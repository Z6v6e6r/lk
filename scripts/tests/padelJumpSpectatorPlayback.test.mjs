import test from 'node:test';
import assert from 'node:assert/strict';
import { createCampaignGame } from '../../src/components/padel-jump/engine.ts';
import { LIVE_ENGINE_VERSION, LIVE_RULE } from '../../src/components/padel-jump/live-contract.ts';

const module = await import('../../src/components/padel-jump/spectator/playback.mjs').catch(() => ({}));
const runId = '00000000-0000-4000-8000-000000000001';
function packet(seq, t, x, score = 0, status = 'running') {
  const game = createCampaignGame(); game.mode = 'running'; game.ball.x = x; game.camera = x;
  return { schema: 'jump-spectator-v1', epoch: 'test-process-epoch', engine: LIVE_ENGINE_VERSION, rule: LIVE_RULE, sourceNow: t, catalogVersion: 'test',
    scenes: { [runId]: { segmentId: runId + ':1', game } }, events: [], gaps: [],
    poses: [{ runId, seq, t, x, y: 64, score, lives: 5, elapsedMs: t, segmentId: runId + ':1', status, phase: status === 'finished' ? 'finished' : 'playing', station: 0, section: 0, changes: { ball: { x }, camera: x } }] };
}

test('real playback buffers pose and camera together; HUD stays confirmed and finish survives reconnect', () => {
  assert.equal(typeof module.createSpectatorPlayback, 'function', 'the real renderer needs an integrated playback adapter');
  const playback = module.createSpectatorPlayback();
  playback.ingest(packet(0, 0, 0), { sentAt: 0, receivedAt: 0, reanchor: true });
  playback.ingest(packet(1, 500, 100, 2), { sentAt: 500, receivedAt: 500 });
  playback.ingest(packet(2, 1000, 200, 3), { sentAt: 1000, receivedAt: 1000 });
  const frame = playback.frame(runId, 1450);
  assert.equal(frame.pose.x, 50);
  assert.equal(frame.game.camera, 50);
  assert.equal(frame.confirmed.score, 0);
  playback.ingest(packet(3, 1500, 210, 4, 'finished'), { sentAt: 1500, receivedAt: 1500 });
  const final = playback.frame(runId, 3000);
  assert.equal(final.state, 'finished'); assert.equal(final.confirmed.score, 4); assert.equal(final.confirmed.elapsedMs, 1500);
  const instance = playback.runs.get(runId).timeline;
  playback.ingest(packet(4, 4000, 400, 100), { sentAt: 4000, receivedAt: 4100, reanchor: true });
  assert.equal(playback.runs.get(runId).timeline, instance);
  assert.equal(playback.frame(runId, 5000).confirmed.score, 4);
});

test('exceeded delay budget holds the last presented scene and requests fresh state', () => {
  let resync = 0;
  const playback = module.createSpectatorPlayback({ onResync: () => resync++ });
  playback.ingest(packet(0, 0, 10), { sentAt: 0, receivedAt: 0, reanchor: true });
  const held = playback.frame(runId, 1300);
  playback.ingest(packet(1, 500, 200, 5), { sentAt: 500, receivedAt: 6500 });
  const stale = playback.frame(runId, 6600);
  assert.equal(stale.state, 'stale'); assert.equal(stale.pose.x, held.pose.x); assert.equal(stale.confirmed.score, 0);
  assert.ok(resync > 0);
});

test('bounded playback keeps seq and clock mapping through 15 minutes of jitter', () => {
  const playback = module.createSpectatorPlayback();
  playback.ingest(packet(0, 0, 0), { sentAt: 0, receivedAt: 0, reanchor: true });
  let previousTime = -Infinity;
  for (let seq = 1; seq <= 1800; seq++) {
    const t = seq * 500, receivedAt = t + 1000 + seq % 4 * 75;
    playback.ingest(packet(seq, t, seq % 300, seq % 50), { sentAt: t, receivedAt });
    const frame = playback.frame(runId, receivedAt);
    assert.ok(frame.playbackTimeMs >= previousTime); previousTime = frame.playbackTimeMs;
    const run = playback.runs.get(runId);
    assert.ok(run.samples.size <= 64); assert.ok(run.scenes.size <= 128); assert.ok(run.timeline.bufferedCount <= 64);
    if (frame.confirmed) assert.ok(frame.confirmed.score <= 49);
  }
  assert.equal(playback.sourceTimeAt(900000), 900000, 'packet arrival never reanchors the source clock');
  assert.ok(playback.runs.get(runId).policy.recommendation(901225).stateAgeP90Ms >= 1000);
});

