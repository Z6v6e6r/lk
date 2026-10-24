import { BALL_RADIUS, drainEvents, FIXED_STEP, GRAVITY, movingX, RUN_SPEED, stepGame } from '../../../src/components/padel-jump/engine.ts';
import type { Game, GameEvent } from '../../../src/components/padel-jump/engine.ts';
/** Deterministic route sampler, not a model of a novice or proof of every possible state. */
export function pilot(game: Game, options: { stars?: boolean; untilMoving?: boolean; failAt?: number; onEvent?: (event: GameEvent, game: Game) => void } = {}) {
  game.mode = 'running'; let landed = 0;
  for (let frame = 0; frame < 24000 && game.mode === 'running'; frame++) {
    const p = game.platforms.find(p => p.id > landed && p.spent === undefined) ?? game.platforms.filter(p => p.spent === undefined).at(-1);
    let target = game.ball.x;
    if (p) {
      const d = game.ball.vy ** 2 - 2 * GRAVITY * (p.y + BALL_RADIUS - game.ball.y);
      const t = d >= 0 ? Math.max(0, (game.ball.vy + Math.sqrt(d)) / GRAVITY) : 0;
      target = (p.moving ? movingX(p, game.time + t) : p.x) + p.width / 2;
      const star = game.campaign?.stars.find(s => s.id.endsWith(':' + p.id) && !s.collected);
      if (options.stars !== false && star) target = star.x;
    }
    // Typical test mistake: hold the wrong side instead of steering toward the next support.
    if (options.failAt !== undefined && game.time >= options.failAt) target = 12;
    stepGame(game, Math.max(-1, Math.min(1, (target - game.ball.x) / (RUN_SPEED * FIXED_STEP))));
    for (const event of drainEvents(game)) {
      if (event.type === 'landing') landed = Number(event.id);
      options.onEvent?.(event, game);
    }
    if (options.untilMoving && game.campaign?.movingLandings) break;
  }
  return game;
}
