#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const fail = (message) => { throw new Error(message); };
const files = Object.freeze([
  "bundle.js", "games.js", "tournaments.js", "tournament-signup.js", "group-schedule.js",
  "padel-day-schedule.js", "tournament-subscription.js", "tournament-subscription-referral.js",
  "onboarding.js", "levels-info.js", "communities.js", "release.json",
  "fonts/rf-dewi-ultrabold.woff2", "fonts/rf-dewi-expanded-ultrabold-italic.woff2",
  "fonts/SourceCodePro-Medium.woff2", "fonts/SourceCodePro-Regular.woff2",
]);
const DEFAULTS = Object.freeze({
  configPath: "/etc/nginx/sites-enabled/padlhub.su",
  htmlRoot: "/var/www/html",
  legacyRoot: "/var/www/html/lk",
  nginxPath: "/usr/sbin/nginx",
  systemctlPath: "/usr/bin/systemctl",
  nodePath: "/usr/bin/node",
  curlPath: "/usr/bin/curl",
  bashPath: "/usr/bin/bash",
  realpathPath: "/usr/bin/realpath",
  sha256sumPath: "/usr/bin/sha256sum",
  statPath: "/usr/bin/stat",
  readlinkPath: "/usr/bin/readlink",
  chownPath: "/usr/bin/chown",
  chmodPath: "/usr/bin/chmod",
  flockPath: "/usr/bin/flock",
  envPath: "/usr/bin/env",
  nginxService: "nginx",
  assetBase: "https://padlhub.su/lk",
  originResolve: "padlhub.su:443:127.0.0.1",
});
const PRESERVED_LEGACY_FILES = Object.freeze([
  "index.html",
  "ffc-academy-lk.js",
  "ffc-academy-lk-dev.js",
  "release-dev.json",
]);

const statRecord = (target, { regular = false, directory = false } = {}) => {
  const value = fs.lstatSync(target);
  if ((regular && (!value.isFile() || value.isSymbolicLink()))
    || (directory && (!value.isDirectory() || value.isSymbolicLink()))) {
    fail(`Unexpected path type: ${target}`);
  }
  return {
    uid: value.uid,
    gid: value.gid,
    mode: value.mode & 0o777,
    dev: value.dev,
    ino: value.ino,
    nlink: value.nlink,
  };
};

const readRegular = (target) => {
  let descriptor;
  try {
    descriptor = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_CLOEXEC
      | fs.constants.O_NOFOLLOW);
    const before = fs.fstatSync(descriptor);
    if (!before.isFile()) fail(`Unexpected path type: ${target}`);
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.nlink !== after.nlink || bytes.length !== after.size) {
      fail(`File changed while auditing: ${target}`);
    }
    return { bytes, stat: { uid: after.uid, gid: after.gid, mode: after.mode & 0o777,
      dev: after.dev, ino: after.ino, nlink: after.nlink } };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
};

const regularRecord = (target) => {
  const value = readRegular(target);
  return { path: target, realPath: fs.realpathSync(target), stat: value.stat,
    sha256: sha256(value.bytes) };
};

const exists = (target) => {
  try { fs.lstatSync(target); return true; }
  catch (error) { if (error?.code === "ENOENT") return false; throw error; }
};

