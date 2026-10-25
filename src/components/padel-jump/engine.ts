import { BALANCE, sectionBalance, sectionKey, STATIONS } from './campaign.ts';
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

export type GameMode = 'ready' | 'running' | 'paused' | 'over' | 'complete';
export type Platform = {
  id: number;
  x: number;
  baseX: number;
  y: number;
  width: number;
  kind: 'racket' | 'net' | 'court' | 'crumble';
  moving: boolean;
  flash: number;
  spent?: number;
  finish?: boolean;
  amplitude?: number;
  omega?: number;
  rhythm?: boolean;
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
  campaign?: CampaignRun;
  events: GameEvent[];
  impulseX: number;
  protection: number;
  rebound: number;
  failure?: 'fall' | 'metal' | 'admin' | 'drop-fall';
};
export type GameEvent = { type: 'landing' | 'star' | 'difficulty' | 'finish' | 'failure' | 'glass' | 'drop' | 'admin-warning'; id?: string; moving?: boolean; controlled?: boolean; reason?: string };
export type Star = { id: string; x: number; y: number; collected: boolean; claimed: boolean; platform?: number; offset?: number };
export type Metal = { x: number; y: number; w: number; h: number };
export type Glass = { id: number; side: -1 | 1; y: number; h: number; broken: boolean };
export type Drop = { id: number; x: number; y: number; triggerY: number; phase: 'waiting' | 'warning' | 'falling' | 'spent'; age: number };
export type Admin = { id: number; x: number; y: number; triggerY: number; phase: 'waiting' | 'warning' | 'catch' | 'retreat' | 'gone'; age: number };
export type CampaignRun = {
  station: number; section: number; goalY: number; practice: boolean; assist: boolean; assistedEver: boolean;
  stars: Star[]; metals: Metal[]; glass: Glass[]; drops: Drop[]; admins: Admin[];
  boosters: { x: number; y: number; collected: boolean }[];
  controlledLandings: number; directionChanges: number; lastDirection: number; hasSteered: boolean; flightSteered: boolean;
  difficultySeen: boolean; movingLandings: number; dropHit: boolean; hint: string;
};
function event(game: Game, value: GameEvent) { game.events.push(value); if (game.events.length > 256) game.events.shift(); }
export function drainEvents(game: Game): GameEvent[] { return game.events.splice(0); }
export function routeProgress(game: Game): number {
  return game.campaign ? (game.mode === 'complete' ? 1 : Math.min(0.99, Math.max(0, (game.peak - 64) / (game.campaign.goalY - 50)))) : 0;
}

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
    seed: seed >>> 0, nextId: 1, events: [], impulseX: 0, protection: 0, rebound: 0,
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
  const previousY = ball.y, previousX = ball.x;
  game.protection = Math.max(0, game.protection - dt);
  game.rebound = Math.max(0, game.rebound - dt);
  game.impulseX *= Math.exp(-dt / 0.25);
  const steering = game.rebound > 0 && direction * game.impulseX < 0 ? 0 : direction;
  ball.vx = Math.max(-1, Math.min(1, Number.isFinite(steering) ? steering : 0)) * RUN_SPEED + game.impulseX;
  ball.vx = Math.max(-BALANCE.maxSpeedX, Math.min(BALANCE.maxSpeedX, ball.vx));
  ball.x = ((ball.x + ball.vx * dt) % WIDTH + WIDTH) % WIDTH;
  ball.vy -= GRAVITY * dt;
  ball.y += ball.vy * dt;

  if (game.campaign) {
    // Campaign glass has physical sides. Endless mode retains its original wrap controls.
    ball.x = Math.max(BALL_RADIUS, Math.min(WIDTH - BALL_RADIUS, previousX + ball.vx * dt));
    const sign = Math.sign(direction);
    if (Math.abs(direction) > 0.12) {
      game.campaign.hasSteered = true; game.campaign.flightSteered = true;
      if (game.campaign.lastDirection && sign !== game.campaign.lastDirection) game.campaign.directionChanges++;
      game.campaign.lastDirection = sign;
    }
    hazards(game, previousX, previousY, dt);
    if (game.failure) return;
  }

  for (const p of game.platforms) {
    if (p.spent !== undefined) p.spent += dt;
    p.flash = Math.max(0, p.flash - dt);
    if (p.moving && p.spent === undefined) p.x = movingX(p, game.time);
  }

  // Collectibles stay over their support, including moving rackets.
  if (game.campaign) for (const star of game.campaign.stars) {
    if (star.collected || star.platform === undefined) continue;
    const support = game.platforms.find(p => p.id === star.platform);
    if (support && support.spent === undefined) star.x = support.x + support.width / 2 + (star.offset ?? 0);
  }

  if (ball.vy < 0) {
    // Highest crossed platform wins, and collision is only with its upper surface.
    for (let i = game.platforms.length - 1; i >= 0; i--) {
      const p = game.platforms[i];
      if (p.spent !== undefined) continue;
      if (previousY - BALL_RADIUS >= p.y && ball.y - BALL_RADIUS <= p.y
        && ball.x + BALL_RADIUS > p.x && ball.x - BALL_RADIUS < p.x + p.width) {
        ball.y = p.y + BALL_RADIUS;
        ball.vy = p.kind === 'net' ? SPRING_SPEED : JUMP_SPEED;
        p.flash = 0.24;
        game.bounces++;
        event(game, { type: 'landing', id: String(p.id), moving: p.moving, controlled: game.campaign?.flightSteered });
        if (p.kind === 'racket' || p.kind === 'crumble') p.spent = 0;
        const c = game.campaign;
        if (c) {
          if (c.flightSteered) c.controlledLandings++;
          c.flightSteered = false;
          if (p.moving) c.movingLandings++;
          if (!c.difficultySeen && p.id >= 10) { c.difficultySeen = true; event(game, { type: 'difficulty' }); }
          if (p.finish) {
            if (c.station !== 0 || (c.controlledLandings >= 3 && c.directionChanges >= 1)) {
              game.mode = 'complete'; event(game, { type: 'finish' });
            } else c.hint = `Финиш рядом: ${Math.min(3, c.controlledLandings)}/3 управляемых приземлений. Смени направление влево и вправо.`;
          }
        }
        if (p.kind === 'net') game.boost = 0.9;
        break;
      }
    }
  }

  game.peak = Math.max(game.peak, ball.y);
  game.score = Math.floor(Math.max(0, game.peak - 64) / 10);
  game.camera = Math.max(game.camera, ball.y - HEIGHT * 0.43);
  // A missed starting platform also ends the run, even before the camera moves.
  if (ball.y + BALL_RADIUS < game.camera) fail(game, game.campaign?.dropHit ? 'drop-fall' : 'fall');
  if (game.campaign) {
    for (const star of game.campaign.stars) {
      if (!star.collected && game.campaign.hasSteered && Math.hypot(ball.x - star.x, ball.y - star.y) < BALL_RADIUS + 12) {
        star.collected = true; event(game, { type: 'star', id: star.id });
      }
    }
  } else populate(game);
  game.platforms = game.platforms.filter(p => p.y >= game.camera - 70 && (p.spent === undefined || p.spent < BALANCE.collapseSeconds));
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

