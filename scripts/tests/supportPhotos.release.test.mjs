import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sha256 } from '../nodered_max_outbox_resume.mjs';
import { supportPhotoFixture, supportPhotoPins } from './fixtures/support-photos-release.mjs';
import { PHOTO_POLLERS, buildSupportPhotoTransition, buildSupportPhotoStates, supportPhotoOperations } from '../nodered_support_photos_release.mjs';
import { createSupportPhotosBodyPreserver, support_photosGraphHash, support_photosOrderedGraphHash } from '../nodered_reviewed_flow_deploy/support_photos_body_preserver.mjs';
import { createSupportPhotosNativeOperation, support_photosOperationCodeHash } from '../nodered_reviewed_flow_deploy/support_photos_native_operation.mjs';

test('closed pause2/install8+9/resume2 and paused inverse preserve inputs, unrelated fields, gateway and order', () => {
  const original = JSON.stringify(supportPhotoFixture()), pins = supportPhotoPins(original), before = JSON.stringify(pins);
  let current = original;
  const counts = [[2, 0, 0], [8, 9, 0], [2, 0, 0], [2, 0, 0], [8, 0, 9]];
  for (const [index, purpose] of ['pause', 'install', 'resume', 'pause-photo', 'recover'].entries()) {
    const result = buildSupportPhotoTransition(current, original, pins, purpose);
    assert.deepEqual([result.changedIds.length, result.addedIds.length, result.removedIds.length], counts[index]);
    assert.deepEqual(result.flow.find(n => n.id === 'unrelated'), JSON.parse(original).find(n => n.id === 'unrelated'));
    current = result.candidateJson;
  }
  assert.deepEqual(JSON.parse(current), buildSupportPhotoStates(original, pins).originalPaused);
  assert.equal(JSON.stringify(pins), before);
  const bad = JSON.parse(current); bad.find(n => n.id === 'unrelated').opaque.retained = false;
  assert.throws(() => buildSupportPhotoTransition(JSON.stringify(bad), original, pins, 'install'), /SOURCE_DRIFT/);
  assert.throws(() => buildSupportPhotoTransition(original, original, pins, 'resume'), /SOURCE_DRIFT/);
  const states = buildSupportPhotoStates(original, pins), wrong = structuredClone(states.photoPaused);
  wrong.find(n => n.id === PHOTO_POLLERS[0]).d = false;
  assert.throws(() => supportPhotoOperations(states.originalPaused, wrong, 'install'), /EDIT_SCOPE|NOT_PAUSED/);
  wrong.reverse(); assert.throws(() => supportPhotoOperations(states.originalPaused, wrong, 'install'));
});

