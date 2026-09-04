#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SHA256 = /^[a-f0-9]{64}$/;
const ATTEMPT_ID = /^[a-f0-9]{32}$/;
const LOCK_PATH = "/run/lock/lk1-subscription-dev-stopped-install.lock";
const CANDIDATE_PARENT_PREFIX = "/srv/lk1-subscription-dev/.stopped-install-";
const LOCK_CONFIRMATION = "HELD_BY_TRUSTED_STOPPED_INSTALL_LAUNCHER";
const CONFIRMATIONS = Object.freeze({
  install: ["LK1_SUBSCRIPTION_DEV_STOPPED_INSTALL", "CONFIRM_EXACT_STOPPED_INSTALL"],
  rollback: ["LK1_SUBSCRIPTION_DEV_STOPPED_ROLLBACK", "CONFIRM_EXACT_STOPPED_ROLLBACK"],
  recover: ["LK1_SUBSCRIPTION_DEV_STOPPED_RECOVERY", "CONFIRM_EXACT_STOPPED_RECOVERY"],
});
const fail = (message) => { throw new Error(message); };
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

const exactKeys = (value, keys, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    fail(`${label} schema mismatch`);
  }
};

const assertDirectory = (directory, uid) => {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid
    || (stat.mode & 0o777) !== 0o700) fail(`trusted launcher directory custody mismatch (${directory})`);
};

const assertRegular = (file, uid, mode) => {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== uid || stat.nlink !== 1
    || (stat.mode & 0o777) !== mode) fail(`trusted launcher file custody mismatch (${file})`);
};

const assertProtectedParents = (target, uid) => {
  let current = path.dirname(target);
  while (true) {
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid
      || (stat.mode & 0o022) !== 0) fail(`trusted launcher parent custody mismatch (${current})`);
    if (current === "/") return;
    current = path.dirname(current);
  }
};

export function verifyBundleBeforeExecution({
  bundleDirectory,
  expectedManifestSha256,
  expectedUid = 0,
  environment = "production",
} = {}) {
  if (!SHA256.test(expectedManifestSha256 || "")) fail("trusted launcher manifest SHA is invalid");
  const root = fs.realpathSync(bundleDirectory);
  const candidateParent = `${CANDIDATE_PARENT_PREFIX}${expectedManifestSha256}`;
  if (environment === "production"
    && root !== `${candidateParent}/bundle`) {
    fail("trusted launcher bundle path mismatch");
  }
  if (environment === "production") {
    assertDirectory(candidateParent, expectedUid);
    assertProtectedParents(candidateParent, expectedUid);
  }
  assertDirectory(root, expectedUid);
  const manifestPath = path.join(root, "manifest.json");
  assertRegular(manifestPath, expectedUid, 0o600);
  const manifestBytes = fs.readFileSync(manifestPath);
  if (sha256(manifestBytes) !== expectedManifestSha256) fail("trusted launcher manifest SHA mismatch");
  const manifest = JSON.parse(manifestBytes);
  exactKeys(manifest, [
    "formatVersion", "stage", "environment", "sourceCommit", "toolingCommit", "toolingTreeSha",
    "sourceCandidateSha256", "sourceCandidateManifestSha256", "createdAt", "files",
    "trustedLauncher", "preflightBinding", "authority",
  ], "trusted launcher manifest");
  if (manifest.formatVersion !== 1 || manifest.stage !== "STOPPED_INSTALL_CANDIDATE"
    || manifest.environment !== "DEV" || JSON.stringify(manifest.authority) !== JSON.stringify({
      hostRead: true,
      hostInstall: true,
      daemonReload: false,
      serviceStart: false,
      enableUnits: false,
      ingress: false,
      activation: false,
      canaryIds: false,
      secrets: false,
      externalWrites: false,
    }) || !Array.isArray(manifest.files)
    || manifest.trustedLauncher?.path
      !== "scripts/launch_lk1_subscription_dev_stopped_candidate.mjs"
    || !SHA256.test(manifest.trustedLauncher?.sha256 || "")) {
    fail("trusted launcher manifest authority mismatch");
  }
  if (environment === "production") {
    const launcherPath = fileURLToPath(import.meta.url);
    if (launcherPath !== `${candidateParent}/launcher.mjs`) {
      fail("trusted launcher execution path mismatch");
    }
    assertRegular(launcherPath, expectedUid, 0o500);
    if (sha256(fs.readFileSync(launcherPath)) !== manifest.trustedLauncher.sha256) {
      fail("trusted launcher self-identity mismatch");
    }
  }
  const rows = new Map();
  for (const row of manifest.files) {
    exactKeys(row, ["path", "mode", "sha256", "size"], "trusted launcher file row");
    const target = path.resolve(root, row.path);
    if (!target.startsWith(`${root}${path.sep}`) || rows.has(row.path)
      || !["0550", "0600", "0640", "0644"].includes(row.mode)
      || !SHA256.test(row.sha256) || !Number.isSafeInteger(row.size) || row.size < 1) {
      fail("trusted launcher file row mismatch");
    }
    rows.set(row.path, row);
  }
  const inventory = [];
  const visit = (directory) => {
    assertDirectory(directory, expectedUid);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) fail("trusted launcher bundle contains a symlink");
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile()) inventory.push(path.relative(root, target));
      else fail("trusted launcher bundle contains a special file");
    }
  };
  visit(root);
  if (JSON.stringify(inventory.sort())
    !== JSON.stringify(["manifest.json", ...rows.keys()].sort())) {
    fail("trusted launcher bundle inventory mismatch");
  }
  for (const [relative, row] of rows) {
    const target = path.join(root, relative);
    assertRegular(target, expectedUid, Number.parseInt(row.mode, 8));
    const bytes = fs.readFileSync(target);
    if (bytes.length !== row.size || sha256(bytes) !== row.sha256) {
      fail(`trusted launcher payload drift (${relative})`);
    }
  }
  const installerPath = path.join(root, "payload/install_lk1_subscription_dev_stopped_candidate.mjs");
  const installer = rows.get("payload/install_lk1_subscription_dev_stopped_candidate.mjs");
  if (!installer || installer.mode !== "0550") fail("trusted launcher installer identity mismatch");
  return { root, installerPath, manifest };
}

