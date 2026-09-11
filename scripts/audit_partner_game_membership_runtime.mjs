#!/usr/bin/env node
// Explicit local installation + registry audit. No host credentials or deployment.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.argv.slice(2).join(" ") !== "--install-and-audit-locked-runtime") throw new Error("Explicit --install-and-audit-locked-runtime required");
const scripts = path.dirname(fileURLToPath(import.meta.url));
const reference = "node@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5";
const child = "sha256:4d676821dff059fd00d277ee4261ef34ea712317fed0737c03941481b5760c96";
// Mount sources must live under a path the container runtime can share; the
// canonical /tmp root is used because this host does not share /var/folders.
const output = fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "partner-runtime-audit-")); fs.chmodSync(output, 0o700);
const runtime = path.join(output, "runtime"), input = path.join(output, "input"), results = path.join(output, "results");
for (const dir of [runtime, input, results, path.join(runtime, "partner-package")]) fs.mkdirSync(dir, { mode: 0o700 });
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", timeout: 60000, maxBuffer: 2 * 1024 * 1024 }).trim();
const runId = crypto.randomBytes(16).toString("hex");
const sources = {};
function copy(source, target) { const bytes = fs.readFileSync(path.join(scripts, source)); fs.writeFileSync(target, bytes, { mode: 0o600 }); sources[source] = sha(bytes); }
for (const name of ["package.json", "package-lock.json"]) copy(`partner_game_membership_runtime/${name}`, path.join(runtime, name));
for (const name of ["package.json", "package-lock.json", "partner-game-membership-core.mjs", "partner-game-membership-mongo.mjs", "partner-game-membership-viva.mjs", "partner-game-membership-node.cjs", "partner-game-membership-ingress.cjs", "partner-game-membership-node.html"]) copy(`../node-red/custom-nodes/partner-game-membership-api/${name}`, path.join(runtime, "partner-package", name));
copy("tests/fixtures/partner-runtime-audit.mjs", path.join(input, "run.mjs"));
fs.writeFileSync(path.join(input, "empty-global.npmrc"), "# no inherited configuration\n", { mode: 0o600 });
const user = `${process.getuid()}:${process.getgid()}`;
// Fixture-only account lookup; npm calls os.homedir even with empty configs.
// Do not repurpose HOME or import the host's passwd/home/environment.
fs.writeFileSync(path.join(input, "passwd"), `root:x:0:0:root:/root:/usr/sbin/nologin\npartner-audit:x:${process.getuid()}:${process.getgid()}:fixture:/tmp:/usr/sbin/nologin\n`, { mode: 0o600 });
let ownedId, succeeded = false, failure, cleanupFailed = false;
const receipt = { formatVersion: 1, scope: "LOCAL_INSTALLED_LINUX_RUNTIME_AUDIT", runId, reference, platformImageId: child,
  sourceHashes: sources, orchestratorSha256: sha(fs.readFileSync(fileURLToPath(import.meta.url))), productionTouched: false, containers: [] };
