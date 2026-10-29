const express = require("express");
const router = express.Router();


const jwt = require("jsonwebtoken");
const { JWT_SECRET } = require("../config/env");
const { PLAN_CATALOG } = require("../config/plans");
const { authUser } = require("../services/authService");
const { notificationsList, saveNotificationsStore } = require("../services/notifications");
const { VAPID_PUBLIC_KEY, pushSubscriptionsList, savePushSubscriptionsStore } = require("../services/push");
const { sweepExpiredProUsers } = require("../services/sweep");
const { freeApiHistoryLimit, freeNexusLimit, freePredLimit, getActiveBanners, getActiveUpiId } = require("../state/adminSettings");
const { col } = require("../state/mongo");
router.get("/notifications", async (req, res) => {
  const decoded = authUser(req, res);
  if (!decoded) return;
  const uid = Number(decoded.id);
  try {
    await sweepExpiredProUsers(uid);
  } catch (_) {}

  const userNotifs = notificationsList
    .filter((n) => n && (n.target === "all" || Number(n.user_id) === uid))
    .slice(0, 60)
    .map((n) => {
      const isRead = Array.isArray(n.read_by) && n.read_by.includes(uid);
      return {
        id: n.id,
        target: n.target,
        type: n.type || "broadcast",
        title: n.title || "DRAGO Update",
        message: n.message || "",
        image_url: n.image_url || null,
        action_url: n.action_url || null,
        action_label: n.action_label || null,
        created_at: n.created_at,
        is_read: isRead,
      };
    });

  const unreadCount = userNotifs.filter((n) => !n.is_read).length;
  res.json({
    success: true,
    unread_count: unreadCount,
    notifications: userNotifs,
  });
});

router.post("/notifications/read", (req, res) => {
  const decoded = authUser(req, res);
  if (!decoded) return;
  const uid = Number(decoded.id);
  const targetId = String((req.body && req.body.id) || "").trim();
  let changed = false;

  for (const n of notificationsList) {
    if (!n) continue;
    if (n.target !== "all" && Number(n.user_id) !== uid) continue;
    if (targetId && targetId !== "ALL" && String(n.id) !== targetId) continue;
    if (!Array.isArray(n.read_by)) n.read_by = [];
    if (!n.read_by.includes(uid)) {
      n.read_by.push(uid);
      if (n.read_by.length > 2000) n.read_by = n.read_by.slice(-2000);
      changed = true;
    }
  }

  if (changed) saveNotificationsStore();
  res.json({ success: true, unread_count: 0 });
});

/* ── Web Push Subscription Routes ── */
router.get("/push/vapid-public-key", (_req, res) => {
  res.json({
    success: true,
    publicKey: VAPID_PUBLIC_KEY,
  });
});

router.post("/push/subscribe", async (req, res) => {
  try {
    const b = req.body || {};
    const sub = b.subscription || b;
    if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
      return res.status(400).json({
        success: false,
        message: "Valid Web Push subscription object is required.",
      });
    }

    let uid = Number(b.user_id) || null;
    let uname = b.user_name ? String(b.user_name).slice(0, 80) : null;

    // Optional JWT token resolution
    const h = req.get("Authorization") || "";
    const m = h.match(/^Bearer\s+(.+)$/i);
    if (m && JWT_SECRET) {
      try {
        const dec = jwt.verify(m[1].trim(), JWT_SECRET);
        if (dec && dec.id) uid = Number(dec.id);
        if (dec && dec.name && !uname) uname = String(dec.name).slice(0, 80);
      } catch (_) {}
    }

    const endpoint = String(sub.endpoint).trim();
    const record = {
      endpoint,
      keys: {
        p256dh: String(sub.keys.p256dh),
        auth: String(sub.keys.auth),
      },
      user_id: uid,
      user_name: uname,
      updated_at: new Date().toISOString(),
    };

    const existingIdx = pushSubscriptionsList.findIndex(
      (item) => item && item.endpoint === endpoint
    );
    if (existingIdx >= 0) {
      pushSubscriptionsList[existingIdx] = {
        ...pushSubscriptionsList[existingIdx],
        ...record,
      };
    } else {
      pushSubscriptionsList.unshift(record);
      if (pushSubscriptionsList.length > 3000) {
        pushSubscriptionsList = pushSubscriptionsList.slice(0, 3000);
      }
    }
    savePushSubscriptionsStore();

    if (uid && col.users) {
      await col.users
        .updateOne(
          { id: uid },
          {
            $set: {
              push_enabled: 1,
              push_updated_at: new Date().toISOString(),
            },
          }
        )
        .catch(() => {});
    }

    res.json({
      success: true,
      subscribed: true,
      user_id: uid,
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.post("/push/unsubscribe", async (req, res) => {
  try {
    const endpoint = String((req.body && req.body.endpoint) || "").trim();
    if (endpoint) {
      pushSubscriptionsList = pushSubscriptionsList.filter(
        (s) => s && s.endpoint !== endpoint
      );
      savePushSubscriptionsStore();
    }
    res.json({ success: true, subscribed: false });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

/* ── Public App Config (Plans, UPI ID, Auto-Sliding Home Banners) ── */
router.get("/app-config", (_req, res) => {
  const weeklyObj = {
    name: PLAN_CATALOG.weekly.name,
    amount: PLAN_CATALOG.weekly.amount,
    days: PLAN_CATALOG.weekly.days,
    qr_url: PLAN_CATALOG.weekly.qr_url || null,
  };
  const monthlyObj = {
    name: PLAN_CATALOG.monthly.name,
    amount: PLAN_CATALOG.monthly.amount,
    days: PLAN_CATALOG.monthly.days,
    qr_url: PLAN_CATALOG.monthly.qr_url || null,
  };
  res.json({
    success: true,
    plans: {
      weekly: weeklyObj,
      monthly: monthlyObj,
      beginners: weeklyObj,
      profit: monthlyObj,
    },
    upi_id: getActiveUpiId(),
    banners: getActiveBanners(),
    free_limits: {
      pred: freePredLimit(),
      api_history: freeApiHistoryLimit(),
      nexus: freeNexusLimit(),
    },
  });
});

module.exports = { router };
