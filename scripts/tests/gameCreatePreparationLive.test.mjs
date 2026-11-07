import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {
  assertLiveGameCreateFacts,
  composeGameCreatePreparationLive,
  GAME_CREATE_LIVE_ONBOARDING_NODE_ID,
  GAME_CREATE_LIVE_SOURCE_SHA256,
  GAME_CREATE_ROUTE,
} from '../prepare_game_create_preparation_live.mjs';
import { gameCreatePreparationIds as ids } from '../patch_nodered_game_create_preparation.mjs';
import { gameCreateServiceTable } from '../lib/gameCreatePreparationSource.mjs';
import { validateReviewedFlowContract } from '../nodered_reviewed_flow_deploy/runtime_contract.mjs';
import { Harness } from './helpers/gameCreatePreparationHarness.mjs';

const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const onboardingFunc = fs.readFileSync(
  new URL('../nodered_onboarding_nodes/fn_onboarding_stations.js', import.meta.url), 'utf8');

// Synthetic stand-in for the installed graph: only the facts the additive route relies on.
const syntheticLive = () => [
  { id: 'tab_lk1', type: 'tab', label: 'LK1', disabled: false },
  { id: GAME_CREATE_LIVE_ONBOARDING_NODE_ID, type: 'function', z: 'tab_lk1', func: onboardingFunc, outputs: 1, wires: [[]] },
  { id: 'token_setter', type: 'function', z: 'tab_lk1',
    func: "global.set('vivacrm_access_token', msg.payload.access_token); return msg;", outputs: 1, wires: [[]] },
  { id: 'lk_booked_operation_admission_in_20261021', type: 'http in', z: 'tab_lk1',
    url: '/lk/integrations/v1/booked-operation-admissions', method: 'post', wires: [[]] },
  { id: 'lk_booked_operation_read_in_20261021', type: 'http in', z: 'tab_lk1',
    url: '/lk/integrations/v1/booked-operations/:operationId', method: 'get', wires: [[]] },
];
const bytesOf = (flow) => Buffer.from(JSON.stringify(flow, null, 2) + '\n');
const composeSynthetic = (flow) => {
  const bytes = bytesOf(flow);
  return composeGameCreatePreparationLive(bytes, 'synthetic-create-live', sha(bytes));
};

test('synthetic installed graph composes one additive suffix with an exact contract', () => {
  const flow = syntheticLive();
  const r = composeSynthetic(flow);
  assert.deepEqual(r.candidate.slice(0, flow.length), flow);
  assert.deepEqual(r.candidate.slice(flow.length).map((n) => n.id), Object.values(ids));
  assert.deepEqual(r.contract.allowedChanges ?? [], []);
});

test('whole-flow preimage is pinned to the installed flows.json', () => {
  assert.equal(GAME_CREATE_LIVE_SOURCE_SHA256.length, 64);
  assert.throws(() => composeGameCreatePreparationLive(bytesOf(syntheticLive()), 'synthetic-create-live'),
    /CREATE_LIVE_PREIMAGE_DRIFT/);
});

test('live service table drift refuses instead of trusting the embedded selector', () => {
  const [station] = Object.keys(gameCreateServiceTable);
  const { subServiceId } = gameCreateServiceTable[station];
  const drift = syntheticLive();
  drift[1].func = drift[1].func.replaceAll(subServiceId,subServiceId.slice(0, -1) + (subServiceId.endsWith('0') ? '1' : '0'));
  assert.throws(() => assertLiveGameCreateFacts(drift), /CREATE_LIVE_SERVICE_TABLE_PARITY_INVALID/);
  const missing = syntheticLive().filter((n) => n.id !== GAME_CREATE_LIVE_ONBOARDING_NODE_ID);
  assert.throws(() => assertLiveGameCreateFacts(missing), /CREATE_LIVE_ONBOARDING_MISSING/);
});

test('admin credential source must be an active node', () => {
  const none = syntheticLive().filter((n) => n.id !== 'token_setter');
  assert.throws(() => assertLiveGameCreateFacts(none), /CREATE_LIVE_ADMIN_CREDENTIAL_SOURCE_MISSING/);
  const disabled = syntheticLive();
  disabled.find((n) => n.id === 'token_setter').d = true;
  assert.throws(() => assertLiveGameCreateFacts(disabled), /CREATE_LIVE_ADMIN_CREDENTIAL_SOURCE_MISSING/);
  const disabledTab = [...syntheticLive(), { id: 'off', type: 'tab', disabled: true }];
  disabledTab.find((n) => n.id === 'token_setter').z = 'off';
  assert.throws(() => assertLiveGameCreateFacts(disabledTab), /CREATE_LIVE_ADMIN_CREDENTIAL_SOURCE_MISSING/);
});

