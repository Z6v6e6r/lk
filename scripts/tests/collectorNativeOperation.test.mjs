import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCollectorNativeOperation } from '../nodered_reviewed_flow_deploy/collector_native_operation.mjs';
import { createReviewedFlowRuntime } from '../nodered_reviewed_flow_deploy/deploy_reviewed_flow_147_remote.mjs';
import { collectorGraphHash, collectorOrderedGraphHash, createCollectorBodyPreserver } from '../nodered_reviewed_flow_deploy/collector_body_preserver.mjs';
import { sha256 } from '../nodered_reviewed_flow_deploy/runtime_contract.mjs';
import { ROUTE_ID,RESPONSE_ID,MONGO_ID,DEBUG_ID } from '../diagnostics/split-leave-collector.mjs';

export const sourceBody = `const endpoint = msg.inputUrl;
node.warn(endpoint);
msg.url = endpoint;
return msg;`;
const code = 'a'.repeat(64), identity = 'b'.repeat(64), commit = 'c'.repeat(40);
const confirmation = 'RESERVE_COLLECTOR_NATIVE_NO_RESTART_147';
async function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'collector-native-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); fs.chmodSync(root, 0o700);
  const stage = path.join(root, '.padlhub-collector-stage-20261112T110000Z-1'); fs.mkdirSync(stage, { mode: 0o700 });
  const graph = [{ id: 'tab', type: 'tab', disabled: false },
    { id: 'inject', type: 'inject', z: 'tab', once: false, crontab: '20 12 * * *', wires: [[]] },
    { id: ROUTE_ID, type: 'http in', z: 'tab', url: '/lk/analytics/events', method: 'post', wires: [[DEBUG_ID,RESPONSE_ID,MONGO_ID]] },
    { id: RESPONSE_ID, type: 'http response', z: 'tab', wires: [] },
    { id: MONGO_ID, type: 'mongodb4', z: 'tab', collection: 'events', operation: 'insertOne', wires: [[]] },
    { id: DEBUG_ID, type: 'debug', z: 'tab', active: false, complete: 'true', wires: [] }];
  const live = path.join(root, 'flows.json'), lease = path.join(root, '.padlhub-reviewed-flow-deploy.lease.json');
  fs.writeFileSync(live, JSON.stringify(graph), { mode: 0o600 });
  let now = Date.parse('2026-11-12T11:00:00.000Z'), target = identity;
  const readback = async (g = graph, revision = 'synthetic-pre-revision') => ({ origin: 'http://127.0.0.1:18801',
    requestedAt: new Date(now).toISOString(), observedAt: new Date(now).toISOString(), graphSha256: await collectorGraphHash(g),
    orderedGraphSha256: await collectorOrderedGraphHash(g), editorOrderedGraphSha256: await collectorOrderedGraphHash(graph), revisionSha256: sha256(revision) });
  const options = { stage, root, uid: process.getuid(), gid: process.getgid(), getUid: () => process.getuid(),
    now: () => now, readTarget: () => target, codeHash: () => code };
  const op = createCollectorNativeOperation(options);
  const prepared = await op.prepare({ expectedSourceSha256: sha256(fs.readFileSync(live)), expectedTargetSha256: identity,
    expectedCodeSha256: code, expectedRouteSha256: sha256(JSON.stringify(graph.find(node => node.id === ROUTE_ID))), sourceCommit: commit, native: await readback() });
  const expectedPlanSha256 = prepared.planSha256;
  const reserve = async () => op.reserve({ expectedPlanSha256, confirmation, native: await readback() });
  const begin = async () => op.begin({ expectedPlanSha256, native: await readback() });
  const candidate = JSON.parse(fs.readFileSync(path.join(stage, 'candidate.flow.json')));
  const applyFixture = async seal => {
    const preserver = await createCollectorBodyPreserver(seal, { rev: 'synthetic-pre-revision', flows: graph });
    const result = await preserver({ request: { url: 'http://127.0.0.1:18801/flows', method: 'POST', apiVersion: 'v2', deploymentType: 'nodes' },
      postBody: { rev: 'synthetic-pre-revision', flows: graph } });
    fs.writeFileSync(live, JSON.stringify(JSON.parse(result.postDataText).flows));
    return { expectedPlanSha256, native: await readback(candidate, 'synthetic-post-revision'), httpStatus: 200, ackAt: now,
      audit: { ...result.audit, status: 'FORWARDED_AWAITING_READBACK', forwarded: 1, rejected: 0, notAfter: seal.notAfter } };
  };
  return { op, options, root, stage, graph, live, lease, expectedPlanSha256, reserve, begin, candidate, readback, applyFixture,
    now: () => now, advance: ms => { now += ms; }, driftTarget: () => { target = 'd'.repeat(64); } };
}

