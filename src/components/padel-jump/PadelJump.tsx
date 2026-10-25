import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { createCampaignGame, createGame, drainEvents, FIXED_STEP, readBest, routeProgress, saveBest, stepGame } from './engine';
import type { Game } from './engine';
import { BALANCE, nextSection, STATIONS } from './campaign';
import { canPlayPart, claimStar, finishPart, loadProgress, partResult, recordFailure, stationMedal, writeProgress } from './progress';
import { createVisit } from './session';
import type { JournalEvent } from './session';
import { drawGame } from './render';
import { addFeedback, advanceFeedback, createFeedback } from './feedback';
import { createJumpAudio } from './audio';
import { loadYasenevoArt } from './yasenevo-assets';
import type { YasenevoArt } from './yasenevo-assets';
import { loadStationPainting } from './station-art';
import type { StationPainting } from './station-art';
import { loadRacketArt } from './racket-art';
import type { RacketArt } from './racket-art';
import { createJumpStarter } from './start';
import { browserTiltEnvironment, createTiltController } from './tilt';
import type { TiltStatus } from './tilt';
import logoHab from '../../assets/logo-hab-compact.svg';
import './padel-jump.css';

function storage(): Storage | undefined { try { return window.localStorage; } catch { return undefined; } }
function snapshot(g: Game) {
  const c = g.campaign;
  return { mode: g.mode, score: g.score, boost: g.boost > 0, station: c?.station ?? -1, section: c?.section ?? 0,
    progress: routeProgress(g), stars: c?.stars.filter(s => s.collected).length ?? 0, totalStars: c?.stars.length ?? 0,
    practice: !!c?.practice, assist: !!c?.assist, aided: !!c?.assistedEver, hint: c?.hint ?? '', failure: g.failure };
}
const FAILURE = { fall: 'Мяч упал мимо опор. Выбери следующую опору до начала падения.',
  metal: 'Мяч приземлился на металлическую сетку. Обходи сбоку: верхняя кромка опасна.',
  admin: 'Админ поймал мяч. После предупреждения уйди из отмеченной зоны.',
  'drop-fall': 'Капля сбила мяч, и он упал. После удара ищи нижнюю обычную опору.' };

