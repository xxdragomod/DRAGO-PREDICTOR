
const { PUBLIC_BASE_URL } = require("../config/env");
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

module.exports = { publicBase };
