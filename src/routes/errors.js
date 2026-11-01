/**
 * 404 + error handler
 *
 * Auto-split from the original monolithic server.js — behaviour unchanged.
 * Original lines: 7831-7840
 */


const { app } = require("../app");

app.use((_req, res) => {
  res.status(404).json({ success: false, message: "Not found" });
});

// Error handler
app.use((err, _req, res, _next) => {
  console.error("unhandled:", err.message);
  res.status(500).json({ success: false, message: "Internal server error" });
});

module.exports = {};
