const { UPI_ID } = require("../config/env");
const { kvGet, kvSet } = require("../db/store");
const DEFAULT_ADMIN_SETTINGS = {
  google_auth_enabled: true,
  auto_payment_enabled: true, // Rupayex gateway
  manual_payment_enabled: true, // QR + UTR
  guard_enabled: true, // DevTools detect/block (frontend guard)
  force_feedback: false, // "Bug in app" ON → sab users ko popup har visit pe
  force_rate: false, // "Rate in app" ON → sab users ko rating popup
  force_winfb: false, // "Feedback in app" ON → 20+ wins wale users ko feedback popup
  free_pred_limit: 3,
  free_api_history_limit: 10,
  free_nexus_limit: 3,
  weekly_name: "PRO VIP WEEKLY",
  weekly_amount: 749,
  weekly_days: 7,
  weekly_qr_url: "",
  monthly_name: "PRO VIP MONTHLY",
  monthly_amount: 1498,
  monthly_days: 30,
  monthly_qr_url: "",
  upi_id: "",
  notif_plan_active_title: "💎 Pro VIP Plan Activated!",
  notif_plan_active_body:
    "Congratulations {name}! Your {plan} ({days} Days) VIP subscription is now active until {expiry}. Enjoy Unlimited AI Predictions, NEXUS Agent & Floating Game Window!",
  notif_plan_active_image: "",
  notif_plan_expired_title: "⚠️ Your Pro VIP Plan Has Expired!",
  notif_plan_expired_body:
    "Hello {name}, your Pro VIP subscription expired on {expiry}. Renew your VIP plan now to continue enjoying unlimited AI predictions and premium features!",
  notif_plan_expired_image: "",
  banners: [
    {
      id: "default_rx1",
      title: "DRAGO Predictor RX1 Model",
      image_url: "/assets/images/banners/rx1-model-feature.webp",
      link_url: "/prediction/",
      active: true,
    },
  ],
};
const adminSettings = { ...DEFAULT_ADMIN_SETTINGS };

/** Replace all settings in place so the shared object identity never changes.
 *  Same semantics as the old `adminSettings = {...}` reassignment, but safe across modules. */
function replaceAdminSettings(next) {
  for (const key of Object.keys(adminSettings)) delete adminSettings[key];
  Object.assign(adminSettings, next || {});
}

function getActiveUpiId() {
  return (adminSettings && adminSettings.upi_id && String(adminSettings.upi_id).trim()) || UPI_ID;
}

function getActiveBanners() {
  const list = Array.isArray(adminSettings && adminSettings.banners)
    ? adminSettings.banners.filter((b) => b && b.image_url && b.active !== false)
    : [];
  if (list.length > 0) return list;
  return DEFAULT_ADMIN_SETTINGS.banners;
}
/** Load runtime settings from MongoDB (called once at boot, before listen). */
async function hydrateAdminSettings() {
  const stored = await kvGet("admin_settings");
  if (stored && typeof stored === "object") {
    replaceAdminSettings({ ...DEFAULT_ADMIN_SETTINGS, ...stored });
  } else {
    // First boot on a fresh database — seed the defaults.
    replaceAdminSettings({ ...DEFAULT_ADMIN_SETTINGS });
    await kvSet("admin_settings", { ...adminSettings });
  }
}
/** Persist runtime settings to MongoDB. Returns the pending write promise. */
function saveAdminSettings() {
  return kvSet("admin_settings", { ...adminSettings });
}
function freePredLimit() {
  const n = Number(adminSettings.free_pred_limit);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 3;
}
function freeApiHistoryLimit() {
  const n = Number(adminSettings.free_api_history_limit);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 10;
}
function freeNexusLimit() {
  const n = Number(adminSettings.free_nexus_limit);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 3;
}

module.exports = { DEFAULT_ADMIN_SETTINGS, adminSettings, freeApiHistoryLimit, freeNexusLimit, freePredLimit, getActiveBanners, getActiveUpiId, hydrateAdminSettings, replaceAdminSettings, saveAdminSettings };