export function movingX(p: Platform, time: number): number {
  const amplitude = p.amplitude ?? 20;
  if (!p.rhythm) return p.baseX + Math.sin(time * (p.omega ?? 1.6) + p.id) * amplitude;
  const phase = (time + p.id * 0.4) % 6;
  const v = phase < 1.2 ? -1 : phase < 3 ? -Math.cos((phase - 1.2) / 1.8 * Math.PI) : phase < 4.2 ? 1 : Math.cos((phase - 4.2) / 1.8 * Math.PI);
  return p.baseX + v * amplitude;
}

/** Highlight a reachable landing, including the support below a descending ball. No physics assistance. */
export function landingHint(game: Game): { x: number; y: number } | null {
  const b = game.ball;
  const candidates = game.platforms.filter(p => p.spent === undefined && p.y + BALL_RADIUS <= b.y + Math.max(0, b.vy) ** 2 / (2 * GRAVITY));
  for (let i = candidates.length - 1; i >= 0; i--) {
    const p = candidates[i], d = b.vy ** 2 - 2 * GRAVITY * (p.y + BALL_RADIUS - b.y);
    const t = (b.vy + Math.sqrt(Math.max(0, d))) / GRAVITY;
    if (t < 0) continue;
    const x = (p.moving ? movingX(p, game.time + t) : p.x) + p.width / 2;
    if (Math.abs(x - b.x) <= RUN_SPEED * t + p.width / 2) return { x, y: p.y };
  }
  return null;
}

