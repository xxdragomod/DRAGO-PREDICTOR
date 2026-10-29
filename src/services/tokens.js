const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { JWT_EXPIRES_IN, JWT_SECRET } = require("../config/env");
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

module.exports = { bearerToken, decodeToken, revokedTokenJtis, signToken };
