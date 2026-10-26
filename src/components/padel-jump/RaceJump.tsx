import { useEffect, useRef, useState } from 'react';
import { createCampaignGame, drainEvents, FIXED_STEP, stepGame } from './engine';
import { STATIONS } from './campaign';
import { drawGame } from './render';
import { loadYasenevoArt } from './yasenevo-assets';
import type { YasenevoArt } from './yasenevo-assets';
import { loadStationPainting } from './station-art';
import type { StationPainting } from './station-art';
import { loadRacketArt } from './racket-art';
import type { RacketArt } from './racket-art';
import { loadStationActors } from './station-actors';
import type { StationActors } from './station-actors';
import { browserTiltEnvironment, createTiltController } from './tilt';
import { readyRaceTilt } from './race-tilt';
import { racePageUrl } from './race-navigation';
import { recordLkUserActivity } from '../../utils/lkIdleDataGuard';
import { createRaceControl } from './race-control';
import { createRaceConnection, joinRace, raceProfile } from './live-client';
import { formatRaceTime, LIVE_LIVES } from './live-contract';
import type { LiveAck } from './live-client';
import logo from '../../assets/logo-hab-compact.svg';
import './live.css';

const RACE_CONTROL_HINT = 'Управляй мячом наклоном телефона влево и вправо. Если наклон недоступен, удерживай левую или правую половину поля. На компьютере используй стрелки ← →.';

export function RaceLives({ remaining }: { remaining: number }) {
  return <span className="pj-race-lives" role="status" aria-label={`Осталось жизней: ${remaining} из ${LIVE_LIVES}`}>
    {Array.from({ length: LIVE_LIVES }, (_, index) => <span key={index} className={`pj-race-life${index < remaining ? '' : ' is-spent'}`} aria-hidden="true" />)}
  </span>;
}

