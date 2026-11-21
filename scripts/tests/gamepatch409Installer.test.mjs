import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createGamePatch409Installer } from "../diagnostics/gamepatch409-installer.mjs";
import { createScopedObserver } from "../diagnostics/gamepatch409-scope.mjs";
import { settingsCandidate, sha, LEASE_NAME, ROOT } from "../diagnostics/gamepatch409-contract.mjs";
import { registerSettings } from "../diagnostics/gamepatch409-bootstrap.mjs";
import { buildRuntimeArtifacts, packetContents } from "../prepare_gamepatch409_runtime.mjs";
import { createProcessAdapter } from "../diagnostics/gamepatch409-process.mjs";
import { assertKernelFlock } from "../diagnostics/gamepatch409-lock.mjs";
import { prepareGamePatchHooks } from '../prepare_gamepatch409_hooks.mjs';

const uid = process.getuid(), gid = process.getgid(), generation = "a".repeat(32), release = "b".repeat(40);
function fixture(t, { settingsMode = 0o600 } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gamepatch409-test-")));
  fs.chmodSync(root, 0o700); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const releases = path.join(root, "releases"), settings = path.join(root, "settings.js"), flowPath = path.join(root, "flows.json");
  const before = Buffer.from('module.exports={adminAuth:{type:"credentials"},httpNodeMiddleware:function(req,res,next){next();},functionGlobalContext:{existing:17}};\n');
  const router = 'global.get("lkDiagnostics")?.observe(msg, "roster_authorize", {}); return msg;';
  const finalize = 'global.get("lkDiagnostics")?.observe(msg, "roster_ack", {}); return msg;';
  const flow = Buffer.from(JSON.stringify([{ id: "tab", type: "tab" },
    { id: "route", z: "tab", type: "http in", method: "patch", url: "/lk/games/:gameId", wires: [["router"]] },
    { id: "alias", z: "tab", type: "http in", method: "patch", url: "/lk/games/records/:gameId", wires: [["router"]] },
    { id: "router", z: "tab", type: "function", func: router, wires: [["finalize"]] },
    { id: "finalize", z: "tab", type: "function", func: finalize, wires: [] }]));
  for (const [file, bytes] of [[settings, before], [flowPath, flow]]) fs.writeFileSync(file, bytes, { mode: 0o600 });
  fs.chmodSync(settings, settingsMode);
  const bundle = Buffer.from("exports.registerSettings = function(){};\n"), bundleSha256 = sha(bundle);
  const after = settingsCandidate(before, { generation, bundleSha256, release, root, releases });
  const c = { formatVersion: 1, kind: "gamepatch409-runtime", target: "lk-primary-147", generation, release,
    settingsSha256: sha(before), candidateSha256: sha(after), flowSha256: sha(flow), bundleSha256,
    installerSha256: "c".repeat(64), machineSha256: "d".repeat(64), createdAtMs: 1_000_000,
    process: { pid: 100, restartCount: 4, status: "online" }, hooks: { authorize: sha(router), ack: sha(finalize) },
    preservedFiles: [], coordinatedRestartApproved: true, settingsMode };
  const tx = path.join(root, ".gamepatch409-transactions", generation), lease = path.join(root, LEASE_NAME);
  const state = { time: c.createdAtMs, process: { ...c.process }, restarts: 0, lock: true, fail: null,
    restartFail: null, registrationFail: false, registrationDelayMs: 0, registrationWrong: false, points: [] };
  const saveReady = () => {
    if (sha(fs.readFileSync(settings)) === c.candidateSha256 && !state.registrationFail) fs.writeFileSync(path.join(tx, "ready.json"),
      JSON.stringify({ kind: "GAMEPATCH409_SETTINGS_REGISTERED", generation: state.registrationWrong ? "f".repeat(32) : generation,
        bundleSha256, pid: state.process.pid, registered: true, scope: "GAME_PATCH_409_V1", selfTestPassed: true, ...state.receiptOverrides }), { mode: 0o600 });
  };
  const pm2 = { inspect: () => ({ ...state.process }), restart(expected) {
    assert.equal(state.process.restartCount, expected); state.restarts++;
    if (state.restartFail === "before") throw Error("SYNTHETIC_RESTART_UNKNOWN");
    state.process = { pid: Math.max(100, state.process.pid) + 1, restartCount: expected + 1, status: "online" };
    state.restartedAt = state.time;
    if (state.restartFail === "offline") { state.process = { ...state.process, pid: 0, status: "errored" }; throw Error("SYNTHETIC_RESTART_UNKNOWN"); }
    if (!state.registrationDelayMs) saveReady();
    if (state.restartFail === "after") throw Error("SYNTHETIC_RESTART_UNKNOWN");
    return state.process;
  } };
  const options = { root, releases, uid, gid, machineSha256: c.machineSha256, pm2, now: () => state.time,
    monotonic: () => state.time, registrationTimeoutMs: 1000, pollMs: 100, wait(ms) {
      state.time += ms; state.onWait?.();
      if (state.registrationDelayMs && state.time - state.restartedAt >= state.registrationDelayMs) saveReady();
    },
    assertLock() { if (!state.lock) throw Error("NO_KERNEL_LOCK"); }, onTransition(point) {
      state.points.push(point); if (point === state.fail) { state.fail = null; throw Error("SYNTHETIC_CRASH"); }
    } };
  const runtime = () => createGamePatch409Installer(options), packet = { bundle, beforeSettings: before, afterSettings: after };
  return { root, releases, settings, flowPath, before, after, bundle, c, tx, lease, state, runtime, packet, options };
}

