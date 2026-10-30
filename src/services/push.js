
const { webPush } = require("../state/webPush");
const { BRAND_NAME, FRONTEND_URL, PUSH_ICON_PATH, PUSH_ICON_VERSION, SUPPORT_EMAIL } = require("../config/env");
const { kvGet, kvSet } = require("../db/store");

const { VAPID_PRIVATE_KEY, VAPID_PUBLIC_KEY } = require("../config/env");
/* ── Web Push Notification Engine (VAPID + MongoDB/Local Store) ── */

if (webPush && VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  try {
    webPush.setVapidDetails(
      "mailto:" + SUPPORT_EMAIL,
      VAPID_PUBLIC_KEY,
      VAPID_PRIVATE_KEY
    );
  } catch (e) {
    console.warn("webPush.setVapidDetails:", e.message);
  }
}

const pushSubscriptionsList = [];
/** Keep the in-memory list in place (stable reference for importers). */
function replacePushSubscriptions(rows) {
  pushSubscriptionsList.length = 0;
  if (Array.isArray(rows)) pushSubscriptionsList.push(...rows.slice(0, 3000));
}

/** Persist push subscriptions to MongoDB (max 3000 kept). */
function savePushSubscriptionsStore() {
  return kvSet("push_subs_v1", pushSubscriptionsList.slice(0, 3000));
}

/** Load push subscriptions from MongoDB (boot). */
async function hydratePushSubscriptions() {
  const stored = await kvGet("push_subs_v1");
  if (Array.isArray(stored)) replacePushSubscriptions(stored);
}
function isUserPushSubscribed(userId) {
  const uid = Number(userId);
  if (!uid) return false;
  return pushSubscriptionsList.some((s) => s && Number(s.user_id) === uid && s.endpoint);
}
async function dispatchWebPush(item) {
  if (!webPush || !item) return { attempted: 0, delivered: 0, failed: 0 };
  const target = item.target === "all" ? "all" : "user";
  const targetUid = Number(item.user_id) || null;
  const targets = pushSubscriptionsList.filter((s) => {
    if (!s || !s.endpoint || !s.keys) return false;
    if (target === "all") return true;
    return targetUid && Number(s.user_id) === targetUid;
  });

  if (!targets.length) {
    return { attempted: 0, delivered: 0, failed: 0 };
  }

  const payload = JSON.stringify({
    id: item.id,
    title: item.title || BRAND_NAME,
    body: item.message || "",
    image: item.image_url || null,
    icon: `${FRONTEND_URL}${PUSH_ICON_PATH}${PUSH_ICON_VERSION ? "?v=" + PUSH_ICON_VERSION : ""}`,
    badge: `${FRONTEND_URL}${PUSH_ICON_PATH}${PUSH_ICON_VERSION ? "?v=" + PUSH_ICON_VERSION : ""}`,
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
        await webPush.sendNotification(
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
    pushSubscriptionsList = pushSubscriptionsList.filter(
      (s) => s && !deadEndpoints.has(s.endpoint)
    );
    savePushSubscriptionsStore();
  }

  return { attempted: targets.length, delivered, failed };
}

module.exports = { dispatchWebPush, hydratePushSubscriptions, isUserPushSubscribed, pushSubscriptionsList, replacePushSubscriptions, savePushSubscriptionsStore };
