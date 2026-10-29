const crypto = require("crypto");
const express = require("express");
const router = express.Router();


const { FRONTEND_URL, PAYMENT_TTL_MS, RUPAYEX_API_BASE, RUPAYEX_API_TOKEN, TELEGRAM_ADMIN_CHAT_ID, TELEGRAM_BOT_TOKEN } = require("../config/env");
const { PLAN_CATALOG } = require("../config/plans");
const { dbFindUserById } = require("../db/users");
const { rateLimitUser } = require("../middleware/rateLimit");
const { authUser } = require("../services/authService");
const { activatePro } = require("../services/entitlements");
const { expireStaleOrders, findOrder, findOrderByUtr, findPendingManual, flushPaymentsSync, insertOrder, listOrdersByUser, persistOrderToMongo, schedulePaymentsFlush, updateOrderStatus } = require("../services/payments");
const { telegramApi } = require("../services/telegramApi");
const { notifyAdminManualPayment } = require("../services/telegramNotify");
const { bearerToken, decodeToken } = require("../services/tokens");
const { sendTelegramPhotoSmart } = require("../services/uploads");
const { adminSettings, getActiveUpiId } = require("../state/adminSettings");
const { isDiskFullError } = require("../utils/errors");
const { escTgMd } = require("../utils/telegramFormat");
router.get("/payment-config", (req, res) => {
  const decoded = authUser(req, res);
  if (!decoded) return;

  expireStaleOrders();

  const planKey = String(req.query.plan || "")
    .trim()
    .toLowerCase();
  const plan = PLAN_CATALOG[planKey];
  if (!plan) {
    return res.status(400).json({
      success: false,
      message: "Invalid plan. Use: test, beginners, profit",
    });
  }

  res.json({
    success: true,
    plan: planKey,
    name: plan.name,
    amount: plan.amount,
    days: plan.days,
    qr_url: plan.qr_url || null,
    ttl_minutes: 10,
    upi_id: getActiveUpiId(),
  });
});

/**
 * Live Wingo 30s prediction (proxy upstream)
 * Auth required. Pro = unlimited. Free = max freePredLimit() lifetime reveals.
 * Query: ?consume=1  → increments free counter (only when user taps Get Prediction)
 */
