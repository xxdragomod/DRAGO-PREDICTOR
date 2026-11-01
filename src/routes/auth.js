/**
 * Login / logout routes
 *
 * Auto-split from the original monolithic server.js — behaviour unchanged.
 * Original lines: 4382-4520
 */

const crypto = require("crypto");
const path = require("path");

const { app, rateLimitUser } = require("../app");
const { oauth2Client } = require("../auth/google");
const { STATE_TTL_MS, consumeState, sanitizeRef, sanitizeReturnTo, saveState } = require("../auth/oauth-state");
const { authUser, bearerToken, decodeToken, revokedTokenJtis, signToken, upsertUser } = require("../auth/token");
const { col } = require("../db/index");
const { publicBase } = require("../lib/utils");
const { FRONTEND_URL, GOOGLE_CLIENT_ID } = require("../config");
const { getAdminSettings } = require("../state");

app.get("/auth/google", (req, res) => {
  const ip = String(req.ip || req.socket?.remoteAddress || "unknown");
  if (!rateLimitUser("auth_ip:" + ip, 25, 60000)) {
    return res.status(429).json({ success: false, message: "Too many login attempts. Please wait." });
  }
  if (!(getAdminSettings()).google_auth_enabled) {
    return res.status(403).json({
      success: false,
      message: "Google login is currently disabled by admin",
    });
  }
  const redirectUri = `${publicBase(req)}/auth/google/callback`;
  const state = crypto.randomBytes(24).toString("hex");
  saveState(state, sanitizeRef(req.query.ref), sanitizeReturnTo(req.query.return_to));

  // Cookie backup (same-site backend callback)
  res.cookie("drago_oauth_state", state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: STATE_TTL_MS,
    path: "/",
  });

  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "select_account");
  url.searchParams.set("access_type", "online");

  res.redirect(url.toString());
});

/**
 * Google callback → exchange code → upsert user → JWT → frontend #token=
 */
app.get("/auth/google/callback", async (req, res) => {
  const ip = String(req.ip || req.socket?.remoteAddress || "unknown");
  if (!rateLimitUser("auth_cb:" + ip, 30, 60000)) {
    return res.status(429).send("Too many requests");
  }
  const fail = (reason) => {
    console.error("OAuth fail:", reason);
    res.redirect(`${FRONTEND_URL}/login/?error=google_auth_failed`);
  };

  try {
    const code = req.query.code;
    const state = req.query.state;

    if (!code || typeof code !== "string") {
      return fail("missing code");
    }

    // State: memory first, cookie fallback
    const cookieState = (() => {
      const raw = req.headers.cookie || "";
      for (const part of raw.split(";")) {
        const i = part.indexOf("=");
        if (i === -1) continue;
        if (part.slice(0, i).trim() === "drago_oauth_state") {
          try {
            return decodeURIComponent(part.slice(i + 1).trim());
          } catch {
            return null;
          }
        }
      }
      return null;
    })();

    const st = consumeState(state);
    const stateOk = st.ok || (state && cookieState && state === cookieState);

    res.clearCookie("drago_oauth_state", { path: "/" });

    if (!stateOk) {
      return fail("invalid state");
    }

    const redirectUri = `${publicBase(req)}/auth/google/callback`;
    const { tokens } = await oauth2Client.getToken({
      code,
      redirect_uri: redirectUri,
    });

    if (!tokens.id_token) {
      return fail("no id_token");
    }

    const ticket = await oauth2Client.verifyIdToken({
      idToken: tokens.id_token,
      audience: GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    if (!payload || !payload.sub) {
      return fail("invalid payload");
    }

    const user = await upsertUser(payload, st.ref);
    const token = signToken(user);

    // Hash fragment — server logs / referrer mein nahi jata
    const base = st.returnTo || FRONTEND_URL;
    const target = base.endsWith("/") ? base : `${base}/`;
    res.redirect(`${target}#token=${encodeURIComponent(token)}`);
  } catch (err) {
    fail(err.message || "unknown");
  }
});

/** Session revocation & logout endpoints (BE-10, PR-6) */
app.post("/auth/logout", (req, res) => {
  const token = bearerToken(req);
  const decoded = token ? decodeToken(token) : null;
  if (decoded && decoded.jti) {
    revokedTokenJtis.set(decoded.jti, Date.now());
  }
  res.json({ success: true });
});

app.post("/auth/logout-all", async (req, res) => {
  const decoded = authUser(req, res);
  if (!decoded) return;
  if (decoded.jti) revokedTokenJtis.set(decoded.jti, Date.now());
  try {
    await col.users.updateOne(
      { id: Number(decoded.id) },
      { $inc: { token_version: 1 } }
    );
    res.json({ success: true, message: "All sessions invalidated." });
  } catch (e) {
    res.status(500).json({ success: false, message: "Failed to revoke sessions." });
  }
});

module.exports = {};
