#!/usr/bin/env node
// Opt-in owned internal-network rehearsal. Never operates a host Nginx/service.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createLocalNginxApplicationSession, verifyLocalNginxApplicationPhase, deriveLocalNginxApplicationAddresses } from "./partner_game_membership_nginx_application.mjs";
import { createPartnerNginxTestCertificates } from "./tests/fixtures/partner-nginx124-certificates.mjs";
import { collectFixtureLogThenCleanup } from "./tests/fixtures/partner-nginx-application-cleanup.mjs";
import { parseNginxRehearsalMode, runNginxRehearsalMode } from "./partner_game_membership_nginx_identity_diagnostic.mjs";

const mode = parseNginxRehearsalMode(process.argv.slice(2));
const scripts = path.dirname(fileURLToPath(import.meta.url)), started = Date.now();
const nodeImage = "node@sha256:4d676821dff059fd00d277ee4261ef34ea712317fed0737c03941481b5760c96";
const nginxImage = "nginx@sha256:2e26275ed7a47e8e93f264d39a09ca4bc3f4058c904c75087e237f4ea883f2a1";
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const output = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "partner-nginx-application-")); fs.chmodSync(output, 0o700);
const fixture = path.join(output, "fixture"), control = path.join(output, "control"), results = path.join(output, "results");
for (const directory of [control, results]) fs.mkdirSync(directory, { mode: 0o700 });
const runId = crypto.randomBytes(16).toString("hex"), label = "padlhub.partner-nginx-application", owned = [], targets = new Map();
let networkId, failure, cleanupFailed = false, cleaning = false, session;
const sources = {}, copies = {};
const receipt = { state: "STARTING", scope: mode === "diagnostic" ? "LOCAL_NGINX_IDENTITY_DIAGNOSTIC" : "LOCAL_NGINX_CONTROLLED_APPLICATION", runId, sources, containers: [], cleanup: [],
  productionVerified: false, deployAuthorized: false, activationAuthorized: false };
