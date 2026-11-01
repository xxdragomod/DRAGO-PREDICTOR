/**
 * Document → API shape mappers
 *
 * Auto-split from the original monolithic server.js — behaviour unchanged.
 * Original lines: 282-304, 305-316, 365-381
 */


const { maskApiKeyPrefix } = require("../security/crypto");

// ── Lazy bindings: ye modules isko wapas bhi require karte hain (circular).
// Isliye direct import ki jagah pehli baar call hone par resolve hote hain.
// Behaviour same: call hamesha runtime pe hota hai, module-load pe kabhi nahi.
const { lazy } = require("../lib/lazy");
const isFreeActive = lazy("isFreeActive");


function mapUser(doc) {
  if (!doc) return null;
  return {
    id: doc.id,
    google_id: doc.google_id,
    email: doc.email || "",
    name: doc.name || "",
    picture: doc.picture || "",
    is_pro: doc.is_pro ? 1 : 0,
    free_active: isFreeActive(doc) ? 1 : 0,
    tg_id: doc.tg_id ? Number(doc.tg_id) : null,
    pro_plan: doc.pro_plan || null,
    pro_expires_at: doc.pro_expires_at || null,
    free_pred_used: Number(doc.free_pred_used) || 0,
    free_api_used: Number(doc.free_api_used) || 0,
    free_nexus_used: Number(doc.free_nexus_used) || 0,
    banned: doc.banned ? 1 : 0,
    banned_at: doc.banned_at || null,
    ban_reason: doc.ban_reason || null,
    created_at: doc.created_at || null,
  };
}


function mapGame(doc) {
  if (!doc) return null;
  return {
    id: doc.id,
    name: doc.name,
    image_url: doc.image_url,
    link_url: doc.link_url,
    sort_order: Number(doc.sort_order) || 0,
    created_at: doc.created_at || null,
  };
}


function mapApiKey(doc) {
  if (!doc) return null;
  const prefix =
    doc.key_prefix ||
    (doc.api_key ? String(doc.api_key).slice(0, 12) : "drago_");
  return {
    id: doc.id,
    user_id: doc.user_id,
    key_prefix: prefix,
    api_key_masked: maskApiKeyPrefix(prefix),
    key_enc: doc.key_enc || null,
    name: doc.name || "default",
    created_at: doc.created_at || null,
    last_used_at: doc.last_used_at || null,
  };
}

module.exports = {
  mapApiKey,
  mapGame,
  mapUser,
};

require("../lib/lazy").register(module.exports);
