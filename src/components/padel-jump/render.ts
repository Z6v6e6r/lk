import { BALANCE, STATIONS } from './campaign';
import { BALL_RADIUS, HEIGHT, landingHint, WIDTH } from './engine';
import type { Game, Platform } from './engine';
import type { YasenevoArt } from './yasenevo-assets';
import type { StationPainting } from './station-art';
import { drawRacket } from './racket-art';
import type { RacketArt } from './racket-art';
import { stationScenery } from './station-scenery';
import { yasenevoBall, yasenevoCage, yasenevoPlatform, yasenevoScenery, yasenevoSprite } from './yasenevo-render';

const INK = '#23214d';

function rounded(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number, fill: string, stroke?: string) {
  ctx.beginPath();
  const radius = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y); ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius); ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius); ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 2; ctx.stroke(); }
}

function cloud(ctx: CanvasRenderingContext2D, x: number, y: number, size: number) {
  ctx.fillStyle = '#ffffff9c';
  ctx.beginPath();
  ctx.ellipse(x, y, size, size * 0.28, 0, 0, Math.PI * 2);
  ctx.ellipse(x - size * 0.25, y - size * 0.18, size * 0.45, size * 0.39, 0, 0, Math.PI * 2);
  ctx.ellipse(x + size * 0.23, y - size * 0.1, size * 0.4, size * 0.31, 0, 0, Math.PI * 2);
  ctx.fill();
}

function palm(ctx: CanvasRenderingContext2D, x: number, y: number, scale: number) {
  ctx.save(); ctx.translate(x, y); ctx.scale(scale, scale);
  ctx.strokeStyle = '#919c79'; ctx.lineWidth = 6;
  ctx.beginPath(); ctx.moveTo(0, 100); ctx.quadraticCurveTo(7, 40, 0, 0); ctx.stroke();
  for (let i = 0; i < 7; i++) {
    const a = i * Math.PI / 5 + 0.1;
    ctx.save(); ctx.rotate(a);
    ctx.fillStyle = i % 2 ? '#448f78' : '#67aa76';
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.quadraticCurveTo(15, -31, 49, -5);
    ctx.quadraticCurveTo(15, -13, 0, 0); ctx.fill(); ctx.restore();
  }
  ctx.restore();
}