const docker = (...args) => {
  if (!cleaning && Date.now() - started > 180000) throw new Error("LOCAL_APPLICATION_HARD_DEADLINE");
  return execFileSync("docker", args, { encoding: "utf8", timeout: 20000, maxBuffer: 2 * 1024 * 1024 }).trim();
};
const inspect = id => JSON.parse(docker("inspect", id))[0];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const write = (file, value) => fs.writeFileSync(file, value, { mode: 0o600 });
function recovery() { write(path.join(results, "recovery.json"), JSON.stringify({ runId, networkId, owned }) + "\n"); }
function verify(id) {
  const actual = inspect(id), target = targets.get(id), host = actual.HostConfig;
  assert.equal(actual.Id, id); assert.equal(actual.Config.Labels?.[label], runId);
  assert.equal(actual.Image, target.imageId); assert.equal(actual.Config.Image, target.image);
  assert.equal(actual.Config.User, `${process.getuid()}:${process.getgid()}`);
  assert.equal(host.NetworkMode, target.network); assert.equal(host.PidMode, target.pidMode);
  assert.equal(host.Privileged, false); assert.equal(host.ReadonlyRootfs, true);
  assert.deepEqual(host.CapDrop, ["ALL"]); assert.deepEqual(host.SecurityOpt, ["no-new-privileges"]);
  assert.equal(host.Memory, 512 * 1024 * 1024); assert.equal(host.NanoCpus, 1e9); assert.equal(host.PidsLimit, 128);
  assert.equal(Object.keys(host.PortBindings || {}).length, 0);
  assert.equal(Object.values(actual.NetworkSettings.Ports || {}).filter(Boolean).length, 0);
  assert.deepEqual(actual.Config.Entrypoint, [target.entrypoint]); assert.deepEqual(actual.Config.Cmd, target.command);
  assert.deepEqual(actual.Mounts.map(m => [m.Source, m.Destination, m.RW]).sort(), target.mounts.toSorted());
  if (target.ip) {
    const networks = Object.values(actual.NetworkSettings.Networks);
    assert.equal(networks.length, 1); assert.equal(networks[0].NetworkID, networkId); assert.equal(networks[0].IPAddress, target.ip);
  }
  return { id, image: target.image, imageId: actual.Image, processId: actual.State.Pid,
    startedAt: actual.State.StartedAt, network: host.NetworkMode, pidMode: host.PidMode };
}
function create(image, role, command, { network, pidMode = "", ip, writable = false } = {}) {
  const metadata = JSON.parse(docker("image", "inspect", "--platform", "linux/amd64", image))[0];
  assert.equal(metadata.Os, "linux"); assert.equal(metadata.Architecture, "amd64");
  const mounts = [[fixture, "/fixture", false], ...(writable ? [[control, "/control", true], [results, "/out", true]] : [])];
  const entrypoint = role === "nginx" ? "/usr/sbin/nginx" : "node";
  const id = docker("create", "--platform", "linux/amd64", "--name", `partner-app-${runId}-${role}`,
    "--label", `${label}=${runId}`, "--network", network, ...(ip ? ["--ip", ip] : []), ...(pidMode ? ["--pid", pidMode] : []),
    "--read-only", "--user", `${process.getuid()}:${process.getgid()}`, "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--memory", "512m", "--cpus", "1", "--pids-limit", "128", "--tmpfs", "/tmp:rw,noexec,nosuid,size=256m,mode=1777",
    ...mounts.flatMap(([source, target, rw]) => ["--mount", `type=bind,src=${source},dst=${target}${rw ? "" : ",readonly"}`]),
    "--entrypoint", entrypoint, image, ...command);
  assert.match(id, /^[a-f0-9]{64}$/); owned.push(id);
  targets.set(id, { image, imageId: metadata.Id, network, pidMode, ip, mounts, entrypoint, command }); recovery();
  docker("start", id); verify(id); return id;
}
function verifyNetwork() {
  const network = JSON.parse(docker("network", "inspect", networkId))[0];
  assert.equal(network.Id, networkId); assert.equal(network.Labels?.[label], runId); assert.equal(network.Internal, true);
  assert.equal(network.Driver, "bridge"); assert.equal(network.EnableIPv6, false);
  assert.deepEqual(Object.keys(network.Containers).sort(), owned.filter(id => targets.get(id).ip).sort());
  return { id: network.Id, internal: true, driver: network.Driver, members: Object.keys(network.Containers).sort() };
}
try {
  for (const relative of ["partner_game_membership_nginx_application.mjs", "partner_game_membership_nginx_candidate.mjs",
    "partner_game_membership_ingress_evidence.mjs", "rehearse_partner_game_membership_nginx_application.mjs", "tests/fixtures/partner-nginx124-certificates.mjs", "tests/fixtures/partner-nginx-application-cleanup.mjs", "partner_game_membership_nginx_identity_diagnostic.mjs"]) {
    sources[relative] = sha(fs.readFileSync(path.join(scripts, relative)));
  }
  const binding = createPartnerNginxTestCertificates(fixture, { sourceLimits: true });
  const copiedFiles = mode === "diagnostic"
    ? { "partner_game_membership_nginx_linux.mjs": "partner_game_membership_nginx_linux.mjs", "identity-diagnostic.mjs": "partner_game_membership_nginx_identity_diagnostic.mjs", "peer.cjs": "tests/fixtures/partner-nginx-application-peer.cjs" }
    : { "linux.mjs": "partner_game_membership_nginx_linux.mjs", "peer.cjs": "tests/fixtures/partner-nginx-application-peer.cjs" };
  for (const [name, relative] of Object.entries(copiedFiles)) {
    const bytes = fs.readFileSync(path.join(scripts, relative)); sources[relative] = sha(bytes); copies[name] = sha(bytes); write(path.join(fixture, name), bytes);
  }
  networkId = docker("network", "create", "--internal", "--driver", "bridge", "--label", `${label}=${runId}`, `partner-app-${runId}`);
  assert.match(networkId, /^[a-f0-9]{64}$/); recovery();
  receipt.preparationStep = "OWNED_NETWORK_IPAM_VALIDATION";
  const network = JSON.parse(docker("network", "inspect", networkId))[0];
  assert.equal(network.Internal, true); assert.equal(network.IPAM.Config.length, 1);
  const subnet = network.IPAM.Config[0].Subnet;
  receipt.observedDockerSubnet = typeof subnet === "string" && /^[0-9./]{1,18}$/.test(subnet) ? subnet : null;
  const { peerAddress, probeAddress } = deriveLocalNginxApplicationAddresses(subnet);
  receipt.preparationStep = "OWNED_FIXTURE_AND_CONTAINERS";
  const networkBytes = JSON.stringify({ peerAddress, probeAddress }); write(path.join(fixture, "network.json"), networkBytes);
  session = createLocalNginxApplicationSession({ binding, peerAddress, probeAddress });
  const publish = phase => { const config = session.configuration(phase); write(path.join(control, "nginx.conf"), config.configuration); return config; };
  const baselineConfig = publish("baseline"); receipt.certificateHashes = baselineConfig.certificateHashes;
  const observer = create(nodeImage, "observer", ["/fixture/peer.cjs", "serve"], { network: networkId, ip: peerAddress, writable: true });
  for (let i = 0; !fs.existsSync(path.join(control, "observer-ready")) && i < 30; i++) { assert.equal(inspect(observer).State.Running, true); await wait(100); }
  assert.ok(fs.existsSync(path.join(control, "observer-ready")));
  const nginx = create(nginxImage, "nginx", ["-c", "/control/nginx.conf", "-g", "daemon off;"], { network: `container:${observer}`, pidMode: `container:${observer}`, writable: true });
  const verifyInputs = () => {
    for (const [relative, digest] of Object.entries(sources)) assert.equal(sha(fs.readFileSync(path.join(scripts, relative))), digest);
    for (const [name, digest] of Object.entries(copies)) assert.equal(sha(fs.readFileSync(path.join(fixture, name))), digest);
    for (const [name, digest] of Object.entries(receipt.certificateHashes)) assert.equal(sha(fs.readFileSync(path.join(fixture, `${name}.crt`))), digest);
    assert.equal(fs.readFileSync(path.join(fixture, "network.json"), "utf8"), networkBytes);
  };
  await runNginxRehearsalMode(mode, {
    diagnostic: async () => {
      const containersBefore = owned.map(verify), networkBefore = verifyNetwork();
      assert.equal(owned.length, 2); receipt.containers = containersBefore; receipt.network = networkBefore;
      receipt.preparationStep = "IDENTITY_DIAGNOSTIC_ONLY";
      await wait(500);
      let diagnostic;
      try { diagnostic = JSON.parse(docker("exec", observer, "node", "/fixture/identity-diagnostic.mjs", "capture")); }
      catch (error) {
        // The pinned diagnostic emits a closed redacted envelope on nonzero exit.
        // Preserve it for diagnosis; never promote incomplete capture to PASS.
        const stdout = error.stdout;
        assert.ok((typeof stdout === "string" || Buffer.isBuffer(stdout)) && stdout.length <= 65536);
        diagnostic = JSON.parse(stdout.toString()); assert.equal(diagnostic.state, "DIAGNOSTIC_INCOMPLETE");
      }
      assert.equal(JSON.parse(fs.readFileSync(path.join(control, "observer.json"))).received, 0);
      assert.equal(fs.readFileSync(path.join(results, "nginx-access.jsonl"), "utf8"), "");
      assert.deepEqual(owned.map(verify), containersBefore); assert.deepEqual(verifyNetwork(), networkBefore);
      assert.equal(sha(fs.readFileSync(path.join(control, "nginx.conf"))), baselineConfig.configSha256);
      verifyInputs();
      const bytes = JSON.stringify(diagnostic, null, 2) + "\n"; write(path.join(results, "identity-diagnostic.json"), bytes);
      receipt.diagnosticSha256 = sha(bytes);
      if (diagnostic.state === "DIAGNOSTIC_INCOMPLETE") throw new Error("NGINX_IDENTITY_DIAGNOSTIC_INCOMPLETE");
      assert.equal(diagnostic.state, "DIAGNOSTIC_CAPTURE_ONLY_NOT_APPLICATION_PROOF");
      assert.equal(diagnostic.before.configSha256, baselineConfig.configSha256);
      Object.assign(receipt, { state: "DIAGNOSTIC_COMPLETE_NOT_APPLICATION_PASS", diagnosticSha256: sha(bytes),
        classification: diagnostic.classification, observerRequests: 0, ingressLogRows: 0, applicationProbes: "NOT_RUN", hup: "NOT_RUN" });
    },
    application: async () => {
  const client = create(nodeImage, "client", ["-e", "setInterval(() => {}, 1000)"], { network: networkId, ip: probeAddress });
  const containersBefore = owned.map(verify), networkBefore = verifyNetwork();
  receipt.containers = containersBefore; receipt.network = networkBefore;
  receipt.preparationStep = "APPLICATION_OBSERVATIONS";
  const snapshot = () => JSON.parse(docker("exec", observer, "node", "/fixture/linux.mjs", "snapshot"));
  const settled = async (oldWorker = null) => {
    for (let i = 0; i < 30; i++) {
      try { const value = snapshot(); if (value.workers.length === 1 && !value.workers[0].draining && value.workers[0].pid !== oldWorker) return value; } catch { /* bounded transition observation */ }
      await wait(100);
    }
    throw new Error("NGINX_WORKER_TRANSITION_UNPROVEN");
  };
  const logs = () => fs.existsSync(path.join(results, "nginx-access.jsonl")) ? fs.readFileSync(path.join(results, "nginx-access.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
  const upstream = () => JSON.parse(fs.readFileSync(path.join(control, "observer.json"))).received;
  const observe = async phase => {
    const before = snapshot(), offset = logs().length, upstreamBefore = upstream(), probes = [];
    for (const name of ["client", "client-2", "direct-sidecar"]) {
      await wait(550); probes.push(JSON.parse(docker("exec", client, "node", "/fixture/peer.cjs", "probe", name)));
    }
    return { phase, before, after: snapshot(), probes, logs: logs().slice(offset), upstreamBefore, upstreamAfter: upstream() };
  };
  await settled(); const baseline = await observe("baseline"); session.record(baseline);
  const next = publish("applied");
  docker("exec", nginx, "/usr/sbin/nginx", "-t", "-c", "/control/nginx.conf");
  const unapplied = await observe("applied"); session.recordUnapplied(unapplied);
  assert.throws(() => verifyLocalNginxApplicationPhase({ expected: next, observed: unapplied, previous: baseline.after, peerAddress, probeAddress }), /NGINX_APPLICATION_NEW_WORKER_REQUIRED/);
  verify(nginx); docker("kill", "--signal", "HUP", nginx);
  await settled(baseline.after.workers[0].pid); const applied = await observe("applied"); session.record(applied);
  publish("revoked"); docker("exec", nginx, "/usr/sbin/nginx", "-t", "-c", "/control/nginx.conf");
  verify(nginx); docker("kill", "--signal", "HUP", nginx);
  await settled(applied.after.workers[0].pid); session.record(await observe("revoked"));
  const proof = session.finish();
  assert.deepEqual(owned.map(verify), containersBefore); assert.deepEqual(verifyNetwork(), networkBefore);
  verifyInputs();
  const proofBytes = JSON.stringify(proof, null, 2) + "\n"; write(path.join(results, "proof.json"), proofBytes);
  Object.assign(receipt, { state: "PASS_LOCAL_APPLICATION_ONLY", proofSha256: sha(proofBytes), probeCount: 12, appliedGenerations: 3,
    diskOnlyNegativeConfirmed: true, bindingRevocationConfirmed: true, independentNamespaceRefusalConfirmed: true });
    },
  });
} catch (error) { failure = error; receipt.state = "FAILED"; receipt.failureCode = /^NGINX_|^LOCAL_|^EXPLICIT_/.test(error.message) ? error.message : "LOCAL_APPLICATION_ASSERTION_OR_EXEC_FAILED"; }
finally {
  cleaning = true;
  for (const id of [...owned].reverse()) {
    try {
      const info = inspect(id); assert.equal(info.Id, id); assert.equal(info.Config.Labels?.[label], runId);
      const logResult = collectFixtureLogThenCleanup(() => write(path.join(results, `${id}.log`), docker("logs", id)), () => {
        if (info.State.Running) docker("stop", "--time", "10", id); docker("rm", id);
        assert.equal(docker("ps", "--all", "--no-trunc", "--filter", `id=${id}`, "--format", "{{.ID}}"), "");
      });
      if (logResult.logCollectionFailed) receipt.logCollectionFailed = true;
      receipt.cleanup.push({ id, containerPresent: false });
    } catch { cleanupFailed = true; receipt.cleanup.push({ id, containerPresent: "UNCONFIRMED" }); }
  }
  if (networkId) {
    try {
      const current = JSON.parse(docker("network", "inspect", networkId))[0];
      assert.equal(current.Id, networkId); assert.equal(current.Labels?.[label], runId); assert.deepEqual(Object.keys(current.Containers), []);
      docker("network", "rm", networkId);
      assert.equal(docker("network", "ls", "--no-trunc", "--filter", `id=${networkId}`, "--format", "{{.ID}}"), ""); receipt.networkPresentAfterCleanup = false;
    } catch { cleanupFailed = true; receipt.networkPresentAfterCleanup = "UNCONFIRMED"; }
  }
  if (!cleanupFailed && fs.existsSync(fixture)) for (const name of fs.readdirSync(fixture).filter(name => /\.(key|csr)$/.test(name))) fs.unlinkSync(path.join(fixture, name));
  receipt.syntheticPrivateKeysRemoved = !cleanupFailed;
  if (receipt.logCollectionFailed && !failure) { failure = new Error("LOCAL_APPLICATION_LOG_COLLECTION_FAILED"); receipt.failureCode = failure.message; receipt.state = "FAILED"; }
  if (cleanupFailed) receipt.state = "FAIL_CLEANUP";
  receipt.capturedAt = new Date().toISOString(); write(path.join(results, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify({ output, state: receipt.state, productionTouched: false }));
}
if (failure || cleanupFailed) throw new Error(cleanupFailed ? "OWNED_APPLICATION_CLEANUP_UNCONFIRMED" : receipt.failureCode);