test("apply, guarded soak, finish and idempotent finish never alter flow or credentials", t => {
  const f = fixture(t), initial = fs.readFileSync(f.flowPath);
  assert.equal(f.runtime().apply(f.c, f.packet).state, "SOAKING"); assert.equal(f.state.restarts, 1);
  assert.throws(() => f.runtime().finish(f.c), /SOAK_NOT_COMPLETE/);
  f.state.time += 900_001; const done = f.runtime().finish(f.c); assert.equal(done.state, "INSTALLED");
  assert.equal(fs.existsSync(f.lease), false); assert.deepEqual(f.runtime().finish(f.c), done);
  assert.deepEqual(f.runtime().apply(f.c, f.packet), done); assert.equal(f.state.restarts, 1);
  assert(fs.readFileSync(f.flowPath).equals(initial)); assert(fs.readFileSync(f.settings).subarray(0, f.before.length).equals(f.before));
});

for (const settingsMode of [0o640, 0o644]) test(`apply and rollback preserve original settings mode ${settingsMode.toString(8)}`, t => {
  const f = fixture(t, { settingsMode });
  f.runtime().apply(f.c, f.packet); assert.equal(fs.statSync(f.settings).mode & 0o777, settingsMode);
  for (const file of ["settings.before.js", "settings.after.js", "contract.json", "ready.json"])
    assert.equal(fs.statSync(path.join(f.tx, file)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(f.releases, f.c.bundleSha256, "observer.cjs")).mode & 0o777, 0o600);
  assert.equal(fs.statSync(f.lease).mode & 0o777, 0o600);
  assert.equal(f.runtime().rollback(f.c).state, "ROLLED_BACK");
  const st = fs.statSync(f.settings); assert.equal(st.mode & 0o777, settingsMode); assert.equal(st.uid, uid); assert.equal(st.gid, gid);
});

test("settings mode drift and permissive contract modes are refused without chmod", t => {
  const f = fixture(t, { settingsMode: 0o644 }); fs.chmodSync(f.settings, 0o600);
  assert.throws(() => f.runtime().apply(f.c, f.packet), /Protected file mode/);
  assert.equal(fs.statSync(f.settings).mode & 0o777, 0o600); assert.equal(f.state.restarts, 0);
  assert.throws(() => f.runtime().apply({ ...f.c, settingsMode: 0o666 }, f.packet), /CONTRACT_INVALID/);
});

for (const point of ["backups-and-intent-durable", "lease-published", "artifact-published", "settings-published",
  "restart-intent-durable", "restart-returned-before-receipt", "soaking-durable"]) {
  test(`fresh installer recovers crash at ${point} without blind restart`, t => {
    const f = fixture(t); f.state.fail = point;
    assert.throws(() => f.runtime().apply(f.c, f.packet), /SYNTHETIC_CRASH/);
    if (point === "backups-and-intent-durable") {
      assert.equal(fs.existsSync(f.lease), false); assert.equal(sha(fs.readFileSync(f.settings)), f.c.settingsSha256);
      assert.equal(f.state.restarts, 0); assert.equal(f.runtime().apply(f.c, f.packet).state, "SOAKING"); return;
    }
    const uncertain = JSON.parse(fs.readFileSync(f.lease)).phase === "RESTART_INTENT";
    if (uncertain) assert.throws(() => f.runtime().rollback(f.c), /EXPLICIT_RESTART_RECOVERY_REQUIRED/);
    const result = f.runtime().rollback(f.c, { restartQuiesced: uncertain, recoveryProcess: f.state.process });
    assert.equal(result.state, "ROLLED_BACK"); assert.equal(sha(fs.readFileSync(f.settings)), f.c.settingsSha256);
    assert.equal(f.state.restarts, ["restart-returned-before-receipt", "soaking-durable"].includes(point) ? 2 : 0);
    assert.equal(fs.existsSync(f.lease), false);
  });
}

