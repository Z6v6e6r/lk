import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { createGame, FIXED_STEP, readBest, saveBest, stepGame } from './engine';
import type { Game, GameMode } from './engine';
import { drawGame } from './render';
import { browserTiltEnvironment, createTiltController } from './tilt';
import type { TiltStatus } from './tilt';
import './padel-jump.css';

function storage(): Storage | undefined {
  try { return window.localStorage; } catch { return undefined; }
}

type Snapshot = { mode: GameMode; score: number; boost: boolean };
const snapshot = (game: Game): Snapshot => ({ mode: game.mode, score: game.score, boost: game.boost > 0 });

export default function PadelJump({ onBack }: { onBack?: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const region = useRef<HTMLElement>(null);
  const primaryButton = useRef<HTMLButtonElement>(null);
  const game = useRef<Game>(createGame());
  const inputs = useRef(new Map<string, number>());
  const [view, setView] = useState<Snapshot>({ mode: 'ready', score: 0, boost: false });
  const [best, setBest] = useState(() => readBest(storage()));
  const [renderError, setRenderError] = useState(false);
  const [tilt] = useState(() => createTiltController(browserTiltEnvironment()));
  const [tiltStatus, setTiltStatus] = useState<TiltStatus>('off');

  const pause = useCallback(() => {
    inputs.current.clear();
    if (game.current.mode === 'running') {
      game.current.mode = 'paused';
      setView(snapshot(game.current));
    }
    tilt.recalibrate();
  }, [tilt]);

  const play = () => {
    if (game.current.mode !== 'paused') game.current = createGame();
    tilt.recalibrate();
    game.current.mode = 'running';
    inputs.current.clear();
    setView(snapshot(game.current));
    region.current?.focus({ preventScroll: true });
  };

  const menu = () => {
    inputs.current.clear();
    game.current = createGame();
    setView(snapshot(game.current));
  };

  useEffect(() => {
    const unsubscribe = tilt.subscribe(status => {
      setTiltStatus(status);
      if (status === 'calibrating' || status === 'unavailable') pause();
    });
    return () => { unsubscribe(); tilt.dispose(); };
  }, [pause, tilt]);

  useEffect(() => {
    const activeInputs = inputs.current;
    const element = canvas.current;
    const ctx = element?.getContext('2d');
    if (!element || !ctx) { setRenderError(true); return; }
    let width = 420, height = 640, dpr = 1;
    const resize = () => {
      const rect = element.getBoundingClientRect();
      width = Math.max(1, rect.width); height = Math.max(1, rect.height);
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      element.width = Math.round(width * dpr); element.height = Math.round(height * dpr);
      drawGame(ctx, game.current, width, height, dpr);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    resize();
    let frame = 0, previous = 0, accumulator = 0, published = 0;
    const tick = (now: number) => {
      const current = game.current;
      if (current.mode === 'running') {
        accumulator += previous ? Math.min((now - previous) / 1000, 0.05) : 0;
        let direction = 0;
        for (const input of inputs.current.values()) direction += input;
        if (inputs.current.size === 0) direction = tilt.direction();
        while (accumulator >= FIXED_STEP) {
          stepGame(current, direction);
          accumulator -= FIXED_STEP;
        }
        const next = snapshot(current);
        if (next.mode === 'over') {
          const saved = saveBest(current.score, storage());
          setBest(value => Math.max(value, saved));
          inputs.current.clear();
          setView(next);
        } else if (now - published > 90) {
          setView(next);
          published = now;
        }
      } else { accumulator = 0; }
      previous = now;
      drawGame(ctx, current, width, height, dpr);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    const hidden = () => { if (document.hidden) pause(); };
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('blur', pause);
    window.addEventListener('pagehide', pause);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('blur', pause);
      window.removeEventListener('pagehide', pause);
      activeInputs.clear();
    };
  }, [pause, tilt]);

  useEffect(() => {
    if (view.mode !== 'running' && region.current?.contains(document.activeElement)) {
      primaryButton.current?.focus({ preventScroll: true });
    }
  }, [view.mode]);

  const key = (event: KeyboardEvent<HTMLElement>, down: boolean) => {
    const direction = ['ArrowLeft', 'KeyA'].includes(event.code) ? -1
      : ['ArrowRight', 'KeyD'].includes(event.code) ? 1 : 0;
    if (direction && game.current.mode === 'running') {
      event.preventDefault();
      if (down) inputs.current.set(event.code, direction);
      else inputs.current.delete(event.code);
    }
    if (down && !event.repeat && ['Escape', 'KeyP'].includes(event.code)) {
      if (game.current.mode === 'running') { event.preventDefault(); pause(); }
    }
  };

  const pointer = (event: PointerEvent<HTMLElement>, direction?: number) => {
    if (game.current.mode !== 'running') return;
    const rect = event.currentTarget.getBoundingClientRect();
    inputs.current.set(`pointer:${event.pointerId}`, direction ?? (event.clientX < rect.left + rect.width / 2 ? -1 : 1));
    if (event.type === 'pointerdown') event.currentTarget.setPointerCapture(event.pointerId);
  };
  const release = (event: PointerEvent<HTMLElement>) => { inputs.current.delete(`pointer:${event.pointerId}`); };
  const playing = view.mode === 'running';
  const tiltSelected = ['requesting', 'calibrating', 'active'].includes(tiltStatus);
  const tiltMessage: Record<TiltStatus, string> = {
    off: 'Можно включить управление наклоном телефона.',
    requesting: 'Разрешите браузеру доступ к датчикам движения.',
    calibrating: 'Держите телефон удобно. Ожидаем сигнал датчика…',
    active: 'Наклоняйте телефон влево и вправо. «Центр» — калибровка.',
    denied: 'Доступ к датчикам не выдан. Касание и стрелки работают.',
    unavailable: 'Нет сигнала датчика. Откройте игру напрямую или играйте касанием.',
    insecure: 'Для наклона откройте игру по HTTPS. Касание работает и здесь.',
  };

  return (
    <section className="pj" aria-label="PadlHub Jump — падел-аркада" ref={region} tabIndex={-1}
      onKeyDown={event => key(event, true)} onKeyUp={event => key(event, false)}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) pause(); }}>
      <aside className="pj-editorial">
        <a className="pj-wordmark" href="#padel-jump" aria-label="PadlHub Jump">Padl<span>Hub</span><i>®</i></a>
        <div className="pj-editorial-copy">
          <span className="pj-eyebrow"><span /> PADEL MEETS PLAY</span>
          <h1>Твой корт.<br />Твой <em>взлёт.</em></h1>
          <p>Здесь не нужен напарник.<br />Только ты, мяч и ещё один прыжок.</p>
          <div className="pj-tags"><span>БЕСКОНЕЧНЫЙ ПОДЪЁМ</span><span>100% PADEL</span></div>
        </div>
        <div className="pj-editorial-bottom"><span>01 / ПЕРВАЯ ПОДАЧА</span><p>Маленькая игра.<br />Большая любовь к паделу.</p></div>
      </aside>

      <div className="pj-device" id="padel-jump">
        <header className="pj-topbar">
          <button type="button" className="pj-icon-button" onClick={onBack ?? menu} aria-label={onBack ? 'Вернуться в личный кабинет' : 'На стартовый экран'}>‹</button>
          <div className="pj-logo">Padl<span>Hub</span><small>JUMP</small></div>
          <button type="button" className="pj-icon-button pj-pause" onClick={pause} aria-label="Пауза" disabled={!playing}>Ⅱ</button>
        </header>
        <div className="pj-stats">
          <div><span className="pj-stat-label">ВЫСОТА</span><strong data-testid="jump-score">{view.score}<small> м</small></strong></div>
          <div className="pj-best"><span className="pj-stat-label">ЛИЧНЫЙ РЕКОРД</span><strong>{best}<small> м</small></strong></div>
          <span className={`pj-boost${view.boost ? ' pj-boost-active' : ''}`}>{view.boost ? 'СЕТКА ×2' : '↗ ВЫШЕ!'}</span>
        </div>

        <div className="pj-input-settings">
          <div className="pj-input-modes" role="group" aria-label="Способ управления">
            <button type="button" aria-pressed={!tiltSelected} onClick={() => tilt.disable()}>Касание</button>
            <button type="button" aria-pressed={tiltSelected} disabled={tiltStatus === 'requesting'}
              onClick={() => { pause(); void tilt.enable(); }}>{tiltStatus === 'requesting' ? 'Подключаем…' : 'Наклон телефона'}</button>
            {tiltSelected && <button type="button" className="pj-recenter" disabled={tiltStatus !== 'active'}
              onClick={pause} aria-label="Откалибровать наклон телефона">◎ Центр</button>}
          </div>
          <p className="pj-sensor-status" role="status">{tiltMessage[tiltStatus]}</p>
        </div>

        <div className="pj-field">
          <canvas ref={canvas} className="pj-canvas" width={420} height={640}
            aria-label="Игровое поле: мяч прыгает по ракеткам и сеткам. Управляйте наклоном телефона, стрелками или кнопками под полем."
            onPointerDown={event => pointer(event)} onPointerMove={event => { if (inputs.current.has(`pointer:${event.pointerId}`)) pointer(event); }}
            onPointerUp={release} onPointerCancel={release} onLostPointerCapture={release} />
          {playing && <div className="pj-field-caption" aria-hidden="true">{view.boost ? 'ХОРОШИЙ ОТСКОК!' : view.score < 15 ? 'ПОЙМАЙ СЛЕДУЮЩУЮ РАКЕТКУ' : 'ПРОДОЛЖАЙ В СВОЁМ РИТМЕ'}</div>}
          {(view.mode !== 'running' || renderError) && (
            <div className={`pj-overlay pj-overlay-${view.mode}`}>
              <div className="pj-dialog" role="group" aria-label={view.mode === 'over' ? 'Результат игры' : 'Управление игрой'}>
                <span className="pj-pill">{renderError ? 'НУЖЕН ДРУГОЙ БРАУЗЕР' : view.mode === 'paused' ? 'ПЕРЕРЫВ МЕЖДУ СЕТАМИ' : view.mode === 'over' ? 'ОТЛИЧНЫЙ РОЗЫГРЫШ' : 'PADLHUB JUMP'}</span>
                <div className="pj-hero-ball" aria-hidden="true"><span /></div>
                <h2>{renderError ? 'Поле не загрузилось' : view.mode === 'paused' ? 'Выдохни.\nИ снова вверх.' : view.mode === 'over' ? `${view.score} метров.\nЭто только начало.` : 'Выше.\nЕщё выше.'}</h2>
                <p>{renderError ? 'Открой игру в актуальной версии Safari или Chrome.' : view.mode === 'paused' ? 'Продолжим с того же места.' : view.mode === 'over' ? 'Следующая попытка может стать рекордной.' : 'Прыгай по ракеткам. Лови сетки-пружины.\nНайди свой путь к рекорду.'}</p>
                {view.mode === 'over' && <div className="pj-result" role="status">Твой рекорд: <strong>{best} м</strong></div>}
                {!renderError && <button ref={primaryButton} type="button" className="pj-play" onClick={play}>{view.mode === 'paused' ? 'Продолжить' : view.mode === 'over' ? 'Ещё попытка' : 'Полетели'}<span aria-hidden="true">↗</span></button>}
                <span className="pj-dialog-note">{view.mode === 'paused' ? 'P / Esc — пауза во время игры' : 'Прыжки — автоматически. Рекорды — твои.'}</span>
              </div>
            </div>
          )}
        </div>

        <footer className="pj-controls">
          <button type="button" aria-label="Двигаться влево" disabled={!playing}
            onPointerDown={event => pointer(event, -1)} onPointerUp={release} onPointerCancel={release} onLostPointerCapture={release}
            onKeyDown={event => { if (playing && ['Space', 'Enter'].includes(event.code)) { event.preventDefault(); inputs.current.set('button:left', -1); } }}
            onKeyUp={() => inputs.current.delete('button:left')} onBlur={() => inputs.current.delete('button:left')}>‹</button>
          <div><strong>{tiltSelected ? 'Наклоняй телефон влево и вправо' : 'Веди мяч влево и вправо'}</strong><span>{tiltSelected ? 'Касание и стрелки тоже работают' : 'Касайся краёв поля или используй ← →'}</span></div>
          <button type="button" aria-label="Двигаться вправо" disabled={!playing}
            onPointerDown={event => pointer(event, 1)} onPointerUp={release} onPointerCancel={release} onLostPointerCapture={release}
            onKeyDown={event => { if (playing && ['Space', 'Enter'].includes(event.code)) { event.preventDefault(); inputs.current.set('button:right', 1); } }}
            onKeyUp={() => inputs.current.delete('button:right')} onBlur={() => inputs.current.delete('button:right')}>›</button>
        </footer>
        <div className="pj-device-note">БЕЗ СОПЕРНИКОВ. БЕЗ ОЖИДАНИЯ. ПРОСТО ИГРАЙ.</div>
      </div>
      <div className="pj-mobile-label" aria-hidden="true">PADEL MEETS PLAY · PADLHUB</div>
    </section>
  );
}