function scenery(ctx: CanvasRenderingContext2D, game: Game) {
  const station = game.campaign ? STATIONS[game.campaign.station] : undefined;
  const gradient = ctx.createLinearGradient(0, 0, 0, HEIGHT);
  const finale = game.campaign?.station === STATIONS.length - 1 && game.mode === 'complete';
  gradient.addColorStop(0, finale ? '#69c5ee' : station?.sky[0] ?? '#58bafa'); gradient.addColorStop(1, finale ? '#e3f5dc' : station?.sky[1] ?? '#d3eff6');
  ctx.fillStyle = gradient; ctx.fillRect(-WIDTH * 5, -HEIGHT * 5, WIDTH * 11, HEIGHT * 11);
  const shift = game.camera * 0.12;
  for (let i = 0; i < 5; i++) {
    const y = ((i * 157 + 60 + shift) % (HEIGHT + 120)) - 50;
    cloud(ctx, i % 2 ? 336 : 70, y, i % 2 ? 34 : 47);
  }
  const floor = HEIGHT + Math.min(140, game.camera * 0.12);
  ctx.save(); ctx.globalAlpha = 0.6;
  palm(ctx, 46, floor - 180, 0.85); palm(ctx, 351, floor - 158, 1.1);
  rounded(ctx, 87, floor - 100, 251, 122, 4, '#f9f4e9');
  rounded(ctx, 105, floor - 88, 62, 90, 1, '#8fc8db');
  rounded(ctx, 179, floor - 88, 62, 90, 1, '#82b7cb');
  rounded(ctx, 253, floor - 88, 62, 90, 1, '#9ac3d3');
  ctx.fillStyle = '#6b69aa'; ctx.beginPath(); ctx.moveTo(250, floor - 104); ctx.lineTo(300, floor - 125); ctx.lineTo(350, floor - 104); ctx.fill();
  ctx.strokeStyle = '#588eac'; ctx.lineWidth = 3;
  for (let x = 54; x < WIDTH; x += 66) {
    ctx.beginPath(); ctx.moveTo(x, floor - 64); ctx.lineTo(x, floor + 15); ctx.stroke();
  }
  ctx.strokeRect(18, floor - 64, 384, 70);
  ctx.fillStyle = '#3d9bbe55'; ctx.fillRect(18, floor - 64, 384, 70);
  ctx.restore();

  if (station) stationBackdrop(ctx, game);

  // Side glass and climbing plants frame the court without covering playable platforms.
  for (const right of [false, true]) {
    ctx.save(); if (right) { ctx.translate(WIDTH, 0); ctx.scale(-1, 1); }
    ctx.fillStyle = '#f6efda'; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(13, 0); ctx.lineTo(25, HEIGHT); ctx.lineTo(0, HEIGHT); ctx.fill();
    ctx.fillStyle = '#6588a633'; ctx.fillRect(13, 200, 10, HEIGHT);
    ctx.strokeStyle = '#486978'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(16, 210); ctx.lineTo(23, HEIGHT); ctx.stroke();
    for (let i = 0; i < 23; i++) {
      const y = i * 32 + ((shift * 0.7) % 32) - 20;
      const x = 7 + Math.sin(i * 1.9) * 7;
      ctx.save(); ctx.translate(x, y); ctx.rotate(Math.sin(i * 2) * 0.9);
      ctx.fillStyle = i % 3 ? '#66a447' : '#a5c953';
      ctx.beginPath(); ctx.ellipse(0, 0, 5, 12, 0.6, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    }
    ctx.save(); ctx.translate(4, 330); ctx.rotate(-0.04);
    rounded(ctx, 0, 0, 19, 116, 3, '#8b52f0');
    ctx.fillStyle = '#e4d5ff'; ctx.font = 'bold 12px Arial'; ctx.translate(right ? 5 : 14, 99); ctx.rotate(-Math.PI / 2);
    if (right) ctx.scale(1, -1); // Undo the court reflection in the text's rotated coordinates.
    ctx.fillText('ПадлхАБ', 0, 0);
    ctx.restore(); ctx.restore();
  }
}

function platform(ctx: CanvasRenderingContext2D, p: Platform, game: Game, reduced: boolean, art: YasenevoArt | null, rackets: RacketArt | null) {
  const fall = p.spent ?? 0;
  const y = HEIGHT - p.y + game.camera + (fall ? fall * 75 + fall * fall * 400 : 0);
  if (y < -(art || rackets ? 200 : 35) || y > HEIGHT + 30) return;
  ctx.save(); ctx.translate(p.x, y);
  if (p.spent !== undefined) { ctx.globalAlpha = Math.max(0, 1 - fall / BALANCE.collapseSeconds); if (!reduced) ctx.rotate(fall * 0.65); }
  if (p.flash > 0 && !reduced) {
    ctx.shadowColor = p.kind === 'net' ? '#d9ff52' : '#a66dff';
    ctx.shadowBlur = 18;
  }
  if (art) yasenevoPlatform(ctx, p, art);
  else if (p.kind === 'racket' && rackets) drawRacket(ctx, p.id, p.width, rackets);
  else if (p.kind === 'court' || p.kind === 'crumble') {
    rounded(ctx, 3, 1, p.width - 6, 15, 7, '#a9a6a0', INK);
    const c = game.campaign, grey = c && STATIONS[c.station].construction && game.mode !== 'complete';
    const color = grey ? '#b8b9b9' : p.kind === 'crumble' ? (p.width <= 100 ? '#66b9df' : '#e777bd') : c && [3, 4].includes(c.station) ? '#f4bd58' : '#b6e75c';
    rounded(ctx, 0, -4, p.width, 9, 4, color, INK);
    ctx.fillStyle = '#6ca42f';
    if (p.kind === 'crumble') {
      ctx.strokeStyle = '#493558'; ctx.lineWidth = 2; ctx.beginPath();
      for (let x = 12; x < p.width - 8; x += 23) { ctx.moveTo(x, -3); ctx.lineTo(x + 7, 2); ctx.lineTo(x + 2, 9); } ctx.stroke();
    } else for (let x = 5; x < p.width; x += 9) ctx.fillRect(x, -6 + (x % 3), 2, 5);
  } else if (p.kind === 'net') {
    ctx.fillStyle = '#e9f6ffaf'; ctx.fillRect(6, 1, p.width - 12, 22);
    ctx.strokeStyle = '#333565'; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 12; x < p.width - 5; x += 7) { ctx.moveTo(x, 2); ctx.lineTo(x, 24); }
    for (let yy = 4; yy < 25; yy += 6) { ctx.moveTo(6, yy); ctx.lineTo(p.width - 6, yy); }
    ctx.stroke();
    rounded(ctx, 5, -3, p.width - 10, 5, 2, '#faf5ff', INK);
    rounded(ctx, 0, -8, 7, 36, 3, '#c4f354', INK);
    rounded(ctx, p.width - 7, -8, 7, 36, 3, '#c4f354', INK);
  } else {
    rounded(ctx, p.width * 0.56, -1, p.width * 0.43, 8, 3, '#eee6d9', INK);
    for (let x = p.width * 0.7; x < p.width - 6; x += 5) {
      ctx.strokeStyle = '#aaa3a9'; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x - 2, 6); ctx.stroke();
    }
    ctx.fillStyle = '#9e6be6'; ctx.strokeStyle = INK; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(p.width * 0.3, 0, p.width * 0.32, 11, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.strokeStyle = '#dfc4ff'; ctx.beginPath(); ctx.ellipse(p.width * 0.3, -2, p.width * 0.27, 6, 0, Math.PI, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = INK;
    for (let x = 9; x < p.width * 0.53; x += 8) for (let yy = -4; yy <= 4; yy += 4) {
      ctx.beginPath(); ctx.ellipse(x, yy, 1.6, 1, 0, 0, Math.PI * 2); ctx.fill();
    }
  }
  if (p.kind === 'racket' && p.spent === undefined) { ctx.fillStyle = '#fff'; ctx.font = 'bold 8px Arial'; ctx.fillText('1×', p.width * 0.71, 1); }
  if (p.finish) {
    ctx.strokeStyle = '#6642b0'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(p.width / 2, -3); ctx.lineTo(p.width / 2, -44); ctx.stroke();
    rounded(ctx, p.width / 2, -44, 64, 21, 3, '#fffbef', '#6642b0');
    ctx.fillStyle = '#6642b0'; ctx.font = 'bold 10px Arial'; ctx.fillText('ФИНИШ', p.width / 2 + 7, -30);
  }
  ctx.restore();
}

export function drawGame(ctx: CanvasRenderingContext2D, game: Game, width: number, height: number, dpr: number, reducedMotion = false, yasenevoArt: YasenevoArt | null = null, stationPainting: StationPainting | null = null, racketArt: RacketArt | null = null) {
  // Preserve physics proportions, including narrow embeds and landscape phones.
  const scale = Math.min(width / WIDTH, height / HEIGHT);
  ctx.setTransform(dpr * scale, 0, 0, dpr * scale,
    dpr * (width - WIDTH * scale) / 2, dpr * (height - HEIGHT * scale) / 2);
  const art = game.campaign?.station === 0 ? yasenevoArt : null;
  const rackets = game.campaign ? racketArt : null;
  const painting = game.campaign && stationPainting?.station === game.campaign.station ? stationPainting : null;
  const overscanY = Math.max(0, (height / scale - HEIGHT) / 2);
  if (art) yasenevoScenery(ctx, game, art, overscanY);
  else if (painting) stationScenery(ctx, game, painting, overscanY);
  else scenery(ctx, game);
  if (!art) campaignObjects(ctx, game, reducedMotion);
  ctx.save();
  if (art) { ctx.beginPath(); ctx.rect(0, 0, WIDTH, HEIGHT); ctx.clip(); }
  // The deeper racket artwork must sit behind the next lower landing surface.
  for (let i = 0; i < game.platforms.length; i++) {
    const p = game.platforms[art || rackets ? game.platforms.length - 1 - i : i];
    platform(ctx, p, game, reducedMotion, art, rackets);
  }
  if (art) { campaignObjects(ctx, game, reducedMotion, art); yasenevoCage(ctx, game, art); yasenevoBall(ctx, game, art, reducedMotion); }
  ctx.restore();
  if (art) return;
  const { ball } = game;
  const x = ball.x, y = HEIGHT - ball.y + game.camera;
  if (!reducedMotion && ball.vy > 0 && game.mode === 'running') {
    ctx.save(); ctx.strokeStyle = '#fff9'; ctx.lineWidth = 5; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(x - ball.vx * 0.04, y + 32); ctx.quadraticCurveTo(x - ball.vx * 0.08, y + 14, x, y + 8); ctx.stroke(); ctx.restore();
  }
  ctx.save(); ctx.translate(x, y); if (!reducedMotion) ctx.rotate(game.time * 2.5);
  ctx.shadowColor = painting ? '#0b1b3c99' : '#8ba53166'; ctx.shadowBlur = 10; ctx.shadowOffsetY = 3;
  const gradient = ctx.createRadialGradient(-4, -5, 1, 0, 0, BALL_RADIUS);
  gradient.addColorStop(0, '#f5ff98'); gradient.addColorStop(0.6, '#d5f347'); gradient.addColorStop(1, '#99bc1e');
  ctx.fillStyle = gradient; ctx.strokeStyle = '#7e9d21'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(0, 0, BALL_RADIUS, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.shadowBlur = 0; ctx.shadowOffsetY = 0; ctx.strokeStyle = '#ffffd8'; ctx.lineWidth = 1.8;
  ctx.beginPath(); ctx.moveTo(-11, -4); ctx.bezierCurveTo(0, -8, -2, 8, 10, 6); ctx.stroke(); ctx.restore();
  if (game.boost > 0) {
    ctx.save(); ctx.fillStyle = '#fff'; ctx.font = 'bold 14px Arial'; ctx.textAlign = 'center';
    ctx.shadowColor = '#8249ee'; ctx.shadowBlur = reducedMotion ? 0 : 8; ctx.fillText('↑ УСКОРЕНИЕ', x, y + 55); ctx.restore();
  }
}

function starShape(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, ghost: boolean, art?: YasenevoArt) {
  if (art) { ctx.save(); ctx.globalAlpha = ghost ? 0.35 : 1; yasenevoSprite(ctx, art, 'star_gold', x, y, size * 96 / 29); ctx.restore(); return; }
  ctx.save(); ctx.translate(x, y); ctx.beginPath();
  for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, r = i % 2 ? size * 0.46 : size; const xx = Math.cos(a) * r, yy = Math.sin(a) * r; if (!i) ctx.moveTo(xx, yy); else ctx.lineTo(xx, yy); }
  ctx.closePath(); ctx.fillStyle = ghost ? '#ffef9b55' : '#ffe14c'; ctx.strokeStyle = '#b48221'; ctx.lineWidth = 1.4; ctx.fill(); ctx.stroke(); ctx.restore();
}
function campaignObjects(ctx: CanvasRenderingContext2D, game: Game, reduced: boolean, art?: YasenevoArt) {
  const c = game.campaign; if (!c) return;
  const sy = (y: number) => HEIGHT - y + game.camera;
  if (c.assist) {
    const next = landingHint(game);
    if (next) {
      ctx.save(); ctx.strokeStyle = '#fff9'; ctx.lineWidth = 3; ctx.setLineDash([5, 7]);
      ctx.beginPath(); ctx.moveTo(game.ball.x, sy(game.ball.y)); ctx.quadraticCurveTo(game.ball.x, sy(game.ball.y + 110), next.x, sy(next.y + 20)); ctx.stroke(); ctx.restore();
    }
  }
  for (const s of c.stars) if (!s.collected && sy(s.y) > -25 && sy(s.y) < HEIGHT + 25) starShape(ctx, s.x, sy(s.y), 12, s.claimed, art);
  for (const wall of c.metals) {
    const y = sy(wall.y + wall.h); if (y < -40 || y > HEIGHT + 30) continue;
    rounded(ctx, wall.x, y, wall.w, wall.h, 2, '#414457', '#242438');
    ctx.strokeStyle = '#a8a9b8'; ctx.lineWidth = 1;
    for (let x = 5; x < wall.w; x += 8) { ctx.beginPath(); ctx.moveTo(wall.x + x, y + 2); ctx.lineTo(wall.x + x, y + wall.h - 2); ctx.stroke(); }
    ctx.fillStyle = '#f3b241'; ctx.fillRect(wall.x, y - 4, wall.w, 4);
    ctx.fillStyle = '#ff6668'; ctx.font = 'bold 13px Arial'; ctx.textAlign = 'center'; ctx.fillText('⊘', wall.x + wall.w / 2, y + 14); ctx.textAlign = 'start';
  }
  for (const panel of c.glass) {
    const x = panel.side < 0 ? 0 : WIDTH - 14, y = sy(panel.y + panel.h);
    if (y < -panel.h || y > HEIGHT + panel.h) continue;
    ctx.save(); ctx.strokeStyle = '#d9f8ff'; ctx.lineWidth = 2;
    if (!panel.broken) {
      rounded(ctx, x, y, 14, panel.h, 2, '#8ee5ff88', '#f4ffff');
      for (let dy = 10; dy < panel.h; dy += 29) { ctx.beginPath(); ctx.moveTo(x, y + dy); ctx.lineTo(x + 14, y + dy - 13); ctx.stroke(); }
      ctx.fillStyle = '#fff'; ctx.font = 'bold 16px Arial'; ctx.fillText(panel.side < 0 ? '↗' : '↖', panel.side < 0 ? 17 : WIDTH - 35, y + panel.h * 0.5);
    } else { ctx.setLineDash([3, 9]); ctx.strokeRect(x + 4, y, 6, panel.h); }
    ctx.restore();
  }
  for (const d of c.drops) {
    if (d.phase === 'waiting' || d.phase === 'spent') continue;
    const y = sy(d.y); if (y < -50 || y > HEIGHT + 30) continue;
    ctx.save();
    if (d.phase === 'warning') {
      ctx.fillStyle = '#fff3'; ctx.fillRect(d.x - 12, y, 24, HEIGHT - y);
      ctx.fillStyle = '#173c69'; ctx.font = 'bold 18px Arial'; ctx.fillText('!', d.x - 3, y + 18);
    } else {
      ctx.fillStyle = '#9ce9ff'; ctx.strokeStyle = '#427fbd'; ctx.beginPath(); ctx.moveTo(d.x, y - 12); ctx.quadraticCurveTo(d.x + 16, y + 10, d.x, y + 9); ctx.quadraticCurveTo(d.x - 16, y + 10, d.x, y - 12); ctx.fill(); ctx.stroke();
    }
    ctx.restore();
  }
  for (const a of c.admins) {
    if (a.phase === 'waiting' || a.phase === 'gone') continue;
    const y = sy(a.y); if (y < -80 || y > HEIGHT + 80) continue;
    ctx.save(); ctx.globalAlpha = a.phase === 'retreat' ? 1 - a.age / BALANCE.adminRetreat : 1;
    ctx.fillStyle = a.phase === 'catch' ? '#f0ad75' : '#f0ad7580'; ctx.strokeStyle = '#87512d'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(a.x, y, 26, 27, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    rounded(ctx, a.x - 29, y - 27, 58, 12, 5, '#63368d');
    ctx.fillStyle = '#2f2945'; ctx.beginPath(); ctx.arc(a.x - 8, y - 2, 3, 0, Math.PI * 2); ctx.arc(a.x + 8, y - 2, 3, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#3a3151'; ctx.font = 'bold 8px Arial'; ctx.textAlign = 'center'; ctx.fillText(a.phase === 'warning' ? 'ЛОВЛЮ ЗДЕСЬ!' : a.phase === 'catch' ? 'ЛОВЛЮ!' : 'ДО ВСТРЕЧИ', a.x, y - 38); ctx.textAlign = 'start'; ctx.restore();
  }
  for (const b of c.boosters) if (!b.collected && sy(b.y) > -30 && sy(b.y) < HEIGHT + 30) {
    ctx.save(); ctx.strokeStyle = '#bc5bff'; ctx.fillStyle = '#7541ae'; ctx.lineWidth = 3;
    if (!reduced) { ctx.shadowColor = '#e984ff'; ctx.shadowBlur = 9; }
    ctx.beginPath(); ctx.arc(b.x, sy(b.y), 15, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); ctx.fillStyle = '#fff'; ctx.font = 'bold 20px Arial'; ctx.fillText('×', b.x - 6, sy(b.y) + 7); ctx.restore();
  }
}

/** Original vector placeholders based on the supplied mood boards, not final station textures. */
function stationBackdrop(ctx: CanvasRenderingContext2D, game: Game) {
  const c = game.campaign!, station = STATIONS[c.station], theme = station.theme;
  ctx.save(); ctx.globalAlpha = 0.24;
  if (['city', 'piter', 'sunset', 'shell'].includes(theme)) {
    for (let i = 0; i < 8; i++) {
      const x = 28 + i * 49, y = 250 + Math.sin(i * 2 + c.station) * 60;
      ctx.fillStyle = theme === 'piter' ? '#38446d' : '#6c7894'; ctx.fillRect(x, y, 37, HEIGHT - y);
      ctx.fillStyle = '#fff0b8'; for (let yy = y + 15; yy < HEIGHT; yy += 24) for (let xx = x + 6; xx < x + 32; xx += 13) ctx.fillRect(xx, yy, 5, 7);
    }
  }
  if (theme === 'piter') {
    ctx.fillStyle = '#ba8c51'; ctx.beginPath(); ctx.ellipse(210, 285, 45, 30, 0, Math.PI, 0); ctx.fill();
    ctx.fillRect(168, 285, 84, 23); ctx.fillRect(207, 207, 5, 50);
    ctx.strokeStyle = '#d3bed9'; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(22, 510); ctx.lineTo(150, 450); ctx.lineTo(280, 510); ctx.stroke();
  }
  if (theme === 'sochi') { palm(ctx, 60, 280, 1.1); palm(ctx, 354, 270, -1.05); ctx.fillStyle = '#798cbb'; ctx.fillRect(20, 540, 380, 100); }
  if (theme === 'spa') {
    ctx.fillStyle = '#224d35'; for (let x = 35; x < WIDTH; x += 40) { ctx.beginPath(); ctx.ellipse(x, 300, 22, 85, x * 0.1, 0, Math.PI * 2); ctx.fill(); }
    ctx.strokeStyle = '#ecda96'; ctx.beginPath(); ctx.moveTo(30, 130); ctx.quadraticCurveTo(210, 210, 390, 130); ctx.stroke();
    for (let x = 50; x < 390; x += 35) { ctx.fillStyle = '#ffeaa0'; ctx.beginPath(); ctx.arc(x, 150 + Math.sin(x / 90) * 20, 3, 0, Math.PI * 2); ctx.fill(); }
  }
  if (theme === 'yard' || theme === 'works' || station.construction) {
    ctx.strokeStyle = '#5c6470'; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(310, 520); ctx.lineTo(310, 150); ctx.lineTo(110, 150); ctx.moveTo(310, 154); ctx.lineTo(360, 190); ctx.moveTo(155, 150); ctx.lineTo(155, 230); ctx.stroke();
    for (let y = 200; y < HEIGHT; y += 70) { ctx.beginPath(); ctx.moveTo(45, y); ctx.lineTo(110, y); ctx.lineTo(45, y + 70); ctx.stroke(); }
    ctx.fillStyle = '#dfb24d'; for (let x = 120; x < 310; x += 26) ctx.fillRect(x, 525, 15, 9);
    if (theme === 'yard') { ctx.fillStyle = '#d88b35'; ctx.fillRect(260, 410, 13, 27); ctx.beginPath(); ctx.arc(266, 400, 9, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#fff7bc'; ctx.fillRect(278, 420, 5, 5); }
    if (theme === 'works') { rounded(ctx, 135, 440, 80, 35, 6, '#d89b39'); ctx.fillStyle = '#544f50'; ctx.beginPath(); ctx.arc(150, 480, 18, 0, Math.PI * 2); ctx.arc(204, 480, 18, 0, Math.PI * 2); ctx.fill(); for (let y = 385; y < 411; y += 6) { ctx.fillStyle = y % 2 ? '#d84a3b' : '#edd65f'; ctx.fillRect(230, y, 47, 4); } }
  }
  if (theme === 'city') {
    ctx.strokeStyle = '#426c4f'; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(355, 0); ctx.lineTo(350, 240); ctx.stroke();
    ctx.fillStyle = '#6e6553'; ctx.beginPath(); ctx.arc(350, 175, 8, 0, Math.PI * 2); ctx.fill(); ctx.fillRect(345, 184, 10, 23);
  }
  ctx.restore();
}
