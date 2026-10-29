
const { col } = require("../state/mongo");
const { encKey, hashApiKey, mapApiKey } = require("../utils/apiKeyCrypto");
const { nextSeq } = require("../utils/seq");
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
async function dbBumpApiUsage(userId, apiKeyId, endpoint, day) {
  // expire_at = day + 90d so Atlas TTL keeps collection lean
  const expireAt = new Date(String(day) + "T00:00:00.000Z");
  expireAt.setUTCDate(expireAt.getUTCDate() + 90);
  await col.api_usage.updateOne(
    {
      api_key_id: Number(apiKeyId),
      endpoint: String(endpoint),
      day: String(day),
    },
    {
      $inc: { hits: 1 },
      $setOnInsert: {
        user_id: Number(userId),
        api_key_id: Number(apiKeyId),
        endpoint: String(endpoint),
        day: String(day),
        expire_at: expireAt,
      },
    },
    { upsert: true }
  );
}
async function dbUsageByUserToday(userId, day) {
  return col.api_usage
    .aggregate([
      { $match: { user_id: Number(userId), day: String(day) } },
      { $group: { _id: "$endpoint", hits: { $sum: "$hits" } } },
      { $project: { endpoint: "$_id", hits: 1, _id: 0 } },
    ])
    .toArray();
}
async function dbUsageByUserTotal(userId) {
  return col.api_usage
    .aggregate([
      { $match: { user_id: Number(userId) } },
      { $group: { _id: "$endpoint", hits: { $sum: "$hits" } } },
      { $project: { endpoint: "$_id", hits: 1, _id: 0 } },
    ])
    .toArray();
}
async function dbUsageByKey(apiKeyId) {
  return col.api_usage
    .aggregate([
      { $match: { api_key_id: Number(apiKeyId) } },
      { $group: { _id: "$endpoint", hits: { $sum: "$hits" } } },
      { $project: { endpoint: "$_id", hits: 1, _id: 0 } },
    ])
    .toArray();
}
async function dbUsageByKeyToday(apiKeyId, day) {
  return col.api_usage
    .aggregate([
      {
        $match: {
          api_key_id: Number(apiKeyId),
          day: String(day),
        },
      },
      { $group: { _id: "$endpoint", hits: { $sum: "$hits" } } },
      { $project: { endpoint: "$_id", hits: 1, _id: 0 } },
    ])
    .toArray();
}

module.exports = { dbBumpApiUsage, dbCountUserApiKeys, dbDeleteApiKey, dbFindApiKey, dbInsertApiKey, dbListApiKeys, dbTouchApiKey, dbUsageByKey, dbUsageByKeyToday, dbUsageByUserToday, dbUsageByUserTotal };
