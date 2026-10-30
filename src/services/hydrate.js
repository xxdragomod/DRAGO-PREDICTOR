/**
 * Boot-time hydration.
 *
 * Saare runtime stores MongoDB se load hote hain — `app.listen()` se PEHLE.
 * Isliye koi bhi route kabhi khaali cache nahi dekhta.
 */
const { hydrateAdminSettings } = require("../state/adminSettings");
const { hydrateAnnouncement } = require("./announcement");
const { hydrateNotifications } = require("./notifications");
const { hydratePayments, isPaymentsHydrated, getPayments } = require("./payments");
const { hydratePushSubscriptions } = require("./push");

async function hydrateStores() {
  await Promise.all([
    hydrateAdminSettings(),
    hydrateAnnouncement(),
    hydrateNotifications(),
    hydratePushSubscriptions(),
    hydratePayments(),
  ]);

  return {
    payments: isPaymentsHydrated() ? getPayments().length : 0,
  };
}

module.exports = { hydrateStores };
