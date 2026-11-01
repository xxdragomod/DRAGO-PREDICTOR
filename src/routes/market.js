/**
 * Market history routes
 *
 * Auto-split from the original monolithic server.js — behaviour unchanged.
 * Original lines: 5556-5617
 */


const { app } = require("../app");
const { WINGO_HISTORY_MAX, fetchWingoHistoryFromVps } = require("../services/upstream-vps");
const { SERVER_BRAND } = require("../settings");
const { getMarketCache, setMarketCache } = require("../state");

const MARKET_CACHE_TTL_MS = 2 * 1000; // chart boundary pe turant fresh


app.get("/market/wingo30s/history", async (req, res) => {
  let limit = Number.parseInt(String(req.query.limit ?? "30"), 10);
  if (!Number.isFinite(limit) || limit < 1) limit = 30;
  limit = Math.min(WINGO_HISTORY_MAX, limit);

  const now = Date.now();
  if (
    (getMarketCache()).at &&
    now - (getMarketCache()).at < MARKET_CACHE_TTL_MS &&
    (getMarketCache()).items.length
  ) {
    return res.json({
      success: true,
      count: Math.min(limit, (getMarketCache()).items.length),
      limit,
      Server: SERVER_BRAND,
      updated_at: (getMarketCache()).updated_at,
      cached: true,
      items: (getMarketCache()).items.slice(0, limit),
    });
  }

  try {
    const { items, updated_at } = await fetchWingoHistoryFromVps(
      Math.max(limit, 60)
    );
    setMarketCache({ at: Date.now(), items, updated_at });
    res.json({
      success: true,
      count: Math.min(limit, items.length),
      limit,
      Server: SERVER_BRAND,
      updated_at,
      cached: false,
      items: items.slice(0, limit),
    });
  } catch (err) {
    // VPS down hai par purana (stale) data dena behtar hai — chart blank na ho
    if ((getMarketCache()).items.length) {
      return res.status(200).json({
        success: true,
        stale: true,
        count: Math.min(limit, (getMarketCache()).items.length),
        limit,
        Server: SERVER_BRAND,
        updated_at: (getMarketCache()).updated_at,
        cached: true,
        items: (getMarketCache()).items.slice(0, limit),
      });
    }
    console.error("market history proxy:", err.message);
    res.status(err.status || 502).json({
      success: false,
      Server: SERVER_BRAND,
      message: "Market data source offline",
    });
  }
});

module.exports = {
  MARKET_CACHE_TTL_MS,
};

require("../lib/lazy").register(module.exports);