test('custody reserves exact source, forwards one candidate and releases only after full fresh soak', async t => {
  const f = await fixture(t), original = fs.readFileSync(f.live);
  await f.reserve(); const begun = await f.begin();
  assert.deepEqual(fs.readFileSync(f.live), original, 'controller must not write live flow');
  const input = await f.applyFixture(begun.seal); await f.op.confirm(input);
  await assert.rejects(f.op.finish({ expectedPlanSha256: f.expectedPlanSha256, native: input.native }), /SOAK_INCOMPLETE/);
  f.advance(900000); const native = await f.readback(f.candidate, 'synthetic-post-revision');
  assert.equal((await f.op.finish({ expectedPlanSha256: f.expectedPlanSha256, native })).status, 'FINISHED');
  assert.equal(fs.existsSync(f.lease), false);
  assert.equal((await f.op.finish({ expectedPlanSha256: f.expectedPlanSha256, native })).status, 'FINISHED');
  assert.deepEqual(f.graph.find(n => n.id === 'inject'), f.candidate.find(n => n.id === 'inject'));
  for (const name of ['source.flow.json', 'candidate.flow.json', 'plan.json', 'attempt.json', 'ack.json', 'finish.json'])
    assert.equal(fs.statSync(path.join(f.stage, name)).mode & 0o777, 0o600);
});

test('expired matching v2 handoff is durable; active, mismatched, MAX and unknown leases are retained', async t => {
  for (const variant of ['active', 'mismatched', 'MAX', 'unknown', 'malformed', 'matching']) {
    const f = await fixture(t), value = { formatVersion: 2, deploymentId: 'completed-prior', token: 'synthetic-prior-token',
      phase: 'soaking', acquiredAtMs: f.now() - 10000, sourceSha256: 'a'.repeat(64),
      expiresAtMs: f.now() - 1000, candidateSha256: sha256(fs.readFileSync(f.live)) };
    if (variant === 'active') value.expiresAtMs = f.now() + 1000;
    if (variant === 'mismatched') value.candidateSha256 = '0'.repeat(64);
    if (variant === 'MAX') Object.assign(value, { formatVersion: 3, kind: 'editor-modified-nodes' });
    if (variant === 'unknown') value.formatVersion = 99;
    if (variant === 'malformed') delete value.token;
    const before = JSON.stringify(value); fs.writeFileSync(f.lease, before, { mode: 0o600 });
    if (variant === 'matching') {
      await f.op.reserve({ expectedPlanSha256: f.expectedPlanSha256, confirmation, native: await f.readback(), expectedPredecessorLeaseSha256: sha256(before), expectedPredecessorDeploymentId: value.deploymentId }); assert.equal(fs.readFileSync(path.join(f.stage, 'predecessor.lease.json'), 'utf8'), before);
    } else { await assert.rejects(f.op.reserve({ expectedPlanSha256: f.expectedPlanSha256, confirmation, native: await f.readback(), expectedPredecessorLeaseSha256: sha256(before), expectedPredecessorDeploymentId: value.deploymentId }), /EXISTING_LEASE|FOREIGN_LEASE_INVALID|PREDECESSOR_PIN/); assert.equal(fs.readFileSync(f.lease, 'utf8'), before); }
  }
});

