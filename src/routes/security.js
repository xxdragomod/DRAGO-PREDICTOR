const express = require("express");
const router = express.Router();

/** Ban account (e.g. client security report) — JWT required (BE-5, AUDIT-8: no unauthenticated arbitrary device bans) */

const { dbBanStateByDevice, dbBlockUser, dbFindUserByIdLite, dbIsUserBanned } = require("../db/users");
const { rateLimitUser } = require("../middleware/rateLimit");
const { notifyAdminDevtoolsBan } = require("../services/telegramNotify");
const { bearerToken, decodeToken } = require("../services/tokens");
router.post("/security/devtools-ban", async (req, res) => {
  const ip = String(req.ip || req.socket?.remoteAddress || "unknown");
  if (!rateLimitUser("sec_ban:" + ip, 10, 3600000)) {
    return res.status(429).json({ success: false, message: "Too many security reports." });
  }
  const reason = String((req.body && req.body.reason) || "devtools").slice(0, 120);
  const rawDevice = String((req.body && req.body.device) || "").trim();
  const device = /^[a-zA-Z0-9_-]{6,64}$/.test(rawDevice) ? rawDevice : "";
  const token = bearerToken(req);
  const decoded = token ? decodeToken(token) : null;
  try {
    // Only authenticated users can trigger an account/device block for their own session (BE-5)
    if (!decoded || !decoded.id) {
      return res.status(401).json({ success: false, message: "Authentication required" });
    }
    const prev = await dbIsUserBanned(decoded.id);
    if (prev.banned && prev.state === "banned") {
      return res.json({ success: true, banned: true, state: "banned" });
    }
    const ok = await dbBlockUser(decoded.id, reason, device);
    console.warn("🚫 BLOCK user=", decoded.id, "reason=", reason, "device=", device || "-");
    const user = await dbFindUserByIdLite(decoded.id);
    await notifyAdminDevtoolsBan({ user, userId: decoded.id, reason, device });
    return res.json({ success: true, banned: true, state: "blocked", applied: !!ok });
  } catch (e) {
    console.error("devtools-ban:", e.message);
    return res.status(500).json({ success: false, message: "Ban failed" });
  }
});

/** Ban status — frontend early check (device + optional JWT) */
router.get("/security/ban-status", async (req, res) => {
  // 🔒 Rate limit (2026-10-05): pehle is endpoint pe koi visible limit nahi thi —
  // device IDs enumerate/brute-force kiye ja sakte the. Ab per-IP + per-device
  // dono limits hain. Limit ka jawab fail-open hai (frontend "ok" maan leta hai)
  // taaki normal users kabhi na atken.
  const rlIp = String(req.ip || req.socket?.remoteAddress || "unknown");
  if (!rateLimitUser("ban_stat_ip:" + rlIp, 100, 60000)) {
    res.setHeader("Retry-After", "30");
    return res.status(429).json({ success: false, message: "Too many ban checks. Please slow down." });
  }
  const rlDev = String(req.query.device || "").slice(0, 64);
  if (rlDev && !rateLimitUser("ban_stat_dev:" + rlDev, 30, 60000)) {
    res.setHeader("Retry-After", "30");
    return res.status(429).json({ success: false, message: "Too many ban checks for this device." });
  }
  let state = "ok";
  try {
    const device = String(req.query.device || "").slice(0, 64);
    const byDev = await dbBanStateByDevice(device);
    if (byDev) state = byDev;
    if (state !== "banned") {
      const token = bearerToken(req);
      if (token) {
        const decoded = decodeToken(token);
        if (decoded && decoded.id) {
          const b = await dbIsUserBanned(decoded.id);
          if (b.banned) state = b.state;
        }
      }
    }
  } catch (e) {
    state = "ok"; // fail-open
  }
  res.json({ success: true, state });
});

module.exports = { router };