router.post("/create-payment", async (req, res) => {
  const decoded = authUser(req, res);
  if (!decoded) return;
  if (!rateLimitUser("cp:" + decoded.id, 15, 3600000)) {
    return res.status(429).json({ success: false, message: "Too many payment attempts. Try later." });
  }

  if (!adminSettings.auto_payment_enabled) {
    return res.status(403).json({
      success: false,
      message: "Auto payment gateway is disabled. Try manual QR or contact support.",
    });
  }

  if (!RUPAYEX_API_TOKEN) {
    return res.status(503).json({
      success: false,
      message: "Payment gateway not configured",
    });
  }

  const planKey = String((req.body && req.body.plan) || "")
    .trim()
    .toLowerCase();
  const plan = PLAN_CATALOG[planKey];
  if (!plan) {
    return res.status(400).json({
      success: false,
      message: "Invalid plan. Use: test, beginners, profit",
    });
  }

  const orderId = `DRAGO${Date.now()}${crypto.randomBytes(3).toString("hex")}`;
  const redirectUrl = `${FRONTEND_URL}/subscription?order=${encodeURIComponent(orderId)}`;

  const form = new URLSearchParams();
  form.set("amount", String(plan.amount));
  form.set("order_id", orderId);
  form.set("redirect_url", redirectUrl);
  form.set("remark1", `DRAGO ${plan.name}`);
  form.set("user_token", RUPAYEX_API_TOKEN);

  try {
    const upstream = await fetch(`${RUPAYEX_API_BASE}/create-order`, {
      method: "POST",
      headers: {
        "X-Api-Token": RUPAYEX_API_TOKEN,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: form.toString(),
      signal: AbortSignal.timeout(20000),
    });

    const rawText = await upstream.text();
    let data = null;
    try {
      data = JSON.parse(rawText);
    } catch {
      data = null;
    }

    if (!upstream.ok) {
      console.error("Rupayex create-order fail:", upstream.status, rawText.slice(0, 400));
      return res.status(502).json({
        success: false,
        message: "Payment provider error. Try again or use manual QR.",
      });
    }

    // Common response shapes
    const paymentUrl =
      (data &&
        (data.payment_url ||
          data.paymentUrl ||
          data.url ||
          data.payment_link ||
          data.redirect_url ||
          (data.data &&
            (data.data.payment_url ||
              data.data.paymentUrl ||
              data.data.url ||
              data.data.payment_link ||
              data.data.redirect_url)))) ||
      null;

    try {
      insertOrder({
        order_id: orderId,
        user_id: decoded.id,
        plan: planKey,
        amount: plan.amount,
        payment_status: "PENDING",
        payment_url: paymentUrl || null,
        raw_response: rawText.slice(0, 1500),
      });
    } catch (dbErr) {
      console.error("create-payment save:", dbErr.message);
      return res.status(500).json({
        success: false,
        message: isDiskFullError(dbErr)
          ? "Server storage full — try again later"
          : "Could not save order",
      });
    }

    if (!paymentUrl) {
      console.error("Rupayex: no payment_url in response:", rawText.slice(0, 500));
      return res.status(502).json({
        success: false,
        message: "Payment URL missing from provider response",
        order_id: orderId,
      });
    }

    console.log("💳 order created:", orderId, planKey, plan.amount);
    res.json({
      success: true,
      order_id: orderId,
      plan: planKey,
      amount: plan.amount,
      payment_url: paymentUrl,
    });
  } catch (err) {
    console.error("create-payment error:", err.message);
    res.status(502).json({
      success: false,
      message: "Failed to reach payment provider",
    });
  }
});

/**
 * Payment history for logged-in user
 * GET /payment-history
 * Pending + payment_url → can_continue true (24h window)
 */
router.get("/payment-history", (req, res) => {
  const decoded = authUser(req, res);
  if (!decoded) return;

  expireStaleOrders();

  const rows = listOrdersByUser(decoded.id, 50);
  const now = Date.now();

  const orders = rows.map((row) => {
    const created = row.created_at ? new Date(row.created_at).getTime() : 0;
    const ageOk = created && now - created < PAYMENT_TTL_MS;
    const status = String(row.payment_status || "").toUpperCase();
    const pending = status === "PENDING";
    const method = String(row.method || "");
    // Gateway continue needs payment_url; manual QR continue needs UPI_MANUAL + no UTR yet
    const canContinueGateway = Boolean(pending && ageOk && row.payment_url);
    const canContinueManual = Boolean(
      pending && ageOk && method === "UPI_MANUAL" && !row.utr
    );
    const canContinue = canContinueGateway || canContinueManual;
    return {
      order_id: row.order_id,
      plan: row.plan,
      plan_name:
        (PLAN_CATALOG[row.plan] && PLAN_CATALOG[row.plan].name) ||
        String(row.plan || "PRO VIP").toUpperCase(),
      amount: row.amount,
      payment_status: row.payment_status,
      utr: row.utr || null,
      method: row.method || null,
      created_at: row.created_at,
      can_continue: canContinue,
      payment_url: canContinueGateway ? row.payment_url : null,
      continue_mode: canContinueManual
        ? "manual"
        : canContinueGateway
          ? "gateway"
          : null,
      expires_in_sec:
        pending && ageOk
          ? Math.max(0, Math.floor((created + PAYMENT_TTL_MS - now) / 1000))
          : 0,
    };
  });

  res.json({ success: true, orders });
});

/**
 * Manual / custom gateway — user submits UTR after paying via QR
 * Body: { plan, utr }
 * Status: PENDING_VERIFY → Telegram Approve/Deny
 * Order must be within 10 minutes of... we create fresh order on submit;
 * if user had opened sheet long ago, still allow but admin verifies.
 * Extra: reject if another PENDING_VERIFY same user within window without need.
 */
router.post("/manual-payment", async (req, res) => {
  const decoded = authUser(req, res);
  if (!decoded) return;
  if (!rateLimitUser("mp:" + decoded.id, 15, 3600000)) {
    return res.status(429).json({ success: false, message: "Too many UTR submissions. Try again later." });
  }

  if (!adminSettings.manual_payment_enabled) {
    return res.status(403).json({
      success: false,
      message: "Manual payment is disabled. Use auto gateway or contact support.",
    });
  }

  expireStaleOrders();

  const planKey = String((req.body && req.body.plan) || "")
    .trim()
    .toLowerCase();
  const plan = PLAN_CATALOG[planKey];
  if (!plan) {
    return res.status(400).json({
      success: false,
      message: "Invalid plan",
    });
  }

  let utr = String((req.body && req.body.utr) || "")
    .replace(/\s+/g, "")
    .trim()
    .toUpperCase();
  if (!/^[A-Z0-9]{8,22}$/.test(utr)) {
    return res.status(400).json({
      success: false,
      message: "Valid alphanumeric UTR required (8–22 chars)",
    });
  }

  if (findOrderByUtr(utr)) {
    return res.status(409).json({
      success: false,
      message: "This UTR is already submitted",
    });
  }

  const user = await dbFindUserById(decoded.id);
  if (!user) {
    return res.status(404).json({ success: false, message: "User not found" });
  }

  const amount = plan.amount;
  let orderId = String((req.body && req.body.order_id) || "").trim();

  try {
    if (orderId) {
      const existing = findOrder(orderId);
      if (
        !existing ||
        Number(existing.user_id) !== Number(decoded.id) ||
        String(existing.payment_status).toUpperCase() !== "PENDING"
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid or expired order. Start payment again.",
        });
      }
      const created = existing.created_at
        ? new Date(existing.created_at).getTime()
        : 0;
      if (created && Date.now() - created > PAYMENT_TTL_MS) {
        try {
          updateOrderStatus(
            orderId,
            "EXPIRED",
            null,
            existing.method,
            existing.raw_response
          );
        } catch (_) {}
        return res.status(400).json({
          success: false,
          message: "Payment session expired (10 min). Start again.",
        });
      }
      updateOrderStatus(
        orderId,
        "PENDING_VERIFY",
        utr,
        "UPI_MANUAL",
        JSON.stringify({ source: "manual_qr", utr })
      );
    } else {
      orderId = `MANUAL${Date.now()}${crypto.randomBytes(3).toString("hex")}`;
      insertOrder({
        order_id: orderId,
        user_id: decoded.id,
        plan: planKey,
        amount,
        payment_status: "PENDING_VERIFY",
        payment_url: null,
        utr,
        method: "UPI_MANUAL",
        raw_response: JSON.stringify({ source: "manual_qr", utr }),
      });
    }

    console.log("🧾 manual UTR:", orderId, planKey, amount, utr);

    notifyAdminManualPayment({
      orderId,
      user: { id: user.id, name: user.name, email: user.email },
      planKey,
      amount,
      utr,
    }).catch((e) => console.error("tg notify:", e.message));

    res.json({
      success: true,
      order_id: orderId,
      plan: planKey,
      amount,
      utr,
      payment_status: "PENDING_VERIFY",
      message: "UTR submitted. Waiting for admin verification.",
    });
  } catch (err) {
    console.error("manual-payment error:", err.message);
    res.status(500).json({
      success: false,
      message: isDiskFullError(err)
        ? "Server storage full — try again in a moment"
        : "Could not save payment",
    });
  }
});

