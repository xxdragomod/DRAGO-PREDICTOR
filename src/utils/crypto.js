const crypto = require("crypto");
const { APP_ID, APP_SECRET } = require("../config/env");
function timingSafeEqualStr(a, b) {
  try {
    const ba = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}
function hmacSign(payload) {
  return crypto.createHmac("sha256", APP_SECRET).update(payload).digest("hex");
}
function buildSignPayload({ method, pathOnly, timestamp, nonce, body, userId, userName }) {
  const bodyHash = crypto
    .createHash("sha256")
    .update(body == null ? "" : typeof body === "string" ? body : JSON.stringify(body))
    .digest("hex");
  return [
    String(method || "GET").toUpperCase(),
    String(pathOnly || ""),
    String(timestamp || ""),
    String(nonce || ""),
    bodyHash,
    String(userId || ""),
    String(userName || ""),
    String(APP_ID),
  ].join("\n");
}

module.exports = { buildSignPayload, hmacSign, timingSafeEqualStr };
