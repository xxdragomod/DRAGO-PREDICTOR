/**
 * Public app-config route
 *
 * Auto-split from the original monolithic server.js — behaviour unchanged.
 * Original lines: 6833-6867
 */


const { app } = require("../app");
const { PLAN_CATALOG } = require("../plans");
const { freeApiHistoryLimit, freeNexusLimit, freePredLimit, getActiveBanners, getActiveUpiId } = require("../settings");

app.get("/app-config", (_req, res) => {
  const weeklyObj = {
    name: PLAN_CATALOG.weekly.name,
    amount: PLAN_CATALOG.weekly.amount,
    days: PLAN_CATALOG.weekly.days,
    qr_url: PLAN_CATALOG.weekly.qr_url || null,
  };
  const monthlyObj = {
    name: PLAN_CATALOG.monthly.name,
    amount: PLAN_CATALOG.monthly.amount,
    days: PLAN_CATALOG.monthly.days,
    qr_url: PLAN_CATALOG.monthly.qr_url || null,
  };
  res.json({
    success: true,
    plans: {
      weekly: weeklyObj,
      monthly: monthlyObj,
      beginners: weeklyObj,
      profit: monthlyObj,
    },
    upi_id: getActiveUpiId(),
    banners: getActiveBanners(),
    free_limits: {
      pred: freePredLimit(),
      api_history: freeApiHistoryLimit(),
      nexus: freeNexusLimit(),
    },
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   ADMIN PANEL API (/admin/*) — Protected by X-Admin-Key
   Works from standalone local index.html on mobile (Origin: null supported)
   ═══════════════════════════════════════════════════════════════════════════ */

module.exports = {};
