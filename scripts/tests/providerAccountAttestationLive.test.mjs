import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {
  assertLiveAttestationFacts,
  composeProviderAccountAttestationLive,
  ATTESTATION_LIVE_SOURCE_SHA256,
} from '../prepare_provider_account_attestation_live.mjs';
import { providerAccountAttestationIds as ids, PROVIDER_ACCOUNT_ROUTE } from '../patch_nodered_provider_account_attestation.mjs';
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
];
const bytesOf = (flow) => Buffer.from(JSON.stringify(flow, null, 2) + '\n');

test('synthetic installed graph composes one additive suffix with an exact contract', () => {
  const flow = syntheticLive();
  const bytes = bytesOf(flow);
  const r = composeProviderAccountAttestationLive(bytes, 'provider-account-attestation-synthetic', sha(bytes));
  assert.deepEqual(r.candidate.slice(0, flow.length), flow);
  assert.deepEqual(r.candidate.slice(flow.length).map((n) => n.id), Object.values(ids));
  assert.deepEqual(r.contract.allowedChanges, []);
});

test('whole-flow preimage is pinned', () => {
  assert.equal(ATTESTATION_LIVE_SOURCE_SHA256.length, 64);
  assert.throws(() => composeProviderAccountAttestationLive(bytesOf(syntheticLive()), 'x'), /ATTESTATION_LIVE_PREIMAGE_DRIFT/);
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
});

test('an earlier parameter, wildcard, case or slash variant route refuses (it would receive the tokens)', () => {
  for (const [url, method] of [['/lk/integrations/v1/:resource', 'post'], ['/lk/integrations/*', 'get'],
    [PROVIDER_ACCOUNT_ROUTE + '/', 'post'], [PROVIDER_ACCOUNT_ROUTE.toUpperCase(), 'get'], ['lk/integrations/v1/:x', 'all'],
    ['/lk/integrations/v1/:x?', 'use']]) {
    const flow = [...syntheticLive(), { id: 'shadow', type: 'http in', z: 'tab_lk1', url, method, wires: [[]] }];
    assert.throws(() => assertLiveAttestationFacts(flow), /ATTESTATION_LIVE_ROUTE_SHADOWED/, url + ' ' + method);
  }
  const putOnly = [...syntheticLive(), { id: 'put', type: 'http in', z: 'tab_lk1', url: '/lk/integrations/v1/:x', method: 'put', wires: [[]] }];
  assert.doesNotThrow(() => assertLiveAttestationFacts(putOnly));
});

const fixture = process.env.LK1_ATTESTATION_LIVE_FLOW_FIXTURE;
const live = fixture ? fs.readFileSync(fixture) : null;
const liveTest = (name, fn) => test(name, { skip: live ? false : 'LK1_ATTESTATION_LIVE_FLOW_FIXTURE not set' }, fn);

liveTest('LIVE: installed graph is unchanged and only the reviewed nodes are appended', () => {
  const flow = JSON.parse(live.toString('utf8'));
  const r = composeProviderAccountAttestationLive(live, 'provider-account-attestation-live-test');
  assert.deepEqual(r.candidate.slice(0, flow.length), flow);
  assert.equal(r.candidate.length, flow.length + Object.keys(ids).length);
  validateReviewedFlowContract({ liveBytes: live, candidateBytes: r.candidateBytes, contract: r.contract });
  const routes = (f) => f.filter((n) => n.type === 'http in').map((n) => n.method + ' ' + n.url).sort();
  assert.deepEqual(routes(r.candidate), [...routes(flow), 'get ' + PROVIDER_ACCOUNT_ROUTE, 'post ' + PROVIDER_ACCOUNT_ROUTE].sort());
});

liveTest('LIVE: no installed node reads or sets the attestation flag or replay key', () => {
  const text = live.toString('utf8');
  assert.ok(!text.includes('LK1_PROVIDER_ACCOUNT_ATTESTATION_ENABLED'));
  assert.ok(!text.includes('providerAccountAttestationSeen'));
});
