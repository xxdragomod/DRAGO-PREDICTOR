/**
 * Root / meta routes
 *
 * Auto-split from the original monolithic server.js — behaviour unchanged.
 * Original lines: 4366-4381
 */


const { app } = require("../app");

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

module.exports = {};
