/**
 * Ban / block / device-block model
 *
 * Auto-split from the original monolithic server.js — behaviour unchanged.
 * Original lines: 850-1079
 */


const { col } = require("../db/index");
const { pushNotification } = require("../notifications");

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
        message: `Hi ${userName}, your DRAGO Predictor ID (#${uid}) has been blocked (${cleanReason}). Please contact Admin Support if you need help.`,
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

module.exports = {
  banListPayload,
  dbBanPermanent,
  dbBanStateByDevice,
  dbBanUser,
  dbBanUserPermanent,
  dbBlockDevice,
  dbBlockUser,
  dbIsUserBanned,
  dbListBanned,
  dbUnbanUser,
  dbUnlockUser,
  notifyUserBanStatus,
};

require("../lib/lazy").register(module.exports);
