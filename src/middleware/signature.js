/**
 * Request signature / domain lock / shield
 *
 * Auto-split from the original monolithic server.js — behaviour unchanged.
 * Original lines: 3946-4055
 */

const crypto = require("crypto");

const { ALLOWED_WEB_DOMAIN, APP_ID, APP_SECRET } = require("../config");

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

function clientDomain(req) {
  const origin = req.get("origin") || "";
  const referer = req.get("referer") || "";
  const hdr = (req.get("x-client-domain") || "").trim().toLowerCase();
  let host = hdr;
  try {
    if (!host && origin) host = new URL(origin).hostname;
  } catch (_) {}
  try {
    if (!host && referer) host = new URL(referer).hostname;
  } catch (_) {}
  return String(host || "").toLowerCase().replace(/:\d+$/, "");
}

function isAllowedWebDomain(domain) {
  if (!domain) return false;
  const d = domain.toLowerCase();
  return d === ALLOWED_WEB_DOMAIN || d === "localhost" || d === "127.0.0.1";
}

// Nonce replay protection store (BE-13)
const usedNonces = new Map(); // nonce -> timestamp
const NONCE_TTL_MS = 5 * 60 * 1000;

function checkAndRecordNonce(nonce) {
  if (!nonce) return true;
  const now = Date.now();
  const prev = usedNonces.get(nonce);
  if (prev && now - prev < NONCE_TTL_MS) {
    return false;
  }
  usedNonces.set(nonce, now);
  if (usedNonces.size > 10000) {
    for (const [k, ts] of usedNonces) {
      if (now - ts >= NONCE_TTL_MS) usedNonces.delete(k);
    }
  }
  return true;
}

/** Frontend routes: strict origin check + optional nonce replay protection (BE-3, BE-6, BE-13) */
function requireAppSignature(mode) {
  return function appSigMiddleware(req, res, next) {
    if (req.path.startsWith("/v1") || String(req.originalUrl || "").startsWith("/v1")) {
      return next();
    }

    const origin = req.get("origin") || "";
    const domain = clientDomain(req);

    // Exact origin allow-list (BE-6: no wildcard *.vercel.app)
    if (origin) {
      try {
        const host = new URL(origin).hostname.toLowerCase();
        if (!isAllowedWebDomain(host)) {
          return res.status(403).json({ success: false, message: "Origin not allowed" });
        }
      } catch (_) {
        return res.status(403).json({ success: false, message: "Origin not allowed" });
      }
    } else if (domain && !isAllowedWebDomain(domain)) {
      return res.status(403).json({ success: false, message: "Domain not allowed" });
    }

    const ts = String(req.get("x-timestamp") || "").trim();
    const nonce = String(req.get("x-nonce") || "").trim();
    if (mode === "payment" && nonce) {
      if (!checkAndRecordNonce(nonce)) {
        return res.status(409).json({ success: false, message: "Duplicate request nonce" });
      }
    }

    req.dragoMeta = { domain, ts, nonce };
    next();
  };
}

// ─── App ────────────────────────────────────────────────────────────────────

module.exports = {
  NONCE_TTL_MS,
  buildSignPayload,
  checkAndRecordNonce,
  clientDomain,
  hmacSign,
  isAllowedWebDomain,
  requireAppSignature,
  timingSafeEqualStr,
  usedNonces,
};

require("../lib/lazy").register(module.exports);