for (const point of ["rollback-intent-durable", "baseline-settings-restored", "rollback-restart-intent-durable",
  "rollback-restart-returned-before-receipt", "rollback-verified-durable", "finish-receipt-durable",
  "lease-unlinked-before-directory-sync", "lease-released"]) {
  test(`rollback resumes crash at ${point} exactly once per proven restart`, t => {
    const f = fixture(t); f.runtime().apply(f.c, f.packet); f.state.fail = point;
    assert.throws(() => f.runtime().rollback(f.c), /SYNTHETIC_CRASH/);
    const result = f.runtime().rollback(f.c, { restartQuiesced: true, recoveryProcess: f.state.process });
    assert.equal(result.state, "ROLLED_BACK"); assert.equal(f.state.restarts, 2);
    assert.equal(sha(fs.readFileSync(f.settings)), f.c.settingsSha256); assert.equal(fs.existsSync(f.lease), false);
  });
}

for (const fail of ["before", "after"]) test(`restart ${fail}-effect failure retains lease and needs explicit recovery`, t => {
  const f = fixture(t); f.state.restartFail = fail;
  assert.throws(() => f.runtime().apply(f.c, f.packet), /SYNTHETIC_RESTART_UNKNOWN/); assert(fs.existsSync(f.lease));
  const n = f.state.restarts; assert.throws(() => f.runtime().apply(f.c, f.packet), /LEASE_PRESENT/); assert.equal(f.state.restarts, n);
  assert.throws(() => f.runtime().rollback(f.c), /EXPLICIT_RESTART_RECOVERY_REQUIRED/);
  f.state.restartFail = null;
  assert.equal(f.runtime().rollback(f.c, { restartQuiesced: true, recoveryProcess: f.state.process }).state, "ROLLED_BACK");
});

test("failed startup with an offline process needs explicit quiesced recovery before baseline restart", t => {
  const f = fixture(t); f.state.restartFail = "offline";
  assert.throws(() => f.runtime().apply(f.c, f.packet), /SYNTHETIC_RESTART_UNKNOWN/);
  assert.equal(f.state.process.status, "errored"); assert.equal(f.state.process.pid, 0);
  assert.throws(() => f.runtime().rollback(f.c), /EXPLICIT_RESTART_RECOVERY_REQUIRED/);
  f.state.restartFail = null;
  assert.equal(f.runtime().rollback(f.c, { restartQuiesced: true, recoveryProcess: f.state.process }).state, "ROLLED_BACK");
  assert.equal(f.state.restarts, 2); assert.equal(f.state.process.status, "online");
});

test("failed baseline startup stays blocked and its explicit retry survives another crash", t => {
  const f = fixture(t); f.runtime().apply(f.c, f.packet); f.state.restartFail = "offline";
  assert.throws(() => f.runtime().rollback(f.c), /SYNTHETIC_RESTART_UNKNOWN/); assert(fs.existsSync(f.lease));
  assert.throws(() => f.runtime().rollback(f.c), /EXPLICIT_RESTART_RECOVERY_REQUIRED/);
  f.state.restartFail = null; f.state.fail = "baseline-settings-restored";
  assert.throws(() => f.runtime().rollback(f.c, { restartQuiesced: true, recoveryProcess: f.state.process }), /SYNTHETIC_CRASH/);
  assert.equal(f.runtime().rollback(f.c).state, "ROLLED_BACK"); assert.equal(f.state.restarts, 3);
});

test("registration failure and artifact corruption never become successful activation", t => {
  const f = fixture(t); f.state.registrationFail = true;
  assert.throws(() => f.runtime().apply(f.c, f.packet), /REGISTRATION_TIMEOUT/);
  assert.equal(JSON.parse(fs.readFileSync(f.lease)).phase, "RESTART_INTENT");
  assert.equal(f.runtime().rollback(f.c, { restartQuiesced: true, recoveryProcess: f.state.process }).state, "ROLLED_BACK");
});

test("delayed registration reaches SOAKING after one restart while preserving the same PID/count", t => {
  const f = fixture(t); f.state.registrationDelayMs = 300;
  assert.equal(f.runtime().apply(f.c, f.packet).state, "SOAKING");
  assert.equal(f.state.restarts, 1); assert.equal(f.state.time, f.c.createdAtMs + 300);
});

test("registration timeout retains the lease and late registration forward-resumes without restart", t => {
  const f = fixture(t); f.state.registrationDelayMs = 1500;
  assert.throws(() => f.runtime().apply(f.c, f.packet), /REGISTRATION_TIMEOUT/);
  assert.equal(f.state.restarts, 1); assert(fs.existsSync(f.lease));
  assert.throws(() => f.runtime().apply(f.c, f.packet), /LEASE_PRESENT/);
  assert.equal(f.runtime().resume(f.c).state, "SOAKING"); assert.equal(f.state.restarts, 1);
  const until = JSON.parse(fs.readFileSync(f.lease)).soakUntilMs;
  assert.equal(f.runtime().resume(f.c).soakUntilMs, until); assert.equal(f.state.restarts, 1);
});

