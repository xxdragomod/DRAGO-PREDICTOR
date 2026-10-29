
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

function isFreeActive(u) {
  return !!(u && u.free_active) && (!u.free_expires_at || Number(u.free_expires_at) > Date.now());
}

module.exports = { isFreeActive, mapGame, mapUser };
