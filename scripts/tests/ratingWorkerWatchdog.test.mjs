import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
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
    "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" > \"$RATING_WORKER_TEST_FLOCK_ARGS\"\nexit \"${RATING_WORKER_TEST_FLOCK_STATUS:-0}\"\n",
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
    RATING_WORKER_TEST_FLOCK_ARGS: path.join(tempRoot, "flock-args"),
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

for (const mode of ["incremental", "full"]) {
  test(`${mode} fails visibly if the shared lock wait expires`, (t) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rating-lock-policy-")));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const bin = createFakeTools(root);
    const marker = path.join(root, "timeout-called");
    const result = spawnSync("bash", [watchdogPath, mode], {
      env: watchdogEnv(root, bin, {
        RATING_WORKER_LOCK_WAIT_SECONDS: "3",
        RATING_WORKER_TEST_FLOCK_STATUS: "1",
        RATING_WORKER_TEST_TIMEOUT_MARKER: marker,
      }), encoding: "utf8",
    });
    assert.equal(result.status, 75, result.stderr);
    assert.equal(fs.readFileSync(path.join(root, "flock-args"), "utf8").trim(), "-w 3 9");
    assert.equal(fs.existsSync(marker), false);
    const log = fs.readFileSync(path.join(root, "logs", `${mode}.log`), "utf8");
    assert.match(log, /"event":"rating_worker_lock_timeout"/);
    assert.match(log, /"waitSeconds":3/);
    assert.doesNotMatch(log, /rating_worker_lock_skipped/);
  });
}

test("scheduled lock wait defaults to 120 seconds and rejects invalid values", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rating-lock-config-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = createFakeTools(root);
  const argsFile = path.join(root, "flock-args");
  const env = watchdogEnv(root, bin);
  delete env.RATING_WORKER_LOCK_WAIT_SECONDS;
  assert.equal(spawnSync("bash", [watchdogPath, "incremental"], { env }).status, 0);
  assert.equal(fs.readFileSync(argsFile, "utf8").trim(), "-w 120 9");
  fs.unlinkSync(argsFile);
  for (const value of ["0", "-1", "1.5", "invalid"]) {
    const result = spawnSync("bash", [watchdogPath, "full"], {
      env: { ...env, RATING_WORKER_LOCK_WAIT_SECONDS: value }, encoding: "utf8",
    });
    assert.equal(result.status, 64);
    assert.match(result.stderr, /Invalid lock wait/);
    assert.equal(fs.existsSync(argsFile), false);
  }
});

const linuxLocksAvailable = process.platform === "linux"
  && spawnSync("flock", ["--version"]).status === 0
  && spawnSync("timeout", ["--version"]).status === 0;

function startProcess(command, args, env) {
  const child = spawn(command, args, { env, stdio: "ignore", detached: true });
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (status, signal) => resolve({ status, signal }));
  });
  return { child, done };
}

