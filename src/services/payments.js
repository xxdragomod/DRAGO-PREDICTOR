/**
 * Payments store — MongoDB only.
 *
 * `payments` collection me ek document = ek order (order_id unique).
 * In-memory `paymentsCache` sirf read speed ke liye hai; source of truth MongoDB
 * hai. Disk pe kuch nahi likha jaata.
 */
const { PAYMENT_TTL_MS } = require("../config/env");
const { trackWrite } = require("../db/store");
const { col } = require("../state/mongo");

/** Stable array reference — modules that import it always see current data. */
const paymentsCache = [];
let paymentsHydrated = false;

function replacePayments(rows) {
  paymentsCache.length = 0;
  for (const r of rows || []) {
    if (!r || !r.order_id) continue;
    const clean = { ...r };
    delete clean._id;
    paymentsCache.push(clean);
  }
}

/** All orders currently in memory (hydrated at boot). */
function getPayments() {
  return paymentsCache;
}

/** Move the order document (without Mongo's _id) to a plain row. */
function toDoc(row) {
  const copy = { ...row };
  delete copy._id;
  copy.order_id = String(copy.order_id);
  return copy;
}

/** Queue an upsert of a single order into MongoDB. */
function persistOrderToMongo(row) {
  if (!row || !row.order_id) return Promise.resolve();
  if (!col.payments) {
    console.warn("persistOrderToMongo: payments collection not ready");
    return Promise.resolve();
  }
  return trackWrite(
    "payment " + String(row.order_id),
    col.payments.updateOne(
      { order_id: String(row.order_id) },
      { $set: toDoc(row) },
      { upsert: true }
    )
  );
}

/** Remove an order from memory + MongoDB. */
function deleteOrder(orderId) {
  const id = String(orderId || "");
  if (!id) return null;
  const before = paymentsCache.length;
  for (let i = paymentsCache.length - 1; i >= 0; i--) {
    if (paymentsCache[i] && String(paymentsCache[i].order_id) === id) {
      paymentsCache.splice(i, 1);
    }
  }
  if (col.payments) {
    trackWrite("payment delete " + id, col.payments.deleteOne({ order_id: id }));
  }
  return before !== paymentsCache.length;
}

/** Load every order from MongoDB into memory. Called once at boot. */
async function hydratePayments() {
  if (!col.payments) return;
  const rows = await col.payments.find({}).sort({ created_at: 1 }).toArray();
  replacePayments(rows);
  paymentsHydrated = true;
}

function isPaymentsHydrated() {
  return paymentsHydrated;
}

function findOrder(orderId) {
  if (!orderId) return null;
  const id = String(orderId);
  return getPayments().find((o) => o && String(o.order_id) === id) || null;
}

function listOrdersByUser(userId, limit) {
  const uid = Number(userId);
  const lim = limit || 50;
  return getPayments()
    .filter((o) => o && Number(o.user_id) === uid)
    .sort(
      (a, b) =>
        Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0)
    )
    .slice(0, lim);
}

function findOrderByUtr(utr) {
  if (!utr) return null;
  const u = String(utr).toUpperCase();
  return (
    getPayments().find(
      (o) => o && o.utr && String(o.utr).toUpperCase() === u
    ) || null
  );
}

function findPendingManual(userId, planKey) {
  const uid = Number(userId);
  const plan = String(planKey || "");
  const cutoff = Date.now() - PAYMENT_TTL_MS;
  return (
    getPayments()
      .filter((o) => {
        if (!o || Number(o.user_id) !== uid || String(o.plan) !== plan) return false;
        if (String(o.method || "") !== "UPI_MANUAL") return false;
        const st = String(o.payment_status || "").toUpperCase();
        // Only reuse an open order that has NOT submitted UTR yet and is within 10 minutes
        if (o.utr) return false;
        return st === "PENDING" && Date.parse(o.created_at || 0) >= cutoff;
      })
      .sort(
        (a, b) =>
          Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0)
      )[0] || null
  );
}

/** Create a new order (memory + MongoDB). */
function insertOrder({
  order_id,
  user_id,
  plan,
  amount,
  payment_status,
  payment_url,
  utr,
  method,
  raw_response,
}) {
  const now = new Date().toISOString();
  const row = {
    order_id: String(order_id),
    user_id: Number(user_id),
    plan: String(plan || ""),
    amount: Number(amount) || 0,
    payment_status: String(payment_status || "PENDING"),
    payment_url: payment_url || null,
    utr: utr || null,
    method: method || null,
    raw_response: raw_response
      ? String(raw_response).slice(0, 1500)
      : null,
    created_at: now,
    updated_at: now,
  };
  paymentsCache.push(row);
  persistOrderToMongo(row);
  return row;
}
function updateOrderStatus(orderId, payment_status, utr, method, raw_response) {
  const row = findOrder(orderId);
  if (!row) return null;
  if (payment_status != null) row.payment_status = String(payment_status);
  if (utr !== undefined) row.utr = utr;
  if (method !== undefined) row.method = method;
  if (raw_response !== undefined) {
    row.raw_response = raw_response
      ? String(raw_response).slice(0, 1500)
      : null;
  }
  row.updated_at = new Date().toISOString();
  persistOrderToMongo(row);
  return row;
}
function expireStaleOrders() {
  // PENDING older than 10 min → EXPIRED (orders MongoDB me hamesha rehte hain)
  try {
    const cutoff = Date.now() - PAYMENT_TTL_MS;
    for (const o of paymentsCache) {
      if (!o) continue;
      const st = String(o.payment_status || "").toUpperCase();
      if (st !== "PENDING") continue;
      const t = Date.parse(o.created_at || 0);
      if (Number.isFinite(t) && t < cutoff) {
        o.payment_status = "EXPIRED";
        o.updated_at = new Date().toISOString();
        // Only the rows that actually changed are written back.
        persistOrderToMongo(o);
      }
    }
  } catch (e) {
    console.error("expire orders:", e.message);
  }
}

// ─── WinGo data: proxy-only to orihost VPS (no local save) ─────────────────
// Prediction + history dono VPS se aate hain. Render sirf forward karta hai.
const WINGO_HISTORY_MAX = 10000;

// Last good prediction — upstream (VPS) fail ho to stale fallback serve karte
let predCache = { at: 0, prediction: null, fetched_at: "" };

module.exports = { WINGO_HISTORY_MAX, deleteOrder, expireStaleOrders, findOrder, findOrderByUtr, findPendingManual, getPayments, hydratePayments, insertOrder, isPaymentsHydrated, listOrdersByUser, paymentsCache, paymentsHydrated, persistOrderToMongo, predCache, replacePayments, toDoc, updateOrderStatus };
