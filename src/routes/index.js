/**
 * Route registration — ORDER MATTERS.
 *
 * Express first-match-wins hai, isliye ye bilkul wahi order hai jo original
 * monolithic server.js me tha. Koi bhi line idhar-udhar mat karna.
 */

require("./meta");
require("./auth");
require("./security");
require("./user");
require("./payments-config");
require("./prediction");
require("./payments-orders");
require("./status");
require("./games");
require("./market");
require("./api-keys");
require("./public-api");
require("./engagement");
require("./payments-status");
require("./telegram");
require("./notifications");
require("./config");
require("./admin");
require("./support");
require("./errors");

module.exports = {};