test("wrong registration and process drift retain custody and never trigger a retry", t => {
  const wrong = fixture(t); wrong.state.registrationWrong = true;
  assert.throws(() => wrong.runtime().apply(wrong.c, wrong.packet), /REGISTRATION_NOT_PROVEN/);
  assert(fs.existsSync(wrong.lease)); assert.equal(wrong.state.restarts, 1);
  const drift = fixture(t); drift.state.registrationDelayMs = 300; drift.state.onWait = () => { drift.state.process.pid++; };
  assert.throws(() => drift.runtime().apply(drift.c, drift.packet), /PROCESS_DRIFT/);
  assert(fs.existsSync(drift.lease)); assert.equal(drift.state.restarts, 1);
  assert.throws(() => drift.runtime().resume(drift.c), /PROCESS_DRIFT/);
});

for (const receiptOverrides of [{ pid: 999 }, { bundleSha256: "f".repeat(64) }, { registered: false }]) {
  test(`registration identity mismatch ${Object.keys(receiptOverrides)[0]} preserves the lease`, t => {
    const f = fixture(t); f.state.receiptOverrides = receiptOverrides;
    assert.throws(() => f.runtime().apply(f.c, f.packet), /REGISTRATION_NOT_PROVEN/);
    assert(fs.existsSync(f.lease)); assert.equal(f.state.restarts, 1);
  });
}

test("artifact corruption fails finish but does not prevent safe settings rollback", t => {
  const f = fixture(t); f.runtime().apply(f.c, f.packet); f.state.time += 900_001;
  fs.writeFileSync(path.join(f.releases, f.c.bundleSha256, "observer.cjs"), "corrupt");
  assert.throws(() => f.runtime().finish(f.c), /ARTIFACT_DRIFT/); assert(fs.existsSync(f.lease));
  assert.equal(f.runtime().rollback(f.c).state, "ROLLED_BACK"); assert.equal(f.state.restarts, 2);
});

test("forward resume of a restart-return crash requires a settled explicit new-process identity", t => {
  const f = fixture(t); f.state.fail = "restart-returned-before-receipt";
  assert.throws(() => f.runtime().apply(f.c, f.packet), /SYNTHETIC_CRASH/);
  assert.throws(() => f.runtime().resume(f.c), /EXPLICIT_RESTART_RECOVERY_REQUIRED/);
  assert.equal(f.runtime().resume(f.c, { restartQuiesced: true, recoveryProcess: f.state.process }).state, "SOAKING");
  assert.equal(f.state.restarts, 1);
});

test("a poll returning past deadline does not count as bounded registration success", t => {
  const f = fixture(t), inspect = f.options.pm2.inspect; let callsAfterRestart = 0;
  f.options.pm2.inspect = (...args) => {
    if (f.state.restarts && ++callsAfterRestart === 2) f.state.time += 1001;
    return inspect(...args);
  };
  assert.throws(() => f.runtime().apply(f.c, f.packet), /REGISTRATION_TIMEOUT/);
  assert(fs.existsSync(f.lease)); assert.equal(f.state.restarts, 1);
  assert.equal(f.runtime().resume(f.c).state, "SOAKING"); assert.equal(f.state.restarts, 1);
});

for (const drift of ["settings", "flow", "process", "machine", "lease", "backup"]) {
  test(`foreign ${drift} drift is not overwritten or restarted`, t => {
    const f = fixture(t); f.runtime().apply(f.c, f.packet);
    if (drift === "settings") fs.writeFileSync(f.settings, "foreign");
    if (drift === "flow") fs.writeFileSync(f.flowPath, "[]");
    if (drift === "process") f.state.process.pid++;
    if (drift === "machine") f.options.machineSha256 = "e".repeat(64);
    if (drift === "lease") { const l = JSON.parse(fs.readFileSync(f.lease)); l.generation = "f".repeat(32); fs.writeFileSync(f.lease, JSON.stringify(l)); }
    if (drift === "backup") fs.writeFileSync(path.join(f.tx, "settings.before.js"), "foreign");
    const before = fs.readFileSync(f.settings), lease = fs.readFileSync(f.lease);
    assert.throws(() => f.runtime().rollback(f.c));
    assert.equal(f.state.restarts, 1); assert(fs.readFileSync(f.settings).equals(before)); assert(fs.readFileSync(f.lease).equals(lease));
  });
}

test("foreign/expired lease, unsafe modes, symlinks, missing lock and stale packet fail before publication", t => {
  const f = fixture(t); fs.writeFileSync(f.lease, JSON.stringify({ formatVersion: 2, phase: "soaking", expiresAtMs: 0 }), { mode: 0o600 });
  const lease = fs.readFileSync(f.lease); assert.throws(() => f.runtime().apply(f.c, f.packet), /LEASE_PRESENT/);
  assert(fs.readFileSync(f.lease).equals(lease)); fs.unlinkSync(f.lease);
  f.state.lock = false; assert.throws(() => f.runtime().apply(f.c, f.packet), /NO_KERNEL_LOCK/); f.state.lock = true;
  f.state.time += 1_800_001; assert.throws(() => f.runtime().apply(f.c, f.packet), /STALE/); f.state.time = f.c.createdAtMs;
  fs.chmodSync(f.settings, 0o644); assert.throws(() => f.runtime().apply(f.c, f.packet), /Protected file mode/); fs.chmodSync(f.settings, 0o600);
  fs.renameSync(f.settings, f.settings + ".real"); fs.symlinkSync(f.settings + ".real", f.settings);
  assert.throws(() => f.runtime().apply(f.c, f.packet), /Protected file/); assert.equal(f.state.restarts, 0);
});

