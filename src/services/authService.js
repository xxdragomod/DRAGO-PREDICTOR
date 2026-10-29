
const { bumpReferrer, dbFindUserByGoogle, dbInsertUser, dbUpdateUserProfile } = require("../db/users");
const { col } = require("../state/mongo");
const { istTimeStr } = require("../utils/time");
const { groupNotify } = require("./telegramNotify");
const { bearerToken, decodeToken } = require("./tokens");
async function upsertUser(payload, refCode) {
  const googleId = payload.sub;
  const email = payload.email || "";
  const name = payload.name || "";
  const picture = payload.picture || "";

  let user = await dbFindUserByGoogle(googleId);
  if (!user) {
    // Referral: valid code ho to referrer ko credit (server-side, self-referral impossible)
    let referredBy = null;
    if (refCode) {
      const referrer = await col.users.findOne({ ref_code: refCode });
      if (referrer) referredBy = refCode;
    }
    user = await dbInsertUser(googleId, email, name, picture, referredBy);
    console.log("🆕 user:", email);
    if (referredBy) bumpReferrer(referredBy);
    // 🎉 new user alert → Telegram group
    groupNotify(
      "🎉 *NEW USER REGISTERED*\n\n" +
        "👤 Name: " + (name || "User") + "\n" +
        "🆔 ID: #" + user.id + "\n" +
        (referredBy ? "🔗 Referred by: " + referredBy + "\n" : "") +
        "🕒 Time: " + istTimeStr(),
      true
    );
  } else {
    await dbUpdateUserProfile(googleId, name, picture);
    user = { ...user, name, picture };
    console.log("✅ login:", email);
  }
  return user;
}
function authUser(req, res) {
  const token = bearerToken(req);
  if (!token) {
    res.status(401).json({ success: false, message: "No token provided" });
    return null;
  }
  const decoded = decodeToken(token);
  if (!decoded || !decoded.id) {
    res.status(401).json({ success: false, message: "Invalid or expired token" });
    return null;
  }
  return decoded;
}


// ─── Request signature + domain lock (frontend → Render) ───────────────────

module.exports = { authUser, upsertUser };
