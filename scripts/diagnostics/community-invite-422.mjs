import { createHash } from 'node:crypto';

export const COMMUNITY_INVITE_422_SOURCE_SHA256 =
  'f725d598092b5c15b89fa81cbab81c6ea3d564b566538a0c004bc5eb3d4c3819';
const route = '/lk/communities/join-by-invite';
const sha = source => createHash('sha256').update(source).digest('hex');

// Only allowlisted constants and booleans enter the sink. Never pass msg/error.
function diagnostic(branch, reason, facts = '') {
  return `try { node.warn(JSON.stringify({ code: 'COMMUNITY_INVITE_JOIN_422', route: '${route}', httpStatus: 422, branch: '${branch}', reason: ${reason}${facts} })); } catch { /* Logging cannot change the rejection. */ }`;
}

// The caller pins the source. Separate splice permits synthetic-only unit tests.
export function instrumentCommunityInvite422(source) {
  if (typeof source !== 'string' || source.includes('COMMUNITY_INVITE_JOIN_422')) {
    throw Error('COMMUNITY_INVITE_DIAGNOSTIC_SOURCE_DRIFT');
  }
  const required = "return [null, null, null, null, withJson(msg, 422, {error:'EVENT_REGISTRATION_REQUIRED', eventNotice: notice}), null];";
  const invalid = "return [null, null, null, null, withJson(msg, 422, { error: error.message, communityId: community.id, eventNotice: notice }), null];";
  if (source.split(required).length !== 2 || source.split(invalid).length !== 2) {
    throw Error('COMMUNITY_INVITE_DIAGNOSTIC_SOURCE_DRIFT');
  }
  const facts = ", registrationPresent: ctx.eventRegistration !== undefined && ctx.eventRegistration !== null, revisionMatches: ctx.eventRegistration?.policyRevision === community.typeSettingsRevision, retentionMatches: !perpetual || ctx.eventRegistration?.retentionMode === 'submitted-year-v1'";
  const candidate = source
    .replace(required, `{ ${diagnostic('registration_challenge', "'EVENT_REGISTRATION_REQUIRED'", facts)} ${required} }`)
    .replace(invalid, `{ ${diagnostic('registration_validation', "error.message === 'EVENT_REGISTRATION_REQUIRED' ? 'EVENT_REGISTRATION_REQUIRED' : error.message === 'EVENT_REGISTRATION_INVALID' ? 'EVENT_REGISTRATION_INVALID' : 'UNKNOWN'")} ${invalid} }`);
  try { new Function('msg', 'node', candidate); }
  catch { throw Error('COMMUNITY_INVITE_DIAGNOSTIC_SYNTAX_INVALID'); }
  return candidate;
}

// Pure, in-memory candidate builder. No filesystem, context, network or deploy.
export function patchCommunityInvite422Flow(flow) {
  if (!Array.isArray(flow) || flow.some(n => !n || typeof n.id !== 'string' || !n.id)
    || new Set(flow.map(n => n.id)).size !== flow.length) {
    throw Error('COMMUNITY_INVITE_DIAGNOSTIC_FLOW_INVALID');
  }
  const byId = new Map(flow.map(n => [n.id, n]));
  const enabled = n => n.d !== true && n.disabled !== true
    && byId.get(n.z)?.type === 'tab' && byId.get(n.z).disabled !== true;
  const roots = flow.filter(n => n.type === 'http in' && n.url === route
    && String(n.method).toLowerCase() === 'post' && enabled(n));
  if (roots.length !== 1) throw Error('COMMUNITY_INVITE_DIAGNOSTIC_ROUTE_DRIFT');
  const root = roots[0], visited = new Set(), todo = [root.id];
  while (todo.length) {
    const id = todo.pop();
    if (visited.has(id)) continue;
    const n = byId.get(id);
    if (!n || n.z !== root.z || !enabled(n) || !Array.isArray(n.wires)
      || n.wires.some(port => !Array.isArray(port))) throw Error('COMMUNITY_INVITE_DIAGNOSTIC_GRAPH_DRIFT');
    visited.add(id);
    todo.push(...n.wires.flat());
  }
  const targets = flow.filter(n => visited.has(n.id) && n.type === 'function' && n.name === 'Apply invite join');
  const target = targets[0];
  if (targets.length !== 1 || target.outputs !== 6 || target.wires.length !== 6
    || target.wires[4].length !== 1 || byId.get(target.wires[4][0])?.type !== 'http response'
    || typeof target.func !== 'string' || sha(target.func) !== COMMUNITY_INVITE_422_SOURCE_SHA256) {
    throw Error('COMMUNITY_INVITE_DIAGNOSTIC_SOURCE_DRIFT');
  }
  // A different ingress sharing this function would make the fixed route false.
  // Reject shared, linked or cross-tab ancestry instead of guessing its scope.
  const parents = new Map();
  for (const n of flow.filter(enabled)) {
    const destinations = [...(n.wires || []).flat(), ...(n.type === 'link out' ? n.links || [] : [])];
    for (const id of destinations) parents.set(id, [...(parents.get(id) || []), n]);
  }
  const ancestors = new Set(), pending = [target];
  while (pending.length) {
    const n = pending.pop();
    if (ancestors.has(n.id)) continue;
    ancestors.add(n.id);
    const incoming = parents.get(n.id) || [];
    if (n.z !== root.z || n.type.startsWith('link ')
      || (n.type === 'http in' && n.id !== root.id)
      || (n.type === 'function' && typeof n.initialize === 'string' && n.initialize.trim() !== '')
      || (incoming.length === 0 && n.id !== root.id
        && !['mongodb4', 'mongodb in', 'mongodb out'].includes(n.type))) {
      throw Error('COMMUNITY_INVITE_DIAGNOSTIC_INGRESS_DRIFT');
    }
    pending.push(...incoming);
  }
  const candidate = structuredClone(flow);
  const patched = candidate.find(n => n.id === target.id);
  patched.func = instrumentCommunityInvite422(target.func);
  return { candidate, beforeFunctionSha256: sha(target.func), afterFunctionSha256: sha(patched.func),
    changedNodeCount: 1, changedFieldCount: 1, addedNodeCount: 0, topologyUnchanged: true };
}
