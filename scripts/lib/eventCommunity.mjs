import {isDeepStrictEqual} from 'node:util';
import {addCommunityPolicyAuth, COMMUNITY_AUTH_SUBFLOW} from './communityPolicyAuth.mjs';
import { parseEventRegistrationPolicy, eventRetentionUntil } from '../../src/services/community-policy.ts';
import { EVENT_JUMP_ENGINE_VERSION } from '../../src/services/eventJumpContract.ts';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';

// This pure function is also embedded in Node-RED. No data or provider access.
export function eventRegistration(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('EVENT_REGISTRATION_REQUIRED');
  if (Object.keys(value).some(key => !['fullName','company','email','policyRevision'].includes(key))) throw new Error('EVENT_REGISTRATION_INVALID');
  const clean = (key, max) => {
    const raw = typeof value[key] === 'string' ? value[key] : '';
    if ([...raw].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw new Error('EVENT_REGISTRATION_INVALID');
    const s = raw.trim().replace(/\s+/g, ' ');
    if (!s || s.length > max) throw new Error('EVENT_REGISTRATION_INVALID');
    return s;
  };
  const fullName = clean('fullName', 160), company = clean('company', 160), email = clean('email', 254).toLowerCase();
  if (fullName.split(' ').length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('EVENT_REGISTRATION_INVALID');
  return { fullName, company, email };
}

export const EVENT_JOIN_GUARD = `
// EVENT_REGISTRATION_GUARD_V2
if (community.communityType === 'EVENT') {
  const actor = msg._verifiedCommunityActor;
  if (!actor?.id) return [null, null, null, null, withJson(msg, 403, { error: 'COMMUNITY_AUTH_REQUIRED' }), null];
  if (!ctx.viaInvite && toJoinRule(community.joinRule, toVisibility(community.visibility)) === 'INVITE_ONLY') return [null, null, null, null, withJson(msg, 403, {error:'COMMUNITY_INVITE_REQUIRED'}), null];
  if (!community.typeSettingsEffectiveAt || !Number.isSafeInteger(community.typeSettingsRevision) || community.typeSettingsRevision < 1) return [null, null, null, null, withJson(msg, 409, {error:'EVENT_POLICY_NOT_READY'}), null];
  let policy;
  try { policy = (${parseEventRegistrationPolicy.toString()})(community.typeSettings?.registrationPolicy); }
  catch { return [null, null, null, null, withJson(msg, 409, {error:'EVENT_POLICY_NOT_READY'}), null]; }
  if (Date.now() >= Date.parse(policy.endsAt)) return [null, null, null, null, withJson(msg, 409, {error:'EVENT_CLOSED'}), null];
  const notice = {policy, revision: community.typeSettingsRevision};
  // Public identities come from the verified profile, never from the private form.
  member.id = actor.id; member.name = actor.name || 'Игрок'; member.phone = actor.phone || null;
  const entries = toArray(community.eventEntries);
  const epoch = community.typeSettingsEffectiveAt;
  const entry = entries.find(item => item.playerId === actor.id && item.epoch === epoch);
  const banned = toArray(community.bannedMembers).some(item => item.id === actor.id || (actor.phone && normPhone(item.phone || item.phoneNorm) === normPhone(actor.phone)));
  if (banned) return [null, null, null, null, withJson(msg, 403, { error: 'COMMUNITY_ACCESS_DENIED' }), null];
  if (!entry || entry.policyRevision !== community.typeSettingsRevision || entry.policyVersion !== policy.version) {
    if (entries.length >= 500 && !entries.some(item => item.playerId === actor.id)) return [null, null, null, null, withJson(msg, 409, { error: 'EVENT_REGISTRATION_LIMIT' }), null];
    if (ctx.eventRegistration?.policyRevision !== community.typeSettingsRevision) return [null, null, null, null, withJson(msg, 422, {error:'EVENT_REGISTRATION_REQUIRED', eventNotice: notice}), null];
    try { msg._eventEntry = Object.assign({ playerId: actor.id, epoch, registeredAt: nowIso, policyRevision: community.typeSettingsRevision, policyVersion: policy.version, retentionUntil: (${eventRetentionUntil.toString()})(policy.endsAt) }, (${eventRegistration.toString()})(ctx.eventRegistration)); }
    catch (error) { return [null, null, null, null, withJson(msg, 422, { error: error.message, communityId: community.id, eventNotice: notice }), null]; }
  }
}
`;

export function addEventRegistration(input) {
  const flow = structuredClone(input);
  for (const node of flow) {
    if (node.type !== 'function') continue;
    if (['Prepare community join', 'Prepare invite join'].includes(node.name) && !node.func.includes('eventRegistration: body.eventRegistration')) {
      const anchor = 'msg._communityJoin = {';
      if (node.func.split(anchor).length !== 2) throw new Error('EVENT_JOIN_PREPARE_DRIFT');
      node.func = node.func.replace(anchor, anchor + '\n  eventRegistration: body.eventRegistration,');
    }
    if (['Prepare community join', 'Prepare invite join', 'Build member games query', 'Build invited member games query'].includes(node.name)) node.func = node.func.replaceAll('return [msg, null, msg];', 'return [msg, null, null];');
    if (['Apply community join', 'Apply invite join'].includes(node.name) && !node.func.includes('EVENT_REGISTRATION_GUARD_V2')) {
      const anchor = 'const memberStats = buildMemberGameStats(memberGames, member);';
      if (node.func.split(anchor).length !== 2) throw new Error('EVENT_JOIN_APPLY_DRIFT');
      if (node.func.includes('EVENT_REGISTRATION_GUARD_V1')) {
        const begin = node.func.indexOf('// EVENT_REGISTRATION_GUARD_V1');
        const end = node.func.indexOf(anchor, begin);
        if (begin < 0 || end < 0 || createHash('sha256').update(node.func.slice(begin,end).trim()).digest('hex') !== '267d963acec70c2c7ce98321e1ac763c33c190c4fac89e76567f6068ec6ac096') throw new Error('EVENT_JOIN_UPGRADE_DRIFT');
        node.func = node.func.slice(0, begin) + EVENT_JOIN_GUARD + '\n' + node.func.slice(end);
      } else node.func = node.func.replace(anchor, EVENT_JOIN_GUARD + '\n' + anchor);
    }
  }
  return flow;
}

function engineSource() {
  const digest = createHash('sha256').update(fs.readFileSync(fileURLToPath(new URL('../../src/components/padel-jump/campaign.ts', import.meta.url)))).update(fs.readFileSync(fileURLToPath(new URL('../../src/components/padel-jump/engine.ts', import.meta.url)))).digest('hex');
  if (digest !== EVENT_JUMP_ENGINE_VERSION) throw new Error('EVENT_ENGINE_VERSION_DRIFT');
  return ['campaign.ts', 'engine.ts'].map(name => stripTypeScriptTypes(fs.readFileSync(fileURLToPath(new URL('../../src/components/padel-jump/' + name, import.meta.url)), 'utf8'))
    .replace(/^import .*;\s*$/gm, '').replace(/^export /gm, '')).join('\n');
}
export const EVENT_GAME_PREPARE = String.raw`
const actor = msg._verifiedCommunityActor;
const id = String(msg.req?.params?.communityId || '');
if (!actor?.id || !/^[a-zA-Z0-9_-]{1,120}$/.test(id)) {
  msg.statusCode = 403; msg.payload = { error: 'COMMUNITY_AUTH_REQUIRED' }; return [null, msg];
}
const action = String(msg.req?.params?.action || 'ranking');
if (!['start', 'finish', 'ranking'].includes(action)) { msg.statusCode = 404; msg.payload = { error: 'EVENT_ACTION_NOT_FOUND' }; return [null, msg]; }
msg._eventGame = { actor, action, body: msg.payload || {}, id };
msg.payload = { id, communityType: 'EVENT', archived: { $ne: true } }; return [msg, null];
`;
export function eventGameApplySource() {
  return 'const EVENT_JUMP_ENGINE_VERSION = '+JSON.stringify(EVENT_JUMP_ENGINE_VERSION)+';\n' + engineSource() + '\n' + parseEventRegistrationPolicy.toString() + '\n' + eventRetentionUntil.toString() + '\n' + String.raw`
const ctx = msg._eventGame, community = Array.isArray(msg.payload) ? msg.payload[0] : msg.payload;
const reply = (status, payload) => Object.assign({}, msg, { statusCode: status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' }, payload });
if (!community || community.communityType !== 'EVENT' || community.archived === true) return [null, reply(404, { error: 'COMMUNITY_NOT_FOUND' })];
if (!Number.isSafeInteger(community.typeSettingsRevision) || community.typeSettingsRevision < 1) return [null, reply(409, {error:'EVENT_POLICY_NOT_READY'})];
let policy;
try { policy = parseEventRegistrationPolicy(community.typeSettings?.registrationPolicy); }
catch { return [null, reply(409, {error:'EVENT_POLICY_NOT_READY'})]; }
const policyNow = Date.now();
if (policyNow >= Date.parse(eventRetentionUntil(policy.endsAt))) return [null, reply(410, {error:'EVENT_DATA_EXPIRED'})];
if (ctx.action !== 'ranking' && (policyNow < Date.parse(policy.startsAt) || policyNow >= Date.parse(policy.endsAt))) return [null, reply(409, {error:'EVENT_CLOSED'})];
const rows = key => Array.isArray(community[key]) ? community[key] : [];
const actor = ctx.actor, member = rows('members').find(item => item.id === actor.id);
const norm = phone => String(phone || '').replace(/\D/g, '').replace(/^8(?=\d{10}$)/, '7');
if (!member || (member.status && member.status !== 'ACTIVE') || rows('bannedMembers').some(item => item.id === actor.id || (actor.phone && norm(item.phone || item.phoneNorm) === norm(actor.phone)))) return [null, reply(403, { error: 'COMMUNITY_ACCESS_DENIED' })];
if (community.eventRosterRevision !== undefined && (!Number.isSafeInteger(community.eventRosterRevision) || community.eventRosterRevision < 0 || community.eventRosterRevision >= Number.MAX_SAFE_INTEGER)) return [null, reply(409, {error:'EVENT_ROSTER_REVISION_INVALID'})];
if (community.eventEntriesRevision !== undefined && (!Number.isSafeInteger(community.eventEntriesRevision) || community.eventEntriesRevision < 0 || community.eventEntriesRevision >= Number.MAX_SAFE_INTEGER)) return [null, reply(409, {error:'EVENT_REVISION_INVALID'})];
const entries = rows('eventEntries').map(item => Object.assign({}, item)), index = entries.findIndex(item => item.playerId === actor.id && item.epoch === community.typeSettingsEffectiveAt && item.policyRevision === community.typeSettingsRevision && item.policyVersion === policy.version);
if (index < 0) return [null, reply(422, { error: 'EVENT_REGISTRATION_REQUIRED' })];
if (!Array.isArray(community.typeSettings?.gameIds) || !community.typeSettings.gameIds.includes('padel-jump')) return [null, reply(409, { error: 'EVENT_GAME_DISABLED' })];
if (ctx.action === 'ranking') {
  const eligible = new Map(rows('members').filter(item => (!item.status || item.status === 'ACTIVE') && !rows('bannedMembers').some(ban => ban.id === item.id || (item.phone && norm(ban.phone || ban.phoneNorm) === norm(item.phone)))).map(item => [item.id, item]));
  const ranking = entries.filter(item => item.epoch === community.typeSettingsEffectiveAt && item.policyRevision === community.typeSettingsRevision && item.policyVersion === policy.version && eligible.has(item.playerId) && item.bestRun?.engineVersion === EVENT_JUMP_ENGINE_VERSION && Number.isSafeInteger(item.bestScore)).map(item => ({ playerId: item.playerId, name: eligible.get(item.playerId).name || 'Игрок', score: item.bestScore, achievedAt: item.bestAt }))
    .sort((a,b) => b.score - a.score || String(a.achievedAt).localeCompare(String(b.achievedAt)) || a.playerId.localeCompare(b.playerId)).map((item,i) => Object.assign({ rank: i + 1 }, item));
  return [null, reply(200, { communityId: community.id, rows: ranking.map(({rank,name,score}) => ({rank,name,score})) })];
}
const body = ctx.body;
if (body.engineVersion !== EVENT_JUMP_ENGINE_VERSION) return [null, reply(409, {error:'EVENT_ENGINE_CHANGED'})];
const requestId = String(msg.req?.headers?.['idempotency-key'] || '');
if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(requestId)) return [null, reply(400, { error: 'IDEMPOTENCY_KEY_REQUIRED' })];
const now = Date.now();
const rateKey = community.id + ':' + actor.id;
const rates = context.get('eventRate') || {};
for (const key of Object.keys(rates)) if (now - rates[key].at > 60000) delete rates[key];
if (Object.keys(rates).length >= 1000 && !rates[rateKey]) return [null, reply(429, {error:'EVENT_RATE_LIMIT'})];
const rate = rates[rateKey] || {at: now, count: 0};
if (++rate.count > 30) return [null, reply(429, {error:'EVENT_RATE_LIMIT'})];
rates[rateKey] = rate; context.set('eventRate', rates);
const entry = entries[index]; let result;
const existingRun = entry.run;
if (ctx.action === 'start') {
  if (existingRun?.requestId === requestId) return [null, reply(200, { runId: existingRun.id, seed: existingRun.seed, engineVersion: existingRun.engineVersion, startedAt: existingRun.startedAt, completed: !!existingRun.completedAt })];
  if (existingRun && !existingRun.completedAt && existingRun.revision === community.typeSettingsRevision && existingRun.engineVersion === EVENT_JUMP_ENGINE_VERSION && now - Date.parse(existingRun.startedAt) < 30 * 60000) return [null, reply(200, { runId: existingRun.id, seed: existingRun.seed, engineVersion: existingRun.engineVersion, startedAt: existingRun.startedAt, completed: false })];
  const run = { id: crypto.randomUUID(), requestId, seed: crypto.randomBytes(4).readUInt32LE(0), revision: community.typeSettingsRevision, engineVersion: EVENT_JUMP_ENGINE_VERSION, gameId: 'padel-jump', startedAt: new Date(now).toISOString() };
  entries[index] = Object.assign({}, entry, { run });
  result = { runId: run.id, seed: run.seed, engineVersion: run.engineVersion, startedAt: run.startedAt, completed: false };
} else {
  if (!existingRun || existingRun.id !== body.runId || existingRun.revision !== community.typeSettingsRevision || existingRun.gameId !== 'padel-jump' || existingRun.engineVersion !== EVENT_JUMP_ENGINE_VERSION) return [null, reply(409, { error: 'EVENT_RUN_CHANGED' })];
  if (existingRun.completedAt) return [null, reply(200, { score: existingRun.score, bestScore: entry.bestScore })];
  const age = now - Date.parse(existingRun.startedAt);
  if (!Number.isFinite(age) || age < 0 || age > 30 * 60000) return [null, reply(409, { error: 'EVENT_RUN_EXPIRED' })];
  if (!Array.isArray(body.inputs) || !body.inputs.length || body.inputs.length > 12000 || JSON.stringify(body.inputs).length > 150000) return [null, reply(400, { error: 'EVENT_REPLAY_INVALID' })];
  let ticks = 0;
  for (const row of body.inputs) {
    if (!Array.isArray(row) || row.length !== 2 || !Number.isInteger(row[0]) || Math.abs(row[0]) > 100 || !Number.isInteger(row[1]) || row[1] < 1 || row[1] > 36000) return [null, reply(400, { error: 'EVENT_REPLAY_INVALID' })];
    ticks += row[1]; if (ticks > 36000) return [null, reply(400, { error: 'EVENT_REPLAY_LIMIT' })];
  }
  if (ticks * FIXED_STEP * 1000 > age + 1000) return [null, reply(400, { error: 'EVENT_REPLAY_TOO_FAST' })];
  const budget = context.get('eventReplayBudget') || {at: now, count: 0};
  if (now - budget.at > 1000) { budget.at = now; budget.count = 0; }
  if (++budget.count > 10) return [null, reply(429, {error:'EVENT_RATE_LIMIT'})];
  context.set('eventReplayBudget', budget);
  const replayDeadline = Date.now() + 50;
  const game = createGame(existingRun.seed); game.mode = 'running'; let processed = 0;
  for (const [direction, count] of body.inputs) for (let i = 0; i < count; i++) {
    if (game.mode !== 'running') return [null, reply(400, { error: 'EVENT_REPLAY_AFTER_END' })];
    if (processed % 256 === 0 && Date.now() > replayDeadline) return [null, reply(503, {error:'EVENT_REPLAY_BUDGET'})];
    stepGame(game, direction / 100); processed++;
  }
  if (game.mode !== 'over' && processed !== 36000) return [null, reply(400, { error: 'EVENT_REPLAY_INCOMPLETE' })];
  const completedAt = new Date(now).toISOString(), improved = entry.bestRun?.engineVersion !== EVENT_JUMP_ENGINE_VERSION || entry.bestScore === undefined || game.score > entry.bestScore;
  entries[index] = Object.assign({}, entry, { run: Object.assign({}, existingRun, { completedAt, score: game.score, finishRequestId: requestId, ticks: processed }), ...(improved ? { bestScore: game.score, bestAt: completedAt, bestRun: {id:existingRun.id, score:game.score, completedAt, ticks:processed, revision:existingRun.revision, gameId:existingRun.gameId, engineVersion:existingRun.engineVersion} } : {}) });
  result = { score: game.score, bestScore: entries[index].bestScore };
}
const pre = key => Object.prototype.hasOwnProperty.call(community,key) ? community[key] : { $exists: false };
msg.query = { id: community.id, communityType: 'EVENT', archived: { $ne: true }, typeSettingsRevision: pre('typeSettingsRevision'), eventRosterRevision: pre('eventRosterRevision'), eventEntriesRevision: pre('eventEntriesRevision') };
msg.payload = [msg.query, { $set: { eventEntries: entries, eventEntriesRevision: (Number(community.eventEntriesRevision) || 0) + 1 } }, {upsert:false}]; delete msg.query; msg._eventReply = result;
delete msg._eventGame;
return [msg, null];
`;
}
export const EVENT_GAME_ACK = String.raw`
const ok = msg.payload?.acknowledged === true && msg.payload.matchedCount === 1 && msg.payload.modifiedCount === 1;
msg.statusCode = ok ? 200 : 409; msg.headers = { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' };
msg.payload = ok ? msg._eventReply : { error: 'COMMUNITY_MEMBERS_CHANGED' };
delete msg._eventReply; return msg;
`;

export function addEventGameRoutes(input) {
  const flow = structuredClone(input), prefix = 'community-event-game-v1';
  if (flow.some(n => n.id === prefix + '-prepare')) {
    // Recreate only expected shapes in memory. Foreign runtime edits are never overwritten.
    const isManaged = n => n.id.startsWith(prefix) || n.id.startsWith(COMMUNITY_AUTH_SUBFLOW + '-entry-' + prefix);
    const expected = addCommunityPolicyAuth(addEventGameRoutes(flow.filter(n => !isManaged(n)))).filter(isManaged);
    const actual = flow.filter(isManaged);
    if (actual.length !== expected.length) throw new Error('EVENT_GENERATED_GRAPH_DRIFT');
    for (const wanted of expected) {
      const existing = actual.find(n => n.id === wanted.id);
      const comparable = structuredClone(wanted);
      if (wanted.id === prefix + '-apply' || wanted.id === prefix + '-ack') comparable.func = existing?.func;
      if (!isDeepStrictEqual(existing,comparable)) throw new Error('EVENT_GENERATED_GRAPH_DRIFT');
    }

    const apply = flow.find(n => n.id === prefix + '-apply');
    if (!apply || apply.type !== 'function') throw new Error('EVENT_GAME_UPGRADE_DRIFT');
    const wrapperPrefix = 'const output = (function() {\n', suffix = '\n}).call(this);';
    const start = apply.func.includes('// COMMUNITY_TYPED_RESPONSE_REDACTION') ? apply.func.indexOf(wrapperPrefix) + wrapperPrefix.length : 0;
    const end = start ? apply.func.lastIndexOf(suffix) : apply.func.length;
    const raw = apply.func.slice(start,end), next = eventGameApplySource();
    if (raw !== next && createHash('sha256').update(raw).digest('hex') !== '67226720a4fb18a7affb6651b18e64f905aa9d099d4f1328060794f1aea45928') throw new Error('EVENT_GAME_UPGRADE_DRIFT');
    apply.func = apply.func.slice(0,start) + next + apply.func.slice(end);
    const ack = flow.find(n => n.id === prefix + '-ack');
    if (!ack || ack.type !== 'function' || (ack.func.trim() !== EVENT_GAME_ACK.trim() && createHash('sha256').update(ack.func.trim()).digest('hex') !== '2995c54bfb2dbe9a17221f4b6cadc632502d5f4c2d94b635c506638c393f621e')) throw new Error('EVENT_GAME_ACK_UPGRADE_DRIFT');
    ack.func = EVENT_GAME_ACK;
    return flow;
  }
  const template = flow.find(n => n.type === 'mongodb4' && n.collection === 'lk_communities' && ['find','findOne'].includes(n.operation));
  const writeTemplate = flow.find(n => n.type === 'mongodb4' && n.collection === 'lk_communities' && n.operation === 'updateOne');
  if (!template || !writeTemplate) throw new Error('EVENT_MONGODB4_TEMPLATES_REQUIRED');
  const z = template.z, node = (suffix, type, extra) => ({ id: prefix + suffix, type, z, ...extra });
  const response = prefix + '-response';
  flow.push(
    node('-in', 'http in', { name: 'Event game command', url: '/lk/communities/:communityId/event-game/:action', method: 'post', wires: [[prefix + '-prepare']] }),
    node('-ranking-in', 'http in', { name: 'Event game ranking', url: '/lk/communities/:communityId/event-game/ranking', method: 'get', wires: [[prefix + '-prepare']] }),
    node('-prepare', 'function', { name: 'Prepare event game', func: EVENT_GAME_PREPARE, outputs: 2, wires: [[prefix + '-find'], [response]] }),
    { ...structuredClone(template), id: prefix + '-find', name: 'Find event community', operation: 'find', wires: [[prefix + '-apply']] },
    node('-apply', 'function', { name: 'Apply event game', func: eventGameApplySource(), libs: [{var: 'crypto', module: 'crypto'}], outputs: 2, wires: [[prefix + '-write'], [response]] }),
    { ...structuredClone(writeTemplate), id: prefix + '-write', name: 'Commit event game', operation: 'updateOne', wires: [[prefix + '-ack']] },
    node('-ack', 'function', { name: 'Confirm event game commit', func: EVENT_GAME_ACK, outputs: 1, wires: [[response]] }),
    node('-catch', 'catch', { name: 'Event game database failure', scope: [prefix + '-prepare', prefix + '-find', prefix + '-apply', prefix + '-write', prefix + '-ack'], uncaught: false, wires: [[prefix + '-error']] }),
    node('-error', 'function', { name: 'Event game unavailable', func: "msg.statusCode = 503; msg.headers = {'Cache-Control':'no-store'}; msg.payload = {error:'EVENT_GAME_UNAVAILABLE'}; return msg;", outputs: 1, wires: [[response]] }),
    node('-response', 'http response', { name: 'Event game response', wires: [] }),
  );
  return flow;
}
