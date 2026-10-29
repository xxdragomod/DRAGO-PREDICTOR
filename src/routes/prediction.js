const express = require("express");
const router = express.Router();


const { SERVER_BRAND } = require("../config/constants");
const { WINGO_PREDICTION_URL } = require("../config/env");
const { dbBumpFreeNexus, dbBumpFreePred, dbFindUserById, dbGetFreeNexusUsed, dbGetFreePredUsed, isFreeActive } = require("../db/users");
const { rateLimitUser } = require("../middleware/rateLimit");
const { authUser } = require("../services/authService");
const { userIsPro } = require("../services/entitlements");
const { fetchWingoHistoryFromVps } = require("../services/history");
const { WINGO_HISTORY_MAX, predCache } = require("../services/payments");
const { vpsHeaders } = require("../services/prediction");
const { freeNexusLimit, freePredLimit } = require("../state/adminSettings");
router.get("/wingo30s_prediction", async (req, res) => {
  const decoded = authUser(req, res);
  if (!decoded) return;
  if (!rateLimitUser("pred:" + decoded.id, 30, 60000)) {
    return res.status(429).json({ success: false, message: "Too many prediction requests. Please wait." });
  }

  const user = await dbFindUserById(decoded.id);
  if (!user) {
    return res.status(404).json({ success: false, message: "User not found" });
  }

  const isPro = userIsPro(user);
  const freeUsed = await dbGetFreePredUsed(decoded.id);
  // Free users always consume 1 of their 3 lifetime predictions per reveal
  const wantConsume = !isPro || String(req.query.consume || "") === "1";

  if (!isPro) {
    if (!isFreeActive(user)) {
      return res.status(403).json({
        success: false,
        verification_required: true,
        message: "Verify your Telegram account on Dashboard to unlock your 3 Free Predictions.",
      });
    }
    if (freeUsed >= freePredLimit()) {
      return res.status(402).json({
        success: false,
        message:
          "Free prediction limit (3/3) complete ho gaya hai. Unlimited predictions ke liye Pro Plan me upgrade karein.",
        billing_required: true,
        plan: "free",
        free_pred_used: freeUsed,
        free_pred_limit: freePredLimit(),
        free_pred_remaining: 0,
      });
    }
    try {
      await dbBumpFreePred(decoded.id);
    } catch (e) {
      console.error("free_pred bump:", e.message);
    }
  }

  if (!WINGO_PREDICTION_URL) {
    return res.status(503).json({
      success: false,
      message: "Prediction source not configured",
    });
  }

  try {
    const response = await fetch(WINGO_PREDICTION_URL, {
      signal: AbortSignal.timeout(10000),
      headers: vpsHeaders(),
    });

    if (!response.ok) {
      return res.status(502).json({
        success: false,
        message: `Upstream error: ${response.status}`,
      });
    }

    const data = await response.json();
    // Internal tracker fields hatao
    const { max_consec_today, max_level_today, ...clean } = data || {};

    const newUsed = isPro
      ? freeUsed
      : wantConsume
        ? freeUsed + 1
        : freeUsed;

    // Fresh result ko cache rakho — upstream fail ho to stale fallback
    predCache = {
      at: Date.now(),
      prediction: clean,
      fetched_at: new Date().toISOString(),
    };

    res.json({
      success: true,
      prediction: clean,
      plan: isPro ? "pro" : "free",
      free_pred_used: isPro ? 0 : newUsed,
      free_pred_limit: freePredLimit(),
      free_pred_remaining: isPro
        ? null
        : Math.max(0, freePredLimit() - newUsed),
    });
  } catch (err) {
    console.error("prediction error:", err.message);
    // VPS down hai par 15 min se purana NAHI wala cached prediction de do —
    // user ko "STALE" flag ke saath pichli prediction dikhe, blank na ho.
    if (
      predCache.prediction &&
      Date.now() - predCache.at < 15 * 60 * 1000
    ) {
      return res.json({
        success: true,
        stale: true,
        stale_reason: "source offline — last known prediction served",
        prediction: predCache.prediction,
        plan: isPro ? "pro" : "free",
        free_pred_used: isPro ? 0 : freeUsed,
        free_pred_limit: freePredLimit(),
        free_pred_remaining: isPro
          ? null
          : Math.max(0, freePredLimit() - freeUsed),
      });
    }
    res.status(502).json({
      success: false,
      message: "Failed to fetch prediction from source",
    });
  }
});

