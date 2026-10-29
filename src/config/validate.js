/**
 * Fail closed: required secrets must be provisioned out of band (Render env).
 * The process refuses to boot when any of them is missing or too short.
 */
const {
  ADMIN_PANEL_KEY,
  TELEGRAM_BOT_TOKEN,
  TG_BOT_TOKEN,
  TG_FREE_SECRET,
  TG_WEBHOOK_SECRET,
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY,
  VPS_SECRET,
} = require("./env");
const { webPush } = require("../state/webPush");

function validateSecurityEnv() {
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
}

module.exports = { validateSecurityEnv };
