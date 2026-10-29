
const { VPS_SECRET, WINGO_PREDICTION_URL } = require("../config/env");
function vpsHeaders() {
  const h = { Accept: "application/json" };
  if (VPS_SECRET) {
    h["X-VPS-Key"] = VPS_SECRET;
    h["Authorization"] = "Bearer " + VPS_SECRET;
  }
  return h;
}
async function fetchWingoPrediction() {
  if (!WINGO_PREDICTION_URL) {
    const err = new Error("Prediction source not configured");
    err.status = 503;
    throw err;
  }
  const response = await fetch(WINGO_PREDICTION_URL, {
    signal: AbortSignal.timeout(10000),
    headers: vpsHeaders(),
  });
  if (!response.ok) {
    const err = new Error(`Upstream error: ${response.status}`);
    err.status = 502;
    throw err;
  }
  const data = await response.json();
  const { max_consec_today, max_level_today, ...clean } = data || {};
  return clean;
}

/**
 * Payments store = payments.json ONLY (never deleted, never in MongoDB).
 * Users / games / api_keys in MongoDB; all order rows live in this file forever.
 */

module.exports = { fetchWingoPrediction, vpsHeaders };
