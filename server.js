/**
 * DRAGO Main API — Render
 * Frontend (Vercel) → this server → Orihost VPS (prediction + history)
 *
 * Env: MONGODB_URI, JWT_SECRET, GOOGLE_*, APP_ID, APP_SECRET,
 *      WINGO_PREDICTION_URL, WINGO_HISTORY_URL, VPS_SECRET,
 *      TELEGRAM_*, FRONTEND_URL, ALLOWED_WEB_DOMAIN
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
let webPush = null;
try {
  webPush = require("web-push");
} catch (_) {
  webPush = null;
}

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
const APP_ID_PREV = process.env.APP_ID_PREV || "";
const APP_SECRET_PREV = process.env.APP_SECRET_PREV || "";
const FRONTEND_URL = (
  process.env.FRONTEND_URL || "https://dragopredictor.vercel.app"
).replace(/\/$/, "");
const ALLOWED_WEB_DOMAIN = (
  process.env.ALLOWED_WEB_DOMAIN || "dragopredictor.vercel.app"
).replace(/^https?:\/\//, "").replace(/\/$/, "");
// Third-party prediction VPS (HTTP ok — server-to-server only, never exposed to browser)
const WINGO_PREDICTION_URL = (
  process.env.WINGO_PREDICTION_URL ||
  "http://2.56.246.119:30119/api/prediction/wingo/30s/size"
).replace(/\/$/, "");
// History/data also on orihost VPS — Render pe kuch save nahi
const WINGO_HISTORY_URL = (
  process.env.WINGO_HISTORY_URL ||
  "http://2.56.246.119:30119/api/history"
).replace(/\/$/, "");
const VPS_SECRET = (process.env.VPS_SECRET || process.env.DRAGO_VPS_SECRET || "").trim();
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
// Shorter bearer-token lifetime limits the impact window if a browser token is stolen.
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "24h";
const SIGNATURE_MAX_SKEW_MS = Number(process.env.SIGNATURE_MAX_SKEW_MS) || 120000; // 2 min

// Rupayex (server-side only)
const RUPAYEX_API_BASE = (
  process.env.RUPAYEX_API_BASE || "https://rupayex.net/api"
).replace(/\/$/, "");
const RUPAYEX_API_TOKEN = process.env.RUPAYEX_API_TOKEN || "";

/** Plan → amount (INR). Client amount trust mat karo.
 * Supports both QR_URL_749 / QR_URL_300 (for ₹749 Weekly) and QR_URL_1498 / QR_URL_900 (for ₹1498 Monthly).
 */
function resolveValidQrUrl(rawUrl, fallbackUrl) {
  const u = String(rawUrl || "").trim();
  if (!u) return fallbackUrl;
  // Reject non-direct ImgBB page URLs (https://ibb.co/...) or expired ImgBB assets
  if (
    /^https?:\/\/(www\.)?ibb\.co\//i.test(u) ||
    /dc0e2bd33bc2|47c3bf9c834f|spLnbMnw|Ngw5tH5j|ZzZvmHB2|5h7CFYrK|upipe-qr/i.test(u)
  ) {
    return fallbackUrl;
  }
  return u;
}

const PLAN_CATALOG = {
  weekly: {
    get name() {
      return (adminSettings && adminSettings.weekly_name) || "PRO VIP WEEKLY";
    },
    get amount() {
      const v = Number(adminSettings && adminSettings.weekly_amount);
      return Number.isFinite(v) && v >= 1 ? v : 749;
    },
    get days() {
      const v = Number(adminSettings && adminSettings.weekly_days);
      return Number.isFinite(v) && v >= 1 ? v : 7;
    },
    get qr_url() {
      const raw =
        (adminSettings && adminSettings.weekly_qr_url) ||
        process.env.QR_URL_749 ||
        process.env.QR_URL_300 ||
        process.env.QR_URL_500 ||
        "";
      return resolveValidQrUrl(
        raw,
        "https://dragopredictor.vercel.app/assets/upi/qr-weekly.png"
      );
    },
  },
  monthly: {
    get name() {
      return (adminSettings && adminSettings.monthly_name) || "PRO VIP MONTHLY";
    },
    get amount() {
      const v = Number(adminSettings && adminSettings.monthly_amount);
      return Number.isFinite(v) && v >= 1 ? v : 1498;
    },
    get days() {
      const v = Number(adminSettings && adminSettings.monthly_days);
      return Number.isFinite(v) && v >= 1 ? v : 30;
    },
    get qr_url() {
      const raw =
        (adminSettings && adminSettings.monthly_qr_url) ||
        process.env.QR_URL_1498 ||
        process.env.QR_URL_900 ||
        "";
      return resolveValidQrUrl(
        raw,
        "https://dragopredictor.vercel.app/assets/upi/qr-monthly.png"
      );
    },
  },
  test: {
    get name() {
      return PLAN_CATALOG.weekly.name;
    },
    get amount() {
      return PLAN_CATALOG.weekly.amount;
    },
    get days() {
      return PLAN_CATALOG.weekly.days;
    },
    get qr_url() {
      return PLAN_CATALOG.weekly.qr_url;
    },
  },
  beginners: {
    get name() {
      return PLAN_CATALOG.weekly.name;
    },
    get amount() {
      return PLAN_CATALOG.weekly.amount;
    },
    get days() {
      return PLAN_CATALOG.weekly.days;
    },
    get qr_url() {
      return PLAN_CATALOG.weekly.qr_url;
    },
  },
  profit: {
    get name() {
      return PLAN_CATALOG.monthly.name;
    },
    get amount() {
      return PLAN_CATALOG.monthly.amount;
    },
    get days() {
      return PLAN_CATALOG.monthly.days;
    },
    get qr_url() {
      return PLAN_CATALOG.monthly.qr_url;
    },
  },
};

// Separate, server-only credentials. No token literals or code fallbacks.
const TELEGRAM_BOT_TOKEN = String(
  process.env.TELEGRAM_ADMIN_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || ""
).trim();
const TELEGRAM_GROUP_BOT_TOKEN = String(
  process.env.TELEGRAM_GROUP_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || TELEGRAM_BOT_TOKEN
).trim();
const TELEGRAM_REPORT_GROUP_ID = String(
  process.env.TELEGRAM_REPORT_GROUP_ID || "-1004386088906"
);
const TELEGRAM_ADMIN_CHAT_ID = String(
  process.env.TELEGRAM_ADMIN_CHAT_ID || "6656009938"
).trim();
/** Pending payment window (gateway + manual) */
const UPI_ID = process.env.UPI_ID || "dragoxkrish@nyes";
const PAYMENT_TTL_MS = 10 * 60 * 1000; // payment popup/resume 10 min; orders history hamesha rahti hai

if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !JWT_SECRET) {
  console.error("❌ GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET aur JWT_SECRET set karo (Render env)");
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
  banned_devices: null,
  payments: null,
  kv_store: null,
  uploads: null,
};

