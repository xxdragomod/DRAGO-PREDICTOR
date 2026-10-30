/* ── Shield telemetry (BE-4: non-blocking signal; real auth relies on JWT + server entitlements) ── */
const { SHIELD_SALT } = require("../config/env");
function shieldDjb2(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
function shieldCheck(req, _res, next) {
  const s = String(req.get("x-shield") || "");
  const b = Math.floor(Date.now() / 30000);
  req.shieldValid =
    s === shieldDjb2(SHIELD_SALT + "|" + b) ||
    s === shieldDjb2(SHIELD_SALT + "|" + (b - 1));
  next();
}

module.exports = { SHIELD_SALT, shieldCheck, shieldDjb2 };
