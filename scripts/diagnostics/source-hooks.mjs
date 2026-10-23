import fs from "node:fs";
import { ROUTES } from "../../src/utils/errorDiagnosticsCore.mjs";
import { createHash } from "node:crypto";
import { referralObserverBindings, applyCurrentReferralObserver } from "./referral-observer-overlay.mjs";
export const hooks = {
  "scripts/nodered_games_nodes/fn_split_join_prepare.js": "join_prepare",
  "scripts/nodered_games_nodes/fn_split_router.js": "split_router",
  "scripts/nodered_games_nodes/fn_game_payment_confirm_router.js": "confirm",
  "scripts/nodered_subscription_booking_nodes/fn_subscription_booking_mongo_error.js": "booking_error",
  "scripts/nodered_games_nodes/fn_referral_subscription_purchase_prepare.js": "purchase_prepare",
  "scripts/nodered_games_nodes/fn_referral_subscription_owner_resolve.js": "owner_resolve",
  "scripts/nodered_games_nodes/fn_referral_subscription_purchase_limit.js": "purchase_limit",
  "scripts/nodered_games_nodes/fn_referral_subscription_purchase_resolve.js": "purchase_resolve",
  "scripts/nodered_games_nodes/fn_referral_subscription_confirm_resolve.js": "confirm",
  "scripts/nodered_partner_roster_nodes/fn_preflight.js": "roster_preflight",
  "scripts/nodered_partner_roster_nodes/fn_authorize.js": "roster_authorize",
  "scripts/nodered_partner_roster_nodes/fn_wrapper.js": "roster_wrapper",
  "scripts/nodered_partner_roster_nodes/fn_ack.js": "roster_ack",
  "scripts/nodered_games_nodes/fn_patch.js": "patch",
  "scripts/nodered_auth_consent_nodes/fn_auth_consent_prepare.js": "auth_prepare",
  "scripts/nodered_auth_consent_nodes/fn_auth_consent_build_upsert.js": "auth_verify",
  "scripts/nodered_auth_consent_nodes/fn_auth_consent_response.js": "auth_response",
  "scripts/nodered_subscription_booking_nodes/fn_subscription_booking_prepare.js": "booking_prepare",
  "scripts/nodered_subscription_booking_nodes/fn_subscription_booking_router.js": "booking_router",
  "scripts/nodered_subscription_booking_nodes/fn_subscription_booking_finalize.js": "booking_finalize",
  "scripts/nodered_subscription_price_preview_nodes/entry.js": "preview_entry",
  "scripts/nodered_subscription_price_preview_nodes/router.js": "preview_router",
  "scripts/nodered_subscription_price_preview_nodes/final.js": "preview_final",
  "scripts/nodered_subscription_price_preview_nodes/error.js": "preview_error",
  "scripts/nodered_max_nodes/fn_max_client_lookup_prepare.js": "max_ingress",
  "scripts/nodered_max_nodes/fn_max_support_route.js": "max_binding",
  "scripts/nodered_max_nodes/fn_max_outbox_dispatch_prepare.js": "max_send_attempt",
  "scripts/nodered_max_nodes/fn_max_outbox_ack_prepare.js": "max_ack_prepare",
  "scripts/nodered_onboarding_nodes/fn_onboarding_level_capture_viva_result.js": "onboarding_put",
  "scripts/nodered_tournament_participants_nodes/fn_cache_gate_v2.js": "participants_cache",
};
export const sha = text => createHash("sha256").update(text).digest("hex");
// No arbitrary node IDs and no executable code from the supplied flow. Exact scoped preimages only.
export function applySourceHooks(flow, attestations, root = process.cwd()) {
  if (!Array.isArray(flow) || !Array.isArray(attestations)) throw new Error("DIAGNOSTIC_ATTESTATION_REQUIRED");
  const candidate = structuredClone(flow);
  const seen = new Set();
  for (const attestation of attestations) {
    const { id, path, preimageHash, candidateHash, routeId, routeHash } = attestation;
    const routeMatches = candidate.filter(n => n.id === routeId);
    const route = routeMatches.length === 1 ? routeMatches[0] : null;
    if (!route || route.type !== "http in" || !ROUTES.includes(route.url) || sha(JSON.stringify(route)) !== routeHash) throw new Error("DIAGNOSTIC_ROUTE_BINDING_REQUIRED");
    const visited = new Set(), pending = [route.id];
    while (pending.length && visited.size <= candidate.length) {
      const current = pending.pop();
      if (visited.has(current)) continue;
      const node = candidate.find(n => n.id === current && n.z === route.z);
      if (!node) continue;
      visited.add(current);
      for (const target of node.wires?.flat() || []) pending.push(target);
    }
    if (!visited.has(id)) throw new Error("DIAGNOSTIC_ROUTE_BINDING_UNKNOWN");
    if (!Object.hasOwn(hooks, path) || seen.has(id)) throw new Error("DIAGNOSTIC_SCOPE_INVALID");
    seen.add(id);
    const matches = candidate.filter(n => n.id === id && n.type === "function");
    if (Object.hasOwn(referralObserverBindings, path)) {
      if (matches.length !== 1) throw new Error("DIAGNOSTIC_SOURCE_DRIFT");
      matches[0].func = applyCurrentReferralObserver(candidate, attestation, matches[0].func);
      continue;
    }
    const source = fs.readFileSync(`${root}/${path}`, "utf8");
    const businessPreimage = source.match(/sourceHash: "([a-f0-9]{64})"/)?.[1];
    if (!businessPreimage || businessPreimage !== preimageHash || matches.length !== 1 || sha(matches[0].func) !== preimageHash || sha(source) !== candidateHash) throw new Error("DIAGNOSTIC_SOURCE_DRIFT");
    matches[0].func = source;
  }
  return candidate;
}