export default function PadelJump({ onBack }: { onBack?: () => void }) {
  const [initial] = useState(() => {
    const progress = loadProgress(storage());
    return { progress, game: createCampaignGame(progress.current.station, progress.current.section,
      { assist: progress.settings.assist, claimed: progress.claimed }), best: readBest(storage()) };
  });
  const canvas = useRef<HTMLCanvasElement>(null), region = useRef<HTMLElement>(null), primaryButton = useRef<HTMLButtonElement>(null);
  const game = useRef(initial.game), progress = useRef(initial.progress);
  const inputs = useRef(new Map<string, number>()), inputType = useRef<JournalEvent['input']>('touch');
  const explicitPause = useRef(false), mapRef = useRef(false), transition = useRef(0);
  const attempt = useRef(partResult(initial.progress, initial.progress.current.station, initial.progress.current.section).failures + 1);
  const reduced = useRef(false);
  const yasenevoArt = useRef<YasenevoArt | null>(null);
  const stationPainting = useRef<StationPainting | null>(null);
  const racketArt = useRef<RacketArt | null>(null);
  const feedback = useRef(createFeedback()), redraw = useRef(() => {});
  const mapOpener = useRef<HTMLElement | null>(null);
  const [audio] = useState(createJumpAudio);
  const [artStatus, setArtStatus] = useState<'loading' | 'ready' | 'fallback'>('loading');
  const [artAttempt, setArtAttempt] = useState(0);
  const [visit] = useState(() => createVisit(globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)));
  const [view, setView] = useState(() => snapshot(initial.game));
  const [saved, setSaved] = useState(() => structuredClone(initial.progress));
  const [best, setBest] = useState(initial.best), [renderError, setRenderError] = useState(false);
  const [mapOpen, setMapOpen] = useState(false), [storageIssue, setStorageIssue] = useState(false);
  const [journeyComplete, setJourneyComplete] = useState(initial.progress.completed);
  const [tilt] = useState(() => createTiltController(browserTiltEnvironment()));
  const [tiltStatus, setTiltStatus] = useState<TiltStatus>('off'), [starting, setStarting] = useState(false);
  const starter = useRef<ReturnType<typeof createJumpStarter> | null>(null);

  useEffect(() => {
    let active = true;
    stationPainting.current = null;
    setArtStatus(view.station < 0 ? 'ready' : 'loading');
    if (view.station >= 0) void Promise.all([
      loadRacketArt().then(art => { if (active) { racketArt.current = art; redraw.current(); } return art; }),
      view.station === 0
        ? loadYasenevoArt().then(art => { if (active) { yasenevoArt.current = art; redraw.current(); } return art; })
        : loadStationPainting(view.station).then(art => { if (active) { stationPainting.current = art; redraw.current(); } return art; }),
    ]).then(parts => { if (active) setArtStatus(parts.every(Boolean) ? 'ready' : 'fallback'); });
    return () => { active = false; };
  }, [view.station, artAttempt]);
  useEffect(() => { audio.setEnabled(saved.settings.sound); tilt.setSensitivity(saved.settings.tiltSensitivity); }, [audio, tilt, saved.settings.sound, saved.settings.tiltSensitivity]);
  useEffect(() => () => audio.dispose(), [audio]);

  const save = useCallback(() => {
    setStorageIssue(!writeProgress(progress.current, storage()));
    setSaved(structuredClone(progress.current)); redraw.current();
  }, []);
  const log = useCallback((name: string, reason?: string) => {
    const c = game.current.campaign;
    return visit.log(name, { station: c?.station ?? -1, section: c?.section ?? 0, attempt: attempt.current,
      input: inputType.current, assist: !!c?.assistedEver, practice: !!c?.practice }, progress.current.settings.journal, storage(), reason);
  }, [visit]);
  const pause = useCallback((manual = false) => {
    if (manual) explicitPause.current = true;
    inputs.current.clear();
    if (game.current.mode === 'running') { game.current.mode = 'paused'; setView(snapshot(game.current)); }
    tilt.recalibrate(); audio.pause();
  }, [tilt, audio]);
  const prepare = useCallback((station: number, section: number, practice = false) => {
    starter.current?.cancel(); feedback.current.bursts.length = 0; audio.pause(); inputs.current.clear(); transition.current = 0; explicitPause.current = false;
    if (station < 0) game.current = createGame();
    else {
      if (!canPlayPart(progress.current, station, section)) return;
      game.current = createCampaignGame(station, section, { practice, assist: progress.current.settings.assist, claimed: progress.current.claimed });
    }
    attempt.current = station < 0 ? 1 : partResult(progress.current, station, section).failures + 1;
    setJourneyComplete(false); mapRef.current = false; setMapOpen(false); setView(snapshot(game.current));
  }, [audio]);
  const start = useCallback(() => {
    if (visit.start()) log('visit_start');
    explicitPause.current = false;
    if (game.current.mode === 'over') {
      const c = game.current.campaign; prepare(c?.station ?? -1, c?.section ?? 0, c?.practice); log('retry');
    }
    audio.unlock(); starter.current?.play();
  }, [audio, log, prepare, visit]);
  const continueRoute = useCallback(() => {
    const c = game.current.campaign;
    if (!c) return;
    const next = c.practice ? { station: c.station, section: c.section } : nextSection(c.station, c.section);
    if (!next) return;
    prepare(next.station, next.section, c.practice); audio.unlock(); starter.current?.play();
  }, [audio, prepare]);
  const openMap = () => {
    mapOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    starter.current?.cancel(); pause(true); mapRef.current = true; setMapOpen(true); save();
  };
  const closeMap = () => {
    mapRef.current = false; setMapOpen(false); redraw.current();
    if (game.current.mode !== 'paused') explicitPause.current = false;
    requestAnimationFrame(() => (mapOpener.current?.isConnected ? mapOpener.current : primaryButton.current)?.focus({ preventScroll: true }));
  };
  const choose = (station: number, section: number, practice = false) => { prepare(station, section, practice); };
  const toggleAssist = (enabled: boolean) => {
    progress.current.settings.assist = enabled;
    const c = game.current.campaign;
    if (c) { c.assist = enabled; c.assistedEver ||= enabled; }
    log('assistance', enabled ? 'on' : 'off'); save(); setView(snapshot(game.current));
  };

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => { reduced.current = query.matches; if (query.matches) feedback.current.bursts.length = 0; redraw.current(); }; update(); query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    const coordinator = createJumpStarter({ autoTilt: () => navigator.maxTouchPoints > 0,
      enableTilt: () => { void tilt.enable(); }, recalibrate: () => tilt.recalibrate(),
      canBegin: () => !document.hidden && document.hasFocus() && !mapRef.current,
      pending: setStarting,
      begin: () => {
        const entering = game.current.mode === 'ready';
        game.current.mode = 'running'; audio.unlock(); inputs.current.clear(); explicitPause.current = false;
        setView(snapshot(game.current)); region.current?.focus({ preventScroll: true });
        log('field_ready');
        const c = game.current.campaign;
        if (c && entering) { log('section_enter'); if (c.station > 0 && c.section === 0) log('next_station_ready'); }
        else if (!entering) log('resume');
      },
    });
    starter.current = coordinator;
    const unsubscribe = tilt.subscribe(status => {
      setTiltStatus(status);
      if (status === 'calibrating' || status === 'unavailable') pause();
      coordinator.status(status);
    });
    return () => { coordinator.cancel(); starter.current = null; unsubscribe(); tilt.dispose(); };
  }, [audio, log, pause, tilt]);

  useEffect(() => {
    const activeInputs = inputs.current, currentProgress = progress.current, element = canvas.current, ctx = element?.getContext('2d');
    if (!element || !ctx) { setRenderError(true); return; }
    let width = 420, height = 640, dpr = 1;
    let dirty = true, drawnGame: Game | undefined, drawnMode: Game['mode'] | undefined;
    redraw.current = () => { dirty = true; };
    const draw = () => {
      drawGame(ctx, game.current, width, height, dpr, reduced.current || !progress.current.settings.effects, yasenevoArt.current, stationPainting.current, racketArt.current, feedback.current);
      dirty = false; drawnGame = game.current; drawnMode = game.current.mode;
    };
    const resize = () => {
      const rect = element.getBoundingClientRect(); width = Math.max(1, rect.width); height = Math.max(1, rect.height);
      dpr = Math.min(window.devicePixelRatio || 1, 2); element.width = Math.round(width * dpr); element.height = Math.round(height * dpr); draw();
    };
    const observer = new ResizeObserver(resize); observer.observe(element); resize();
    let frame = 0, previous = 0, accumulator = 0, published = 0;
    const tick = (now: number) => {
      const seconds = previous ? Math.max(0, (now - previous) / 1000) : 0;
      const before = visit.times().visibleSeconds;
      visit.advance(seconds, !document.hidden, explicitPause.current, game.current.mode === 'running');
      progress.current.activeSeconds += visit.times().visibleSeconds - before;
      const current = game.current;
      if (current.mode === 'running') {
        accumulator += Math.min(seconds, 0.05);
        let direction = 0;
        for (const value of inputs.current.values()) direction += value;
        if (inputs.current.size === 0) { direction = tilt.direction(); if (Math.abs(direction) > 0.05) inputType.current = 'tilt'; }
        while (accumulator >= FIXED_STEP && current.mode === 'running') { stepGame(current, direction); accumulator -= FIXED_STEP; }
        for (const event of drainEvents(current)) {
          if (current.campaign) { if (progress.current.settings.effects && !reduced.current) addFeedback(feedback.current, event, current); audio.cue(event); }
          if (event.type === 'landing') {
            if (event.controlled && visit.first('landing')) log('first_controlled_landing');
            if (event.moving && current.campaign?.station === 1 && visit.first('moving')) log('first_moving_landing');
          } else if (event.type === 'star') {
            if (event.id && claimStar(progress.current, current, event.id)) save();
            if (visit.first('star')) log('first_star');
          } else if (event.type === 'finish') {
            if (finishPart(progress.current, current)) save();
            log('checkpoint');
            const c = current.campaign;
            if (c?.section === 2) log('station_complete');
            if (c?.station === STATIONS.length - 1 && c.section === 2 && !c.practice) { setJourneyComplete(true); log('campaign_complete'); }
            transition.current = 0; inputs.current.clear(); setView(snapshot(current));
          } else if (event.type === 'failure') {
            recordFailure(progress.current, current); save(); log('failure', event.reason);
            if (!current.campaign) { const value = saveBest(current.score, storage()); setBest(old => Math.max(old, value)); }
            inputs.current.clear(); setView(snapshot(current));
          } else log(event.type, event.reason);
        }
        if (now - published > 90) { setView(snapshot(current)); published = now; }
      } else accumulator = 0;
      if (current.mode === 'complete' && current.campaign && !current.campaign.practice
        && nextSection(current.campaign.station, current.campaign.section) && !mapRef.current && !explicitPause.current && !document.hidden && document.hasFocus()) {
        transition.current += seconds;
        if (transition.current >= BALANCE.intermission) continueRoute();
      }
      const effectsEnabled = progress.current.settings.effects && !reduced.current;
      if (current.mode !== 'paused' && !mapRef.current && !document.hidden) advanceFeedback(feedback.current, seconds, effectsEnabled);
      const animating = current.mode !== 'paused' && feedback.current.bursts.length > 0;
      if (!document.hidden && !mapRef.current && (dirty || current.mode === 'running' || animating || drawnGame !== current || drawnMode !== current.mode)) draw();
      previous = now; frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    const blur = () => pause();
    const suspend = () => { previous = 0; starter.current?.cancel(); pause(); save(); };
    const hidden = () => { previous = 0; if (document.hidden) suspend(); };
    document.addEventListener('visibilitychange', hidden); window.addEventListener('blur', blur); window.addEventListener('pagehide', suspend);
    return () => {
      cancelAnimationFrame(frame); observer.disconnect(); activeInputs.clear(); redraw.current = () => {};
      document.removeEventListener('visibilitychange', hidden); window.removeEventListener('blur', blur); window.removeEventListener('pagehide', suspend);
      writeProgress(currentProgress, storage());
    };
  }, [audio, continueRoute, log, pause, save, tilt, visit]);
  useEffect(() => {
    if (mapOpen) { region.current?.querySelector<HTMLButtonElement>('.pj-map-heading button')?.focus({ preventScroll: true }); return; }
    if (view.mode !== 'running' && region.current?.contains(document.activeElement)) primaryButton.current?.focus({ preventScroll: true });
  }, [view.mode, mapOpen]);

  const key = (event: KeyboardEvent<HTMLElement>, down: boolean) => {
    if (mapRef.current) {
      if (down && event.code === 'Escape') { event.preventDefault(); closeMap(); }
      if (down && event.key === 'Tab') {
        const controls = Array.from(region.current?.querySelectorAll<HTMLElement>('.pj-map button:not(:disabled), .pj-map input') ?? []);
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
      return;
    }
    const direction = ['ArrowLeft', 'KeyA'].includes(event.code) ? -1 : ['ArrowRight', 'KeyD'].includes(event.code) ? 1 : 0;
    if (direction && game.current.mode === 'running' && !mapRef.current) {
      event.preventDefault(); inputType.current = 'keyboard';
      if (down) inputs.current.set(event.code, direction); else inputs.current.delete(event.code);
    }
    if (down && !event.repeat && ['Escape', 'KeyP'].includes(event.code) && game.current.mode === 'running') { event.preventDefault(); pause(true); }
  };
  const pointer = (event: PointerEvent<HTMLElement>, direction?: number) => {
    if (game.current.mode !== 'running' || mapRef.current) return;
    const rect = event.currentTarget.getBoundingClientRect(); inputType.current = 'touch';
    inputs.current.set(`pointer:${event.pointerId}`, direction ?? (event.clientX < rect.left + rect.width / 2 ? -1 : 1));
    if (event.type === 'pointerdown') event.currentTarget.setPointerCapture(event.pointerId);
  };
  const release = (event: PointerEvent<HTMLElement>) => { inputs.current.delete(`pointer:${event.pointerId}`); };
  const playing = view.mode === 'running' && !mapOpen;
  const campaign = view.station >= 0, station = campaign ? STATIONS[view.station] : undefined;
  const tiltSelected = ['requesting', 'calibrating', 'active'].includes(tiltStatus);
  const failures = campaign ? partResult(saved, view.station, view.section).failures : 0;
  const finished = view.mode === 'complete';
  const title = renderError ? 'Поле не загрузилось' : journeyComplete ? 'Все 11 станций.\nТвой маршрут!' : finished ? (view.section === 2 ? `${station?.name}\nпройдено!` : 'Участок пройден!')
    : view.mode === 'paused' ? 'Выдохни.\nИ снова вверх.' : view.mode === 'over' ? 'Ещё одна\nподача.' : campaign ? `${station?.name}.\nТвой взлёт.` : 'Выше.\nЕщё выше.';
  const body = starting ? (tiltStatus === 'requesting' ? 'Разрешите доступ к датчикам движения.' : 'Держите телефон удобно. Подключаем наклон…')
    : renderError ? 'Открой игру в актуальной версии Safari или Chrome.' : journeyComplete ? 'Маршрут завершён. Можно вернуться за звёздами и медалями.'
      : finished ? view.practice ? 'Тренировка завершена. Прогресс кампании сохранён.' : view.section === 2 ? `Дальше — ${STATIONS[view.station + 1]?.name ?? 'твои новые рекорды'}.` : 'Контрольная точка сохранена. Следующий участок уже рядом.'
        : view.mode === 'over' ? FAILURE[view.failure ?? 'fall'] : view.mode === 'paused' ? 'Продолжим с того же места. Наклон откалибруется заново.' : station?.hint ?? 'Ракетки дают один отскок. Сетки-пружины подбрасывают выше.';

  return <section className="pj" aria-label="PadlHub Jump — падел-аркада" ref={region} tabIndex={-1}
    onKeyDown={e => key(e, true)} onKeyUp={e => key(e, false)}
    onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) pause(); }}>
    <aside className="pj-editorial">
      <a className="pj-wordmark" href="#padel-jump" aria-label="PadlHub Jump">Padl<span>Hub</span><i>®</i></a>
      <div className="pj-editorial-copy"><span className="pj-eyebrow"><span /> 11 СТАНЦИЙ · ОДИН МАРШРУТ</span>
        <h1>Твой корт.<br />Твой <em>взлёт.</em></h1><p>От первой подачи в Ясенево<br />до финала в Коломенском.</p>
        <div className="pj-tags"><span>РАКЕТКА — ОДИН ОТСКОК</span><span>100% PADEL</span></div></div>
      <div className="pj-editorial-bottom"><span>ПРОГРЕСС СОХРАНЯЕТСЯ НА УСТРОЙСТВЕ</span><p>Короткие участки.<br />Твой собственный темп.</p></div>
    </aside>
    <div className="pj-device" id="padel-jump">
      <header className="pj-topbar" inert={mapOpen}>
        <button type="button" className="pj-icon-button" onClick={() => { starter.current?.cancel(); if (onBack) onBack(); else openMap(); }} aria-label={onBack ? 'Вернуться в личный кабинет' : 'Карта станций'}>‹</button>
        <div className="pj-logo"><img src={logoHab} alt="ПадлхАБ" /><small>Jump</small></div>
        <button type="button" className="pj-icon-button pj-pause" onClick={() => pause(true)} aria-label="Пауза" disabled={!playing}>Ⅱ</button>
      </header>
      {campaign ? <><div className="pj-campaign-hud" inert={mapOpen}>
        <button type="button" className="pj-station" onClick={openMap} aria-label={`Карта станций: ${station?.name}`}><b>{String(view.station + 1).padStart(2, '0')}</b><span>{station?.name}<small>Участок {view.section + 1}/3{view.practice ? ' · тренировка' : view.assist ? ' · с подсветкой' : station?.construction ? ' · черновой арт' : ''}</small></span></button>
        <strong aria-label={`Звёзды участка: ${view.stars} из ${view.totalStars}`}>★ {view.stars}/{view.totalStars}</strong><span className="pj-height">{view.score} м</span><span className="pj-percent">{Math.floor(view.progress * 100)}%</span>
      </div><progress className="pj-route-progress" max={1} value={view.progress} aria-label="Прогресс участка" /></>
        : <div className="pj-stats" inert={mapOpen}><div><span className="pj-stat-label">ВЫСОТА</span><strong data-testid="jump-score">{view.score}<small> м</small></strong></div><div className="pj-best"><span className="pj-stat-label">РЕКОРД</span><strong>{best}<small> м</small></strong></div><button type="button" className="pj-boost" onClick={openMap}>КАРТА</button></div>}
      <div className="pj-field">
        <canvas ref={canvas} className="pj-canvas" width={420} height={640} aria-label="Игровое поле: мяч прыгает по опорам. Управляйте наклоном телефона, стрелками или кнопками под полем."
          onPointerDown={e => pointer(e)} onPointerMove={e => { if (inputs.current.has(`pointer:${e.pointerId}`)) pointer(e); }} onPointerUp={release} onPointerCancel={release} onLostPointerCapture={release} />
        {playing && <div className="pj-field-caption" aria-hidden="true">{view.boost ? 'ВЫСОКИЙ ОТСКОК!' : view.practice ? 'ТРЕНИРОВКА · ПРОГРЕСС СОХРАНЁН' : view.assist ? 'ПОДСВЕТКА МАРШРУТА' : view.station === 0 && !game.current.campaign?.difficultySeen ? (game.current.campaign?.controlledLandings && !game.current.campaign.directionChanges ? 'Теперь смени направление' : (game.current.campaign?.controlledLandings ?? 0) >= 3 ? 'Отлично! Выбирай следующую опору' : `Освой управление: ${game.current.campaign?.controlledLandings ?? 0}/3 приземлений`) : view.progress < 0.08 ? station?.skill ?? 'РАКЕТКА — ОДИН ОТСКОК' : view.progress > 0.98 ? view.hint : 'СМОТРИ НА СЛЕДУЮЩУЮ ОПОРУ'}</div>}
        {!mapOpen && (view.mode !== 'running' || renderError || journeyComplete) && <div className={`pj-overlay pj-overlay-${view.mode}`}>
          <div className="pj-dialog" role="group" aria-label={view.mode === 'over' ? 'Результат игры' : 'Управление игрой'}>
            <span className="pj-pill">{journeyComplete ? 'МАРШРУТ ЗАВЕРШЁН' : campaign ? `${station?.name} · ${view.section + 1}/3` : 'ПаделхАБ JUMP'}</span>
            <div className="pj-hero-ball" aria-hidden="true"><span /></div><h2>{title}</h2>
            <p role={starting ? 'status' : undefined}>{body}</p>
            {view.mode === 'ready' && <div className="pj-legend" aria-label="Обозначения опор"><span>Ракетка · 1 отскок</span><span>Площадка · можно вернуться</span><span>Сетка · ускорение</span></div>}
            {view.mode === 'ready' && artStatus !== 'ready' && <div className="pj-art-status" role="status">{artStatus === 'loading' ? 'Готовим оформление. Играть уже можно.' : <>Упрощённая графика. <button type="button" onClick={() => setArtAttempt(n => n + 1)}>Загрузить снова</button></>}</div>}
            {view.mode === 'over' && campaign && <div className="pj-result">Участок {view.section + 1}/3 · {Math.floor(view.progress * 100)}% пути · ★ {view.stars}/{view.totalStars}</div>}
            {view.aided && finished && <div className="pj-result">С подсветкой · прохождение сохранено</div>}
            {!renderError && <button ref={primaryButton} type="button" className="pj-play" disabled={starting} aria-busy={starting}
              onClick={journeyComplete ? openMap : finished ? continueRoute : start}>{starting ? 'Подключаем…' : journeyComplete ? 'К итоговой карте' : finished ? view.practice ? 'Ещё раз' : 'Дальше' : view.mode === 'paused' ? 'Продолжить' : view.mode === 'over' ? 'Повторить' : 'Полетели'}<span aria-hidden="true">↗</span></button>}
            <div className="pj-dialog-actions">
              {view.mode === 'over' && campaign && <button type="button" onClick={() => { prepare(view.station, view.section, true); start(); }}>Потренировать участок</button>}
              <button type="button" onClick={openMap}>К карте</button>
              {campaign && failures >= BALANCE.assistanceAfterFailures && !view.assist && view.mode === 'over' && <button type="button" onClick={() => { toggleAssist(true); start(); }}>Подсветить маршрут</button>}
            </div>
            <span className="pj-dialog-note">{finished && !view.practice && !journeyComplete ? 'Продолжим автоматически. Можно нажать «Дальше».' : 'Прыжки — автоматически. Ракетки — на один раз.'}</span>
          </div>
        </div>}
        {mapOpen && <div className="pj-map" role="dialog" aria-modal="true" aria-label="Карта станций">
          <div className="pj-map-heading"><div><span className="pj-eyebrow">ТВОЙ МАРШРУТ</span><h2>11 станций ПадлхАБ</h2><p className="pj-map-total">Собрано звёзд: {saved.claimed.length}</p></div><button type="button" aria-label="Закрыть карту" onClick={closeMap}>×</button></div>
          {saved.completed && <p className="pj-map-complete">Все станции пройдены. Возвращайся за звёздами и медалями!</p>}
          <button type="button" className="pj-settings-link" onClick={() => { const settings = region.current?.querySelector<HTMLElement>('.pj-map-settings'); settings?.scrollIntoView({ block: 'start' }); settings?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true }); }}>Звук и управление ↘</button>
          <div className="pj-station-list">{STATIONS.map((s, index) => {
            const unlocked = index <= saved.unlocked, medal = stationMedal(saved, index);
            const first = !saved.completed && index === saved.unlocked ? saved.current.section : 0;
            return <div className={`pj-map-station${s.construction ? ' pj-map-construction' : ''}`} key={s.name}>
              <button type="button" disabled={!unlocked} onClick={() => choose(index, first)} aria-label={`${s.name}: ${!unlocked ? 'закрыто' : medal ? 'пройдено' : 'доступно'}`}>
                <b>{String(index + 1).padStart(2, '0')}</b><span><strong>{s.name}</strong><small>{!unlocked ? '🔒 Пройди предыдущую станцию' : medal === 'perfect' ? '★★★ Все звёзды без помощи' : medal === 'skill' ? '◆ Медаль навыка' : medal ? '✓ Пройдено' : s.skill}{s.construction ? ' · черновой арт' : ''}</small></span><i>{unlocked ? '↗' : '🔒'}</i>
              </button>
              {unlocked && <div className="pj-practice-parts">{[0, 1, 2].map(n => <button type="button" disabled={!canPlayPart(saved, index, n)} key={n} onClick={() => choose(index, n, true)} aria-label={`Тренировка: ${s.name}, участок ${n + 1}`}>{n + 1}/3 {partResult(saved, index, n).done ? '✓' : '·'}</button>)}</div>}
            </div>;
          })}</div>
          <div className="pj-map-settings">
            <label><input type="checkbox" checked={saved.settings.assist} onChange={e => toggleAssist(e.target.checked)} /> Подсветка маршрута <small>Помогает пройти, без идеальной медали</small></label>
            <label><input type="checkbox" checked={saved.settings.effects} onChange={e => { progress.current.settings.effects = e.target.checked; save(); }} /> Декоративные эффекты</label>
            <label><input type="checkbox" checked={saved.settings.sound} onChange={e => { progress.current.settings.sound = e.target.checked; audio.setEnabled(e.target.checked); if (e.target.checked) audio.unlock(); save(); }} /> Звуки игры <small>Короткие сигналы прыжка, звёзд и финиша</small></label>
            <label className="pj-sensitivity">Чувствительность наклона <output>{saved.settings.tiltSensitivity.toFixed(2)}×</output><input type="range" min="0.65" max="1.5" step="0.05" value={saved.settings.tiltSensitivity} aria-label="Чувствительность наклона" onChange={e => { progress.current.settings.tiltSensitivity = Number(e.target.value); tilt.setSensitivity(Number(e.target.value)); save(); }} /></label>
            <label><input type="checkbox" checked={saved.settings.journal} onChange={e => { progress.current.settings.journal = e.target.checked; save(); }} /> Локальный журнал игры <small>Без имени и телефона, только на этом устройстве</small></label>
            <button type="button" onClick={() => choose(-1, 0)}>Бесконечный подъём · рекорд {best} м</button>
            {storageIssue && <p role="status">Браузер не сохраняет данные. Этот заход работает, но прогресс может потеряться после закрытия.</p>}
            <p>Пройди все 11 станций и собери свои медали.</p>
          </div>
        </div>}
      </div>
      <footer className="pj-controls" inert={mapOpen}>
        <button type="button" aria-label="Двигаться влево" disabled={!playing} onPointerDown={e => pointer(e, -1)} onPointerUp={release} onPointerCancel={release} onLostPointerCapture={release}
          onKeyDown={e => { if (playing && ['Space', 'Enter'].includes(e.code)) { e.preventDefault(); inputType.current = 'keyboard'; inputs.current.set('button:left', -1); } }} onKeyUp={() => inputs.current.delete('button:left')} onBlur={() => inputs.current.delete('button:left')}>‹</button>
        <div><strong>{tiltSelected ? 'Наклоняй телефон влево и вправо' : 'Веди мяч влево и вправо'}</strong><span>{tiltSelected ? 'Пауза — калибровка. Касание тоже работает' : 'Касайся краёв поля или используй ← →'}</span></div>
        <button type="button" aria-label="Двигаться вправо" disabled={!playing} onPointerDown={e => pointer(e, 1)} onPointerUp={release} onPointerCancel={release} onLostPointerCapture={release}
          onKeyDown={e => { if (playing && ['Space', 'Enter'].includes(e.code)) { e.preventDefault(); inputType.current = 'keyboard'; inputs.current.set('button:right', 1); } }} onKeyUp={() => inputs.current.delete('button:right')} onBlur={() => inputs.current.delete('button:right')}>›</button>
      </footer>
    </div>
  </section>;
}
