import test from 'node:test';
import assert from 'node:assert/strict';
import { AdaptivePlayoutDelay, LatestPosePublisher, STREAM_PROFILES, utf8PayloadBytes } from '../../src/components/padel-jump/spectator/spectator-network.mjs';
import { SpectatorTimeline } from '../../src/components/padel-jump/spectator/spectator-timeline.mjs';

const timing = (seq, t, extra = {}) => ({ runId: 'run-a', seq, t, ...extra });
const state = (seq, t, extra = {}) => timing(seq, t, {
  x: t / 100, y: 10, score: seq, lives: 3, elapsedMs: t, segmentId: 'level-1', status: 'running', ...extra,
});

test('cadence estimator is independent of absolute receive-clock offset', () => {
  const a = new AdaptivePlayoutDelay({ runId: 'run-a' });
  const b = new AdaptivePlayoutDelay({ runId: 'run-a' });
  let ra, rb;
  for (let i = 0; i < 20; i++) {
    ra = a.observe(timing(i, i * 200), i * 200 + 500);
    rb = b.observe(timing(i, i * 200), i * 200 + 40500);
  }
  assert.equal(ra.delayMs, rb.delayMs);
  assert.equal(ra.cadenceP90Ms, 200);
  assert.equal(ra.jitterP90Ms, 0);
  assert.equal(ra.delayMs, 500);
  assert.equal('oneWayLatencyMs' in ra, false);
});

test('sparse states produce a larger bounded delay and profiles have explicit floors', () => {
  const normal = new AdaptivePlayoutDelay({ runId: 'run-a' });
  for (let i = 0; i < 20; i++) normal.observe(timing(i, i * 1000), i * 1000 + 100);
  assert.equal(normal.recommendation(19100).delayMs, 2100);
  const constrained = new AdaptivePlayoutDelay({ runId: 'run-a', profile: 'constrained' });
  assert.equal(constrained.recommendation(0).delayMs, 1200);
  const fallback = new AdaptivePlayoutDelay({ runId: 'run-a', profile: 'fallback' });
  assert.equal(fallback.recommendation(0).delayMs, 2200);
  for (let i = 0; i < 20; i++) fallback.observe(timing(i, i * 3000), i * 3000);
  assert.equal(fallback.recommendation(57000).delayMs, 4000);
  assert.deepEqual(Object.keys(STREAM_PROFILES), ['normal', 'constrained', 'fallback']);
});

test('stable high state age is budgeted even with zero jitter', () => {
  const policy = new AdaptivePlayoutDelay({ runId: 'run-a', sourceTimeAt: now => now });
  let advice;
  for (let i = 0; i < 20; i++) advice = policy.observe(timing(i, i * 200), 1000 + i * 200);
  assert.equal(advice.jitterP90Ms, 0);
  assert.equal(advice.stateAgeP90Ms, 1000);
  assert.equal(advice.delayMs, 1500);
  assert.equal(advice.ageCompensated, true);
  assert.equal(advice.budgetExceeded, false);
  const timeline = new SpectatorTimeline({ runId: 'run-a', sourceTimeAt: now => now, delayMs: advice.delayMs });
  for (let i = 0; i < 20; i++) timeline.push(state(i, i * 200), 1000 + i * 200);
  assert.equal(timeline.sample(4800).pose.mode, 'interpolated');
});

test('delay cap is explicit when state age exceeds the presentation budget', () => {
  const policy = new AdaptivePlayoutDelay({ runId: 'run-a', sourceTimeAt: now => now });
  let advice;
  for (let i = 0; i < 10; i++) advice = policy.observe(timing(i, i * 200), 5000 + i * 200);
  assert.equal(advice.delayMs, 4000);
  assert.equal(advice.requiredDelayMs, 5500);
  assert.equal(advice.budgetExceeded, true);
  assert.equal(advice.stateAgeP90Ms, 5000);
  const unsynchronized = new AdaptivePlayoutDelay({ runId: 'run-a' });
  const unanchored = unsynchronized.observe(timing(0, 0), 5000);
  assert.equal(unanchored.ageCompensated, false);
  assert.equal(unanchored.stateAgeP90Ms, null);
});

test('reanchoring clears old age samples and invalid source clocks change no metrics', () => {
  const policy = new AdaptivePlayoutDelay({ runId: 'run-a', sourceTimeAt: now => now });
  policy.observe(timing(0, 0), 1000);
  assert.equal(policy.recommendation(1000).stateAgeP90Ms, 1000);
  policy.reanchorClock(now => now - 800);
  assert.equal(policy.recommendation(1000).ageCompensated, false);
  assert.equal(policy.observe(timing(1, 200), 1200).stateAgeP90Ms, 200);
  policy.reanchorClock(() => NaN);
  assert.throws(() => policy.observe(timing(2, 400), 1400));
  policy.reanchorClock(now => now - 800);
  assert.equal(policy.observe(timing(2, 400), 1400).accepted, true);
});

