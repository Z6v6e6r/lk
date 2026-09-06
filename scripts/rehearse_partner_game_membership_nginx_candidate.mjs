#!/usr/bin/env node
// Owned local fixture only: no downloads, public ports, host credentials or SSH.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { generatePartnerNginx124Candidate } from "./partner_game_membership_nginx_candidate.mjs";
import { createPartnerNginxTestCertificates } from "./tests/fixtures/partner-nginx124-certificates.mjs";
import { summarizeNginxRows } from "./tests/fixtures/partner-nginx124-evidence.cjs";

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--audited-runtime-root" || !path.isAbsolute(args[1])) throw new Error("Usage: --audited-runtime-root /absolute/owned-audit-output");
const auditRoot = fs.realpathSync(args[1]);
if (!path.basename(auditRoot).startsWith("partner-runtime-audit-") || fs.statSync(auditRoot).uid !== process.getuid() || (fs.statSync(auditRoot).mode & 0o777) !== 0o700) throw new Error("OWNED_AUDIT_ROOT_REQUIRED");
const auditReceipt = JSON.parse(fs.readFileSync(path.join(auditRoot, "results/receipt.json")));
if (auditReceipt.state !== "PASS_LOCAL_AUDIT_ONLY" || auditReceipt.containerPresentAfterCleanup !== false) throw new Error("COMPLETED_AUDIT_REQUIRED");
const runtime = path.join(auditRoot, "runtime");
const scripts = path.dirname(fileURLToPath(import.meta.url));
const nodeImage = "node@sha256:4d676821dff059fd00d277ee4261ef34ea712317fed0737c03941481b5760c96";
const nginxImage = "nginx@sha256:2e26275ed7a47e8e93f264d39a09ca4bc3f4058c904c75087e237f4ea883f2a1";
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const output = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "partner-nginx-candidate-")); fs.chmodSync(output, 0o700);
const fixture = path.join(output, "fixture"), results = path.join(output, "results"); fs.mkdirSync(results, { mode: 0o700 });
const sources = {}, copiedHashes = {};
let candidate, runtimeBefore;
function prepare() {
for (const relative of ["partner_game_membership_nginx_candidate.mjs", "rehearse_partner_game_membership_nginx_candidate.mjs", "tests/fixtures/partner-nginx124-certificates.mjs"]) {
  sources[relative] = sha(fs.readFileSync(path.join(scripts, relative)));
}
const binding = createPartnerNginxTestCertificates(fixture, { sourceLimits: true });
candidate = generatePartnerNginx124Candidate(binding);
assert.deepEqual(candidate.clientIdentities.map(item => item.bucket), ["fixture-client", "fixture-client-2", "fixture-client-3"]);
assert.equal(new Set(candidate.clientIdentities.map(item => item.spkiSha256)).size, 3);
fs.writeFileSync(path.join(fixture, "nginx.conf"), candidate.configuration, { mode: 0o600 });
for (const [name, relative] of Object.entries({
  "runner.cjs": "tests/fixtures/partner-nginx124-runtime.cjs", "http-response.cjs": "tests/fixtures/partner-http-response.cjs", "settings.cjs": "partner_game_membership_sidecar/settings.cjs",
  "evidence.cjs": "tests/fixtures/partner-nginx124-evidence.cjs",
  "settings-guarded.cjs": "partner_game_membership_sidecar/settings-guarded.cjs", "raw-request-guard.cjs": "partner_game_membership_sidecar/raw-request-guard.cjs",
})) { const bytes = fs.readFileSync(path.join(scripts, relative)); sources[relative] = sha(bytes); copiedHashes[name] = sha(bytes); fs.writeFileSync(path.join(fixture, name), bytes, { mode: 0o600 }); }
for (const name of ["package.json", "package-lock.json"]) assert.equal(sha(fs.readFileSync(path.join(runtime, name))), auditReceipt.sourceHashes[`partner_game_membership_runtime/${name}`]);
runtimeBefore = treeDigest();
Object.assign(receipt, { candidateSha256: candidate.configSha256, certificateHashes: candidate.certificateHashes,
  fixtureMode: "THREE_CLIENT_TWO_SOURCE_LOCAL", clientIdentities: candidate.clientIdentities,
  unresolvedControls: candidate.unresolvedControls, runtimeBeforeSha256: runtimeBefore });
}
const treeDigest = () => {
  const entries = [];
  function walk(relative = "") {
    for (const name of fs.readdirSync(path.join(runtime, relative)).sort()) {
      const rel = path.join(relative, name), target = path.join(runtime, rel), stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) { assert.ok(fs.realpathSync(target).startsWith(runtime + path.sep)); entries.push([rel, "link", fs.readlinkSync(target)]); }
      else if (stat.isDirectory()) walk(rel);
      else { assert.ok(stat.isFile()); entries.push([rel, stat.mode & 0o777, sha(fs.readFileSync(target))]); }
    }
  }
  walk(); return sha(Buffer.from(JSON.stringify(entries)));
};
const docker = (...command) => execFileSync("docker", command, { encoding: "utf8", timeout: 60000, maxBuffer: 2 * 1024 * 1024 }).trim();
const runId = crypto.randomBytes(16).toString("hex"), user = `${process.getuid()}:${process.getgid()}`, owned = [];
const receipt = { state: "STARTING", scope: "LOCAL_NGINX_124_GENERATED_CONFIG", runId, sources,
  auditReceiptSha256: sha(fs.readFileSync(path.join(auditRoot, "results/receipt.json"))),
  containers: [], cleanup: [], productionVerified: false, deployAuthorized: false, activationAuthorized: false };
