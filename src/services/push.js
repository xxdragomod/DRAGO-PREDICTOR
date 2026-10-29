
const fs = require("fs");
const path = require("path");
const { webPush } = require("../state/webPush");
const { FRONTEND_URL } = require("../config/env");
const { col } = require("../state/mongo");

const { VAPID_PRIVATE_KEY, VAPID_PUBLIC_KEY } = require("../config/env");
const { ROOT_DIR } = require("../config/paths");
/* ── Web Push Notification Engine (VAPID + MongoDB/Local Store) ── */

if (webPush && VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  try {
    webPush.setVapidDetails(
      "mailto:support@dragopredictor.vercel.app",
      VAPID_PUBLIC_KEY,
      VAPID_PRIVATE_KEY
    );
  } catch (e) {
    console.warn("webPush.setVapidDetails:", e.message);
  }
}

const PUSH_SUBS_PATH = path.join(ROOT_DIR, "push_subs.json");
let pushSubscriptionsList = [];
try {
  if (fs.existsSync(PUSH_SUBS_PATH)) {
    const parsed = JSON.parse(fs.readFileSync(PUSH_SUBS_PATH, "utf8"));
    if (Array.isArray(parsed)) pushSubscriptionsList = parsed;
  }
} catch (_) {
  pushSubscriptionsList = [];
}
function savePushSubscriptionsStore() {
  try {
    fs.writeFileSync(
      PUSH_SUBS_PATH,
      JSON.stringify(pushSubscriptionsList.slice(0, 3000), null, 2),
      "utf8"
    );
  } catch (_) {}
  if (col.kv_store) {
    col.kv_store
      .updateOne(
        { _id: "push_subs_v1" },
        {
          $set: {
            value: pushSubscriptionsList.slice(0, 3000),
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

module.exports = { PUSH_SUBS_PATH, dispatchWebPush, isUserPushSubscribed, pushSubscriptionsList, savePushSubscriptionsStore };
