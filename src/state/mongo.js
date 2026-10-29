
const { MongoClient } = require("mongodb");
const { MONGODB_URI } = require("../config/env");
let mongoClient = null;
let db = null; // MongoDB database handle
const col = {
  users: null,
  games: null,
  api_keys: null,
  api_usage: null,
  counters: null,
  banned_devices: null,
  payments: null,
  kv_store: null,
  uploads: null,
};
async function connectMongo() {
  if (db) return db;
  mongoClient = new MongoClient(MONGODB_URI, {
    maxPoolSize: 10,
    minPoolSize: 1,
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000,
  });
  await mongoClient.connect();
  db = mongoClient.db(); // uses /drago from URI
  col.users = db.collection("users");
  col.games = db.collection("games");
  col.api_keys = db.collection("api_keys");
  col.api_usage = db.collection("api_usage");
  col.counters = db.collection("counters");
  col.banned_devices = db.collection("banned_devices");
  col.payments = db.collection("payments");
  col.kv_store = db.collection("kv_store");
  col.uploads = db.collection("uploads");
  col.support_messages = db.collection("support_messages");

  // Minimal indexes only (no bloat)
  // safeIndex: agar purana index same name se alag options ke saath exist kare
  // (IndexOptionsConflict) to use drop karke naya banata hai — deploy crash nahi.
  async function safeIndex(c, spec, opts) {
    const name =
      (opts && opts.name) ||
      Object.keys(spec)
        .map((k) => k + "_1")
        .join("_");
    try {
      await c.createIndex(spec, opts);
    } catch (e) {
      try {
        await c.dropIndex(name);
        await c.createIndex(spec, opts);
      } catch (e2) {
        console.warn("index skip:", name, e2.message);
      }
    }
  }
  await Promise.all([
    safeIndex(col.users, { google_id: 1 }, { unique: true }),
    safeIndex(col.users, { id: 1 }, { unique: true }),
    safeIndex(col.users, { tg_id: 1 }),
    safeIndex(col.games, { id: 1 }, { unique: true }),
    safeIndex(col.games, { sort_order: 1 }),
    safeIndex(col.api_keys, { key_hash: 1 }, { unique: true, sparse: true }),
    safeIndex(col.api_keys, { api_key: 1 }, { unique: true, sparse: true }),
    safeIndex(col.api_keys, { user_id: 1 }),
    safeIndex(col.api_keys, { id: 1 }, { unique: true }),
    safeIndex(
      col.api_usage,
      { api_key_id: 1, endpoint: 1, day: 1 },
      { unique: true }
    ),
    safeIndex(col.api_usage, { user_id: 1, day: 1 }),
    // TTL on expire_at Date → auto-purge usage older than ~90 days
    safeIndex(col.api_usage, { expire_at: 1 }, { expireAfterSeconds: 0 }),
    // Persistent MongoDB payment orders with unique order_id index (BE-7)
    safeIndex(col.payments, { order_id: 1 }, { unique: true }),
    safeIndex(col.payments, { user_id: 1, created_at: -1 }),
    safeIndex(col.uploads, { id: 1 }, { unique: true }),
  ]);
  // Deduplicate any historical duplicate tg_id assignments so strictly 1 Telegram account = 1 DRAGO ID
  try {
    const withTg = await col.users
      .find({ tg_id: { $ne: null } })
      .sort({ id: 1 })
      .toArray();
    const seenTg = new Set();
    const dupUserIds = [];
    for (const u of withTg) {
      const t = Number(u.tg_id);
      if (!t) continue;
      if (seenTg.has(t)) {
        dupUserIds.push(u.id);
      } else {
        seenTg.add(t);
      }
    }
    if (dupUserIds.length > 0) {
      await col.users.updateMany(
        { id: { $in: dupUserIds } },
        { $set: { free_active: 0, free_expires_at: null, tg_id: null } }
      );
      console.log("🔒 Cleaned up duplicate Telegram verifications for user IDs:", dupUserIds);
    }
  } catch (e) {
    console.warn("tg_id dedupe skip:", e.message);
  }
  console.log("✅ MongoDB connected");
  return db;
}

// ── DB helpers (async, lean) ────────────────────────────────────────────────
async function dbPing() {
  await db.command({ ping: 1 });
}

/** Runtime admin settings (Telegram bot can change these) */

module.exports = { col, connectMongo, db, dbPing, mongoClient };
