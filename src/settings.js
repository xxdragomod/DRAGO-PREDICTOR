/**
 * Runtime admin settings + free limits
 *
 * Auto-split from the original monolithic server.js — behaviour unchanged.
 * Original lines: 1308-1322, 1813-1845, 1846-1864
 */

const fs = require("fs");

const { col } = require("./db/index");
const { UPI_ID } = require("./plans");
const { ADMIN_SETTINGS_PATH, DEFAULT_ADMIN_SETTINGS } = require("./settings/defaults");
const { getAdminSettings, setAdminSettings } = require("./state");

function getActiveUpiId() {
  return (getAdminSettings() && (getAdminSettings()).upi_id && String((getAdminSettings()).upi_id).trim()) || UPI_ID;
}

function getActiveBanners() {
  const list = Array.isArray(getAdminSettings() && (getAdminSettings()).banners)
    ? (getAdminSettings()).banners.filter((b) => b && b.image_url && b.active !== false)
    : [];
  if (list.length > 0) return list;
  return DEFAULT_ADMIN_SETTINGS.banners;
}

/* ── Web Push Notification Engine (VAPID + MongoDB/Local Store) ── */

function loadAdminSettings() {
  try {
    if (fs.existsSync(ADMIN_SETTINGS_PATH)) {
      const raw = JSON.parse(fs.readFileSync(ADMIN_SETTINGS_PATH, "utf8"));
      setAdminSettings({ ...DEFAULT_ADMIN_SETTINGS, ...(raw || {}) });
    }
  } catch (e) {
    console.warn("admin-settings load:", e.message);
    setAdminSettings({ ...DEFAULT_ADMIN_SETTINGS });
  }
}
function saveAdminSettings() {
  try {
    fs.writeFileSync(
      ADMIN_SETTINGS_PATH,
      JSON.stringify(getAdminSettings(), null, 2),
      "utf8"
    );
  } catch (e) {
    console.error("admin-settings save:", e.message);
  }
  if (col.kv_store) {
    col.kv_store
      .updateOne(
        { _id: "admin_settings" },
        { $set: { value: getAdminSettings(), updated_at: new Date().toISOString() } },
        { upsert: true }
      )
      .catch((err) => console.warn("mongo admin-settings save:", err.message));
  }
}
loadAdminSettings();


function freePredLimit() {
  const n = Number((getAdminSettings()).free_pred_limit);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 3;
}
function freeApiHistoryLimit() {
  const n = Number((getAdminSettings()).free_api_history_limit);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 10;
}
function freeNexusLimit() {
  const n = Number((getAdminSettings()).free_nexus_limit);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 3;
}
/** @deprecated use freePredLimit() / freeApiHistoryLimit() / freeNexusLimit() */
const FREE_PRED_LIMIT = 3;
const FREE_API_HISTORY_LIMIT = 10;
const FREE_NEXUS_LIMIT = 3;
const SERVER_BRAND = "🐉 DRAGO PREDICTOR";

/** Developer API rate limit: 20 requests / minute / user / endpoint */

module.exports = {
  FREE_API_HISTORY_LIMIT,
  FREE_NEXUS_LIMIT,
  FREE_PRED_LIMIT,
  SERVER_BRAND,
  freeApiHistoryLimit,
  freeNexusLimit,
  freePredLimit,
  getActiveBanners,
  getActiveUpiId,
  loadAdminSettings,
  saveAdminSettings,
};

require("./lib/lazy").register(module.exports);
