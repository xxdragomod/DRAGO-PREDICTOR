/** Telegram group me notification (group bot → fallback admin bot) */

const { TELEGRAM_ADMIN_CHAT_ID, TELEGRAM_BOT_TOKEN, TELEGRAM_GROUP_BOT_TOKEN, TELEGRAM_REPORT_GROUP_ID } = require("../config/env");
const { PLAN_CATALOG } = require("../config/plans");
const { escTgMd } = require("../utils/telegramFormat");
const { telegramApi } = require("./telegramApi");
async function groupNotify(text, md) {
  const payload = { chat_id: TELEGRAM_REPORT_GROUP_ID, text };
  if (md) payload.parse_mode = "Markdown";
  try {
    let r = await telegramApi("sendMessage", payload, TELEGRAM_GROUP_BOT_TOKEN);
    if (!r || !r.ok && md) {
      // Markdown parse fail → plain text retry
      r = await telegramApi(
        "sendMessage",
        { chat_id: TELEGRAM_REPORT_GROUP_ID, text: text.replace(/[*_`]/g, "") },
        TELEGRAM_GROUP_BOT_TOKEN
      );
    }
    if (!r || !r.ok) r = await telegramApi("sendMessage", { chat_id: TELEGRAM_REPORT_GROUP_ID, text: text.replace(/[*_`]/g, "") });
  } catch (e) {
    console.warn("groupNotify:", e.message);
  }
}
async function notifyAdminManualPayment({ orderId, user, planKey, amount, utr }) {
  if (!TELEGRAM_BOT_TOKEN) {
    console.warn("Telegram: TELEGRAM_BOT_TOKEN missing — payment notify skipped");
    return null;
  }
  if (!TELEGRAM_ADMIN_CHAT_ID) {
    console.warn("Telegram: TELEGRAM_ADMIN_CHAT_ID missing — payment notify skipped");
    return null;
  }
  const plan = PLAN_CATALOG[planKey];
  const when = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  const text =
    `🧾 *New manual payment*\n\n` +
    `👤 Name: ${escTgMd(user.name || "—", 80)}\n` +
    `📧 Email: ${escTgMd(user.email || "—", 120)}\n` +
    `🆔 User ID: #${escTgMd(user.id || "—", 24)}\n` +
    `📦 Plan: ${plan ? `${escTgMd(plan.name, 60)} (${plan.days} Days)` : escTgMd(planKey, 30)}\n` +
    `💰 Amount: ₹${Number(amount) || 0}\n` +
    `🔖 UTR: \`${escTgMd(utr, 32)}\`\n` +
    `🆔 Order: \`${escTgMd(orderId, 48)}\`\n` +
    `🕐 Time: ${when} IST`;

  // callback_data max 64 bytes — short codes
  const chatId = TELEGRAM_ADMIN_CHAT_ID;
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ Approve", callback_data: `a:${orderId}` },
          { text: "❌ Deny", callback_data: `d:${orderId}` },
        ],
      ],
    },
  };
  let result = await telegramApi("sendMessage", payload);
  // Retry without Markdown if parse fails
  if (result && !result.ok && String(result.description || "").includes("parse")) {
    delete payload.parse_mode;
    payload.text = payload.text.replace(/\*/g, "").replace(/`/g, "");
    result = await telegramApi("sendMessage", payload);
  }
  if (!result || !result.ok) {
    console.error("Telegram sendMessage failed:", JSON.stringify(result));
  } else {
    console.log("Telegram: payment notify sent OK order=", orderId);
  }
  return result;
}

/** DevTools detect → admin ko BAN / UNLOCK buttons wala alert */
async function notifyAdminDevtoolsBan({ user, userId, reason, device }) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_ADMIN_CHAT_ID) {
    console.warn("Telegram: token/chat missing — devtools alert skipped");
    return null;
  }
  const when = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  const text =
    `🚨 *DevTools detected — BLOCKED*\n\n` +
    `👤 Name: ${escTgMd((user && user.name) || "— (not logged in)", 80)}\n` +
    `📧 Email: ${escTgMd((user && user.email) || "—", 120)}\n` +
    `🆔 User ID: ${userId ? `\`${escTgMd(userId, 24)}\`` : "—"}\n` +
    `📱 Device: \`${escTgMd(device || "—", 64)}\`\n` +
    `🧾 Reason: ${escTgMd(reason || "devtools", 80)}\n` +
    `🕐 Time: ${when} IST\n\n` +
    `UNLOCK → user wapas app use kar payega\nBAN → permanent ban (site hamesha 404 dikhegi)`;
  // Logged-in → user buttons; device-only → device buttons (warna "bad user id")
  const hasUser = userId != null && userId !== "";
  const btnRow = hasUser
    ? [
        { text: "⛔ BAN Permanent", callback_data: `bb:${userId}` },
        { text: "🔓 UNLOCK", callback_data: `ub:${userId}` },
      ]
    : [
        { text: "⛔ BAN Device", callback_data: `bd:${device}` },
        { text: "🔓 UNLOCK Device", callback_data: `ud:${device}` },
      ];
  const payload = {
    chat_id: TELEGRAM_ADMIN_CHAT_ID,
    text,
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [btnRow],
    },
  };
  let result = await telegramApi("sendMessage", payload);
  if (result && !result.ok && String(result.description || "").includes("parse")) {
    delete payload.parse_mode;
    payload.text = payload.text.replace(/[*`]/g, "");
    result = await telegramApi("sendMessage", payload);
  }
  if (!result || !result.ok) console.error("Telegram devtools alert failed:", JSON.stringify(result));
  else console.log("Telegram: devtools alert sent OK user=", userId);
  return result;
}

/** Shared Approve / Deny handler (polling) */
/** Bug report → Telegram group (group bot bhejta hai; fallback admin bot) */
async function sendBugReportToGroup(report) {
  const text =
    `🐞 *Bug Report — DRAGO Predictor*\n\n` +
    `👤 User: ${escTgMd(report.name, 80)} (#${escTgMd(report.userId, 24)})\n` +
    `🧩 Area: ${escTgMd(report.category, 60)}\n` +
    `📝 Issue: ${escTgMd(report.description, 1200)}`;
  const payload = {
    chat_id: TELEGRAM_REPORT_GROUP_ID,
    text,
    parse_mode: "Markdown",
    disable_web_page_preview: true,
  };
  let r = await telegramApi("sendMessage", payload, TELEGRAM_GROUP_BOT_TOKEN);
  if (!r || !r.ok) r = await telegramApi("sendMessage", payload);
  return r;
}

module.exports = { groupNotify, notifyAdminDevtoolsBan, notifyAdminManualPayment, sendBugReportToGroup };