export function launchStoppedCandidate({
  argv,
  environment = "production",
  expectedUid = 0,
  runLocked = defaultRunLocked,
} = {}) {
  const args = parseArgs(argv);
  if (!new Set(["install", "rollback", "recover"]).has(args["--mode"])) {
    fail("trusted launcher mode mismatch");
  }
  if (args["--mode"] === "install" && !ATTEMPT_ID.test(args["--attempt-id"] || "")) {
    fail("trusted launcher attempt ID mismatch");
  }
  if (environment === "production" && [
    "NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES",
  ].some((key) => process.env[key] !== undefined)) fail("trusted launcher environment is not clean");
  const [confirmationKey, confirmationValue] = CONFIRMATIONS[args["--mode"]] || [];
  if (environment === "production" && process.env[confirmationKey] !== confirmationValue) {
    fail("trusted launcher operation authority mismatch");
  }
  const verified = verifyBundleBeforeExecution({
    bundleDirectory: args["--bundle"],
    expectedManifestSha256: args["--manifest-sha256"],
    expectedUid,
    environment,
  });
  if (environment === "production" && args["--mode"] === "install"
    && args["--preflight-evidence"]
      !== `${CANDIDATE_PARENT_PREFIX}${args["--manifest-sha256"]}/evidence.json`) {
    fail("trusted launcher preflight evidence path mismatch");
  }
  const runtime = fs.realpathSync(process.execPath);
  const runtimeStat = fs.lstatSync(runtime);
  const expectedRuntimeUid = environment === "production" ? expectedUid : runtimeStat.uid;
  if ((environment === "production"
      && runtime !== "/srv/lk1-subscription-dev/runtime/node/bin/node")
    || !runtimeStat.isFile() || runtimeStat.isSymbolicLink() || runtimeStat.uid !== expectedRuntimeUid
    || (runtimeStat.mode & 0o022) !== 0) fail("trusted launcher Node runtime custody mismatch");
  const childEnv = {
    PATH: "/usr/bin:/bin",
    LANG: "C",
    LK1_SUBSCRIPTION_DEV_STOPPED_LOCK_HELD: LOCK_CONFIRMATION,
    LK1_SUBSCRIPTION_DEV_STOPPED_LOCK_FD: "3",
  };
  if (process.env[confirmationKey] !== undefined) {
    childEnv[confirmationKey] = process.env[confirmationKey];
  }
  runLocked(runtime, verified.installerPath, argv, {
    childEnv, expectedUid, environment,
  });
  return true;
}

function defaultRunLocked(runtime, installerPath, forwardedArgs, {
  childEnv, expectedUid, environment,
}) {
  const lockFd = fs.openSync(
    LOCK_PATH,
    fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_CLOEXEC | fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fs.fchmodSync(lockFd, 0o600);
    if (environment === "production") fs.fchownSync(lockFd, expectedUid, 0);
    const lockStat = fs.fstatSync(lockFd);
    if (!lockStat.isFile() || lockStat.uid !== expectedUid || lockStat.nlink !== 1
      || (lockStat.mode & 0o777) !== 0o600) fail("trusted launcher lock custody mismatch");
    execFileSync("/usr/bin/flock", ["--exclusive", "--nonblock", "3"], {
      stdio: ["ignore", "ignore", "inherit", lockFd],
      env: { PATH: "/usr/bin:/bin", LANG: "C" },
    });
    execFileSync(runtime, [installerPath, ...forwardedArgs], {
      stdio: ["inherit", "inherit", "inherit", lockFd],
      env: childEnv,
    });
  } finally {
    fs.closeSync(lockFd);
  }
}

function parseArgs(argv = []) {
  if (!Array.isArray(argv) || argv.length === 0 || argv.length % 2 !== 0) {
    fail("trusted launcher arguments are invalid");
  }
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index].startsWith("--") || Object.hasOwn(result, argv[index])) {
      fail("trusted launcher arguments are invalid");
    }
    result[argv[index]] = argv[index + 1];
  }
  const allowed = argsForMode(result["--mode"]);
  if (JSON.stringify(Object.keys(result).sort()) !== JSON.stringify([...allowed].sort())) {
    fail("trusted launcher argument schema mismatch");
  }
  return result;
}

const argsForMode = (mode) => mode === "install"
  ? ["--mode", "--bundle", "--manifest-sha256", "--preflight-evidence", "--preflight-sha256", "--attempt-id"]
  : ["--mode", "--bundle", "--manifest-sha256", "--evidence-directory"];

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    launchStoppedCandidate({ argv: process.argv.slice(2) });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
