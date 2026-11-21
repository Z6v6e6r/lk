import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import { patchFprStartLevelReadback } from '../patch_fpr_start_level_readback.mjs';

const fieldId = 'eabfe27b-3f72-4496-9185-1a2ec6e6465e';
const clientId = 'synthetic-player';
const put = '9793d68822613891';
const capture = 'onboarding_level_capture_viva_result_001';
const join = '83cdc134bc890c26';
const response = '14601d3a912ff692';
const tab = 'fixture-onboarding';
const sourceFunction = name => fs.readFileSync(
  new URL(`../nodered_onboarding_nodes/${name}.js`, import.meta.url), 'utf8',
);
const sourceFlow = [
  { id: tab, type: 'tab', label: 'LK Onboarding' },
  { id: put, z: tab, type: 'http request', method: 'use', ret: 'obj', wires: [[capture]] },
  { id: capture, z: tab, type: 'function', outputs: 1, wires: [[join]], func: sourceFunction('fn_onboarding_level_capture_viva_result') },
  { id: join, z: tab, type: 'join', mode: 'auto', wires: [[response]] },
  { id: response, z: tab, type: 'function', func: sourceFunction('fn_onboarding_level_build_response') },
  { id: 'another-route', type: 'http in', url: '/fixture', wires: [[]] },
];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const source = JSON.stringify(sourceFlow);
const candidate = patchFprStartLevelReadback(source, hash(source));
const nodes = new Map(JSON.parse(candidate.output).map(node => [node.id, node]));
const prepareId = nodes.get(capture).wires[0][0];
const profileId = nodes.get(prepareId).wires[1][0];
const authorizeId = nodes.get(profileId).wires[0][0];
const requestId = nodes.get(authorizeId).wires[1][0];
const resultId = nodes.get(requestId).wires[0][0];
const run = (id, msg) => new Function('msg', nodes.get(id).func)(msg);

const profile = (value, id = clientId) => ({
  id,
  customFields: [{ id: fieldId, value: [value] }],
  name: 'fixture-private-profile',
});
const actorId = 'synthetic-host';
const hostProfile = {
  id: actorId,
  customFields: [{
    id: 'e17a32f3-65f7-47c5-bda1-33d79932c884',
    value: ['host-role'],
    attributes: { options: [{ id: 'host-role', name: 'проводит турниры' }] },
  }],
};
const putResult = (overrides = {}) => run(capture, {
  statusCode: 200, payload: '', clientId, source: 'tournament_start',
  token: 'fixture-bearer', levelNumeric: '2.00000',
  req: { headers: { authorization: 'Bearer fixture-organizer' } },
  ratingAudit: { changedBy: { id: actorId } },
  parts: { id: 'fixture-one-part', index: 0, count: 1 }, res: {},
  _vivaFieldUpdate: { fieldId, requestedValue: ['2.00000'] },
  ...overrides,
});
const aggregate = msg => run(response, { ...msg, payload: [msg.payload] });
const authorize = (msg, reply = { statusCode: 200, payload: hostProfile }) => run(authorizeId, { ...msg, ...reply });

test('focused patch adds a bounded authorized GET branch and preserves the existing flow', () => {
  assert.deepEqual(candidate.changed, [capture]);
  assert.deepEqual(candidate.added, [prepareId, profileId, authorizeId, requestId, resultId]);
  for (const node of sourceFlow) {
    assert.deepEqual(nodes.get(node.id), node.id === capture ? { ...node, wires: [[prepareId]] } : node);
  }
  assert.deepEqual(nodes.get(prepareId).wires, [[join], [profileId]]);
  assert.deepEqual(nodes.get(authorizeId).wires, [[resultId], [requestId]]);
  for (const id of [profileId, requestId]) {
    assert.equal(nodes.get(id).method, 'GET');
    assert.equal(nodes.get(id).ret, 'obj');
    assert.equal(nodes.get(id).senderr, false);
    assert.equal(nodes.get(id).headers[0].keyValue, 'User-Agent');
  }
  assert.deepEqual(nodes.get(resultId).wires, [[join]]);
  assert.throws(() => patchFprStartLevelReadback(source, '0'.repeat(64)), /source hash mismatch/);
  const drifted = JSON.stringify(sourceFlow.map(node => node.id === capture ? { ...node, wires: [['another-route']] } : node));
  assert.throws(() => patchFprStartLevelReadback(drifted, hash(drifted)));
});

