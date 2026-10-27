import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';

const source = readFileSync('src/utils/lkIdleDataGuard.ts', 'utf8');
const compiled = transformSync(source, { loader: 'ts', format: 'cjs' }).code;

test('active foreground steering keeps actual idle guard usable; background or no steering still expires', async () => {
  assert.ok(source.includes('export function recordLkUserActivity'));
  const priorWindow = globalThis.window, priorDocument = globalThis.document, priorNow = Date.now;
  let now = 1000, nextId = 0, nativeCalls = 0;
  const timers = new Map();
  const events = new EventTarget();
  try {
    Date.now = () => now;
    globalThis.document = { hidden: false, hasFocus: () => true, addEventListener() {}, body: { classList: { add() {} } } };
    globalThis.window = { fetch: async () => { nativeCalls++; return new Response('{}'); }, setTimeout: (callback, ms) => { const id = ++nextId; timers.set(id, { callback, due: now + ms }); return id; }, clearTimeout: id => timers.delete(id), addEventListener: events.addEventListener.bind(events), dispatchEvent: events.dispatchEvent.bind(events), requestAnimationFrame() {} };
    const module = { exports: {} }; new Function('module', 'exports', compiled)(module, module.exports);
    const idle = module.exports;
    idle.installLkIdleDataGuard();
    const runtime = globalThis.window.__LK_IDLE_DATA_GUARD_V1__;
    runtime.modalElement = { isConnected: true, hidden: true };
    const tick = () => { for (const [id, timer] of timers) if (timer.due <= now) { timers.delete(id); timer.callback(); } };
    for (let i = 0; i < 600; i++) { now += 1000; idle.recordLkUserActivity(); tick(); }
    assert.equal(runtime.status, 'active');
    await globalThis.window.fetch('/fixture'); assert.equal(nativeCalls, 1);
    globalThis.document.hidden = true;
    for (let i = 0; i < 300; i++) { now += 1000; idle.recordLkUserActivity(); tick(); }
    assert.equal(runtime.status, 'stale');
    await assert.rejects(globalThis.window.fetch('/fixture'), { code: 'LK_IDLE_REQUEST_PAUSED' });
    globalThis.document.hidden = false; idle.recordLkUserActivity();
    assert.equal(runtime.status, 'stale'); assert.equal(nativeCalls, 1);

    // A fresh visible page with only network heartbeats must still time out.
    timers.clear(); delete globalThis.window.__LK_IDLE_DATA_GUARD_V1__;
    globalThis.window.fetch = async () => { nativeCalls++; return new Response('{}'); };
    idle.installLkIdleDataGuard();
    const inactive = globalThis.window.__LK_IDLE_DATA_GUARD_V1__;
    inactive.modalElement = { isConnected: true, hidden: true };
    for (let i = 0; i < 299; i++) { now += 1000; tick(); await globalThis.window.fetch('/heartbeat'); }
    now += 1000; tick();
    assert.equal(inactive.status, 'stale');
    await assert.rejects(globalThis.window.fetch('/heartbeat'), { code: 'LK_IDLE_REQUEST_PAUSED' });
  } finally {
    Date.now = priorNow;
    if (priorWindow === undefined) delete globalThis.window; else globalThis.window = priorWindow;
    if (priorDocument === undefined) delete globalThis.document; else globalThis.document = priorDocument;
  }
});

test('race reports only real tilt steering inside the running/foreground simulation branch', () => {
  const race = readFileSync('src/components/padel-jump/RaceJump.tsx', 'utf8');
  assert.match(race, /if \(g\.mode === 'running' && connection\.current && control\.canStep\(\)\)[\s\S]*direction = tilt\.direction\(\);[\s\S]*if \(direction !== 0\) recordLkUserActivity\(\);/);
  assert.equal((race.match(/recordLkUserActivity\(\)/g) || []).length, 1);
});

test('ordinary game reports actual tilt steering only inside the running simulation branch', () => {
  const ordinary = readFileSync('src/components/padel-jump/PadelJump.tsx', 'utf8');
  assert.match(ordinary, /if \(current\.mode === 'running'\)[\s\S]*if \(inputs\.current\.size === 0\)[\s\S]*direction = tilt\.direction\(\);[\s\S]*if \(Math\.abs\(direction\) > 0\.05\) \{[^}]*recordLkUserActivity\(\);/);
  assert.equal((ordinary.match(/recordLkUserActivity\(\)/g) || []).length, 1);
});
