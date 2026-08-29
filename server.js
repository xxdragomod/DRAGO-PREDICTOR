/**
 * DRAGO Backend — optimized
 * Express + MongoDB + Google OAuth (server-side) + JWT
 *
 * Endpoints:
 *   GET  /                      health
 *   GET  /auth/google           start Google login
 *   GET  /auth/google/callback  OAuth callback → JWT → frontend
 *   GET  /verify                session check (Bearer token)
 *   GET  /profile               full profile (Bearer token)
 *   GET  /wingo30s_prediction   live prediction proxy
 *   POST /create-payment        Rupayex order (Bearer + plan)
 *   GET  /order-status          payment status (Bearer + order_id)
 *   GET  /payment-history       user orders list (Bearer)
 *   POST /manual-payment        custom QR + UTR claim (Bearer)
 *   GET  /system-status         status page checks (Bearer)
 *   GET  /games                 list games (public)
 *   GET  /games/:id             single game (public)
 *   POST /api-keys              create developer API key (Bearer)
 *   GET  /api-keys              list own API keys (Bearer)
 *   DELETE /api-keys/:id        revoke API key (Bearer)
 *   GET  /v1/wingo30s/history      history JSON (X-API-Key, 20/min)
 *   GET  /v1/wingo30s/prediction   prediction JSON (X-API-Key, 20/min)
 *   GET  /api-usage                own API usage stats (Bearer)
 * Telegram admin: /addgame /listgames /delgame <id> /cancel
 * Background: WinGo history poll every :00 / :30 → wingo30s_history.json (max 1000)
 */

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const dotenv = require("dotenv");
const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const { OAuth2Client } = require("google-auth-library");
const { MongoClient, ObjectId } = require("mongodb");

// ─── Env ( .env  +  env  dono support ) ─────────────────────────────────────
dotenv.config({ path: path.join(__dirname, ".env") });
dotenv.config({ path: path.join(__dirname, "env") });
dotenv.config({ path: path.join(__dirname, "local.env") });

const PORT = Number(process.env.PORT) || 3000;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const JWT_SECRET = process.env.JWT_SECRET;
const APP_ID = process.env.APP_ID || process.env.DRAGO_APP_ID || "";
const APP_SECRET = process.env.APP_SECRET || process.env.DRAGO_APP_SECRET || "";
const FRONTEND_URL = (
  process.env.FRONTEND_URL || "https://dragopredictor.vercel.app"
).replace(/\/$/, "");
const ALLOWED_WEB_DOMAIN = (
  process.env.ALLOWED_WEB_DOMAIN || "dragopredictor.vercel.app"
).replace(/^https?:\/\//, "").replace(/\/$/, "");
// Third-party prediction VPS (HTTP ok — server-to-server only, never exposed to browser)
const WINGO_PREDICTION_URL = (
  process.env.WINGO_PREDICTION_URL ||
  "http://46.247.108.191:30296/api/prediction/wingo/30s/size"
).replace(/\/$/, "");
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";
const SIGNATURE_MAX_SKEW_MS = Number(process.env.SIGNATURE_MAX_SKEW_MS) || 120000; // 2 min

// Rupayex (server-side only)
const RUPAYEX_API_BASE = (
  process.env.RUPAYEX_API_BASE || "https://rupayex.net/api"
).replace(/\/$/, "");
const RUPAYEX_API_TOKEN = process.env.RUPAYEX_API_TOKEN || "";

/** Plan → amount (INR). Client amount trust mat karo. */
const PLAN_CATALOG = {
  test: {
    name: "RX1 FOR TEST",
    amount: 300,
    days: 3,
    qr_url: process.env.QR_URL_300 || "",
  },
  beginners: {
    name: "RX1 FOR BEGINNERS",
    amount: 500,
    days: 7,
    qr_url: process.env.QR_URL_500 || "",
  },
  profit: {
    name: "RX1 FOR PROFIT",
    amount: 900,
    days: 15,
    qr_url: process.env.QR_URL_900 || "",
  },
};

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_ADMIN_CHAT_ID = String(
  process.env.TELEGRAM_ADMIN_CHAT_ID || ""
).trim();
/** Pending payment window (gateway + manual) */
const PAYMENT_TTL_MS = 10 * 60 * 1000;

if (!GOOGLE_CLIENT_ID || !JWT_SECRET) {
  console.error("❌ GOOGLE_CLIENT_ID aur JWT_SECRET set karo (Render env)");
  process.exit(1);
}
if (!APP_ID || !APP_SECRET || APP_SECRET.length < 32) {
  console.error("❌ APP_ID aur APP_SECRET (min 32 chars) set karo (Render env)");
  process.exit(1);
}
if (JWT_SECRET.length < 32) {
  console.error("❌ JWT_SECRET kam se kam 32 characters ka hona chahiye");
  process.exit(1);
}
if (!GOOGLE_CLIENT_SECRET) {
  console.warn("⚠️  GOOGLE_CLIENT_SECRET missing — Google login fail hoga");
}
if (!WINGO_PREDICTION_URL) {
  console.warn("⚠️  WINGO_PREDICTION_URL missing — prediction fail hoga");
}

// ─── Database (MongoDB Atlas) ───────────────────────────────────────────────
// Only store what is needed: users, games, api_keys, api_usage (daily aggregates).
// Payments + wingo history stay in JSON files (unchanged).
const MONGODB_URI = process.env.MONGODB_URI || "";
if (!MONGODB_URI) {
  console.error("❌ MONGODB_URI set karo (Render env)");
  process.exit(1);
}

let mongoClient = null;
let db = null; // MongoDB database handle
const col = {
  users: null,
  games: null,
  api_keys: null,
  api_usage: null,
  counters: null,
};

async function nextSeq(name) {
  const r = await col.counters.findOneAndUpdate(
    { _id: name },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: "after" }
  );
  return r && r.seq != null ? r.seq : 1;
}

function mapUser(doc) {
  if (!doc) return null;
  return {
    id: doc.id,
    google_id: doc.google_id,
    email: doc.email || "",
    name: doc.name || "",
    picture: doc.picture || "",
    is_pro: doc.is_pro ? 1 : 0,
    pro_plan: doc.pro_plan || null,
    pro_expires_at: doc.pro_expires_at || null,
    free_pred_used: Number(doc.free_pred_used) || 0,
    created_at: doc.created_at || null,
  };
}

function mapGame(doc) {
  if (!doc) return null;
  return {
    id: doc.id,
    name: doc.name,
    image_url: doc.image_url,
    link_url: doc.link_url,
    sort_order: Number(doc.sort_order) || 0,
    created_at: doc.created_at || null,
  };
}

function mapApiKey(doc) {
  if (!doc) return null;
  return {
    id: doc.id,
    user_id: doc.user_id,
    api_key: doc.api_key,
    name: doc.name || "default",
    created_at: doc.created_at || null,
    last_used_at: doc.last_used_at || null,
  };
}

async function connectMongo() {
  if (db) return db;
  mongoClient = new MongoClient(MONGODB_URI, {
    maxPoolSize: 10,
    minPoolSize: 1,
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000,
  });
  await mongoClient.connect();
  db = mongoClient.db(); // uses /drago from URI
  col.users = db.collection("users");
  col.games = db.collection("games");
  col.api_keys = db.collection("api_keys");
  col.api_usage = db.collection("api_usage");
  col.counters = db.collection("counters");

  // Minimal indexes only (no bloat)
  await Promise.all([
    col.users.createIndex({ google_id: 1 }, { unique: true }),
    col.users.createIndex({ id: 1 }, { unique: true }),
    col.games.createIndex({ id: 1 }, { unique: true }),
    col.games.createIndex({ sort_order: 1 }),
    col.api_keys.createIndex({ api_key: 1 }, { unique: true }),
    col.api_keys.createIndex({ user_id: 1 }),
    col.api_keys.createIndex({ id: 1 }, { unique: true }),
    col.api_usage.createIndex(
      { api_key_id: 1, endpoint: 1, day: 1 },
      { unique: true }
    ),
    col.api_usage.createIndex({ user_id: 1, day: 1 }),
    // TTL on expire_at Date → auto-purge usage older than ~90 days
    col.api_usage.createIndex(
      { expire_at: 1 },
      { expireAfterSeconds: 0 }
    ),
  ]);
  console.log("✅ MongoDB connected");
  return db;
}

// ── DB helpers (async, lean) ────────────────────────────────────────────────

async function dbFindUserByGoogle(googleId) {
  return mapUser(await col.users.findOne({ google_id: googleId }));
}
async function dbFindUserById(id) {
  return mapUser(await col.users.findOne({ id: Number(id) }));
}
async function dbFindUserByIdLite(id) {
  const u = await dbFindUserById(id);
  if (!u) return null;
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    picture: u.picture,
    is_pro: u.is_pro,
    pro_plan: u.pro_plan,
    pro_expires_at: u.pro_expires_at,
  };
}
async function dbInsertUser(googleId, email, name, picture) {
  const id = await nextSeq("users");
  const doc = {
    id,
    google_id: googleId,
    email: email || "",
    name: name || "",
    picture: picture || "",
    is_pro: 0,
    pro_plan: null,
    pro_expires_at: null,
    free_pred_used: 0,
    created_at: new Date().toISOString(),
  };
  await col.users.insertOne(doc);
  return mapUser(doc);
}
async function dbUpdateUserProfile(googleId, name, picture) {
  await col.users.updateOne(
    { google_id: googleId },
    { $set: { name: name || "", picture: picture || "" } }
  );
}
async function dbSetUserPro(userId, isPro, planKey, expires) {
  await col.users.updateOne(
    { id: Number(userId) },
    {
      $set: {
        is_pro: isPro ? 1 : 0,
        pro_plan: planKey || null,
        pro_expires_at: expires || null,
      },
    }
  );
}
async function dbGetFreePredUsed(userId) {
  const u = await col.users.findOne(
    { id: Number(userId) },
    { projection: { free_pred_used: 1 } }
  );
  return Number(u && u.free_pred_used) || 0;
}
async function dbBumpFreePred(userId) {
  await col.users.updateOne(
    { id: Number(userId) },
    { $inc: { free_pred_used: 1 } }
  );
}

