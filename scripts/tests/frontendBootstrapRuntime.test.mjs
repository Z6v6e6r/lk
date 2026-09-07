import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { files } from "../frontend-release.mjs";
import { auditFrontendBootstrapHost } from "../audit_frontend_bootstrap_host.mjs";
import {
  createFrontendBootstrapRuntime,
  verifyFrontendBootstrapBundle,
} from "../frontend_bootstrap_runtime.mjs";
import {
  prepareFrontendBootstrapAuditKit,
  prepareFrontendBootstrapExecution,
} from "../prepare_frontend_bootstrap_execution.mjs";
import {
  buildFrontendStaticCandidate,
  prepareBootstrap,
} from "../nginx/prepare_frontend_static_bootstrap.mjs";

const digest = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const canonical = (value) => `${JSON.stringify(value, null, 2)}\n`;
const attemptId = "a".repeat(32);

const makeDirectory = (target, mode = 0o755) => {
  if (!fs.existsSync(target)) {
    fs.mkdirSync(target, { recursive: true, mode });
    fs.chmodSync(target, mode);
  }
};
const write = (target, bytes, mode = 0o644) => {
  makeDirectory(path.dirname(target));
  fs.writeFileSync(target, bytes, { mode });
  fs.chmodSync(target, mode);
};
const stat = (target) => {
  const value = fs.lstatSync(target);
  return { uid: value.uid, gid: value.gid, mode: value.mode & 0o777,
    dev: value.dev, ino: value.ino, nlink: value.nlink };
};
const mapped = (root, target) => path.join(root, target.slice(1));

