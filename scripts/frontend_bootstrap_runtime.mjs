#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SHA256 = /^[a-f0-9]{64}$/;
const ATTEMPT = /^[a-f0-9]{32}$/;
const DEPLOYMENT = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;
const KIND = "lk-frontend-static-bootstrap-execution";
const GUARD_IMAGE = "node@sha256:0557ac14e0d45d02ed563067b82856ca5e7aa3437fa28d98d4350ea9c3d9494a";
const GUARD_FLAGS = Object.freeze([
  "-static", "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-fno-ident",
  "-ffile-prefix-map=/src=.", "-Wl,--build-id=none", "-s",
]);
const EXECUTION_SOURCES = Object.freeze([
  "scripts/frontend_bootstrap_guard.c",
  "scripts/frontend_bootstrap_exec_launcher.c",
  "scripts/frontend_bootstrap_runtime.mjs",
  "scripts/prepare_frontend_bootstrap_execution.mjs",
  "scripts/audit_frontend_bootstrap_host.mjs",
]);
const GLOBAL_LOCK = "/var/www/html/.lk-frontend-bootstrap.lock";
const NGINX_LOCK = "/etc/nginx/.padlhub-nginx-writer.lock";
const GLOBAL_LEASE = "/var/www/html/.lk-frontend-bootstrap.lease.json";
const RELEASES = "/var/www/html/lk-frontend-releases";
const RELEASE_LOCK = `${RELEASES}/.lock`;
const RELEASE_LEASE = `${RELEASES}/.lease.json`;
const CURRENT = "/var/www/html/lk-frontend-current";
const EVIDENCE_ROOT = `${RELEASES}/.bootstrap-evidence`;
const CONFIRMATIONS = Object.freeze({
  apply: ["LK_FRONTEND_BOOTSTRAP_APPLY", "CONFIRM_EXACT_BOOTSTRAP"],
  recover: ["LK_FRONTEND_BOOTSTRAP_RECOVER", "CONFIRM_EXACT_BOOTSTRAP_RECOVERY"],
  rollback: ["LK_FRONTEND_BOOTSTRAP_ROLLBACK", "CONFIRM_EXACT_BOOTSTRAP_ROLLBACK"],
  finalize: ["LK_FRONTEND_BOOTSTRAP_FINALIZE", "CONFIRM_EXACT_BOOTSTRAP_FINALIZE"],
});
const EXPECTED_PUBLIC_FILES = Object.freeze([
  "bundle.js", "games.js", "tournaments.js", "tournament-signup.js", "group-schedule.js",
  "padel-day-schedule.js", "tournament-subscription.js", "tournament-subscription-referral.js",
  "onboarding.js", "levels-info.js", "communities.js", "release.json",
  "fonts/rf-dewi-ultrabold.woff2", "fonts/rf-dewi-expanded-ultrabold-italic.woff2",
  "fonts/SourceCodePro-Medium.woff2", "fonts/SourceCodePro-Regular.woff2",
]);

