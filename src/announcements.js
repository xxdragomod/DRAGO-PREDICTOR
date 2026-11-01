/**
 * Announcement store
 *
 * Auto-split from the original monolithic server.js — behaviour unchanged.
 * Original lines: 1604-1631
 */

const fs = require("fs");
const path = require("path");

const { col } = require("./db/index");
const { APP_ROOT } = require("./config");
const { setAnnouncement } = require("./state");

const ANNOUNCE_PATH = path.join(APP_ROOT, "announcement.json");

try {
  if (fs.existsSync(ANNOUNCE_PATH)) {
    setAnnouncement(JSON.parse(fs.readFileSync(ANNOUNCE_PATH, "utf8")) || null);
  }
} catch (e) {
  setAnnouncement(null);
}
function saveAnnouncement(a) {
  setAnnouncement(a);
  try {
    fs.writeFileSync(ANNOUNCE_PATH, JSON.stringify(a, null, 2), "utf8");
  } catch (e) {
    console.warn("announcement save:", e.message);
  }
  if (col.kv_store) {
    col.kv_store
      .updateOne(
        { _id: "announcement" },
        { $set: { value: a, updated_at: new Date().toISOString() } },
        { upsert: true }
      )
      .catch((err) => console.warn("mongo announcement save:", err.message));
  }
}

/* ── Built-in Persistent Image Hosting (MongoDB + RAM Cache + ImgBB fallback) ── */

module.exports = {
  ANNOUNCE_PATH,
  saveAnnouncement,
};

require("./lib/lazy").register(module.exports);
