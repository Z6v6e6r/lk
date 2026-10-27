import { BALL_RADIUS, drainEvents, FIXED_STEP, GRAVITY, movingX, RUN_SPEED, stepGame } from '../../../src/components/padel-jump/engine.ts';
import type { Game, GameEvent } from '../../../src/components/padel-jump/engine.ts';

/** Predictive test steering; responds to the displayed catch warning, never changes physics. */
export function pilotTarget(game: Game, landed: number, stars = true) {
  const p = game.platforms.find(p => p.id > landed && p.spent === undefined) ?? game.platforms.filter(p => p.spent === undefined).at(-1);
  if (!p) return game.ball.x;
  const d = game.ball.vy ** 2 - 2 * GRAVITY * (p.y + BALL_RADIUS - game.ball.y);
  const t = d >= 0 ? Math.max(0, (game.ball.vy + Math.sqrt(d)) / GRAVITY) : 0;
  const px = p.moving ? movingX(p, game.time + t) : p.x;
  let target = px + p.width / 2;
  const star = game.campaign?.stars.find(s => s.platform === p.id && !s.collected);
  if (stars && star) target = star.x;
  for (const admin of game.campaign?.admins ?? []) {
    if ((admin.phase !== 'warning' && admin.phase !== 'catch') || Math.abs(game.ball.y - admin.y) > 144) continue;
    if (Math.abs(p.y + BALL_RADIUS - admin.y) < 58) {
      const lo = px + 8, hi = px + p.width - 8;
      const safe = [admin.x - 58, admin.x + 58].map(x => Math.max(lo, Math.min(hi, x))).filter(x => Math.abs(x - admin.x) >= 52);
      if (safe.length) target = safe.sort((a, b) => Math.abs(a - game.ball.x) - Math.abs(b - game.ball.x))[0];
    } else if (p.y + BALL_RADIUS > admin.y && game.ball.y < admin.y + 58) {
      target = admin.x + (game.ball.x < admin.x ? -58 : 58);
    }
  }
  return target;
}

/** Deterministic route sampler, not a model of a novice or proof of every possible state. */
export function pilot(game: Game, options: { stars?: boolean; untilMoving?: boolean; failAt?: number; onEvent?: (event: GameEvent, game: Game) => void } = {}) {
  game.mode = 'running'; let landed = 0;
  for (let frame = 0; frame < 24000 && game.mode === 'running'; frame++) {
    const target = options.failAt !== undefined && game.time >= options.failAt ? 12 : pilotTarget(game, landed, options.stars !== false);
    stepGame(game, Math.max(-1, Math.min(1, (target - game.ball.x) / (RUN_SPEED * FIXED_STEP))));
    for (const event of drainEvents(game)) {
      if (event.type === 'landing') landed = Number(event.id);
      options.onEvent?.(event, game);
    }
    if (options.untilMoving && game.campaign?.movingLandings) break;
  }
  return game;
}
