import { SpectatorTimeline } from './spectator-timeline.mjs';
import { AdaptivePlayoutDelay } from './spectator-network.mjs';
import { applySceneDelta } from './state.mjs';
import { LIVE_ENGINE_VERSION, LIVE_RULE } from '../live-contract.ts';

/** Compact server state -> delayed read-only scene. No physics, input or result writes. */
export function createSpectatorPlayback({ profile = 'constrained', onResync = () => {} } = {}) {
  const runs = new Map();
  let offset = null;
  const sourceTimeAt = now => now + (offset ?? 0);
  function ensure(runId) {
    if (!runs.has(runId)) runs.set(runId, {
      timeline: new SpectatorTimeline({ runId, sourceTimeAt, delayMs: 1200, maxExtrapolationMs: 0, maxSnapshots: 64 }),
      policy: new AdaptivePlayoutDelay({ runId, profile, sourceTimeAt }),
      scenes: new Map(), samples: new Map(), ack: 0, last: null, waiting: false,
    });
    return runs.get(runId);
  }
  function accept(snapshot, receivedAt) {
    const run = ensure(snapshot.runId);
    const scene = run.scenes.get(snapshot.segmentId);
    if (!scene) throw new Error('SPECTATOR_SCENE_MISSING');
    const game = applySceneDelta(scene, snapshot.changes);
    if (!game?.campaign || !Number.isFinite(game.camera) || !Number.isFinite(game.ball?.x) || !Number.isFinite(game.ball?.y)) throw new Error('SPECTATOR_SCENE_INVALID');
    const accepted = run.timeline.push(snapshot, receivedAt);
    if (accepted.accepted) {
      run.samples.set(snapshot.seq, { snapshot, game });
      while (run.samples.size > 64) run.samples.delete(run.samples.keys().next().value);
      const advice = run.policy.observe(snapshot, receivedAt);
      if (advice.accepted) run.timeline.setDelayMs(advice.delayMs);
    }
    return accepted.accepted || accepted.reason === 'old-sequence' || accepted.reason === 'terminal-run';
  }
  return {
    runs,
    sourceTimeAt,
    ingest(packet, { sentAt, receivedAt, reanchor = false } = {}) {
      if (packet.engine !== LIVE_ENGINE_VERSION || packet.rule !== LIVE_RULE) throw new Error('SPECTATOR_VERSION_INVALID');
      if (packet.schema !== 'jump-spectator-v1' || !Number.isFinite(packet.sourceNow) || !Number.isFinite(sentAt) || !Number.isFinite(receivedAt) || receivedAt < sentAt
        || !Array.isArray(packet.poses) || packet.poses.length > 4 || !Array.isArray(packet.events) || packet.events.length > 512) throw new Error('SPECTATOR_PACKET_INVALID');
      if (offset === null || reanchor) {
        // Explicit HTTP handshake: midpoint estimate on a monotonic server clock.
        // It assumes symmetric transit, not a measurement of one-way latency.
        offset = packet.sourceNow - (sentAt + receivedAt) / 2;
        for (const run of runs.values()) {
          run.timeline.reanchorClock(sourceTimeAt);
          // A full-state handshake starts a new cadence measurement epoch, not
          // a new attempt. Never reset the timeline's seq or terminal guard.
          run.policy.reset(run.timeline.runId); run.policy.reanchorClock(sourceTimeAt);
        }
      }
      for (const [id, scene] of Object.entries(packet.scenes)) ensure(id).scenes.set(scene.segmentId, scene.game);
      const blocked = new Set(packet.gaps.filter(id => !Number.isSafeInteger(packet.baselines?.[id])));
      for (const id of blocked) { ensure(id).waiting = true; onResync(id); }
      for (const event of packet.events) {
        const snapshot = event.snapshot, run = ensure(snapshot.runId);
        if (blocked.has(snapshot.runId)) continue;
        if (event.eventId !== `${snapshot.runId}:${event.eventSeq}` || !Number.isSafeInteger(event.eventSeq) || event.eventSeq < 1) throw new Error('SPECTATOR_EVENT_INVALID');
        if (event.eventSeq <= run.ack) continue;
        if (event.eventSeq !== run.ack + 1 && !packet.gaps.includes(snapshot.runId)) {
          run.waiting = true; blocked.add(snapshot.runId); onResync(snapshot.runId); continue;
        }
        run.scenes.set(snapshot.segmentId, event.scene);
        if (accept(snapshot, receivedAt)) run.ack = event.eventSeq;
      }
      for (const snapshot of packet.poses) {
        if (blocked.has(snapshot.runId)) continue;
        const run = ensure(snapshot.runId);
        if (accept(snapshot, receivedAt)) {
          run.waiting = false;
          const baseline = packet.baselines?.[snapshot.runId];
          if (Number.isSafeInteger(baseline) && baseline >= run.ack) run.ack = baseline;
          if (reanchor && run.last) run.timeline.skipToLatest();
          run.policy.acknowledgeResync();
        }
        while (run.scenes.size > 128) run.scenes.delete(run.scenes.keys().next().value);
      }
    },
    frame(runId, now) {
      const run = runs.get(runId); if (!run) return null;
      const advice = run.policy.recommendation(now);
      run.timeline.setDelayMs(advice.delayMs);
      if (advice.resyncRequired || advice.budgetExceeded) onResync(runId);
      if ((run.waiting || advice.budgetExceeded) && run.last) return { ...run.last, state: run.last.state === 'finished' ? 'finished' : 'stale' };
      const frame = run.timeline.sample(now);
      if (!frame.confirmed || !frame.pose) return frame;
      const left = run.samples.get(frame.confirmed.seq);
      if (!left) return run.last ? { ...run.last, state: 'stale' } : null;
      const right = [...run.samples.values()].find(s => s.snapshot.t > frame.playbackTimeMs);
      let game = left.game;
      if (right && right.snapshot.segmentId === left.snapshot.segmentId && right.snapshot.status === 'running'
        && frame.pose.mode === 'interpolated') {
        const alpha = (frame.playbackTimeMs - left.snapshot.t) / (right.snapshot.t - left.snapshot.t);
        game = interpolateScene(left.game, right.game, alpha);
      }
      game = { ...game, ball: { ...game.ball, x: frame.pose.x, y: frame.pose.y } };
      const result = { ...frame, game, confirmed: { ...frame.confirmed, phase: left.snapshot.phase, station: left.snapshot.station, section: left.snapshot.section } };
      run.last = result;
      return result;
    },
    requireFresh(ids) { for (const id of ids) { const run = runs.get(id); if (run) run.waiting = true; } },
    forgetExcept(ids) { for (const id of runs.keys()) if (!ids.includes(id)) runs.delete(id); },
    requestState(ids) {
      return { scenes: Object.fromEntries(ids.flatMap(id => { const run = runs.get(id); return run?.scenes.size ? [[id, [...run.scenes.keys()].at(-1)]] : []; })),
        acks: Object.fromEntries(ids.map(id => [id, runs.get(id)?.ack ?? 0])) };
    },
  };
}

function interpolateScene(left, right, alpha) {
  const lerp = (a, b) => a + (b - a) * alpha;
  const game = { ...left, camera: lerp(left.camera, right.camera), time: lerp(left.time, right.time) };
  game.platforms = left.platforms.map((p, index) => {
    const next = right.platforms[index];
    return next?.id === p.id ? { ...p, x: lerp(p.x, next.x) } : p;
  });
  const campaign = { ...left.campaign };
  for (const key of ['stars', 'drops', 'admins']) campaign[key] = left.campaign[key].map((item, index) => {
    const next = right.campaign[key][index];
    return next?.id === item.id && next.phase === item.phase ? { ...item, x: lerp(item.x, next.x), y: lerp(item.y, next.y) } : item;
  });
  game.campaign = campaign;
  return game;
}
