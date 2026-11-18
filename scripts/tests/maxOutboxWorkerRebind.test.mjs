import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  buildMaxOutboxOnlyResume, MAX_OUTBOX_RESUME_TOPOLOGY as routes,
  MAX_OUTBOX_RESUME_REQUIRED_IDS, nodeSha256, sha256,
} from '../nodered_max_outbox_resume.mjs';
import {
  buildMaxOutboxWorkerRebind, buildMaxOutboxWorkerInverse, MAX_OUTBOX_WORKER_BASELINE_FILES as files,
} from '../nodered_max_outbox_worker_rebind.mjs';

const GUARD = 'lib/lk1LiveGatewayGuard.mjs';
const GATEWAY = 'lk_subscription_booking_router_20260804';
const baselineCommit = 'a'.repeat(40), publishingCommit = 'b'.repeat(40);
const byId = (flow, id) => flow.find((node) => node.id === id);
const nrPins = (source) => {
  const flow = JSON.parse(source);
  return { flowSha256: sha256(source), nodeSha256: Object.fromEntries(
    MAX_OUTBOX_RESUME_REQUIRED_IDS.map((id) => [id, nodeSha256(byId(flow, id))]),
  ) };
};
function flowFixture() {
  const flow = [];
  for (const r of routes) {
    const add = (id, type, extra = {}) => flow.push({ id, type, z: r.tab, wires: [], ...extra });
    add(r.tab, 'tab'); add(r.bot, 'maxbot-config', { opaqueSyntheticConfig: 'unchanged' });
    add(r.sender, 'maxbot-send', { bot: r.bot, d: true, wires: [[r.sendDebug, r.ack]] });
    add(r.receiver, 'maxbot-receive', { bot: r.bot, d: true });
    add(r.callback, 'function', { d: true, func: 'return msg;' });
    add(r.poller, 'inject', { d: true, wires: [[r.pull]] });
    add(r.pull, 'function', { func: `msg.url = "/support/outbox/pull?connector=${r.connector}&limit=10";`, wires: [[r.http]] });
    add(r.http, 'http request', { wires: [[r.parse]] });
    add(r.parse, 'function', { func: 'return [msg, null];', wires: [[r.split], [r.error]] });
    add(r.split, 'split', { wires: [[r.dispatch]] });
    add(r.dispatch, 'function', { outputs: 2, func: 'return [msg, null];', wires: [[r.sender], [r.error]] });
    add(r.error, 'debug'); add(r.sendDebug, 'debug'); add(r.ack, 'function', { func: 'return msg;' });
  }
  flow.push({ id: GATEWAY, type: 'function', z: routes[0].tab,
    func: '// Synthetic unchanged business gateway\nreturn msg;', wires: [[]] });
  return flow;
}
function refreshManifest(input) {
  input.baselineManifestBytes = Buffer.from(JSON.stringify({ schema: 1,
    sourceCommit: input.trustedBaseline.sourceCommit,
    files: Object.fromEntries([...input.baselineFiles].map(([file, bytes]) => [file, sha256(bytes)])),
  }, null, 2) + '\n');
  input.trustedBaseline.manifestSha256 = sha256(input.baselineManifestBytes);
  input.trustedBaseline.guardSha256 = sha256(input.baselineFiles.get(GUARD));
}
function fixture() {
  const flow = flowFixture();
  const beforeFlow = Buffer.from(JSON.stringify(flow, null, 4));
  const baselineFiles = new Map(files.map((file) => [file, Buffer.from(`synthetic baseline ${file}\n`)]));
  baselineFiles.set(GUARD, Buffer.from(
    `// Синтетический UTF-8 preamble: byte offsets must remain correct.\n`
    + `export const LK1_UNPAID_FLOW_SHA256 = '${sha256(beforeFlow)}';\n`
    + `export const LK1_UNPAID_GATEWAY_SHA256 = '${sha256(byId(flow, GATEWAY).func)}';\n`
    + 'export function unchangedBusinessGuard() { return LK1_UNPAID_FLOW_SHA256; }\n',
  ));
  const input = { beforeFlow, trustedNrPins: nrPins(beforeFlow), baselineFiles,
    trustedBaseline: { sourceCommit: baselineCommit }, publishingSourceCommit: publishingCommit };
  refreshManifest(input);
  return input;
}
function changeGuard(input, mutate) {
  input.baselineFiles.set(GUARD, Buffer.from(mutate(input.baselineFiles.get(GUARD).toString())));
  refreshManifest(input);
}
function changeFlow(input, mutate) {
  const oldSha = sha256(input.beforeFlow), flow = JSON.parse(input.beforeFlow);
  mutate(flow);
  input.beforeFlow = Buffer.from(JSON.stringify(flow, null, 4));
  input.trustedNrPins = nrPins(input.beforeFlow);
  changeGuard(input, (text) => text.replace(oldSha, sha256(input.beforeFlow)));
}

