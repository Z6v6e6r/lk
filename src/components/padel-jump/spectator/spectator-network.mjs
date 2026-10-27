/**
 * Low-bandwidth spectator helpers; no transport, timers, video encoder or clock sync.
 * All local times use one monotonic clock (normally performance.now()).
 * A packet's t is on the authoritative run clock, not the receiver's local clock.
 */
export const STREAM_PROFILES = Object.freeze({
  normal: Object.freeze({ poseHz: 5, minDelayMs: 400 }),
  constrained: Object.freeze({ poseHz: 2, minDelayMs: 1200 }),
  fallback: Object.freeze({ poseHz: 1, minDelayMs: 2200 }),
});

/**
 * Estimates a conservative playout buffer from source cadence, arrival spacing,
 * and (optionally) sourceTimeAt(localNow)-snapshot.t. The latter is state age,
 * including sender batching and clock error, NOT precise one-way network latency.
 * Without a source clock mapper, the result is only an extra smoothing reserve.
 * Recommendations are advisory. The consumer must preserve monotonic playback.
 */
export class AdaptivePlayoutDelay {
  constructor({
    runId,
    sourceTimeAt = null,
    profile = 'normal',
    windowSize = 32,
    maxDelayMs = 4000,
    marginMs = 100,
    decreaseMsPerSecond = 80,
    resetAfterGapMs = 10000,
  } = {}) {
    if (!Number.isInteger(windowSize) || windowSize < 4 || windowSize > 512) {
      throw new TypeError('windowSize must be an integer from 4 to 512');
    }
    for (const [name, value] of Object.entries({ maxDelayMs, marginMs, decreaseMsPerSecond, resetAfterGapMs })) {
      finiteNonnegative(value, name);
    }
    if (resetAfterGapMs <= 0) throw new TypeError('resetAfterGapMs must be positive');
    this.options = Object.freeze({ windowSize, maxDelayMs, marginMs, decreaseMsPerSecond, resetAfterGapMs });
    if (sourceTimeAt !== null && typeof sourceTimeAt !== 'function') throw new TypeError('sourceTimeAt must be a function or null');
    this.sourceTimeAt = sourceTimeAt;
    this.profile = checkedProfile(profile);
    if (STREAM_PROFILES[this.profile].minDelayMs > maxDelayMs) throw new TypeError('maxDelayMs is below the profile floor');
    this.reset(runId);
  }

  /** New metrics epoch only. Never resets the application's seq/finish guards. */
  reset(runId) {
    nonempty(runId, 'runId');
    this.runId = runId;
    this._seq = -1;
    this._sourceTime = -Infinity;
    this._lastAcceptedAt = null;
    this._anchor = null;
    this._gaps = [];
    this._stateAges = [];
    this._delayMs = STREAM_PROFILES[this.profile].minDelayMs;
    this._lastRecommendationAt = null;
    this._resyncRequired = false;
  }

  setProfile(profile) {
    const name = checkedProfile(profile);
    if (STREAM_PROFILES[name].minDelayMs > this.options.maxDelayMs) throw new TypeError('maxDelayMs is below the profile floor');
    this.profile = name;
    // Larger buffers take effect immediately; lower floors still decay slowly.
    this._delayMs = Math.max(this._delayMs, STREAM_PROFILES[name].minDelayMs);
  }

  acknowledgeResync() { this._resyncRequired = false; }

  /** Keep policy ages in the same clock mapping as SpectatorTimeline. */
  reanchorClock(sourceTimeAt) {
    if (sourceTimeAt !== null && typeof sourceTimeAt !== 'function') throw new TypeError('sourceTimeAt must be a function or null');
    this.sourceTimeAt = sourceTimeAt;
    this._stateAges = [];
  }

