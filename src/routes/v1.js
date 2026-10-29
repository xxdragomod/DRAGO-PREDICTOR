const express = require("express");
const router = express.Router();


const { SERVER_BRAND } = require("../config/constants");
const { requireApiKey } = require("../services/apiAuth");
const { fetchWingoHistoryFromVps } = require("../services/history");
const { WINGO_HISTORY_MAX } = require("../services/payments");
const { fetchWingoPrediction } = require("../services/prediction");
router.get("/v1/wingo30s/history", async (req, res) => {
  const auth = await requireApiKey(req, res, "history");
  if (!auth) return;

  let limit = Number.parseInt(String(req.query.limit ?? ""), 10);
  if (!Number.isFinite(limit) || limit < 1) {
    limit = WINGO_HISTORY_MAX;
  } else {
    limit = Math.min(WINGO_HISTORY_MAX, Math.max(1, limit));
  }

  try {
    const { items, updated_at } = await fetchWingoHistoryFromVps(limit);
    res.json({
      success: true,
      count: items.length,
      limit,
      Server: SERVER_BRAND,
      updated_at,
      items,
    });
  } catch (err) {
    console.error("v1 history proxy:", err.message);
    const status = err.status || 502;
    res.status(status).json({
      success: false,
      Server: SERVER_BRAND,
      message:
        status === 503
          ? "History source not configured"
          : "Failed to fetch history from source",
    });
  }
});

/**
 * Public prediction API (API key required)
 * GET /v1/wingo30s/prediction
 * Auth: X-API-Key header only; query-string credentials are rejected.
 * Rate: 20 / minute / user
 */
router.get("/v1/wingo30s/prediction", async (req, res) => {
  const auth = await requireApiKey(req, res, "prediction");
  if (!auth) return;

  try {
    const prediction = await fetchWingoPrediction();
    const pred =
      prediction && typeof prediction === "object" ? prediction : {};
    const period =
      pred.period != null
        ? pred.period
        : pred.issueNumber != null
          ? pred.issueNumber
          : pred.issue || "";
    const signal =
      pred.prediction != null
        ? pred.prediction
        : pred.signal != null
          ? pred.signal
          : pred.result != null
            ? pred.result
            : pred.value != null
              ? pred.value
              : "";
    let conf =
      pred.confidence ?? pred.conf ?? pred.score ?? pred.probability ?? null;
    if (conf != null && Number(conf) <= 1) conf = Math.round(Number(conf) * 100);
    let level =
      pred.level ?? pred.lvl ?? pred.signal_level ?? pred.strength ?? null;
    if (level != null && Number(level) <= 1) level = Math.round(Number(level) * 100);

    res.json({
      success: true,
      Server: SERVER_BRAND,
      Timestamp: new Date().toISOString(),
      Period: period === "" ? null : period,
      PREDICTION: signal === "" ? null : signal,
      CONFIDENCE: conf,
      "CURRENT LEVEL": level,
    });
  } catch (err) {
    console.error("v1 prediction:", err.message);
    const status = err.status || 502;
    res.status(status).json({
      success: false,
      Server: SERVER_BRAND,
      message:
        status === 503
          ? "Prediction source not configured"
          : "Failed to fetch prediction from source",
    });
  }
});

module.exports = { router };