test('legacy reviewed-flow and MAX helpers cannot reinterpret or release a collector v4 lease', async t => {
  const f = await fixture(t); await f.reserve(); const before = fs.readFileSync(f.lease);
  const old = createReviewedFlowRuntime({ liveFlowPath: f.live, stageParent: f.root, deploymentLeasePath: f.lease,
    uid: process.getuid(), gid: process.getgid(), getUid: () => process.getuid(),
    pm2: { assertOnline: () => { throw new Error('must not reach process/write'); } } });
  assert.throws(() => old.preflight({}), /lease contract mismatch/);
  assert.deepEqual(fs.readFileSync(f.lease), before);
});

test('one-attempt marker prevents repeat and abort even when POST never happened', async t => {
  const f = await fixture(t); await f.reserve(); await f.begin();
  await assert.rejects(f.begin(), /EEXIST/);
  await assert.rejects(f.op.abort({ expectedPlanSha256: f.expectedPlanSha256, native: await f.readback() }), /MAY_HAVE_EFFECT/);
  const result = await f.op.reconcile({ expectedPlanSha256: f.expectedPlanSha256, native: await f.readback() });
  assert.equal(result.status, 'PRE'); assert.equal(result.automaticRelease, false);
  assert.equal(fs.existsSync(f.lease), true);
});
test('own interrupted atomic lease publication is recovered; foreign or arbitrary aliases remain refused', async t => {
  const f = await fixture(t); await f.reserve();
  const alias = path.join(f.root, `.${path.basename(f.lease)}.1234.fixture.tmp`); fs.linkSync(f.lease, alias);
  const result = await f.op.reconcile({ expectedPlanSha256: f.expectedPlanSha256, native: await f.readback() });
  assert.equal(result.status, 'PRE'); assert.equal(fs.existsSync(alias), false); assert.equal(fs.statSync(f.lease).nlink, 1);
  const g = await fixture(t); await g.reserve();
  const other = path.join(g.root, 'unrecognized-alias'); fs.linkSync(g.lease, other);
  await assert.rejects(g.op.reconcile({ expectedPlanSha256: g.expectedPlanSha256, native: await g.readback() }));
  assert.equal(fs.statSync(g.lease).nlink, 2); assert.equal(fs.existsSync(other), true);
});

for (const [name, mutate] of [
  ['HTTP conflict', x => { x.httpStatus = 409; }], ['extra credential', x => { x.audit.Authorization = 'synthetic'; }],
  ['second forward', x => { x.audit.forwarded = 2; }], ['wrong body', x => { x.audit.candidateGraphSha256 = '0'.repeat(64); }],
  ['same revision', x => { x.native.revisionSha256 = sha256('synthetic-pre-revision'); }],
  ['foreign origin', x => { x.native.origin = 'http://example.invalid'; }],
  ['stale observation', x => { x.native.observedAt = '2026-11-11T11:00:00.000Z'; }],
  ['GET started before ACK', x => { x.native.requestedAt = new Date(x.ackAt - 1).toISOString(); }],
]) test(`ACK refuses ${name} and keeps shared custody`, async t => {
  const f = await fixture(t); await f.reserve(); const b = await f.begin();
  const input = await f.applyFixture(b.seal); mutate(input);
  await assert.rejects(f.op.confirm(input)); assert.equal(fs.existsSync(f.lease), true);
  assert.equal(fs.existsSync(path.join(f.stage, 'ack.json')), false);
});