const fixture = (t, { failFirstReload = false } = {}) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "lk-frontend-bootstrap-runtime-"));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const root = path.join(fs.realpathSync(sandbox), "host");
  const htmlRoot = mapped(root, "/var/www/html");
  const legacyRoot = mapped(root, "/var/www/html/lk");
  const configPath = mapped(root, "/etc/nginx/sites-enabled/padlhub.su");
  const machineId = Buffer.from("fixture-machine-id\n");
  const sourceConfig = Buffer.from(`server {
    location = /lk/release.json {
        root /var/www/html;
        try_files $uri =404;
    }
    location ^~ /lk/ {
        alias /var/www/html/lk/;
    }
}
`);
  const candidateConfig = Buffer.from(buildFrontendStaticCandidate(sourceConfig.toString("utf8"),
    digest(sourceConfig)).candidate);
  makeDirectory(htmlRoot);
  makeDirectory(legacyRoot);
  write(mapped(root, "/etc/machine-id"), machineId);
  write(configPath, sourceConfig);
  const source = "1".repeat(40);
  const version = "fixture-v1";
  const releaseManifest = Buffer.from(canonical({ sourceCommit: source, sourceDirty: false, version }));
  const publicBytes = {};
  for (const name of files) {
    const bytes = name === "release.json" ? releaseManifest : Buffer.from(`fixture ${name}\n`);
    publicBytes[name] = bytes;
    write(path.join(legacyRoot, name), bytes);
  }
  const preservedBytes = {};
  for (const name of ["index.html", "ffc-academy-lk.js", "ffc-academy-lk-dev.js", "release-dev.json"]) {
    const bytes = Buffer.from(`preserved ${name}\n`);
    preservedBytes[name] = bytes;
    write(path.join(legacyRoot, name), bytes);
  }
  for (const [name, bytes] of [["/usr/sbin/nginx", "nginx fixture\n"],
    ["/usr/bin/systemctl", "systemctl fixture\n"], ["/usr/bin/node", "node fixture\n"],
    ["/usr/bin/curl", "curl fixture\n"], ["/usr/bin/bash", "bash fixture\n"],
    ["/usr/bin/realpath", "realpath fixture\n"], ["/usr/bin/sha256sum", "sha256sum fixture\n"],
    ["/usr/bin/stat", "stat fixture\n"], ["/usr/bin/readlink", "readlink fixture\n"],
    ["/usr/bin/chown", "chown fixture\n"], ["/usr/bin/chmod", "chmod fixture\n"],
    ["/usr/bin/flock", "flock fixture\n"], ["/usr/bin/env", "env fixture\n"]]) {
    write(mapped(root, name), bytes, 0o755);
  }

  const record = (logicalPath) => {
    const target = mapped(root, logicalPath);
    return { path: logicalPath, realPath: logicalPath, stat: stat(target), sha256: digest(fs.readFileSync(target)) };
  };
  const host = {
    formatVersion: 1,
    kind: "lk-frontend-static-bootstrap-host-snapshot",
    capturedAt: new Date().toISOString(),
    hostname: "fixture-host",
    machineIdSha256: digest(machineId),
    config: record("/etc/nginx/sites-enabled/padlhub.su"),
    htmlRoot: { path: "/var/www/html", realPath: "/var/www/html", stat: stat(htmlRoot) },
    legacyRoot: { path: "/var/www/html/lk", realPath: "/var/www/html/lk", stat: stat(legacyRoot) },
    nginx: record("/usr/sbin/nginx"),
    systemctl: record("/usr/bin/systemctl"),
    node: record("/usr/bin/node"),
    curl: record("/usr/bin/curl"),
    producer: { kind: "lk-frontend-static-bootstrap-audit",
      sourceSha256: digest(fs.readFileSync(new URL("../audit_frontend_bootstrap_host.mjs", import.meta.url))),
      launcherSha256: "0".repeat(64), nodeSha256: record("/usr/bin/node").sha256 },
    launcherTools: Object.fromEntries(Object.entries({ bash: "/usr/bin/bash", realpath: "/usr/bin/realpath",
      sha256sum: "/usr/bin/sha256sum", stat: "/usr/bin/stat", readlink: "/usr/bin/readlink",
      chown: "/usr/bin/chown", chmod: "/usr/bin/chmod", flock: "/usr/bin/flock", env: "/usr/bin/env" })
      .map(([name, target]) => [name, record(target)])),
    nginxService: "nginx",
    assetBase: "https://padlhub.su/lk",
    originResolve: "padlhub.su:443:127.0.0.1",
    installed: { source, version,
      hashes: Object.fromEntries(files.map((name) => [name, digest(publicBytes[name])])) },
    installedStats: Object.fromEntries(files.map((name) => [name, stat(path.join(legacyRoot, name))])),
    preservedLegacy: Object.entries(preservedBytes).map(([name, bytes]) => ({
      name, sha256: digest(bytes), stat: stat(path.join(legacyRoot, name)),
    })),
    bootstrapState: { releasesExists: false, currentExists: false,
      globalLeaseExists: false, stagingEntries: [], orphanEntries: [] },
  };

  const candidate = path.join(sandbox, "candidate");
  const dist = path.join(sandbox, "dist");
  const fonts = path.join(sandbox, "fonts");
  makeDirectory(dist);
  makeDirectory(fonts);
  for (const name of files) write(name.startsWith("fonts/")
    ? path.join(fonts, path.basename(name)) : path.join(dist, name), publicBytes[name]);
  prepareBootstrap({ sourceNginx: configPath, expectedSourceSha: digest(sourceConfig),
    installed: host.installed, distDir: dist, fontsDir: fonts, outDir: candidate });
  const parent = path.join(sandbox, "private");
  makeDirectory(parent, 0o700);
  const output = path.join(parent, "execution");
  const guardBytes = Buffer.from("fixture static guard\n");
  const guardSource = fs.readFileSync(new URL("../frontend_bootstrap_guard.c", import.meta.url));
  const prepared = prepareFrontendBootstrapExecution({ candidateDirectory: candidate,
    hostSnapshot: host, outputDirectory: output, production: false,
    guardArtifact: { bytes: guardBytes, sha256: digest(guardBytes), sourceSha256: digest(guardSource),
      image: "fixture@sha256", flags: ["-static"] } });
  const verified = verifyFrontendBootstrapBundle({ bundleRoot: output,
    manifestSha256: prepared.manifestSha256, expectedUid: process.getuid(), production: false });
  let reloads = 0;
  const guardExecutables = [];
  const execFile = (command, args, options = {}) => {
    if (command.startsWith("/proc/self/fd/") && args[0] === "exchange") {
      guardExecutables.push(command);
      const replacement = args[args.indexOf("--replacement") + 1];
      fs.renameSync(replacement, configPath);
      return "";
    }
    if (command.endsWith("/systemctl") && args[0] === "is-active") return "active\n";
    if (command.endsWith("/systemctl") && args[0] === "reload") {
      reloads += 1;
      if (failFirstReload && reloads === 1) throw new Error("injected reload failure");
      return "";
    }
    if (command.endsWith("/nginx") && args[0] === "-t") return "";
    if (command.endsWith("/curl")) {
      if (args.includes("-X")) {
        if (args[args.indexOf("-X") + 1] === "OPTIONS") return "204";
        return fs.readFileSync(configPath).equals(candidateConfig) ? "403" : "405";
      }
      if (args.includes("-I") || args.includes("-fsSI")) {
        const url = args.at(-1);
        return `HTTP/1.1 200 OK\nAccess-Control-Allow-Origin: *\n${url.includes("release.json")
          ? "Cache-Control: no-store\n" : "Cache-Control: public, max-age=31536000, immutable\n"}`;
      }
      const url = new URL(args.at(-1));
      const name = decodeURIComponent(url.pathname.split("/lk/")[1]);
      const bytes = publicBytes[name] || preservedBytes[name];
      if (!bytes) throw new Error(`Unexpected public fixture request: ${name}`);
      return options.encoding === null ? Buffer.from(bytes) : bytes.toString("utf8");
    }
    throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
  };
  const runtime = createFrontendBootstrapRuntime({ verified, rootPrefix: root, production: false,
    hostname: () => host.hostname, machineIdBytes: () => machineId, execFile });
  return { sandbox, root, host, candidate, output, prepared, verified, runtime, sourceConfig, candidateConfig,
    machineId, configPath, execFile, guardExecutables,
    get reloads() { return reloads; } };
};