function escTgMd(val, maxLen = 200) {
  return String(val == null ? "" : val)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/([_*`\[\]\\])/g, "")
    .trim()
    .slice(0, maxLen);
}

function hasValidImageMagicBytes(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return false;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return true;
  }
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return true;
  }
  // WEBP: RIFF....WEBP
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return true;
  }
  return false;
}

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
    free_active: isFreeActive(doc) ? 1 : 0,
    tg_id: doc.tg_id ? Number(doc.tg_id) : null,
    pro_plan: doc.pro_plan || null,
    pro_expires_at: doc.pro_expires_at || null,
    free_pred_used: Number(doc.free_pred_used) || 0,
    free_api_used: Number(doc.free_api_used) || 0,
    free_nexus_used: Number(doc.free_nexus_used) || 0,
    banned: doc.banned ? 1 : 0,
    banned_at: doc.banned_at || null,
    ban_reason: doc.ban_reason || null,
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

function hashApiKey(raw) {
  return crypto.createHash("sha256").update(String(raw || "")).digest("hex");
}
function maskApiKeyPrefix(prefix) {
  const p = String(prefix || "drago_");
  return p + "…" + "****";
}
/** Full API key at-rest encryption (AES-256-GCM, APP_SECRET derived) — user can copy key anytime. */
function encKey(raw) {
  try {
    const iv = crypto.randomBytes(12);
    const k = Buffer.from(String(APP_SECRET).slice(0, 32).padEnd(32, "0"));
    const c = crypto.createCipheriv("aes-256-gcm", k, iv);
    let e = c.update(String(raw), "utf8");
    e = Buffer.concat([e, c.final()]);
    return (
      iv.toString("base64") +
      "." +
      c.getAuthTag().toString("base64") +
      "." +
      e.toString("base64")
    );
  } catch (_) {
    return null;
  }
}
function decKey(s) {
  try {
    const [i, t, e] = String(s || "").split(".");
    const k = Buffer.from(String(APP_SECRET).slice(0, 32).padEnd(32, "0"));
    const d = crypto.createDecipheriv("aes-256-gcm", k, Buffer.from(i, "base64"));
    d.setAuthTag(Buffer.from(t, "base64"));
    let p = d.update(e, "base64");
    p = Buffer.concat([p, d.final()]);
    return p.toString("utf8");
  } catch (_) {
    if (!APP_SECRET_PREV) return null;
    try {
      const [i2, t2, e2] = String(s || "").split(".");
      const k2 = Buffer.from(String(APP_SECRET_PREV).slice(0, 32).padEnd(32, "0"));
      const d2 = crypto.createDecipheriv("aes-256-gcm", k2, Buffer.from(i2, "base64"));
      d2.setAuthTag(Buffer.from(t2, "base64"));
      let p2 = d2.update(e2, "base64");
      p2 = Buffer.concat([p2, d2.final()]);
      return p2.toString("utf8");
    } catch (_) { return null; }
  }
}
function mapApiKey(doc) {
  if (!doc) return null;
  const prefix =
    doc.key_prefix ||
    (doc.api_key ? String(doc.api_key).slice(0, 12) : "drago_");
  return {
    id: doc.id,
    user_id: doc.user_id,
    key_prefix: prefix,
    api_key_masked: maskApiKeyPrefix(prefix),
    key_enc: doc.key_enc || null,
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
  col.banned_devices = db.collection("banned_devices");
  col.payments = db.collection("payments");
  col.kv_store = db.collection("kv_store");
  col.uploads = db.collection("uploads");

  // Minimal indexes only (no bloat)
  // safeIndex: agar purana index same name se alag options ke saath exist kare
  // (IndexOptionsConflict) to use drop karke naya banata hai — deploy crash nahi.
  async function safeIndex(c, spec, opts) {
    const name =
      (opts && opts.name) ||
      Object.keys(spec)
        .map((k) => k + "_1")
        .join("_");
    try {
      await c.createIndex(spec, opts);
    } catch (e) {
      try {
        await c.dropIndex(name);
        await c.createIndex(spec, opts);
      } catch (e2) {
        console.warn("index skip:", name, e2.message);
      }
    }
  }
  await Promise.all([
    safeIndex(col.users, { google_id: 1 }, { unique: true }),
    safeIndex(col.users, { id: 1 }, { unique: true }),
    safeIndex(col.users, { tg_id: 1 }),
    safeIndex(col.games, { id: 1 }, { unique: true }),
    safeIndex(col.games, { sort_order: 1 }),
    safeIndex(col.api_keys, { key_hash: 1 }, { unique: true, sparse: true }),
    safeIndex(col.api_keys, { api_key: 1 }, { unique: true, sparse: true }),
    safeIndex(col.api_keys, { user_id: 1 }),
    safeIndex(col.api_keys, { id: 1 }, { unique: true }),
    safeIndex(
      col.api_usage,
      { api_key_id: 1, endpoint: 1, day: 1 },
      { unique: true }
    ),
    safeIndex(col.api_usage, { user_id: 1, day: 1 }),
    // TTL on expire_at Date → auto-purge usage older than ~90 days
    safeIndex(col.api_usage, { expire_at: 1 }, { expireAfterSeconds: 0 }),
    // Persistent MongoDB payment orders with unique order_id index (BE-7)
    safeIndex(col.payments, { order_id: 1 }, { unique: true }),
    safeIndex(col.payments, { user_id: 1, created_at: -1 }),
    safeIndex(col.uploads, { id: 1 }, { unique: true }),
  ]);
  // Deduplicate any historical duplicate tg_id assignments so strictly 1 Telegram account = 1 DRAGO ID
  try {
    const withTg = await col.users
      .find({ tg_id: { $ne: null } })
      .sort({ id: 1 })
      .toArray();
    const seenTg = new Set();
    const dupUserIds = [];
    for (const u of withTg) {
      const t = Number(u.tg_id);
      if (!t) continue;
      if (seenTg.has(t)) {
        dupUserIds.push(u.id);
      } else {
        seenTg.add(t);
      }
    }
    if (dupUserIds.length > 0) {
      await col.users.updateMany(
        { id: { $in: dupUserIds } },
        { $set: { free_active: 0, free_expires_at: null, tg_id: null } }
      );
      console.log("🔒 Cleaned up duplicate Telegram verifications for user IDs:", dupUserIds);
    }
  } catch (e) {
    console.warn("tg_id dedupe skip:", e.message);
  }
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
    free_active: isFreeActive(u) ? 1 : 0,
    pro_plan: u.pro_plan,
    pro_expires_at: u.pro_expires_at,
  };
}
async function genRefCode() {
  for (let i = 0; i < 5; i++) {
    const c = crypto.randomBytes(4).toString("hex");
    const ex = await col.users.findOne({ ref_code: c });
    if (!ex) return c;
  }
  return crypto.randomBytes(6).toString("hex");
}
async function dbInsertUser(googleId, email, name, picture, referredBy) {
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
    free_api_used: 0,
    free_nexus_used: 0,
    ref_code: await genRefCode(),
    referred_by: referredBy || null,
    ref_count: 0,
    ref_rewarded: false,
    created_at: new Date().toISOString(),
  };
  await col.users.insertOne(doc);
  return mapUser(doc);
}
/** Referrer joined count badhao (freeplan reward tabhi milega jab 2 referred users VIP plan buy karenge) */
async function bumpReferrer(code) {
  try {
    if (!code || !col.users) return;
    const referrer = await col.users.findOne({ ref_code: String(code).trim() });
    if (!referrer) return;
    await col.users.updateOne(
      { ref_code: String(code).trim() },
      { $inc: { ref_count: 1 } }
    );
  } catch (e) {
    console.warn("bumpReferrer:", e.message);
  }
}

/**
 * Jab kisi referred user ka VIP plan activate ho (paid weekly/monthly),
 * referrer ke paid referrals check karo:
 * - Har 2 Weekly Paid Referrals par referrer ko 1 Weekly VIP Plan (7 Days) FREE milega!
 * - Har 2 Monthly Paid Referrals par referrer ko 1 Monthly VIP Plan (30 Days) FREE milega!
 */
async function creditReferrerOnPaidPlan(refCode, purchasedPlanKey, buyerUser) {
  try {
    if (!refCode || !col.users) return;
    const cleanCode = String(refCode).trim();
    const referrer = await col.users.findOne({ ref_code: cleanCode });
    if (!referrer) return;
    if (buyerUser && Number(referrer.id) === Number(buyerUser.id)) return;

    const pKey = String(purchasedPlanKey || "weekly").toLowerCase();
    const isMonthly = pKey === "monthly" || pKey === "profit";

    const incFields = {
      ref_paid_count: 1,
      ...(isMonthly ? { ref_paid_monthly: 1 } : { ref_paid_weekly: 1 }),
    };
    await col.users.updateOne({ id: referrer.id }, { $inc: incFields });

    const freshRef = await col.users.findOne({ id: referrer.id });
    if (!freshRef) return;

    const totalPaid = Number(freshRef.ref_paid_count) || 0;
    const paidMonthly = Number(freshRef.ref_paid_monthly) || 0;
    const rewardedPairs = Number(freshRef.ref_rewarded_pairs) || 0;
    const rewardedMonthlyUsed = Number(freshRef.ref_rewarded_monthly_used) || 0;

    const unrewardedTotal = totalPaid - rewardedPairs * 2;
    const unrewardedMonthly = paidMonthly - rewardedMonthlyUsed;

    if (unrewardedTotal >= 2) {
      const giveMonthly = unrewardedMonthly >= 2;
      const rewardPlanKey = giveMonthly ? "monthly" : "weekly";
      const rewardDays = giveMonthly
        ? (PLAN_CATALOG.monthly && PLAN_CATALOG.monthly.days) || 30
        : (PLAN_CATALOG.weekly && PLAN_CATALOG.weekly.days) || 7;
      const rewardLabel = giveMonthly ? "Monthly VIP Plan (30 Days)" : "Weekly VIP Plan (7 Days)";

      const upd = await col.users.updateOne(
        { id: freshRef.id, ref_rewarded_pairs: rewardedPairs },
        {
          $inc: {
            ref_rewarded_pairs: 1,
            ref_rewards_earned: 1,
            ...(giveMonthly ? { ref_rewarded_monthly_used: 2 } : {}),
          },
          $set: { ref_rewarded: true },
        }
      );

      if (upd && (upd.modifiedCount || upd.matchedCount)) {
        const nowMs = Date.now();
        const curExpMs =
          freshRef.is_pro && freshRef.pro_expires_at
            ? new Date(freshRef.pro_expires_at).getTime()
            : 0;
        const baseMs = curExpMs > nowMs ? curExpMs : nowMs;
        const newExpires = new Date(baseMs + rewardDays * 86400000).toISOString();

        await dbSetUserPro(freshRef.id, 1, rewardPlanKey, newExpires, {
          isReferralReward: true,
        });

        pushNotification({
          target: "user",
          user_id: freshRef.id,
          user_name: freshRef.name || "VIP Member",
          type: "plan_active",
          title: `🎁 Free ${rewardLabel} Unlocked!`,
          message: `Congratulations ${freshRef.name || "Partner"}! 2 of your referred friends purchased a VIP Plan. Your FREE ${rewardLabel} is now ACTIVE till ${formatIstDateShort(newExpires)}!`,
          image_url: null,
          action_url: "/prediction/",
          action_label: "OPEN PREDICTION →",
        });

        groupNotify(
          "🎁 *REFERRAL VIP REWARD UNLOCKED*\n\n" +
            "👤 Referrer: " + (freshRef.name || "User") + " (#" + freshRef.id + ")\n" +
            "👥 Paid Referrals: " + totalPaid + " (" + (giveMonthly ? "2 Monthly Paid" : "2 Weekly Paid") + ")\n" +
            "🏆 Free Reward: " + rewardLabel + " Activated FREE\n" +
            "🕒 Time: " + istTimeStr(),
          true
        );
      }
    }
  } catch (e) {
    console.warn("creditReferrerOnPaidPlan:", e.message);
  }
}
async function dbUpdateUserProfile(googleId, name, picture) {
  await col.users.updateOne(
    { google_id: googleId },
    { $set: { name: name || "", picture: picture || "" } }
  );
}
async function dbSetUserPro(userId, isPro, planKey, expires, opts = {}) {
  const uid = Number(userId);
  let prevUser = null;
  try {
    if (col.users) prevUser = await col.users.findOne({ id: uid });
  } catch (_) {}

  const extraSet = {};
  const isFirstPaidPurchase =
    Boolean(isPro) &&
    !opts.isReferralReward &&
    prevUser &&
    prevUser.referred_by &&
    !prevUser.ref_plan_purchased;

  if (isFirstPaidPurchase) {
    extraSet.ref_plan_purchased = true;
    extraSet.ref_plan_type = String(planKey || "weekly").toLowerCase();
    extraSet.ref_plan_purchased_at = new Date().toISOString();
  }

  await col.users.updateOne(
    { id: uid },
    {
      $set: {
        is_pro: isPro ? 1 : 0,
        pro_plan: planKey || null,
        pro_expires_at: expires || null,
        ...(isPro ? { pro_expired_notified_for: null } : {}),
        ...extraSet,
      },
    }
  );

  if (isFirstPaidPurchase && prevUser && prevUser.referred_by) {
    await creditReferrerOnPaidPlan(prevUser.referred_by, planKey, prevUser);
  }

  try {
    const userName = (prevUser && (prevUser.name || prevUser.email)) || "VIP Member";
    if (isPro) {
      const pKey = String(planKey || "weekly").toLowerCase();
      const planLabel =
        pKey === "monthly" || pKey === "profit"
          ? "PRO VIP MONTHLY"
          : "PRO VIP WEEKLY";
      const daysCount = expires
        ? Math.max(1, Math.round((new Date(expires).getTime() - Date.now()) / 86400000))
        : (PLAN_CATALOG[pKey] && PLAN_CATALOG[pKey].days) || 7;
      const expStr = expires ? formatIstDateShort(expires) : `${daysCount} Days`;

      const title = formatNotifTemplate(
        (adminSettings && adminSettings.notif_plan_active_title) ||
          DEFAULT_ADMIN_SETTINGS.notif_plan_active_title,
        { name: userName, plan: planLabel, days: daysCount, expiry: expStr }
      );
      const message = formatNotifTemplate(
        (adminSettings && adminSettings.notif_plan_active_body) ||
          DEFAULT_ADMIN_SETTINGS.notif_plan_active_body,
        { name: userName, plan: planLabel, days: daysCount, expiry: expStr }
      );
      pushNotification({
        target: "user",
        user_id: uid,
        user_name: userName,
        type: "plan_active",
        title,
        message,
        image_url: (adminSettings && adminSettings.notif_plan_active_image) || null,
        action_url: "/prediction/",
        action_label: "OPEN PREDICTION →",
      });
    } else if (prevUser && prevUser.is_pro) {
      const expStr = formatIstDateShort(new Date().toISOString());
      const title = formatNotifTemplate(
        (adminSettings && adminSettings.notif_plan_expired_title) ||
          DEFAULT_ADMIN_SETTINGS.notif_plan_expired_title,
        { name: userName, expiry: expStr }
      );
      const message = formatNotifTemplate(
        (adminSettings && adminSettings.notif_plan_expired_body) ||
          DEFAULT_ADMIN_SETTINGS.notif_plan_expired_body,
        { name: userName, expiry: expStr }
      );
      pushNotification({
        target: "user",
        user_id: uid,
        user_name: userName,
        type: "plan_expired",
        title,
        message,
        image_url: (adminSettings && adminSettings.notif_plan_expired_image) || null,
        action_url: "/payment/?plan=weekly",
        action_label: "RENEW VIP PLAN →",
      });
    }
  } catch (e) {
    console.warn("dbSetUserPro notif:", e.message);
  }
}
function isFreeActive(u) {
  return !!(u && u.free_active) && (!u.free_expires_at || Number(u.free_expires_at) > Date.now());
}
async function dbSetUserFree(userId, tgId, active, expires) {
  await col.users.updateOne(
    { id: Number(userId) },
    { $set: { free_active: active ? 1 : 0, free_expires_at: expires || null, tg_id: tgId != null ? Number(tgId) : null } }
  );
}
/**
 * Strictly enforce 1 Telegram account = 1 DRAGO ID.
 * If tgId is already claimed by another userId, reject and return owner_id.
 */
async function claimTelegramForUser(userId, tgId, expires) {
  const uidNum = Number(userId);
  const tgNum = Number(tgId);
  if (!uidNum || !tgNum) {
    return { ok: false, reason: "invalid_params" };
  }

  const matches = await col.users
    .find({ tg_id: tgNum })
    .sort({ id: 1 })
    .toArray();

  if (matches.length > 0) {
    const primaryOwner = matches[0];
    if (matches.length > 1) {
      const dupIds = matches.slice(1).map((u) => u.id);
      await col.users.updateMany(
        { id: { $in: dupIds } },
        { $set: { free_active: 0, free_expires_at: null, tg_id: null } }
      );
    }
    if (Number(primaryOwner.id) !== uidNum) {
      return {
        ok: false,
        reason: "tg_already_used",
        owner_id: primaryOwner.id,
      };
    }
  }

  const currentUser = await col.users.findOne({ id: uidNum });
  if (!currentUser) {
    return { ok: false, reason: "user_not_found" };
  }
  if (currentUser.tg_id && Number(currentUser.tg_id) !== tgNum) {
    return {
      ok: false,
      reason: "user_has_other_tg",
    };
  }

  await col.users.updateOne(
    { id: uidNum },
    {
      $set: {
        free_active: 1,
        free_expires_at: expires || null,
        tg_id: tgNum,
      },
    }
  );
  return { ok: true, owner_id: uidNum };
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
async function dbGetFreeApiUsed(userId) {
  const u = await col.users.findOne(
    { id: Number(userId) },
    { projection: { free_api_used: 1 } }
  );
  return Number(u && u.free_api_used) || 0;
}
async function dbBumpFreeApi(userId) {
  await col.users.updateOne(
    { id: Number(userId) },
    { $inc: { free_api_used: 1 } }
  );
}
async function dbGetFreeNexusUsed(userId) {
  const u = await col.users.findOne(
    { id: Number(userId) },
    { projection: { free_nexus_used: 1 } }
  );
  return Number(u && u.free_nexus_used) || 0;
}
async function dbBumpFreeNexus(userId) {
  await col.users.updateOne(
    { id: Number(userId) },
    { $inc: { free_nexus_used: 1 } }
  );
}

async function notifyUserBanStatus(userId, isBanned, reason) {
  try {
    const uid = Number(userId);
    if (!uid) return;
    let userName = `User #${uid}`;
    if (col.users) {
      const u = await col.users.findOne(
        { id: uid },
        { projection: { name: 1, email: 1 } }
      );
      if (u && (u.name || u.email)) userName = u.name || u.email;
    }
    if (isBanned) {
      const cleanReason = String(reason || "Security policy").slice(0, 120);
      pushNotification({
        target: "user",
        user_id: uid,
        user_name: userName,
        type: "account_banned",
        title: "🚫 Account Blocked / Restricted",
        message: `Hi ${userName}, your DRAGO Predictor ID (#${uid}) has been blocked (${cleanReason}). Please contact Admin Support if you need help.`,
        action_url: "/profile/",
        action_label: "CONTACT SUPPORT →",
      });
    } else {
      pushNotification({
        target: "user",
        user_id: uid,
        user_name: userName,
        type: "account_unbanned",
        title: "✅ Account Unblocked & Restored!",
        message: `Good news ${userName}! Your DRAGO Predictor ID (#${uid}) has been unblocked by Admin. You can now use all features again.`,
        action_url: "/dashboard/",
        action_label: "OPEN APP →",
      });
    }
  } catch (e) {
    console.warn("notifyUserBanStatus:", e.message);
  }
}

async function dbBanUser(userId, reason) {
  const r = await col.users.updateOne(
    { id: Number(userId) },
    {
      $set: {
        banned: 1,
        banned_at: new Date().toISOString(),
        ban_reason: String(reason || "policy").slice(0, 200),
      },
    }
  );
  if (r.matchedCount > 0) {
    notifyUserBanStatus(userId, true, reason);
  }
  return r.matchedCount > 0;
}
/** DevTools detect → temporary block (admin UNLOCK kar sakta hai) */
async function dbBlockUser(userId, reason, device) {
  const r = await col.users.updateOne(
    { id: Number(userId) },
    {
      $set: {
        banned: 1,
        ban_state: "blocked",
        banned_at: new Date().toISOString(),
        ban_reason: String(reason || "devtools").slice(0, 200),
      },
    }
  );
  if (device && col.banned_devices) {
    await col.banned_devices.updateOne(
      { device: String(device) },
      {
        $set: {
          device: String(device),
          user_id: Number(userId),
          state: "blocked",
          at: new Date().toISOString(),
        },
      },
      { upsert: true }
    );
  }
  if (r.matchedCount > 0) {
    notifyUserBanStatus(userId, true, reason || "Security lock");
  }
  return r.matchedCount > 0;
}
/** Device-only block (bina login user ke) */
async function dbBlockDevice(device, reason) {
  if (!device || !col.banned_devices) return false;
  const r = await col.banned_devices.updateOne(
    { device: String(device) },
    {
      $set: {
        device: String(device),
        user_id: null,
        state: "blocked",
        reason: String(reason || "devtools").slice(0, 200),
        at: new Date().toISOString(),
      },
    },
    { upsert: true }
  );
  return !!r;
}
/** Admin Telegram / Admin Panel se permanent BAN */
async function dbBanPermanent(userId, reason) {
  await col.users.updateOne(
    { id: Number(userId) },
    {
      $set: {
        banned: 1,
        ban_state: "banned",
        banned_at: new Date().toISOString(),
        ban_reason: String(reason || "Admin ban").slice(0, 200),
      },
      $inc: { token_version: 1 },
    }
  );
  if (col.banned_devices) {
    await col.banned_devices.updateMany(
      { user_id: Number(userId) },
      { $set: { state: "banned" } }
    );
  }
  notifyUserBanStatus(userId, true, reason || "Admin ban");
  return true;
}
async function dbBanUserPermanent(userId, reason) {
  return dbBanPermanent(userId, reason);
}
/** Admin Telegram / Admin Panel se UNLOCK */
async function dbUnbanUser(userId) {
  await col.users.updateOne(
    { id: Number(userId) },
    { $set: { banned: 0, ban_state: "ok", ban_reason: null } }
  );
  if (col.banned_devices) {
    await col.banned_devices.deleteMany({ user_id: Number(userId) });
  }
  notifyUserBanStatus(userId, false);
  return true;
}
async function dbUnlockUser(userId) {
  return dbUnbanUser(userId);
}
async function dbIsUserBanned(userId) {
  const u = await col.users.findOne(
    { id: Number(userId) },
    { projection: { banned: 1, ban_reason: 1, ban_state: 1 } }
  );
  return u && u.banned
    ? { banned: true, reason: u.ban_reason || null, state: u.ban_state === "banned" ? "banned" : "blocked" }
    : { banned: false, state: "ok" };
}
async function dbBanStateByDevice(device) {
  if (!device || !col.banned_devices) return null;
  const d = await col.banned_devices.findOne({ device: String(device) });
  return d ? (d.state === "banned" ? "banned" : "blocked") : null;
}
/** Blocked/banned users ki list (Telegram /banlist ke liye) */
async function dbListBanned(limit) {
  const rows = await col.users
    .find({ banned: 1 })
    .sort({ banned_at: -1 })
    .limit(limit || 30)
    .toArray();
  const list = rows.map((u) => ({
    id: u.id,
    name: u.name || "",
    email: u.email || "",
    device: null,
    state: u.ban_state === "banned" ? "banned" : "blocked",
    at: u.banned_at || "",
    reason: u.ban_reason || "",
  }));
  // Device-only blocks (bina login wale) bhi dikhao
  if (col.banned_devices) {
    const devRows = await col.banned_devices
      .find({ user_id: null })
      .sort({ at: -1 })
      .limit(10)
      .toArray();
    devRows.forEach((d) =>
      list.push({
        id: null,
        name: "(not logged in)",
        email: "",
        device: d.device,
        state: d.state === "banned" ? "banned" : "blocked",
        at: d.at || "",
        reason: d.reason || "",
      })
    );
  }
  return list;
}
/** /banlist + refresh button dono ke liye shared payload */
async function banListPayload() {
  const rows = await dbListBanned(20);
  if (!rows.length) return null;
  const keyboard = [];
  const lines = ["🚫 *Blocked/Banned users:*", ""];
  rows.forEach((u) => {
    const tag = u.state === "banned" ? "⛔" : "🟠";
    if (u.id != null) {
      lines.push(
        `${tag} #${u.id} ${u.name || "—"}\n   ${u.email || ""}\n   ${u.state} • ${String(u.at).slice(0, 16).replace("T", " ")}`
      );
      keyboard.push([
        { text: `🔓 Unlock #${u.id}`, callback_data: `ub:${u.id}` },
        { text: `⛔ Ban #${u.id}`, callback_data: `bb:${u.id}` },
      ]);
    } else {
      lines.push(
        `${tag} 📱 ${String(u.device || "?").slice(0, 14)}…\n   ${u.name}\n   ${u.state} • ${String(u.at).slice(0, 16).replace("T", " ")}`
      );
      keyboard.push([
        { text: `🔓 Dev ${String(u.device).slice(0, 6)}`, callback_data: `ud:${u.device}` },
        { text: `⛔ Dev ${String(u.device).slice(0, 6)}`, callback_data: `bd:${u.device}` },
      ]);
    }
  });
  keyboard.push([{ text: "🔄 Refresh", callback_data: "banlist:refresh" }]);
  return { text: lines.join("\n"), keyboard };
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

  // Automatically broadcast In-App + Web Push Notification to ALL users when a new game is added!
  try {
    pushNotification({
      target: "all",
      type: "new_game",
      title: `🎮 New Game Added: ${name}!`,
      message: `${name} is now live on DRAGO Predictor! Open the app now to play with real-time AI WinGo 30s predictions.`,
      image_url: imageUrl || null,
      action_url: "/game/",
      action_label: `PLAY ${String(name).toUpperCase().slice(0, 20)} →`,
    });
  } catch (e) {
    console.warn("dbInsertGame pushNotification:", e.message);
  }

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
  const keyHash = hashApiKey(apiKey);
  const keyPrefix = String(apiKey).slice(0, 12);
  const doc = {
    id,
    user_id: Number(userId),
    key_hash: keyHash,
    key_prefix: keyPrefix,
    key_enc: encKey(apiKey),
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
  const raw = String(key || "").trim();
  if (!raw) return null;
  const keyHash = hashApiKey(raw);
  let doc = await col.api_keys.findOne({ key_hash: keyHash });
  if (!doc) {
    doc = await col.api_keys.findOne({ api_key: raw });
    if (doc) {
      try {
        await col.api_keys.updateOne(
          { id: doc.id },
          {
            $set: { key_hash: keyHash, key_prefix: raw.slice(0, 12) },
            $unset: { api_key: "" },
          }
        );
        doc.key_hash = keyHash;
        doc.key_prefix = raw.slice(0, 12);
        delete doc.api_key;
      } catch (e) {
        console.warn("api key migrate:", e.message);
      }
    }
  }
  return mapApiKey(doc);
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
  guard_enabled: true, // DevTools detect/block (frontend guard)
  force_feedback: false, // "Bug in app" ON → sab users ko popup har visit pe
  force_rate: false, // "Rate in app" ON → sab users ko rating popup
  force_winfb: false, // "Feedback in app" ON → 20+ wins wale users ko feedback popup
  free_pred_limit: 3,
  free_api_history_limit: 10,
  free_nexus_limit: 3,
  weekly_name: "PRO VIP WEEKLY",
  weekly_amount: 749,
  weekly_days: 7,
  weekly_qr_url: "",
  monthly_name: "PRO VIP MONTHLY",
  monthly_amount: 1498,
  monthly_days: 30,
  monthly_qr_url: "",
  upi_id: "",
  notif_plan_active_title: "💎 Pro VIP Plan Activated!",
  notif_plan_active_body:
    "Congratulations {name}! Your {plan} ({days} Days) VIP subscription is now active until {expiry}. Enjoy Unlimited AI Predictions, NEXUS Agent & Floating Game Window!",
  notif_plan_active_image: "",
  notif_plan_expired_title: "⚠️ Your Pro VIP Plan Has Expired!",
  notif_plan_expired_body:
    "Hello {name}, your Pro VIP subscription expired on {expiry}. Renew your VIP plan now to continue enjoying unlimited AI predictions and premium features!",
  notif_plan_expired_image: "",
  banners: [
    {
      id: "default_rx1",
      title: "DRAGO Predictor RX1 Model",
      image_url: "/assets/images/banners/rx1-model-feature.webp",
      link_url: "/prediction/",
      active: true,
    },
  ],
};
let adminSettings = { ...DEFAULT_ADMIN_SETTINGS };

function getActiveUpiId() {
  return (adminSettings && adminSettings.upi_id && String(adminSettings.upi_id).trim()) || UPI_ID;
}

function getActiveBanners() {
  const list = Array.isArray(adminSettings && adminSettings.banners)
    ? adminSettings.banners.filter((b) => b && b.image_url && b.active !== false)
    : [];
  if (list.length > 0) return list;
  return DEFAULT_ADMIN_SETTINGS.banners;
}

/* ── Web Push Notification Engine (VAPID + MongoDB/Local Store) ── */
const VAPID_PUBLIC_KEY = String(process.env.VAPID_PUBLIC_KEY || "").trim();
const VAPID_PRIVATE_KEY = String(process.env.VAPID_PRIVATE_KEY || "").trim();

if (webPush && VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  try {
    webPush.setVapidDetails(
      "mailto:support@dragopredictor.vercel.app",
      VAPID_PUBLIC_KEY,
      VAPID_PRIVATE_KEY
    );
  } catch (e) {
    console.warn("webPush.setVapidDetails:", e.message);
  }
}

const PUSH_SUBS_PATH = path.join(__dirname, "push_subs.json");
let pushSubscriptionsList = [];
try {
  if (fs.existsSync(PUSH_SUBS_PATH)) {
    const parsed = JSON.parse(fs.readFileSync(PUSH_SUBS_PATH, "utf8"));
    if (Array.isArray(parsed)) pushSubscriptionsList = parsed;
  }
} catch (_) {
  pushSubscriptionsList = [];
}

function savePushSubscriptionsStore() {
  try {
    fs.writeFileSync(
      PUSH_SUBS_PATH,
      JSON.stringify(pushSubscriptionsList.slice(0, 3000), null, 2),
      "utf8"
    );
  } catch (_) {}
  if (col.kv_store) {
    col.kv_store
      .updateOne(
        { _id: "push_subs_v1" },
        {
          $set: {
            value: pushSubscriptionsList.slice(0, 3000),
            updated_at: new Date().toISOString(),
          },
        },
        { upsert: true }
      )
      .catch((err) => console.warn("mongo push_subs save:", err.message));
  }
}

function isUserPushSubscribed(userId) {
  const uid = Number(userId);
  if (!uid) return false;
  return pushSubscriptionsList.some((s) => s && Number(s.user_id) === uid && s.endpoint);
}

async function dispatchWebPush(item) {
  if (!webPush || !item) return { attempted: 0, delivered: 0, failed: 0 };
  const target = item.target === "all" ? "all" : "user";
  const targetUid = Number(item.user_id) || null;
  const targets = pushSubscriptionsList.filter((s) => {
    if (!s || !s.endpoint || !s.keys) return false;
    if (target === "all") return true;
    return targetUid && Number(s.user_id) === targetUid;
  });

  if (!targets.length) {
    return { attempted: 0, delivered: 0, failed: 0 };
  }

  const payload = JSON.stringify({
    id: item.id,
    title: item.title || "DRAGO Predictor",
    body: item.message || "",
    image: item.image_url || null,
    icon: `${FRONTEND_URL}/favicon-192.png?v=20261004`,
    badge: `${FRONTEND_URL}/favicon-192.png?v=20261004`,
    url: item.action_url || "/notifications/",
    action_label: item.action_label || "Open App",
    type: item.type || "broadcast",
    created_at: item.created_at || new Date().toISOString(),
  });

  let delivered = 0;
  let failed = 0;
  const deadEndpoints = new Set();

  await Promise.all(
    targets.map(async (subRecord) => {
      try {
        await webPush.sendNotification(
          {
            endpoint: subRecord.endpoint,
            keys: subRecord.keys,
          },
          payload,
          { TTL: 86400, urgency: "high" }
        );
        delivered++;
      } catch (err) {
        failed++;
        const status = Number(err && err.statusCode);
        if (status === 404 || status === 410) {
          deadEndpoints.add(subRecord.endpoint);
        }
      }
    })
  );

  if (deadEndpoints.size > 0) {
    pushSubscriptionsList = pushSubscriptionsList.filter(
      (s) => s && !deadEndpoints.has(s.endpoint)
    );
    savePushSubscriptionsStore();
  }

  return { attempted: targets.length, delivered, failed };
}

/* ── Persistent Notifications Store (Broadcast + Personal + Auto Plan Active/Expired) ── */
const NOTIFICATIONS_PATH = path.join(__dirname, "notifications.json");
let notificationsList = [];
try {
  if (fs.existsSync(NOTIFICATIONS_PATH)) {
    const parsed = JSON.parse(fs.readFileSync(NOTIFICATIONS_PATH, "utf8"));
    if (Array.isArray(parsed)) notificationsList = parsed;
  }
} catch (_) {
  notificationsList = [];
}

function saveNotificationsStore() {
  try {
    fs.writeFileSync(
      NOTIFICATIONS_PATH,
      JSON.stringify(notificationsList.slice(0, 250), null, 2),
      "utf8"
    );
  } catch (_) {}
  if (col.kv_store) {
    col.kv_store
      .updateOne(
        { _id: "notifications_v1" },
        {
          $set: {
            value: notificationsList.slice(0, 250),
            updated_at: new Date().toISOString(),
          },
        },
        { upsert: true }
      )
      .catch((err) => console.warn("mongo notifications save:", err.message));
  }
}

function formatNotifTemplate(tpl, vars) {
  let out = String(tpl || "");
  const v = vars || {};
  out = out.replace(/\{name\}/gi, String(v.name || "VIP Member"));
  out = out.replace(/\{plan\}/gi, String(v.plan || "PRO VIP"));
  out = out.replace(/\{days\}/gi, String(v.days || "7"));
  out = out.replace(/\{expiry\}/gi, String(v.expiry || ""));
  return out;
}

function formatIstDateShort(isoOrMs) {
  try {
    const d = new Date(isoOrMs);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    });
  } catch (_) {
    return "—";
  }
}

function pushNotification({
  target,
  user_id,
  user_name,
  type,
  title,
  message,
  image_url,
  action_url,
  action_label,
}) {
  const item = {
    id: "ntf_" + Date.now() + "_" + crypto.randomBytes(3).toString("hex"),
    target: target === "all" ? "all" : "user",
    user_id: target === "all" ? null : Number(user_id) || null,
    user_name: user_name ? String(user_name).slice(0, 80) : null,
    type: String(type || "direct"),
    title: String(title || "DRAGO Update").trim().slice(0, 140),
    message: String(message || "").trim().slice(0, 1200),
    image_url: image_url ? String(image_url).trim() : null,
    action_url: action_url ? String(action_url).trim() : null,
    action_label: action_label ? String(action_label).trim().slice(0, 50) : null,
    created_at: new Date().toISOString(),
    read_by: [],
  };
  notificationsList.unshift(item);
  if (notificationsList.length > 250) {
    notificationsList = notificationsList.slice(0, 250);
  }
  saveNotificationsStore();
  dispatchWebPush(item).catch((err) =>
    console.warn("dispatchWebPush:", err && err.message)
  );
  return item;
}

async function sweepExpiredProUsers(onlyUserId) {
  if (!col.users) return;
  try {
    const nowIso = new Date().toISOString();
    const query = {
      is_pro: 1,
      pro_expires_at: { $ne: null, $lte: nowIso },
    };
    if (onlyUserId) {
      query.id = Number(onlyUserId);
    }
    const expiredUsers = await col.users.find(query).limit(50).toArray();
    for (const u of expiredUsers) {
      if (!u || !u.id) continue;
      if (u.pro_expired_notified_for && u.pro_expired_notified_for === u.pro_expires_at) {
        await col.users.updateOne({ id: u.id }, { $set: { is_pro: 0 } });
        continue;
      }
      const upd = await col.users.updateOne(
        { id: u.id, is_pro: 1 },
        {
          $set: {
            is_pro: 0,
            pro_expired_notified_for: u.pro_expires_at || nowIso,
          },
        }
      );
      if (upd && upd.modifiedCount > 0) {
        const expStr = formatIstDateShort(u.pro_expires_at || nowIso);
        const title = formatNotifTemplate(
          adminSettings.notif_plan_expired_title || DEFAULT_ADMIN_SETTINGS.notif_plan_expired_title,
          { name: u.name || "Member", expiry: expStr }
        );
        const message = formatNotifTemplate(
          adminSettings.notif_plan_expired_body || DEFAULT_ADMIN_SETTINGS.notif_plan_expired_body,
          { name: u.name || "Member", expiry: expStr }
        );
        pushNotification({
          target: "user",
          user_id: u.id,
          user_name: u.name || u.email || "",
          type: "plan_expired",
          title,
          message,
          image_url: adminSettings.notif_plan_expired_image || null,
          action_url: "/payment/?plan=weekly",
          action_label: "RENEW VIP PLAN →",
        });
      }
    }
  } catch (e) {
    console.warn("sweepExpiredProUsers:", e.message);
  }
}

// Automatically check expired VIP plans every 60 seconds so users receive
// In-App + Mobile Push Notifications on time even when the app is closed.
setInterval(() => {
  sweepExpiredProUsers().catch(() => {});
}, 60 * 1000);

/* ── Announcement broadcast (new game / feature popup) ── */
const ANNOUNCE_PATH = path.join(__dirname, "announcement.json");
let announcement = null;
try {
  if (fs.existsSync(ANNOUNCE_PATH)) {
    announcement = JSON.parse(fs.readFileSync(ANNOUNCE_PATH, "utf8")) || null;
  }
} catch (e) {
  announcement = null;
}
function saveAnnouncement(a) {
  announcement = a;
  try {
    fs.writeFileSync(ANNOUNCE_PATH, JSON.stringify(a, null, 2), "utf8");
  } catch (e) {
    console.warn("announcement save:", e.message);
  }
  if (col.kv_store) {
    col.kv_store
      .updateOne(
        { _id: "announcement" },
        { $set: { value: a, updated_at: new Date().toISOString() } },
        { upsert: true }
      )
      .catch((err) => console.warn("mongo announcement save:", err.message));
  }
}

