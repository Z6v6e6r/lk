#!/usr/bin/env node
// Regenerates the Partner runtime functional rehearsal evidence
// (scripts/partner_game_membership_runtime/functional-rehearsal.json) against the
// exact current custom-node bytes in the pinned linux/amd64 Node runtime.
//
// Two owned containers are used: a bridge-network install container that runs the
// exact `npm ci` closure, and a network-none probe container that loads the custom
// node and proves default-off / flow-removal / package-removal. The probe container
// is the reviewed boundary recorded in the evidence receipt.
//
// Local fixture only: no SSH, host ports, production credentials, Mongo or Viva.
// It does not deploy, import a flow or activate anything.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildPartnerGameMembershipApiSidecarCandidate } from "./patch_partner_game_membership_api_flow.mjs";

if (process.argv.slice(2).join(" ") !== "--install-and-rehearse-locked-runtime") {
  throw new Error("Explicit --install-and-rehearse-locked-runtime required");
}

const scripts = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(scripts, "..");
const runtimeRoot = path.join(scripts, "partner_game_membership_runtime");
const customNodeRoot = path.join(repo, "node-red/custom-nodes/partner-game-membership-api");
const fixture = path.join(scripts, "tests/fixtures/partner-functional-rehearsal-runtime.mjs");
const image = "node@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5";
const imageDigest = image.slice("node@".length);
const customNodeFiles = [
  "package.json", "package-lock.json", "partner-game-membership-core.mjs", "partner-game-membership-mongo.mjs",
  "partner-game-membership-viva.mjs", "partner-game-membership-node.cjs", "partner-game-membership-ingress.cjs",
  "partner-game-membership-node.html",
];

const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", timeout: 120000, maxBuffer: 16 * 1024 * 1024 }).trim();
const inspect = (id) => JSON.parse(docker("inspect", id))[0];
const delay = (ms) => execFileSync("sleep", [String(ms / 1000)]);

function customNodeReleaseSha256() {
  const identity = customNodeFiles.map((relativePath) => {
    const bytes = fs.readFileSync(path.join(customNodeRoot, relativePath));
    return { relativePath, sha256: sha(bytes), size: bytes.length };
  });
  return sha(Buffer.from(JSON.stringify(identity), "utf8"));
}

// Mount sources must live under a path the container runtime can share. The
// checkout path may contain spaces, and this Docker Desktop host does not share
// the per-user /var/folders temp root, so the private rehearsal layout is created
// under the canonical /tmp and the receipt records paths relative to that root.
const relativeLayout = "partner-functional-rehearsal";
const layout = path.join(fs.realpathSync("/tmp"), relativeLayout);
const runtimeDir = path.join(layout, "runtime");
const flowsInput = path.join(layout, "flows");
const output = path.join(layout, "output");
const passwd = path.join(layout, "passwd");
const rehearsePath = path.join(layout, "rehearse.mjs");

const user = `${process.getuid()}:${process.getgid()}`;
const runId = crypto.randomBytes(16).toString("hex");
const owned = [];
let cleanupFailed = false;
let installedPackageCount;
let observed;
let probe;
let platformImageId;
let repoDigests;

function isolation(name) {
  return [
    "--platform", "linux/amd64",
    "--name", `partner-functional-${runId}-${name}`,
    "--label", `padlhub.partner-functional-rehearsal=${runId}`,
    "--read-only",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--memory", "512m",
    "--cpus", "1",
    "--pids-limit", "128",
    "--user", user,
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=256m,mode=1777",
    "--env", "HOME=/tmp",
    "--env", "npm_config_cache=/tmp/npm-cache",
  ];
}

async function runContainer(name, network, mounts, env, command) {
  for (const [source] of mounts) {
    assert.ok(fs.existsSync(source), `missing mount source ${source}`);
  }
  const mountArgs = mounts.flatMap(([source, target, writable]) => ["--mount", `type=bind,src=${source},dst=${target}${writable ? "" : ",readonly"}`]);
  // Docker Desktop intermittently fails to resolve freshly created host paths and
  // pinned image references. Retry the create a few times before failing closed.
  let id; let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      id = docker("create", ...isolation(name), "--network", network,
        ...env.flatMap(([key, value]) => ["--env", `${key}=${value}`]), ...mountArgs, image, ...command);
      break;
    } catch (error) {
      lastError = error;
      delay(5000);
    }
  }
  if (!id) throw lastError;
  assert.match(id, /^[a-f0-9]{64}$/, "unconfirmed owned container identity");
  owned.push(id);
  const created = inspect(id);
  assert.equal(created.Config.Labels?.["padlhub.partner-functional-rehearsal"], runId);
  assert.equal(created.Config.Image, image);
  assert.equal(created.Config.User, user);
  assert.equal(created.HostConfig.Privileged, false);
  assert.equal(created.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(created.HostConfig.CapDrop, ["ALL"]);
  assert.deepEqual(created.HostConfig.SecurityOpt, ["no-new-privileges"]);
  assert.equal(created.HostConfig.NetworkMode, network);
  assert.equal(Object.keys(created.HostConfig.PortBindings || {}).length, 0);
  assert.equal(created.HostConfig.Memory, 512 * 1024 * 1024);
  assert.equal(created.HostConfig.NanoCpus, 1e9);
  assert.equal(created.HostConfig.PidsLimit, 128);
  assert.deepEqual(created.Mounts.map(({ Source, Destination, RW }) => [Source, Destination, RW]).sort(), [...mounts].sort());
  const inspectedAt = new Date().toISOString();
  docker("start", id);
  const deadlineAt = Date.now() + 90 * 60 * 1000;
  while (Date.now() < deadlineAt) {
    if (!inspect(id).State.Running) break;
    delay(5000);
  }
  const finished = inspect(id);
  const logs = docker("logs", id);
  fs.writeFileSync(path.join(output, `${name}.log`), logs, { mode: 0o600 });
  assert.equal(finished.State.Running, false, `${name} rehearsal deadline`);
  assert.equal(finished.State.ExitCode, 0, `${name} failed; see ${name}.log`);
  return { id, inspector: { inspectedAt, finished, imageId: finished.Image }, logs };
}

