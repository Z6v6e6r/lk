import test from 'node:test';
import assert from 'node:assert/strict';
import { SpectatorTimeline } from '../../src/components/padel-jump/spectator/spectator-timeline.mjs';

const snap = (seq, t, overrides = {}) => ({
  runId: 'run-a', seq, t, x: t / 10, y: t / 20,
  score: seq * 3, lives: 5, elapsedMs: t,
  segmentId: 'level-1-life-1', status: 'running', ...overrides,
});
const tracker = (overrides = {}) => new SpectatorTimeline({ runId: 'run-a', sourceTimeAt: t => t, ...overrides });

test('delayed interpolation keeps HUD on the confirmed left snapshot', () => {
  const t = tracker();
  t.push(snap(0, 0), 10);
  t.push(snap(1, 200, { score: 2, lives: 4 }), 235);
  t.push(snap(2, 400, { score: 8, lives: 3 }), 431);
  const f = t.sample(700);
  assert.equal(f.playbackTimeMs, 300);
  assert.deepEqual(f.pose, { x: 30, y: 15, mode: 'interpolated' });
  assert.equal(f.confirmed.score, 2);
  assert.equal(f.confirmed.lives, 4);
  assert.equal(f.confirmed.elapsedMs, 200);
  assert.equal(f.confirmed.seq, 1);
  assert.equal(t.sample(800).confirmed.score, 8);
});

test('jitter in receipt times does not alter the pose clock', () => {
  const a = tracker(), b = tracker();
  for (const [seq, time] of [[0, 0], [1, 200], [2, 400]]) {
    a.push(snap(seq, time), time + 20);
    b.push(snap(seq, time), time + [20, 170, 40][seq]);
  }
  assert.deepEqual(a.sample(700).pose, b.sample(700).pose);
});

test('future snapshots do not appear during initial buffering', () => {
  const t = tracker();
  t.push(snap(0, 500, { score: 99 }), 520);
  const f = t.sample(700);
  assert.equal(f.state, 'buffering');
  assert.equal(f.pose, null);
  assert.equal(f.confirmed, null);
  assert.equal(t.sample(900).confirmed.score, 99);
});

test('respawn and final states are discontinuities, never blended early', () => {
  const t = tracker({ delayMs: 100 });
  t.push(snap(0, 0, { x: 10, y: 10 }), 10);
  t.push(snap(1, 200, { x: 90, y: 900, lives: 0, segmentId: 'respawn-2' }), 220);
  assert.equal(t.sample(250).pose.x, 10);
  let f = t.sample(300);
  assert.equal(f.pose.x, 90);
  assert.equal(f.confirmed.lives, 0);
  assert.deepEqual(f.transition, { type: 'segment', from: 'level-1-life-1', to: 'respawn-2' });
  assert.equal(t.sample(310).transition, null);
  t.push(snap(2, 400, { x: 15, y: 25, segmentId: 'respawn-2', score: 11, status: 'finished' }), 410);
  assert.equal(t.sample(450).confirmed.status, 'running');
  assert.equal(t.sample(450).pose.x, 90);
  f = t.sample(500);
  assert.equal(f.state, 'finished');
  assert.equal(f.confirmed.score, 11);
  assert.equal(f.confirmed.elapsedMs, 400);
  assert.deepEqual(f.transition, { type: 'finished' });
});

test('prediction has a strict time horizon then holds; stale never invents results', () => {
  const t = tracker({ delayMs: 100, maxExtrapolationMs: 150, staleAfterMs: 1000 });
  t.push(snap(0, 0), 10);
  t.push(snap(1, 200, { score: 7 }), 210);
  const moving = t.sample(400);
  assert.equal(moving.pose.x, 30);
  assert.equal(moving.pose.mode, 'extrapolated');
  const held = t.sample(800);
  assert.equal(held.pose.x, 35);
  assert.equal(held.state, 'holding');
  const stale = t.sample(1500);
  assert.equal(stale.pose.x, 35);
  assert.equal(stale.state, 'stale');
  assert.equal(stale.confirmed.score, 7);
  assert.equal(stale.confirmed.lives, 5);
  assert.equal(stale.confirmed.status, 'running');
});

