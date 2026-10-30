const { BRAND_NAME } = require("../config/env");
const crypto = require("crypto");
const { PLAN_CATALOG } = require("../config/plans");
const { formatNotifTemplate, pushNotification } = require("../services/notifications");
const { groupNotify } = require("../services/telegramNotify");
const { DEFAULT_ADMIN_SETTINGS, adminSettings } = require("../state/adminSettings");
const { col } = require("../state/mongo");
const { nextSeq } = require("../utils/seq");
const { formatIstDateShort, istTimeStr } = require("../utils/time");
const { isFreeActive, mapUser } = require("./mappers");
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
        (adminSettings && adminSettings.notif_plan_active_title) ||
          DEFAULT_ADMIN_SETTINGS.notif_plan_active_title,
        { name: userName, plan: planLabel, days: daysCount, expiry: expStr }
      );
      const message = formatNotifTemplate(
        (adminSettings && adminSettings.notif_plan_active_body) ||
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
        image_url: (adminSettings && adminSettings.notif_plan_active_image) || null,
        action_url: "/prediction/",
        action_label: "OPEN PREDICTION →",
      });
    } else if (prevUser && prevUser.is_pro) {
      const expStr = formatIstDateShort(new Date().toISOString());
      const title = formatNotifTemplate(
        (adminSettings && adminSettings.notif_plan_expired_title) ||
          DEFAULT_ADMIN_SETTINGS.notif_plan_expired_title,
        { name: userName, expiry: expStr }
      );
      const message = formatNotifTemplate(
        (adminSettings && adminSettings.notif_plan_expired_body) ||
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
        image_url: (adminSettings && adminSettings.notif_plan_expired_image) || null,
        action_url: "/payment/?plan=weekly",
        action_label: "RENEW VIP PLAN →",
      });
    }
  } catch (e) {
    console.warn("dbSetUserPro notif:", e.message);
  }
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
async function dbGetFreePredUsed(userId) {
  const u = await col.users.findOne(
    { id: Number(userId) },
    { projection: { free_pred_used: 1 } }
  );
  return Number(u && u.free_pred_used) || 0;
}
async function dbBumpFreePred(userId) {
  await col.users.updateOne(
    { id: Number(userId) },
    { $inc: { free_pred_used: 1 } }
  );
}
async function dbGetFreeApiUsed(userId) {
  const u = await col.users.findOne(
    { id: Number(userId) },
    { projection: { free_api_used: 1 } }
  );
  return Number(u && u.free_api_used) || 0;
}
async function dbBumpFreeApi(userId) {
  await col.users.updateOne(
    { id: Number(userId) },
    { $inc: { free_api_used: 1 } }
  );
}
async function dbGetFreeNexusUsed(userId) {
  const u = await col.users.findOne(
    { id: Number(userId) },
    { projection: { free_nexus_used: 1 } }
  );
  return Number(u && u.free_nexus_used) || 0;
}
async function dbBumpFreeNexus(userId) {
  await col.users.updateOne(
    { id: Number(userId) },
    { $inc: { free_nexus_used: 1 } }
  );
}

async function notifyUserBanStatus(userId, isBanned, reason) {
  try {
    const uid = Number(userId);
    if (!uid) return;
    let userName = `User #${uid}`;
    if (col.users) {
      const u = await col.users.findOne(
        { id: uid },
        { projection: { name: 1, email: 1 } }
      );
      if (u && (u.name || u.email)) userName = u.name || u.email;
    }
    if (isBanned) {
      const cleanReason = String(reason || "Security policy").slice(0, 120);
      pushNotification({
        target: "user",
        user_id: uid,
        user_name: userName,
        type: "account_banned",
        title: "🚫 Account Blocked / Restricted",
        message: `Hi ${userName}, your ${BRAND_NAME} ID (#${uid}) has been blocked (${cleanReason}). Please contact Admin Support if you need help.`,
        action_url: "/profile/",
        action_label: "CONTACT SUPPORT →",
      });
    } else {
      pushNotification({
        target: "user",
        user_id: uid,
        user_name: userName,
        type: "account_unbanned",
        title: "✅ Account Unblocked & Restored!",
        message: `Good news ${userName}! Your DRAGO Predictor ID (#${uid}) has been unblocked by Admin. You can now use all features again.`,
        action_url: "/dashboard/",
        action_label: "OPEN APP →",
      });
    }
  } catch (e) {
    console.warn("notifyUserBanStatus:", e.message);
  }
}