export function createCampaignGame(station = 0, section = 0, options: { assist?: boolean; practice?: boolean; claimed?: readonly string[] } = {}): Game {
  if (!Number.isInteger(station) || station < 0 || station >= STATIONS.length || !Number.isInteger(section) || section < 0 || section > 2) throw new RangeError('Unknown campaign section');
  const game = createGame(1000 + station * 3 + section);
  const cfg = sectionBalance(station, section);
  game.platforms = [{ id: 0, x: 110, baseX: 110, y: 50, width: 200, kind: 'court', moving: false, flash: 0 }];
  const c: CampaignRun = { station, section, goalY: 50 + cfg.count * cfg.gap, practice: !!options.practice, assist: !!options.assist, assistedEver: !!options.assist,
    stars: [], metals: [], glass: [], drops: [], admins: [], boosters: [], controlledLandings: 0, directionChanges: 0,
    lastDirection: 0, hasSteered: false, flightSteered: false, difficultySeen: false, movingLandings: 0, dropHit: false, hint: STATIONS[station].hint };
  game.campaign = c;
  const claimed = new Set(options.claimed);
  for (let i = 1; i <= cfg.count; i++) {
    const introduction = station === 0 && section === 0 && i < 10;
    const center = 210 + Math.sin(i * cfg.phase) * (introduction ? 20 : cfg.sway);
    const small = station === 3 && section > 0 && i > cfg.count / 2 && i % 4 === 0;
    const lessonRecovery = (station === 4 && section === 0 && i >= 6 && i <= 9)
      || (station === 5 && section === 0 && (i === 18 || i === 19));
    const slotWidth = lessonRecovery ? 230 : small ? 98 : cfg.width;
    const slotX = Math.max(26, Math.min(WIDTH - slotWidth - 26, center - slotWidth / 2));
    const finish = i === cfg.count;
    const recovery = i <= 3 || i % 6 === 0 || finish || lessonRecovery;
    let kind: Platform['kind'] = recovery ? 'court' : 'racket';
    if (lessonRecovery) kind = 'court';
    if (cfg.crumbleEvery && i > 4 && i % cfg.crumbleEvery === 0 && !recovery) kind = 'crumble';
    if (cfg.springEvery && i > 5 && i % cfg.springEvery === 0 && !recovery) kind = 'net';
    // Use the Yasenevo-sized racket on every station; retain each route centre.
    const width = kind === 'racket' ? 40 : slotWidth;
    const x = slotX + (slotWidth - width) / 2;
    const moving = !!cfg.movingEvery && i >= 5 && i % cfg.movingEvery === 0 && !recovery;
    const p: Platform = { id: i, x, baseX: x, y: 50 + i * cfg.gap, width, kind, moving, flash: 0, finish,
      amplitude: cfg.amplitude, omega: cfg.omega, rhythm: cfg.rhythm };
    if (moving) p.x = movingX(p, 0);
    game.platforms.push(p);
    if (i === 1 || i % 4 === 0) {
      const id = `${sectionKey(station, section)}:${i}`;
      const offset = (i % 8 ? -1 : 1) * (kind === 'racket' ? 12 : 27);
      c.stars.push({ id, x: p.x + p.width / 2 + offset, y: p.y + 40, collected: false, claimed: claimed.has(id), platform: i, offset });
    }
    const outside = center > 210 ? 30 : WIDTH - 112;
    if (cfg.metalEvery && i >= 6 && i % cfg.metalEvery === 0) c.metals.push({ x: outside, y: p.y + cfg.gap * 0.4, w: 82, h: 19 });
    if (cfg.glassEvery && i >= 5 && (i - 5) % cfg.glassEvery === 0) c.glass.push({ id: i, side: i % 2 ? -1 : 1, y: p.y - 45, h: 160, broken: false });
    if (cfg.dropsEvery && i >= 6 && i % cfg.dropsEvery === 0) c.drops.push({ id: i, x: outside + 40, y: p.y + 210, triggerY: p.y - 75, phase: 'waiting', age: 0 });
    if (cfg.adminEvery && i >= 20 && i % cfg.adminEvery === 0) c.admins.push({ id: i, x: outside + 36, y: p.y + 25, triggerY: p.y - 160, phase: 'waiting', age: 0 });
    if (station >= 3 && section === 2 && i === 18) c.boosters.push({ x: outside + 40, y: p.y + 45, collected: false });
  }
  return game;
}

function fail(game: Game, reason: NonNullable<Game['failure']>) {
  if (game.mode === 'over') return;
  game.mode = 'over'; game.failure = reason; event(game, { type: 'failure', reason });
}

