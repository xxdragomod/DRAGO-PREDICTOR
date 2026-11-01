/**
 * Telegram webhook + free-check routes
 *
 * Auto-split from the original monolithic server.js — behaviour unchanged.
 * Original lines: 6441-6463, 6465-6671
 */

const crypto = require("crypto");

const { app } = require("../app");
const { authUser } = require("../auth/token");
const { col } = require("../db/index");
const { timingSafeEqualStr } = require("../middleware/signature");
const { claimTelegramForUser, isFreeActive } = require("../models/users");
const { parseTgStartCode, tgCall, tgMemberStatus } = require("../telegram/free-bot");
const { FRONTEND_URL, TG_CHANNEL_ID, TG_CHANNEL_LINK, TG_FREE_SECRET, TG_OWNER_CHAT, TG_WEBHOOK_SECRET } = require("../config");

app.post("/tg/free-sync", async (req, res) => {
  try {
    const { uid, tg_id, exp, sig } = req.body || {};
    if (!uid || !tg_id || !exp || !sig) {
      return res.status(400).json({ ok: false, reason: "missing_params" });
    }
    const expected = crypto
      .createHmac("sha256", TG_FREE_SECRET)
      .update(`${uid}.${tg_id}.${exp}`)
      .digest("hex");
    if (String(sig) !== expected) {
      return res.status(403).json({ ok: false, reason: "invalid_sig" });
    }
    const claim = await claimTelegramForUser(Number(uid), Number(tg_id), Number(exp));
    if (!claim.ok) {
      return res.status(409).json(claim);
    }
    return res.json({ ok: true, owner_id: claim.owner_id });
  } catch (e) {
    return res.status(500).json({ ok: false, reason: "server_error" });
  }
});



