/**
 * User model + referrals + pro/free lifecycle
 *
 * Auto-split from the original monolithic server.js — behaviour unchanged.
 * Original lines: 479-809
 */

const crypto = require("crypto");

const { col, nextSeq } = require("../db/index");
const { mapUser } = require("./mappers");
const { formatIstDateShort, formatNotifTemplate, pushNotification } = require("../notifications");
const { PLAN_CATALOG } = require("../plans");
const { DEFAULT_ADMIN_SETTINGS } = require("../settings/defaults");
const { groupNotify, istTimeStr } = require("../telegram/admin-bot");
const { getAdminSettings } = require("../state");

async function dbFindUserByGoogle(googleId) {
  return mapUser(await col.users.findOne({ google_id: googleId }));
}
async function dbFindUserById(id) {
  return mapUser(await col.users.findOne({ id: Number(id) }));
}
async function dbFindUserByIdLite(id) {
  const u = await dbFindUserById(id);
  if (!u) return null;
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    picture: u.picture,
    is_pro: u.is_pro,
    free_active: isFreeActive(u) ? 1 : 0,
    pro_plan: u.pro_plan,
    pro_expires_at: u.pro_expires_at,
  };
}
async function genRefCode() {
  for (let i = 0; i < 5; i++) {
    const c = crypto.randomBytes(4).toString("hex");
    const ex = await col.users.findOne({ ref_code: c });
    if (!ex) return c;
  }
  return crypto.randomBytes(6).toString("hex");
}
async function dbInsertUser(googleId, email, name, picture, referredBy) {
  const id = await nextSeq("users");
  const doc = {
    id,
    google_id: googleId,
    email: email || "",
    name: name || "",
    picture: picture || "",
    is_pro: 0,
    pro_plan: null,
    pro_expires_at: null,
    free_pred_used: 0,
    free_api_used: 0,
    free_nexus_used: 0,
    ref_code: await genRefCode(),
    referred_by: referredBy || null,
    ref_count: 0,
    ref_rewarded: false,
    created_at: new Date().toISOString(),
  };
  await col.users.insertOne(doc);
  return mapUser(doc);
}
/** Referrer joined count badhao (freeplan reward tabhi milega jab 2 referred users VIP plan buy karenge) */
async function bumpReferrer(code) {
  try {
    if (!code || !col.users) return;
    const referrer = await col.users.findOne({ ref_code: String(code).trim() });
    if (!referrer) return;
    await col.users.updateOne(
      { ref_code: String(code).trim() },
      { $inc: { ref_count: 1 } }
    );
  } catch (e) {
    console.warn("bumpReferrer:", e.message);
  }
}

/**
 * Jab kisi referred user ka VIP plan activate ho (paid weekly/monthly),
 * referrer ke paid referrals check karo:
 * - Har 2 Weekly Paid Referrals par referrer ko 1 Weekly VIP Plan (7 Days) FREE milega!
 * - Har 2 Monthly Paid Referrals par referrer ko 1 Monthly VIP Plan (30 Days) FREE milega!
 */