/* ── Built-in Persistent Image Hosting (MongoDB + RAM Cache + ImgBB fallback) ── */
const IMGBB_API_KEY = String(process.env.IMGBB_API_KEY || process.env.IMGBB_KEY || "").trim();
const uploadedImagesMem = new Map(); // id -> { mime, buf, ext }

async function storeUploadedImage(buf, mimeType, req) {
  const mime = String(mimeType || "image/jpeg").toLowerCase();
  const ext = mime.includes("png")
    ? "png"
    : mime.includes("webp")
      ? "webp"
      : mime.includes("gif")
        ? "gif"
        : "jpg";

  // ImgBB credentials are accepted only from server-side environment variables.
  if (IMGBB_API_KEY) {
    try {
      const body = new URLSearchParams();
      body.append("key", IMGBB_API_KEY);
      body.append("image", buf.toString("base64"));
      const r = await fetch("https://api.imgbb.com/1/upload", {
        method: "POST",
        body,
        signal: AbortSignal.timeout(6000),
      });
      const j = await r.json();
      if (j && j.success && j.data && j.data.url) {
        return j.data.url;
      }
    } catch (_) {}
  }

  const id = "img_" + Date.now() + "_" + crypto.randomBytes(4).toString("hex");
  const doc = {
    id,
    ext,
    mime: `image/${ext === "jpg" ? "jpeg" : ext}`,
    data: buf.toString("base64"),
    size: buf.length,
    created_at: new Date().toISOString(),
  };

  uploadedImagesMem.set(id, { mime: doc.mime, buf, ext });
  if (uploadedImagesMem.size > 150) {
    const oldest = uploadedImagesMem.keys().next().value;
    if (oldest) uploadedImagesMem.delete(oldest);
  }

  if (col.uploads) {
    try {
      await col.uploads.updateOne({ id }, { $set: doc }, { upsert: true });
    } catch (e) {
      console.warn("mongo image save:", e.message);
    }
  }

  const base =
    PUBLIC_BASE_URL ||
    (req ? publicBase(req) : "") ||
    "https://dragopredictor.onrender.com";
  return `${base.replace(/\/$/, "")}/uploads/${id}.${ext}`;
}

async function getStoredImageById(rawId) {
  const id = String(rawId || "")
    .trim()
    .replace(/\.(png|jpe?g|webp|gif)$/i, "");
  if (!id) return null;
  if (uploadedImagesMem.has(id)) {
    return uploadedImagesMem.get(id);
  }
  if (col.uploads) {
    try {
      const doc = await col.uploads.findOne({ id });
      if (doc && doc.data) {
        const entry = {
          mime: doc.mime || "image/jpeg",
          buf: Buffer.from(doc.data, "base64"),
          ext: doc.ext || "jpg",
        };
        uploadedImagesMem.set(id, entry);
        return entry;
      }
    } catch (_) {}
  }
  return null;
}

async function sendTelegramPhotoSmart({ chatId, photoUrl, caption, replyMarkup, parseMode, token }) {
  const tk = token || TELEGRAM_BOT_TOKEN;
  if (!tk || !chatId) return null;

  // 1. If photoUrl is one of our /uploads/img_... URLs, send binary buffer directly via FormData
  try {
    const match = String(photoUrl || "").match(/\/uploads\/(img_[A-Za-z0-9_]+)(?:\.[a-z]+)?$/i);
    if (match && match[1]) {
      const stored = await getStoredImageById(match[1]);
      if (stored && stored.buf && typeof FormData !== "undefined" && typeof Blob !== "undefined") {
        const fd = new FormData();
        fd.append("chat_id", String(chatId));
        fd.append(
          "photo",
          new Blob([stored.buf], { type: stored.mime || "image/jpeg" }),
          `${match[1]}.${stored.ext || "jpg"}`
        );
        if (caption) fd.append("caption", String(caption).slice(0, 1024));
        if (parseMode) fd.append("parse_mode", String(parseMode));
        if (replyMarkup) fd.append("reply_markup", JSON.stringify(replyMarkup));

        const res = await fetch(`https://api.telegram.org/bot${tk}/sendPhoto`, {
          method: "POST",
          body: fd,
          signal: AbortSignal.timeout(15000),
        });
        const j = await res.json().catch(() => null);
        if (j && j.ok) return j;
      }
    }
  } catch (e) {
    console.warn("sendTelegramPhotoSmart binary:", e.message);
  }

  // 2. Fallback: send URL to Telegram sendPhoto
  if (photoUrl && /^https?:\/\//i.test(photoUrl)) {
    const payload = {
      chat_id: chatId,
      photo: photoUrl,
      caption: String(caption || "").slice(0, 1024),
    };
    if (parseMode) payload.parse_mode = parseMode;
    if (replyMarkup) payload.reply_markup = replyMarkup;
    const r = await telegramApi("sendPhoto", payload, tk);
    if (r && r.ok) return r;
  }

  return null;
}