app.post("/tg/webhook", async (req, res) => {
  // BE-2: Require valid Telegram webhook secret token header
  const incomingSecret = String(req.get("x-telegram-bot-api-secret-token") || "").trim();
  if (!incomingSecret || !timingSafeEqualStr(incomingSecret, TG_WEBHOOK_SECRET)) {
    return res.status(401).json({ ok: false, message: "Unauthorized webhook" });
  }
  res.json({ ok: true });
  try {
    // Telegram sends this update when a user submits a join request. A pending
    // request is not membership; acknowledge it but unlock only after approval.
    const joinRequest = req.body && req.body.chat_join_request;
    if (
      joinRequest &&
      joinRequest.from &&
      String(joinRequest.chat && joinRequest.chat.id) === String(TG_CHANNEL_ID)
    ) {
      await tgCall("sendMessage", {
        chat_id: joinRequest.from.id,
        text: "✅ Channel join request mil gaya. Verification admin approval ke baad hi complete hogi. Approval ke baad app/bot me wapas aakar ‘Joined — Verify Now’ dabayein.",
      });
      return;
    }

    const cb = req.body && req.body.callback_query;
    if (cb && cb.from && typeof cb.data === "string" && cb.data.startsWith("verify:")) {
      const code = cb.data.slice("verify:".length).trim();
      const uid = parseTgStartCode(code);
      if (uid == null) {
        await tgCall("answerCallbackQuery", {
          callback_query_id: cb.id,
          text: "Verification link expire ho gaya hai. App se dobara Verify par tap karein.",
          show_alert: true,
        });
        return;
      }
      const st = tgMemberStatus(await tgCall("getChatMember", { chat_id: TG_CHANNEL_ID, user_id: cb.from.id }));
      if (st === "member" || st === "administrator" || st === "creator") {
        const exp = Date.now() + 30 * 86400000;
        const claim = await claimTelegramForUser(uid, cb.from.id, exp);
        if (!claim.ok) {
          await tgCall("answerCallbackQuery", {
            callback_query_id: cb.id,
            text: "❌ 1 Telegram account se sirf 1 hi DRAGO ID verify ho sakti hai!",
            show_alert: true,
          });
          await tgCall("sendMessage", {
            chat_id: cb.message.chat.id,
            text:
              "❌ Verification Blocked!\n\n" +
              (claim.reason === "tg_already_used"
                ? `⚠️ Ye Telegram account pehle se hi DRAGO Account #${claim.owner_id} ke saath linked hai.\n\n🔒 Rule: 1 Telegram account se sirf 1 hi DRAGO ID verify ho sakti hai.\nApne pehle wale DRAGO account me login karein ya Unlimited Access ke liye Pro VIP Plan lein.`
                : "⚠️ Ye DRAGO account pehle se kisi dusre Telegram account se linked hai."),
            reply_markup: {
              inline_keyboard: [
                [{ text: "🚀 Open DRAGO App", url: `${FRONTEND_URL}/dashboard/` }],
              ],
            },
          });
          return;
        }
        const payload = `${uid}.${cb.from.id}.${exp}`;
        const sig = crypto.createHmac("sha256", TG_FREE_SECRET).update(payload).digest("hex");
        const freeToken = Buffer.from(payload).toString("base64url") + "." + sig;
        await tgCall("answerCallbackQuery", {
          callback_query_id: cb.id,
          text: "✅ Account Verified! Free Trial Activated.",
          show_alert: false,
        });
        await tgCall("sendMessage", {
          chat_id: cb.message.chat.id,
          text:
            "✅ Account Verified Successfully!\n\n" +
            "🎁 Aapka FREE Trial active ho gaya hai:\n" +
            "• 🔮 3 Free Predictions (Lifetime)\n" +
            "• 🔌 10 Drago API Data Fetches (Lifetime)\n" +
            "• 🤖 3 NEXUS Agent Uses (Lifetime)\n\n" +
            "💎 Unlimited access ke liye Pro Plan me upgrade karein.\n" +
            "👇 Niche button daba kar seedha app me jao:",
          reply_markup: {
            inline_keyboard: [
              [{ text: "🔮 Open Prediction", url: `${FRONTEND_URL}/prediction/#free=${freeToken}` }],
              [{ text: "🏠 Open Dashboard", url: `${FRONTEND_URL}/dashboard/#free=${freeToken}` }],
            ],
          },
        });
        await tgCall("sendMessage", {
          chat_id: TG_OWNER_CHAT,
          text: "🆓 User #" + uid + " (" + (cb.from.username || cb.from.first_name) + ") ne free plan activate kiya.",
        });
      } else {
        await tgCall("answerCallbackQuery", {
          callback_query_id: cb.id,
          text: "⚠️ Channel join karein. Join request bheji hai to admin approval ka wait karein; approve hone ke baad Verify Now dobara dabayein.",
          show_alert: true,
        });
      }
      return;
    }

    const msg = req.body && req.body.message;
    if (!msg || !msg.from || !msg.text || msg.text.indexOf("/start") !== 0) return;
    const rawParam = decodeURIComponent(msg.text.replace(/^\/start(@\S+)?/, "").trim());
    const uid = parseTgStartCode(rawParam);
    if (uid == null) {
      await tgCall("sendMessage", {
        chat_id: msg.chat.id,
        text: "👋 Welcome to DRAGO Predictor Bot!\n\nApna account verify karne ke liye DRAGO App kholein aur 'Verify Your Account' button par tap karein.",
        reply_markup: {
          inline_keyboard: [[{ text: "🚀 Open DRAGO App", url: `${FRONTEND_URL}/dashboard/` }]],
        },
      });
      return;
    }
    const st = tgMemberStatus(await tgCall("getChatMember", { chat_id: TG_CHANNEL_ID, user_id: msg.from.id }));
    if (st === "member" || st === "administrator" || st === "creator") {
      const exp = Date.now() + 30 * 86400000;
      const claim = await claimTelegramForUser(uid, msg.from.id, exp);
      if (!claim.ok) {
        await tgCall("sendMessage", {
          chat_id: msg.chat.id,
          text:
            "❌ Verification Blocked!\n\n" +
            (claim.reason === "tg_already_used"
              ? `⚠️ Ye Telegram account pehle se hi DRAGO Account #${claim.owner_id} ke saath linked hai.\n\n🔒 Rule: 1 Telegram account se sirf 1 hi DRAGO ID verify ho sakti hai.\nApne pehle wale DRAGO account me login karein ya Unlimited Access ke liye Pro VIP Plan lein.`
              : "⚠️ Ye DRAGO account pehle se kisi dusre Telegram account se linked hai."),
          reply_markup: {
            inline_keyboard: [
              [{ text: "🚀 Open DRAGO App", url: `${FRONTEND_URL}/dashboard/` }],
            ],
          },
        });
        return;
      }
      const payload = `${uid}.${msg.from.id}.${exp}`;
      const sig = crypto.createHmac("sha256", TG_FREE_SECRET).update(payload).digest("hex");
      const freeToken = Buffer.from(payload).toString("base64url") + "." + sig;
      await tgCall("sendMessage", {
        chat_id: msg.chat.id,
        text:
          "✅ Account Verified Successfully!\n\n" +
          "🎁 Aapka FREE Trial active ho gaya hai:\n" +
          "• 🔮 3 Free Predictions (Lifetime)\n" +
          "• 🔌 10 Drago API Data Fetches (Lifetime)\n" +
          "• 🤖 3 NEXUS Agent Uses (Lifetime)\n\n" +
          "💎 Unlimited access ke liye Pro Plan me upgrade karein.\n" +
          "👇 Niche button daba kar seedha app me jao:",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔮 Open Prediction", url: `${FRONTEND_URL}/prediction/#free=${freeToken}` }],
            [{ text: "🏠 Open Dashboard", url: `${FRONTEND_URL}/dashboard/#free=${freeToken}` }],
          ],
        },
      });
      await tgCall("sendMessage", {
        chat_id: TG_OWNER_CHAT,
        text: "🆓 User #" + uid + " (" + (msg.from.username || msg.from.first_name) + ") ne free plan activate kiya.",
      });
    } else {
      await tgCall("sendMessage", {
        chat_id: msg.chat.id,
        text: "🔐 DRAGO Free Plan Verification\n\n1️⃣ Niche 'Join Official Channel' par tap karke channel join karein ya join request bhejein.\n2️⃣ Request pending ho to admin approval ka wait karein. Approval ke baad 'Joined — Verify Now' dabayein; pending request se access activate nahi hota.",
        reply_markup: {
          inline_keyboard: [
            [{ text: "📢 1. Join Official Channel", url: TG_CHANNEL_LINK }],
            [{ text: "✅ 2. Joined — Verify Now", callback_data: `verify:${rawParam}` }],
          ],
        },
      });
    }
  } catch (e) {
    console.error("tg/webhook:", e.message);
  }
});

