import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync, opendirSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync, unlinkSync, linkSync } from 'node:fs';
import { join } from 'node:path';
import { createCampaignGame, stepGame, drainEvents, FIXED_STEP } from '../../../src/components/padel-jump/engine.ts';
import { nextSection } from '../../../src/components/padel-jump/campaign.ts';
import { LIVE_ENGINE_VERSION, LIVE_RULE, LIVE_LIMIT, LIVE_SYNC, LIVE_LIVES } from '../../../src/components/padel-jump/live-contract.ts';

export const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
export const RESULT_STORAGE_POLICY = 'permanent-v1';
export const RANKING_V2_ACCEPT = 'application/vnd.padlhub.jump-community-ranking.v2+json';
const ttl = 10000, legacyWindow = 48 * 3600000;
function aliasOf(value) {
  if (typeof value !== 'string' || [...value].length < 1 || [...value].length > 48 || /[\p{C}<>]/u.test(value)) fail(422, 'ALIAS_INVALID');
  const alias = value.trim().replace(/\s+/g, ' '); if (!alias) fail(422, 'ALIAS_INVALID'); return alias;
}
function cleanGame(game) {
  const g = structuredClone(game), lo = g.camera - 130, hi = g.camera + 770;
  const visible = x => x.y >= lo && x.y <= hi;
  g.events = []; g.platforms = g.platforms.filter(visible);
  for (const key of ['stars', 'glass', 'metals', 'drops', 'admins', 'boosters']) g.campaign[key] = g.campaign[key].filter(visible);
  return g;
}

