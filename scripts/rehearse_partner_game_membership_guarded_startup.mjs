#!/usr/bin/env node
// Local fixture only. No SSH, host ports, production credentials or shared data.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { buildPartnerGameMembershipApiSidecarCandidate } from "./patch_partner_game_membership_api_flow.mjs";

if (process.argv.slice(2).join(" ") !== "--install-locked-runtime") throw new Error("Explicit --install-locked-runtime required");
const scripts = path.dirname(fileURLToPath(import.meta.url));
const image = "node@sha256:4d676821dff059fd00d277ee4261ef34ea712317fed0737c03941481b5760c96";
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const output = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "partner-guarded-startup-")); fs.chmodSync(output, 0o700);
const layout = path.join(output, "layout"); const release = path.join(layout, "releases/proof");
const runtime = path.join(release, "runtime"); const sidecar = path.join(release, "sidecar");
for (const dir of [runtime, sidecar, path.join(runtime, "partner-package"), path.join(output, "state"), path.join(output, "results")]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
fs.symlinkSync("releases/proof", path.join(layout, "current"));
const sources = {};
const copy = (relative, target) => { const bytes = fs.readFileSync(path.join(scripts, relative)); fs.writeFileSync(target, bytes, { mode: 0o600 }); sources[relative] = sha(bytes); };
for (const name of ["package.json", "package-lock.json"]) copy(`partner_game_membership_runtime/${name}`, path.join(runtime, name));
for (const name of ["package.json", "package-lock.json", "partner-game-membership-core.mjs", "partner-game-membership-mongo.mjs", "partner-game-membership-viva.mjs", "partner-game-membership-node.cjs", "partner-game-membership-node.html"]) copy(`../node-red/custom-nodes/partner-game-membership-api/${name}`, path.join(runtime, "partner-package", name));
for (const name of ["settings.cjs", "settings-runtime.cjs", "settings-guarded.cjs", "guarded-startup.cjs", "raw-request-guard.cjs", "raw-audit.cjs", "guarded-runtime-policy.json", "partner-game-membership-sidecar.service"]) copy(`partner_game_membership_sidecar/${name}`, path.join(sidecar, name));
copy("tests/fixtures/partner-guarded-startup-runtime.cjs", path.join(output, "runner.cjs"));
const candidate = Buffer.from(JSON.stringify(buildPartnerGameMembershipApiSidecarCandidate().flow, null, 2) + "\n");
fs.writeFileSync(path.join(release, "candidate.flow.json"), candidate, { mode: 0o600 });
sources["candidate.flow.json"] = sha(candidate);
sources["rehearse_partner_game_membership_guarded_startup.mjs"] = sha(fs.readFileSync(fileURLToPath(import.meta.url)));
const runId = crypto.randomBytes(8).toString("hex"); const owned = [];
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", timeout: 60000, maxBuffer: 2 * 1024 * 1024 }).trim();
const inspect = (id) => JSON.parse(docker("inspect", id))[0];
const user = `${process.getuid()}:${process.getgid()}`;
// Synthetic service-account lookup for numeric host UID in the Linux fixture;
// no host passwd/home/environment is imported or repurposed.
fs.writeFileSync(path.join(output, "passwd"), `root:x:0:0:root:/root:/usr/sbin/nologin\npartner-game-api:x:${process.getuid()}:${process.getgid()}:fixture:/tmp:/usr/sbin/nologin\n`, { mode: 0o600 });
const isolation = ["--platform", "linux/amd64", "--label", `padlhub.partner-guarded-startup=${runId}`, "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--memory", "512m", "--cpus", "1", "--pids-limit", "128", "--user", user, "--tmpfs", "/tmp:rw,noexec,nosuid,size=256m,mode=1777"];
const receipt = { scope: "LOCAL_GUARDED_STARTUP_ONLY", sources, containers: [], cleanup: [], productionTouched: false };
let imageId;
let cleanupFailed = false;
function verify(id, network, mounts) {
  const info = inspect(id); const config = info.HostConfig;
  assert.equal(info.Config.Labels?.["padlhub.partner-guarded-startup"], runId); assert.equal(info.Image, imageId);
  assert.equal(info.Config.Image, image); assert.equal(info.Config.User, user); assert.equal(config.NetworkMode, network);
  assert.equal(config.Privileged, false); assert.equal(config.ReadonlyRootfs, true); assert.deepEqual(config.CapDrop, ["ALL"]);
  assert.deepEqual(config.SecurityOpt, ["no-new-privileges"]); assert.equal(Object.keys(config.PortBindings || {}).length, 0);
  assert.equal(config.Memory, 512 * 1024 * 1024); assert.equal(config.NanoCpus, 1e9); assert.equal(config.PidsLimit, 128);
  assert.deepEqual(info.Mounts.map(({ Source, Destination, RW }) => [Source, Destination, RW]).sort(), [...mounts].sort());
  return { image, imageId, networkMode: network, publishedPorts: 0, readOnlyRootfs: true, user, capabilitiesDropped: ["ALL"] };
}
async function container(name, network, mounts, command) {
  const mountArgs = mounts.flatMap(([source, target, writable]) => ["--mount", `type=bind,src=${source},dst=${target}${writable ? "" : ",readonly"}`]);
  const id = docker("create", ...isolation, "--network", network, "--name", `partner-guarded-${runId}-${name}`, ...mountArgs, image, ...command);
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Unconfirmed owned container identity"); owned.push(id);
  verify(id, network, mounts); docker("start", id);
  for (let i = 0; i < 240; i++) {
    if (!inspect(id).State.Running) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const info = inspect(id); fs.writeFileSync(path.join(output, "results", `${name}.log`), docker("logs", id), { mode: 0o600 });
  assert.equal(info.State.Running, false, `${name} deadline`); assert.equal(info.State.ExitCode, 0, `${name} failed; see private log`);
  receipt.containers.push(verify(id, network, mounts));
}
try {
  const meta = JSON.parse(docker("image", "inspect", image))[0]; assert.equal(meta.Architecture, "amd64"); assert.equal(meta.Os, "linux"); imageId = meta.Id;
  await container("install", "bridge", [[runtime, "/runtime", true]], ["npm", "ci", "--prefix", "/runtime", "--cache", "/tmp/npm-cache", "--ignore-scripts", "--no-fund", "--no-audit", "--registry=https://registry.npmjs.org"]);
  receipt.install = { exitCode: 0, lifecycleScripts: false, reusedRuntime: false };
  await container("probe", "none", [[layout, "/opt/padlhub/partner-game-membership", false], [path.join(output, "state"), "/var/lib/padlhub/partner-game-membership", true], [path.join(output, "results"), "/out", true], [path.join(output, "runner.cjs"), "/runner.cjs", false], [path.join(output, "passwd"), "/etc/passwd", false]], ["node", "/runner.cjs"]);
  receipt.probesSha256 = sha(fs.readFileSync(path.join(output, "results/probes.json"))); receipt.state = "PASS";
} finally {
  for (const id of owned.reverse()) {
    try {
      const info = inspect(id); assert.equal(info.Config.Labels?.["padlhub.partner-guarded-startup"], runId); assert.equal(info.Id, id);
      if (info.State.Running) docker("stop", "--time", "20", id);
      docker("rm", id);
      assert.equal(docker("ps", "--all", "--no-trunc", "--filter", `id=${id}`, "--format", "{{.ID}}"), "");
      receipt.cleanup.push({ containerPresent: false, ownedId: id });
    } catch {
      cleanupFailed = true;
      receipt.cleanup.push({ containerPresent: "UNCONFIRMED", ownedId: id });
    }
  }
  if (cleanupFailed) receipt.state = "FAIL_CLEANUP";
  receipt.capturedAt = new Date().toISOString();
  fs.writeFileSync(path.join(output, "results/receipt.json"), JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ output, state: receipt.state || "FAIL", productionTouched: false }));
}
if (cleanupFailed) throw new Error("Owned fixture cleanup incomplete; inspect exact IDs in private receipt before any recovery");
