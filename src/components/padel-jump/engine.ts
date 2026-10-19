/** World coordinates grow upward. The simulation is independent of React and pixels. */
export const WIDTH = 420;
export const HEIGHT = 640;
export const BALL_RADIUS = 12;
export const GRAVITY = 1600;
export const JUMP_SPEED = 620;
export const SPRING_SPEED = 860;
export const RUN_SPEED = 250;
export const FIXED_STEP = 1 / 120;
export const BEST_KEY = 'padlhub.jump.best.v1';

export type GameMode = 'ready' | 'running' | 'paused' | 'over';
export type Platform = {
  id: number;
  x: number;
  baseX: number;
  y: number;
  width: number;
  kind: 'racket' | 'net' | 'court';
  moving: boolean;
  flash: number;
};
export type Game = {
  mode: GameMode;
  ball: { x: number; y: number; vx: number; vy: number };
  platforms: Platform[];
  camera: number;
  peak: number;
  score: number;
  time: number;
  bounces: number;
  boost: number;
  seed: number;
  nextId: number;
};

function random(game: Game): number {
  game.seed = (Math.imul(game.seed, 1664525) + 1013904223) >>> 0;
  return game.seed / 0x100000000;
}

function populate(game: Game) {
  let last = game.platforms[game.platforms.length - 1];
  while (last.y < game.camera + HEIGHT + 130) {
    const id = game.nextId++;
    const width = id % 7 === 0 ? 100 : 110;
    // Each platform remains reachable with a normal jump, including moving ones.
    const x = Math.max(24, Math.min(WIDTH - width - 24, last.baseX + (random(game) - 0.5) * 175));
    const platform: Platform = {
      id, x, baseX: x,
      y: last.y + 75 + random(game) * 15,
      width,
      kind: id % 7 === 0 ? 'net' : id % 3 === 0 ? 'court' : 'racket',
      moving: id > 10 && id % 5 === 0,
      flash: 0,
    };
    game.platforms.push(platform);
    last = platform;
  }
}

export function createGame(seed = Date.now()): Game {
  const game: Game = {
    mode: 'ready',
    ball: { x: WIDTH / 2, y: 64, vx: 0, vy: JUMP_SPEED },
    platforms: [{ id: 0, x: 150, baseX: 150, y: 50, width: 120, kind: 'court', moving: false, flash: 0 }],
    camera: 0, peak: 64, score: 0, time: 0, bounces: 0, boost: 0,
    seed: seed >>> 0, nextId: 1,
  };
  populate(game);
  return game;
}

export function stepGame(game: Game, direction: number, dt = FIXED_STEP): void {
  if (game.mode !== 'running' || !Number.isFinite(dt) || dt <= 0) return;
  // Ignore background-tab time. Callers accumulate small fixed steps.
  dt = Math.min(dt, 1 / 30);
  game.time += dt;
  game.boost = Math.max(0, game.boost - dt);
  const ball = game.ball;
  const previousY = ball.y;
  ball.vx = Math.max(-1, Math.min(1, Number.isFinite(direction) ? direction : 0)) * RUN_SPEED;
  ball.x = ((ball.x + ball.vx * dt) % WIDTH + WIDTH) % WIDTH;
  ball.vy -= GRAVITY * dt;
  ball.y += ball.vy * dt;

  for (const p of game.platforms) {
    p.flash = Math.max(0, p.flash - dt);
    if (p.moving) p.x = p.baseX + Math.sin(game.time * 1.6 + p.id) * 20;
  }

  if (ball.vy < 0) {
    // Highest crossed platform wins, and collision is only with its upper surface.
    for (let i = game.platforms.length - 1; i >= 0; i--) {
      const p = game.platforms[i];
      if (previousY - BALL_RADIUS >= p.y && ball.y - BALL_RADIUS <= p.y
        && ball.x + BALL_RADIUS > p.x && ball.x - BALL_RADIUS < p.x + p.width) {
        ball.y = p.y + BALL_RADIUS;
        ball.vy = p.kind === 'net' ? SPRING_SPEED : JUMP_SPEED;
        p.flash = 0.24;
        game.bounces++;
        if (p.kind === 'net') game.boost = 0.9;
        break;
      }
    }
  }

  game.peak = Math.max(game.peak, ball.y);
  game.score = Math.floor(Math.max(0, game.peak - 64) / 10);
  game.camera = Math.max(game.camera, ball.y - HEIGHT * 0.43);
  // A missed starting platform also ends the run, even before the camera moves.
  if (ball.y + BALL_RADIUS < game.camera) game.mode = 'over';
  game.platforms = game.platforms.filter(p => p.y >= game.camera - 70);
  populate(game);
}

export function readBest(storage?: Pick<Storage, 'getItem'>): number {
  try {
    const value = Number(storage?.getItem(BEST_KEY));
    return Number.isSafeInteger(value) && value > 0 ? value : 0;
  } catch { return 0; }
}

export function saveBest(score: number, storage?: Pick<Storage, 'getItem' | 'setItem'>): number {
  const best = Math.max(readBest(storage), Number.isSafeInteger(score) && score > 0 ? score : 0);
  try { storage?.setItem(BEST_KEY, String(best)); } catch { /* Private mode still permits playing. */ }
  return best;
}