test("runtime exchanges through the retained exact guard descriptor after its path is replaced", (t) => {
  const value = fixture(t);
  const guardPath = path.join(value.output, "payload/guard");
  const displacedPath = `${guardPath}.displaced`;
  const guardFd = fs.openSync(guardPath, fs.constants.O_RDONLY);
  t.after(() => fs.closeSync(guardFd));
  fs.renameSync(guardPath, displacedPath);
  fs.writeFileSync(guardPath, "#!/bin/sh\nexit 0\n", { mode: 0o500 });
  fs.chmodSync(guardPath, 0o500);
  const runtime = createFrontendBootstrapRuntime({ verified: value.verified, rootPrefix: value.root,
    production: false, pinnedGuardExecution: true, guardFd,
    hostname: () => value.host.hostname, machineIdBytes: () => value.machineId,
    execFile: value.execFile });
  runtime.initialize({ attemptId });
  assert.equal(runtime.apply({ attemptId }).state, "SERVER_SUCCESS");
  assert.deepEqual(value.guardExecutables, [`/proc/self/fd/${guardFd}`]);
  assert.equal(runtime.configState().state, "candidate");
});

test("bootstrap holds both leases after server success until explicit finalize", (t) => {
  const value = fixture(t);
  assert.equal(value.runtime.preflight().ok, true);
  value.runtime.initialize({ attemptId });
  const result = value.runtime.apply({ attemptId });
  assert.equal(result.state, "SERVER_SUCCESS");
  assert.equal(result.awaitingFinalize, true);
  assert.equal(value.runtime.configState().state, "candidate");
  assert.equal(value.runtime.currentState(), "expected");
  assert.equal(value.reloads, 1);
  assert.equal(fs.existsSync(value.runtime.paths.globalLease), true);
  assert.equal(fs.existsSync(value.runtime.paths.releaseLease), true);
  assert.equal(value.runtime.finalize({ attemptId }).state, "SUCCESS");
  assert.equal(fs.existsSync(value.runtime.paths.globalLease), false);
  assert.equal(fs.existsSync(value.runtime.paths.releaseLease), false);
});

test("explicit rollback remains available after server success and before finalize", (t) => {
  const value = fixture(t);
  value.runtime.initialize({ attemptId });
  assert.equal(value.runtime.apply({ attemptId }).state, "SERVER_SUCCESS");
  const result = value.runtime.rollback({ attemptId });
  assert.equal(result.state, "ROLLED_BACK");
  assert.equal(value.runtime.configState().state, "source");
  assert.equal(value.runtime.currentState(), "expected");
  assert.equal(fs.existsSync(value.runtime.paths.globalLease), false);
  assert.equal(fs.existsSync(value.runtime.paths.releaseLease), false);
});

test("recovery honors a durable rollback intent ahead of server success", (t) => {
  const value = fixture(t);
  value.runtime.initialize({ attemptId });
  assert.equal(value.runtime.apply({ attemptId }).state, "SERVER_SUCCESS");
  const evidence = path.join(value.runtime.paths.evidenceRoot,
    `${value.verified.manifest.deploymentId}-${attemptId}`);
  const rollbackIntent = path.join(evidence, "90-rollback-requested.json");
  fs.writeFileSync(rollbackIntent, canonical({
    formatVersion: 1,
    kind: "lk-frontend-static-bootstrap-journal",
    deploymentId: value.verified.manifest.deploymentId,
    manifestSha256: digest(value.verified.manifestBytes),
    attemptId,
    state: "ROLLBACK_REQUESTED",
    observedAt: new Date().toISOString(),
    reason: "fixture crash after durable rollback intent",
  }), { mode: 0o600 });
  fs.chmodSync(rollbackIntent, 0o600);
  assert.equal(value.runtime.prepareRecovery({ attemptId }).terminalState, null);
  const result = value.runtime.recover({ attemptId });
  assert.equal(result.state, "ROLLED_BACK");
  assert.equal(value.runtime.configState().state, "source");
});

test("failed activation restores exact source, verifies it and keeps the retained baseline", async (t) => {
  const value = fixture(t, { failFirstReload: true });
  value.runtime.initialize({ attemptId });
  assert.throws(() => value.runtime.apply({ attemptId }), /exact nginx source restored/);
  assert.equal(value.runtime.configState().state, "source");
  assert.equal(value.runtime.currentState(), "expected");
  assert.equal(value.reloads, 2);
  assert.equal(fs.existsSync(value.runtime.paths.globalLease), false);
  assert.equal(fs.existsSync(value.runtime.paths.releaseLease), false);
});

