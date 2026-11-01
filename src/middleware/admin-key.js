/**
 * Admin panel key gate
 *
 * Auto-split from the original monolithic server.js — behaviour unchanged.
 * Original lines: 6871-6901
 */


const { rateLimitUser } = require("../app");
const { timingSafeEqualStr } = require("./signature");
const { TELEGRAM_BOT_TOKEN } = require("../plans");
const { ADMIN_PANEL_KEY, TG_BOT_TOKEN, TG_FREE_SECRET, TG_WEBHOOK_SECRET, VAPID_PRIVATE_KEY, VAPID_PUBLIC_KEY, VPS_SECRET } = require("../config");
const { getWebPush } = require("../state");

const missingSecurityEnv = [];
if (!TELEGRAM_BOT_TOKEN) missingSecurityEnv.push("TELEGRAM_ADMIN_BOT_TOKEN");
if (!TG_BOT_TOKEN) missingSecurityEnv.push("TELEGRAM_FREE_BOT_TOKEN");
if (TG_FREE_SECRET.length < 32) missingSecurityEnv.push("TG_FREE_SECRET (32+ chars)");
if (TG_WEBHOOK_SECRET.length < 32) missingSecurityEnv.push("TELEGRAM_WEBHOOK_SECRET (32+ chars)");
if (ADMIN_PANEL_KEY.length < 32) missingSecurityEnv.push("ADMIN_PANEL_KEY (32+ chars)");
if (!VPS_SECRET || VPS_SECRET.length < 32) missingSecurityEnv.push("VPS_SECRET (32+ chars)");
if (getWebPush() && (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY)) {
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

module.exports = {
  missingSecurityEnv,
  requireAdminKey,
};

require("../lib/lazy").register(module.exports);
