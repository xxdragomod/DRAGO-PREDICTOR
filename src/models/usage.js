/**
 * API usage aggregates
 *
 * Auto-split from the original monolithic server.js — behaviour unchanged.
 * Original lines: 1200-1263
 */


const { col } = require("../db/index");

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

module.exports = {
  dbBumpApiUsage,
  dbUsageByKey,
  dbUsageByKeyToday,
  dbUsageByUserToday,
  dbUsageByUserTotal,
};

require("../lib/lazy").register(module.exports);
