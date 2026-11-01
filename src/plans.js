/**
 * Plan catalog + pro activation
 *
 * Auto-split from the original monolithic server.js — behaviour unchanged.
 * Original lines: 67-189, 2434-2459
 */


const { col } = require("./db/index");
const { getAdminSettings } = require("./state");

// ── Lazy bindings: ye modules isko wapas bhi require karte hain (circular).
// Isliye direct import ki jagah pehli baar call hone par resolve hote hain.
// Behaviour same: call hamesha runtime pe hota hai, module-load pe kabhi nahi.
const { lazy } = require("./lib/lazy");
const dbSetUserPro = lazy("dbSetUserPro");
const groupNotify = lazy("groupNotify");
const istTimeStr = lazy("istTimeStr");


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
      return (getAdminSettings() && (getAdminSettings()).weekly_name) || "PRO VIP WEEKLY";
    },
    get amount() {
      const v = Number(getAdminSettings() && (getAdminSettings()).weekly_amount);
      return Number.isFinite(v) && v >= 1 ? v : 749;
    },
    get days() {
      const v = Number(getAdminSettings() && (getAdminSettings()).weekly_days);
      return Number.isFinite(v) && v >= 1 ? v : 7;
    },
    get qr_url() {
      const raw =
        (getAdminSettings() && (getAdminSettings()).weekly_qr_url) ||
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
      return (getAdminSettings() && (getAdminSettings()).monthly_name) || "PRO VIP MONTHLY";
    },
    get amount() {
      const v = Number(getAdminSettings() && (getAdminSettings()).monthly_amount);
      return Number.isFinite(v) && v >= 1 ? v : 1498;
    },
    get days() {
      const v = Number(getAdminSettings() && (getAdminSettings()).monthly_days);
      return Number.isFinite(v) && v >= 1 ? v : 30;
    },
    get qr_url() {
      const raw =
        (getAdminSettings() && (getAdminSettings()).monthly_qr_url) ||
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

// Separate, server-only credentials. No token literals or code fallbacks.
const TELEGRAM_BOT_TOKEN = String(
  process.env.TELEGRAM_ADMIN_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || ""
).trim();
const TELEGRAM_GROUP_BOT_TOKEN = String(
  process.env.TELEGRAM_GROUP_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || TELEGRAM_BOT_TOKEN
).trim();
const TELEGRAM_REPORT_GROUP_ID = String(
  process.env.TELEGRAM_REPORT_GROUP_ID || "-1004386088906"
);
const TELEGRAM_ADMIN_CHAT_ID = String(
  process.env.TELEGRAM_ADMIN_CHAT_ID || "6656009938"
).trim();
/** Pending payment window (gateway + manual) */
const UPI_ID = process.env.UPI_ID || "dragoxkrish@nyes";
const PAYMENT_TTL_MS = 10 * 60 * 1000; // payment popup/resume 10 min; orders history hamesha rahti hai

function userIsPro(user) {
  if (!user || !user.is_pro) return false;
  if (!user.pro_expires_at) return true;
  return new Date(user.pro_expires_at).getTime() > Date.now();
}

async function activatePro(userId, planKey) {
  const plan = PLAN_CATALOG[planKey];
  if (!plan) return null;
  const expires = new Date(Date.now() + plan.days * 86400000).toISOString();
  await dbSetUserPro(userId, 1, planKey, expires);
  // 💎 subscription alert → Telegram group
  try {
    const u = await col.users.findOne({ id: Number(userId) });
    groupNotify(
      "💎 *NEW SUBSCRIPTION ACTIVATED*\n\n" +
        "👤 Name: " + ((u && u.name) || "User") + "\n" +
        "🆔 ID: #" + userId + "\n" +
        "📦 Plan: " + planKey + " (" + plan.days + " days)\n" +
        "🕒 Time: " + istTimeStr(),
      true
    );
  } catch (e) {}
  return { plan: planKey, pro_expires_at: expires, days: plan.days };
}

module.exports = {
  PAYMENT_TTL_MS,
  PLAN_CATALOG,
  TELEGRAM_ADMIN_CHAT_ID,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_GROUP_BOT_TOKEN,
  TELEGRAM_REPORT_GROUP_ID,
  UPI_ID,
  activatePro,
  resolveValidQrUrl,
  userIsPro,
};

require("./lib/lazy").register(module.exports);
