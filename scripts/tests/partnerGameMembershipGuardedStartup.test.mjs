import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import auditModule from "../partner_game_membership_sidecar/raw-audit.cjs";
import startup from "../partner_game_membership_sidecar/guarded-startup.cjs";
import { buildPartnerGameMembershipApiSidecarCandidate } from "../patch_partner_game_membership_api_flow.mjs";

const { openPartnerRawAudit: open } = auditModule;
const event = { stage: "RAW_REQUEST_GUARD", code: "RAW_ACCEPTED", requestId: "ad9c3a09-2022-4aab-9e01-08037061b001" };
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "partner-guard-unit-"));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const state = path.join(root, "state"); fs.mkdirSync(state, { mode: 0o700 });
  const sidecar = path.join(root, "sidecar"); fs.mkdirSync(sidecar);
  const settings = path.join(sidecar, "settings-runtime.cjs"); fs.writeFileSync(settings, '"use strict";\n');
  const candidate = path.join(root, "candidate.flow.json");
  const bytes = Buffer.from(JSON.stringify(buildPartnerGameMembershipApiSidecarCandidate().flow, null, 2) + "\n");
  fs.writeFileSync(candidate, bytes);
  const policy = path.join(sidecar, "guarded-runtime-policy.json");
  fs.writeFileSync(policy, JSON.stringify({ formatVersion: 1, mode: "DEFAULT_OFF_UNBOUND", expectedHost: "unbound.invalid", candidateFlowSha256: sha(bytes) }));
  return { root, state, sidecar, candidate, bytes, policy,
    input: { sidecarDirectory: sidecar, argv: ["--userDir", state, "--settings", settings, candidate],
      env: { LK_PARTNER_GAME_API_ENABLED: "false", LK_PARTNER_GAME_API_PROVIDER_MODE: "disabled", LK_PARTNER_GAME_API_VIVA_MUTATIONS_ENABLED: "false" } } };
}
const unavailable = (fn) => assert.throws(fn, /^Error: RAW_AUDIT_STORAGE_UNAVAILABLE$/);
const refused = (fn) => assert.throws(fn, /^Error: PARTNER_GUARDED_STARTUP_REFUSED$/);
test("durable private audit reopens, contains only fixed metadata and owns exclusive lock", (t) => {
  const f = fixture(t); const a = open({ directory: f.state });
  unavailable(() => open({ directory: f.state }));
  assert.equal(a.write(event), true);
  const file = path.join(f.state, "raw-requests.audit.jsonl");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const row = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(row), ["at", "stage", "code", "requestId"]);
  assert.deepEqual({ ...row, at: undefined }, { ...event, at: undefined });
  a.close(); assert.equal(a.write(event), false);
  assert.equal(fs.existsSync(path.join(f.state, "raw-requests.audit.lock")), false);
  const b = open({ directory: f.state }); assert.equal(b.write(event), true); b.close();
  assert.equal(fs.readFileSync(file, "utf8").trim().split("\n").length, 2);
});
for (const mode of [0o755, 0o750, 0o770]) test(`audit refuses non-private directory ${mode}`, (t) => {
  const f = fixture(t); fs.chmodSync(f.state, mode); unavailable(() => open({ directory: f.state }));
});
for (const kind of ["symlink", "hardlink", "fifo", "permissions", "truncated", "invalid", "extra-field"]) test(`audit refuses unsafe existing log: ${kind}`, (t) => {
  const f = fixture(t); const log = path.join(f.state, "raw-requests.audit.jsonl");
  const target = path.join(f.root, "target"); fs.writeFileSync(target, "", { mode: 0o600 });
  if (kind === "symlink") fs.symlinkSync(target, log);
  else if (kind === "hardlink") fs.linkSync(target, log);
  else if (kind === "fifo") execFileSync("mkfifo", [log]);
  else fs.writeFileSync(log, kind === "truncated" ? "{" : kind === "invalid" ? "{}\n"
    : kind === "extra-field" ? JSON.stringify({ at: new Date().toISOString(), ...event, token: "DO_NOT_LOG_ME" }) + "\n" : "", { mode: kind === "permissions" ? 0o644 : 0o600 });
  unavailable(() => open({ directory: f.state }));
});
for (const mutation of ["replace", "truncate", "permission", "lock-replace", "append"]) test(`audit latches closed after ${mutation}`, (t) => {
  const f = fixture(t); const a = open({ directory: f.state });
  assert.equal(a.write(event), true);
  const log = path.join(f.state, "raw-requests.audit.jsonl");
  if (mutation === "replace") { fs.renameSync(log, `${log}.old`); fs.writeFileSync(log, "", { mode: 0o600 }); }
  if (mutation === "truncate") fs.truncateSync(log, 0);
  if (mutation === "permission") fs.chmodSync(log, 0o644);
  if (mutation === "append") fs.appendFileSync(log, "\n");
  if (mutation === "lock-replace") { const lock = path.join(f.state, "raw-requests.audit.lock"); fs.renameSync(lock, `${lock}.old`); fs.writeFileSync(lock, "", { mode: 0o600 }); }
  assert.equal(a.write(event), false); assert.equal(a.write(event), false);
  if (mutation === "lock-replace") unavailable(() => a.close()); else a.close();
});
for (const failure of ["short-write", "enospc", "fsync"]) test(`audit fails closed on ${failure} without automatic retry`, (t) => {
  const f = fixture(t); let fail = false; let calls = 0;
  const io = { ...fs,
    writeSync: (...args) => { if (!fail) return fs.writeSync(...args); calls++;
      if (failure === "enospc") throw new Error("ENOSPC DO_NOT_LOG_ME");
      if (failure === "short-write") return fs.writeSync(args[0], args[1].subarray(0, 4));
      return fs.writeSync(...args); },
    fsyncSync: (...args) => { if (fail && failure === "fsync") throw new Error("EIO DO_NOT_LOG_ME"); return fs.fsyncSync(...args); },
  };
  const a = open({ directory: f.state, io }); fail = true;
  assert.equal(a.write(event), false); assert.equal(calls, 1);
  fail = false; assert.equal(a.write(event), false); assert.equal(calls, 1); a.close();
  if (failure === "short-write") unavailable(() => open({ directory: f.state }));
});
test("audit has exact byte cap and rejects unknown metadata without writing it", (t) => {
  const f = fixture(t); const rowBytes = Buffer.byteLength(JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n");
  const a = open({ directory: f.state, maxBytes: rowBytes * 2 });
  assert.equal(a.write(event), true); assert.equal(a.write(event), true); assert.equal(a.write(event), false); a.close();
  const b = open({ directory: f.state });
  assert.equal(b.write({ ...event, secret: "DO_NOT_LOG_ME" }), false); assert.equal(b.write(event), false); b.close();
  const text = fs.readFileSync(path.join(f.state, "raw-requests.audit.jsonl"), "utf8");
  assert.equal(Buffer.byteLength(text), rowBytes * 2); assert.doesNotMatch(text, /DO_NOT_LOG_ME/);
});
test("guarded startup binds actual CLI candidate bytes to immutable storage snapshot", async (t) => {
  const f = fixture(t); const input = startup.validateGuardedStartup(f.input);
  assert.equal(input.expectedHost, "unbound.invalid"); assert.deepEqual(input.candidateBytes, f.bytes);
  const storage = startup.createPinnedFlowStorage(input.candidateBytes, {});
  input.candidateBytes.fill(0); fs.writeFileSync(f.candidate, "[]");
  const flows = await storage.getFlows(); flows[0].id = "MUTATED";
  assert.deepEqual(await storage.getFlows(), JSON.parse(f.bytes));
  assert.deepEqual(await storage.getCredentials(), {});
  for (const name of ["saveFlows", "saveCredentials", "getLibraryEntry", "saveLibraryEntry"]) await assert.rejects(storage[name](), /PARTNER_IMMUTABLE_FLOW_WRITE_REFUSED/);
  assert.equal(storage.projects, undefined);
});
test("current symlink CLI resolves the release; later alias swap cannot replace captured graph", async (t) => {
  const f = fixture(t); const alias = path.join(f.root, "current"); fs.symlinkSync(f.root, alias);
  f.input.argv[3] = path.join(alias, "sidecar/settings-runtime.cjs");
  f.input.argv[4] = path.join(alias, "candidate.flow.json");
  const input = startup.validateGuardedStartup(f.input);
  const storage = startup.createPinnedFlowStorage(input.candidateBytes, {});
  fs.unlinkSync(alias); fs.symlinkSync(f.state, alias);
  assert.deepEqual(await storage.getFlows(), JSON.parse(f.bytes));
  refused(() => startup.validateGuardedStartup(f.input));
});
for (const arg of ["--safe", "--sa", "--define", "--def", "-D", "--userD", "--settings", "other.flow.json"]) test(`startup refuses extra CLI argument ${arg}`, (t) => {
  const f = fixture(t); f.input.argv.push(arg); refused(() => startup.validateGuardedStartup(f.input));
});
for (const name of ["NODE_OPTIONS", "NODE_PATH", "NODE_RED_ENABLE_SAFE_MODE", "NODE_RED_ENABLE_PROJECTS"]) {
  for (const value of ["true", "0", "1"]) test(`startup refuses ${name}=${value}`, (t) => {
    const f = fixture(t); f.input.env[name] = value; refused(() => startup.validateGuardedStartup(f.input));
  });
}
for (const name of ["LK_PARTNER_GAME_API_ENABLED", "LK_PARTNER_GAME_API_PROVIDER_MODE", "LK_PARTNER_GAME_API_VIVA_MUTATIONS_ENABLED"]) test(`startup refuses missing or changed ${name}`, (t) => {
  const f = fixture(t); delete f.input.env[name]; refused(() => startup.validateGuardedStartup(f.input));
  f.input.env[name] = "true"; refused(() => startup.validateGuardedStartup(f.input));
});
for (const mutation of ["digest", "symlink", "permissions", "alternate", "state-mode", "policy-extra", "policy-host", "skipBodyParsing", "upload"]) test(`startup refuses ${mutation}`, (t) => {
  const f = fixture(t);
  if (mutation === "digest") fs.appendFileSync(f.candidate, " ");
  if (mutation === "symlink") { fs.renameSync(f.candidate, `${f.candidate}.old`); fs.symlinkSync(`${f.candidate}.old`, f.candidate); }
  if (mutation === "permissions") fs.chmodSync(f.candidate, 0o666);
  if (mutation === "alternate") f.input.argv[4] = f.policy;
  if (mutation === "state-mode") fs.chmodSync(f.state, 0o755);
  const policy = JSON.parse(fs.readFileSync(f.policy));
  if (mutation === "policy-extra") policy.unknown = true;
  if (mutation === "policy-host") policy.expectedHost = "somewhere.invalid";
  if (["skipBodyParsing", "upload"].includes(mutation)) {
    const flow = JSON.parse(f.bytes); flow.find((node) => node.type === "http in")[mutation] = true;
    const bytes = JSON.stringify(flow); fs.writeFileSync(f.candidate, bytes); policy.candidateFlowSha256 = sha(bytes);
  }
  fs.writeFileSync(f.policy, JSON.stringify(policy)); refused(() => startup.validateGuardedStartup(f.input));
});
