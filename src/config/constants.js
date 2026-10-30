/** @deprecated use freePredLimit() / freeApiHistoryLimit() / freeNexusLimit() */
const FREE_PRED_LIMIT = 3;
const FREE_API_HISTORY_LIMIT = 10;
const FREE_NEXUS_LIMIT = 3;
const { BRAND_EMOJI, BRAND_NAME } = require("./env");
const SERVER_BRAND = `${BRAND_EMOJI} ${BRAND_NAME.toUpperCase()}`;

module.exports = { FREE_API_HISTORY_LIMIT, FREE_NEXUS_LIMIT, FREE_PRED_LIMIT, SERVER_BRAND };
