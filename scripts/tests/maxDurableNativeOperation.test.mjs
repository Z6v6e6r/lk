import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { durableGraphFixture, durablePins } from './fixtures/max-durable-queue.mjs';
import { buildMaxDurableTransition, buildMaxDurableRecovery } from '../nodered_max_durable_release.mjs';
import { sha256 } from '../nodered_max_outbox_resume.mjs';
import { createMaxDurableBodyPreserver, max_durableGraphHash, max_durableOrderedGraphHash } from '../nodered_reviewed_flow_deploy/max_durable_body_preserver.mjs';
import { createMaxDurableNativeOperation, max_durableOperationCodeHash } from '../nodered_reviewed_flow_deploy/max_durable_native_operation.mjs';
import { createMaxDurableRecoveryNativeOperation, max_durable_recoveryOperationCodeHash } from '../nodered_reviewed_flow_deploy/max_durable_recovery_native_operation.mjs';

async function setup() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'max-durable-op-')));
  fs.chmodSync(root, 0o700); let now = Date.now(), revision = 'synthetic-original';
  const target = 'a'.repeat(64), commit = 'b'.repeat(40), uid = process.getuid(), gid = process.getgid();
  const live = path.join(root, 'flows.json'), lease = path.join(root, '.padlhub-reviewed-flow-deploy.lease.json');
  fs.writeFileSync(live, JSON.stringify(durableGraphFixture(), null, 4), { mode: 0o600 });
  const native = async () => { const f = JSON.parse(fs.readFileSync(live)); return { origin: 'http://127.0.0.1:18801',
    requestedAt: new Date(now).toISOString(), observedAt: new Date(now).toISOString(), revisionSha256: sha256(revision),
    graphSha256: await max_durableGraphHash(f), orderedGraphSha256: await max_durableOrderedGraphHash(f),
    editorOrderedGraphSha256: await max_durableOrderedGraphHash(f) }; };
  const stage = purpose => { const p = path.join(root, '.padlhub-max_durable-' + purpose + '-stage-20261113T000000Z-123'); fs.mkdirSync(p, { mode: 0o700 }); return p; };
  const options = s => ({ stage: s, root, uid, gid, getUid: () => uid, now: () => now, readTarget: () => target });
  const pauseStage = stage('pause'), pause = createMaxDurableNativeOperation({ ...options(pauseStage), purpose: 'pause' });
  const original = fs.readFileSync(live), originalPins = durablePins(original);
  const pausePlan = await pause.prepare({ expectedSourceSha256: sha256(original), expectedTargetSha256: target,
    expectedCodeSha256: max_durableOperationCodeHash(), sourceCommit: commit, trustedPins: originalPins, native: await native() });
  async function post(op, plan, phase) {
    const before = { flows: JSON.parse(fs.readFileSync(live)), rev: revision };
    const begin = await op.begin({ expectedPlanSha256: plan.planSha256, native: await native() });
    const preserve = await createMaxDurableBodyPreserver(begin.seal, before);
    const result = await preserve({ request: { url: 'http://127.0.0.1:18801/flows', method: 'POST', apiVersion: 'v2', deploymentType: 'nodes' }, postBody: before });
    fs.writeFileSync(live, JSON.stringify(JSON.parse(result.postDataText).flows, null, 4));
    now += 1; const ackAt = now; revision += '-changed'; now += 1;
    const audit = { ...result.audit, status: 'FORWARDED_AWAITING_READBACK', forwarded: 1, rejected: 0, notAfter: begin.seal.notAfter };
    const confirmed = await op.confirm({ expectedPlanSha256: plan.planSha256, native: await native(), audit, httpStatus: 200, ackAt });
    assert.equal(confirmed.status, 'SOAKING'); return { begin, result, phase };
  }
  async function paused() {
    await pause.reserve({ expectedPlanSha256: pausePlan.planSha256, confirmation: 'RESERVE_MAX_DURABLE_PAUSE_NATIVE_NO_RESTART_147', native: await native() });
    await post(pause, pausePlan, 'pause');
  }
  async function activation() {
    const s = stage('activate'), op = createMaxDurableNativeOperation({ ...options(s), purpose: 'activate' }), raw = fs.readFileSync(live);
    const plan = await op.prepare({ expectedSourceSha256: sha256(raw), expectedTargetSha256: target,
      expectedCodeSha256: max_durableOperationCodeHash(), sourceCommit: commit, trustedPins: durablePins(raw),
      pauseStage, pausePlanSha256: pausePlan.planSha256, native: await native() });
    return { stage: s, op, plan };
  }
  return { root, live, lease, original, originalPins, target, commit, native, stage, options, pause, pauseStage, pausePlan,
    post, paused, activation, advance: ms => { now += ms; }, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
test('exact native pause→8+4 activation hands off only matching custody and finishes after full final soak', async () => {
  const f = await setup(); try {
    await f.paused(); const pausedRaw = fs.readFileSync(f.live), a = await f.activation();
    assert.equal(a.plan.changedNodeCount, 8); assert.equal(a.plan.addedNodeCount, 4);
    await a.op.reserve({ expectedPlanSha256: a.plan.planSha256, confirmation: 'RESERVE_MAX_DURABLE_ACTIVATE_NATIVE_NO_RESTART_147', native: await f.native() });
    const r = await f.post(a.op, a.plan, 'activate');
    assert.equal(r.begin.seal.purpose, 'activate');
    const expected = buildMaxDurableTransition(pausedRaw, durablePins(pausedRaw), 'activate');
    assert.deepEqual(JSON.parse(fs.readFileSync(f.live)), expected.flow);
    await assert.rejects(a.op.finish({ expectedPlanSha256: a.plan.planSha256, native: await f.native() }));
    f.advance(900001);
    const done = await a.op.finish({ expectedPlanSha256: a.plan.planSha256, native: await f.native() });
    assert.equal(done.leaseReleased, true); assert.equal(fs.existsSync(f.lease), false);
    assert.equal((await a.op.finish({ expectedPlanSha256: a.plan.planSha256, native: await f.native() })).leaseReleased, true);
  } finally { f.cleanup(); }
});
test('activation abort returns protected pause custody; foreign lease and corrupted pause backup refuse without writes', async () => {
  const f = await setup(); try {
    await f.paused(); const a = await f.activation(), before = fs.readFileSync(f.live), prior = fs.readFileSync(f.lease);
    await a.op.reserve({ expectedPlanSha256: a.plan.planSha256, confirmation: 'RESERVE_MAX_DURABLE_ACTIVATE_NATIVE_NO_RESTART_147', native: await f.native() });
    const aborted = await a.op.abort({ expectedPlanSha256: a.plan.planSha256, native: await f.native() });
    assert.equal(aborted.pauseCustodyReturned, true); assert.deepEqual(fs.readFileSync(f.lease), prior);
    assert.deepEqual(fs.readFileSync(f.live), before);
    await a.op.abort({ expectedPlanSha256: a.plan.planSha256, native: await f.native() });
    const foreign = JSON.parse(prior); foreign.stage += '-foreign'; fs.writeFileSync(f.lease, JSON.stringify(foreign));
    await assert.rejects(a.op.reserve({ expectedPlanSha256: a.plan.planSha256, confirmation: 'RESERVE_MAX_DURABLE_ACTIVATE_NATIVE_NO_RESTART_147', native: await f.native() }));
    assert.deepEqual(JSON.parse(fs.readFileSync(f.lease)), foreign);
    fs.writeFileSync(path.join(f.pauseStage, 'candidate.flow.json'), '{}');
    await assert.rejects(a.op.begin({ expectedPlanSha256: a.plan.planSha256, native: await f.native() }));
    assert.deepEqual(fs.readFileSync(f.live), before);
  } finally { f.cleanup(); }
});
test('paired inverse restores only paused source, retains v1 data responsibility and uses independent guarded custody', async () => {
  const f = await setup(); try {
    await f.paused(); const pausedRaw = fs.readFileSync(f.live), a = await f.activation();
    await a.op.reserve({ expectedPlanSha256: a.plan.planSha256, confirmation: 'RESERVE_MAX_DURABLE_ACTIVATE_NATIVE_NO_RESTART_147', native: await f.native() });
    await f.post(a.op, a.plan, 'activate');
    const s = path.join(f.root, '.padlhub-max_durable_recovery-stage-20261113T000000Z-123'); fs.mkdirSync(s, { mode: 0o700 });
    const op = createMaxDurableRecoveryNativeOperation(f.options(s)), raw = fs.readFileSync(f.live);
    const plan = await op.prepare({ expectedSourceSha256: sha256(raw), expectedTargetSha256: f.target,
      expectedCodeSha256: max_durable_recoveryOperationCodeHash(), sourceCommit: f.commit,
      forwardStage: a.stage, forwardPlanSha256: a.plan.planSha256, native: await f.native() });
    assert.equal(plan.changedNodeCount, 8); assert.equal(plan.removedNodeCount, 4);
    await op.reserve({ expectedPlanSha256: plan.planSha256, confirmation: 'RESERVE_MAX_DURABLE_RECOVERY_NATIVE_NO_RESTART_147', native: await f.native() });
    await f.post(op, plan, 'recover');
    assert.deepEqual(JSON.parse(fs.readFileSync(f.live)), JSON.parse(pausedRaw));
    assert.deepEqual(buildMaxDurableRecovery(raw, pausedRaw, durablePins(pausedRaw)).flow, JSON.parse(pausedRaw));
  } finally { f.cleanup(); }
});

for (const field of ['phase', 'ackSha256', 'sourceSha256', 'expiresAtMs']) test('corrupt predecessor '+field+' cannot replace activation custody', async () => {
  const f = await setup(); try {
    await f.paused(); const a = await f.activation();
    await a.op.reserve({expectedPlanSha256:a.plan.planSha256,confirmation:'RESERVE_MAX_DURABLE_ACTIVATE_NATIVE_NO_RESTART_147',native:await f.native()});
    const live=fs.readFileSync(f.live), lease=fs.readFileSync(f.lease), backup=path.join(a.stage,'predecessor.lease.json');
    const bad=JSON.parse(fs.readFileSync(backup));bad[field]=field==='expiresAtMs'?bad[field]+1:'corrupt';fs.writeFileSync(backup,JSON.stringify(bad));
    await assert.rejects(a.op.abort({expectedPlanSha256:a.plan.planSha256,native:await f.native()}),/PREDECESSOR_DRIFT/);
    assert.deepEqual(fs.readFileSync(f.live),live);assert.deepEqual(fs.readFileSync(f.lease),lease);
    assert.equal(fs.existsSync(path.join(a.stage,'abort.json')),false);
  } finally {f.cleanup();}
});
