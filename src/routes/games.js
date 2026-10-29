const express = require("express");
const router = express.Router();


const { dbFindGame, dbListGames } = require("../db/games");
router.get("/games", async (_req, res) => {
  try {
    const rows = await dbListGames();
    res.json({ success: true, games: rows });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.get("/games/:id", async (req, res) => {
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

module.exports = { router };