  observe(snapshot, receivedAtMs) {
    validateTiming(snapshot);
    finiteNonnegative(receivedAtMs, 'receivedAtMs');
    if (snapshot.runId !== this.runId) return Object.freeze({ accepted: false, reason: 'wrong-run' });
    if (snapshot.seq <= this._seq) return Object.freeze({ accepted: false, reason: 'old-sequence' });
    if (snapshot.t < this._sourceTime) return Object.freeze({ accepted: false, reason: 'regressing-source-time' });
    if (this._lastAcceptedAt !== null && receivedAtMs < this._lastAcceptedAt) {
      return Object.freeze({ accepted: false, reason: 'regressing-receive-time' });
    }
    let stateAgeMs = null;
    if (this.sourceTimeAt) {
      const estimatedSourceNow = this.sourceTimeAt(receivedAtMs);
      if (!Number.isFinite(estimatedSourceNow)) throw new TypeError('sourceTimeAt result must be finite');
      stateAgeMs = Math.max(0, estimatedSourceNow - snapshot.t);
    }

    if (this._anchor && snapshot.t > this._anchor.t) {
      const cadenceMs = snapshot.t - this._anchor.t;
      const arrivalGapMs = receivedAtMs - this._anchor.receivedAtMs;
      if (cadenceMs > this.options.resetAfterGapMs || arrivalGapMs > this.options.resetAfterGapMs) {
        // A reconnect/pause gap must not poison the next 32 cadence measurements.
        this._gaps = [];
        this._stateAges = [];
        this._resyncRequired = true;
      } else {
        this._gaps.push(Object.freeze({ cadenceMs, arrivalGapMs, excessMs: Math.max(0, arrivalGapMs - cadenceMs) }));
        if (this._gaps.length > this.options.windowSize) this._gaps.shift();
      }
    }
    // Equal-t corrections/events do not create zero-cadence measurements.
    if (!this._anchor || snapshot.t > this._anchor.t) this._anchor = { t: snapshot.t, receivedAtMs };
    if (stateAgeMs !== null) {
      this._stateAges.push(stateAgeMs);
      if (this._stateAges.length > this.options.windowSize) this._stateAges.shift();
    }
    this._seq = snapshot.seq;
    this._sourceTime = snapshot.t;
    this._lastAcceptedAt = receivedAtMs;
    return Object.freeze({ accepted: true, ...this.recommendation(receivedAtMs) });
  }

  recommendation(localNowMs) {
    finiteNonnegative(localNowMs, 'localNowMs');
    const now = Math.max(localNowMs, this._lastRecommendationAt ?? localNowMs);
    const cadenceP90Ms = quantile90(this._gaps.map(x => x.cadenceMs));
    const jitterP90Ms = quantile90(this._gaps.map(x => x.excessMs));
    const arrivalP90Ms = quantile90(this._gaps.map(x => x.arrivalGapMs));
    const stateAgeP90Ms = quantile90([...this._stateAges]);
    const floor = STREAM_PROFILES[this.profile].minDelayMs;
    const extraBufferMs = Math.max(
      floor,
      cadenceP90Ms === null ? floor : 2 * cadenceP90Ms + (jitterP90Ms ?? 0) + this.options.marginMs,
    );
    const requiredDelayMs = extraBufferMs + (stateAgeP90Ms ?? 0);
    const targetDelayMs = Math.min(this.options.maxDelayMs, requiredDelayMs);
    const elapsedMs = this._lastRecommendationAt === null ? 0 : now - this._lastRecommendationAt;
    this._delayMs = targetDelayMs >= this._delayMs
      ? targetDelayMs
      : Math.max(targetDelayMs, this._delayMs - elapsedMs * this.options.decreaseMsPerSecond / 1000);
    this._lastRecommendationAt = now;
    const freshnessAgeMs = this._lastAcceptedAt === null ? null : Math.max(0, now - this._lastAcceptedAt);
    if (freshnessAgeMs !== null && freshnessAgeMs > this.options.resetAfterGapMs) this._resyncRequired = true;
    return Object.freeze({
      profile: this.profile,
      delayMs: Math.ceil(this._delayMs),
      targetDelayMs: Math.ceil(targetDelayMs),
      requiredDelayMs: Math.ceil(requiredDelayMs),
      budgetExceeded: requiredDelayMs > this.options.maxDelayMs,
      ageCompensated: this.sourceTimeAt !== null && stateAgeP90Ms !== null,
      stateAgeP90Ms,
      observations: this._gaps.length,
      cadenceP90Ms,
      jitterP90Ms,
      arrivalP90Ms,
      freshnessAgeMs,
      resyncRequired: this._resyncRequired,
      // State age includes batching, transit, clock error; no RTT/one-way claim.
    });
  }
}

/**
 * One-slot coalescing sender for disposable pose snapshots ONLY.
 * Call offer from the game, flush from the application's existing scheduler.
 * send(wireString) must synchronously return true only if accepted by transport;
 * transport acceptance is not application/server acknowledgement.
 * canSend(nextPayloadBytes) must check OPEN and a bounded outgoing queue before
 * WebSocket.send. Oversized poses are rejected so an accidental world dump is
 * visible as an integration error rather than an unbounded low-bandwidth packet.
 */
export class LatestPosePublisher {
  constructor({ runId, profile = 'normal', maxPayloadBytes = 1024, canSend, send } = {}) {
    this.profile = checkedProfile(profile);
    if (!Number.isSafeInteger(maxPayloadBytes) || maxPayloadBytes <= 0) throw new TypeError('maxPayloadBytes must be a positive integer');
    this.maxPayloadBytes = maxPayloadBytes;
    if (typeof canSend !== 'function' || typeof send !== 'function') throw new TypeError('canSend and send callbacks are required');
    this.canSend = canSend;
    this.send = send;
    this.reset(runId);
  }

