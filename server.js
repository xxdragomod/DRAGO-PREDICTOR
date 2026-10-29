/**
 * DRAGO Main API — entrypoint
 *
 * Frontend (Vercel) → this server → Orihost VPS (prediction + history)
 *
 * The application itself lives in src/. This file only boots it:
 *   src/config    env loading, plans, paths, startup validation
 *   src/state     shared mutable state (mongo handles, runtime settings)
 *   src/db        MongoDB data access
 *   src/services  business logic (payments, telegram, push, predictions…)
 *   src/middleware security (signature, rate limit, shield, oauth state)
 *   src/routes    HTTP routes, one file per feature area
 *   src/app.js    express wiring
 */
require("./src/bootstrap");
