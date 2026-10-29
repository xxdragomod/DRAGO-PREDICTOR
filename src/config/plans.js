
const { adminSettings } = require("../state/adminSettings");
function resolveValidQrUrl(rawUrl, fallbackUrl) {
  const u = String(rawUrl || "").trim();
  if (!u) return fallbackUrl;
  // Reject non-direct ImgBB page URLs (https://ibb.co/...) or expired ImgBB assets
  if (
    /^https?:\/\/(www\.)?ibb\.co\//i.test(u) ||
    /dc0e2bd33bc2|47c3bf9c834f|spLnbMnw|Ngw5tH5j|ZzZvmHB2|5h7CFYrK|upipe-qr/i.test(u)
  ) {
    return fallbackUrl;
  }
  return u;
}
const PLAN_CATALOG = {
  weekly: {
    get name() {
      return (adminSettings && adminSettings.weekly_name) || "PRO VIP WEEKLY";
    },
    get amount() {
      const v = Number(adminSettings && adminSettings.weekly_amount);
      return Number.isFinite(v) && v >= 1 ? v : 749;
    },
    get days() {
      const v = Number(adminSettings && adminSettings.weekly_days);
      return Number.isFinite(v) && v >= 1 ? v : 7;
    },
    get qr_url() {
      const raw =
        (adminSettings && adminSettings.weekly_qr_url) ||
        process.env.QR_URL_749 ||
        process.env.QR_URL_300 ||
        process.env.QR_URL_500 ||
        "";
      return resolveValidQrUrl(
        raw,
        "https://dragopredictor.vercel.app/assets/upi/qr-weekly.png"
      );
    },
  },
  monthly: {
    get name() {
      return (adminSettings && adminSettings.monthly_name) || "PRO VIP MONTHLY";
    },
    get amount() {
      const v = Number(adminSettings && adminSettings.monthly_amount);
      return Number.isFinite(v) && v >= 1 ? v : 1498;
    },
    get days() {
      const v = Number(adminSettings && adminSettings.monthly_days);
      return Number.isFinite(v) && v >= 1 ? v : 30;
    },
    get qr_url() {
      const raw =
        (adminSettings && adminSettings.monthly_qr_url) ||
        process.env.QR_URL_1498 ||
        process.env.QR_URL_900 ||
        "";
      return resolveValidQrUrl(
        raw,
        "https://dragopredictor.vercel.app/assets/upi/qr-monthly.png"
      );
    },
  },
  test: {
    get name() {
      return PLAN_CATALOG.weekly.name;
    },
    get amount() {
      return PLAN_CATALOG.weekly.amount;
    },
    get days() {
      return PLAN_CATALOG.weekly.days;
    },
    get qr_url() {
      return PLAN_CATALOG.weekly.qr_url;
    },
  },
  beginners: {
    get name() {
      return PLAN_CATALOG.weekly.name;
    },
    get amount() {
      return PLAN_CATALOG.weekly.amount;
    },
    get days() {
      return PLAN_CATALOG.weekly.days;
    },
    get qr_url() {
      return PLAN_CATALOG.weekly.qr_url;
    },
  },
  profit: {
    get name() {
      return PLAN_CATALOG.monthly.name;
    },
    get amount() {
      return PLAN_CATALOG.monthly.amount;
    },
    get days() {
      return PLAN_CATALOG.monthly.days;
    },
    get qr_url() {
      return PLAN_CATALOG.monthly.qr_url;
    },
  },
};

module.exports = { PLAN_CATALOG, resolveValidQrUrl };