test('positive gap variation grows the buffer and measurement history is bounded', () => {
  const policy = new AdaptivePlayoutDelay({ runId: 'run-a', windowSize: 8 });
  let arrival = 0, result;
  for (let i = 0; i < 80; i++) {
    arrival += i % 2 ? 700 : 100;
    result = policy.observe(timing(i, i * 400), arrival);
  }
  assert.equal(result.observations, 8);
  assert.equal(result.cadenceP90Ms, 400);
  assert.equal(result.jitterP90Ms, 300);
  assert.equal(result.delayMs, 1200);
});

test('buffer decreases slowly after a profile improvement, never in one catch-up jump', () => {
  const policy = new AdaptivePlayoutDelay({ runId: 'run-a', profile: 'fallback' });
  policy.recommendation(100);
  policy.setProfile('normal');
  assert.equal(policy.recommendation(100).delayMs, 2200);
  assert.equal(policy.recommendation(1100).delayMs, 2120);
  assert.equal(policy.recommendation(900).delayMs, 2120);
  assert.equal(policy.recommendation(31100).delayMs, 400);
});

test('old, foreign and equal-time packets cannot corrupt cadence metrics', () => {
  const policy = new AdaptivePlayoutDelay({ runId: 'run-a' });
  policy.observe(timing(0, 0), 100);
  policy.observe(timing(1, 200), 300);
  assert.equal(policy.observe(timing(1, 200), 600).reason, 'old-sequence');
  assert.equal(policy.observe(timing(2, 200, { runId: 'run-b' }), 600).reason, 'wrong-run');
  assert.equal(policy.observe(timing(2, 100), 600).reason, 'regressing-source-time');
  assert.equal(policy.observe(timing(2, 400), 200).reason, 'regressing-receive-time');
  policy.observe(timing(2, 200), 350);
  const r = policy.observe(timing(3, 400), 500);
  assert.equal(r.observations, 2);
  assert.equal(r.cadenceP90Ms, 200);
  assert.equal(r.jitterP90Ms, 0);
});

test('long outage asks for resync and does not poison the normal cadence window', () => {
  const policy = new AdaptivePlayoutDelay({ runId: 'run-a' });
  policy.observe(timing(0, 0), 100);
  policy.observe(timing(1, 200), 300);
  assert.equal(policy.recommendation(11000).resyncRequired, true);
  const resume = policy.observe(timing(2, 20000), 20100);
  assert.equal(resume.resyncRequired, true);
  assert.equal(resume.observations, 0);
  assert.notEqual(resume.delayMs, 4000);
  policy.acknowledgeResync();
  assert.equal(policy.observe(timing(3, 20200), 20300).resyncRequired, false);
  assert.equal(policy.recommendation(20300).cadenceP90Ms, 200);
});

test('one-slot publisher replaces obsolete poses under backpressure', () => {
  let open = false;
  const sent = [];
  const publisher = new LatestPosePublisher({ runId: 'run-a', canSend: () => open, send: wire => { sent.push(JSON.parse(wire)); return true; } });
  for (let i = 0; i < 1000; i++) {
    publisher.offer(state(i, i * 10));
    assert.equal(publisher.pendingCount, 1);
    assert.equal(publisher.flush(i * 10).reason, 'backpressure');
  }
  assert.equal(sent.length, 0);
  open = true;
  assert.equal(publisher.flush(10000).sent, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].seq, 999);
  assert.equal(publisher.pendingCount, 0);
});

test('publisher obeys cadence, stores immutable wire data and retains a failed send', () => {
  const sent = [];
  let fail = false;
  const publisher = new LatestPosePublisher({ runId: 'run-a', profile: 'constrained', canSend: () => true, send: wire => {
    if (fail) throw new Error('offline');
    sent.push(JSON.parse(wire)); return true;
  } });
  const input = state(0, 0); publisher.offer(input); input.x = 999;
  publisher.flush(0);
  assert.equal(sent[0].x, 0);
  publisher.offer(state(1, 100));
  assert.equal(publisher.flush(499).reason, 'rate-limited');
  fail = true;
  assert.equal(publisher.flush(500).reason, 'send-failed');
  assert.equal(publisher.pendingCount, 1);
  fail = false;
  assert.equal(publisher.flush(510).sent, true);
  assert.equal(sent.length, 2);
});

