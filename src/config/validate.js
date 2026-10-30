/**
 * Fail closed: required values must be provisioned out of band (Render env).
 * Koi silent fallback nahi — galat chat / UPI / VPS use hone se pehle boot ruk jaayega.
 */
const {
  ADMIN_PANEL_KEY,
  ALLOWED_WEB_DOMAIN,
  APP_ID,
  APP_SECRET,
  FRONTEND_URL,
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  JWT_SECRET,
  MONGODB_URI,
  RUPAYEX_API_BASE,
  SUPPORT_EMAIL,
  TELEGRAM_ADMIN_CHAT_ID,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_REPORT_GROUP_ID,
  TG_BOT_TOKEN,
  TG_CHANNEL_ID,
  TG_CHANNEL_LINK,
  TG_FREE_SECRET,
  TG_OWNER_CHAT,
  TG_WEBHOOK_SECRET,
  UPI_ID,
  VAPID_PRIVATE_KEY,
  VAPID_PUBLIC_KEY,
  VPS_SECRET,
  WINGO_HISTORY_URL,
  WINGO_PREDICTION_URL,
} = require("./env");
const { webPush } = require("../state/webPush");

function validateEnv() {
  const missing = []; // boot rokne wale
  const warnings = []; // optional features

  // ── core ──
  if (!MONGODB_URI) missing.push("MONGODB_URI");
  if (!JWT_SECRET) missing.push("JWT_SECRET");
  else if (JWT_SECRET.length < 32) missing.push("JWT_SECRET (32+ chars)");
  if (!GOOGLE_CLIENT_ID) missing.push("GOOGLE_CLIENT_ID");
  if (!GOOGLE_CLIENT_SECRET) missing.push("GOOGLE_CLIENT_SECRET");
  if (!APP_ID) missing.push("APP_ID");
  if (!APP_SECRET) missing.push("APP_SECRET");
  else if (APP_SECRET.length < 32) missing.push("APP_SECRET (32+ chars)");

  // ── public urls ──
  if (!FRONTEND_URL) missing.push("FRONTEND_URL");
  if (!ALLOWED_WEB_DOMAIN) missing.push("ALLOWED_WEB_DOMAIN (ya FRONTEND_URL se derive hoga)");

  // ── upstream VPS ──
  if (!WINGO_PREDICTION_URL) missing.push("WINGO_PREDICTION_URL");
  if (!WINGO_HISTORY_URL) missing.push("WINGO_HISTORY_URL");
  if (!VPS_SECRET) missing.push("VPS_SECRET");
  else if (VPS_SECRET.length < 32) missing.push("VPS_SECRET (32+ chars)");

  // ── payments ──
  if (!UPI_ID) missing.push("UPI_ID");
  if (!RUPAYEX_API_BASE) missing.push("RUPAYEX_API_BASE");

  // ── telegram (core notification path) ──
  if (!TELEGRAM_BOT_TOKEN) missing.push("TELEGRAM_ADMIN_BOT_TOKEN");
  if (!TELEGRAM_ADMIN_CHAT_ID) missing.push("TELEGRAM_ADMIN_CHAT_ID");
  if (!TELEGRAM_REPORT_GROUP_ID) missing.push("TELEGRAM_REPORT_GROUP_ID");

  // ── admin + push ──
  if (!ADMIN_PANEL_KEY) missing.push("ADMIN_PANEL_KEY");
  else if (ADMIN_PANEL_KEY.length < 32) missing.push("ADMIN_PANEL_KEY (32+ chars)");
  if (webPush && (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY)) {
    missing.push("VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY");
  }
  if (webPush && !SUPPORT_EMAIL) warnings.push("SUPPORT_EMAIL (VAPID contact)");

  // ── free-plan bot (optional feature) ──
  if (!TG_BOT_TOKEN) warnings.push("TELEGRAM_FREE_BOT_TOKEN (free-plan bot disabled)");
  if (TG_BOT_TOKEN && !TG_CHANNEL_ID) warnings.push("TG_CHANNEL_ID (free-plan channel check disabled)");
  if (TG_BOT_TOKEN && !TG_CHANNEL_LINK) warnings.push("TG_JOIN_LINK (join button disabled)");
  if (TG_BOT_TOKEN && !TG_OWNER_CHAT) warnings.push("TG_OWNER_CHAT (owner alerts disabled)");
  if (TG_FREE_SECRET && TG_FREE_SECRET.length < 32) warnings.push("TG_FREE_SECRET (32+ chars)");
  if (TG_WEBHOOK_SECRET && TG_WEBHOOK_SECRET.length < 32) {
    warnings.push("TELEGRAM_WEBHOOK_SECRET (32+ chars)");
  }

  if (warnings.length) {
    console.warn("⚠️  Optional env not set:", warnings.join(", "));
  }

  if (missing.length) {
    console.error("❌ Missing required environment variables:");
    for (const m of missing) console.error("   • " + m);
    console.error("   (values .env.example me documented hain)");
    process.exit(1);
  }
}

module.exports = { validateEnv };