test('native inverse worker binds the restored graph encoding rather than old installer bytes', () => {
  const input = fixture(), originalHash = sha256(input.beforeFlow);
  input.beforeFlow = Buffer.from(JSON.stringify(JSON.parse(input.beforeFlow), null, 2) + '\n');
  input.trustedNrPins = nrPins(input.beforeFlow);
  changeGuard(input, text => text.replace(originalHash, sha256(input.beforeFlow)));
  const before = structuredClone(input);
  const result = buildMaxOutboxWorkerInverse(input);
  const nativeHash = sha256(JSON.stringify(JSON.parse(input.beforeFlow), null, 4));
  assert.notEqual(nativeHash, sha256(input.beforeFlow));
  assert.equal(result.provenance.nativeDiskSha256, nativeHash);
  assert.equal(result.provenance.gatewayUnchanged, true);
  assert.deepEqual(result.provenance.flowAddedIds, []);
  assert.equal(result.provenance.flowRemovedIds.length, 2);
  assert.deepEqual(result.provenance.changedFiles, [GUARD]);
  for (const file of files) {
    const expected = file === GUARD ? Buffer.from(input.baselineFiles.get(file).toString().replace(sha256(input.beforeFlow), nativeHash)) : input.baselineFiles.get(file);
    assert.ok(result.candidateFiles.get(file).equals(expected));
    assert.equal(result.candidateManifest.files[file], sha256(expected));
    assert.ok(input.baselineFiles.get(file).equals(Buffer.from(before.baselineFiles.get(file))));
  }
  assert.equal(result.candidateManifestSha256, sha256(result.candidateManifestBytes));
});

test('already-native baseline inverse preserves all payload bytes and still rejects untrusted baselines', () => {
  const input = fixture(), result = buildMaxOutboxWorkerInverse(input);
  assert.equal(result.provenance.nativeDiskSha256, sha256(input.beforeFlow));
  assert.deepEqual(result.provenance.changedFiles, []);
  for (const file of files) assert.ok(result.candidateFiles.get(file).equals(input.baselineFiles.get(file)));
  const bad = fixture(); bad.baselineFiles.set('package.json', Buffer.from('foreign'));
  assert.throws(() => buildMaxOutboxWorkerInverse(bad), /BASELINE_FILE_DIGEST_MISMATCH/);
});