/** Free/pro prediction quota status (no upstream call) */
router.get("/prediction-quota", async (req, res) => {
  const decoded = authUser(req, res);
  if (!decoded) return;
  const user = await dbFindUserById(decoded.id);
  if (!user) {
    return res.status(404).json({ success: false, message: "User not found" });
  }
  const isPro = userIsPro(user);
  const freeUsed = await dbGetFreePredUsed(decoded.id);
  const nexusUsed = await dbGetFreeNexusUsed(decoded.id);
  res.json({
    success: true,
    plan: isPro ? "pro" : "free",
    is_pro: isPro,
    free_active: isFreeActive(user) ? 1 : 0,
    free_pred_used: isPro ? 0 : freeUsed,
    free_pred_limit: freePredLimit(),
    free_pred_remaining: isPro
      ? null
      : Math.max(0, freePredLimit() - freeUsed),
    free_nexus_used: isPro ? 0 : nexusUsed,
    free_nexus_limit: freeNexusLimit(),
    free_nexus_remaining: isPro
      ? null
      : Math.max(0, freeNexusLimit() - nexusUsed),
  });
});

/** NEXUS Agent quota check & lifetime 3-use consumer for free users */
router.all("/nexus-quota", async (req, res) => {
  const decoded = authUser(req, res);
  if (!decoded) return;
  const user = await dbFindUserById(decoded.id);
  if (!user) {
    return res.status(404).json({ success: false, message: "User not found" });
  }
  const isPro = userIsPro(user);
  const nexusUsed = await dbGetFreeNexusUsed(decoded.id);
  const limit = freeNexusLimit();
  const wantConsume =
    req.method === "POST" || String(req.query.consume || "") === "1";

  if (!isPro) {
    if (nexusUsed >= limit) {
      return res.status(402).json({
        success: false,
        billing_required: true,
        plan: "free",
        is_pro: false,
        free_nexus_used: nexusUsed,
        free_nexus_limit: limit,
        free_nexus_remaining: 0,
        message:
          "Free NEXUS Agent limit reached (3/3). Upgrade to Pro Plan for unlimited NEXUS Agent access.",
      });
    }
    if (wantConsume) {
      try {
        await dbBumpFreeNexus(decoded.id);
      } catch (e) {
        console.error("free_nexus bump:", e.message);
      }
    }
  }

  const newUsed = isPro ? 0 : wantConsume ? nexusUsed + 1 : nexusUsed;
  res.json({
    success: true,
    plan: isPro ? "pro" : "free",
    is_pro: isPro,
    free_active: isFreeActive(user) ? 1 : 0,
    free_nexus_used: newUsed,
    free_nexus_limit: limit,
    free_nexus_remaining: isPro ? null : Math.max(0, limit - newUsed),
  });
});

/**
 * Create payment order (Rupayex) — token sirf server pe.
 * Body: { plan: "test" | "beginners" | "profit" }
 * Auth: Bearer JWT required
 * Returns: { success, order_id, amount, payment_url }
 */
/* ─── Market data proxy (NO JWT) ─────────────────────────────────────────
 * Browser ko lottery API (draw.ar-lottery01.com) se direct CORS + Cloudflare
 * 403 milta hai, isliye frontend ka live market chart RENDER se proxy maangta hai.
 * GET /market/wingo30s/history?limit=30   →  { success, items, updated_at }
 * 10-sec in-memory cache se VPS pe load nahi padta (2s poll hone par bhi). */
const MARKET_CACHE_TTL_MS = 2 * 1000; // chart boundary pe turant fresh
let marketCache = { at: 0, items: [], updated_at: "" };

router.get("/market/wingo30s/history", async (req, res) => {
  let limit = Number.parseInt(String(req.query.limit ?? "30"), 10);
  if (!Number.isFinite(limit) || limit < 1) limit = 30;
  limit = Math.min(WINGO_HISTORY_MAX, limit);

  const now = Date.now();
  if (
    marketCache.at &&
    now - marketCache.at < MARKET_CACHE_TTL_MS &&
    marketCache.items.length
  ) {
    return res.json({
      success: true,
      count: Math.min(limit, marketCache.items.length),
      limit,
      Server: SERVER_BRAND,
      updated_at: marketCache.updated_at,
      cached: true,
      items: marketCache.items.slice(0, limit),
    });
  }

  try {
    const { items, updated_at } = await fetchWingoHistoryFromVps(
      Math.max(limit, 60)
    );
    marketCache = { at: Date.now(), items, updated_at };
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
    if (marketCache.items.length) {
      return res.status(200).json({
        success: true,
        stale: true,
        count: Math.min(limit, marketCache.items.length),
        limit,
        Server: SERVER_BRAND,
        updated_at: marketCache.updated_at,
        cached: true,
        items: marketCache.items.slice(0, limit),
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

/**
 * Developer API keys
 * POST /api-keys  { name? }  — create (max 5 per user)
 * GET  /api-keys             — list own keys
 * DELETE /api-keys/:id       — revoke
 */
const API_KEY_LIMIT = 5;

module.exports = { API_KEY_LIMIT, MARKET_CACHE_TTL_MS, marketCache, router };