test("recovery repairs an interrupted journal initialization and resumes exact activation", (t) => {
  const value = fixture(t);
  value.runtime.initialize({ attemptId });
  fs.unlinkSync(path.join(value.runtime.paths.evidenceRoot,
    `${value.verified.manifest.deploymentId}-${attemptId}`, "00-intent.json"));
  const prepared = value.runtime.prepareRecovery({ attemptId });
  assert.equal(prepared.terminalState, null);
  const result = value.runtime.recover({ attemptId });
  assert.equal(result.state, "SERVER_SUCCESS");
  assert.equal(value.runtime.configState().state, "candidate");
  assert.equal(value.reloads, 1);
  assert.equal(value.runtime.finalize({ attemptId }).state, "SUCCESS");
});

test("recovery completes an atomically unpublished release root from the global lease", (t) => {
  const value = fixture(t);
  value.runtime.preflight();
  const lease = {
    formatVersion: 1, kind: "lk-frontend-static-bootstrap-lease",
    deploymentId: value.verified.manifest.deploymentId,
    manifestSha256: digest(value.verified.manifestBytes), attemptId, phase: "INITIALIZING",
    sourceSha256: value.verified.manifest.bootstrap.nginxSourceSha256,
    candidateSha256: value.verified.manifest.bootstrap.nginxCandidateSha256,
    releaseName: value.verified.manifest.bootstrap.releaseName,
  };
  write(value.runtime.paths.globalLease, canonical(lease), 0o600);
  const staging = path.join(path.dirname(value.runtime.paths.releases),
    `.lk-frontend-releases-bootstrap-${attemptId}`);
  makeDirectory(staging, 0o755);
  value.runtime.prepareRecovery({ attemptId });
  assert.equal(fs.existsSync(staging), false);
  assert.equal(fs.existsSync(value.runtime.paths.releaseLease), true);
  assert.equal(value.runtime.recover({ attemptId }).state, "SERVER_SUCCESS");
  assert.equal(value.runtime.finalize({ attemptId }).state, "SUCCESS");
});

test("recovery removes an owned partial release temp before inventory", (t) => {
  const value = fixture(t);
  value.runtime.initialize({ attemptId });
  const temporary = path.join(value.runtime.paths.releases, `.bootstrap-${attemptId}`);
  makeDirectory(temporary, 0o700);
  makeDirectory(path.join(temporary, "fonts"), 0o700);
  write(path.join(temporary, `.bundle.js.${attemptId}.new`), "partial", 0o600);
  value.runtime.prepareRecovery({ attemptId });
  assert.equal(value.runtime.recover({ attemptId }).state, "SERVER_SUCCESS");
  assert.equal(value.runtime.finalize({ attemptId }).state, "SUCCESS");
  assert.equal(value.runtime.currentState(), "expected");
});

