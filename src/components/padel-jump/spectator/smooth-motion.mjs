/**
 * Presentation-only motion for the spectator wall (TV over a weak network).
 *
 * Confirmed facts — segment (start/failure/level), phase, score, lives and the
 * final time — always come from the server snapshot. Only the *picture between*
 * snapshots is synthesised: ballistic arcs instead of straight 2Hz segments, a
 * short "coast" through a network gap and an eased catch-up afterwards. Nothing
 * here decides an outcome, writes a result or feeds the ranking.
 */
import { BALL_RADIUS, GRAVITY, HEIGHT, JUMP_SPEED, SPRING_SPEED, WIDTH, movingX } from '../engine.ts';

const STEP = 1 / 120;
const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
const ease = a => a <= 0 ? 0 : a >= 1 ? 1 : a * a * (3 - 2 * a);
const usable = p => p && p.spent === undefined && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.width);
const platformX = (p, time) => p.moving ? movingX(p, time) : p.x;

/** One fixed step of presentation kinematics: gravity plus platform top bounces. */
export function kinematicStep(ball, platforms, time, dt, steer = null) {
  const previousY = ball.y;
  if (steer !== null) ball.vx = clamp(steer, -1, 1) * 250;
  ball.x = clamp(ball.x + ball.vx * dt, BALL_RADIUS, WIDTH - BALL_RADIUS);
  ball.vy -= GRAVITY * dt;
  ball.y += ball.vy * dt;
  if (ball.vy >= 0) return null;
  for (let i = platforms.length - 1; i >= 0; i--) {
    const p = platforms[i];
    if (!usable(p)) continue;
    const x = platformX(p, time);
    if (previousY - BALL_RADIUS >= p.y && ball.y - BALL_RADIUS <= p.y && ball.x + BALL_RADIUS > x && ball.x - BALL_RADIUS < x + p.width) {
      ball.y = p.y + BALL_RADIUS; ball.vy = p.kind === 'net' ? SPRING_SPEED : JUMP_SPEED;
      return p;
    }
  }
  return null;
}

/** Ball height after `seconds` of free flight from `game`, bouncing on its platforms. */
export function ballisticY(game, seconds) {
  const ball = { x: game.ball.x, y: game.ball.y, vx: game.ball.vx ?? 0, vy: game.ball.vy ?? 0 };
  let t = 0;
  const end = Math.max(0, Math.min(1.5, seconds));
  while (t < end - 1e-9) {
    const dt = Math.min(STEP, end - t);
    kinematicStep(ball, game.platforms ?? [], (game.time ?? 0) + t, dt);
    t += dt;
  }
  return ball.y;
}

/**
 * Smooth pose between two confirmed samples of one continuous segment. The
 * curve starts and ends exactly on the confirmed samples; in between it follows
 * the ball's own velocity and gravity, so a 2Hz feed still reads as jumps.
 */
export function arcPose(left, right, alpha, durationMs) {
  const a = clamp(alpha, 0, 1), span = Math.max(1e-3, durationMs / 1000);
  const tau = a * span;
  const lx = left.ball.x, rx = right.ball.x;
  const mx0 = clamp((left.ball.vx ?? 0) * span, -WIDTH, WIDTH), mx1 = clamp((right.ball.vx ?? 0) * span, -WIDTH, WIDTH);
  const a2 = a * a, a3 = a2 * a;
  const x = (2 * a3 - 3 * a2 + 1) * lx + (a3 - 2 * a2 + a) * mx0 + (-2 * a3 + 3 * a2) * rx + (a3 - a2) * mx1;
  const predictedEnd = ballisticY(left, span);
  // A large miss means a bounce/boost we cannot see: fall back to a gentle ease.
  const y = Math.abs(right.ball.y - predictedEnd) > 160
    ? left.ball.y + (right.ball.y - left.ball.y) * ease(a)
    : ballisticY(left, tau) + (right.ball.y - predictedEnd) * a;
  return { x: clamp(x, BALL_RADIUS, WIDTH - BALL_RADIUS), y };
}

/** Steer toward the lowest reachable platform above the last landing. Shared by coast and demo. */
export function autopilotDirection(game, memory = { landY: -Infinity, bias: 0 }) {
  const b = game.ball;
  const apex = b.vy > 0 ? b.y + b.vy * b.vy / (2 * GRAVITY) : b.y;
  let target = null;
  for (const p of game.platforms) {
    if (!usable(p) || p.y + BALL_RADIUS > apex - 4 || p.y <= memory.landY + 4) continue;
    if (!target || p.y < target.y) target = p;
  }
  if (!target) for (const p of game.platforms) if (usable(p) && p.y < b.y && (!target || p.y > target.y)) target = p;
  if (!target) return 0;
  const lift = target.y + BALL_RADIUS - b.y;
  const fall = b.vy > 0 ? (b.vy + Math.sqrt(Math.max(0, b.vy * b.vy - 2 * GRAVITY * lift))) / GRAVITY : Math.sqrt(Math.max(0, -2 * lift / GRAVITY));
  const x = platformX(target, (game.time ?? 0) + fall) + target.width / 2 + (memory.bias ?? 0) * target.width * 0.25;
  return clamp((x - b.x) / 30, -1, 1);
}