test('ambiguous POST requires explicit observed-POST adoption without replay and a new soak', async t => {
  const f = await fixture(t); await f.reserve(); const b = await f.begin(); await f.applyFixture(b.seal);
  f.advance(600000); const native = await f.readback(f.candidate, 'synthetic-post-revision');
  const reconcile = await f.op.reconcile({ expectedPlanSha256: f.expectedPlanSha256, native });
  assert.equal(reconcile.status, 'POST'); assert.equal(reconcile.automaticRetry, false);
  const adopted = await f.op.adopt({ expectedPlanSha256: f.expectedPlanSha256, native,
    expectedRevisionSha256: native.revisionSha256, confirmation: 'ADOPT_OBSERVED_COLLECTOR_POST_NO_REPLAY_147' });
  assert.equal(adopted.ackMode, 'observed-post-adoption');
  await assert.rejects(f.op.finish({ expectedPlanSha256: f.expectedPlanSha256, native }), /SOAK_INCOMPLETE/);
  f.advance(900000); await f.op.finish({ expectedPlanSha256: f.expectedPlanSha256, native: await f.readback(f.candidate, 'synthetic-post-revision') });
});

test('target/source/candidate drift refuses; source-only abort is receipt-first and repeatable', async t => {
  const f = await fixture(t); await f.reserve();
  const input = { expectedPlanSha256: f.expectedPlanSha256, native: await f.readback() };
  await f.op.abort(input); assert.equal(fs.existsSync(f.lease), false); await f.op.abort(input);
  f.driftTarget(); await assert.rejects(f.op.abort(input), /TARGET_DRIFT/);
  const g = await fixture(t); fs.appendFileSync(g.live, ' '); await assert.rejects(g.reserve(), /SOURCE_DRIFT/);
  const h = await fixture(t); fs.appendFileSync(path.join(h.stage, 'candidate.flow.json'), ' '); await assert.rejects(h.reserve(), /BACKUP_DRIFT/);
});

test('reserve rejects editor and source-order drift before creating shared custody', async t => {
  for (const key of ['editorOrderedGraphSha256', 'orderedGraphSha256']) {
    const f = await fixture(t), native = await f.readback(); native[key] = '0'.repeat(64);
    await assert.rejects(f.op.reserve({ expectedPlanSha256: f.expectedPlanSha256, confirmation, native }), /NATIVE_EVIDENCE/);
    assert.equal(fs.existsSync(f.lease), false);
  }
});
test('ACK rejects a different serialization pin; retained custody prevents replay', async t => {
  const f = await fixture(t); await f.reserve(); const b = await f.begin(), input = await f.applyFixture(b.seal);
  input.audit.editorOrderedGraphSha256 = '0'.repeat(64);
  await assert.rejects(f.op.confirm(input), /ACK_INPUT/); assert.equal(fs.existsSync(f.lease), true);
});
test('a sorted-hash-equivalent reordered candidate is UNKNOWN and cannot finish', async t => {
  const f = await fixture(t); await f.reserve(); const b = await f.begin(), input = await f.applyFixture(b.seal);
  await f.op.confirm(input); f.advance(900000);
  const reordered = [...f.candidate].reverse(); fs.writeFileSync(f.live, JSON.stringify(reordered));
  const native = await f.readback(reordered, 'synthetic-post-revision');
  assert.equal(native.graphSha256, input.native.graphSha256);
  assert.equal((await f.op.reconcile({ expectedPlanSha256: f.expectedPlanSha256, native })).status, 'UNKNOWN');
  await assert.rejects(f.op.finish({ expectedPlanSha256: f.expectedPlanSha256, native }), /POST_GRAPH/);
  assert.equal(fs.existsSync(f.lease), true);
});
test('finish GET must start after the full soak, even if it completed after expiry', async t => {
  const f = await fixture(t); await f.reserve(); const b = await f.begin(), input = await f.applyFixture(b.seal);
  await f.op.confirm(input); f.advance(900000);
  const native = await f.readback(f.candidate, 'synthetic-post-revision'); native.requestedAt = new Date(f.now() - 65000).toISOString();
  await assert.rejects(f.op.finish({ expectedPlanSha256: f.expectedPlanSha256, native }), /SOAK_INCOMPLETE/);
  assert.equal(fs.existsSync(f.lease), true);
});