test('critical and final events explicitly require reliable delivery and cannot be silently coalesced', () => {
  const publisher = new LatestPosePublisher({ runId: 'run-a', canSend: () => true, send: () => true });
  publisher.offer(state(0, 0));
  for (const marker of [{ status: 'finished' }, { critical: true }, { event: { type: 'death' } }, { delivery: 'reliable' }, { type: 'level-change' }]) {
    const r = publisher.offer(state(1, 100, marker));
    assert.equal(r.accepted, false);
    assert.equal(r.requiresReliableDelivery, true);
    assert.equal(publisher.pendingCount, 1);
  }
  publisher.close();
  assert.equal(publisher.pendingCount, 0);
  assert.equal(publisher.flush(200).reason, 'closed');
  assert.equal(publisher.offer(state(2, 200)).reason, 'closed');
});

test('send acceptance preserves a newer pose offered synchronously by the callback', () => {
  let publisher;
  publisher = new LatestPosePublisher({ runId: 'run-a', canSend: () => true, send: () => { publisher.offer(state(1, 100)); return true; } });
  publisher.offer(state(0, 0));
  assert.equal(publisher.flush(0).seq, 0);
  assert.equal(publisher.pendingCount, 1);
});

test('publisher rejects old poses and same-run reset; byte count uses UTF-8', () => {
  const publisher = new LatestPosePublisher({ runId: 'run-a', canSend: () => false, send: () => true });
  publisher.offer(state(5, 500));
  assert.equal(publisher.offer(state(4, 400)).reason, 'old-sequence');
  assert.equal(publisher.offer(state(6, 400)).reason, 'regressing-source-time');
  assert.equal(publisher.offer(state(6, 600, { runId: 'another' })).reason, 'wrong-run');
  assert.throws(() => publisher.reset('run-a'));
  publisher.reset('run-b');
  assert.equal(publisher.pendingCount, 0);
  assert.equal(publisher.offer(state(7, 700)).reason, 'wrong-run');
  assert.equal(utf8PayloadBytes('Я'), 2);
  assert.equal(utf8PayloadBytes({ x: 1 }), 7);
});

test('oversized poses do not replace a valid pending state or advance the sequence', () => {
  const publisher = new LatestPosePublisher({ runId: 'run-a', maxPayloadBytes: 256, canSend: bytes => bytes <= 256, send: () => true });
  assert.equal(publisher.offer(state(0, 0)).accepted, true);
  const rejected = publisher.offer(state(1, 100, { accidentalWorldData: 'x'.repeat(1000) }));
  assert.equal(rejected.reason, 'payload-too-large');
  assert.equal(publisher.pendingCount, 1);
  assert.equal(publisher.offer(state(1, 100)).accepted, true);
  assert.equal(publisher.flush(0).seq, 1);
});

test('dynamic delay preserves playback, confirmed state and terminal lock', () => {
  const timeline = new SpectatorTimeline({ runId: 'run-a', sourceTimeAt: t => t });
  timeline.push(state(0, 0), 0);
  timeline.push(state(1, 1000), 1000);
  const first = timeline.sample(1400);
  timeline.setDelayMs(2200);
  const held = timeline.sample(1450);
  assert.equal(held.playbackTimeMs, first.playbackTimeMs);
  assert.equal(held.confirmed.seq, first.confirmed.seq);
  timeline.push(state(2, 2000, { status: 'finished', lives: 0, score: 45 }), 2100);
  timeline.sample(4300);
  timeline.setDelayMs(400);
  assert.equal(timeline.sample(4400).state, 'finished');
  assert.equal(timeline.sample(4500).confirmed.score, 45);
  assert.equal(timeline.push(state(3, 3000), 4500).accepted, false);
  assert.throws(() => timeline.setDelayMs(-1));
  assert.throws(() => timeline.setDelayMs(NaN));
});

test('invalid policy and publisher input fails before changing state', () => {
  assert.throws(() => new AdaptivePlayoutDelay({ runId: 'a', profile: 'unknown' }));
  assert.throws(() => new AdaptivePlayoutDelay({ runId: 'a', windowSize: 1 }));
  assert.throws(() => new AdaptivePlayoutDelay({ runId: 'a', profile: 'fallback', maxDelayMs: 1000 }));
  const policy = new AdaptivePlayoutDelay({ runId: 'run-a' });
  assert.throws(() => policy.observe(timing(0, -1), 0));
  assert.throws(() => policy.recommendation(NaN));
  const p = new LatestPosePublisher({ runId: 'run-a', canSend: () => true, send: () => true });
  assert.throws(() => p.offer(timing(1.5, 10)));
  assert.equal(p.pendingCount, 0);
});
