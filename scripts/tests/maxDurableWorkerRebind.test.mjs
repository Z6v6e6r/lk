import assert from 'node:assert/strict';
import test from 'node:test';
import { durableGraphFixture, durablePins } from './fixtures/max-durable-queue.mjs';
import { MAX_OUTBOX_RESUME_TOPOLOGY as routes, sha256 } from '../nodered_max_outbox_resume.mjs';
import { buildMaxDurableTransition } from '../nodered_max_durable_release.mjs';
import { buildMaxDurableWorkerRebind, MAX_DURABLE_WORKER_BASELINE_FILES as files } from '../nodered_max_durable_worker_rebind.mjs';
import { MAX_OUTBOX_WORKER_BASELINE_FILES } from '../nodered_max_outbox_worker_rebind.mjs';
const guard = 'lib/lk1LiveGatewayGuard.mjs', gateway = 'lk_subscription_booking_router_20260804';
function manifest(input) {
  input.baselineManifestBytes = Buffer.from(JSON.stringify({ schema: 1, sourceCommit: input.trustedBaseline.sourceCommit,
    files: Object.fromEntries([...input.baselineFiles].map(([k, v]) => [k, sha256(v)])) }) + '\n');
  input.trustedBaseline.manifestSha256 = sha256(input.baselineManifestBytes);
  input.trustedBaseline.guardSha256 = sha256(input.baselineFiles.get(guard));
}
function fixture() {
  const flow = durableGraphFixture(); flow.push({ id: gateway, type: 'function', z: routes[0].tab, func: 'return msg;', wires: [[]] });
  const beforeFlow = Buffer.from(JSON.stringify(flow, null, 4));
  const baselineFiles = new Map(files.map(f => [f, Buffer.from('synthetic baseline ' + f)]));
  baselineFiles.set(guard, Buffer.from('// Синтетический preamble\n'
    + `export const LK1_UNPAID_FLOW_SHA256 = '${sha256(beforeFlow)}';\n`
    + `export const LK1_UNPAID_GATEWAY_SHA256 = '${sha256('return msg;')}';\n`));
  const input = { beforeFlow, trustedNrPins: durablePins(beforeFlow), baselineFiles,
    trustedBaseline: { sourceCommit: 'a'.repeat(40) }, publishingSourceCommit: 'b'.repeat(40) };
  manifest(input); return input;
}
test('forward and paused-recovery worker bindings retain exact13-file closure and change only64 ASCII guard bytes', () => {
  assert.deepEqual(files, MAX_OUTBOX_WORKER_BASELINE_FILES);
  const input = fixture(), saved = structuredClone(input);
  const paused = buildMaxDurableTransition(input.beforeFlow, input.trustedNrPins, 'pause');
  const pausedRaw = JSON.stringify(paused.flow, null, 4);
  const active = buildMaxDurableTransition(pausedRaw, durablePins(pausedRaw), 'activate');
  for (const purpose of ['forward', 'paused-recovery']) {
    const result = buildMaxDurableWorkerRebind({ ...input, purpose });
    const expected = sha256(purpose === 'forward' ? JSON.stringify(active.flow, null, 4) : pausedRaw);
    assert.equal(result.provenance.nativeDiskSha256, expected);
    assert.equal(result.provenance.pausedNativeDiskSha256, sha256(pausedRaw));
    assert.equal(result.provenance.gatewayUnchanged, true);
    assert.deepEqual(result.provenance.changedFiles, [guard]);
    for (const file of files) if (file !== guard) assert(result.candidateFiles.get(file).equals(input.baselineFiles.get(file)));
    const before = input.baselineFiles.get(guard), after = result.candidateFiles.get(guard);
    assert.equal(before.length, after.length);
    assert.equal(after.toString().replace(expected, sha256(input.beforeFlow)), before.toString());
    result.candidateFiles.get(files[0]).fill(0); assert.deepEqual(structuredClone(input), saved, 'Returned buffers cannot alias baseline');
  }
});
test('baseline pins, full file closure, publishing identity and exact constant shapes reject drift', () => {
  const invalid = [
    i => { i.trustedBaseline.manifestSha256 = '0'.repeat(64); },
    i => { i.trustedBaseline.guardSha256 = '0'.repeat(64); },
    i => { i.publishingSourceCommit = i.trustedBaseline.sourceCommit; },
    i => { i.baselineFiles.delete(files[0]); },
    i => { i.baselineFiles.set('foreign', Buffer.from('x')); manifest(i); },
    i => { i.baselineFiles.set(files[0], Buffer.from('changed')); },
    i => { i.baselineFiles.set(guard, Buffer.from(i.baselineFiles.get(guard).toString().replace("export const LK1_UNPAID_FLOW_SHA256", 'const LK1_UNPAID_FLOW_SHA256'))); manifest(i); },
    i => { i.baselineFiles.set(guard, Buffer.concat([i.baselineFiles.get(guard), Buffer.from("export const LK1_UNPAID_FLOW_SHA256 = '" + 'c'.repeat(64) + "';\n")])); manifest(i); }
  ];
  for (const mutate of invalid) { const i = fixture(); mutate(i); assert.throws(() => buildMaxDurableWorkerRebind(i)); }
});
test('scope/bot drift, gateway mismatch and source already paused cannot be blessed by recomputing superficial pins', () => {
  const mutations = [
    f => { f.find(n => n.id === gateway).func += '\nreturn null;'; },
    f => { f.find(n => n.id === gateway).d = true; },
    f => { f.find(n => n.id === routes[0].newSender).bot = routes[1].bot; },
    f => { for (const r of routes) f.find(n => n.id === r.poller).d = true; }
  ];
  for (const mutate of mutations) {
    const i = fixture(), old = sha256(i.beforeFlow), flow = JSON.parse(i.beforeFlow); mutate(flow);
    i.beforeFlow = Buffer.from(JSON.stringify(flow, null, 4)); i.trustedNrPins = durablePins(i.beforeFlow);
    i.baselineFiles.set(guard, Buffer.from(i.baselineFiles.get(guard).toString().replace(old, sha256(i.beforeFlow)))); manifest(i);
    assert.throws(() => buildMaxDurableWorkerRebind(i));
  }
});
