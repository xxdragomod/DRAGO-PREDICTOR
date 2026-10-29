
const { PLAN_CATALOG } = require("../config/plans");
const { dbSetUserPro } = require("../db/users");
const { col } = require("../state/mongo");
const { istTimeStr } = require("../utils/time");
const { groupNotify } = require("./telegramNotify");
function userIsPro(user) {
  if (!user || !user.is_pro) return false;
  if (!user.pro_expires_at) return true;
  return new Date(user.pro_expires_at).getTime() > Date.now();
}
async function activatePro(userId, planKey) {
  const plan = PLAN_CATALOG[planKey];
  if (!plan) return null;
  const expires = new Date(Date.now() + plan.days * 86400000).toISOString();
  await dbSetUserPro(userId, 1, planKey, expires);
  // 💎 subscription alert → Telegram group
  try {
    const u = await col.users.findOne({ id: Number(userId) });
    groupNotify(
      "💎 *NEW SUBSCRIPTION ACTIVATED*\n\n" +
        "👤 Name: " + ((u && u.name) || "User") + "\n" +
        "🆔 ID: #" + userId + "\n" +
        "📦 Plan: " + planKey + " (" + plan.days + " days)\n" +
        "🕒 Time: " + istTimeStr(),
      true
    );
  } catch (e) {}
  return { plan: planKey, pro_expires_at: expires, days: plan.days };
}

module.exports = { activatePro, userIsPro };
