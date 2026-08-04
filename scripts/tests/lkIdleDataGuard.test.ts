import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  LK_IDLE_DATA_TIMEOUT_MS,
  LK_IDLE_REQUEST_PAUSED_CODE,
  LkIdleRequestPausedError,
  isLkIdleDeadlineReached,
  isLkIdleRequestPausedError,
} from "../../src/utils/lkIdleDataGuard.ts";

const guardSource = fs.readFileSync("src/utils/lkIdleDataGuard.ts", "utf8");
const analyticsSource = fs.readFileSync("src/utils/analytics.ts", "utf8");
const apiClientSource = fs.readFileSync("src/utils/apiClient.ts", "utf8");
const vivaAuthSource = fs.readFileSync("src/context/VivaAuthProvider.tsx", "utf8");
const cssSource = fs.readFileSync("src/MyApp.css", "utf8");

test("LK data becomes stale exactly after five minutes without activity", () => {
  assert.equal(LK_IDLE_DATA_TIMEOUT_MS, 300_000);
  assert.equal(isLkIdleDeadlineReached(1_000, 300_999), false);
  assert.equal(isLkIdleDeadlineReached(1_000, 301_000), true);
  assert.equal(isLkIdleDeadlineReached(1_000, 301_001), true);
  assert.equal(isLkIdleDeadlineReached(0, 301_000), false);
  assert.equal(isLkIdleDeadlineReached(2_000, 1_000), false);
});

test("idle request pause errors remain recognizable across separately bundled LK widgets", () => {
  const error = new LkIdleRequestPausedError();
  assert.equal(error.code, LK_IDLE_REQUEST_PAUSED_CODE);
  assert.equal(isLkIdleRequestPausedError(error), true);
  assert.equal(isLkIdleRequestPausedError({ code: LK_IDLE_REQUEST_PAUSED_CODE }), true);
  assert.equal(isLkIdleRequestPausedError({ name: "LkIdleRequestPausedError" }), true);
  assert.equal(isLkIdleRequestPausedError(new Error("network")), false);
});

test("the page-wide idle gate blocks every browser transport without queueing requests", () => {
  assert.match(guardSource, /window\.fetch = \(\(input:/);
  assert.match(guardSource, /prototype\.send = function guardedLkXhrSend/);
  assert.match(guardSource, /navigator\.sendBeacon =/);
  assert.match(guardSource, /class GuardedLkWebSocket extends NativeWebSocket/);
  assert.match(guardSource, /closeActiveSockets\(runtime\);/);
  assert.match(guardSource, /return Promise\.reject\(new LkIdleRequestPausedError\(\)\);/);
  assert.doesNotMatch(guardSource, /localStorage|sessionStorage/);
});

test("the stale dialog requires an explicit full-page refresh and cannot silently resume", () => {
  assert.match(guardSource, /title\.textContent = "Данные ЛК устарели";/);
  assert.match(guardSource, /refreshButton\.textContent = "Обновить";/);
  assert.match(guardSource, /runtime\.status = "refreshing";[\s\S]*window\.location\.reload\(\);/);
  assert.match(cssSource, /\.lk-idle-data-guard\s*\{[\s\S]*z-index: 2147483647;/);
  assert.match(cssSource, /body\.lk-idle-data-stale\s*\{[\s\S]*overflow: hidden !important;/);
});

test("analytics, API fallbacks and auth refresh treat idle pause as terminal", () => {
  assert.match(
    analyticsSource,
    /export function installGlobalErrorTracking\(\) \{[\s\S]*installLkIdleDataGuard\(\);/,
  );
  assert.match(
    analyticsSource,
    /export function trackAnalyticsEvent\([\s\S]*if \(isLkIdleRequestPaused\(\)\) return;[\s\S]*trackFirebaseAnalyticsEvent/,
  );
  assert.match(
    apiClientSource,
    /function shouldFallback\(result:[\s\S]*if \(isLkIdleRequestPausedError\(result\.error\?\.raw\)\) return false;/,
  );
  assert.match(
    vivaAuthSource,
    /catch \(refreshError\) \{\s*if \(isLkIdleRequestPausedError\(refreshError\)\) \{\s*return false;\s*\}/,
  );
});
