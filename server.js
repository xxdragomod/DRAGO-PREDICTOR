/**
 * DRAGO Main API — Render
 * Frontend (Vercel) → this server → Orihost VPS (prediction + history)
 *
 * Entry point. Saara logic src/ ke modules me hai:
 *   src/config.js            env + startup guards
 *   src/app.js               express app + global middleware
 *   src/routes/*.js          68 route handlers (domain wise split)
 *   src/models/*.js          MongoDB models
 *   src/telegram/*.js        bot integrations
 *   src/boot.js              startup sequence
 *
 * Env: MONGODB_URI, JWT_SECRET, GOOGLE_*, APP_ID, APP_SECRET,
 *      WINGO_PREDICTION_URL, WINGO_HISTORY_URL, VPS_SECRET,
 *      TELEGRAM_*, FRONTEND_URL, ALLOWED_WEB_DOMAIN
 */

// 1. config sabse pehle — env guards yahin fail-fast karte hain
require("./src/config");

// 2. express app + global middleware (CORS, rate limit, security headers)
const { app } = require("./src/app");

// 3. saare routes register karo (order original server.js jaisa hi hai)
require("./src/routes");

// 4. boot: mongo connect, listen, telegram polling, maintenance timers
require("./src/boot");

module.exports = { app };
