import {createHash} from 'node:crypto';
import { COMMUNITY_AUTH_SUBFLOW } from './communityPolicyAuth.mjs';
/** Public typed payloads never expose contact identities from legacy records. */
export function sanitizeTypedCommunityPayload(value, typed = false) {
  if (Array.isArray(value)) return value.map(item => sanitizeTypedCommunityPayload(item, typed));
  if (!value || typeof value !== 'object') return value;
  const scoped = typed || ['STATION', 'CORPORATE', 'LEAGUE', 'EVENT'].includes(value.communityType);
  const phoneIdentity = typeof value.playerKey === 'string' && value.playerKey.startsWith('phone:');
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'eventEntries' || key === 'eventRegistration' || key === '_eventEntry') continue;
    if (scoped && (/phone|mobile|msisdn|^email$/i.test(key) || key === 'playerKey')) continue;
    if (scoped && (key === 'playerId' && phoneIdentity)) continue;
    if (scoped && /(?:^id$|Id$|Key$)/.test(key) && typeof item === 'string' && /(?:^phone:|(?:^|[^a-fA-F0-9])(?:\+7|8|7)\d{10}(?:$|[^a-fA-F0-9]))/.test(item)) continue;
    result[key] = sanitizeTypedCommunityPayload(item, scoped);
  }
  return result;
}
function redactionSuffix(ports) {
  return '\n}).call(this);\n' + `
const ports = ${JSON.stringify(ports)};
const outputs = Array.isArray(output) ? output : [output];
for (const port of ports) {
  const messages = Array.isArray(outputs[port]) ? outputs[port] : [outputs[port]];
  for (const message of messages) if (message && typeof message === 'object') message.payload = redact(message.payload, message._typedCommunity === true);
}
return output;
`;
}
function wrapRedacted(body,ports) {
  return '// COMMUNITY_TYPED_RESPONSE_REDACTION\nconst redact = ' + sanitizeTypedCommunityPayload.toString() + ';\nconst output = (function() {\n' + body + redactionSuffix(ports);
}
export function addTypedCommunityResponseRedaction(input) {
  const flow = structuredClone(input), byId = new Map(flow.map(node => [node.id, node]));
  for (const node of flow) {
    if (node.z === COMMUNITY_AUTH_SUBFLOW || node.type !== 'function' || typeof node.func !== 'string') continue;
    const responsePorts = (node.wires || []).map((group, index) => group.some(id => byId.get(id)?.type === 'http response') ? index : -1).filter(index => index >= 0);
    if (node.func.includes('COMMUNITY_TYPED_RESPONSE_REDACTION')) {
      const prefix = '// COMMUNITY_TYPED_RESPONSE_REDACTION\nconst redact = ', separator = ';\nconst output = (function() {\n';
      const end = node.func.indexOf(separator,prefix.length), suffix = redactionSuffix(responsePorts);
      if (!node.func.startsWith(prefix) || end < 0 || !node.func.endsWith(suffix)) throw new Error('EVENT_REDACTION_WRAPPER_DRIFT');
      const sanitizer = node.func.slice(prefix.length,end);
      if (sanitizer !== sanitizeTypedCommunityPayload.toString() && !["9ca1ae941b8cd7f01c1be2e1bc23c472676c1629e5baf48ea646e68e65aae152", "aec9d94d0b792b78076a0bcb2960e63b330c5cb3384e47ed5c3570ae8e243a5d"].includes(createHash('sha256').update(sanitizer).digest('hex'))) throw new Error('EVENT_REDACTION_SANITIZER_DRIFT');
      node.func = wrapRedacted(node.func.slice(end+separator.length,-suffix.length),responsePorts);
      continue;
    }
    if (!responsePorts.length) continue;
    const communityFunction = /Community|community/.test(node.name || '') || node.func.includes('normalizeCommunityForResponse') || node.func.includes('_communityPlayerRating');
    if (!communityFunction) continue;
    node.func = wrapRedacted(node.func,responsePorts);
  }
  return flow;
}
