/**
 * Admin bot: alerts, callbacks, commands, long-polling
 *
 * Auto-split from the original monolithic server.js — behaviour unchanged.
 * Original lines: 1719-1793, 1794-1812, 2478-3801
 */


const { saveAnnouncement } = require("../announcements");
const { col } = require("../db/index");
const { getStoredImageById, storeUploadedImage } = require("../images");
const { escTgMd } = require("../lib/utils");
const { banListPayload, dbBanPermanent, dbIsUserBanned, dbListBanned, dbUnbanUser } = require("../models/bans");
const { dbDeleteGame, dbFindGame, dbInsertGame, dbListGames, dbMaxGameOrder } = require("../models/games");
const { findOrder, updateOrderStatus } = require("../payments/store");
const { PLAN_CATALOG, TELEGRAM_ADMIN_CHAT_ID, TELEGRAM_BOT_TOKEN, TELEGRAM_GROUP_BOT_TOKEN, TELEGRAM_REPORT_GROUP_ID, activatePro } = require("../plans");
const { saveAdminSettings } = require("../settings");
const { telegramApi } = require("./api");
const { getAdminSettings, getTgOffset, getTgPolling, setTgOffset, setTgPolling } = require("../state");

// ── Lazy bindings: ye modules isko wapas bhi require karte hain (circular).
// Isliye direct import ki jagah pehli baar call hone par resolve hote hain.
// Behaviour same: call hamesha runtime pe hota hai, module-load pe kabhi nahi.
const { lazy } = require("../lib/lazy");
const dbFindUserById = lazy("dbFindUserById");
const dbSetUserPro = lazy("dbSetUserPro");


async function sendTelegramPhotoSmart({ chatId, photoUrl, caption, replyMarkup, parseMode, token }) {
  const tk = token || TELEGRAM_BOT_TOKEN;
  if (!tk || !chatId) return null;

  // 1. If photoUrl is one of our /uploads/img_... URLs, send binary buffer directly via FormData
  try {
    const match = String(photoUrl || "").match(/\/uploads\/(img_[A-Za-z0-9_]+)(?:\.[a-z]+)?$/i);
    if (match && match[1]) {
      const stored = await getStoredImageById(match[1]);
      if (stored && stored.buf && typeof FormData !== "undefined" && typeof Blob !== "undefined") {
        const fd = new FormData();
        fd.append("chat_id", String(chatId));
        fd.append(
          "photo",
          new Blob([stored.buf], { type: stored.mime || "image/jpeg" }),
          `${match[1]}.${stored.ext || "jpg"}`
        );
        if (caption) fd.append("caption", String(caption).slice(0, 1024));
        if (parseMode) fd.append("parse_mode", String(parseMode));
        if (replyMarkup) fd.append("reply_markup", JSON.stringify(replyMarkup));

        const res = await fetch(`https://api.telegram.org/bot${tk}/sendPhoto`, {
          method: "POST",
          body: fd,
          signal: AbortSignal.timeout(15000),
        });
        const j = await res.json().catch(() => null);
        if (j && j.ok) return j;
      }
    }
  } catch (e) {
    console.warn("sendTelegramPhotoSmart binary:", e.message);
  }

  // 2. Fallback: send URL to Telegram sendPhoto
  if (photoUrl && /^https?:\/\//i.test(photoUrl)) {
    const payload = {
      chat_id: chatId,
      photo: photoUrl,
      caption: String(caption || "").slice(0, 1024),
    };
    if (parseMode) payload.parse_mode = parseMode;
    if (replyMarkup) payload.reply_markup = replyMarkup;
    const r = await telegramApi("sendPhoto", payload, tk);
    if (r && r.ok) return r;
  }

  return null;
}