test("source-restored but new process still requires a guarded baseline restart", t => {
  const f = fixture(t); f.runtime().apply(f.c, f.packet); f.state.fail = "baseline-settings-restored";
  assert.throws(() => f.runtime().rollback(f.c), /SYNTHETIC_CRASH/); assert.equal(f.state.restarts, 1);
  assert.equal(sha(fs.readFileSync(f.settings)), f.c.settingsSha256);
  assert.equal(f.runtime().rollback(f.c).state, "ROLLED_BACK"); assert.equal(f.state.restarts, 2);
});

test("finish receipt cannot clear a later foreign lease", t => {
  const f = fixture(t); f.runtime().apply(f.c, f.packet); f.state.time += 900_001;
  f.runtime().finish(f.c); const foreign = Buffer.from('{"formatVersion":2,"phase":"soaking"}');
  fs.writeFileSync(f.lease, foreign, { mode: 0o600 });
  assert.throws(() => f.runtime().finish(f.c), /FOREIGN_LEASE/); assert(fs.readFileSync(f.lease).equals(foreign));
});

for (const point of [null, "deactivation-intent-durable", "rollback-lease-reacquired", "baseline-settings-restored",
  "rollback-restart-returned-before-receipt", "finish-receipt-durable"]) test(`delayed rollback after finish remains guarded and resumable (${point})`, t => {
  const f = fixture(t); f.runtime().apply(f.c, f.packet); f.state.time += 900_001; f.runtime().finish(f.c);
  if (point) { f.state.fail = point; assert.throws(() => f.runtime().rollback(f.c), /SYNTHETIC_CRASH/); }
  const result = f.runtime().rollback(f.c, { restartQuiesced: true, recoveryProcess: f.state.process });
  assert.equal(result.state, "ROLLED_BACK"); assert.equal(f.state.restarts, 2);
  assert.equal(sha(fs.readFileSync(f.settings)), f.c.settingsSha256); assert.equal(fs.existsSync(f.lease), false);
});

test("pending delayed rollback cannot be mistaken for an idempotent installed result", t => {
  const f = fixture(t); f.runtime().apply(f.c, f.packet); f.state.time += 900_001; f.runtime().finish(f.c);
  f.state.fail = "deactivation-intent-durable"; assert.throws(() => f.runtime().rollback(f.c), /SYNTHETIC_CRASH/);
  assert.throws(() => f.runtime().finish(f.c), /ROLLBACK_PENDING_USE_ROLLBACK/);
  assert.throws(() => f.runtime().apply(f.c, f.packet), /ROLLBACK_PENDING_USE_ROLLBACK/);
});

test("delayed rollback does not write an intent or clear a foreign lease", t => {
  const f = fixture(t); f.runtime().apply(f.c, f.packet); f.state.time += 900_001; f.runtime().finish(f.c);
  const foreign = Buffer.from('{"formatVersion":2}'); fs.writeFileSync(f.lease, foreign, { mode: 0o600 });
  assert.throws(() => f.runtime().rollback(f.c), /FOREIGN_LEASE/);
  assert(fs.readFileSync(f.lease).equals(foreign)); assert.equal(fs.existsSync(path.join(f.tx, "deactivation.intent.json")), false);
  assert.equal(f.state.restarts, 1);
});

test("candidate reappearance after rollback verification cannot release the lease", t => {
  const f = fixture(t); f.runtime().apply(f.c, f.packet); f.state.fail = "rollback-verified-durable";
  assert.throws(() => f.runtime().rollback(f.c), /SYNTHETIC_CRASH/); fs.writeFileSync(f.settings, f.after);
  assert.throws(() => f.runtime().rollback(f.c), /SETTINGS_DRIFT/); assert(fs.existsSync(f.lease)); assert.equal(f.state.restarts, 2);
});

test("settings rename directory-fsync failure remains recoverable without restart", t => {
  const f = fixture(t), rename = fs.renameSync, sync = fs.fsyncSync; let renamed = false, failed = false;
  fs.renameSync = (a, b) => { rename(a, b); if (b === f.settings) renamed = true; };
  fs.fsyncSync = fd => {
    if (renamed && !failed && fs.fstatSync(fd).isDirectory()) { failed = true; throw Error("SYNTHETIC_FSYNC"); } return sync(fd);
  };
  try { assert.throws(() => f.runtime().apply(f.c, f.packet), /SYNTHETIC_FSYNC/); }
  finally { fs.renameSync = rename; fs.fsyncSync = sync; }
  assert.equal(f.runtime().rollback(f.c).state, "ROLLED_BACK"); assert.equal(f.state.restarts, 0);
});

