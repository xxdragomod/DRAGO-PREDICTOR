/**
 * Express app: security headers, CORS, rate limit, global middleware
 *
 * Auto-split from the original monolithic server.js — behaviour unchanged.
 * Original lines: 4056-4365
 */

const crypto = require("crypto");
const cors = require("cors");
const express = require("express");

const { authUser, bearerToken, decodeToken } = require("./auth/token");
const { col } = require("./db/index");
const { getStoredImageById, hasValidImageMagicBytes, storeUploadedImage } = require("./images");
const { requireAppSignature } = require("./middleware/signature");
const { dbIsUserBanned } = require("./models/bans");
const { ALLOWED_WEB_DOMAIN, FRONTEND_URL } = require("./config");

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");

// Security headers & Request-ID middleware (BE-16)
app.use((req, res, next) => {
  const reqId = crypto.randomBytes(8).toString("hex");
  req.reqId = reqId;
  res.setHeader("X-Request-Id", reqId);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  res.setHeader("X-Permitted-Cross-Domain-Policies", "none");
  res.setHeader(
    "Strict-Transport-Security",
    "max-age=63072000; includeSubDomains; preload"
  );
  next();
});

/* ═══ SECURITY HARDENING ═══
   - imgbb key sirf server-side (FE se hataya)
   - bounded rate limiter without global reset bug (BE-8)
   - image validation: magic bytes + 4MB cap (BE-18) */
const RL = new Map();
function rateLimitUser(key, max, windowMs) {
  const now = Date.now();
  let rec = RL.get(key);
  if (!rec || now - rec.t > windowMs) {
    rec = { t: now, n: 0, w: windowMs };
  }
  rec.n++;
  RL.set(key, rec);
  if (RL.size > 10000) {
    for (const [k, v] of RL) {
      if (now - v.t > (v.w || windowMs)) RL.delete(k);
      if (RL.size <= 8000) break;
    }
    if (RL.size > 10000) {
      const oldestKey = RL.keys().next().value;
      if (oldestKey) RL.delete(oldestKey);
    }
  }
  return rec.n <= max;
}

// Global per-IP rate limit (BE-8)
app.use((req, res, next) => {
  const ip = String(req.ip || req.socket?.remoteAddress || "unknown");
  if (!rateLimitUser("ip:" + ip, 240, 60000)) {
    return res.status(429).json({ success: false, message: "Too many requests. Please slow down." });
  }
  next();
});

// Standalone Admin Panel (file:// -> Origin: null / koi origin nahi) aur allow-listed
// app origins ke liye CORS. ⚠️ 2026-10-05 security fix: pehle yahan blanket
// `Access-Control-Allow-Origin: *` tha, jisse koi bhi random website (evil.com)
// /app-config (plans/banners/upi_id) padh sakti thi. Ab sirf:
//   • no-origin / "null" (file:// admin panel, curl, non-browser clients) → "*"
//   • allow-listed origins (hamara frontend) → origin echo + Vary: Origin
//   • baaki sab → koi CORS header nahi (browser request block kar deta hai)
app.use(["/admin", "/app-config", "/uploads", "/upload-image", "/push"], (req, res, next) => {
  const origin = req.get("origin");
  let allow = null;
  if (!origin || origin === "null") {
    allow = "*";
  } else if (isCorsOriginAllowed(origin)) {
    allow = origin;
    res.setHeader("Vary", "Origin");
  }
  if (allow) {
    res.setHeader("Access-Control-Allow-Origin", allow);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, X-Admin-Key, x-admin-key, Accept, Origin, X-Timestamp, X-Signature, X-Nonce, X-Client-Domain, X-Shield"
    );
  }
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  next();
});

app.get("/uploads/:filename", async (req, res) => {
  try {
    const entry = await getStoredImageById(req.params.filename);
    if (!entry || !entry.buf) {
      return res.status(404).send("Image not found");
    }
    res.setHeader("Content-Type", entry.mime || "image/jpeg");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    return res.send(entry.buf);
  } catch (e) {
    return res.status(500).send("Error loading image");
  }
});

app.use("/upload-image", express.json({ limit: "8mb" }));
app.post("/upload-image", async (req, res) => {
  const decoded = authUser(req, res);
  if (!decoded) return;
  if (!rateLimitUser("up:" + decoded.id, 25, 3600000))
    return res.status(429).json({ success: false, message: "Too many uploads. Try later." });
  const b64 = String((req.body && req.body.image) || "");
  const m = b64.match(/^data:image\/(png|jpe?g|webp|gif);base64,(.+)$/i);
  if (!m) return res.status(400).json({ success: false, message: "Only PNG/JPG/WEBP/GIF allowed." });
  const buf = Buffer.from(m[2], "base64");
  if (buf.length > 6 * 1024 * 1024)
    return res.status(413).json({ success: false, message: "Image too large (max 6MB)." });
  if (!hasValidImageMagicBytes(buf)) {
    return res.status(400).json({ success: false, message: "Invalid image file contents." });
  }
  try {
    const url = await storeUploadedImage(buf, "image/" + m[1].toLowerCase(), req);
    return res.json({ success: true, url });
  } catch (e) {
    return res.status(502).json({ success: false, message: "Upload failed." });
  }
});

app.use("/admin", express.json({ limit: "8mb" }));
app.use(express.json({ limit: "256kb" }));

const allowedOrigins = [
  FRONTEND_URL,
  "https://dragopredictor.vercel.app",
  "http://localhost:3000",
  "http://localhost:5173",
  "http://127.0.0.1:3000",
].filter(Boolean);

