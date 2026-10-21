import { BALL_RADIUS, HEIGHT, WIDTH } from './engine';
import type { Game, Platform } from './engine';
import { YASENEVO_SPRITES } from './yasenevo-assets';
import type { YasenevoArt, YasenevoSprite } from './yasenevo-assets';
import { surfaceRect } from './yasenevo-layout';

export function yasenevoSprite(ctx: CanvasRenderingContext2D, art: YasenevoArt, id: YasenevoSprite, x: number, y: number, width: number) {
  const sprite = YASENEVO_SPRITES[id], height = width * sprite.h / sprite.w;
  ctx.drawImage(art.images[id], x - width / 2, y - height / 2, width, height);
}
export function yasenevoScenery(ctx: CanvasRenderingContext2D, game: Game, art: YasenevoArt, reduced: boolean) {
  ctx.fillStyle = '#dce3e9'; ctx.fillRect(-WIDTH * 5, -HEIGHT * 5, WIDTH * 11, HEIGHT * 11);
  const h = WIDTH * 2, shift = game.camera * 0.12 % h;
  for (let y = shift - h; y < HEIGHT; y += h) ctx.drawImage(art.images.dome_loop, 0, y, WIDTH, h);
  const floor = HEIGHT + game.camera * 0.14;
  if (floor - h < HEIGHT) {
    ctx.drawImage(art.images.station_start, 0, floor - h, WIDTH, h);
    ctx.save(); ctx.globalAlpha = 0.72;
    const walkers = ['worker_navy_walk_00', 'worker_navy_walk_01', 'worker_navy_walk_02', 'worker_navy_walk_03'] as const;
    yasenevoSprite(ctx, art, walkers[reduced ? 0 : Math.floor(game.time / 0.18) % 4], 45, floor - 43, 29);
    yasenevoSprite(ctx, art, 'worker_green_panel', 369, floor - 48, 28);
    yasenevoSprite(ctx, art, 'worker_cream_inspector', 335, floor - 34, 23);
    yasenevoSprite(ctx, art, 'decor_stepladder', 76, floor - 42, 26);
    yasenevoSprite(ctx, art, 'decor_toolcase', 59, floor - 15, 29);
    yasenevoSprite(ctx, art, 'banner_padlhub', 210, floor - 13, 118);
    ctx.restore();
  }
  // Repeating wall artwork scrolls behind all playable objects, with gaps between bands.
  ctx.save();
  const sleeveSpacing = 900, sleeveShift = game.camera * 0.55 % sleeveSpacing;
  for (let y = 210 + sleeveShift - sleeveSpacing; y < HEIGHT + 24; y += sleeveSpacing) {
    if (y <= -24) continue;
    ctx.globalAlpha = 0.38; ctx.fillStyle = '#4e356d'; ctx.fillRect(17, y - 25, WIDTH - 34, 50);
    ctx.globalAlpha = 0.8; yasenevoSprite(ctx, art, 'padel_sleeve', WIDTH / 2, y, WIDTH - 36);
  }
  ctx.restore();
  ctx.save(); ctx.globalAlpha = 0.85;
  yasenevoSprite(ctx, art, 'flag_padlhub', 34, 163, 52);
  yasenevoSprite(ctx, art, 'flag_padlhub', WIDTH - 34, 330, 52);
  yasenevoSprite(ctx, art, 'poster_build_ourselves', WIDTH - 43, HEIGHT - 150, 44);
  ctx.restore();
}
export function yasenevoCage(ctx: CanvasRenderingContext2D, game: Game, art: YasenevoArt) {
  const w = 17, h = w * 1440 / 112, shift = game.camera * 0.1 % h;
  for (let y = shift - h; y < HEIGHT; y += h) {
    ctx.drawImage(art.images.cage_left, 0, y, w, h);
    ctx.drawImage(art.images.cage_right, WIDTH - w, y, w, h);
  }
}
export function yasenevoPlatform(ctx: CanvasRenderingContext2D, p: Platform, art: YasenevoArt) {
  const id = p.kind === 'racket' ? (p.id % 2 ? 'racket_red_platform' : 'racket_black_platform')
    : p.kind === 'net' ? (p.flash > 0.16 ? 'spring_pressed' : p.flash > 0.06 ? 'spring_rebound' : 'spring_idle')
      : p.width >= 180 ? 'platform_blue_wide' : 'platform_blue';
  const rect = surfaceRect(p.width, YASENEVO_SPRITES[id]);
  ctx.drawImage(art.images[id], rect.x, rect.y, rect.w, rect.h);
}
export function yasenevoBall(ctx: CanvasRenderingContext2D, game: Game, art: YasenevoArt, reduced: boolean) {
  const { x, y, vy, vx } = game.ball, screenY = HEIGHT - y + game.camera;
  if (!reduced && vy > 0 && game.mode === 'running') {
    ctx.save(); ctx.translate(x - vx * 0.025, screenY + 22); ctx.rotate(vx * 0.001);
    yasenevoSprite(ctx, art, 'ball_trail', 0, 0, 19); ctx.restore();
  }
  const landed = game.platforms.some(p => p.flash > 0.19 && Math.abs(p.y + BALL_RADIUS - y) < 30);
  ctx.save(); ctx.translate(x, screenY); if (!reduced && !landed) ctx.rotate(game.time * 2.5);
  yasenevoSprite(ctx, art, !reduced && landed ? 'ball_squash' : 'ball', 0, 0, BALL_RADIUS * 128 / 43);
  ctx.restore();
}
