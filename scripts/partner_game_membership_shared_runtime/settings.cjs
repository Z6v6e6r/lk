"use strict";

const { createPartnerRawRequestGuard } = require("../partner_game_membership_sidecar/raw-request-guard.cjs");
const defaultIngress = require("../../node-red/custom-nodes/partner-game-membership-api/partner-game-membership-ingress.cjs");

// Local candidate adapter, not a replacement settings.js. When the custom node
// is installed from npm, pass ingress=require('<installed-package>/...ingress.cjs')
// so the proof registry is shared with the installed store.
function createSharedPartnerSettings(base, options, ingress = defaultIngress) {
  if (!base || typeof base !== "object" || Array.isArray(base)
    || (base.httpNodeRoot !== undefined && base.httpNodeRoot !== "/")
    // The default Node-RED admin root is "/". Its global body parsers run
    // before HTTP-In middleware, so a signed raw body would already be lost.
    || base.httpAdminRoot === undefined || base.httpAdminRoot === "/"
    || base.httpNodeCors || base.httpNodeMiddleware) {
    // Global CORS registers OPTIONS before httpNodeMiddleware in Node-RED 4.0.9.
    // Do not silently change existing CORS, admin or mount paths to make this API work.
    throw new Error("PARTNER_SHARED_HTTP_SETTINGS_UNSUPPORTED");
  }
  const rawGuard = createPartnerRawRequestGuard(options);
  return { ...base, httpNodeMiddleware: ingress.createPartnerIngressMiddleware({ rawGuard, audit: options.audit }) };
}

module.exports = { createSharedPartnerSettings };
