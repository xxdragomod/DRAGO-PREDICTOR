/** Loads .env / env / local.env from the project root before anything reads process.env. */
const path = require("path");
const dotenv = require("dotenv");
const { ROOT_DIR } = require("./paths");

dotenv.config({ path: path.join(ROOT_DIR, ".env") });
dotenv.config({ path: path.join(ROOT_DIR, "env") });
dotenv.config({ path: path.join(ROOT_DIR, "local.env") });

module.exports = { dotenv };
