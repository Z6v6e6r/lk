import {createHash} from 'node:crypto';
import { COMMUNITY_AUTH_SUBFLOW } from './communityPolicyAuth.mjs';
/** Public typed payloads never expose contact identities from legacy records. */
export function sanitizeTypedCommunityPayload(value, typed = false) {
  // HTTP media responses must keep their binary payload, including its identity.
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) return value;
  if (Array.isArray(value)) return value.map(item => sanitizeTypedCommunityPayload(item, typed));
  if (!value || typeof value !== 'object') return value;
  const scoped = typed || ['STATION', 'CORPORATE', 'LEAGUE', 'EVENT'].includes(value.communityType);
  const phoneIdentity = typeof value.playerKey === 'string' && value.playerKey.startsWith('phone:');
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (['stationMembershipLifetime', 'stationMembershipAdmission', 'admissionBindingSha256', 'communityMessageOutbox', 'stationMessageEvent', 'stationMessageOwner'].includes(key)) continue;
    if (key === 'eventEntries' || key === 'eventRegistration' || key === '_eventEntry') continue;
    if (scoped && (/phone|mobile|msisdn|^email$/i.test(key) || key === 'playerKey')) continue;
    if (scoped && (key === 'playerId' && phoneIdentity)) continue;
    if (scoped && /(?:^id$|Id$|Key$)/.test(key) && typeof item === 'string' && /(?:^phone:|(?:^|[^a-fA-F0-9])(?:\+7|8|7)\d{10}(?:$|[^a-fA-F0-9]))/.test(item)) continue;
    if (['logo', 'logoUrl', 'logoThumbUrl'].includes(key) && typeof item === 'string'
      && /^(?:(?:https?:)?\/\/(?:padlhub\.su|lk-reserve\.89-108-64-209\.sslip\.io)(?::\d+)?)?\/lk\/media\/community-logo(?:-legacy)?\/[^?#]+(?:[?#]|$)/i.test(item)) {
      // The previous binary regression was cached as immutable for one year.
      // Version only our logo URLs; preserve external assets and stored records.
      const hashIndex = item.indexOf('#');
      const hash = hashIndex < 0 ? '' : item.slice(hashIndex);
      const url = hashIndex < 0 ? item : item.slice(0, hashIndex);
      const queryIndex = url.indexOf('?');
      const path = queryIndex < 0 ? url : url.slice(0, queryIndex);
      const query = queryIndex < 0 ? [] : url.slice(queryIndex + 1).split('&').filter(part => part && !/^lkLogoRev=/i.test(part));
      query.push('lkLogoRev=20261112-binary-v1');
      result[key] = path + '?' + query.join('&') + hash;
    } else {
      result[key] = sanitizeTypedCommunityPayload(item, scoped);
    }
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
export function addTypedCommunityResponseRedaction(input, { existingOnly = false } = {}) {
  const flow = structuredClone(input), byId = new Map(flow.map(node => [node.id, node]));
  for (const node of flow) {
    if (node.z === COMMUNITY_AUTH_SUBFLOW || node.type !== 'function' || typeof node.func !== 'string') continue;
    const responsePorts = (node.wires || []).map((group, index) => group.some(id => byId.get(id)?.type === 'http response') ? index : -1).filter(index => index >= 0);
    if (node.func.includes('COMMUNITY_TYPED_RESPONSE_REDACTION')) {
      const prefix = '// COMMUNITY_TYPED_RESPONSE_REDACTION\nconst redact = ', separator = ';\nconst output = (function() {\n';
      const end = node.func.indexOf(separator,prefix.length), suffix = redactionSuffix(responsePorts);
      if (!node.func.startsWith(prefix) || end < 0 || !node.func.endsWith(suffix)) throw new Error('EVENT_REDACTION_WRAPPER_DRIFT');
      const sanitizer = node.func.slice(prefix.length,end);
      if (sanitizer !== sanitizeTypedCommunityPayload.toString() && !['3d043f46996d6b9b691aaa918caee157b0bfca5e5806c23fe55af3d78361b508', "2a36eca2dbdffed8d7044761f4438d4e88ab7893efdb3b7c944b323689cd56d2", "9ca1ae941b8cd7f01c1be2e1bc23c472676c1629e5baf48ea646e68e65aae152", "aec9d94d0b792b78076a0bcb2960e63b330c5cb3384e47ed5c3570ae8e243a5d", "50415cd7b9e6e8b2a2b15c46485e903ffbf9327efc0301dce9dea62fb0025191"].includes(createHash('sha256').update(sanitizer).digest('hex'))) throw new Error('EVENT_REDACTION_SANITIZER_DRIFT');
      node.func = wrapRedacted(node.func.slice(end+separator.length,-suffix.length),responsePorts);
      continue;
    }
    if (existingOnly || !responsePorts.length) continue;
    const communityFunction = /Community|community/.test(node.name || '') || node.func.includes('normalizeCommunityForResponse') || node.func.includes('_communityPlayerRating');
    if (!communityFunction) continue;
    node.func = wrapRedacted(node.func,responsePorts);
  }
  return flow;
}
