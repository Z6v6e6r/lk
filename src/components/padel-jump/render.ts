import { BALL_RADIUS, HEIGHT, WIDTH } from './engine';
import type { Game, Platform } from './engine';

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
  const gradient = ctx.createLinearGradient(0, 0, 0, HEIGHT);
  gradient.addColorStop(0, '#58bafa'); gradient.addColorStop(0.65, '#8ed9ff'); gradient.addColorStop(1, '#d3eff6');
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

function platform(ctx: CanvasRenderingContext2D, p: Platform, game: Game) {
  const y = HEIGHT - p.y + game.camera;
  if (y < -35 || y > HEIGHT + 30) return;
  ctx.save(); ctx.translate(p.x, y);
  if (p.flash > 0) {
    ctx.shadowColor = p.kind === 'net' ? '#d9ff52' : '#a66dff';
    ctx.shadowBlur = 18;
  }
  if (p.kind === 'court') {
    rounded(ctx, 3, 1, p.width - 6, 15, 7, '#a9a6a0', INK);
    rounded(ctx, 0, -4, p.width, 9, 4, '#b6e75c', INK);
    ctx.fillStyle = '#6ca42f';
    for (let x = 5; x < p.width; x += 9) ctx.fillRect(x, -6 + (x % 3), 2, 5);
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
  ctx.restore();
}

export function drawGame(ctx: CanvasRenderingContext2D, game: Game, width: number, height: number, dpr: number) {
  // Preserve physics proportions, including narrow embeds and landscape phones.
  const scale = Math.min(width / WIDTH, height / HEIGHT);
  ctx.setTransform(dpr * scale, 0, 0, dpr * scale,
    dpr * (width - WIDTH * scale) / 2, dpr * (height - HEIGHT * scale) / 2);
  scenery(ctx, game);
  for (const p of game.platforms) platform(ctx, p, game);
  const { ball } = game;
  const x = ball.x, y = HEIGHT - ball.y + game.camera;
  if (ball.vy > 0 && game.mode === 'running') {
    ctx.save(); ctx.strokeStyle = '#fff9'; ctx.lineWidth = 5; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(x - ball.vx * 0.04, y + 32); ctx.quadraticCurveTo(x - ball.vx * 0.08, y + 14, x, y + 8); ctx.stroke(); ctx.restore();
  }
  ctx.save(); ctx.translate(x, y); ctx.rotate(game.time * 2.5);
  ctx.shadowColor = '#8ba53166'; ctx.shadowBlur = 10; ctx.shadowOffsetY = 3;
  const gradient = ctx.createRadialGradient(-4, -5, 1, 0, 0, BALL_RADIUS);
  gradient.addColorStop(0, '#f5ff98'); gradient.addColorStop(0.6, '#d5f347'); gradient.addColorStop(1, '#99bc1e');
  ctx.fillStyle = gradient; ctx.strokeStyle = '#7e9d21'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(0, 0, BALL_RADIUS, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.shadowBlur = 0; ctx.shadowOffsetY = 0; ctx.strokeStyle = '#ffffd8'; ctx.lineWidth = 1.8;
  ctx.beginPath(); ctx.moveTo(-11, -4); ctx.bezierCurveTo(0, -8, -2, 8, 10, 6); ctx.stroke(); ctx.restore();
  if (game.boost > 0) {
    ctx.save(); ctx.fillStyle = '#fff'; ctx.font = 'bold 14px Arial'; ctx.textAlign = 'center';
    ctx.shadowColor = '#8249ee'; ctx.shadowBlur = 8; ctx.fillText('↑ УСКОРЕНИЕ', x, y + 55); ctx.restore();
  }
}