async function imgbbUploadBuffer(buf) {
  return storeUploadedImage(buf, "image/jpeg", null);
}
async function telegramPhotoToImgbb(photoArr) {
  const best = photoArr[photoArr.length - 1];
  const f = await telegramApi("getFile", { file_id: best.file_id });
  if (!f || !f.ok || !f.result || !f.result.file_path) throw new Error("getFile failed");
  const src = await fetch(
    "https://api.telegram.org/file/bot" + TELEGRAM_BOT_TOKEN + "/" + f.result.file_path
  );
  const buf = Buffer.from(await src.arrayBuffer());
  return imgbbUploadBuffer(buf);
}
function istTimeStr() {
  try {
    return new Date().toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch (e) {
    return new Date().toString();
  }
}
/** Telegram group me notification (group bot → fallback admin bot) */
async function groupNotify(text, md) {
  const payload = { chat_id: TELEGRAM_REPORT_GROUP_ID, text };
  if (md) payload.parse_mode = "Markdown";
  try {
    let r = await telegramApi("sendMessage", payload, TELEGRAM_GROUP_BOT_TOKEN);
    if (!r || !r.ok && md) {
      // Markdown parse fail → plain text retry
      r = await telegramApi(
        "sendMessage",
        { chat_id: TELEGRAM_REPORT_GROUP_ID, text: text.replace(/[*_`]/g, "") },
        TELEGRAM_GROUP_BOT_TOKEN
      );
    }
    if (!r || !r.ok) r = await telegramApi("sendMessage", { chat_id: TELEGRAM_REPORT_GROUP_ID, text: text.replace(/[*_`]/g, "") });
  } catch (e) {
    console.warn("groupNotify:", e.message);
  }
}

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
  if (col.kv_store) {
    col.kv_store
      .updateOne(
        { _id: "admin_settings" },
        { $set: { value: adminSettings, updated_at: new Date().toISOString() } },
        { upsert: true }
      )
      .catch((err) => console.warn("mongo admin-settings save:", err.message));
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
function freeNexusLimit() {
  const n = Number(adminSettings.free_nexus_limit);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 3;
}
/** @deprecated use freePredLimit() / freeApiHistoryLimit() / freeNexusLimit() */
const FREE_PRED_LIMIT = 3;
const FREE_API_HISTORY_LIMIT = 10;
const FREE_NEXUS_LIMIT = 3;
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
 * Validate X-API-Key header, rate-limit, free/pro quotas, touch + usage.
 * Returns { row, rate, isPro } or sends error response and returns null.
 *
 * Free users:
 *   - history only (prediction blocked)
 *   - lifetime max freeApiHistoryLimit() history fetches
 * Pro users:
 *   - 20 requests / minute / endpoint (unchanged)
 */
async function requireApiKey(req, res, endpointName) {
  // Query-string credentials are rejected: URLs can leak through history, logs, and referrers.
  if (Object.keys(req.query || {}).some((name) => name.toLowerCase().replace(/[-_]/g, "") === "apikey")) {
    res.status(400).json({
      success: false,
      message: "API keys are accepted only in the X-API-Key header (never in URLs).",
    });
    return null;
  }
  const authHeader = String(req.headers.authorization || "").trim();
  const bearerKey = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
  const key = String(req.headers["x-api-key"] || bearerKey || "").trim();
  if (!key || key.length < 16 || key.length > 256) {
    res.status(401).json({
      success: false,
      message: "API key required in the X-API-Key header.",
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

  // History: free + any pro. Prediction API: any active Pro plan (Weekly ₹749 / Monthly ₹1498)
  if (endpointName === "prediction") {
    const planKey = user && user.pro_plan ? String(user.pro_plan) : "";
    if (!isPro) {
      res.status(403).json({
        success: false,
        message:
          "Prediction API is available only on Pro VIP plans (₹749 Weekly / ₹1,498 Monthly). Upgrade to access.",
        billing_required: true,
        plan: planKey || "free",
        required_plan: "weekly",
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

  // Free: lifetime history quota (10 fetches max across lifetime)
  let freeHistoryHits = 0;
  if (!isPro && endpointName === "history") {
    const totalUsage = usageMap(await dbUsageByUserTotal(row.user_id));
    const userDocApiUsed = await dbGetFreeApiUsed(row.user_id);
    freeHistoryHits = Math.max(userDocApiUsed, Number(totalUsage.history) || 0);
    if (freeHistoryHits >= freeApiHistoryLimit()) {
      res.status(402).json({
        success: false,
        message:
          "Free plan limit reached (10/10 Drago API data fetches). Upgrade to Pro Plan for unlimited API access.",
        billing_required: true,
        plan: "free",
        used: freeHistoryHits,
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
        remaining: Math.max(0, freeApiHistoryLimit() - freeHistoryHits),
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
  if (!isPro && endpointName === "history") {
    try {
      await dbBumpFreeApi(row.user_id);
    } catch (_) {}
  }
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

function vpsHeaders() {
  const h = { Accept: "application/json" };
  if (VPS_SECRET) {
    h["X-VPS-Key"] = VPS_SECRET;
    h["Authorization"] = "Bearer " + VPS_SECRET;
  }
  return h;
}

async function fetchWingoPrediction() {
  if (!WINGO_PREDICTION_URL) {
    const err = new Error("Prediction source not configured");
    err.status = 503;
    throw err;
  }
  const response = await fetch(WINGO_PREDICTION_URL, {
    signal: AbortSignal.timeout(10000),
    headers: vpsHeaders(),
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
        adminSettings = { ...DEFAULT_ADMIN_SETTINGS, ...settingsDoc.value };
      } else {
        await col.kv_store.updateOne(
          { _id: "admin_settings" },
          { $set: { value: adminSettings, updated_at: new Date().toISOString() } },
          { upsert: true }
        );
      }
      if (annDoc && annDoc.value !== undefined) {
        announcement = annDoc.value;
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

function extractHistoryList(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.items)) return payload.items;
  if (Array.isArray(payload.list)) return payload.list;
  if (Array.isArray(payload.data)) return payload.data;
  if (payload.data && Array.isArray(payload.data.list)) return payload.data.list;
  if (payload.data && Array.isArray(payload.data.records))
    return payload.data.records;
  if (Array.isArray(payload.records)) return payload.records;
  if (Array.isArray(payload.result)) return payload.result;
  return [];
}

/** Fetch history from orihost — never write to disk on Render */
async function fetchWingoHistoryFromVps(limit) {
  if (!WINGO_HISTORY_URL) {
    const err = new Error("History source not configured");
    err.status = 503;
    throw err;
  }
  const url = new URL(WINGO_HISTORY_URL);
  if (limit != null && Number.isFinite(limit) && limit > 0) {
    url.searchParams.set("limit", String(Math.min(WINGO_HISTORY_MAX, limit)));
  }
  const response = await fetch(url.toString(), {
    signal: AbortSignal.timeout(12000),
    headers: vpsHeaders(),
  });
  if (!response.ok) {
    const err = new Error(`Upstream history error: ${response.status}`);
    err.status = 502;
    throw err;
  }
  const data = await response.json();
  let items = extractHistoryList(data);
  if (limit != null && Number.isFinite(limit) && limit > 0) {
    items = items.slice(0, Math.min(WINGO_HISTORY_MAX, limit));
  } else if (items.length > WINGO_HISTORY_MAX) {
    items = items.slice(0, WINGO_HISTORY_MAX);
  }
  return {
    items,
    updated_at:
      (data && (data.updated_at || data.updatedAt)) ||
      new Date().toISOString(),
    raw: data,
  };
}

/** Lightweight VPS health for status page (no data stored) */
async function pingVps(kind) {
  const target =
    kind === "history" ? WINGO_HISTORY_URL : WINGO_PREDICTION_URL;
  if (!target) return { ok: false, detail: "Not configured", latency_ms: null };
  const t0 = Date.now();
  try {
    const r = await fetch(target, {
      method: "GET",
      signal: AbortSignal.timeout(8000),
      headers: vpsHeaders(),
    });
    return {
      ok: r.status < 500,
      detail: r.status < 500 ? "Online (VPS)" : `HTTP ${r.status}`,
      latency_ms: Date.now() - t0,
    };
  } catch (e) {
    return {
      ok: false,
      detail: "Unreachable",
      latency_ms: Date.now() - t0,
    };
  }
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
  // 💎 subscription alert → Telegram group
  try {
    const u = await col.users.findOne({ id: Number(userId) });
    groupNotify(
      "💎 *NEW SUBSCRIPTION ACTIVATED*\n\n" +
        "👤 Name: " + ((u && u.name) || "User") + "\n" +
        "🆔 ID: #" + userId + "\n" +
        "📦 Plan: " + planKey + " (" + plan.days + " days)\n" +
        "🕒 Time: " + istTimeStr(),
      true
    );
  } catch (e) {}
  return { plan: planKey, pro_expires_at: expires, days: plan.days };
}

async function telegramApi(method, body, token) {
  const tk = token || TELEGRAM_BOT_TOKEN;
  if (!tk) return null;
  const url = `https://api.telegram.org/bot${tk}/${method}`;
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
  if (!TELEGRAM_BOT_TOKEN) {
    console.warn("Telegram: TELEGRAM_BOT_TOKEN missing — payment notify skipped");
    return null;
  }
  if (!TELEGRAM_ADMIN_CHAT_ID) {
    console.warn("Telegram: TELEGRAM_ADMIN_CHAT_ID missing — payment notify skipped");
    return null;
  }
  const plan = PLAN_CATALOG[planKey];
  const when = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  const text =
    `🧾 *New manual payment*\n\n` +
    `👤 Name: ${escTgMd(user.name || "—", 80)}\n` +
    `📧 Email: ${escTgMd(user.email || "—", 120)}\n` +
    `🆔 User ID: #${escTgMd(user.id || "—", 24)}\n` +
    `📦 Plan: ${plan ? `${escTgMd(plan.name, 60)} (${plan.days} Days)` : escTgMd(planKey, 30)}\n` +
    `💰 Amount: ₹${Number(amount) || 0}\n` +
    `🔖 UTR: \`${escTgMd(utr, 32)}\`\n` +
    `🆔 Order: \`${escTgMd(orderId, 48)}\`\n` +
    `🕐 Time: ${when} IST`;

  // callback_data max 64 bytes — short codes
  const chatId = TELEGRAM_ADMIN_CHAT_ID;
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ Approve", callback_data: `a:${orderId}` },
          { text: "❌ Deny", callback_data: `d:${orderId}` },
        ],
      ],
    },
  };
  let result = await telegramApi("sendMessage", payload);
  // Retry without Markdown if parse fails
  if (result && !result.ok && String(result.description || "").includes("parse")) {
    delete payload.parse_mode;
    payload.text = payload.text.replace(/\*/g, "").replace(/`/g, "");
    result = await telegramApi("sendMessage", payload);
  }
  if (!result || !result.ok) {
    console.error("Telegram sendMessage failed:", JSON.stringify(result));
  } else {
    console.log("Telegram: payment notify sent OK order=", orderId);
  }
  return result;
}

/** DevTools detect → admin ko BAN / UNLOCK buttons wala alert */
async function notifyAdminDevtoolsBan({ user, userId, reason, device }) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_ADMIN_CHAT_ID) {
    console.warn("Telegram: token/chat missing — devtools alert skipped");
    return null;
  }
  const when = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  const text =
    `🚨 *DevTools detected — BLOCKED*\n\n` +
    `👤 Name: ${escTgMd((user && user.name) || "— (not logged in)", 80)}\n` +
    `📧 Email: ${escTgMd((user && user.email) || "—", 120)}\n` +
    `🆔 User ID: ${userId ? `\`${escTgMd(userId, 24)}\`` : "—"}\n` +
    `📱 Device: \`${escTgMd(device || "—", 64)}\`\n` +
    `🧾 Reason: ${escTgMd(reason || "devtools", 80)}\n` +
    `🕐 Time: ${when} IST\n\n` +
    `UNLOCK → user wapas app use kar payega\nBAN → permanent ban (site hamesha 404 dikhegi)`;
  // Logged-in → user buttons; device-only → device buttons (warna "bad user id")
  const hasUser = userId != null && userId !== "";
  const btnRow = hasUser
    ? [
        { text: "⛔ BAN Permanent", callback_data: `bb:${userId}` },
        { text: "🔓 UNLOCK", callback_data: `ub:${userId}` },
      ]
    : [
        { text: "⛔ BAN Device", callback_data: `bd:${device}` },
        { text: "🔓 UNLOCK Device", callback_data: `ud:${device}` },
      ];
  const payload = {
    chat_id: TELEGRAM_ADMIN_CHAT_ID,
    text,
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [btnRow],
    },
  };
  let result = await telegramApi("sendMessage", payload);
  if (result && !result.ok && String(result.description || "").includes("parse")) {
    delete payload.parse_mode;
    payload.text = payload.text.replace(/[*`]/g, "");
    result = await telegramApi("sendMessage", payload);
  }
  if (!result || !result.ok) console.error("Telegram devtools alert failed:", JSON.stringify(result));
  else console.log("Telegram: devtools alert sent OK user=", userId);
  return result;
}

/** Shared Approve / Deny handler (polling) */
/** Bug report → Telegram group (group bot bhejta hai; fallback admin bot) */
async function sendBugReportToGroup(report) {
  const text =
    `🐞 *Bug Report — DRAGO Predictor*\n\n` +
    `👤 User: ${escTgMd(report.name, 80)} (#${escTgMd(report.userId, 24)})\n` +
    `🧩 Area: ${escTgMd(report.category, 60)}\n` +
    `📝 Issue: ${escTgMd(report.description, 1200)}`;
  const payload = {
    chat_id: TELEGRAM_REPORT_GROUP_ID,
    text,
    parse_mode: "Markdown",
    disable_web_page_preview: true,
  };
  let r = await telegramApi("sendMessage", payload, TELEGRAM_GROUP_BOT_TOKEN);
  if (!r || !r.ok) r = await telegramApi("sendMessage", payload);
  return r;
}

async function handleTelegramCallback(cb) {
  if (!cb || !cb.data) return;
  const data = String(cb.data);
  const chatId = cb.message && cb.message.chat && cb.message.chat.id;
  const msgId = cb.message && cb.message.message_id;
  const fromId = cb.from && cb.from.id;

  // CRITICAL (BE-1): Strictly verify Telegram admin identity at the top of handleTelegramCallback
  if (!isTelegramAdmin(fromId) && !isTelegramAdmin(chatId)) {
    await telegramApi("answerCallbackQuery", {
      callback_query_id: cb.id,
      text: "Unauthorized: Admin only",
      show_alert: true,
    });
    return;
  }

  // 📢 Announcement broadcast — conversation start
  if (data === "act:announce") {
    if (!isTelegramAdmin(chatId)) return;
    await telegramApi("answerCallbackQuery", { callback_query_id: cb.id });
    tgConversations.set(String(chatId), {
      step: "ann_type",
      data: {},
      expires: Date.now() + 10 * 60 * 1000,
    });
    await tgReply(
      chatId,
      "📢 New Announcement\n\nType bhejo:\n1 = 🎮 New Game\n2 = ⚡ Server Update\n3 = 📢 Other\n\n(or /cancel)"
    );
    return;
  }

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
    } else if (key === "guard") {
      adminSettings.guard_enabled = !adminSettings.guard_enabled;
    } else if (key === "feedback") {
      adminSettings.force_feedback = !adminSettings.force_feedback;
    } else if (key === "rate") {
      adminSettings.force_rate = !adminSettings.force_rate;
    } else if (key === "winfb") {
      adminSettings.force_winfb = !adminSettings.force_winfb;
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
            [
              {
                text: s.guard_enabled
                  ? "🔴 Disable DevTools Guard"
                  : "🟢 Enable DevTools Guard",
                callback_data: "cfg:guard",
              },
            ],
            [
              {
                text: s.force_feedback ? "🐞 Bug in app: ON" : "🐞 Bug in app: OFF",
                callback_data: "cfg:feedback",
              },
            ],
            [
              {
                text: s.force_rate ? "⭐ Rate in app: ON" : "⭐ Rate in app: OFF",
                callback_data: "cfg:rate",
              },
            ],
            [
              {
                text: s.force_winfb ? "🏆 Feedback in app: ON" : "🏆 Feedback in app: OFF",
                callback_data: "cfg:winfb",
              },
            ],
            [{ text: "👥 Users Manage", callback_data: "users:list" }],
        [{ text: "🔄 Refresh", callback_data: "cfg:refresh" }],
          ],
        },
      });
    } catch (e) {
      console.error("tg panel edit:", e.message);
    }
    return;
  }

  // /banlist refresh button
  if (data === "banlist:refresh") {
    if (!isTelegramAdmin(chatId)) {
      await telegramApi("answerCallbackQuery", {
        callback_query_id: cb.id,
        text: "Not admin",
        show_alert: true,
      });
      return;
    }
    const p = await banListPayload();
    await telegramApi("answerCallbackQuery", { callback_query_id: cb.id, text: "Refreshed" });
    if (chatId && msgId) {
      await telegramApi("editMessageText", {
        chat_id: chatId,
        message_id: msgId,
        text: p ? p.text : "✅ Koi blocked/banned user nahi hai.",
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: p ? p.keyboard : [] },
      });
    }
    return;
  }

  // Device-only ban: unlock / ban
  if (data.startsWith("ud:") || data.startsWith("bd:")) {
    if (!isTelegramAdmin(chatId)) {
      await telegramApi("answerCallbackQuery", { callback_query_id: cb.id, text: "Not admin", show_alert: true });
      return;
    }
    const dev = data.slice(3);
    if (data.startsWith("ud:")) {
      if (col.banned_devices) await col.banned_devices.deleteOne({ device: dev });
      await telegramApi("answerCallbackQuery", { callback_query_id: cb.id, text: "Device unlocked" });
      if (chatId && msgId)
        await telegramApi("editMessageText", {
          chat_id: chatId, message_id: msgId,
          text: `🔓 DEVICE UNLOCKED\n${dev}`, reply_markup: { inline_keyboard: [] },
        });
    } else {
      if (col.banned_devices) await col.banned_devices.updateOne({ device: dev }, { $set: { state: "banned" } });
      await telegramApi("answerCallbackQuery", { callback_query_id: cb.id, text: "Device banned" });
      if (chatId && msgId)
        await telegramApi("editMessageText", {
          chat_id: chatId, message_id: msgId,
          text: `⛔ DEVICE BANNED\n${dev}`, reply_markup: { inline_keyboard: [] },
        });
    }
    return;
  }

  // DevTools ban: ⛔ BAN / 🔓 UNLOCK
  if (data.startsWith("bb:") || data.startsWith("ub:")) {
    if (!isTelegramAdmin(chatId)) {
      await telegramApi("answerCallbackQuery", {
        callback_query_id: cb.id,
        text: "Not admin",
        show_alert: true,
      });
      return;
    }
    const uid = Number(data.slice(3));
    if (!uid) {
      await telegramApi("answerCallbackQuery", { callback_query_id: cb.id, text: "Bad user id" });
      return;
    }
    if (data.startsWith("ub:")) {
      await dbUnbanUser(uid);
      await telegramApi("answerCallbackQuery", {
        callback_query_id: cb.id,
        text: "Unlocked — user can use app",
      });
      if (chatId && msgId) {
        await telegramApi("editMessageText", {
          chat_id: chatId,
          message_id: msgId,
          text: `🔓 UNLOCKED\nUser #${uid} ab wapas app use kar sakta hai.`,
          reply_markup: { inline_keyboard: [] },
        });
      }
      console.log("🔓 UNLOCK user=", uid);
    } else {
      await dbBanPermanent(uid);
      await telegramApi("answerCallbackQuery", {
        callback_query_id: cb.id,
        text: "Banned permanently",
      });
      if (chatId && msgId) {
        await telegramApi("editMessageText", {
          chat_id: chatId,
          message_id: msgId,
          text: `⛔ PERMANENTLY BANNED\nUser #${uid} — site ab isko 404 dikhegi.`,
          reply_markup: { inline_keyboard: [] },
        });
      }
      console.log("⛔ PERMA-BAN user=", uid);
    }
    return;
  }

  // ── USER MANAGEMENT: pro grant / pro band / ban / unban ──
  async function showUserMenu(uid, cId, mId) {
    const p = await userDocMenuPayload(uid);
    if (!p) {
      await telegramApi("editMessageText", {
        chat_id: cId,
        message_id: mId,
        text: "❌ User #" + uid + " nahi mila.",
        reply_markup: {
          inline_keyboard: [[{ text: "← Users", callback_data: "users:list" }]],
        },
      });
      return;
    }
    await telegramApi("editMessageText", {
      chat_id: cId,
      message_id: mId,
      text: p.text,
      reply_markup: { inline_keyboard: p.keyboard },
    });
  }

  if (
    data === "users:list" ||
    data === "users:panel" ||
    data === "users:search" ||
    data === "users:pro" ||
    data.startsWith("users:page:") ||
    data.startsWith("users:propage:") ||
    data.startsWith("u:") ||
    data.startsWith("up:")
  ) {
    if (!isTelegramAdmin(chatId)) {
      await telegramApi("answerCallbackQuery", {
        callback_query_id: cb.id,
        text: "Not admin",
        show_alert: true,
      });
      return;
    }
    await telegramApi("answerCallbackQuery", { callback_query_id: cb.id });

    if (data === "users:panel") {
      await sendAdminPanel(chatId);
      return;
    }

    if (data === "users:search") {
      tgConversations.set(String(chatId), {
        step: "usersearch",
        data: {},
        expires: Date.now() + 10 * 60 * 1000,
      });
      await tgReply(
        chatId,
        "🔍 User search\n\nUser ID, email ya naam bhejo.\n\n(or /cancel)"
      );
      return;
    }

    if (data === "users:pro" || data.startsWith("users:propage:")) {
      const page = data.startsWith("users:propage:")
        ? Math.max(0, Number(data.slice(14)) || 0)
        : 0;
      const rows = await col.users
        .find({ is_pro: 1 })
        .sort({ id: -1 })
        .skip(page * 8)
        .limit(8)
        .toArray();
      const total = await col.users.countDocuments({ is_pro: 1 });
      const kb = [];
      for (const u of rows) {
        const pn =
          u.pro_plan && PLAN_CATALOG[u.pro_plan]
            ? PLAN_CATALOG[u.pro_plan].name
            : "PRO";
        kb.push([
          {
            text:
              "⭐ #" + u.id + " · " + String(u.name || u.email || "user").slice(0, 14) +
              " · " + pn.replace("RX1 FOR ", ""),
            callback_data: "u:" + u.id,
          },
        ]);
      }
      if (!kb.length) kb.push([{ text: "🤷 Koi pro user nahi", callback_data: "users:panel" }]);
      const nav = [];
      if (page > 0) nav.push({ text: "‹ Prev", callback_data: "users:propage:" + (page - 1) });
      if (page * 8 + 8 < total) nav.push({ text: "Next ›", callback_data: "users:propage:" + (page + 1) });
      if (nav.length) kb.push(nav);
      kb.push([
        { text: "👥 All users", callback_data: "users:list" },
        { text: "← Panel", callback_data: "users:panel" },
      ]);
      await telegramApi("editMessageText", {
        chat_id: chatId,
        message_id: msgId,
        text: "⭐ PRO USERS (" + total + ") — page " + (page + 1) + ":",
        reply_markup: { inline_keyboard: kb },
      });
      return;
    }

    if (data === "users:list" || data.startsWith("users:page:")) {
      const page = data.startsWith("users:page:")
        ? Math.max(0, Number(data.slice(11)) || 0)
        : 0;
      const rows = await col.users
        .find({})
        .sort({ id: -1 })
        .skip(page * 8)
        .limit(8)
        .toArray();
      const total = await col.users.countDocuments({});
      const kb = [
        [
          { text: "🔍 Search user", callback_data: "users:search" },
          { text: "⭐ Pro users", callback_data: "users:pro" },
        ],
      ];
      for (const u of rows) {
        kb.push([
          {
            text:
              "👤 " + String(u.name || u.email || "user").slice(0, 16) +
              " #" + u.id + (u.is_pro ? " 🟢" : ""),
            callback_data: "u:" + u.id,
          },
        ]);
      }
      const nav = [];
      if (page > 0) nav.push({ text: "‹ Prev", callback_data: "users:page:" + (page - 1) });
      if (page * 8 + 8 < total) nav.push({ text: "Next ›", callback_data: "users:page:" + (page + 1) });
      if (nav.length) kb.push(nav);
      kb.push([{ text: "← Panel", callback_data: "users:panel" }]);
      await telegramApi("editMessageText", {
        chat_id: chatId,
        message_id: msgId,
        text: "👥 Users (page " + (page + 1) + ") — user select karo:",
        reply_markup: { inline_keyboard: kb },
      });
      return;
    }

    if (data.startsWith("up:")) {
      const parts = data.split(":");
      const uid = Number(parts[1]);
      const plan = parts[2];
      if (plan === "none") {
        await dbSetUserPro(uid, false, null, null);
        await telegramApi("answerCallbackQuery", {
          callback_query_id: cb.id,
          text: "❌ Pro band — user ab FREE hai",
          show_alert: true,
        });
      } else if (PLAN_CATALOG[plan]) {
        const p = PLAN_CATALOG[plan];
        const expIso = new Date(Date.now() + p.days * 86400000).toISOString();
        await dbSetUserPro(uid, true, plan, expIso);
        await telegramApi("answerCallbackQuery", {
          callback_query_id: cb.id,
          text: "✅ PRO " + p.name + " (" + p.days + " din) grant ho gaya",
          show_alert: true,
        });
      } else {
        await telegramApi("answerCallbackQuery", {
          callback_query_id: cb.id,
          text: "Bad plan",
        });
        return;
      }
      await showUserMenu(uid, chatId, msgId);
      return;
    }

    if (data.startsWith("u:")) {
      await showUserMenu(Number(data.slice(2)), chatId, msgId);
      return;
    }
    return;
  }

  let action = null;
  let orderId = null;
  if (data === "stats:refresh") {
    await telegramApi("answerCallbackQuery", {
      callback_query_id: cb.id,
      text: "Refreshed",
    });
    await sendAdminPanel(chatId);
    return;
  }
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
  const convPre = tgConversations.get(String(chatId));
  const text = String(msg.text || "").trim();
  if (!text && !(msg.photo && convPre && convPre.step === "ann_image")) return;

  if (!isTelegramAdmin(chatId)) {
    // Ignore non-admin private messages (payment buttons still work via callback)
    return;
  }

  // Direct photo accepted — announcement image ya /addgame image (imgbb pe upload)
  if (
    convPre &&
    (convPre.step === "ann_image" || convPre.step === "image") &&
    convPre.expires > Date.now() &&
    msg.photo &&
    msg.photo.length
  ) {
    try {
      const url = await telegramPhotoToImgbb(msg.photo);
      convPre.data.image_url = url;
      convPre.expires = Date.now() + 10 * 60 * 1000;
      if (convPre.step === "ann_image") {
        convPre.step = "ann_title";
        await tgReply(
          chatId,
          "✅ Image uploaded\n\nStep 2/3 — Send the TITLE (game / feature name)\n\n(or /cancel)"
        );
      } else {
        convPre.step = "link";
        await tgReply(
          chatId,
          "✅ Image uploaded\n\nStep 3/3 — Send GAME LINK (URL that opens in gameplay)"
        );
      }
      return;
    } catch (e) {
      await tgReply(chatId, "Photo upload failed — send the image again (photo ya https URL):");
      return;
    }
  }

  if (!text) return;

  const lower = text.toLowerCase();
  const conv = convPre;

  // Cancel
  if (lower === "/cancel") {
    tgConversations.delete(String(chatId));
    await tgReply(chatId, "Cancelled.");
    return;
  }

  if (conv && conv.expires > Date.now() && conv.step === "usersearch") {
    tgConversations.delete(String(chatId));
    const q = text.trim();
    let rows = [];
    if (/^\d+$/.test(q)) {
      const one = await dbFindUserById(Number(q));
      if (one) rows = [one];
    } else if (q.indexOf("@") !== -1) {
      rows = await col.users
        .find({ email: new RegExp(escRe(q), "i") })
        .limit(6)
        .toArray();
    } else {
      rows = await col.users
        .find({ name: new RegExp(escRe(q), "i") })
        .limit(6)
        .toArray();
    }
    if (!rows.length) {
      await tgReply(chatId, "❌ Koi user nahi mila: " + q);
      return;
    }
    if (rows.length === 1) {
      const u = rows[0];
      const p = await userDocMenuPayload(u.id);
      await telegramApi("sendMessage", {
        chat_id: chatId,
        text: p.text,
        reply_markup: { inline_keyboard: p.keyboard },
      });
      return;
    }
    const kb = rows.map((u) => [
      {
        text:
          "👤 #" + u.id + " · " + String(u.name || u.email || "user").slice(0, 20) +
          (u.is_pro ? " 🟢" : ""),
        callback_data: "u:" + u.id,
      },
    ]);
    await telegramApi("sendMessage", {
      chat_id: chatId,
      text: "🔍 " + rows.length + " users mile — select karo:",
      reply_markup: { inline_keyboard: kb },
    });
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

  // /banlist — blocked/banned users ki list + UNLOCK/BAN buttons
  if (lower === "/banlist" || lower === "/bans" || lower === "/blocked" || lower === "/blocklist") {
    const rows = await dbListBanned(20);
    if (!rows.length) {
      await tgReply(chatId, "✅ Koi blocked/banned user nahi hai.");
      return;
    }
    const keyboard = [];
    const lines = ["🚫 *Blocked/Banned users:*", ""];
    rows.forEach((u) => {
      const tag = u.state === "banned" ? "⛔" : "🟠";
      lines.push(
        `${tag} #${u.id} ${u.name || "—"}\n   ${u.email || ""}\n   ${u.state} • ${String(u.at).slice(0, 16).replace("T", " ")}`
      );
      keyboard.push([
        { text: `🔓 Unlock #${u.id}`, callback_data: `ub:${u.id}` },
        { text: `⛔ Ban #${u.id}`, callback_data: `bb:${u.id}` },
      ]);
    });
    keyboard.push([{ text: "🔄 Refresh", callback_data: "banlist:refresh" }]);
    const payload = {
      chat_id: chatId,
      text: lines.join("\n"),
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: keyboard },
    };
    let r = await telegramApi("sendMessage", payload);
    if (r && !r.ok && String(r.description || "").includes("parse")) {
      delete payload.parse_mode;
      payload.text = payload.text.replace(/[*`]/g, "");
      await telegramApi("sendMessage", payload);
    }
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

  // Start /announce — broadcast popup to all users
  if (lower === "/announce") {
    tgConversations.set(String(chatId), {
      step: "ann_type",
      data: {},
      expires: Date.now() + 10 * 60 * 1000,
    });
    await tgReply(
      chatId,
      "📢 New Announcement\n\nType bhejo:\n1 = 🎮 New Game\n2 = ⚡ Server Update\n3 = 📢 Other\n\n(or /cancel)"
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
        `✅ Name: ${name}\n\nStep 2/3 — Send IMAGE (photo directly ya https URL)`
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
      // Auto-broadcast: app popup + Telegram group post
      const annAuto = {
        id: Date.now(),
        image_url: conv.data.image_url,
        title: conv.data.name,
        details: "New game added — play now!\n🔗 " + conv.data.link_url,
        ts: Date.now(),
      };
      saveAnnouncement(annAuto);
      const capG =
        "🎮 *NEW GAME ADDED*\n\n🏷 NAME: " +
        conv.data.name +
        "\n🔗 LINK: " +
        conv.data.link_url +
        "\n🕒 TIME: " +
        istTimeStr() +
        "\n\n🐉 DRAGO Predictor";
      let gr = await telegramApi(
        "sendPhoto",
        { chat_id: TELEGRAM_REPORT_GROUP_ID, photo: conv.data.image_url, caption: capG, parse_mode: "Markdown" },
        TELEGRAM_GROUP_BOT_TOKEN
      );
      if (!gr || !gr.ok)
        gr = await telegramApi(
          "sendPhoto",
          { chat_id: TELEGRAM_REPORT_GROUP_ID, photo: conv.data.image_url, caption: capG.replace(/[*_`]/g, "") },
          TELEGRAM_GROUP_BOT_TOKEN
        );
      if (!gr || !gr.ok)
        gr = await telegramApi("sendPhoto", {
          chat_id: TELEGRAM_REPORT_GROUP_ID,
          photo: conv.data.image_url,
          caption: capG.replace(/[*_`]/g, ""),
        });
      await tgReply(
        chatId,
        `✅ Game added!\n\n#${info.lastInsertRowid}\nName: ${conv.data.name}\nImage: ${conv.data.image_url}\nLink: ${conv.data.link_url}\n\n📢 Auto-broadcast: app popup (all users, once) + Telegram group post ho gaya.`
      );
      return;
    }
    if (conv.step === "ann_type") {
      const t = lower.trim();
      let type = "other";
      if (t === "1" || t.indexOf("game") !== -1) type = "game";
      else if (t === "2" || t.indexOf("update") !== -1 || t.indexOf("server") !== -1) type = "update";
      conv.data.type = type;
      conv.step = "ann_image";
      conv.expires = Date.now() + 10 * 60 * 1000;
      await tgReply(
        chatId,
        "✅ Type: " +
          (type === "game" ? "🎮 New Game" : type === "update" ? "⚡ Server Update" : "📢 Other") +
          "\n\nStep 1/3 — Send the IMAGE (photo ya https URL)"
      );
      return;
    }
    if (conv.step === "ann_image") {
      if (!looksLikeUrl(text)) {
        await tgReply(chatId, "Invalid URL — send the image again (photo ya full https URL):");
        return;
      }
      conv.data.image_url = text.trim();
      conv.step = "ann_title";
      conv.expires = Date.now() + 10 * 60 * 1000;
      await tgReply(chatId, "✅ Image saved\n\nStep 2/3 — Send the TITLE (game / feature name)");
      return;
    }
    if (conv.step === "ann_title") {
      const ttl = text.slice(0, 80).trim();
      if (ttl.length < 2) {
        await tgReply(chatId, "Title too short — send again:");
        return;
      }
      conv.data.title = ttl;
      conv.step = "ann_details";
      conv.expires = Date.now() + 10 * 60 * 1000;
      await tgReply(chatId, "✅ Title: " + ttl + "\n\nStep 3/3 — Send the DETAILS text");
      return;
    }
    if (conv.step === "ann_details") {
      conv.data.details = text.slice(0, 600).trim();
      conv.step = "ann_confirm";
      conv.expires = Date.now() + 10 * 60 * 1000;
      await tgReply(
        chatId,
        "📢 Preview\n\n🖼 " +
          conv.data.image_url +
          "\n🏷 " +
          conv.data.title +
          "\n📝 " +
          conv.data.details +
          "\n\nType YES to broadcast to ALL users, NO to cancel."
      );
      return;
    }
    if (conv.step === "ann_confirm") {
      if (lower === "yes" || lower === "y") {
        const ann = {
          id: Date.now(),
          image_url: conv.data.image_url,
          title: conv.data.title,
          details: conv.data.details,
          ts: Date.now(),
        };
        saveAnnouncement(ann);
        tgConversations.delete(String(chatId));
        const hdr =
          conv.data.type === "game"
            ? "🎮 *NEW GAME ADDED*"
            : conv.data.type === "update"
              ? "⚡ *SERVER UPDATE*"
              : "📢 *NEW UPDATE*";
        const caption =
          hdr + "\n\n🏷 NAME: " +
          ann.title +
          "\n📝 " +
          ann.details +
          "\n🕒 TIME: " +
          istTimeStr() +
          "\n\n🐉 DRAGO Predictor";
        const pay = {
          chat_id: TELEGRAM_REPORT_GROUP_ID,
          photo: ann.image_url,
          caption,
          parse_mode: "Markdown",
        };
        let r = await telegramApi("sendPhoto", pay, TELEGRAM_GROUP_BOT_TOKEN);
        if (!r || !r.ok) r = await telegramApi("sendPhoto", pay);
        if (!r || !r.ok) {
          const plain = {
            chat_id: TELEGRAM_REPORT_GROUP_ID,
            photo: ann.image_url,
            caption: caption.replace(/[*_`]/g, ""),
          };
          r = await telegramApi("sendPhoto", plain, TELEGRAM_GROUP_BOT_TOKEN);
          if (!r || !r.ok) r = await telegramApi("sendPhoto", plain);
        }
        await tgReply(
          chatId,
          "✅ Broadcast LIVE! All users will see the popup once. Telegram group me bhi post ho gaya."
        );
        return;
      }
      if (lower === "no" || lower === "n") {
        tgConversations.delete(String(chatId));
        await tgReply(chatId, "Cancelled.");
        return;
      }
      await tgReply(chatId, "Type YES to broadcast, NO to cancel.");
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

function escRe(t) {
  return String(t).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function userDocMenuPayload(uid) {
  const u = await dbFindUserById(uid);
  if (!u) return null;
  const ban = await dbIsUserBanned(uid);
  const exp = u.pro_expires_at
    ? new Date(u.pro_expires_at).toLocaleDateString("en-IN", {
        day: "numeric", month: "short", year: "numeric",
      })
    : "—";
  const planName =
    u.pro_plan && PLAN_CATALOG[u.pro_plan] ? PLAN_CATALOG[u.pro_plan].name : u.pro_plan;
  const text =
    "👤 " + (u.name || u.email || "User") + "  ·  #" + u.id + "\n" +
    "📧 " + (u.email || "—") + "\n" +
    "📦 Plan: " + (u.is_pro ? planName || "PRO" : "FREE") + "\n" +
    (u.is_pro ? "🟢 Pro ACTIVE till " + exp : "⚪ Pro nahi hai") + "\n" +
    (ban.banned ? "⛔ BANNED" : "✅ Not banned");
  const keyboard = [
    [
      { text: "⚡ Weekly ₹749 · 7d", callback_data: "up:" + u.id + ":weekly" },
      { text: "👑 Monthly ₹1498 · 30d", callback_data: "up:" + u.id + ":monthly" },
    ],
    [{ text: "❌ Pro band karo", callback_data: "up:" + u.id + ":none" }],
    [
      ban.banned
        ? { text: "🔓 UNBAN user", callback_data: "ub:" + u.id }
        : { text: "⛔ BAN user", callback_data: "bb:" + u.id },
    ],
    [
      { text: "← Users", callback_data: "users:list" },
      { text: "⭐ Pro list", callback_data: "users:pro" },
    ],
  ];
  return { text, keyboard };
}

function adminPanelText() {
  const s = adminSettings;
  const on = (v) => (v ? "✅ ON" : "❌ OFF");
  return (
    "🐉 DRAGO Admin Panel\n\n" +
    "Google Auth: " + on(s.google_auth_enabled) + "\n" +
    "Auto Payment (Rupayex): " + on(s.auto_payment_enabled) + "\n" +
    "Manual QR Payment: " + on(s.manual_payment_enabled) + "\n" +
    "DevTools Guard: " + on(s.guard_enabled) + "\n" +
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
  let totalUsers = 0,
    proUsers = 0,
    todayUsers = 0;
  try {
    totalUsers = await col.users.countDocuments({});
    proUsers = await col.users.countDocuments({ is_pro: 1 });
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    todayUsers = await col.users.countDocuments({
      created_at: { $gte: dayStart.toISOString() },
    });
  } catch (e) {}
  const stats =
    "📊 Total users: " +
    totalUsers +
    " | Pro: " +
    proUsers +
    " | Aaj naye: " +
    todayUsers +
    "\n\n";
  await telegramApi("sendMessage", {
    chat_id: chatId,
    text: "🐉 DRAGO Admin Panel\n\n" + stats + adminPanelText().replace("🐉 DRAGO Admin Panel\n\n", ""),
    reply_markup: {
      inline_keyboard: [
        [
          {
            text:
              "📊 Users: " +
              totalUsers +
              " | Pro: " +
              proUsers +
              " | +Aaj: " +
              todayUsers,
            callback_data: "stats:refresh",
          },
        ],
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
        [
          {
            text: s.guard_enabled
              ? "🔴 Disable DevTools Guard"
              : "🟢 Enable DevTools Guard",
            callback_data: "cfg:guard",
          },
        ],
        [
          {
            text: s.force_feedback ? "🐞 Bug in app: ON" : "🐞 Bug in app: OFF",
            callback_data: "cfg:feedback",
          },
        ],
        [
          {
            text: s.force_rate ? "⭐ Rate in app: ON" : "⭐ Rate in app: OFF",
            callback_data: "cfg:rate",
          },
        ],
        [
          {
            text: s.force_winfb ? "🏆 Feedback in app: ON" : "🏆 Feedback in app: OFF",
            callback_data: "cfg:winfb",
          },
        ],
        [{ text: "📢 New Announcement", callback_data: "act:announce" }],
        [{ text: "📢 New Announcement", callback_data: "act:announce" }],
        [{ text: "👥 Users Manage", callback_data: "users:list" }],
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
const oauthStates = new Map(); // state → { exp, ref }
const STATE_TTL_MS = 10 * 60 * 1000;

function sanitizeReturnTo(u) {
  try {
    const parsed = new URL(String(u || ""));
    const origin = parsed.origin;
    const h = parsed.hostname.toLowerCase();
    if (
      origin === FRONTEND_URL ||
      origin === "https://dragopredictor.vercel.app" ||
      h === ALLOWED_WEB_DOMAIN ||
      h === "localhost" ||
      h === "127.0.0.1"
    ) {
      return origin;
    }
  } catch (_) {}
  return null;
}
function saveState(state, ref, returnTo) {
  oauthStates.set(state, { exp: Date.now() + STATE_TTL_MS, ref: ref || null, returnTo: returnTo || null });
  // Cleanup stale
  if (oauthStates.size > 500) {
    const now = Date.now();
    for (const [k, v] of oauthStates) {
      if (v.exp < now) oauthStates.delete(k);
    }
  }
}

function consumeState(state) {
  if (!state) return { ok: false, ref: null };
  const v = oauthStates.get(state);
  oauthStates.delete(state);
  if (!v || v.exp < Date.now()) return { ok: false, ref: null, returnTo: null };
  return { ok: true, ref: v.ref || null, returnTo: v.returnTo || null };
}
function sanitizeRef(r) {
  return String(r || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 12) || null;
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

const revokedTokenJtis = new Map(); // jti -> expiresAtMs

function signToken(user) {
  const jti = crypto.randomBytes(12).toString("hex");
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      name: user.name,
      tv: Number(user.token_version) || 0,
      jti,
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

function decodeToken(token) {
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded && decoded.jti && revokedTokenJtis.has(decoded.jti)) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

function bearerToken(req) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith("Bearer ")) return null;
  return h.slice(7).trim() || null;
}

async function upsertUser(payload, refCode) {
  const googleId = payload.sub;
  const email = payload.email || "";
  const name = payload.name || "";
  const picture = payload.picture || "";

  let user = await dbFindUserByGoogle(googleId);
  if (!user) {
    // Referral: valid code ho to referrer ko credit (server-side, self-referral impossible)
    let referredBy = null;
    if (refCode) {
      const referrer = await col.users.findOne({ ref_code: refCode });
      if (referrer) referredBy = refCode;
    }
    user = await dbInsertUser(googleId, email, name, picture, referredBy);
    console.log("🆕 user:", email);
    if (referredBy) bumpReferrer(referredBy);
    // 🎉 new user alert → Telegram group
    groupNotify(
      "🎉 *NEW USER REGISTERED*\n\n" +
        "👤 Name: " + (name || "User") + "\n" +
        "🆔 ID: #" + user.id + "\n" +
        (referredBy ? "🔗 Referred by: " + referredBy + "\n" : "") +
        "🕒 Time: " + istTimeStr(),
      true
    );
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

// Nonce replay protection store (BE-13)
const usedNonces = new Map(); // nonce -> timestamp
const NONCE_TTL_MS = 5 * 60 * 1000;

function checkAndRecordNonce(nonce) {
  if (!nonce) return true;
  const now = Date.now();
  const prev = usedNonces.get(nonce);
  if (prev && now - prev < NONCE_TTL_MS) {
    return false;
  }
  usedNonces.set(nonce, now);
  if (usedNonces.size > 10000) {
    for (const [k, ts] of usedNonces) {
      if (now - ts >= NONCE_TTL_MS) usedNonces.delete(k);
    }
  }
  return true;
}

/** Frontend routes: strict origin check + optional nonce replay protection (BE-3, BE-6, BE-13) */
function requireAppSignature(mode) {
  return function appSigMiddleware(req, res, next) {
    if (req.path.startsWith("/v1") || String(req.originalUrl || "").startsWith("/v1")) {
      return next();
    }

    const origin = req.get("origin") || "";
    const domain = clientDomain(req);

    // Exact origin allow-list (BE-6: no wildcard *.vercel.app)
    if (origin) {
      try {
        const host = new URL(origin).hostname.toLowerCase();
        if (!isAllowedWebDomain(host)) {
          return res.status(403).json({ success: false, message: "Origin not allowed" });
        }
      } catch (_) {
        return res.status(403).json({ success: false, message: "Origin not allowed" });
      }
    } else if (domain && !isAllowedWebDomain(domain)) {
      return res.status(403).json({ success: false, message: "Domain not allowed" });
    }

    const ts = String(req.get("x-timestamp") || "").trim();
    const nonce = String(req.get("x-nonce") || "").trim();
    if (mode === "payment" && nonce) {
      if (!checkAndRecordNonce(nonce)) {
        return res.status(409).json({ success: false, message: "Duplicate request nonce" });
      }
    }

    req.dragoMeta = { domain, ts, nonce };
    next();
  };
}

// ─── App ────────────────────────────────────────────────────────────────────
const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");

// Security headers & Request-ID middleware (BE-16)
app.use((req, res, next) => {
  const reqId = crypto.randomBytes(8).toString("hex");
  req.reqId = reqId;
  res.setHeader("X-Request-Id", reqId);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  res.setHeader("X-Permitted-Cross-Domain-Policies", "none");
  res.setHeader(
    "Strict-Transport-Security",
    "max-age=63072000; includeSubDomains; preload"
  );
  next();
});

/* ═══ SECURITY HARDENING ═══
   - imgbb key sirf server-side (FE se hataya)
   - bounded rate limiter without global reset bug (BE-8)
   - image validation: magic bytes + 4MB cap (BE-18) */
const RL = new Map();
function rateLimitUser(key, max, windowMs) {
  const now = Date.now();
  let rec = RL.get(key);
  if (!rec || now - rec.t > windowMs) {
    rec = { t: now, n: 0, w: windowMs };
  }
  rec.n++;
  RL.set(key, rec);
  if (RL.size > 10000) {
    for (const [k, v] of RL) {
      if (now - v.t > (v.w || windowMs)) RL.delete(k);
      if (RL.size <= 8000) break;
    }
    if (RL.size > 10000) {
      const oldestKey = RL.keys().next().value;
      if (oldestKey) RL.delete(oldestKey);
    }
  }
  return rec.n <= max;
}

// Global per-IP rate limit (BE-8)
app.use((req, res, next) => {
  const ip = String(req.ip || req.socket?.remoteAddress || "unknown");
  if (!rateLimitUser("ip:" + ip, 240, 60000)) {
    return res.status(429).json({ success: false, message: "Too many requests. Please slow down." });
  }
  next();
});

// Standalone Admin Panel (file:// -> Origin: null / koi origin nahi) aur allow-listed
// app origins ke liye CORS. ⚠️ 2026-10-05 security fix: pehle yahan blanket
// `Access-Control-Allow-Origin: *` tha, jisse koi bhi random website (evil.com)
// /app-config (plans/banners/upi_id) padh sakti thi. Ab sirf:
//   • no-origin / "null" (file:// admin panel, curl, non-browser clients) → "*"
//   • allow-listed origins (hamara frontend) → origin echo + Vary: Origin
//   • baaki sab → koi CORS header nahi (browser request block kar deta hai)
app.use(["/admin", "/app-config", "/uploads", "/upload-image", "/push"], (req, res, next) => {
  const origin = req.get("origin");
  let allow = null;
  if (!origin || origin === "null") {
    allow = "*";
  } else if (isCorsOriginAllowed(origin)) {
    allow = origin;
    res.setHeader("Vary", "Origin");
  }
  if (allow) {
    res.setHeader("Access-Control-Allow-Origin", allow);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, X-Admin-Key, x-admin-key, Accept, Origin, X-Timestamp, X-Signature, X-Nonce, X-Client-Domain, X-Shield"
    );
  }
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  next();
});

app.get("/uploads/:filename", async (req, res) => {
  try {
    const entry = await getStoredImageById(req.params.filename);
    if (!entry || !entry.buf) {
      return res.status(404).send("Image not found");
    }
    res.setHeader("Content-Type", entry.mime || "image/jpeg");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    return res.send(entry.buf);
  } catch (e) {
    return res.status(500).send("Error loading image");
  }
});

app.use("/upload-image", express.json({ limit: "8mb" }));
app.post("/upload-image", async (req, res) => {
  const decoded = authUser(req, res);
  if (!decoded) return;
  if (!rateLimitUser("up:" + decoded.id, 25, 3600000))
    return res.status(429).json({ success: false, message: "Too many uploads. Try later." });
  const b64 = String((req.body && req.body.image) || "");
  const m = b64.match(/^data:image\/(png|jpe?g|webp|gif);base64,(.+)$/i);
  if (!m) return res.status(400).json({ success: false, message: "Only PNG/JPG/WEBP/GIF allowed." });
  const buf = Buffer.from(m[2], "base64");
  if (buf.length > 6 * 1024 * 1024)
    return res.status(413).json({ success: false, message: "Image too large (max 6MB)." });
  if (!hasValidImageMagicBytes(buf)) {
    return res.status(400).json({ success: false, message: "Invalid image file contents." });
  }
  try {
    const url = await storeUploadedImage(buf, "image/" + m[1].toLowerCase(), req);
    return res.json({ success: true, url });
  } catch (e) {
    return res.status(502).json({ success: false, message: "Upload failed." });
  }
});

app.use("/admin", express.json({ limit: "8mb" }));
app.use(express.json({ limit: "256kb" }));

const allowedOrigins = [
  FRONTEND_URL,
  "https://dragopredictor.vercel.app",
  "http://localhost:3000",
  "http://localhost:5173",
  "http://127.0.0.1:3000",
].filter(Boolean);

// Ek hi jagah origin policy (CORS + app-origin gate dono isi ko use karte hain)
function isCorsOriginAllowed(origin) {
  try {
    if (allowedOrigins.includes(origin)) return true;
    const host = new URL(origin).hostname.toLowerCase();
    return host === ALLOWED_WEB_DOMAIN || host === "localhost" || host === "127.0.0.1";
  } catch (_) {}
  return false;
}

// Block unknown browser origins on app routes (not /v1, /admin, /app-config, /uploads) — strict allow-list (BE-6)
app.use((req, res, next) => {
  const p = String(req.originalUrl || req.path || "");
  if (
    p.startsWith("/v1") ||
    p.startsWith("/admin") ||
    p.startsWith("/app-config") ||
    p.startsWith("/uploads") ||
    p.startsWith("/push")
  ) {
    return next();
  }
  const origin = req.get("origin");
  if (!origin) return next();
  try {
    const host = new URL(origin).hostname.toLowerCase();
    if (
      allowedOrigins.includes(origin) ||
      host === ALLOWED_WEB_DOMAIN ||
      host === "localhost" ||
      host === "127.0.0.1"
    ) {
      return next();
    }
  } catch (_) {}
  return res.status(403).json({ success: false, message: "Origin not allowed" });
});

app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      try {
        const host = new URL(origin).hostname.toLowerCase();
        if (host === ALLOWED_WEB_DOMAIN || host === "localhost" || host === "127.0.0.1") {
          return cb(null, true);
        }
      } catch (_) {}
      return cb(null, false);
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
      "X-ABP-Ts",
      "X-ABP-Sig",
      "x-abp-ts",
      "x-abp-sig",
      "X-Shield",
      "x-shield",
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

// Developer API (/v1): CORS * intentional — keep for public developer access
app.use("/v1", (req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, OPTIONS"
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-API-Key, x-api-key, Accept, Origin, X-ABP-Ts, X-ABP-Sig, x-abp-ts, x-abp-sig"
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
app.options("*", cors());

// Signature gates (domain + nonce). /v1 skipped inside middleware.
const sigAuth = requireAppSignature("auth");
const sigPay = requireAppSignature("payment");
const sigPublic = requireAppSignature("public-app");

async function rejectIfBanned(req, res, next) {
  try {
    const token = bearerToken(req);
    if (!token) return next();
    const decoded = decodeToken(token);
    if (!decoded || !decoded.id) return next();
    if (col.users) {
      const u = await col.users.findOne(
        { id: Number(decoded.id) },
        { projection: { token_version: 1, banned: 1, ban_state: 1, ban_reason: 1 } }
      );
      if (u && Number(u.token_version || 0) > Number(decoded.tv || 0)) {
        return res.status(401).json({
          success: false,
          message: "Session invalidated. Please sign in again.",
        });
      }
    }
    const ban = await dbIsUserBanned(decoded.id);
    if (ban.banned) {
      return res.status(403).json({
        success: false,
        banned: true,
        message: "Account suspended due to security policy violation.",
        reason: ban.reason || "policy",
      });
    }
  } catch (e) {
    console.warn("rejectIfBanned:", e.message);
  }
  next();
}
app.use(["/verify", "/profile", "/prediction-quota", "/wingo30s_prediction", "/payment-history", "/payment-config", "/create-payment", "/manual-payment", "/order-status", "/api-keys", "/api-usage", "/system-status", "/games"], rejectIfBanned);

// Auth-bound app APIs
app.use(["/verify", "/profile", "/prediction-quota", "/wingo30s_prediction", "/payment-history", "/api-keys", "/api-usage", "/system-status", "/games"], sigAuth);
app.use("/api-keys", sigAuth);

/* ── Shield telemetry (BE-4: non-blocking signal; real auth relies on JWT + server entitlements) ── */
const SHIELD_SALT = "DRAGO_SHIELD_V2_8kq2";
function shieldDjb2(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
function shieldCheck(req, _res, next) {
  const s = String(req.get("x-shield") || "");
  const b = Math.floor(Date.now() / 30000);
  req.shieldValid =
    s === shieldDjb2(SHIELD_SALT + "|" + b) ||
    s === shieldDjb2(SHIELD_SALT + "|" + (b - 1));
  next();
}
app.use(["/wingo30s_prediction", "/prediction-quota"], shieldCheck);
// Market data (no JWT) — frontend prediction page ka live chart yahin se leta hai
// (browser ko lottery API se direct CORS/Cloudflare 403 milta hai, isliye proxy)
app.use("/market", sigPublic);
app.use("/payment-config", sigPay);
app.use("/create-payment", sigPay);
app.use("/manual-payment", sigPay);
app.use("/payment-appeal", sigPay);
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
  const ip = String(req.ip || req.socket?.remoteAddress || "unknown");
  if (!rateLimitUser("auth_ip:" + ip, 25, 60000)) {
    return res.status(429).json({ success: false, message: "Too many login attempts. Please wait." });
  }
  if (!adminSettings.google_auth_enabled) {
    return res.status(403).json({
      success: false,
      message: "Google login is currently disabled by admin",
    });
  }
  const redirectUri = `${publicBase(req)}/auth/google/callback`;
  const state = crypto.randomBytes(24).toString("hex");
  saveState(state, sanitizeRef(req.query.ref), sanitizeReturnTo(req.query.return_to));

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
  const ip = String(req.ip || req.socket?.remoteAddress || "unknown");
  if (!rateLimitUser("auth_cb:" + ip, 30, 60000)) {
    return res.status(429).send("Too many requests");
  }
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

    const st = consumeState(state);
    const stateOk = st.ok || (state && cookieState && state === cookieState);

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

    const user = await upsertUser(payload, st.ref);
    const token = signToken(user);

    // Hash fragment — server logs / referrer mein nahi jata
    res.redirect(`${st.returnTo || FRONTEND_URL}/#token=${encodeURIComponent(token)}`);
  } catch (err) {
    fail(err.message || "unknown");
  }
});

/** Session revocation & logout endpoints (BE-10, PR-6) */
app.post("/auth/logout", (req, res) => {
  const token = bearerToken(req);
  const decoded = token ? decodeToken(token) : null;
  if (decoded && decoded.jti) {
    revokedTokenJtis.set(decoded.jti, Date.now());
  }
  res.json({ success: true });
});

app.post("/auth/logout-all", async (req, res) => {
  const decoded = authUser(req, res);
  if (!decoded) return;
  if (decoded.jti) revokedTokenJtis.set(decoded.jti, Date.now());
  try {
    await col.users.updateOne(
      { id: Number(decoded.id) },
      { $inc: { token_version: 1 } }
    );
    res.json({ success: true, message: "All sessions invalidated." });
  } catch (e) {
    res.status(500).json({ success: false, message: "Failed to revoke sessions." });
  }
});

/** Ban account (e.g. client security report) — JWT required (BE-5, AUDIT-8: no unauthenticated arbitrary device bans) */
app.post("/security/devtools-ban", async (req, res) => {
  const ip = String(req.ip || req.socket?.remoteAddress || "unknown");
  if (!rateLimitUser("sec_ban:" + ip, 10, 3600000)) {
    return res.status(429).json({ success: false, message: "Too many security reports." });
  }
  const reason = String((req.body && req.body.reason) || "devtools").slice(0, 120);
  const rawDevice = String((req.body && req.body.device) || "").trim();
  const device = /^[a-zA-Z0-9_-]{6,64}$/.test(rawDevice) ? rawDevice : "";
  const token = bearerToken(req);
  const decoded = token ? decodeToken(token) : null;
  try {
    // Only authenticated users can trigger an account/device block for their own session (BE-5)
    if (!decoded || !decoded.id) {
      return res.status(401).json({ success: false, message: "Authentication required" });
    }
    const prev = await dbIsUserBanned(decoded.id);
    if (prev.banned && prev.state === "banned") {
      return res.json({ success: true, banned: true, state: "banned" });
    }
    const ok = await dbBlockUser(decoded.id, reason, device);
    console.warn("🚫 BLOCK user=", decoded.id, "reason=", reason, "device=", device || "-");
    const user = await dbFindUserByIdLite(decoded.id);
    await notifyAdminDevtoolsBan({ user, userId: decoded.id, reason, device });
    return res.json({ success: true, banned: true, state: "blocked", applied: !!ok });
  } catch (e) {
    console.error("devtools-ban:", e.message);
    return res.status(500).json({ success: false, message: "Ban failed" });
  }
});

/** Ban status — frontend early check (device + optional JWT) */
app.get("/security/ban-status", async (req, res) => {
  // 🔒 Rate limit (2026-10-05): pehle is endpoint pe koi visible limit nahi thi —
  // device IDs enumerate/brute-force kiye ja sakte the. Ab per-IP + per-device
  // dono limits hain. Limit ka jawab fail-open hai (frontend "ok" maan leta hai)
  // taaki normal users kabhi na atken.
  const rlIp = String(req.ip || req.socket?.remoteAddress || "unknown");
  if (!rateLimitUser("ban_stat_ip:" + rlIp, 100, 60000)) {
    res.setHeader("Retry-After", "30");
    return res.status(429).json({ success: false, message: "Too many ban checks. Please slow down." });
  }
  const rlDev = String(req.query.device || "").slice(0, 64);
  if (rlDev && !rateLimitUser("ban_stat_dev:" + rlDev, 30, 60000)) {
    res.setHeader("Retry-After", "30");
    return res.status(429).json({ success: false, message: "Too many ban checks for this device." });
  }
  let state = "ok";
  try {
    const device = String(req.query.device || "").slice(0, 64);
    const byDev = await dbBanStateByDevice(device);
    if (byDev) state = byDev;
    if (state !== "banned") {
      const token = bearerToken(req);
      if (token) {
        const decoded = decodeToken(token);
        if (decoded && decoded.id) {
          const b = await dbIsUserBanned(decoded.id);
          if (b.banned) state = b.state;
        }
      }
    }
  } catch (e) {
    state = "ok"; // fail-open
  }
  res.json({ success: true, state });
});

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
  const userDocApiUsed = await dbGetFreeApiUsed(user.id);
  const apiHistoryUsed = Math.max(userDocApiUsed, Number(apiTotal.history) || 0);
  const nexusUsed = await dbGetFreeNexusUsed(user.id);
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
      free_active: isFreeActive(user) ? 1 : 0,
      tg_id: user.tg_id || null,
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
      api_history_used: apiHistoryUsed,
      api_history_limit: isPro ? null : freeApiHistoryLimit(),
      api_history_remaining: isPro
        ? null
        : Math.max(0, freeApiHistoryLimit() - apiHistoryUsed),
      free_nexus_used: isPro ? 0 : nexusUsed,
      free_nexus_limit: freeNexusLimit(),
      free_nexus_remaining: isPro
        ? null
        : Math.max(0, freeNexusLimit() - nexusUsed),
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
    upi_id: getActiveUpiId(),
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
  if (!rateLimitUser("pred:" + decoded.id, 30, 60000)) {
    return res.status(429).json({ success: false, message: "Too many prediction requests. Please wait." });
  }

  const user = await dbFindUserById(decoded.id);
  if (!user) {
    return res.status(404).json({ success: false, message: "User not found" });
  }

  const isPro = userIsPro(user);
  const freeUsed = await dbGetFreePredUsed(decoded.id);
  // Free users always consume 1 of their 3 lifetime predictions per reveal
  const wantConsume = !isPro || String(req.query.consume || "") === "1";

  if (!isPro) {
    if (!isFreeActive(user)) {
      return res.status(403).json({
        success: false,
        verification_required: true,
        message: "Verify your Telegram account on Dashboard to unlock your 3 Free Predictions.",
      });
    }
    if (freeUsed >= freePredLimit()) {
      return res.status(402).json({
        success: false,
        message:
          "Free prediction limit (3/3) complete ho gaya hai. Unlimited predictions ke liye Pro Plan me upgrade karein.",
        billing_required: true,
        plan: "free",
        free_pred_used: freeUsed,
        free_pred_limit: freePredLimit(),
        free_pred_remaining: 0,
      });
    }
    try {
      await dbBumpFreePred(decoded.id);
    } catch (e) {
      console.error("free_pred bump:", e.message);
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
      headers: vpsHeaders(),
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

    // Fresh result ko cache rakho — upstream fail ho to stale fallback
    predCache = {
      at: Date.now(),
      prediction: clean,
      fetched_at: new Date().toISOString(),
    };

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
    // VPS down hai par 15 min se purana NAHI wala cached prediction de do —
    // user ko "STALE" flag ke saath pichli prediction dikhe, blank na ho.
    if (
      predCache.prediction &&
      Date.now() - predCache.at < 15 * 60 * 1000
    ) {
      return res.json({
        success: true,
        stale: true,
        stale_reason: "source offline — last known prediction served",
        prediction: predCache.prediction,
        plan: isPro ? "pro" : "free",
        free_pred_used: isPro ? 0 : freeUsed,
        free_pred_limit: freePredLimit(),
        free_pred_remaining: isPro
          ? null
          : Math.max(0, freePredLimit() - freeUsed),
      });
    }
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
  const nexusUsed = await dbGetFreeNexusUsed(decoded.id);
  res.json({
    success: true,
    plan: isPro ? "pro" : "free",
    is_pro: isPro,
    free_active: isFreeActive(user) ? 1 : 0,
    free_pred_used: isPro ? 0 : freeUsed,
    free_pred_limit: freePredLimit(),
    free_pred_remaining: isPro
      ? null
      : Math.max(0, freePredLimit() - freeUsed),
    free_nexus_used: isPro ? 0 : nexusUsed,
    free_nexus_limit: freeNexusLimit(),
    free_nexus_remaining: isPro
      ? null
      : Math.max(0, freeNexusLimit() - nexusUsed),
  });
});

/** NEXUS Agent quota check & lifetime 3-use consumer for free users */
app.all("/nexus-quota", async (req, res) => {
  const decoded = authUser(req, res);
  if (!decoded) return;
  const user = await dbFindUserById(decoded.id);
  if (!user) {
    return res.status(404).json({ success: false, message: "User not found" });
  }
  const isPro = userIsPro(user);
  const nexusUsed = await dbGetFreeNexusUsed(decoded.id);
  const limit = freeNexusLimit();
  const wantConsume =
    req.method === "POST" || String(req.query.consume || "") === "1";

  if (!isPro) {
    if (nexusUsed >= limit) {
      return res.status(402).json({
        success: false,
        billing_required: true,
        plan: "free",
        is_pro: false,
        free_nexus_used: nexusUsed,
        free_nexus_limit: limit,
        free_nexus_remaining: 0,
        message:
          "Free NEXUS Agent limit reached (3/3). Upgrade to Pro Plan for unlimited NEXUS Agent access.",
      });
    }
    if (wantConsume) {
      try {
        await dbBumpFreeNexus(decoded.id);
      } catch (e) {
        console.error("free_nexus bump:", e.message);
      }
    }
  }

  const newUsed = isPro ? 0 : wantConsume ? nexusUsed + 1 : nexusUsed;
  res.json({
    success: true,
    plan: isPro ? "pro" : "free",
    is_pro: isPro,
    free_active: isFreeActive(user) ? 1 : 0,
    free_nexus_used: newUsed,
    free_nexus_limit: limit,
    free_nexus_remaining: isPro ? null : Math.max(0, limit - newUsed),
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
app.post("/manual-payment/start", (req, res) => {
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

  // Orihost VPS — prediction + history (no local store on Render)
  try {
    const predPing = await pingVps("prediction");
    push(
      "wingo_prediction",
      "Prediction Source (VPS)",
      predPing.ok,
      predPing.detail,
      predPing.ok ? 100 : 0,
      { latency_ms: predPing.latency_ms, url: "" }
    );
  } catch (_) {
    push("wingo_prediction", "Prediction Source (VPS)", false, "Error", 0, {
      url: "",
    });
  }
  try {
    const histPing = await pingVps("history");
    push(
      "wingo_history",
      "History Source (VPS)",
      histPing.ok,
      histPing.detail,
      histPing.ok ? 100 : 0,
      { latency_ms: histPing.latency_ms, url: "" }
    );
  } catch (_) {
    push("wingo_history", "History Source (VPS)", false, "Error", 0, {
      url: "",
    });
  }

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

/* ─── Market data proxy (NO JWT) ─────────────────────────────────────────
 * Browser ko lottery API (draw.ar-lottery01.com) se direct CORS + Cloudflare
 * 403 milta hai, isliye frontend ka live market chart RENDER se proxy maangta hai.
 * GET /market/wingo30s/history?limit=30   →  { success, items, updated_at }
 * 10-sec in-memory cache se VPS pe load nahi padta (2s poll hone par bhi). */
const MARKET_CACHE_TTL_MS = 2 * 1000; // chart boundary pe turant fresh
let marketCache = { at: 0, items: [], updated_at: "" };

app.get("/market/wingo30s/history", async (req, res) => {
  let limit = Number.parseInt(String(req.query.limit ?? "30"), 10);
  if (!Number.isFinite(limit) || limit < 1) limit = 30;
  limit = Math.min(WINGO_HISTORY_MAX, limit);

  const now = Date.now();
  if (
    marketCache.at &&
    now - marketCache.at < MARKET_CACHE_TTL_MS &&
    marketCache.items.length
  ) {
    return res.json({
      success: true,
      count: Math.min(limit, marketCache.items.length),
      limit,
      Server: SERVER_BRAND,
      updated_at: marketCache.updated_at,
      cached: true,
      items: marketCache.items.slice(0, limit),
    });
  }

  try {
    const { items, updated_at } = await fetchWingoHistoryFromVps(
      Math.max(limit, 60)
    );
    marketCache = { at: Date.now(), items, updated_at };
    res.json({
      success: true,
      count: Math.min(limit, items.length),
      limit,
      Server: SERVER_BRAND,
      updated_at,
      cached: false,
      items: items.slice(0, limit),
    });
  } catch (err) {
    // VPS down hai par purana (stale) data dena behtar hai — chart blank na ho
    if (marketCache.items.length) {
      return res.status(200).json({
        success: true,
        stale: true,
        count: Math.min(limit, marketCache.items.length),
        limit,
        Server: SERVER_BRAND,
        updated_at: marketCache.updated_at,
        cached: true,
        items: marketCache.items.slice(0, limit),
      });
    }
    console.error("market history proxy:", err.message);
    res.status(err.status || 502).json({
      success: false,
      Server: SERVER_BRAND,
      message: "Market data source offline",
    });
  }
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
      key_prefix: apiKey.slice(0, 12),
      name,
      endpoints: {
        history: "/v1/wingo30s/history",
        prediction: "/v1/wingo30s/prediction",
      },
      rate_limit: { per_minute: API_RATE_LIMIT },
      usage: {
        header: "X-API-Key: " + apiKey,
      },
      warning: "Copy this key now. It is stored hashed and cannot be shown again.",
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
      key_prefix: r.key_prefix,
      api_key_masked: r.api_key_masked,
      api_key_full: r.key_enc ? decKey(r.key_enc) : null,
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
  const userDocApiUsed = await dbGetFreeApiUsed(decoded.id);
  const historyUsed = Math.max(userDocApiUsed, Number(total.history) || 0);
  const billingRequired =
    !isPro && historyUsed >= freeApiHistoryLimit();

  res.json({
    success: true,
    plan: isPro ? "pro" : "free",
    is_pro: isPro,
    free_active: isFreeActive(user) ? 1 : 0,
    rate_limit: isPro
      ? { per_minute: API_RATE_LIMIT, window_sec: 60 }
      : {
          lifetime_history: freeApiHistoryLimit(),
          history_used: historyUsed,
          history_remaining: Math.max(0, freeApiHistoryLimit() - historyUsed),
        },
    billing_required: billingRequired,
    billing_message: billingRequired
      ? "Free plan limit complete (10/10 Drago API data fetches). Upgrade to Pro Plan for unlimited API access."
      : null,
    today,
    total,
    keys,
  });
});

/**
 * Public history API (API key required)
 * GET /v1/wingo30s/history
 * Auth: X-API-Key header only; query-string credentials are rejected.
 * Query: limit=1..1000  (newest first; default = all stored, max 1000)
 * Rate: 20 / minute / user
 * Example: GET /v1/wingo30s/history?limit=50 with header X-API-Key: <key>
 */
app.get("/v1/wingo30s/history", async (req, res) => {
  const auth = await requireApiKey(req, res, "history");
  if (!auth) return;

  let limit = Number.parseInt(String(req.query.limit ?? ""), 10);
  if (!Number.isFinite(limit) || limit < 1) {
    limit = WINGO_HISTORY_MAX;
  } else {
    limit = Math.min(WINGO_HISTORY_MAX, Math.max(1, limit));
  }

  try {
    const { items, updated_at } = await fetchWingoHistoryFromVps(limit);
    res.json({
      success: true,
      count: items.length,
      limit,
      Server: SERVER_BRAND,
      updated_at,
      items,
    });
  } catch (err) {
    console.error("v1 history proxy:", err.message);
    const status = err.status || 502;
    res.status(status).json({
      success: false,
      Server: SERVER_BRAND,
      message:
        status === 503
          ? "History source not configured"
          : "Failed to fetch history from source",
    });
  }
});

/**
 * Public prediction API (API key required)
 * GET /v1/wingo30s/prediction
 * Auth: X-API-Key header only; query-string credentials are rejected.
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

/** Public: frontend guard reads this to honour Telegram on/off toggle. */
app.get("/guard-status", (req, res) => {
  res.json({ success: true, enabled: adminSettings.guard_enabled !== false });
});

/** Public: feedback popup force mode ("Bug in app" admin toggle) */
app.get("/feedback-status", (req, res) => {
  res.json({
    success: true,
    force: adminSettings.force_feedback === true,
    rate: adminSettings.force_rate === true,
    winfb: adminSettings.force_winfb === true,
  });
});

/** Current announcement (app popup — ek baar per user) */
app.get("/announcement", (req, res) => {
  res.json(announcement ? { success: true, announcement } : { success: true, announcement: null });
});

/** Referral status — code, joined_count, paid_count, rewards_earned, referrals list, link (JWT required) */
app.get("/ref-status", async (req, res) => {
  const decoded = authUser(req, res);
  if (!decoded) return;
  try {
    let u = await col.users.findOne({ id: Number(decoded.id) });
    if (!u) return res.status(404).json({ success: false, message: "user not found" });
    if (!u.ref_code) {
      const c = await genRefCode();
      await col.users.updateOne({ id: u.id }, { $set: { ref_code: c } });
      u.ref_code = c;
    }

    let referredDocs = [];
    try {
      const allUsers = await col.users.find({ referred_by: u.ref_code }).toArray();
      referredDocs = Array.isArray(allUsers) ? allUsers : [];
    } catch (_) {}

    let paidWeekly = 0;
    let paidMonthly = 0;
    const referralsList = referredDocs
      .map((r) => {
        const bought = Boolean(r.ref_plan_purchased || r.is_pro);
        const pType = String(r.ref_plan_type || r.pro_plan || "").toLowerCase();
        const isMon = pType === "monthly" || pType === "profit";
        if (bought) {
          if (isMon) paidMonthly++;
          else paidWeekly++;
        }
        return {
          id: r.id,
          name: r.name || "DRAGO User",
          created_at: r.created_at || null,
          plan_bought: bought,
          plan_type: bought ? (isMon ? "MONTHLY VIP" : "WEEKLY VIP") : "FREE",
        };
      })
      .sort((a, b) => Number(b.plan_bought) - Number(a.plan_bought) || (b.id - a.id));

    const joinedCount = Math.max(Number(u.ref_count) || 0, referredDocs.length);
    const paidCount = Math.max(Number(u.ref_paid_count) || 0, paidWeekly + paidMonthly);
    const rewardedPairs = Number(u.ref_rewarded_pairs) || 0;

    // Auto-unlock if 2+ paid referrals exist and reward hasn't been granted yet
    if (paidCount - rewardedPairs * 2 >= 2) {
      await col.users.updateOne(
        { id: u.id },
        {
          $set: {
            ref_count: joinedCount,
            ref_paid_count: paidCount - 1,
            ref_paid_weekly: Math.max(0, paidWeekly - (paidMonthly >= 2 ? 0 : 1)),
            ref_paid_monthly: Math.max(0, paidMonthly - (paidMonthly >= 2 ? 1 : 0)),
          },
        }
      );
      await creditReferrerOnPaidPlan(
        u.ref_code,
        paidMonthly >= 2 ? "monthly" : "weekly",
        null
      );
      u = (await col.users.findOne({ id: u.id })) || u;
    }

    const finalRewards = Number(u.ref_rewards_earned) || Number(u.ref_rewarded_pairs) || 0;
    const progressCurrent = paidCount % 2;

    res.json({
      success: true,
      code: u.ref_code,
      joined_count: joinedCount,
      count: paidCount,
      paid_count: paidCount,
      paid_weekly_count: Math.max(Number(u.ref_paid_weekly) || 0, paidWeekly),
      paid_monthly_count: Math.max(Number(u.ref_paid_monthly) || 0, paidMonthly),
      progress_current: progressCurrent,
      progress_target: 2,
      rewards_earned: finalRewards,
      rewarded: finalRewards > 0 || !!u.ref_rewarded,
      referred_by: u.referred_by || null,
      weekly_plan_price: (PLAN_CATALOG.weekly && PLAN_CATALOG.weekly.amount) || 749,
      monthly_plan_price: (PLAN_CATALOG.monthly && PLAN_CATALOG.monthly.amount) || 1498,
      link: FRONTEND_URL + "/?ref=" + u.ref_code,
      referrals: referralsList.slice(0, 50),
    });
  } catch (e) {
    res.status(500).json({ success: false, message: "server error" });
  }
});

/** Apply referral code manually (once per user, cannot refer self) */
app.post("/ref-apply", async (req, res) => {
  const decoded = authUser(req, res);
  if (!decoded) return;
  try {
    const rawCode = String((req.body && req.body.code) || "")
      .trim()
      .toLowerCase();
    if (!rawCode) {
      return res.status(400).json({ success: false, message: "Enter a valid referral code." });
    }
    const u = await col.users.findOne({ id: Number(decoded.id) });
    if (!u) return res.status(404).json({ success: false, message: "User not found." });
    if (u.referred_by) {
      return res.status(400).json({ success: false, message: "Referral code already applied on your account." });
    }
    if (String(u.ref_code || "").toLowerCase() === rawCode) {
      return res.status(400).json({ success: false, message: "You cannot apply your own referral code." });
    }
    const referrer = await col.users.findOne({ ref_code: rawCode });
    if (!referrer || Number(referrer.id) === Number(u.id)) {
      return res.status(404).json({ success: false, message: "Invalid referral code." });
    }
    await col.users.updateOne({ id: u.id }, { $set: { referred_by: referrer.ref_code } });
    await bumpReferrer(referrer.ref_code);
    res.json({
      success: true,
      referred_by: referrer.ref_code,
      referrer_name: referrer.name || "Friend",
      message: `Referral code applied! Linked to ${referrer.name || "your friend"}.`,
    });
  } catch (e) {
    res.status(500).json({ success: false, message: "Failed to apply referral code." });
  }
});

/** Rating (stars) → Telegram group */
app.post("/rate-submit", async (req, res) => {
  const decoded = authUser(req, res);
  if (!decoded) return;
  if (!rateLimitUser("rs:" + decoded.id, 5, 3600000)) {
    return res.status(429).json({ success: false, message: "Too many rating submissions. Try later." });
  }
  const stars = Math.max(1, Math.min(5, Number((req.body && req.body.stars) || 0) | 0));
  if (!stars) {
    return res.status(400).json({ success: false, message: "stars required" });
  }
  const name = escTgMd(decoded.name || decoded.email || "User", 80);
  const text =
    `⭐ *App Rating — DRAGO Predictor*\n\n` +
    `👤 User: ${name} (#${escTgMd(decoded.id, 24)})\n` +
    `⭐ Rating: ${"★".repeat(stars)}${"☆".repeat(5 - stars)} (${stars}/5)`;
  const payload = {
    chat_id: TELEGRAM_REPORT_GROUP_ID,
    text,
    parse_mode: "Markdown",
  };
  let r = await telegramApi("sendMessage", payload, TELEGRAM_GROUP_BOT_TOKEN);
  if (!r || !r.ok) r = await telegramApi("sendMessage", payload);
  res.json({ success: true });
});

/** Win feedback (screenshot + wins) → Telegram group */
app.post("/win-feedback", async (req, res) => {
  const decoded = authUser(req, res);
  if (!decoded) return;
  if (!rateLimitUser("wf:" + decoded.id, 5, 3600000))
    return res.status(429).json({ success: false, message: "Too many submissions. Try later." });
  const wins = Math.max(0, Number((req.body && req.body.wins) || 0) | 0);
  const rawImageUrl = String((req.body && req.body.image_url) || "").trim().slice(0, 500);
  const imageUrl = /^https?:\/\/[^\s"'<>]+$/i.test(rawImageUrl) ? rawImageUrl : "";
  const name = escTgMd(decoded.name || decoded.email || "User", 80);
  const caption =
    `🏆 *Win Feedback — DRAGO Predictor*\n\n` +
    `👤 User: ${name} (#${escTgMd(decoded.id, 24)})\n` +
    `🎉 Wins: ${wins}\n` +
    `📝 User ne 20+ wins ke baad feedback bheja hai.`;
  let r = null;
  if (imageUrl) {
    r = await sendTelegramPhotoSmart({
      chatId: TELEGRAM_REPORT_GROUP_ID,
      photoUrl: imageUrl,
      caption,
      parseMode: "Markdown",
      token: TELEGRAM_GROUP_BOT_TOKEN,
    });
    if (!r || !r.ok) {
      r = await sendTelegramPhotoSmart({
        chatId: TELEGRAM_ADMIN_CHAT_ID,
        photoUrl: imageUrl,
        caption,
        parseMode: "Markdown",
        token: TELEGRAM_BOT_TOKEN,
      });
    }
  }
  if (!r || !r.ok) {
    r = await telegramApi(
      "sendMessage",
      { chat_id: TELEGRAM_REPORT_GROUP_ID, text: caption + (imageUrl ? `\n🔗 ${imageUrl}` : ""), parse_mode: "Markdown" },
      TELEGRAM_GROUP_BOT_TOKEN
    );
  }
  res.json({ success: true });
});

/**
 * Check order status (Rupayex + local DB)
 * Query: ?order_id=xxx
 * Auth: Bearer JWT required (own orders only)
 */
app.post("/bug-report", async (req, res) => {
  const decoded = authUser(req, res);
  if (!decoded) return;
  if (!rateLimitUser("br:" + decoded.id, 5, 3600000))
    return res.status(429).json({ success: false, message: "Too many reports. Try later." });
  const category = String((req.body && req.body.category) || "")
    .trim()
    .slice(0, 60);
  const description = String((req.body && req.body.description) || "")
    .trim()
    .slice(0, 1200);
  if (!category || !description) {
    return res
      .status(400)
      .json({ success: false, message: "category & description required" });
  }
  try {
    await sendBugReportToGroup({
      userId: decoded.id,
      name: decoded.name || decoded.email || "User",
      category,
      description,
    });
  } catch (e) {
    console.error("bug-report:", e.message);
  }
  res.json({ success: true });
});

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
const TG_BOT_TOKEN = String(process.env.TELEGRAM_FREE_BOT_TOKEN || "").trim();
const TG_CHANNEL_ID = String(process.env.TG_CHANNEL_ID || "-1002782160527").trim();
const TG_OWNER_CHAT = String(process.env.TG_OWNER_CHAT || "6656009938").trim();
const TG_CHANNEL_LINK = String(process.env.TG_JOIN_LINK || "https://t.me/+AWev-BNeAz9jZTQ1").trim();
const TG_FREE_SECRET = String(process.env.TG_FREE_SECRET || "").trim();

function tgCall(method, payload) {
  return fetch("https://api.telegram.org/bot" + TG_BOT_TOKEN + "/" + method, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).then((r) => r.json()).catch(() => null);
}
function tgMemberStatus(joined) {
  return joined && joined.result ? String(joined.result.status) : "";
}
function parseTgStartCode(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  if (s.startsWith("v_")) {
    const parts = s.split("_");
    if (parts.length === 4) {
      const uid = Number(parts[1]);
      const expSec = parseInt(parts[2], 36);
      const sig = parts[3];
      if (Number.isFinite(uid) && uid > 0 && Number.isFinite(expSec) && expSec * 1000 > Date.now()) {
        const expected = crypto
          .createHmac("sha256", TG_FREE_SECRET)
          .update(`v.${uid}.${parts[2]}`)
          .digest("hex")
          .slice(0, 16);
        if (sig === expected) return uid;
      }
    }
  }
  try {
    const d = jwt.verify(s, JWT_SECRET);
    if (d && d.id != null) return Number(d.id);
  } catch (_) {}
  return null;
}

app.post("/tg/free-sync", async (req, res) => {
  try {
    const { uid, tg_id, exp, sig } = req.body || {};
    if (!uid || !tg_id || !exp || !sig) {
      return res.status(400).json({ ok: false, reason: "missing_params" });
    }
    const expected = crypto
      .createHmac("sha256", TG_FREE_SECRET)
      .update(`${uid}.${tg_id}.${exp}`)
      .digest("hex");
    if (String(sig) !== expected) {
      return res.status(403).json({ ok: false, reason: "invalid_sig" });
    }
    const claim = await claimTelegramForUser(Number(uid), Number(tg_id), Number(exp));
    if (!claim.ok) {
      return res.status(409).json(claim);
    }
    return res.json({ ok: true, owner_id: claim.owner_id });
  } catch (e) {
    return res.status(500).json({ ok: false, reason: "server_error" });
  }
});

const TG_WEBHOOK_SECRET = String(process.env.TELEGRAM_WEBHOOK_SECRET || "").trim();

app.post("/tg/webhook", async (req, res) => {
  // BE-2: Require valid Telegram webhook secret token header
  const incomingSecret = String(req.get("x-telegram-bot-api-secret-token") || "").trim();
  if (!incomingSecret || !timingSafeEqualStr(incomingSecret, TG_WEBHOOK_SECRET)) {
    return res.status(401).json({ ok: false, message: "Unauthorized webhook" });
  }
  res.json({ ok: true });
  try {
    // Telegram sends this update when a user submits a join request. A pending
    // request is not membership; acknowledge it but unlock only after approval.
    const joinRequest = req.body && req.body.chat_join_request;
    if (
      joinRequest &&
      joinRequest.from &&
      String(joinRequest.chat && joinRequest.chat.id) === String(TG_CHANNEL_ID)
    ) {
      await tgCall("sendMessage", {
        chat_id: joinRequest.from.id,
        text: "✅ Channel join request mil gaya. Verification admin approval ke baad hi complete hogi. Approval ke baad app/bot me wapas aakar ‘Joined — Verify Now’ dabayein.",
      });
      return;
    }

    const cb = req.body && req.body.callback_query;
    if (cb && cb.from && typeof cb.data === "string" && cb.data.startsWith("verify:")) {
      const code = cb.data.slice("verify:".length).trim();
      const uid = parseTgStartCode(code);
      if (uid == null) {
        await tgCall("answerCallbackQuery", {
          callback_query_id: cb.id,
          text: "Verification link expire ho gaya hai. App se dobara Verify par tap karein.",
          show_alert: true,
        });
        return;
      }
      const st = tgMemberStatus(await tgCall("getChatMember", { chat_id: TG_CHANNEL_ID, user_id: cb.from.id }));
      if (st === "member" || st === "administrator" || st === "creator") {
        const exp = Date.now() + 30 * 86400000;
        const claim = await claimTelegramForUser(uid, cb.from.id, exp);
        if (!claim.ok) {
          await tgCall("answerCallbackQuery", {
            callback_query_id: cb.id,
            text: "❌ 1 Telegram account se sirf 1 hi DRAGO ID verify ho sakti hai!",
            show_alert: true,
          });
          await tgCall("sendMessage", {
            chat_id: cb.message.chat.id,
            text:
              "❌ Verification Blocked!\n\n" +
              (claim.reason === "tg_already_used"
                ? `⚠️ Ye Telegram account pehle se hi DRAGO Account #${claim.owner_id} ke saath linked hai.\n\n🔒 Rule: 1 Telegram account se sirf 1 hi DRAGO ID verify ho sakti hai.\nApne pehle wale DRAGO account me login karein ya Unlimited Access ke liye Pro VIP Plan lein.`
                : "⚠️ Ye DRAGO account pehle se kisi dusre Telegram account se linked hai."),
            reply_markup: {
              inline_keyboard: [
                [{ text: "🚀 Open DRAGO App", url: `${FRONTEND_URL}/dashboard/` }],
              ],
            },
          });
          return;
        }
        const payload = `${uid}.${cb.from.id}.${exp}`;
        const sig = crypto.createHmac("sha256", TG_FREE_SECRET).update(payload).digest("hex");
        const freeToken = Buffer.from(payload).toString("base64url") + "." + sig;
        await tgCall("answerCallbackQuery", {
          callback_query_id: cb.id,
          text: "✅ Account Verified! Free Trial Activated.",
          show_alert: false,
        });
        await tgCall("sendMessage", {
          chat_id: cb.message.chat.id,
          text:
            "✅ Account Verified Successfully!\n\n" +
            "🎁 Aapka FREE Trial active ho gaya hai:\n" +
            "• 🔮 3 Free Predictions (Lifetime)\n" +
            "• 🔌 10 Drago API Data Fetches (Lifetime)\n" +
            "• 🤖 3 NEXUS Agent Uses (Lifetime)\n\n" +
            "💎 Unlimited access ke liye Pro Plan me upgrade karein.\n" +
            "👇 Niche button daba kar seedha app me jao:",
          reply_markup: {
            inline_keyboard: [
              [{ text: "🔮 Open Prediction", url: `${FRONTEND_URL}/prediction/#free=${freeToken}` }],
              [{ text: "🏠 Open Dashboard", url: `${FRONTEND_URL}/dashboard/#free=${freeToken}` }],
            ],
          },
        });
        await tgCall("sendMessage", {
          chat_id: TG_OWNER_CHAT,
          text: "🆓 User #" + uid + " (" + (cb.from.username || cb.from.first_name) + ") ne free plan activate kiya.",
        });
      } else {
        await tgCall("answerCallbackQuery", {
          callback_query_id: cb.id,
          text: "⚠️ Channel join karein. Join request bheji hai to admin approval ka wait karein; approve hone ke baad Verify Now dobara dabayein.",
          show_alert: true,
        });
      }
      return;
    }

    const msg = req.body && req.body.message;
    if (!msg || !msg.from || !msg.text || msg.text.indexOf("/start") !== 0) return;
    const rawParam = decodeURIComponent(msg.text.replace(/^\/start(@\S+)?/, "").trim());
    const uid = parseTgStartCode(rawParam);
    if (uid == null) {
      await tgCall("sendMessage", {
        chat_id: msg.chat.id,
        text: "👋 Welcome to DRAGO Predictor Bot!\n\nApna account verify karne ke liye DRAGO App kholein aur 'Verify Your Account' button par tap karein.",
        reply_markup: {
          inline_keyboard: [[{ text: "🚀 Open DRAGO App", url: `${FRONTEND_URL}/dashboard/` }]],
        },
      });
      return;
    }
    const st = tgMemberStatus(await tgCall("getChatMember", { chat_id: TG_CHANNEL_ID, user_id: msg.from.id }));
    if (st === "member" || st === "administrator" || st === "creator") {
      const exp = Date.now() + 30 * 86400000;
      const claim = await claimTelegramForUser(uid, msg.from.id, exp);
      if (!claim.ok) {
        await tgCall("sendMessage", {
          chat_id: msg.chat.id,
          text:
            "❌ Verification Blocked!\n\n" +
            (claim.reason === "tg_already_used"
              ? `⚠️ Ye Telegram account pehle se hi DRAGO Account #${claim.owner_id} ke saath linked hai.\n\n🔒 Rule: 1 Telegram account se sirf 1 hi DRAGO ID verify ho sakti hai.\nApne pehle wale DRAGO account me login karein ya Unlimited Access ke liye Pro VIP Plan lein.`
              : "⚠️ Ye DRAGO account pehle se kisi dusre Telegram account se linked hai."),
          reply_markup: {
            inline_keyboard: [
              [{ text: "🚀 Open DRAGO App", url: `${FRONTEND_URL}/dashboard/` }],
            ],
          },
        });
        return;
      }
      const payload = `${uid}.${msg.from.id}.${exp}`;
      const sig = crypto.createHmac("sha256", TG_FREE_SECRET).update(payload).digest("hex");
      const freeToken = Buffer.from(payload).toString("base64url") + "." + sig;
      await tgCall("sendMessage", {
        chat_id: msg.chat.id,
        text:
          "✅ Account Verified Successfully!\n\n" +
          "🎁 Aapka FREE Trial active ho gaya hai:\n" +
          "• 🔮 3 Free Predictions (Lifetime)\n" +
          "• 🔌 10 Drago API Data Fetches (Lifetime)\n" +
          "• 🤖 3 NEXUS Agent Uses (Lifetime)\n\n" +
          "💎 Unlimited access ke liye Pro Plan me upgrade karein.\n" +
          "👇 Niche button daba kar seedha app me jao:",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔮 Open Prediction", url: `${FRONTEND_URL}/prediction/#free=${freeToken}` }],
            [{ text: "🏠 Open Dashboard", url: `${FRONTEND_URL}/dashboard/#free=${freeToken}` }],
          ],
        },
      });
      await tgCall("sendMessage", {
        chat_id: TG_OWNER_CHAT,
        text: "🆓 User #" + uid + " (" + (msg.from.username || msg.from.first_name) + ") ne free plan activate kiya.",
      });
    } else {
      await tgCall("sendMessage", {
        chat_id: msg.chat.id,
        text: "🔐 DRAGO Free Plan Verification\n\n1️⃣ Niche 'Join Official Channel' par tap karke channel join karein ya join request bhejein.\n2️⃣ Request pending ho to admin approval ka wait karein. Approval ke baad 'Joined — Verify Now' dabayein; pending request se access activate nahi hota.",
        reply_markup: {
          inline_keyboard: [
            [{ text: "📢 1. Join Official Channel", url: TG_CHANNEL_LINK }],
            [{ text: "✅ 2. Joined — Verify Now", callback_data: `verify:${rawParam}` }],
          ],
        },
      });
    }
  } catch (e) {
    console.error("tg/webhook:", e.message);
  }
});

app.get("/free-check", async (req, res) => {
  const decoded = authUser(req, res);
  if (!decoded) return;
  try {
    const u = await col.users.findOne({ id: Number(decoded.id) });
    if (u && u.tg_id) {
      const exp =
        u.free_expires_at && Number(u.free_expires_at) > Date.now()
          ? Number(u.free_expires_at)
          : Date.now() + 30 * 86400000;
      const claim = await claimTelegramForUser(u.id, u.tg_id, exp);
      if (!claim.ok) {
        return res.json({
          success: true,
          free_active: 0,
          tg_already_used: true,
          owner_id: claim.owner_id || null,
        });
      }
      const st = tgMemberStatus(await tgCall("getChatMember", { chat_id: TG_CHANNEL_ID, user_id: u.tg_id }));
      if (st === "member" || st === "administrator" || st === "creator") {
        const payload = `${u.id}.${u.tg_id}.${exp}`;
        const sig = crypto.createHmac("sha256", TG_FREE_SECRET).update(payload).digest("hex");
        const freeToken = Buffer.from(payload).toString("base64url") + "." + sig;
        return res.json({ success: true, free_active: 1, free_token: freeToken });
      }
    }
    res.json({ success: true, free_active: u && isFreeActive(u) ? 1 : 0 });
  } catch (e) {
    res.json({ success: true, free_active: 0 });
  }
});

/* ── User Notifications Feed (Broadcast + Personal + Auto Plan Active/Expired) ── */
app.get("/notifications", async (req, res) => {
  const decoded = authUser(req, res);
  if (!decoded) return;
  const uid = Number(decoded.id);
  try {
    await sweepExpiredProUsers(uid);
  } catch (_) {}

  const userNotifs = notificationsList
    .filter((n) => n && (n.target === "all" || Number(n.user_id) === uid))
    .slice(0, 60)
    .map((n) => {
      const isRead = Array.isArray(n.read_by) && n.read_by.includes(uid);
      return {
        id: n.id,
        target: n.target,
        type: n.type || "broadcast",
        title: n.title || "DRAGO Update",
        message: n.message || "",
        image_url: n.image_url || null,
        action_url: n.action_url || null,
        action_label: n.action_label || null,
        created_at: n.created_at,
        is_read: isRead,
      };
    });

  const unreadCount = userNotifs.filter((n) => !n.is_read).length;
  res.json({
    success: true,
    unread_count: unreadCount,
    notifications: userNotifs,
  });
});

app.post("/notifications/read", (req, res) => {
  const decoded = authUser(req, res);
  if (!decoded) return;
  const uid = Number(decoded.id);
  const targetId = String((req.body && req.body.id) || "").trim();
  let changed = false;

  for (const n of notificationsList) {
    if (!n) continue;
    if (n.target !== "all" && Number(n.user_id) !== uid) continue;
    if (targetId && targetId !== "ALL" && String(n.id) !== targetId) continue;
    if (!Array.isArray(n.read_by)) n.read_by = [];
    if (!n.read_by.includes(uid)) {
      n.read_by.push(uid);
      if (n.read_by.length > 2000) n.read_by = n.read_by.slice(-2000);
      changed = true;
    }
  }

  if (changed) saveNotificationsStore();
  res.json({ success: true, unread_count: 0 });
});

/* ── Web Push Subscription Routes ── */
app.get("/push/vapid-public-key", (_req, res) => {
  res.json({
    success: true,
    publicKey: VAPID_PUBLIC_KEY,
  });
});

app.post("/push/subscribe", async (req, res) => {
  try {
    const b = req.body || {};
    const sub = b.subscription || b;
    if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
      return res.status(400).json({
        success: false,
        message: "Valid Web Push subscription object is required.",
      });
    }

    let uid = Number(b.user_id) || null;
    let uname = b.user_name ? String(b.user_name).slice(0, 80) : null;

    // Optional JWT token resolution
    const h = req.get("Authorization") || "";
    const m = h.match(/^Bearer\s+(.+)$/i);
    if (m && JWT_SECRET) {
      try {
        const dec = jwt.verify(m[1].trim(), JWT_SECRET);
        if (dec && dec.id) uid = Number(dec.id);
        if (dec && dec.name && !uname) uname = String(dec.name).slice(0, 80);
      } catch (_) {}
    }

    const endpoint = String(sub.endpoint).trim();
    const record = {
      endpoint,
      keys: {
        p256dh: String(sub.keys.p256dh),
        auth: String(sub.keys.auth),
      },
      user_id: uid,
      user_name: uname,
      updated_at: new Date().toISOString(),
    };

    const existingIdx = pushSubscriptionsList.findIndex(
      (item) => item && item.endpoint === endpoint
    );
    if (existingIdx >= 0) {
      pushSubscriptionsList[existingIdx] = {
        ...pushSubscriptionsList[existingIdx],
        ...record,
      };
    } else {
      pushSubscriptionsList.unshift(record);
      if (pushSubscriptionsList.length > 3000) {
        pushSubscriptionsList = pushSubscriptionsList.slice(0, 3000);
      }
    }
    savePushSubscriptionsStore();

    if (uid && col.users) {
      await col.users
        .updateOne(
          { id: uid },
          {
            $set: {
              push_enabled: 1,
              push_updated_at: new Date().toISOString(),
            },
          }
        )
        .catch(() => {});
    }

    res.json({
      success: true,
      subscribed: true,
      user_id: uid,
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.post("/push/unsubscribe", async (req, res) => {
  try {
    const endpoint = String((req.body && req.body.endpoint) || "").trim();
    if (endpoint) {
      pushSubscriptionsList = pushSubscriptionsList.filter(
        (s) => s && s.endpoint !== endpoint
      );
      savePushSubscriptionsStore();
    }
    res.json({ success: true, subscribed: false });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

/* ── Public App Config (Plans, UPI ID, Auto-Sliding Home Banners) ── */
app.get("/app-config", (_req, res) => {
  const weeklyObj = {
    name: PLAN_CATALOG.weekly.name,
    amount: PLAN_CATALOG.weekly.amount,
    days: PLAN_CATALOG.weekly.days,
    qr_url: PLAN_CATALOG.weekly.qr_url || null,
  };
  const monthlyObj = {
    name: PLAN_CATALOG.monthly.name,
    amount: PLAN_CATALOG.monthly.amount,
    days: PLAN_CATALOG.monthly.days,
    qr_url: PLAN_CATALOG.monthly.qr_url || null,
  };
  res.json({
    success: true,
    plans: {
      weekly: weeklyObj,
      monthly: monthlyObj,
      beginners: weeklyObj,
      profit: monthlyObj,
    },
    upi_id: getActiveUpiId(),
    banners: getActiveBanners(),
    free_limits: {
      pred: freePredLimit(),
      api_history: freeApiHistoryLimit(),
      nexus: freeNexusLimit(),
    },
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   ADMIN PANEL API (/admin/*) — Protected by X-Admin-Key
   Works from standalone local index.html on mobile (Origin: null supported)
   ═══════════════════════════════════════════════════════════════════════════ */
const ADMIN_PANEL_KEY = String(process.env.ADMIN_PANEL_KEY || "").trim();

// Fail closed: required secrets must be provisioned out of band.
const missingSecurityEnv = [];
if (!TELEGRAM_BOT_TOKEN) missingSecurityEnv.push("TELEGRAM_ADMIN_BOT_TOKEN");
if (!TG_BOT_TOKEN) missingSecurityEnv.push("TELEGRAM_FREE_BOT_TOKEN");
if (TG_FREE_SECRET.length < 32) missingSecurityEnv.push("TG_FREE_SECRET (32+ chars)");
if (TG_WEBHOOK_SECRET.length < 32) missingSecurityEnv.push("TELEGRAM_WEBHOOK_SECRET (32+ chars)");
if (ADMIN_PANEL_KEY.length < 32) missingSecurityEnv.push("ADMIN_PANEL_KEY (32+ chars)");
if (!VPS_SECRET || VPS_SECRET.length < 32) missingSecurityEnv.push("VPS_SECRET (32+ chars)");
if (webPush && (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY)) {
  missingSecurityEnv.push("VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY");
}
if (missingSecurityEnv.length) {
  console.error("❌ Missing required secure environment variables:", missingSecurityEnv.join(", "));
  process.exit(1);
}

function requireAdminKey(req, res, next) {
  const ip = String(req.ip || req.socket?.remoteAddress || "unknown");
  if (!rateLimitUser("adm_try:" + ip, 60, 300000)) {
    return res.status(429).json({ success: false, message: "Too many admin attempts. Wait 5 min." });
  }
  let key = String(req.get("x-admin-key") || "").trim();
  if (!key) {
    const auth = String(req.get("authorization") || "").trim();
    if (auth.toLowerCase().startsWith("bearer ")) key = auth.slice(7).trim();
  }
  if (!key || !timingSafeEqualStr(key, ADMIN_PANEL_KEY)) {
    return res.status(401).json({ success: false, message: "Invalid Admin Key" });
  }
  next();
}

app.use("/admin", requireAdminKey);

app.get("/admin/overview", async (_req, res) => {
  try {
    expireStaleOrders();
    const allUsers = col.users ? await col.users.find({}).toArray() : [];
    let proCount = 0;
    let freeVerifiedCount = 0;
    let bannedCount = 0;
    for (const u of allUsers) {
      if (userIsPro(u)) proCount++;
      if (isFreeActive(u)) freeVerifiedCount++;
      if (u.banned || u.ban_state === "banned" || u.ban_state === "blocked") bannedCount++;
    }

    const allPayments = getPayments();
    let approvedPayments = 0;
    let pendingVerifyPayments = 0;
    let pendingPayments = 0;
    let rejectedPayments = 0;
    let expiredPayments = 0;
    let totalRevenue = 0;

    for (const o of allPayments) {
      if (!o) continue;
      const st = String(o.payment_status || "").toUpperCase();
      if (st === "SUCCESS" || st === "APPROVED") {
        approvedPayments++;
        totalRevenue += Number(o.amount) || 0;
      } else if (st === "PENDING_VERIFY") {
        pendingVerifyPayments++;
      } else if (st === "PENDING") {
        pendingPayments++;
      } else if (st === "REJECTED" || st === "FAILED" || st === "DENIED") {
        rejectedPayments++;
      } else if (st === "EXPIRED") {
        expiredPayments++;
      }
    }

    const games = col.games ? await dbListGames() : [];
    const banners = Array.isArray(adminSettings.banners) && adminSettings.banners.length
      ? adminSettings.banners
      : DEFAULT_ADMIN_SETTINGS.banners;

    res.json({
      success: true,
      stats: {
        total_users: allUsers.length,
        pro_users: proCount,
        free_verified_users: freeVerifiedCount,
        banned_users: bannedCount,
        total_payments: allPayments.length,
        approved_payments: approvedPayments,
        pending_verify_payments: pendingVerifyPayments,
        pending_payments: pendingPayments,
        rejected_payments: rejectedPayments,
        expired_payments: expiredPayments,
        total_revenue: totalRevenue,
        total_games: games.length,
        total_banners: banners.length,
        push_subscribers_count: pushSubscriptionsList.length,
      },
      settings: {
        ...adminSettings,
        weekly_amount: PLAN_CATALOG.weekly.amount,
        weekly_days: PLAN_CATALOG.weekly.days,
        weekly_name: PLAN_CATALOG.weekly.name,
        weekly_qr_url: PLAN_CATALOG.weekly.qr_url,
        monthly_amount: PLAN_CATALOG.monthly.amount,
        monthly_days: PLAN_CATALOG.monthly.days,
        monthly_name: PLAN_CATALOG.monthly.name,
        monthly_qr_url: PLAN_CATALOG.monthly.qr_url,
        upi_id: getActiveUpiId(),
      },
      banners,
      games,
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.get("/admin/users", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim().toLowerCase();
    const filter = String(req.query.filter || "all").trim().toLowerCase();
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 300, 1000));

    const docs = col.users
      ? await col.users.find({}).sort({ id: -1 }).toArray()
      : [];

    const mapped = [];
    for (const u of docs) {
      const isPro = userIsPro(u);
      const isFree = isFreeActive(u);
      const isBanned = Boolean(u.banned || u.ban_state === "banned" || u.ban_state === "blocked");

      if (filter === "pro" && !isPro) continue;
      if (filter === "free" && isPro) continue;
      if (filter === "verified" && !isFree) continue;
      if (filter === "banned" && !isBanned) continue;

      if (q) {
        const hay = `${u.id} #${u.id} ${u.name || ""} ${u.email || ""} ${u.tg_id || ""} ${u.pro_plan || ""}`.toLowerCase();
        if (!hay.includes(q)) continue;
      }

      mapped.push({
        id: u.id,
        name: u.name || "User",
        email: u.email || "",
        picture: u.picture || "",
        created_at: u.created_at || null,
        is_pro: isPro,
        pro_plan: isPro ? u.pro_plan || "weekly" : null,
        pro_expires_at: isPro ? u.pro_expires_at || null : null,
        free_active: isFree,
        tg_id: u.tg_id || null,
        free_pred_used: Number(u.free_pred_used) || 0,
        free_pred_limit: freePredLimit(),
        free_api_used: Number(u.free_api_used) || 0,
        free_api_limit: freeApiHistoryLimit(),
        free_nexus_used: Number(u.free_nexus_used) || 0,
        free_nexus_limit: freeNexusLimit(),
        banned: isBanned,
        ban_state: u.ban_state || (u.banned ? "banned" : "ok"),
        ban_reason: u.ban_reason || "",
        banned_device: u.banned_device || "",
        ref_code: u.ref_code || "",
        ref_count: Number(u.ref_count) || 0,
        ref_paid_count: Number(u.ref_paid_count) || 0,
        ref_rewards_earned: Number(u.ref_rewards_earned) || 0,
        referred_by: u.referred_by || null,
        push_enabled: Boolean(u.push_enabled || isUserPushSubscribed(u.id)),
      });
      if (mapped.length >= limit) break;
    }

    res.json({ success: true, total: docs.length, count: mapped.length, users: mapped });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.post("/admin/user-action", async (req, res) => {
  try {
    const userId = Number(req.body && req.body.user_id);
    const action = String((req.body && req.body.action) || "").trim().toLowerCase();
    if (!userId || !action) {
      return res.status(400).json({ success: false, message: "user_id and action required" });
    }
    const u = await col.users.findOne({ id: userId });
    if (!u) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    if (action === "activate_pro") {
      const rawPlan = String((req.body && req.body.plan) || "weekly").trim().toLowerCase();
      const planKey = rawPlan === "monthly" || rawPlan === "profit" ? "monthly" : "weekly";
      const customDays = Number(req.body && req.body.days);
      const days = Number.isFinite(customDays) && customDays >= 1
        ? customDays
        : PLAN_CATALOG[planKey].days;
      const expires = new Date(Date.now() + days * 86400000).toISOString();
      await dbSetUserPro(userId, 1, planKey, expires);
      return res.json({
        success: true,
        message: `User #${userId} activated on ${planKey.toUpperCase()} (${days} days)`,
        pro_plan: planKey,
        pro_expires_at: expires,
      });
    }

    if (action === "revoke_pro") {
      await dbSetUserPro(userId, 0, null, null);
      return res.json({
        success: true,
        message: `User #${userId} moved to Free plan`,
      });
    }

    if (action === "block" || action === "ban") {
      const reason = String((req.body && req.body.reason) || "Admin panel block").slice(0, 120);
      await dbBanUserPermanent(userId, reason);
      return res.json({
        success: true,
        message: `User #${userId} blocked/banned`,
        banned: true,
      });
    }

    if (action === "unblock" || action === "unban") {
      await dbUnlockUser(userId);
      return res.json({
        success: true,
        message: `User #${userId} unblocked/unlocked`,
        banned: false,
      });
    }

    if (action === "reset_quota") {
      await col.users.updateOne(
        { id: userId },
        { $set: { free_pred_used: 0, free_api_used: 0, free_nexus_used: 0 } }
      );
      if (col.api_usage) {
        await col.api_usage.deleteMany({ user_id: userId });
      }
      pushNotification({
        target: "user",
        user_id: userId,
        user_name: u.name || u.email || `User #${userId}`,
        type: "quota_reset",
        title: "♻️ Free Usage Quota Reset!",
        message: `Hi ${u.name || "Member"}, your free prediction, API, and NEXUS AI usage quota has been reset to 0 by Admin!`,
        action_url: "/prediction/",
        action_label: "OPEN PREDICTION →",
      });
      return res.json({
        success: true,
        message: `Free quotas reset to 0 for User #${userId}`,
      });
    }

    if (action === "verify_free") {
      const exp = Date.now() + 365 * 86400000;
      await col.users.updateOne(
        { id: userId },
        { $set: { free_active: 1, free_expires_at: exp } }
      );
      pushNotification({
        target: "user",
        user_id: userId,
        user_name: u.name || u.email || `User #${userId}`,
        type: "free_verified",
        title: "✅ Free Access Activated!",
        message: `Hi ${u.name || "Member"}, your account has been verified by Admin! You can now test live predictions.`,
        action_url: "/prediction/",
        action_label: "START NOW →",
      });
      return res.json({
        success: true,
        message: `Free plan manually verified for User #${userId}`,
      });
    }

    if (action === "unlink_tg") {
      await col.users.updateOne(
        { id: userId },
        { $set: { free_active: 0, free_expires_at: null, tg_id: null } }
      );
      return res.json({
        success: true,
        message: `Telegram unlinked for User #${userId}`,
      });
    }

    return res.status(400).json({ success: false, message: "Unknown action" });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.post("/admin/settings", (req, res) => {
  try {
    const b = req.body || {};
    if (b.weekly_amount != null) {
      const n = Number(b.weekly_amount);
      if (Number.isFinite(n) && n >= 1 && n <= 100000) adminSettings.weekly_amount = Math.round(n);
    }
    if (b.weekly_days != null) {
      const n = Number(b.weekly_days);
      if (Number.isFinite(n) && n >= 1 && n <= 3650) adminSettings.weekly_days = Math.round(n);
    }
    if (typeof b.weekly_name === "string" && b.weekly_name.trim()) {
      adminSettings.weekly_name = b.weekly_name.trim().slice(0, 50);
    }
    if (typeof b.weekly_qr_url === "string") {
      adminSettings.weekly_qr_url = b.weekly_qr_url.trim();
    }

    if (b.monthly_amount != null) {
      const n = Number(b.monthly_amount);
      if (Number.isFinite(n) && n >= 1 && n <= 100000) adminSettings.monthly_amount = Math.round(n);
    }
    if (b.monthly_days != null) {
      const n = Number(b.monthly_days);
      if (Number.isFinite(n) && n >= 1 && n <= 3650) adminSettings.monthly_days = Math.round(n);
    }
    if (typeof b.monthly_name === "string" && b.monthly_name.trim()) {
      adminSettings.monthly_name = b.monthly_name.trim().slice(0, 50);
    }
    if (typeof b.monthly_qr_url === "string") {
      adminSettings.monthly_qr_url = b.monthly_qr_url.trim();
    }

    if (typeof b.upi_id === "string") {
      adminSettings.upi_id = b.upi_id.trim().slice(0, 100);
    }

    if (b.free_pred_limit != null) {
      const n = Number(b.free_pred_limit);
      if (Number.isFinite(n) && n >= 0 && n <= 1000) adminSettings.free_pred_limit = Math.round(n);
    }
    if (b.free_api_history_limit != null) {
      const n = Number(b.free_api_history_limit);
      if (Number.isFinite(n) && n >= 0 && n <= 10000) adminSettings.free_api_history_limit = Math.round(n);
    }
    if (b.free_nexus_limit != null) {
      const n = Number(b.free_nexus_limit);
      if (Number.isFinite(n) && n >= 0 && n <= 1000) adminSettings.free_nexus_limit = Math.round(n);
    }

    if (typeof b.google_auth_enabled === "boolean") adminSettings.google_auth_enabled = b.google_auth_enabled;
    if (typeof b.auto_payment_enabled === "boolean") adminSettings.auto_payment_enabled = b.auto_payment_enabled;
    if (typeof b.manual_payment_enabled === "boolean") adminSettings.manual_payment_enabled = b.manual_payment_enabled;
    if (typeof b.guard_enabled === "boolean") adminSettings.guard_enabled = b.guard_enabled;

    saveAdminSettings();
    res.json({
      success: true,
      message: "Settings & Plan prices saved!",
      settings: adminSettings,
      plans: {
        weekly: {
          name: PLAN_CATALOG.weekly.name,
          amount: PLAN_CATALOG.weekly.amount,
          days: PLAN_CATALOG.weekly.days,
          qr_url: PLAN_CATALOG.weekly.qr_url,
        },
        monthly: {
          name: PLAN_CATALOG.monthly.name,
          amount: PLAN_CATALOG.monthly.amount,
          days: PLAN_CATALOG.monthly.days,
          qr_url: PLAN_CATALOG.monthly.qr_url,
        },
      },
      upi_id: getActiveUpiId(),
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.get("/admin/payments", async (req, res) => {
  try {
    expireStaleOrders();
    const statusFilter = String(req.query.status || "ALL").trim().toUpperCase();
    const q = String(req.query.q || "").trim().toLowerCase();
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 300, 1000));

    const userMap = new Map();
    if (col.users) {
      const uDocs = await col.users
        .find({}, { projection: { id: 1, name: 1, email: 1 } })
        .toArray();
      for (const u of uDocs) userMap.set(Number(u.id), u);
    }

    const all = getPayments()
      .filter(Boolean)
      .slice()
      .sort((a, b) => Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0));

    let approved = 0;
    let pendingVerify = 0;
    let pending = 0;
    let rejected = 0;
    let expired = 0;
    let approvedRevenue = 0;

    for (const o of all) {
      const st = String(o.payment_status || "").toUpperCase();
      if (st === "SUCCESS" || st === "APPROVED") {
        approved++;
        approvedRevenue += Number(o.amount) || 0;
      } else if (st === "PENDING_VERIFY") {
        pendingVerify++;
      } else if (st === "PENDING") {
        pending++;
      } else if (st === "REJECTED" || st === "FAILED" || st === "DENIED") {
        rejected++;
      } else if (st === "EXPIRED") {
        expired++;
      }
    }

    const orders = [];
    for (const o of all) {
      const st = String(o.payment_status || "").toUpperCase();
      if (statusFilter !== "ALL") {
        if (statusFilter === "SUCCESS" && st !== "SUCCESS" && st !== "APPROVED") continue;
        else if (statusFilter === "REJECTED" && st !== "REJECTED" && st !== "FAILED" && st !== "DENIED") continue;
        else if (statusFilter !== "SUCCESS" && statusFilter !== "REJECTED" && st !== statusFilter) continue;
      }
      const u = userMap.get(Number(o.user_id)) || {};
      if (q) {
        const hay = `${o.order_id || ""} ${o.utr || ""} ${o.user_id || ""} ${u.name || ""} ${u.email || ""} ${o.plan || ""}`.toLowerCase();
        if (!hay.includes(q)) continue;
      }
      let proofImg = o.proof_image_url || null;
      if (!proofImg && o.raw_response) {
        try {
          const parsed = JSON.parse(o.raw_response);
          if (parsed && parsed.proof_image_url) proofImg = parsed.proof_image_url;
        } catch (_) {}
      }
      orders.push({
        order_id: o.order_id,
        user_id: o.user_id,
        user_name: u.name || `User #${o.user_id}`,
        user_email: u.email || "",
        plan: o.plan,
        plan_name: (PLAN_CATALOG[o.plan] && PLAN_CATALOG[o.plan].name) || String(o.plan || "PRO VIP").toUpperCase(),
        amount: o.amount,
        payment_status: o.payment_status,
        utr: o.utr || null,
        proof_image_url: proofImg,
        method: o.method || null,
        created_at: o.created_at,
        updated_at: o.updated_at || o.created_at,
      });
      if (orders.length >= limit) break;
    }

    res.json({
      success: true,
      summary: {
        total: all.length,
        approved,
        pending_verify: pendingVerify,
        pending,
        rejected,
        expired,
        approved_revenue: approvedRevenue,
      },
      orders,
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.post("/admin/payment-action", async (req, res) => {
  try {
    const orderId = String((req.body && req.body.order_id) || "").trim();
    const action = String((req.body && req.body.action) || "").trim().toLowerCase();
    if (!orderId || !action) {
      return res.status(400).json({ success: false, message: "order_id and action required" });
    }
    const order = findOrder(orderId);
    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }

    if (action === "approve") {
      updateOrderStatus(orderId, "SUCCESS", order.utr, order.method || "UPI_MANUAL", order.raw_response);
      const act = await activatePro(order.user_id, order.plan || "weekly");
      if (TELEGRAM_BOT_TOKEN && TELEGRAM_ADMIN_CHAT_ID) {
        telegramApi("sendMessage", {
          chat_id: TELEGRAM_ADMIN_CHAT_ID,
          text: `✅ Payment Approved (Admin Panel)\nOrder: ${orderId}\nUser: #${order.user_id}\nPlan: ${order.plan || "weekly"} (₹${order.amount || 0})`,
        }).catch(() => {});
      }
      return res.json({
        success: true,
        message: `Order ${orderId} approved & Pro activated for User #${order.user_id}!`,
        order,
        activated: act,
      });
    }

    if (action === "reject" || action === "deny") {
      updateOrderStatus(orderId, "REJECTED", order.utr, order.method || "UPI_MANUAL", order.raw_response);
      try {
        pushNotification({
          target: "user",
          user_id: order.user_id,
          type: "payment_rejected",
          title: "❌ Payment Verification Declined",
          message: `Your payment UTR (${order.utr || "N/A"}) for Order ${orderId} could not be verified. If amount was deducted, open Profile → Subscription Not Approve and upload your payment screenshot.`,
          action_url: "/profile/",
          action_label: "UPLOAD PAYMENT PROOF →",
        });
      } catch (_) {}
      if (TELEGRAM_BOT_TOKEN && TELEGRAM_ADMIN_CHAT_ID) {
        telegramApi("sendMessage", {
          chat_id: TELEGRAM_ADMIN_CHAT_ID,
          text: `❌ Payment Rejected (Admin Panel)\nOrder: ${orderId}\nUser: #${order.user_id}`,
        }).catch(() => {});
      }
      return res.json({
        success: true,
        message: `Order ${orderId} rejected.`,
        order,
      });
    }

    if (action === "delete") {
      paymentsCache = getPayments().filter((o) => o && String(o.order_id) !== orderId);
      schedulePaymentsFlush();
      flushPaymentsSync();
      if (col.payments) {
        await col.payments.deleteOne({ order_id: orderId }).catch(() => {});
      }
      return res.json({
        success: true,
        message: `Order ${orderId} deleted.`,
      });
    }

    return res.status(400).json({ success: false, message: "Unknown action" });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.get("/admin/games", async (_req, res) => {
  try {
    const games = await dbListGames();
    res.json({ success: true, games });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.post("/admin/games", async (req, res) => {
  try {
    const b = req.body || {};
    const name = String(b.name || "").trim().slice(0, 80);
    const imageUrl = String(b.image_url || "").trim().slice(0, 500);
    const gameUrl = String(b.game_url || b.link_url || "").trim().slice(0, 500);
    if (!name || !gameUrl) {
      return res.status(400).json({ success: false, message: "Game name and game URL are required" });
    }
    const maxRow = await dbMaxGameOrder();
    const sortOrder = b.sort_order != null ? Number(b.sort_order) : (Number(maxRow.m) || 0) + 1;
    const inserted = await dbInsertGame(name, imageUrl, gameUrl, sortOrder);
    const games = await dbListGames();
    res.json({
      success: true,
      message: `Game "${name}" added!`,
      id: inserted.id,
      games,
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.delete("/admin/games/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: "Invalid game id" });
    await dbDeleteGame(id);
    const games = await dbListGames();
    res.json({ success: true, message: `Game #${id} deleted`, games });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.get("/admin/banners", (_req, res) => {
  const banners = Array.isArray(adminSettings.banners) && adminSettings.banners.length
    ? adminSettings.banners
    : DEFAULT_ADMIN_SETTINGS.banners;
  res.json({ success: true, banners });
});

app.post("/admin/banners", (req, res) => {
  try {
    const b = req.body || {};
    const imageUrl = String(b.image_url || "").trim();
    const linkUrl = String(b.link_url || "/prediction/").trim() || "/prediction/";
    const title = String(b.title || "DRAGO Promotion").trim().slice(0, 120);
    if (!imageUrl) {
      return res.status(400).json({ success: false, message: "Banner image URL required" });
    }
    if (!Array.isArray(adminSettings.banners) || !adminSettings.banners.length) {
      adminSettings.banners = [...DEFAULT_ADMIN_SETTINGS.banners];
    }
    const newBanner = {
      id: "bn_" + Date.now() + "_" + crypto.randomBytes(2).toString("hex"),
      title,
      image_url: imageUrl,
      link_url: linkUrl,
      active: true,
      created_at: new Date().toISOString(),
    };
    adminSettings.banners.push(newBanner);
    saveAdminSettings();
    res.json({
      success: true,
      message: "Banner added!",
      banner: newBanner,
      banners: adminSettings.banners,
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.delete("/admin/banners/:id", (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    if (!Array.isArray(adminSettings.banners)) {
      adminSettings.banners = [...DEFAULT_ADMIN_SETTINGS.banners];
    }
    adminSettings.banners = adminSettings.banners.filter((b) => b && String(b.id) !== id);
    saveAdminSettings();
    res.json({
      success: true,
      message: "Banner removed!",
      banners: adminSettings.banners,
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.post("/admin/upload-image", async (req, res) => {
  try {
    const b64 = String((req.body && req.body.image) || "");
    const m = b64.match(/^data:image\/(png|jpe?g|webp|gif);base64,(.+)$/i);
    if (!m) {
      return res.status(400).json({ success: false, message: "Valid PNG/JPG/WEBP/GIF image required" });
    }
    const buf = Buffer.from(m[2], "base64");
    if (buf.length > 6 * 1024 * 1024) {
      return res.status(413).json({ success: false, message: "Image too large (max 6MB)" });
    }
    const url = await storeUploadedImage(buf, "image/" + m[1].toLowerCase(), req);
    return res.json({ success: true, url });
  } catch (e) {
    return res.status(502).json({ success: false, message: "Image upload failed: " + e.message });
  }
});

app.get("/admin/notifications", (_req, res) => {
  const uniquePushUsers = new Set(
    pushSubscriptionsList.map((s) => s && s.user_id).filter(Boolean)
  );
  res.json({
    success: true,
    push_subscribers_count: pushSubscriptionsList.length,
    push_users_count: uniquePushUsers.size,
    notifications: notificationsList.slice(0, 100),
    templates: {
      plan_active_title:
        adminSettings.notif_plan_active_title ||
        DEFAULT_ADMIN_SETTINGS.notif_plan_active_title,
      plan_active_body:
        adminSettings.notif_plan_active_body ||
        DEFAULT_ADMIN_SETTINGS.notif_plan_active_body,
      plan_active_image: adminSettings.notif_plan_active_image || "",
      plan_expired_title:
        adminSettings.notif_plan_expired_title ||
        DEFAULT_ADMIN_SETTINGS.notif_plan_expired_title,
      plan_expired_body:
        adminSettings.notif_plan_expired_body ||
        DEFAULT_ADMIN_SETTINGS.notif_plan_expired_body,
      plan_expired_image: adminSettings.notif_plan_expired_image || "",
    },
  });
});

app.post("/admin/notifications/send", async (req, res) => {
  try {
    const b = req.body || {};
    const target = String(b.target || "all").toLowerCase() === "user" ? "user" : "all";
    const title = String(b.title || "").trim().slice(0, 140);
    const message = String(b.message || "").trim().slice(0, 1200);
    const imageUrl = String(b.image_url || "").trim() || null;
    const actionUrl = String(b.action_url || "").trim() || null;
    const actionLabel = String(b.action_label || "").trim().slice(0, 50) || null;

    if (!title || !message) {
      return res.status(400).json({
        success: false,
        message: "Both Title and Message are required.",
      });
    }

    let resolvedUserId = null;
    let resolvedUserName = null;

    if (target === "user") {
      const rawQuery = String(b.user_id || b.user_query || "").trim();
      if (!rawQuery) {
        return res.status(400).json({
          success: false,
          message: "Enter User ID, Email, or Name for personal notification.",
        });
      }
      let userDoc = null;
      const numId = Number(rawQuery.replace(/^#/, ""));
      if (col.users) {
        if (Number.isFinite(numId) && numId > 0) {
          userDoc = await col.users.findOne({ id: numId });
        }
        if (!userDoc) {
          const esc = rawQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          userDoc = await col.users.findOne({
            $or: [
              { email: { $regex: new RegExp("^" + esc + "$", "i") } },
              { name: { $regex: new RegExp(esc, "i") } },
            ],
          });
        }
      }
      if (!userDoc) {
        return res.status(404).json({
          success: false,
          message: `User "${rawQuery}" not found.`,
        });
      }
      resolvedUserId = userDoc.id;
      resolvedUserName = userDoc.name || userDoc.email || `User #${userDoc.id}`;
    }

    const created = pushNotification({
      target,
      user_id: resolvedUserId,
      user_name: resolvedUserName,
      type: target === "all" ? "broadcast" : "direct",
      title,
      message,
      image_url: imageUrl,
      action_url: actionUrl,
      action_label: actionLabel,
    });

    res.json({
      success: true,
      message:
        target === "all"
          ? "Broadcast notification sent to ALL users!"
          : `Notification sent to ${resolvedUserName} (#${resolvedUserId})!`,
      notification: created,
      notifications: notificationsList.slice(0, 100),
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.post("/admin/notifications/templates", (req, res) => {
  try {
    const b = req.body || {};
    if (typeof b.plan_active_title === "string" && b.plan_active_title.trim()) {
      adminSettings.notif_plan_active_title = b.plan_active_title.trim().slice(0, 140);
    }
    if (typeof b.plan_active_body === "string" && b.plan_active_body.trim()) {
      adminSettings.notif_plan_active_body = b.plan_active_body.trim().slice(0, 1200);
    }
    if (typeof b.plan_active_image === "string") {
      adminSettings.notif_plan_active_image = b.plan_active_image.trim();
    }
    if (typeof b.plan_expired_title === "string" && b.plan_expired_title.trim()) {
      adminSettings.notif_plan_expired_title = b.plan_expired_title.trim().slice(0, 140);
    }
    if (typeof b.plan_expired_body === "string" && b.plan_expired_body.trim()) {
      adminSettings.notif_plan_expired_body = b.plan_expired_body.trim().slice(0, 1200);
    }
    if (typeof b.plan_expired_image === "string") {
      adminSettings.notif_plan_expired_image = b.plan_expired_image.trim();
    }
    saveAdminSettings();
    res.json({
      success: true,
      message: "Auto Plan Active & Plan Expired notification templates saved!",
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.post("/admin/notifications/delete", (req, res) => {
  try {
    const id = String((req.body && req.body.id) || "").trim();
    if (!id) {
      return res.status(400).json({ success: false, message: "Notification ID required" });
    }
    if (id === "ALL") {
      notificationsList = [];
    } else {
      notificationsList = notificationsList.filter((n) => n && String(n.id) !== id);
    }
    saveNotificationsStore();
    res.json({
      success: true,
      message: id === "ALL" ? "All notifications cleared!" : "Notification deleted!",
      notifications: notificationsList.slice(0, 100),
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
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

    console.log(`   History VPS: ${WINGO_HISTORY_URL}`);
    console.log(`   VPS auth: ${VPS_SECRET ? "enabled" : "MISSING — set VPS_SECRET"}`);
    console.log(`   Data store: none on Render (proxy → orihost only)`);

    // Load payments.json + sync with MongoDB + mark stale PENDING → EXPIRED (BE-7)
    try {
      loadPaymentsFromDisk();
      syncPaymentsAndSettingsFromMongo()
        .then(() => {
          expireStaleOrders();
          sweepExpiredProUsers().catch(() => {});
          console.log(`   Payments synced (Mongo + disk): ${getPayments().length} record(s)`);
        })
        .catch((e) => console.warn("mongo payments sync:", e.message));
      expireStaleOrders();
    } catch (e) {
      console.error("startup payments:", e.message);
    }

    // Periodic: expire PENDING orders + check expired Pro subscriptions
    setInterval(() => {
      try {
        expireStaleOrders();
        sweepExpiredProUsers().catch(() => {});
      } catch (e) {
        console.error("maintenance:", e.message);
      }
    }, 60 * 1000);

    // Prefer long-polling for Approve/Deny reliability on changing tunnels
    if (TELEGRAM_BOT_TOKEN) {
      console.log("   Telegram admin bot token: configured");
      console.log(`   Telegram admin chat: ${TELEGRAM_ADMIN_CHAT_ID || "MISSING"}`);
      telegramApi("deleteWebhook", { drop_pending_updates: false })
        .then(async () => {
          const me = await telegramApi("getMe", {});
          if (me && me.ok) {
            console.log(`   Telegram bot: @${me.result.username} online`);
          } else {
            console.error("   Telegram getMe failed:", JSON.stringify(me));
          }
          if (TELEGRAM_ADMIN_CHAT_ID) {
            const ping = await telegramApi("sendMessage", {
              chat_id: TELEGRAM_ADMIN_CHAT_ID,
              text: "🐉 DRAGO payment bot online\nApprove/Deny ready.",
            });
            if (ping && ping.ok) {
              console.log("   Telegram: admin ping OK");
            } else {
              console.error(
                "   Telegram admin ping FAILED — check TELEGRAM_ADMIN_CHAT_ID:",
                JSON.stringify(ping)
              );
            }
          } else {
            console.warn("   Telegram: set TELEGRAM_ADMIN_CHAT_ID to receive payment alerts");
          }
          console.log("   Telegram: long-polling enabled (Approve/Deny)");
          const loop = async () => {
            await pollTelegramUpdates();
            setTimeout(loop, 400);
          };
          loop();
        })
        .catch((e) => console.error("Telegram boot:", e.message));
    } else {
      console.warn("   Telegram: TELEGRAM_BOT_TOKEN not set — payment alerts disabled");
    }
  });
}

boot().catch((e) => {
  console.error("boot failed:", e);
  process.exit(1);
});

// Deploy refresh: 2026-10-08T03:04:34Z