// Ek hi jagah origin policy (CORS + app-origin gate dono isi ko use karte hain)
function isCorsOriginAllowed(origin) {
  try {
    if (allowedOrigins.includes(origin)) return true;
    const host = new URL(origin).hostname.toLowerCase();
    return host === ALLOWED_WEB_DOMAIN || host === "localhost" || host === "127.0.0.1";
  } catch (_) {}
  return false;
}

// Block unknown browser origins on app routes (not /v1, /admin, /app-config, /uploads) — strict allow-list (BE-6)
app.use((req, res, next) => {
  const p = String(req.originalUrl || req.path || "");
  if (
    p.startsWith("/v1") ||
    p.startsWith("/admin") ||
    p.startsWith("/app-config") ||
    p.startsWith("/uploads") ||
    p.startsWith("/push")
  ) {
    return next();
  }
  const origin = req.get("origin");
  if (!origin) return next();
  try {
    const host = new URL(origin).hostname.toLowerCase();
    if (
      allowedOrigins.includes(origin) ||
      host === ALLOWED_WEB_DOMAIN ||
      host === "localhost" ||
      host === "127.0.0.1"
    ) {
      return next();
    }
  } catch (_) {}
  return res.status(403).json({ success: false, message: "Origin not allowed" });
});

app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      try {
        const host = new URL(origin).hostname.toLowerCase();
        if (host === ALLOWED_WEB_DOMAIN || host === "localhost" || host === "127.0.0.1") {
          return cb(null, true);
        }
      } catch (_) {}
      return cb(null, false);
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-API-Key",
      "x-api-key",
      "Accept",
      "Origin",
      "X-App-Id",
      "X-Timestamp",
      "X-Signature",
      "X-Nonce",
      "X-Client-Domain",
      "X-User-Id",
      "X-User-Name",
      "X-ABP-Ts",
      "X-ABP-Sig",
      "x-abp-ts",
      "x-abp-sig",
      "X-Shield",
      "x-shield",
    ],
    exposedHeaders: [
      "X-RateLimit-Limit",
      "X-RateLimit-Remaining",
      "X-RateLimit-Reset",
    ],
    optionsSuccessStatus: 204,
    preflightContinue: false,
    credentials: false,
  })
);

// Developer API (/v1): CORS * intentional — keep for public developer access
app.use("/v1", (req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, OPTIONS"
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-API-Key, x-api-key, Accept, Origin, X-ABP-Ts, X-ABP-Sig, x-abp-ts, x-abp-sig"
  );
  res.setHeader(
    "Access-Control-Expose-Headers",
    "X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset"
  );
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  next();
});

// Explicit OPTIONS for all routes (Cloudflare / some proxies need this)
app.options("*", cors());

// Signature gates (domain + nonce). /v1 skipped inside middleware.
const sigAuth = requireAppSignature("auth");
const sigPay = requireAppSignature("payment");
const sigPublic = requireAppSignature("public-app");

async function rejectIfBanned(req, res, next) {
  try {
    const token = bearerToken(req);
    if (!token) return next();
    const decoded = decodeToken(token);
    if (!decoded || !decoded.id) return next();
    if (col.users) {
      const u = await col.users.findOne(
        { id: Number(decoded.id) },
        { projection: { token_version: 1, banned: 1, ban_state: 1, ban_reason: 1 } }
      );
      if (u && Number(u.token_version || 0) > Number(decoded.tv || 0)) {
        return res.status(401).json({
          success: false,
          message: "Session invalidated. Please sign in again.",
        });
      }
    }
    const ban = await dbIsUserBanned(decoded.id);
    if (ban.banned) {
      return res.status(403).json({
        success: false,
        banned: true,
        message: "Account suspended due to security policy violation.",
        reason: ban.reason || "policy",
      });
    }
  } catch (e) {
    console.warn("rejectIfBanned:", e.message);
  }
  next();
}
app.use(["/verify", "/profile", "/prediction-quota", "/wingo30s_prediction", "/payment-history", "/payment-config", "/create-payment", "/manual-payment", "/order-status", "/api-keys", "/api-usage", "/system-status", "/games"], rejectIfBanned);

// Auth-bound app APIs
app.use(["/verify", "/profile", "/prediction-quota", "/wingo30s_prediction", "/payment-history", "/api-keys", "/api-usage", "/system-status", "/games"], sigAuth);
app.use("/api-keys", sigAuth);

/* ── Shield telemetry (BE-4: non-blocking signal; real auth relies on JWT + server entitlements) ── */
const SHIELD_SALT = "DRAGO_SHIELD_V2_8kq2";
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
app.use(["/wingo30s_prediction", "/prediction-quota"], shieldCheck);
// Market data (no JWT) — frontend prediction page ka live chart yahin se leta hai
// (browser ko lottery API se direct CORS/Cloudflare 403 milta hai, isliye proxy)
app.use("/market", sigPublic);
app.use("/payment-config", sigPay);
app.use("/create-payment", sigPay);
app.use("/manual-payment", sigPay);
app.use("/payment-appeal", sigPay);
app.use("/order-status", sigPay);

module.exports = {
  RL,
  SHIELD_SALT,
  allowedOrigins,
  app,
  isCorsOriginAllowed,
  rateLimitUser,
  rejectIfBanned,
  shieldCheck,
  shieldDjb2,
  sigAuth,
  sigPay,
  sigPublic,
};

require("./lib/lazy").register(module.exports);