async function dbListGames() {
  const rows = await col.games
    .find({})
    .sort({ sort_order: 1, id: 1 })
    .toArray();
  return rows.map(mapGame);
}
async function dbFindGame(id) {
  return mapGame(await col.games.findOne({ id: Number(id) }));
}
async function dbInsertGame(name, imageUrl, linkUrl, sortOrder) {
  const id = await nextSeq("games");
  const doc = {
    id,
    name,
    image_url: imageUrl,
    link_url: linkUrl,
    sort_order: Number(sortOrder) || 0,
    created_at: new Date().toISOString(),
  };
  await col.games.insertOne(doc);
  return { lastInsertRowid: id, id };
}
async function dbDeleteGame(id) {
  const r = await col.games.deleteOne({ id: Number(id) });
  return { changes: r.deletedCount || 0 };
}
async function dbMaxGameOrder() {
  const row = await col.games
    .find({})
    .sort({ sort_order: -1 })
    .limit(1)
    .project({ sort_order: 1 })
    .toArray();
  return { m: row[0] ? Number(row[0].sort_order) || 0 : 0 };
}

async function dbInsertApiKey(userId, apiKey, name) {
  const id = await nextSeq("api_keys");
  const doc = {
    id,
    user_id: Number(userId),
    api_key: apiKey,
    name: name || "default",
    created_at: new Date().toISOString(),
    last_used_at: null,
  };
  await col.api_keys.insertOne(doc);
  return { lastInsertRowid: id, id };
}
async function dbListApiKeys(userId) {
  const rows = await col.api_keys
    .find({ user_id: Number(userId) })
    .sort({ id: -1 })
    .toArray();
  return rows.map(mapApiKey);
}
async function dbFindApiKey(key) {
  return mapApiKey(await col.api_keys.findOne({ api_key: key }));
}
async function dbDeleteApiKey(id, userId) {
  const r = await col.api_keys.deleteOne({
    id: Number(id),
    user_id: Number(userId),
  });
  return { changes: r.deletedCount || 0 };
}
async function dbTouchApiKey(id) {
  await col.api_keys.updateOne(
    { id: Number(id) },
    { $set: { last_used_at: new Date().toISOString() } }
  );
}
async function dbCountUserApiKeys(userId) {
  const c = await col.api_keys.countDocuments({ user_id: Number(userId) });
  return { c };
}
async function dbBumpApiUsage(userId, apiKeyId, endpoint, day) {
  // expire_at = day + 90d so Atlas TTL keeps collection lean
  const expireAt = new Date(String(day) + "T00:00:00.000Z");
  expireAt.setUTCDate(expireAt.getUTCDate() + 90);
  await col.api_usage.updateOne(
    {
      api_key_id: Number(apiKeyId),
      endpoint: String(endpoint),
      day: String(day),
    },
    {
      $inc: { hits: 1 },
      $setOnInsert: {
        user_id: Number(userId),
        api_key_id: Number(apiKeyId),
        endpoint: String(endpoint),
        day: String(day),
        expire_at: expireAt,
      },
    },
    { upsert: true }
  );
}
async function dbUsageByUserToday(userId, day) {
  return col.api_usage
    .aggregate([
      { $match: { user_id: Number(userId), day: String(day) } },
      { $group: { _id: "$endpoint", hits: { $sum: "$hits" } } },
      { $project: { endpoint: "$_id", hits: 1, _id: 0 } },
    ])
    .toArray();
}
async function dbUsageByUserTotal(userId) {
  return col.api_usage
    .aggregate([
      { $match: { user_id: Number(userId) } },
      { $group: { _id: "$endpoint", hits: { $sum: "$hits" } } },
      { $project: { endpoint: "$_id", hits: 1, _id: 0 } },
    ])
    .toArray();
}
async function dbUsageByKey(apiKeyId) {
  return col.api_usage
    .aggregate([
      { $match: { api_key_id: Number(apiKeyId) } },
      { $group: { _id: "$endpoint", hits: { $sum: "$hits" } } },
      { $project: { endpoint: "$_id", hits: 1, _id: 0 } },
    ])
    .toArray();
}
async function dbUsageByKeyToday(apiKeyId, day) {
  return col.api_usage
    .aggregate([
      {
        $match: {
          api_key_id: Number(apiKeyId),
          day: String(day),
        },
      },
      { $group: { _id: "$endpoint", hits: { $sum: "$hits" } } },
      { $project: { endpoint: "$_id", hits: 1, _id: 0 } },
    ])
    .toArray();
}
async function dbPing() {
  await db.command({ ping: 1 });
}

/** Runtime admin settings (Telegram bot can change these) */
const ADMIN_SETTINGS_PATH = path.join(__dirname, "admin-settings.json");
const DEFAULT_ADMIN_SETTINGS = {
  google_auth_enabled: true,
  auto_payment_enabled: true, // Rupayex gateway
  manual_payment_enabled: true, // QR + UTR
  free_pred_limit: 3,
  free_api_history_limit: 10,
};
let adminSettings = { ...DEFAULT_ADMIN_SETTINGS };

function loadAdminSettings() {
  try {
    if (fs.existsSync(ADMIN_SETTINGS_PATH)) {
      const raw = JSON.parse(fs.readFileSync(ADMIN_SETTINGS_PATH, "utf8"));
      adminSettings = { ...DEFAULT_ADMIN_SETTINGS, ...(raw || {}) };
    }
  } catch (e) {
    console.warn("admin-settings load:", e.message);
    adminSettings = { ...DEFAULT_ADMIN_SETTINGS };
  }
}
function saveAdminSettings() {
  try {
    fs.writeFileSync(
      ADMIN_SETTINGS_PATH,
      JSON.stringify(adminSettings, null, 2),
      "utf8"
    );
  } catch (e) {
    console.error("admin-settings save:", e.message);
  }
}
loadAdminSettings();

function freePredLimit() {
  const n = Number(adminSettings.free_pred_limit);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 3;
}
function freeApiHistoryLimit() {
  const n = Number(adminSettings.free_api_history_limit);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 10;
}
/** @deprecated use freePredLimit() / freeApiHistoryLimit() */
const FREE_PRED_LIMIT = 3;
const FREE_API_HISTORY_LIMIT = 10;
const SERVER_BRAND = "🐉 DRAGO PREDICTOR";

/** Developer API rate limit: 20 requests / minute / user / endpoint */
const API_RATE_LIMIT = 20;
const API_RATE_WINDOW_MS = 60 * 1000;
const apiRateBuckets = new Map(); // `${userId}:${endpoint}` → number[] timestamps

