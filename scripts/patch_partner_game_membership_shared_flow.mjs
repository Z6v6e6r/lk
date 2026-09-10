import { buildPartnerGameMembershipApiCandidate } from "./patch_partner_game_membership_api_flow.mjs";

export const PARTNER_SHARED_TAB = Object.freeze({
  id: "a6f1000000000008", type: "tab", label: "Partner Game Membership API", disabled: false,
  info: "Local shared-runtime candidate; default off. Requires the scoped raw-request middleware in settings.js.",
});

// Conservative route collision check, including wildcard/parameter ancestors.
// It deliberately refuses ambiguous routes rather than reordering existing APIs.
function overlapsPartner(route) {
  if (typeof route !== "string" || !route.startsWith("/")) return true;
  let literal = route.toLowerCase().split(/[?:*({[\\]/, 1)[0];
  try { literal = decodeURIComponent(literal); } catch { return true; }
  const target = "/lk/integrations/v1/";
  return literal.startsWith(target) || literal === target.slice(0, -1)
    || (literal.length < route.length && target.startsWith(literal));
}

export function buildPartnerGameMembershipSharedCandidate(sourceFlow) {
  if (!Array.isArray(sourceFlow)) throw new Error("Node-RED source flow must be an array");
  if (sourceFlow.some(node => node.id === PARTNER_SHARED_TAB.id
    || (node.type === "tab" && node.label === PARTNER_SHARED_TAB.label))) throw new Error("Partner shared tab already exists");
  if (sourceFlow.some(node => node.type === "http in" && overlapsPartner(node.url))) {
    throw new Error("Partner shared namespace may overlap an existing HTTP route");
  }
  const result = buildPartnerGameMembershipApiCandidate([...sourceFlow, { ...PARTNER_SHARED_TAB }], {
    sourceTabLabel: PARTNER_SHARED_TAB.label,
  });
  const added = result.flow.slice(sourceFlow.length);
  for (const node of added) {
    if (node.type === "padlhub-partner-game-membership-store") node.requireIngressProof = true;
    if (node.type === "comment") node.info = "Shared Node-RED candidate: separate tab; requireIngressProof=true; default-off. Install scoped middleware before importing. Uses the existing read-only Viva global token and its own Mongo client. Existing flows are preserved. External protected ingress and explicit activation remain required.";
  }
  return { ...result, addedNodeIds: added.map(node => node.id), topology: "SHARED_NODE_RED_SEPARATE_TAB", deploymentPerformed: false };
}
