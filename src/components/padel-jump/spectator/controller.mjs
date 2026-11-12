import { mountSpectatorView } from './spectator-ui.mjs';
import { createSpectatorPlayback } from './playback.mjs';
import { STREAM_PROFILES } from './spectator-network.mjs';
import { createSmoothMotion } from './smooth-motion.mjs';
import { createDemoShow, DEMO_LEADERBOARD } from './demo-runs.mjs';

const RATING_CACHE_KEY = 'padlhub.jump.wall.rating.v1';
const OFFLINE_DEMO_AFTER_MS = 45000;
const readCache = storage => { try { const value = JSON.parse(storage?.getItem(RATING_CACHE_KEY) ?? 'null'); return Array.isArray(value?.rows) && Number.isFinite(value.savedAt) ? value : null; } catch { return null; } };
const writeCache = (storage, rows) => { try { storage?.setItem(RATING_CACHE_KEY, JSON.stringify({ savedAt: Date.now(), rows })); } catch { /* Private mode: the wall still works without a cache. */ } };
const cacheNote = savedAt => `Нет связи с сервером · рейтинг на ${new Date(savedAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`;

/** Same public GET route, opt-in projection. One in-flight read, no coordinate backlog. */
export function mountLiveSpectator(root, { logoUrl, createRenderer, onJoin, profile = 'constrained', api = '/jump-live-api/', onError = () => {}, tv = false, demo = null, offlineDemo = tv }) {
  if (demo !== null) return mountDemoSpectator(root, { logoUrl, createRenderer, tv, scenario: demo });
  let alive = true, busy = false, timer = null, controller = null, visible = [], catalog = '', playersKey = '', resultsKey = '';
  let needsFresh = true, reanchor = true, requestGeneration = 0, lastResync = -Infinity, failures = 0;
  let catalogPlayers = [], shownPlayers = [];
  const clock = () => performance.now();
  const storage = (() => { try { return root.ownerDocument.defaultView.localStorage; } catch { return null; } })();
  let connectedOnce = false, lastSuccessAt = performance.now(), demoStop = null;
  const smooth = createSmoothMotion({ coastMs: tv ? 12000 : 6000 });
  // A TV wall tolerates a long delay: smooth late motion beats a frozen frame.
  const playback = createSpectatorPlayback({ profile, maxDelayMs: tv ? 10000 : 4000, onResync: () => {
    if (clock() - lastResync < 5000) return;
    lastResync = clock(); needsFresh = true; reanchor = true;
  } });
  const view = mountSpectatorView(root, { logoUrl, onJoin, createRenderer, targetFps: 30, tv,
    onVisibleRunsChange: ids => {
      // Offline demo runs are local only: never request them from the board.
      visible = ids.filter(id => !id.startsWith('demo-')); requestGeneration++; needsFresh = true; reanchor = true;
      playback.requireFresh(ids); schedule(0);
    }, onError,
  });
  function schedule(delay) {
    if (!alive || root.ownerDocument.hidden) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(poll, delay);
  }
  async function poll() {
    timer = null;
    if (!alive || busy || root.ownerDocument.hidden) return;
    busy = true; controller = new AbortController();
    const currentController = controller;
    const deadline = setTimeout(() => currentController.abort(), 8000);
    const generation = requestGeneration, ids = [...visible], fresh = needsFresh, anchor = reanchor;
    needsFresh = false; reanchor = false;
    const sentAt = clock();
    try {
      const params = new URLSearchParams({ spectator: '1', profile, runs: ids.join(','), catalog,
        ...Object.fromEntries(Object.entries(playback.requestState(ids)).map(([key, value]) => [key, JSON.stringify(value)])), ...(fresh ? { fresh: '1' } : {}) });
      const response = await fetch(api + 'board?' + params, { signal: currentController.signal, cache: 'no-store', credentials: 'omit' });
      if (!response.ok) throw new Error('SPECTATOR_HTTP_' + response.status);
      const raw = await response.text();
      if (raw.length > 2097152) throw new Error('SPECTATOR_TOO_LARGE');
      const packet = JSON.parse(raw);
      if (packet.schema !== 'jump-spectator-v1') throw new Error('SPECTATOR_UPGRADE_REQUIRED');
      if (!alive || generation !== requestGeneration || root.ownerDocument.hidden) return;
      playback.ingest(packet, { sentAt, receivedAt: clock(), reanchor: anchor });
      if (packet.catalog) {
        const nextResults = JSON.stringify(packet.catalog.results);
        const players = packet.catalog.players;
        if (!Array.isArray(players) || players.length > 12 || players.some(p => typeof p.name !== 'string' || p.name.length > 48)) throw new Error('SPECTATOR_CATALOG_INVALID');
        catalogPlayers = players;
        if (nextResults !== resultsKey) {
          const rows = packet.catalog.results.map(r => ({ id: r.id, name: r.alias, score: r.stars, elapsedMs: r.elapsedMs }));
          view.setLeaderboard(rows); view.setRatingNote('');
          writeCache(storage, rows.slice(0, 50));
          resultsKey = nextResults;
        }
      }
      if (demoStop) { demoStop(); demoStop = null; playersKey = ''; }
      const players = playback.withFinished(catalogPlayers, shownPlayers, clock());
      const nextPlayers = JSON.stringify(players);
      if (nextPlayers !== playersKey) {
        view.updatePlayers(players.map(p => ({ ...p, stationLabel: '', getFrame: now => smooth.present(p.runId, playback.frame(p.runId, now), now) })));
        const ids = players.map(p => p.runId);
        playback.forgetExcept(ids); smooth.forgetExcept(ids); playersKey = nextPlayers; shownPlayers = players;
      }
      connectedOnce = true; lastSuccessAt = clock();
      catalog = packet.catalogVersion;
      failures = 0; view.setConnection('connected');
    } catch (error) {
      if (!alive || root.ownerDocument.hidden) return;
      needsFresh = true; reanchor = true; failures++;
      view.setConnection('offline'); onError(error);
      if (!resultsKey) {
        const cached = readCache(storage);
        if (cached) { view.setLeaderboard(cached.rows); view.setRatingNote(cacheNote(cached.savedAt)); resultsKey = 'cache'; }
        else view.setRatingStatus('Рейтинг появится, когда вернётся связь');
      }
      // Long outage on a TV: labelled demonstration games, never mixed into the rating.
      if (offlineDemo && !demoStop && !shownPlayers.some(p => !p.finished) && clock() - lastSuccessAt > (connectedOnce ? OFFLINE_DEMO_AFTER_MS : OFFLINE_DEMO_AFTER_MS / 3)) {
        demoStop = runDemo(view, createDemoShow('loop'), 'Демонстрация · нет связи с сервером');
        shownPlayers = []; playersKey = '';
      }
      if (error.message === 'SPECTATOR_UPGRADE_REQUIRED') {
        root.querySelector('[data-connection]').textContent = 'Для этого табло нужен обновлённый сервер Jump. Последние результаты не подменяются демо.';
      }
    } finally {
      clearTimeout(deadline); busy = false; controller = null;
      const interval = 1000 / STREAM_PROFILES[profile].poseHz;
      // Request start cadence, without concurrent reads or a post-outage burst.
      schedule(needsFresh && !failures ? 0 : Math.max(failures ? Math.min(5000, interval * 2 ** failures) : 0, interval - (clock() - sentAt)));
    }
  }
  const visibility = () => {
    requestGeneration++;
    if (root.ownerDocument.hidden) { if (timer !== null) clearTimeout(timer); timer = null; controller?.abort(); }
    else { needsFresh = true; reanchor = true; playback.requireFresh(visible); schedule(0); }
  };
  root.ownerDocument.addEventListener('visibilitychange', visibility);
  const online = () => { needsFresh = true; reanchor = true; schedule(0); };
  root.ownerDocument.defaultView.addEventListener('online', online);
  schedule(0);
  return () => {
    alive = false; controller?.abort(); if (timer !== null) clearTimeout(timer); demoStop?.();
    root.ownerDocument.removeEventListener('visibilitychange', visibility);
    root.ownerDocument.defaultView.removeEventListener('online', online);
    view.destroy();
  };
}

