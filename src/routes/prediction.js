/**
 * Prediction + quota routes
 *
 * Auto-split from the original monolithic server.js — behaviour unchanged.
 * Original lines: 4706-4907
 */


const { app, rateLimitUser } = require("../app");
const { authUser } = require("../auth/token");
const { dbBumpFreeNexus, dbBumpFreePred, dbGetFreeNexusUsed, dbGetFreePredUsed } = require("../models/quota");
const { dbFindUserById, isFreeActive } = require("../models/users");
const { userIsPro } = require("../plans");
const { vpsHeaders } = require("../services/upstream-vps");
const { freeNexusLimit, freePredLimit } = require("../settings");
const { WINGO_PREDICTION_URL } = require("../config");
const { getPredCache, setPredCache } = require("../state");

/**
 * Live Wingo 30s prediction (proxy upstream)
 * Auth required. Pro = unlimited. Free = max freePredLimit() lifetime reveals.
 * Query: ?consume=1  → increments free counter (only when user taps Get Prediction)
 */
app.get("/wingo30s_prediction", async (req, res) => {
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
    setPredCache({
      at: Date.now(),
      prediction: clean,
      fetched_at: new Date().toISOString(),
    });

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
      (getPredCache()).prediction &&
      Date.now() - (getPredCache()).at < 15 * 60 * 1000
    ) {
      return res.json({
        success: true,
        stale: true,
        stale_reason: "source offline — last known prediction served",
        prediction: (getPredCache()).prediction,
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
app.get("/prediction-quota", async (req, res) => {
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
app.all("/nexus-quota", async (req, res) => {
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

module.exports = {};
