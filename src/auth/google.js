/**
 * Google OAuth client
 *
 * Auto-split from the original monolithic server.js — behaviour unchanged.
 * Original lines: 3847-3849
 */

const { OAuth2Client } = require("google-auth-library");

const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = require("../config");

const oauth2Client = new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);

// ─── Helpers ────────────────────────────────────────────────────────────────

module.exports = {
  oauth2Client,
};

require("../lib/lazy").register(module.exports);
