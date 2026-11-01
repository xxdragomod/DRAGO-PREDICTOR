/**
 * Payment order creation + history routes
 *
 * Auto-split from the original monolithic server.js — behaviour unchanged.
 * Original lines: 4908-5353
 */

const crypto = require("crypto");

const { app, rateLimitUser } = require("../app");
const { authUser } = require("../auth/token");
const { isDiskFullError } = require("../lib/utils");
const { dbFindUserById } = require("../models/users");
const { expireStaleOrders, findOrder, findOrderByUtr, findPendingManual, insertOrder, listOrdersByUser, updateOrderStatus } = require("../payments/store");
const { PAYMENT_TTL_MS, PLAN_CATALOG } = require("../plans");
const { getActiveUpiId } = require("../settings");
const { notifyAdminManualPayment } = require("../telegram/admin-bot");
const { FRONTEND_URL, RUPAYEX_API_BASE, RUPAYEX_API_TOKEN } = require("../config");
const { getAdminSettings } = require("../state");

/**
 * Create payment order (Rupayex) — token sirf server pe.
 * Body: { plan: "test" | "beginners" | "profit" }
 * Auth: Bearer JWT required
 * Returns: { success, order_id, amount, payment_url }
 */
app.post("/create-payment", async (req, res) => {
  const decoded = authUser(req, res);
  if (!decoded) return;
  if (!rateLimitUser("cp:" + decoded.id, 15, 3600000)) {
    return res.status(429).json({ success: false, message: "Too many payment attempts. Try later." });
  }

  if (!(getAdminSettings()).auto_payment_enabled) {
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
app.get("/payment-history", (req, res) => {
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
app.post("/manual-payment", async (req, res) => {
  const decoded = authUser(req, res);
  if (!decoded) return;
  if (!rateLimitUser("mp:" + decoded.id, 15, 3600000)) {
    return res.status(429).json({ success: false, message: "Too many UTR submissions. Try again later." });
  }

  if (!(getAdminSettings()).manual_payment_enabled) {
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
app.post("/manual-payment/start", (req, res) => {
  const decoded = authUser(req, res);
  if (!decoded) return;
  if (!rateLimitUser("mps:" + decoded.id, 30, 3600000)) {
    return res.status(429).json({ success: false, message: "Too many payment sessions started. Try later." });
  }

  if (!(getAdminSettings()).manual_payment_enabled) {
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

module.exports = {};