async function creditReferrerOnPaidPlan(refCode, purchasedPlanKey, buyerUser) {
  try {
    if (!refCode || !col.users) return;
    const cleanCode = String(refCode).trim();
    const referrer = await col.users.findOne({ ref_code: cleanCode });
    if (!referrer) return;
    if (buyerUser && Number(referrer.id) === Number(buyerUser.id)) return;

    const pKey = String(purchasedPlanKey || "weekly").toLowerCase();
    const isMonthly = pKey === "monthly" || pKey === "profit";

    const incFields = {
      ref_paid_count: 1,
      ...(isMonthly ? { ref_paid_monthly: 1 } : { ref_paid_weekly: 1 }),
    };
    await col.users.updateOne({ id: referrer.id }, { $inc: incFields });

    const freshRef = await col.users.findOne({ id: referrer.id });
    if (!freshRef) return;

    const totalPaid = Number(freshRef.ref_paid_count) || 0;
    const paidMonthly = Number(freshRef.ref_paid_monthly) || 0;
    const rewardedPairs = Number(freshRef.ref_rewarded_pairs) || 0;
    const rewardedMonthlyUsed = Number(freshRef.ref_rewarded_monthly_used) || 0;

    const unrewardedTotal = totalPaid - rewardedPairs * 2;
    const unrewardedMonthly = paidMonthly - rewardedMonthlyUsed;

    if (unrewardedTotal >= 2) {
      const giveMonthly = unrewardedMonthly >= 2;
      const rewardPlanKey = giveMonthly ? "monthly" : "weekly";
      const rewardDays = giveMonthly
        ? (PLAN_CATALOG.monthly && PLAN_CATALOG.monthly.days) || 30
        : (PLAN_CATALOG.weekly && PLAN_CATALOG.weekly.days) || 7;
      const rewardLabel = giveMonthly ? "Monthly VIP Plan (30 Days)" : "Weekly VIP Plan (7 Days)";

      const upd = await col.users.updateOne(
        { id: freshRef.id, ref_rewarded_pairs: rewardedPairs },
        {
          $inc: {
            ref_rewarded_pairs: 1,
            ref_rewards_earned: 1,
            ...(giveMonthly ? { ref_rewarded_monthly_used: 2 } : {}),
          },
          $set: { ref_rewarded: true },
        }
      );

      if (upd && (upd.modifiedCount || upd.matchedCount)) {
        const nowMs = Date.now();
        const curExpMs =
          freshRef.is_pro && freshRef.pro_expires_at
            ? new Date(freshRef.pro_expires_at).getTime()
            : 0;
        const baseMs = curExpMs > nowMs ? curExpMs : nowMs;
        const newExpires = new Date(baseMs + rewardDays * 86400000).toISOString();

        await dbSetUserPro(freshRef.id, 1, rewardPlanKey, newExpires, {
          isReferralReward: true,
        });

        pushNotification({
          target: "user",
          user_id: freshRef.id,
          user_name: freshRef.name || "VIP Member",
          type: "plan_active",
          title: `🎁 Free ${rewardLabel} Unlocked!`,
          message: `Congratulations ${freshRef.name || "Partner"}! 2 of your referred friends purchased a VIP Plan. Your FREE ${rewardLabel} is now ACTIVE till ${formatIstDateShort(newExpires)}!`,
          image_url: null,
          action_url: "/prediction/",
          action_label: "OPEN PREDICTION →",
        });

        groupNotify(
          "🎁 *REFERRAL VIP REWARD UNLOCKED*\n\n" +
            "👤 Referrer: " + (freshRef.name || "User") + " (#" + freshRef.id + ")\n" +
            "👥 Paid Referrals: " + totalPaid + " (" + (giveMonthly ? "2 Monthly Paid" : "2 Weekly Paid") + ")\n" +
            "🏆 Free Reward: " + rewardLabel + " Activated FREE\n" +
            "🕒 Time: " + istTimeStr(),
          true
        );
      }
    }
  } catch (e) {
    console.warn("creditReferrerOnPaidPlan:", e.message);
  }
}
async function dbUpdateUserProfile(googleId, name, picture) {
  await col.users.updateOne(
    { google_id: googleId },
    { $set: { name: name || "", picture: picture || "" } }
  );
}
async function dbSetUserPro(userId, isPro, planKey, expires, opts = {}) {
  const uid = Number(userId);
  let prevUser = null;
  try {
    if (col.users) prevUser = await col.users.findOne({ id: uid });
  } catch (_) {}

  const extraSet = {};
  const isFirstPaidPurchase =
    Boolean(isPro) &&
    !opts.isReferralReward &&
    prevUser &&
    prevUser.referred_by &&
    !prevUser.ref_plan_purchased;

  if (isFirstPaidPurchase) {
    extraSet.ref_plan_purchased = true;
    extraSet.ref_plan_type = String(planKey || "weekly").toLowerCase();
    extraSet.ref_plan_purchased_at = new Date().toISOString();
  }

  await col.users.updateOne(
    { id: uid },
    {
      $set: {
        is_pro: isPro ? 1 : 0,
        pro_plan: planKey || null,
        pro_expires_at: expires || null,
        ...(isPro ? { pro_expired_notified_for: null } : {}),
        ...extraSet,
      },
    }
  );

  if (isFirstPaidPurchase && prevUser && prevUser.referred_by) {
    await creditReferrerOnPaidPlan(prevUser.referred_by, planKey, prevUser);
  }

  try {
    const userName = (prevUser && (prevUser.name || prevUser.email)) || "VIP Member";
    if (isPro) {
      const pKey = String(planKey || "weekly").toLowerCase();
      const planLabel =
        pKey === "monthly" || pKey === "profit"
          ? "PRO VIP MONTHLY"
          : "PRO VIP WEEKLY";
      const daysCount = expires
        ? Math.max(1, Math.round((new Date(expires).getTime() - Date.now()) / 86400000))
        : (PLAN_CATALOG[pKey] && PLAN_CATALOG[pKey].days) || 7;
      const expStr = expires ? formatIstDateShort(expires) : `${daysCount} Days`;

      const title = formatNotifTemplate(
        (getAdminSettings() && (getAdminSettings()).notif_plan_active_title) ||
          DEFAULT_ADMIN_SETTINGS.notif_plan_active_title,
        { name: userName, plan: planLabel, days: daysCount, expiry: expStr }
      );
      const message = formatNotifTemplate(
        (getAdminSettings() && (getAdminSettings()).notif_plan_active_body) ||
          DEFAULT_ADMIN_SETTINGS.notif_plan_active_body,
        { name: userName, plan: planLabel, days: daysCount, expiry: expStr }
      );
      pushNotification({
        target: "user",
        user_id: uid,
        user_name: userName,
        type: "plan_active",
        title,
        message,
        image_url: (getAdminSettings() && (getAdminSettings()).notif_plan_active_image) || null,
        action_url: "/prediction/",
        action_label: "OPEN PREDICTION →",
      });
    } else if (prevUser && prevUser.is_pro) {
      const expStr = formatIstDateShort(new Date().toISOString());
      const title = formatNotifTemplate(
        (getAdminSettings() && (getAdminSettings()).notif_plan_expired_title) ||
          DEFAULT_ADMIN_SETTINGS.notif_plan_expired_title,
        { name: userName, expiry: expStr }
      );
      const message = formatNotifTemplate(
        (getAdminSettings() && (getAdminSettings()).notif_plan_expired_body) ||
          DEFAULT_ADMIN_SETTINGS.notif_plan_expired_body,
        { name: userName, expiry: expStr }
      );
      pushNotification({
        target: "user",
        user_id: uid,
        user_name: userName,
        type: "plan_expired",
        title,
        message,
        image_url: (getAdminSettings() && (getAdminSettings()).notif_plan_expired_image) || null,
        action_url: "/payment/?plan=weekly",
        action_label: "RENEW VIP PLAN →",
      });
    }
  } catch (e) {
    console.warn("dbSetUserPro notif:", e.message);
  }
}
function isFreeActive(u) {
  return !!(u && u.free_active) && (!u.free_expires_at || Number(u.free_expires_at) > Date.now());
}
async function dbSetUserFree(userId, tgId, active, expires) {
  await col.users.updateOne(
    { id: Number(userId) },
    { $set: { free_active: active ? 1 : 0, free_expires_at: expires || null, tg_id: tgId != null ? Number(tgId) : null } }
  );
}
/**
 * Strictly enforce 1 Telegram account = 1 DRAGO ID.
 * If tgId is already claimed by another userId, reject and return owner_id.
 */