test('a reliable journal gap holds the picture until an explicit full-state baseline', () => {
  let resync = 0;
  const playback = module.createSpectatorPlayback({ onResync: () => resync++ });
  playback.ingest(packet(0, 0, 10), { sentAt: 0, receivedAt: 0, reanchor: true });
  playback.frame(runId, 1300);
  const gap = packet(5, 1500, 300, 3); gap.gaps = [runId];
  playback.ingest(gap, { sentAt: 1500, receivedAt: 1500 });
  assert.ok(resync > 0, 'missing reliable transitions require explicit full-state reconciliation');
  assert.equal(playback.frame(runId, 3000).state, 'stale');
  assert.equal(playback.frame(runId, 3000).confirmed.score, 0);
  gap.baselines = { [runId]: 10 };
  playback.ingest(gap, { sentAt: 3000, receivedAt: 3000, reanchor: true });
  assert.equal(playback.frame(runId, 3000).confirmed.score, 3);
  assert.equal(playback.requestState([runId]).acks[runId], 10);
});

test('incompatible engine or ranking rule is rejected before creating a timeline', () => {
  for (const patch of [{ engine: 'old' }, { rule: 'old' }]) {
    const playback = module.createSpectatorPlayback();
    assert.throws(() => playback.ingest({ ...packet(0, 0, 0), ...patch }, { sentAt: 0, receivedAt: 0 }), /SPECTATOR_VERSION_INVALID/);
    assert.equal(playback.runs.size, 0);
  }
});

test('a catalog replacement retains the confirmed final card for a bounded display interval', () => {
  const playback = module.createSpectatorPlayback();
  assert.equal(typeof playback.withFinished, 'function', 'catalog changes must not erase an undelivered final frame');
  playback.ingest(packet(0, 0, 10), { sentAt: 0, receivedAt: 0, reanchor: true });
  playback.ingest(packet(1, 500, 20, 7, 'finished'), { sentAt: 500, receivedAt: 500 });
  const previous = [{ runId, name: 'Тест' }], current = [{ runId: 'new-run', name: 'Новая попытка' }];
  assert.deepEqual(playback.withFinished(current, previous, 600).map(p => p.runId), ['new-run', runId]);
  playback.ingest(packet(1, 500, 20, 7, 'finished'), { sentAt: 5000, receivedAt: 5000, reanchor: true });
  assert.deepEqual(playback.withFinished(current, previous, 10501).map(p => p.runId), ['new-run'], 'duplicate full snapshots cannot extend final retention forever');
});

test('a service clock epoch change anchors new attempts before their first rendered sample', () => {
  const playback = module.createSpectatorPlayback();
  playback.ingest(packet(0, 900000, 10), { sentAt: 900000, receivedAt: 900000 });
  const restarted = packet(0, 0, 200, 9); restarted.epoch = 'new-process-epoch';
  restarted.poses[0].runId = '00000000-0000-4000-8000-000000000002';
  restarted.scenes[restarted.poses[0].runId] = restarted.scenes[runId]; delete restarted.scenes[runId];
  playback.ingest(restarted, { sentAt: 901000, receivedAt: 901000 });
  assert.equal(playback.sourceTimeAt(901000), 0, 'server monotonic restart requires a new explicit epoch anchor');
  assert.equal(playback.frame(restarted.poses[0].runId, 901000).confirmed, null);
});

test('moving platform identity remains aligned when another platform disappears between samples', () => {
  const playback = module.createSpectatorPlayback(), left = packet(0, 0, 0);
  const platforms = left.scenes[runId].game.platforms;
  left.scenes[runId].game.platforms = [{ ...platforms[0], x: 0 }, { ...platforms[1], x: 10 }];
  playback.ingest(left, { sentAt: 0, receivedAt: 0 });
  const right = packet(1, 500, 100); right.scenes = {};
  right.poses[0].changes.platforms = { $indices: [1], $changes: { 0: { x: 110 } } };
  playback.ingest(right, { sentAt: 500, receivedAt: 500 });
  const frame = playback.frame(runId, 1450);
  assert.equal(frame.game.platforms.find(p => p.id === platforms[1].id).x, 60);
  assert.equal(frame.confirmed.score, 0);
});
