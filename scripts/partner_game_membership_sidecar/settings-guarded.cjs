"use strict";

const baseline = require("./settings.cjs");
const { createPartnerRawRequestGuard } = require("./raw-request-guard.cjs");

// Candidate only: NOT loaded by the frozen v0.2 packet/service. The future
// release closure must include both this factory and raw-request-guard.cjs.
function validatePartnerGuardFlows(flows) {
  const expected = new Set([
    "post /lk/integrations/v1/open-games/:gameId/members",
    "delete /lk/integrations/v1/open-games/:gameId/members/:membershipId",
    "get /lk/integrations/v1/operations/:operationId",
  ]);
  if (!Array.isArray(flows)) throw new Error("RAW_GUARD_FLOW_CONFIGURATION_INVALID");
  for (const node of flows) {
    if (node.type !== "http in") continue;
    const route = `${node.method} ${node.url}`;
    if (node.skipBodyParsing || node.upload || !expected.delete(route)) throw new Error("RAW_GUARD_FLOW_CONFIGURATION_INVALID");
  }
  if (expected.size) throw new Error("RAW_GUARD_FLOW_CONFIGURATION_INVALID");
}

function createGuardedPartnerSettings(options = {}, base = baseline) {
  if (base.httpNodeMiddleware !== undefined || base.httpNodeCors !== undefined || base.httpNodeAuth !== undefined
    || base.httpNodeRoot !== "/" || base.httpAdminRoot !== false || base.disableEditor !== true) {
    throw new Error("RAW_GUARD_SETTINGS_CONFLICT");
  }
  validatePartnerGuardFlows(options.flows);
  return { ...base, httpNodeMiddleware: createPartnerRawRequestGuard(options), apiMaxLength: "16kb" };
}

module.exports = { createGuardedPartnerSettings, validatePartnerGuardFlows };
