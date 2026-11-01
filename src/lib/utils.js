/**
 * Generic helpers
 *
 * Auto-split from the original monolithic server.js — behaviour unchanged.
 * Original lines: 230-237, 2417-2433, 3850-3860
 */


const { PUBLIC_BASE_URL } = require("../config");

function escTgMd(val, maxLen = 200) {
  return String(val == null ? "" : val)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/([_*`\[\]\\])/g, "")
    .trim()
    .slice(0, maxLen);
}


function isDiskFullError(err) {
  const m = String((err && err.message) || err || "").toLowerCase();
  return (
    m.includes("database or disk is full") ||
    m.includes("sqlite_full") ||
    m.includes("disk i/o error") ||
    m.includes("no space left") ||
    m.includes("enospc") ||
    m.includes("quota")
  );
}

/** Compatibility wrapper — payments are file-based; just run fn */
function safeDbWrite(fn) {
  return fn();
}


function publicBase(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  // Cloudflare / reverse-proxy: X-Forwarded-Proto + Host
  const proto =
    (req.get("x-forwarded-proto") || "").split(",")[0].trim() ||
    req.protocol ||
    "https";
  const host = req.get("x-forwarded-host") || req.get("host");
  return `${proto}://${host}`;
}

module.exports = {
  escTgMd,
  isDiskFullError,
  publicBase,
  safeDbWrite,
};

require("./lazy").register(module.exports);