async function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'support-photo-custody-')));
  fs.chmodSync(root, 0o700);
  let now = Date.now(), revision = 'synthetic-original';
  const uid = process.getuid(), gid = process.getgid(), target = 'a'.repeat(64), commit = 'b'.repeat(40);
  const live = path.join(root, 'flows.json'), lease = path.join(root, '.padlhub-reviewed-flow-deploy.lease.json');
  const original = Buffer.from(JSON.stringify(supportPhotoFixture(), null, 4));
  fs.writeFileSync(live, original, { mode: 0o600 });
  const native = async () => {
    const flow = JSON.parse(fs.readFileSync(live));
    return { origin: 'http://127.0.0.1:18801', requestedAt: new Date(now).toISOString(), observedAt: new Date(now).toISOString(),
      graphSha256: await support_photosGraphHash(flow), orderedGraphSha256: await support_photosOrderedGraphHash(flow),
      editorOrderedGraphSha256: await support_photosOrderedGraphHash(flow), revisionSha256: sha256(revision) };
  };
  let generation = 0;
  const prepare = async (purpose, prior) => {
    const stage = path.join(root, '.padlhub-support_photos-' + purpose + '-stage-20261116T000000Z-' + ++generation);
    fs.mkdirSync(stage, { mode: 0o700 });
    const op = createSupportPhotosNativeOperation({ stage, purpose, root, uid, gid, getUid: () => uid,
      now: () => now, readTarget: () => target });
    const plan = await op.prepare({ expectedSourceSha256: sha256(fs.readFileSync(live)), expectedTargetSha256: target,
      expectedCodeSha256: support_photosOperationCodeHash(), sourceCommit: commit, originalPins: supportPhotoPins(original),
      previousStage: prior?.stage, previousPlanSha256: prior?.plan.planSha256, native: await native() });
    return { stage, op, plan, purpose };
  };
  const reserve = async p => p.op.reserve({ expectedPlanSha256: p.plan.planSha256,
    confirmation: 'RESERVE_SUPPORT_PHOTOS_' + p.purpose.toUpperCase() + '_NATIVE_NO_RESTART_147', native: await native() });
  const post = async (p, confirm = true) => {
    const snapshot = { rev: revision, flows: JSON.parse(fs.readFileSync(live)) };
    const begin = await p.op.begin({ expectedPlanSha256: p.plan.planSha256, native: await native() });
    const preserver = await createSupportPhotosBodyPreserver(begin.seal, snapshot);
    const result = await preserver({ request: { url: 'http://127.0.0.1:18801/flows', method: 'POST', apiVersion: 'v2', deploymentType: 'nodes' }, postBody: snapshot });
    fs.writeFileSync(live, JSON.stringify(JSON.parse(result.postDataText).flows, null, 4));
    now++; const ackAt = now; revision += '-post'; now++;
    if (confirm) await p.op.confirm({ expectedPlanSha256: p.plan.planSha256, native: await native(), httpStatus: 200, ackAt,
      audit: { ...result.audit, status: 'FORWARDED_AWAITING_READBACK', forwarded: 1, rejected: 0, notAfter: begin.seal.notAfter } });
    return { begin, result };
  };
  return { root, live, lease, original, native, prepare, reserve, post, advance: ms => { now += ms; },
    changeRevision: () => { revision += '-foreign'; },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('native custody hands off each exact phase and recovery removes only nine additions while consumers stay paused', async () => {
  const f = await fixture();
  try {
    let prior;
    for (const purpose of ['pause', 'install', 'resume', 'pause-photo', 'recover']) {
      const p = await f.prepare(purpose, prior); await f.reserve(p); await f.post(p); prior = p;
    }
    assert(PHOTO_POLLERS.every(id => JSON.parse(fs.readFileSync(f.live)).find(n => n.id === id).d === true));
    assert.equal(JSON.parse(fs.readFileSync(f.live)).length, JSON.parse(f.original).length);
    await assert.rejects(prior.op.finish({ expectedPlanSha256: prior.plan.planSha256, native: await f.native() }), /SOAK/);
    f.advance(900001);
    assert.equal((await prior.op.finish({ expectedPlanSha256: prior.plan.planSha256, native: await f.native() })).leaseReleased, true);
    assert.equal(fs.existsSync(f.lease), false);
    assert.equal((await prior.op.finish({ expectedPlanSha256: prior.plan.planSha256, native: await f.native() })).leaseReleased, true);
  } finally { f.cleanup(); }
});

test('abort before attempt returns predecessor custody; corrupt/foreign predecessor refuses without a flow write', async () => {
  const f = await fixture();
  try {
    const pause = await f.prepare('pause'); await f.reserve(pause); await f.post(pause);
    const originalLease = fs.readFileSync(f.lease), originalFlow = fs.readFileSync(f.live);
    const install = await f.prepare('install', pause); await f.reserve(install);
    const out = await install.op.abort({ expectedPlanSha256: install.plan.planSha256, native: await f.native() });
    assert.equal(out.previousCustodyReturned, true); assert.deepEqual(fs.readFileSync(f.lease), originalLease);
    assert.deepEqual(fs.readFileSync(f.live), originalFlow);
    const foreign = JSON.parse(originalLease); foreign.planSha256 = 'f'.repeat(64); fs.writeFileSync(f.lease, JSON.stringify(foreign));
    await assert.rejects(install.op.reserve({ expectedPlanSha256: install.plan.planSha256,
      confirmation: 'RESERVE_SUPPORT_PHOTOS_INSTALL_NATIVE_NO_RESTART_147', native: await f.native() }));
    assert.deepEqual(fs.readFileSync(f.live), originalFlow);
  } finally { f.cleanup(); }
});

test('lost ACK is observed without replay; explicit adoption starts a new complete soak and a consumed attempt cannot retry', async () => {
  const f = await fixture();
  try {
    const p = await f.prepare('pause'); await f.reserve(p); await f.post(p, false); f.advance(300001);
    const result = await p.op.reconcile({ expectedPlanSha256: p.plan.planSha256, native: await f.native() });
    assert.equal(result.status, 'POST'); assert.equal(result.automaticRetry, false);
    await assert.rejects(p.op.begin({ expectedPlanSha256: p.plan.planSha256, native: await f.native() }));
    const n = await f.native(); await p.op.adopt({ expectedPlanSha256: p.plan.planSha256, native: n,
      expectedRevisionSha256: n.revisionSha256, confirmation: 'ADOPT_OBSERVED_SUPPORT_PHOTOS_PAUSE_POST_NO_REPLAY_147' });
    await assert.rejects(p.op.finish({ expectedPlanSha256: p.plan.planSha256, native: await f.native() }));
  } finally { f.cleanup(); }
});

test('completed forward retains a protected recovery path; intermediate phases cannot release their custody', async () => {
  const f = await fixture();
  try {
    let prior;
    for (const purpose of ['pause', 'install', 'resume']) {
      const p = await f.prepare(purpose, prior); await f.reserve(p); await f.post(p); prior = p;
      if (purpose !== 'resume') await assert.rejects(p.op.finish({ expectedPlanSha256: p.plan.planSha256,
        native: await f.native() }), /INTERMEDIATE_FINISH/);
    }
    f.advance(900001);
    await prior.op.finish({ expectedPlanSha256: prior.plan.planSha256, native: await f.native() });
    assert.equal(fs.existsSync(f.lease), false);
    const paused = await f.prepare('pause-photo', prior); await f.reserve(paused);
    const aborted = await paused.op.abort({ expectedPlanSha256: paused.plan.planSha256, native: await f.native() });
    assert.equal(aborted.leaseReleased, true); assert.equal(fs.existsSync(f.lease), false);
    const p = await f.prepare('pause-photo', prior); await f.reserve(p); await f.post(p);
    const recovered = await f.prepare('recover', p); await f.reserve(recovered); await f.post(recovered);
    assert.equal(JSON.parse(fs.readFileSync(f.live)).length, JSON.parse(f.original).length);
    assert(PHOTO_POLLERS.every(id => JSON.parse(fs.readFileSync(f.live)).find(n => n.id === id).d === true));
  } finally { f.cleanup(); }
});

test('same graph with an intervening revision cannot inherit predecessor custody', async () => {
  const f = await fixture();
  try {
    const p = await f.prepare('pause'); await f.reserve(p); await f.post(p);
    const flow = fs.readFileSync(f.live), lease = fs.readFileSync(f.lease); f.changeRevision();
    await assert.rejects(f.prepare('install', p), /PREVIOUS_ACK/);
    assert.deepEqual(fs.readFileSync(f.live), flow); assert.deepEqual(fs.readFileSync(f.lease), lease);
    const stage = path.join(f.root, '.padlhub-support_photos-install-stage-20261116T000000Z-2');
    assert.deepEqual(fs.readdirSync(stage), []);
  } finally { f.cleanup(); }
});

test('canonical postimage with different disk bytes is never confirmed or adopted', async () => {
  const f = await fixture();
  try {
    const p = await f.prepare('pause'); await f.reserve(p); await f.post(p, false);
    const graph = JSON.parse(fs.readFileSync(f.live)).map(node => Object.fromEntries(Object.entries(node).reverse()));
    fs.writeFileSync(f.live, JSON.stringify(graph, null, 4));
    const result = await p.op.reconcile({ expectedPlanSha256: p.plan.planSha256, native: await f.native() });
    assert.equal(result.status, 'UNKNOWN');
    const n = await f.native(); await assert.rejects(p.op.adopt({ expectedPlanSha256: p.plan.planSha256, native: n,
      expectedRevisionSha256: n.revisionSha256, confirmation: 'ADOPT_OBSERVED_SUPPORT_PHOTOS_PAUSE_POST_NO_REPLAY_147' }), /POST_DISK_ENCODING/);
    assert.equal(fs.existsSync(path.join(p.stage, 'ack.json')), false);
  } finally { f.cleanup(); }
});