test("recovery unlinks an exact target plus hardlink temp orphan", (t) => {
  const value = fixture(t);
  value.runtime.initialize({ attemptId });
  const partial = path.join(value.runtime.paths.releases, `.bootstrap-${attemptId}`);
  makeDirectory(partial, 0o700);
  makeDirectory(path.join(partial, "fonts"), 0o700);
  const name = "fonts/SourceCodePro-Regular.woff2";
  const target = path.join(partial, name);
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${attemptId}.new`);
  write(temporary, fs.readFileSync(path.join(value.output, "payload/release", name)), 0o644);
  fs.linkSync(temporary, target);
  value.runtime.prepareRecovery({ attemptId });
  assert.equal(value.runtime.recover({ attemptId }).state, "SERVER_SUCCESS");
  assert.equal(fs.existsSync(temporary), false);
  assert.equal(value.runtime.finalize({ attemptId }).state, "SUCCESS");
});

test("recovery clears an owned partial nginx temp while source remains live", (t) => {
  const value = fixture(t);
  value.runtime.initialize({ attemptId });
  const temporary = path.join(path.dirname(value.runtime.paths.config),
    `.${path.basename(value.runtime.paths.config)}.${attemptId}.tmp`);
  write(temporary, "partial nginx candidate", 0o600);
  value.runtime.prepareRecovery({ attemptId });
  assert.equal(fs.existsSync(temporary), false);
  assert.equal(value.runtime.recover({ attemptId }).state, "SERVER_SUCCESS");
  assert.equal(value.runtime.finalize({ attemptId }).state, "SUCCESS");
});

test("recovery clears the displaced source after a completed nginx exchange", (t) => {
  const value = fixture(t);
  value.runtime.initialize({ attemptId });
  assert.equal(value.runtime.apply({ attemptId }).state, "SERVER_SUCCESS");
  const temporary = path.join(path.dirname(value.runtime.paths.config),
    `.${path.basename(value.runtime.paths.config)}.${attemptId}.tmp`);
  write(temporary, value.sourceConfig, 0o644);
  assert.equal(value.runtime.prepareRecovery({ attemptId }).terminalState, null);
  assert.equal(fs.existsSync(temporary), false);
  assert.equal(value.runtime.recover({ attemptId }).state, "SERVER_SUCCESS");
  assert.equal(value.runtime.finalize({ attemptId }).state, "SUCCESS");
});

test("candidate nginx without the exact current link fails before another reload", (t) => {
  const value = fixture(t);
  value.runtime.initialize({ attemptId });
  assert.equal(value.runtime.apply({ attemptId }).state, "SERVER_SUCCESS");
  fs.unlinkSync(value.runtime.paths.current);
  const reloadsBefore = value.reloads;
  assert.throws(() => value.runtime.prepareRecovery({ attemptId }), /requires the exact current release/);
  assert.equal(value.reloads, reloadsBefore);
  assert.equal(fs.existsSync(value.runtime.paths.globalLease), true);
  assert.equal(fs.existsSync(value.runtime.paths.releaseLease), true);
});

test("terminal rollback retains leases when retained topology is damaged", (t) => {
  const value = fixture(t);
  value.runtime.initialize({ attemptId });
  const globalLease = fs.readFileSync(value.runtime.paths.globalLease);
  const releaseLease = fs.readFileSync(value.runtime.paths.releaseLease);
  assert.equal(value.runtime.apply({ attemptId }).state, "SERVER_SUCCESS");
  assert.equal(value.runtime.rollback({ attemptId }).state, "ROLLED_BACK");
  write(value.runtime.paths.globalLease, globalLease, 0o600);
  write(value.runtime.paths.releaseLease, releaseLease, 0o600);
  fs.unlinkSync(value.runtime.paths.current);
  assert.equal(value.runtime.prepareRecovery({ attemptId }).terminalState, "ROLLED_BACK");
  assert.throws(() => value.runtime.recover({ attemptId }), /frontend current state/);
  assert.equal(fs.existsSync(value.runtime.paths.globalLease), true);
  assert.equal(fs.existsSync(value.runtime.paths.releaseLease), true);
});

test("an unknown-attempt global lease temp fails closed", (t) => {
  const value = fixture(t);
  write(path.join(value.runtime.paths.htmlRoot,
    `..lk-frontend-bootstrap.lease.json.${"b".repeat(32)}.new`), "orphan", 0o600);
  assert.throws(() => value.runtime.preflight(), /target state is not empty|HTML root nlink drift/);
});

test("recovery finishes a crash between durable success receipt and final lease release", (t) => {
  const value = fixture(t);
  value.runtime.initialize({ attemptId });
  const releaseLease = fs.readFileSync(value.runtime.paths.releaseLease);
  assert.equal(value.runtime.apply({ attemptId }).state, "SERVER_SUCCESS");
  assert.equal(value.runtime.finalize({ attemptId }).state, "SUCCESS");
  write(value.runtime.paths.releaseLease, releaseLease, 0o600);
  assert.equal(value.runtime.prepareRecovery({ attemptId }).terminalState, "SUCCESS");
  const result = value.runtime.recover({ attemptId });
  assert.equal(result.state, "SUCCESS");
  assert.equal(result.resumedLeaseRelease, true);
  assert.equal(fs.existsSync(value.runtime.paths.releaseLease), false);
});

test("unknown nginx drift is never overwritten and keeps both leases", (t) => {
  const value = fixture(t);
  value.runtime.initialize({ attemptId });
  fs.writeFileSync(value.runtime.paths.config, "unknown config\n");
  assert.throws(() => value.runtime.prepareRecovery({ attemptId }), /ambiguous/);
  assert.equal(fs.existsSync(value.runtime.paths.globalLease), true);
  assert.equal(fs.existsSync(value.runtime.paths.releaseLease), true);
  assert.equal(fs.readFileSync(value.runtime.paths.config, "utf8"), "unknown config\n");
});

test("verified bundle rejects directory mode drift and added symlinks", (t) => {
  const value = fixture(t);
  const payload = path.join(value.output, "payload");
  fs.chmodSync(payload, 0o755);
  assert.throws(() => verifyFrontendBootstrapBundle({ bundleRoot: value.output,
    manifestSha256: value.prepared.manifestSha256, expectedUid: process.getuid(), production: false }),
  /directory custody/);
  fs.chmodSync(payload, 0o700);
  fs.symlinkSync("manifest.json", path.join(value.output, "foreign-link"));
  assert.throws(() => verifyFrontendBootstrapBundle({ bundleRoot: value.output,
    manifestSha256: value.prepared.manifestSha256, expectedUid: process.getuid(), production: false }),
  /symlink or special file/);
});

test("verified bundle rejects a coherent manifest with a cross-bound runtime", (t) => {
  const value = fixture(t);
  const manifestPath = path.join(value.output, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.repository = { commit: "1".repeat(40), sources: [
    { path: "scripts/frontend_bootstrap_runtime.mjs", sha256: "f".repeat(64) },
    { path: "scripts/frontend_bootstrap_guard.c", sha256: manifest.guard.sourceSha256 },
    { path: "scripts/frontend_bootstrap_exec_launcher.c", sha256: manifest.launcher.sourceSha256 },
  ] };
  const bytes = Buffer.from(canonical(manifest));
  fs.chmodSync(manifestPath, 0o600);
  fs.writeFileSync(manifestPath, bytes);
  fs.chmodSync(manifestPath, 0o400);
  assert.throws(() => verifyFrontendBootstrapBundle({ bundleRoot: value.output,
    manifestSha256: digest(bytes), expectedUid: process.getuid(), production: false }),
  /payload and repository source binding/);
});

test("verified bundle rejects a cross-bound audit producer", (t) => {
  const value = fixture(t);
  const manifestPath = path.join(value.output, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const runtimeRow = manifest.files.find((row) => row.path === "payload/runtime.mjs");
  manifest.host.producer.launcherSha256 = manifest.launcher.sha256;
  manifest.host.producer.nodeSha256 = manifest.host.node.sha256;
  manifest.repository = { commit: "1".repeat(40), sources: [
    { path: "scripts/frontend_bootstrap_runtime.mjs", sha256: runtimeRow.sha256 },
    { path: "scripts/frontend_bootstrap_guard.c", sha256: manifest.guard.sourceSha256 },
    { path: "scripts/frontend_bootstrap_exec_launcher.c", sha256: manifest.launcher.sourceSha256 },
    { path: "scripts/audit_frontend_bootstrap_host.mjs", sha256: "f".repeat(64) },
  ] };
  const bytes = Buffer.from(canonical(manifest));
  fs.chmodSync(manifestPath, 0o600);
  fs.writeFileSync(manifestPath, bytes);
  fs.chmodSync(manifestPath, 0o400);
  assert.throws(() => verifyFrontendBootstrapBundle({ bundleRoot: value.output,
    manifestSha256: digest(bytes), expectedUid: process.getuid(), production: false }),
  /payload and repository source binding/);
});

test("execution builder rejects a coherent-looking but non-deterministic nginx candidate", (t) => {
  const value = fixture(t);
  const candidate = value.candidate;
  const candidatePath = path.join(candidate, "nginx.candidate.conf");
  const bytes = Buffer.from(`${fs.readFileSync(candidatePath, "utf8")}# coherent tamper\n`);
  fs.writeFileSync(candidatePath, bytes);
  const planPath = path.join(candidate, "bootstrap.json");
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  plan.nginx.candidateSha = digest(bytes);
  plan.rollback.expectedLiveSha = plan.nginx.candidateSha;
  fs.chmodSync(planPath, 0o600);
  fs.writeFileSync(planPath, canonical(plan));
  fs.chmodSync(planPath, 0o400);
  const guardBytes = Buffer.from("fixture static guard\n");
  const guardSource = fs.readFileSync(new URL("../frontend_bootstrap_guard.c", import.meta.url));
  assert.throws(() => prepareFrontendBootstrapExecution({ candidateDirectory: candidate,
    hostSnapshot: value.host, outputDirectory: path.join(value.sandbox, "private", "tampered"),
    production: false, guardArtifact: { bytes: guardBytes, sha256: digest(guardBytes),
      sourceSha256: digest(guardSource), image: "fixture@sha256", flags: ["-static"] } }),
  /deterministic source transform/);
});

