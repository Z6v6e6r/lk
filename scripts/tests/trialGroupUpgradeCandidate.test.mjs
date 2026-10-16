import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import {
  composeTrialGroupUpgradeCandidate, composeTrialGroupPolicyTransition, trialPolicyInitializer,
  trialUpgradeSha256, TRIAL_BOOKING_ID, TRIAL_ROUTER_ID, TRIAL_POLICY_INITIALIZER_ID,
  LEGACY_TRIAL_SOURCE_COMMIT,
} from '../prepare_trial_group_upgrade_candidate.mjs';
import { normalizeTrialGroupPolicy, TRIAL_GROUP_HISTORY_CONTRACT } from '../lib/trialGroupEligibility.mjs';

const head = relative => execFileSync('git', ['show', `${LEGACY_TRIAL_SOURCE_COMMIT}:${relative}`], { encoding: 'utf8' });
const oldPrefix = head('scripts/lib/trialGroupEligibility.mjs').replace(/^export /gm, '') + '\n'
  + head('scripts/nodered_trial_group_nodes/visit_gate.js') + '\n';
const oldCheckout = oldPrefix + head('scripts/nodered_trial_group_nodes/checkout.js');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const policy = { version: 'trial-group-v1', mode: 'enforce', checkoutMode: 'disabled',
  tenantKey: 'iSkq6G', historyContract: TRIAL_GROUP_HISTORY_CONTRACT };
function fixture() {
  const tab = { id: 'tab', type: 'tab', label: 'fixture', disabled: false };
  const ids = ['post', 'entry', 'router', 'http', 'response', 'options', 'cors', 'catch', 'find', 'insert', 'update'];
  const nodes = ids.map((name, index) => ({ id: `lk_trial_group_20261002_${name}`,
    type: name === 'router' ? 'function' : 'fixture', z: 'tab', func: name === 'router' ? oldCheckout : '',
    initialize: '', outputs: 0, wires: [], x: index, y: index }));
  const booking = { id: TRIAL_BOOKING_ID, type: 'function', z: 'tab', func: oldPrefix + 'return [msg];', outputs: 1, wires: [[]] };
  return [tab, booking, ...nodes];
}
function compose(flow = fixture()) {
  const raw = JSON.stringify(flow, null, 2) + '\n';
  const booking = flow.find(row => row.id === TRIAL_BOOKING_ID);
  const router = flow.find(row => row.id === TRIAL_ROUTER_ID);
  return composeTrialGroupUpgradeCandidate(raw, sha(raw), sha(booking.func), sha(router.func), policy);
}
test('upgrade changes only installed sources and adds deterministic policy initializer', () => {
  const { candidate, bytes, contract } = compose();
  const init = candidate.find(row => row.id === TRIAL_POLICY_INITIALIZER_ID);
  assert.equal(init.func, 'return null;'); assert.equal(init.outputs, 0); assert.deepEqual(init.wires, []);
  assert.equal(init.initialize, trialPolicyInitializer(policy));
  assert.match(candidate.find(row => row.id === TRIAL_BOOKING_ID).func, /checkoutMode/);
  assert.match(candidate.find(row => row.id === TRIAL_ROUTER_ID).func, /trial-group-target-v2/);
  assert.equal(trialUpgradeSha256(bytes), contract.candidateSha256);
});
test('source, topology, prefix and public-policy drift are rejected', () => {
  const raw = JSON.stringify(fixture(), null, 2) + '\n';
  const booking = fixture().find(row => row.id === TRIAL_BOOKING_ID);
  const router = fixture().find(row => row.id === TRIAL_ROUTER_ID);
  assert.throws(() => composeTrialGroupUpgradeCandidate(raw, 'wrong', sha(booking.func), sha(router.func), policy), /SHA drift/);
  const badPrefix = fixture(); badPrefix.find(row => row.id === TRIAL_BOOKING_ID).func = 'unexpected';
  const badRaw = JSON.stringify(badPrefix, null, 2) + '\n';
  assert.throws(() => composeTrialGroupUpgradeCandidate(badRaw, sha(badRaw), sha('unexpected'), sha(router.func), policy), /prefix drift/);
  assert.throws(() => trialPolicyInitializer({ ...policy, mode: 'shadow', checkoutMode: 'enabled' }), /safe server policy/);
  assert.throws(() => trialPolicyInitializer({ ...policy, tenantKey: 'bad/key' }), /safe server policy/);
});
test('transition only replaces a pinned initializer and is restart deterministic', () => {
  const upgraded = compose(); const init = upgraded.candidate.find(row => row.id === TRIAL_POLICY_INITIALIZER_ID);
  const next = { ...policy, checkoutMode: 'enabled' };
  const transitioned = composeTrialGroupPolicyTransition(upgraded.bytes, sha(upgraded.bytes), sha(init.initialize), next);
  assert.equal(transitioned.candidate.find(row => row.id === TRIAL_POLICY_INITIALIZER_ID).initialize,
    trialPolicyInitializer(next));
  assert.throws(() => composeTrialGroupPolicyTransition(upgraded.bytes, 'wrong', sha(init.initialize), next), /SHA drift/);
});
test('initializer round-trips every policy mode and reinitializes after restart', () => {
  for (const mode of ['off', 'shadow', 'enforce']) {
    const expected = normalizeTrialGroupPolicy({ ...policy, mode });
    const writes = [];
    const initialize = new Function('global', trialPolicyInitializer({ ...policy, mode }));
    initialize({ set: (key, value) => writes.push([key, value]) });
    initialize({ set: (key, value) => writes.push([key, value]) });
    assert.equal(writes.length, 2);
    assert.equal(writes[0][0], 'trial_group_visit_policy');
    assert.deepEqual(normalizeTrialGroupPolicy(writes[0][1]), expected);
    assert.deepEqual(writes[0], writes[1]);
  }
});