const expected = new Map(); let failure, cleanupFailed = false;
const inspect = id => JSON.parse(docker("inspect", id))[0];
function verify(id) {
  const info = inspect(id), target = expected.get(id), host = info.HostConfig;
  assert.equal(info.Id, id); assert.equal(info.Config.Labels?.["padlhub.partner-nginx-candidate"], runId);
  assert.equal(info.Image, target.imageId); assert.equal(info.Config.Image, target.image);
  assert.equal(info.Config.User, user); assert.equal(host.NetworkMode, target.network);
  assert.equal(host.Privileged, false); assert.equal(host.ReadonlyRootfs, true); assert.deepEqual(host.CapDrop, ["ALL"]);
  assert.deepEqual(host.SecurityOpt, ["no-new-privileges"]); assert.equal(host.Memory, 512 * 1024 * 1024);
  assert.equal(host.NanoCpus, 1e9); assert.equal(host.PidsLimit, 128);
  assert.equal(Object.keys(host.PortBindings || {}).length, 0); assert.equal(Object.values(info.NetworkSettings.Ports || {}).filter(Boolean).length, 0);
  assert.deepEqual(info.Mounts.map(m => [m.Source, m.Destination, m.RW]).sort(), [...target.mounts].sort());
  assert.deepEqual(info.Config.Cmd, target.command);
  return { id, imageId: info.Image, image: info.Config.Image, network: host.NetworkMode,
    processId: info.State.Pid, startedAt: info.State.StartedAt, publishedPorts: 0, user, readOnlyRootfs: true };
}
function create(image, network, command, withRuntime) {
  const metadata = JSON.parse(docker("image", "inspect", "--platform", "linux/amd64", image))[0];
  assert.equal(metadata.Os, "linux"); assert.equal(metadata.Architecture, "amd64");
  const mounts = [[fixture, "/fixture", false], [results, "/out", true], ...(withRuntime ? [[runtime, "/runtime", false]] : [])];
  const id = docker("create", "--platform", "linux/amd64", "--name", `partner-nginx-${runId}-${withRuntime ? "node" : "nginx"}`,
    "--label", `padlhub.partner-nginx-candidate=${runId}`, "--network", network, "--read-only", "--user", user,
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--memory", "512m", "--cpus", "1", "--pids-limit", "128",
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=256m,mode=1777",
    ...mounts.flatMap(([source, target, writable]) => ["--mount", `type=bind,src=${source},dst=${target}${writable ? "" : ",readonly"}`]),
    "--entrypoint", withRuntime ? "node" : "/bin/sh", image, ...command);
  assert.match(id, /^[a-f0-9]{64}$/); owned.push(id); expected.set(id, { image, imageId: metadata.Id, network, command, mounts });
  fs.writeFileSync(path.join(results, "recovery.json"), JSON.stringify({ runId, owned }) + "\n", { mode: 0o600 });
  verify(id); docker("start", id); return id;
}
try {
  prepare();
  const nodeId = create(nodeImage, "none", ["/fixture/runner.cjs", "serve"], true);
  let ready = false;
  for (let i = 0; i < 60; i++) {
    assert.equal(inspect(nodeId).State.Running, true);
    try { docker("exec", nodeId, "node", "-e", "process.exit(require('fs').existsSync('/tmp/nginx-fixture-ready')?0:1)"); ready = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 500)); }
  }
  assert.ok(ready, "FIXTURE_STARTUP_TIMEOUT");
  const nginxId = create(nginxImage, `container:${nodeId}`, ["-c", "nginx -t -c /fixture/nginx.conf && exec nginx -c /fixture/nginx.conf -g 'daemon off;'"], false);
  await new Promise(resolve => setTimeout(resolve, 1000));
  const before = [verify(nodeId), verify(nginxId)]; receipt.containers = before;
  // Bounded execution may exceed a single tool wait, but not the fixture deadline.
  execFileSync("docker", ["exec", nodeId, "node", "/fixture/runner.cjs", "test"], { encoding: "utf8", timeout: 180000, maxBuffer: 65536 });
  const after = [verify(nodeId), verify(nginxId)]; assert.deepEqual(after, before);
  assert.equal(treeDigest(), runtimeBefore); assert.equal(sha(fs.readFileSync(path.join(fixture, "nginx.conf"))), candidate.configSha256);
  for (const [name, digest] of Object.entries(copiedHashes)) assert.equal(sha(fs.readFileSync(path.join(fixture, name))), digest);
  for (const [name, digest] of Object.entries(candidate.certificateHashes)) assert.equal(sha(fs.readFileSync(path.join(fixture, `${name}.crt`))), digest);
  for (const [relative, digest] of Object.entries(sources)) assert.equal(sha(fs.readFileSync(path.join(scripts, relative))), digest);
  const probes = JSON.parse(fs.readFileSync(path.join(results, "nginx-probes.json")));
  assert.equal(probes.state, "LOCAL_NGINX_MATRIX_CHECKED_NOT_PRODUCTION"); assert.equal(probes.node, "v22.23.2"); assert.equal(probes.nodeRed, "5.0.6");
  assert.equal(probes.productionVerified, false);
  assert.equal(probes.sourceLimitsIndependentlyProven, true);
  assert.equal(probes.platform, "linux"); assert.equal(probes.architecture, "x64");
  const summary = summarizeNginxRows(probes.rows);
  for (const field of ["passed", "notTested", "confirmedBlockers"]) assert.deepEqual(probes[field], summary[field]);
  Object.assign(receipt, summary);
  receipt.sourceLimitsIndependentlyProven = true;
  receipt.probesSha256 = sha(fs.readFileSync(path.join(results, "nginx-probes.json")));
  receipt.runtimeAfterSha256 = runtimeBefore; receipt.state = "PASS_LOCAL_MATRIX_ONLY";
} catch (error) { failure = error; receipt.state = "FAILED"; }
finally {
  for (const id of owned.reverse()) {
    try {
      const info = inspect(id); assert.equal(info.Config.Labels?.["padlhub.partner-nginx-candidate"], runId); assert.equal(info.Id, id);
      try { fs.writeFileSync(path.join(results, `${expected.get(id).image.startsWith("nginx") ? "nginx" : "node"}.log`), docker("logs", id), { mode: 0o600 }); }
      catch { receipt.logCollectionFailed = true; }
      if (info.State.Running) docker("stop", "--time", "20", id); docker("rm", id);
      assert.equal(docker("ps", "--all", "--no-trunc", "--filter", `id=${id}`, "--format", "{{.ID}}"), "");
      receipt.cleanup.push({ id, containerPresent: false });
    } catch { cleanupFailed = true; receipt.cleanup.push({ id, containerPresent: "UNCONFIRMED" }); }
  }
  if (!cleanupFailed && fs.existsSync(fixture)) for (const name of fs.readdirSync(fixture).filter(name => /\.(key|csr)$/.test(name))) fs.unlinkSync(path.join(fixture, name));
  receipt.syntheticPrivateKeysRemoved = !cleanupFailed;
  if (receipt.logCollectionFailed && !failure) { failure = new Error("FIXTURE_LOG_COLLECTION_FAILED"); receipt.state = "FAILED"; }
  if (cleanupFailed) receipt.state = "FAIL_CLEANUP";
  receipt.capturedAt = new Date().toISOString();
  fs.writeFileSync(path.join(results, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ output, state: receipt.state, productionTouched: false }));
}
if (cleanupFailed) throw new Error("OWNED_NGINX_CLEANUP_UNCONFIRMED");
if (failure) throw failure;
