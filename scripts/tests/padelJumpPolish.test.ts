import test from 'node:test';
import assert from 'node:assert/strict';
import { createCampaignGame, drainEvents, stepGame } from '../../src/components/padel-jump/engine.ts';
import { sectionBalance, STATIONS } from '../../src/components/padel-jump/campaign.ts';
import { addFeedback, advanceFeedback, createFeedback } from '../../src/components/padel-jump/feedback.ts';
import { createJumpAudio } from '../../src/components/padel-jump/audio.ts';
import { freshProgress, loadProgress, PROGRESS_KEY } from '../../src/components/padel-jump/progress.ts';
import { pilot } from './helpers/padelJumpPilot.ts';

test('short sections ramp duration gradually and retain permanent recovery courts on every station', () => {
  const times: number[] = [];
  for (let station = 0; station < STATIONS.length; station++) {
    let total = 0;
    for (let section = 0; section < 3; section++) {
      const g = createCampaignGame(station, section), cfg = sectionBalance(station, section);
      assert.ok(cfg.count >= 24 && cfg.count <= 42);
      for (const p of g.platforms.filter(p => p.id % 6 === 0 || p.finish)) {
        assert.equal(p.kind, 'court'); assert.equal(p.moving, false);
      }
      pilot(g); assert.equal(g.mode, 'complete'); total += g.time;
    }
    times.push(total);
  }
  assert.ok(times[1] / times[0] < 1.4);
  assert.ok(times.every(t => t < 90));
});

test('moving racket stars follow their head instead of baiting players into its old position', () => {
  const g = createCampaignGame(1, 2); g.mode = 'running';
  const p = g.platforms.find(p => p.moving && p.id % 4 === 0)!;
  const star = g.campaign!.stars.find(s => s.platform === p.id)!;
  assert.ok(Math.abs(star.offset!) <= 12);
  const old = star.x;
  for (let i = 0; i < 30; i++) { g.ball.y = p.y + 100; g.ball.vy = 0; stepGame(g, 0); drainEvents(g); }
  assert.notEqual(star.x, old); assert.equal(star.x, p.x + p.width / 2 + star.offset!);
});

test('feedback is bounded, expires, respects disabled effects and never mutates game state', () => {
  const g = createCampaignGame(), before = JSON.stringify(g), feedback = createFeedback();
  for (let i = 0; i < 100; i++) addFeedback(feedback, { type: 'star', id: '0:0:1' }, g);
  assert.equal(feedback.bursts.length, 16); assert.equal(JSON.stringify(g), before);
  for (let i = 0; i < 20; i++) advanceFeedback(feedback, 1, true);
  assert.equal(feedback.bursts.length, 0);
  addFeedback(feedback, { type: 'landing', id: '1' }, g); advanceFeedback(feedback, 0.01, false);
  assert.equal(feedback.bursts.length, 0);
});

test('old saves keep checkpoints, sound stays opt-in and invalid sensitivity is clamped', () => {
  const p = freshProgress(); p.parts['0:0'] = { done: true, clean: true, perfect: false, bestStars: 2, failures: 1 };
  const old = { ...p, balance: 3, settings: { assist: false, effects: true, journal: true, tiltSensitivity: 100 } };
  const loaded = loadProgress({ getItem: key => key === PROGRESS_KEY ? JSON.stringify(old) : null });
  assert.equal(loaded.current.section, 1); assert.equal(loaded.parts['0:0'].done, true);
  assert.equal(loaded.settings.sound, false); assert.equal(loaded.settings.tiltSensitivity, 1.5);
});

function audioHarness() {
  let creates = 0, resumes = 0, suspends = 0, closes = 0;
  const voices: { onended: null | (() => void); stops: number }[] = [];
  const param = () => ({ value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} });
  const context = { state: 'running', currentTime: 0, destination: {},
    resume: async () => { resumes++; }, suspend: async () => { suspends++; }, close: async () => { closes++; },
    createGain: () => ({ gain: param(), connect() {}, disconnect() {} }),
    createOscillator: () => {
      const voice = { onended: null as null | (() => void), stops: 0, frequency: param(), type: 'sine',
        start() {}, stop() { voice.stops++; }, connect() {}, disconnect() {} };
      voices.push(voice); return voice;
    },
  };
  const audio = createJumpAudio(() => { creates++; return context as unknown as AudioContext; });
  return { audio, voices, counts: () => ({ creates, resumes, suspends, closes }) };
}
test('audio never autoplays, caps polyphony, mutes on pause and closes on disposal', async () => {
  const h = audioHarness(); h.audio.unlock(); h.audio.cue({ type: 'star' }); assert.equal(h.counts().creates, 0);
  h.audio.setEnabled(true); h.audio.unlock(); await Promise.resolve();
  for (let i = 0; i < 20; i++) h.audio.cue({ type: 'landing', id: '1' });
  assert.equal(h.voices.length, 4);
  for (const voice of h.voices) voice.onended?.();
  h.audio.cue({ type: 'star' }); assert.equal(h.voices.length, 5);
  h.audio.pause(); assert.equal(h.counts().suspends, 1);
  h.audio.setEnabled(false); h.audio.cue({ type: 'star' }); assert.equal(h.voices.length, 5);
  h.audio.dispose(); assert.equal(h.counts().closes, 1);
});
test('unavailable audio cannot prevent play or throw on feedback', () => {
  const audio = createJumpAudio(() => { throw new Error('Device unavailable'); });
  audio.setEnabled(true); assert.doesNotThrow(() => audio.unlock()); assert.doesNotThrow(() => audio.cue({ type: 'star' })); audio.dispose();
});