test("execution builder rejects changed offline bootstrap gates", (t) => {
  const value = fixture(t);
  const planPath = path.join(value.candidate, "bootstrap.json");
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  plan.gates[0] = "tampered gate";
  fs.chmodSync(planPath, 0o600);
  fs.writeFileSync(planPath, canonical(plan));
  fs.chmodSync(planPath, 0o400);
  const guardBytes = Buffer.from("fixture static guard\n");
  const guardSource = fs.readFileSync(new URL("../frontend_bootstrap_guard.c", import.meta.url));
  assert.throws(() => prepareFrontendBootstrapExecution({ candidateDirectory: value.candidate,
    hostSnapshot: value.host, outputDirectory: path.join(value.sandbox, "private", "tampered-gates"),
    production: false, guardArtifact: { bytes: guardBytes, sha256: digest(guardBytes),
      sourceSha256: digest(guardSource), image: "fixture@sha256", flags: ["-static"] } }),
  /policy metadata mismatch/);
});

test("execution builder rejects changed offline bootstrap rollback policy", (t) => {
  const value = fixture(t);
  const planPath = path.join(value.candidate, "bootstrap.json");
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  plan.rollback.rule = "tampered rollback";
  fs.chmodSync(planPath, 0o600);
  fs.writeFileSync(planPath, canonical(plan));
  fs.chmodSync(planPath, 0o400);
  const guardBytes = Buffer.from("fixture static guard\n");
  const guardSource = fs.readFileSync(new URL("../frontend_bootstrap_guard.c", import.meta.url));
  assert.throws(() => prepareFrontendBootstrapExecution({ candidateDirectory: value.candidate,
    hostSnapshot: value.host, outputDirectory: path.join(value.sandbox, "private", "tampered-rollback"),
    production: false, guardArtifact: { bytes: guardBytes, sha256: digest(guardBytes),
      sourceSha256: digest(guardSource), image: "fixture@sha256", flags: ["-static"] } }),
  /policy metadata mismatch/);
});

