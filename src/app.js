const crypto = require("crypto");
const cors = require("cors");
const express = require("express");
const {
  ALLOWED_WEB_DOMAIN,
  CORS_EXTRA_ORIGINS,
  DEV_ORIGINS,
  FRONTEND_URL,
  IS_PRODUCTION,
  JSON_BODY_LIMIT,
  JSON_UPLOAD_LIMIT,
  RATE_LIMIT_PER_IP,
  RATE_LIMIT_WINDOW_MS,
} = require("./config/env");
const { dbIsUserBanned } = require("./db/users");
const { rateLimitUser } = require("./middleware/rateLimit");
const { shieldCheck } = require("./middleware/shield");
const { requireAppSignature } = require("./middleware/signature");
const { bearerToken, decodeToken } = require("./services/tokens");
const { col } = require("./state/mongo");
const { validateEnv } = require("./config/validate");
const { router: systemRoutes } = require("./routes/system");
const { router: authRoutes } = require("./routes/auth");
const { router: securityRoutes } = require("./routes/security");
const { router: userRoutes } = require("./routes/user");
const { router: paymentRoutes } = require("./routes/payment");
const { router: predictionRoutes } = require("./routes/prediction");
const { router: gamesRoutes } = require("./routes/games");
const { router: apiKeyRoutes } = require("./routes/apikeys");
const { router: v1Routes } = require("./routes/v1");
const { router: referralRoutes } = require("./routes/referral");
const { router: telegramRoutes } = require("./routes/telegram");
const { router: notificationRoutes } = require("./routes/notifications");
const { router: adminRoutes } = require("./routes/admin");
const { router: uploadRoutes } = require("./routes/uploads");
// Fail fast: refuse to boot without the required secrets (was inline in server.js).
validateEnv();

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
// Global per-IP rate limit (BE-8)
app.use((req, res, next) => {
  const ip = String(req.ip || req.socket?.remoteAddress || "unknown");
  if (!rateLimitUser("ip:" + ip, RATE_LIMIT_PER_IP, RATE_LIMIT_WINDOW_MS)) {
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
app.use("/upload-image", express.json({ limit: JSON_UPLOAD_LIMIT }));
app.use("/admin", express.json({ limit: JSON_UPLOAD_LIMIT }));
app.use(express.json({ limit: JSON_BODY_LIMIT }));
// Saare allowed browser origins env se aate hain (koi hardcoded domain nahi):
//   FRONTEND_URL + CORS_EXTRA_ORIGINS  → hamesha
//   DEV_ORIGINS                        → sirf jab NODE_ENV=production na ho
const allowedOrigins = Array.from(
  new Set(
    [
      FRONTEND_URL,
      ...CORS_EXTRA_ORIGINS,
      ...(IS_PRODUCTION ? [] : DEV_ORIGINS),
    ].filter(Boolean)
  )
);

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
app.use(["/wingo30s_prediction", "/prediction-quota"], shieldCheck);
// Market data (no JWT) — frontend prediction page ka live chart yahin se leta hai
// (browser ko lottery API se direct CORS/Cloudflare 403 milta hai, isliye proxy)
app.use("/market", sigPublic);
app.use("/payment-config", sigPay);
app.use("/create-payment", sigPay);
app.use("/manual-payment", sigPay);
app.use("/payment-appeal", sigPay);
app.use("/order-status", sigPay);


// ─── Routes ─────────────────────────────────────────────────────────────────

app.use(systemRoutes);
app.use(authRoutes);
app.use(securityRoutes);
app.use(userRoutes);
app.use(paymentRoutes);
app.use(predictionRoutes);
app.use(gamesRoutes);
app.use(apiKeyRoutes);
app.use(v1Routes);
app.use(referralRoutes);
app.use(telegramRoutes);
app.use(notificationRoutes);
app.use(adminRoutes);
app.use(uploadRoutes);

// ─── Fallbacks ──────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ success: false, message: "Not found" });
});

// Error handler
app.use((err, _req, res, _next) => {
  console.error("unhandled:", err.message);
  res.status(500).json({ success: false, message: "Internal server error" });
});

module.exports = { app };