export function auditFrontendBootstrapHost(options = {}) {
  const configPath = path.resolve(options.configPath || DEFAULTS.configPath);
  const htmlRoot = path.resolve(options.htmlRoot || DEFAULTS.htmlRoot);
  const legacyRoot = path.resolve(options.legacyRoot || DEFAULTS.legacyRoot);
  const nginxPath = path.resolve(options.nginxPath || DEFAULTS.nginxPath);
  const systemctlPath = path.resolve(options.systemctlPath || DEFAULTS.systemctlPath);
  const nodePath = path.resolve(options.nodePath || DEFAULTS.nodePath);
  const curlPath = path.resolve(options.curlPath || DEFAULTS.curlPath);
  const launcherTools = Object.fromEntries([
    ["bash", "bashPath"], ["realpath", "realpathPath"], ["sha256sum", "sha256sumPath"],
    ["stat", "statPath"], ["readlink", "readlinkPath"], ["chown", "chownPath"],
    ["chmod", "chmodPath"], ["flock", "flockPath"], ["env", "envPath"],
  ].map(([name, option]) => [name, regularRecord(path.resolve(options[option] || DEFAULTS[option]))]));
  const machineIdPath = path.resolve(options.machineIdPath || "/etc/machine-id");
  const machineId = readRegular(machineIdPath).bytes;
  const auditedFiles = new Map([...files, ...PRESERVED_LEGACY_FILES].map((name) => [
    name, readRegular(path.join(legacyRoot, name)),
  ]));
  const releaseManifest = JSON.parse(auditedFiles.get("release.json").bytes.toString("utf8"));
  if (!/^[a-f0-9]{40}$/.test(String(releaseManifest.sourceCommit || ""))
    || releaseManifest.sourceDirty !== false
    || !/^[A-Za-z0-9._-]{1,100}$/.test(String(releaseManifest.version || ""))) {
    fail("Installed release manifest provenance is invalid");
  }
  const installedHashes = Object.fromEntries(files.map((name) => [name,
    sha256(auditedFiles.get(name).bytes)]));
  const installedStats = Object.fromEntries(files.map((name) => [name,
    auditedFiles.get(name).stat]));
  const preservedLegacy = PRESERVED_LEGACY_FILES.map((name) => {
    const value = auditedFiles.get(name);
    return { name, sha256: sha256(value.bytes), stat: value.stat };
  });
  const config = regularRecord(configPath);
  const node = regularRecord(nodePath);
  const auditSourceSha256 = sha256(readRegular(fileURLToPath(import.meta.url)).bytes);
  const expectedSourceSha256 = options.auditSourceSha256
    || process.env.LK_FRONTEND_AUDIT_SOURCE_SHA256 || auditSourceSha256;
  const launcherSha256 = options.launcherSha256
    || process.env.LK_FRONTEND_AUDIT_LAUNCHER_SHA256 || "0".repeat(64);
  const expectedNodeSha256 = options.nodeSha256
    || process.env.LK_FRONTEND_AUDIT_NODE_SHA256 || node.sha256;
  if (auditSourceSha256 !== expectedSourceSha256 || node.sha256 !== expectedNodeSha256
    || !/^[a-f0-9]{64}$/.test(launcherSha256)) {
    fail("Host audit producer identity mismatch");
  }
  const snapshot = {
    formatVersion: 1,
    kind: "lk-frontend-static-bootstrap-host-snapshot",
    capturedAt: new Date().toISOString(),
    hostname: options.hostname || os.hostname(),
    machineIdSha256: sha256(machineId),
    config,
    htmlRoot: { path: htmlRoot, realPath: fs.realpathSync(htmlRoot), stat: statRecord(htmlRoot, { directory: true }) },
    legacyRoot: { path: legacyRoot, realPath: fs.realpathSync(legacyRoot), stat: statRecord(legacyRoot, { directory: true }) },
    nginx: regularRecord(nginxPath),
    systemctl: regularRecord(systemctlPath),
    node,
    curl: regularRecord(curlPath),
    producer: {
      kind: "lk-frontend-static-bootstrap-audit",
      sourceSha256: auditSourceSha256,
      launcherSha256,
      nodeSha256: node.sha256,
    },
    launcherTools,
    nginxService: options.nginxService || DEFAULTS.nginxService,
    assetBase: options.assetBase || DEFAULTS.assetBase,
    originResolve: options.originResolve || DEFAULTS.originResolve,
    installed: {
      source: releaseManifest.sourceCommit,
      version: releaseManifest.version,
      hashes: installedHashes,
    },
    installedStats,
    preservedLegacy,
    bootstrapState: {
      releasesExists: exists(path.join(htmlRoot, "lk-frontend-releases")),
      currentExists: exists(path.join(htmlRoot, "lk-frontend-current")),
      globalLeaseExists: exists(path.join(htmlRoot, ".lk-frontend-bootstrap.lease.json")),
      stagingEntries: fs.readdirSync(htmlRoot)
        .filter((name) => name.startsWith(".lk-frontend-releases-bootstrap-")).sort(),
      orphanEntries: fs.readdirSync(htmlRoot)
        .filter((name) => name.startsWith("..lk-frontend-bootstrap.lease.json.")).sort(),
    },
  };
  if (!/^https:\/\//.test(snapshot.assetBase)
    || !/^[a-zA-Z0-9_.@-]{1,100}$/.test(snapshot.nginxService)
    || snapshot.originResolve !== DEFAULTS.originResolve
    || config.realPath !== configPath
    || snapshot.htmlRoot.realPath !== htmlRoot
    || snapshot.legacyRoot.realPath !== legacyRoot) {
    fail("Host snapshot topology is outside the supported bootstrap contract");
  }
  return snapshot;
}

if (process.argv[1]
  && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try {
    if (process.argv.length !== 2) fail("Host audit accepts no arguments");
    const allowedEnvironment = new Set(["PATH", "LANG", "LC_ALL", "LK_FRONTEND_AUDIT_SOURCE_SHA256",
      "LK_FRONTEND_AUDIT_LAUNCHER_SHA256", "LK_FRONTEND_AUDIT_NODE_SHA256"]);
    if (Object.keys(process.env).some((name) => !allowedEnvironment.has(name))
      || !/^[a-f0-9]{64}$/.test(String(process.env.LK_FRONTEND_AUDIT_SOURCE_SHA256 || ""))
      || !/^[a-f0-9]{64}$/.test(String(process.env.LK_FRONTEND_AUDIT_LAUNCHER_SHA256 || ""))
      || !/^[a-f0-9]{64}$/.test(String(process.env.LK_FRONTEND_AUDIT_NODE_SHA256 || ""))) {
      fail("Host audit requires the clean exact-FD launcher environment");
    }
    process.stdout.write(`${JSON.stringify(auditFrontendBootstrapHost(), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