const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const canonical = (value) => `${JSON.stringify(value, null, 2)}\n`;
const fail = (message) => { throw new Error(message); };
const exactKeys = (value, keys, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    fail(`${label} schema mismatch`);
  }
};
const pathExists = (target, fsApi = fs) => {
  try { fsApi.lstatSync(target); return true; }
  catch (error) { if (error?.code === "ENOENT") return false; throw error; }
};
const mapped = (rootPrefix, target) => {
  if (!path.isAbsolute(target) || target.includes("..")) fail("Runtime path is invalid");
  if (!rootPrefix) return target;
  const root = path.resolve(rootPrefix);
  const result = path.resolve(root, `.${target}`);
  if (!result.startsWith(`${root}${path.sep}`)) fail("Runtime path escaped rehearsal root");
  return result;
};
const fsyncDirectory = (directory, fsApi = fs) => {
  const fd = fsApi.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_CLOEXEC
    | (fs.constants.O_DIRECTORY || 0));
  try { fsApi.fsyncSync(fd); } finally { fsApi.closeSync(fd); }
};
const durableTemporaryPath = (target, attemptId) => path.join(
  path.dirname(target), `.${path.basename(target)}.${attemptId}.new`,
);
const durableTemporaryPrefix = (target) => `.${path.basename(target)}.`;
const writeExclusive = (target, bytes, {
  mode = 0o600, uid, gid, attemptId, fsApi = fs,
} = {}) => {
  if (!ATTEMPT.test(String(attemptId || ""))) fail("Durable publication attempt ID is invalid");
  const temporary = durableTemporaryPath(target, attemptId);
  const expectedBytes = Buffer.from(bytes);
  const assertExactTarget = ({ allowLinked = false } = {}) => {
    const value = assertRegular(target, `Durable file ${path.basename(target)}`, {
      uid, gid, mode,
    }, fsApi);
    if ((!allowLinked && value.nlink !== 1) || (allowLinked && ![1, 2].includes(value.nlink))
      || !fsApi.readFileSync(target).equals(expectedBytes)) fail("Durable target drift");
    return value;
  };
  if (pathExists(temporary, fsApi)) {
    const temp = assertRegular(temporary, "Durable publication temporary", { uid, gid }, fsApi);
    const temporaryMode = temp.mode & 0o777;
    if (![0o600, mode].includes(temporaryMode) || ![1, 2].includes(temp.nlink)) {
      fail("Durable publication temporary custody drift");
    }
    if (pathExists(target, fsApi)) {
      const published = assertExactTarget({ allowLinked: true });
      if (published.dev !== temp.dev || published.ino !== temp.ino) {
        fail("Durable publication orphan identity drift");
      }
      fsApi.unlinkSync(temporary);
      fsyncDirectory(path.dirname(target), fsApi);
      assertExactTarget();
      return false;
    }
    fsApi.unlinkSync(temporary);
    fsyncDirectory(path.dirname(target), fsApi);
  }
  if (pathExists(target, fsApi)) { assertExactTarget(); return false; }
  let fd;
  let created = false;
  try {
    fd = fsApi.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY
      | fs.constants.O_CLOEXEC | fs.constants.O_NOFOLLOW, mode);
    created = true;
    fsApi.writeFileSync(fd, expectedBytes);
    fsApi.fchmodSync(fd, mode);
    if (uid !== undefined && typeof fsApi.fchownSync === "function") fsApi.fchownSync(fd, uid, gid);
    fsApi.fsyncSync(fd);
    fsApi.closeSync(fd);
    fd = undefined;
    fsApi.linkSync(temporary, target);
    fsyncDirectory(path.dirname(target), fsApi);
    fsApi.unlinkSync(temporary);
    fsyncDirectory(path.dirname(target), fsApi);
    assertExactTarget();
    return true;
  } catch (error) {
    if (fd !== undefined) fsApi.closeSync(fd);
    if (created && pathExists(temporary, fsApi) && !pathExists(target, fsApi)) {
      fsApi.unlinkSync(temporary);
      fsyncDirectory(path.dirname(target), fsApi);
    }
    throw error;
  }
};
const atomicReplace = (target, bytes, {
  mode, uid, gid, attemptId, expectedCurrentSha256, exchangeFile, fsApi = fs,
} = {}) => {
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${attemptId}.tmp`);
  let fd;
  let created = false;
  try {
    fd = fsApi.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY
      | fs.constants.O_CLOEXEC | fs.constants.O_NOFOLLOW, 0o600);
    created = true;
    fsApi.writeFileSync(fd, bytes);
    fsApi.fchmodSync(fd, mode);
    if (typeof fsApi.fchownSync === "function") fsApi.fchownSync(fd, uid, gid);
    fsApi.fsyncSync(fd);
    fsApi.closeSync(fd);
    fd = undefined;
    if (exchangeFile) {
      exchangeFile({ target, temporary, attemptId, expectedCurrentSha256,
        expectedReplacementSha256: sha256(bytes) });
    } else {
      fsApi.renameSync(temporary, target);
      fsyncDirectory(path.dirname(target), fsApi);
    }
    if (!fsApi.readFileSync(target).equals(Buffer.from(bytes))) fail("Atomic replacement postcheck failed");
  } finally {
    if (fd !== undefined) fsApi.closeSync(fd);
    if (created && pathExists(temporary, fsApi)) fsApi.unlinkSync(temporary);
  }
};
const createDirectory = (target, { mode, uid, gid, fsApi = fs } = {}) => {
  fsApi.mkdirSync(target, { recursive: false, mode });
  if (typeof fsApi.chownSync === "function") fsApi.chownSync(target, uid, gid);
  fsApi.chmodSync(target, mode);
  fsyncDirectory(target, fsApi);
  fsyncDirectory(path.dirname(target), fsApi);
};
const assertRegular = (target, label, expected = {}, fsApi = fs) => {
  const value = fsApi.lstatSync(target);
  if (!value.isFile() || value.isSymbolicLink()
    || (expected.uid !== undefined && value.uid !== expected.uid)
    || (expected.gid !== undefined && value.gid !== expected.gid)
    || (expected.mode !== undefined && (value.mode & 0o777) !== expected.mode)
    || (expected.nlink !== undefined && value.nlink !== expected.nlink)
    || (expected.dev !== undefined && value.dev !== expected.dev)
    || (expected.ino !== undefined && value.ino !== expected.ino)) fail(`${label} custody mismatch`);
  return value;
};
const assertDirectory = (target, label, expected = {}, fsApi = fs) => {
  const value = fsApi.lstatSync(target);
  if (!value.isDirectory() || value.isSymbolicLink()
    || (expected.uid !== undefined && value.uid !== expected.uid)
    || (expected.gid !== undefined && value.gid !== expected.gid)
    || (expected.mode !== undefined && (value.mode & 0o777) !== expected.mode)
    || (expected.dev !== undefined && value.dev !== expected.dev)
    || (expected.ino !== undefined && value.ino !== expected.ino)) fail(`${label} custody mismatch`);
  return value;
};
const readJson = (target, label, fsApi = fs) => {
  try { return JSON.parse(fsApi.readFileSync(target, "utf8")); }
  catch { fail(`${label} is invalid`); }
};

const visitInventory = (root, fsApi = fs, directoryCustody = null) => {
  const result = [];
  const visit = (directory) => {
    const stat = fsApi.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("Bundle contains an invalid directory");
    if (directoryCustody && (stat.uid !== directoryCustody.uid
      || (stat.mode & 0o777) !== directoryCustody.mode)) {
      fail("Bundle directory custody mismatch");
    }
    for (const entry of fsApi.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile()) result.push(path.relative(root, target));
      else fail("Bundle contains a symlink or special file");
    }
  };
  visit(root);
  return result.sort();
};

export function verifyFrontendBootstrapBundle({
  bundleRoot,
  manifestSha256,
  expectedUid = 0,
  production = true,
  fsApi = fs,
} = {}) {
  if (!SHA256.test(String(manifestSha256 || ""))) fail("Bootstrap manifest SHA is invalid");
  const root = fsApi.realpathSync(bundleRoot);
  if (production && root !== `/root/.padlhub-frontend-bootstrap-${manifestSha256}`) {
    fail("Bootstrap bundle path mismatch");
  }
  const rootStat = fsApi.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.uid !== expectedUid
    || (rootStat.mode & 0o777) !== 0o700) fail("Bootstrap bundle root custody mismatch");
  const manifestPath = path.join(root, "manifest.json");
  assertRegular(manifestPath, "Bootstrap manifest", { uid: expectedUid, mode: 0o400, nlink: 1 }, fsApi);
  const manifestBytes = fsApi.readFileSync(manifestPath);
  if (sha256(manifestBytes) !== manifestSha256) fail("Bootstrap manifest SHA mismatch");
  const manifest = JSON.parse(manifestBytes);
  exactKeys(manifest, [
    "formatVersion", "kind", "deploymentId", "createdAt", "maxSnapshotAgeMs",
    "host", "repository", "guard", "launcher", "bootstrap", "files",
  ], "Bootstrap manifest");
  if (manifest.formatVersion !== 1 || manifest.kind !== KIND || !DEPLOYMENT.test(manifest.deploymentId)
    || !Number.isSafeInteger(manifest.maxSnapshotAgeMs) || manifest.maxSnapshotAgeMs < 60_000
    || manifest.maxSnapshotAgeMs > 30 * 60_000 || !Array.isArray(manifest.files)) {
    fail("Bootstrap manifest contract mismatch");
  }
  exactKeys(manifest.repository, ["commit", "sources"], "Bootstrap repository");
  if (!(manifest.repository.commit === null || /^[a-f0-9]{40}$/.test(manifest.repository.commit))
    || !Array.isArray(manifest.repository.sources)) fail("Bootstrap repository contract mismatch");
  const repositorySources = new Set();
  for (const row of manifest.repository.sources) {
    exactKeys(row, ["path", "sha256"], "Bootstrap repository source");
    if (!/^scripts\/[A-Za-z0-9_./-]+$/.test(row.path) || !SHA256.test(row.sha256)
      || repositorySources.has(row.path)) {
      fail("Bootstrap repository source contract mismatch");
    }
    repositorySources.add(row.path);
  }
  exactKeys(manifest.guard, ["sha256", "sourceSha256", "image", "flags"], "Bootstrap guard");
  if (!SHA256.test(manifest.guard.sha256) || !SHA256.test(manifest.guard.sourceSha256)
    || typeof manifest.guard.image !== "string" || !Array.isArray(manifest.guard.flags)
    || manifest.guard.flags.some((flag) => typeof flag !== "string")) {
    fail("Bootstrap guard contract mismatch");
  }
  exactKeys(manifest.launcher, ["sha256", "sourceSha256", "image", "flags"], "Bootstrap launcher");
  if (!SHA256.test(manifest.launcher.sha256) || !SHA256.test(manifest.launcher.sourceSha256)
    || typeof manifest.launcher.image !== "string" || !Array.isArray(manifest.launcher.flags)
    || manifest.launcher.flags.some((flag) => typeof flag !== "string")) {
    fail("Bootstrap launcher contract mismatch");
  }
  if (production && (!/^[a-f0-9]{40}$/.test(manifest.repository.commit)
    || JSON.stringify([...repositorySources].sort()) !== JSON.stringify([...EXECUTION_SOURCES].sort())
    || manifest.guard.image !== GUARD_IMAGE
    || JSON.stringify(manifest.guard.flags) !== JSON.stringify(GUARD_FLAGS)
    || manifest.launcher.image !== GUARD_IMAGE
    || JSON.stringify(manifest.launcher.flags) !== JSON.stringify(GUARD_FLAGS))) {
    fail("Bootstrap production source closure mismatch");
  }
  const expectedFiles = new Map();
  for (const row of manifest.files) {
    exactKeys(row, ["path", "mode", "size", "sha256"], "Bootstrap file row");
    if (!/^payload\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(row.path)
      || expectedFiles.has(row.path)
      || !["0400", "0500"].includes(row.mode) || !Number.isSafeInteger(row.size) || row.size < 1
      || !SHA256.test(row.sha256)) fail("Bootstrap file row contract mismatch");
    expectedFiles.set(row.path, row);
  }
  const inventory = visitInventory(root, fsApi, { uid: expectedUid, mode: 0o700 });
  if (JSON.stringify(inventory) !== JSON.stringify(["manifest.json", ...expectedFiles.keys()].sort())) {
    fail("Bootstrap bundle inventory mismatch");
  }
  for (const [relative, row] of expectedFiles) {
    const target = path.join(root, relative);
    assertRegular(target, `Bootstrap file ${relative}`, {
      uid: expectedUid, mode: Number.parseInt(row.mode, 8), nlink: 1,
    }, fsApi);
    const bytes = fsApi.readFileSync(target);
    if (bytes.length !== row.size || sha256(bytes) !== row.sha256) fail(`Bootstrap file drift: ${relative}`);
  }
  for (const required of ["payload/launcher", "payload/guard", "payload/runtime.mjs", "payload/bootstrap.json",
    "payload/nginx.source.conf", "payload/nginx.candidate.conf", ...EXPECTED_PUBLIC_FILES.map((name) => `payload/release/${name}`)]) {
    if (!expectedFiles.has(required)) fail(`Bootstrap bundle is missing ${required}`);
  }
  const runtimePath = path.join(root, "payload/runtime.mjs");
  if (expectedFiles.get("payload/guard")?.sha256 !== manifest.guard.sha256) {
    fail("Bootstrap guard identity mismatch");
  }
  if (expectedFiles.get("payload/launcher")?.sha256 !== manifest.launcher.sha256) {
    fail("Bootstrap launcher identity mismatch");
  }
  if (manifest.repository.sources.length) {
    const sourceHashes = new Map(manifest.repository.sources.map((row) => [row.path, row.sha256]));
    if (sourceHashes.get("scripts/frontend_bootstrap_runtime.mjs")
        !== expectedFiles.get("payload/runtime.mjs")?.sha256
      || sourceHashes.get("scripts/frontend_bootstrap_guard.c") !== manifest.guard.sourceSha256
      || sourceHashes.get("scripts/frontend_bootstrap_exec_launcher.c") !== manifest.launcher.sourceSha256
      || sourceHashes.get("scripts/audit_frontend_bootstrap_host.mjs")
        !== manifest.host?.producer?.sourceSha256
      || manifest.host?.producer?.launcherSha256 !== manifest.launcher.sha256
      || manifest.host?.producer?.nodeSha256 !== manifest.host?.node?.sha256) {
      fail("Bootstrap payload and repository source binding mismatch");
    }
  }
  if (production && fsApi.realpathSync(fileURLToPath(import.meta.url)) !== runtimePath) {
    fail("Bootstrap runtime must execute from the verified bundle");
  }
  return { root, manifest, manifestBytes, runtimePath };
}

const assertObjectStat = (actual, expected, label, keys = ["uid", "gid", "mode", "dev", "ino", "nlink"]) => {
  for (const key of keys) {
    const observed = key === "mode" ? actual.mode & 0o777 : actual[key];
    if (!Number.isSafeInteger(expected?.[key]) || observed !== expected[key]) {
      fail(`${label} ${key} drift (expected ${expected?.[key]}, observed ${observed})`);
    }
  }
};

const safeRelativeRelease = (name) => {
  if (!/^[a-f0-9]{40}-[a-f0-9]{16}$/.test(String(name || ""))) fail("Retained release name is invalid");
  return name;
};

export function createFrontendBootstrapRuntime({
  verified,
  rootPrefix = "",
  fsApi = fs,
  execFile = execFileSync,
  now = () => Date.now(),
  hostname = () => os.hostname(),
  machineIdBytes = () => fsApi.readFileSync(mapped(rootPrefix, "/etc/machine-id")),
  exchangeFile,
  production = true,
  guardFd = null,
  pinnedGuardExecution = production,
} = {}) {
  const { root, manifest } = verified;
  const host = manifest.host;
  const bootstrap = manifest.bootstrap;
  const planPath = path.join(root, "payload/bootstrap.json");
  const sourceConfigPath = path.join(root, "payload/nginx.source.conf");
  const candidateConfigPath = path.join(root, "payload/nginx.candidate.conf");
  const releaseSource = path.join(root, "payload/release");
  const planBytes = fsApi.readFileSync(planPath);
  const sourceConfigBytes = fsApi.readFileSync(sourceConfigPath);
  const candidateConfigBytes = fsApi.readFileSync(candidateConfigPath);
  JSON.parse(planBytes);
  if (sha256(planBytes) !== bootstrap.planSha256
    || sha256(sourceConfigBytes) !== bootstrap.nginxSourceSha256
    || sha256(candidateConfigBytes) !== bootstrap.nginxCandidateSha256) fail("Bootstrap payload identity mismatch");
  const releaseName = safeRelativeRelease(bootstrap.releaseName);
  const paths = {
    globalLock: mapped(rootPrefix, GLOBAL_LOCK),
    globalLease: mapped(rootPrefix, GLOBAL_LEASE),
    nginxLock: mapped(rootPrefix, NGINX_LOCK),
    releases: mapped(rootPrefix, RELEASES),
    releaseLock: mapped(rootPrefix, RELEASE_LOCK),
    releaseLease: mapped(rootPrefix, RELEASE_LEASE),
    current: mapped(rootPrefix, CURRENT),
    evidenceRoot: mapped(rootPrefix, EVIDENCE_ROOT),
    config: mapped(rootPrefix, host.config.path),
    htmlRoot: mapped(rootPrefix, host.htmlRoot.path),
    legacyRoot: mapped(rootPrefix, host.legacyRoot.path),
    nginx: mapped(rootPrefix, host.nginx.path),
    systemctl: mapped(rootPrefix, host.systemctl.path),
    node: mapped(rootPrefix, host.node.path),
    curl: mapped(rootPrefix, host.curl.path),
    launcherTools: Object.fromEntries(Object.entries(host.launcherTools)
      .map(([name, contract]) => [name, mapped(rootPrefix, contract.path)])),
  };
  const uid = host.config.stat.uid;
  const gid = host.config.stat.gid;

  const assertHostIdentity = ({ initial = false } = {}) => {
    if (hostname() !== host.hostname || sha256(machineIdBytes()) !== host.machineIdSha256) {
      fail("Bootstrap host identity drift");
    }
    const htmlStat = assertDirectory(paths.htmlRoot, "HTML root", {}, fsApi);
    const legacyStat = assertDirectory(paths.legacyRoot, "Legacy LK root", {}, fsApi);
    assertObjectStat(htmlStat, host.htmlRoot.stat, "HTML root",
      initial ? undefined : ["uid", "gid", "mode", "dev", "ino"]);
    assertObjectStat(legacyStat, host.legacyRoot.stat, "Legacy LK root");
    for (const [label, target, contract] of [
      ["nginx binary", paths.nginx, host.nginx], ["systemctl binary", paths.systemctl, host.systemctl],
      ["Node binary", paths.node, host.node], ["curl binary", paths.curl, host.curl],
      ...Object.entries(host.launcherTools).map(([name, contract]) => [
        `launcher tool ${name}`, paths.launcherTools[name], contract,
      ]),
    ]) {
      const value = assertRegular(target, label, {}, fsApi);
      if (fsApi.realpathSync(target) !== mapped(rootPrefix, contract.realPath)
        || sha256(fsApi.readFileSync(target)) !== contract.sha256) fail(`${label} identity drift`);
      assertObjectStat(value, contract.stat, label);
    }
  };

  const assertLegacyPreimages = () => {
    const expectedNames = Object.keys(host.installed.hashes).sort();
    if (JSON.stringify(expectedNames) !== JSON.stringify([...EXPECTED_PUBLIC_FILES].sort())) {
      fail("Installed frontend inventory contract mismatch");
    }
    for (const name of EXPECTED_PUBLIC_FILES) {
      const target = path.join(paths.legacyRoot, name);
      const value = assertRegular(target, `Legacy frontend ${name}`, { nlink: 1 }, fsApi);
      assertObjectStat(value, host.installedStats[name], `Legacy frontend ${name}`);
      if (sha256(fsApi.readFileSync(target)) !== host.installed.hashes[name]) {
        fail(`Legacy frontend preimage drift: ${name}`);
      }
    }
    for (const row of host.preservedLegacy) {
      const target = path.join(paths.legacyRoot, row.name);
      const value = assertRegular(target, `Preserved legacy ${row.name}`, { nlink: 1 }, fsApi);
      assertObjectStat(value, row.stat, `Preserved legacy ${row.name}`);
      if (sha256(fsApi.readFileSync(target)) !== row.sha256) fail(`Preserved legacy drift: ${row.name}`);
    }
  };

  const configState = ({ initial = false } = {}) => {
    const value = assertRegular(paths.config, "Live nginx config", {
      uid, gid, mode: host.config.stat.mode, nlink: host.config.stat.nlink,
      dev: host.config.stat.dev,
    }, fsApi);
    if (fsApi.realpathSync(paths.config) !== mapped(rootPrefix, host.config.realPath)) {
      fail("Live nginx config topology drift");
    }
    if (initial) assertObjectStat(value, host.config.stat, "Live nginx config");
    const digest = sha256(fsApi.readFileSync(paths.config));
    if (digest === bootstrap.nginxSourceSha256) return { state: "source", stat: value, digest };
    if (digest === bootstrap.nginxCandidateSha256) return { state: "candidate", stat: value, digest };
    return { state: "unknown", stat: value, digest };
  };

  const expectedReleaseDirectory = () => path.join(paths.releases, releaseName);
  const assertRelease = () => {
    const directory = expectedReleaseDirectory();
    assertDirectory(directory, "Retained release", { uid, gid, mode: 0o755 }, fsApi);
    const actual = visitInventory(directory, fsApi);
    if (JSON.stringify(actual) !== JSON.stringify([...EXPECTED_PUBLIC_FILES].sort())) {
      fail("Retained release inventory drift");
    }
    for (const name of EXPECTED_PUBLIC_FILES) {
      const target = path.join(directory, name);
      assertRegular(target, `Retained release ${name}`, { uid, gid, mode: 0o644, nlink: 1 }, fsApi);
      if (sha256(fsApi.readFileSync(target)) !== host.installed.hashes[name]) {
        fail(`Retained release hash drift: ${name}`);
      }
    }
  };

  const currentState = () => {
    if (!pathExists(paths.current, fsApi)) return "absent";
    const value = fsApi.lstatSync(paths.current);
    if (!value.isSymbolicLink()) return "unknown";
    const expected = path.relative(paths.htmlRoot, expectedReleaseDirectory());
    return fsApi.readlinkSync(paths.current) === expected
      && fsApi.realpathSync(paths.current) === expectedReleaseDirectory() ? "expected" : "unknown";
  };

  const assertInitial = () => {
    assertHostIdentity({ initial: true });
    assertLegacyPreimages();
    const config = configState({ initial: true });
    if (config.state !== "source") fail("Bootstrap source nginx preimage drift");
    if (pathExists(paths.releases, fsApi) || pathExists(paths.current, fsApi)
      || pathExists(paths.globalLease, fsApi)
      || fsApi.readdirSync(paths.htmlRoot)
        .some((name) => name.startsWith(durableTemporaryPrefix(paths.globalLease)))
      || fsApi.readdirSync(paths.htmlRoot).some((name) => name.startsWith(".lk-frontend-releases-bootstrap-"))) {
      fail("Bootstrap target state is not empty");
    }
    if (host.bootstrapState.releasesExists || host.bootstrapState.currentExists
      || host.bootstrapState.globalLeaseExists || host.bootstrapState.stagingEntries.length
      || host.bootstrapState.orphanEntries.length) {
      fail("Host snapshot was not captured before bootstrap");
    }
    const capturedAt = Date.parse(host.capturedAt);
    if (!Number.isFinite(capturedAt) || now() - capturedAt < 0
      || now() - capturedAt > manifest.maxSnapshotAgeMs) fail("Bootstrap host snapshot is stale");
    return config;
  };

  const leaseContract = (attemptId, phase) => ({
    formatVersion: 1,
    kind: "lk-frontend-static-bootstrap-lease",
    deploymentId: manifest.deploymentId,
    manifestSha256: sha256(verified.manifestBytes),
    attemptId,
    phase,
    sourceSha256: bootstrap.nginxSourceSha256,
    candidateSha256: bootstrap.nginxCandidateSha256,
    releaseName,
  });
  const readLease = (target, label) => {
    assertRegular(target, label, { uid, gid, mode: 0o600, nlink: 1 }, fsApi);
    return readJson(target, label, fsApi);
  };
  const assertLeaseValue = (value, attemptId) => {
    exactKeys(value, ["formatVersion", "kind", "deploymentId", "manifestSha256", "attemptId",
      "phase", "sourceSha256", "candidateSha256", "releaseName"], "Bootstrap lease");
    if (canonical(value) !== canonical(leaseContract(attemptId, "INITIALIZING"))) {
      fail("Bootstrap lease contract mismatch");
    }
    return value;
  };
  const readLeaseOptional = (target, label, attemptId) => pathExists(target, fsApi)
    ? assertLeaseValue(readLease(target, label), attemptId) : null;
  const assertLease = (attemptId, { allowPartial = false } = {}) => {
    const global = readLeaseOptional(paths.globalLease, "Global bootstrap lease", attemptId);
    const release = readLeaseOptional(paths.releaseLease, "Frontend release lease", attemptId);
    if ((!global || !release) && (!allowPartial || (!global && !release))) {
      fail("Bootstrap lease is missing");
    }
    if (fsApi.readdirSync(paths.htmlRoot)
      .some((name) => name.startsWith(".lk-frontend-releases-bootstrap-"))) {
      fail("Bootstrap release-root staging drift");
    }
    return { global, release };
  };
  const evidenceDirectory = (attemptId) => path.join(paths.evidenceRoot, `${manifest.deploymentId}-${attemptId}`);
  const evidencePath = (attemptId, name) => path.join(evidenceDirectory(attemptId), name);
  const writeEvidence = (attemptId, name, value) => writeExclusive(
    evidencePath(attemptId, name), Buffer.from(canonical(value)), {
      mode: 0o600, uid, gid, attemptId, fsApi,
    },
  );
  const writeEvidenceIfAbsent = (attemptId, name, value) => {
    const target = evidencePath(attemptId, name);
    if (!pathExists(target, fsApi)) writeEvidence(attemptId, name, value);
  };
  const record = (attemptId, state, extra = {}) => ({
    formatVersion: 1,
    kind: "lk-frontend-static-bootstrap-journal",
    deploymentId: manifest.deploymentId,
    manifestSha256: sha256(verified.manifestBytes),
    attemptId,
    state,
    observedAt: new Date(now()).toISOString(),
    ...extra,
  });

  const ensureDirectory = (target, label, mode) => {
    if (!pathExists(target, fsApi)) createDirectory(target, { mode, uid, gid, fsApi });
    else {
      const value = assertDirectory(target, label, { uid, gid, dev: host.htmlRoot.stat.dev }, fsApi);
      const observedMode = value.mode & 0o777;
      if (observedMode !== mode && observedMode !== 0o700) fail(`${label} mode drift`);
      if (observedMode !== mode) {
        fsApi.chmodSync(target, mode);
      }
      fsyncDirectory(target, fsApi);
      fsyncDirectory(path.dirname(target), fsApi);
    }
  };

  const ensureReleaseRoot = (attemptId) => {
    const expectedLease = Buffer.from(canonical(leaseContract(attemptId, "INITIALIZING")));
    const staging = path.join(paths.htmlRoot, `.lk-frontend-releases-bootstrap-${attemptId}`);
    if (pathExists(paths.releases, fsApi)) {
      assertDirectory(paths.releases, "Frontend release root", { uid, gid, mode: 0o755 }, fsApi);
      if (pathExists(staging, fsApi)) fail("Bootstrap release-root publication is ambiguous");
      assertLeaseValue(readLease(paths.releaseLease, "Frontend release lease"), attemptId);
      return;
    }
    ensureDirectory(staging, "Frontend release root staging", 0o755);
    const stagingLease = path.join(staging, ".lease.json");
    if (!pathExists(stagingLease, fsApi)) {
      writeExclusive(stagingLease, expectedLease, { mode: 0o600, uid, gid, attemptId, fsApi });
    } else {
      assertLeaseValue(readLease(stagingLease, "Staged frontend release lease"), attemptId);
    }
    if (JSON.stringify(fsApi.readdirSync(staging).sort()) !== JSON.stringify([".lease.json"])) {
      fail("Bootstrap release-root staging inventory drift");
    }
    fsyncDirectory(staging, fsApi);
    fsApi.renameSync(staging, paths.releases);
    fsyncDirectory(paths.htmlRoot, fsApi);
    assertDirectory(paths.releases, "Frontend release root", { uid, gid, mode: 0o755 }, fsApi);
    assertLeaseValue(readLease(paths.releaseLease, "Frontend release lease"), attemptId);
  };

  const ensureIntent = (attemptId, resumedInitialization = false) => {
    ensureDirectory(paths.evidenceRoot, "Bootstrap evidence root", 0o700);
    ensureDirectory(evidenceDirectory(attemptId), "Bootstrap attempt evidence", 0o700);
    const target = evidencePath(attemptId, "00-intent.json");
    if (!pathExists(target, fsApi)) {
      writeEvidence(attemptId, "00-intent.json", record(attemptId, "INTENT", {
        sourceSha256: bootstrap.nginxSourceSha256,
        candidateSha256: bootstrap.nginxCandidateSha256,
        releaseName,
        ...(resumedInitialization ? { resumedInitialization: true } : {}),
      }));
      return;
    }
    assertRegular(target, "Bootstrap intent", { uid, gid, mode: 0o600, nlink: 1 }, fsApi);
    const intent = readJson(target, "Bootstrap intent", fsApi);
    if (intent.formatVersion !== 1 || intent.kind !== "lk-frontend-static-bootstrap-journal"
      || intent.deploymentId !== manifest.deploymentId || intent.manifestSha256 !== sha256(verified.manifestBytes)
      || intent.attemptId !== attemptId || intent.state !== "INTENT"
      || intent.sourceSha256 !== bootstrap.nginxSourceSha256
      || intent.candidateSha256 !== bootstrap.nginxCandidateSha256 || intent.releaseName !== releaseName
      || !Number.isFinite(Date.parse(intent.observedAt))) fail("Bootstrap intent contract mismatch");
  };

  const assertEvidenceInventory = (attemptId) => {
    const directory = evidenceDirectory(attemptId);
    assertDirectory(paths.evidenceRoot, "Bootstrap evidence root", { uid, gid, mode: 0o700 }, fsApi);
    assertDirectory(directory, "Bootstrap attempt evidence", { uid, gid, mode: 0o700 }, fsApi);
    const states = new Map([
      ["00-intent.json", "INTENT"], ["01-release.json", "RELEASE_DURABLE"],
      ["02-current.json", "CURRENT_PUBLISHED"], ["03-config.json", "CONFIG_PUBLISHED"],
      ["04-reload-requested.json", "RELOAD_REQUESTED"], ["05-postcheck.json", "POSTCHECK_PASSED"],
      ["server-success.json", "SERVER_SUCCESS"],
      ["06-recovery-apply-resumed.json", "RECOVERY_APPLY_RESUMED"],
      ["06-recovery-reload-requested.json", "RECOVERY_RELOAD_REQUESTED"],
      ["90-rollback-requested.json", "ROLLBACK_REQUESTED"],
      ["91-rollback-reload-requested.json", "ROLLBACK_RELOAD_REQUESTED"],
      ["success.json", "SUCCESS"], ["rolled-back.json", "ROLLED_BACK"],
    ]);
    const allowed = new Set([...states.keys(), "nginx.source.conf"]);
    const orphanSuffix = `.${attemptId}.new`;
    for (const name of fsApi.readdirSync(directory).filter((entry) => entry.startsWith(".")
      && entry.endsWith(orphanSuffix))) {
      const finalName = name.slice(1, -orphanSuffix.length);
      if (!allowed.has(finalName)) fail("Bootstrap evidence orphan drift");
      const temporary = path.join(directory, name);
      const target = path.join(directory, finalName);
      const temp = assertRegular(temporary, "Bootstrap evidence orphan", { uid, gid }, fsApi);
      if (![0o400, 0o600].includes(temp.mode & 0o777) || ![1, 2].includes(temp.nlink)) {
        fail("Bootstrap evidence orphan custody drift");
      }
      if (pathExists(target, fsApi)) {
        const published = assertRegular(target, "Bootstrap evidence orphan target", { uid, gid }, fsApi);
        if (published.dev !== temp.dev || published.ino !== temp.ino) {
          fail("Bootstrap evidence orphan identity drift");
        }
      }
      fsApi.unlinkSync(temporary);
      fsyncDirectory(directory, fsApi);
    }
    for (const name of fsApi.readdirSync(directory)) {
      if (!allowed.has(name)) fail("Bootstrap evidence inventory drift");
      const target = path.join(directory, name);
      if (name === "nginx.source.conf") {
        assertRegular(target, "Bootstrap nginx source backup", { uid, gid, mode: 0o400, nlink: 1 }, fsApi);
        if (sha256(fsApi.readFileSync(target)) !== bootstrap.nginxSourceSha256) {
          fail("Bootstrap nginx source backup drift");
        }
        continue;
      }
      assertRegular(target, `Bootstrap journal ${name}`, { uid, gid, mode: 0o600, nlink: 1 }, fsApi);
      const value = readJson(target, `Bootstrap journal ${name}`, fsApi);
      if (value.formatVersion !== 1 || value.kind !== "lk-frontend-static-bootstrap-journal"
        || value.deploymentId !== manifest.deploymentId
        || value.manifestSha256 !== sha256(verified.manifestBytes) || value.attemptId !== attemptId
        || value.state !== states.get(name) || !Number.isFinite(Date.parse(value.observedAt))) {
        fail(`Bootstrap journal contract mismatch: ${name}`);
      }
    }
  };

  const clearOwnedConfigTemporary = (attemptId) => {
    const temporary = path.join(path.dirname(paths.config), `.${path.basename(paths.config)}.${attemptId}.tmp`);
    if (!pathExists(temporary, fsApi)) return;
    const value = assertRegular(temporary, "Bootstrap nginx temporary", {
      uid, gid, dev: host.config.stat.dev, nlink: 1,
    }, fsApi);
    const mode = value.mode & 0o777;
    if (mode !== 0o600 && mode !== host.config.stat.mode) fail("Bootstrap nginx temporary mode drift");
    fsApi.unlinkSync(temporary);
    fsyncDirectory(path.dirname(paths.config), fsApi);
  };

  const assertLock = (fd, expectedPath, label) => {
    if (!production) return;
    if (!Number.isInteger(fd) || fsApi.readlinkSync(`/proc/self/fd/${fd}`) !== expectedPath) {
      fail(`${label} descriptor identity mismatch`);
    }
    const value = fsApi.fstatSync(fd);
    if (!value.isFile() || value.uid !== uid || value.nlink !== 1 || (value.mode & 0o777) !== 0o600) {
      fail(`${label} descriptor custody mismatch`);
    }
  };

  const materializeRelease = (attemptId) => {
    const finalDirectory = expectedReleaseDirectory();
    if (pathExists(finalDirectory, fsApi)) { assertRelease(); return false; }
    const temporary = path.join(paths.releases, `.bootstrap-${attemptId}`);
    ensureDirectory(temporary, "Partial retained release", 0o755);
    const fonts = path.join(temporary, "fonts");
    ensureDirectory(fonts, "Partial retained release fonts", 0o755);
    for (const name of EXPECTED_PUBLIC_FILES) {
      const source = path.join(releaseSource, name);
      const target = path.join(temporary, name);
      writeExclusive(target, fsApi.readFileSync(source), { mode: 0o644, uid, gid, attemptId, fsApi });
    }
    const partialInventory = visitInventory(temporary, fsApi);
    if (JSON.stringify(partialInventory) !== JSON.stringify([...EXPECTED_PUBLIC_FILES].sort())) {
      fail("Partial retained release inventory drift");
    }
    fsyncDirectory(path.join(temporary, "fonts"), fsApi);
    fsyncDirectory(temporary, fsApi);
    fsApi.renameSync(temporary, finalDirectory);
    fsyncDirectory(paths.releases, fsApi);
    assertRelease();
    return true;
  };

  const publishCurrent = () => {
    const state = currentState();
    if (state === "expected") return false;
    if (state !== "absent") fail("Frontend current link drift");
    fsApi.symlinkSync(path.relative(paths.htmlRoot, expectedReleaseDirectory()), paths.current);
    fsyncDirectory(paths.htmlRoot, fsApi);
    if (currentState() !== "expected") fail("Frontend current link publication failed");
    return true;
  };

  const run = (command, args, options = {}) => execFile(command, args, {
    encoding: options.encoding ?? "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C" },
    timeout: 30_000,
    killSignal: "SIGKILL",
    maxBuffer: 4 * 1024 * 1024,
    ...options,
  });
  const assertPinnedGuard = () => {
    if (!pinnedGuardExecution) return;
    if (!Number.isInteger(guardFd) || guardFd < 3) fail("Pinned guard descriptor is missing");
    const value = fsApi.fstatSync(guardFd);
    if (!value.isFile() || value.uid !== uid || value.gid !== gid || value.nlink !== 1
      || (value.mode & 0o777) !== 0o500) fail("Pinned guard descriptor custody mismatch");
    const chunks = [];
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    for (;;) {
      const length = fsApi.readSync(guardFd, buffer, 0, buffer.length, position);
      if (!length) break;
      chunks.push(Buffer.from(buffer.subarray(0, length)));
      position += length;
    }
    if (sha256(Buffer.concat(chunks)) !== manifest.guard.sha256) {
      fail("Pinned guard descriptor digest mismatch");
    }
  };
  const exchangeConfig = exchangeFile || (pinnedGuardExecution ? ({
    temporary, attemptId, expectedCurrentSha256, expectedReplacementSha256,
  }) => {
    assertPinnedGuard();
    return run(`/proc/self/fd/${guardFd}`, [
      "exchange",
      "--attempt-id", attemptId,
      "--expected-self-sha256", manifest.guard.sha256,
      "--replacement", temporary,
      "--expected-current-sha256", expectedCurrentSha256,
      "--expected-replacement-sha256", expectedReplacementSha256,
    ], { stdio: ["ignore", "pipe", "pipe", "ignore", "ignore", "ignore", guardFd] });
  } : null);
  const nginxTest = () => run(paths.nginx, ["-t"]);
  const reload = () => run(paths.systemctl, ["reload", host.nginxService]);
  const assertService = () => {
    if (String(run(paths.systemctl, ["is-active", host.nginxService])).trim() !== "active") {
      fail("nginx service is not active");
    }
  };
  const curlArgs = (args, originPinned) => originPinned
    ? ["--resolve", host.originResolve, ...args] : args;
  const fetchBytes = (url, originPinned) => run(paths.curl,
    curlArgs(["-fsS", "--max-time", "20", url], originPinned), { encoding: null });
  const fetchStatus = (method, url, originPinned) => String(run(paths.curl, curlArgs([
    "-sS", "--max-time", "20", "-o", "/dev/null", "-w", "%{http_code}", "-X", method, url,
  ], originPinned))).trim();
  const fetchHeaders = (url, originPinned) => String(run(paths.curl,
    curlArgs(["-fsSI", "--max-time", "20", url], originPinned)));
  const publicReadback = ({ candidate = true, originPinned = false } = {}) => {
    for (const name of EXPECTED_PUBLIC_FILES) {
      const url = `${host.assetBase.replace(/\/$/, "")}/${name}?v=${encodeURIComponent(host.installed.version)}`;
      if (sha256(fetchBytes(url, originPinned)) !== host.installed.hashes[name]) {
        fail(`Public frontend mismatch: ${name}`);
      }
      const headers = fetchHeaders(url, originPinned);
      if (!/access-control-allow-origin:\s*\*/i.test(headers)) fail(`Public CORS mismatch: ${name}`);
      if (name === "release.json" && !/cache-control:.*(?:no-store|no-cache)/i.test(headers)) {
        fail("Public release manifest cache policy mismatch");
      }
      if (candidate && name !== "release.json"
        && !/cache-control:.*public.*max-age=31536000.*immutable/i.test(headers)) {
        fail(`Public immutable cache policy mismatch: ${name}`);
      }
    }
    const probe = `${host.assetBase.replace(/\/$/, "")}/bundle.js?v=${encodeURIComponent(host.installed.version)}`;
    const expectedPost = candidate ? "403" : "405";
    if (fetchStatus("OPTIONS", probe, originPinned) !== "204"
      || fetchStatus("POST", probe, originPinned) !== expectedPost) {
      fail("Public static method contract mismatch");
    }
    for (const row of host.preservedLegacy) {
      const url = `${host.assetBase.replace(/\/$/, "")}/${row.name}?bootstrap-preserved=1`;
      if (sha256(fetchBytes(url, originPinned)) !== row.sha256) {
        fail(`Preserved public legacy mismatch: ${row.name}`);
      }
    }
  };

  const postcheck = () => {
    assertHostIdentity({ initial: false });
    assertLegacyPreimages();
    if (configState().state !== "candidate") fail("Candidate nginx config is not active on disk");
    assertRelease();
    if (currentState() !== "expected") fail("Frontend current link is not active");
    nginxTest();
    assertService();
    publicReadback({ candidate: true, originPinned: true });
    publicReadback({ candidate: true });
  };

  const releaseLeases = (attemptId) => {
    const leases = assertLease(attemptId, { allowPartial: true });
    if (leases.global) {
      fsApi.unlinkSync(paths.globalLease);
      fsyncDirectory(paths.htmlRoot, fsApi);
    }
    if (leases.release) {
      fsApi.unlinkSync(paths.releaseLease);
      fsyncDirectory(paths.releases, fsApi);
    }
  };

  const assertReceipt = (target, attemptId, state) => {
    assertRegular(target, `Bootstrap ${state} receipt`, { uid, gid, mode: 0o600, nlink: 1 }, fsApi);
    const value = readJson(target, `Bootstrap ${state} receipt`, fsApi);
    if (value.formatVersion !== 1 || value.kind !== "lk-frontend-static-bootstrap-journal"
      || value.deploymentId !== manifest.deploymentId || value.manifestSha256 !== sha256(verified.manifestBytes)
      || value.attemptId !== attemptId || value.state !== state || !Number.isFinite(Date.parse(value.observedAt))) {
      fail(`Bootstrap ${state} receipt contract mismatch`);
    }
    return value;
  };

  const complete = (attemptId, state, extra = {}) => {
    const target = evidencePath(attemptId, state === "SUCCESS" ? "success.json" : "rolled-back.json");
    const receipt = record(attemptId, state, extra);
    if (!pathExists(target, fsApi)) writeExclusive(target, Buffer.from(canonical(receipt)), {
      mode: 0o600, uid, gid, attemptId, fsApi,
    });
    const durableReceipt = assertReceipt(target, attemptId, state);
    releaseLeases(attemptId);
    return durableReceipt;
  };

  const restoreSource = (attemptId, reason) => {
    assertHostIdentity({ initial: false });
    assertLegacyPreimages();
    writeEvidenceIfAbsent(attemptId, "90-rollback-requested.json",
      record(attemptId, "ROLLBACK_REQUESTED", { reason }));
    materializeRelease(attemptId);
    publishCurrent();
    assertRelease();
    if (currentState() !== "expected") fail("Rollback baseline topology is incomplete");
    const config = configState();
    if (config.state === "unknown") fail("Unknown nginx config drift; bootstrap lease retained");
    if (config.state === "candidate") {
      if (configState().state !== "candidate") fail("Nginx candidate changed before rollback publication");
      atomicReplace(paths.config, sourceConfigBytes, {
        mode: host.config.stat.mode, uid, gid, attemptId,
        expectedCurrentSha256: bootstrap.nginxCandidateSha256,
        exchangeFile: exchangeConfig, fsApi,
      });
      if (configState().state !== "source") fail("Nginx source restore digest mismatch");
    }
    if (configState().state !== "source") fail("Nginx source is not restored");
    nginxTest();
    writeEvidenceIfAbsent(attemptId, "91-rollback-reload-requested.json", record(attemptId, "ROLLBACK_RELOAD_REQUESTED"));
    reload();
    assertService();
    assertLegacyPreimages();
    assertRelease();
    if (currentState() !== "expected") fail("Rollback baseline topology drift");
    publicReadback({ candidate: false, originPinned: true });
    publicReadback({ candidate: false });
    return complete(attemptId, "ROLLED_BACK", { reason, restoredNginxSha256: bootstrap.nginxSourceSha256 });
  };

  const inspect = () => {
    const config = assertInitial();
    return {
      ok: true,
      action: "preflight",
      deploymentId: manifest.deploymentId,
      sourceSha256: config.digest,
      candidateSha256: bootstrap.nginxCandidateSha256,
      releaseName,
      installedSource: host.installed.source,
      installedFileCount: EXPECTED_PUBLIC_FILES.length,
    };
  };

  const verify = () => {
    assertHostIdentity({ initial: false });
    assertLegacyPreimages();
    if (configState().state === "unknown") fail("Bootstrap nginx config is unknown");
    return { ok: true, action: "verify", deploymentId: manifest.deploymentId };
  };

  const assertWriterLocks = (globalLockFd, nginxLockFd) => {
    assertLock(globalLockFd, GLOBAL_LOCK, "Bootstrap global lock");
    assertLock(nginxLockFd, NGINX_LOCK, "nginx writer lock");
  };

  const preflight = ({ globalLockFd = 3, nginxLockFd = 5 } = {}) => {
    assertWriterLocks(globalLockFd, nginxLockFd);
    return inspect();
  };

  const initialize = ({ attemptId, globalLockFd = 3, nginxLockFd = 5 } = {}) => {
    if (!ATTEMPT.test(String(attemptId || ""))) fail("Bootstrap attempt ID is invalid");
    assertWriterLocks(globalLockFd, nginxLockFd);
    assertInitial();
    const lease = leaseContract(attemptId, "INITIALIZING");
    writeExclusive(paths.globalLease, Buffer.from(canonical(lease)), {
      mode: 0o600, uid, gid, attemptId, fsApi,
    });
    try {
      ensureReleaseRoot(attemptId);
      ensureIntent(attemptId);
      return { ok: true, action: "initialize", deploymentId: manifest.deploymentId, attemptId };
    } catch (error) {
      fail(`Bootstrap initialization is incomplete; global lease retained: ${error.message}`);
    }
  };

  const prepareRecovery = ({ attemptId, globalLockFd = 3, nginxLockFd = 5 } = {}) => {
    if (!ATTEMPT.test(String(attemptId || ""))) fail("Bootstrap attempt ID is invalid");
    assertWriterLocks(globalLockFd, nginxLockFd);
    assertHostIdentity({ initial: false });
    assertLegacyPreimages();
    const config = configState();
    const current = currentState();
    if (config.state === "unknown" || current === "unknown") {
      fail("Bootstrap initialization recovery state is ambiguous");
    }
    const stagingEntries = fsApi.readdirSync(paths.htmlRoot)
      .filter((name) => name.startsWith(".lk-frontend-releases-bootstrap-"));
    const ownStaging = `.lk-frontend-releases-bootstrap-${attemptId}`;
    if (stagingEntries.some((name) => name !== ownStaging)
      || (pathExists(paths.releases, fsApi) && stagingEntries.length)) {
      fail("Bootstrap release-root staging drift");
    }
    const successPath = evidencePath(attemptId, "success.json");
    const rolledBackPath = evidencePath(attemptId, "rolled-back.json");
    if (pathExists(successPath, fsApi) || pathExists(rolledBackPath, fsApi)) {
      if (pathExists(successPath, fsApi) && pathExists(rolledBackPath, fsApi)) {
        fail("Conflicting bootstrap terminal receipts");
      }
      const terminalState = pathExists(successPath, fsApi) ? "SUCCESS" : "ROLLED_BACK";
      assertEvidenceInventory(attemptId);
      assertReceipt(pathExists(successPath, fsApi) ? successPath : rolledBackPath, attemptId, terminalState);
      if (pathExists(paths.globalLease, fsApi) || pathExists(paths.releaseLease, fsApi)) {
        assertLease(attemptId, { allowPartial: true });
      }
      return { ok: true, action: "prepare-recovery", terminalState, deploymentId: manifest.deploymentId, attemptId };
    }
    if (!pathExists(paths.globalLease, fsApi)) {
      const globalTemporary = durableTemporaryPath(paths.globalLease, attemptId);
      if (!pathExists(globalTemporary, fsApi)) fail("Global bootstrap lease is missing");
      writeExclusive(paths.globalLease, Buffer.from(canonical(leaseContract(attemptId, "INITIALIZING"))), {
        mode: 0o600, uid, gid, attemptId, fsApi,
      });
    }
    assertLeaseValue(readLease(paths.globalLease, "Global bootstrap lease"), attemptId);
    if (config.state === "candidate") {
      if (current !== "expected") fail("Candidate nginx state requires the exact current release");
      assertRelease();
    }
    if (!pathExists(paths.releases, fsApi) && (config.state !== "source" || current !== "absent")) {
      fail("Bootstrap initialization recovery state is ambiguous");
    }
    ensureReleaseRoot(attemptId);
    const allowed = new Set([".lease.json", ".lock", ".bootstrap-evidence", releaseName, `.bootstrap-${attemptId}`]);
    if (fsApi.readdirSync(paths.releases).some((name) => !allowed.has(name))) {
      fail("Bootstrap release root contains unknown state");
    }
    ensureIntent(attemptId, true);
    assertEvidenceInventory(attemptId);
    clearOwnedConfigTemporary(attemptId);
    return { ok: true, action: "prepare-recovery", terminalState: null,
      deploymentId: manifest.deploymentId, attemptId };
  };

  const apply = ({ attemptId, globalLockFd = 3, releaseLockFd = 4, nginxLockFd = 5 } = {}) => {
    assertWriterLocks(globalLockFd, nginxLockFd);
    assertLock(releaseLockFd, RELEASE_LOCK, "Frontend release lock");
    assertLease(attemptId);
    assertEvidenceInventory(attemptId);
    try {
      assertHostIdentity();
      assertLegacyPreimages();
      if (configState().state !== "source" || !pathExists(evidencePath(attemptId, "00-intent.json"), fsApi)) {
        fail("Bootstrap apply preimage or intent drift");
      }
      materializeRelease(attemptId);
      if (!pathExists(evidencePath(attemptId, "01-release.json"), fsApi)) {
        writeEvidence(attemptId, "01-release.json", record(attemptId, "RELEASE_DURABLE", { releaseName }));
      }
      publishCurrent();
      if (!pathExists(evidencePath(attemptId, "02-current.json"), fsApi)) {
        writeEvidence(attemptId, "02-current.json", record(attemptId, "CURRENT_PUBLISHED"));
      }
      const backupPath = evidencePath(attemptId, "nginx.source.conf");
      if (!pathExists(backupPath, fsApi)) writeExclusive(backupPath, sourceConfigBytes, {
        mode: 0o400, uid, gid, attemptId, fsApi,
      });
      if (configState().state !== "source") fail("Nginx source changed before candidate publication");
      atomicReplace(paths.config, candidateConfigBytes, {
        mode: host.config.stat.mode, uid, gid, attemptId,
        expectedCurrentSha256: bootstrap.nginxSourceSha256,
        exchangeFile: exchangeConfig, fsApi,
      });
      if (configState().state !== "candidate") fail("Nginx candidate publication digest mismatch");
      if (!pathExists(evidencePath(attemptId, "03-config.json"), fsApi)) {
        writeEvidence(attemptId, "03-config.json", record(attemptId, "CONFIG_PUBLISHED"));
      }
      nginxTest();
      if (!pathExists(evidencePath(attemptId, "04-reload-requested.json"), fsApi)) {
        writeEvidence(attemptId, "04-reload-requested.json", record(attemptId, "RELOAD_REQUESTED"));
      }
      reload();
      postcheck();
      writeEvidenceIfAbsent(attemptId, "05-postcheck.json", record(attemptId, "POSTCHECK_PASSED"));
      writeEvidenceIfAbsent(attemptId, "server-success.json", record(attemptId, "SERVER_SUCCESS", {
        activeNginxSha256: bootstrap.nginxCandidateSha256,
        releaseName,
        publicFileCount: EXPECTED_PUBLIC_FILES.length,
      }));
      return { ...readJson(evidencePath(attemptId, "server-success.json"),
        "Bootstrap server success", fsApi), action: "apply", awaitingFinalize: true };
    } catch (error) {
      try { restoreSource(attemptId, String(error?.message || error)); }
      catch (recoveryError) {
        fail(`Bootstrap apply failed; recovery incomplete and leases retained: ${recoveryError.message}`);
      }
      fail(`Bootstrap apply failed; exact nginx source restored: ${error.message}`);
    }
  };

  const recover = ({ attemptId, globalLockFd = 3, releaseLockFd = 4, nginxLockFd = 5 } = {}) => {
    assertWriterLocks(globalLockFd, nginxLockFd);
    assertLock(releaseLockFd, RELEASE_LOCK, "Frontend release lock");
    const successPath = evidencePath(attemptId, "success.json");
    const rolledBackPath = evidencePath(attemptId, "rolled-back.json");
    assertEvidenceInventory(attemptId);
    if (pathExists(successPath, fsApi)) {
      if (pathExists(rolledBackPath, fsApi)) fail("Conflicting bootstrap terminal receipts");
      if (pathExists(paths.globalLease, fsApi) || pathExists(paths.releaseLease, fsApi)) {
        assertLease(attemptId, { allowPartial: true });
      }
      postcheck();
      if (pathExists(paths.globalLease, fsApi) || pathExists(paths.releaseLease, fsApi)) releaseLeases(attemptId);
      return { ...assertReceipt(successPath, attemptId, "SUCCESS"), resumedLeaseRelease: true };
    }
    if (pathExists(rolledBackPath, fsApi)) {
      if (pathExists(paths.globalLease, fsApi) || pathExists(paths.releaseLease, fsApi)) {
        assertLease(attemptId, { allowPartial: true });
      }
      if (configState().state !== "source") fail("Rolled-back receipt does not match nginx source state");
      assertRelease();
      if (currentState() !== "expected") fail("Rolled-back receipt does not match frontend current state");
      nginxTest();
      assertService();
      assertLegacyPreimages();
      publicReadback({ candidate: false, originPinned: true });
      publicReadback({ candidate: false });
      if (pathExists(paths.globalLease, fsApi) || pathExists(paths.releaseLease, fsApi)) releaseLeases(attemptId);
      return { ...assertReceipt(rolledBackPath, attemptId, "ROLLED_BACK"), resumedLeaseRelease: true };
    }
    assertLease(attemptId);
    if (pathExists(evidencePath(attemptId, "90-rollback-requested.json"), fsApi)
      || pathExists(evidencePath(attemptId, "91-rollback-reload-requested.json"), fsApi)) {
      return restoreSource(attemptId, "Resumed durable rollback intent");
    }
    const serverSuccessPath = evidencePath(attemptId, "server-success.json");
    if (pathExists(serverSuccessPath, fsApi)) {
      try {
        postcheck();
        return { ...readJson(serverSuccessPath, "Bootstrap server success", fsApi),
          action: "recover", awaitingFinalize: true };
      } catch (error) {
        return restoreSource(attemptId, `Server-success recovery fallback: ${error.message}`);
      }
    }
    const config = configState();
    if (config.state === "unknown" || currentState() === "unknown") {
      fail("Unknown bootstrap state; leases retained");
    }
    if (config.state === "candidate") {
      try {
        nginxTest();
        writeEvidenceIfAbsent(attemptId, "06-recovery-reload-requested.json", record(attemptId, "RECOVERY_RELOAD_REQUESTED"));
        reload();
        postcheck();
        writeEvidenceIfAbsent(attemptId, "05-postcheck.json", record(attemptId, "POSTCHECK_PASSED"));
        writeEvidenceIfAbsent(attemptId, "server-success.json", record(attemptId, "SERVER_SUCCESS", {
          activeNginxSha256: bootstrap.nginxCandidateSha256,
          releaseName,
          recovered: true,
        }));
        return { ...readJson(evidencePath(attemptId, "server-success.json"),
          "Bootstrap server success", fsApi), action: "recover", awaitingFinalize: true };
      } catch (error) {
        return restoreSource(attemptId, `Recovery fallback: ${error.message}`);
      }
    }
    writeEvidenceIfAbsent(attemptId, "06-recovery-apply-resumed.json",
      record(attemptId, "RECOVERY_APPLY_RESUMED"));
    return apply({ attemptId, globalLockFd, releaseLockFd, nginxLockFd });
  };

  const finalize = ({ attemptId, globalLockFd = 3, releaseLockFd = 4, nginxLockFd = 5 } = {}) => {
    assertWriterLocks(globalLockFd, nginxLockFd);
    assertLock(releaseLockFd, RELEASE_LOCK, "Frontend release lock");
    assertLease(attemptId);
    assertEvidenceInventory(attemptId);
    if (pathExists(evidencePath(attemptId, "90-rollback-requested.json"), fsApi)
      || pathExists(evidencePath(attemptId, "91-rollback-reload-requested.json"), fsApi)) {
      fail("Bootstrap finalize is blocked by durable rollback intent");
    }
    const serverSuccessPath = evidencePath(attemptId, "server-success.json");
    if (!pathExists(serverSuccessPath, fsApi)) fail("Bootstrap server success is missing");
    postcheck();
    return complete(attemptId, "SUCCESS", {
      activeNginxSha256: bootstrap.nginxCandidateSha256,
      releaseName,
      externalSmokeAuthorized: true,
    });
  };

  const rollback = ({ attemptId, globalLockFd = 3, releaseLockFd = 4, nginxLockFd = 5 } = {}) => {
    assertWriterLocks(globalLockFd, nginxLockFd);
    assertLock(releaseLockFd, RELEASE_LOCK, "Frontend release lock");
    assertLease(attemptId);
    assertEvidenceInventory(attemptId);
    return restoreSource(attemptId, "Explicit exact bootstrap rollback");
  };

  return { inspect, verify, preflight, initialize, prepareRecovery, apply, recover, rollback, finalize,
    paths, configState, currentState };
}

const parseArgs = (argv) => {
  if (!argv.length || argv.length % 2 !== 0) fail("Bootstrap runtime arguments are invalid");
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index].startsWith("--") || Object.hasOwn(values, argv[index])) fail("Bootstrap runtime arguments are invalid");
    values[argv[index]] = argv[index + 1];
  }
  return values;
};

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.getuid?.() !== 0) fail("Bootstrap runtime must run as root");
    for (const key of ["NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES"]) {
      if (process.env[key] !== undefined) fail("Bootstrap runtime environment is not clean");
    }
    const action = process.argv[2];
    const args = parseArgs(process.argv.slice(3));
    if (!new Set(["inspect", "verify", "preflight", "initialize", "prepare-recovery", "apply", "recover", "rollback", "finalize"]).has(action)) {
      fail("Unknown bootstrap runtime action");
    }
    if (!new Set(["inspect", "verify", "preflight", "initialize"]).has(action)) {
      const confirmationAction = action === "prepare-recovery" ? "recover" : action;
      const [key, value] = CONFIRMATIONS[confirmationAction] || [];
      if (!key || process.env[key] !== value) fail("Bootstrap runtime operation authority mismatch");
    }
    if (action === "initialize" && process.env.LK_FRONTEND_BOOTSTRAP_APPLY !== "CONFIRM_EXACT_BOOTSTRAP") {
      fail("Bootstrap initialization authority mismatch");
    }
    const verified = verifyFrontendBootstrapBundle({
      bundleRoot: args["--bundle"], manifestSha256: args["--manifest-sha256"],
    });
    if (process.env.LK_FRONTEND_BOOTSTRAP_GUARD_SHA256 !== verified.manifest.guard.sha256) {
      fail("Bootstrap guard authority mismatch");
    }
    const allowedEnvironment = new Set(["PATH", "LANG", "LK_FRONTEND_BOOTSTRAP_GUARD_SHA256",
      "LK_FRONTEND_BOOTSTRAP_GUARD_FD",
      ...Object.keys(CONFIRMATIONS)]);
    if (Object.keys(process.env).some((key) => !allowedEnvironment.has(key))) {
      fail("Bootstrap runtime environment contains an unexpected variable");
    }
    const runtime = createFrontendBootstrapRuntime({ verified,
      guardFd: Number.parseInt(process.env.LK_FRONTEND_BOOTSTRAP_GUARD_FD || "", 10) });
    const common = {
      attemptId: args["--attempt-id"],
      globalLockFd: Number.parseInt(args["--global-lock-fd"] || "3", 10),
      releaseLockFd: Number.parseInt(args["--release-lock-fd"] || "4", 10),
      nginxLockFd: Number.parseInt(args["--nginx-lock-fd"] || "5", 10),
    };
    const method = action === "prepare-recovery" ? "prepareRecovery" : action;
    const result = runtime[method](common);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
