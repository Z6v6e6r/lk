import test from 'node:test';
import assert from 'node:assert/strict';
import { createTiltController, screenTilt, TILT_STALE_MS, tiltDirection } from '../../src/components/padel-jump/tilt.ts';
import type { TiltEnvironment, TiltStatus } from '../../src/components/padel-jump/tilt.ts';

function harness() {
  let time = 1, angle = 0;
  let sample: ((value: { beta: number | null; gamma: number | null }) => void) | undefined;
  let rotate: (() => void) | undefined;
  let listeners = 0;
  const timers = new Set<() => void>();
  const states: TiltStatus[] = [];
  const env: TiltEnvironment = {
    secure: true, api: {}, now: () => time, angle: () => angle,
    listen: (onSample, onRotate) => {
      sample = onSample; rotate = onRotate; listeners++;
      return () => { sample = undefined; rotate = undefined; listeners--; };
    },
    timer: callback => { timers.add(callback); return () => { timers.delete(callback); }; },
  };
  const tilt = createTiltController(env);
  tilt.subscribe(state => states.push(state));
  return {
    env, tilt, states,
    emit(beta: number | null, gamma: number | null, ms = 100) { time += ms; sample?.({ beta, gamma }); },
    advance(ms: number) { time += ms; },
    rotate(next: number) { angle = next; rotate?.(); },
    timeout() { for (const callback of [...timers]) callback(); },
    listeners: () => listeners,
    timers: () => timers.size,
  };
}

test('portrait and landscape project the correct screen-relative axis', () => {
  const sample = { beta: 20, gamma: 10 };
  assert.equal(screenTilt(sample, 0), 10);
  assert.equal(screenTilt(sample, 90), 20);
  assert.equal(screenTilt(sample, 180), -10);
  assert.equal(screenTilt(sample, 270), -20);
  assert.equal(screenTilt(sample, -90), -20);
  assert.equal(screenTilt({ beta: null, gamma: null }, 0), null);
  assert.equal(screenTilt({ beta: NaN, gamma: 4 }, 0), null);
});

test('neutral dead zone, proportional speed, bounds, and angle wrapping', () => {
  assert.equal(tiltDirection(2, 0), 0);
  assert.equal(tiltDirection(12, 10), 0);
  assert.ok(tiltDirection(12, 0) > 0 && tiltDirection(12, 0) < 1);
  assert.equal(tiltDirection(-30, 0), -1);
  assert.equal(tiltDirection(30, 0), 1);
  assert.equal(tiltDirection(-179, 179), 0);
});

test('calibrates to the first sample, smooths noise and recalibrates on rotation', async () => {
  const h = harness(); await h.tilt.enable();
  assert.equal(h.states.at(-1), 'calibrating');
  h.emit(45, 15); assert.equal(h.tilt.direction(), 0);
  h.emit(45, 35); assert.ok(h.tilt.direction() > 0.5 && h.tilt.direction() < 1);
  h.rotate(90); assert.equal(h.tilt.direction(), 0);
  assert.equal(h.states.at(-1), 'calibrating');
  h.emit(65, 0); assert.equal(h.tilt.direction(), 0);
  h.emit(45, 0); assert.ok(h.tilt.direction() < -0.5);
  h.tilt.recalibrate(); assert.equal(h.tilt.direction(), 0);
  h.emit(45, 0); assert.equal(h.tilt.direction(), 0);
  assert.equal(h.timers(), 1);
});

test('stale sensor data stops steering; missing/invalid signals fall back and detach', async () => {
  const h = harness(); await h.tilt.enable();
  h.emit(45, 0); h.emit(45, 25);
  assert.ok(h.tilt.direction() > 0);
  h.advance(TILT_STALE_MS + 1); assert.equal(h.tilt.direction(), 0);
  h.timeout();
  assert.equal(h.states.at(-1), 'unavailable');
  assert.equal(h.listeners(), 0);
  assert.equal(h.timers(), 0);
  await h.tilt.enable();
  h.emit(null, null); assert.equal(h.states.at(-1), 'calibrating');
  h.timeout(); assert.equal(h.states.at(-1), 'unavailable');
});

test('permission is called immediately and denial/rejection does not install listeners', async () => {
  const h = harness(); let called = false;
  h.env.api = { requestPermission: () => { called = true; return Promise.resolve('denied'); } };
  const pending = h.tilt.enable(); assert.equal(called, true);
  await pending; assert.equal(h.states.at(-1), 'denied'); assert.equal(h.listeners(), 0);
  h.env.api.requestPermission = () => Promise.reject(new Error('blocked'));
  await h.tilt.enable(); assert.equal(h.states.at(-1), 'denied'); assert.equal(h.listeners(), 0);
});

test('secure-context and unsupported checks do not request permission', async () => {
  const h = harness(); let calls = 0;
  h.env.secure = false; h.env.api = { requestPermission: async () => { calls++; return 'granted'; } };
  await h.tilt.enable(); assert.equal(h.states.at(-1), 'insecure'); assert.equal(calls, 0);
  h.env.secure = true; h.env.api = undefined;
  await h.tilt.enable(); assert.equal(h.states.at(-1), 'unavailable'); assert.equal(h.listeners(), 0);
});

test('switching to touch or unmounting cancels a pending permission grant', async () => {
  for (const cancel of ['disable', 'dispose'] as const) {
    const h = harness(); let resolve!: (value: string) => void;
    h.env.api = { requestPermission: () => new Promise<string>(done => { resolve = done; }) };
    const pending = h.tilt.enable();
    h.tilt[cancel](); resolve('granted'); await pending;
    assert.equal(h.listeners(), 0); assert.equal(h.tilt.direction(), 0);
  }
});

test('repeat enable and StrictMode dispose/remount keep exactly one sensor listener', async () => {
  const h = harness(); await h.tilt.enable(); await h.tilt.enable();
  assert.equal(h.listeners(), 1); assert.equal(h.timers(), 1);
  h.tilt.dispose(); assert.equal(h.listeners(), 0); assert.equal(h.timers(), 0);
  h.tilt.subscribe(state => h.states.push(state));
  await h.tilt.enable(); assert.equal(h.listeners(), 1);
  h.tilt.disable(); assert.equal(h.states.at(-1), 'off');
  assert.equal(h.listeners(), 0); assert.equal(h.timers(), 0);
});

test('sensitivity changes response without reattaching sensors or changing calibration', async () => {
  const h = harness(); await h.tilt.enable(); h.emit(20, 0); h.emit(20, 12, 300);
  const normal = h.tilt.direction(); h.tilt.setSensitivity(0.65);
  assert.ok(Math.abs(h.tilt.direction() - normal * 0.65) < 1e-9);
  h.tilt.setSensitivity(1.5); assert.ok(h.tilt.direction() >= normal);
  h.tilt.setSensitivity(NaN); assert.equal(h.tilt.direction(), normal); assert.equal(h.listeners(), 1);
});
