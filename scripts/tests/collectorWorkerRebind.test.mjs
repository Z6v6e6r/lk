import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildCollectorWorkerRebind, buildCollectorWorkerInverse, COLLECTOR_WORKER_BASELINE_FILES as FILES } from '../diagnostics/collector-worker-rebind.mjs';
import { buildCollectorCandidate } from '../diagnostics/split-leave-collector.mjs';
import { graph } from './splitLeaveCollector.test.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const GUARD = 'lib/lk1LiveGatewayGuard.mjs';
function fixture() {
  const flow = [...graph(), { id: 'lk_subscription_booking_router_20260804', z: 'tab', type: 'function', func: 'return msg;', wires: [[]] }];
  const beforeFlow = Buffer.from(JSON.stringify(flow, null, 4));
  const baselineFiles = new Map(FILES.map(file => [file, Buffer.from('synthetic-immutable-business:' + file)]));
  baselineFiles.set('verify_bundle.mjs', Buffer.from(`export const BUNDLE_FILES = [\n${FILES.map(file => `  '${file}',`).join('\n')}\n];\n`));
  baselineFiles.set(GUARD, Buffer.from(`export const LK1_UNPAID_FLOW_SHA256 = '${sha(beforeFlow)}';\nexport const LK1_UNPAID_GATEWAY_SHA256 = '${sha('return msg;')}';\n// unchanged binding, mtime, tenant, cursor and payment policy\n`));
  const sourceCommit = 'b'.repeat(40), manifest = { schema: 1, sourceCommit, files: Object.fromEntries([...baselineFiles].map(([file, bytes]) => [file, sha(bytes)])) };
  const baselineManifestBytes = Buffer.from(JSON.stringify(manifest)), collectorRelease = 'a'.repeat(40), routeHash = sha(JSON.stringify(flow[1]));
  const candidate = buildCollectorCandidate(flow, { release: collectorRelease, routeHash });
  return { beforeFlow, baselineFiles, baselineManifestBytes, publishingSourceCommit: 'c'.repeat(40), collectorRelease, routeHash,
    expectedCandidateSha256: sha(Buffer.from(JSON.stringify(candidate.candidate, null, 2) + '\n')),
    trustedBaseline: { manifestSha256: sha(baselineManifestBytes), sourceCommit, guardSha256: sha(baselineFiles.get(GUARD)) } };
}
test('worker rebind changes only the full-flow digest bytes and preserves the complete 13-file business closure', () => {
  const input = fixture(), snapshots = new Map([...input.baselineFiles].map(([key, bytes]) => [key, Buffer.from(bytes)]));
  const result = buildCollectorWorkerRebind(input);
  assert.deepEqual(result.provenance.changedFiles, [GUARD]); assert.equal(result.provenance.unchangedFileCount, 12);
  assert.deepEqual(result.provenance.flowChangedIds, ['17cd943f9a72e572']);
  assert.deepEqual(result.provenance.flowAddedIds, ['diag_ingest_17cd943f9a72e572']);
  for (const [file, bytes] of snapshots) {
    assert.deepEqual(input.baselineFiles.get(file), bytes);
    if (file !== GUARD) assert.deepEqual(result.candidateFiles.get(file), bytes);
  }
  const old = input.baselineFiles.get(GUARD).toString(), next = result.candidateFiles.get(GUARD).toString();
  assert.equal(next.replace(result.provenance.nativeDiskSha256, sha(input.beforeFlow)), old);
  assert.deepEqual(Object.keys(result.candidateManifest), ['schema', 'sourceCommit', 'files']);
  assert.equal(result.provenance.gatewayUnchanged, true);
});
test('native inverse keeps business bytes and restores the matching native source flow pin', () => {
  const input = fixture(), inverse = buildCollectorWorkerInverse(input);
  for (const [file, bytes] of input.baselineFiles) assert.deepEqual(inverse.candidateFiles.get(file), bytes);
  assert.equal(inverse.provenance.nativeDiskSha256, sha(input.beforeFlow));
  assert.equal(inverse.provenance.schema, 'PHAB_COLLECTOR_WORKER_NATIVE_INVERSE_V1');
});
for (const [name, mutate] of [
  ['candidate', input => { input.expectedCandidateSha256 = '0'.repeat(64); }],
  ['manifest', input => { input.baselineManifestBytes = Buffer.from('{}'); }],
  ['guard', input => { input.trustedBaseline.guardSha256 = '0'.repeat(64); }],
  ['extra payload', input => { input.baselineFiles.set('secrets.env', Buffer.from('synthetic')); }],
  ['missing payload', input => { input.baselineFiles.delete('lib/lk1UnpaidScanCursor.mjs'); }],
  ['changed business', input => { input.baselineFiles.set('run_lk1_unpaid_booking_cancellation.mjs', Buffer.from('changed')); }],
]) test(`worker rebind refuses ${name} without modifying inputs`, () => {
  const input = fixture(); mutate(input); assert.throws(() => buildCollectorWorkerRebind(input));
});

test('worker rebind rejects a self-consistent manifest with an older verifier closure', () => {
  const input = fixture();
  input.baselineFiles.set('verify_bundle.mjs', Buffer.from("export const BUNDLE_FILES = ['package.json'];\n"));
  const manifest = JSON.parse(input.baselineManifestBytes);
  manifest.files['verify_bundle.mjs'] = sha(input.baselineFiles.get('verify_bundle.mjs'));
  input.baselineManifestBytes = Buffer.from(JSON.stringify(manifest));
  input.trustedBaseline.manifestSha256 = sha(input.baselineManifestBytes);
  assert.throws(() => buildCollectorWorkerRebind(input), /VERIFIER_FILESET_MISMATCH/);
});