/**
 * Wraps playback frames. `present(runId, frame, now)` returns a frame whose
 * picture keeps moving smoothly; `confirmed` facts are passed through, except a
 * running clock that ticks locally between confirmations (bounded, monotonic).
 */
export function createSmoothMotion({ coastMs = 8000, blendMs = 650, clockLeadMs = 2500 } = {}) {
  const runs = new Map();
  function snapshotOf(game) {
    return { ...game, ball: { ...game.ball }, platforms: game.platforms ?? [] };
  }
  function present(runId, frame, now) {
    if (!frame || !frame.game || !frame.confirmed) return frame;
    let run = runs.get(runId);
    const confirmed = frame.confirmed;
    const running = confirmed.status === 'running' && (confirmed.phase === undefined || confirmed.phase === 'playing');
    if (!run || run.segmentId !== confirmed.segmentId) {
      // Start, failure, retry and level changes are confirmed transitions: show them as-is.
      run = { segmentId: confirmed.segmentId, view: snapshotOf(frame.game), lastNow: now, coastFrom: null, blend: null,
        clock: { base: confirmed.elapsedMs, at: now, seq: confirmed.seq, shown: confirmed.elapsedMs }, memory: { landY: frame.game.ball.y - BALL_RADIUS - 1, bias: 0 } };
      runs.set(runId, run);
    }
    const dt = clamp((now - run.lastNow) / 1000, 0, 0.1);
    run.lastNow = now;
    const clock = run.clock;
    if (confirmed.seq !== clock.seq) { clock.base = confirmed.elapsedMs; clock.at = now; clock.seq = confirmed.seq; }
    const elapsed = running ? Math.max(clock.shown, Math.min(clock.base + (now - clock.at), clock.base + clockLeadMs)) : confirmed.elapsedMs;
    clock.shown = running ? elapsed : confirmed.elapsedMs;
    const shownConfirmed = running && elapsed !== confirmed.elapsedMs ? { ...confirmed, elapsedMs: Math.floor(elapsed / 1000) * 1000 } : confirmed;

    const live = frame.state === 'playing' && frame.pose;
    if (!running) { run.view = snapshotOf(frame.game); run.coastFrom = null; run.blend = null; return frame; }
    if (live) {
      if (run.coastFrom !== null) { run.blend = { from: { x: run.view.ball.x, y: run.view.ball.y, camera: run.view.camera }, at: now }; run.coastFrom = null; }
      let game = frame.game;
      if (run.blend) {
        const a = ease((now - run.blend.at) / blendMs);
        if (a >= 1) run.blend = null;
        else {
          const f = run.blend.from;
          const x = f.x + (game.ball.x - f.x) * a, y = f.y + (game.ball.y - f.y) * a;
          game = { ...game, camera: f.camera + (game.camera - f.camera) * a, ball: { ...game.ball, x, y } };
        }
      }
      run.view = snapshotOf(game);
      return { ...frame, game, pose: { ...frame.pose, x: game.ball.x, y: game.ball.y }, confirmed: shownConfirmed };
    }
    // No fresh confirmed motion: keep the ball alive for a bounded time.
    if (run.coastFrom === null) run.coastFrom = now;
    if (now - run.coastFrom > coastMs) return { ...frame, game: run.view, confirmed: shownConfirmed };
    const view = run.view, ball = { ...view.ball };
    let time = view.time ?? 0;
    for (let left = dt; left > 1e-9; left -= STEP) {
      const step = Math.min(STEP, left);
      const landed = kinematicStep(ball, view.platforms, time, step, autopilotDirection({ ...view, ball, time }, run.memory));
      time += step;
      if (landed) { run.memory.landY = landed.y; run.memory.bias = Math.sin(landed.id * 12.9898) * 0.5; }
      // Never show a local miss: a fall is only ever a confirmed server transition.
      if (ball.y - BALL_RADIUS < view.camera + 30 && ball.vy < 0) { ball.y = view.camera + 30 + BALL_RADIUS; ball.vy = JUMP_SPEED; }
    }
    const camera = Math.max(view.camera, ball.y - HEIGHT * 0.43);
    const platforms = view.platforms.some(p => p.moving) ? view.platforms.map(p => p.moving && usable(p) ? { ...p, x: movingX(p, time) } : p) : view.platforms;
    run.view = { ...view, ball, time, camera, platforms };
    return { ...frame, state: 'playing', game: run.view, pose: { x: ball.x, y: ball.y, mode: 'coasting' }, confirmed: shownConfirmed };
  }
  return {
    present,
    forgetExcept(ids) { for (const id of runs.keys()) if (!ids.includes(id)) runs.delete(id); },
  };
}