test('tournament level 2 with empty Viva 200 is confirmed by exactly one matching profile read', () => {
  const [direct, verifyHost] = run(prepareId, putResult());
  assert.equal(direct, null);
  assert.equal(verifyHost.url, 'https://api.vivacrm.ru/end-user/api/v1/iSkq6G/profile');
  assert.equal(verifyHost.headers.Authorization, 'Bearer fixture-organizer');
  assert.equal(verifyHost.requestTimeout, 2500);
  assert.equal(verifyHost.followRedirects, false);
  assert.equal(verifyHost.maxRedirects, 0);
  const [rejected, read] = authorize(verifyHost);
  assert.equal(rejected, null);
  assert.equal(read.method, 'GET');
  assert.equal(read.url, 'https://api.vivacrm.ru/api/v1/clients/synthetic-player');
  assert.equal(read.headers.Authorization, 'Bearer fixture-bearer');
  assert.equal(read.payload, undefined);
  assert.equal(read.token, undefined);
  assert.equal(read.requestTimeout, 5000);
  assert.equal(read.followRedirects, false);
  assert.equal(read.maxRedirects, 0);
  const msg = run(resultId, { ...read, statusCode: 200, payload: profile('2,00000') });
  assert.deepEqual(msg.parts, read.parts);
  assert.equal(msg.res, read.res);
  assert.equal(msg.payload.ok, true);
  assert.deepEqual(msg.payload.readback, { httpStatus: 200, confirmed: true });
  const [log, , reply] = aggregate(msg);
  assert.equal(reply.statusCode, 200);
  assert.equal(reply.payload.projectionStatus, 'SYNCED');
  assert.deepEqual(reply.payload.updatedFields, [fieldId]);
  assert.equal(log.payload.projectionStatus, 'SYNCED');
  assert.doesNotMatch(JSON.stringify([log, reply]), /fixture-private-profile|fixture-bearer/);
});

test('mismatched or unavailable reads produce a single failed result for the original PUT', () => {
  const [, verifyHost] = run(prepareId, putResult());
  const [, read] = authorize(verifyHost);
  const good = profile(2);
  for (const reply of [
    { statusCode: 200, payload: profile(2.000001) },
    { statusCode: 200, payload: profile(2, 'other-player') },
    { statusCode: 200, payload: { ...good, customFields: [] } },
    { statusCode: 200, payload: { ...good, customFields: [...good.customFields, ...good.customFields] } },
    { statusCode: 200, payload: { ...good, customFields: [{ id: fieldId, value: [2, 2] }] } },
    { statusCode: 200, payload: profile('0x2') },
    { statusCode: 200, payload: profile({ value: 2 }) },
    { statusCode: 200, payload: '' },
    { statusCode: 302, payload: good },
    { statusCode: 401, payload: good },
    { statusCode: 404, payload: good },
    { statusCode: 'ETIMEDOUT', payload: 'fixture-transport-body', error: { code: 'ETIMEDOUT' } },
  ]) {
    const result = run(resultId, { ...read, ...reply });
    assert.equal(result.payload.ok, false);
    assert.equal(result.payload.readback.confirmed, false);
    assert.equal(result.payload.httpStatus, 200);
    assert.equal(aggregate(result)[2].statusCode, 502);
    assert.doesNotMatch(JSON.stringify(result), /fixture-private-profile|fixture-bearer|fixture-transport-body/);
  }
});

test('expired, unauthorized or mismatched caller never reaches the service-token read', () => {
  const [, verifyHost] = run(prepareId, putResult());
  for (const reply of [
    { statusCode: 401, payload: hostProfile },
    { statusCode: 200, payload: { ...hostProfile, customFields: [] } },
    { statusCode: 200, payload: { ...hostProfile, id: 'another-host' } },
    { statusCode: 200, payload: profile(2) },
    { statusCode: 'ETIMEDOUT', payload: 'fixture-transport-body', error: { code: 'ETIMEDOUT' } },
  ]) {
    const [rejected, read] = authorize(verifyHost, reply);
    assert.equal(read, null);
    assert.equal(aggregate(run(resultId, rejected))[2].statusCode, 502);
  }
});

test('other sources, malformed acknowledgements and normal success stay on the original path', () => {
  for (const input of [
    { source: 'onboarding' }, { source: 'tournaments' },
    { statusCode: 201 }, { statusCode: 404 }, { statusCode: 204 },
    { payload: null }, { payload: '{}' }, { payload: '<html>wrong response</html>' },
    { error: { code: 'ETIMEDOUT' } }, { token: undefined }, { req: { headers: {} } },
    { _vivaFieldUpdate: { fieldId: 'other-field', requestedValue: ['2.00000'] } },
    { payload: {} },
  ]) {
    const msg = putResult(input);
    const [direct, read] = run(prepareId, msg);
    assert.equal(direct, msg);
    assert.equal(read, null);
    const expected = input.statusCode === 204 || input.payload && typeof input.payload === 'object' ? 200 : 502;
    assert.equal(aggregate(direct)[2].statusCode, expected);
  }
});
