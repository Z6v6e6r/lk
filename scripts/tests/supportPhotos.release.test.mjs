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
  const prepare = async (purpose, prior, options = {}) => {
    const stage = path.join(root, '.padlhub-support_photos-' + purpose + '-stage-20261116T000000Z-' + ++generation);
    fs.mkdirSync(stage, { mode: 0o700 });
    const op = createSupportPhotosNativeOperation({ stage, purpose, root, uid, gid, getUid: () => uid,
      now: () => now, readTarget: () => target });
    const plan = await op.prepare({ expectedSourceSha256: sha256(fs.readFileSync(live)), expectedTargetSha256: target,
      expectedCodeSha256: support_photosOperationCodeHash(), sourceCommit: commit, originalPins: supportPhotoPins(original),
      previousStage: prior?.stage, previousPlanSha256: prior?.plan.planSha256,
      expectedLegacyPredecessor: options.expectedLegacyPredecessor, native: await native() });
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
    const predecessor = legacyLease(f);
    let prior;
    for (const purpose of ['pause', 'install', 'resume', 'pause-photo', 'recover']) {
      const p = await f.prepare(purpose, prior, purpose === 'pause' ? predecessor : undefined);
      await f.reserve(p); await f.post(p); prior = p;
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

function legacyLease(f, overrides = {}) {
  const value = { formatVersion: 2, deploymentId: 'synthetic-previous-release', token: 'synthetic-owner-token',
    phase: 'soaking', acquiredAtMs: 1, expiresAtMs: 2,
    sourceSha256: 'c'.repeat(64), candidateSha256: sha256(f.original), ...overrides };
  const raw = Buffer.from(JSON.stringify(value, null, 3) + '\n');
  fs.writeFileSync(f.lease, raw, { mode: 0o600 });
  return { raw, value, expectedLegacyPredecessor: { sha256: sha256(raw), deploymentId: value.deploymentId } };
}

test('initial pause requires an explicit exact legacy predecessor and abort restores its original bytes idempotently', async () => {
  const f = await fixture();
  try {
    const predecessor = legacyLease(f), flow = fs.readFileSync(f.live);
    await assert.rejects(f.prepare('pause'), /LEGACY_PREDECESSOR_REQUIRED/);
    assert.deepEqual(fs.readFileSync(f.lease), predecessor.raw);
    const p = await f.prepare('pause', undefined, predecessor);
    await f.reserve(p);
    assert.deepEqual(fs.readFileSync(path.join(p.stage, 'predecessor.lease.json')), predecessor.raw);
    for (let i = 0; i < 2; i++) {
      const result = await p.op.abort({ expectedPlanSha256: p.plan.planSha256, native: await f.native() });
      assert.equal(result.previousCustodyReturned, true); assert.equal(result.leaseReleased, false);
      assert.deepEqual(fs.readFileSync(f.lease), predecessor.raw);
      assert.deepEqual(fs.readFileSync(f.live), flow);
    }
  } finally { f.cleanup(); }
});

test('initial pause refuses a different legacy owner, token, or presence after preparation', async () => {
  for (const change of ['owner', 'token', 'disappear', 'appear']) {
    const f = await fixture();
    try {
      const predecessor = change === 'appear' ? undefined : legacyLease(f);
      const p = await f.prepare('pause', undefined, predecessor);
      if (change === 'disappear') fs.unlinkSync(f.lease);
      else legacyLease(f, change === 'owner' ? { deploymentId: 'another-owner' }
        : change === 'token' ? { token: 'another-token' } : {});
      const current = fs.existsSync(f.lease) ? fs.readFileSync(f.lease) : null;
      await assert.rejects(f.reserve(p), /LEGACY_PREDECESSOR/);
      assert.deepEqual(fs.existsSync(f.lease) ? fs.readFileSync(f.lease) : null, current);
      assert.deepEqual(fs.readFileSync(f.live), f.original);
      assert.equal(fs.existsSync(path.join(p.stage, 'reserve.json')), false);
    } finally { f.cleanup(); }
  }
});

test('legacy handoff rejects active, wrong-source and non-soaking leases before producing a plan', async () => {
  for (const override of [{ expiresAtMs: Number.MAX_SAFE_INTEGER }, { candidateSha256: 'd'.repeat(64) },
    { phase: 'applying' }, { phase: 'rollback-restart-required' }]) {
    const f = await fixture();
    try {
      const predecessor = legacyLease(f, override);
      await assert.rejects(f.prepare('pause', undefined, predecessor), /LEGACY_PREDECESSOR_DRIFT/);
      assert.deepEqual(fs.readFileSync(f.lease), predecessor.raw);
      assert.deepEqual(fs.readFileSync(f.live), f.original);
    } finally { f.cleanup(); }
  }
});

test('legacy abort never returns corrupt custody or a lease after a consumed attempt', async () => {
  for (const mode of ['corrupt-backup', 'consumed-attempt', 'foreign-live-lease']) {
    const f = await fixture();
    try {
      const predecessor = legacyLease(f), p = await f.prepare('pause', undefined, predecessor);
      await f.reserve(p);
      if (mode === 'corrupt-backup') fs.writeFileSync(path.join(p.stage, 'predecessor.lease.json'), predecessor.raw + ' ');
      if (mode === 'consumed-attempt') await p.op.begin({ expectedPlanSha256: p.plan.planSha256, native: await f.native() });
      if (mode === 'foreign-live-lease') legacyLease(f, { token: 'new-foreign-token' });
      const lease = fs.readFileSync(f.lease);
      await assert.rejects(p.op.abort({ expectedPlanSha256: p.plan.planSha256, native: await f.native() }),
        /LEGACY_PREDECESSOR_DRIFT|ATTEMPT_MAY_HAVE_EFFECT|LEASE_BINDING/);
      assert.deepEqual(fs.readFileSync(f.lease), lease);
      assert.deepEqual(fs.readFileSync(f.live), f.original);
      assert.equal(fs.existsSync(path.join(p.stage, 'abort.json')), false);
    } finally { f.cleanup(); }
  }
});

test('reserve pins the captured predecessor even if its file changes between validation reads', async () => {
  const f = await fixture(), readFile = fs.readFileSync;
  try {
    const predecessor = legacyLease(f), p = await f.prepare('pause', undefined, predecessor);
    const inode = fs.statSync(f.lease).ino; let reads = 0, swapped = false;
    fs.readFileSync = function (file, ...args) {
      const data = readFile.call(fs, file, ...args);
      if (typeof file === 'number' && fs.fstatSync(file).ino === inode && ++reads === 2) {
        legacyLease(f, { token: 'changed-between-reads' }); swapped = true;
      }
      return data;
    };
    await assert.rejects(f.reserve(p), /PREDECESSOR_DRIFT/);
    fs.readFileSync = readFile;
    assert.equal(swapped, true);
    assert.equal(fs.existsSync(path.join(p.stage, 'predecessor.lease.json')), false);
    assert.equal(JSON.parse(fs.readFileSync(f.lease)).token, 'changed-between-reads');
    assert.deepEqual(fs.readFileSync(f.live), f.original);
  } finally { fs.readFileSync = readFile; f.cleanup(); }
});

test('retry cannot claim returned legacy custody when its lease is missing', async () => {
  const f = await fixture();
  try {
    const predecessor = legacyLease(f), p = await f.prepare('pause', undefined, predecessor);
    await f.reserve(p);
    await p.op.abort({ expectedPlanSha256: p.plan.planSha256, native: await f.native() });
    fs.unlinkSync(f.lease);
    await assert.rejects(p.op.abort({ expectedPlanSha256: p.plan.planSha256, native: await f.native() }),
      /PREDECESSOR_RETURN_MISSING/);
    assert.equal(fs.existsSync(f.lease), false);
  } finally { f.cleanup(); }
});

test('handback retry fsyncs the restored lease directory after an interrupted rename durability step', async () => {
  const f = await fixture(), fsync = fs.fsyncSync;
  try {
    const predecessor = legacyLease(f), p = await f.prepare('pause', undefined, predecessor);
    await f.reserve(p); let failed = false;
    fs.fsyncSync = function (fd) {
      if (!failed && fs.fstatSync(fd).isDirectory() && fs.readFileSync(f.lease).equals(predecessor.raw)) {
        failed = true; throw Error('SYNTHETIC_DIRECTORY_FSYNC');
      }
      return fsync.call(fs, fd);
    };
    await assert.rejects(p.op.abort({ expectedPlanSha256: p.plan.planSha256, native: await f.native() }),
      /SYNTHETIC_DIRECTORY_FSYNC/);
    assert.equal(failed, true); assert.deepEqual(fs.readFileSync(f.lease), predecessor.raw);
    let synced = false;
    fs.fsyncSync = function (fd) {
      if (fs.fstatSync(fd).isDirectory()) synced = true;
      return fsync.call(fs, fd);
    };
    assert.equal((await p.op.abort({ expectedPlanSha256: p.plan.planSha256, native: await f.native() })).previousCustodyReturned, true);
    assert.equal(synced, true); assert.deepEqual(fs.readFileSync(f.lease), predecessor.raw);
  } finally { fs.fsyncSync = fsync; f.cleanup(); }
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
