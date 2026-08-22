import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_RATING_WORKER_CHILD_TIMEOUT_MS,
  DEFAULT_RATING_WORKER_MONGO_SOCKET_TIMEOUT_MS,
  resolveRatingWorkerChildTimeoutMs,
  resolveRatingWorkerMongoSocketTimeoutMs,
  spawnRatingWorkerChild,
} from "../lib/ratingWorkerChildProcess.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const watchdogPath = path.join(repoRoot, "deploy/rating-worker/run-with-watchdog.sh");

function writeExecutable(filePath, source) {
  fs.writeFileSync(filePath, source, { mode: 0o755 });
}

function createFakeTools(tempRoot) {
  const binDir = path.join(tempRoot, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  writeExecutable(
    path.join(binDir, "flock"),
    "#!/usr/bin/env bash\nexit \"${RATING_WORKER_TEST_FLOCK_STATUS:-0}\"\n",
  );
  writeExecutable(
    path.join(binDir, "timeout"),
    [
      "#!/usr/bin/env bash",
      "if [[ -n \"${RATING_WORKER_TEST_TIMEOUT_MARKER:-}\" ]]; then",
      "  touch \"$RATING_WORKER_TEST_TIMEOUT_MARKER\"",
      "fi",
      "exit \"${RATING_WORKER_TEST_TIMEOUT_STATUS:-0}\"",
      "",
    ].join("\n"),
  );
  return binDir;
}

function watchdogEnv(tempRoot, binDir, overrides = {}) {
  return {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    RATING_WORKER_INSTALL_ROOT: path.join(tempRoot, "install"),
    RATING_WORKER_LOG_DIR: path.join(tempRoot, "logs"),
    RATING_WORKER_LOCK_FILE: path.join(tempRoot, "locks", "rating-worker.lock"),
    ...overrides,
  };
}

test("spawned rating-worker children have a finite timeout", () => {
  assert.equal(resolveRatingWorkerChildTimeoutMs({}), DEFAULT_RATING_WORKER_CHILD_TIMEOUT_MS);
  assert.equal(resolveRatingWorkerChildTimeoutMs({ RATING_WORKER_CHILD_TIMEOUT_MS: "2500" }), 2500);
  assert.equal(
    resolveRatingWorkerChildTimeoutMs({ RATING_WORKER_CHILD_TIMEOUT_MS: "invalid" }),
    DEFAULT_RATING_WORKER_CHILD_TIMEOUT_MS,
  );

  const startedAt = Date.now();
  const result = spawnRatingWorkerChild(
    ["--input-type=module", "--eval", "setInterval(() => {}, 1000)"],
    { cwd: repoRoot, env: process.env, timeoutMs: 100 },
  );
  assert.equal(result.error?.code, "ETIMEDOUT");
  assert.ok(Date.now() - startedAt < 2_000);
});

test("canonical worker applies a finite configurable Mongo socket timeout", () => {
  assert.equal(
    resolveRatingWorkerMongoSocketTimeoutMs(null),
    DEFAULT_RATING_WORKER_MONGO_SOCKET_TIMEOUT_MS,
  );
  assert.equal(resolveRatingWorkerMongoSocketTimeoutMs("45000"), 45_000);
  assert.equal(
    resolveRatingWorkerMongoSocketTimeoutMs("0"),
    DEFAULT_RATING_WORKER_MONGO_SOCKET_TIMEOUT_MS,
  );
});

test("shell watchdog logs a hard timeout and returns the timeout status", (t) => {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rating-watchdog-timeout-")));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const binDir = createFakeTools(tempRoot);
  const result = spawnSync("bash", [watchdogPath, "incremental"], {
    cwd: repoRoot,
    env: watchdogEnv(tempRoot, binDir, {
      RATING_WORKER_TEST_TIMEOUT_STATUS: "124",
      RATING_WORKER_INCREMENTAL_HARD_TIMEOUT_SECONDS: "7",
    }),
    encoding: "utf8",
  });

  assert.equal(result.status, 124, result.stderr);
  const log = fs.readFileSync(path.join(tempRoot, "logs", "incremental.log"), "utf8");
  assert.match(log, /"event":"rating_worker_watchdog_timeout"/);
  assert.match(log, /"runKind":"incremental"/);
  assert.match(log, /"timeoutSeconds":7/);
});

test("shell watchdog records an expected busy-lock skip without starting timeout", (t) => {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rating-watchdog-lock-")));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const binDir = createFakeTools(tempRoot);
  const timeoutMarker = path.join(tempRoot, "timeout-called");
  const result = spawnSync("bash", [watchdogPath, "game-results"], {
    cwd: repoRoot,
    env: watchdogEnv(tempRoot, binDir, {
      RATING_WORKER_TEST_FLOCK_STATUS: "1",
      RATING_WORKER_TEST_TIMEOUT_MARKER: timeoutMarker,
    }),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(timeoutMarker), false);
  const log = fs.readFileSync(path.join(tempRoot, "logs", "game-results.log"), "utf8");
  assert.match(log, /"event":"rating_worker_lock_skipped"/);
  assert.match(log, /"runKind":"game-results"/);
});

test("cron wrappers delegate all modes to the shared watchdog", () => {
  const wrappers = {
    "run-game-results.sh": "game-results",
    "run-incremental.sh": "incremental",
    "run-full.sh": "full",
  };
  Object.entries(wrappers).forEach(([fileName, runKind]) => {
    const source = fs.readFileSync(path.join(repoRoot, "deploy/rating-worker", fileName), "utf8");
    assert.match(source, /run-with-watchdog\.sh/);
    assert.match(source, new RegExp(`${runKind}\\s*$`, "m"));
  });

  const watchdogSource = fs.readFileSync(watchdogPath, "utf8");
  assert.match(watchdogSource, /timeout --signal=TERM --kill-after=30s/);
  assert.match(watchdogSource, /rating_worker_dependency_missing/);
  assert.match(watchdogSource, /RATING_WORKER_INCREMENTAL_HARD_TIMEOUT_SECONDS:-780/);
  assert.match(watchdogSource, /RATING_WORKER_FULL_HARD_TIMEOUT_SECONDS:-780/);

  const runtimeWrapper = fs.readFileSync(path.join(repoRoot, "scripts/run_rating_worker_147.mjs"), "utf8");
  assert.doesNotMatch(runtimeWrapper, /["']--mongo-uri["']/);
  assert.match(runtimeWrapper, /spawnRatingWorkerChild/);
  assert.match(runtimeWrapper, /result\.error\?\.code === "ETIMEDOUT"/);

  const canonicalWorker = fs.readFileSync(path.join(repoRoot, "scripts/rating_worker.mjs"), "utf8");
  assert.match(canonicalWorker, /socketTimeoutMS: resolveRatingWorkerMongoSocketTimeoutMs\(\)/);
});