function checkApiRateLimit(userId, endpoint) {
  const k = String(userId) + ":" + endpoint;
  const now = Date.now();
  let arr = apiRateBuckets.get(k) || [];
  arr = arr.filter((t) => now - t < API_RATE_WINDOW_MS);
  if (arr.length >= API_RATE_LIMIT) {
    const resetMs = Math.max(0, API_RATE_WINDOW_MS - (now - arr[0]));
    return {
      ok: false,
      limit: API_RATE_LIMIT,
      remaining: 0,
      reset_sec: Math.ceil(resetMs / 1000),
    };
  }
  arr.push(now);
  apiRateBuckets.set(k, arr);
  // light cleanup
  if (apiRateBuckets.size > 5000) {
    for (const [key, ts] of apiRateBuckets) {
      const live = ts.filter((t) => now - t < API_RATE_WINDOW_MS);
      if (!live.length) apiRateBuckets.delete(key);
      else apiRateBuckets.set(key, live);
    }
  }
  return {
    ok: true,
    limit: API_RATE_LIMIT,
    remaining: API_RATE_LIMIT - arr.length,
    reset_sec: 60,
  };
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

async function recordApiUsage(userId, apiKeyId, endpoint) {
  try {
    await dbBumpApiUsage(userId, apiKeyId, endpoint, todayKey());
  } catch (e) {
    console.error("api_usage:", e.message);
  }
}

/**
 * Validate X-API-Key / ?api_key=, rate-limit, free/pro quotas, touch + usage.
 * Returns { row, rate, isPro } or sends error response and returns null.
 *
 * Free users:
 *   - history only (prediction blocked)
 *   - lifetime max freeApiHistoryLimit() history fetches
 * Pro users:
 *   - 20 requests / minute / endpoint (unchanged)
 */
async function requireApiKey(req, res, endpointName) {
  const key = String(
    req.headers["x-api-key"] || req.query.api_key || ""
  ).trim();
  if (!key || key.length < 16) {
    res.status(401).json({
      success: false,
      message: "API key required (header X-API-Key or ?api_key=)",
    });
    return null;
  }
  const row = await dbFindApiKey(key);
  if (!row) {
    res.status(401).json({ success: false, message: "Invalid API key" });
    return null;
  }

  const user = await dbFindUserById(row.user_id);
  const isPro = userIsPro(user);

  // History: free + any pro. Prediction API: ONLY RX1 FOR PROFIT (₹900)
  if (endpointName === "prediction") {
    const planKey = user && user.pro_plan ? String(user.pro_plan) : "";
    if (!isPro || planKey !== "profit") {
      res.status(403).json({
        success: false,
        message:
          "Prediction API is available only on RX1 FOR PROFIT (₹900) plan. Upgrade to access.",
        billing_required: true,
        plan: planKey || (isPro ? "pro" : "free"),
        required_plan: "profit",
      });
      return null;
    }
  } else if (endpointName !== "history" && !isPro) {
    res.status(403).json({
      success: false,
      message:
        "Free plan: only history data fetch is allowed. Upgrade to Pro for prediction API.",
      billing_required: true,
      plan: "free",
    });
    return null;
  }

  // Free: lifetime history quota
  if (!isPro && endpointName === "history") {
    const totalUsage = usageMap(await dbUsageByUserTotal(row.user_id));
    const historyHits = Number(totalUsage.history) || 0;
    if (historyHits >= freeApiHistoryLimit()) {
      res.status(402).json({
        success: false,
        message:
          "Free plan limit reached (10 history fetches). Please upgrade to Pro / complete billing.",
        billing_required: true,
        plan: "free",
        used: historyHits,
        limit: freeApiHistoryLimit(),
      });
      return null;
    }
  }

  const rate = isPro
    ? checkApiRateLimit(row.user_id, endpointName)
    : {
        ok: true,
        limit: freeApiHistoryLimit(),
        remaining: Math.max(
          0,
          freeApiHistoryLimit() -
            (Number(
              usageMap(await dbUsageByUserTotal(row.user_id)).history
            ) || 0)
        ),
        reset_sec: 0,
      };

  if (isPro) {
    res.setHeader("X-RateLimit-Limit", String(rate.limit));
    res.setHeader("X-RateLimit-Remaining", String(rate.remaining));
    res.setHeader("X-RateLimit-Reset", String(rate.reset_sec));
    if (!rate.ok) {
      res.status(429).json({
        success: false,
        message: `Rate limit: max ${rate.limit} requests per minute for ${endpointName}`,
        limit: rate.limit,
        remaining: 0,
        reset_sec: rate.reset_sec,
      });
      return null;
    }
  } else {
    res.setHeader("X-RateLimit-Limit", String(freeApiHistoryLimit()));
    res.setHeader(
      "X-RateLimit-Remaining",
      String(Math.max(0, rate.remaining - 1))
    );
  }

  try {
    await dbTouchApiKey(row.id);
  } catch (_) {}
  await recordApiUsage(row.user_id, row.id, endpointName);
  return { row, rate, isPro };
}

function usageMap(rows) {
  const out = { history: 0, prediction: 0, total: 0 };
  for (const r of rows || []) {
    const ep = String(r.endpoint || "");
    const h = Number(r.hits) || 0;
    if (ep === "history") out.history += h;
    else if (ep === "prediction") out.prediction += h;
    out.total += h;
  }
  return out;
}

async function fetchWingoPrediction() {
  if (!WINGO_PREDICTION_URL) {
    const err = new Error("Prediction source not configured");
    err.status = 503;
    throw err;
  }
  const response = await fetch(WINGO_PREDICTION_URL, {
    signal: AbortSignal.timeout(10000),
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    const err = new Error(`Upstream error: ${response.status}`);
    err.status = 502;
    throw err;
  }
  const data = await response.json();
  const { max_consec_today, max_level_today, ...clean } = data || {};
  return clean;
}

/**
 * Payments store = payments.json ONLY (never deleted, never in MongoDB).
 * Users / games / api_keys in MongoDB; all order rows live in this file forever.
 */
const PAYMENTS_JSON_PATH = path.join(__dirname, "payments.json");
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
      .filter(
        (o) =>
          o &&
          Number(o.user_id) === uid &&
          String(o.plan) === plan &&
          String(o.payment_status || "").toUpperCase() === "PENDING" &&
          String(o.method || "") === "UPI_MANUAL" &&
          Date.parse(o.created_at || 0) >= cutoff
      )
      .sort(
        (a, b) =>
          Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0)
      )[0] || null
  );
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
  schedulePaymentsFlush();
  flushPaymentsSync();
  return row;
}

function expireStaleOrders() {
  // PENDING older than 10 min → EXPIRED (still kept forever in payments.json)
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

// ─── WinGo 30s history (poll at :00 / :30, max 1000 rows) ───────────────────
const WINGO_HISTORY_URL =
  process.env.WINGO_HISTORY_URL ||
  "https://draw.ar-lottery01.com/WinGo/WinGo_30S/GetHistoryIssuePage.json";
const WINGO_HISTORY_PATH = path.join(__dirname, "wingo30s_history.json");
const WINGO_HISTORY_MAX = 1000;
let wingoHistoryCache = null;
let wingoHistoryMeta = {
  last_poll_at: null,
  last_ok: false,
  last_error: null,
  last_added: 0,
  count: 0,
};

function loadWingoHistory() {
  if (wingoHistoryCache) return wingoHistoryCache;
  try {
    if (!fs.existsSync(WINGO_HISTORY_PATH)) {
      wingoHistoryCache = [];
      return wingoHistoryCache;
    }
    const raw = fs.readFileSync(WINGO_HISTORY_PATH, "utf8");
    const data = JSON.parse(raw || "[]");
    if (Array.isArray(data)) {
      wingoHistoryCache = data;
    } else if (data && Array.isArray(data.items)) {
      wingoHistoryCache = data.items;
    } else {
      wingoHistoryCache = [];
    }
  } catch (e) {
    console.error("read wingo30s_history.json:", e.message);
    wingoHistoryCache = [];
  }
  wingoHistoryMeta.count = wingoHistoryCache.length;
  return wingoHistoryCache;
}

function saveWingoHistory(items) {
  wingoHistoryCache = items;
  wingoHistoryMeta.count = items.length;
  const payload = {
    updated_at: new Date().toISOString(),
    count: items.length,
    items,
  };
  const tmp = WINGO_HISTORY_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(payload), "utf8");
  fs.renameSync(tmp, WINGO_HISTORY_PATH);
}

function issueKey(row) {
  if (!row || typeof row !== "object") return null;
  const k =
    row.issueNumber ||
    row.issue_number ||
    row.issue ||
    row.period ||
    row.issueNo ||
    row.issue_no ||
    row.expect ||
    null;
  return k != null ? String(k) : null;
}

function extractHistoryList(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.list)) return payload.list;
  if (Array.isArray(payload.data)) return payload.data;
  if (payload.data && Array.isArray(payload.data.list)) return payload.data.list;
  if (payload.data && Array.isArray(payload.data.records))
    return payload.data.records;
  if (Array.isArray(payload.records)) return payload.records;
  if (Array.isArray(payload.result)) return payload.result;
  return [];
}

