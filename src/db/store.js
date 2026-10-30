/**
 * MongoDB-only persistence helpers.
 *
 * Har runtime store (admin settings, announcement, notifications, push subs,
 * payments) MongoDB me rehta hai — disk pe kuch nahi likha jaata.
 *
 * Writes fire-and-forget nahi hain: `trackWrite` unhe queue me rakhta hai
 * taaki deploy/shutdown se pehle `flushWrites()` se flush kiye ja sakein.
 */
const { col } = require("../state/mongo");

const pendingWrites = new Set();

/** Queue a Mongo write so it can be awaited/flushed later. Never throws. */
function trackWrite(label, promise) {
  const p = Promise.resolve(promise)
    .catch((e) => console.warn(`mongo write failed (${label}):`, e.message))
    .finally(() => pendingWrites.delete(p));
  pendingWrites.add(p);
  return p;
}

/** Read a document from the kv_store collection. Returns undefined when absent. */
async function kvGet(id) {
  if (!col.kv_store) return undefined;
  try {
    const doc = await col.kv_store.findOne({ _id: id });
    return doc ? doc.value : undefined;
  } catch (e) {
    console.warn(`kvGet(${id}):`, e.message);
    return undefined;
  }
}

/** Upsert a document into the kv_store collection. */
function kvSet(id, value) {
  if (!col.kv_store) {
    console.warn(`kvSet(${id}): kv_store not ready — value dropped`);
    return Promise.resolve();
  }
  return trackWrite(
    id,
    col.kv_store.updateOne(
      { _id: id },
      { $set: { value, updated_at: new Date().toISOString() } },
      { upsert: true }
    )
  );
}

/** Wait for every queued write to settle (used on shutdown). */
async function flushWrites() {
  if (!pendingWrites.size) return;
  await Promise.allSettled(Array.from(pendingWrites));
}

module.exports = { flushWrites, kvGet, kvSet, pendingWrites, trackWrite };