test('exact inverse restores only the gate and route wires, preserves process custody and requires a full fresh soak', async t => {
  const f = await fixture(t); await f.reserve(); const forward = await f.begin();
  const ack = await f.applyFixture(forward.seal); await f.op.confirm(ack);
  const started = await f.op.beginInverse({ expectedPlanSha256: f.expectedPlanSha256,
    native: await f.readback(f.candidate, 'synthetic-post-revision'),
    confirmation: 'RESTORE_COLLECTOR_SOURCE_NO_BUSINESS_ROLLBACK_147' });
  const preserver = await createCollectorBodyPreserver(started.seal, { rev: 'synthetic-post-revision', flows: f.candidate });
  const result = await preserver({ request: { url: 'http://127.0.0.1:18801/flows', method: 'POST', apiVersion: 'v2', deploymentType: 'nodes' },
    postBody: { rev: 'synthetic-post-revision', flows: f.graph } });
  assert.deepEqual(JSON.parse(result.postDataText).flows, f.graph);
  fs.writeFileSync(f.live, JSON.stringify(f.graph));
  const input = { expectedPlanSha256: f.expectedPlanSha256, httpStatus: 200, ackAt: f.now(),
    native: await f.readback(f.graph, 'synthetic-inverse-revision'), audit: { ...result.audit,
      status: 'FORWARDED_AWAITING_READBACK', forwarded: 1, rejected: 0, notAfter: started.seal.notAfter } };
  await f.op.confirmInverse(input);
  await assert.rejects(f.op.finishInverse({ expectedPlanSha256: f.expectedPlanSha256, native: input.native }), /SOAK_INCOMPLETE/);
  f.advance(900000);
  const finished = await f.op.finishInverse({ expectedPlanSha256: f.expectedPlanSha256,
    native: await f.readback(f.graph, 'synthetic-inverse-revision') });
  assert.equal(finished.leaseReleased, true); assert.equal(finished.nodeRedRestarted, false);
});

async function inverseFixture(t) {
  const f = await fixture(t); await f.reserve(); const forward = await f.begin();
  await f.op.confirm(await f.applyFixture(forward.seal));
  const started = await f.op.beginInverse({ expectedPlanSha256: f.expectedPlanSha256,
    native: await f.readback(f.candidate, 'synthetic-post-revision'),
    confirmation: 'RESTORE_COLLECTOR_SOURCE_NO_BUSINESS_ROLLBACK_147' });
  const preserve = await createCollectorBodyPreserver(started.seal, { rev: 'synthetic-post-revision', flows: f.candidate });
  const result = await preserve({ request: { url: 'http://127.0.0.1:18801/flows', method: 'POST', apiVersion: 'v2', deploymentType: 'nodes' },
    postBody: { rev: 'synthetic-post-revision', flows: f.graph } });
  fs.writeFileSync(f.live, JSON.stringify(f.graph, null, 1));
  return { ...f, input: { expectedPlanSha256: f.expectedPlanSha256, httpStatus: 200, ackAt: f.now(),
    native: await f.readback(f.graph, 'synthetic-inverse-revision'), audit: { ...result.audit,
      status: 'FORWARDED_AWAITING_READBACK', forwarded: 1, rejected: 0, notAfter: started.seal.notAfter } } };
}

test('inverse ACK receipt resumes after lease-write interruption; finish resumes after receipt before lease removal', async t => {
  const f = await inverseFixture(t), rename = fs.renameSync;
  fs.renameSync = (from, to) => { if (to === f.lease) throw Error('synthetic-lease-publication-failure'); return rename(from, to); };
  try { await assert.rejects(f.op.confirmInverse(f.input), /synthetic-lease/); } finally { fs.renameSync = rename; }
  assert(fs.existsSync(path.join(f.stage, 'ack.inverse.json')));
  await f.op.confirmInverse(f.input); await f.op.confirmInverse(f.input);
  f.advance(900000);
  const args = { expectedPlanSha256: f.expectedPlanSha256, native: await f.readback(f.graph, 'synthetic-inverse-revision') };
  const unlink = fs.unlinkSync;
  fs.unlinkSync = file => { if (file === f.lease) throw Error('synthetic-lease-removal-failure'); return unlink(file); };
  try { await assert.rejects(f.op.finishInverse(args), /synthetic-lease/); } finally { fs.unlinkSync = unlink; }
  assert(fs.existsSync(path.join(f.stage, 'finish.inverse.json')));
  assert.equal((await f.op.finishInverse(args)).status, 'INVERSE_FINISHED');
  assert.equal((await f.op.finishInverse(args)).status, 'INVERSE_FINISHED');
});

