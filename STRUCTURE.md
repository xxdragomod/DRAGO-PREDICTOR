# DRAGO PREDICTOR — Backend

Node.js + Express API jo Vercel frontend ko serve karta hai, MongoDB se data leta hai
aur prediction/history ke liye Orihost VPS ko proxy karta hai.

```bash
npm install
cp .env.example .env     # Render se real values bharo
npm start                # node server.js
```

---

## Folder Structure

Pehle poora backend ek hi `server.js` (7,938 lines) me tha. Ab feature-wise split hai:

```
server.js                  ← sirf entrypoint (15 lines): require("./src/bootstrap")
src/
├── app.js                 ← express app: middleware chain + saare routers mount
├── bootstrap.js           ← boot: Mongo connect → listen → telegram polling → cron
│
├── config/                ← environment & static config
│   ├── loadEnv.js         ←   .env / env / local.env load
│   ├── env.js             ←   saare process.env constants (ek hi jagah)
│   ├── validate.js        ←   startup fail-fast (missing secrets → exit)
│   ├── plans.js           ←   PLAN_CATALOG (weekly/monthly pricing + QR)
│   ├── paths.js           ←   ROOT_DIR (JSON stores ka base path)
│   ├── constants.js       ←   brand, deprecated limits
│   └── google.js          ←   OAuth2Client instance
│
├── state/                 ← shared mutable state (single source of truth)
│   ├── mongo.js           ←   MongoClient + db handle + collections (col.*)
│   ├── adminSettings.js   ←   runtime settings (Telegram bot se editable)
│   └── webPush.js         ←   optional web-push module
│
├── db/                    ← MongoDB data access (saare queries yahan)
│   ├── users.js           ←   user CRUD, pro/free plans, bans, referral
│   ├── games.js           ←   games collection
│   ├── apiKeys.js         ←   api keys + usage aggregates
│   └── mappers.js         ←   doc → API shape (mapUser, mapGame, isFreeActive)
│
├── services/              ← business logic (routes se call hota hai)
│   ├── payments.js        ←   orders store, Mongo sync, expiry
│   ├── entitlements.js    ←   userIsPro, activatePro
│   ├── prediction.js      ←   VPS prediction fetch
│   ├── history.js         ←   VPS history fetch + health ping
│   ├── notifications.js   ←   in-app notification store + pushDispatch
│   ├── push.js            ←   Web Push (VAPID + subscriptions)
│   ├── sweep.js           ←   expired VIP plan sweeper (60s interval)
│   ├── announcement.js    ←   announcement broadcast
│   ├── uploads.js         ←   image hosting (Mongo + RAM + ImgBB fallback)
│   ├── apiAuth.js         ←   developer API key check + rate limit
│   ├── tokens.js          ←   JWT sign/decode/bearer + revocation
│   ├── authService.js     ←   authUser, upsertUser
│   ├── telegramApi.js     ←   low-level Telegram API caller
│   ├── telegramNotify.js  ←   admin alerts, group notify, bug reports
│   └── telegramBot.js     ←   bot commands, admin panel, long-polling
│
├── middleware/            ← security layer
│   ├── signature.js       ←   origin allow-list + nonce replay protection
│   ├── rateLimit.js       ←   bounded in-memory rate limiter
│   ├── shield.js          ←   shield telemetry (non-blocking)
│   └── oauthState.js      ←   OAuth state store (memory)
│
├── routes/                ← ek file = ek feature area
│   ├── system.js          ←   / , /system-status, /guard-status, /announcement
│   ├── auth.js            ←   /auth/google, /auth/google/callback, /auth/logout*
│   ├── security.js        ←   /security/ban-status, /security/devtools-ban
│   ├── user.js            ←   /verify, /profile
│   ├── payment.js         ←   /payment-config, /create-payment, /manual-payment*,
│   │                          /payment-history, /order-status, /payment-appeal
│   ├── prediction.js      ←   /wingo30s_prediction, /prediction-quota,
│   │                          /nexus-quota, /market/wingo30s/history
│   ├── games.js           ←   /games, /games/:id
│   ├── apikeys.js         ←   /api-keys*, /api-usage
│   ├── v1.js              ←   /v1/* (public developer API, API-key auth)
│   ├── referral.js        ←   /ref-status, /ref-apply, /rate-submit,
│   │                          /win-feedback, /bug-report
│   ├── telegram.js        ←   /tg/free-sync, /tg/webhook, /free-check
│   ├── notifications.js   ←   /notifications*, /push/*, /app-config
│   ├── admin.js           ←   /admin/* (X-Admin-Key) + /support/*
│   └── uploads.js         ←   /uploads/:filename, /upload-image
│
└── utils/                 ← pure helpers (koi side effect nahi)
    ├── time.js, crypto.js, errors.js, images.js, seq.js,
    ├── apiKeyCrypto.js    ← AES-256-GCM key encryption
    ├── telegramFormat.js  ← Markdown escaping
    └── url.js
```

