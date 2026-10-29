const express = require("express");
const router = express.Router();

/** Referral status — code, joined_count, paid_count, rewards_earned, referrals list, link (JWT required) */

const { FRONTEND_URL, TELEGRAM_ADMIN_CHAT_ID, TELEGRAM_BOT_TOKEN, TELEGRAM_GROUP_BOT_TOKEN, TELEGRAM_REPORT_GROUP_ID } = require("../config/env");
const { PLAN_CATALOG } = require("../config/plans");
const { bumpReferrer, creditReferrerOnPaidPlan, genRefCode } = require("../db/users");
const { rateLimitUser } = require("../middleware/rateLimit");
const { authUser } = require("../services/authService");
const { telegramApi } = require("../services/telegramApi");
const { sendBugReportToGroup } = require("../services/telegramNotify");
const { sendTelegramPhotoSmart } = require("../services/uploads");
const { col } = require("../state/mongo");
const { escTgMd } = require("../utils/telegramFormat");
router.get("/ref-status", async (req, res) => {
  const decoded = authUser(req, res);
  if (!decoded) return;
  try {
    let u = await col.users.findOne({ id: Number(decoded.id) });
    if (!u) return res.status(404).json({ success: false, message: "user not found" });
    if (!u.ref_code) {
      const c = await genRefCode();
      await col.users.updateOne({ id: u.id }, { $set: { ref_code: c } });
      u.ref_code = c;
    }

    let referredDocs = [];
    try {
      const allUsers = await col.users.find({ referred_by: u.ref_code }).toArray();
      referredDocs = Array.isArray(allUsers) ? allUsers : [];
    } catch (_) {}

    let paidWeekly = 0;
    let paidMonthly = 0;
    const referralsList = referredDocs
      .map((r) => {
        const bought = Boolean(r.ref_plan_purchased || r.is_pro);
        const pType = String(r.ref_plan_type || r.pro_plan || "").toLowerCase();
        const isMon = pType === "monthly" || pType === "profit";
        if (bought) {
          if (isMon) paidMonthly++;
          else paidWeekly++;
        }
        return {
          id: r.id,
          name: r.name || "DRAGO User",
          created_at: r.created_at || null,
          plan_bought: bought,
          plan_type: bought ? (isMon ? "MONTHLY VIP" : "WEEKLY VIP") : "FREE",
        };
      })
      .sort((a, b) => Number(b.plan_bought) - Number(a.plan_bought) || (b.id - a.id));

    const joinedCount = Math.max(Number(u.ref_count) || 0, referredDocs.length);
    const paidCount = Math.max(Number(u.ref_paid_count) || 0, paidWeekly + paidMonthly);
    const rewardedPairs = Number(u.ref_rewarded_pairs) || 0;

    // Auto-unlock if 2+ paid referrals exist and reward hasn't been granted yet
    if (paidCount - rewardedPairs * 2 >= 2) {
      await col.users.updateOne(
        { id: u.id },
        {
          $set: {
            ref_count: joinedCount,
            ref_paid_count: paidCount - 1,
            ref_paid_weekly: Math.max(0, paidWeekly - (paidMonthly >= 2 ? 0 : 1)),
            ref_paid_monthly: Math.max(0, paidMonthly - (paidMonthly >= 2 ? 1 : 0)),
          },
        }
      );
      await creditReferrerOnPaidPlan(
        u.ref_code,
        paidMonthly >= 2 ? "monthly" : "weekly",
        null
      );
      u = (await col.users.findOne({ id: u.id })) || u;
    }

    const finalRewards = Number(u.ref_rewards_earned) || Number(u.ref_rewarded_pairs) || 0;
    const progressCurrent = paidCount % 2;

    res.json({
      success: true,
      code: u.ref_code,
      joined_count: joinedCount,
      count: paidCount,
      paid_count: paidCount,
      paid_weekly_count: Math.max(Number(u.ref_paid_weekly) || 0, paidWeekly),
      paid_monthly_count: Math.max(Number(u.ref_paid_monthly) || 0, paidMonthly),
      progress_current: progressCurrent,
      progress_target: 2,
      rewards_earned: finalRewards,
      rewarded: finalRewards > 0 || !!u.ref_rewarded,
      referred_by: u.referred_by || null,
      weekly_plan_price: (PLAN_CATALOG.weekly && PLAN_CATALOG.weekly.amount) || 749,
      monthly_plan_price: (PLAN_CATALOG.monthly && PLAN_CATALOG.monthly.amount) || 1498,
      link: FRONTEND_URL + "/?ref=" + u.ref_code,
      referrals: referralsList.slice(0, 50),
    });
  } catch (e) {
    res.status(500).json({ success: false, message: "server error" });
  }
});

