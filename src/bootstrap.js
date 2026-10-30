
const { app } = require("./app");
const { ALLOWED_WEB_DOMAIN, APP_ID, FRONTEND_URL, PORT, PUBLIC_BASE_URL, TELEGRAM_ADMIN_CHAT_ID, TELEGRAM_BOT_TOKEN, VPS_SECRET, WINGO_HISTORY_URL, WINGO_PREDICTION_URL } = require("./config/env");
const { flushWrites } = require("./db/store");
const { importLegacyJsonFiles } = require("./db/legacyJsonImport");
const { expireStaleOrders } = require("./services/payments");
const { hydrateStores } = require("./services/hydrate");
const { sweepExpiredProUsers } = require("./services/sweep");
const { telegramApi } = require("./services/telegramApi");
const { pollTelegramUpdates } = require("./services/telegramBot");
const { connectMongo } = require("./state/mongo");
// ─── Start ──────────────────────────────────────────────────────────────────
async function boot() {
  try {
    await connectMongo();
  } catch (e) {
    console.error("❌ MongoDB connect failed:", e.message);
    process.exit(1);
  }

  // MongoDB is the only data store: one-time JSON import (if old files exist),
  // then hydrate every in-memory cache BEFORE the server starts accepting traffic.
  try {
    await importLegacyJsonFiles();
    const stats = await hydrateStores();
    console.log(`✅ Stores hydrated from MongoDB (${stats.payments} order(s))`);
  } catch (e) {
    console.error("❌ Store hydration failed:", e.message);
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
    console.log(`   Data store: MongoDB only (no JSON files)`);

    // Mark stale PENDING orders → EXPIRED (BE-7)
    try {
      expireStaleOrders();
      sweepExpiredProUsers().catch(() => {});
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

// Flush queued Mongo writes on shutdown (Render sends SIGTERM on deploy/restart).
let shuttingDown = false;
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await flushWrites();
    } catch (_) {}
    process.exit(0);
  });
}

boot().catch((e) => {
  console.error("boot failed:", e);
  process.exit(1);
});

// Deploy refresh: 2026-10-08T03:04:34Z

module.exports = { boot };
