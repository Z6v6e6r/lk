import { mountSpectatorView } from './spectator-ui.mjs';
import { createSpectatorPlayback } from './playback.mjs';
import { STREAM_PROFILES } from './spectator-network.mjs';

/** Same public GET route, opt-in projection. One in-flight read, no coordinate backlog. */
export function mountLiveSpectator(root, { logoUrl, createRenderer, onJoin, profile = 'constrained', api = '/jump-live-api/', onError = () => {} }) {
  let alive = true, busy = false, timer = null, controller = null, visible = [], catalog = '', playersKey = '', resultsKey = '';
  let needsFresh = true, reanchor = true, requestGeneration = 0, lastResync = -Infinity, failures = 0;
  const clock = () => performance.now();
  const playback = createSpectatorPlayback({ profile, onResync: () => {
    if (clock() - lastResync < 5000) return;
    lastResync = clock(); needsFresh = true; reanchor = true;
  } });
  const view = mountSpectatorView(root, { logoUrl, onJoin, createRenderer, targetFps: 30,
    onVisibleRunsChange: ids => {
      visible = ids; requestGeneration++; needsFresh = true; reanchor = true;
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
        const nextPlayers = JSON.stringify(packet.catalog.players), nextResults = JSON.stringify(packet.catalog.results);
        if (nextPlayers !== playersKey) {
          const players = packet.catalog.players;
          if (!Array.isArray(players) || players.length > 12 || players.some(p => typeof p.name !== 'string' || p.name.length > 48)) throw new Error('SPECTATOR_CATALOG_INVALID');
          view.updatePlayers(players.map(p => ({ ...p, stationLabel: '', getFrame: now => playback.frame(p.runId, now) })));
          playback.forgetExcept(players.map(p => p.runId)); playersKey = nextPlayers;
        }
        if (nextResults !== resultsKey) {
          view.setLeaderboard(packet.catalog.results.map(r => ({ id: r.id, name: r.alias, score: r.stars, elapsedMs: r.elapsedMs })));
          resultsKey = nextResults;
        }
      }
      catalog = packet.catalogVersion;
      failures = 0; view.setConnection('connected');
    } catch (error) {
      if (!alive || root.ownerDocument.hidden) return;
      needsFresh = true; reanchor = true; failures++;
      view.setConnection('offline'); onError(error);
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
    alive = false; controller?.abort(); if (timer !== null) clearTimeout(timer);
    root.ownerDocument.removeEventListener('visibilitychange', visibility);
    root.ownerDocument.defaultView.removeEventListener('online', online);
    view.destroy();
  };
}
