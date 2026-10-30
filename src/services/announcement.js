
const { kvGet, kvSet } = require("../db/store");

/* ── Announcement broadcast (new game / feature popup) ── */
const announcementState = { value: null };
function getAnnouncement() {
  return announcementState.value;
}
function setAnnouncement(a) {
  announcementState.value = a;
}
/** Persist the current announcement to MongoDB. */
function saveAnnouncement(a) {
  setAnnouncement(a);
  return kvSet("announcement", a);
}

/** Load the announcement from MongoDB (boot). */
async function hydrateAnnouncement() {
  const stored = await kvGet("announcement");
  if (stored !== undefined) setAnnouncement(stored);
}

module.exports = { announcementState, getAnnouncement, hydrateAnnouncement, saveAnnouncement, setAnnouncement };
