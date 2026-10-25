import { HEIGHT } from './engine.ts';
import type { Game, GameEvent } from './engine.ts';

type Burst = { kind: 'landing' | 'star' | 'finish' | 'failure'; x: number; y: number; age: number };
export type Feedback = { bursts: Burst[] };
export const createFeedback = (): Feedback => ({ bursts: [] });

/** Presentation only: never changes the ball, collision geometry or simulation time. */
export function addFeedback(state: Feedback, event: GameEvent, game: Game) {
  if (!['landing', 'star', 'finish', 'failure'].includes(event.type)) return;
  const support = event.type === 'landing' ? game.platforms.find(p => String(p.id) === event.id) : undefined;
  const star = event.type === 'star' ? game.campaign?.stars.find(s => s.id === event.id) : undefined;
  state.bursts.push({ kind: event.type as Burst['kind'], x: star?.x ?? game.ball.x,
    y: star?.y ?? support?.y ?? game.ball.y, age: 0 });
  if (state.bursts.length > 16) state.bursts.shift();
}
export function advanceFeedback(state: Feedback, seconds: number, enabled: boolean) {
  if (!enabled) { state.bursts.length = 0; return; }
  for (const burst of state.bursts) burst.age += Math.max(0, Math.min(0.05, seconds));
  state.bursts = state.bursts.filter(b => b.age < (b.kind === 'landing' ? 0.24 : 0.65));
}
export function drawFeedback(ctx: CanvasRenderingContext2D, state: Feedback, camera: number) {
  for (const b of state.bursts) {
    const duration = b.kind === 'landing' ? 0.24 : 0.65, t = b.age / duration;
    const y = HEIGHT - b.y + camera;
    if (y < -60 || y > HEIGHT + 60) continue;
    ctx.save(); ctx.translate(b.x, y); ctx.globalAlpha = (1 - t) * (b.kind === 'landing' ? 0.65 : 1);
    ctx.strokeStyle = b.kind === 'star' ? '#ffe16c' : b.kind === 'failure' ? '#ef9fbe' : '#e9ffb9';
    ctx.lineWidth = b.kind === 'landing' ? 2 : 2.5;
    if (b.kind === 'landing') { ctx.beginPath(); ctx.ellipse(0, 0, 8 + t * 23, 3 + t * 5, 0, 0, Math.PI); ctx.stroke(); }
    else {
      const count = b.kind === 'finish' ? 12 : 8;
      for (let i = 0; i < count; i++) {
        const angle = i / count * Math.PI * 2, radius = 10 + (1 - (1 - t) ** 2) * 33;
        ctx.beginPath(); ctx.moveTo(Math.cos(angle) * radius, Math.sin(angle) * radius - t * 15);
        ctx.lineTo(Math.cos(angle) * (radius + 5), Math.sin(angle) * (radius + 5) - t * 15); ctx.stroke();
      }
      if (b.kind === 'star') {
        ctx.font = 'bold 15px system-ui'; ctx.textAlign = 'center'; ctx.fillStyle = '#fff6bb';
        ctx.strokeStyle = '#302145'; ctx.lineWidth = 3; ctx.strokeText('+1', 0, -18 - t * 27); ctx.fillText('+1', 0, -18 - t * 27);
      }
    }
    ctx.restore();
  }
}

export function ballHalo(ctx: CanvasRenderingContext2D, game: Game) {
  ctx.save(); ctx.beginPath(); ctx.arc(game.ball.x, HEIGHT - game.ball.y + game.camera, 16, 0, Math.PI * 2);
  ctx.fillStyle = '#14283840'; ctx.fill(); ctx.strokeStyle = '#ffffffdc'; ctx.lineWidth = 1.5; ctx.stroke(); ctx.restore();
}