/** Drive the view with a local demo show until stopped. Returns the stop function. */
function runDemo(view, show, label) {
  const win = globalThis;
  const startedAt = performance.now();
  let key = '';
  view.setDemo(label);
  const update = () => {
    const seconds = (performance.now() - startedAt) / 1000;
    const players = show.players(seconds);
    const nextKey = players.map(p => p.runId + (p.finished ? ':done' : '')).join(',');
    if (nextKey === key) return;
    key = nextKey;
    view.updatePlayers(players.map(run => ({ runId: run.runId, name: run.name, slot: 0, initialLives: run.initialLives, demo: true,
      finished: run.finished, getFrame: now => run.frameAt((now - startedAt) / 1000) })));
  };
  update();
  const timer = win.setInterval(update, 250);
  return () => { win.clearInterval(timer); view.setDemo(null); view.updatePlayers([]); };
}

/** Offline-only wall (recording and stand fallback): no network reads at all. */
function mountDemoSpectator(root, { logoUrl, createRenderer, tv, scenario }) {
  const view = mountSpectatorView(root, { logoUrl, createRenderer, targetFps: 30, tv });
  view.setLeaderboard(DEMO_LEADERBOARD.map(row => ({ ...row })));
  view.setRatingNote('Демонстрация · пример рейтинга');
  view.setConnection('connected');
  const stop = runDemo(view, createDemoShow(scenario), 'Демонстрация');
  return () => { stop(); view.destroy(); };
}
