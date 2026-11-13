import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { buildCollectorCandidate, collectorFunction, ROUTE_ID, RESPONSE_ID, MONGO_ID, DEBUG_ID } from '../diagnostics/split-leave-collector.mjs';
import { sanitizeEvent } from '../../src/utils/errorDiagnosticsCore.mjs';
import { buildExactGraphContract } from '../nodered_reviewed_flow_deploy/runtime_contract.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');
const release = 'a'.repeat(40);
export const graph = () => [{ id: 'tab', type: 'tab', disabled: false },
  { id: ROUTE_ID, type: 'http in', z: 'tab', method: 'post', url: '/lk/analytics/events', wires: [[DEBUG_ID, RESPONSE_ID, MONGO_ID]] },
  { id: RESPONSE_ID, z: 'tab', type: 'http response', wires: [] },
  { id: MONGO_ID, z: 'tab', type: 'mongodb4', collection: 'events', operation: 'insertOne', wires: [[]] },
  { id: DEBUG_ID, z: 'tab', type: 'debug', active: false, wires: [] }];
const event = () => ({ schemaVersion: 1, diagnosticEventId: randomUUID(), requestId: randomUUID(),
  eventKind: 'client_error', source: 'browser', method: 'POST', routeTemplate: '/lk/games/:gameId/split/leave',
  stage: 'leave_initiator', code: 'SPLIT_LEAVE_INITIATED', deviceEventTime: new Date().toISOString(),
  leaveTrace: { frames: [{ asset: 'games.js', line: 1, column: 42 }], actions: [{ action: 'GAME_LEAVE', kind: 'click', ageMs: 10, trusted: true }], visibility: 'visible' } });
test('source generator changes only original route wires and one appended gate', () => {
  const source = graph(), raw = JSON.stringify(source), routeHash = sha(JSON.stringify(source[1]));
  const built = buildCollectorCandidate(source, { release, routeHash });
  assert.equal(JSON.stringify(source), raw);
  const contract = buildExactGraphContract({ liveBytes: Buffer.from(raw), candidateBytes: Buffer.from(JSON.stringify(built.candidate)),
    deploymentId: 'collector-native-diagnostic', allowedChanges: [{ id: ROUTE_ID, fields: ['wires'] }], allowedAdditionIds: [built.gate.id] });
  assert.equal(contract.allowedChanges.length, 1); assert.equal(contract.allowedAdditions.length, 1);
  assert.deepEqual(built.candidate.slice(2, -1), source.slice(2));
  assert.throws(() => buildCollectorCandidate(source, { release, routeHash: '0'.repeat(64) }), /PIN/);
  source[3].collection = 'business';
  assert.throws(() => buildCollectorCandidate(source, { release, routeHash }), /PERSISTENCE/);
});
test('actual generated function rebuilds one safe envelope for storage/debug and preserves response identity', () => {
  const run = new Function('msg', collectorFunction(release));
  const secret = 'SENSITIVE_TEST_SENTINEL';
  const payload = event(); payload.leaveTrace.frames[0].url = secret;
  payload.leaveTrace.actions[0].text = secret; payload.token = secret;
  payload.serverRequestId = randomUUID(); payload.serverTimeUtc = new Date().toISOString();
  const msg = { payload: { event: 'client_error', payload, user: secret, session: secret }, req: { headers: { authorization: secret } }, res: {} };
  const before = JSON.stringify(msg), [response, storage] = run(msg);
  assert.equal(response, msg); assert.equal(JSON.stringify(msg), before);
  assert.deepEqual(Object.keys(storage), ['payload']);
  assert.deepEqual(Object.keys(storage.payload), ['event', 'timestamp', 'payload']);
  assert.equal(storage.payload.payload.serverRelease, release);
  assert.equal(storage.payload.payload.serverTimeUtc, undefined);
  assert.equal(storage.payload.payload.serverRequestId, undefined);
  assert.equal(storage.payload.payload.deviceClockTrusted, false);
  assert(storage.payload.payload.serverIngestTime);
  assert.deepEqual(storage.payload.payload, sanitizeEvent(storage.payload.payload));
  assert(!JSON.stringify(storage).includes(secret));
});
test('invalid target diagnostics lose storage only; other legacy events remain unchanged', () => {
  const run = new Function('msg', collectorFunction(release));
  for (const mutation of [{ method: 'GET' }, { source: 'node_red' }, { requestId: 'invalid' }, { leaveTrace: undefined }]) {
    const msg = { payload: { event: 'client_error', payload: { ...event(), ...mutation } } };
    assert.deepEqual(run(msg), [msg, null]);
  }
  const old = { payload: { event: 'other-legacy-event', payload: { code: 'LEGACY', field: 'unchanged' } } };
  assert.deepEqual(run(old), [old, old]);
});
