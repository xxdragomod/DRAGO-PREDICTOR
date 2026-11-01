/**
 * Startup sequence
 *
 * Auto-split from the original monolithic server.js — behaviour unchanged.
 * Original lines: 7841-7937
 */


const { app } = require("./app");
const { connectMongo } = require("./db/index");
const { sweepExpiredProUsers } = require("./notifications");
const { expireStaleOrders, getPayments, loadPaymentsFromDisk, syncPaymentsAndSettingsFromMongo } = require("./payments/store");
const { TELEGRAM_ADMIN_CHAT_ID, TELEGRAM_BOT_TOKEN } = require("./plans");
const { pollTelegramUpdates } = require("./telegram/admin-bot");
const { telegramApi } = require("./telegram/api");
const { ALLOWED_WEB_DOMAIN, APP_ID, FRONTEND_URL, PORT, PUBLIC_BASE_URL, VPS_SECRET, WINGO_HISTORY_URL, WINGO_PREDICTION_URL } = require("./config");

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

module.exports = {
  boot,
};

require("./lib/lazy").register(module.exports);