async function imgbbUploadBuffer(buf) {
  return storeUploadedImage(buf, "image/jpeg", null);
}
async function telegramPhotoToImgbb(photoArr) {
  const best = photoArr[photoArr.length - 1];
  const f = await telegramApi("getFile", { file_id: best.file_id });
  if (!f || !f.ok || !f.result || !f.result.file_path) throw new Error("getFile failed");
  const src = await fetch(
    "https://api.telegram.org/file/bot" + TELEGRAM_BOT_TOKEN + "/" + f.result.file_path
  );
  const buf = Buffer.from(await src.arrayBuffer());
  return imgbbUploadBuffer(buf);
}
function istTimeStr() {
  try {
    return new Date().toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch (e) {
    return new Date().toString();
  }
}
/** Telegram group me notification (group bot → fallback admin bot) */

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

async function handleTelegramCallback(cb) {
  if (!cb || !cb.data) return;
  const data = String(cb.data);
  const chatId = cb.message && cb.message.chat && cb.message.chat.id;
  const msgId = cb.message && cb.message.message_id;
  const fromId = cb.from && cb.from.id;

  // CRITICAL (BE-1): Strictly verify Telegram admin identity at the top of handleTelegramCallback
  if (!isTelegramAdmin(fromId) && !isTelegramAdmin(chatId)) {
    await telegramApi("answerCallbackQuery", {
      callback_query_id: cb.id,
      text: "Unauthorized: Admin only",
      show_alert: true,
    });
    return;
  }

  // 📢 Announcement broadcast — conversation start
  if (data === "act:announce") {
    if (!isTelegramAdmin(chatId)) return;
    await telegramApi("answerCallbackQuery", { callback_query_id: cb.id });
    tgConversations.set(String(chatId), {
      step: "ann_type",
      data: {},
      expires: Date.now() + 10 * 60 * 1000,
    });
    await tgReply(
      chatId,
      "📢 New Announcement\n\nType bhejo:\n1 = 🎮 New Game\n2 = ⚡ Server Update\n3 = 📢 Other\n\n(or /cancel)"
    );
    return;
  }

  // Admin config toggles (cfg:*)
  if (data.startsWith("cfg:")) {
    if (!isTelegramAdmin(chatId)) {
      await telegramApi("answerCallbackQuery", {
        callback_query_id: cb.id,
        text: "Not admin",
        show_alert: true,
      });
      return;
    }
    const parts = data.split(":");
    const key = parts[1] || "";
    const arg = parts[2];
    if (key === "google") {
      (getAdminSettings()).google_auth_enabled = !(getAdminSettings()).google_auth_enabled;
    } else if (key === "auto") {
      (getAdminSettings()).auto_payment_enabled = !(getAdminSettings()).auto_payment_enabled;
    } else if (key === "manual") {
      (getAdminSettings()).manual_payment_enabled = !(getAdminSettings()).manual_payment_enabled;
    } else if (key === "guard") {
      (getAdminSettings()).guard_enabled = !(getAdminSettings()).guard_enabled;
    } else if (key === "feedback") {
      (getAdminSettings()).force_feedback = !(getAdminSettings()).force_feedback;
    } else if (key === "rate") {
      (getAdminSettings()).force_rate = !(getAdminSettings()).force_rate;
    } else if (key === "winfb") {
      (getAdminSettings()).force_winfb = !(getAdminSettings()).force_winfb;
    } else if (key === "pred" && arg != null) {
      const delta = Number(arg) || 0;
      (getAdminSettings()).free_pred_limit = Math.max(
        0,
        Math.min(1000, Number((getAdminSettings()).free_pred_limit) + delta)
      );
    } else if (key === "hist" && arg != null) {
      const delta = Number(arg) || 0;
      (getAdminSettings()).free_api_history_limit = Math.max(
        0,
        Math.min(100000, Number((getAdminSettings()).free_api_history_limit) + delta)
      );
    }
    // refresh always saves current state
    saveAdminSettings();
    await telegramApi("answerCallbackQuery", {
      callback_query_id: cb.id,
      text: "Updated",
    });
    // Refresh panel message
    const s = getAdminSettings();
    try {
      await telegramApi("editMessageText", {
        chat_id: chatId,
        message_id: msgId,
        text: adminPanelText(),
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: s.google_auth_enabled
                  ? "🔴 Disable Google Auth"
                  : "🟢 Enable Google Auth",
                callback_data: "cfg:google",
              },
            ],
            [
              {
                text: s.auto_payment_enabled
                  ? "🔴 Disable Auto Pay"
                  : "🟢 Enable Auto Pay",
                callback_data: "cfg:auto",
              },
              {
                text: s.manual_payment_enabled
                  ? "🔴 Disable Manual"
                  : "🟢 Enable Manual",
                callback_data: "cfg:manual",
              },
            ],
            [
              { text: "Pred −1", callback_data: "cfg:pred:-1" },
              { text: "Pred +1", callback_data: "cfg:pred:1" },
              { text: "Pred +5", callback_data: "cfg:pred:5" },
            ],
            [
              { text: "Hist −5", callback_data: "cfg:hist:-5" },
              { text: "Hist +5", callback_data: "cfg:hist:5" },
              { text: "Hist +10", callback_data: "cfg:hist:10" },
            ],
            [
              {
                text: s.guard_enabled
                  ? "🔴 Disable DevTools Guard"
                  : "🟢 Enable DevTools Guard",
                callback_data: "cfg:guard",
              },
            ],
            [
              {
                text: s.force_feedback ? "🐞 Bug in app: ON" : "🐞 Bug in app: OFF",
                callback_data: "cfg:feedback",
              },
            ],
            [
              {
                text: s.force_rate ? "⭐ Rate in app: ON" : "⭐ Rate in app: OFF",
                callback_data: "cfg:rate",
              },
            ],
            [
              {
                text: s.force_winfb ? "🏆 Feedback in app: ON" : "🏆 Feedback in app: OFF",
                callback_data: "cfg:winfb",
              },
            ],
            [{ text: "👥 Users Manage", callback_data: "users:list" }],
        [{ text: "🔄 Refresh", callback_data: "cfg:refresh" }],
          ],
        },
      });
    } catch (e) {
      console.error("tg panel edit:", e.message);
    }
    return;
  }

  // /banlist refresh button
  if (data === "banlist:refresh") {
    if (!isTelegramAdmin(chatId)) {
      await telegramApi("answerCallbackQuery", {
        callback_query_id: cb.id,
        text: "Not admin",
        show_alert: true,
      });
      return;
    }
    const p = await banListPayload();
    await telegramApi("answerCallbackQuery", { callback_query_id: cb.id, text: "Refreshed" });
    if (chatId && msgId) {
      await telegramApi("editMessageText", {
        chat_id: chatId,
        message_id: msgId,
        text: p ? p.text : "✅ Koi blocked/banned user nahi hai.",
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: p ? p.keyboard : [] },
      });
    }
    return;
  }

  // Device-only ban: unlock / ban
  if (data.startsWith("ud:") || data.startsWith("bd:")) {
    if (!isTelegramAdmin(chatId)) {
      await telegramApi("answerCallbackQuery", { callback_query_id: cb.id, text: "Not admin", show_alert: true });
      return;
    }
    const dev = data.slice(3);
    if (data.startsWith("ud:")) {
      if (col.banned_devices) await col.banned_devices.deleteOne({ device: dev });
      await telegramApi("answerCallbackQuery", { callback_query_id: cb.id, text: "Device unlocked" });
      if (chatId && msgId)
        await telegramApi("editMessageText", {
          chat_id: chatId, message_id: msgId,
          text: `🔓 DEVICE UNLOCKED\n${dev}`, reply_markup: { inline_keyboard: [] },
        });
    } else {
      if (col.banned_devices) await col.banned_devices.updateOne({ device: dev }, { $set: { state: "banned" } });
      await telegramApi("answerCallbackQuery", { callback_query_id: cb.id, text: "Device banned" });
      if (chatId && msgId)
        await telegramApi("editMessageText", {
          chat_id: chatId, message_id: msgId,
          text: `⛔ DEVICE BANNED\n${dev}`, reply_markup: { inline_keyboard: [] },
        });
    }
    return;
  }

  // DevTools ban: ⛔ BAN / 🔓 UNLOCK
  if (data.startsWith("bb:") || data.startsWith("ub:")) {
    if (!isTelegramAdmin(chatId)) {
      await telegramApi("answerCallbackQuery", {
        callback_query_id: cb.id,
        text: "Not admin",
        show_alert: true,
      });
      return;
    }
    const uid = Number(data.slice(3));
    if (!uid) {
      await telegramApi("answerCallbackQuery", { callback_query_id: cb.id, text: "Bad user id" });
      return;
    }
    if (data.startsWith("ub:")) {
      await dbUnbanUser(uid);
      await telegramApi("answerCallbackQuery", {
        callback_query_id: cb.id,
        text: "Unlocked — user can use app",
      });
      if (chatId && msgId) {
        await telegramApi("editMessageText", {
          chat_id: chatId,
          message_id: msgId,
          text: `🔓 UNLOCKED\nUser #${uid} ab wapas app use kar sakta hai.`,
          reply_markup: { inline_keyboard: [] },
        });
      }
      console.log("🔓 UNLOCK user=", uid);
    } else {
      await dbBanPermanent(uid);
      await telegramApi("answerCallbackQuery", {
        callback_query_id: cb.id,
        text: "Banned permanently",
      });
      if (chatId && msgId) {
        await telegramApi("editMessageText", {
          chat_id: chatId,
          message_id: msgId,
          text: `⛔ PERMANENTLY BANNED\nUser #${uid} — site ab isko 404 dikhegi.`,
          reply_markup: { inline_keyboard: [] },
        });
      }
      console.log("⛔ PERMA-BAN user=", uid);
    }
    return;
  }

  // ── USER MANAGEMENT: pro grant / pro band / ban / unban ──
  async function showUserMenu(uid, cId, mId) {
    const p = await userDocMenuPayload(uid);
    if (!p) {
      await telegramApi("editMessageText", {
        chat_id: cId,
        message_id: mId,
        text: "❌ User #" + uid + " nahi mila.",
        reply_markup: {
          inline_keyboard: [[{ text: "← Users", callback_data: "users:list" }]],
        },
      });
      return;
    }
    await telegramApi("editMessageText", {
      chat_id: cId,
      message_id: mId,
      text: p.text,
      reply_markup: { inline_keyboard: p.keyboard },
    });
  }

  if (
    data === "users:list" ||
    data === "users:panel" ||
    data === "users:search" ||
    data === "users:pro" ||
    data.startsWith("users:page:") ||
    data.startsWith("users:propage:") ||
    data.startsWith("u:") ||
    data.startsWith("up:")
  ) {
    if (!isTelegramAdmin(chatId)) {
      await telegramApi("answerCallbackQuery", {
        callback_query_id: cb.id,
        text: "Not admin",
        show_alert: true,
      });
      return;
    }
    await telegramApi("answerCallbackQuery", { callback_query_id: cb.id });

    if (data === "users:panel") {
      await sendAdminPanel(chatId);
      return;
    }

    if (data === "users:search") {
      tgConversations.set(String(chatId), {
        step: "usersearch",
        data: {},
        expires: Date.now() + 10 * 60 * 1000,
      });
      await tgReply(
        chatId,
        "🔍 User search\n\nUser ID, email ya naam bhejo.\n\n(or /cancel)"
      );
      return;
    }

    if (data === "users:pro" || data.startsWith("users:propage:")) {
      const page = data.startsWith("users:propage:")
        ? Math.max(0, Number(data.slice(14)) || 0)
        : 0;
      const rows = await col.users
        .find({ is_pro: 1 })
        .sort({ id: -1 })
        .skip(page * 8)
        .limit(8)
        .toArray();
      const total = await col.users.countDocuments({ is_pro: 1 });
      const kb = [];
      for (const u of rows) {
        const pn =
          u.pro_plan && PLAN_CATALOG[u.pro_plan]
            ? PLAN_CATALOG[u.pro_plan].name
            : "PRO";
        kb.push([
          {
            text:
              "⭐ #" + u.id + " · " + String(u.name || u.email || "user").slice(0, 14) +
              " · " + pn.replace("RX1 FOR ", ""),
            callback_data: "u:" + u.id,
          },
        ]);
      }
      if (!kb.length) kb.push([{ text: "🤷 Koi pro user nahi", callback_data: "users:panel" }]);
      const nav = [];
      if (page > 0) nav.push({ text: "‹ Prev", callback_data: "users:propage:" + (page - 1) });
      if (page * 8 + 8 < total) nav.push({ text: "Next ›", callback_data: "users:propage:" + (page + 1) });
      if (nav.length) kb.push(nav);
      kb.push([
        { text: "👥 All users", callback_data: "users:list" },
        { text: "← Panel", callback_data: "users:panel" },
      ]);
      await telegramApi("editMessageText", {
        chat_id: chatId,
        message_id: msgId,
        text: "⭐ PRO USERS (" + total + ") — page " + (page + 1) + ":",
        reply_markup: { inline_keyboard: kb },
      });
      return;
    }

    if (data === "users:list" || data.startsWith("users:page:")) {
      const page = data.startsWith("users:page:")
        ? Math.max(0, Number(data.slice(11)) || 0)
        : 0;
      const rows = await col.users
        .find({})
        .sort({ id: -1 })
        .skip(page * 8)
        .limit(8)
        .toArray();
      const total = await col.users.countDocuments({});
      const kb = [
        [
          { text: "🔍 Search user", callback_data: "users:search" },
          { text: "⭐ Pro users", callback_data: "users:pro" },
        ],
      ];
      for (const u of rows) {
        kb.push([
          {
            text:
              "👤 " + String(u.name || u.email || "user").slice(0, 16) +
              " #" + u.id + (u.is_pro ? " 🟢" : ""),
            callback_data: "u:" + u.id,
          },
        ]);
      }
      const nav = [];
      if (page > 0) nav.push({ text: "‹ Prev", callback_data: "users:page:" + (page - 1) });
      if (page * 8 + 8 < total) nav.push({ text: "Next ›", callback_data: "users:page:" + (page + 1) });
      if (nav.length) kb.push(nav);
      kb.push([{ text: "← Panel", callback_data: "users:panel" }]);
      await telegramApi("editMessageText", {
        chat_id: chatId,
        message_id: msgId,
        text: "👥 Users (page " + (page + 1) + ") — user select karo:",
        reply_markup: { inline_keyboard: kb },
      });
      return;
    }

    if (data.startsWith("up:")) {
      const parts = data.split(":");
      const uid = Number(parts[1]);
      const plan = parts[2];
      if (plan === "none") {
        await dbSetUserPro(uid, false, null, null);
        await telegramApi("answerCallbackQuery", {
          callback_query_id: cb.id,
          text: "❌ Pro band — user ab FREE hai",
          show_alert: true,
        });
      } else if (PLAN_CATALOG[plan]) {
        const p = PLAN_CATALOG[plan];
        const expIso = new Date(Date.now() + p.days * 86400000).toISOString();
        await dbSetUserPro(uid, true, plan, expIso);
        await telegramApi("answerCallbackQuery", {
          callback_query_id: cb.id,
          text: "✅ PRO " + p.name + " (" + p.days + " din) grant ho gaya",
          show_alert: true,
        });
      } else {
        await telegramApi("answerCallbackQuery", {
          callback_query_id: cb.id,
          text: "Bad plan",
        });
        return;
      }
      await showUserMenu(uid, chatId, msgId);
      return;
    }

    if (data.startsWith("u:")) {
      await showUserMenu(Number(data.slice(2)), chatId, msgId);
      return;
    }
    return;
  }

  let action = null;
  let orderId = null;
  if (data === "stats:refresh") {
    await telegramApi("answerCallbackQuery", {
      callback_query_id: cb.id,
      text: "Refreshed",
    });
    await sendAdminPanel(chatId);
    return;
  }
  if (data.startsWith("a:")) {
    action = "approve";
    orderId = data.slice(2);
  } else if (data.startsWith("d:")) {
    action = "deny";
    orderId = data.slice(2);
  } else if (data.startsWith("approve:")) {
    action = "approve";
    orderId = data.slice(8);
  } else if (data.startsWith("deny:")) {
    action = "deny";
    orderId = data.slice(5);
  }

  if (!orderId || (action !== "approve" && action !== "deny")) {
    await telegramApi("answerCallbackQuery", {
      callback_query_id: cb.id,
      text: "Unknown action",
    });
    return;
  }

  const order = findOrder(orderId);
  if (!order) {
    await telegramApi("answerCallbackQuery", {
      callback_query_id: cb.id,
      text: "Order not found",
      show_alert: true,
    });
    return;
  }

  const st = String(order.payment_status || "").toUpperCase();
  if (st === "SUCCESS" || st === "FAILED" || st === "EXPIRED") {
    await telegramApi("answerCallbackQuery", {
      callback_query_id: cb.id,
      text: "Already processed: " + st,
      show_alert: true,
    });
    return;
  }

  if (action === "approve") {
    updateOrderStatus(
      orderId,
      "SUCCESS",
      order.utr || null,
      order.method || "UPI_MANUAL",
      order.raw_response || null
    );
    const pro = await activatePro(order.user_id, order.plan);
    await telegramApi("answerCallbackQuery", {
      callback_query_id: cb.id,
      text: "Approved — user is Pro",
    });
    if (chatId && msgId) {
      await telegramApi("editMessageText", {
        chat_id: chatId,
        message_id: msgId,
        text:
          `✅ APPROVED\nOrder: ${orderId}\nUser #${order.user_id} → Pro (${order.plan})` +
          (pro ? `\nExpires: ${pro.pro_expires_at}` : ""),
        reply_markup: { inline_keyboard: [] },
      });
    }
    console.log("✅ pro approved:", orderId, order.user_id, order.plan);
  } else {
    updateOrderStatus(
      orderId,
      "FAILED",
      order.utr || null,
      order.method || "UPI_MANUAL",
      order.raw_response || null
    );
    await telegramApi("answerCallbackQuery", {
      callback_query_id: cb.id,
      text: "Denied",
    });
    if (chatId && msgId) {
      await telegramApi("editMessageText", {
        chat_id: chatId,
        message_id: msgId,
        text: `❌ DENIED\nOrder: ${orderId}`,
        reply_markup: { inline_keyboard: [] },
      });
    }
    console.log("❌ payment denied:", orderId);
  }
}

