/**
 * Admin panel routes
 *
 * Auto-split from the original monolithic server.js — behaviour unchanged.
 * Original lines: 6902-7702
 */

const crypto = require("crypto");

const { app } = require("../app");
const { col } = require("../db/index");
const { storeUploadedImage } = require("../images");
const { requireAdminKey } = require("../middleware/admin-key");
const { dbBanUserPermanent, dbUnlockUser } = require("../models/bans");
const { dbDeleteGame, dbInsertGame, dbListGames, dbMaxGameOrder } = require("../models/games");
const { dbSetUserPro, isFreeActive } = require("../models/users");
const { isUserPushSubscribed, pushNotification, saveNotificationsStore } = require("../notifications");
const { expireStaleOrders, findOrder, flushPaymentsSync, getPayments, schedulePaymentsFlush, updateOrderStatus } = require("../payments/store");
const { PLAN_CATALOG, TELEGRAM_ADMIN_CHAT_ID, TELEGRAM_BOT_TOKEN, activatePro, userIsPro } = require("../plans");
const { freeApiHistoryLimit, freeNexusLimit, freePredLimit, getActiveUpiId, saveAdminSettings } = require("../settings");
const { DEFAULT_ADMIN_SETTINGS } = require("../settings/defaults");
const { telegramApi } = require("../telegram/api");
const { getAdminSettings, getNotificationsList, getPushSubscriptionsList, setNotificationsList, setPaymentsCache } = require("../state");

app.use("/admin", requireAdminKey);