export default function RaceJump({ onChangeProfile, onCheckAdmission }: { onChangeProfile?: () => void; onCheckAdmission?: () => void } = {}) {
  const [checking, setChecking] = useState(true), [profileAttempt, setProfileAttempt] = useState(0);
  const [profile, setProfile] = useState<{ name: string; communityId: string } | null>(null), [pending, setPending] = useState(false), [error, setError] = useState('');
  const [view, setView] = useState({ mode: 'ready', station: 0, section: 0, score: 0, lives: LIVE_LIVES, stars: 0 });
  const [result, setResult] = useState<LiveAck['result']>(), [displayMs, setDisplayMs] = useState(0);
  const game = useRef(createCampaignGame()), canvas = useRef<HTMLCanvasElement>(null), region = useRef<HTMLElement>(null);
  const connection = useRef<ReturnType<typeof createRaceConnection> | null>(null), directions = useRef(new Map<string, number>());
  const locked = useRef(false), alive = useRef(true), ackClock = useRef({ elapsed: 0, received: 0, final: false });
  const painting = useRef<StationPainting | null>(null), yas = useRef<YasenevoArt | null>(null), racket = useRef<RacketArt | null>(null), actors = useRef<StationActors | null>(null);
  const [tilt] = useState(() => createTiltController(browserTiltEnvironment()));
  const finalRequested = useRef(false);
  const lives = useRef(LIVE_LIVES);
  const stars = useRef(0);
  const joinAbort = useRef<AbortController | null>(null);
  const refresh = () => { const g = game.current; setView({ mode: g.mode, station: g.campaign!.station, section: g.campaign!.section, score: g.score, lives: lives.current, stars: stars.current }); };
  const [control] = useState(() => createRaceControl({
    game: () => game.current, replace: value => { game.current = value; }, connection: () => connection.current,
    foreground: () => !document.hidden && document.hasFocus(), prepareResume: async () => { if (navigator.maxTouchPoints > 0) await readyRaceTilt(tilt, false); },
    stopped: () => locked.current || !alive.current,
    canPause: () => lives.current > 0 && !finalRequested.current && !(game.current.mode === 'complete' && game.current.campaign?.station === 10 && game.current.campaign.section === 2),
    changed: refresh, pending: setPending,
  }));
  useEffect(() => {
    let active = true; painting.current = null; actors.current = null;
    void loadRacketArt().then(v => { if (active) racket.current = v; });
    if (view.station === 0) void loadYasenevoArt().then(v => { if (active) yas.current = v; });
    else void loadStationPainting(view.station).then(v => { if (active) painting.current = v; });
    void loadStationActors(view.station).then(v => { if (active) actors.current = v; });
    return () => { active = false; };
  }, [view.station]);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; control.dispose(); connection.current?.dispose(); joinAbort.current?.abort(); tilt.dispose(); };
  }, [tilt, control]);
  useEffect(() => {
    const controller = new AbortController(); let active = true;
    void raceProfile(controller.signal).then(v => { if (active) setProfile(v); }).catch(e => { if (active) setError(e instanceof Error ? e.message : 'Профиль не подтверждён.'); }).finally(() => { if (active) setChecking(false); });
    return () => { active = false; controller.abort(); };
  }, [profileAttempt]);
  const serverAck = (v: LiveAck) => {
    if (!alive.current) return;
    lives.current = v.player.livesRemaining;
    stars.current = v.player.stars;
    control.acknowledge(v.player, v.prediction);
    ackClock.current = { elapsed: v.player.elapsedMs, received: performance.now(), final: v.player.completedParts === 33 || v.player.state === 'eliminated' };
    if ((v.player.completedParts === 33 || v.player.state === 'eliminated') && !v.result && !finalRequested.current) { finalRequested.current = true; void connection.current?.command('finish'); }
    if (v.result) { setResult(v.result); setDisplayMs(v.result.elapsedMs); connection.current?.dispose(); }
  };
  const networkError = (message: string, retryFinish = false) => { if (!alive.current) return; if (retryFinish) { setError(message); refresh(); return; } locked.current = true; game.current.mode = 'paused'; directions.current.clear(); setError(message); refresh(); };
  const pause = () => { directions.current.clear(); return control.pause(); };
  const begin = async () => {
    if (pending || !profile) return;
    setPending(true); setError(''); joinAbort.current = new AbortController();
    try {
      if (navigator.maxTouchPoints > 0) await readyRaceTilt(tilt, true);
      if (!alive.current) return;
      if (document.hidden || !document.hasFocus()) throw new Error('Вернись на страницу и нажми старт ещё раз.');
      const ticket = await joinRace(joinAbort.current.signal); if (!alive.current) return;
      connection.current?.dispose(); connection.current = createRaceConnection(ticket, serverAck, networkError);
      game.current = createCampaignGame(); game.current.mode = 'running'; locked.current = false; control.reset(); setResult(undefined);
      serverAck(ticket); refresh();
      if (document.hidden || !document.hasFocus()) await control.pause();
      else region.current?.focus();
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : 'Сервер заездов недоступен.'); }
    finally { if (alive.current) setPending(false); }
  };
  const command = async (action: 'retry' | 'advance' | 'resume' | 'finish') => {
    setError('');
    try { await control.command(action); if (alive.current && !document.hidden) region.current?.focus(); }
    catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : 'Не удалось продолжить заезд.'); }
  };
  useEffect(() => {
    const element = canvas.current, ctx = element?.getContext('2d'); if (!element || !ctx) return;
    let frame = 0, previous = 0, accumulator = 0, heartbeat = 0, published = 0;
    const tick = (now: number) => {
      const seconds = previous ? Math.min(0.05, Math.max(0, (now - previous) / 1000)) : 0; previous = now;
      const g = game.current;
      if (g.mode === 'running' && connection.current && control.canStep()) {
        accumulator += seconds; let direction = 0; for (const value of directions.current.values()) direction += value;
        if (!directions.current.size) {
          direction = tilt.direction();
          if (direction !== 0) recordLkUserActivity();
        }
        direction = Math.round(Math.max(-1, Math.min(1, direction)) * 100) / 100;
        while (accumulator >= FIXED_STEP && g.mode === 'running' && connection.current.canStep()) {
          connection.current.record(direction); stepGame(g, direction); drainEvents(g); accumulator -= FIXED_STEP;
        }
        if (!connection.current.canStep()) accumulator = 0;
        if (g.mode !== 'running') void connection.current.flush();
      } else accumulator = 0;
      if (now - heartbeat >= 500 && connection.current && !locked.current && !result) { void connection.current.flush(); heartbeat = now; }
      if (now - published > 100) {
        refresh(); const clock = ackClock.current;
        if (!result && connection.current) setDisplayMs(clock.elapsed + (g.mode === 'paused' || locked.current || clock.final ? 0 : Math.max(0, now - clock.received)));
        published = now;
      }
      const rect = element.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2);
      const w = Math.max(1, rect.width), h = Math.max(1, rect.height);
      if (element.width !== Math.round(w * dpr) || element.height !== Math.round(h * dpr)) { element.width = Math.round(w * dpr); element.height = Math.round(h * dpr); }
      drawGame(ctx, g, w, h, dpr, true, yas.current, painting.current, racket.current, undefined, actors.current);
      frame = requestAnimationFrame(tick);
    };
    const hidden = () => { if (document.hidden) { previous = 0; void pause(); } };
    const blur = () => { void pause(); };
    document.addEventListener('visibilitychange', hidden); window.addEventListener('blur', blur); frame = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(frame); document.removeEventListener('visibilitychange', hidden); window.removeEventListener('blur', blur); };
    // Refs keep input and transport state current; restart only when the result becomes final.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, tilt, control]);
  const active = !!connection.current, finished = view.mode === 'complete', last = view.station === 10 && view.section === 2;
  const eliminated = active && view.lives === 0;
  const checkpointReady = control.checkpointConfirmed();
  const move = (key: string, value: number) => { if (view.mode === 'running') directions.current.set(key, value); };
  return <main className="pj-race" ref={region} tabIndex={-1} onKeyDown={e => {
    if (['ArrowLeft', 'ArrowRight'].includes(e.key)) { e.preventDefault(); move(e.key, e.key === 'ArrowLeft' ? -1 : 1); }
    if (e.key === 'Escape') void pause();
  }} onKeyUp={e => directions.current.delete(e.key)}>
    <header><img src={logo} alt="ПадлхАБ" /><span>Jump · звёзды за 5 жизней</span><a href={racePageUrl('live')}>Общий экран ↗</a></header>
    {!active && <section className="pj-race-entry"><h1>Больше звёзд. Выше в рейтинге.</h1><p>На каждую попытку у тебя всего 5 жизней. Чем больше звезд ты наберешь, тем выше твой рейтинг в сообществе. Если количество звезд равное, выше тот, кто потратил меньше времени.</p><p className="pj-race-control-hint">{RACE_CONTROL_HINT}</p><p className="pj-race-profile">{profile ? `Играешь как ${profile.name}` : checking ? 'Подтверждаем профиль сообщества…' : 'Профиль пока не подтверждён'}</p>{!profile && <><button disabled={checking} onClick={() => { setError(''); setChecking(true); setProfileAttempt(n => n + 1); }}>Проверить профиль</button>{onCheckAdmission && <button onClick={onCheckAdmission}>Вернуться к проверке участия</button>}</>}{onChangeProfile && <button onClick={onChangeProfile}>Выйти и сменить профиль</button>}<p className="pj-live-note">Нажимая «Игра на ретинг», ты показываешь имя профиля, игру и результат на общем экране. Личный прогресс обычной игры сохраняется отдельно. Рейтинг связан с твоим профилем сообщества.</p><button disabled={pending || !profile} onClick={() => void begin()}>{pending ? 'Подключаем…' : 'Игра на ретинг'}</button><a href={racePageUrl('practice')}>Обычная игра</a></section>}
    {error && <p role="alert" className="pj-live-error">{error}</p>}
    {active && <div className="pj-race-hud"><strong>{STATIONS[view.station].name} <small>{view.section + 1}/3</small></strong><span>{view.score} м</span><span aria-label={`Собрано звёзд: ${view.stars}`}>★ {view.stars}</span><RaceLives remaining={view.lives} /><time>{formatRaceTime(displayMs)}</time><button disabled={pending || eliminated || locked.current || view.mode === 'paused' || !!result} onClick={() => void pause()}>Пауза</button></div>}
    <div className="pj-race-field" hidden={!active}><canvas ref={canvas} aria-label="Заезд Jump. Веди мяч наклоном телефона, стрелками или касанием левой и правой половины поля."
      onPointerDown={e => { if (view.mode !== 'running') return; e.currentTarget.setPointerCapture(e.pointerId); const rect = e.currentTarget.getBoundingClientRect(); move(String(e.pointerId), e.clientX < rect.left + rect.width / 2 ? -1 : 1); }}
      onPointerUp={e => directions.current.delete(String(e.pointerId))} onPointerCancel={e => directions.current.delete(String(e.pointerId))} onLostPointerCapture={e => directions.current.delete(String(e.pointerId))} />
      {active && view.mode !== 'running' && <div className="pj-race-overlay">{view.mode === 'paused' && !locked.current && !result && <p className="pj-race-control-hint">{RACE_CONTROL_HINT}</p>}<h2>{result ? 'Результат сохранён' : eliminated ? 'Жизни закончились' : locked.current ? 'Заезд остановлен' : finished ? checkpointReady ? 'Участок пройден!' : 'Подтверждаем финиш…' : view.mode === 'over' ? 'Ещё одна попытка' : 'Пауза'}</h2><time>{formatRaceTime(result?.elapsedMs ?? displayMs)}</time>
        {eliminated && <p>Все {LIVE_LIVES} жизней потрачены. Собрано звёзд: {view.stars}. Новый заезд — с Ясенево 1/3.</p>}{result ? <p>Этот заезд: ★ {result.stars} · {formatRaceTime(result.elapsedMs)}. В рейтинге учитывается твой лучший результат.</p> : eliminated ? !locked.current && <button disabled={pending} onClick={() => void command('finish')}>{pending ? 'Сохраняем…' : 'Подтвердить результат'}</button> : !eliminated && !locked.current && <button disabled={pending || finished && !checkpointReady} onClick={() => void command(finished ? last ? 'finish' : 'advance' : view.mode === 'over' ? 'retry' : 'resume')}>{pending || finished && !checkpointReady ? 'Подтверждаем…' : finished ? last ? 'Подтвердить финиш' : 'Дальше' : view.mode === 'over' ? 'Повторить' : 'Продолжить'}</button>}
        {(result || eliminated || locked.current) && <a href={racePageUrl('race')}>Новый заезд</a>}</div>}
    </div>

  </main>;
}