async function pollWingoHistory() {
  const t0 = Date.now();
  try {
    const res = await fetch(WINGO_HISTORY_URL, {
      method: "GET",
      signal: AbortSignal.timeout(12000),
      headers: {
        Accept: "application/json, text/plain, */*",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
        Referer: "https://draw.ar-lottery01.com/",
        Origin: "https://draw.ar-lottery01.com",
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} ${body.slice(0, 120)}`);
    }
    const json = await res.json();
    const incoming = extractHistoryList(json);
    if (!incoming.length) {
      wingoHistoryMeta.last_poll_at = new Date().toISOString();
      wingoHistoryMeta.last_ok = true;
      wingoHistoryMeta.last_error = "empty list";
      wingoHistoryMeta.last_added = 0;
      return;
    }

    const existing = loadWingoHistory();
    const seen = new Set();
    for (const row of existing) {
      const k = issueKey(row);
      if (k) seen.add(k);
    }

    const fresh = [];
    for (const row of incoming) {
      const k = issueKey(row);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      fresh.push(row);
    }

    // Newest first: new rows on top, then old; cap at 1000
    let merged = fresh.length ? fresh.concat(existing) : existing;
    if (merged.length > WINGO_HISTORY_MAX) {
      merged = merged.slice(0, WINGO_HISTORY_MAX);
    }
    if (fresh.length || existing.length !== merged.length) {
      saveWingoHistory(merged);
    }

    wingoHistoryMeta.last_poll_at = new Date().toISOString();
    wingoHistoryMeta.last_ok = true;
    wingoHistoryMeta.last_error = null;
    wingoHistoryMeta.last_added = fresh.length;
    wingoHistoryMeta.count = merged.length;
    if (fresh.length) {
      console.log(
        `📊 wingo history +${fresh.length} (total ${merged.length}) ${Date.now() - t0}ms`
      );
    }
  } catch (err) {
    wingoHistoryMeta.last_poll_at = new Date().toISOString();
    wingoHistoryMeta.last_ok = false;
    wingoHistoryMeta.last_error = String(err.message || err).slice(0, 200);
    console.error("wingo history poll:", wingoHistoryMeta.last_error);
  }
}

/** Align first run to next clock :00 or :30, then every 30s */
function startWingoHistoryScheduler() {
  const msToNextHalf = () => {
    const now = Date.now();
    const d = new Date(now);
    const sec = d.getSeconds();
    const ms = d.getMilliseconds();
    const waitSec = sec < 30 ? 30 - sec : 60 - sec;
    return Math.max(50, waitSec * 1000 - ms);
  };

  // Warm load + immediate first attempt (then schedule on half-minute)
  try {
    loadWingoHistory();
  } catch (_) {}
  pollWingoHistory().catch(() => {});

  setTimeout(() => {
    pollWingoHistory().catch(() => {});
    setInterval(() => {
      pollWingoHistory().catch(() => {});
    }, 30 * 1000);
  }, msToNextHalf());

  console.log("   WinGo history poller: every :00 / :30 (+ align)");
}

function isDiskFullError(err) {
  const m = String((err && err.message) || err || "").toLowerCase();
  return (
    m.includes("database or disk is full") ||
    m.includes("sqlite_full") ||
    m.includes("disk i/o error") ||
    m.includes("no space left") ||
    m.includes("enospc") ||
    m.includes("quota")
  );
}

/** Compatibility wrapper — payments are file-based; just run fn */
function safeDbWrite(fn) {
  return fn();
}

function userIsPro(user) {
  if (!user || !user.is_pro) return false;
  if (!user.pro_expires_at) return true;
  return new Date(user.pro_expires_at).getTime() > Date.now();
}

async function activatePro(userId, planKey) {
  const plan = PLAN_CATALOG[planKey];
  if (!plan) return null;
  const expires = new Date(Date.now() + plan.days * 86400000).toISOString();
  await dbSetUserPro(userId, 1, planKey, expires);
  return { plan: planKey, pro_expires_at: expires, days: plan.days };
}

async function telegramApi(method, body) {
  if (!TELEGRAM_BOT_TOKEN) return null;
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    return await res.json();
  } catch (err) {
    console.error("telegram:", method, err.message);
    return null;
  }
}

async function notifyAdminManualPayment({ orderId, user, planKey, amount, utr }) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_ADMIN_CHAT_ID) {
    console.warn("Telegram not configured — skip admin notify");
    return;
  }
  const plan = PLAN_CATALOG[planKey];
  const when = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  const text =
    `🧾 New manual payment\n\n` +
    `👤 Name: ${user.name || "—"}\n` +
    `📧 Email: ${user.email || "—"}\n` +
    `📦 Plan: ${plan ? plan.name : planKey}\n` +
    `💰 Amount: ₹${amount}\n` +
    `🔖 UTR: ${utr}\n` +
    `🆔 Order: ${orderId}\n` +
    `🕐 Time: ${when} IST`;

  // callback_data max 64 bytes — use short codes a: / d:
  const payload = {
    chat_id: Number(TELEGRAM_ADMIN_CHAT_ID) || TELEGRAM_ADMIN_CHAT_ID,
    text,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ Approve", callback_data: `a:${orderId}` },
          { text: "❌ Deny", callback_data: `d:${orderId}` },
        ],
      ],
    },
  };
  const result = await telegramApi("sendMessage", payload);
  if (!result || !result.ok) {
    console.error("Telegram sendMessage failed:", JSON.stringify(result));
  }
  return result;
}

/** Shared Approve / Deny handler (webhook + polling) */
async function handleTelegramCallback(cb) {
  if (!cb || !cb.data) return;
  const data = String(cb.data);
  const chatId = cb.message && cb.message.chat && cb.message.chat.id;
  const msgId = cb.message && cb.message.message_id;

  // Admin config toggles (cfg:*)
  if (data.startsWith("cfg:")) {
    if (!isTelegramAdmin(chatId)) {
      await telegramApi("answerCallbackQuery", {
        callback_query_id: cb.id,
        text: "Not admin",
        show_alert: true,
      });
      return;
    }
    const parts = data.split(":");
    const key = parts[1] || "";
    const arg = parts[2];
    if (key === "google") {
      adminSettings.google_auth_enabled = !adminSettings.google_auth_enabled;
    } else if (key === "auto") {
      adminSettings.auto_payment_enabled = !adminSettings.auto_payment_enabled;
    } else if (key === "manual") {
      adminSettings.manual_payment_enabled = !adminSettings.manual_payment_enabled;
    } else if (key === "pred" && arg != null) {
      const delta = Number(arg) || 0;
      adminSettings.free_pred_limit = Math.max(
        0,
        Math.min(1000, Number(adminSettings.free_pred_limit) + delta)
      );
    } else if (key === "hist" && arg != null) {
      const delta = Number(arg) || 0;
      adminSettings.free_api_history_limit = Math.max(
        0,
        Math.min(100000, Number(adminSettings.free_api_history_limit) + delta)
      );
    }
    // refresh always saves current state
    saveAdminSettings();
    await telegramApi("answerCallbackQuery", {
      callback_query_id: cb.id,
      text: "Updated",
    });
    // Refresh panel message
    const s = adminSettings;
    try {
      await telegramApi("editMessageText", {
        chat_id: chatId,
        message_id: msgId,
        text: adminPanelText(),
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: s.google_auth_enabled
                  ? "🔴 Disable Google Auth"
                  : "🟢 Enable Google Auth",
                callback_data: "cfg:google",
              },
            ],
            [
              {
                text: s.auto_payment_enabled
                  ? "🔴 Disable Auto Pay"
                  : "🟢 Enable Auto Pay",
                callback_data: "cfg:auto",
              },
              {
                text: s.manual_payment_enabled
                  ? "🔴 Disable Manual"
                  : "🟢 Enable Manual",
                callback_data: "cfg:manual",
              },
            ],
            [
              { text: "Pred −1", callback_data: "cfg:pred:-1" },
              { text: "Pred +1", callback_data: "cfg:pred:1" },
              { text: "Pred +5", callback_data: "cfg:pred:5" },
            ],
            [
              { text: "Hist −5", callback_data: "cfg:hist:-5" },
              { text: "Hist +5", callback_data: "cfg:hist:5" },
              { text: "Hist +10", callback_data: "cfg:hist:10" },
            ],
            [{ text: "🔄 Refresh", callback_data: "cfg:refresh" }],
          ],
        },
      });
    } catch (e) {
      console.error("tg panel edit:", e.message);
    }
    return;
  }

  let action = null;
  let orderId = null;
  if (data.startsWith("a:")) {
    action = "approve";
    orderId = data.slice(2);
  } else if (data.startsWith("d:")) {
    action = "deny";
    orderId = data.slice(2);
  } else if (data.startsWith("approve:")) {
    action = "approve";
    orderId = data.slice(8);
  } else if (data.startsWith("deny:")) {
    action = "deny";
    orderId = data.slice(5);
  }

  if (!orderId || (action !== "approve" && action !== "deny")) {
    await telegramApi("answerCallbackQuery", {
      callback_query_id: cb.id,
      text: "Unknown action",
    });
    return;
  }

  const order = findOrder(orderId);
  if (!order) {
    await telegramApi("answerCallbackQuery", {
      callback_query_id: cb.id,
      text: "Order not found",
      show_alert: true,
    });
    return;
  }

  const st = String(order.payment_status || "").toUpperCase();
  if (st === "SUCCESS" || st === "FAILED" || st === "EXPIRED") {
    await telegramApi("answerCallbackQuery", {
      callback_query_id: cb.id,
      text: "Already processed: " + st,
      show_alert: true,
    });
    return;
  }

  if (action === "approve") {
    updateOrderStatus(
      orderId,
      "SUCCESS",
      order.utr || null,
      order.method || "UPI_MANUAL",
      order.raw_response || null
    );
    const pro = await activatePro(order.user_id, order.plan);
    await telegramApi("answerCallbackQuery", {
      callback_query_id: cb.id,
      text: "Approved — user is Pro",
    });
    if (chatId && msgId) {
      await telegramApi("editMessageText", {
        chat_id: chatId,
        message_id: msgId,
        text:
          `✅ APPROVED\nOrder: ${orderId}\nUser #${order.user_id} → Pro (${order.plan})` +
          (pro ? `\nExpires: ${pro.pro_expires_at}` : ""),
        reply_markup: { inline_keyboard: [] },
      });
    }
    console.log("✅ pro approved:", orderId, order.user_id, order.plan);
  } else {
    updateOrderStatus(
      orderId,
      "FAILED",
      order.utr || null,
      order.method || "UPI_MANUAL",
      order.raw_response || null
    );
    await telegramApi("answerCallbackQuery", {
      callback_query_id: cb.id,
      text: "Denied",
    });
    if (chatId && msgId) {
      await telegramApi("editMessageText", {
        chat_id: chatId,
        message_id: msgId,
        text: `❌ DENIED\nOrder: ${orderId}`,
        reply_markup: { inline_keyboard: [] },
      });
    }
    console.log("❌ payment denied:", orderId);
  }
}

/** Admin multi-step conversations (e.g. /addgame) */
const tgConversations = new Map(); // chatId → { step, data, expires }

function isTelegramAdmin(chatId) {
  if (!TELEGRAM_ADMIN_CHAT_ID) return false;
  return String(chatId) === String(TELEGRAM_ADMIN_CHAT_ID);
}

async function tgReply(chatId, text) {
  return telegramApi("sendMessage", {
    chat_id: chatId,
    text: String(text || "").slice(0, 4000),
  });
}

