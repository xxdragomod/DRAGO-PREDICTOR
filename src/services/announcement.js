
const fs = require("fs");
const path = require("path");
const { col } = require("../state/mongo");

const { ROOT_DIR } = require("../config/paths");
/* ── Announcement broadcast (new game / feature popup) ── */
const ANNOUNCE_PATH = path.join(ROOT_DIR, "announcement.json");
const announcementState = { value: null };
try {
  if (fs.existsSync(ANNOUNCE_PATH)) {
    announcementState.value = JSON.parse(fs.readFileSync(ANNOUNCE_PATH, "utf8")) || null;
  }
} catch (e) {
  announcementState.value = null;
}
function getAnnouncement() {
  return announcementState.value;
}
function setAnnouncement(a) {
  announcementState.value = a;
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

module.exports = { ANNOUNCE_PATH, announcementState, getAnnouncement, saveAnnouncement, setAnnouncement };
