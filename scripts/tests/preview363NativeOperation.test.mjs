import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createPreview363NativeOperation } from '../nodered_reviewed_flow_deploy/preview363_native_operation.mjs';
import { createReviewedFlowRuntime } from '../nodered_reviewed_flow_deploy/deploy_reviewed_flow_147_remote.mjs';
import { createPreview363BodyPreserver } from '../nodered_reviewed_flow_deploy/preview363_body_preserver.mjs';
import { sha256, buildPreview363Artifact } from '../lib/preview363_activation.mjs';

import { fixture, bundle, code, identity, commit, confirmation } from './fixtures/preview363NativeCustodyFixture.mjs';

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
      await f.reserve(); assert.equal(fs.readFileSync(path.join(f.stage, 'predecessor.lease.json'), 'utf8'), before);
    } else { await assert.rejects(f.reserve(), /EXISTING_LEASE|FOREIGN_LEASE_INVALID/); assert.equal(fs.readFileSync(f.lease, 'utf8'), before); }
  }
});

test('legacy reviewed-flow and MAX helpers cannot reinterpret or release a preview363 v5 lease', async t => {
  const f = await fixture(t); await f.reserve(); const before = fs.readFileSync(f.lease);
  const old = createReviewedFlowRuntime({ liveFlowPath: f.live, stageParent: f.root, deploymentLeasePath: f.lease,
    uid: process.getuid(), gid: process.getgid(), getUid: () => process.getuid(),
    pm2: { assertOnline: () => { throw new Error('must not reach process/write'); } } });
  assert.throws(() => old.preflight({}), /lease contract mismatch/);
  assert.throws(() => old.abortEditorModified({ deploymentId: 'preview363-native-diagnostic', stamp: '20261112T140000+0300' }), /lease contract mismatch/);
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
  ['source order', x => { x.audit.sourceOrderedGraphSha256 = '0'.repeat(64); }],
  ['candidate order', x => { x.audit.candidateOrderedGraphSha256 = '0'.repeat(64); }],
  ['editor order', x => { x.audit.editorOrderedGraphSha256 = '0'.repeat(64); }],
  ['stale request start', x => { x.native.requestedAt = '2026-11-11T11:00:00.000Z'; }],
  ['same revision', x => { x.native.revisionSha256 = sha256('synthetic-pre-revision'); }],
  ['foreign origin', x => { x.native.origin = 'http://example.invalid'; }],
  ['stale observation', x => { x.native.observedAt = '2026-11-11T11:00:00.000Z'; }],
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
    expectedRevisionSha256: native.revisionSha256, confirmation: 'ADOPT_OBSERVED_PREVIEW363_POST_NO_REPLAY_147' });
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

