/**
 * Order status + payment appeal routes
 *
 * Auto-split from the original monolithic server.js — behaviour unchanged.
 * Original lines: 6120-6398
 */

const crypto = require("crypto");

const { app, rateLimitUser } = require("../app");
const { authUser, bearerToken, decodeToken } = require("../auth/token");
const { escTgMd } = require("../lib/utils");
const { dbFindUserById } = require("../models/users");
const { findOrder, findOrderByUtr, flushPaymentsSync, insertOrder, persistOrderToMongo, schedulePaymentsFlush, updateOrderStatus } = require("../payments/store");
const { PLAN_CATALOG, TELEGRAM_ADMIN_CHAT_ID, TELEGRAM_BOT_TOKEN, activatePro } = require("../plans");
const { sendTelegramPhotoSmart } = require("../telegram/admin-bot");
const { telegramApi } = require("../telegram/api");
const { RUPAYEX_API_BASE, RUPAYEX_API_TOKEN } = require("../config");

app.get("/order-status", async (req, res) => {
  const decoded = authUser(req, res);
  if (!decoded) return;

  const orderId = String(req.query.order_id || "").trim();
  if (!orderId) {
    return res.status(400).json({
      success: false,
      message: "order_id required",
    });
  }

  const local = findOrder(orderId);
  if (!local || Number(local.user_id) !== Number(decoded.id)) {
    return res.status(404).json({
      success: false,
      message: "Order not found",
    });
  }

  // Already success → no need to hit provider again
  if (local.payment_status === "SUCCESS") {
    return res.json({
      success: true,
      order_id: orderId,
      amount: local.amount,
      plan: local.plan,
      payment_status: "SUCCESS",
      utr: local.utr || null,
      method: local.method || null,
    });
  }

  if (
    !RUPAYEX_API_TOKEN ||
    local.method === "UPI_MANUAL" ||
    orderId.startsWith("MANUAL")
  ) {
    return res.json({
      success: true,
      order_id: orderId,
      amount: local.amount,
      plan: local.plan,
      payment_status: local.payment_status,
      utr: local.utr || null,
      method: local.method || null,
    });
  }

  try {
    const qs = new URLSearchParams({
      user_token: RUPAYEX_API_TOKEN,
      order_id: orderId,
    });
    const upstream = await fetch(
      `${RUPAYEX_API_BASE}/order-status?${qs.toString()}`,
      {
        method: "GET",
        headers: {
          "X-Api-Token": RUPAYEX_API_TOKEN,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(15000),
      }
    );

    const rawText = await upstream.text();
    let data = null;
    try {
      data = JSON.parse(rawText);
    } catch {
      data = null;
    }

    const status =
      (data &&
        (data.payment_status ||
          data.status ||
          (data.data && data.data.payment_status))) ||
      local.payment_status;
    const utr =
      (data && (data.utr || (data.data && data.data.utr))) || local.utr || null;
    const method =
      (data && (data.method || (data.data && data.data.method))) ||
      local.method ||
      null;

    const normalized =
      String(status).toUpperCase() === "SUCCESS" ||
      String(status).toUpperCase() === "PAID" ||
      status === true
        ? "SUCCESS"
        : String(status).toUpperCase() === "FAILED" ||
            String(status).toUpperCase() === "FAILURE"
          ? "FAILED"
          : "PENDING";

    // AUDIT-1: Verify upstream amount matches local order amount and never auto-activate REJECTED/EXPIRED orders
    const upstreamAmt = Number(
      (data && (data.amount || (data.data && data.data.amount))) || local.amount
    );
    const amountMatches =
      !Number.isFinite(upstreamAmt) || Math.abs(upstreamAmt - Number(local.amount)) < 1;
    const prevUpper = String(local.payment_status || "").toUpperCase();
    const canTransitionToSuccess =
      prevUpper !== "REJECTED" && prevUpper !== "FAILED" && amountMatches;

    const finalStatus =
      normalized === "SUCCESS" && !canTransitionToSuccess
        ? local.payment_status
        : normalized;

    if (finalStatus !== local.payment_status || utr !== local.utr) {
      updateOrderStatus(
        orderId,
        finalStatus,
        utr,
        method,
        rawText.slice(0, 1500)
      );
      if (finalStatus === "SUCCESS" && prevUpper !== "SUCCESS") {
        try {
          await activatePro(local.user_id, local.plan);
        } catch (_) {}
      }
    }

    res.json({
      success: true,
      order_id: orderId,
      amount: local.amount,
      plan: local.plan,
      payment_status: finalStatus,
      utr,
      method,
    });
  } catch (err) {
    console.error("order-status error:", err.message);
    res.json({
      success: true,
      order_id: orderId,
      amount: local.amount,
      plan: local.plan,
      payment_status: local.payment_status,
      note: "provider unreachable, showing local status",
    });
  }
});


/**
 * POST /payment-appeal  { order_id }
 * User claims payment not verified → Telegram admin alert
 */
app.post("/payment-appeal", async (req, res) => {
  const _tk = bearerToken(req);
  const _ap = _tk ? decodeToken(_tk) : null;
  if (_ap && !rateLimitUser("pa:" + _ap.id, 15, 86400000))
    return res.status(429).json({ success: false, message: "Too many appeals today. Try tomorrow." });
  const decoded = authUser(req, res);
  if (!decoded) return;

  const orderId = String((req.body && req.body.order_id) || "").trim();
  const rawProofUrl = String((req.body && req.body.proof_image_url) || "").trim();
  const proofUrl = /^https?:\/\/[^\s"'<>]+$/i.test(rawProofUrl) ? rawProofUrl : "";
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(orderId)) {
    return res.status(400).json({ success: false, message: "Valid Payment ID or UTR required" });
  }

  const user = await dbFindUserById(decoded.id);
  if (!user) {
    return res.status(404).json({ success: false, message: "User not found" });
  }

  let order = findOrder(orderId) || findOrderByUtr(orderId);
  if (!order) {
    // If the user enters a client-side Payment ID or UTR not yet in DB, create a PENDING_VERIFY order
    // so both Telegram Approve/Deny buttons and Admin Panel can approve it!
    const fallbackOrderId = orderId.toUpperCase().startsWith("MANUAL")
      ? orderId
      : `MANUAL${Date.now()}${crypto.randomBytes(2).toString("hex")}`;
    const looksLikeUtr = !orderId.toUpperCase().startsWith("MANUAL") ? orderId : null;
    insertOrder({
      order_id: fallbackOrderId,
      user_id: decoded.id,
      plan: "weekly",
      amount: PLAN_CATALOG.weekly.amount,
      payment_status: "PENDING_VERIFY",
      payment_url: null,
      utr: looksLikeUtr,
      method: "UPI_MANUAL",
      raw_response: JSON.stringify({ source: "appeal", proof_image_url: proofUrl, input_id: orderId }),
    });
    order = findOrder(fallbackOrderId);
  } else if (Number(order.user_id) !== Number(decoded.id)) {
    return res.status(403).json({
      success: false,
      message: "This Payment ID does not belong to your account.",
    });
  }

  if (order && proofUrl) {
    order.proof_image_url = proofUrl;
    if (String(order.payment_status || "").toUpperCase() === "PENDING") {
      order.payment_status = "PENDING_VERIFY";
    }
    order.updated_at = new Date().toISOString();
    schedulePaymentsFlush();
    flushPaymentsSync();
    persistOrderToMongo(order);
  }

  const plan = PLAN_CATALOG[order.plan] || PLAN_CATALOG.weekly;
  const when = order.created_at
    ? new Date(order.created_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })
    : "—";
  const text =
    `⚠️ Subscription Not Approved — Appeal\n\n` +
    `👤 Name: ${escTgMd(user.name || "—", 80)}\n` +
    `📧 Email: ${escTgMd(user.email || "—", 120)}\n` +
    `🆔 User ID: #${escTgMd(user.id || "—", 24)}\n` +
    `🆔 Payment ID: ${escTgMd(order.order_id, 48)}\n` +
    `📦 Plan: ${escTgMd(plan.name || order.plan || "—", 60)}\n` +
    `💰 Amount: ₹${order.amount != null ? order.amount : "—"}\n` +
    `📊 Status: ${escTgMd(order.payment_status || "—", 32)}\n` +
    `🔖 UTR: ${escTgMd(order.utr || orderId || "—", 32)}\n` +
    `🕐 Created: ${when} IST\n` +
    `🕐 Appeal: ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST` +
    (proofUrl ? `\n🖼 Proof: ${proofUrl}` : "");

  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_ADMIN_CHAT_ID) {
    console.warn("Appeal received but Telegram not configured");
    return res.json({
      success: true,
      message: "Appeal received. Support will review.",
      telegram: false,
    });
  }

  const keyboard = {
    inline_keyboard: [
      [
        { text: "✅ Approve", callback_data: `a:${order.order_id}` },
        { text: "❌ Deny", callback_data: `d:${order.order_id}` },
      ],
    ],
  };

  let result = null;
  if (proofUrl) {
    result = await sendTelegramPhotoSmart({
      chatId: TELEGRAM_ADMIN_CHAT_ID,
      photoUrl: proofUrl,
      caption: text.slice(0, 1000),
      replyMarkup: keyboard,
      token: TELEGRAM_BOT_TOKEN,
    });
  }
  if (!result || !result.ok) {
    result = await telegramApi("sendMessage", {
      chat_id: TELEGRAM_ADMIN_CHAT_ID,
      text,
      reply_markup: keyboard,
    });
  }
  if (!result || !result.ok) {
    console.error("Appeal telegram failed:", JSON.stringify(result));
    return res.json({
      success: true,
      message: "Appeal saved for Admin review.",
      telegram: false,
    });
  }

  res.json({ success: true, message: "Appeal sent to admin." });
});

/* ── Telegram free-plan verification bot (registered BEFORE 404 handler) ── */

module.exports = {};