function looksLikeUrl(s) {
  try {
    const u = new URL(String(s || "").trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

async function handleTelegramMessage(msg) {
  if (!msg || !msg.chat) return;
  const chatId = msg.chat.id;
  const text = String(msg.text || "").trim();
  if (!text) return;

  if (!isTelegramAdmin(chatId)) {
    // Ignore non-admin private messages (payment buttons still work via callback)
    return;
  }

  const lower = text.toLowerCase();
  const conv = tgConversations.get(String(chatId));

  // Cancel
  if (lower === "/cancel") {
    tgConversations.delete(String(chatId));
    await tgReply(chatId, "Cancelled.");
    return;
  }

  // /listgames
  if (lower === "/listgames" || lower === "/games") {
    const rows = await dbListGames();
    if (!rows.length) {
      await tgReply(chatId, "No games yet. Use /addgame");
      return;
    }
    const lines = rows.map(
      (g, i) =>
        `${i + 1}. [#${g.id}] ${g.name}\n   img: ${g.image_url}\n   link: ${g.link_url}`
    );
    await tgReply(chatId, "🎮 Games:\n\n" + lines.join("\n\n"));
    return;
  }

  // /delgame <id>
  if (lower.startsWith("/delgame")) {
    const id = Number(text.split(/\s+/)[1]);
    if (!id) {
      await tgReply(chatId, "Usage: /delgame <id>");
      return;
    }
    const existing = await dbFindGame(id);
    if (!existing) {
      await tgReply(chatId, "Game not found: #" + id);
      return;
    }
    await dbDeleteGame(id);
    await tgReply(chatId, `Deleted game #${id} (${existing.name})`);
    return;
  }

  // Start /addgame
  if (lower === "/addgame" || lower.startsWith("/addgame ")) {
    tgConversations.set(String(chatId), {
      step: "name",
      data: {},
      expires: Date.now() + 10 * 60 * 1000,
    });
    await tgReply(
      chatId,
      "🎮 Add Game\n\nStep 1/3 — Send the game NAME\n\n(or /cancel)"
    );
    return;
  }

  // Continue conversation
  if (conv && conv.expires > Date.now()) {
    if (conv.step === "name") {
      const name = text.slice(0, 80).trim();
      if (name.length < 1) {
        await tgReply(chatId, "Name too short. Send game name again:");
        return;
      }
      conv.data.name = name;
      conv.step = "image";
      conv.expires = Date.now() + 10 * 60 * 1000;
      await tgReply(
        chatId,
        `✅ Name: ${name}\n\nStep 2/3 — Send IMAGE URL (https://...)`
      );
      return;
    }
    if (conv.step === "image") {
      if (!looksLikeUrl(text)) {
        await tgReply(chatId, "Invalid URL. Send a full https image URL:");
        return;
      }
      conv.data.image_url = text.trim();
      conv.step = "link";
      conv.expires = Date.now() + 10 * 60 * 1000;
      await tgReply(
        chatId,
        `✅ Image saved\n\nStep 3/3 — Send GAME LINK (URL that opens in gameplay)`
      );
      return;
    }
    if (conv.step === "link") {
      if (!looksLikeUrl(text)) {
        await tgReply(chatId, "Invalid URL. Send a full https game link:");
        return;
      }
      conv.data.link_url = text.trim();
      const maxOrd = await dbMaxGameOrder();
      const nextOrd = (maxOrd && maxOrd.m != null ? Number(maxOrd.m) : 0) + 1;
      const info = await dbInsertGame(
        conv.data.name,
        conv.data.image_url,
        conv.data.link_url,
        nextOrd
      );
      tgConversations.delete(String(chatId));
      await tgReply(
        chatId,
        `✅ Game added!\n\n#${info.lastInsertRowid}\nName: ${conv.data.name}\nImage: ${conv.data.image_url}\nLink: ${conv.data.link_url}\n\nIt will show on the Game page.`
      );
      return;
    }
  } else if (conv) {
    tgConversations.delete(String(chatId));
  }

  // /settings or /panel — admin control panel
  if (
    lower === "/start" ||
    lower === "/help" ||
    lower === "/settings" ||
    lower === "/panel" ||
    lower === "/admin"
  ) {
    await sendAdminPanel(chatId);
    return;
  }

  // /freepred 5
  if (lower.startsWith("/freepred")) {
    const n = Number(text.split(/\s+/)[1]);
    if (!Number.isFinite(n) || n < 0 || n > 1000) {
      await tgReply(chatId, "Usage: /freepred <number>\nExample: /freepred 5");
      return;
    }
    adminSettings.free_pred_limit = Math.floor(n);
    saveAdminSettings();
    await tgReply(chatId, "✅ Free prediction limit = " + adminSettings.free_pred_limit);
    return;
  }
  // /freehistory 10
  if (lower.startsWith("/freehistory") || lower.startsWith("/freeapi")) {
    const n = Number(text.split(/\s+/)[1]);
    if (!Number.isFinite(n) || n < 0 || n > 100000) {
      await tgReply(chatId, "Usage: /freehistory <number>\nExample: /freehistory 10");
      return;
    }
    adminSettings.free_api_history_limit = Math.floor(n);
    saveAdminSettings();
    await tgReply(chatId, "✅ Free API history limit = " + adminSettings.free_api_history_limit);
    return;
  }
}

function adminPanelText() {
  const s = adminSettings;
  const on = (v) => (v ? "✅ ON" : "❌ OFF");
  return (
    "🐉 DRAGO Admin Panel\n\n" +
    "Google Auth: " + on(s.google_auth_enabled) + "\n" +
    "Auto Payment (Rupayex): " + on(s.auto_payment_enabled) + "\n" +
    "Manual QR Payment: " + on(s.manual_payment_enabled) + "\n" +
    "Free predictions: " + s.free_pred_limit + "\n" +
    "Free API history fetches: " + s.free_api_history_limit + "\n\n" +
    "Commands:\n" +
    "/freepred 5 — set free prediction limit\n" +
    "/freehistory 10 — set free history API limit\n" +
    "/addgame /listgames /delgame <id>\n" +
    "/cancel"
  );
}

async function sendAdminPanel(chatId) {
  const s = adminSettings;
  await telegramApi("sendMessage", {
    chat_id: chatId,
    text: adminPanelText(),
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: s.google_auth_enabled ? "🔴 Disable Google Auth" : "🟢 Enable Google Auth",
            callback_data: "cfg:google",
          },
        ],
        [
          {
            text: s.auto_payment_enabled ? "🔴 Disable Auto Pay" : "🟢 Enable Auto Pay",
            callback_data: "cfg:auto",
          },
          {
            text: s.manual_payment_enabled ? "🔴 Disable Manual" : "🟢 Enable Manual",
            callback_data: "cfg:manual",
          },
        ],
        [
          { text: "Pred −1", callback_data: "cfg:pred:-1" },
          { text: "Pred +1", callback_data: "cfg:pred:1" },
          { text: "Pred +5", callback_data: "cfg:pred:5" },
        ],
        [
          { text: "Hist −5", callback_data: "cfg:hist:-5" },
          { text: "Hist +5", callback_data: "cfg:hist:5" },
          { text: "Hist +10", callback_data: "cfg:hist:10" },
        ],
        [{ text: "🔄 Refresh", callback_data: "cfg:refresh" }],
      ],
    },
  });
}

/** Long-poll Telegram updates so Approve/Deny + /addgame work */
let tgOffset = 0;
let tgPolling = false;
async function pollTelegramUpdates() {
  if (!TELEGRAM_BOT_TOKEN || tgPolling) return;
  tgPolling = true;
  try {
    const url =
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates` +
      `?timeout=25&offset=${tgOffset}&allowed_updates=${encodeURIComponent(
        JSON.stringify(["callback_query", "message"])
      )}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(35000) });
    const data = await res.json();
    if (data && data.ok && Array.isArray(data.result)) {
      for (const upd of data.result) {
        tgOffset = upd.update_id + 1;
        if (upd.callback_query) {
          try {
            await handleTelegramCallback(upd.callback_query);
          } catch (e) {
            console.error("tg callback:", e.message);
          }
        }
        if (upd.message) {
          try {
            await handleTelegramMessage(upd.message);
          } catch (e) {
            console.error("tg message:", e.message);
          }
        }
      }
    }
  } catch (err) {
    if (!String(err.message || "").includes("aborted")) {
      console.error("tg poll:", err.message);
    }
  } finally {
    tgPolling = false;
  }
}

console.log("✅ MongoDB driver loaded (connect on listen)");

// ─── OAuth state store (memory) — cookie ke saath double protection ─────────
// Cookie free hosts / cross-proxy pe kabhi fail hoti hai; memory reliable hai.
const oauthStates = new Map(); // state → expiresAt
const STATE_TTL_MS = 10 * 60 * 1000;

function saveState(state) {
  oauthStates.set(state, Date.now() + STATE_TTL_MS);
  // Cleanup stale
  if (oauthStates.size > 500) {
    const now = Date.now();
    for (const [k, exp] of oauthStates) {
      if (exp < now) oauthStates.delete(k);
    }
  }
}

function consumeState(state) {
  if (!state) return false;
  const exp = oauthStates.get(state);
  oauthStates.delete(state);
  return Boolean(exp && exp >= Date.now());
}

// ─── Google client ──────────────────────────────────────────────────────────
const oauth2Client = new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);

// ─── Helpers ────────────────────────────────────────────────────────────────
function publicBase(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  // Cloudflare / reverse-proxy: X-Forwarded-Proto + Host
  const proto =
    (req.get("x-forwarded-proto") || "").split(",")[0].trim() ||
    req.protocol ||
    "https";
  const host = req.get("x-forwarded-host") || req.get("host");
  return `${proto}://${host}`;
}

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, name: user.name },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

function decodeToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

function bearerToken(req) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith("Bearer ")) return null;
  return h.slice(7).trim() || null;
}

async function upsertUser(payload) {
  const googleId = payload.sub;
  const email = payload.email || "";
  const name = payload.name || "";
  const picture = payload.picture || "";

  let user = await dbFindUserByGoogle(googleId);
  if (!user) {
    user = await dbInsertUser(googleId, email, name, picture);
    console.log("🆕 user:", email);
  } else {
    await dbUpdateUserProfile(googleId, name, picture);
    user = { ...user, name, picture };
    console.log("✅ login:", email);
  }
  return user;
}

function authUser(req, res) {
  const token = bearerToken(req);
  if (!token) {
    res.status(401).json({ success: false, message: "No token provided" });
    return null;
  }
  const decoded = decodeToken(token);
  if (!decoded || !decoded.id) {
    res.status(401).json({ success: false, message: "Invalid or expired token" });
    return null;
  }
  // If client sent X-User-Id / X-User-Name (signed), they must match JWT
  const meta = req.dragoMeta;
  if (meta && meta.userIdHdr) {
    if (String(meta.userIdHdr) !== String(decoded.id)) {
      res.status(401).json({ success: false, message: "User mismatch" });
      return null;
    }
  }
  if (meta && meta.userNameHdr && decoded.name) {
    if (String(meta.userNameHdr) !== String(decoded.name)) {
      res.status(401).json({ success: false, message: "User mismatch" });
      return null;
    }
  }
  return decoded;
}