/** Admin multi-step conversations (e.g. /addgame) */
const tgConversations = new Map(); // chatId → { step, data, expires }

function isTelegramAdmin(chatId) {
  if (!TELEGRAM_ADMIN_CHAT_ID) return false;
  return String(chatId) === String(TELEGRAM_ADMIN_CHAT_ID);
}

async function tgReply(chatId, text) {
  return telegramApi("sendMessage", {
    chat_id: chatId,
    text: String(text || "").slice(0, 4000),
  });
}

function looksLikeUrl(s) {
  try {
    const u = new URL(String(s || "").trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

async function handleTelegramMessage(msg) {
  if (!msg || !msg.chat) return;
  const chatId = msg.chat.id;
  const convPre = tgConversations.get(String(chatId));
  const text = String(msg.text || "").trim();
  if (!text && !(msg.photo && convPre && convPre.step === "ann_image")) return;

  if (!isTelegramAdmin(chatId)) {
    // Ignore non-admin private messages (payment buttons still work via callback)
    return;
  }

  // Direct photo accepted — announcement image ya /addgame image (imgbb pe upload)
  if (
    convPre &&
    (convPre.step === "ann_image" || convPre.step === "image") &&
    convPre.expires > Date.now() &&
    msg.photo &&
    msg.photo.length
  ) {
    try {
      const url = await telegramPhotoToImgbb(msg.photo);
      convPre.data.image_url = url;
      convPre.expires = Date.now() + 10 * 60 * 1000;
      if (convPre.step === "ann_image") {
        convPre.step = "ann_title";
        await tgReply(
          chatId,
          "✅ Image uploaded\n\nStep 2/3 — Send the TITLE (game / feature name)\n\n(or /cancel)"
        );
      } else {
        convPre.step = "link";
        await tgReply(
          chatId,
          "✅ Image uploaded\n\nStep 3/3 — Send GAME LINK (URL that opens in gameplay)"
        );
      }
      return;
    } catch (e) {
      await tgReply(chatId, "Photo upload failed — send the image again (photo ya https URL):");
      return;
    }
  }

  if (!text) return;

  const lower = text.toLowerCase();
  const conv = convPre;

  // Cancel
  if (lower === "/cancel") {
    tgConversations.delete(String(chatId));
    await tgReply(chatId, "Cancelled.");
    return;
  }

  if (conv && conv.expires > Date.now() && conv.step === "usersearch") {
    tgConversations.delete(String(chatId));
    const q = text.trim();
    let rows = [];
    if (/^\d+$/.test(q)) {
      const one = await dbFindUserById(Number(q));
      if (one) rows = [one];
    } else if (q.indexOf("@") !== -1) {
      rows = await col.users
        .find({ email: new RegExp(escRe(q), "i") })
        .limit(6)
        .toArray();
    } else {
      rows = await col.users
        .find({ name: new RegExp(escRe(q), "i") })
        .limit(6)
        .toArray();
    }
    if (!rows.length) {
      await tgReply(chatId, "❌ Koi user nahi mila: " + q);
      return;
    }
    if (rows.length === 1) {
      const u = rows[0];
      const p = await userDocMenuPayload(u.id);
      await telegramApi("sendMessage", {
        chat_id: chatId,
        text: p.text,
        reply_markup: { inline_keyboard: p.keyboard },
      });
      return;
    }
    const kb = rows.map((u) => [
      {
        text:
          "👤 #" + u.id + " · " + String(u.name || u.email || "user").slice(0, 20) +
          (u.is_pro ? " 🟢" : ""),
        callback_data: "u:" + u.id,
      },
    ]);
    await telegramApi("sendMessage", {
      chat_id: chatId,
      text: "🔍 " + rows.length + " users mile — select karo:",
      reply_markup: { inline_keyboard: kb },
    });
    return;
  }

  // /listgames
  if (lower === "/listgames" || lower === "/games") {
    const rows = await dbListGames();
    if (!rows.length) {
      await tgReply(chatId, "No games yet. Use /addgame");
      return;
    }
    const lines = rows.map(
      (g, i) =>
        `${i + 1}. [#${g.id}] ${g.name}\n   img: ${g.image_url}\n   link: ${g.link_url}`
    );
    await tgReply(chatId, "🎮 Games:\n\n" + lines.join("\n\n"));
    return;
  }

  // /banlist — blocked/banned users ki list + UNLOCK/BAN buttons
  if (lower === "/banlist" || lower === "/bans" || lower === "/blocked" || lower === "/blocklist") {
    const rows = await dbListBanned(20);
    if (!rows.length) {
      await tgReply(chatId, "✅ Koi blocked/banned user nahi hai.");
      return;
    }
    const keyboard = [];
    const lines = ["🚫 *Blocked/Banned users:*", ""];
    rows.forEach((u) => {
      const tag = u.state === "banned" ? "⛔" : "🟠";
      lines.push(
        `${tag} #${u.id} ${u.name || "—"}\n   ${u.email || ""}\n   ${u.state} • ${String(u.at).slice(0, 16).replace("T", " ")}`
      );
      keyboard.push([
        { text: `🔓 Unlock #${u.id}`, callback_data: `ub:${u.id}` },
        { text: `⛔ Ban #${u.id}`, callback_data: `bb:${u.id}` },
      ]);
    });
    keyboard.push([{ text: "🔄 Refresh", callback_data: "banlist:refresh" }]);
    const payload = {
      chat_id: chatId,
      text: lines.join("\n"),
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: keyboard },
    };
    let r = await telegramApi("sendMessage", payload);
    if (r && !r.ok && String(r.description || "").includes("parse")) {
      delete payload.parse_mode;
      payload.text = payload.text.replace(/[*`]/g, "");
      await telegramApi("sendMessage", payload);
    }
    return;
  }

  // /delgame <id>
  if (lower.startsWith("/delgame")) {
    const id = Number(text.split(/\s+/)[1]);
    if (!id) {
      await tgReply(chatId, "Usage: /delgame <id>");
      return;
    }
    const existing = await dbFindGame(id);
    if (!existing) {
      await tgReply(chatId, "Game not found: #" + id);
      return;
    }
    await dbDeleteGame(id);
    await tgReply(chatId, `Deleted game #${id} (${existing.name})`);
    return;
  }

  // Start /addgame
  if (lower === "/addgame" || lower.startsWith("/addgame ")) {
    tgConversations.set(String(chatId), {
      step: "name",
      data: {},
      expires: Date.now() + 10 * 60 * 1000,
    });
    await tgReply(
      chatId,
      "🎮 Add Game\n\nStep 1/3 — Send the game NAME\n\n(or /cancel)"
    );
    return;
  }

  // Start /announce — broadcast popup to all users
  if (lower === "/announce") {
    tgConversations.set(String(chatId), {
      step: "ann_type",
      data: {},
      expires: Date.now() + 10 * 60 * 1000,
    });
    await tgReply(
      chatId,
      "📢 New Announcement\n\nType bhejo:\n1 = 🎮 New Game\n2 = ⚡ Server Update\n3 = 📢 Other\n\n(or /cancel)"
    );
    return;
  }

  // Continue conversation
  if (conv && conv.expires > Date.now()) {
    if (conv.step === "name") {
      const name = text.slice(0, 80).trim();
      if (name.length < 1) {
        await tgReply(chatId, "Name too short. Send game name again:");
        return;
      }
      conv.data.name = name;
      conv.step = "image";
      conv.expires = Date.now() + 10 * 60 * 1000;
      await tgReply(
        chatId,
        `✅ Name: ${name}\n\nStep 2/3 — Send IMAGE (photo directly ya https URL)`
      );
      return;
    }
    if (conv.step === "image") {
      if (!looksLikeUrl(text)) {
        await tgReply(chatId, "Invalid URL. Send a full https image URL:");
        return;
      }
      conv.data.image_url = text.trim();
      conv.step = "link";
      conv.expires = Date.now() + 10 * 60 * 1000;
      await tgReply(
        chatId,
        `✅ Image saved\n\nStep 3/3 — Send GAME LINK (URL that opens in gameplay)`
      );
      return;
    }
    if (conv.step === "link") {
      if (!looksLikeUrl(text)) {
        await tgReply(chatId, "Invalid URL. Send a full https game link:");
        return;
      }
      conv.data.link_url = text.trim();
      const maxOrd = await dbMaxGameOrder();
      const nextOrd = (maxOrd && maxOrd.m != null ? Number(maxOrd.m) : 0) + 1;
      const info = await dbInsertGame(
        conv.data.name,
        conv.data.image_url,
        conv.data.link_url,
        nextOrd
      );
      tgConversations.delete(String(chatId));
      // Auto-broadcast: app popup + Telegram group post
      const annAuto = {
        id: Date.now(),
        image_url: conv.data.image_url,
        title: conv.data.name,
        details: "New game added — play now!\n🔗 " + conv.data.link_url,
        ts: Date.now(),
      };
      saveAnnouncement(annAuto);
      const capG =
        "🎮 *NEW GAME ADDED*\n\n🏷 NAME: " +
        conv.data.name +
        "\n🔗 LINK: " +
        conv.data.link_url +
        "\n🕒 TIME: " +
        istTimeStr() +
        "\n\n🐉 DRAGO Predictor";
      let gr = await telegramApi(
        "sendPhoto",
        { chat_id: TELEGRAM_REPORT_GROUP_ID, photo: conv.data.image_url, caption: capG, parse_mode: "Markdown" },
        TELEGRAM_GROUP_BOT_TOKEN
      );
      if (!gr || !gr.ok)
        gr = await telegramApi(
          "sendPhoto",
          { chat_id: TELEGRAM_REPORT_GROUP_ID, photo: conv.data.image_url, caption: capG.replace(/[*_`]/g, "") },
          TELEGRAM_GROUP_BOT_TOKEN
        );
      if (!gr || !gr.ok)
        gr = await telegramApi("sendPhoto", {
          chat_id: TELEGRAM_REPORT_GROUP_ID,
          photo: conv.data.image_url,
          caption: capG.replace(/[*_`]/g, ""),
        });
      await tgReply(
        chatId,
        `✅ Game added!\n\n#${info.lastInsertRowid}\nName: ${conv.data.name}\nImage: ${conv.data.image_url}\nLink: ${conv.data.link_url}\n\n📢 Auto-broadcast: app popup (all users, once) + Telegram group post ho gaya.`
      );
      return;
    }
    if (conv.step === "ann_type") {
      const t = lower.trim();
      let type = "other";
      if (t === "1" || t.indexOf("game") !== -1) type = "game";
      else if (t === "2" || t.indexOf("update") !== -1 || t.indexOf("server") !== -1) type = "update";
      conv.data.type = type;
      conv.step = "ann_image";
      conv.expires = Date.now() + 10 * 60 * 1000;
      await tgReply(
        chatId,
        "✅ Type: " +
          (type === "game" ? "🎮 New Game" : type === "update" ? "⚡ Server Update" : "📢 Other") +
          "\n\nStep 1/3 — Send the IMAGE (photo ya https URL)"
      );
      return;
    }
    if (conv.step === "ann_image") {
      if (!looksLikeUrl(text)) {
        await tgReply(chatId, "Invalid URL — send the image again (photo ya full https URL):");
        return;
      }
      conv.data.image_url = text.trim();
      conv.step = "ann_title";
      conv.expires = Date.now() + 10 * 60 * 1000;
      await tgReply(chatId, "✅ Image saved\n\nStep 2/3 — Send the TITLE (game / feature name)");
      return;
    }
    if (conv.step === "ann_title") {
      const ttl = text.slice(0, 80).trim();
      if (ttl.length < 2) {
        await tgReply(chatId, "Title too short — send again:");
        return;
      }
      conv.data.title = ttl;
      conv.step = "ann_details";
      conv.expires = Date.now() + 10 * 60 * 1000;
      await tgReply(chatId, "✅ Title: " + ttl + "\n\nStep 3/3 — Send the DETAILS text");
      return;
    }
    if (conv.step === "ann_details") {
      conv.data.details = text.slice(0, 600).trim();
      conv.step = "ann_confirm";
      conv.expires = Date.now() + 10 * 60 * 1000;
      await tgReply(
        chatId,
        "📢 Preview\n\n🖼 " +
          conv.data.image_url +
          "\n🏷 " +
          conv.data.title +
          "\n📝 " +
          conv.data.details +
          "\n\nType YES to broadcast to ALL users, NO to cancel."
      );
      return;
    }
    if (conv.step === "ann_confirm") {
      if (lower === "yes" || lower === "y") {
        const ann = {
          id: Date.now(),
          image_url: conv.data.image_url,
          title: conv.data.title,
          details: conv.data.details,
          ts: Date.now(),
        };
        saveAnnouncement(ann);
        tgConversations.delete(String(chatId));
        const hdr =
          conv.data.type === "game"
            ? "🎮 *NEW GAME ADDED*"
            : conv.data.type === "update"
              ? "⚡ *SERVER UPDATE*"
              : "📢 *NEW UPDATE*";
        const caption =
          hdr + "\n\n🏷 NAME: " +
          ann.title +
          "\n📝 " +
          ann.details +
          "\n🕒 TIME: " +
          istTimeStr() +
          "\n\n🐉 DRAGO Predictor";
        const pay = {
          chat_id: TELEGRAM_REPORT_GROUP_ID,
          photo: ann.image_url,
          caption,
          parse_mode: "Markdown",
        };
        let r = await telegramApi("sendPhoto", pay, TELEGRAM_GROUP_BOT_TOKEN);
        if (!r || !r.ok) r = await telegramApi("sendPhoto", pay);
        if (!r || !r.ok) {
          const plain = {
            chat_id: TELEGRAM_REPORT_GROUP_ID,
            photo: ann.image_url,
            caption: caption.replace(/[*_`]/g, ""),
          };
          r = await telegramApi("sendPhoto", plain, TELEGRAM_GROUP_BOT_TOKEN);
          if (!r || !r.ok) r = await telegramApi("sendPhoto", plain);
        }
        await tgReply(
          chatId,
          "✅ Broadcast LIVE! All users will see the popup once. Telegram group me bhi post ho gaya."
        );
        return;
      }
      if (lower === "no" || lower === "n") {
        tgConversations.delete(String(chatId));
        await tgReply(chatId, "Cancelled.");
        return;
      }
      await tgReply(chatId, "Type YES to broadcast, NO to cancel.");
      return;
    }
  } else if (conv) {
    tgConversations.delete(String(chatId));
  }

  // /settings or /panel — admin control panel
  if (
    lower === "/start" ||
    lower === "/help" ||
    lower === "/settings" ||
    lower === "/panel" ||
    lower === "/admin"
  ) {
    await sendAdminPanel(chatId);
    return;
  }

  // /freepred 5
  if (lower.startsWith("/freepred")) {
    const n = Number(text.split(/\s+/)[1]);
    if (!Number.isFinite(n) || n < 0 || n > 1000) {
      await tgReply(chatId, "Usage: /freepred <number>\nExample: /freepred 5");
      return;
    }
    (getAdminSettings()).free_pred_limit = Math.floor(n);
    saveAdminSettings();
    await tgReply(chatId, "✅ Free prediction limit = " + (getAdminSettings()).free_pred_limit);
    return;
  }
  // /freehistory 10
  if (lower.startsWith("/freehistory") || lower.startsWith("/freeapi")) {
    const n = Number(text.split(/\s+/)[1]);
    if (!Number.isFinite(n) || n < 0 || n > 100000) {
      await tgReply(chatId, "Usage: /freehistory <number>\nExample: /freehistory 10");
      return;
    }
    (getAdminSettings()).free_api_history_limit = Math.floor(n);
    saveAdminSettings();
    await tgReply(chatId, "✅ Free API history limit = " + (getAdminSettings()).free_api_history_limit);
    return;
  }
}

function escRe(t) {
  return String(t).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function userDocMenuPayload(uid) {
  const u = await dbFindUserById(uid);
  if (!u) return null;
  const ban = await dbIsUserBanned(uid);
  const exp = u.pro_expires_at
    ? new Date(u.pro_expires_at).toLocaleDateString("en-IN", {
        day: "numeric", month: "short", year: "numeric",
      })
    : "—";
  const planName =
    u.pro_plan && PLAN_CATALOG[u.pro_plan] ? PLAN_CATALOG[u.pro_plan].name : u.pro_plan;
  const text =
    "👤 " + (u.name || u.email || "User") + "  ·  #" + u.id + "\n" +
    "📧 " + (u.email || "—") + "\n" +
    "📦 Plan: " + (u.is_pro ? planName || "PRO" : "FREE") + "\n" +
    (u.is_pro ? "🟢 Pro ACTIVE till " + exp : "⚪ Pro nahi hai") + "\n" +
    (ban.banned ? "⛔ BANNED" : "✅ Not banned");
  const keyboard = [
    [
      { text: "⚡ Weekly ₹749 · 7d", callback_data: "up:" + u.id + ":weekly" },
      { text: "👑 Monthly ₹1498 · 30d", callback_data: "up:" + u.id + ":monthly" },
    ],
    [{ text: "❌ Pro band karo", callback_data: "up:" + u.id + ":none" }],
    [
      ban.banned
        ? { text: "🔓 UNBAN user", callback_data: "ub:" + u.id }
        : { text: "⛔ BAN user", callback_data: "bb:" + u.id },
    ],
    [
      { text: "← Users", callback_data: "users:list" },
      { text: "⭐ Pro list", callback_data: "users:pro" },
    ],
  ];
  return { text, keyboard };
}

function adminPanelText() {
  const s = getAdminSettings();
  const on = (v) => (v ? "✅ ON" : "❌ OFF");
  return (
    "🐉 DRAGO Admin Panel\n\n" +
    "Google Auth: " + on(s.google_auth_enabled) + "\n" +
    "Auto Payment (Rupayex): " + on(s.auto_payment_enabled) + "\n" +
    "Manual QR Payment: " + on(s.manual_payment_enabled) + "\n" +
    "DevTools Guard: " + on(s.guard_enabled) + "\n" +
    "Free predictions: " + s.free_pred_limit + "\n" +
    "Free API history fetches: " + s.free_api_history_limit + "\n\n" +
    "Commands:\n" +
    "/freepred 5 — set free prediction limit\n" +
    "/freehistory 10 — set free history API limit\n" +
    "/addgame /listgames /delgame <id>\n" +
    "/cancel"
  );
}

async function sendAdminPanel(chatId) {
  const s = getAdminSettings();
  let totalUsers = 0,
    proUsers = 0,
    todayUsers = 0;
  try {
    totalUsers = await col.users.countDocuments({});
    proUsers = await col.users.countDocuments({ is_pro: 1 });
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    todayUsers = await col.users.countDocuments({
      created_at: { $gte: dayStart.toISOString() },
    });
  } catch (e) {}
  const stats =
    "📊 Total users: " +
    totalUsers +
    " | Pro: " +
    proUsers +
    " | Aaj naye: " +
    todayUsers +
    "\n\n";
  await telegramApi("sendMessage", {
    chat_id: chatId,
    text: "🐉 DRAGO Admin Panel\n\n" + stats + adminPanelText().replace("🐉 DRAGO Admin Panel\n\n", ""),
    reply_markup: {
      inline_keyboard: [
        [
          {
            text:
              "📊 Users: " +
              totalUsers +
              " | Pro: " +
              proUsers +
              " | +Aaj: " +
              todayUsers,
            callback_data: "stats:refresh",
          },
        ],
        [
          {
            text: s.google_auth_enabled ? "🔴 Disable Google Auth" : "🟢 Enable Google Auth",
            callback_data: "cfg:google",
          },
        ],
        [
          {
            text: s.auto_payment_enabled ? "🔴 Disable Auto Pay" : "🟢 Enable Auto Pay",
            callback_data: "cfg:auto",
          },
          {
            text: s.manual_payment_enabled ? "🔴 Disable Manual" : "🟢 Enable Manual",
            callback_data: "cfg:manual",
          },
        ],
        [
          { text: "Pred −1", callback_data: "cfg:pred:-1" },
          { text: "Pred +1", callback_data: "cfg:pred:1" },
          { text: "Pred +5", callback_data: "cfg:pred:5" },
        ],
        [
          { text: "Hist −5", callback_data: "cfg:hist:-5" },
          { text: "Hist +5", callback_data: "cfg:hist:5" },
          { text: "Hist +10", callback_data: "cfg:hist:10" },
        ],
        [
          {
            text: s.guard_enabled
              ? "🔴 Disable DevTools Guard"
              : "🟢 Enable DevTools Guard",
            callback_data: "cfg:guard",
          },
        ],
        [
          {
            text: s.force_feedback ? "🐞 Bug in app: ON" : "🐞 Bug in app: OFF",
            callback_data: "cfg:feedback",
          },
        ],
        [
          {
            text: s.force_rate ? "⭐ Rate in app: ON" : "⭐ Rate in app: OFF",
            callback_data: "cfg:rate",
          },
        ],
        [
          {
            text: s.force_winfb ? "🏆 Feedback in app: ON" : "🏆 Feedback in app: OFF",
            callback_data: "cfg:winfb",
          },
        ],
        [{ text: "📢 New Announcement", callback_data: "act:announce" }],
        [{ text: "📢 New Announcement", callback_data: "act:announce" }],
        [{ text: "👥 Users Manage", callback_data: "users:list" }],
        [{ text: "🔄 Refresh", callback_data: "cfg:refresh" }],
      ],
    },
  });
}

/** Long-poll Telegram updates so Approve/Deny + /addgame work */

async function pollTelegramUpdates() {
  if (!TELEGRAM_BOT_TOKEN || getTgPolling()) return;
  setTgPolling(true);
  try {
    const url =
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates` +
      `?timeout=25&offset=${getTgOffset()}&allowed_updates=${encodeURIComponent(
        JSON.stringify(["callback_query", "message"])
      )}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(35000) });
    const data = await res.json();
    if (data && data.ok && Array.isArray(data.result)) {
      for (const upd of data.result) {
        setTgOffset(upd.update_id + 1);
        if (upd.callback_query) {
          try {
            await handleTelegramCallback(upd.callback_query);
          } catch (e) {
            console.error("tg callback:", e.message);
          }
        }
        if (upd.message) {
          try {
            await handleTelegramMessage(upd.message);
          } catch (e) {
            console.error("tg message:", e.message);
          }
        }
      }
    }
  } catch (err) {
    if (!String(err.message || "").includes("aborted")) {
      console.error("tg poll:", err.message);
    }
  } finally {
    setTgPolling(false);
  }
}

console.log("✅ MongoDB driver loaded (connect on listen)");

// ─── OAuth state store (memory) — cookie ke saath double protection ─────────
// Cookie free hosts / cross-proxy pe kabhi fail hoti hai; memory reliable hai.

module.exports = {
  adminPanelText,
  escRe,
  groupNotify,
  handleTelegramCallback,
  handleTelegramMessage,
  imgbbUploadBuffer,
  isTelegramAdmin,
  istTimeStr,
  looksLikeUrl,
  notifyAdminDevtoolsBan,
  notifyAdminManualPayment,
  pollTelegramUpdates,
  sendAdminPanel,
  sendBugReportToGroup,
  sendTelegramPhotoSmart,
  telegramPhotoToImgbb,
  tgConversations,
  tgReply,
  userDocMenuPayload,
};

require("../lib/lazy").register(module.exports);