app.get("/admin/overview", async (_req, res) => {
  try {
    expireStaleOrders();
    const allUsers = col.users ? await col.users.find({}).toArray() : [];
    let proCount = 0;
    let freeVerifiedCount = 0;
    let bannedCount = 0;
    for (const u of allUsers) {
      if (userIsPro(u)) proCount++;
      if (isFreeActive(u)) freeVerifiedCount++;
      if (u.banned || u.ban_state === "banned" || u.ban_state === "blocked") bannedCount++;
    }

    const allPayments = getPayments();
    let approvedPayments = 0;
    let pendingVerifyPayments = 0;
    let pendingPayments = 0;
    let rejectedPayments = 0;
    let expiredPayments = 0;
    let totalRevenue = 0;

    for (const o of allPayments) {
      if (!o) continue;
      const st = String(o.payment_status || "").toUpperCase();
      if (st === "SUCCESS" || st === "APPROVED") {
        approvedPayments++;
        totalRevenue += Number(o.amount) || 0;
      } else if (st === "PENDING_VERIFY") {
        pendingVerifyPayments++;
      } else if (st === "PENDING") {
        pendingPayments++;
      } else if (st === "REJECTED" || st === "FAILED" || st === "DENIED") {
        rejectedPayments++;
      } else if (st === "EXPIRED") {
        expiredPayments++;
      }
    }

    const games = col.games ? await dbListGames() : [];
    const banners = Array.isArray((getAdminSettings()).banners) && (getAdminSettings()).banners.length
      ? (getAdminSettings()).banners
      : DEFAULT_ADMIN_SETTINGS.banners;

    res.json({
      success: true,
      stats: {
        total_users: allUsers.length,
        pro_users: proCount,
        free_verified_users: freeVerifiedCount,
        banned_users: bannedCount,
        total_payments: allPayments.length,
        approved_payments: approvedPayments,
        pending_verify_payments: pendingVerifyPayments,
        pending_payments: pendingPayments,
        rejected_payments: rejectedPayments,
        expired_payments: expiredPayments,
        total_revenue: totalRevenue,
        total_games: games.length,
        total_banners: banners.length,
        push_subscribers_count: (getPushSubscriptionsList()).length,
      },
      settings: {
        ...getAdminSettings(),
        weekly_amount: PLAN_CATALOG.weekly.amount,
        weekly_days: PLAN_CATALOG.weekly.days,
        weekly_name: PLAN_CATALOG.weekly.name,
        weekly_qr_url: PLAN_CATALOG.weekly.qr_url,
        monthly_amount: PLAN_CATALOG.monthly.amount,
        monthly_days: PLAN_CATALOG.monthly.days,
        monthly_name: PLAN_CATALOG.monthly.name,
        monthly_qr_url: PLAN_CATALOG.monthly.qr_url,
        upi_id: getActiveUpiId(),
      },
      banners,
      games,
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.get("/admin/users", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim().toLowerCase();
    const filter = String(req.query.filter || "all").trim().toLowerCase();
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 300, 1000));

    const docs = col.users
      ? await col.users.find({}).sort({ id: -1 }).toArray()
      : [];

    const mapped = [];
    for (const u of docs) {
      const isPro = userIsPro(u);
      const isFree = isFreeActive(u);
      const isBanned = Boolean(u.banned || u.ban_state === "banned" || u.ban_state === "blocked");

      if (filter === "pro" && !isPro) continue;
      if (filter === "free" && isPro) continue;
      if (filter === "verified" && !isFree) continue;
      if (filter === "banned" && !isBanned) continue;

      if (q) {
        const hay = `${u.id} #${u.id} ${u.name || ""} ${u.email || ""} ${u.tg_id || ""} ${u.pro_plan || ""}`.toLowerCase();
        if (!hay.includes(q)) continue;
      }

      mapped.push({
        id: u.id,
        name: u.name || "User",
        email: u.email || "",
        picture: u.picture || "",
        created_at: u.created_at || null,
        is_pro: isPro,
        pro_plan: isPro ? u.pro_plan || "weekly" : null,
        pro_expires_at: isPro ? u.pro_expires_at || null : null,
        free_active: isFree,
        tg_id: u.tg_id || null,
        free_pred_used: Number(u.free_pred_used) || 0,
        free_pred_limit: freePredLimit(),
        free_api_used: Number(u.free_api_used) || 0,
        free_api_limit: freeApiHistoryLimit(),
        free_nexus_used: Number(u.free_nexus_used) || 0,
        free_nexus_limit: freeNexusLimit(),
        banned: isBanned,
        ban_state: u.ban_state || (u.banned ? "banned" : "ok"),
        ban_reason: u.ban_reason || "",
        banned_device: u.banned_device || "",
        ref_code: u.ref_code || "",
        ref_count: Number(u.ref_count) || 0,
        ref_paid_count: Number(u.ref_paid_count) || 0,
        ref_rewards_earned: Number(u.ref_rewards_earned) || 0,
        referred_by: u.referred_by || null,
        push_enabled: Boolean(u.push_enabled || isUserPushSubscribed(u.id)),
      });
      if (mapped.length >= limit) break;
    }

    res.json({ success: true, total: docs.length, count: mapped.length, users: mapped });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.post("/admin/user-action", async (req, res) => {
  try {
    const userId = Number(req.body && req.body.user_id);
    const action = String((req.body && req.body.action) || "").trim().toLowerCase();
    if (!userId || !action) {
      return res.status(400).json({ success: false, message: "user_id and action required" });
    }
    const u = await col.users.findOne({ id: userId });
    if (!u) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    if (action === "activate_pro") {
      const rawPlan = String((req.body && req.body.plan) || "weekly").trim().toLowerCase();
      const planKey = rawPlan === "monthly" || rawPlan === "profit" ? "monthly" : "weekly";
      const customDays = Number(req.body && req.body.days);
      const days = Number.isFinite(customDays) && customDays >= 1
        ? customDays
        : PLAN_CATALOG[planKey].days;
      const expires = new Date(Date.now() + days * 86400000).toISOString();
      await dbSetUserPro(userId, 1, planKey, expires);
      return res.json({
        success: true,
        message: `User #${userId} activated on ${planKey.toUpperCase()} (${days} days)`,
        pro_plan: planKey,
        pro_expires_at: expires,
      });
    }

    if (action === "revoke_pro") {
      await dbSetUserPro(userId, 0, null, null);
      return res.json({
        success: true,
        message: `User #${userId} moved to Free plan`,
      });
    }

    if (action === "block" || action === "ban") {
      const reason = String((req.body && req.body.reason) || "Admin panel block").slice(0, 120);
      await dbBanUserPermanent(userId, reason);
      return res.json({
        success: true,
        message: `User #${userId} blocked/banned`,
        banned: true,
      });
    }

    if (action === "unblock" || action === "unban") {
      await dbUnlockUser(userId);
      return res.json({
        success: true,
        message: `User #${userId} unblocked/unlocked`,
        banned: false,
      });
    }

    if (action === "reset_quota") {
      await col.users.updateOne(
        { id: userId },
        { $set: { free_pred_used: 0, free_api_used: 0, free_nexus_used: 0 } }
      );
      if (col.api_usage) {
        await col.api_usage.deleteMany({ user_id: userId });
      }
      pushNotification({
        target: "user",
        user_id: userId,
        user_name: u.name || u.email || `User #${userId}`,
        type: "quota_reset",
        title: "♻️ Free Usage Quota Reset!",
        message: `Hi ${u.name || "Member"}, your free prediction, API, and NEXUS AI usage quota has been reset to 0 by Admin!`,
        action_url: "/prediction/",
        action_label: "OPEN PREDICTION →",
      });
      return res.json({
        success: true,
        message: `Free quotas reset to 0 for User #${userId}`,
      });
    }

    if (action === "verify_free") {
      const exp = Date.now() + 365 * 86400000;
      await col.users.updateOne(
        { id: userId },
        { $set: { free_active: 1, free_expires_at: exp } }
      );
      pushNotification({
        target: "user",
        user_id: userId,
        user_name: u.name || u.email || `User #${userId}`,
        type: "free_verified",
        title: "✅ Free Access Activated!",
        message: `Hi ${u.name || "Member"}, your account has been verified by Admin! You can now test live predictions.`,
        action_url: "/prediction/",
        action_label: "START NOW →",
      });
      return res.json({
        success: true,
        message: `Free plan manually verified for User #${userId}`,
      });
    }

    if (action === "unlink_tg") {
      await col.users.updateOne(
        { id: userId },
        { $set: { free_active: 0, free_expires_at: null, tg_id: null } }
      );
      return res.json({
        success: true,
        message: `Telegram unlinked for User #${userId}`,
      });
    }

    return res.status(400).json({ success: false, message: "Unknown action" });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.post("/admin/settings", (req, res) => {
  try {
    const b = req.body || {};
    if (b.weekly_amount != null) {
      const n = Number(b.weekly_amount);
      if (Number.isFinite(n) && n >= 1 && n <= 100000) (getAdminSettings()).weekly_amount = Math.round(n);
    }
    if (b.weekly_days != null) {
      const n = Number(b.weekly_days);
      if (Number.isFinite(n) && n >= 1 && n <= 3650) (getAdminSettings()).weekly_days = Math.round(n);
    }
    if (typeof b.weekly_name === "string" && b.weekly_name.trim()) {
      (getAdminSettings()).weekly_name = b.weekly_name.trim().slice(0, 50);
    }
    if (typeof b.weekly_qr_url === "string") {
      (getAdminSettings()).weekly_qr_url = b.weekly_qr_url.trim();
    }

    if (b.monthly_amount != null) {
      const n = Number(b.monthly_amount);
      if (Number.isFinite(n) && n >= 1 && n <= 100000) (getAdminSettings()).monthly_amount = Math.round(n);
    }
    if (b.monthly_days != null) {
      const n = Number(b.monthly_days);
      if (Number.isFinite(n) && n >= 1 && n <= 3650) (getAdminSettings()).monthly_days = Math.round(n);
    }
    if (typeof b.monthly_name === "string" && b.monthly_name.trim()) {
      (getAdminSettings()).monthly_name = b.monthly_name.trim().slice(0, 50);
    }
    if (typeof b.monthly_qr_url === "string") {
      (getAdminSettings()).monthly_qr_url = b.monthly_qr_url.trim();
    }

    if (typeof b.upi_id === "string") {
      (getAdminSettings()).upi_id = b.upi_id.trim().slice(0, 100);
    }

    if (b.free_pred_limit != null) {
      const n = Number(b.free_pred_limit);
      if (Number.isFinite(n) && n >= 0 && n <= 1000) (getAdminSettings()).free_pred_limit = Math.round(n);
    }
    if (b.free_api_history_limit != null) {
      const n = Number(b.free_api_history_limit);
      if (Number.isFinite(n) && n >= 0 && n <= 10000) (getAdminSettings()).free_api_history_limit = Math.round(n);
    }
    if (b.free_nexus_limit != null) {
      const n = Number(b.free_nexus_limit);
      if (Number.isFinite(n) && n >= 0 && n <= 1000) (getAdminSettings()).free_nexus_limit = Math.round(n);
    }

    if (typeof b.google_auth_enabled === "boolean") (getAdminSettings()).google_auth_enabled = b.google_auth_enabled;
    if (typeof b.auto_payment_enabled === "boolean") (getAdminSettings()).auto_payment_enabled = b.auto_payment_enabled;
    if (typeof b.manual_payment_enabled === "boolean") (getAdminSettings()).manual_payment_enabled = b.manual_payment_enabled;
    if (typeof b.guard_enabled === "boolean") (getAdminSettings()).guard_enabled = b.guard_enabled;

    saveAdminSettings();
    res.json({
      success: true,
      message: "Settings & Plan prices saved!",
      settings: getAdminSettings(),
      plans: {
        weekly: {
          name: PLAN_CATALOG.weekly.name,
          amount: PLAN_CATALOG.weekly.amount,
          days: PLAN_CATALOG.weekly.days,
          qr_url: PLAN_CATALOG.weekly.qr_url,
        },
        monthly: {
          name: PLAN_CATALOG.monthly.name,
          amount: PLAN_CATALOG.monthly.amount,
          days: PLAN_CATALOG.monthly.days,
          qr_url: PLAN_CATALOG.monthly.qr_url,
        },
      },
      upi_id: getActiveUpiId(),
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.get("/admin/payments", async (req, res) => {
  try {
    expireStaleOrders();
    const statusFilter = String(req.query.status || "ALL").trim().toUpperCase();
    const q = String(req.query.q || "").trim().toLowerCase();
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 300, 1000));

    const userMap = new Map();
    if (col.users) {
      const uDocs = await col.users
        .find({}, { projection: { id: 1, name: 1, email: 1 } })
        .toArray();
      for (const u of uDocs) userMap.set(Number(u.id), u);
    }

    const all = getPayments()
      .filter(Boolean)
      .slice()
      .sort((a, b) => Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0));

    let approved = 0;
    let pendingVerify = 0;
    let pending = 0;
    let rejected = 0;
    let expired = 0;
    let approvedRevenue = 0;

    for (const o of all) {
      const st = String(o.payment_status || "").toUpperCase();
      if (st === "SUCCESS" || st === "APPROVED") {
        approved++;
        approvedRevenue += Number(o.amount) || 0;
      } else if (st === "PENDING_VERIFY") {
        pendingVerify++;
      } else if (st === "PENDING") {
        pending++;
      } else if (st === "REJECTED" || st === "FAILED" || st === "DENIED") {
        rejected++;
      } else if (st === "EXPIRED") {
        expired++;
      }
    }

    const orders = [];
    for (const o of all) {
      const st = String(o.payment_status || "").toUpperCase();
      if (statusFilter !== "ALL") {
        if (statusFilter === "SUCCESS" && st !== "SUCCESS" && st !== "APPROVED") continue;
        else if (statusFilter === "REJECTED" && st !== "REJECTED" && st !== "FAILED" && st !== "DENIED") continue;
        else if (statusFilter !== "SUCCESS" && statusFilter !== "REJECTED" && st !== statusFilter) continue;
      }
      const u = userMap.get(Number(o.user_id)) || {};
      if (q) {
        const hay = `${o.order_id || ""} ${o.utr || ""} ${o.user_id || ""} ${u.name || ""} ${u.email || ""} ${o.plan || ""}`.toLowerCase();
        if (!hay.includes(q)) continue;
      }
      let proofImg = o.proof_image_url || null;
      if (!proofImg && o.raw_response) {
        try {
          const parsed = JSON.parse(o.raw_response);
          if (parsed && parsed.proof_image_url) proofImg = parsed.proof_image_url;
        } catch (_) {}
      }
      orders.push({
        order_id: o.order_id,
        user_id: o.user_id,
        user_name: u.name || `User #${o.user_id}`,
        user_email: u.email || "",
        plan: o.plan,
        plan_name: (PLAN_CATALOG[o.plan] && PLAN_CATALOG[o.plan].name) || String(o.plan || "PRO VIP").toUpperCase(),
        amount: o.amount,
        payment_status: o.payment_status,
        utr: o.utr || null,
        proof_image_url: proofImg,
        method: o.method || null,
        created_at: o.created_at,
        updated_at: o.updated_at || o.created_at,
      });
      if (orders.length >= limit) break;
    }

    res.json({
      success: true,
      summary: {
        total: all.length,
        approved,
        pending_verify: pendingVerify,
        pending,
        rejected,
        expired,
        approved_revenue: approvedRevenue,
      },
      orders,
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.post("/admin/payment-action", async (req, res) => {
  try {
    const orderId = String((req.body && req.body.order_id) || "").trim();
    const action = String((req.body && req.body.action) || "").trim().toLowerCase();
    if (!orderId || !action) {
      return res.status(400).json({ success: false, message: "order_id and action required" });
    }
    const order = findOrder(orderId);
    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }

    if (action === "approve") {
      updateOrderStatus(orderId, "SUCCESS", order.utr, order.method || "UPI_MANUAL", order.raw_response);
      const act = await activatePro(order.user_id, order.plan || "weekly");
      if (TELEGRAM_BOT_TOKEN && TELEGRAM_ADMIN_CHAT_ID) {
        telegramApi("sendMessage", {
          chat_id: TELEGRAM_ADMIN_CHAT_ID,
          text: `✅ Payment Approved (Admin Panel)\nOrder: ${orderId}\nUser: #${order.user_id}\nPlan: ${order.plan || "weekly"} (₹${order.amount || 0})`,
        }).catch(() => {});
      }
      return res.json({
        success: true,
        message: `Order ${orderId} approved & Pro activated for User #${order.user_id}!`,
        order,
        activated: act,
      });
    }

    if (action === "reject" || action === "deny") {
      updateOrderStatus(orderId, "REJECTED", order.utr, order.method || "UPI_MANUAL", order.raw_response);
      try {
        pushNotification({
          target: "user",
          user_id: order.user_id,
          type: "payment_rejected",
          title: "❌ Payment Verification Declined",
          message: `Your payment UTR (${order.utr || "N/A"}) for Order ${orderId} could not be verified. If amount was deducted, open Profile → Subscription Not Approve and upload your payment screenshot.`,
          action_url: "/profile/",
          action_label: "UPLOAD PAYMENT PROOF →",
        });
      } catch (_) {}
      if (TELEGRAM_BOT_TOKEN && TELEGRAM_ADMIN_CHAT_ID) {
        telegramApi("sendMessage", {
          chat_id: TELEGRAM_ADMIN_CHAT_ID,
          text: `❌ Payment Rejected (Admin Panel)\nOrder: ${orderId}\nUser: #${order.user_id}`,
        }).catch(() => {});
      }
      return res.json({
        success: true,
        message: `Order ${orderId} rejected.`,
        order,
      });
    }

    if (action === "delete") {
      setPaymentsCache(getPayments().filter((o) => o && String(o.order_id) !== orderId));
      schedulePaymentsFlush();
      flushPaymentsSync();
      if (col.payments) {
        await col.payments.deleteOne({ order_id: orderId }).catch(() => {});
      }
      return res.json({
        success: true,
        message: `Order ${orderId} deleted.`,
      });
    }

    return res.status(400).json({ success: false, message: "Unknown action" });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.get("/admin/games", async (_req, res) => {
  try {
    const games = await dbListGames();
    res.json({ success: true, games });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.post("/admin/games", async (req, res) => {
  try {
    const b = req.body || {};
    const name = String(b.name || "").trim().slice(0, 80);
    const imageUrl = String(b.image_url || "").trim().slice(0, 500);
    const gameUrl = String(b.game_url || b.link_url || "").trim().slice(0, 500);
    if (!name || !gameUrl) {
      return res.status(400).json({ success: false, message: "Game name and game URL are required" });
    }
    const maxRow = await dbMaxGameOrder();
    const sortOrder = b.sort_order != null ? Number(b.sort_order) : (Number(maxRow.m) || 0) + 1;
    const inserted = await dbInsertGame(name, imageUrl, gameUrl, sortOrder);
    const games = await dbListGames();
    res.json({
      success: true,
      message: `Game "${name}" added!`,
      id: inserted.id,
      games,
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.delete("/admin/games/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: "Invalid game id" });
    await dbDeleteGame(id);
    const games = await dbListGames();
    res.json({ success: true, message: `Game #${id} deleted`, games });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.get("/admin/banners", (_req, res) => {
  const banners = Array.isArray((getAdminSettings()).banners) && (getAdminSettings()).banners.length
    ? (getAdminSettings()).banners
    : DEFAULT_ADMIN_SETTINGS.banners;
  res.json({ success: true, banners });
});

app.post("/admin/banners", (req, res) => {
  try {
    const b = req.body || {};
    const imageUrl = String(b.image_url || "").trim();
    const linkUrl = String(b.link_url || "/prediction/").trim() || "/prediction/";
    const title = String(b.title || "DRAGO Promotion").trim().slice(0, 120);
    if (!imageUrl) {
      return res.status(400).json({ success: false, message: "Banner image URL required" });
    }
    if (!Array.isArray((getAdminSettings()).banners) || !(getAdminSettings()).banners.length) {
      (getAdminSettings()).banners = [...DEFAULT_ADMIN_SETTINGS.banners];
    }
    const newBanner = {
      id: "bn_" + Date.now() + "_" + crypto.randomBytes(2).toString("hex"),
      title,
      image_url: imageUrl,
      link_url: linkUrl,
      active: true,
      created_at: new Date().toISOString(),
    };
    (getAdminSettings()).banners.push(newBanner);
    saveAdminSettings();
    res.json({
      success: true,
      message: "Banner added!",
      banner: newBanner,
      banners: (getAdminSettings()).banners,
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.delete("/admin/banners/:id", (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    if (!Array.isArray((getAdminSettings()).banners)) {
      (getAdminSettings()).banners = [...DEFAULT_ADMIN_SETTINGS.banners];
    }
    (getAdminSettings()).banners = (getAdminSettings()).banners.filter((b) => b && String(b.id) !== id);
    saveAdminSettings();
    res.json({
      success: true,
      message: "Banner removed!",
      banners: (getAdminSettings()).banners,
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.post("/admin/upload-image", async (req, res) => {
  try {
    const b64 = String((req.body && req.body.image) || "");
    const m = b64.match(/^data:image\/(png|jpe?g|webp|gif);base64,(.+)$/i);
    if (!m) {
      return res.status(400).json({ success: false, message: "Valid PNG/JPG/WEBP/GIF image required" });
    }
    const buf = Buffer.from(m[2], "base64");
    if (buf.length > 6 * 1024 * 1024) {
      return res.status(413).json({ success: false, message: "Image too large (max 6MB)" });
    }
    const url = await storeUploadedImage(buf, "image/" + m[1].toLowerCase(), req);
    return res.json({ success: true, url });
  } catch (e) {
    return res.status(502).json({ success: false, message: "Image upload failed: " + e.message });
  }
});

app.get("/admin/notifications", (_req, res) => {
  const uniquePushUsers = new Set(
    (getPushSubscriptionsList()).map((s) => s && s.user_id).filter(Boolean)
  );
  res.json({
    success: true,
    push_subscribers_count: (getPushSubscriptionsList()).length,
    push_users_count: uniquePushUsers.size,
    notifications: (getNotificationsList()).slice(0, 100),
    templates: {
      plan_active_title:
        (getAdminSettings()).notif_plan_active_title ||
        DEFAULT_ADMIN_SETTINGS.notif_plan_active_title,
      plan_active_body:
        (getAdminSettings()).notif_plan_active_body ||
        DEFAULT_ADMIN_SETTINGS.notif_plan_active_body,
      plan_active_image: (getAdminSettings()).notif_plan_active_image || "",
      plan_expired_title:
        (getAdminSettings()).notif_plan_expired_title ||
        DEFAULT_ADMIN_SETTINGS.notif_plan_expired_title,
      plan_expired_body:
        (getAdminSettings()).notif_plan_expired_body ||
        DEFAULT_ADMIN_SETTINGS.notif_plan_expired_body,
      plan_expired_image: (getAdminSettings()).notif_plan_expired_image || "",
    },
  });
});

app.post("/admin/notifications/send", async (req, res) => {
  try {
    const b = req.body || {};
    const target = String(b.target || "all").toLowerCase() === "user" ? "user" : "all";
    const title = String(b.title || "").trim().slice(0, 140);
    const message = String(b.message || "").trim().slice(0, 1200);
    const imageUrl = String(b.image_url || "").trim() || null;
    const actionUrl = String(b.action_url || "").trim() || null;
    const actionLabel = String(b.action_label || "").trim().slice(0, 50) || null;

    if (!title || !message) {
      return res.status(400).json({
        success: false,
        message: "Both Title and Message are required.",
      });
    }

    let resolvedUserId = null;
    let resolvedUserName = null;

    if (target === "user") {
      const rawQuery = String(b.user_id || b.user_query || "").trim();
      if (!rawQuery) {
        return res.status(400).json({
          success: false,
          message: "Enter User ID, Email, or Name for personal notification.",
        });
      }
      let userDoc = null;
      const numId = Number(rawQuery.replace(/^#/, ""));
      if (col.users) {
        if (Number.isFinite(numId) && numId > 0) {
          userDoc = await col.users.findOne({ id: numId });
        }
        if (!userDoc) {
          const esc = rawQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          userDoc = await col.users.findOne({
            $or: [
              { email: { $regex: new RegExp("^" + esc + "$", "i") } },
              { name: { $regex: new RegExp(esc, "i") } },
            ],
          });
        }
      }
      if (!userDoc) {
        return res.status(404).json({
          success: false,
          message: `User "${rawQuery}" not found.`,
        });
      }
      resolvedUserId = userDoc.id;
      resolvedUserName = userDoc.name || userDoc.email || `User #${userDoc.id}`;
    }

    const created = pushNotification({
      target,
      user_id: resolvedUserId,
      user_name: resolvedUserName,
      type: target === "all" ? "broadcast" : "direct",
      title,
      message,
      image_url: imageUrl,
      action_url: actionUrl,
      action_label: actionLabel,
    });

    res.json({
      success: true,
      message:
        target === "all"
          ? "Broadcast notification sent to ALL users!"
          : `Notification sent to ${resolvedUserName} (#${resolvedUserId})!`,
      notification: created,
      notifications: (getNotificationsList()).slice(0, 100),
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.post("/admin/notifications/templates", (req, res) => {
  try {
    const b = req.body || {};
    if (typeof b.plan_active_title === "string" && b.plan_active_title.trim()) {
      (getAdminSettings()).notif_plan_active_title = b.plan_active_title.trim().slice(0, 140);
    }
    if (typeof b.plan_active_body === "string" && b.plan_active_body.trim()) {
      (getAdminSettings()).notif_plan_active_body = b.plan_active_body.trim().slice(0, 1200);
    }
    if (typeof b.plan_active_image === "string") {
      (getAdminSettings()).notif_plan_active_image = b.plan_active_image.trim();
    }
    if (typeof b.plan_expired_title === "string" && b.plan_expired_title.trim()) {
      (getAdminSettings()).notif_plan_expired_title = b.plan_expired_title.trim().slice(0, 140);
    }
    if (typeof b.plan_expired_body === "string" && b.plan_expired_body.trim()) {
      (getAdminSettings()).notif_plan_expired_body = b.plan_expired_body.trim().slice(0, 1200);
    }
    if (typeof b.plan_expired_image === "string") {
      (getAdminSettings()).notif_plan_expired_image = b.plan_expired_image.trim();
    }
    saveAdminSettings();
    res.json({
      success: true,
      message: "Auto Plan Active & Plan Expired notification templates saved!",
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.post("/admin/notifications/delete", (req, res) => {
  try {
    const id = String((req.body && req.body.id) || "").trim();
    if (!id) {
      return res.status(400).json({ success: false, message: "Notification ID required" });
    }
    if (id === "ALL") {
      setNotificationsList([]);
    } else {
      setNotificationsList((getNotificationsList()).filter((n) => n && String(n.id) !== id));
    }
    saveNotificationsStore();
    res.json({
      success: true,
      message: id === "ALL" ? "All notifications cleared!" : "Notification deleted!",
      notifications: (getNotificationsList()).slice(0, 100),
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = {};