  reset(runId) {
    nonempty(runId, 'runId');
    if (runId === this.runId) throw new TypeError('same-run reconnect must preserve the publisher sequence');
    this.runId = runId;
    this._pending = null;
    this._lastSeq = -1;
    this._lastSourceTime = -Infinity;
    this._lastSentAt = -Infinity;
    this._lastFlushAt = -Infinity;
    this._closed = false;
  }

  setProfile(profile) { this.profile = checkedProfile(profile); }
  get pendingCount() { return this._pending === null ? 0 : 1; }

  /** Close on finish; send the finish through the reliable event/result contract. */
  close() { this._closed = true; this._pending = null; }

  offer(snapshot) {
    validateTiming(snapshot);
    if (snapshot.runId !== this.runId) return Object.freeze({ accepted: false, reason: 'wrong-run' });
    if (requiresReliableDelivery(snapshot)) {
      // Never queue or silently coalesce terminal/critical events.
      return Object.freeze({ accepted: false, reason: 'requires-reliable-delivery', requiresReliableDelivery: true });
    }
    if (this._closed) return Object.freeze({ accepted: false, reason: 'closed' });
    if (snapshot.seq <= this._lastSeq) return Object.freeze({ accepted: false, reason: 'old-sequence' });
    if (snapshot.t < this._lastSourceTime) return Object.freeze({ accepted: false, reason: 'regressing-source-time' });
    // Serialize at offer: later mutation of the caller's object cannot change it.
    const wire = JSON.stringify(snapshot);
    if (typeof wire !== 'string') throw new TypeError('snapshot must be JSON serializable');
    const bytes = utf8PayloadBytes(wire);
    if (bytes > this.maxPayloadBytes) return Object.freeze({ accepted: false, reason: 'payload-too-large', bytes, maxPayloadBytes: this.maxPayloadBytes });
    const replaced = this._pending !== null;
    this._pending = Object.freeze({ wire, seq: snapshot.seq, bytes });
    this._lastSeq = snapshot.seq;
    this._lastSourceTime = snapshot.t;
    return Object.freeze({ accepted: true, replaced, bytes: this._pending.bytes });
  }

  flush(localNowMs) {
    finiteNonnegative(localNowMs, 'localNowMs');
    const now = Math.max(localNowMs, this._lastFlushAt);
    this._lastFlushAt = now;
    if (this._closed) return Object.freeze({ sent: false, reason: 'closed' });
    if (!this._pending) return Object.freeze({ sent: false, reason: 'empty' });
    const intervalMs = 1000 / STREAM_PROFILES[this.profile].poseHz;
    if (now - this._lastSentAt < intervalMs) return Object.freeze({ sent: false, reason: 'rate-limited' });
    const ready = this.canSend(this._pending.bytes);
    if (ready && typeof ready.then === 'function') throw new TypeError('canSend must be synchronous, not a Promise');
    if (ready !== true) return Object.freeze({ sent: false, reason: 'backpressure' });
    const pending = this._pending;
    let accepted;
    try { accepted = this.send(pending.wire); }
    catch (error) { return Object.freeze({ sent: false, reason: 'send-failed', error }); }
    if (accepted && typeof accepted.then === 'function') throw new TypeError('send must be synchronous, not a Promise');
    if (accepted !== true) return Object.freeze({ sent: false, reason: 'not-accepted' });
    // A callback may synchronously offer a newer pose; preserve that newer slot.
    if (this._pending === pending) this._pending = null;
    this._lastSentAt = now;
    return Object.freeze({ sent: true, seq: pending.seq, bytes: pending.bytes });
  }
}

export function utf8PayloadBytes(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (typeof text !== 'string') throw new TypeError('value must be JSON serializable');
  return new TextEncoder().encode(text).byteLength;
}

function requiresReliableDelivery(s) {
  return s.status === 'finished' || s.critical === true || s.delivery === 'reliable'
    || s.event != null || (Array.isArray(s.events) && s.events.length > 0)
    || (typeof s.type === 'string' && s.type !== 'pose' && s.type !== 'snapshot');
}
function checkedProfile(name) {
  if (!Object.hasOwn(STREAM_PROFILES, name)) throw new TypeError('unknown stream profile');
  return name;
}
function validateTiming(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) throw new TypeError('snapshot object required');
  nonempty(s.runId, 'runId');
  if (!Number.isSafeInteger(s.seq) || s.seq < 0) throw new TypeError('seq must be a nonnegative safe integer');
  finiteNonnegative(s.t, 't');
}
function finiteNonnegative(x, name) {
  if (!Number.isFinite(x) || x < 0) throw new TypeError(`${name} must be finite and nonnegative`);
}
function nonempty(x, name) {
  if (typeof x !== 'string' || !x) throw new TypeError(`${name} must be a nonempty string`);
}
function quantile90(values) {
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  return values[Math.max(0, Math.ceil(values.length * .9) - 1)];
}