/** One isolated event; no LK accounts, community writes or client-supplied score/time. */
export function createRegistry({ now = () => performance.now(), wall = () => Date.now(), directory, communityId = null } = {}) {
  const runs = new Map(), best = new Map();
  const rank = (a, b) => b.stars - a.stars || a.elapsedMs - b.elapsedMs || a.finishedAt.localeCompare(b.finishedAt) || a.id.localeCompare(b.id);
  const remember = row => { const previous = best.get(row.actorId); if (!previous || rank(row, previous) < 0) best.set(row.actorId, row); };
  let legacyCache = null;
  function scanResults(visit, quarantine = false) {
    if (!directory) return;
    const entries = opendirSync(directory);
    try { for (let entry; (entry = entries.readSync());) {
      const name = entry.name;
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
      if (!entry.isFile()) fail(503, 'RESULT_STORE_INVALID');
      let row;
      try { row = JSON.parse(readFileSync(join(directory, name), 'utf8')); if (!row || typeof row !== 'object' || Array.isArray(row)) throw new SyntaxError('Receipt object required'); }
      catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        // Preserve a torn legacy receipt privately; one bad file must not stop
        // recovery of the other durable results. Never load temporary files.
        if (quarantine) {
          const path = join(directory, name), preserved = join(directory, '.corrupt-' + randomUUID());
          linkSync(path, preserved); unlinkSync(path);
          const fd = openSync(directory, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
        }
        continue;
      }
      if (row.engine === LIVE_ENGINE_VERSION && row.rule === LIVE_RULE && row.communityId === communityId && typeof row.actorId === 'string' && row.id + '.json' === name && Number.isSafeInteger(row.stars) && row.stars >= 0 && Number.isFinite(row.elapsedMs) && row.elapsedMs >= 0 && Number.isFinite(Date.parse(row.finishedAt))) visit(row);
    } } finally { entries.closeSync(); }
  }
  if (directory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    scanResults(remember, true);
  }
  const elapsed = run => run.finalMs ?? run.activeMs + (run.paused || run.finished ? 0 : Math.max(0, now() - run.segment));
  const sweep = () => { for (const [id, run] of runs) if (now() - run.seen > ((run.completed === 33 || run.failures >= LIVE_LIVES) && !run.finished ? 600000 : ttl)) runs.delete(id); };
  const publicResult = row => ({ id: row.id, alias: row.alias, elapsedMs: row.elapsedMs, playMs: row.playMs, failures: row.failures, stars: row.stars, finishedAt: row.finishedAt, engine: row.engine, rule: row.rule });
  const player = (run, full = false) => ({ id: run.id, alias: run.alias, slot: run.slot, state: run.finished ? 'finished' : run.failures >= LIVE_LIVES ? 'eliminated' : run.paused ? 'paused' : run.game.mode === 'over' ? 'retry' : run.game.mode === 'complete' ? 'checkpoint' : 'playing',
    elapsedMs: Math.round(elapsed(run)), playMs: Math.round(run.ticks * FIXED_STEP * 1000), failures: run.failures, livesRemaining: Math.max(0, LIVE_LIVES - run.failures), stars: run.claimed.size, completedParts: run.completed, game: full ? structuredClone(run.game) : cleanGame(run.game) });
  function persist(row) {
    if (!directory) return;
    const path = join(directory, row.id + '.json'), temporary = join(directory, '.pending-' + randomUUID());
    const bytes = JSON.stringify(row) + '\n';
    const syncDirectory = () => { const fd = openSync(directory, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } };
    let fd, failure;
    try {
      fd = openSync(temporary, 'wx', 0o600); writeFileSync(fd, bytes); fsyncSync(fd); closeSync(fd); fd = undefined;
      // Same-filesystem hard-link publication is atomic and cannot replace an
      // existing receipt. A crash leaves either a complete final file or only
      // an ignored private temporary file, never a half-written ranked result.
      try { linkSync(temporary, path); }
      catch (error) {
        if (error.code !== 'EEXIST' || readFileSync(path, 'utf8') !== bytes) throw error;
        const existing = openSync(path, 'r'); try { fsyncSync(existing); } finally { closeSync(existing); }
      }
      syncDirectory();
    } catch (error) { failure = error; }
    if (fd !== undefined) { try { closeSync(fd); } catch (error) { failure ??= error; } }
    try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') failure ??= error; }
    try { syncDirectory(); } catch (error) { failure ??= error; }
    if (failure) throw failure;
  }

  function publishResult(run) {
    if (!directory) fail(503, 'RESULT_STORE_UNAVAILABLE');
    const row = run.finishRow ?? { id: run.id, alias: run.alias, actorId: run.actorId, communityId: run.communityId, elapsedMs: Math.max(Math.round(elapsed(run)), Math.round(run.ticks * FIXED_STEP * 1000)), playMs: Math.round(run.ticks * FIXED_STEP * 1000), failures: run.failures, stars: run.claimed.size, finishedAt: new Date(wall()).toISOString(), engine: LIVE_ENGINE_VERSION, rule: LIVE_RULE };
    run.finishRow = row; persist(row); remember(row); legacyCache = null;
  }

  const bestResults = () => [...best.values()].sort(rank);
  // Compatibility view for already-open v1 pages only. The archive is never
  // pruned; scanning streams files and retains one recent best per profile.
  function legacyResults() {
    const at = wall();
    if (legacyCache && at >= legacyCache.at && at < legacyCache.until) {
      if (!legacyCache.rows) fail(503, 'RANKING_CLIENT_UPGRADE_REQUIRED');
      return legacyCache.rows;
    }
    const recent = new Map();
    scanResults(row => {
      if (at - Date.parse(row.finishedAt) >= legacyWindow) return;
      const previous = recent.get(row.actorId); if (!previous || rank(row, previous) < 0) recent.set(row.actorId, row);
    });
    let until = at + 30000;
    for (const row of recent.values()) until = Math.min(until, Date.parse(row.finishedAt) + legacyWindow);
    legacyCache = { at, until, rows: recent.size > 500 ? null : [...recent.values()].sort(rank) };
    if (!legacyCache.rows) fail(503, 'RANKING_CLIENT_UPGRADE_REQUIRED');
    return legacyCache.rows;
  }

  return {
    join(body, actor) {
      sweep();
      if (!body || Object.keys(body).some(k => !['consent', 'engine', 'rule'].includes(k)) || body.engine !== LIVE_ENGINE_VERSION || body.rule !== LIVE_RULE) fail(409, 'RULES_CHANGED');
      if (body.consent !== true) fail(422, 'DISPLAY_CONSENT_REQUIRED');
      if (!actor || actor.communityId !== communityId || typeof actor.id !== 'string' || !actor.id || typeof actor.communityId !== 'string' || !actor.communityId) fail(403, 'VERIFIED_PROFILE_REQUIRED');
      const alias = aliasOf(actor.name);
      // Recover this verified actor's terminal score before replacing its capability.
      for (const [id, run] of runs) if (run.actorId === actor.id && run.communityId === actor.communityId && (run.failures >= LIVE_LIVES || run.completed === 33)) {
        if (!run.finished) publishResult(run);
        runs.delete(id);
      }
      if (runs.size >= LIVE_LIMIT) fail(429, 'EVENT_FULL');
      if ([...runs.values()].some(r => r.actorId === actor.id && r.communityId === actor.communityId && !r.finished)) fail(409, 'PROFILE_ALREADY_RUNNING');
      const id = randomUUID(), token = randomBytes(32).toString('hex'), used = new Set([...runs.values()].map(r => r.slot));
      let slot = 0; while (used.has(slot)) slot++;
      const game = createCampaignGame(0, 0); game.mode = 'running';
      const run = { id, alias, actorId: actor.id, communityId: actor.communityId, slot, token: createHash('sha256').update(token).digest(), game, claimed: new Set(), seq: 0, ack: null, digest: '', ticks: 0, failures: 0, completed: 0, activeMs: 0, segment: now(), seen: now(), paused: false, finished: false };
      runs.set(id, run); return { id, token, seq: 0, engine: LIVE_ENGINE_VERSION, rule: LIVE_RULE, sync: LIVE_SYNC, player: player(run, true) };
    },
    command(id, token, body, actor) {
      sweep(); const run = runs.get(id);
      if (!run || typeof token !== 'string' || token.length !== 64 || !timingSafeEqual(run.token, createHash('sha256').update(token).digest())) fail(403, 'RUN_ACCESS_DENIED');
      if (now() - (run.rateAt ?? 0) > 60000) { run.rateAt = now(); run.rateCount = 0; }
      run.rateCount = (run.rateCount ?? 0) + 1; if (run.rateCount > 480) fail(429, 'COMMAND_RATE_LIMIT');
      if (!actor || actor.id !== run.actorId || actor.communityId !== run.communityId) fail(403, 'PROFILE_RUN_MISMATCH');
      if (!body || Object.keys(body).some(k => !['seq', 'command', 'inputs'].includes(k)) || !Number.isSafeInteger(body.seq) || body.seq < 1) fail(422, 'COMMAND_INVALID');
      const digest = createHash('sha256').update(JSON.stringify(body)).digest('hex');
      if (body.seq === run.seq) { if (digest !== run.digest) fail(409, 'SEQUENCE_CONFLICT'); run.seen = now(); return run.ack; }
      if (body.seq !== run.seq + 1) fail(409, 'SEQUENCE_CONFLICT');
      if (run.finished) fail(409, 'RUN_FINISHED');
      if (run.failures >= LIVE_LIVES && body.command !== 'finish' && (body.command !== 'inputs' || !Array.isArray(body.inputs) || body.inputs.length)) fail(409, 'RUN_ELIMINATED');
      let g = structuredClone(run.game); const claimed = new Set(run.claimed); let ticks = 0, failures = run.failures, completed = run.completed;
      const command = body.command;
      if (command === 'inputs') {
        if (!Array.isArray(body.inputs) || body.inputs.length > 120) fail(422, 'INPUTS_INVALID');
        for (const block of body.inputs) {
          if (!Array.isArray(block) || block.length !== 2 || !Number.isInteger(block[0]) || Math.abs(block[0]) > 100 || !Number.isInteger(block[1]) || block[1] < 1 || block[1] > 120) fail(422, 'INPUTS_INVALID');
          ticks += block[1];
        }
        if (ticks > 480 || (ticks && (run.paused || g.mode !== 'running'))) fail(409, 'INPUTS_NOT_RUNNING');
        if ((run.ticks + ticks) * FIXED_STEP * 1000 > elapsed(run) + 250) fail(409, 'REPLAY_TOO_FAST');
        for (const [direction, count] of body.inputs) for (let i = 0; i < count; i++) {
          if (g.mode !== 'running') fail(422, 'EXCESS_INPUTS');
          stepGame(g, direction / 100);
          for (const e of drainEvents(g)) { if (e.type === 'failure') failures++; if (e.type === 'finish') completed++; if (e.type === 'star') claimed.add(e.id); }
        }
      } else if (command === 'pause') {
        if (run.paused) fail(409, 'ALREADY_PAUSED');
      } else if (command === 'resume') {
        if (!run.paused) fail(409, 'NOT_PAUSED');
      } else if (command === 'retry') {
        if (g.mode !== 'over' || run.paused) fail(409, 'RETRY_NOT_READY');
        g = createCampaignGame(g.campaign.station, g.campaign.section, { claimed: [...claimed] }); g.mode = 'running';
      } else if (command === 'advance') {
        const next = nextSection(g.campaign.station, g.campaign.section);
        if (g.mode !== 'complete' || !next || run.paused) fail(409, 'CHECKPOINT_NOT_READY');
        g = createCampaignGame(next.station, next.section, { claimed: [...claimed] }); g.mode = 'running';
      } else if (command === 'finish') {
        if (!(failures >= LIVE_LIVES || g.mode === 'complete' && g.campaign.station === 10 && g.campaign.section === 2 && completed === 33) || run.paused) fail(409, 'FINISH_NOT_VERIFIED');
        publishResult(run);
      } else fail(422, 'COMMAND_INVALID');
      // Commit only after complete validation and durable result publication.
      if (completed === 33 && run.completed !== 33 || failures >= LIVE_LIVES && run.failures < LIVE_LIVES) run.finalMs = Math.max(Math.round(elapsed(run)), Math.round((run.ticks + ticks) * FIXED_STEP * 1000));
      run.game = g; run.claimed = claimed; run.ticks += ticks; run.failures = failures; run.completed = completed;
      if (command === 'pause' || command === 'finish') { run.activeMs = elapsed(run); run.paused = command === 'pause'; run.finished = command === 'finish'; }
      if (command === 'resume') { run.paused = false; run.segment = now(); }
      run.seen = now(); run.seq = body.seq; run.digest = digest;
      const ack = { seq: run.seq, sync: LIVE_SYNC, player: player(run, true), ...(command === 'finish' ? { result: publicResult(run.finishRow) } : {}) }; run.ack = ack; return ack;
    },
    board() { sweep(); return { engine: LIVE_ENGINE_VERSION, rule: LIVE_RULE, now: wall(), players: [...runs.values()].filter(r => now() - r.seen <= ttl).sort((a, b) => a.slot - b.slot).map(run => player(run)),
      results: bestResults().slice(0, 100).map(publicResult) }; },
    communityRanking(actor, { allTime = false } = {}) {
      if (!actor || actor.communityId !== communityId || typeof actor.id !== 'string' || !actor.id) fail(403, 'VERIFIED_PROFILE_REQUIRED');
      sweep(); const ranked = allTime ? bestResults() : legacyResults();
      const row = (value, index) => ({ id: value.id, rank: index + 1, name: value.alias, stars: value.stars, elapsedMs: value.elapsedMs, isCurrentUser: value.actorId === actor.id });
      const mine = ranked.findIndex(value => value.actorId === actor.id);
      return { schema: allTime ? 'jump-community-ranking-v2' : 'jump-community-ranking-v1', communityId, rule: LIVE_RULE, lives: LIVE_LIVES, retentionHours: allTime ? null : legacyWindow / 3600000, total: ranked.length,
        rows: ranked.slice(0, 100).map(row), me: mine >= 0 ? row(ranked[mine], mine) : null };
    },
  };
}
