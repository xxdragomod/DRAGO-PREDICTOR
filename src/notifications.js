/**
 * Web Push + in-app notifications store
 *
 * Auto-split from the original monolithic server.js — behaviour unchanged.
 * Original lines: 1325-1603
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { col } = require("./db/index");
const { DEFAULT_ADMIN_SETTINGS } = require("./settings/defaults");
const { APP_ROOT, FRONTEND_URL, VAPID_PRIVATE_KEY, VAPID_PUBLIC_KEY } = require("./config");
const { getAdminSettings, getNotificationsList, getPushSubscriptionsList, getWebPush, setNotificationsList, setPushSubscriptionsList } = require("./state");

if (getWebPush() && VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  try {
    (getWebPush()).setVapidDetails(
      "mailto:support@dragopredictor.vercel.app",
      VAPID_PUBLIC_KEY,
      VAPID_PRIVATE_KEY
    );
  } catch (e) {
    console.warn("webPush.setVapidDetails:", e.message);
  }
}

const PUSH_SUBS_PATH = path.join(APP_ROOT, "push_subs.json");

try {
  if (fs.existsSync(PUSH_SUBS_PATH)) {
    const parsed = JSON.parse(fs.readFileSync(PUSH_SUBS_PATH, "utf8"));
    if (Array.isArray(parsed)) setPushSubscriptionsList(parsed);
  }
} catch (_) {
  setPushSubscriptionsList([]);
}

function savePushSubscriptionsStore() {
  try {
    fs.writeFileSync(
      PUSH_SUBS_PATH,
      JSON.stringify((getPushSubscriptionsList()).slice(0, 3000), null, 2),
      "utf8"
    );
  } catch (_) {}
  if (col.kv_store) {
    col.kv_store
      .updateOne(
        { _id: "push_subs_v1" },
        {
          $set: {
            value: (getPushSubscriptionsList()).slice(0, 3000),
            updated_at: new Date().toISOString(),
          },
        },
        { upsert: true }
      )
      .catch((err) => console.warn("mongo push_subs save:", err.message));
  }
}

function isUserPushSubscribed(userId) {
  const uid = Number(userId);
  if (!uid) return false;
  return (getPushSubscriptionsList()).some((s) => s && Number(s.user_id) === uid && s.endpoint);
}

async function dispatchWebPush(item) {
  if (!getWebPush() || !item) return { attempted: 0, delivered: 0, failed: 0 };
  const target = item.target === "all" ? "all" : "user";
  const targetUid = Number(item.user_id) || null;
  const targets = (getPushSubscriptionsList()).filter((s) => {
    if (!s || !s.endpoint || !s.keys) return false;
    if (target === "all") return true;
    return targetUid && Number(s.user_id) === targetUid;
  });

  if (!targets.length) {
    return { attempted: 0, delivered: 0, failed: 0 };
  }

  const payload = JSON.stringify({
    id: item.id,
    title: item.title || "DRAGO Predictor",
    body: item.message || "",
    image: item.image_url || null,
    icon: `${FRONTEND_URL}/favicon-192.png?v=20261004`,
    badge: `${FRONTEND_URL}/favicon-192.png?v=20261004`,
    url: item.action_url || "/notifications/",
    action_label: item.action_label || "Open App",
    type: item.type || "broadcast",
    created_at: item.created_at || new Date().toISOString(),
  });

  let delivered = 0;
  let failed = 0;
  const deadEndpoints = new Set();

  await Promise.all(
    targets.map(async (subRecord) => {
      try {
        await (getWebPush()).sendNotification(
          {
            endpoint: subRecord.endpoint,
            keys: subRecord.keys,
          },
          payload,
          { TTL: 86400, urgency: "high" }
        );
        delivered++;
      } catch (err) {
        failed++;
        const status = Number(err && err.statusCode);
        if (status === 404 || status === 410) {
          deadEndpoints.add(subRecord.endpoint);
        }
      }
    })
  );

  if (deadEndpoints.size > 0) {
    setPushSubscriptionsList((getPushSubscriptionsList()).filter(
      (s) => s && !deadEndpoints.has(s.endpoint)
    ));
    savePushSubscriptionsStore();
  }

  return { attempted: targets.length, delivered, failed };
}

/* ── Persistent Notifications Store (Broadcast + Personal + Auto Plan Active/Expired) ── */
const NOTIFICATIONS_PATH = path.join(APP_ROOT, "notifications.json");

try {
  if (fs.existsSync(NOTIFICATIONS_PATH)) {
    const parsed = JSON.parse(fs.readFileSync(NOTIFICATIONS_PATH, "utf8"));
    if (Array.isArray(parsed)) setNotificationsList(parsed);
  }
} catch (_) {
  setNotificationsList([]);
}

