const express = require("express");
const router = express.Router();


const { PLAN_CATALOG } = require("../config/plans");
const { dbUsageByUserTotal } = require("../db/apiKeys");
const { dbFindUserById, dbFindUserByIdLite, dbGetFreeApiUsed, dbGetFreeNexusUsed, dbGetFreePredUsed, isFreeActive } = require("../db/users");
const { usageMap } = require("../services/apiAuth");
const { authUser } = require("../services/authService");
const { userIsPro } = require("../services/entitlements");
const { freeApiHistoryLimit, freeNexusLimit, freePredLimit } = require("../state/adminSettings");
router.get("/verify", async (req, res) => {
  const decoded = authUser(req, res);
  if (!decoded) return;

  const user = await dbFindUserByIdLite(decoded.id);
  if (!user) {
    return res
      .status(401)
      .json({ success: false, message: "User not found" });
  }

  res.json({ success: true, user });
});

/** Full profile */
router.get("/profile", async (req, res) => {
  const decoded = authUser(req, res);
  if (!decoded) return;

  const user = await dbFindUserById(decoded.id);
  if (!user) {
    return res
      .status(404)
      .json({ success: false, message: "User not found" });
  }

  const created = user.created_at ? new Date(user.created_at) : null;
  const joinedDate = created
    ? created.toLocaleDateString("en-IN", {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : "Unknown";
  const daysSinceJoin = created
    ? Math.floor((Date.now() - created.getTime()) / 86400000)
    : 0;

  const isPro = userIsPro(user);
  const freeUsed = await dbGetFreePredUsed(user.id);
  const apiTotal = usageMap(await dbUsageByUserTotal(user.id));
  const userDocApiUsed = await dbGetFreeApiUsed(user.id);
  const apiHistoryUsed = Math.max(userDocApiUsed, Number(apiTotal.history) || 0);
  const nexusUsed = await dbGetFreeNexusUsed(user.id);
  res.json({
    success: true,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      picture: user.picture,
      provider: "Google",
      joinedDate,
      daysSinceJoin,
      is_pro: isPro,
      free_active: isFreeActive(user) ? 1 : 0,
      tg_id: user.tg_id || null,
      pro_plan: isPro ? user.pro_plan || null : null,
      pro_expires_at: isPro ? user.pro_expires_at || null : null,
      plan_label:
        isPro && user.pro_plan && PLAN_CATALOG[user.pro_plan]
          ? PLAN_CATALOG[user.pro_plan].name
          : isPro
            ? "Pro"
            : "Free",
      free_pred_used: isPro ? 0 : freeUsed,
      free_pred_limit: freePredLimit(),
      free_pred_remaining: isPro
        ? null
        : Math.max(0, freePredLimit() - freeUsed),
      api_history_used: apiHistoryUsed,
      api_history_limit: isPro ? null : freeApiHistoryLimit(),
      api_history_remaining: isPro
        ? null
        : Math.max(0, freeApiHistoryLimit() - apiHistoryUsed),
      free_nexus_used: isPro ? 0 : nexusUsed,
      free_nexus_limit: freeNexusLimit(),
      free_nexus_remaining: isPro
        ? null
        : Math.max(0, freeNexusLimit() - nexusUsed),
    },
  });
});

/**
 * Payment config for custom QR gateway (frontend only hits this API)
 * GET /payment-config?plan=test
 */

module.exports = { router };
