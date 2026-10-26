import test from 'node:test';
import assert from 'node:assert/strict';
import { BALL_RADIUS, BEST_KEY, createGame, FIXED_STEP, JUMP_SPEED, readBest, saveBest, SPRING_SPEED, stepGame, WIDTH } from '../../src/components/padel-jump/engine.ts';

function falling(kind: 'court' | 'racket' | 'net') {
  const game = createGame(42);
  game.mode = 'running';
  game.platforms[0].kind = kind;
  game.ball.x = 200;
  game.ball.y = 50 + BALL_RADIUS + 1;
  game.ball.vy = -300;
  return game;
}

test('a descending ball lands on rackets/courts; a net gives a stronger jump', () => {
  for (const kind of ['court', 'racket', 'net'] as const) {
    const game = falling(kind);
    stepGame(game, 0);
    assert.equal(game.bounces, 1);
    assert.equal(game.ball.y, 50 + BALL_RADIUS);
    assert.equal(game.ball.vy, kind === 'net' ? SPRING_SPEED : JUMP_SPEED);
    assert.equal(game.boost > 0, kind === 'net');
  }
});

test('platforms do not catch an ascending ball or a horizontal miss', () => {
  const rising = falling('racket');
  rising.ball.y = 50;
  rising.ball.vy = 300;
  stepGame(rising, 0);
  assert.equal(rising.bounces, 0);
  const miss = falling('racket');
  miss.ball.x = 80;
  stepGame(miss, 0);
  assert.equal(miss.bounces, 0);
});

test('movement wraps across both court edges and clamps input', () => {
  const game = createGame(1); game.mode = 'running';
  game.ball.x = WIDTH - 1; stepGame(game, 10);
  assert.ok(game.ball.x < 5);
  game.ball.x = 1; stepGame(game, -10);
  assert.ok(game.ball.x > WIDTH - 5);
});

test('ready, paused and finished games do not simulate', () => {
  for (const mode of ['ready', 'paused', 'over'] as const) {
    const game = createGame(1); game.mode = mode;
    const before = structuredClone(game);
    stepGame(game, 1);
    assert.deepEqual(game, before);
  }
});

test('height and camera never decrease; falling below the field ends the run', () => {
  const game = createGame(1); game.mode = 'running';
  game.ball.y = 500; stepGame(game, 0);
  const { score, camera } = game;
  assert.ok(score > 0 && camera > 0);
  game.ball.y -= 10; stepGame(game, 0);
  assert.ok(game.score >= score && game.camera >= camera);
  game.ball.y = game.camera - BALL_RADIUS - 1; game.ball.vy = -300;
  stepGame(game, 0);
  assert.equal(game.mode, 'over');
});

test('a missed first platform ends a run without camera movement', () => {
  const game = falling('court'); game.ball.x = 30; game.ball.y = -15;
  stepGame(game, 0);
  assert.equal(game.camera, 0);
  assert.equal(game.mode, 'over');
});

test('seeded courses are reproducible; normal jumps can reach each successive platform', () => {
  assert.deepEqual(createGame(1234), createGame(1234));
  for (let seed = 1; seed <= 100; seed++) {
    const game = createGame(seed);
    for (let i = 1; i < game.platforms.length; i++) {
      const previous = game.platforms[i - 1], next = game.platforms[i];
      const gap = next.y - previous.y;
      assert.ok(gap >= 75 && gap <= 90);
      assert.ok(gap < JUMP_SPEED ** 2 / (2 * 1600));
      assert.ok(Math.abs(next.baseX - previous.baseX) <= 87.5);
      assert.ok(next.x >= 24 && next.x + next.width <= WIDTH - 24);
    }
  }
});

test('a long run discards old platforms while continuing to generate the route', () => {
  const game = createGame(4); game.mode = 'running';
  for (let i = 0; i < 1000; i++) {
    game.ball.y += 30; game.ball.vy = 20;
    stepGame(game, 0);
    assert.ok(game.platforms.length < 20);
  }
  assert.ok(game.score > 2000);
  assert.ok(game.platforms.some(p => p.moving));
});

test('frame timing rejects invalid inputs and caps background gaps', () => {
  for (const dt of [0, -1, NaN, Infinity]) {
    const game = createGame(1); game.mode = 'running';
    const before = structuredClone(game); stepGame(game, 1, dt);
    assert.deepEqual(game, before);
  }
  const game = createGame(1); game.mode = 'running';
  stepGame(game, NaN, 60);
  assert.equal(game.time, 1 / 30);
  assert.ok(Number.isFinite(game.ball.x));
  assert.ok(game.ball.y < 90);
});

test('fixed simulation produces the same result regardless of rendering cadence', () => {
  const a = createGame(7), b = createGame(7); a.mode = b.mode = 'running';
  for (let frame = 0; frame < 120; frame++) stepGame(a, 0, FIXED_STEP);
  for (let frame = 0; frame < 60; frame++) { stepGame(b, 0, FIXED_STEP); stepGame(b, 0, FIXED_STEP); }
  assert.deepEqual(a, b);
});

test('local record survives reloads, rejects invalid values and tolerates denied storage', () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  assert.equal(readBest(storage), 0);
  assert.equal(saveBest(85, storage), 85);
  assert.equal(saveBest(42, storage), 85);
  assert.equal(readBest(storage), 85);
  for (const invalid of ['NaN', '-1', 'Infinity', '9.5', '9007199254740993']) {
    values.set(BEST_KEY, invalid); assert.equal(readBest(storage), 0);
  }
  const denied = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); } };
  assert.equal(readBest(denied), 0);
  assert.equal(saveBest(20, denied), 20);
  assert.equal(saveBest(NaN, denied), 0);
});