function saveNotificationsStore() {
  try {
    fs.writeFileSync(
      NOTIFICATIONS_PATH,
      JSON.stringify((getNotificationsList()).slice(0, 250), null, 2),
      "utf8"
    );
  } catch (_) {}
  if (col.kv_store) {
    col.kv_store
      .updateOne(
        { _id: "notifications_v1" },
        {
          $set: {
            value: (getNotificationsList()).slice(0, 250),
            updated_at: new Date().toISOString(),
          },
        },
        { upsert: true }
      )
      .catch((err) => console.warn("mongo notifications save:", err.message));
  }
}

function formatNotifTemplate(tpl, vars) {
  let out = String(tpl || "");
  const v = vars || {};
  out = out.replace(/\{name\}/gi, String(v.name || "VIP Member"));
  out = out.replace(/\{plan\}/gi, String(v.plan || "PRO VIP"));
  out = out.replace(/\{days\}/gi, String(v.days || "7"));
  out = out.replace(/\{expiry\}/gi, String(v.expiry || ""));
  return out;
}

function formatIstDateShort(isoOrMs) {
  try {
    const d = new Date(isoOrMs);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    });
  } catch (_) {
    return "—";
  }
}

function pushNotification({
  target,
  user_id,
  user_name,
  type,
  title,
  message,
  image_url,
  action_url,
  action_label,
}) {
  const item = {
    id: "ntf_" + Date.now() + "_" + crypto.randomBytes(3).toString("hex"),
    target: target === "all" ? "all" : "user",
    user_id: target === "all" ? null : Number(user_id) || null,
    user_name: user_name ? String(user_name).slice(0, 80) : null,
    type: String(type || "direct"),
    title: String(title || "DRAGO Update").trim().slice(0, 140),
    message: String(message || "").trim().slice(0, 1200),
    image_url: image_url ? String(image_url).trim() : null,
    action_url: action_url ? String(action_url).trim() : null,
    action_label: action_label ? String(action_label).trim().slice(0, 50) : null,
    created_at: new Date().toISOString(),
    read_by: [],
  };
  (getNotificationsList()).unshift(item);
  if ((getNotificationsList()).length > 250) {
    setNotificationsList((getNotificationsList()).slice(0, 250));
  }
  saveNotificationsStore();
  dispatchWebPush(item).catch((err) =>
    console.warn("dispatchWebPush:", err && err.message)
  );
  return item;
}

async function sweepExpiredProUsers(onlyUserId) {
  if (!col.users) return;
  try {
    const nowIso = new Date().toISOString();
    const query = {
      is_pro: 1,
      pro_expires_at: { $ne: null, $lte: nowIso },
    };
    if (onlyUserId) {
      query.id = Number(onlyUserId);
    }
    const expiredUsers = await col.users.find(query).limit(50).toArray();
    for (const u of expiredUsers) {
      if (!u || !u.id) continue;
      if (u.pro_expired_notified_for && u.pro_expired_notified_for === u.pro_expires_at) {
        await col.users.updateOne({ id: u.id }, { $set: { is_pro: 0 } });
        continue;
      }
      const upd = await col.users.updateOne(
        { id: u.id, is_pro: 1 },
        {
          $set: {
            is_pro: 0,
            pro_expired_notified_for: u.pro_expires_at || nowIso,
          },
        }
      );
      if (upd && upd.modifiedCount > 0) {
        const expStr = formatIstDateShort(u.pro_expires_at || nowIso);
        const title = formatNotifTemplate(
          (getAdminSettings()).notif_plan_expired_title || DEFAULT_ADMIN_SETTINGS.notif_plan_expired_title,
          { name: u.name || "Member", expiry: expStr }
        );
        const message = formatNotifTemplate(
          (getAdminSettings()).notif_plan_expired_body || DEFAULT_ADMIN_SETTINGS.notif_plan_expired_body,
          { name: u.name || "Member", expiry: expStr }
        );
        pushNotification({
          target: "user",
          user_id: u.id,
          user_name: u.name || u.email || "",
          type: "plan_expired",
          title,
          message,
          image_url: (getAdminSettings()).notif_plan_expired_image || null,
          action_url: "/payment/?plan=weekly",
          action_label: "RENEW VIP PLAN →",
        });
      }
    }
  } catch (e) {
    console.warn("sweepExpiredProUsers:", e.message);
  }
}

// Automatically check expired VIP plans every 60 seconds so users receive
// In-App + Mobile Push Notifications on time even when the app is closed.
setInterval(() => {
  sweepExpiredProUsers().catch(() => {});
}, 60 * 1000);

/* ── Announcement broadcast (new game / feature popup) ── */

module.exports = {
  NOTIFICATIONS_PATH,
  PUSH_SUBS_PATH,
  dispatchWebPush,
  formatIstDateShort,
  formatNotifTemplate,
  isUserPushSubscribed,
  pushNotification,
  saveNotificationsStore,
  savePushSubscriptionsStore,
  sweepExpiredProUsers,
};

require("./lib/lazy").register(module.exports);
