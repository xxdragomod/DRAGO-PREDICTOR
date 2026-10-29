/**
 * Project root. Every JSON store (.env, payments.json, admin-settings.json, ...)
 * lives at the repo root — modules must never rely on their own __dirname.
 */
const path = require("path");

const ROOT_DIR = path.join(__dirname, "..", "..");

module.exports = { ROOT_DIR };
