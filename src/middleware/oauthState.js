
const { ALLOWED_WEB_DOMAIN, FRONTEND_URL } = require("../config/env");
// Cookie free hosts / cross-proxy pe kabhi fail hoti hai; memory reliable hai.
const oauthStates = new Map(); // state → { exp, ref }
const STATE_TTL_MS = 10 * 60 * 1000;

function sanitizeReturnTo(u) {
  try {
    const parsed = new URL(String(u || ""));
    const origin = parsed.origin;
    const h = parsed.hostname.toLowerCase();
    if (
      origin === FRONTEND_URL ||
      origin === "https://dragopredictor.vercel.app" ||
      h === ALLOWED_WEB_DOMAIN ||
      h === "localhost" ||
      h === "127.0.0.1"
    ) {
      // Only the login page path is allowed; anything else falls back to origin.
      const isLoginPath = parsed.pathname.replace(/\/+$/, "") === "/login";
      return origin + (isLoginPath ? "/login/" : "");
    }
  } catch (_) {}
  return null;
}
function saveState(state, ref, returnTo) {
  oauthStates.set(state, { exp: Date.now() + STATE_TTL_MS, ref: ref || null, returnTo: returnTo || null });
  // Cleanup stale
  if (oauthStates.size > 500) {
    const now = Date.now();
    for (const [k, v] of oauthStates) {
      if (v.exp < now) oauthStates.delete(k);
    }
  }
}

function consumeState(state) {
  if (!state) return { ok: false, ref: null };
  const v = oauthStates.get(state);
  oauthStates.delete(state);
  if (!v || v.exp < Date.now()) return { ok: false, ref: null, returnTo: null };
  return { ok: true, ref: v.ref || null, returnTo: v.returnTo || null };
}
function sanitizeRef(r) {
  return String(r || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 12) || null;
}

// ─── Google client ──────────────────────────────────────────────────────────

module.exports = { STATE_TTL_MS, consumeState, oauthStates, sanitizeRef, sanitizeReturnTo, saveState };