---

## Request Lifecycle

```
request
  └─ src/app.js
       ├─ X-Request-Id + security headers
       ├─ per-IP rate limit (240/min)
       ├─ CORS (admin panel + allow-listed origins only)
       ├─ JSON body parser (8mb for /admin & /upload-image, 256kb rest)
       ├─ origin gate (strict allow-list, /v1 | /admin | /uploads | /push exempt)
       ├─ rejectIfBanned  → token_version check + ban check
       ├─ sigAuth / sigPay / sigPublic → origin + nonce replay protection
       ├─ shieldCheck → telemetry (non-blocking)
       └─ routers (system → auth → … → admin → uploads)
            └─ 404 → error handler
```

---

## Kaise extend karein

**Naya endpoint** — uske feature ki route file me add karo:

```js
// src/routes/payment.js
router.get("/wallet", async (req, res) => { ... });
```

**Naya DB query** — `src/db/` me function likho, route se import karo:

```js
// src/db/users.js
async function dbWalletBalance(userId) { return col.users.findOne({ id: userId }); }
module.exports = { ..., dbWalletBalance };
```

**Naya env var** — `src/config/env.js` me add karo:

```js
const NEW_THING = process.env.NEW_THING || "";
module.exports = { ..., NEW_THING };   // exports list me naam add karna mat bhoolo
```

**Naya service** — `src/services/myThing.js` banao aur jahan chahiye `require` karo.
Circular dependency se bacho: shared state `src/state/` me rakho, helpers `src/utils/` me.

---

## Rules / Conventions

1. **`__dirname` use na karo** — JSON stores ke liye `ROOT_DIR` (`src/config/paths.js`) use karo,
   warna file paths `src/` ke andar chale jayenge.
2. **Module-load side effects tabhi likho jab module load hi ho** — koi module kisi ne import
   na kiya to uska top-level code kabhi nahi chalega.
3. **Shared mutable object ko reassign na karo** — properties in-place badlo
   (dekho `replaceAdminSettings` in `src/state/adminSettings.js`), warna dusre modules
   purana object pakde reh jayenge.
4. **Circular require se bacho** — cycle hone par destructured import `undefined` aata hai.
5. Route files sirf HTTP handle karein; DB/Telegram/payment logic services me rakhein.

---

## Env Vars

`.env.example` me poora list hai. Critical (missing → server start hi nahi hoga):

| Variable | Kyun |
|---|---|
| `MONGODB_URI` | database |
| `JWT_SECRET` (32+) | auth tokens |
| `APP_ID` + `APP_SECRET` (32+) | client signing |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google login |
| `ADMIN_PANEL_KEY` (32+) | /admin panel |
| `VPS_SECRET` (32+) | Orihost VPS auth |
| `TG_FREE_SECRET` (32+) / `TELEGRAM_WEBHOOK_SECRET` (32+) | free-plan bot |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | web push |

---

## Data Stores

| Store | Kahan |
|---|---|
| users, games, api_keys, api_usage, payments, kv_store, uploads, support_messages, banned_devices | MongoDB |
| `payments.json`, `admin-settings.json`, `push_subs.json`, `notifications.json`, `announcement.json` | repo root (Mongo ke saath sync) |
