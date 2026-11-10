import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import { eventJumpAdmission, addEventAdmissionRoutes } from '../lib/eventJumpAdmission.mjs';
import { addCommunityPolicyAuth } from '../lib/communityPolicyAuth.mjs';
import { patchCommunityTypesFlow } from '../patch_live_community_types.mjs';
type FlowNode = { id: string; type: string; method?: string; url?: string; wires?: string[][]; operation?: string; func?: string };

test('assembled admission rejects foreign normalized route ownership but preserves inactive and distinct-method routes', () => {
  const source = fs.readFileSync('scripts/patch_nodered_communities_flow.mjs', 'utf8');
  const common = source.split('const commonHelpers = String.raw`')[1].split('\n`;')[0];
  const body = (name: string) => common + source.split('const ' + name + ' = `${commonHelpers}')[1].split('\n`;')[0];
  const required = [
    { id: 'create', name: 'Build community create docs', func: body('fnCreate') },
    { id: 'update', name: 'Prepare community update', func: body('fnUpdatePrepare') },
    { id: 'ranking', name: 'Use rating snapshot or fallback', func: body('fnRankingSnapshotResponse') },
    { id: 'list', name: 'Prepare communities list query', func: common + fs.readFileSync('scripts/nodered_community_list_nodes/fn_list_prepare_tail.js', 'utf8') },
    { id: 'autojoin', name: 'Prepare game station autojoin', func: 'return [msg, null];' },
  ].map(node => ({ ...node, type: 'function', z: 'tab', outputs: 2, wires: [['foreign']] }));
  const base = [...required, { id: 'tab', type: 'tab' }, { id: 'foreign', type: 'function', z: 'tab', func: 'return msg;', wires: [] },
    { id: 'mongo', type: 'mongodb4', z: 'tab', collection: 'lk_communities', operation: 'find', clientNode: 'fixture-client', wires: [] }];
  for (const [method, url] of [['get', '/lk/communities/:communityId/event-admission'], ['GET', '/lk/communities/:other/event-admission/']]) {
    const input = [...base, { id: 'existing-admission', type: 'http in', z: 'tab', method, url, wires: [['foreign']] }];
    const original = structuredClone(input);
    assert.throws(() => patchCommunityTypesFlow(input, { eventAdmission: true }), /COMMUNITY_TYPES_AMBIGUOUS_ACTIVE_ROUTE/);
    assert.deepEqual(input, original, 'rejection must not mutate the preimage');
  }
  for (const foreign of [
    { id: 'existing-admission', type: 'http in', z: 'tab', method: 'get', url: '/lk/communities/:communityId/event-admission', d: true, wires: [['foreign']] },
    { id: 'existing-admission', type: 'http in', z: 'tab', method: 'post', url: '/lk/communities/:communityId/event-admission', wires: [['foreign']] },
  ]) {
    const result = patchCommunityTypesFlow([...base, foreign], { eventAdmission: true });
    assert.equal(result.flow.filter((node: FlowNode) => node.id === 'community-event-admission-v1-in').length, 1);
    if (foreign.d) assert.deepEqual(result.flow.find((node: FlowNode) => node.id === foreign.id), foreign);
    assert.equal(patchCommunityTypesFlow(result.flow, { eventAdmission: true }).changes.length, 0);
  }
});

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
test('direct admission has a bounded gate before profile authentication even with rotating credentials', () => {
  const input = [{ id: 'tab', type: 'tab' }, { id: 'mongo', type: 'mongodb4', z: 'tab', collection: 'lk_communities', operation: 'find', clientNode: 'fixture-client', wires: [] }];
  const graph: FlowNode[] = addCommunityPolicyAuth(addEventAdmissionRoutes(input));
  const route = graph.find(n => n.id === 'community-event-admission-v1-in')!;
  const gate = graph.find(n => n.id === route.wires![0][0])!;
  assert.equal(gate.type, 'function', 'budget must execute before the auth subflow, not after it');
  const auth = graph.find(n => n.id === gate.wires![0][0])!;
  assert.match(auth.type, /^subflow:community-policy-verified-actor/);
  assert.deepEqual(auth.wires, [['community-event-admission-v1-prepare']]);
  assert.deepEqual(gate.wires![1], ['community-event-admission-v1-response']);
  const stored = new Map<string, unknown>();
  const context = { get: (key: string) => stored.get(key), set: (key: string, value: unknown) => stored.set(key, value) };
  let admitted = 0, rejected = 0;
  for (let i = 0; i < 60; i++) {
    const msg = { req: { method: 'GET', params: { communityId: 'fixture-event' }, query: {}, headers: { authorization: 'Bearer fixture-' + i, 'x-forwarded-for': 'spoof-' + i } }, payload: {} };
    const result = vm.runInNewContext('(function(msg){' + gate.func + '\n})(msg)', { msg, context, Date: { now: () => 1000 } });
    if (result[0]) admitted++;
    else { rejected++; assert.equal(result[1].statusCode, 429); assert.equal(result[1].payload.error, 'EVENT_ADMISSION_RATE_LIMITED'); }
  }
  assert.equal(admitted, 10); assert.equal(rejected, 50);
  assert.doesNotMatch(JSON.stringify([...stored]), /Bearer|fixture-|spoof-/);
  assert.deepEqual(addCommunityPolicyAuth(addEventAdmissionRoutes(graph)), graph);
});
function admissionBudgetFixture() {
  const graph: FlowNode[] = addCommunityPolicyAuth(addEventAdmissionRoutes([{ id: 'tab', type: 'tab' }, { id: 'mongo', type: 'mongodb4', z: 'tab', collection: 'lk_communities', operation: 'find', clientNode: 'fixture-client', wires: [] }]));
  const gate = graph.find(n => n.id === 'community-policy-verified-actor-v1-budget-community-event-admission-v1-in')!;
  assert.equal(gate.type,'function');
  const stored = new Map<string, unknown>();
  const context = { get: (key: string) => stored.get(key), set: (key: string, value: unknown) => stored.set(key, value) };
  const run = (at: number, patch: Record<string, unknown> = {}) => {
    const msg = { req: { method: 'GET', params: { communityId: 'fixture-event' }, query: {}, headers: { authorization: 'Bearer fixture' }, ...patch }, payload: {} };
    return vm.runInNewContext('(function(msg){' + gate.func + '\n})(msg)', { msg, context, Date: { now: () => at } });
  };
  return {graph,gate,stored,context,run};
}
test('direct admission bounds dispatches across the entire provider timeout, with inclusive expiry and fail-closed clock rollback', () => {
  const fixture=admissionBudgetFixture();
  for(const at of [1000,2000,3000]) for(let i=0;i<10;i++) assert.ok(fixture.run(at)[0]);
  for(const at of [4000,15999]) {
    const result=fixture.run(at);assert.equal(result[0],null,'no more than30 dispatches in any15 seconds');assert.equal(result[1].statusCode,429);
  }
  for(let i=0;i<10;i++) assert.ok(fixture.run(16000)[0]);
  const rollback=fixture.run(15999);assert.equal(rollback[0],null);assert.equal(rollback[1].statusCode,503);
  const timestamps=fixture.stored.get('eventAdmissionProviderBudgetV1') as number[];
  assert.equal(timestamps.length,30);assert.ok(timestamps.every(Number.isSafeInteger));
});
test('admission budget cannot be bypassed or rewired to another auth continuation', () => {
  const {graph,gate}=admissionBudgetFixture();
  for(const mutate of [
    (flow: FlowNode[]) => { flow.find(n=>n.id===gate.id)!.func+='\n// drift'; },
    (flow: FlowNode[]) => { flow.find(n=>n.id===gate.id)!.wires=[['community-event-admission-v1-prepare'],['community-event-admission-v1-response']]; },
    (flow: FlowNode[]) => { flow.find(n=>n.id==='community-event-admission-v1-in')!.wires=[gate.wires![0]]; },
    (flow: FlowNode[]) => { flow.find(n=>n.id===gate.wires![0][0])!.wires=[['mongo']]; },
  ]) {
    const drift=structuredClone(graph);mutate(drift);const original=structuredClone(drift);
    assert.throws(()=>addCommunityPolicyAuth(addEventAdmissionRoutes(drift)),/COMMUNITY_AUTH_.*DRIFT/);
    assert.deepEqual(drift,original);
  }
});
test('admission pre-auth validation rejects malformed requests without dispatch or retained identities', () => {
  for(const [patch,status] of [
    [{method:'HEAD'},405], [{params:{communityId:'bad/target'}},400], [{params:{communityId:'/'}},400], [{params:{communityId:'a\nb'}},400], [{query:{clientId:'spoof'}},400],
    [{headers:{}},403], [{headers:{authorization:'invalid'}},401],
    [{headers:{authorization:'Bearer fixture','content-length':'8193'}},413],
    [{headers:{authorization:'Bearer fixture','transfer-encoding':'chunked'}},400],
  ] as [Record<string,unknown>,number][]) {
    const fixture=admissionBudgetFixture(), result=fixture.run(1000,patch);
    assert.equal(result[0],null);assert.equal(result[1].statusCode,status);assert.equal(fixture.stored.size,0);
  }
  const fixture=admissionBudgetFixture();
  assert.ok(fixture.run(1000,{params:{communityId:'community_корпспорт-2026'},headers:{authorization:'Bearer fixture','content-length':'8192'}})[0]);
  for(const invalid of [null,{},Array(31).fill(0),[1000,999],[NaN]]) {
    const fixture=admissionBudgetFixture();fixture.stored.set('eventAdmissionProviderBudgetV1',invalid);
    const result=fixture.run(1000);assert.equal(result[0],null);assert.equal(result[1].statusCode,503);
  }
});
test('admission fails closed with a sanitized response if its budget store is unavailable', () => {
  for(const method of ['get','set'] as const) {
    const fixture=admissionBudgetFixture();
    fixture.context[method]=()=>{throw new Error('PRIVATE_STORAGE_SENTINEL');};
    assert.doesNotThrow(()=>{
      const result=fixture.run(1000);assert.equal(result[0],null);assert.equal(result[1].statusCode,503);
      assert.doesNotMatch(JSON.stringify(result[1].payload),/PRIVATE_STORAGE_SENTINEL/);
    });
  }
});