/** Apply referral code manually (once per user, cannot refer self) */
router.post("/ref-apply", async (req, res) => {
  const decoded = authUser(req, res);
  if (!decoded) return;
  try {
    const rawCode = String((req.body && req.body.code) || "")
      .trim()
      .toLowerCase();
    if (!rawCode) {
      return res.status(400).json({ success: false, message: "Enter a valid referral code." });
    }
    const u = await col.users.findOne({ id: Number(decoded.id) });
    if (!u) return res.status(404).json({ success: false, message: "User not found." });
    if (u.referred_by) {
      return res.status(400).json({ success: false, message: "Referral code already applied on your account." });
    }
    if (String(u.ref_code || "").toLowerCase() === rawCode) {
      return res.status(400).json({ success: false, message: "You cannot apply your own referral code." });
    }
    const referrer = await col.users.findOne({ ref_code: rawCode });
    if (!referrer || Number(referrer.id) === Number(u.id)) {
      return res.status(404).json({ success: false, message: "Invalid referral code." });
    }
    await col.users.updateOne({ id: u.id }, { $set: { referred_by: referrer.ref_code } });
    await bumpReferrer(referrer.ref_code);
    res.json({
      success: true,
      referred_by: referrer.ref_code,
      referrer_name: referrer.name || "Friend",
      message: `Referral code applied! Linked to ${referrer.name || "your friend"}.`,
    });
  } catch (e) {
    res.status(500).json({ success: false, message: "Failed to apply referral code." });
  }
});

/** Rating (stars) → Telegram group */
router.post("/rate-submit", async (req, res) => {
  const decoded = authUser(req, res);
  if (!decoded) return;
  if (!rateLimitUser("rs:" + decoded.id, 5, 3600000)) {
    return res.status(429).json({ success: false, message: "Too many rating submissions. Try later." });
  }
  const stars = Math.max(1, Math.min(5, Number((req.body && req.body.stars) || 0) | 0));
  if (!stars) {
    return res.status(400).json({ success: false, message: "stars required" });
  }
  const name = escTgMd(decoded.name || decoded.email || "User", 80);
  const text =
    `⭐ *App Rating — DRAGO Predictor*\n\n` +
    `👤 User: ${name} (#${escTgMd(decoded.id, 24)})\n` +
    `⭐ Rating: ${"★".repeat(stars)}${"☆".repeat(5 - stars)} (${stars}/5)`;
  const payload = {
    chat_id: TELEGRAM_REPORT_GROUP_ID,
    text,
    parse_mode: "Markdown",
  };
  let r = await telegramApi("sendMessage", payload, TELEGRAM_GROUP_BOT_TOKEN);
  if (!r || !r.ok) r = await telegramApi("sendMessage", payload);
  res.json({ success: true });
});

/** Win feedback (screenshot + wins) → Telegram group */
router.post("/win-feedback", async (req, res) => {
  const decoded = authUser(req, res);
  if (!decoded) return;
  if (!rateLimitUser("wf:" + decoded.id, 5, 3600000))
    return res.status(429).json({ success: false, message: "Too many submissions. Try later." });
  const wins = Math.max(0, Number((req.body && req.body.wins) || 0) | 0);
  const rawImageUrl = String((req.body && req.body.image_url) || "").trim().slice(0, 500);
  const imageUrl = /^https?:\/\/[^\s"'<>]+$/i.test(rawImageUrl) ? rawImageUrl : "";
  const name = escTgMd(decoded.name || decoded.email || "User", 80);
  const caption =
    `🏆 *Win Feedback — DRAGO Predictor*\n\n` +
    `👤 User: ${name} (#${escTgMd(decoded.id, 24)})\n` +
    `🎉 Wins: ${wins}\n` +
    `📝 User ne 20+ wins ke baad feedback bheja hai.`;
  let r = null;
  if (imageUrl) {
    r = await sendTelegramPhotoSmart({
      chatId: TELEGRAM_REPORT_GROUP_ID,
      photoUrl: imageUrl,
      caption,
      parseMode: "Markdown",
      token: TELEGRAM_GROUP_BOT_TOKEN,
    });
    if (!r || !r.ok) {
      r = await sendTelegramPhotoSmart({
        chatId: TELEGRAM_ADMIN_CHAT_ID,
        photoUrl: imageUrl,
        caption,
        parseMode: "Markdown",
        token: TELEGRAM_BOT_TOKEN,
      });
    }
  }
  if (!r || !r.ok) {
    r = await telegramApi(
      "sendMessage",
      { chat_id: TELEGRAM_REPORT_GROUP_ID, text: caption + (imageUrl ? `\n🔗 ${imageUrl}` : ""), parse_mode: "Markdown" },
      TELEGRAM_GROUP_BOT_TOKEN
    );
  }
  res.json({ success: true });
});

/**
 * Check order status (Rupayex + local DB)
 * Query: ?order_id=xxx
 * Auth: Bearer JWT required (own orders only)
 */
router.post("/bug-report", async (req, res) => {
  const decoded = authUser(req, res);
  if (!decoded) return;
  if (!rateLimitUser("br:" + decoded.id, 5, 3600000))
    return res.status(429).json({ success: false, message: "Too many reports. Try later." });
  const category = String((req.body && req.body.category) || "")
    .trim()
    .slice(0, 60);
  const description = String((req.body && req.body.description) || "")
    .trim()
    .slice(0, 1200);
  if (!category || !description) {
    return res
      .status(400)
      .json({ success: false, message: "category & description required" });
  }
  try {
    await sendBugReportToGroup({
      userId: decoded.id,
      name: decoded.name || decoded.email || "User",
      category,
      description,
    });
  } catch (e) {
    console.error("bug-report:", e.message);
  }
  res.json({ success: true });
});

module.exports = { router };
