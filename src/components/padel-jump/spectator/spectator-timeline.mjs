/**
 * Buffered spectator timeline. Reference adapter, not a game engine or transport.
 *
 * All times are milliseconds. `snapshot.t` belongs to one authoritative run
 * timeline; `receivedAtMs` and sample(now) use the same local monotonic clock
 * (normally performance.now()). Never pass Date.now() into this adapter.
 *
 * Supply sourceTimeAt(localNow) explicitly. It maps the local clock to the run
 * clock, using an existing synchronized clock or an anchor established during
 * the connection handshake. Do not recompute that offset on every packet:
 * doing so turns network jitter into animation jitter. This module does not
 * claim to estimate one-way latency or synchronize clocks itself.
 *
 * A segmentId must change at every respawn, level change, teleport, or camera
 * reset. Coordinates in a segment must share one coordinate space. x/y may be
 * normalized or world coordinates; clipping and world geometry are the host's
 * responsibility. Set maxExtrapolationMs: 0 if linear continuation is unsafe.
 *
 * score, lives, elapsedMs and status are confirmed snapshot values, never
 * predicted. Scores/lives are nonnegative integers; there is no fixed life cap.
 * A separate reliable ordered event stream is needed for effects that must not
 * be missed between snapshots. No gameplay decisions or results are computed.
 */
export class SpectatorTimeline {
  constructor({
    runId,
    sourceTimeAt,
    delayMs = 400,
    maxExtrapolationMs = 150,
    staleAfterMs = 2500,
    maxSnapshots = 64,
  } = {}) {
    for (const [name, value] of Object.entries({ delayMs, maxExtrapolationMs, staleAfterMs })) {
      if (!Number.isFinite(value) || value < 0) throw new TypeError(`${name} must be finite and nonnegative`);
    }
    if (!Number.isInteger(maxSnapshots) || maxSnapshots < 2) {
      throw new TypeError('maxSnapshots must be an integer of at least 2');
    }
    this.config = Object.freeze({ delayMs, maxExtrapolationMs, staleAfterMs, maxSnapshots });
    this.reset({ runId, sourceTimeAt });
  }

  /**
   * Explicit reset is required for a NEW run. Reconnecting the same run must
   * preserve sequence/terminal state; use reanchorClock() if its clock changed.
   */
  reset({ runId, sourceTimeAt } = {}) {
    if (typeof runId !== 'string' || !runId) throw new TypeError('runId must be a nonempty string');
    if (typeof sourceTimeAt !== 'function') throw new TypeError('sourceTimeAt(localNow) is required');
    if (this.runId === runId) throw new TypeError('same-run reconnect must preserve state; use reanchorClock');
    this.runId = runId;
    this.sourceTimeAt = sourceTimeAt;
    this._samples = [];
    this._lastSeq = -1;
    this._lastSourceTime = -Infinity;
    this._lastReceivedAt = null;
    this._lastLocalSample = -Infinity;
    this._playbackTime = -Infinity;
    this._terminalAccepted = false;
    this._lastFrame = null;
  }

  /** Same-run reconnect, in the same performance.now() epoch. Keeps all facts. */
  reanchorClock(sourceTimeAt) {
    if (typeof sourceTimeAt !== 'function') throw new TypeError('sourceTimeAt(localNow) is required');
    this.sourceTimeAt = sourceTimeAt;
  }

  /**
   * Apply a buffer recommendation without resetting seq, facts or playback.
   * Growing the delay can temporarily hold playback while the buffer refills.
   * Reduce it gradually in the calling policy (not an abrupt catch-up jump).
   */
  setDelayMs(delayMs) {
    finite(delayMs, 'delayMs');
    if (delayMs < 0) throw new TypeError('delayMs must be nonnegative');
    this.config = Object.freeze({ ...this.config, delayMs });
  }

  get bufferedCount() { return this._samples.length; }

  /** Fresh full-state recovery: snap once, never replay a background backlog.
   * Keep the same instance, sequence floor and terminal lock. */
  skipToLatest() {
    const latest = this._samples.at(-1);
    if (!latest) return;
    this._samples = [latest];
    this._playbackTime = Math.max(this._playbackTime, latest.t);
  }

  /**
   * Accepts only increasing sequence numbers and nondecreasing source times.
   * Late/out-of-order packets are safely discarded, not inserted into the past.
   * Received time records transport freshness; it never changes clock mapping.
   */
  push(snapshot, receivedAtMs) {
    validateSnapshot(snapshot);
    finite(receivedAtMs, 'receivedAtMs');
    if (snapshot.runId !== this.runId) return rejected('wrong-run');
    if (snapshot.seq <= this._lastSeq) return rejected('old-sequence');
    if (this._terminalAccepted) return rejected('terminal-run');
    if (snapshot.t < this._lastSourceTime) return rejected('regressing-source-time');
    if (this._lastReceivedAt !== null && receivedAtMs < this._lastReceivedAt) {
      return rejected('regressing-receive-time');
    }

    const copy = Object.freeze({
      runId: snapshot.runId, seq: snapshot.seq, t: snapshot.t,
      x: snapshot.x, y: snapshot.y, score: snapshot.score,
      lives: snapshot.lives, elapsedMs: snapshot.elapsedMs,
      segmentId: snapshot.segmentId, status: snapshot.status,
    });
    this._samples.push(copy);
    const overflow = this._samples.length - this.config.maxSnapshots;
    if (overflow > 0) this._samples.splice(0, overflow);
    this._lastSeq = copy.seq;
    this._lastSourceTime = copy.t;
    this._lastReceivedAt = receivedAtMs;
    this._terminalAccepted = copy.status === 'finished';
    return Object.freeze({ accepted: true });
  }

