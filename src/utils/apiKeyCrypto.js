const crypto = require("crypto");
const { API_KEY_PREFIX, APP_SECRET, APP_SECRET_PREV } = require("../config/env");
function hashApiKey(raw) {
  return crypto.createHash("sha256").update(String(raw || "")).digest("hex");
}
function maskApiKeyPrefix(prefix) {
  const p = String(prefix || API_KEY_PREFIX);
  return p + "…" + "****";
}
/** Full API key at-rest encryption (AES-256-GCM, APP_SECRET derived) — user can copy key anytime. */
function encKey(raw) {
  try {
    const iv = crypto.randomBytes(12);
    const k = Buffer.from(String(APP_SECRET).slice(0, 32).padEnd(32, "0"));
    const c = crypto.createCipheriv("aes-256-gcm", k, iv);
    let e = c.update(String(raw), "utf8");
    e = Buffer.concat([e, c.final()]);
    return (
      iv.toString("base64") +
      "." +
      c.getAuthTag().toString("base64") +
      "." +
      e.toString("base64")
    );
  } catch (_) {
    return null;
  }
}
function decKey(s) {
  try {
    const [i, t, e] = String(s || "").split(".");
    const k = Buffer.from(String(APP_SECRET).slice(0, 32).padEnd(32, "0"));
    const d = crypto.createDecipheriv("aes-256-gcm", k, Buffer.from(i, "base64"));
    d.setAuthTag(Buffer.from(t, "base64"));
    let p = d.update(e, "base64");
    p = Buffer.concat([p, d.final()]);
    return p.toString("utf8");
  } catch (_) {
    if (!APP_SECRET_PREV) return null;
    try {
      const [i2, t2, e2] = String(s || "").split(".");
      const k2 = Buffer.from(String(APP_SECRET_PREV).slice(0, 32).padEnd(32, "0"));
      const d2 = crypto.createDecipheriv("aes-256-gcm", k2, Buffer.from(i2, "base64"));
      d2.setAuthTag(Buffer.from(t2, "base64"));
      let p2 = d2.update(e2, "base64");
      p2 = Buffer.concat([p2, d2.final()]);
      return p2.toString("utf8");
    } catch (_) { return null; }
  }
}
function mapApiKey(doc) {
  if (!doc) return null;
  const prefix =
    doc.key_prefix ||
    (doc.api_key ? String(doc.api_key).slice(0, 12) : API_KEY_PREFIX);
  return {
    id: doc.id,
    user_id: doc.user_id,
    key_prefix: prefix,
    api_key_masked: maskApiKeyPrefix(prefix),
    key_enc: doc.key_enc || null,
    name: doc.name || "default",
    created_at: doc.created_at || null,
    last_used_at: doc.last_used_at || null,
  };
}

module.exports = { decKey, encKey, hashApiKey, mapApiKey, maskApiKeyPrefix };
