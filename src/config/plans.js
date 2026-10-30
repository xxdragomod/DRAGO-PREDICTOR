
const {
  PLAN_MONTHLY_AMOUNT,
  PLAN_MONTHLY_DAYS,
  PLAN_MONTHLY_NAME,
  PLAN_WEEKLY_AMOUNT,
  PLAN_WEEKLY_DAYS,
  PLAN_WEEKLY_NAME,
  QR_FALLBACK_MONTHLY_URL,
  QR_FALLBACK_WEEKLY_URL,
  QR_REJECT_PATTERN,
  QR_URL_1498,
  QR_URL_749,
} = require("./env");
const { adminSettings } = require("../state/adminSettings");
function resolveValidQrUrl(rawUrl, fallbackUrl) {
  const u = String(rawUrl || "").trim();
  if (!u) return fallbackUrl;
  // Reject non-direct ImgBB page URLs (https://ibb.co/...) or expired ImgBB assets
  const rejectRx = QR_REJECT_PATTERN ? new RegExp(QR_REJECT_PATTERN, "i") : null;
  if (
    /^https?:\/\/(www\.)?ibb\.co\//i.test(u) ||
    (rejectRx && rejectRx.test(u))
  ) {
    return fallbackUrl;
  }
  return u;
}
const PLAN_CATALOG = {
  weekly: {
    get name() {
      return (adminSettings && adminSettings.weekly_name) || PLAN_WEEKLY_NAME;
    },
    get amount() {
      const v = Number(adminSettings && adminSettings.weekly_amount);
      return Number.isFinite(v) && v >= 1 ? v : PLAN_WEEKLY_AMOUNT;
    },
    get days() {
      const v = Number(adminSettings && adminSettings.weekly_days);
      return Number.isFinite(v) && v >= 1 ? v : PLAN_WEEKLY_DAYS;
    },
    get qr_url() {
      const raw = (adminSettings && adminSettings.weekly_qr_url) || QR_URL_749 || "";
      return resolveValidQrUrl(raw, QR_FALLBACK_WEEKLY_URL);
    },
  },
  monthly: {
    get name() {
      return (adminSettings && adminSettings.monthly_name) || PLAN_MONTHLY_NAME;
    },
    get amount() {
      const v = Number(adminSettings && adminSettings.monthly_amount);
      return Number.isFinite(v) && v >= 1 ? v : PLAN_MONTHLY_AMOUNT;
    },
    get days() {
      const v = Number(adminSettings && adminSettings.monthly_days);
      return Number.isFinite(v) && v >= 1 ? v : PLAN_MONTHLY_DAYS;
    },
    get qr_url() {
      const raw = (adminSettings && adminSettings.monthly_qr_url) || QR_URL_1498 || "";
      return resolveValidQrUrl(raw, QR_FALLBACK_MONTHLY_URL);
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
