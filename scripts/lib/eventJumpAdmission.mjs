import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { parseEventRegistrationPolicy, eventRetentionUntil } from '../../src/services/community-policy.ts';
import { COMMUNITY_AUTH_SUBFLOW } from './communityPolicyAuth.mjs';

/** Own verified admission only. Never return private questionnaires or another actor's state. */
export function eventJumpAdmission(community, actor, now) {
  if (!actor || typeof actor.id !== 'string' || !actor.id || actor.id.length > 120 || /[\p{C}]/u.test(actor.id)) throw new Error('COMMUNITY_AUTH_REQUIRED');
  if (!community || community.communityType !== 'EVENT' || community.archived === true) throw new Error('COMMUNITY_NOT_FOUND');
  const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
  if (!iso(now) || !iso(community.typeSettingsEffectiveAt) || !Number.isSafeInteger(community.typeSettingsRevision) || community.typeSettingsRevision < 1 ||
      !Array.isArray(community.members) || ['pendingMembers', 'bannedMembers', 'eventEntries'].some(key => community[key] !== undefined && !Array.isArray(community[key]))) throw new Error('EVENT_POLICY_NOT_READY');
  const policy = parseEventRegistrationPolicy(community.typeSettings?.registrationPolicy);
  const perpetual = community.id === 'community_1794221739126_корпспорт-падлхаб-2026';
  const retentionUntil = eventRetentionUntil(policy.endsAt);
  if (now >= retentionUntil) throw new Error('EVENT_DATA_EXPIRED');
  if (!Array.isArray(community.typeSettings?.gameIds) || !community.typeSettings.gameIds.includes('padel-jump')) throw new Error('EVENT_GAME_DISABLED');
  const rows = key => community[key] || [];
  const norm = value => String(value || '').replace(/\D/g, '').replace(/^8(?=\d{10}$)/, '7');
  const banned = rows('bannedMembers').some(row => row.id === actor.id || (actor.phone && norm(row.phone || row.phoneNorm) === norm(actor.phone)));
  const members = rows('members').filter(row => row.id === actor.id);
  if (members.length > 1 || members.some(row => row.status && !['ACTIVE', 'PENDING'].includes(row.status))) throw new Error('MEMBERSHIP_NOT_VERIFIED');
  const membership = banned ? 'BANNED' : members[0]?.status === 'PENDING' || rows('pendingMembers').some(row => row.id === actor.id) ? 'PENDING' : members.length ? 'ACTIVE' : 'NONE';
  const entries = rows('eventEntries').filter(row => row.playerId === actor.id && row.epoch === community.typeSettingsEffectiveAt && row.policyRevision === community.typeSettingsRevision && row.policyVersion === policy.version);
  if (entries.length > 1 || entries.some(row => !iso(row.registeredAt) ||
      (perpetual && row.retentionMode !== undefined && row.retentionMode !== 'submitted-year-v1') ||
      (perpetual && row.retentionMode === 'submitted-year-v1' && row.registeredAt > now) ||
      row.retentionUntil !== eventRetentionUntil(perpetual && row.retentionMode === 'submitted-year-v1' ? row.registeredAt : policy.endsAt))) throw new Error('EVENT_POLICY_NOT_READY');
  const registration = entries.length && (!perpetual || entries[0].retentionMode === 'submitted-year-v1' && now < entries[0].retentionUntil) ? 'CURRENT' : 'REQUIRED';
  const playOpen = now >= policy.startsAt && now < policy.endsAt;
  const state = membership === 'BANNED' ? 'blocked' : membership === 'PENDING' ? 'pending' : now < policy.startsAt ? 'scheduled' : now >= policy.endsAt ? 'closed' : registration !== 'CURRENT' || membership !== 'ACTIVE' ? 'form' : 'ready';
  const clean = value => typeof value === 'string' ? value.replace(/[\p{C}<>]/gu, '').trim().slice(0, 48) : '';
  return { schema: 'event-jump-admission-v1', communityId: community.id, communityName: clean(community.name) || 'Мероприятие',
    actor: { id: actor.id, name: clean(actor.name) || 'Игрок' }, membership, registration, state, playOpen,
    epoch: community.typeSettingsEffectiveAt, policyRevision: community.typeSettingsRevision,
    eventNotice: { policy, revision: community.typeSettingsRevision, ...(perpetual ? {retentionMode:'submitted-year-v1'} : {}) }, retentionUntil };
}

