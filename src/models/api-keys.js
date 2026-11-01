/**
 * API keys model
 *
 * Auto-split from the original monolithic server.js — behaviour unchanged.
 * Original lines: 1133-1199
 */


const { col, nextSeq } = require("../db/index");
const { mapApiKey } = require("./mappers");
const { encKey, hashApiKey } = require("../security/crypto");

async function dbInsertApiKey(userId, apiKey, name) {
  const id = await nextSeq("api_keys");
  const keyHash = hashApiKey(apiKey);
  const keyPrefix = String(apiKey).slice(0, 12);
  const doc = {
    id,
    user_id: Number(userId),
    key_hash: keyHash,
    key_prefix: keyPrefix,
    key_enc: encKey(apiKey),
    name: name || "default",
    created_at: new Date().toISOString(),
    last_used_at: null,
  };
  await col.api_keys.insertOne(doc);
  return { lastInsertRowid: id, id };
}
async function dbListApiKeys(userId) {
  const rows = await col.api_keys
    .find({ user_id: Number(userId) })
    .sort({ id: -1 })
    .toArray();
  return rows.map(mapApiKey);
}
async function dbFindApiKey(key) {
  const raw = String(key || "").trim();
  if (!raw) return null;
  const keyHash = hashApiKey(raw);
  let doc = await col.api_keys.findOne({ key_hash: keyHash });
  if (!doc) {
    doc = await col.api_keys.findOne({ api_key: raw });
    if (doc) {
      try {
        await col.api_keys.updateOne(
          { id: doc.id },
          {
            $set: { key_hash: keyHash, key_prefix: raw.slice(0, 12) },
            $unset: { api_key: "" },
          }
        );
        doc.key_hash = keyHash;
        doc.key_prefix = raw.slice(0, 12);
        delete doc.api_key;
      } catch (e) {
        console.warn("api key migrate:", e.message);
      }
    }
  }
  return mapApiKey(doc);
}
async function dbDeleteApiKey(id, userId) {
  const r = await col.api_keys.deleteOne({
    id: Number(id),
    user_id: Number(userId),
  });
  return { changes: r.deletedCount || 0 };
}
async function dbTouchApiKey(id) {
  await col.api_keys.updateOne(
    { id: Number(id) },
    { $set: { last_used_at: new Date().toISOString() } }
  );
}
async function dbCountUserApiKeys(userId) {
  const c = await col.api_keys.countDocuments({ user_id: Number(userId) });
  return { c };
}

module.exports = {
  dbCountUserApiKeys,
  dbDeleteApiKey,
  dbFindApiKey,
  dbInsertApiKey,
  dbListApiKeys,
  dbTouchApiKey,
};

require("../lib/lazy").register(module.exports);