async function dbBanUser(userId, reason) {
  const r = await col.users.updateOne(
    { id: Number(userId) },
    {
      $set: {
        banned: 1,
        banned_at: new Date().toISOString(),
        ban_reason: String(reason || "policy").slice(0, 200),
      },
    }
  );
  if (r.matchedCount > 0) {
    notifyUserBanStatus(userId, true, reason);
  }
  return r.matchedCount > 0;
}
/** DevTools detect → temporary block (admin UNLOCK kar sakta hai) */
async function dbBlockUser(userId, reason, device) {
  const r = await col.users.updateOne(
    { id: Number(userId) },
    {
      $set: {
        banned: 1,
        ban_state: "blocked",
        banned_at: new Date().toISOString(),
        ban_reason: String(reason || "devtools").slice(0, 200),
      },
    }
  );
  if (device && col.banned_devices) {
    await col.banned_devices.updateOne(
      { device: String(device) },
      {
        $set: {
          device: String(device),
          user_id: Number(userId),
          state: "blocked",
          at: new Date().toISOString(),
        },
      },
      { upsert: true }
    );
  }
  if (r.matchedCount > 0) {
    notifyUserBanStatus(userId, true, reason || "Security lock");
  }
  return r.matchedCount > 0;
}
/** Device-only block (bina login user ke) */
async function dbBlockDevice(device, reason) {
  if (!device || !col.banned_devices) return false;
  const r = await col.banned_devices.updateOne(
    { device: String(device) },
    {
      $set: {
        device: String(device),
        user_id: null,
        state: "blocked",
        reason: String(reason || "devtools").slice(0, 200),
        at: new Date().toISOString(),
      },
    },
    { upsert: true }
  );
  return !!r;
}
/** Admin Telegram / Admin Panel se permanent BAN */
async function dbBanPermanent(userId, reason) {
  await col.users.updateOne(
    { id: Number(userId) },
    {
      $set: {
        banned: 1,
        ban_state: "banned",
        banned_at: new Date().toISOString(),
        ban_reason: String(reason || "Admin ban").slice(0, 200),
      },
      $inc: { token_version: 1 },
    }
  );
  if (col.banned_devices) {
    await col.banned_devices.updateMany(
      { user_id: Number(userId) },
      { $set: { state: "banned" } }
    );
  }
  notifyUserBanStatus(userId, true, reason || "Admin ban");
  return true;
}
async function dbBanUserPermanent(userId, reason) {
  return dbBanPermanent(userId, reason);
}
/** Admin Telegram / Admin Panel se UNLOCK */
async function dbUnbanUser(userId) {
  await col.users.updateOne(
    { id: Number(userId) },
    { $set: { banned: 0, ban_state: "ok", ban_reason: null } }
  );
  if (col.banned_devices) {
    await col.banned_devices.deleteMany({ user_id: Number(userId) });
  }
  notifyUserBanStatus(userId, false);
  return true;
}
async function dbUnlockUser(userId) {
  return dbUnbanUser(userId);
}
async function dbIsUserBanned(userId) {
  const u = await col.users.findOne(
    { id: Number(userId) },
    { projection: { banned: 1, ban_reason: 1, ban_state: 1 } }
  );
  return u && u.banned
    ? { banned: true, reason: u.ban_reason || null, state: u.ban_state === "banned" ? "banned" : "blocked" }
    : { banned: false, state: "ok" };
}
async function dbBanStateByDevice(device) {
  if (!device || !col.banned_devices) return null;
  const d = await col.banned_devices.findOne({ device: String(device) });
  return d ? (d.state === "banned" ? "banned" : "blocked") : null;
}
/** Blocked/banned users ki list (Telegram /banlist ke liye) */
async function dbListBanned(limit) {
  const rows = await col.users
    .find({ banned: 1 })
    .sort({ banned_at: -1 })
    .limit(limit || 30)
    .toArray();
  const list = rows.map((u) => ({
    id: u.id,
    name: u.name || "",
    email: u.email || "",
    device: null,
    state: u.ban_state === "banned" ? "banned" : "blocked",
    at: u.banned_at || "",
    reason: u.ban_reason || "",
  }));
  // Device-only blocks (bina login wale) bhi dikhao
  if (col.banned_devices) {
    const devRows = await col.banned_devices
      .find({ user_id: null })
      .sort({ at: -1 })
      .limit(10)
      .toArray();
    devRows.forEach((d) =>
      list.push({
        id: null,
        name: "(not logged in)",
        email: "",
        device: d.device,
        state: d.state === "banned" ? "banned" : "blocked",
        at: d.at || "",
        reason: d.reason || "",
      })
    );
  }
  return list;
}
/** /banlist + refresh button dono ke liye shared payload */
async function banListPayload() {
  const rows = await dbListBanned(20);
  if (!rows.length) return null;
  const keyboard = [];
  const lines = ["🚫 *Blocked/Banned users:*", ""];
  rows.forEach((u) => {
    const tag = u.state === "banned" ? "⛔" : "🟠";
    if (u.id != null) {
      lines.push(
        `${tag} #${u.id} ${u.name || "—"}\n   ${u.email || ""}\n   ${u.state} • ${String(u.at).slice(0, 16).replace("T", " ")}`
      );
      keyboard.push([
        { text: `🔓 Unlock #${u.id}`, callback_data: `ub:${u.id}` },
        { text: `⛔ Ban #${u.id}`, callback_data: `bb:${u.id}` },
      ]);
    } else {
      lines.push(
        `${tag} 📱 ${String(u.device || "?").slice(0, 14)}…\n   ${u.name}\n   ${u.state} • ${String(u.at).slice(0, 16).replace("T", " ")}`
      );
      keyboard.push([
        { text: `🔓 Dev ${String(u.device).slice(0, 6)}`, callback_data: `ud:${u.device}` },
        { text: `⛔ Dev ${String(u.device).slice(0, 6)}`, callback_data: `bd:${u.device}` },
      ]);
    }
  });
  keyboard.push([{ text: "🔄 Refresh", callback_data: "banlist:refresh" }]);
  return { text: lines.join("\n"), keyboard };
}

module.exports = { isFreeActive, banListPayload, bumpReferrer, claimTelegramForUser, creditReferrerOnPaidPlan, dbBanPermanent, dbBanStateByDevice, dbBanUser, dbBanUserPermanent, dbBlockDevice, dbBlockUser, dbBumpFreeApi, dbBumpFreeNexus, dbBumpFreePred, dbFindUserByGoogle, dbFindUserById, dbFindUserByIdLite, dbGetFreeApiUsed, dbGetFreeNexusUsed, dbGetFreePredUsed, dbInsertUser, dbIsUserBanned, dbListBanned, dbSetUserFree, dbSetUserPro, dbUnbanUser, dbUnlockUser, dbUpdateUserProfile, genRefCode, notifyUserBanStatus };
