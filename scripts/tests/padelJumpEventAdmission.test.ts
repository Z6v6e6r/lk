import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { eventJumpAdmission, addEventAdmissionRoutes } from '../lib/eventJumpAdmission.mjs';
import { addCommunityPolicyAuth } from '../lib/communityPolicyAuth.mjs';
type FlowNode = { id: string; type: string; method?: string; url?: string; wires?: string[][]; operation?: string; func?: string };

const policy = { version: 'event-registration-v1', responsibleName: 'Synthetic Organizer', contactEmail: ['organizer', 'example.invalid'].join('@'), startsAt: '2026-11-11T21:00:00.000Z', endsAt: '2026-11-13T21:00:00.000Z', retentionYears: 1 };
const epoch = '2026-11-09T09:00:00.000Z', at = '2026-11-12T09:00:00.000Z';
const actor = { id: 'fixture-player', name: 'Verified Player', phone: '+7' + '9990000001' };
function doc() { return { id: 'fixture-event', name: 'Synthetic Event', communityType: 'EVENT', members: [{ id: actor.id, role: 'MEMBER', status: 'ACTIVE' }], pendingMembers: [], bannedMembers: [], typeSettingsEffectiveAt: epoch, typeSettingsRevision: 2, typeSettings: { gameIds: ['padel-jump'], registrationPolicy: structuredClone(policy) }, eventEntries: [{ playerId: actor.id, epoch, policyRevision: 2, policyVersion: policy.version, registeredAt: '2026-11-12T08:00:00.000Z', retentionUntil: '2027-11-13T21:00:00.000Z', fullName: 'Private Questionnaire', company: 'Private Company', email: ['private', 'example.invalid'].join('@') }] }; }
test('canonical admission binds current own registration and policy without returning questionnaire data', () => {
  const response = eventJumpAdmission(doc(), actor, at);
  assert.equal(response.state, 'ready');
  assert.equal(response.registration, 'CURRENT');
  assert.equal(response.communityId, 'fixture-event');
  assert.equal(response.epoch, epoch); assert.equal(response.policyRevision, 2);
  assert.equal(response.playOpen, true);
  assert.deepEqual(response.actor, { id: actor.id, name: actor.name });
  assert.doesNotMatch(JSON.stringify(response), /Private Questionnaire|Private Company|private@|9990000001|eventEntries|playerId/);
});
test('existing members need a current questionnaire; bans and pending membership cannot become ready', () => {
  for (const change of [() => [], () => [{ ...doc().eventEntries[0], policyRevision: 1 }], () => [{ ...doc().eventEntries[0], epoch: '2026-11-08T09:00:00.000Z' }]]) {
    const value = doc(); value.eventEntries = change(); assert.equal(eventJumpAdmission(value, actor, at).state, 'form');
  }
  const banned = doc(); banned.bannedMembers = [{ id: actor.id }]; assert.equal(eventJumpAdmission(banned, actor, at).state, 'blocked');
  const pending = doc(); pending.members = []; pending.pendingMembers = [{ id: actor.id }]; assert.equal(eventJumpAdmission(pending, actor, at).state, 'pending');
  const stranger = eventJumpAdmission(doc(), { ...actor, id: 'other-player' }, at); assert.equal(stranger.state, 'form'); assert.equal(stranger.membership, 'NONE');
});
test('opening/closing are exact and retention closes even own admission at its inclusive cutoff', () => {
  assert.equal(eventJumpAdmission(doc(), actor, '2026-11-11T20:59:59.999Z').state, 'scheduled');
  assert.equal(eventJumpAdmission(doc(), actor, policy.startsAt).state, 'ready');
  assert.equal(eventJumpAdmission(doc(), actor, policy.endsAt).state, 'closed');
  assert.throws(() => eventJumpAdmission(doc(), actor, '2027-11-13T21:00:00.000Z'), /EVENT_DATA_EXPIRED/);
  const wrong = doc(); wrong.communityType = 'FRIENDS'; assert.throws(() => eventJumpAdmission(wrong, actor, at), /COMMUNITY_NOT_FOUND/);
});
test('generated admission is GET-only, verified-actor bound, read-only and rejects node/config drift', () => {
  const input = [{ id: 'tab', type: 'tab' }, { id: 'mongo', type: 'mongodb4', z: 'tab', collection: 'lk_communities', operation: 'find', clientNode: 'fixture-client', wires: [] }];
  const graph: FlowNode[] = addCommunityPolicyAuth(addEventAdmissionRoutes(input));
  const route = graph.find(n => n.type === 'http in')!;
  assert.equal(route.method, 'get'); assert.equal(route.url, '/lk/communities/:communityId/event-admission');
  assert.match(route.wires![0][0], /community-policy-verified-actor/);
  assert.ok(graph.filter(n => n.type === 'mongodb4').every(n => n.operation === 'find'));
  const prepare = graph.find(n => n.id === 'community-event-admission-v1-prepare')!;
  const msg = { req: { params: { communityId: 'fixture-event' }, query: {} }, payload: null };
  const denied = vm.runInNewContext('(function(msg){' + prepare.func + '\n})(msg)', { msg });
  assert.equal(denied[0], null); assert.equal(denied[1].statusCode, 403);
  assert.deepEqual(addCommunityPolicyAuth(addEventAdmissionRoutes(graph)), graph);
  const drift = structuredClone(graph); drift.find(n => n.id === 'community-event-admission-v1-apply')!.func = 'return msg;';
  assert.throws(() => addEventAdmissionRoutes(drift), /EVENT_ADMISSION_GRAPH_DRIFT/);
});