test('lost inverse ACK requires explicit observed-source adoption and a fresh complete soak', async t => {
  const f = await inverseFixture(t); f.advance(600000);
  const args = { expectedPlanSha256: f.expectedPlanSha256, native: await f.readback(f.graph, 'synthetic-inverse-revision') };
  assert.equal((await f.op.reconcile(args)).status, 'RESTORED_SOURCE');
  const adopted = await f.op.adoptInverse({ ...args, expectedRevisionSha256: args.native.revisionSha256,
    confirmation: 'ADOPT_OBSERVED_COLLECTOR_SOURCE_NO_REPLAY_147' });
  assert.equal(adopted.automaticRetry, false); assert.equal(adopted.ackMode, 'observed-source-adoption');
  await assert.rejects(f.op.finishInverse(args), /SOAK_INCOMPLETE/);
  f.advance(900000);
  assert.equal((await f.op.finishInverse({ ...args, native: await f.readback(f.graph, 'synthetic-inverse-revision') })).status, 'INVERSE_FINISHED');
});

test('inverse reservation resumes the identical attempt after lease publication fails', async t => {
  const f = await fixture(t); await f.reserve(); const forward = await f.begin();
  await f.op.confirm(await f.applyFixture(forward.seal));
  const args = { expectedPlanSha256: f.expectedPlanSha256, native: await f.readback(f.candidate, 'synthetic-post-revision'),
    confirmation: 'RESTORE_COLLECTOR_SOURCE_NO_BUSINESS_ROLLBACK_147' };
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => { if (to === f.lease) throw Error('synthetic-publication-failure'); return rename(from, to); };
  try { await assert.rejects(f.op.beginInverse(args), /synthetic-publication/); } finally { fs.renameSync = rename; }
  const original = fs.readFileSync(path.join(f.stage, 'attempt.inverse.json'));
  const one = await f.op.beginInverse(args), resumed = await f.op.beginInverse(args);
  assert.deepEqual(fs.readFileSync(path.join(f.stage, 'attempt.inverse.json')), original);
  assert.equal(one.seal.attemptSha256, resumed.seal.attemptSha256);
});

test('expired predecessor handoff refuses a changed lease hash or deployment identity', async t => {
  const f = await fixture(t), value = { formatVersion: 2, deploymentId: 'reviewed-prior', token: 'synthetic-token', phase: 'soaking',
    acquiredAtMs: f.now() - 10000, expiresAtMs: f.now() - 1000, sourceSha256: 'a'.repeat(64), candidateSha256: sha256(fs.readFileSync(f.live)) };
  const raw = JSON.stringify(value); fs.writeFileSync(f.lease, raw, { mode: 0o600 });
  for (const overrides of [{ expectedPredecessorLeaseSha256: '0'.repeat(64) }, { expectedPredecessorDeploymentId: 'unreviewed-other' }]) {
    await assert.rejects(f.op.reserve({ expectedPlanSha256: f.expectedPlanSha256, confirmation, native: await f.readback(),
      expectedPredecessorLeaseSha256: sha256(raw), expectedPredecessorDeploymentId: value.deploymentId, ...overrides }), /PREDECESSOR_PIN/);
    assert.equal(fs.readFileSync(f.lease, 'utf8'), raw);
  }
});