/**
 * Start manual QR payment session — creates PENDING order (10 min)
 * so history shows Continue even if user closes the sheet.
 * Reuses existing pending order for same user+plan (avoids DB bloat).
 * Body: { plan }
 */
router.post("/manual-payment/start", (req, res) => {
  const decoded = authUser(req, res);
  if (!decoded) return;
  if (!rateLimitUser("mps:" + decoded.id, 30, 3600000)) {
    return res.status(429).json({ success: false, message: "Too many payment sessions started. Try later." });
  }

  if (!adminSettings.manual_payment_enabled) {
    return res.status(403).json({
      success: false,
      message: "Manual payment is disabled.",
    });
  }

  expireStaleOrders();

  const planKey = String((req.body && req.body.plan) || "")
    .trim()
    .toLowerCase();
  const plan = PLAN_CATALOG[planKey];
  if (!plan) {
    return res.status(400).json({
      success: false,
      message: "Invalid plan",
    });
  }

  try {
    // Reuse open manual session instead of inserting a new row every open
    const existing = findPendingManual(decoded.id, planKey);
    if (existing) {
      const createdMs = Date.parse(existing.created_at || 0) || Date.now();
      const expiresAtMs = createdMs + PAYMENT_TTL_MS;
      const expiresInSec = Math.max(
        0,
        Math.floor((expiresAtMs - Date.now()) / 1000)
      );
      return res.json({
        success: true,
        order_id: existing.order_id,
        plan: planKey,
        amount: plan.amount,
        days: plan.days,
        qr_url: plan.qr_url || null,
        name: plan.name,
        ttl_minutes: 10,
        created_at: existing.created_at,
        expires_at: new Date(expiresAtMs).toISOString(),
        expires_in_sec: expiresInSec,
        upi_id: getActiveUpiId(),
        payment_status: existing.payment_status || "PENDING",
        utr: existing.utr || null,
        reused: true,
      });
    }

    const reqOrderId = String((req.body && req.body.order_id) || "").trim();
    const validClientOrderId =
      /^MANUAL[0-9A-Za-z]{8,32}$/.test(reqOrderId) && !findOrder(reqOrderId)
        ? reqOrderId
        : "";
    const orderId =
      validClientOrderId ||
      `MANUAL${Date.now()}${crypto.randomBytes(3).toString("hex")}`;
    const meta = JSON.stringify({ source: "manual_qr", stage: "awaiting_utr" });
    const nowMs = Date.now();
    const expiresAtMs = nowMs + PAYMENT_TTL_MS;

    insertOrder({
      order_id: orderId,
      user_id: decoded.id,
      plan: planKey,
      amount: plan.amount,
      payment_status: "PENDING",
      payment_url: null,
      utr: null,
      method: "UPI_MANUAL",
      raw_response: meta,
    });

    res.json({
      success: true,
      order_id: orderId,
      plan: planKey,
      amount: plan.amount,
      days: plan.days,
      qr_url: plan.qr_url || null,
      name: plan.name,
      ttl_minutes: 10,
      created_at: new Date(nowMs).toISOString(),
      expires_at: new Date(expiresAtMs).toISOString(),
      expires_in_sec: Math.floor(PAYMENT_TTL_MS / 1000),
      upi_id: getActiveUpiId(),
      payment_status: "PENDING",
    });
  } catch (err) {
    console.error("manual-payment/start:", err.message);
    const msg = isDiskFullError(err)
      ? "Server storage full — try again in a moment"
      : "Could not start payment";
    res.status(500).json({ success: false, message: msg });
  }
});

/** System / status monitoring for Status page */
const SERVER_STARTED_AT = Date.now();
/** In-memory history of ok/down per check (max 48 samples) */
const statusHistory = new Map(); // id → boolean[]

function pushHistory(id, ok) {
  const arr = statusHistory.get(id) || [];
  arr.push(Boolean(ok));
  while (arr.length > 48) arr.shift();
  statusHistory.set(id, arr);
  return arr.slice();
}

async function timedFetch(url, opts) {
  const t0 = Date.now();
  const r = await fetch(url, opts);
  return { response: r, latency_ms: Date.now() - t0 };
}
router.get("/order-status", async (req, res) => {
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
router.post("/payment-appeal", async (req, res) => {
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

module.exports = { SERVER_STARTED_AT, pushHistory, router, statusHistory, timedFetch };
