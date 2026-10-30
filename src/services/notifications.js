const crypto = require("crypto");
const { kvGet, kvSet } = require("../db/store");
const { dispatchWebPush } = require("./push");

/* ── Persistent Notifications Store (Broadcast + Personal + Auto Plan Active/Expired) ── */
const notificationsList = [];
/** Keep the in-memory list in place (stable reference for importers). */
function replaceNotifications(rows) {
  notificationsList.length = 0;
  if (Array.isArray(rows)) notificationsList.push(...rows);
}

/** Persist notifications to MongoDB (max 250 kept). */
function saveNotificationsStore() {
  return kvSet("notifications_v1", notificationsList.slice(0, 250));
}

/** Load notifications from MongoDB (boot). */
async function hydrateNotifications() {
  const stored = await kvGet("notifications_v1");
  if (Array.isArray(stored)) replaceNotifications(stored);
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

module.exports = { formatNotifTemplate, hydrateNotifications, notificationsList, pushNotification, replaceNotifications, saveNotificationsStore };