test('fixed baseline closure agrees with the standard bundle verifier and builder', () => {
  const verifier = readFileSync(new URL('../lk1_unpaid_cancel_service/verify_bundle.mjs', import.meta.url), 'utf8');
  const literal = verifier.match(/export const BUNDLE_FILES = (\[[\s\S]*?\]);/)[1];
  const declared = [...literal.matchAll(/'([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(files, declared);
  const builder = readFileSync(new URL('../lk1_unpaid_cancel_service/build_bundle.mjs', import.meta.url), 'utf8');
  assert.ok(builder.includes('for (const file of BUNDLE_FILES)'));
  assert.equal(files.length, 13);
});

test('derives native disk hash from only the reviewed MAX delta and changes one file', () => {
  const input = fixture(); const before = structuredClone(input);
  const result = buildMaxOutboxWorkerRebind(input);
  const flow = buildMaxOutboxOnlyResume(input.beforeFlow, input.trustedNrPins).flow;
  const nativeHash = sha256(JSON.stringify(flow, null, 4));
  const oldFlowHash = sha256(input.beforeFlow);
  assert.notEqual(nativeHash, sha256(JSON.stringify(flow, null, 2) + '\n'));
  assert.equal(result.provenance.nativeDiskSha256, nativeHash);
  assert.equal(result.provenance.beforeFlowSha256, oldFlowHash);
  assert.equal(result.provenance.gatewayUnchanged, true);
  assert.equal(result.provenance.gatewaySha256, sha256(byId(JSON.parse(input.beforeFlow), GATEWAY).func));
  assert.deepEqual(result.provenance.changedFiles, [GUARD]);
  assert.equal(result.provenance.unchangedFileCount, 12);
  assert.equal(result.provenance.baselineSourceCommit, baselineCommit);
  assert.equal(result.provenance.baselineManifestSha256, input.trustedBaseline.manifestSha256);
  assert.deepEqual([...result.candidateFiles.keys()], [...files]);
  for (const file of files) {
    const expected = file === GUARD
      ? Buffer.from(input.baselineFiles.get(file).toString().replace(oldFlowHash, nativeHash))
      : input.baselineFiles.get(file);
    assert.ok(result.candidateFiles.get(file).equals(expected));
    assert.equal(result.candidateManifest.files[file], sha256(expected));
  }
  assert.deepEqual(Object.keys(result.candidateManifest), ['schema', 'sourceCommit', 'files']);
  assert.equal(result.candidateManifest.schema, 1);
  assert.equal(result.candidateManifest.sourceCommit, publishingCommit);
  assert.deepEqual(JSON.parse(result.candidateManifestBytes), result.candidateManifest);
  assert.equal(result.candidateManifestSha256, sha256(result.candidateManifestBytes));
  assert.ok(input.beforeFlow.equals(Buffer.from(before.beforeFlow)));
  assert.ok(input.baselineManifestBytes.equals(Buffer.from(before.baselineManifestBytes)));
  for (const [file, bytes] of before.baselineFiles) assert.ok(input.baselineFiles.get(file).equals(Buffer.from(bytes)));
  assert.deepEqual(input.trustedNrPins, before.trustedNrPins);
  assert.deepEqual(input.trustedBaseline, before.trustedBaseline);
});

test('candidate buffers do not alias any caller-owned baseline buffer', () => {
  const input = fixture(); const result = buildMaxOutboxWorkerRebind(input);
  for (const [file, candidate] of result.candidateFiles) {
    const original = Buffer.from(input.baselineFiles.get(file)); candidate[0] ^= 1;
    assert.ok(input.baselineFiles.get(file).equals(original));
  }
});

test('rejects wrong manifest, file digest, guard pin and source commit', () => {
  const cases = [
    [(v) => { v.trustedBaseline.manifestSha256 = '0'.repeat(64); }, /BASELINE_MANIFEST_MISMATCH/],
    [(v) => { v.baselineFiles.set('package.json', Buffer.from('foreign package')); }, /BASELINE_FILE_DIGEST_MISMATCH/],
    [(v) => { v.trustedBaseline.guardSha256 = '0'.repeat(64); }, /BASELINE_GUARD_MISMATCH/],
    [(v) => { v.trustedBaseline.sourceCommit = 'c'.repeat(40); }, /BASELINE_SOURCE_MISMATCH/],
  ];
  for (const [mutate, expected] of cases) {
    const input = fixture(); mutate(input);
    assert.throws(() => buildMaxOutboxWorkerRebind(input), expected);
  }
});

test('rejects stale NR pin and guard flow constant detached from exact source bytes', () => {
  const input = fixture(); input.beforeFlow = Buffer.concat([input.beforeFlow, Buffer.from('\n')]);
  assert.throws(() => buildMaxOutboxWorkerRebind(input), /FLOW_PREIMAGE_MISMATCH/);
  const other = fixture(); changeGuard(other, (text) => text.replace(sha256(other.beforeFlow), '0'.repeat(64)));
  assert.throws(() => buildMaxOutboxWorkerRebind(other), /BASELINE_FLOW_BINDING_MISMATCH/);
});

test('rejects changed gateway, missing gateway and disabled gateway', () => {
  for (const mutate of [
    (flow) => { byId(flow, GATEWAY).func += '\n// foreign business change'; },
    (flow) => { flow.splice(flow.findIndex((n) => n.id === GATEWAY), 1); },
    (flow) => { byId(flow, GATEWAY).d = true; },
  ]) {
    const input = fixture(); changeFlow(input, mutate);
    assert.throws(() => buildMaxOutboxWorkerRebind(input), /BASELINE_GATEWAY_BINDING_MISMATCH|GATEWAY_SHAPE_INVALID/);
  }
});

test('rejects doubled or nonstandard digest constant declarations', () => {
  for (const mutate of [
    (text) => text + text.match(/^export const LK1_UNPAID_FLOW_SHA256.*$/m)[0] + '\n',
    (text) => text + text.match(/^export const LK1_UNPAID_GATEWAY_SHA256.*$/m)[0] + '\n',
    (text) => text + '  ' + text.match(/^export const LK1_UNPAID_FLOW_SHA256.*$/m)[0] + '\n',
    (text) => text.replace('export const LK1_UNPAID_FLOW_SHA256', 'export let LK1_UNPAID_FLOW_SHA256'),
  ]) {
    const input = fixture(); changeGuard(input, mutate);
    assert.throws(() => buildMaxOutboxWorkerRebind(input), /GUARD_CONSTANT_SHAPE_INVALID/);
  }
});

test('rejects extra, missing, traversal and absolute baseline file paths', () => {
  for (const mutate of [
    (v) => { v.baselineFiles.set('extra.js', Buffer.from('extra')); },
    (v) => { v.baselineFiles.delete('package.json'); },
    (v) => { v.baselineFiles.set('../guard.mjs', Buffer.from('traversal')); },
    (v) => { v.baselineFiles.set('/guard.mjs', Buffer.from('absolute')); },
  ]) {
    const input = fixture(); mutate(input);
    assert.throws(() => buildMaxOutboxWorkerRebind(input), /BASELINE_FILESET_INVALID/);
    refreshManifest(input);
    assert.throws(() => buildMaxOutboxWorkerRebind(input), /BASELINE_MANIFEST_FILESET_INVALID/);
  }
});

test('rejects nonstandard manifest fields and wrong schema even with matching raw pin', () => {
  for (const mutate of [
    (v) => { v.schema = 2; },
    (v) => { v.provenance = {}; },
    (v) => { v.files['../package.json'] = v.files['package.json']; },
  ]) {
    const input = fixture(); const manifest = JSON.parse(input.baselineManifestBytes); mutate(manifest);
    input.baselineManifestBytes = Buffer.from(JSON.stringify(manifest));
    input.trustedBaseline.manifestSha256 = sha256(input.baselineManifestBytes);
    assert.throws(() => buildMaxOutboxWorkerRebind(input), /BASELINE_MANIFEST_SHAPE_INVALID|BASELINE_MANIFEST_FILESET_INVALID/);
  }
});

test('rejects invalid publishing commit and invalid byte containers', () => {
  for (const publishingSourceCommit of ['', 'main', 'A'.repeat(40), baselineCommit]) {
    assert.throws(() => buildMaxOutboxWorkerRebind({ ...fixture(), publishingSourceCommit }), /PUBLISHING_COMMIT_INVALID/);
  }
  const input = fixture(); input.baselineFiles.set('package.json', 'text is not exact Buffer input');
  assert.throws(() => buildMaxOutboxWorkerRebind(input), /BASELINE_FILE_DIGEST_MISMATCH/);
  assert.throws(() => buildMaxOutboxWorkerRebind({ ...fixture(), baselineManifestBytes: '{}' }), /RAW_BASELINE_BYTES_REQUIRED/);
});

test('rejects MAX topology drift before deriving any worker files', () => {
  const input = fixture(); changeFlow(input, (flow) => { byId(flow, routes[0].sender).bot = routes[1].bot; });
  const before = new Map([...input.baselineFiles].map(([name, bytes]) => [name, Buffer.from(bytes)]));
  assert.throws(() => buildMaxOutboxWorkerRebind(input), /WRONG_BOT_CONNECTOR/);
  for (const [name, bytes] of before) assert.ok(input.baselineFiles.get(name).equals(bytes));
});
