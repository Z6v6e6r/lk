import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {
  assertLiveAttestationFacts,
  composeProviderAccountAttestationLive,
  ATTESTATION_LIVE_SOURCE_SHA256,
} from '../prepare_provider_account_attestation_live.mjs';
import {
  composeProviderAccountAttestation,
  providerAccountAttestationGameIds as gameIds,
  providerAccountAttestationIds as ids,
  PROVIDER_ACCOUNT_ROUTE,
} from '../patch_nodered_provider_account_attestation.mjs';
import { validateReviewedFlowContract } from '../nodered_reviewed_flow_deploy/runtime_contract.mjs';

const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const syntheticLive = () => [
  { id: 'tab_lk1', type: 'tab', label: 'LK1', disabled: false },
  { id: 'lk_booked_operation_admission_in_20261021', type: 'http in', z: 'tab_lk1',
    url: '/lk/integrations/v1/booked-operation-admissions', method: 'post', wires: [[]] },
  { id: 'param', type: 'http in', z: 'tab_lk1', url: '/lk/integrations/v1/station-memberships/operations/:operationId/',
    method: 'post', wires: [[]] },
  { id: 'gw', type: 'function', z: 'tab_lk1', func: 'const LK1_OVERLAY_HUB_PRODUCT_ID = "db7a5250-7369-4f43-8ac5-9111be24bc74";', wires: [[]] },
  { id: 'own', type: 'function', z: 'tab_lk1', func: 'const MANAGED_ENFORCEMENT_PURCHASE_FROM = "2026-09-01";', wires: [[]] },
  { id: '4e820638cc39c730', type: 'mongodb4-client', name: '', dbName: 'games' },
];
// The graph as installed by #305: the attestation tab (nine nodes) with the previous bodies.
const installedLive = (remainder = syntheticLive()) => {
  const r = composeProviderAccountAttestation(bytesOf(remainder), 'installed');
  const installed = r.candidate.slice(remainder.length, remainder.length + Object.keys(ids).length);
  for (const n of installed) if (n.type === 'function') n.func = 'return [null, msg]; // previous ' + n.id;
  const router = installed.find((n) => n.id === ids.router);
  router.outputs = 2;
  router.wires = router.wires.slice(0, 2);
  return [...remainder, ...installed];
};
const bytesOf = (flow) => Buffer.from(JSON.stringify(flow, null, 2) + '\n');

test('upgrade replaces only the reviewed fields of the installed nodes and appends the game lookup', () => {
  const flow = installedLive();
  const bytes = bytesOf(flow);
  const r = composeProviderAccountAttestationLive(bytes, 'provider-account-attestation-synthetic', sha(bytes));
  const remainder = syntheticLive();
  assert.deepEqual(r.candidate.slice(0, remainder.length), remainder);
  assert.deepEqual(r.candidate.slice(remainder.length).map((n) => n.id), [...Object.values(ids), ...Object.values(gameIds)]);
  assert.deepEqual(r.contract.allowedChanges.map((c) => [c.id, c.fields]).sort(), [
    [ids.probe, ['func']], [ids.router, ['func', 'outputs', 'wires']], [ids.sanitize, ['func']], [ids.verify, ['func']]].sort());
  assert.deepEqual([...r.contract.allowedAdditions.map((a) => a.id)].sort(), Object.values(gameIds).sort());
});

test('upgrade refuses unexpected installed drift, a missing node or a missing games client', () => {
  const drift = installedLive();
  drift.find((n) => n.id === ids.http).requestTimeout = '60000';
  assert.throws(() => composeProviderAccountAttestationLive(bytesOf(drift), 'provider-account-attestation-x', sha(bytesOf(drift))), /ATTESTATION_LIVE_UNEXPECTED_CHANGE/);
  const missing = installedLive().filter((n) => n.id !== ids.probe);
  assert.throws(() => composeProviderAccountAttestationLive(bytesOf(missing), 'provider-account-attestation-x', sha(bytesOf(missing))), /ATTESTATION_LIVE_INSTALLED_SHAPE_INVALID/);
  const noClient = installedLive(syntheticLive().filter((n) => n.id !== '4e820638cc39c730'));
  assert.throws(() => composeProviderAccountAttestationLive(bytesOf(noClient), 'provider-account-attestation-x', sha(bytesOf(noClient))), /ATTESTATION_LIVE_GAMES_CLIENT_MISSING/);
  const otherDb = installedLive(syntheticLive().map((n) => n.id === '4e820638cc39c730' ? { ...n, dbName: 'games_chat' } : n));
  assert.throws(() => composeProviderAccountAttestationLive(bytesOf(otherDb), 'provider-account-attestation-x', sha(bytesOf(otherDb))), /ATTESTATION_LIVE_GAMES_CLIENT_MISSING/);
});

test('whole-flow preimage is pinned', () => {
  assert.equal(ATTESTATION_LIVE_SOURCE_SHA256.length, 64);
  assert.throws(() => composeProviderAccountAttestationLive(bytesOf(installedLive()), 'x'), /ATTESTATION_LIVE_PREIMAGE_DRIFT/);
});

