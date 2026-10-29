require("./loadEnv");
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



// ─── Admin panel + Telegram free-plan / webhook secrets ───
const VAPID_PUBLIC_KEY = String(process.env.VAPID_PUBLIC_KEY || "").trim();
const VAPID_PRIVATE_KEY = String(process.env.VAPID_PRIVATE_KEY || "").trim();
const ADMIN_PANEL_KEY = String(process.env.ADMIN_PANEL_KEY || "").trim();
const TG_BOT_TOKEN = String(process.env.TELEGRAM_FREE_BOT_TOKEN || "").trim();
const TG_CHANNEL_ID = String(process.env.TG_CHANNEL_ID || "-1002782160527").trim();
const TG_OWNER_CHAT = String(process.env.TG_OWNER_CHAT || "6656009938").trim();
const TG_CHANNEL_LINK = String(process.env.TG_JOIN_LINK || "https://t.me/+AWev-BNeAz9jZTQ1").trim();
const TG_FREE_SECRET = String(process.env.TG_FREE_SECRET || "").trim();
const TG_WEBHOOK_SECRET = String(process.env.TELEGRAM_WEBHOOK_SECRET || "").trim();

module.exports = { ADMIN_PANEL_KEY, ALLOWED_WEB_DOMAIN, APP_ID, APP_ID_PREV, APP_SECRET, APP_SECRET_PREV, FRONTEND_URL, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, JWT_EXPIRES_IN, JWT_SECRET, MONGODB_URI, PAYMENT_TTL_MS, PORT, PUBLIC_BASE_URL, RUPAYEX_API_BASE, RUPAYEX_API_TOKEN, SIGNATURE_MAX_SKEW_MS, TELEGRAM_ADMIN_CHAT_ID, TELEGRAM_BOT_TOKEN, TELEGRAM_GROUP_BOT_TOKEN, TELEGRAM_REPORT_GROUP_ID, TG_BOT_TOKEN, TG_CHANNEL_ID, TG_CHANNEL_LINK, TG_FREE_SECRET, TG_OWNER_CHAT, TG_WEBHOOK_SECRET, UPI_ID, VAPID_PRIVATE_KEY, VAPID_PUBLIC_KEY, VPS_SECRET, WINGO_HISTORY_URL, WINGO_PREDICTION_URL };
