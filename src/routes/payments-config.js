/**
 * Payment config route (plans, UPI, QR)
 *
 * Auto-split from the original monolithic server.js — behaviour unchanged.
 * Original lines: 4673-4705
 */


const { app } = require("../app");
const { authUser } = require("../auth/token");
const { expireStaleOrders } = require("../payments/store");
const { PLAN_CATALOG } = require("../plans");
const { getActiveUpiId } = require("../settings");

/**
 * Payment config for custom QR gateway (frontend only hits this API)
 * GET /payment-config?plan=test
 */
app.get("/payment-config", (req, res) => {
  const decoded = authUser(req, res);
  if (!decoded) return;

  expireStaleOrders();

  const planKey = String(req.query.plan || "")
    .trim()
    .toLowerCase();
  const plan = PLAN_CATALOG[planKey];
  if (!plan) {
    return res.status(400).json({
      success: false,
      message: "Invalid plan. Use: test, beginners, profit",
    });
  }

  res.json({
    success: true,
    plan: planKey,
    name: plan.name,
    amount: plan.amount,
    days: plan.days,
    qr_url: plan.qr_url || null,
    ttl_minutes: 10,
    upi_id: getActiveUpiId(),
  });
});

module.exports = {};