test("rollback retains pre-existing same-hash immutable artifact and private evidence", t => {
  const f = fixture(t), dir = path.join(f.releases, f.c.bundleSha256); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(f.releases, 0o700); fs.writeFileSync(path.join(dir, "observer.cjs"), f.bundle, { mode: 0o600 });
  f.runtime().apply(f.c, f.packet); f.runtime().rollback(f.c);
  assert(fs.readFileSync(path.join(dir, "observer.cjs")).equals(f.bundle)); assert(fs.existsSync(path.join(f.tx, "finish.json")));
});

for (const boundary of ["lease-link", "settings-rename"]) test(`SIGKILL at ${boundary} is recoverable by the owning installer only`, t => {
  const f = fixture(t), input = path.join(f.root, "child-fixture.json");
  fs.writeFileSync(input, JSON.stringify({ c: f.c, root: f.root, releases: f.releases,
    bundle: f.bundle.toString("base64"), before: f.before.toString("base64"), after: f.after.toString("base64") }));
  const module = new URL("../diagnostics/gamepatch409-installer.mjs", import.meta.url).href;
  const script = `import fs from 'node:fs'; import {createGamePatch409Installer} from ${JSON.stringify(module)};
    const f=JSON.parse(fs.readFileSync(process.argv[1]));
    const link=fs.linkSync, rename=fs.renameSync;
    fs.linkSync=(a,b)=>{link(a,b);if(${JSON.stringify(boundary)}==='lease-link'&&b.endsWith(${JSON.stringify(LEASE_NAME)}))process.kill(process.pid,'SIGKILL');};
    fs.renameSync=(a,b)=>{rename(a,b);if(${JSON.stringify(boundary)}==='settings-rename'&&b===f.root+'/settings.js')process.kill(process.pid,'SIGKILL');};
    createGamePatch409Installer({root:f.root,releases:f.releases,uid:process.getuid(),gid:process.getgid(),
      machineSha256:f.c.machineSha256,assertLock(){},now:()=>f.c.createdAtMs,
      pm2:{inspect:()=>f.c.process,restart(){throw Error('not reached');}}}).apply(f.c,
      {bundle:Buffer.from(f.bundle,'base64'),beforeSettings:Buffer.from(f.before,'base64'),afterSettings:Buffer.from(f.after,'base64')});`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, input], { encoding: "utf8" });
  assert.equal(result.signal, "SIGKILL", result.stderr);
  if (boundary === "lease-link") assert.equal(fs.statSync(f.lease).nlink, 2);
  assert.equal(f.runtime().rollback(f.c).state, "ROLLED_BACK"); assert.equal(f.state.restarts, 0);
  assert.equal(sha(fs.readFileSync(f.settings)), f.c.settingsSha256);
});

test("settings suffix preserves auth/middleware, rejects bad module BEFORE require and fails open", t => {
  const f = fixture(t), logs = [], box = { exports: {} }; let executed = false;
  vm.runInNewContext(f.after.toString(), { module: box, process, console: { warn: s => logs.push(JSON.parse(s)) },
    require(name) { if (name.startsWith("node:")) return createRequire(import.meta.url)(name); executed = true; throw Error("must not load"); } });
  assert.equal(executed, false); assert.equal(box.exports.adminAuth.type, "credentials"); assert.equal(box.exports.functionGlobalContext.existing, 17);
  assert.equal(box.exports.functionGlobalContext.lkDiagnostics, undefined); assert.equal(logs[0].code, "OBSERVER_UNAVAILABLE");
  const baseline = { functionGlobalContext: { existing: 17 } }, original = baseline.functionGlobalContext;
  assert.throws(() => registerSettings(baseline, { receiptPath: path.join(f.root, "missing", "ready.json"), generation, bundleSha256: f.c.bundleSha256, release, sink() {} }));
  assert.equal(baseline.functionGlobalContext, original);
});

