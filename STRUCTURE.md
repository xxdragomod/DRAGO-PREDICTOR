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
│   ├── mappers.js         ←   doc → API shape (mapUser, mapGame, isFreeActive)
│   ├── store.js           ←   kv_store helpers + write queue (kvGet/kvSet/flushWrites)
│   └── legacyJsonImport.js ←  one-time migration of old JSON files → MongoDB
│
├── services/              ← business logic (routes se call hota hai)
│   ├── payments.js        ←   orders store (MongoDB `payments` collection)
│   ├── hydrate.js         ←   boot-time hydration of every store from MongoDB
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

**Har deployment value env se aati hai — code me koi deployment fallback nahi.**

Poora list `.env.example` me hai. Do categories:

### Required (missing → server boot hi nahi hoga)

| Variable | Kyun |
|---|---|
| `MONGODB_URI` | database |
| `JWT_SECRET` (32+) | auth tokens |
| `APP_ID` + `APP_SECRET` (32+) | client signing |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google login |
| `FRONTEND_URL` | OAuth redirect, CORS, QR/push URLs |
| `ALLOWED_WEB_DOMAIN` | browser origin allow-list (FRONTEND_URL se auto-derive) |
| `WINGO_PREDICTION_URL` / `WINGO_HISTORY_URL` | upstream VPS |
| `VPS_SECRET` (32+) | VPS auth |
| `UPI_ID` | manual payment destination |
| `RUPAYEX_API_BASE` | payment gateway |
| `TELEGRAM_ADMIN_BOT_TOKEN` | payment approve/deny |
| `TELEGRAM_ADMIN_CHAT_ID` | **kis chat pe alerts jaayenge** |
| `TELEGRAM_REPORT_GROUP_ID` | bug reports / ratings |
| `ADMIN_PANEL_KEY` (32+) | /admin panel |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | web push |
| `SUPPORT_EMAIL` | VAPID contact |

### Optional (set na ho to sirf warning)

`TELEGRAM_FREE_BOT_TOKEN`, `TG_CHANNEL_ID`, `TG_OWNER_CHAT`, `TG_JOIN_LINK`,
`TG_FREE_SECRET`, `TELEGRAM_WEBHOOK_SECRET`, `IMGBB_API_KEY`, `CORS_EXTRA_ORIGINS`,
`PUBLIC_BASE_URL`.

### Tuning (env se override, default code me)

`PAYMENT_TTL_MS`, `JWT_EXPIRES_IN`, `SIGNATURE_MAX_SKEW_MS`, `NONCE_TTL_MS`,
`RATE_LIMIT_PER_IP`, `API_RATE_LIMIT`, `API_KEY_LIMIT`, `MARKET_CACHE_TTL_MS`,
`WINGO_HISTORY_MAX`, `JSON_BODY_LIMIT`, `UPLOAD_MAX_BYTES`, …

### Branding & assets (env se)

`BRAND_NAME`, `BRAND_EMOJI`, `API_STATUS_LABEL`, `SUPPORT_EMAIL`,
`DEFAULT_BANNER_TITLE`, `DEFAULT_BANNER_IMAGE`, `DEFAULT_BANNER_LINK`,
`QR_FALLBACK_WEEKLY_URL`, `QR_FALLBACK_MONTHLY_URL`, `QR_REJECT_PATTERN`,
`PUSH_ICON_PATH`, `PUSH_ICON_VERSION`, `API_KEY_PREFIX`, `ORDER_ID_PREFIX`.

> Nayi env var add karte waqt: `src/config/env.js` me declare karo, exports list me
> naam add karo, `.env.example` me sample do, aur (required ho to)
> `src/config/validate.js` me check lagao. `npm run check` batayega agar kahin
> value use ho rahi hai par import nahi hui.

## Data Stores — MongoDB only

Koi JSON file nahi likhi jaati. Sab kuch MongoDB me:

| Data | Collection | Shape |
|---|---|---|
| users | `users` | ek doc per user |
| games | `games` | ek doc per game |
| api keys | `api_keys` | ek doc per key |
| api usage | `api_usage` | daily aggregates |
| **payments / orders** | `payments` | ek doc per order (`order_id` unique) |
| **admin settings** | `kv_store` | `_id: "admin_settings"` → `value` |
| **announcement** | `kv_store` | `_id: "announcement"` → `value` |
| **notifications** | `kv_store` | `_id: "notifications_v1"` → array (max 250) |
| **push subscriptions** | `kv_store` | `_id: "push_subs_v1"` → array (max 3000) |
| uploaded images | `uploads` | binary + mime |
| support messages | `support_messages` | thread per user |
| banned devices | `banned_devices` | device id |
| counters | `counters` | sequence numbers |

### Boot sequence (order matters)

```
connectMongo()
  → importLegacyJsonFiles()   // purani .json files agar mili to Mongo me import + rename *.migrated
  → hydrateStores()           // admin settings, announcement, notifications, push subs, payments
  → app.listen()              // ab traffic accept hota hai (cache kabhi khaali nahi)
```

### Writes

* In-memory cache sirf fast reads ke liye hai — source of truth MongoDB hai.
* Har write `trackWrite()` se queue hoti hai; process shutdown (SIGTERM) pe
  `flushWrites()` pending writes ko flush karke exit karta hai.

> **Migration note:** purane `payments.json` / `admin-settings.json` /
> `announcement.json` / `notifications.json` / `push_subs.json` agar server
> ke root me mile, to boot pe automatically MongoDB me import ho jaate hain
> (existing Mongo data kabhi overwrite nahi hota) aur file `.migrated`
> rename ho jaati hai.

---

## Pre-deploy checks

```bash
npm run check     # node scripts/check-refactor.js
```

Ye 3 cheezein pakadta hai (refactor ke baad common mistakes):

| Check | Kyun |
|---|---|
| **broken imports** | destructured `require` aisa naam maange jo target export hi na kare → runtime pe `undefined` → crash |
| **circular requires** | cycle me destructured import `undefined` aata hai |
| **disk writes** | runtime data sirf MongoDB me hona chahiye |

Deploy se pehle `npm run check` chala lo — 60 files, ~1 second.
