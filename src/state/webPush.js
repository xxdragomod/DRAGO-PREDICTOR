/** web-push is optional: the server must still boot when the package is absent. */
let webPush = null;
try {
  webPush = require("web-push");
} catch (_) {
  webPush = null;
}

module.exports = { webPush };
