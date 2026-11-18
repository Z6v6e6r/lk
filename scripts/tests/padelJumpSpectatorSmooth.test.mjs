import test from 'node:test';
import assert from 'node:assert/strict';
import { createCampaignGame, HEIGHT } from '../../src/components/padel-jump/engine.ts';
import { arcPose, ballisticY, createSmoothMotion } from '../../src/components/padel-jump/spectator/smooth-motion.mjs';
import { createDemoRun, createDemoShow, DEMO_SCENARIOS } from '../../src/components/padel-jump/spectator/demo-runs.mjs';

const runId = '00000000-0000-4000-8000-000000000001';
function game(x, y, vx = 0, vy = 0) {
  const g = createCampaignGame(); g.mode = 'running';
  g.ball = { x, y, vx, vy }; g.camera = Math.max(0, y - HEIGHT * 0.43);
  return g;
}
function frame(g, { seq = 1, state = 'playing', segment = 1, elapsedMs = 1000, phase = 'playing', status = 'running', score = 0 } = {}) {
  return { runId, state, pose: state === 'playing' ? { x: g.ball.x, y: g.ball.y, mode: 'interpolated' } : null, game: g,
    confirmed: { runId, seq, segmentId: `${runId}:${segment}`, elapsedMs, phase, status, score, lives: 5, station: 0, section: 0 } };
}

test('arc pose starts and ends exactly on the confirmed samples and follows gravity between them', () => {
  const left = game(100, 400, 0, 300), right = game(200, 380, 0, -200);
  assert.deepEqual(arcPose(left, right, 0, 500), { x: 100, y: 400 });
  const end = arcPose(left, right, 1, 500);
  assert.equal(end.x, 200); assert.ok(Math.abs(end.y - 380) < 1e-9);
  const mid = arcPose(left, right, 0.5, 500);
  // A rising ball keeps rising before gravity brings it down: above the straight line.
  assert.ok(mid.y > 390, `arc ${mid.y} should be above the chord`);
  assert.ok(ballisticY(left, 0.1) > 400);
});

test('arc pose falls back to a gentle ease when the samples imply an unseen bounce or boost', () => {
  const left = game(100, 400, 0, 0), right = game(100, 900, 0, 0);
  const quarter = arcPose(left, right, 0.25, 500);
  assert.ok(quarter.y > 400 && quarter.y < 650);
});

test('coasting keeps the ball moving through a network gap and never shows a local failure', () => {
  const smooth = createSmoothMotion({ coastMs: 8000 });
  const g = game(210, 300, 0, 200);
  smooth.present(runId, frame(g), 0);
  const stale = { ...frame(g), state: 'stale', pose: { x: 210, y: 300, mode: 'held' } };
  let lowest = Infinity, moved = 0, last = null;
  for (let now = 33; now <= 6000; now += 33) {
    const out = smooth.present(runId, stale, now);
    assert.equal(out.state, 'playing', 'the picture keeps playing during the gap');
    assert.equal(out.confirmed.phase, 'playing');
    assert.equal(out.confirmed.lives, 5, 'lives are never changed locally');
    lowest = Math.min(lowest, out.game.ball.y - out.game.camera);
    if (last && (out.game.ball.x !== last.x || out.game.ball.y !== last.y)) moved++;
    last = { ...out.game.ball };
  }
  assert.ok(moved > 150, 'ball keeps moving');
  assert.ok(lowest > 0, 'ball never leaves the bottom of the screen locally');
});

test('after the coast budget the picture holds and reports the stale state', () => {
  const smooth = createSmoothMotion({ coastMs: 1000 });
  const g = game(210, 300, 0, 200);
  smooth.present(runId, frame(g), 0);
  const stale = { ...frame(g), state: 'stale' };
  smooth.present(runId, stale, 500);
  assert.equal(smooth.present(runId, stale, 1200).state, 'playing');
  assert.equal(smooth.present(runId, stale, 2600).state, 'stale');
});

