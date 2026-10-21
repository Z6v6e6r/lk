import { COMMUNITY_AUTH_SUBFLOW } from './communityPolicyAuth.mjs';
/** Public typed payloads never expose contact identities from legacy records. */
export function sanitizeTypedCommunityPayload(value, typed = false) {
  if (Array.isArray(value)) return value.map(item => sanitizeTypedCommunityPayload(item, typed));
  if (!value || typeof value !== 'object') return value;
  const scoped = typed || ['STATION', 'CORPORATE', 'LEAGUE'].includes(value.communityType);
  const phoneIdentity = typeof value.playerKey === 'string' && value.playerKey.startsWith('phone:');
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (scoped && (/phone|mobile|msisdn|^email$/i.test(key) || key === 'playerKey')) continue;
    if (scoped && (key === 'playerId' && phoneIdentity)) continue;
    if (scoped && /(?:^id$|Id$|Key$)/.test(key) && typeof item === 'string' && /(?:^phone:|(?:^|[^a-fA-F0-9])(?:\+7|8|7)\d{10}(?:$|[^a-fA-F0-9]))/.test(item)) continue;
    result[key] = sanitizeTypedCommunityPayload(item, scoped);
  }
  return result;
}
export function addTypedCommunityResponseRedaction(input) {
  const flow = structuredClone(input), byId = new Map(flow.map(node => [node.id, node]));
  for (const node of flow) {
    if (node.z === COMMUNITY_AUTH_SUBFLOW || node.type !== 'function' || typeof node.func !== 'string' || node.func.includes('COMMUNITY_TYPED_RESPONSE_REDACTION')) continue;
    const responsePorts = (node.wires || []).map((group, index) => group.some(id => byId.get(id)?.type === 'http response') ? index : -1).filter(index => index >= 0);
    if (!responsePorts.length) continue;
    // Restrict to community graph functions, including verified-actor/commit
    // nodes. Unrelated flow responses are preserved byte for byte.
    const communityFunction = /Community|community/.test(node.name || '') || node.func.includes('normalizeCommunityForResponse') || node.func.includes('_communityPlayerRating');
    if (!communityFunction) continue;
    node.func = `// COMMUNITY_TYPED_RESPONSE_REDACTION\nconst redact = ${sanitizeTypedCommunityPayload.toString()};\nconst output = (function() {\n${node.func}\n}).call(this);\n` + `
const ports = ${JSON.stringify(responsePorts)};
const outputs = Array.isArray(output) ? output : [output];
for (const port of ports) {
  const messages = Array.isArray(outputs[port]) ? outputs[port] : [outputs[port]];
  for (const message of messages) if (message && typeof message === 'object') message.payload = redact(message.payload, message._typedCommunity === true);
}
return output;
`;
  }
  return flow;
}