const PREPARE = String.raw`
const fail = (statusCode,error) => [null,Object.assign({},msg,{statusCode,headers:{'Cache-Control':'private, no-store'},payload:{error}})];
if (msg._communityPolicyAuthFailure) return fail(msg._communityPolicyAuthFailure === 'INVALID' ? 401 : 503,msg._communityPolicyAuthFailure === 'INVALID' ? 'AUTH_TOKEN_INVALID' : 'AUTH_SERVICE_UNAVAILABLE');
if (!msg._verifiedCommunityActor?.id) return fail(403,'COMMUNITY_AUTH_REQUIRED');
const id = msg.req?.params?.communityId;
if (typeof id !== 'string' || !/^[\p{L}\p{N}_-]{1,120}$/u.test(id) || Object.keys(msg.req?.query || {}).length) return fail(400,'EVENT_ADMISSION_REQUEST_INVALID');
msg.payload = {id,communityType:'EVENT',archived:{$ne:true}}; return [msg,null];
`;
const APPLY = parseEventRegistrationPolicy.toString() + '\n' + eventRetentionUntil.toString() + '\n' + eventJumpAdmission.toString() + String.raw`
const rows = Array.isArray(msg.payload) ? msg.payload : msg.payload ? [msg.payload] : [];
msg.headers = {'Content-Type':'application/json','Cache-Control':'private, no-store'};
try { if (rows.length !== 1) throw new Error('COMMUNITY_NOT_FOUND'); msg.payload = eventJumpAdmission(rows[0],msg._verifiedCommunityActor,new Date().toISOString()); msg.statusCode=200; }
catch(error) { const allowed=['COMMUNITY_AUTH_REQUIRED','COMMUNITY_NOT_FOUND','EVENT_POLICY_NOT_READY','EVENT_DATA_EXPIRED','EVENT_GAME_DISABLED','MEMBERSHIP_NOT_VERIFIED'];const code=allowed.includes(error.message)?error.message:'EVENT_ADMISSION_UNAVAILABLE';msg.statusCode=code==='COMMUNITY_NOT_FOUND'?404:code==='COMMUNITY_AUTH_REQUIRED'?403:code==='EVENT_DATA_EXPIRED'?410:503;msg.payload={error:code}; }
delete msg._verifiedCommunityActor; return msg;
`;

/** Adds a read-only route; fresh live graph and deployment remain separate boundaries. */
export function addEventAdmissionRoutes(input) {
  const flow = structuredClone(input), prefix = 'community-event-admission-v1';
  const template = flow.find(n => n.type === 'mongodb4' && n.collection === 'lk_communities' && n.operation === 'find' && !n.id.startsWith(prefix));
  if (!template) throw new Error('EVENT_ADMISSION_MONGO_TEMPLATE_REQUIRED');
  const node = (suffix,type,extra) => ({id:prefix+suffix,type,z:template.z,...extra});
  const definitions = [
    node('-in','http in',{name:'Event own admission',url:'/lk/communities/:communityId/event-admission',method:'get',wires:[[prefix+'-prepare']]}),
    node('-prepare','function',{name:'Prepare event admission',func:PREPARE,outputs:2,wires:[[prefix+'-find'],[prefix+'-response']]}),
    {...structuredClone(template),id:prefix+'-find',name:'Read event admission',operation:'find',maxTimeMS:5000,wires:[[prefix+'-apply']]},
    node('-apply','function',{name:'Apply event admission',func:APPLY,outputs:1,wires:[[prefix+'-response']]}),
    node('-catch','catch',{name:'Event admission storage failure',scope:[prefix+'-prepare',prefix+'-find',prefix+'-apply'],uncaught:false,wires:[[prefix+'-error']]}),
    node('-error','function',{name:'Event admission unavailable',func:"msg.statusCode=503;msg.headers={'Cache-Control':'private, no-store'};msg.payload={error:'EVENT_ADMISSION_UNAVAILABLE'};return msg;",outputs:1,wires:[[prefix+'-response']]}),
    node('-response','http response',{name:'Event admission response',wires:[]}),
  ];
  const managed=flow.filter(n=>n.id.startsWith(prefix));
  if (!managed.length) { flow.push(...definitions); return flow; }
  if (managed.length !== definitions.length) throw new Error('EVENT_ADMISSION_GRAPH_DRIFT');
  for (const expected of definitions) {
    const actual=managed.find(n=>n.id===expected.id), comparable=structuredClone(expected);
    if (expected.type==='http in' && [COMMUNITY_AUTH_SUBFLOW+'-entry-'+expected.id,COMMUNITY_AUTH_SUBFLOW+'-budget-'+expected.id].includes(actual?.wires?.[0]?.[0])) comparable.wires=actual.wires;
    if (expected.id === prefix+'-apply' && typeof actual?.func === 'string' &&
        createHash('sha256').update(actual.func).digest('hex') === '3c351e3e45f2a15f879f66d93e3273eb2c984ad799153d7985bf5947f0baedcc') comparable.func=actual.func;
    if (!isDeepStrictEqual(actual,comparable)) throw new Error('EVENT_ADMISSION_GRAPH_DRIFT');
  }
  flow.find(n=>n.id===prefix+'-apply').func=APPLY;
  return flow;
}