async function waitForFile(file) {
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(file)) {
    assert.ok(Date.now() < deadline, `Missing readiness marker: ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function realLockFixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rating-real-lock-")));
  const env = watchdogEnv(root, path.dirname(process.execPath), {
    RATING_WORKER_LOCK_WAIT_SECONDS: "2",
    RATING_WORKER_INCREMENTAL_HARD_TIMEOUT_SECONDS: "2",
    RATING_WORKER_FULL_HARD_TIMEOUT_SECONDS: "2",
    RATING_WORKER_TEST_ROOT: root,
  });
  fs.mkdirSync(path.dirname(env.RATING_WORKER_LOCK_FILE), { recursive: true });
  const scripts = path.join(env.RATING_WORKER_INSTALL_ROOT, "current/scripts");
  fs.mkdirSync(scripts, { recursive: true });
  fs.writeFileSync(path.join(scripts, "run_rating_worker_147.mjs"), `
import fs from 'node:fs';
const root = process.env.RATING_WORKER_TEST_ROOT;
const mutex = root + '/critical-section';
fs.mkdirSync(mutex);
fs.writeFileSync(root + '/entered-' + process.pid, 'entered');
if (process.env.RATING_WORKER_TEST_HANG) setInterval(() => {}, 1000);
else setTimeout(() => { fs.rmdirSync(mutex); }, 250);
`);
  const processes = [];
  const start = (command, args, overrides = {}) => {
    const proc = startProcess(command, args, { ...env, ...overrides });
    processes.push(proc);
    return proc;
  };
  t.after(async () => {
    for (const { child } of processes) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      try { process.kill(-child.pid, "SIGKILL"); } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    await Promise.all(processes.map(({ done }) => done));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, env, start };
}

test("Linux: scheduled modes wait for contention and remain serialized", { skip: !linuxLocksAvailable }, async (t) => {
  const { root, env, start } = realLockFixture(t);
  const ready = path.join(root, "holder-ready");
  const holder = start("flock", ["-x", env.RATING_WORKER_LOCK_FILE, process.execPath, "-e",
    `require('fs').writeFileSync(${JSON.stringify(ready)}, 'ready'); setTimeout(() => {}, 350);`]);
  await waitForFile(ready);
  const incremental = start("bash", [watchdogPath, "incremental"]);
  const full = start("bash", [watchdogPath, "full"]);
  const game = start("bash", [watchdogPath, "game-results"]);
  for (const result of await Promise.all([holder.done, incremental.done, full.done, game.done])) {
    assert.equal(result.status, 0);
  }
  assert.equal(fs.readdirSync(root).filter((file) => file.startsWith("entered-")).length, 2);
  assert.match(fs.readFileSync(path.join(root, "logs/game-results.log"), "utf8"), /rating_worker_lock_skipped/);
});

test("Linux: waiting does not consume the worker execution deadline", { skip: !linuxLocksAvailable }, async (t) => {
  const { root, env, start } = realLockFixture(t);
  const ready = path.join(root, "holder-ready");
  start("flock", ["-x", env.RATING_WORKER_LOCK_FILE, process.execPath, "-e",
    `require('fs').writeFileSync(${JSON.stringify(ready)}, 'ready'); setTimeout(() => {}, 1200);`]);
  await waitForFile(ready);
  const result = await start("bash", [watchdogPath, "incremental"], {
    RATING_WORKER_INCREMENTAL_HARD_TIMEOUT_SECONDS: "1",
  }).done;
  assert.equal(result.status, 0);
  assert.equal(fs.readdirSync(root).filter((file) => file.startsWith("entered-")).length, 1);
});

test("Linux: lock deadline expires without starting a worker", { skip: !linuxLocksAvailable }, async (t) => {
  const { root, env, start } = realLockFixture(t);
  const ready = path.join(root, "holder-ready");
  start("flock", ["-x", env.RATING_WORKER_LOCK_FILE, process.execPath, "-e",
    `require('fs').writeFileSync(${JSON.stringify(ready)}, 'ready'); setTimeout(() => {}, 4000);`]);
  await waitForFile(ready);
  const result = await start("bash", [watchdogPath, "full"], { RATING_WORKER_LOCK_WAIT_SECONDS: "1" }).done;
  assert.equal(result.status, 75);
  assert.equal(fs.readdirSync(root).filter((file) => file.startsWith("entered-")).length, 0);
});

test("Linux: watchdog terminates a stuck worker and releases the lock", { skip: !linuxLocksAvailable }, async (t) => {
  const { env, start } = realLockFixture(t);
  const result = await start("bash", [watchdogPath, "incremental"], {
    RATING_WORKER_INCREMENTAL_HARD_TIMEOUT_SECONDS: "1", RATING_WORKER_TEST_HANG: "1",
  }).done;
  assert.equal(result.status, 124);
  assert.equal(spawnSync("flock", ["-n", env.RATING_WORKER_LOCK_FILE, "true"]).status, 0);
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