// ─── Request signature + domain lock (frontend → Render) ───────────────────
function timingSafeEqualStr(a, b) {
  try {
    const ba = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

function hmacSign(payload) {
  return crypto.createHmac("sha256", APP_SECRET).update(payload).digest("hex");
}

function buildSignPayload({ method, pathOnly, timestamp, nonce, body, userId, userName }) {
  const bodyHash = crypto
    .createHash("sha256")
    .update(body == null ? "" : typeof body === "string" ? body : JSON.stringify(body))
    .digest("hex");
  return [
    String(method || "GET").toUpperCase(),
    String(pathOnly || ""),
    String(timestamp || ""),
    String(nonce || ""),
    bodyHash,
    String(userId || ""),
    String(userName || ""),
    String(APP_ID),
  ].join("\n");
}

function clientDomain(req) {
  const origin = req.get("origin") || "";
  const referer = req.get("referer") || "";
  const hdr = (req.get("x-client-domain") || "").trim().toLowerCase();
  let host = hdr;
  try {
    if (!host && origin) host = new URL(origin).hostname;
  } catch (_) {}
  try {
    if (!host && referer) host = new URL(referer).hostname;
  } catch (_) {}
  return String(host || "").toLowerCase().replace(/:\d+$/, "");
}

function isAllowedWebDomain(domain) {
  if (!domain) return false;
  const d = domain.toLowerCase();
  return d === ALLOWED_WEB_DOMAIN || d === "localhost" || d === "127.0.0.1";
}

/** Frontend routes: domain + App-Id + timestamp + HMAC signature */
function requireAppSignature(mode) {
  return function appSigMiddleware(req, res, next) {
    if (req.path.startsWith("/v1") || String(req.originalUrl || "").startsWith("/v1")) {
      return next();
    }
    const domain = clientDomain(req);
    if (!isAllowedWebDomain(domain)) {
      return res.status(404).json({ success: false, message: "Not found" });
    }
    const appId = String(req.get("x-app-id") || "").trim();
    const ts = String(req.get("x-timestamp") || "").trim();
    const sig = String(req.get("x-signature") || "").trim();
    const nonce = String(req.get("x-nonce") || "").trim();
    if (!appId || !timingSafeEqualStr(appId, APP_ID)) {
      return res.status(404).json({ success: false, message: "Not found" });
    }
    const tsNum = Number(ts);
    if (!ts || !Number.isFinite(tsNum)) {
      return res.status(401).json({ success: false, message: "Invalid timestamp" });
    }
    if (Math.abs(Date.now() - tsNum) > SIGNATURE_MAX_SKEW_MS) {
      return res.status(401).json({ success: false, message: "Request expired" });
    }
    if (mode === "payment" && (!nonce || nonce.length < 16)) {
      return res.status(401).json({ success: false, message: "Nonce required" });
    }
    const pathOnly = String(req.originalUrl || req.url || "").split("?")[0];
    const userIdHdr = String(req.get("x-user-id") || "").trim();
    const userNameHdr = String(req.get("x-user-name") || "").trim();
    const payload = buildSignPayload({
      method: req.method,
      pathOnly,
      timestamp: ts,
      nonce: mode === "payment" ? nonce : "",
      body: req.method === "GET" || req.method === "HEAD" ? "" : req.body,
      userId: mode === "auth" || mode === "payment" ? userIdHdr : "",
      userName: mode === "auth" || mode === "payment" ? userNameHdr : "",
    });
    const expected = hmacSign(payload);
    if (!sig || !timingSafeEqualStr(sig, expected)) {
      return res.status(401).json({ success: false, message: "Invalid signature" });
    }
    req.dragoMeta = { domain, appId, ts, nonce, userIdHdr, userNameHdr };
    next();
  };
}

// ─── App ────────────────────────────────────────────────────────────────────
const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));

const allowedOrigins = [
  FRONTEND_URL,
  "https://dragopredictor.vercel.app",
  "http://localhost:3000",
  "http://localhost:5173",
  "http://127.0.0.1:3000",
].filter(Boolean);

// Block unknown browser origins on app routes (not /v1)
app.use((req, res, next) => {
  const isV1 = req.path.startsWith("/v1") || String(req.originalUrl || "").startsWith("/v1");
  if (isV1) return next();
  const origin = req.get("origin");
  if (!origin) return next();
  try {
    const host = new URL(origin).hostname;
    if (
      allowedOrigins.includes(origin) ||
      host === ALLOWED_WEB_DOMAIN ||
      host === "localhost" ||
      host === "127.0.0.1"
    ) {
      return next();
    }
  } catch (_) {}
  return res.status(404).json({ success: false, message: "Not found" });
});

app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      try {
        const host = new URL(origin).hostname || "";
        if (host === ALLOWED_WEB_DOMAIN || host === "localhost" || host === "127.0.0.1") {
          return cb(null, true);
        }
      } catch (_) {}
      return cb(null, true);
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-API-Key",
      "x-api-key",
      "Accept",
      "Origin",
      "X-App-Id",
      "X-Timestamp",
      "X-Signature",
      "X-Nonce",
      "X-Client-Domain",
      "X-User-Id",
      "X-User-Name",
    ],
    exposedHeaders: [
      "X-RateLimit-Limit",
      "X-RateLimit-Remaining",
      "X-RateLimit-Reset",
    ],
    optionsSuccessStatus: 204,
    preflightContinue: false,
    credentials: false,
  })
);

// Extra: force ACAO=* on public /v1 developer endpoints (file:// + any site)
app.use("/v1", (req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, OPTIONS"
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-API-Key, x-api-key, Accept, Origin"
  );
  res.setHeader(
    "Access-Control-Expose-Headers",
    "X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset"
  );
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  next();
});

// Explicit OPTIONS for all routes (Cloudflare / some proxies need this)
app.options("*", cors({ origin: true }));

// Signature gates (domain + App-Id + HMAC). /v1 skipped inside middleware.
const sigAuth = requireAppSignature("auth");
const sigPay = requireAppSignature("payment");
const sigPublic = requireAppSignature("public-app");

// Auth-bound app APIs
app.use(["/verify", "/profile", "/prediction-quota", "/wingo30s_prediction", "/payment-history", "/api-keys", "/api-usage", "/system-status", "/games"], sigAuth);
app.use("/api-keys", sigAuth);
app.use("/payment-config", sigPay);
app.use("/create-payment", sigPay);
app.use("/manual-payment", sigPay);
app.use("/order-status", sigPay);


// ─── Routes ─────────────────────────────────────────────────────────────────

app.get("/", (_req, res) => {
  res.json({
    success: true,
    message: "🐉 DRAGO API is running!",
    timestamp: new Date().toISOString(),
  });
});

/**
 * Start Google OAuth — frontend redirects yahan.
 * Client ID/Secret kabhi frontend pe nahi jaate.
 */
app.get("/auth/google", (req, res) => {
  if (!adminSettings.google_auth_enabled) {
    return res.status(403).json({
      success: false,
      message: "Google login is currently disabled by admin",
    });
  }
  const redirectUri = `${publicBase(req)}/auth/google/callback`;
  const state = crypto.randomBytes(24).toString("hex");
  saveState(state);

  // Cookie backup (same-site backend callback)
  res.cookie("drago_oauth_state", state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: STATE_TTL_MS,
    path: "/",
  });

  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "select_account");
  url.searchParams.set("access_type", "online");

  res.redirect(url.toString());
});

/**
 * Google callback → exchange code → upsert user → JWT → frontend #token=
 */
