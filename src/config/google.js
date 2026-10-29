
const { OAuth2Client } = require("google-auth-library");
const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = require("./env");
const oauth2Client = new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);

// ─── Helpers ────────────────────────────────────────────────────────────────

module.exports = { oauth2Client };
