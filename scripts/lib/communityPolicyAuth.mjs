import {isDeepStrictEqual} from 'node:util';
// Source-only optional Viva-profile authentication subflow. Guest reads retain
// the legacy FRIENDS contract; typed private reads and typed writes require it.
export const COMMUNITY_AUTH_SUBFLOW = 'community-policy-verified-actor-v1';
export const COMMUNITY_AUTH_PREPARE = String.raw`
delete msg._verifiedCommunityActor;
const header = String(msg.req?.headers?.authorization || '').trim();
if (!header) return [null, msg];
if (!/^Bearer[ \t]+[^ \t]+$/i.test(header)) {
  msg.statusCode = 401; msg.payload = { error: 'AUTH_TOKEN_INVALID' }; return [null, null, msg];
}
msg._communityPolicyAuth = { payload: msg.payload, method: msg.method, url: msg.url, headers: msg.headers };
msg.method = 'GET'; msg.url = 'https://api.vivacrm.ru/end-user/api/v1/iSkq6G/profile';
msg.headers = { Authorization: header, Accept: 'application/json' }; msg.payload = undefined;
return [msg, null, null];
`;
export const COMMUNITY_AUTH_RESPONSE = String.raw`
const status = Number(msg.statusCode), profile = msg.payload, saved = msg._communityPolicyAuth;
delete msg._communityPolicyAuth;
if (!saved || !(status >= 200 && status < 300) || !profile || typeof profile !== 'object' || Array.isArray(profile)) {
  msg.headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  msg.statusCode = status === 401 || status === 403 ? 401 : 503;
  msg.payload = { error: msg.statusCode === 401 ? 'AUTH_TOKEN_INVALID' : 'AUTH_SERVICE_UNAVAILABLE' }; return [null, msg];
}
const id = String(profile.id || profile.clientId || profile.uuid || '').trim();
if (!id) { msg.statusCode = 403; msg.headers = {}; msg.payload = { error: 'PROFILE_ID_MISSING' }; return [null, msg]; }
const actor = { id, phone: profile.phone || null, name: profile.name || profile.displayName || [profile.firstName, profile.lastName].filter(Boolean).join(' ') || 'Игрок', avatar: profile.photo || profile.avatar || null };
msg._verifiedCommunityActor = actor;
if (msg.req?.query) Object.assign(msg.req.query, { clientId: id, phone: actor.phone, phoneNumber: '', mobile: '' });
const body = saved.payload;
if (body && typeof body === 'object' && !Array.isArray(body)) {
  const management = /\/members\/manage(?:\?|$)/.test(String(msg.req?.originalUrl || msg.req?.url || ''));
  if (management || body.actor) body.actor = Object.assign({}, body.actor || {}, actor);
  if (!management && body.member) body.member = Object.assign({}, body.member, actor);
  for (const key of ['user', 'manager', 'creator', 'owner']) if (body[key]) body[key] = Object.assign({}, body[key], actor);
}
msg.payload = body; msg.headers = saved.headers || {}; msg.method = saved.method; msg.url = saved.url; delete msg.statusCode;
return [msg, null];
`;

export const COMMUNITY_PLAYER_RATING_ACCESS = String.raw`
// COMMUNITY_TYPED_PLAYER_RATING_ACCESS
if (['STATION','CORPORATE','LEAGUE','EVENT'].includes(community.communityType) && String(community.visibility || '').toUpperCase() === 'CLOSED') {
  const actorId = toTrimmed(msg._verifiedCommunityActor?.id);
  if (!actorId || !toRows(community.members).some(row => exactMemberIds(row).includes(actorId))) return [null, jsonError(403, 'COMMUNITY_ACCESS_DENIED')];
}
`;

