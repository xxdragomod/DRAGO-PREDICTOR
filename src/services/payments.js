
const fs = require("fs");
const path = require("path");
const { PAYMENT_TTL_MS } = require("../config/env");
const { DEFAULT_ADMIN_SETTINGS, adminSettings } = require("../state/adminSettings");
const { col } = require("../state/mongo");
const { notificationsList } = require("./notifications");
const { pushSubscriptionsList } = require("./push");

const { ROOT_DIR } = require("../config/paths");
const { replaceAdminSettings } = require("../state/adminSettings");
const { setAnnouncement } = require("./announcement");
const PAYMENTS_JSON_PATH = path.join(ROOT_DIR, "payments.json");
let paymentsCache = null;
let paymentsDirty = false;
let paymentsWriteTimer = null;
function loadPaymentsFromDisk() {
  try {
    if (!fs.existsSync(PAYMENTS_JSON_PATH)) {
      paymentsCache = [];
      return paymentsCache;
    }
    const raw = fs.readFileSync(PAYMENTS_JSON_PATH, "utf8");
    const data = JSON.parse(raw || "[]");
    paymentsCache = Array.isArray(data) ? data : [];
  } catch (e) {
    console.error("read payments.json:", e.message);
    paymentsCache = [];
  }
  return paymentsCache;
}
function getPayments() {
  if (!paymentsCache) loadPaymentsFromDisk();
  return paymentsCache;
}
function flushPaymentsSync() {
  if (!paymentsCache) return;
  try {
    const tmp = PAYMENTS_JSON_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(paymentsCache, null, 0), "utf8");
    fs.renameSync(tmp, PAYMENTS_JSON_PATH);
    paymentsDirty = false;
  } catch (e) {
    console.error("write payments.json:", e.message);
    throw e;
  }
}
function schedulePaymentsFlush() {
  paymentsDirty = true;
  if (paymentsWriteTimer) return;
  paymentsWriteTimer = setTimeout(() => {
    paymentsWriteTimer = null;
    try {
      flushPaymentsSync();
    } catch (_) {}
  }, 50);
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
function persistOrderToMongo(row) {
  if (!row || !row.order_id || !col.payments) return;
  const copy = { ...row };
  delete copy._id;
  col.payments
    .updateOne(
      { order_id: String(row.order_id) },
      { $set: copy },
      { upsert: true }
    )
    .catch((e) => console.warn("mongo payment upsert:", e.message));
}
async function syncPaymentsAndSettingsFromMongo() {
  try {
    if (col.kv_store) {
      const [settingsDoc, annDoc, notifDoc, pushDoc] = await Promise.all([
        col.kv_store.findOne({ _id: "admin_settings" }),
        col.kv_store.findOne({ _id: "announcement" }),
        col.kv_store.findOne({ _id: "notifications_v1" }),
        col.kv_store.findOne({ _id: "push_subs_v1" }),
      ]);
      if (settingsDoc && settingsDoc.value && typeof settingsDoc.value === "object") {
        replaceAdminSettings({ ...DEFAULT_ADMIN_SETTINGS, ...settingsDoc.value });
      } else {
        await col.kv_store.updateOne(
          { _id: "admin_settings" },
          { $set: { value: adminSettings, updated_at: new Date().toISOString() } },
          { upsert: true }
        );
      }
      if (annDoc && annDoc.value !== undefined) {
        setAnnouncement(annDoc.value);
      }
      if (notifDoc && Array.isArray(notifDoc.value)) {
        notificationsList = notifDoc.value;
      }
      if (pushDoc && Array.isArray(pushDoc.value)) {
        pushSubscriptionsList = pushDoc.value;
      }
    }
    if (col.payments) {
      const localRows = getPayments();
      const mongoRows = await col.payments
        .find({})
        .sort({ created_at: 1 })
        .toArray();
      const mergedMap = new Map();
      for (const r of localRows) {
        if (r && r.order_id) mergedMap.set(String(r.order_id), r);
      }
      for (const r of mongoRows) {
        if (r && r.order_id) {
          const clean = { ...r };
          delete clean._id;
          mergedMap.set(String(r.order_id), clean);
        }
      }
      paymentsCache = Array.from(mergedMap.values());
      // Backfill any local-only orders into MongoDB
      const mongoIds = new Set(mongoRows.map((x) => String(x.order_id)));
      for (const r of paymentsCache) {
        if (r && r.order_id && !mongoIds.has(String(r.order_id))) {
          persistOrderToMongo(r);
        }
      }
      flushPaymentsSync();
    }
  } catch (e) {
    console.warn("syncPaymentsAndSettingsFromMongo:", e.message);
  }
}
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
  getPayments().push(row);
  persistOrderToMongo(row);
  schedulePaymentsFlush();
  flushPaymentsSync();
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
  schedulePaymentsFlush();
  flushPaymentsSync();
  return row;
}
function expireStaleOrders() {
  // PENDING older than 10 min → EXPIRED (still kept forever in MongoDB & payments.json)
  try {
    const cutoff = Date.now() - PAYMENT_TTL_MS;
    let changed = false;
    for (const o of getPayments()) {
      if (!o) continue;
      const st = String(o.payment_status || "").toUpperCase();
      if (st !== "PENDING") continue;
      const t = Date.parse(o.created_at || 0);
      if (Number.isFinite(t) && t < cutoff) {
        o.payment_status = "EXPIRED";
        o.updated_at = new Date().toISOString();
        persistOrderToMongo(o);
        changed = true;
      }
    }
    if (changed) {
      schedulePaymentsFlush();
      flushPaymentsSync();
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

module.exports = { PAYMENTS_JSON_PATH, WINGO_HISTORY_MAX, expireStaleOrders, findOrder, findOrderByUtr, findPendingManual, flushPaymentsSync, getPayments, insertOrder, listOrdersByUser, loadPaymentsFromDisk, paymentsCache, paymentsDirty, paymentsWriteTimer, persistOrderToMongo, predCache, schedulePaymentsFlush, syncPaymentsAndSettingsFromMongo, updateOrderStatus };