test('duplicates, reordered snapshots, wrong run and source regressions are rejected', () => {
  const t = tracker();
  assert.equal(t.push(snap(3, 400), 410).accepted, true);
  assert.equal(t.push(snap(3, 400, { score: 999 }), 420).reason, 'old-sequence');
  assert.equal(t.push(snap(2, 200), 430).reason, 'old-sequence');
  assert.equal(t.push(snap(4, 300), 440).reason, 'regressing-source-time');
  assert.equal(t.push(snap(5, 600, { runId: 'other' }), 610).reason, 'wrong-run');
  assert.equal(t.sample(900).confirmed.score, 9);
});

test('finished run is terminal and exact through long disconnection', () => {
  const t = tracker();
  t.push(snap(0, 100, { status: 'finished', score: 133, lives: 0, elapsedMs: 368700 }), 105);
  assert.equal(t.push(snap(1, 200), 210).reason, 'terminal-run');
  const f = t.sample(10000);
  assert.equal(f.state, 'finished');
  assert.equal(f.stale, false);
  assert.equal(f.confirmed.score, 133);
  assert.equal(f.confirmed.elapsedMs, 368700);
  assert.equal(f.confirmed.lives, 0);
  assert.equal(f.pose.x, 10);
});

test('a clock correction cannot rewind playback or confirmed values', () => {
  let correction = 0;
  const t = tracker({ sourceTimeAt: local => local + correction });
  t.push(snap(0, 0), 10);
  t.push(snap(1, 200), 210);
  t.push(snap(2, 400), 410);
  const before = t.sample(700);
  correction = -250;
  const after = t.sample(720);
  assert.equal(after.playbackTimeMs, before.playbackTimeMs);
  assert.deepEqual(after.pose, before.pose);
  assert.equal(after.confirmed.seq, before.confirmed.seq);
});

test('buffer stays bounded even if frames stop; no future HUD leaks on eviction', () => {
  const t = tracker({ maxSnapshots: 4 });
  t.push(snap(0, 0), 0);
  t.sample(400);
  for (let i = 1; i <= 50; i++) t.push(snap(i, i * 20), i * 20);
  assert.equal(t.bufferedCount, 4);
  const f = t.sample(1000); // playback 600, retained samples begin at 940
  assert.equal(f.state, 'buffering');
  assert.equal(f.confirmed.seq, 0);
  assert.equal(t.sample(1400).confirmed.seq, 50);
  assert.ok(t.bufferedCount <= 4);
});

test('explicit reset changes run and clock epoch; previous packets stay excluded', () => {
  const t = tracker();
  t.push(snap(20, 10000, { status: 'finished' }), 10010);
  t.sample(11000);
  t.reset({ runId: 'run-b', sourceTimeAt: local => local - 20000 });
  assert.equal(t.bufferedCount, 0);
  assert.equal(t.push(snap(21, 10200), 20000).reason, 'wrong-run');
  t.push(snap(0, 0, { runId: 'run-b', lives: 12 }), 20010);
  const f = t.sample(20400);
  assert.equal(f.runId, 'run-b');
  assert.equal(f.confirmed.seq, 0);
  assert.equal(f.confirmed.lives, 12);
  assert.equal(f.state, 'playing');
});

test('same-timestamp newer sequence uses latest confirmed facts', () => {
  const t = tracker();
  t.push(snap(0, 100), 110);
  t.push(snap(1, 100, { score: 12 }), 120);
  assert.equal(t.sample(500).confirmed.score, 12);
});

test('same-run reconnect preserves terminal lock and accepted sequence', () => {
  const t = tracker();
  t.push(snap(7, 400, { status: 'finished', score: 42 }), 410);
  t.sample(800);
  assert.throws(() => t.reset({ runId: 'run-a', sourceTimeAt: x => x }), /same-run reconnect/);
  t.reanchorClock(local => local - 100);
  assert.equal(t.push(snap(6, 300), 1000).reason, 'old-sequence');
  assert.equal(t.push(snap(8, 600), 1010).reason, 'terminal-run');
  const f = t.sample(1200);
  assert.equal(f.state, 'finished');
  assert.equal(f.confirmed.score, 42);
});

test('invalid packets are rejected before affecting the queue', () => {
  const t = tracker();
  assert.throws(() => t.push(snap(0, 0, { x: NaN }), 0), /x must be finite/);
  assert.throws(() => t.push(snap(0, 0, { score: 0.5 }), 0), /score/);
  assert.throws(() => t.push(snap(0, 0, { lives: -1 }), 0), /lives/);
  assert.equal(t.bufferedCount, 0);
});
