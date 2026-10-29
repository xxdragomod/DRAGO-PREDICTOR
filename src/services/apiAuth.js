/** Developer API rate limit: 20 requests / minute / user / endpoint */

const { dbBumpApiUsage, dbFindApiKey, dbTouchApiKey, dbUsageByUserTotal } = require("../db/apiKeys");
const { dbBumpFreeApi, dbFindUserById, dbGetFreeApiUsed } = require("../db/users");
const { freeApiHistoryLimit } = require("../state/adminSettings");
const { todayKey } = require("../utils/time");
const { userIsPro } = require("./entitlements");
const API_RATE_LIMIT = 20;
const API_RATE_WINDOW_MS = 60 * 1000;
const apiRateBuckets = new Map(); // `${userId}:${endpoint}` → number[] timestamps
function checkApiRateLimit(userId, endpoint) {
  const k = String(userId) + ":" + endpoint;
  const now = Date.now();
  let arr = apiRateBuckets.get(k) || [];
  arr = arr.filter((t) => now - t < API_RATE_WINDOW_MS);
  if (arr.length >= API_RATE_LIMIT) {
    const resetMs = Math.max(0, API_RATE_WINDOW_MS - (now - arr[0]));
    return {
      ok: false,
      limit: API_RATE_LIMIT,
      remaining: 0,
      reset_sec: Math.ceil(resetMs / 1000),
    };
  }
  arr.push(now);
  apiRateBuckets.set(k, arr);
  // light cleanup
  if (apiRateBuckets.size > 5000) {
    for (const [key, ts] of apiRateBuckets) {
      const live = ts.filter((t) => now - t < API_RATE_WINDOW_MS);
      if (!live.length) apiRateBuckets.delete(key);
      else apiRateBuckets.set(key, live);
    }
  }
  return {
    ok: true,
    limit: API_RATE_LIMIT,
    remaining: API_RATE_LIMIT - arr.length,
    reset_sec: 60,
  };
}
async function recordApiUsage(userId, apiKeyId, endpoint) {
  try {
    await dbBumpApiUsage(userId, apiKeyId, endpoint, todayKey());
  } catch (e) {
    console.error("api_usage:", e.message);
  }
}

/**
 * Validate X-API-Key header, rate-limit, free/pro quotas, touch + usage.
 * Returns { row, rate, isPro } or sends error response and returns null.
 *
 * Free users:
 *   - history only (prediction blocked)
 *   - lifetime max freeApiHistoryLimit() history fetches
 * Pro users:
 *   - 20 requests / minute / endpoint (unchanged)
 */
async function requireApiKey(req, res, endpointName) {
  // Query-string credentials are rejected: URLs can leak through history, logs, and referrers.
  if (Object.keys(req.query || {}).some((name) => name.toLowerCase().replace(/[-_]/g, "") === "apikey")) {
    res.status(400).json({
      success: false,
      message: "API keys are accepted only in the X-API-Key header (never in URLs).",
    });
    return null;
  }
  const authHeader = String(req.headers.authorization || "").trim();
  const bearerKey = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
  const key = String(req.headers["x-api-key"] || bearerKey || "").trim();
  if (!key || key.length < 16 || key.length > 256) {
    res.status(401).json({
      success: false,
      message: "API key required in the X-API-Key header.",
    });
    return null;
  }
  const row = await dbFindApiKey(key);
  if (!row) {
    res.status(401).json({ success: false, message: "Invalid API key" });
    return null;
  }

  const user = await dbFindUserById(row.user_id);
  const isPro = userIsPro(user);

  // History: free + any pro. Prediction API: any active Pro plan (Weekly ₹749 / Monthly ₹1498)
  if (endpointName === "prediction") {
    const planKey = user && user.pro_plan ? String(user.pro_plan) : "";
    if (!isPro) {
      res.status(403).json({
        success: false,
        message:
          "Prediction API is available only on Pro VIP plans (₹749 Weekly / ₹1,498 Monthly). Upgrade to access.",
        billing_required: true,
        plan: planKey || "free",
        required_plan: "weekly",
      });
      return null;
    }
  } else if (endpointName !== "history" && !isPro) {
    res.status(403).json({
      success: false,
      message:
        "Free plan: only history data fetch is allowed. Upgrade to Pro for prediction API.",
      billing_required: true,
      plan: "free",
    });
    return null;
  }

  // Free: lifetime history quota (10 fetches max across lifetime)
  let freeHistoryHits = 0;
  if (!isPro && endpointName === "history") {
    const totalUsage = usageMap(await dbUsageByUserTotal(row.user_id));
    const userDocApiUsed = await dbGetFreeApiUsed(row.user_id);
    freeHistoryHits = Math.max(userDocApiUsed, Number(totalUsage.history) || 0);
    if (freeHistoryHits >= freeApiHistoryLimit()) {
      res.status(402).json({
        success: false,
        message:
          "Free plan limit reached (10/10 Drago API data fetches). Upgrade to Pro Plan for unlimited API access.",
        billing_required: true,
        plan: "free",
        used: freeHistoryHits,
        limit: freeApiHistoryLimit(),
      });
      return null;
    }
  }

  const rate = isPro
    ? checkApiRateLimit(row.user_id, endpointName)
    : {
        ok: true,
        limit: freeApiHistoryLimit(),
        remaining: Math.max(0, freeApiHistoryLimit() - freeHistoryHits),
        reset_sec: 0,
      };

  if (isPro) {
    res.setHeader("X-RateLimit-Limit", String(rate.limit));
    res.setHeader("X-RateLimit-Remaining", String(rate.remaining));
    res.setHeader("X-RateLimit-Reset", String(rate.reset_sec));
    if (!rate.ok) {
      res.status(429).json({
        success: false,
        message: `Rate limit: max ${rate.limit} requests per minute for ${endpointName}`,
        limit: rate.limit,
        remaining: 0,
        reset_sec: rate.reset_sec,
      });
      return null;
    }
  } else {
    res.setHeader("X-RateLimit-Limit", String(freeApiHistoryLimit()));
    res.setHeader(
      "X-RateLimit-Remaining",
      String(Math.max(0, rate.remaining - 1))
    );
  }

  try {
    await dbTouchApiKey(row.id);
  } catch (_) {}
  if (!isPro && endpointName === "history") {
    try {
      await dbBumpFreeApi(row.user_id);
    } catch (_) {}
  }
  await recordApiUsage(row.user_id, row.id, endpointName);
  return { row, rate, isPro };
}
function usageMap(rows) {
  const out = { history: 0, prediction: 0, total: 0 };
  for (const r of rows || []) {
    const ep = String(r.endpoint || "");
    const h = Number(r.hits) || 0;
    if (ep === "history") out.history += h;
    else if (ep === "prediction") out.prediction += h;
    out.total += h;
  }
  return out;
}

module.exports = { API_RATE_LIMIT, API_RATE_WINDOW_MS, apiRateBuckets, checkApiRateLimit, recordApiUsage, requireApiKey, usageMap };