test('inverse native recovery has a new attempt and restores only the original func without restart', async t => {
  const f = await fixture(t); await f.reserve(); const begin = await f.begin();
  const forward = await f.applyFixture(begin.seal); await f.op.confirm(forward);
  const input = { expectedPlanSha256: f.expectedPlanSha256, native: await f.readback(f.candidate, 'synthetic-post-revision') };
  await f.op.rollbackReserve({ ...input, confirmation: 'ROLLBACK_PREVIEW363_NATIVE_SOURCE_NO_RESTART_147' });
  const rb = await f.op.rollbackBegin(input);
  assert.notEqual(rb.seal.attemptSha256, begin.seal.attemptSha256);
  assert.equal(rb.seal.reverse, true);
  await assert.rejects(f.op.rollbackBegin(input), /EEXIST/);
  const preserver = await createPreview363BodyPreserver(rb.seal, buildPreview363Artifact(commit, bundle), { rev: 'synthetic-post-revision', flows: f.candidate });
  const result = await preserver({ request: { url: 'http://127.0.0.1:18801/flows', method: 'POST', apiVersion: 'v2', deploymentType: 'nodes' },
    postBody: { rev: 'synthetic-post-revision', flows: f.candidate } });
  const restored = JSON.parse(result.postDataText).flows;
  assert.deepEqual(restored, f.graph);
  fs.writeFileSync(f.live, JSON.stringify(restored));
  const native = await f.readback(restored, 'synthetic-rollback-revision');
  const confirm = { expectedPlanSha256: f.expectedPlanSha256, native, httpStatus: 200, ackAt: f.now(),
    audit: { ...result.audit, status: 'FORWARDED_AWAITING_READBACK', forwarded: 1, rejected: 0, notAfter: rb.seal.notAfter } };
  const reservedLease = fs.readFileSync(f.lease);
  assert.equal((await f.op.rollbackConfirm(confirm)).status, 'ROLLBACK_SOAKING');
  // Simulate the durable ACK succeeding but lease publication being interrupted.
  fs.writeFileSync(f.lease, reservedLease);
  assert.equal((await f.op.rollbackConfirm(confirm)).status, 'ROLLBACK_SOAKING');
  await assert.rejects(f.op.finish({ expectedPlanSha256: f.expectedPlanSha256, native }), /SOAK_INCOMPLETE|ACK_BINDING/);
  await assert.rejects(f.op.rollbackFinish({ expectedPlanSha256: f.expectedPlanSha256, native }), /SOAK_INCOMPLETE/);
  f.advance(900000);
  const finished = await f.op.rollbackFinish({ expectedPlanSha256: f.expectedPlanSha256,
    native: await f.readback(restored, 'synthetic-rollback-revision') });
  assert.equal(finished.status, 'ROLLED_BACK'); assert.equal(finished.nodeRedRestarted, false);
  assert.equal(fs.existsSync(f.lease), false);
});
test('inverse recovery refuses unknown live graph and retains custody', async t => {
  const f = await fixture(t); await f.reserve(); const begin = await f.begin(); await f.applyFixture(begin.seal);
  const candidate = structuredClone(f.candidate); candidate[0].label = 'foreign-change';
  fs.writeFileSync(f.live, JSON.stringify(candidate));
  await assert.rejects(f.op.rollbackReserve({ expectedPlanSha256: f.expectedPlanSha256,
    confirmation: 'ROLLBACK_PREVIEW363_NATIVE_SOURCE_NO_RESTART_147',
    native: await f.readback(candidate, 'synthetic-post-revision') }), /POST_GRAPH/);
  assert.equal(fs.existsSync(f.lease), true);
  assert.equal(fs.existsSync(path.join(f.stage, 'rollback-reserve.json')), false);
});
test('lost inverse ACK is adopted from exact observed source without replay and with a new full soak', async t => {
  const f = await fixture(t); await f.reserve(); const begin = await f.begin(); await f.applyFixture(begin.seal);
  const post = await f.readback(f.candidate, 'synthetic-post-revision');
  await f.op.rollbackReserve({ expectedPlanSha256: f.expectedPlanSha256, native: post,
    confirmation: 'ROLLBACK_PREVIEW363_NATIVE_SOURCE_NO_RESTART_147' });
  const rb = await f.op.rollbackBegin({ expectedPlanSha256: f.expectedPlanSha256, native: post });
  const preserver = await createPreview363BodyPreserver(rb.seal, buildPreview363Artifact(commit, bundle), { rev: 'synthetic-post-revision', flows: f.candidate });
  const result = await preserver({ request: { url: 'http://127.0.0.1:18801/flows', method: 'POST', apiVersion: 'v2', deploymentType: 'nodes' },
    postBody: { rev: 'synthetic-post-revision', flows: f.candidate } });
  fs.writeFileSync(f.live, JSON.stringify(JSON.parse(result.postDataText).flows));
  f.advance(600000); // The original HTTP ACK and attempt window are gone.
  const native = await f.readback(f.graph, 'synthetic-rollback-revision');
  const adopted = await f.op.rollbackAdopt({ expectedPlanSha256: f.expectedPlanSha256, native,
    expectedRevisionSha256: native.revisionSha256, confirmation: 'ADOPT_OBSERVED_PREVIEW363_SOURCE_NO_REPLAY_147' });
  assert.equal(adopted.ackMode, 'observed-source-adoption'); assert.equal(adopted.automaticRetry, false);
  await assert.rejects(f.op.rollbackFinish({ expectedPlanSha256: f.expectedPlanSha256, native }), /SOAK_INCOMPLETE/);
  f.advance(900000);
  assert.equal((await f.op.rollbackFinish({ expectedPlanSha256: f.expectedPlanSha256,
    native: await f.readback(f.graph, 'synthetic-rollback-revision') })).status, 'ROLLED_BACK');
});