test("build produces a standalone CJS packet; bootstrap registration is attested without fake409 logs", async t => {
  const f = fixture(t), artifacts = await buildRuntimeArtifacts();
  const data = packetContents({ settings: f.before, flow: fs.readFileSync(f.flowPath), metadata: { sourceKind: "live-147", sourceHost: "lk-primary-147",
    settingsSha256: f.c.settingsSha256, flowSha256: f.c.flowSha256, machineSha256: f.c.machineSha256, hooks: f.c.hooks,
    process: f.c.process, settingsMode: f.c.settingsMode, preservedFiles: [], collectedAtMs: f.c.createdAtMs, coordinatedRestartApproved: true }, release, artifacts, generation, root: f.root, releases: f.releases });
  const c = JSON.parse(data["contract.json"]), dir = path.join(f.releases, c.bundleSha256); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const artifact = path.join(dir, "observer.cjs"); fs.writeFileSync(artifact, data["observer.cjs"], { mode: 0o600 });
  fs.mkdirSync(f.tx, { recursive: true, mode: 0o700 });
  const logs = [], box = { exports: {} };
  vm.runInNewContext(data["settings.after.js"].toString(), { module: box, process, console: { warn: s => logs.push(s) }, require: createRequire(import.meta.url) });
  assert.equal(typeof box.exports.functionGlobalContext.lkDiagnostics.observe, "function"); assert.equal(logs.length, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.tx, "ready.json"))).pid, process.pid);
  box.exports.functionGlobalContext.lkDiagnostics.dispose();
  const installer = path.join(f.root, "installer.cjs"); fs.writeFileSync(installer, data["installer.cjs"]);
  const probe = spawnSync(process.execPath, [installer], { encoding: "utf8" }); assert.equal(probe.status, 1); assert.match(probe.stderr, /USAGE_INVALID/);
  assert.equal(sha(data["installer.cjs"]), c.installerSha256);
});

test("PM2 adapter pins process, uses no update-env and never retries a timed out restart", () => {
  const calls = []; const adapter = createProcessAdapter((cmd, args) => {
    calls.push([cmd, args]); if (args[0] === "jlist") return { status: 0, stdout: JSON.stringify([{ name: "node-red", pid: 1, pm2_env: { status: "online", restart_time: 4 } }]) };
    return { error: Error("timeout"), status: null };
  });
  assert.throws(() => adapter.restart(4), /RESTART_OUTCOME_UNKNOWN/); assert.deepEqual(calls[1], ["pm2", ["restart", "node-red"]]); assert.equal(calls.length, 2);
});

