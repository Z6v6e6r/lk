import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { LIVE_API, LIVE_ENGINE_VERSION, LIVE_LIMIT, LIVE_RULE, LIVE_LIVES, formatRaceTime } from './live-contract';
import type { LiveBoard, LivePlayer } from './live-contract';
import { STATIONS } from './campaign';
import { drawGame } from './render';
import { loadYasenevoArt } from './yasenevo-assets';
import { loadStationPainting } from './station-art';
import { loadRacketArt } from './racket-art';
import { loadStationActors } from './station-actors';
import logo from '../../assets/logo-hab-compact.svg';
import './live.css';

export function readLiveBoard(raw: string): LiveBoard {
  if (raw.length > 524288) throw new Error('BOARD_TOO_LARGE');
  const board = JSON.parse(raw) as LiveBoard;
  if (board.engine !== LIVE_ENGINE_VERSION || board.rule !== LIVE_RULE || !Array.isArray(board.players) || board.players.length > LIVE_LIMIT || !Array.isArray(board.results) || board.results.length > 100) throw new Error('BOARD_INVALID');
  const ids = new Set<string>(), slots = new Set<number>();
  for (const p of board.players) {
    if (!p || typeof p.id !== 'string' || ids.has(p.id) || !Number.isInteger(p.slot) || p.slot < 0 || p.slot >= 12 || slots.has(p.slot) || typeof p.alias !== 'string' || p.alias.length > 48 || !Number.isFinite(p.elapsedMs)
      || !Number.isInteger(p.failures) || p.failures < 0 || p.failures > LIVE_LIVES || p.livesRemaining !== LIVE_LIVES - p.failures || !p.game?.campaign || !STATIONS[p.game.campaign.station] || !Number.isInteger(p.game.campaign.section) || p.game.campaign.section < 0 || p.game.campaign.section > 2 || !Array.isArray(p.game.platforms) || p.game.platforms.length > 50) throw new Error('PLAYER_INVALID');
    ids.add(p.id); slots.add(p.slot);
  }
  return board;
}

function MiniGame({ player }: { player: LivePlayer }) {
  const canvas = useRef<HTMLCanvasElement>(null), latest = useRef(player), draw = useRef(() => {});
  const station = player.game.campaign!.station;
  useEffect(() => { latest.current = player; draw.current(); }, [player]);
  useEffect(() => {
    let active = true; draw.current = () => {};
    void Promise.all([station === 0 ? loadYasenevoArt() : null, loadStationPainting(station), loadRacketArt(), loadStationActors(station)]).then(([yas, scene, rackets, actors]) => {
      if (!active || !canvas.current) return;
      const element = canvas.current, ctx = element.getContext('2d'); if (!ctx) return;
      draw.current = () => {
        const rect = element.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 1.5);
        const w = Math.max(1, rect.width), h = Math.max(1, rect.height); element.width = Math.round(w * dpr); element.height = Math.round(h * dpr);
        drawGame(ctx, latest.current.game, w, h, dpr, true, yas, scene, rackets, undefined, actors);
      };
      draw.current();
    });
    const observer = new ResizeObserver(() => draw.current()); if (canvas.current) observer.observe(canvas.current);
    return () => { active = false; draw.current = () => {}; observer.disconnect(); };
  }, [station]);
  return <canvas ref={canvas} aria-label={`Игра: ${player.alias}`} />;
}

const STATES = { playing: 'В игре', paused: 'Пауза', retry: 'Повторная попытка', checkpoint: 'Участок пройден', finished: 'Финиш', eliminated: 'Жизни закончились' };
export default function LiveScreen() {
  const [board, setBoard] = useState<LiveBoard | null>(null), [status, setStatus] = useState('Подключаем общий экран…'), [connected, setConnected] = useState(true);
  const [fields, setFields] = useState(true);
  useEffect(() => {
    let active = true; const source = new EventSource(LIVE_API + 'stream', { withCredentials: false });
    const stale = setInterval(() => { if (Date.now() - last > 4000) { setConnected(false); setStatus('Связь прервана. Ждём обновления; результаты на экране могут устареть.'); } }, 1000);
    let last = Date.now();
    source.onopen = () => { if (active) { setConnected(true); setStatus('Обновляется в реальном времени'); last = Date.now(); } };
    source.onmessage = e => {
      if (!active) return;
      try { const next = readLiveBoard(e.data); setBoard(next); setConnected(true); setStatus('Обновляется в реальном времени'); last = Date.now(); }
      catch { setConnected(false); setStatus('Версия экрана отличается от игры. Обновите страницу.'); source.close(); }
    };
    source.onerror = () => { if (active) { setConnected(false); setStatus('Нет связи с сервером заездов. Подключаемся снова…'); } };
    return () => { active = false; clearInterval(stale); source.close(); };
  }, []);
  const players = board?.players ?? [], playing = players.filter(p => p.state === 'playing').length;
  return <main className="pj-live-screen"><header><div><img src={logo} alt="ПадлхАБ" /><span>Jump · прямой эфир</span></div><a href="./padel-jump-race.html">Участвовать ↗</a></header>
    <div className="pj-live-title"><div><p className="pj-live-eyebrow">ВРЕМЯ НА НОВЫЙ РЕКОРД</p><h1>{playing ? `Играют сейчас: ${playing}` : players.length ? 'Участники на маршруте' : 'Следующий взлёт — твой'}</h1><p role="status" className={connected ? 'pj-live-connected' : 'pj-live-error'}>{status}</p></div><button aria-pressed={fields} onClick={() => setFields(v => !v)}>{fields ? 'Только результаты' : 'Показать игровые поля'}</button></div>
    {!players.length && <section className="pj-live-empty"><strong>{connected ? 'Ждём игроков' : 'Подключение к заездам'}</strong><p>Открой заезд на телефоне, войди в профиль сообщества — твоя игра появится здесь.</p><a href="./padel-jump-race.html">Открыть заезд ↗</a></section>}
    <section className={`pj-live-grid ${fields ? '' : 'pj-live-cards'}`} style={{ '--columns': Math.min(3, Math.max(1, players.length)), '--rows': Math.max(1, Math.ceil(players.length / 3)) } as CSSProperties} aria-label="Участники онлайн" aria-busy={!connected}>
      {players.map(p => <article className="pj-live-player" key={p.id}><div className="pj-live-player-title"><strong>{p.alias}</strong><span>{STATES[p.state]}</span></div>
        {fields && <MiniGame player={p} />}<div className="pj-live-player-stats"><span>{STATIONS[p.game.campaign!.station].name}<small>Участок {p.game.campaign!.section + 1}/3</small></span><time>{formatRaceTime(p.elapsedMs)}</time></div>
        <progress max={33} value={p.completedParts} aria-label={`${p.alias}: пройдено участков`} /><div className="pj-live-player-bottom"><span>{p.game.score} м</span><span>{p.completedParts}/33 участков</span><span aria-label={`Осталось жизней: ${p.livesRemaining} из ${LIVE_LIVES}`}>♥ {p.livesRemaining}/{LIVE_LIVES}</span></div></article>)}
    </section>
    <section className="pj-live-ranking"><h2>Рейтинг сообщества</h2><p>Полный маршрут · 5 жизней · быстрее — выше · повторы учитываются, паузы исключены.</p>
      {!board?.results.length ? <p>Первые результаты появятся после подтверждённого финиша.</p> : <ol>{board.results.slice(0, 12).map(r => <li key={r.id}><span>{r.alias}</span><time>{formatRaceTime(r.elapsedMs)}</time><small>{r.failures} падений</small></li>)}</ol>}
    </section>
  </main>;
}