app.get("/auth/google/callback", async (req, res) => {
  const fail = (reason) => {
    console.error("OAuth fail:", reason);
    res.redirect(`${FRONTEND_URL}/?error=google_auth_failed`);
  };

  try {
    const code = req.query.code;
    const state = req.query.state;

    if (!code || typeof code !== "string") {
      return fail("missing code");
    }

    // State: memory first, cookie fallback
    const cookieState = (() => {
      const raw = req.headers.cookie || "";
      for (const part of raw.split(";")) {
        const i = part.indexOf("=");
        if (i === -1) continue;
        if (part.slice(0, i).trim() === "drago_oauth_state") {
          try {
            return decodeURIComponent(part.slice(i + 1).trim());
          } catch {
            return null;
          }
        }
      }
      return null;
    })();

    const stateOk =
      consumeState(state) || (state && cookieState && state === cookieState);

    res.clearCookie("drago_oauth_state", { path: "/" });

    if (!stateOk) {
      return fail("invalid state");
    }

    const redirectUri = `${publicBase(req)}/auth/google/callback`;
    const { tokens } = await oauth2Client.getToken({
      code,
      redirect_uri: redirectUri,
    });

    if (!tokens.id_token) {
      return fail("no id_token");
    }

    const ticket = await oauth2Client.verifyIdToken({
      idToken: tokens.id_token,
      audience: GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    if (!payload || !payload.sub) {
      return fail("invalid payload");
    }

    const user = await upsertUser(payload);
    const token = signToken(user);

    // Hash fragment — server logs / referrer mein nahi jata
    res.redirect(`${FRONTEND_URL}/#token=${encodeURIComponent(token)}`);
  } catch (err) {
    fail(err.message || "unknown");
  }
});

/** Session check — dashboard / guards */
app.get("/verify", async (req, res) => {
  const decoded = authUser(req, res);
  if (!decoded) return;

  const user = await dbFindUserByIdLite(decoded.id);
  if (!user) {
    return res
      .status(401)
      .json({ success: false, message: "User not found" });
  }

  res.json({ success: true, user });
});

/** Full profile */
app.get("/profile", async (req, res) => {
  const decoded = authUser(req, res);
  if (!decoded) return;

  const user = await dbFindUserById(decoded.id);
  if (!user) {
    return res
      .status(404)
      .json({ success: false, message: "User not found" });
  }

  const created = user.created_at ? new Date(user.created_at) : null;
  const joinedDate = created
    ? created.toLocaleDateString("en-IN", {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : "Unknown";
  const daysSinceJoin = created
    ? Math.floor((Date.now() - created.getTime()) / 86400000)
    : 0;

  const isPro = userIsPro(user);
  const freeUsed = await dbGetFreePredUsed(user.id);
  const apiTotal = usageMap(await dbUsageByUserTotal(user.id));
  res.json({
    success: true,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      picture: user.picture,
      provider: "Google",
      joinedDate,
      daysSinceJoin,
      is_pro: isPro,
      pro_plan: isPro ? user.pro_plan || null : null,
      pro_expires_at: isPro ? user.pro_expires_at || null : null,
      plan_label:
        isPro && user.pro_plan && PLAN_CATALOG[user.pro_plan]
          ? PLAN_CATALOG[user.pro_plan].name
          : isPro
            ? "Pro"
            : "Free",
      free_pred_used: isPro ? 0 : freeUsed,
      free_pred_limit: freePredLimit(),
      free_pred_remaining: isPro
        ? null
        : Math.max(0, freePredLimit() - freeUsed),
      api_history_used: Number(apiTotal.history) || 0,
      api_history_limit: isPro ? null : freeApiHistoryLimit(),
    },
  });
});

/**
 * Payment config for custom QR gateway (frontend only hits this API)
 * GET /payment-config?plan=test
 */
app.get("/payment-config", (req, res) => {
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
  });
});

/**
 * Live Wingo 30s prediction (proxy upstream)
 * Auth required. Pro = unlimited. Free = max freePredLimit() lifetime reveals.
 * Query: ?consume=1  → increments free counter (only when user taps Get Prediction)
 */
app.get("/wingo30s_prediction", async (req, res) => {
  const decoded = authUser(req, res);
  if (!decoded) return;

  const user = await dbFindUserById(decoded.id);
  if (!user) {
    return res.status(404).json({ success: false, message: "User not found" });
  }

  const isPro = userIsPro(user);
  const freeUsed = await dbGetFreePredUsed(decoded.id);
  const wantConsume = String(req.query.consume || "") === "1";

  if (!isPro) {
    if (freeUsed >= freePredLimit()) {
      return res.status(402).json({
        success: false,
        message:
          "Free prediction limit reached. Upgrade to Pro Plan for unlimited predictions.",
        billing_required: true,
        plan: "free",
        free_pred_used: freeUsed,
        free_pred_limit: freePredLimit(),
      });
    }
    if (wantConsume) {
      try {
        await dbBumpFreePred(decoded.id);
      } catch (e) {
        console.error("free_pred bump:", e.message);
      }
    }
  }

  if (!WINGO_PREDICTION_URL) {
    return res.status(503).json({
      success: false,
      message: "Prediction source not configured",
    });
  }

  try {
    const response = await fetch(WINGO_PREDICTION_URL, {
      signal: AbortSignal.timeout(10000),
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      return res.status(502).json({
        success: false,
        message: `Upstream error: ${response.status}`,
      });
    }

    const data = await response.json();
    // Internal tracker fields hatao
    const { max_consec_today, max_level_today, ...clean } = data || {};

    const newUsed = isPro
      ? freeUsed
      : wantConsume
        ? freeUsed + 1
        : freeUsed;

    res.json({
      success: true,
      prediction: clean,
      plan: isPro ? "pro" : "free",
      free_pred_used: isPro ? 0 : newUsed,
      free_pred_limit: freePredLimit(),
      free_pred_remaining: isPro
        ? null
        : Math.max(0, freePredLimit() - newUsed),
    });
  } catch (err) {
    console.error("prediction error:", err.message);
    res.status(502).json({
      success: false,
      message: "Failed to fetch prediction from source",
    });
  }
});

/** Free/pro prediction quota status (no upstream call) */
app.get("/prediction-quota", async (req, res) => {
  const decoded = authUser(req, res);
  if (!decoded) return;
  const user = await dbFindUserById(decoded.id);
  if (!user) {
    return res.status(404).json({ success: false, message: "User not found" });
  }
  const isPro = userIsPro(user);
  const freeUsed = await dbGetFreePredUsed(decoded.id);
  res.json({
    success: true,
    plan: isPro ? "pro" : "free",
    is_pro: isPro,
    free_pred_used: isPro ? 0 : freeUsed,
    free_pred_limit: freePredLimit(),
    free_pred_remaining: isPro
      ? null
      : Math.max(0, freePredLimit() - freeUsed),
  });
});

/**
 * Create payment order (Rupayex) — token sirf server pe.
 * Body: { plan: "test" | "beginners" | "profit" }
 * Auth: Bearer JWT required
 * Returns: { success, order_id, amount, payment_url }
 */
app.post("/create-payment", async (req, res) => {
  const decoded = authUser(req, res);
  if (!decoded) return;

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
  const redirectUrl = `${FRONTEND_URL}/subscription.html?order=${encodeURIComponent(orderId)}`;

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
        message: "Payment provider error",
        detail: data || rawText.slice(0, 200),
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
        raw: data || rawText.slice(0, 300),
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
  if (!utr || utr.length < 8 || utr.length > 22) {
    return res.status(400).json({
      success: false,
      message: "Valid UTR required (8–22 chars)",
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
      user: { name: user.name, email: user.email },
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
 * Telegram webhook — Approve / Deny (also backed by long-polling)
 */
app.post("/telegram-webhook", async (req, res) => {
  res.json({ ok: true });
  try {
    const cb = req.body && req.body.callback_query;
    if (cb) await handleTelegramCallback(cb);
  } catch (err) {
    console.error("telegram-webhook:", err.message);
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
      return res.json({
        success: true,
        order_id: existing.order_id,
        plan: planKey,
        amount: plan.amount,
        qr_url: plan.qr_url || null,
        name: plan.name,
        ttl_minutes: 10,
        payment_status: "PENDING",
        reused: true,
      });
    }

    const orderId = `MANUAL${Date.now()}${crypto.randomBytes(3).toString("hex")}`;
    const meta = JSON.stringify({ source: "manual_qr", stage: "awaiting_utr" });

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
      qr_url: plan.qr_url || null,
      name: plan.name,
      ttl_minutes: 10,
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

app.get("/system-status", async (req, res) => {
  const decoded = authUser(req, res);
  if (!decoded) return;

  expireStaleOrders();

  const checks = [];
  const nowIso = new Date().toISOString();

  const push = (id, label, ok, detail, pct, extra) => {
    const history = pushHistory(id, ok);
    const upSamples = history.filter(Boolean).length;
    const uptimePct =
      history.length > 0
        ? Math.round((upSamples / history.length) * 100)
        : ok
          ? 100
          : 0;
    checks.push({
      id,
      label,
      ok: Boolean(ok),
      detail: detail || "",
      percent: typeof pct === "number" ? pct : uptimePct,
      latency_ms: extra && extra.latency_ms != null ? extra.latency_ms : null,
      url: (extra && extra.url) || "",
      last_checked: "just now",
      history,
      checked_at: nowIso,
    });
  };

  // API self — never expose real tunnel / host URL to clients
  push("api", "API Server", true, "Online", 100, {
    latency_ms: 1,
    url: "",
  });

  // DB — hide path
  try {
    const t0 = Date.now();
    await dbPing();
    push("db", "Database", true, "Connected (MongoDB)", 100, {
      latency_ms: Date.now() - t0,
      url: "",
    });
  } catch (e) {
    push("db", "Database", false, "Error", 0, { url: "" });
  }

  // Payment Gateway — hide URL
  if (!RUPAYEX_API_TOKEN) {
    push("gateway", "Payment Gateway", false, "Not configured", 0, {
      url: "",
    });
  } else {
    try {
      const { response: r, latency_ms } = await timedFetch(
        `${RUPAYEX_API_BASE}/`,
        { method: "GET", signal: AbortSignal.timeout(8000) }
      );
      push(
        "gateway",
        "Payment Gateway",
        r.status < 500,
        r.status < 500 ? "Online" : `HTTP ${r.status}`,
        r.status < 500 ? 100 : 30,
        { latency_ms, url: "" }
      );
    } catch (e) {
      push("gateway", "Payment Gateway", false, "Unreachable", 0, {
        url: "",
      });
    }
  }

  // Help Support (was Telegram Bot) — hide username / URL
  if (!TELEGRAM_BOT_TOKEN) {
    push("telegram", "Help Support", false, "Not configured", 0, {
      url: "",
    });
  } else {
    try {
      const t0 = Date.now();
      const me = await telegramApi("getMe", {});
      push(
        "telegram",
        "Help Support",
        me && me.ok,
        me && me.ok ? "Online" : "Auth failed",
        me && me.ok ? 100 : 0,
        {
          latency_ms: Date.now() - t0,
          url: "",
        }
      );
    } catch (e) {
      push("telegram", "Help Support", false, "Error", 0, {
        url: "",
      });
    }
  }

  // WinGo history poller (keep — useful, no secret URL)
  push(
    "wingo_history",
    "WinGo 30s History",
    wingoHistoryMeta.last_ok || wingoHistoryMeta.count > 0,
    wingoHistoryMeta.last_ok
      ? `${wingoHistoryMeta.count} rows` +
          (wingoHistoryMeta.last_added
            ? ` (+${wingoHistoryMeta.last_added})`
            : "")
      : wingoHistoryMeta.last_error || "Waiting first poll",
    wingoHistoryMeta.last_ok ? 100 : wingoHistoryMeta.count > 0 ? 50 : 0,
    { url: "" }
  );

  const uptimeSec = Math.floor((Date.now() - SERVER_STARTED_AT) / 1000);
  const avg =
    checks.length > 0
      ? Math.round(
          checks.reduce((s, c) => s + (c.percent || 0), 0) / checks.length
        )
      : 0;

  res.json({
    success: true,
    uptime_sec: uptimeSec,
    health_percent: avg,
    checks,
    timestamp: nowIso,
  });
});

/**
 * Public games list for game.html
 * GET /games
 * GET /games/:id
 */
app.get("/games", async (_req, res) => {
  try {
    const rows = await dbListGames();
    res.json({ success: true, games: rows });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.get("/games/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) {
    return res.status(400).json({ success: false, message: "Invalid id" });
  }
  const row = await dbFindGame(id);
  if (!row) {
    return res.status(404).json({ success: false, message: "Game not found" });
  }
  res.json({ success: true, game: row });
});

/**
 * Developer API keys
 * POST /api-keys  { name? }  — create (max 5 per user)
 * GET  /api-keys             — list own keys
 * DELETE /api-keys/:id       — revoke
 */
const API_KEY_LIMIT = 5;

app.post("/api-keys", async (req, res) => {
  const decoded = authUser(req, res);
  if (!decoded) return;

  const countRow = await dbCountUserApiKeys(decoded.id);
  if (countRow && Number(countRow.c) >= API_KEY_LIMIT) {
    return res.status(400).json({
      success: false,
      message: `Max ${API_KEY_LIMIT} API keys allowed. Delete one first.`,
    });
  }

  const name = String((req.body && req.body.name) || "default")
    .trim()
    .slice(0, 40) || "default";
  const apiKey =
    "drago_" + crypto.randomBytes(24).toString("hex");

  try {
    const info = await dbInsertApiKey(decoded.id, apiKey, name);
    res.json({
      success: true,
      id: Number(info.lastInsertRowid),
      api_key: apiKey,
      name,
      endpoints: {
        history: "/v1/wingo30s/history",
        prediction: "/v1/wingo30s/prediction",
      },
      rate_limit: { per_minute: API_RATE_LIMIT },
      usage: {
        header: "X-API-Key: " + apiKey,
        query: "?api_key=" + apiKey,
      },
    });
  } catch (e) {
    console.error("api-keys create:", e.message);
    res.status(500).json({ success: false, message: "Could not create key" });
  }
});

app.get("/api-keys", async (req, res) => {
  const decoded = authUser(req, res);
  if (!decoded) return;

  const day = todayKey();
  const rows = await dbListApiKeys(decoded.id);
  const keys = [];
  for (const r of rows) {
    const total = usageMap(await dbUsageByKey(r.id));
    const today = usageMap(await dbUsageByKeyToday(r.id, day));
    keys.push({
      id: r.id,
      api_key: r.api_key,
      name: r.name || "default",
      created_at: r.created_at,
      last_used_at: r.last_used_at || null,
      usage: { total, today },
    });
  }
  res.json({
    success: true,
    keys,
    endpoints: {
      history: "/v1/wingo30s/history",
      prediction: "/v1/wingo30s/prediction",
    },
    rate_limit: { per_minute: API_RATE_LIMIT },
    max: API_KEY_LIMIT,
  });
});

app.delete("/api-keys/:id", async (req, res) => {
  const decoded = authUser(req, res);
  if (!decoded) return;

  const id = Number(req.params.id);
  if (!id) {
    return res.status(400).json({ success: false, message: "Invalid id" });
  }
  const result = await dbDeleteApiKey(id, decoded.id);
  if (!result.changes) {
    return res.status(404).json({ success: false, message: "Key not found" });
  }
  res.json({ success: true, message: "API key deleted" });
});

/** Usage monitor for logged-in user */
app.get("/api-usage", async (req, res) => {
  const decoded = authUser(req, res);
  if (!decoded) return;

  const day = todayKey();
  const today = usageMap(await dbUsageByUserToday(decoded.id, day));
  const total = usageMap(await dbUsageByUserTotal(decoded.id));
  const keyRows = await dbListApiKeys(decoded.id);
  const keys = [];
  for (const r of keyRows) {
    keys.push({
      id: r.id,
      name: r.name || "default",
      last_used_at: r.last_used_at || null,
      usage: {
        total: usageMap(await dbUsageByKey(r.id)),
        today: usageMap(await dbUsageByKeyToday(r.id, day)),
      },
    });
  }

  const user = await dbFindUserById(decoded.id);
  const isPro = userIsPro(user);
  const historyUsed = Number(total.history) || 0;
  const billingRequired =
    !isPro && historyUsed >= freeApiHistoryLimit();

  res.json({
    success: true,
    plan: isPro ? "pro" : "free",
    is_pro: isPro,
    rate_limit: isPro
      ? { per_minute: API_RATE_LIMIT, window_sec: 60 }
      : {
          lifetime_history: freeApiHistoryLimit(),
          history_used: historyUsed,
          history_remaining: Math.max(0, freeApiHistoryLimit() - historyUsed),
        },
    billing_required: billingRequired,
    billing_message: billingRequired
      ? "Free plan limit reached. Please complete billing / upgrade to Pro."
      : null,
    today,
    total,
    keys,
  });
});

/**
 * Public history API (API key required)
 * GET /v1/wingo30s/history
 * Auth: header X-API-Key  OR  ?api_key=
 * Query: limit=1..1000  (newest first; default = all stored, max 1000)
 * Rate: 20 / minute / user
 *
 * Examples:
 *   /v1/wingo30s/history?api_key=...&limit=1   → latest 1 draw
 *   /v1/wingo30s/history?api_key=...&limit=50  → latest 50 draws
 */
app.get("/v1/wingo30s/history", async (req, res) => {
  const auth = await requireApiKey(req, res, "history");
  if (!auth) return;

  const items = loadWingoHistory();
  // Newest first already in storage; limit controls how many to return
  let limit = Number.parseInt(String(req.query.limit ?? ""), 10);
  if (!Number.isFinite(limit) || limit < 1) {
    // no limit / invalid → return all stored (capped)
    limit = Math.min(WINGO_HISTORY_MAX, items.length || WINGO_HISTORY_MAX);
  } else {
    limit = Math.min(WINGO_HISTORY_MAX, Math.max(1, limit));
  }
  const slice = items.slice(0, limit);

  res.json({
    success: true,
    count: slice.length,
    limit,
    Server: SERVER_BRAND,
    updated_at: wingoHistoryMeta.last_poll_at || new Date().toISOString(),
    items: slice,
  });
});

/**
 * Public prediction API (API key required)
 * GET /v1/wingo30s/prediction
 * Auth: header X-API-Key  OR  ?api_key=
 * Rate: 20 / minute / user
 */
app.get("/v1/wingo30s/prediction", async (req, res) => {
  const auth = await requireApiKey(req, res, "prediction");
  if (!auth) return;

  try {
    const prediction = await fetchWingoPrediction();
    const pred =
      prediction && typeof prediction === "object" ? prediction : {};
    const period =
      pred.period != null
        ? pred.period
        : pred.issueNumber != null
          ? pred.issueNumber
          : pred.issue || "";
    const signal =
      pred.prediction != null
        ? pred.prediction
        : pred.signal != null
          ? pred.signal
          : pred.result != null
            ? pred.result
            : pred.value != null
              ? pred.value
              : "";
    let conf =
      pred.confidence ?? pred.conf ?? pred.score ?? pred.probability ?? null;
    if (conf != null && Number(conf) <= 1) conf = Math.round(Number(conf) * 100);
    let level =
      pred.level ?? pred.lvl ?? pred.signal_level ?? pred.strength ?? null;
    if (level != null && Number(level) <= 1) level = Math.round(Number(level) * 100);

    res.json({
      success: true,
      Server: SERVER_BRAND,
      Timestamp: new Date().toISOString(),
      Period: period === "" ? null : period,
      PREDICTION: signal === "" ? null : signal,
      CONFIDENCE: conf,
      "CURRENT LEVEL": level,
    });
  } catch (err) {
    console.error("v1 prediction:", err.message);
    const status = err.status || 502;
    res.status(status).json({
      success: false,
      Server: SERVER_BRAND,
      message:
        status === 503
          ? "Prediction source not configured"
          : "Failed to fetch prediction from source",
    });
  }
});

/**
 * Check order status (Rupayex + local DB)
 * Query: ?order_id=xxx
 * Auth: Bearer JWT required (own orders only)
 */
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

  if (!RUPAYEX_API_TOKEN) {
    return res.json({
      success: true,
      order_id: orderId,
      amount: local.amount,
      plan: local.plan,
      payment_status: local.payment_status,
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

    if (normalized !== local.payment_status || utr !== local.utr) {
      updateOrderStatus(
        orderId,
        normalized,
        utr,
        method,
        rawText.slice(0, 1500)
      );
      if (normalized === "SUCCESS") {
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
      payment_status: normalized,
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

// 404
app.use((_req, res) => {
  res.status(404).json({ success: false, message: "Not found" });
});

// Error handler
app.use((err, _req, res, _next) => {
  console.error("unhandled:", err.message);
  res.status(500).json({ success: false, message: "Internal server error" });
});

// ─── Start ──────────────────────────────────────────────────────────────────
async function boot() {
  try {
    await connectMongo();
  } catch (e) {
    console.error("❌ MongoDB connect failed:", e.message);
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log(`🚀 DRAGO on :${PORT}`);
    console.log(`   Frontend: ${FRONTEND_URL}`);
    console.log(`   Allowed domain: ${ALLOWED_WEB_DOMAIN}`);
    console.log(`   App ID: ${APP_ID}`);
    console.log(`   Prediction VPS: ${WINGO_PREDICTION_URL}`);
    console.log(`   Public base: ${PUBLIC_BASE_URL || "(auto from request)"}`);
    console.log(`   OAuth callback: /auth/google/callback`);
    console.log(`   Database: MongoDB Atlas`);

    // WinGo 30s history file poller (:00 / :30)
    try {
      startWingoHistoryScheduler();
    } catch (e) {
      console.error("history scheduler:", e.message);
    }

    // Load payments.json + mark stale PENDING → EXPIRED (rows never deleted)
    try {
      loadPaymentsFromDisk();
      expireStaleOrders();
      console.log(`   Payments file: ${getPayments().length} record(s)`);
    } catch (e) {
      console.error("startup payments:", e.message);
    }

    // Periodic: expire PENDING only (payments.json never auto-deleted)
    setInterval(() => {
      try {
        expireStaleOrders();
      } catch (e) {
        console.error("maintenance:", e.message);
      }
    }, 5 * 60 * 1000);

    // Prefer long-polling for Approve/Deny reliability on changing tunnels
    if (TELEGRAM_BOT_TOKEN) {
      telegramApi("deleteWebhook", { drop_pending_updates: false }).then(() => {
        console.log(
          "   Telegram: long-polling enabled (Approve/Deny + /addgame)"
        );
        const loop = async () => {
          await pollTelegramUpdates();
          setTimeout(loop, 400);
        };
        loop();
      });
    }
  });
}

boot().catch((e) => {
  console.error("boot failed:", e);
  process.exit(1);
});