test("kernel flock cannot be forged with a caller marker", { skip: process.platform !== "linux" }, t => {
  const f = fixture(t), lock = path.join(f.root, "shared.lock"); fs.writeFileSync(lock, "", { mode: 0o600 });
  assert.throws(() => assertKernelFlock(lock, { uid, gid }), /SHARED_KERNEL_LOCK_REQUIRED/);
  const module = new URL("../diagnostics/gamepatch409-lock.mjs", import.meta.url).href;
  const result = spawnSync("flock", ["-n", "-F", lock, process.execPath, "--input-type=module", "-e",
    `import {assertKernelFlock} from ${JSON.stringify(module)}; assertKernelFlock(${JSON.stringify(lock)}, {uid:${uid},gid:${gid}});`], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("contract/settings builder never accepts an existing observer or different target", t => {
  const f = fixture(t); assert.throws(() => settingsCandidate(Buffer.from('module.exports={functionGlobalContext:{lkDiagnostics:{}}};'),
    { generation, bundleSha256: f.c.bundleSha256, release }), /SETTINGS_INPUT_INVALID/);
  assert.throws(() => f.runtime().apply({ ...f.c, target: "other" }, f.packet), /CONTRACT_INVALID/);
  assert.equal(ROOT, "/root/.node-red");
});

test('both PATCH aliases must reach the pinned authorize/ACK sources', t => {
  const f = fixture(t), nodes = JSON.parse(fs.readFileSync(f.flowPath));
  nodes.find(n => n.id === 'alias').wires = [];
  const bytes = Buffer.from(JSON.stringify(nodes)); fs.writeFileSync(f.flowPath, bytes);
  assert.throws(() => f.runtime().apply({ ...f.c, flowSha256: sha(bytes) }, f.packet), /HOOK_SOURCE_DRIFT/);
  assert.equal(f.state.restarts, 0); assert.equal(fs.existsSync(f.lease), false);
});

test('scoped observer accepts only game PATCH conflicts, preserves claims, never retains payload', () => {
  const events = [], observer = createScopedObserver({ release, sink: e => events.push(e) });
  const op = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  for (const path of ['/lk/games/PRIVATE_SENTINEL', '/lk/games/records/PRIVATE_SENTINEL']) {
    const req = { method: 'PATCH', path, originalUrl: `${path}?__lk_diag_build=${release}&__lk_diag_op=${op}&token=PRIVATE_SENTINEL` };
    const msg = { req, payload: { acknowledged: true, matchedCount: 0, secret: 'PRIVATE_SENTINEL' }, _partnerRosterPatch: { preimage: {} } };
    const before = structuredClone(msg);
    for (const [stage, code] of [['roster_authorize', 'GAME_ROSTER_BINDING_UNKNOWN'], ['roster_authorize', 'GAME_PATCH_VERSION_CONFLICT'], ['roster_ack', 'GAME_PATCH_VERSION_CONFLICT']]) {
      observer.observe(msg, stage, { code, httpStatus: 409 });
    }
    for (const status of [200, 400, 403, 428, 503]) observer.observe(msg, 'roster_ack', { code: 'GAME_PATCH_VERSION_CONFLICT', httpStatus: status });
    for (const method of ['GET', 'POST', 'DELETE']) observer.observe({ ...msg, req: { ...req, method } }, 'roster_authorize', { code: 'GAME_PATCH_VERSION_CONFLICT', httpStatus: 409 });
    observer.observe({ ...msg, req: { ...req, path: '/lk/subscription-bookings' } }, 'roster_authorize', { code: 'GAME_PATCH_VERSION_CONFLICT', httpStatus: 409 });
    observer.observe(msg, 'booking_finalize', { code: 'GAME_PATCH_VERSION_CONFLICT', httpStatus: 409 });
    assert.deepEqual(msg, before);
  }
  assert.equal(events.length, 6);
  assert.deepEqual(events.map(e => e.patchConflictStage), ['binding', 'precondition', 'cas', 'binding', 'precondition', 'cas']);
  assert(events.every(e => e.callerBuild === release && e.logicalOperation === op && !e.entityRef && !e.operationRef));
  assert(!JSON.stringify(events).includes('PRIVATE_SENTINEL')); observer.dispose();
});

test('scoped failures are bounded and a throwing sink cannot affect callers', () => {
  const events = [], observer = createScopedObserver({ release, detailLimit: 1, sink: e => events.push(e) });
  const msg = { req: { method: 'PATCH', path: '/lk/games/fixture' } }, fields = { code: 'GAME_PATCH_VERSION_CONFLICT', httpStatus: 409 };
  observer.observe(msg, 'roster_authorize', fields); observer.observe(msg, 'roster_authorize', fields); observer.flushSuppressed();
  assert.equal(events.filter(e => e.httpStatus === 409).length, 1);
  assert.equal(events.find(e => e.eventKind === 'suppression').suppressedCount, 1); observer.dispose();
  const broken = createScopedObserver({ sink() { throw Error('private'); } });
  assert.doesNotThrow(() => broken.observe(msg, 'roster_authorize', fields)); assert.equal(broken.snapshot().loggerFailures, 1); broken.dispose();
});

test('a committed READY receipt keeps its observer when directory fsync fails', t => {
  const f = fixture(t), ready = path.join(f.root, 'ready.json'), settings = { functionGlobalContext: { existing: 17 } };
  const original = fs.fsyncSync;
  fs.fsyncSync = fd => { if (fs.fstatSync(fd).isDirectory()) throw Error('synthetic fsync'); return original(fd); };
  try { assert.equal(registerSettings(settings, { receiptPath: ready, generation, release, bundleSha256: f.c.bundleSha256, sink() {} }), true); }
  finally { fs.fsyncSync = original; }
  assert.equal(JSON.parse(fs.readFileSync(ready)).registered, true); assert.equal(settings.functionGlobalContext.lkDiagnostics.scope, 'GAME_PATCH_409_V1');
  assert.equal(settings.functionGlobalContext.existing, 17); settings.functionGlobalContext.lkDiagnostics.dispose();
});

test('hook packet changes exactly two pinned functions and requires both reachable routes', t => {
  const f = fixture(t), dir = path.join(f.root, 'scripts/nodered_partner_roster_nodes'); fs.mkdirSync(dir, { recursive: true });
  const bare = 'return [msg, null];', nodes = [{ id: 'tab', type: 'tab' }];
  for (const [name, next] of [['authorize', 'partner_roster_ack_20261012'], ['ack', null]]) {
    fs.writeFileSync(path.join(dir, `fn_${name}.js`), `// sourceHash: "${sha(bare)}"\n${bare}`);
    nodes.push({ id: `partner_roster_${name}_20261012`, z: 'tab', type: 'function', func: bare, wires: next ? [[next]] : [] });
  }
  for (const [id, url] of [['direct', '/lk/games/:gameId'], ['alias', '/lk/games/records/:gameId']]) {
    nodes.push({ id, z: 'tab', type: 'http in', method: 'patch', url, wires: [['partner_roster_authorize_20261012']] });
  }
  const packet = prepareGamePatchHooks(Buffer.from(JSON.stringify(nodes)), f.root);
  assert.equal(packet.contract.allowedChanges.length, 2);
  for (const route of nodes.filter(n => n.type === 'http in')) assert.deepEqual(JSON.parse(packet.candidateBytes).find(n => n.id === route.id), route);
  nodes.find(n => n.id === 'alias').wires = [];
  assert.throws(() => prepareGamePatchHooks(Buffer.from(JSON.stringify(nodes)), f.root), /DIAGNOSTIC_ROUTE_BINDING_UNKNOWN/);
  nodes.find(n => n.id === 'alias').d = true;
  assert.throws(() => prepareGamePatchHooks(Buffer.from(JSON.stringify(nodes)), f.root), /PATCH_ROUTE_DRIFT/);
});
