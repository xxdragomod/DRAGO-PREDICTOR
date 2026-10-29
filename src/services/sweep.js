
const { DEFAULT_ADMIN_SETTINGS, adminSettings } = require("../state/adminSettings");
const { col } = require("../state/mongo");
const { formatIstDateShort } = require("../utils/time");
const { formatNotifTemplate, pushNotification } = require("./notifications");
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
          adminSettings.notif_plan_expired_title || DEFAULT_ADMIN_SETTINGS.notif_plan_expired_title,
          { name: u.name || "Member", expiry: expStr }
        );
        const message = formatNotifTemplate(
          adminSettings.notif_plan_expired_body || DEFAULT_ADMIN_SETTINGS.notif_plan_expired_body,
          { name: u.name || "Member", expiry: expStr }
        );
        pushNotification({
          target: "user",
          user_id: u.id,
          user_name: u.name || u.email || "",
          type: "plan_expired",
          title,
          message,
          image_url: adminSettings.notif_plan_expired_image || null,
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

module.exports = { sweepExpiredProUsers };