test('receiver boundary must exist and no earlier route may shadow the new path', () => {
  const noReceiver = syntheticLive().filter((n) => n.id !== 'lk_booked_operation_admission_in_20261021');
  assert.throws(() => assertLiveGameCreateFacts(noReceiver), /CREATE_LIVE_RECEIVER_MISSING/);
  for (const url of ['/lk/integrations/v1/:resource', '/lk/integrations/*', GAME_CREATE_ROUTE + '/',
    'lk/integrations/v1/:resource', GAME_CREATE_ROUTE.toUpperCase()]) {
    const shadow = [...syntheticLive(), { id: 'shadow', type: 'http in', z: 'tab_lk1', url, method: 'post', wires: [[]] }];
    assert.throws(() => assertLiveGameCreateFacts(shadow), /CREATE_LIVE_ROUTE_SHADOWED/, url);
  }
  const getOnly = [...syntheticLive(), { id: 'get', type: 'http in', z: 'tab_lk1', url: '/lk/integrations/v1/:x', method: 'get', wires: [[]] }];
  assert.doesNotThrow(() => assertLiveGameCreateFacts(getOnly));
});

// ---- Installed graph fixture (private copy outside Git; never committed) ----
const fixture = process.env.LK1_GAME_CREATE_LIVE_FLOW_FIXTURE;
const live = fixture ? fs.readFileSync(fixture) : null;
const liveTest = (name, fn) => test(name, { skip: live ? false : 'LK1_GAME_CREATE_LIVE_FLOW_FIXTURE not set' }, fn);

const liveHarness = (candidate) => {
  const h = new Harness();
  const func = (id) => candidate.find((n) => n.id === id).func;
  h.fns = Object.fromEntries([['verify', ids.verify], ['router', ids.router], ['response', ids.sanitize]]
    .map(([k, id]) => [k, new Function('msg', 'env', 'global', 'nodeCrypto', 'Date', func(id))]));
  return h;
};

liveTest('LIVE: installed graph is unchanged and only the eight reviewed nodes are appended', () => {
  const flow = JSON.parse(live.toString('utf8'));
  const r = composeGameCreatePreparationLive(live, 'game-create-preparation-live-test');
  assert.deepEqual(r.candidate.slice(0, flow.length), flow);
  assert.equal(r.candidate.length, flow.length + 8);
  validateReviewedFlowContract({ liveBytes: live, candidateBytes: r.candidateBytes, contract: r.contract });
  const routes = (f) => f.filter((n) => n.type === 'http in').map((n) => n.method + ' ' + n.url).sort();
  assert.deepEqual(routes(r.candidate), [...routes(flow), 'post ' + GAME_CREATE_ROUTE].sort());
});

liveTest('LIVE: candidate functions observe every installed station through GETs only', () => {
  const { candidate } = composeGameCreatePreparationLive(live, 'game-create-preparation-live-test');
  for (const station of Object.keys(gameCreateServiceTable)) {
    const h = liveHarness(candidate);
    const r = h.run({ claims: { provider_station_id: station } });
    assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
    assert.equal(r.payload.nonBinding, true);
    assert.equal(r.payload.pricing.quarterPriceMinor * 4, r.payload.pricing.courtWindowPriceMinor);
    assert.ok(h.calls.length > 0 && h.calls.every((c) => c.method === 'GET'));
    assert.ok(!JSON.stringify(r.payload).includes('PRIVATE_PHONE'));
  }
});

liveTest('LIVE: candidate functions stay closed without flags, delegation or admin credential', () => {
  const { candidate } = composeGameCreatePreparationLive(live, 'game-create-preparation-live-test');
  for (const [key, value] of [['BOOKED_OPERATION_EXECUTION_ENABLED', 'false'],
    ['LK1_BOOKED_OPERATION_RECEIVER_ENABLED', undefined], ['LK2_BOOKED_OPERATION_DELEGATION_PUBLIC_KEY_PEM', undefined]]) {
    const h = liveHarness(candidate);
    h.env[key] = value;
    const r = h.run();
    assert.equal(r.statusCode, 503, key);
    assert.equal(h.calls.length, 0, key);
  }
  const h = liveHarness(candidate);
  h.globals = {};
  const r = h.run();
  // Actor-token reads (profile, subscriptions) only; the admin catalogue read never starts.
  assert.equal(r.statusCode, 503);
  assert.deepEqual(h.calls.map((c) => c.step), ['profile', 'subscriptions']);
  const unsigned = liveHarness(candidate);
  const bad = unsigned.run({ request: (msg) => { msg.req.headers['x-subscription-actor-delegation'] = 'a.b.c'; } });
  assert.equal(bad.statusCode, 401);
  assert.equal(unsigned.calls.length, 0);
});

test('signed dot-segment provider ids are refused before any provider read', () => {
  for (const id of ['.', '..', '.hidden']) {
    for (const claim of ['provider_room_id', 'provider_station_id', 'provider_client_id']) {
      const h = new Harness();
      const r = h.run({ claims: { [claim]: id } });
      assert.ok(r.statusCode >= 400 && r.statusCode < 500, claim + '=' + id);
      assert.equal(h.calls.length, 0, claim + '=' + id);
    }
  }
});