test("standalone host audit captures every launcher tool and exact legacy preimage", (t) => {
  const value = fixture(t);
  const tool = (target) => mapped(value.root, target);
  const snapshot = auditFrontendBootstrapHost({
    configPath: tool("/etc/nginx/sites-enabled/padlhub.su"), htmlRoot: tool("/var/www/html"),
    legacyRoot: tool("/var/www/html/lk"), nginxPath: tool("/usr/sbin/nginx"),
    systemctlPath: tool("/usr/bin/systemctl"), nodePath: tool("/usr/bin/node"),
    curlPath: tool("/usr/bin/curl"), machineIdPath: tool("/etc/machine-id"), hostname: "fixture-host",
    bashPath: tool("/usr/bin/bash"), realpathPath: tool("/usr/bin/realpath"),
    sha256sumPath: tool("/usr/bin/sha256sum"), statPath: tool("/usr/bin/stat"),
    readlinkPath: tool("/usr/bin/readlink"), chownPath: tool("/usr/bin/chown"),
    chmodPath: tool("/usr/bin/chmod"), flockPath: tool("/usr/bin/flock"), envPath: tool("/usr/bin/env"),
  });
  assert.deepEqual(Object.keys(snapshot.launcherTools).sort(),
    ["bash", "chmod", "chown", "env", "flock", "readlink", "realpath", "sha256sum", "stat"]);
  assert.equal(snapshot.launcherTools.bash.path, tool("/usr/bin/bash"));
  assert.equal(snapshot.launcherTools.bash.realPath, tool("/usr/bin/bash"));
  assert.deepEqual(Object.keys(snapshot.installedStats).sort(), [...files].sort());
  assert.deepEqual(snapshot.bootstrapState.stagingEntries, []);
  assert.equal(snapshot.producer.sourceSha256,
    digest(fs.readFileSync(new URL("../audit_frontend_bootstrap_host.mjs", import.meta.url))));
  assert.equal(snapshot.producer.nodeSha256, snapshot.node.sha256);
});

test("audit-kit builder emits a private exact launcher and committed-source payload", (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "lk-frontend-audit-kit-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  fs.chmodSync(parent, 0o700);
  const launcherBytes = Buffer.from("fixture launcher\n");
  const launcherSource = fs.readFileSync(new URL("../frontend_bootstrap_exec_launcher.c", import.meta.url));
  const result = prepareFrontendBootstrapAuditKit({ outputDirectory: path.join(parent, "kit"),
    production: false, launcherArtifact: { bytes: launcherBytes, sha256: digest(launcherBytes),
      sourceSha256: digest(launcherSource), image: "fixture@sha256", flags: ["-static"] } });
  assert.equal(fs.readFileSync(path.join(result.output, "launcher")).equals(launcherBytes), true);
  assert.equal(fs.lstatSync(path.join(result.output, "launcher")).mode & 0o777, 0o500);
  assert.equal(fs.lstatSync(path.join(result.output, "audit.mjs")).mode & 0o777, 0o400);
  assert.equal(result.auditSourceSha256,
    digest(fs.readFileSync(new URL("../audit_frontend_bootstrap_host.mjs", import.meta.url))));
});

test("execution builder rejects a stale host snapshot", (t) => {
  const value = fixture(t);
  const stale = structuredClone(value.host);
  stale.capturedAt = new Date(Date.now() - 16 * 60_000).toISOString();
  const guardBytes = Buffer.from("fixture static guard\n");
  const guardSource = fs.readFileSync(new URL("../frontend_bootstrap_guard.c", import.meta.url));
  assert.throws(() => prepareFrontendBootstrapExecution({ candidateDirectory: path.join(value.sandbox, "candidate"),
    hostSnapshot: stale, outputDirectory: path.join(value.sandbox, "private", "stale"), production: false,
    guardArtifact: { bytes: guardBytes, sha256: digest(guardBytes), sourceSha256: digest(guardSource),
      image: "fixture@sha256", flags: ["-static"] } }),
  /snapshot is stale/);
});

test("execution builder rejects unknown host snapshot fields instead of carrying them into the bundle", (t) => {
  const value = fixture(t);
  const tampered = structuredClone(value.host);
  tampered.secret = "must-not-cross-the-builder-boundary";
  assert.throws(() => prepareFrontendBootstrapExecution({
    candidateDirectory: path.join(value.sandbox, "candidate"), hostSnapshot: tampered,
    outputDirectory: path.join(value.sandbox, "private", "unknown-host-field"), production: false,
  }), /host snapshot schema mismatch/);
});