export function addCommunityPolicyAuth(input) {
  const flow = structuredClone(input), byId = new Map(flow.map(node => [node.id, node]));
  const id = COMMUNITY_AUTH_SUBFLOW;
  const definitions = [
    { id, type: 'subflow', name: 'Community verified actor', in: [{ x: 40, y: 80, wires: [{ id: id + '-prepare' }] }], out: [{ x: 650, y: 80, wires: [{ id: id + '-prepare', port: 1 }, { id: id + '-response', port: 0 }] }] },
    { id: id + '-prepare', type: 'function', z: id, name: 'Verify optional community Bearer', func: COMMUNITY_AUTH_PREPARE, outputs: 3, wires: [[id + '-http'], [], [id + '-error']] },
    { id: id + '-http', type: 'http request', z: id, name: 'Community actor Viva profile', method: 'use', ret: 'obj', paytoqs: 'ignore', url: '', requestTimeout: '10000', persist: false, senderr: true, wires: [[id + '-response']] },
    { id: id + '-response', type: 'function', z: id, name: 'Bind community actor to verified profile', func: COMMUNITY_AUTH_RESPONSE, outputs: 2, wires: [[], [id + '-error']] },
    { id: id + '-error', type: 'http response', z: id, name: 'Community auth failure', statusCode: '', headers: {}, wires: [] },
  ];
  const instances = [];
  for (const node of flow) {
    if (node.type !== 'http in' || !/^\/(?:lk\/)?communities(?:\/|$)/.test(node.url || '') || /\/public(?:\/|$)/.test(node.url)) continue;
    const instanceId = id + '-entry-' + node.id;
    if (byId.has(instanceId)) {
      const instance = byId.get(instanceId);
      if (instance.type !== 'subflow:' + id || instance.z !== node.z || instance.d === true || !Array.isArray(instance.wires) || instance.wires.length !== 1 || !Array.isArray(instance.wires[0]) || instance.wires[0].length !== 1 || instance.wires[0].some(target => !byId.has(target))) throw new Error('COMMUNITY_AUTH_INSTANCE_DRIFT');
      const expectedPrepare = /\/add-member$/.test(node.url) ? 'Prepare community join' : /\/join-by-invite$/.test(node.url) ? 'Prepare invite join' : null;
      if (expectedPrepare && (byId.get(instance.wires[0][0])?.type !== 'function' || byId.get(instance.wires[0][0])?.name !== expectedPrepare)) throw new Error('COMMUNITY_AUTH_JOIN_TARGET_DRIFT');
      if (node.wires?.[0]?.length !== 1 || node.wires?.[0]?.[0] !== instanceId) throw new Error('COMMUNITY_AUTH_INGRESS_DRIFT');
      continue;
    }
    if (node.wires?.length !== 1 || node.wires[0]?.length !== 1 || !byId.has(node.wires[0][0])) throw new Error('COMMUNITY_AUTH_INGRESS_TARGET_DRIFT');
    const expectedPrepare = /\/add-member$/.test(node.url) ? 'Prepare community join' : /\/join-by-invite$/.test(node.url) ? 'Prepare invite join' : null;
    if (expectedPrepare && (byId.get(node.wires[0][0])?.type !== 'function' || byId.get(node.wires[0][0])?.name !== expectedPrepare)) throw new Error('COMMUNITY_AUTH_JOIN_TARGET_DRIFT');
    instances.push({ id: instanceId, type: 'subflow:' + id, z: node.z, name: 'Verify community caller', wires: structuredClone(node.wires), x: (node.x || 0) + 100, y: node.y || 0 });
    node.wires = [[instanceId]];
  }
  if (instances.length && !byId.has(id)) flow.push(...definitions);
  for (const expected of definitions) {
    const existing = byId.get(expected.id);
    if (existing && !isDeepStrictEqual(existing,expected)) throw new Error('COMMUNITY_AUTH_SUBFLOW_DRIFT');
  }
  flow.push(...instances);
  const allNodes = new Map(flow.map(node => [node.id, node]));
  for (const node of flow) {
    if (node.type !== 'function' || typeof node.func !== 'string') continue;
    if (node.func.includes('const snapshotPlayerId = exactMemberIds(member)[0] || ctx.playerId;') && !node.func.includes('COMMUNITY_TYPED_PLAYER_RATING_ACCESS')) {
      const anchor = "if (!community) return [null, jsonError(404, 'COMMUNITY_NOT_FOUND')];";
      if (!node.func.includes(anchor)) throw new Error('COMMUNITY_PLAYER_RATING_ACCESS_SHAPE_DRIFT');
      node.func = node.func.replace(anchor, anchor + '\n' + COMMUNITY_PLAYER_RATING_ACCESS);
    }
    if (node.func.includes('// COMMUNITY_TYPED_ACCESS_GUARD')) continue;
    if (node.func.includes('const sameMemberIdentity =') && !node.func.includes('COMMUNITY_TYPED_IDENTITY')) {
      node.func = node.func.replace('  const b = buildMember(right);', "  const b = buildMember(right);\n  // COMMUNITY_TYPED_IDENTITY\n  if (msg._typedCommunity) return Boolean(a.id && b.id && a.id === b.id);");
      node.func = node.func.replace('  const safePhone = normPhone(phone);', "  const safePhone = msg._typedCommunity ? null : normPhone(phone);");
      node.func = node.func.replace('const resolveCommunityViewerMembership = (community, clientId, phone) => {', "const resolveCommunityViewerMembership = (community, clientId, phone) => {\n  if (['STATION','CORPORATE','LEAGUE','EVENT'].includes(community?.communityType)) { clientId = msg._verifiedCommunityActor?.id || null; phone = null; }");
      // A phone is never an access grant; it can still enforce a legacy ban.
      node.func = node.func.replace('const isBanned = bannedMembers.some((item) => sameMemberIdentity(item, member));', "const isBanned = bannedMembers.some((item) => sameMemberIdentity(item, member) || (member.phone && normPhone(item.phone || item.phoneNorm) === member.phone));");
    }
    const target = node.func.includes('const sourceCommunity = rows[0];') ? 'sourceCommunity' : node.func.includes('const community = rows[0];') ? 'community' : null;
    if (!target || !node.func.includes('const normalizeCommunityForResponse =')) continue;
    const responseIndex = (node.wires || []).findIndex(group => group.some(targetId => allNodes.get(targetId)?.type === 'http response'));
    if (responseIndex < 0) throw new Error('COMMUNITY_AUTH_RESPONSE_WIRE_NOT_PROVEN: ' + node.id);
    const outputs = Number(node.outputs) || node.wires.length;
    const guard = `\n// COMMUNITY_TYPED_ACCESS_GUARD\nmsg._typedCommunity = ['STATION','CORPORATE','LEAGUE','EVENT'].includes(${target}?.communityType);\nif (msg._typedCommunity && !msg._verifiedCommunityActor && (String(msg.req?.method || 'GET').toUpperCase() !== 'GET' || String(${target}?.visibility || '').toUpperCase() === 'CLOSED')) {\n  const denied = withJson(msg, 403, { error: 'COMMUNITY_AUTH_REQUIRED' });\n  const deniedOutputs = Array(${outputs}).fill(null); deniedOutputs[${responseIndex}] = denied; return deniedOutputs;\n}\nif (msg._typedCommunity && String(msg.req?.method || 'GET').toUpperCase() !== 'GET') msg._communityPolicyPreimage = ${target};\n`;
    node.func = node.func.replace('const ' + target + ' = rows[0];', 'const ' + target + ' = rows[0];' + guard);
  }
  return flow;
}
