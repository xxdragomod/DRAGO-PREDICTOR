/**
 * Free-verification bot helpers
 *
 * Auto-split from the original monolithic server.js — behaviour unchanged.
 * Original lines: 6405-6440
 */

const crypto = require("crypto");
const jwt = require("jsonwebtoken");

const { JWT_SECRET, TG_BOT_TOKEN, TG_FREE_SECRET } = require("../config");

function tgCall(method, payload) {
  return fetch("https://api.telegram.org/bot" + TG_BOT_TOKEN + "/" + method, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).then((r) => r.json()).catch(() => null);
}
function tgMemberStatus(joined) {
  return joined && joined.result ? String(joined.result.status) : "";
}
function parseTgStartCode(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  if (s.startsWith("v_")) {
    const parts = s.split("_");
    if (parts.length === 4) {
      const uid = Number(parts[1]);
      const expSec = parseInt(parts[2], 36);
      const sig = parts[3];
      if (Number.isFinite(uid) && uid > 0 && Number.isFinite(expSec) && expSec * 1000 > Date.now()) {
        const expected = crypto
          .createHmac("sha256", TG_FREE_SECRET)
          .update(`v.${uid}.${parts[2]}`)
          .digest("hex")
          .slice(0, 16);
        if (sig === expected) return uid;
      }
    }
  }
  try {
    const d = jwt.verify(s, JWT_SECRET);
    if (d && d.id != null) return Number(d.id);
  } catch (_) {}
  return null;
}

module.exports = {
  parseTgStartCode,
  tgCall,
  tgMemberStatus,
};

require("../lib/lazy").register(module.exports);