test("execution builder rejects value-level hostname smuggling", (t) => {
  const value = fixture(t);
  const tampered = structuredClone(value.host);
  tampered.hostname = { secret: "must-not-cross-the-builder-boundary" };
  assert.throws(() => prepareFrontendBootstrapExecution({
    candidateDirectory: path.join(value.sandbox, "candidate"), hostSnapshot: tampered,
    outputDirectory: path.join(value.sandbox, "private", "hostname-smuggling"), production: false,
  }), /host snapshot contract mismatch/);
});

test("production builder rejects a Node preload environment before output", (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "lk-frontend-builder-env-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  fs.chmodSync(parent, 0o700);
  const previous = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = "--require=/tmp/never-load.cjs";
  try {
    assert.throws(() => prepareFrontendBootstrapAuditKit({
      outputDirectory: path.join(parent, "audit-kit"), production: true,
    }), /refuses Node preload environment/);
  } finally {
    if (previous === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previous;
  }
});

test("production builder rejects an invalid Darwin text-encoding environment", (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "lk-frontend-builder-cf-env-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  fs.chmodSync(parent, 0o700);
  const previous = process.env.__CF_USER_TEXT_ENCODING;
  process.env.__CF_USER_TEXT_ENCODING = "secret-smuggling";
  try {
    assert.throws(() => prepareFrontendBootstrapAuditKit({
      outputDirectory: path.join(parent, "audit-kit"), production: true,
    }), /exact clean environment/);
  } finally {
    if (previous === undefined) delete process.env.__CF_USER_TEXT_ENCODING;
    else process.env.__CF_USER_TEXT_ENCODING = previous;
  }
});

test("builder import cannot execute a malicious repository node_modules package", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lk-frontend-builder-import-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  makeDirectory(path.join(root, "scripts"), 0o700);
  const copy = path.join(root, "scripts/prepare_frontend_bootstrap_execution.mjs");
  fs.copyFileSync(new URL("../prepare_frontend_bootstrap_execution.mjs", import.meta.url), copy);
  const dependency = path.join(root, "node_modules/typescript");
  makeDirectory(dependency, 0o700);
  const marker = path.join(root, "malicious-package-executed");
  write(path.join(dependency, "package.json"), canonical({ type: "module", main: "index.mjs" }), 0o600);
  write(path.join(dependency, "index.mjs"), `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(marker)}, "x");\n`, 0o600);
  const result = spawnSync(process.execPath, ["--input-type=module", "-e",
    `await import(${JSON.stringify(pathToFileURL(copy).href)});`], {
    cwd: root, encoding: "utf8", env: { ...process.env, NODE_PATH: path.join(root, "node_modules") },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(marker), false);
});

test("external env-i prevents NODE_OPTIONS from preloading before the production builder", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lk-frontend-builder-preload-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.chmodSync(root, 0o700);
  const marker = path.join(root, "preload-marker");
  const preload = path.join(root, "preload.cjs");
  write(preload, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed");\n`, 0o600);
  const builder = path.resolve(new URL("../prepare_frontend_bootstrap_execution.mjs", import.meta.url).pathname);
  const repository = path.resolve(new URL("../../", import.meta.url).pathname);
  const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).stdout.trim();
  const result = spawnSync("/usr/bin/env", ["-i",
    "PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", "LANG=C", "LC_ALL=C",
    `LK_FRONTEND_REPOSITORY=${repository}`, `LK_FRONTEND_BUILDER_COMMIT=${commit}`,
    `LK_FRONTEND_BUILDER_SHA256=${"f".repeat(64)}`,
    `LK_FRONTEND_NODE_PATH=${process.execPath}`,
    `LK_FRONTEND_NODE_SHA256=${digest(fs.readFileSync(process.execPath))}`,
    process.execPath, builder, "--audit-kit", path.join(root, "kit")], {
    cwd: repository, encoding: "utf8", env: { ...process.env, NODE_OPTIONS: `--require=${preload}` },
  });
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(marker), false);
});

test("static guard pins executable hashes, lock descriptors, clean env and atomic exchange", () => {
  const source = fs.readFileSync(new URL("../frontend_bootstrap_guard.c", import.meta.url), "utf8");
  assert.match(source, /SELF_DIGEST_MISMATCH/);
  assert.match(source, /fexecve\(node_descriptor/);
  assert.match(source, /open_lock\(GLOBAL_LOCK, 3\)/);
  assert.match(source, /open_lock\(NGINX_LOCK, 5\)/);
  assert.match(source, /SYS_renameat2/);
  assert.match(source, /RENAME_EXCHANGE/);
  assert.match(source, /CONFIRM_EXACT_BOOTSTRAP/);
  assert.match(source, /PR_SET_CHILD_SUBREAPER/);
  assert.match(source, /kill\(-child, SIGKILL\)/);
});