  /**
   * Call from the host's one requestAnimationFrame loop. This method does not
   * allocate timers, mutate the DOM, run physics, or invoke a framework render.
   * `transition` is emitted once when a displayed segment/status changes.
   */
  sample(localNowMs) {
    finite(localNowMs, 'localNowMs');
    const now = Math.max(localNowMs, this._lastLocalSample);
    const sourceNow = this.sourceTimeAt(now);
    finite(sourceNow, 'sourceTimeAt result');
    this._lastLocalSample = now;
    // A backward clock correction can pause playback, never rewind it.
    this._playbackTime = Math.max(this._playbackTime, sourceNow - this.config.delayMs);
    const playbackTimeMs = this._playbackTime;
    const stale = this._lastReceivedAt !== null && now - this._lastReceivedAt >= this.config.staleAfterMs;
    const common = { runId: this.runId, playbackTimeMs, stale, transition: null };

    if (!this._samples.length) {
      return this._remember({ ...common, state: 'empty', pose: null, confirmed: null });
    }

    let leftIndex = -1;
    for (let i = 0; i < this._samples.length && this._samples[i].t <= playbackTimeMs; i++) leftIndex = i;
    if (leftIndex < 0) {
      // Capacity overflow may have evicted the due snapshot. Preserve the last
      // displayed state instead of leaking a future score or moving backwards.
      return this._remember({
        ...common, state: stale ? 'stale' : 'buffering',
        pose: this._lastFrame?.pose ?? null,
        confirmed: this._lastFrame?.confirmed ?? null,
      });
    }

    const left = this._samples[leftIndex];
    const right = this._samples[leftIndex + 1];
    const before = this._samples[leftIndex - 1];
    const prior = this._lastFrame?.confirmed;
    let transition = null;
    if (!prior) transition = Object.freeze({ type: left.status === 'finished' ? 'finished' : 'start' });
    else if (left.status === 'finished' && prior.status !== 'finished') transition = Object.freeze({ type: 'finished' });
    else if (left.segmentId !== prior.segmentId) {
      transition = Object.freeze({ type: 'segment', from: prior.segmentId, to: left.segmentId });
    }

    let pose = { x: left.x, y: left.y, mode: 'snapshot' };
    let state = 'playing';
    if (left.status === 'finished') {
      state = 'finished';
    } else if (right) {
      if (sameContinuousSegment(left, right)) {
        const alpha = (playbackTimeMs - left.t) / (right.t - left.t);
        pose = { x: lerp(left.x, right.x, alpha), y: lerp(left.y, right.y, alpha), mode: 'interpolated' };
      } else {
        // No interpolation into a future death, respawn, level, or final state.
        pose.mode = 'held';
      }
    } else {
      const age = Math.max(0, playbackTimeMs - left.t);
      const extrapolateFor = Math.min(age, this.config.maxExtrapolationMs);
      if (before && sameContinuousSegment(before, left) && extrapolateFor > 0) {
        const scale = extrapolateFor / (left.t - before.t);
        pose = { x: left.x + (left.x - before.x) * scale, y: left.y + (left.y - before.y) * scale, mode: 'extrapolated' };
      }
      if (age > this.config.maxExtrapolationMs || (age > 0 && !before)) {
        state = 'holding';
        pose.mode = 'held';
      }
    }

    if (stale && state !== 'finished') state = 'stale';
    const frame = this._remember({
      ...common, stale: state === 'finished' ? false : stale,
      state, pose: Object.freeze(pose), confirmed: left, transition,
    });
    // Retain one preceding sample for velocity, plus every future sample.
    if (leftIndex > 1) this._samples.splice(0, leftIndex - 1);
    return frame;
  }

  _remember(frame) {
    this._lastFrame = Object.freeze(frame);
    return this._lastFrame;
  }
}

function sameContinuousSegment(a, b) {
  return a.segmentId === b.segmentId && a.status === 'running' && b.status === 'running' && b.t > a.t;
}
function lerp(a, b, amount) { return a + (b - a) * amount; }
function rejected(reason) { return Object.freeze({ accepted: false, reason }); }
function finite(value, name) {
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be finite`);
}
function validateSnapshot(s) {
  if (!s || typeof s !== 'object') throw new TypeError('snapshot is required');
  for (const key of ['runId', 'segmentId']) {
    if (typeof s[key] !== 'string' || !s[key]) throw new TypeError(`${key} must be a nonempty string`);
  }
  for (const key of ['seq', 'score', 'lives']) {
    if (!Number.isSafeInteger(s[key]) || s[key] < 0) throw new TypeError(`${key} must be a nonnegative safe integer`);
  }
  for (const key of ['t', 'x', 'y', 'elapsedMs']) finite(s[key], key);
  if (s.t < 0 || s.elapsedMs < 0) throw new TypeError('t and elapsedMs must be nonnegative');
  if (s.status !== 'running' && s.status !== 'finished') throw new TypeError('unsupported status');
}

/* Integration sketch:
 * const timeline = new SpectatorTimeline({
 *   runId: handshake.runId,
 *   sourceTimeAt: localNow => synchronizedRunClock.at(localNow),
 * });
 * onSnapshot(s => timeline.push(s, performance.now()));
 * // Inside the screen's shared rAF loop:
 * const frame = timeline.sample(performance.now());
 * renderer.drawPose(frame.pose, frame.transition);
 * // Commit the confirmed HUD only when its confirmed seq changes.
 * // If stale: hold the presentation, label it, and await authoritative data.
 */
