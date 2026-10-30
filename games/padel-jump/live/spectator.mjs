import { createHash, randomUUID } from 'node:crypto';
import { LIVE_ENGINE_VERSION, LIVE_RULE, LIVE_LIVES } from '../../../src/components/padel-jump/live-contract.ts';
import { LatestPosePublisher, STREAM_PROFILES } from '../../../src/components/padel-jump/spectator/spectator-network.mjs';
import { sceneDelta } from '../../../src/components/padel-jump/spectator/state.mjs';

/** Read-only projection of accepted commands; never executes physics or persists results. */
export function createSpectatorChannel({ now }) {
  const epoch = randomUUID();
  const entries = new Map();
  function prune() {
    for (const [id, entry] of entries) if (entry.retiredAt !== undefined && now() - entry.retiredAt > 30000) entries.delete(id);
    const retired = [...entries].filter(([, entry]) => entry.retiredAt !== undefined);
    for (const [id] of retired.slice(0, Math.max(0, retired.length - 24))) entries.delete(id);
  }
  function remove(id) {
    const entry = entries.get(id);
    if (entry?.pose?.status === 'finished') entry.retiredAt ??= now();
    else entries.delete(id);
    prune();
  }
  function capture(player, seq) {
    prune();
    let entry = entries.get(player.id);
    if (entry?.fault) {
      entry = { generation: entry.generation, eventSeq: entry.eventSeq, events: [], publishers: new Map(), cached: new Map() };
      entries.set(player.id, entry);
    }
    if (entry?.pose && seq <= entry.pose.seq) return;
    const previous = entry?.player;
    const discontinuity = !previous || previous.failures !== player.failures || previous.state !== player.state
      || previous.game.campaign.station !== player.game.campaign.station || previous.game.campaign.section !== player.game.campaign.section;
    if (!entry) {
      entry = { generation: 0, events: [], publishers: new Map(), cached: new Map(), eventSeq: 0 };
      entries.set(player.id, entry);
    }
    if (discontinuity) { entry.generation++; entry.scene = structuredClone(player.game); }
    const segmentId = `${player.id}:${entry.generation}`;
    const pose = { runId: player.id, seq, t: now(), x: player.game.ball.x, y: player.game.ball.y,
      score: player.stars, lives: player.livesRemaining, elapsedMs: player.elapsedMs, segmentId,
      status: player.state === 'finished' ? 'finished' : 'running', phase: player.state,
      station: player.game.campaign.station, section: player.game.campaign.section,
      changes: sceneDelta(entry.scene, player.game) ?? {} };
    entry.player = player; entry.pose = pose;
    if (discontinuity && previous) {
      const event = { eventId: `${player.id}:${++entry.eventSeq}`, eventSeq: entry.eventSeq, snapshot: pose, scene: entry.scene };
      entry.events.push(event);
      // Max 33 levels + five failures/retries, plus bounded pause/resume churn.
      // Overflow is explicit; never silently acknowledge a missing transition.
      if (entry.events.length > 128) entry.events.shift();
    }
    for (const profile of Object.keys(STREAM_PROFILES)) {
      if (!entry.publishers.has(profile)) entry.publishers.set(profile, new LatestPosePublisher({
        runId: player.id, profile, maxPayloadBytes: 16384,
        // This synchronous destination is a single cached payload, not a socket queue.
        // HTTP has its own single-response/backpressure gate in server.mjs.
        canSend: bytes => bytes <= 16384,
        send: wire => { entry.cached.set(profile, JSON.parse(wire)); return true; },
      }));
      const publisher = entry.publishers.get(profile);
      const offered = publisher.offer(discontinuity ? { ...pose, critical: true } : pose);
      if (offered.requiresReliableDelivery) {
        publisher.close(); entry.publishers.delete(profile); entry.cached.set(profile, pose);
      } else if (!offered.accepted) entry.error = 'SPECTATOR_POSE_' + offered.reason;
    }
  }
  function read({ runs = [], catalog, scenes = {}, acks = {}, profile = 'constrained', fresh = false } = {}, board) {
    if (!Object.hasOwn(STREAM_PROFILES, profile) || !Array.isArray(runs) || runs.length > 4
      || new Set(runs).size !== runs.length || runs.some(id => typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id))
      || !scenes || typeof scenes !== 'object' || !acks || typeof acks !== 'object'
      || Object.values(acks).some(v => !Number.isSafeInteger(v) || v < 0)) throw Object.assign(new Error('SPECTATOR_QUERY_INVALID'), { code: 422 });
    prune();
    const players = board.players.map(p => ({ runId: p.id, name: p.alias, slot: p.slot, state: p.state, initialLives: LIVE_LIVES }));
    const nextCatalog = { players, results: board.results };
    const catalogVersion = createHash('sha256').update(JSON.stringify(nextCatalog)).digest('hex').slice(0, 16);
    const reply = { schema: 'jump-spectator-v1', epoch, engine: LIVE_ENGINE_VERSION, rule: LIVE_RULE, sourceNow: now(),
      catalogVersion, ...(catalogVersion !== catalog ? { catalog: nextCatalog } : {}), poses: [], scenes: {}, events: [], gaps: [], baselines: {} };
    for (const id of runs) {
      const entry = entries.get(id); if (!entry) continue;
      if (entry.fault) { reply.gaps.push(id); continue; }
      if (entry.error) throw Object.assign(new Error('SPECTATOR_UNAVAILABLE'), { code: 503 });
      const publisher = entry.publishers.get(profile);
      publisher?.flush(now());
      const pose = fresh ? entry.pose : entry.cached.get(profile) ?? entry.pose;
      reply.poses.push(pose);
      if (scenes[id] !== pose.segmentId) reply.scenes[id] = { segmentId: pose.segmentId, game: entry.scene };
      const ack = acks[id] ?? 0;
      if (ack > entry.eventSeq || ack < entry.eventSeq && !entry.events.length || entry.events.length && ack < entry.events[0].eventSeq - 1) reply.gaps.push(id);
      // Explicit full-state reconciliation after background/reconnect. The client
      // acknowledges this exact baseline only after accepting the full snapshot.
      if (fresh) reply.baselines[id] = entry.eventSeq;
      else reply.events.push(...entry.events.filter(event => event.eventSeq > ack));
    }
    return reply;
  }
  return { capture, read, remove,
    invalidate(id) {
      const entry = entries.get(id);
      entries.set(id, { fault: true, generation: entry?.generation ?? 0, eventSeq: (entry?.eventSeq ?? 0) + 1, events: [] });
    },
    stats: () => { prune(); return { runs: entries.size, events: [...entries.values()].reduce((n, entry) => n + entry.events.length, 0) }; } };
}