const inspect = () => JSON.parse(docker("inspect", ownedId))[0];
function verify() {
  const info = inspect(), host = info.HostConfig;
  assert.equal(info.Id, ownedId); assert.ok([child, reference.slice("node@".length)].includes(info.Image)); assert.equal(info.Config.Image, reference);
  assert.equal(info.Config.Labels?.["padlhub.partner-runtime-audit"], runId);
  assert.equal(info.Config.User, user); assert.equal(host.NetworkMode, "bridge");
  assert.equal(host.Privileged, false); assert.equal(host.ReadonlyRootfs, true);
  assert.deepEqual(host.CapDrop, ["ALL"]); assert.deepEqual(host.SecurityOpt, ["no-new-privileges"]);
  assert.equal(host.Memory, 512 * 1024 * 1024); assert.equal(host.NanoCpus, 1e9); assert.equal(host.PidsLimit, 128);
  assert.equal(Object.keys(host.PortBindings || {}).length, 0);
  assert.equal(Object.values(info.NetworkSettings.Ports || {}).filter(Boolean).length, 0);
  assert.deepEqual(info.Mounts.map(m => [m.Source, m.Destination, m.RW]).sort(), [[runtime, "/runtime", true], [input, "/input", false], [results, "/out", true], [path.join(input, "passwd"), "/etc/passwd", false]].sort());
  assert.deepEqual(info.Config.Cmd, ["node", "/input/run.mjs"]);
  return { id: ownedId, imageId: info.Image, imageReference: reference, networkMode: "bridge", user,
    readOnlyRootfs: true, publishedPorts: 0, privileged: false, capabilitiesDropped: ["ALL"], noNewPrivileges: true,
    memoryBytes: host.Memory, nanoCpus: host.NanoCpus, pidsLimit: host.PidsLimit,
    mounts: [{ target: "/runtime", writable: true }, { target: "/input", writable: false }, { target: "/out", writable: true }, { target: "/etc/passwd", writable: false }],
    inspectedAt: new Date().toISOString() };
}
try {
  // Docker Desktop intermittently loses the pinned manifest reference until it is
  // re-resolved; pull is idempotent and the pinned digest still decides the bytes.
  let image;
  for (let attempt = 0; attempt < 6 && !image; attempt += 1) {
    try { image = JSON.parse(docker("image", "inspect", "--platform", "linux/amd64", reference))[0]; }
    catch { try { docker("pull", "--platform", "linux/amd64", reference); } catch { /* retry below */ } execFileSync("sleep", ["3"]); }
  }
  assert.ok(image, "pinned linux/amd64 runtime image unavailable");
  assert.equal(image.Id, child); assert.equal(image.Os, "linux"); assert.equal(image.Architecture, "amd64");
  assert.ok(image.RepoDigests.includes(reference)); receipt.imageRepoDigests = image.RepoDigests;
  ownedId = docker("create", "--platform", "linux/amd64", "--name", `partner-audit-${runId}`, "--label", `padlhub.partner-runtime-audit=${runId}`,
    "--network", "bridge", "--read-only", "--user", user, "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--memory", "512m", "--cpus", "1", "--pids-limit", "128", "--tmpfs", "/tmp:rw,noexec,nosuid,size=256m,mode=1777",
    "--mount", `type=bind,src=${runtime},dst=/runtime`, "--mount", `type=bind,src=${input},dst=/input,readonly`,
    "--mount", `type=bind,src=${path.join(input, "passwd")},dst=/etc/passwd,readonly`,
    "--mount", `type=bind,src=${results},dst=/out`, "--workdir", "/runtime", reference, "node", "/input/run.mjs");
  if (!/^[a-f0-9]{64}$/.test(ownedId)) throw new Error("UNCONFIRMED_AUDIT_CONTAINER");
  fs.writeFileSync(path.join(results, "recovery.json"), JSON.stringify({ runId, ownedId, state: "CREATED_NOT_STARTED" }) + "\n", { mode: 0o600, flag: "wx" });
  receipt.containers.push(verify()); docker("start", ownedId);
  // npm ci + npm ls + npm audit under emulation needs far more than the previous 4
  // minutes; keep a hard bound but let the pinned Linux runtime finish.
  const deadline = Date.now() + 45 * 60 * 1000;
  while (inspect().State.Running && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1000));
  const final = inspect(); receipt.containers.push(verify());
  fs.writeFileSync(path.join(results, "container.log"), docker("logs", ownedId), { mode: 0o600 });
  assert.equal(final.State.Running, false, "AUDIT_DEADLINE"); assert.equal(final.State.ExitCode, 0, "AUDIT_FAILED_SEE_PRIVATE_OUTPUT");
  const observation = JSON.parse(fs.readFileSync(path.join(results, "audit-observation.json")));
  assert.equal(observation.platform, "linux"); assert.equal(observation.architecture, "x64");
  assert.equal(observation.nodeVersion, "22.23.2"); assert.equal(observation.npmVersion, "10.9.8"); assert.equal(observation.nodeRedVersion, "5.0.6");
  assert.equal(observation.inputs["package-lock.json"], sources["partner_game_membership_runtime/package-lock.json"]);
  for (const command of observation.commands) {
    assert.equal(sha(fs.readFileSync(path.join(results, `${command.name}.stdout`))), command.stdoutSha256);
    assert.equal(sha(fs.readFileSync(path.join(results, `${command.name}.stderr`))), command.stderrSha256);
  }
  receipt.observationSha256 = sha(fs.readFileSync(path.join(results, "audit-observation.json")));
  succeeded = true;
} catch (error) {
  failure = error;
} finally {
  if (ownedId && /^[a-f0-9]{64}$/.test(ownedId)) {
    try {
      const info = inspect(); assert.equal(info.Config.Labels?.["padlhub.partner-runtime-audit"], runId); assert.equal(info.Id, ownedId);
      if (info.State.Running) docker("stop", "--time", "20", ownedId);
      docker("rm", ownedId);
      assert.equal(docker("ps", "--all", "--no-trunc", "--filter", `id=${ownedId}`, "--format", "{{.ID}}"), "");
      receipt.containerPresentAfterCleanup = false;
    } catch { cleanupFailed = true; receipt.containerPresentAfterCleanup = "UNCONFIRMED"; }
  }
  receipt.ownedId = ownedId;
  receipt.capturedAt = new Date().toISOString(); receipt.state = cleanupFailed ? "FAIL_CLEANUP" : succeeded ? "PASS_LOCAL_AUDIT_ONLY" : "FAILED";
  fs.writeFileSync(path.join(results, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ output, state: receipt.state, productionTouched: false }));
}
if (cleanupFailed) throw new Error("AUDIT_CLEANUP_UNCONFIRMED_SEE_PRIVATE_RECEIPT");
if (failure) throw failure;
