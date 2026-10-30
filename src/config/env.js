/**
 * Central configuration — har value env se aati hai.
 *
 * Do categories:
 *   1. DEPLOYMENT VALUES (URLs, chat ids, UPI, VPS, images, brand)
 *      → koi hardcoded fallback nahi. Missing = boot fail (validate.js).
 *        Isse galti se galat chat/UPI/VPS use nahi hoga.
 *   2. TUNING CONSTANTS (TTL, rate limits, prefixes)
 *      → env se override ho sakte hain; default yahan documented hai.
 *
 * .env.example me har variable ka sample hai.
 */
require("./loadEnv");

// ─── helpers ────────────────────────────────────────────────────────────────
function str(name, fallback = "") {
  const v = process.env[name];
  return String(v === undefined || v === null ? fallback : v).trim();
}
function num(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}
function bool(name, fallback = false) {
  const v = String(process.env[name] || "").trim().toLowerCase();
  if (!v) return fallback;
  return v === "1" || v === "true" || v === "yes" || v === "on";
}
/** Comma-separated env → array */
function list(name, fallback = []) {
  const raw = str(name);
  if (!raw) return fallback;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
/** URL without trailing slash */
function url(name, fallback = "") {
  return str(name, fallback).replace(/\/+$/, "");
}

// ─── server ─────────────────────────────────────────────────────────────────
const NODE_ENV = str("NODE_ENV", "development");
const IS_PRODUCTION = NODE_ENV === "production";
const PORT = num("PORT", 3000);

// ─── public URLs & origins ──────────────────────────────────────────────────
// FRONTEND_URL har jagah use hota hai (OAuth redirect, CORS, QR images, push icons).
const FRONTEND_URL = url("FRONTEND_URL");

/** Bare hostname allowed for browser requests. Default: FRONTEND_URL ka host. */
const ALLOWED_WEB_DOMAIN = (() => {
  const explicit = str("ALLOWED_WEB_DOMAIN")
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
  if (explicit) return explicit;
  try {
    return new URL(FRONTEND_URL).hostname.toLowerCase();
  } catch (_) {
    return "";
  }
})();

/** Optional: fixed public base for uploaded image URLs (warna request se detect). */
const PUBLIC_BASE_URL = url("PUBLIC_BASE_URL");

/** Extra browser origins (comma-separated), e.g. a second frontend domain. */
const CORS_EXTRA_ORIGINS = list("CORS_EXTRA_ORIGINS");

/** Local dev origins — sirf tab lagte hain jab NODE_ENV production na ho. */
const DEV_ORIGINS = list("DEV_ORIGINS", [
  "http://localhost:3000",
  "http://localhost:5173",
  "http://127.0.0.1:3000",
]);

// ─── branding & assets ──────────────────────────────────────────────────────
const BRAND_NAME = str("BRAND_NAME", "DRAGO Predictor");
const BRAND_EMOJI = str("BRAND_EMOJI", "🐉");
/** GET / health message me brand ka short label */
const API_STATUS_LABEL = str("API_STATUS_LABEL", "DRAGO");
const SUPPORT_EMAIL = str("SUPPORT_EMAIL");

// Default banner (image + links) — admin panel se override ho sakta hai
const DEFAULT_BANNER_IMAGE = str("DEFAULT_BANNER_IMAGE");
const DEFAULT_BANNER_TITLE = str("DEFAULT_BANNER_TITLE", `${BRAND_NAME} RX1 Model`);
const DEFAULT_BANNER_LINK = str("DEFAULT_BANNER_LINK", "/prediction/");

// QR fallback images (jab admin settings aur QR_URL_* dono khaali hon)
const QR_FALLBACK_WEEKLY_URL = str("QR_FALLBACK_WEEKLY_URL");
const QR_FALLBACK_MONTHLY_URL = str("QR_FALLBACK_MONTHLY_URL");

// Legacy/expired QR asset ids jinke URL reject karne hain (regex, '|' separated)
const QR_REJECT_PATTERN = str("QR_REJECT_PATTERN");

// Push notification icon/badge
const PUSH_ICON_PATH = str("PUSH_ICON_PATH", "/favicon-192.png");
const PUSH_ICON_VERSION = str("PUSH_ICON_VERSION");

// ─── plans (defaults; admin panel se runtime override) ──────────────────────
const PLAN_WEEKLY_NAME = str("PLAN_WEEKLY_NAME", "PRO VIP WEEKLY");
const PLAN_WEEKLY_AMOUNT = num("PLAN_WEEKLY_AMOUNT", 749);
const PLAN_WEEKLY_DAYS = num("PLAN_WEEKLY_DAYS", 7);
const PLAN_MONTHLY_NAME = str("PLAN_MONTHLY_NAME", "PRO VIP MONTHLY");
const PLAN_MONTHLY_AMOUNT = num("PLAN_MONTHLY_AMOUNT", 1498);
const PLAN_MONTHLY_DAYS = num("PLAN_MONTHLY_DAYS", 30);

// Free-tier limits (defaults; admin panel se runtime override)
const FREE_PRED_LIMIT = num("FREE_PRED_LIMIT", 3);
const FREE_API_HISTORY_LIMIT = num("FREE_API_HISTORY_LIMIT", 10);
const FREE_NEXUS_LIMIT = num("FREE_NEXUS_LIMIT", 3);

// ─── auth ───────────────────────────────────────────────────────────────────
const GOOGLE_CLIENT_ID = str("GOOGLE_CLIENT_ID");
const GOOGLE_CLIENT_SECRET = str("GOOGLE_CLIENT_SECRET");
const JWT_SECRET = str("JWT_SECRET");
const JWT_EXPIRES_IN = str("JWT_EXPIRES_IN", "24h");
const APP_ID = str("APP_ID", str("DRAGO_APP_ID"));
const APP_SECRET = str("APP_SECRET", str("DRAGO_APP_SECRET"));
const APP_ID_PREV = str("APP_ID_PREV");
const APP_SECRET_PREV = str("APP_SECRET_PREV");

// ─── upstream prediction/history VPS ────────────────────────────────────────
const WINGO_PREDICTION_URL = url("WINGO_PREDICTION_URL");
const WINGO_HISTORY_URL = url("WINGO_HISTORY_URL");
const VPS_SECRET = str("VPS_SECRET", str("DRAGO_VPS_SECRET"));
const WINGO_HISTORY_MAX = num("WINGO_HISTORY_MAX", 10000);
const MARKET_CACHE_TTL_MS = num("MARKET_CACHE_TTL_MS", 2000);

// ─── payments ───────────────────────────────────────────────────────────────
const UPI_ID = str("UPI_ID");
const PAYMENT_TTL_MS = num("PAYMENT_TTL_MS", 10 * 60 * 1000);
const RUPAYEX_API_BASE = url("RUPAYEX_API_BASE");
const RUPAYEX_API_TOKEN = str("RUPAYEX_API_TOKEN");
const ORDER_ID_PREFIX = str("ORDER_ID_PREFIX", "DRAGO");
const QR_URL_749 = str("QR_URL_749", str("QR_URL_300"));
const QR_URL_1498 = str("QR_URL_1498", str("QR_URL_900"));

// ─── database ───────────────────────────────────────────────────────────────
const MONGODB_URI = str("MONGODB_URI");
const MONGODB_DB = str("MONGODB_DB");

// ─── telegram ───────────────────────────────────────────────────────────────
const TELEGRAM_BOT_TOKEN = str("TELEGRAM_ADMIN_BOT_TOKEN", str("TELEGRAM_BOT_TOKEN"));
const TELEGRAM_GROUP_BOT_TOKEN = str(
  "TELEGRAM_GROUP_BOT_TOKEN",
  str("TELEGRAM_BOT_TOKEN", TELEGRAM_BOT_TOKEN)
);
const TELEGRAM_REPORT_GROUP_ID = str("TELEGRAM_REPORT_GROUP_ID");
const TELEGRAM_ADMIN_CHAT_ID = str("TELEGRAM_ADMIN_CHAT_ID");

// Free-plan verification bot
const TG_BOT_TOKEN = str("TELEGRAM_FREE_BOT_TOKEN");
const TG_CHANNEL_ID = str("TG_CHANNEL_ID");
const TG_OWNER_CHAT = str("TG_OWNER_CHAT");
const TG_CHANNEL_LINK = str("TG_JOIN_LINK");
const TG_BOT_USERNAME = str("TG_BOT_USERNAME");
const TG_FREE_SECRET = str("TG_FREE_SECRET");
const TG_WEBHOOK_SECRET = str("TELEGRAM_WEBHOOK_SECRET");

// ─── security / rate limits / prefixes ──────────────────────────────────────
const ADMIN_PANEL_KEY = str("ADMIN_PANEL_KEY");
const VAPID_PUBLIC_KEY = str("VAPID_PUBLIC_KEY");
const VAPID_PRIVATE_KEY = str("VAPID_PRIVATE_KEY");
const IMGBB_API_KEY = str("IMGBB_API_KEY", str("IMGBB_KEY"));

/** Server-side telemetry salt (frontend ke saath shared, non-blocking signal). */
const SHIELD_SALT = str("SHIELD_SALT", "DRAGO_SHIELD_V2_8kq2");
const SIGNATURE_MAX_SKEW_MS = num("SIGNATURE_MAX_SKEW_MS", 120000);
const NONCE_TTL_MS = num("NONCE_TTL_MS", 5 * 60 * 1000);
const OAUTH_STATE_TTL_MS = num("OAUTH_STATE_TTL_MS", 10 * 60 * 1000);
const RATE_LIMIT_PER_IP = num("RATE_LIMIT_PER_IP", 240);
const RATE_LIMIT_WINDOW_MS = num("RATE_LIMIT_WINDOW_MS", 60000);
const API_RATE_LIMIT = num("API_RATE_LIMIT", 20);
const API_RATE_WINDOW_MS = num("API_RATE_WINDOW_MS", 60 * 1000);
const API_KEY_LIMIT = num("API_KEY_LIMIT", 5);
const API_KEY_PREFIX = str("API_KEY_PREFIX", "drago_");
const JSON_BODY_LIMIT = str("JSON_BODY_LIMIT", "256kb");
const JSON_UPLOAD_LIMIT = str("JSON_UPLOAD_LIMIT", "8mb");
const UPLOAD_MAX_BYTES = num("UPLOAD_MAX_BYTES", 6 * 1024 * 1024);

module.exports = {
  ADMIN_PANEL_KEY,
  ALLOWED_WEB_DOMAIN,
  API_KEY_LIMIT,
  API_KEY_PREFIX,
  API_RATE_LIMIT,
  API_RATE_WINDOW_MS,
  APP_ID,
  APP_ID_PREV,
  APP_SECRET,
  API_STATUS_LABEL,
  APP_SECRET_PREV,
  BRAND_EMOJI,
  BRAND_NAME,
  CORS_EXTRA_ORIGINS,
  DEFAULT_BANNER_IMAGE,
  DEFAULT_BANNER_LINK,
  DEFAULT_BANNER_TITLE,
  DEV_ORIGINS,
  FREE_API_HISTORY_LIMIT,
  FREE_NEXUS_LIMIT,
  FREE_PRED_LIMIT,
  FRONTEND_URL,
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  IMGBB_API_KEY,
  IS_PRODUCTION,
  JSON_BODY_LIMIT,
  JSON_UPLOAD_LIMIT,
  JWT_EXPIRES_IN,
  JWT_SECRET,
  MARKET_CACHE_TTL_MS,
  MONGODB_DB,
  MONGODB_URI,
  NODE_ENV,
  NONCE_TTL_MS,
  OAUTH_STATE_TTL_MS,
  ORDER_ID_PREFIX,
  PAYMENT_TTL_MS,
  PLAN_MONTHLY_AMOUNT,
  PLAN_MONTHLY_DAYS,
  PLAN_MONTHLY_NAME,
  PLAN_WEEKLY_AMOUNT,
  PLAN_WEEKLY_DAYS,
  PLAN_WEEKLY_NAME,
  PORT,
  PUBLIC_BASE_URL,
  PUSH_ICON_PATH,
  PUSH_ICON_VERSION,
  QR_FALLBACK_MONTHLY_URL,
  QR_FALLBACK_WEEKLY_URL,
  QR_REJECT_PATTERN,
  QR_URL_1498,
  QR_URL_749,
  RATE_LIMIT_PER_IP,
  RATE_LIMIT_WINDOW_MS,
  RUPAYEX_API_BASE,
  RUPAYEX_API_TOKEN,
  SHIELD_SALT,
  SIGNATURE_MAX_SKEW_MS,
  SUPPORT_EMAIL,
  TELEGRAM_ADMIN_CHAT_ID,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_GROUP_BOT_TOKEN,
  TELEGRAM_REPORT_GROUP_ID,
  TG_BOT_TOKEN,
  TG_BOT_USERNAME,
  TG_CHANNEL_ID,
  TG_CHANNEL_LINK,
  TG_FREE_SECRET,
  TG_OWNER_CHAT,
  TG_WEBHOOK_SECRET,
  UPLOAD_MAX_BYTES,
  UPI_ID,
  VAPID_PRIVATE_KEY,
  VAPID_PUBLIC_KEY,
  VPS_SECRET,
  WINGO_HISTORY_MAX,
  WINGO_HISTORY_URL,
  WINGO_PREDICTION_URL,
};
