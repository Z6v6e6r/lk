"use strict";

const { randomUUID } = require("node:crypto");
// Request identity is held outside msg/req: callers cannot forge this proof with
// Node-RED's public _body/skipRawBodyParser flags or a header. The settings adapter
// and the store must load this SAME installed module instance.
const accepted = new WeakMap();
const namespace = /^\/lk\/integrations\/v1(?:[/?]|$)/i;
const isPartnerRequest = req => namespace.test(req.originalUrl || req.url || "")
  || namespace.test(req.route?.path || "");
const unavailable = () => Object.assign(new Error("Partner ingress proof is absent or changed"), {
  code: "PARTNER_INGRESS_REQUIRED", httpStatus: 503, expose: false,
});
const snapshot = req => JSON.stringify([req.method, req.originalUrl, req.url, req.headers, req.body]);

function createPartnerIngressMiddleware({ rawGuard, audit } = {}) {
  if (typeof rawGuard !== "function" || typeof audit !== "function") throw new Error("PARTNER_INGRESS_CONFIG_INVALID");
  return function partnerScopedIngress(req, res, next) {
    if (!isPartnerRequest(req)) {
      // No header/body inspection, audit, timers or stream listeners on other APIs.
      return next();
    }
    // The protected Nginx ingress connects over loopback. Never trust req.ip or
    // Forwarded headers for this check. This is not a substitute for its mTLS gate.
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket?.remoteAddress)) {
      try { audit(Object.freeze({ stage: "RAW_REQUEST_GUARD", code: "RAW_PEER_INVALID", requestId: randomUUID() })); } catch { /* closed either way */ }
      res.statusCode = 503;
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Connection", "close");
      req.pause();
      return res.end('{"error":"PARTNER_INGRESS_REQUIRED"}', () => req.destroy());
    }
    return rawGuard(req, res, () => {
      accepted.set(req, snapshot(req));
      const clear = () => { accepted.delete(req); res.removeListener("finish", clear); res.removeListener("close", clear); };
      res.once("finish", clear);
      res.once("close", clear);
      next();
    });
  };
}

function consumePartnerIngress(req) {
  const proof = req && accepted.get(req);
  if (req) accepted.delete(req); // one dispatch, including failed validation
  if (!proof || proof !== snapshot(req)) throw unavailable();
  // Independent bounded data: subsequent flow edits cannot mutate the command.
  return JSON.parse(proof);
}

module.exports = { createPartnerIngressMiddleware, consumePartnerIngress, isPartnerRequest };
