const { API_KEY_LIMIT, API_KEY_PREFIX } = require("../config/env");
const crypto = require("crypto");
const express = require("express");
const router = express.Router();


const { dbCountUserApiKeys, dbDeleteApiKey, dbInsertApiKey, dbListApiKeys, dbUsageByKey, dbUsageByKeyToday, dbUsageByUserToday, dbUsageByUserTotal } = require("../db/apiKeys");
const { dbFindUserById, dbGetFreeApiUsed, isFreeActive } = require("../db/users");
const { API_RATE_LIMIT, usageMap } = require("../services/apiAuth");
const { authUser } = require("../services/authService");
const { userIsPro } = require("../services/entitlements");
const { freeApiHistoryLimit } = require("../state/adminSettings");
const { decKey } = require("../utils/apiKeyCrypto");
const { todayKey } = require("../utils/time");
router.post("/api-keys", async (req, res) => {
  const decoded = authUser(req, res);
  if (!decoded) return;

  const countRow = await dbCountUserApiKeys(decoded.id);
  if (countRow && Number(countRow.c) >= API_KEY_LIMIT) {
    return res.status(400).json({
      success: false,
      message: `Max ${API_KEY_LIMIT} API keys allowed. Delete one first.`,
    });
  }

  const name = String((req.body && req.body.name) || "default")
    .trim()
    .slice(0, 40) || "default";
  const apiKey =
    API_KEY_PREFIX + crypto.randomBytes(24).toString("hex");

  try {
    const info = await dbInsertApiKey(decoded.id, apiKey, name);
    res.json({
      success: true,
      id: Number(info.lastInsertRowid),
      api_key: apiKey,
      key_prefix: apiKey.slice(0, 12),
      name,
      endpoints: {
        history: "/v1/wingo30s/history",
        prediction: "/v1/wingo30s/prediction",
      },
      rate_limit: { per_minute: API_RATE_LIMIT },
      usage: {
        header: "X-API-Key: " + apiKey,
      },
      warning: "Copy this key now. It is stored hashed and cannot be shown again.",
    });
  } catch (e) {
    console.error("api-keys create:", e.message);
    res.status(500).json({ success: false, message: "Could not create key" });
  }
});

router.get("/api-keys", async (req, res) => {
  const decoded = authUser(req, res);
  if (!decoded) return;

  const day = todayKey();
  const rows = await dbListApiKeys(decoded.id);
  const keys = [];
  for (const r of rows) {
    const total = usageMap(await dbUsageByKey(r.id));
    const today = usageMap(await dbUsageByKeyToday(r.id, day));
    keys.push({
      id: r.id,
      key_prefix: r.key_prefix,
      api_key_masked: r.api_key_masked,
      api_key_full: r.key_enc ? decKey(r.key_enc) : null,
      name: r.name || "default",
      created_at: r.created_at,
      last_used_at: r.last_used_at || null,
      usage: { total, today },
    });
  }
  res.json({
    success: true,
    keys,
    endpoints: {
      history: "/v1/wingo30s/history",
      prediction: "/v1/wingo30s/prediction",
    },
    rate_limit: { per_minute: API_RATE_LIMIT },
    max: API_KEY_LIMIT,
  });
});

router.delete("/api-keys/:id", async (req, res) => {
  const decoded = authUser(req, res);
  if (!decoded) return;

  const id = Number(req.params.id);
  if (!id) {
    return res.status(400).json({ success: false, message: "Invalid id" });
  }
  const result = await dbDeleteApiKey(id, decoded.id);
  if (!result.changes) {
    return res.status(404).json({ success: false, message: "Key not found" });
  }
  res.json({ success: true, message: "API key deleted" });
});

/** Usage monitor for logged-in user */
router.get("/api-usage", async (req, res) => {
  const decoded = authUser(req, res);
  if (!decoded) return;

  const day = todayKey();
  const today = usageMap(await dbUsageByUserToday(decoded.id, day));
  const total = usageMap(await dbUsageByUserTotal(decoded.id));
  const keyRows = await dbListApiKeys(decoded.id);
  const keys = [];
  for (const r of keyRows) {
    keys.push({
      id: r.id,
      name: r.name || "default",
      last_used_at: r.last_used_at || null,
      usage: {
        total: usageMap(await dbUsageByKey(r.id)),
        today: usageMap(await dbUsageByKeyToday(r.id, day)),
      },
    });
  }

  const user = await dbFindUserById(decoded.id);
  const isPro = userIsPro(user);
  const userDocApiUsed = await dbGetFreeApiUsed(decoded.id);
  const historyUsed = Math.max(userDocApiUsed, Number(total.history) || 0);
  const billingRequired =
    !isPro && historyUsed >= freeApiHistoryLimit();

  res.json({
    success: true,
    plan: isPro ? "pro" : "free",
    is_pro: isPro,
    free_active: isFreeActive(user) ? 1 : 0,
    rate_limit: isPro
      ? { per_minute: API_RATE_LIMIT, window_sec: 60 }
      : {
          lifetime_history: freeApiHistoryLimit(),
          history_used: historyUsed,
          history_remaining: Math.max(0, freeApiHistoryLimit() - historyUsed),
        },
    billing_required: billingRequired,
    billing_message: billingRequired
      ? "Free plan limit complete (10/10 Drago API data fetches). Upgrade to Pro Plan for unlimited API access."
      : null,
    today,
    total,
    keys,
  });
});

/**
 * Public history API (API key required)
 * GET /v1/wingo30s/history
 * Auth: X-API-Key header only; query-string credentials are rejected.
 * Query: limit=1..1000  (newest first; default = all stored, max 1000)
 * Rate: 20 / minute / user
 * Example: GET /v1/wingo30s/history?limit=50 with header X-API-Key: <key>
 */

module.exports = { router };