test('execution manifest requires an explicit exact source pin and preserves a reviewed unrelated delta', async t => {
  const f = await fixture(t), oldSha = sha256(fs.readFileSync(f.live));
  const changed = structuredClone(f.graph); changed[3].requestTimeout = '17000';
  fs.writeFileSync(f.live, JSON.stringify(changed));
  const stage = f.stage + '2'; fs.mkdirSync(stage, { mode: 0o700 });
  const op = createPreview363NativeOperation({ ...f.options, stage });
  const input = { expectedTargetSha256: identity, expectedCodeSha256: code, sourceCommit: commit, native: await f.readback(changed) };
  await assert.rejects(op.prepare(input), /PREPARE_PINS/);
  await assert.rejects(op.prepare({ ...input, expectedSourceSha256: 'not-a-sha' }), /PREPARE_PINS/);
  await assert.rejects(op.prepare({ ...input, expectedSourceSha256: oldSha }), /SOURCE_DRIFT/);
  assert.deepEqual(fs.readdirSync(stage), []); assert.equal(fs.existsSync(f.lease), false);
  const manifest = Object.freeze({ ...input, expectedSourceSha256: sha256(fs.readFileSync(f.live)) });
  const prepared = await op.prepare(manifest);
  const candidate = JSON.parse(fs.readFileSync(path.join(stage, 'candidate.flow.json')));
  assert.deepEqual(candidate[3], changed[3]);
  const restored = structuredClone(candidate);
  const target = restored.find(n => n.id === 'lk_subscription_price_preview_20260908_router');
  const artifact = buildPreview363Artifact(commit, bundle);
  target.func = target.func.slice(artifact.prefix.length).replace(artifact.hook, '');
  assert.deepEqual(restored, changed);
  assert.equal(JSON.parse(fs.readFileSync(path.join(stage, 'plan.json'))).sourceSha256, manifest.expectedSourceSha256);
  const drift = structuredClone(changed); drift[3].method = 'POST'; fs.writeFileSync(f.live, JSON.stringify(drift));
  await assert.rejects(op.reserve({ expectedPlanSha256: prepared.planSha256, confirmation, native: await f.readback(changed) }), /SOURCE_DRIFT/);
  assert.equal(fs.existsSync(f.lease), false);
});

test('source drift after reservation refuses begin and preserves custody without consuming an attempt', async t => {
  const f = await fixture(t); await f.reserve();
  const lease = fs.readFileSync(f.lease), changed = structuredClone(f.graph);
  changed[3].requestTimeout = '18000'; fs.writeFileSync(f.live, JSON.stringify(changed));
  await assert.rejects(f.begin(), /SOURCE_DRIFT/);
  assert.deepEqual(fs.readFileSync(f.lease), lease);
  assert.equal(fs.existsSync(path.join(f.stage, 'attempt.json')), false);
});

for (const field of ['func','initialize','finalize','libs','node-count']) test(`correct source SHA cannot bless target ${field} drift`, async t => {
  const f = await fixture(t), changed = structuredClone(f.graph);
  if (field === 'node-count') changed.push({ id: 'unexpected', type: 'debug', active: false });
  else if (field === 'libs') changed[2].libs[0].module = 'fs';
  else changed[2][field] += ' ';
  fs.writeFileSync(f.live, JSON.stringify(changed));
  const stage = f.stage + '2'; fs.mkdirSync(stage, { mode: 0o700 });
  const op = createPreview363NativeOperation({ ...f.options, stage });
  await assert.rejects(op.prepare({ expectedSourceSha256: sha256(fs.readFileSync(f.live)), expectedTargetSha256: identity,
    expectedCodeSha256: code, sourceCommit: commit, native: await f.readback(changed) }), /NODE_DRIFT|GRAPH/);
  assert.deepEqual(fs.readdirSync(stage), []); assert.equal(fs.existsSync(f.lease), false);
});
