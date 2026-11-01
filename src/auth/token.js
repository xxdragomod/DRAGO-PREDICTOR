/**
 * JWT sign/verify + bearer auth
 *
 * Auto-split from the original monolithic server.js — behaviour unchanged.
 * Original lines: 3861-3945
 */

const crypto = require("crypto");
const jwt = require("jsonwebtoken");

const { col } = require("../db/index");
const { bumpReferrer, dbFindUserByGoogle, dbInsertUser, dbUpdateUserProfile } = require("../models/users");
const { groupNotify, istTimeStr } = require("../telegram/admin-bot");
const { JWT_EXPIRES_IN, JWT_SECRET } = require("../config");

const revokedTokenJtis = new Map(); // jti -> expiresAtMs

function signToken(user) {
  const jti = crypto.randomBytes(12).toString("hex");
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      name: user.name,
      tv: Number(user.token_version) || 0,
      jti,
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

function decodeToken(token) {
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded && decoded.jti && revokedTokenJtis.has(decoded.jti)) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

function bearerToken(req) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith("Bearer ")) return null;
  return h.slice(7).trim() || null;
}

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

module.exports = {
  authUser,
  bearerToken,
  decodeToken,
  revokedTokenJtis,
  signToken,
  upsertUser,
};

require("../lib/lazy").register(module.exports);