app.get("/free-check", async (req, res) => {
  const decoded = authUser(req, res);
  if (!decoded) return;
  try {
    const u = await col.users.findOne({ id: Number(decoded.id) });
    if (u && u.tg_id) {
      const exp =
        u.free_expires_at && Number(u.free_expires_at) > Date.now()
          ? Number(u.free_expires_at)
          : Date.now() + 30 * 86400000;
      const claim = await claimTelegramForUser(u.id, u.tg_id, exp);
      if (!claim.ok) {
        return res.json({
          success: true,
          free_active: 0,
          tg_already_used: true,
          owner_id: claim.owner_id || null,
        });
      }
      const st = tgMemberStatus(await tgCall("getChatMember", { chat_id: TG_CHANNEL_ID, user_id: u.tg_id }));
      if (st === "member" || st === "administrator" || st === "creator") {
        const payload = `${u.id}.${u.tg_id}.${exp}`;
        const sig = crypto.createHmac("sha256", TG_FREE_SECRET).update(payload).digest("hex");
        const freeToken = Buffer.from(payload).toString("base64url") + "." + sig;
        return res.json({ success: true, free_active: 1, free_token: freeToken });
      }
    }
    res.json({ success: true, free_active: u && isFreeActive(u) ? 1 : 0 });
  } catch (e) {
    res.json({ success: true, free_active: 0 });
  }
});

module.exports = {};