/** Swept circle/AABB faces: top is fatal, side and underside are solid, corner-only tangency is not a landing. */
export function metalContact(game: Game, wall: Metal, previousX: number, previousY: number) {
  const b = game.ball, r = BALL_RADIUS, dx = b.x - previousX, dy = b.y - previousY;
  const hits: { t: number; face: 'top' | 'bottom' | 'left' | 'right' }[] = [];
  const add = (t: number, face: typeof hits[number]['face'], value: number, lo: number, hi: number) => {
    if (t >= 0 && t <= 1 && value > lo + 0.001 && value < hi - 0.001) hits.push({ t, face });
  };
  if (dy < 0 && previousY - r >= wall.y + wall.h) { const t = (wall.y + wall.h + r - previousY) / dy; add(t, 'top', previousX + dx * t, wall.x - r, wall.x + wall.w + r); }
  if (dy > 0 && previousY + r <= wall.y) { const t = (wall.y - r - previousY) / dy; add(t, 'bottom', previousX + dx * t, wall.x - r, wall.x + wall.w + r); }
  if (dx > 0 && previousX + r <= wall.x) { const t = (wall.x - r - previousX) / dx; add(t, 'left', previousY + dy * t, wall.y - r, wall.y + wall.h + r); }
  if (dx < 0 && previousX - r >= wall.x + wall.w) { const t = (wall.x + wall.w + r - previousX) / dx; add(t, 'right', previousY + dy * t, wall.y - r, wall.y + wall.h + r); }
  hits.sort((a, b) => a.t - b.t || Number(a.face === 'top') - Number(b.face === 'top'));
  const hit = hits[0];
  if (!hit) return;
  if (hit.face === 'top') { b.y = wall.y + wall.h + r; fail(game, 'metal'); }
  else if (hit.face === 'bottom') { b.y = wall.y - r; b.vy = Math.min(0, b.vy); }
  else { b.x = hit.face === 'left' ? wall.x - r : wall.x + wall.w + r; b.vx = 0; game.impulseX = 0; }
}

function hazards(game: Game, previousX: number, previousY: number, dt: number) {
  const c = game.campaign!, b = game.ball;
  for (const wall of c.metals) { metalContact(game, wall, previousX, previousY); if (game.mode === 'over') return; }
  for (const panel of c.glass) {
    const contact = panel.side < 0 ? previousX + b.vx * dt - BALL_RADIUS <= 0 : previousX + b.vx * dt + BALL_RADIUS >= WIDTH;
    if (!panel.broken && contact && b.y + BALL_RADIUS > panel.y && b.y - BALL_RADIUS < panel.y + panel.h) {
      panel.broken = true; b.vy = BALANCE.glassSpeed; game.impulseX = -panel.side * BALANCE.glassInward;
      b.vx = game.impulseX; game.rebound = BALANCE.glassRecovery; game.boost = 0.9; event(game, { type: 'glass', id: String(panel.id) });
    }
  }
  for (const drop of c.drops) {
    if (drop.phase === 'waiting' && b.y >= drop.triggerY) { drop.phase = 'warning'; drop.age = 0; }
    else if (drop.phase === 'warning') { drop.age += dt; if (drop.age >= BALANCE.dropWarning) { drop.phase = 'falling'; drop.age = 0; } }
    else if (drop.phase === 'falling') {
      const oldY = drop.y; drop.y -= BALANCE.dropSpeed * dt;
      const relativeOld = previousY - oldY, relativeNew = b.y - drop.y;
      const close = Math.hypot(b.x - drop.x, b.y - drop.y) < BALL_RADIUS + 9
        || (Math.abs(b.x - drop.x) < BALL_RADIUS + 8 && relativeOld <= 0 && relativeNew >= 0);
      if (game.protection <= 0 && close) {
        b.vy = -BALANCE.dropKnockdown; drop.phase = 'spent'; game.protection = BALANCE.hitProtection; c.dropHit = true; event(game, { type: 'drop', id: String(drop.id) });
      }
      if (drop.y < game.camera - 40) drop.phase = 'spent';
    }
  }
  for (const admin of c.admins) {
    if (admin.phase === 'waiting' && b.y >= admin.triggerY) { admin.phase = 'warning'; admin.age = 0; event(game, { type: 'admin-warning' }); }
    else if (admin.phase !== 'waiting' && admin.phase !== 'gone') {
      admin.age += dt;
      if (admin.phase === 'warning' && admin.age >= BALANCE.adminWarning) { admin.phase = 'catch'; admin.age = 0; }
      else if (admin.phase === 'catch') {
        if (Math.hypot(b.x - admin.x, b.y - admin.y) < BALL_RADIUS + 31) { fail(game, 'admin'); return; }
        if (admin.age >= BALANCE.adminCatch) { admin.phase = 'retreat'; admin.age = 0; }
      } else if (admin.phase === 'retreat' && admin.age >= BALANCE.adminRetreat) admin.phase = 'gone';
    }
  }
  for (const boost of c.boosters) if (!boost.collected && Math.hypot(b.x - boost.x, b.y - boost.y) < BALL_RADIUS + 14) {
    boost.collected = true; b.vy = BALANCE.glassSpeed; game.boost = 0.9;
  }
}
