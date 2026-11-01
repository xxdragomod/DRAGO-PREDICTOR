/**
 * Games model
 *
 * Auto-split from the original monolithic server.js — behaviour unchanged.
 * Original lines: 1080-1132
 */


const { col, nextSeq } = require("../db/index");
const { mapGame } = require("./mappers");
const { pushNotification } = require("../notifications");

async function dbListGames() {
  const rows = await col.games
    .find({})
    .sort({ sort_order: 1, id: 1 })
    .toArray();
  return rows.map(mapGame);
}
async function dbFindGame(id) {
  return mapGame(await col.games.findOne({ id: Number(id) }));
}
async function dbInsertGame(name, imageUrl, linkUrl, sortOrder) {
  const id = await nextSeq("games");
  const doc = {
    id,
    name,
    image_url: imageUrl,
    link_url: linkUrl,
    sort_order: Number(sortOrder) || 0,
    created_at: new Date().toISOString(),
  };
  await col.games.insertOne(doc);

  // Automatically broadcast In-App + Web Push Notification to ALL users when a new game is added!
  try {
    pushNotification({
      target: "all",
      type: "new_game",
      title: `🎮 New Game Added: ${name}!`,
      message: `${name} is now live on DRAGO Predictor! Open the app now to play with real-time AI WinGo 30s predictions.`,
      image_url: imageUrl || null,
      action_url: "/game/",
      action_label: `PLAY ${String(name).toUpperCase().slice(0, 20)} →`,
    });
  } catch (e) {
    console.warn("dbInsertGame pushNotification:", e.message);
  }

  return { lastInsertRowid: id, id };
}
async function dbDeleteGame(id) {
  const r = await col.games.deleteOne({ id: Number(id) });
  return { changes: r.deletedCount || 0 };
}
async function dbMaxGameOrder() {
  const row = await col.games
    .find({})
    .sort({ sort_order: -1 })
    .limit(1)
    .project({ sort_order: 1 })
    .toArray();
  return { m: row[0] ? Number(row[0].sort_order) || 0 : 0 };
}

module.exports = {
  dbDeleteGame,
  dbFindGame,
  dbInsertGame,
  dbListGames,
  dbMaxGameOrder,
};

require("../lib/lazy").register(module.exports);
