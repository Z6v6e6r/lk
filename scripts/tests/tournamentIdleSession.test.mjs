import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";
import { installLegacyIdleRuntimeV1 } from "./fixtures/lkIdleRuntimeV1.mjs";
const compiled = transformSync(readFileSync("src/utils/lkIdleDataGuard.ts", "utf8"), { loader: "ts", format: "cjs" }).code;
function harness(t, legacy = false) {
  const before = { window: globalThis.window, document: globalThis.document, now: Date.now };
  let now = 1000, id = 0, calls = 0;
  const timers = new Map();
  globalThis.document = { hidden: true, hasFocus: () => false, addEventListener() {}, body: { classList: { add() {} } } };
  const events = new EventTarget();
  globalThis.window = { fetch: async () => { calls++; return new Response("{}"); },
    setTimeout: (fn, delay) => { const key = ++id; timers.set(key, { fn, due: now + delay }); return key; },
    clearTimeout: key => timers.delete(key), addEventListener: events.addEventListener.bind(events), dispatchEvent: events.dispatchEvent.bind(events), requestAnimationFrame() {} };
  Date.now = () => now;
  t.after(() => { globalThis.window = before.window; globalThis.document = before.document; Date.now = before.now; });
  const m = { exports: {} }; new Function("module", "exports", compiled)(m, m.exports);
  if (legacy) installLegacyIdleRuntimeV1();
  const idle = m.exports; idle.installLkIdleDataGuard();
  const runtime = globalThis.window.__LK_IDLE_DATA_GUARD_V1__; runtime.modalElement = { isConnected: true, hidden: true };
  return { idle, runtime, calls: () => calls, advance: (ms, runTimers = true) => { now += ms; if (runTimers) for (const [key, timer] of [...timers]) if (timer.due <= now) { timers.delete(key); timer.fn(); } } };
}
test("open tournament stays usable beyond five minutes, including a background tab", async t => {
  const h = harness(t), release = h.idle.beginLkTournamentSession();
  h.advance(3 * 60 * 60_000);
  assert.equal(h.runtime.status, "active"); assert.equal(h.runtime.modalElement.hidden, true);
  await globalThis.window.fetch("/tournament-command"); assert.equal(h.calls(), 1);
  release(); h.advance(299999); assert.equal(h.runtime.status, "active");
  h.advance(1); assert.equal(h.runtime.status, "stale");
  await assert.rejects(globalThis.window.fetch("/other-request"), { code: "LK_IDLE_REQUEST_PAUSED" });
});
test("closing one nested tournament cannot release another and cleanup is idempotent", t => {
  const h = harness(t), otherBundle = { exports: {} };
  new Function("module", "exports", compiled)(otherBundle, otherBundle.exports);
  otherBundle.exports.installLkIdleDataGuard();
  const releaseA = h.idle.beginLkTournamentSession(), releaseB = otherBundle.exports.beginLkTournamentSession();
  releaseA(); releaseA(); h.advance(600000); assert.equal(h.runtime.status, "active");
  releaseB(); releaseB(); h.advance(300000); assert.equal(h.runtime.status, "stale");
});
test("a tournament hold cannot resume an already stale or overdue page", async t => {
  const h = harness(t); h.advance(300000); h.idle.beginLkTournamentSession()();
  assert.equal(h.runtime.status, "stale");
  await assert.rejects(globalThis.window.fetch("/fixture"), { code: "LK_IDLE_REQUEST_PAUSED" });
});
test("entering a tournament after an overdue clock cannot race the pending idle callback", t => {
  const h = harness(t); h.advance(300000, false);
  assert.equal(h.runtime.status, "active");
  h.idle.beginLkTournamentSession()();
  assert.equal(h.runtime.status, "stale");
});
test("new tournament overlay holds cached V1 timer and pointer listeners without replacing transports", async t => {
  const h = harness(t, true), oldFetch = globalThis.window.fetch;
  const release = h.idle.beginLkTournamentSession();
  h.advance(3600000); globalThis.window.dispatchEvent(new Event("pointerdown"));
  assert.equal(h.runtime.status, "active"); assert.equal(h.runtime.modalElement.hidden, true);
  assert.equal(globalThis.window.fetch, oldFetch);
  await globalThis.window.fetch("/fixture"); assert.equal(h.calls(), 1);
  release(); h.advance(300000);
  assert.equal(h.runtime.status, "stale");
  await assert.rejects(globalThis.window.fetch("/fixture"), { code: "LK_IDLE_REQUEST_PAUSED" });
});
