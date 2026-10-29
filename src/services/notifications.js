const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { col } = require("../state/mongo");
const { dispatchWebPush } = require("./push");

const { ROOT_DIR } = require("../config/paths");
/* ── Persistent Notifications Store (Broadcast + Personal + Auto Plan Active/Expired) ── */
const NOTIFICATIONS_PATH = path.join(ROOT_DIR, "notifications.json");
let notificationsList = [];
try {
  if (fs.existsSync(NOTIFICATIONS_PATH)) {
    const parsed = JSON.parse(fs.readFileSync(NOTIFICATIONS_PATH, "utf8"));
    if (Array.isArray(parsed)) notificationsList = parsed;
  }
} catch (_) {
  notificationsList = [];
}
function saveNotificationsStore() {
  try {
    fs.writeFileSync(
      NOTIFICATIONS_PATH,
      JSON.stringify(notificationsList.slice(0, 250), null, 2),
      "utf8"
    );
  } catch (_) {}
  if (col.kv_store) {
    col.kv_store
      .updateOne(
        { _id: "notifications_v1" },
        {
          $set: {
            value: notificationsList.slice(0, 250),
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
  notificationsList.unshift(item);
  if (notificationsList.length > 250) {
    notificationsList = notificationsList.slice(0, 250);
  }
  saveNotificationsStore();
  dispatchWebPush(item).catch((err) =>
    console.warn("dispatchWebPush:", err && err.message)
  );
  return item;
}

module.exports = { NOTIFICATIONS_PATH, formatNotifTemplate, notificationsList, pushNotification, saveNotificationsStore };
