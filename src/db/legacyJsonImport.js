/**
 * One-time migration: purane JSON store files ko MongoDB me import karta hai.
 *
 * Background: pehle data disk (payments.json, admin-settings.json, ...) me bhi
 * likha jaata tha. Ab MongoDB hi single source of truth hai. Render pe disk
 * ephemeral hoti hai, but agar kisi environment me purani files bachi hain to
 * ye unhe import kar leta hai (idempotent) aur `.migrated` rename kar deta hai.
 *
 * Existing Mongo data kabhi overwrite nahi hota.
 */
const fs = require("fs");
const path = require("path");
const { ROOT_DIR } = require("../config/paths");
const { col } = require("../state/mongo");

const LEGACY_FILES = [
  { file: "admin-settings.json", kv: "admin_settings" },
  { file: "announcement.json", kv: "announcement" },
  { file: "notifications.json", kv: "notifications_v1" },
  { file: "push_subs.json", kv: "push_subs_v1" },
];

function readJson(file) {
  try {
    const full = path.join(ROOT_DIR, file);
    if (!fs.existsSync(full)) return { found: false };
    const parsed = JSON.parse(fs.readFileSync(full, "utf8"));
    return { found: true, parsed, full };
  } catch (e) {
    console.warn(`legacy import: ${file} parse failed:`, e.message);
    return { found: false };
  }
}

function markMigrated(full) {
  try {
    fs.renameSync(full, full + ".migrated");
  } catch (_) {
    try {
      fs.unlinkSync(full);
    } catch (_) {}
  }
}

async function importLegacyJsonFiles() {
  if (!col.kv_store || !col.payments) return { imported: 0 };

  let imported = 0;

  // ── payments.json → payments collection (doc per order, idempotent upsert) ──
  const pay = readJson("payments.json");
  if (pay.found) {
    const rows = Array.isArray(pay.parsed) ? pay.parsed : [];
    for (const row of rows) {
      if (!row || !row.order_id) continue;
      const copy = { ...row };
      delete copy._id;
      copy.order_id = String(copy.order_id);
      await col.payments
        .updateOne(
          { order_id: copy.order_id },
          { $setOnInsert: copy },
          { upsert: true }
        )
        .catch((e) => console.warn("legacy payments import:", e.message));
      imported++;
    }
    markMigrated(pay.full);
    console.log(`   legacy import: payments.json → ${rows.length} order(s) checked`);
  }

  // ── singleton / array documents → kv_store (sirf agar Mongo me missing) ──
  for (const { file, kv } of LEGACY_FILES) {
    const res = readJson(file);
    if (!res.found) continue;
    const existing = await col.kv_store.findOne({ _id: kv });
    if (existing && existing.value !== undefined && existing.value !== null) {
      markMigrated(res.full);
      continue;
    }
    await col.kv_store.updateOne(
      { _id: kv },
      { $set: { value: res.parsed, updated_at: new Date().toISOString() } },
      { upsert: true }
    );
    markMigrated(res.full);
    imported++;
    console.log(`   legacy import: ${file} → kv_store/${kv}`);
  }

  return { imported };
}

module.exports = { LEGACY_FILES, importLegacyJsonFiles, markMigrated, readJson };
