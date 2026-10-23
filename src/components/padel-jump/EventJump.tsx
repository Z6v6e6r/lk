import { useEffect, useRef, useState } from 'react';
import { createGame, FIXED_STEP, stepGame } from './engine';
import { drawGame } from './render';
import type { EventReplay } from '../../utils/communityApi';
import './padel-jump.css';

/** The browser and server run the same fixed-step engine and quantized input. */
export function EventJump({ seed, onFinish, onBack }: { seed: number; onFinish: (inputs: EventReplay) => void; onBack: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null), inputs = useRef(new Map<string, number>());
  const [score, setScore] = useState(0), [paused, setPaused] = useState(true), [over, setOver] = useState(false);
  const game = useRef(createGame(seed)), replay = useRef<EventReplay>([]), ticks = useRef(0), sent = useRef(false);
  const pausedRef = useRef(true), finishRef = useRef(onFinish);
  useEffect(() => { finishRef.current = onFinish; }, [onFinish]);
  const pause = () => { pausedRef.current = true; inputs.current.clear(); setPaused(true); };
  useEffect(() => {
    const element = canvas.current, ctx = element?.getContext('2d'), activeInputs = inputs.current;
    if (!element || !ctx) return;
    let frame = 0, previous = 0, accumulator = 0;
    const hidden = () => { if (document.hidden) pause(); };
    window.addEventListener('blur', pause); document.addEventListener('visibilitychange', hidden);
    const tick = (now: number) => {
      const seconds = previous ? Math.min((now - previous) / 1000, 0.05) : 0; previous = now;
      const current = game.current;
      if (!pausedRef.current && current.mode === 'running') {
        accumulator += seconds;
        const direction = Math.round(Math.max(-1, Math.min(1, [...inputs.current.values()].reduce((a,b) => a+b,0))) * 100);
        while (accumulator >= FIXED_STEP && current.mode === 'running' && ticks.current < 36000) {
          const last = replay.current.at(-1);
          if (last?.[0] === direction) last[1]++; else replay.current.push([direction, 1]);
          ticks.current++; stepGame(current, direction / 100); accumulator -= FIXED_STEP;
        }
        setScore(current.score);
        if (((current.mode as string) === 'over' || ticks.current >= 36000) && !sent.current) {
          sent.current = true; setOver(true); finishRef.current(replay.current);
        }
      } else accumulator = 0;
      const rect = element.getBoundingClientRect(), width = Math.max(rect.width, 1), height = Math.max(rect.height, 1), dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (element.width !== Math.round(width*dpr) || element.height !== Math.round(height*dpr)) { element.width = Math.round(width*dpr); element.height = Math.round(height*dpr); }
      drawGame(ctx, current, width, height, dpr, true, null);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(frame); window.removeEventListener('blur', pause); document.removeEventListener('visibilitychange', hidden); activeInputs.clear(); };
  }, []);
  return <section className="pj-event" aria-label="Падл Jump" tabIndex={0}
    onKeyDown={e => { if (['ArrowLeft','ArrowRight'].includes(e.key)) { e.preventDefault(); inputs.current.set(e.key, e.key === 'ArrowLeft' ? -1 : 1); } if (e.key === 'Escape') pause(); }}
    onKeyUp={e => inputs.current.delete(e.key)} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) pause(); }}>
    <p aria-live="polite">Высота: <strong>{score} м</strong> · {over ? 'Партия завершена' : 'Рейтинг мероприятия'}</p>
    <canvas ref={canvas} className="pj-canvas" style={{ width: 'min(100%, 38svh, 420px)', height: 'auto', margin: '0 auto', aspectRatio: '420 / 640', display: 'block', borderRadius: 24 }} aria-label="Мяч прыгает автоматически. Управляйте стрелками или кнопками под полем." />
    {!over && <div className="form-actions"><button type="button" className="btn-primary" onClick={() => { pausedRef.current = false; game.current.mode = 'running'; setPaused(false); }}>{paused ? 'Полетели' : 'Игра идёт'}</button><button type="button" className="btn-secondary" onClick={pause}>Пауза</button></div>}
    <div className="form-actions">{[-1,1].map(direction => <button type="button" key={direction} className="btn-primary" disabled={paused || over} aria-label={direction < 0 ? 'Двигаться влево' : 'Двигаться вправо'}
      style={{ touchAction: 'none', minWidth: 80, minHeight: 48 }} onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); inputs.current.set(String(e.pointerId), direction); }} onPointerUp={e => inputs.current.delete(String(e.pointerId))} onPointerCancel={e => inputs.current.delete(String(e.pointerId))} onLostPointerCapture={e => inputs.current.delete(String(e.pointerId))}> {direction < 0 ? '←' : '→'} </button>)}</div>
    <button type="button" className="btn-secondary" onClick={onBack}>К мероприятию</button>
  </section>;
}
