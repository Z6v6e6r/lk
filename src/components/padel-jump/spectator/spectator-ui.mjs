/**
 * Spectator UI shell. No demo data, transport, physics, clock sync or score writes.
 * Import spectator.css once. Mount into a dedicated empty element.
 * createRenderer must adapt the existing game's READ-ONLY renderer.
 */
import { STATIONS } from '../campaign.ts';

export function mountSpectatorView(root, {
  logoUrl,
  onJoin,
  createRenderer,
  maxVisiblePlayers = 4,
  maxCanvasDpr = 1.5,
  targetFps = 30,
  onVisibleRunsChange,
  onError = () => {},
} = {}) {
  if (!root || root.nodeType !== 1) throw new TypeError('A mount element is required');
  if (root.childElementCount) throw new TypeError('Use a dedicated empty mount element');
  if (typeof createRenderer !== 'function') throw new TypeError('createRenderer adapter is required');
  if (![30, 60].includes(targetFps)) throw new TypeError('targetFps must be 30 or 60');
  if (!Number.isInteger(maxVisiblePlayers) || maxVisiblePlayers < 1 || maxVisiblePlayers > 4) throw new TypeError('maxVisiblePlayers must be 1–4');
  if (!Number.isFinite(maxCanvasDpr) || maxCanvasDpr <= 0) throw new TypeError('maxCanvasDpr must be positive');
  const doc = root.ownerDocument, win = doc.defaultView;
  const ownedClass = !root.classList.contains('ph-jump-spectator');
  root.classList.add('ph-jump-spectator');
  const template = doc.createElement('template');
  template.innerHTML = `
    <section class="ph-screen" aria-label="Табло ПадлхАБ Jump">
      <header class="ph-header">
        <div class="ph-brand"><img class="ph-brand-image" alt="ПадлхАБ" hidden><div class="ph-app-name"><strong>Jump</strong><span>Экран сообщества</span></div></div>
        <div class="ph-header-actions"><button type="button" class="ph-main-action" data-action="join" hidden>Играть на телефоне</button><button type="button" class="ph-fullscreen-button" data-action="fullscreen" hidden>На весь экран</button></div>
      </header>
      <div class="ph-section-heading"><div class="ph-now-title"><h1>Пока никто не играет</h1><span class="ph-player-count" hidden>0</span></div><div class="ph-view-switch" role="group" aria-label="Вид табло"><button type="button" data-view="games" aria-pressed="true">Игры и рейтинг</button><button type="button" data-view="rating" aria-pressed="false">Только рейтинг</button></div></div>
      <main class="ph-content" data-layout="empty">
        <section class="ph-live-area" aria-label="Текущие прохождения" hidden><div class="ph-player-picker" role="group" aria-label="Выбрать игрока"></div><div class="ph-courts"></div><p class="ph-live-note">Зрительский режим · движение показано приблизительно</p></section>
        <aside class="ph-standings" aria-label="Рейтинг сообщества"><div class="ph-standings-title"><h2>Рейтинг сообщества</h2><span>Лучший заезд каждого</span></div><table class="ph-ranking-table"><caption class="ph-sr-only">Подтверждённые результаты сообщества</caption><colgroup><col class="ph-col-place"><col><col class="ph-col-balls"><col class="ph-col-time"></colgroup><thead><tr><th scope="col">№</th><th scope="col">Игрок</th><th scope="col">Мячи</th><th scope="col">Время</th></tr></thead><tbody><tr><td colspan="4">Рейтинг загружается…</td></tr></tbody></table><p class="ph-ranking-rule">Больше мячей — выше место.<br>При равенстве — меньшее время.</p></aside>
        <section class="ph-empty-state" aria-label="Ожидание игроков"><div><h2>Кто следующий?</h2><p>Открой Jump на телефоне<br>и начни игру в сообществе.</p></div></section>
      </main>
      <footer class="ph-screen-footer"><span data-connection>Подключаемся…</span><span>ПадлхАБ Jump</span></footer>
      <p class="ph-sr-only" role="status" aria-live="polite" data-announcement></p>
    </section>`;
  const shell = template.content.firstElementChild;
  root.append(shell);
  const q = s => shell.querySelector(s);
  const fields = q('.ph-courts'), picker = q('.ph-player-picker');
  const cards = new Map(), canvasCards = new WeakMap();
  let order = [], visible = [], selectedIndex = 0, capacity = 1, view = 'games';
  let destroyed = false, raf = null, lastTick = -Infinity;
  const media = win.matchMedia('(prefers-reduced-motion: reduce)');
  const removers = [];
  const listen = (target, event, handler) => { target.addEventListener(event, handler); removers.push(() => target.removeEventListener(event, handler)); };
  const announce = text => { q('[data-announcement]').textContent = text; };
  const report = (error, runId) => { try { onError(error, runId); } catch { /* An error reporter must not stop other fields. */ } };

  if (logoUrl) {
    const logo = q('.ph-brand-image');
    logo.src = String(logoUrl); logo.hidden = false;
    listen(logo, 'error', () => { logo.hidden = true; report(new Error('Brand logo failed to load')); });
  }
  const join = q('[data-action="join"]');
  if (typeof onJoin === 'function') { join.hidden = false; listen(join, 'click', () => onJoin()); }
  const fullscreen = q('[data-action="fullscreen"]');
  fullscreen.hidden = !(doc.fullscreenEnabled && root.requestFullscreen);
  listen(fullscreen, 'click', async () => {
    try {
      if (doc.fullscreenElement === root) await doc.exitFullscreen();
      else await root.requestFullscreen();
    } catch (error) { announce('Полноэкранный режим недоступен в этом браузере.'); report(error); }
  });
  listen(doc, 'fullscreenchange', () => { fullscreen.textContent = doc.fullscreenElement === root ? 'Свернуть экран' : 'На весь экран'; measureRoot(); });
  for (const button of shell.querySelectorAll('[data-view]')) listen(button, 'click', () => {
    view = button.dataset.view;
    for (const peer of shell.querySelectorAll('[data-view]')) peer.setAttribute('aria-pressed', String(peer === button));
    arrange('view');
  });

  function makeCard(player) {
    const element = doc.createElement('article'); element.className = 'ph-player';
    element.innerHTML = `<header class="ph-player-heading"><span class="ph-avatar" aria-hidden="true"></span><div class="ph-person"><h2></h2><p></p></div></header><div class="ph-scoreline"><div><span class="ph-label">Мячи</span><div class="ph-score"><span class="ph-ball" aria-hidden="true"></span><strong data-score>—</strong></div></div><div class="ph-time"><span class="ph-label">Время</span><strong data-time>—</strong></div></div><div class="ph-court"><canvas role="img"></canvas><span class="ph-court-station"></span><div class="ph-court-message">Подключаемся к игре…</div></div><footer class="ph-player-footer"><span class="ph-label">Жизни</span><div class="ph-lives" aria-hidden="true"></div><span class="ph-life-count">—</span></footer>`;
    const canvas = element.querySelector('canvas');
    canvas.width = 1; canvas.height = 1;
    element.hidden = true;
    const c = { element, canvas, renderer: null, player, width: 0, height: 0, dpr: 0, dirty: true, error: false, hudKey: '', drawKey: '', discreteKey: '', motionDrawn: false };
    canvasCards.set(canvas, c); fields.append(element); observer.observe(canvas);
    setPlayerText(c); return c;
  }
  function setPlayerText(c) {
    c.element.querySelector('h2').textContent = c.player.name;
    c.element.querySelector('h2').title = c.player.name;
    c.element.querySelector('.ph-person p').textContent = c.player.stationLabel || '';
    c.element.querySelector('.ph-court-station').textContent = c.player.stationLabel || '';
    c.element.querySelector('.ph-avatar').textContent = c.player.name.trim().split(/\s+/).slice(0, 2).map(s => Array.from(s)[0] || '').join('').toLocaleUpperCase('ru');
    c.canvas.setAttribute('aria-label', `Прохождение: ${c.player.name}`);
    c.hudKey = '';
  }
  function resizeCard(c, width, height) {
    const dpr = Math.min(win.devicePixelRatio || 1, maxCanvasDpr);
    if (width <= 0 || height <= 0 || (width === c.width && height === c.height && dpr === c.dpr)) return;
    c.width = width; c.height = height; c.dpr = dpr; c.dirty = true;
    c.canvas.width = Math.max(1, Math.round(width * dpr)); c.canvas.height = Math.max(1, Math.round(height * dpr));
    if (c.renderer) try { c.renderer.resize({ width, height, dpr }); } catch (error) { failCard(c, error); }
  }
  function ensureRenderer(c) {
    if (c.renderer || c.error) return;
    let renderer;
    try {
      renderer = createRenderer(c.canvas, c.player);
      if (!renderer || typeof renderer.draw !== 'function' || typeof renderer.resize !== 'function' || typeof renderer.dispose !== 'function') throw new TypeError('Renderer must implement draw, resize, and dispose');
      c.renderer = renderer; c.dirty = true;
      if (c.width > 0 && c.height > 0) renderer.resize({ width: c.width, height: c.height, dpr: c.dpr });
    } catch (error) {
      try { renderer?.dispose?.(); } catch { /* Report the original initialization error. */ }
      c.renderer = null; failCard(c, error);
    }
  }
  function releaseRenderer(c) {
    if (c.renderer) try { c.renderer.dispose(); } catch (error) { report(error, c.player.runId); }
    c.renderer = null; c.canvas.width = 1; c.canvas.height = 1;
    c.width = 0; c.height = 0; c.dpr = 0; c.dirty = true; c.error = false;
    c.drawKey = ''; c.discreteKey = ''; c.motionDrawn = false;
  }
  function measureRoot() {
    if (destroyed) return;
    const width = root.getBoundingClientRect().width;
    const next = Math.min(maxVisiblePlayers, width < 560 ? 1 : width < 1200 ? 2 : 4);
    if (next !== capacity) { capacity = next; arrange('resize'); }
  }
  const observer = new win.ResizeObserver(entries => {
    for (const entry of entries) {
      if (entry.target === root) measureRoot();
      else { const c = canvasCards.get(entry.target); if (c) resizeCard(c, entry.contentRect.width, entry.contentRect.height); }
    }
  });
  observer.observe(root);
  listen(win, 'resize', () => {
    measureRoot();
    for (const id of visible) { const c = cards.get(id), r = c.canvas.getBoundingClientRect(); resizeCard(c, r.width, r.height); }
  });

  function arrange(reason) {
    selectedIndex = Math.max(0, Math.min(selectedIndex, Math.max(0, order.length - 1)));
    const start = Math.floor(selectedIndex / capacity) * capacity;
    const next = view === 'games' ? order.slice(start, start + capacity) : [];
    const changed = next.join('\u0000') !== visible.join('\u0000'); visible = next;
    for (const [id, c] of cards) {
      const hidden = !visible.includes(id);
      if (hidden && c.renderer) releaseRenderer(c);
      c.element.hidden = hidden;
    }
    fields.style.gridTemplateColumns = `repeat(${Math.max(1, visible.length)}, minmax(0, 1fr))`;
    fields.dataset.visibleCount = String(visible.length);
    q('.ph-live-area').hidden = !order.length || view !== 'games';
    q('.ph-empty-state').hidden = order.length > 0 && view === 'games';
    q('.ph-content').dataset.layout = view === 'rating' ? 'rating' : order.length ? 'games' : 'empty';
    q('h1').textContent = view === 'rating' ? 'Рейтинг сообщества' : order.length ? 'Сейчас играют' : 'Пока никто не играет';
    q('.ph-player-count').textContent = String(order.length); q('.ph-player-count').hidden = !order.length || view === 'rating';
    q('.ph-standings-title').hidden = view === 'rating';
    for (const id of visible) {
      const c = cards.get(id); ensureRenderer(c);
      const rect = c.canvas.getBoundingClientRect(); resizeCard(c, rect.width, rect.height);
      c.dirty = true;
    }
    picker.replaceChildren(); picker.hidden = order.length <= capacity;
    if (!picker.hidden) order.forEach((id, index) => {
      const button = doc.createElement('button'); button.type = 'button'; button.textContent = cards.get(id).player.name;
      button.setAttribute('aria-pressed', String(visible.includes(id)));
      button.addEventListener('click', () => { selectedIndex = index; arrange('selection'); }); picker.append(button);
    });
    if (changed && typeof onVisibleRunsChange === 'function') {
      try { onVisibleRunsChange([...visible], { reason }); } catch (error) { report(error); }
    }
  }
  function failCard(c, error) {
    c.error = true; const message = c.element.querySelector('.ph-court-message');
    message.textContent = 'Не удалось отобразить игру'; message.hidden = false; report(error, c.player.runId);
  }
  function updateHud(c, frame) {
    const s = frame.confirmed;
    const key = [s?.score, s?.lives, s?.elapsedMs, s?.status, s?.phase, s?.station, s?.section, frame.state, c.player.initialLives].join('|');
    if (key === c.hudKey) return; c.hudKey = key;
    if (s) {
      if (STATIONS[s.station]) {
        const label = `${STATIONS[s.station].name} · Уровень ${s.section + 1}/3`;
        c.element.querySelector('.ph-person p').textContent = label;
      }
      c.element.querySelector('[data-score]').textContent = String(s.score);
      c.element.querySelector('[data-time]').textContent = formatElapsed(s.elapsedMs, s.status === 'finished');
      const total = c.player.initialLives;
      c.element.querySelector('.ph-life-count').textContent = Number.isSafeInteger(total) ? `${s.lives} / ${total}` : String(s.lives);
      c.element.querySelector('.ph-player-footer').setAttribute('aria-label', `Жизни: ${s.lives}${Number.isSafeInteger(total) ? ` из ${total}` : ''}`);
      const lives = c.element.querySelector('.ph-lives'); lives.replaceChildren();
      // Large game-specific life counts remain numeric, avoiding unbounded DOM.
      if (Number.isSafeInteger(total) && total <= 12 && s.lives <= total) for (let i = 0; i < total; i++) {
        const ball = doc.createElement('span'); ball.className = `ph-ball${i >= s.lives ? ' ph-spent' : ''}`; lives.append(ball);
      }
    }
    const message = c.element.querySelector('.ph-court-message');
    const phases = { paused: 'Пауза', retry: 'Ждём новую попытку', checkpoint: 'Уровень пройден', eliminated: 'Сохраняем результат' };
    const text = frame.state === 'finished' ? 'Игра завершена' : frame.state === 'stale' ? 'Ждём связь с игроком' : !s ? 'Подключаемся к игре…' : phases[s.phase] ?? '';
    message.textContent = text; message.hidden = !text;
  }
  function tick(now) {
    raf = null; if (destroyed || doc.hidden) return;
    const interval = media.matches ? 1000 : 1000 / targetFps;
    if (now - lastTick >= interval - 0.5) {
      lastTick = now;
      for (const id of visible) {
        const c = cards.get(id); if (!c || c.error || !c.renderer) continue;
        try {
          const frame = c.player.getFrame(now); if (!frame) continue;
          updateHud(c, frame);
          if (!frame.pose || !c.width || !c.height) continue;
          const key = [frame.pose.x, frame.pose.y, frame.confirmed?.seq, frame.state].join('|');
          const discreteKey = [frame.confirmed?.segmentId, frame.confirmed?.status, frame.state === 'finished'].join('|');
          const shouldDraw = c.dirty || !c.motionDrawn || (media.matches ? discreteKey !== c.discreteKey : frame.state === 'playing' || key !== c.drawKey);
          if (shouldDraw) { c.renderer.draw(frame, { now, width: c.width, height: c.height }); c.drawKey = key; c.discreteKey = discreteKey; c.dirty = false; c.motionDrawn = true; }
        } catch (error) { failCard(c, error); }
      }
    }
    raf = win.requestAnimationFrame(tick);
  }
  listen(doc, 'visibilitychange', () => {
    if (raf !== null) win.cancelAnimationFrame(raf); raf = null; lastTick = -Infinity;
    if (!doc.hidden && !destroyed) {
      for (const id of visible) cards.get(id).dirty = true;
      if (typeof onVisibleRunsChange === 'function') try { onVisibleRunsChange([...visible], { reason: 'resume' }); } catch (error) { report(error); }
      raf = win.requestAnimationFrame(tick);
    }
  });
  listen(media, 'change', () => { lastTick = -Infinity; for (const c of cards.values()) c.dirty = true; });
  measureRoot(); if (!doc.hidden) raf = win.requestAnimationFrame(tick);

  return Object.freeze({
    updatePlayers(players) {
      if (destroyed) throw new Error('Spectator view is destroyed');
      if (!Array.isArray(players)) throw new TypeError('players must be an array');
      const next = new Map();
      for (const p of players) {
        if (!p || typeof p.runId !== 'string' || !p.runId || typeof p.name !== 'string' || !p.name || typeof p.getFrame !== 'function') throw new TypeError('Each player needs runId, name and getFrame');
        if (next.has(p.runId)) throw new TypeError('Duplicate runId');
        if (p.initialLives !== undefined && (!Number.isSafeInteger(p.initialLives) || p.initialLives < 0)) throw new TypeError('initialLives must be a nonnegative integer');
        next.set(p.runId, { ...p });
      }
      for (const [id, c] of cards) if (!next.has(id)) { observer.unobserve(c.canvas); releaseRenderer(c); c.element.remove(); cards.delete(id); }
      // Preserve existing visual order; append new attempts rather than sorting by points.
      order = order.filter(id => next.has(id));
      for (const [id, player] of next) {
        if (cards.has(id)) { const c = cards.get(id); c.player = player; c.error = false; setPlayerText(c); }
        else { const c = makeCard(player); cards.set(id, c); order.push(id); }
      }
      arrange('players');
    },
    setLeaderboard(rows) {
      if (destroyed) throw new Error('Spectator view is destroyed');
      if (!Array.isArray(rows)) throw new TypeError('rows must be an array');
      for (const row of rows) if (!row || typeof row.name !== 'string' || !Number.isSafeInteger(row.score) || row.score < 0 || !Number.isFinite(row.elapsedMs) || row.elapsedMs < 0) throw new TypeError('Invalid leaderboard row');
      const body = q('tbody'); body.replaceChildren();
      // Keep the server's order: do not invent a client-side tie-break.
      rows.forEach((row, index) => {
        const tr = doc.createElement('tr'); if (!index) tr.className = 'ph-first-place';
        for (const [i, value] of [index + 1, row.name, row.score, formatElapsed(row.elapsedMs, true)].entries()) {
          const cell = doc.createElement(i === 1 ? 'th' : 'td'); if (i === 1) cell.scope = 'row'; cell.textContent = String(value); tr.append(cell);
        }
        body.append(tr);
      });
      if (!rows.length) { const tr = doc.createElement('tr'), td = doc.createElement('td'); td.colSpan = 4; td.textContent = 'Пока нет результатов'; tr.append(td); body.append(tr); }
    },
    setConnection(status) {
      if (destroyed) throw new Error('Spectator view is destroyed');
      const labels = { connecting: 'Подключаемся…', connected: 'Табло подключено', offline: 'Связь прервана. Показываем последние данные.' };
      if (!Object.hasOwn(labels, status)) throw new TypeError('Unsupported connection status');
      q('[data-connection]').textContent = labels[status];
    },
    destroy() {
      if (destroyed) return; destroyed = true;
      if (raf !== null) win.cancelAnimationFrame(raf); observer.disconnect(); removers.forEach(remove => remove());
      if (doc.fullscreenElement === root) doc.exitFullscreen().catch(error => report(error));
      for (const c of cards.values()) releaseRenderer(c);
      cards.clear(); shell.remove(); if (ownedClass) root.classList.remove('ph-jump-spectator');
    },
  });
}

function formatElapsed(ms, tenths) {
  const whole = Math.max(0, Math.floor(ms));
  const seconds = Math.floor(whole / 1000);
  const base = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  return tenths ? `${base}.${Math.floor(whole % 1000 / 100)}` : base;
}
