import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { buildCounterEpochCandidate, buildCounterEpochInitializer, counterEpochTargets } from '../prepare_subscription_counter_epoch_candidate.mjs';
import { syncCounterEpoch } from '../sync_subscription_counter_epoch.mjs';
import { syncAnnualHistory } from '../sync_annual_subscription_history.mjs';
const binding = JSON.parse(fs.readFileSync(new URL('../subscription_counter_epoch_binding.json', import.meta.url)));
const texts = Object.fromEntries(counterEpochTargets.map(t => [t.file, fs.readFileSync(new URL(`../nodered_games_nodes/${t.file}`, import.meta.url), 'utf8')]));
test('epoch candidate binds all current source files and generated helpers', () => {
  syncCounterEpoch({ check: true }); syncAnnualHistory({ check: true });
  for (const t of binding.targets) assert.equal(createHash('sha256').update(texts[t.file]).digest('hex'), t.sourceTextSha256, t.file);
  assert.equal(binding.targets.length, 11);
  assert.throws(() => buildCounterEpochCandidate({ liveBytes: Buffer.from('[]'), sourceTexts: texts, binding }), /preimage drift/);
});
const fixture = process.env.COUNTER_EPOCH_LIVE_FIXTURE;
test('fresh private flow composes exactly, preserves parallel booking change and reverses structurally', { skip: !fixture }, () => {
  const liveBytes = fs.readFileSync(fixture), result = buildCounterEpochCandidate({ liveBytes, sourceTexts: texts, binding });
  const before = JSON.parse(liveBytes), after = JSON.parse(result.candidateBytes), touched = new Set(binding.targets.map(t => t.id));
  for (const n of before) if (!touched.has(n.id)) assert.deepEqual(after.find(x => x.id === n.id), n);
  assert.equal(result.report.structuralReverseCheckPassed, true);
  assert.equal(result.report.deploymentPerformed, false); assert.equal(result.report.activationPerformed, false);
  assert.equal(before.length, after.length);
  const atomic = after.find(n => n.id === 'piter_atomic_router_20260903');
  const store = new Map(), global = { get: k => store.get(k), set: (k,v) => store.set(k,v) };
  const config = { kind: 'SUBSCRIPTION_SALES_CONFIGURATION_V2', revision: 2, epochStartedAt: '2026-09-10T10:00:00.000Z',
    common: false, hub: false, piter: false, raClosed: false, friendshipClosed: false };
  new Function('global', 'env', atomic.initialize)(global, { get: () => JSON.stringify(config) });
  assert.deepEqual(global.get('subscriptions_lk1_hub_sale_runtime'), binding.hubEvidence.receipt);
  assert.equal(global.get('subscription_counter_epoch_started_at'), config.epochStartedAt);
  assert.equal(global.get('summer_subscription_sales_20260909_enabled'), false);
  assert.deepEqual(global.get('subscription_sales_configuration_attestation').configuration, config);
  assert.throws(() => buildCounterEpochCandidate({ liveBytes, sourceTexts: { ...texts, [binding.targets[0].file]: texts[binding.targets[0].file] + '\n' }, binding }), /binding drift/);
  const bad = structuredClone(binding); bad.hubEvidence.receipt.sourceDigest = 'sha256:' + 'a'.repeat(64);
  assert.throws(() => buildCounterEpochCandidate({ liveBytes, sourceTexts: texts, binding: bad }), /binding drift/);
  assert.throws(() => buildCounterEpochInitializer('', binding.hubEvidence.receipt), /preimage invalid/);
  assert.throws(() => buildCounterEpochInitializer(atomic.initialize + atomic.initialize, binding.hubEvidence.receipt), /preimage invalid/);
});
