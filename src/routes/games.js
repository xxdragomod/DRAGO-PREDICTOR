/**
 * Games routes
 *
 * Auto-split from the original monolithic server.js — behaviour unchanged.
 * Original lines: 5525-5555
 */


const { app } = require("../app");
const { dbFindGame, dbListGames } = require("../models/games");

/**
 * Public games list for game.html
 * GET /games
 * GET /games/:id
 */
app.get("/games", async (_req, res) => {
  try {
    const rows = await dbListGames();
    res.json({ success: true, games: rows });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.get("/games/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) {
    return res.status(400).json({ success: false, message: "Invalid id" });
  }
  const row = await dbFindGame(id);
  if (!row) {
    return res.status(404).json({ success: false, message: "Game not found" });
  }
  res.json({ success: true, game: row });
});

/* ─── Market data proxy (NO JWT) ─────────────────────────────────────────
 * Browser ko lottery API (draw.ar-lottery01.com) se direct CORS + Cloudflare
 * 403 milta hai, isliye frontend ka live market chart RENDER se proxy maangta hai.
 * GET /market/wingo30s/history?limit=30   →  { success, items, updated_at }
 * 10-sec in-memory cache se VPS pe load nahi padta (2s poll hone par bhi). */

module.exports = {};