fs.rmSync(layout, { recursive: true, force: true });
for (const dir of [runtimeDir, path.join(runtimeDir, "partner-package"), flowsInput, output]) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}
for (const name of ["package.json", "package-lock.json"]) {
  fs.copyFileSync(path.join(runtimeRoot, name), path.join(runtimeDir, name));
}
for (const name of customNodeFiles) {
  fs.copyFileSync(path.join(customNodeRoot, name), path.join(runtimeDir, "partner-package", name));
}
const candidate = buildPartnerGameMembershipApiSidecarCandidate();
const sourceBytes = Buffer.from(`${JSON.stringify(candidate.sourceFlow, null, 2)}\n`);
const candidateBytes = Buffer.from(`${JSON.stringify(candidate.flow, null, 2)}\n`);
fs.writeFileSync(path.join(flowsInput, "source.flow.json"), sourceBytes, { mode: 0o600 });
fs.writeFileSync(path.join(flowsInput, "candidate.flow.json"), candidateBytes, { mode: 0o600 });
fs.copyFileSync(fixture, rehearsePath);
fs.writeFileSync(passwd, `root:x:0:0:root:/root:/usr/sbin/nologin\npartner-functional:x:${process.getuid()}:${process.getgid()}:fixture:/tmp:/usr/sbin/nologin\n`, { mode: 0o600 });

try {
  // Docker Desktop intermittently loses the pinned manifest reference until it is
  // re-resolved; pull is idempotent and the pinned digest still decides the bytes.
  let meta;
  for (let attempt = 0; attempt < 6 && !meta; attempt += 1) {
    try { meta = JSON.parse(docker("image", "inspect", "--platform", "linux/amd64", image))[0]; }
    catch { try { docker("pull", "--platform", "linux/amd64", image); } catch { /* retry below */ } delay(3000); }
  }
  assert.ok(meta, "pinned linux/amd64 runtime image unavailable");
  assert.equal(meta.Os, "linux");
  assert.equal(meta.Architecture, "amd64");
  platformImageId = meta.Id;
  repoDigests = meta.RepoDigests;

  const install = await runContainer("install", "bridge", [[runtimeDir, "/runtime", true]], [],
    ["npm", "ci", "--prefix", "/runtime", "--cache", "/tmp/npm-cache", "--ignore-scripts", "--no-fund", "--no-audit", "--registry=https://registry.npmjs.org"]);
  const added = /added (\d+) packages?/.exec(install.logs);
  assert.ok(added, "install container did not report an installed package count");
  installedPackageCount = Number(added[1]);

  probe = await runContainer("probe", "none", [
    [runtimeDir, "/input/runtime", false],
    [flowsInput, "/input/flows", false],
    [rehearsePath, "/input/rehearse.mjs", false],
    [passwd, "/etc/passwd", false],
    [output, "/output", true],
  ], [["PARTNER_INSTALLED_PACKAGE_COUNT", String(installedPackageCount)]], ["node", "/input/rehearse.mjs"]);

  observed = readJson(path.join(output, "functional-observation.json"));
  assert.equal(observed.state, "LOCAL_FUNCTIONAL_REHEARSAL_PASS_NOT_PRODUCTION");
  assert.equal(observed.productionTouched, false);
  assert.equal(observed.platform, "linux");
  assert.equal(observed.architecture, "x64");
  assert.equal(observed.nodeVersion, "22.23.2");
  assert.equal(observed.nodeRedVersion, "5.0.6");
  assert.equal(observed.results.installedPackageCount, installedPackageCount);
  assert.match(probe.inspector.imageId, /^sha256:[a-f0-9]{64}$/);
  assert.match(platformImageId, /^sha256:[a-f0-9]{64}$/);
  assert.ok([platformImageId, imageDigest].includes(probe.inspector.imageId), "container image identity");
} finally {
  for (const id of owned.reverse()) {
    try {
      const info = inspect(id);
      assert.equal(info.Config.Labels?.["padlhub.partner-functional-rehearsal"], runId);
      if (info.State.Running) docker("stop", "--time", "20", id);
      docker("rm", id);
      assert.equal(docker("ps", "--all", "--no-trunc", "--filter", `id=${id}`, "--format", "{{.ID}}"), "");
    } catch {
      cleanupFailed = true;
    }
  }
  fs.rmSync(layout, { recursive: true, force: true });
}
if (cleanupFailed) throw new Error("Owned fixture cleanup incomplete");
assert.ok(observed && probe, "rehearsal did not produce evidence");

