/**
 * Default admin settings (leaf module — no deps)
 *
 * Auto-split from the original monolithic server.js — behaviour unchanged.
 * Original lines: 1269-1269, 1270-1307
 */

const path = require("path");

const { APP_ROOT } = require("../config");

const ADMIN_SETTINGS_PATH = path.join(APP_ROOT, "admin-settings.json");

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

module.exports = {
  ADMIN_SETTINGS_PATH,
  DEFAULT_ADMIN_SETTINGS,
};

require("../lib/lazy").register(module.exports);
