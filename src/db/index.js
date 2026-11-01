/**
 * MongoDB connection, collections, sequences
 *
 * Auto-split from the original monolithic server.js — behaviour unchanged.
 * Original lines: 210-215, 218-229, 273-281, 382-478, 1264-1268
 */

const { MongoClient } = require("mongodb");

const { getDb, getMongoClient, setDb, setMongoClient } = require("../state");

const MONGODB_URI = process.env.MONGODB_URI || "";
if (!MONGODB_URI) {
  console.error("❌ MONGODB_URI set karo (Render env)");
  process.exit(1);
}


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


async function nextSeq(name) {
  const r = await col.counters.findOneAndUpdate(
    { _id: name },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: "after" }
  );
  return r && r.seq != null ? r.seq : 1;
}


async function connectMongo() {
  if (getDb()) return getDb();
  setMongoClient(new MongoClient(MONGODB_URI, {
    maxPoolSize: 10,
    minPoolSize: 1,
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000,
  }));
  await (getMongoClient()).connect();
  setDb((getMongoClient()).db()); // uses /drago from URI
  col.users = (getDb()).collection("users");
  col.games = (getDb()).collection("games");
  col.api_keys = (getDb()).collection("api_keys");
  col.api_usage = (getDb()).collection("api_usage");
  col.counters = (getDb()).collection("counters");
  col.banned_devices = (getDb()).collection("banned_devices");
  col.payments = (getDb()).collection("payments");
  col.kv_store = (getDb()).collection("kv_store");
  col.uploads = (getDb()).collection("uploads");
  col.support_messages = (getDb()).collection("support_messages");

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
  return getDb();
}

// ── DB helpers (async, lean) ────────────────────────────────────────────────


async function dbPing() {
  await (getDb()).command({ ping: 1 });
}

/** Runtime admin settings (Telegram bot can change these) */

module.exports = {
  MONGODB_URI,
  col,
  connectMongo,
  dbPing,
  nextSeq,
};

require("../lib/lazy").register(module.exports);