test('receiver boundary must exist and be active', () => {
  const none = syntheticLive().filter((n) => n.id !== 'lk_booked_operation_admission_in_20261021');
  assert.throws(() => assertLiveAttestationFacts(none), /ATTESTATION_LIVE_RECEIVER_MISSING/);
  const off = syntheticLive();
  off[1].d = true;
  assert.throws(() => assertLiveAttestationFacts(off), /ATTESTATION_LIVE_RECEIVER_MISSING/);
});

test('installed HUB pins must equal the compiled rule', () => {
  for (const [id, func] of [['gw', 'const LK1_OVERLAY_HUB_PRODUCT_ID = "6b98e7e3-5bd3-4e94-9dc3-7723ea52513e";'],
    ['own', 'const MANAGED_ENFORCEMENT_PURCHASE_FROM = "2026-10-01";']]) {
    const flow = syntheticLive();
    flow.find((n) => n.id === id).func = func;
    assert.throws(() => assertLiveAttestationFacts(flow), /ATTESTATION_LIVE_RULE_PIN_DRIFT/, id);
  }
  assert.throws(() => assertLiveAttestationFacts(syntheticLive().filter((n) => n.id !== 'gw')), /ATTESTATION_LIVE_RULE_PIN_DRIFT/);
  for (const func of ["let LK1_OVERLAY_HUB_PRODUCT_ID = '6b98e7e3-5bd3-4e94-9dc3-7723ea52513e';",
    'var MANAGED_ENFORCEMENT_PURCHASE_FROM = "2026-10-01";']) {
    const flow = [...syntheticLive(), { id: 'other', type: 'function', z: 'tab_lk1', func, wires: [[]] }];
    assert.throws(() => assertLiveAttestationFacts(flow), /ATTESTATION_LIVE_RULE_PIN_DRIFT/, func);
  }
});

test('an earlier parameter, wildcard, case or slash variant route refuses (it would receive the tokens)', () => {
  for (const [url, method] of [['/lk/integrations/v1/:resource', 'post'], ['/lk/integrations/*', 'get'],
    [PROVIDER_ACCOUNT_ROUTE + '/', 'post'], [PROVIDER_ACCOUNT_ROUTE.toUpperCase(), 'get'], ['lk/integrations/v1/:x', 'all'],
    ['/lk/integrations/v1/:x?', 'use']]) {
    const flow = [...syntheticLive(), { id: 'shadow', type: 'http in', z: 'tab_lk1', url, method, wires: [[]] }];
    assert.throws(() => assertLiveAttestationFacts(flow), /ATTESTATION_LIVE_ROUTE_SHADOWED/, url + ' ' + method);
  }
  for (const url of ['/lk/integrations/v1/provider-:kind', '/lk/integrations/v1/provider-account-attestation(s)?',
    '/lk/integrations/v1/provider-accoun+t-attestations']) {
    const flow = [...syntheticLive(), { id: 'shadow', type: 'http in', z: 'tab_lk1', url, method: 'post', wires: [[]] }];
    assert.throws(() => assertLiveAttestationFacts(flow), /ATTESTATION_LIVE_ROUTE_SHADOWED/, url);
  }
  const putOnly = [...syntheticLive(), { id: 'put', type: 'http in', z: 'tab_lk1', url: '/lk/integrations/v1/:x', method: 'put', wires: [[]] }];
  assert.doesNotThrow(() => assertLiveAttestationFacts(putOnly));
});

const fixture = process.env.LK1_ATTESTATION_LIVE_FLOW_FIXTURE;
const live = fixture ? fs.readFileSync(fixture) : null;
const liveTest = (name, fn) => test(name, { skip: live ? false : 'LK1_ATTESTATION_LIVE_FLOW_FIXTURE not set' }, fn);

liveTest('LIVE: only the four attestation bodies and the router wiring change; two lookup nodes appended', () => {
  const flow = JSON.parse(live.toString('utf8'));
  const r = composeProviderAccountAttestationLive(live, 'provider-account-attestation-live-test');
  const keep = flow.filter((n) => !Object.values(ids).includes(n.id));
  assert.deepEqual(r.candidate.slice(0, keep.length), keep);
  assert.equal(r.candidate.length, flow.length + 2);
  validateReviewedFlowContract({ liveBytes: live, candidateBytes: r.candidateBytes, contract: r.contract });
  const routes = (f) => f.filter((n) => n.type === 'http in').map((n) => n.method + ' ' + n.url).sort();
  assert.deepEqual(routes(r.candidate), routes(flow));
  assert.equal(r.contract.allowedChanges.length, 4);
});

liveTest('LIVE: outside the attestation tab no node reads the attestation flag or replay key', () => {
  const flow = JSON.parse(live.toString('utf8')).filter((n) => !Object.values(ids).includes(n.id));
  const text = JSON.stringify(flow);
  assert.ok(!text.includes('LK1_PROVIDER_ACCOUNT_ATTESTATION_ENABLED'));
  assert.ok(!text.includes('providerAccountAttestationSeen'));
});