test('recovery eases from the coasted picture to the confirmed one instead of jumping', () => {
  const smooth = createSmoothMotion({ blendMs: 600 });
  smooth.present(runId, frame(game(100, 300, 0, 0)), 0);
  smooth.present(runId, { ...frame(game(100, 300, 0, 0)), state: 'stale' }, 100);
  const coasted = smooth.present(runId, { ...frame(game(100, 300, 0, 0)), state: 'stale' }, 200).game.ball;
  const target = game(320, 700, 0, 0);
  const first = smooth.present(runId, frame(target, { seq: 2 }), 233).game.ball;
  assert.ok(Math.abs(first.x - coasted.x) < Math.abs(target.ball.x - coasted.x) / 2, 'no snap on recovery');
  const done = smooth.present(runId, frame(target, { seq: 3 }), 900).game.ball;
  assert.equal(done.x, 320); assert.equal(done.y, 700);
});

test('confirmed transitions (failure, retry, new level) are shown immediately', () => {
  const smooth = createSmoothMotion();
  smooth.present(runId, frame(game(100, 300)), 0);
  smooth.present(runId, { ...frame(game(100, 300)), state: 'stale' }, 300);
  const retry = frame(game(210, 64), { segment: 2, phase: 'retry', seq: 9 });
  const out = smooth.present(runId, retry, 333);
  assert.equal(out, retry, 'a new segment is passed through untouched');
  const next = frame(game(210, 64), { segment: 3, seq: 10 });
  assert.equal(smooth.present(runId, next, 400).game.ball.x, 210);
});

test('the running clock ticks locally, stays monotonic and never runs far ahead of confirmation', () => {
  const smooth = createSmoothMotion({ clockLeadMs: 2500 });
  const g = game(210, 300, 0, 200);
  let previous = 0;
  for (let now = 0; now <= 5000; now += 100) {
    const out = smooth.present(runId, frame(g, { seq: 1, elapsedMs: 10000 }), now);
    assert.ok(out.confirmed.elapsedMs >= previous); previous = out.confirmed.elapsedMs;
    assert.ok(out.confirmed.elapsedMs <= 12500);
  }
  assert.equal(previous, 12000);
  const finished = smooth.present(runId, frame(g, { seq: 2, elapsedMs: 10400, status: 'finished', phase: 'finished', state: 'finished' }), 5100);
  assert.equal(finished.confirmed.elapsedMs, 10400, 'the final time is always the confirmed one');
});

test('seven offline demo scenarios exist (up to 16 players), run on the real engine and are always labelled demo', () => {
  assert.deepEqual(Object.keys(DEMO_SCENARIOS), ['1', '2', '3', '4', '5', '6', '7']);
  assert.equal(DEMO_SCENARIOS[6].runs.length, 7); assert.equal(DEMO_SCENARIOS[7].runs.length, 16);
  for (const scenario of [...Object.keys(DEMO_SCENARIOS), 'loop']) {
    const show = createDemoShow(scenario);
    const seen = new Set();
    for (let t = 0; t <= 60; t += 1 / 15) for (const run of show.players(t)) {
      assert.equal(run.demo, true);
      const f = run.frameAt(t);
      assert.ok(f.game.campaign && Number.isFinite(f.game.ball.y));
      seen.add(run.runId);
    }
    assert.ok(seen.size >= 1, `scenario ${scenario} shows players`);
  }
});

test('a demo run is deterministic and finishes or loses lives within bounds', () => {
  const describe = () => {
    const run = createDemoRun({ runId: 'demo', name: 'Демо', station: 3, sections: 2, misses: 2, seed: 5 });
    const phases = [];
    for (let t = 0; t <= 120; t += 1 / 30) { const c = run.frameAt(t).confirmed; if (phases.at(-1) !== c.phase) phases.push(c.phase); }
    return { phases, lives: run.frameAt(120).confirmed.lives, finished: run.finished };
  };
  const a = describe(), b = describe();
  assert.deepEqual(a, b);
  assert.ok(a.phases.includes('retry'), 'scripted misses lose lives');
  assert.ok(a.lives >= 3 && a.finished);
});