async function claimTelegramForUser(userId, tgId, expires) {
  const uidNum = Number(userId);
  const tgNum = Number(tgId);
  if (!uidNum || !tgNum) {
    return { ok: false, reason: "invalid_params" };
  }

  const matches = await col.users
    .find({ tg_id: tgNum })
    .sort({ id: 1 })
    .toArray();

  if (matches.length > 0) {
    const primaryOwner = matches[0];
    if (matches.length > 1) {
      const dupIds = matches.slice(1).map((u) => u.id);
      await col.users.updateMany(
        { id: { $in: dupIds } },
        { $set: { free_active: 0, free_expires_at: null, tg_id: null } }
      );
    }
    if (Number(primaryOwner.id) !== uidNum) {
      return {
        ok: false,
        reason: "tg_already_used",
        owner_id: primaryOwner.id,
      };
    }
  }

  const currentUser = await col.users.findOne({ id: uidNum });
  if (!currentUser) {
    return { ok: false, reason: "user_not_found" };
  }
  if (currentUser.tg_id && Number(currentUser.tg_id) !== tgNum) {
    return {
      ok: false,
      reason: "user_has_other_tg",
    };
  }

  await col.users.updateOne(
    { id: uidNum },
    {
      $set: {
        free_active: 1,
        free_expires_at: expires || null,
        tg_id: tgNum,
      },
    }
  );
  return { ok: true, owner_id: uidNum };
}

module.exports = {
  bumpReferrer,
  claimTelegramForUser,
  creditReferrerOnPaidPlan,
  dbFindUserByGoogle,
  dbFindUserById,
  dbFindUserByIdLite,
  dbInsertUser,
  dbSetUserFree,
  dbSetUserPro,
  dbUpdateUserProfile,
  genRefCode,
  isFreeActive,
};

require("../lib/lazy").register(module.exports);