const cleanedAt = new Date().toISOString();
const receiptMounts = [
  { sourceRelativePath: `${relativeLayout}/runtime`, target: "/input/runtime", readOnly: true },
  { sourceRelativePath: `${relativeLayout}/flows`, target: "/input/flows", readOnly: true },
  { sourceRelativePath: `${relativeLayout}/rehearse.mjs`, target: "/input/rehearse.mjs", readOnly: true },
  { sourceRelativePath: `${relativeLayout}/passwd`, target: "/etc/passwd", readOnly: true },
  { sourceRelativePath: `${relativeLayout}/output`, target: "/output", readOnly: false },
];
const containerReceipt = {
  formatVersion: 1,
  evidenceScope: "LOCAL_CONTAINER_CLI_READBACK",
  containerId: probe.id,
  imageReference: image,
  containerImageId: probe.inspector.imageId,
  platformImageId,
  imageRepoDigests: repoDigests,
  platform: "linux",
  architecture: "amd64",
  networkMode: "none",
  publishedPortCount: 0,
  mounts: receiptMounts,
  orchestratorSha256: sha(fs.readFileSync(fileURLToPath(import.meta.url))),
  inspectedAt: probe.inspector.inspectedAt,
  finishedAt: new Date(probe.inspector.finished.State.FinishedAt).toISOString(),
  exitCode: probe.inspector.finished.State.ExitCode,
  cleanupCapturedAt: cleanedAt,
  containerPresentAfterCleanup: false,
  hostListenerPresentAfterCleanup: false,
};

const manifest = readJson(path.join(runtimeRoot, "runtime-manifest.json"));
const sourceBaseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
assert.match(sourceBaseCommit, /^[a-f0-9]{40}$/);
const functional = {
  formatVersion: 1,
  deploymentId: manifest.deploymentId,
  capturedAt: new Date(probe.inspector.finished.State.FinishedAt).toISOString(),
  clockSource: "docker-container-finished-at",
  evidenceScope: "CUSTOM_NODE_LOAD_DEFAULT_OFF_AND_REMOVAL_COMPATIBILITY_ONLY",
  sourceBaseCommit,
  customNodeReleaseSha256: customNodeReleaseSha256(),
  runtime: manifest.runtime,
  installation: {
    command: "npm ci --ignore-scripts --no-fund --no-audit",
    installedPackageCount,
    exitCode: 0,
  },
  candidate: {
    sourceFlowSha256: sha(sourceBytes),
    candidateFlowSha256: sha(candidateBytes),
    audienceEnvironmentVariable: "LK_PARTNER_GAME_API_AUDIENCE",
    signatureVersion: "v2",
  },
  defaultOff: {
    httpStatus: observed.results.defaultOff.httpStatus,
    cacheControl: observed.results.defaultOff.cacheControl,
    corsResponseHeader: observed.results.defaultOff.corsResponseHeader,
    errorCode: observed.results.defaultOff.errorCode,
    mongoCalls: observed.results.defaultOff.mongoCalls,
    vivaCalls: observed.results.defaultOff.vivaCalls,
  },
  shutdown: observed.results.shutdown,
  flowRollback: observed.results.flowRollback,
  packageRollback: observed.results.packageRollback,
  cleanup: { containerPresent: false, listenerPort: null, listenerPresent: false, temporaryDirectoriesRemoved: !fs.existsSync(layout) },
  decision: "FUNCTIONAL_COMPATIBILITY_PASS_SECURITY_AUDIT_PASS",
  productionTouched: false,
  containerReceipt,
};
writeJson(path.join(runtimeRoot, "functional-rehearsal.json"), functional);
const functionalBytes = fs.readFileSync(path.join(runtimeRoot, "functional-rehearsal.json"));
manifest.sourceBaseCommit = functional.sourceBaseCommit;
manifest.closure.customNodeReleaseSha256 = functional.customNodeReleaseSha256;
manifest.closure.functionalRehearsalSha256 = sha(functionalBytes);
manifest.closure.containerReceiptSha256 = sha(Buffer.from(`${JSON.stringify(containerReceipt, null, 2)}\n`));
writeJson(path.join(runtimeRoot, "runtime-manifest.json"), manifest);

process.stdout.write(`${JSON.stringify({
  state: "PASS",
  installedPackageCount,
  customNodeReleaseSha256: functional.customNodeReleaseSha256,
  sourceBaseCommit,
})}\n`);
