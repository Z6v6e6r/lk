import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { composeTrialGroupCandidate, trialSha256, TRIAL_BOOKING_ID, TRIAL_ROUTE,
  TRIAL_COLLECTION, writeTrialGroupCandidate } from '../prepare_trial_group_eligibility_candidate.mjs';
import { buildTrialGroupBookingProxy } from '../nginx/trial_group_booking_proxy.mjs';
import { assertNoInstalledTrialGateOverwrite } from '../lib/trialGroupSources.mjs';

const func = fs.readFileSync(new URL('../nodered_subscription_booking_nodes/fn_subscription_booking_router.js', import.meta.url), 'utf8');
const flow = () => [
  { id: 'fixture-tab', type: 'tab', label: 'Fixture' },
  { id: 'fixture-client', type: 'mongodb4-client' },
  { id: TRIAL_BOOKING_ID, z: 'fixture-tab', type: 'function', func, outputs: 7,
    wires: [['fixture-http'], ['lk_subscription_booking_find_20260804'], ['fixture-insert'], ['fixture-update'], ['fixture-final'], [], []] },
  { id: 'lk_subscription_booking_find_20260804', z: 'fixture-tab', type: 'mongodb4', operation: 'find',
    clientNode: 'fixture-client', wires: [[TRIAL_BOOKING_ID]] },
  ...['fixture-http', 'fixture-insert', 'fixture-update', 'fixture-final'].map(id => ({
    id, z: 'fixture-tab', type: 'function', func: 'return msg;', outputs: 1, wires: [[]] })),
];
const compose = rows => { const bytes = Buffer.from(JSON.stringify(rows));
  return composeTrialGroupCandidate(bytes, trialSha256(bytes), trialSha256(func)); };
test('candidate changes only booking function, adds isolated authenticated checkout and reuses Mongo connection', () => {
  const before = flow(); const { candidate, contract } = compose(before);
  for (const row of before.filter(row => row.id !== TRIAL_BOOKING_ID)) {
    assert.deepEqual(candidate.find(node => node.id === row.id), row);
  }
  const routes = candidate.filter(row => row.type === 'http in' && row.url === TRIAL_ROUTE);
  assert.deepEqual(routes.map(row => row.method).sort(), ['options', 'post']);
  const mongo = candidate.filter(row => row.collection === TRIAL_COLLECTION);
  assert.equal(mongo.length, 3);
  assert.ok(mongo.every(row => row.clientNode === 'fixture-client'));
  assert.equal(contract.allowedAdditions.length, 11);
  const router = candidate.find(row => row.id.endsWith('_router') && row.id !== TRIAL_BOOKING_ID);
  assert.match(router.func, /trial_group_visit_policy/);
  assert.doesNotMatch(JSON.stringify(candidate), /Bearer\s+[A-Za-z0-9._-]{20,}/);
});
test('source hash, booking preimage, route conflicts and topology drift block composition', () => {
  const rows = flow(); const raw = Buffer.from(JSON.stringify(rows));
  assert.throws(() => composeTrialGroupCandidate(raw, 'wrong', trialSha256(func)), /source SHA drift/);
  assert.throws(() => composeTrialGroupCandidate(raw, trialSha256(raw), 'wrong'), /topology drift/);
  for (const mutate of [f => f.push({ id: 'conflict', type: 'http in', url: TRIAL_ROUTE }),
    f => f.find(row => row.id === TRIAL_BOOKING_ID).outputs = 6,
    f => f.find(row => row.type === 'mongodb4').clientNode = 'other',
    f => f.find(row => row.type === 'tab').disabled = true]) {
    const copy = flow(); mutate(copy); assert.throws(() => compose(copy), /drift|conflict/);
  }
  assert.throws(() => compose(compose(rows).candidate), /drift|already installed/);
});
test('CLI writer never substitutes a stale local snapshot for verified fresh live origin', () => {
  assert.throws(() => writeTrialGroupCandidate('/private/tmp/does-not-exist-trial-fixture', '/private/tmp/trial-output-fixture', 'wrong', 'wrong'));
});
test('canonical gateway regeneration cannot erase an installed trial rule', () => {
  assertNoInstalledTrialGateOverwrite(flow());
  assert.throws(() => assertNoInstalledTrialGateOverwrite(compose(flow()).candidate), /must be preserved/);
});
test('nginx candidate is exact, idempotent, disables POST retries and exposes only POST/OPTIONS', () => {
  const source = 'server {\n    location ^~ /lk/ {\n        alias /var/www/html/lk/;\n    }\n}\n';
  const first = buildTrialGroupBookingProxy(source, trialSha256(source));
  assert.match(first.candidate, /location = \/lk\/trial-group-bookings/);
  assert.match(first.candidate, /proxy_next_upstream off;/);
  assert.match(first.candidate, /Access-Control-Allow-Methods "POST, OPTIONS"/);
  assert.equal(buildTrialGroupBookingProxy(first.candidate, first.candidateSha).changed, false);
  assert.throws(() => buildTrialGroupBookingProxy(source, 'wrong'), /SHA mismatch/);
  const conflict = source.replace('server {', 'server {\nlocation = /lk/trial-group-bookings { return 418; }');
  assert.throws(() => buildTrialGroupBookingProxy(conflict, trialSha256(conflict)), /unmanaged/);
});
