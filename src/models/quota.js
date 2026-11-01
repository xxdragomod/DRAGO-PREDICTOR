/**
 * Free-tier usage counters
 *
 * Auto-split from the original monolithic server.js — behaviour unchanged.
 * Original lines: 810-849
 */


const { col } = require("../db/index");

async function dbGetFreePredUsed(userId) {
  const u = await col.users.findOne(
    { id: Number(userId) },
    { projection: { free_pred_used: 1 } }
  );
  return Number(u && u.free_pred_used) || 0;
}
async function dbBumpFreePred(userId) {
  await col.users.updateOne(
    { id: Number(userId) },
    { $inc: { free_pred_used: 1 } }
  );
}
async function dbGetFreeApiUsed(userId) {
  const u = await col.users.findOne(
    { id: Number(userId) },
    { projection: { free_api_used: 1 } }
  );
  return Number(u && u.free_api_used) || 0;
}
async function dbBumpFreeApi(userId) {
  await col.users.updateOne(
    { id: Number(userId) },
    { $inc: { free_api_used: 1 } }
  );
}
async function dbGetFreeNexusUsed(userId) {
  const u = await col.users.findOne(
    { id: Number(userId) },
    { projection: { free_nexus_used: 1 } }
  );
  return Number(u && u.free_nexus_used) || 0;
}
async function dbBumpFreeNexus(userId) {
  await col.users.updateOne(
    { id: Number(userId) },
    { $inc: { free_nexus_used: 1 } }
  );
}

module.exports = {
  dbBumpFreeApi,
  dbBumpFreeNexus,
  dbBumpFreePred,
  dbGetFreeApiUsed,
  dbGetFreeNexusUsed,
  dbGetFreePredUsed,
};

require("../lib/lazy").register(module.exports);
