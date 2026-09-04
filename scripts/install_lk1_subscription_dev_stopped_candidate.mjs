#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { verifyRuntimeInstallCandidateBundle } from "./verify_lk1_subscription_dev_runtime_install_candidate.mjs";
import {
  currentCaptureIdentity,
  validateFreshHostPreflightEvidence,
} from "./validate_lk1_subscription_dev_host_preflight.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const HOSTNAME = "89-108-64-209.cloudvps.regruhosting.ru";
const INSTALL_CONFIRMATION = "CONFIRM_EXACT_STOPPED_INSTALL";
const ROLLBACK_CONFIRMATION = "CONFIRM_EXACT_STOPPED_ROLLBACK";
const RECOVERY_CONFIRMATION = "CONFIRM_EXACT_STOPPED_RECOVERY";
const LOCK_CONFIRMATION = "HELD_BY_TRUSTED_STOPPED_INSTALL_LAUNCHER";
const ATTEMPT_ID = /^[a-f0-9]{32}$/;
const UNITS = Object.freeze([
  "lk1-subscription-dev-mongo.service",
  "lk1-subscription-dev-cup.service",
  "lk1-subscription-dev-provider-fixture.service",
  "lk1-subscription-dev-identity-fixture.service",
  "lk1-subscription-dev-nodered.service",
]);
const RESERVED_PORTS = Object.freeze([1882, 27030, 3037, 3038, 3039]);
const FORBIDDEN_INPUTS = Object.freeze([
  "/srv/lk1-subscription-dev/private/fixture.json",
  "/srv/lk1-subscription-dev/node-red/release-identity.json",
  "/srv/lk1-subscription-dev/authorization/service-start.approved",
  "/srv/lk1-subscription-dev/runtime/install-identity.env",
  "/srv/lk1-subscription-dev/tls/server.key",
  "/srv/lk1-subscription-dev/tls/server.crt",
]);
const INSTALLER_PATH = fileURLToPath(import.meta.url);
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const canonical = (value) => `${JSON.stringify(value, null, 2)}\n`;
const fail = (message) => { throw new Error(message); };

const targetPath = (rootPrefix, absolute) => {
  if (!path.isAbsolute(absolute) || absolute.includes("..")) fail("install target path is invalid");
  const root = path.resolve(rootPrefix || "/");
  const resolved = path.resolve(root, `.${absolute}`);
  if (root !== "/" && !resolved.startsWith(`${root}${path.sep}`)) fail("install target escaped rehearsal root");
  return resolved;
};

const pathEntryExists = (file) => {
  try {
    fs.lstatSync(file);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
};

const assertRegular = (file, label, { uid, gid, mode, nlink = 1 } = {}) => {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== nlink
    || (uid !== undefined && stat.uid !== uid)
    || (gid !== undefined && stat.gid !== gid)
    || (mode !== undefined && (stat.mode & 0o777) !== mode)) fail(`${label} custody mismatch`);
  return stat;
};

const assertDirectory = (directory, label, { uid, mode } = {}) => {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || (uid !== undefined && stat.uid !== uid)
    || (mode !== undefined && (stat.mode & 0o777) !== mode)) fail(`${label} custody mismatch`);
  return stat;
};

const assertBundleCustody = (root, manifest, uid) => {
  const expectedModes = new Map([
    ["manifest.json", 0o600],
    ...manifest.files.map((row) => [row.path, Number.parseInt(row.mode, 8)]),
  ]);
  const visit = (directory) => {
    assertDirectory(directory, "bundle directory", { uid, mode: 0o700 });
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else {
        const relative = path.relative(root, target);
        assertRegular(target, `bundle file ${relative}`, {
          uid, mode: expectedModes.get(relative), nlink: 1,
        });
      }
    }
  };
  visit(root);
};

const assertProtectedParents = (file, stopAt, expectedUid) => {
  let current = path.dirname(file);
  const stop = path.resolve(stopAt);
  while (current.startsWith(stop)) {
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== expectedUid
      || (stat.mode & 0o022) !== 0) fail(`install parent custody mismatch (${current})`);
    if (current === stop) return;
    current = path.dirname(current);
  }
  fail("install parent escaped custody root");
};

const fsyncDirectory = (directory) => {
  const directoryFd = fs.openSync(directory, fs.constants.O_RDONLY);
  try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
};

const writeExclusiveDurable = (target, bytes, { mode, uid, gid }) => {
  let fd;
  let created = false;
  try {
    fd = fs.openSync(target, fs.constants.O_CREAT | fs.constants.O_EXCL
      | fs.constants.O_WRONLY | fs.constants.O_CLOEXEC | fs.constants.O_NOFOLLOW, mode);
    created = true;
    fs.writeFileSync(fd, bytes);
    fs.fchmodSync(fd, mode);
    if (typeof fs.fchownSync === "function") fs.fchownSync(fd, uid, gid);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fsyncDirectory(path.dirname(target));
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    if (created && pathEntryExists(target)) fs.unlinkSync(target);
    throw error;
  }
};

const writeAtomic = (target, bytes, { mode, uid, gid, suffix }) => {
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${suffix}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL
      | fs.constants.O_WRONLY | fs.constants.O_CLOEXEC | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeFileSync(fd, bytes);
    fs.fchmodSync(fd, mode);
    if (typeof fs.fchownSync === "function") fs.fchownSync(fd, uid, gid);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, target);
    fsyncDirectory(path.dirname(target));
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (pathEntryExists(temporary)) fs.unlinkSync(temporary);
  }
};

const resolveIdentity = (name, database) => {
  const output = execFileSync("/usr/bin/getent", [database, name], { encoding: "utf8" }).trim();
  const fields = output.split(":");
  const value = Number.parseInt(fields[database === "passwd" ? 2 : 2], 10);
  if (!Number.isSafeInteger(value) || value < 0) fail(`cannot resolve ${database} identity (${name})`);
  return value;
};

const defaultProbe = ({ manifest, phase }) => {
  for (const unit of UNITS) {
    let active;
    let enabled;
    try {
      active = execFileSync("/usr/bin/systemctl", ["is-active", unit], {
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    } catch (error) {
      active = String(error.stdout || "").trim();
    }
    try {
      enabled = execFileSync("/usr/bin/systemctl", ["is-enabled", unit], {
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    } catch (error) {
      enabled = String(error.stdout || "").trim();
    }
    if (active !== "inactive" || enabled !== "disabled") fail(`unit is not stopped and disabled (${unit})`);
  }
  const sockets = execFileSync("/usr/bin/ss", ["-H", "-ltn"], { encoding: "utf8" });
  for (const port of RESERVED_PORTS) {
    if (new RegExp(`(?:^|:)${port}(?:\\s|$)`, "m").test(sockets)) fail(`reserved listener is present (${port})`);
  }
  for (const input of FORBIDDEN_INPUTS) {
    if (pathEntryExists(input)) fail(`forbidden authorization input is present (${input})`);
  }
  const sharedFlow = fs.readFileSync("/root/.node-red/flows.json");
  if (sha256(sharedFlow) !== manifest.preflightBinding.expectedSharedFlowSha256) fail("shared flow drifted");
  return { phase, sharedFlowSha256: sha256(sharedFlow) };
};

export function validateStoppedInstallContract(contract) {
  if (contract?.formatVersion !== 2 || contract.stage !== "STOPPED_INSTALL_CANDIDATE"
    || contract.environment !== "DEV" || contract.sourceCommit !== null
    || contract.stoppedInstall?.exactBundlePathPrefix !== "/tmp/lk1-subscription-dev-stopped-install-"
    || contract.stoppedInstall?.evidenceRoot !== "/srv/lk1-subscription-dev/bootstrap-evidence/stopped-install"
    || contract.stoppedInstall?.evidenceLayout !== "MANIFEST_SHA256/ATTEMPT_ID"
    || contract.stoppedInstall?.executionLock !== "KERNEL_FLOCK_TRUSTED_LAUNCHER"
    || contract.rollback?.mode !== "RESTORE_EXACT_PREIMAGE_OR_ABSENT"
    || contract.rollback.automaticOnInstallFailure !== true
    || contract.rollback.manualExecutionRequiresSeparateAuthorization !== true
    || contract.rollback.incompleteRecovery !== "SEPARATELY_AUTHORIZED_IDEMPOTENT"
    || contract.rollback.preserveEvidence !== true || contract.rollback.deleteData !== false
    || contract.candidateContents.installExecutor !== "INCLUDED_STOPPED_ONLY"
    || contract.candidateContents.rollbackExecutor !== "INCLUDED_SEPARATELY_AUTHORIZED"
    || contract.candidateContents.trustedPreExecLauncher !== "OUT_OF_BUNDLE_EXACT_SHA"
    || contract.authority.bundleBuildAllowed !== true
    || contract.authority.hostReadAllowed !== true
    || contract.authority.hostInstallAllowed !== true
    || contract.authority.manualRollbackAllowed !== false) fail("stopped install contract identity mismatch");
  const allowedTrue = new Set(["bundleBuildAllowed", "hostReadAllowed", "hostInstallAllowed"]);
  if (Object.entries(contract.authority).some(([key, value]) => value !== allowedTrue.has(key))) {
    fail("stopped install contract exceeds host-install-only authority");
  }
  if (!Array.isArray(contract.stoppedInstall.installedFiles)
    || contract.stoppedInstall.installedFiles.length !== 6
    || new Set(contract.stoppedInstall.installedFiles.map((item) => item.targetPath)).size !== 6) {
    fail("stopped install file map mismatch");
  }
  for (const item of contract.stoppedInstall.installedFiles) {
    if (!item.sourcePath?.startsWith("payload/") || !path.isAbsolute(item.targetPath)
      || !["0550", "0600", "0644"].includes(item.mode)
      || item.owner !== "root" || !["root", "lk1-subscription-dev"].includes(item.group)
      || !["ABSENT", "EXACT_FILE"].includes(item.preimage?.state)
      || (item.preimage.state === "ABSENT" ? item.preimage.sha256 !== null
        : !SHA256.test(item.preimage.sha256 || ""))
      || JSON.stringify(Object.keys(item.preimage).sort())
        !== JSON.stringify(["group", "mode", "nlink", "owner", "sha256", "state"])
      || (item.preimage.state === "ABSENT"
        ? ["mode", "owner", "group", "nlink"].some((key) => item.preimage[key] !== null)
        : item.preimage.mode !== item.mode || item.preimage.owner !== item.owner
          || item.preimage.group !== item.group || item.preimage.nlink !== 1)) {
      fail("stopped install file map entry mismatch");
    }
  }
  if (JSON.stringify(contract.stoppedInstall.forbiddenEffects) !== JSON.stringify([
    "DAEMON_RELOAD", "SERVICE_START", "SERVICE_ENABLE", "INGRESS_CHANGE",
    "CONFIG_OR_TLS_INSTALL", "START_CREDENTIAL_OR_RELEASE_RECEIPT", "PROVIDER_OR_DATABASE_WRITE",
  ])) fail("stopped install forbidden-effect boundary mismatch");
  return true;
}

function validateBundleAndEvidence(bundleDirectory, expectedManifestSha256, evidence, now) {
  const verified = verifyRuntimeInstallCandidateBundle(bundleDirectory, expectedManifestSha256);
  const { manifest, contract } = verified;
  validateStoppedInstallContract(contract);
  const localCaptureIdentity = currentCaptureIdentity();
  if (manifest.stage !== "STOPPED_INSTALL_CANDIDATE"
    || manifest.toolingTreeSha === undefined
    || !COMMIT.test(manifest.toolingCommit || "")
    || !COMMIT.test(manifest.toolingTreeSha || "")) fail("stopped install manifest identity mismatch");
  validateFreshHostPreflightEvidence(evidence, now, {
    expectedRepositoryIdentity: {
      headSha: manifest.toolingCommit,
      treeSha: manifest.toolingTreeSha,
      clean: true,
    },
    expectedReleaseBinding: {
      sourceCommit: manifest.sourceCommit,
      sourceFlowSha256: verified.receiptTemplate.sourceFlowSha256,
      candidateSha256: manifest.sourceCandidateSha256,
      manifestSha256: manifest.sourceCandidateManifestSha256,
    },
    expectedValidatorSha256: manifest.preflightBinding.validatorSha256,
    expectedRemoteScriptSha256: manifest.preflightBinding.remoteScriptSha256,
  });
  if (evidence.capture.hostKeyFingerprint !== manifest.preflightBinding.hostKeyFingerprint
    || JSON.stringify(manifest.preflightBinding) !== JSON.stringify({
      ...localCaptureIdentity,
      expectedSharedFlowSha256: manifest.preflightBinding.expectedSharedFlowSha256,
    })
    || evidence.sharedResources.flowSha256 !== manifest.preflightBinding.expectedSharedFlowSha256) {
    fail("stopped install preflight binding mismatch");
  }
  return verified;
}

function assertBundleExecutionIdentity(root, manifest) {
  const expected = path.join(root, "payload/install_lk1_subscription_dev_stopped_candidate.mjs");
  if (fs.realpathSync(INSTALLER_PATH) !== fs.realpathSync(expected)) {
    fail("stopped installer must execute from the verified bundle");
  }
  const row = manifest.files.find((item) => item.path === "payload/install_lk1_subscription_dev_stopped_candidate.mjs");
  if (!row || row.sha256 !== sha256(fs.readFileSync(INSTALLER_PATH))) fail("stopped installer identity mismatch");
}

function preparePreimages({ rootPrefix, bundleRoot, contract, evidenceDirectory, uid, gid, rootGid }) {
  const validated = contract.stoppedInstall.installedFiles.map((item) => {
    const source = path.join(bundleRoot, item.sourcePath);
    const destination = targetPath(rootPrefix, item.targetPath);
    assertRegular(source, `bundle source ${item.sourcePath}`);
    assertProtectedParents(destination, rootPrefix || "/", uid);
    const sourceSha256 = sha256(fs.readFileSync(source));
    if (item.preimage.state === "ABSENT") {
      if (pathEntryExists(destination)) fail(`required absent preimage is present (${item.targetPath})`);
      return { item, sourceSha256, preimageBytes: null, preimageMetadata: null };
    }
    const expectedGid = item.preimage.group === "root" ? rootGid : gid;
    const stat = assertRegular(destination, `preimage ${item.targetPath}`, {
      uid, gid: expectedGid, mode: Number.parseInt(item.preimage.mode, 8),
      nlink: item.preimage.nlink,
    });
    const preimageBytes = fs.readFileSync(destination);
    if (sha256(preimageBytes) !== item.preimage.sha256) fail(`preimage digest mismatch (${item.targetPath})`);
    return {
      item,
      sourceSha256,
      preimageBytes,
      preimageMetadata: {
        uid: stat.uid,
        gid: stat.gid,
        mode: (stat.mode & 0o777).toString(8).padStart(4, "0"),
        nlink: stat.nlink,
      },
    };
  });
  const backupDirectory = path.join(evidenceDirectory, "preimage");
  fs.mkdirSync(backupDirectory, { mode: 0o700 });
  fs.chownSync(backupDirectory, uid, gid);
  return validated.map(({ item, sourceSha256, preimageBytes, preimageMetadata }, index) => {
    if (preimageBytes !== null) {
      const backupPath = path.join(backupDirectory, `${index}.bin`);
      writeExclusiveDurable(backupPath, preimageBytes, { mode: 0o600, uid, gid });
      return {
        ...item, sourceSha256, preimageMetadata,
        backupPath: path.relative(evidenceDirectory, backupPath),
      };
    }
    return { ...item, sourceSha256, preimageMetadata: null, backupPath: null };
  });
}

const metadataMatches = (stat, metadata) => stat.uid === metadata.uid
  && stat.gid === metadata.gid && (stat.mode & 0o777) === Number.parseInt(metadata.mode, 8)
  && stat.nlink === metadata.nlink;

function restoreRecords({ rootPrefix, evidenceDirectory, records, changed, uid, gid, suffix, verified = [] }) {
  const states = new Map();
  for (const index of changed) {
    const record = records[index];
    const destination = targetPath(rootPrefix, record.targetPath);
    if (!pathEntryExists(destination)) {
      if (record.preimage.state !== "ABSENT") fail(`rollback target is absent (${record.targetPath})`);
      states.set(index, "PREIMAGE_EXACT");
      continue;
    }
    const stat = assertRegular(destination, `rollback target ${record.targetPath}`);
    const digest = sha256(fs.readFileSync(destination));
    if (record.preimage.state === "EXACT_FILE" && digest === record.preimage.sha256) {
      states.set(index, metadataMatches(stat, record.preimageMetadata)
        ? "PREIMAGE_EXACT" : "PREIMAGE_METADATA_DRIFT");
    } else if (digest === record.sourceSha256) {
      states.set(index, "POSTIMAGE_EXACT");
    } else {
      fail(`rollback target drifted (${record.targetPath})`);
    }
  }
  for (const index of [...changed].reverse()) {
    const record = records[index];
    const destination = targetPath(rootPrefix, record.targetPath);
    if (states.get(index) === "PREIMAGE_EXACT") {
      verified.push(record.targetPath);
      continue;
    }
    if (record.preimage.state === "ABSENT") {
      fs.unlinkSync(destination);
      fsyncDirectory(path.dirname(destination));
    } else {
      const backup = path.join(evidenceDirectory, record.backupPath);
      assertRegular(backup, `rollback backup ${record.targetPath}`, { uid, gid, mode: 0o600 });
      const bytes = fs.readFileSync(backup);
      if (sha256(bytes) !== record.preimage.sha256) fail(`rollback backup drifted (${record.targetPath})`);
      writeAtomic(destination, bytes, {
        mode: Number.parseInt(record.preimageMetadata.mode, 8), uid: record.preimageMetadata.uid,
        gid: record.preimageMetadata.gid, suffix,
      });
    }
    if (record.preimage.state === "ABSENT") {
      if (pathEntryExists(destination)) fail(`rollback absence postcheck failed (${record.targetPath})`);
    } else {
      assertRegular(destination, `restored preimage ${record.targetPath}`, {
        uid: record.preimageMetadata.uid,
        gid: record.preimageMetadata.gid,
        mode: Number.parseInt(record.preimageMetadata.mode, 8),
        nlink: record.preimageMetadata.nlink,
      });
      if (sha256(fs.readFileSync(destination)) !== record.preimage.sha256) {
        fail(`rollback preimage postcheck failed (${record.targetPath})`);
      }
    }
    verified.push(record.targetPath);
  }
  return verified;
}

function cleanupAttemptTemporaries({ rootPrefix, records, installSuffix, uid }) {
  const temporaryPaths = [];
  for (const record of records) {
    const destination = targetPath(rootPrefix, record.targetPath);
    const temporary = path.join(
      path.dirname(destination), `.${path.basename(destination)}.${installSuffix}.tmp`,
    );
    if (!pathEntryExists(temporary)) continue;
    assertRegular(temporary, `interrupted install temporary ${record.targetPath}`, {
      uid, nlink: 1,
    });
    temporaryPaths.push(temporary);
  }
  for (const temporary of temporaryPaths) {
    fs.unlinkSync(temporary);
    fsyncDirectory(path.dirname(temporary));
  }
  return temporaryPaths.map((temporary) => path.relative(rootPrefix || "/", temporary));
}

export function installStoppedCandidate({
  bundleDirectory,
  expectedManifestSha256,
  preflightEvidence,
  preflightEvidenceSha256,
  now = new Date(),
  environment = "production",
  rootPrefix = "",
  currentUid = typeof process.getuid === "function" ? process.getuid() : -1,
  currentGid = typeof process.getgid === "function" ? process.getgid() : -1,
  targetGid = environment === "production" ? resolveIdentity("lk1-subscription-dev", "group") : currentGid,
  hostname = os.hostname(),
  confirmation = process.env.LK1_SUBSCRIPTION_DEV_STOPPED_INSTALL,
  lockHeld = process.env.LK1_SUBSCRIPTION_DEV_STOPPED_LOCK_HELD,
  attemptId = crypto.randomBytes(16).toString("hex"),
  probe = defaultProbe,
} = {}) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())
    || !SHA256.test(expectedManifestSha256 || "")
    || !SHA256.test(preflightEvidenceSha256 || "")
    || sha256(Buffer.from(canonical(preflightEvidence))) !== preflightEvidenceSha256
    || !ATTEMPT_ID.test(attemptId || "")) {
    fail("stopped install inputs are invalid");
  }
  if (environment === "production") {
    if (currentUid !== 0 || hostname !== HOSTNAME || rootPrefix !== ""
      || confirmation !== INSTALL_CONFIRMATION || lockHeld !== LOCK_CONFIRMATION) {
      fail("stopped install production authority mismatch");
    }
  } else if (environment !== "rehearsal") fail("stopped install environment mismatch");
  const bundleRoot = fs.realpathSync(bundleDirectory);
  const verified = validateBundleAndEvidence(
    bundleRoot, expectedManifestSha256, preflightEvidence, now,
  );
  assertBundleCustody(bundleRoot, verified.manifest, currentUid);
  assertBundleExecutionIdentity(bundleRoot, verified.manifest);
  const expectedBundlePath = `${verified.contract.stoppedInstall.exactBundlePathPrefix}${expectedManifestSha256}`;
  if (environment === "production" && bundleRoot !== expectedBundlePath) fail("stopped install bundle path mismatch");
  let evidenceDirectory;
  let records = [];
  const changed = [];
  const installSuffix = `${expectedManifestSha256.slice(0, 16)}.${attemptId}`;
  try {
    probe({ contract: verified.contract, manifest: verified.manifest, phase: "PREINSTALL" });
    for (const item of verified.contract.stoppedInstall.requiredExistingFiles) {
      const file = targetPath(rootPrefix, item.path);
      assertRegular(file, `required existing file ${item.path}`);
      if (sha256(fs.readFileSync(file)) !== item.sha256) fail(`required existing file drifted (${item.path})`);
    }
    const evidenceRoot = targetPath(rootPrefix, verified.contract.stoppedInstall.evidenceRoot);
    assertProtectedParents(evidenceRoot, rootPrefix || "/", currentUid);
    if (!pathEntryExists(evidenceRoot)) {
      fs.mkdirSync(evidenceRoot, { recursive: false, mode: 0o700 });
      fs.chownSync(evidenceRoot, currentUid, currentGid);
    }
    assertDirectory(evidenceRoot, "stopped install evidence root", {
      uid: currentUid, mode: 0o700,
    });
    const manifestEvidenceDirectory = path.join(evidenceRoot, expectedManifestSha256);
    if (!pathEntryExists(manifestEvidenceDirectory)) {
      fs.mkdirSync(manifestEvidenceDirectory, { mode: 0o700 });
      fs.chownSync(manifestEvidenceDirectory, currentUid, currentGid);
    }
    assertDirectory(manifestEvidenceDirectory, "stopped install manifest evidence directory", {
      uid: currentUid, mode: 0o700,
    });
    evidenceDirectory = path.join(manifestEvidenceDirectory, attemptId);
    fs.mkdirSync(evidenceDirectory, { mode: 0o700 });
    fs.chownSync(evidenceDirectory, currentUid, currentGid);
    assertDirectory(evidenceDirectory, "stopped install evidence directory", {
      uid: currentUid, mode: 0o700,
    });
    records = preparePreimages({
      rootPrefix, bundleRoot, contract: verified.contract, evidenceDirectory,
      uid: currentUid, gid: targetGid, rootGid: currentGid,
    });
    writeExclusiveDurable(path.join(evidenceDirectory, "preimage.json"), canonical({
      schemaVersion: 1,
      state: "PREIMAGE_CAPTURED",
      manifestSha256: expectedManifestSha256,
      attemptId,
      preflightEvidenceSha256,
      records,
    }), { mode: 0o600, uid: currentUid, gid: currentGid });
    const progressDirectory = path.join(evidenceDirectory, "progress");
    fs.mkdirSync(progressDirectory, { mode: 0o700 });
    fs.chownSync(progressDirectory, currentUid, currentGid);
    for (const [index, record] of records.entries()) {
      const source = path.join(bundleRoot, record.sourcePath);
      const destination = targetPath(rootPrefix, record.targetPath);
      changed.push(index);
      writeAtomic(destination, fs.readFileSync(source), {
        mode: Number.parseInt(record.mode, 8), uid: currentUid,
        gid: record.group === "root" ? currentGid : targetGid, suffix: installSuffix,
      });
      assertRegular(destination, `installed file ${record.targetPath}`, {
        uid: currentUid, mode: Number.parseInt(record.mode, 8),
      });
      if (sha256(fs.readFileSync(destination)) !== record.sourceSha256) {
        fail(`installed file digest mismatch (${record.targetPath})`);
      }
      writeExclusiveDurable(path.join(
        progressDirectory, `${String(index).padStart(2, "0")}-installed.json`,
      ), canonical({
        schemaVersion: 1,
        state: "POSTIMAGE_VERIFIED",
        manifestSha256: expectedManifestSha256,
        attemptId,
        index,
        targetPath: record.targetPath,
        sourceSha256: record.sourceSha256,
      }), { mode: 0o600, uid: currentUid, gid: currentGid });
    }
    probe({ contract: verified.contract, manifest: verified.manifest, phase: "POSTINSTALL" });
    const result = {
      schemaVersion: 1,
      state: "INSTALLED_STOPPED",
      installedAt: now.toISOString(),
      manifestSha256: expectedManifestSha256,
      attemptId,
      preflightEvidenceSha256,
      toolingCommit: verified.manifest.toolingCommit,
      toolingTreeSha: verified.manifest.toolingTreeSha,
      sourceCommit: verified.manifest.sourceCommit,
      installedFiles: records.map(({ targetPath: installedPath, sourceSha256, mode, owner, group }) => ({
        path: installedPath, sha256: sourceSha256, mode, owner, group,
      })),
      daemonReloadPerformed: false,
      servicesStarted: false,
      servicesEnabled: false,
      ingressChanged: false,
      secretsInstalled: false,
      externalWrites: false,
    };
    const evidencePath = path.join(evidenceDirectory, "install.json");
    writeExclusiveDurable(evidencePath, canonical(result), {
      mode: 0o600, uid: currentUid, gid: currentGid,
    });
    return { ...result, evidencePath };
  } catch (error) {
    if (evidenceDirectory && records.length > 0 && changed.length > 0) {
      let rollbackError;
      const rollbackVerifiedTargets = [];
      try {
        restoreRecords({
          rootPrefix, evidenceDirectory, records, changed,
          uid: currentUid, gid: targetGid, suffix: `${installSuffix}.auto-rollback`,
          verified: rollbackVerifiedTargets,
        });
        probe({
          contract: verified.contract,
          manifest: verified.manifest,
          phase: "POST_AUTO_ROLLBACK",
        });
      } catch (candidateRollbackError) {
        rollbackError = candidateRollbackError;
      }
      writeExclusiveDurable(path.join(evidenceDirectory, "failure.json"), canonical({
        schemaVersion: 1,
        state: rollbackError ? "AUTO_ROLLBACK_INCOMPLETE" : "AUTO_ROLLED_BACK",
        failedAt: now.toISOString(),
        manifestSha256: expectedManifestSha256,
        attemptId,
        changedTargets: changed.map((index) => records[index].targetPath),
        rollbackVerifiedTargets,
        restoredTargets: rollbackVerifiedTargets.length,
        error: String(error.message),
        rollbackError: rollbackError ? String(rollbackError.message) : null,
      }), { mode: 0o600, uid: currentUid, gid: currentGid });
      if (rollbackError) {
        fail(`stopped install failed and automatic rollback did not pass: ${error.message}; rollback: ${rollbackError.message}`);
      }
    }
    throw error;
  }
}

function runStoppedRollback({
  bundleDirectory,
  expectedManifestSha256,
  evidenceDirectory,
  recovery = false,
  environment = "production",
  rootPrefix = "",
  currentUid = typeof process.getuid === "function" ? process.getuid() : -1,
  currentGid = typeof process.getgid === "function" ? process.getgid() : -1,
  targetGid = environment === "production" ? resolveIdentity("lk1-subscription-dev", "group") : currentGid,
  hostname = os.hostname(),
  confirmation = recovery
    ? process.env.LK1_SUBSCRIPTION_DEV_STOPPED_RECOVERY
    : process.env.LK1_SUBSCRIPTION_DEV_STOPPED_ROLLBACK,
  lockHeld = process.env.LK1_SUBSCRIPTION_DEV_STOPPED_LOCK_HELD,
  probe = defaultProbe,
} = {}) {
  const requiredConfirmation = recovery ? RECOVERY_CONFIRMATION : ROLLBACK_CONFIRMATION;
  if (environment === "production") {
    if (currentUid !== 0 || hostname !== HOSTNAME || rootPrefix !== ""
      || confirmation !== requiredConfirmation || lockHeld !== LOCK_CONFIRMATION) {
      fail("stopped rollback production authority mismatch");
    }
  } else if (environment !== "rehearsal") fail("stopped rollback environment mismatch");
  const verified = verifyRuntimeInstallCandidateBundle(bundleDirectory, expectedManifestSha256);
  validateStoppedInstallContract(verified.contract);
  const bundleRoot = fs.realpathSync(bundleDirectory);
  assertBundleCustody(bundleRoot, verified.manifest, currentUid);
  assertBundleExecutionIdentity(bundleRoot, verified.manifest);
  const expectedManifestEvidenceDirectory = targetPath(
    rootPrefix,
    `${verified.contract.stoppedInstall.evidenceRoot}/${expectedManifestSha256}`,
  );
  const actualEvidenceDirectory = fs.realpathSync(evidenceDirectory);
  if (path.dirname(actualEvidenceDirectory) !== expectedManifestEvidenceDirectory
    || !ATTEMPT_ID.test(path.basename(actualEvidenceDirectory))) {
    fail("stopped rollback evidence path mismatch");
  }
  const installPath = path.join(evidenceDirectory, "install.json");
  const preimagePath = path.join(evidenceDirectory, "preimage.json");
  const installPresent = pathEntryExists(installPath);
  if (installPresent) assertRegular(installPath, "stopped install evidence", {
    uid: currentUid, gid: currentGid, mode: 0o600,
  });
  assertRegular(preimagePath, "stopped preimage evidence", {
    uid: currentUid, gid: currentGid, mode: 0o600,
  });
  const install = installPresent ? JSON.parse(fs.readFileSync(installPath, "utf8")) : null;
  const preimage = JSON.parse(fs.readFileSync(preimagePath, "utf8"));
  if ((recovery ? install !== null : install?.state !== "INSTALLED_STOPPED")
    || preimage.state !== "PREIMAGE_CAPTURED"
    || (!recovery && install.manifestSha256 !== expectedManifestSha256)
    || preimage.manifestSha256 !== expectedManifestSha256
    || preimage.attemptId !== path.basename(actualEvidenceDirectory)
    || (!recovery && install.attemptId !== preimage.attemptId)
    || !Array.isArray(preimage.records)
    || pathEntryExists(path.join(evidenceDirectory, "rollback.json"))) {
    fail("stopped rollback evidence mismatch");
  }
  const expectedRecords = verified.contract.stoppedInstall.installedFiles.map((item, index) => {
    const manifestRow = verified.manifest.files.find((row) => row.path === item.sourcePath);
    if (!manifestRow) fail(`stopped rollback source is absent (${item.sourcePath})`);
    return {
      ...item,
      sourceSha256: manifestRow.sha256,
      preimageMetadata: item.preimage.state === "ABSENT" ? null : {
        uid: currentUid,
        gid: item.preimage.group === "root" ? currentGid : targetGid,
        mode: item.preimage.mode,
        nlink: item.preimage.nlink,
      },
      backupPath: item.preimage.state === "ABSENT" ? null : `preimage/${index}.bin`,
    };
  });
  if (JSON.stringify(preimage.records) !== JSON.stringify(expectedRecords)
    || (!recovery && JSON.stringify(install.installedFiles) !== JSON.stringify(expectedRecords.map((record) => ({
      path: record.targetPath,
      sha256: record.sourceSha256,
      mode: record.mode,
      owner: record.owner,
      group: record.group,
    }))))) fail("stopped rollback record binding mismatch");
  probe({
    contract: verified.contract,
    manifest: verified.manifest,
    phase: recovery ? "PRE_RECOVERY" : "PRE_ROLLBACK",
  });
  const changed = preimage.records.map((_, index) => index);
  const cleanedTemporaryPaths = cleanupAttemptTemporaries({
    rootPrefix,
    records: preimage.records,
    installSuffix: `${expectedManifestSha256.slice(0, 16)}.${preimage.attemptId}`,
    uid: currentUid,
  });
  const restoredTargets = restoreRecords({
    rootPrefix, evidenceDirectory, records: preimage.records, changed,
    uid: currentUid, gid: targetGid,
    suffix: `${expectedManifestSha256.slice(0, 16)}.${recovery ? "recovery" : "rollback"}`,
  });
  const postRollback = probe({
    contract: verified.contract,
    manifest: verified.manifest,
    phase: recovery ? "POST_RECOVERY" : "POSTROLLBACK",
  });
  const result = {
    schemaVersion: 1,
    state: recovery ? "RECOVERED_TO_EXACT_PREIMAGE" : "ROLLED_BACK_TO_EXACT_PREIMAGE",
    manifestSha256: expectedManifestSha256,
    attemptId: preimage.attemptId,
    restoredTargets: restoredTargets.length,
    evidencePreserved: true,
    dataDeleted: false,
    cleanedTemporaryPaths,
    postRollback,
  };
  const evidencePath = path.join(evidenceDirectory, "rollback.json");
  writeExclusiveDurable(evidencePath, canonical(result), {
    mode: 0o600, uid: currentUid, gid: currentGid,
  });
  return { ...result, evidencePath };
}

export function rollbackStoppedCandidate(options = {}) {
  return runStoppedRollback({ ...options, recovery: false });
}

export function recoverIncompleteStoppedCandidate(options = {}) {
  return runStoppedRollback({ ...options, recovery: true });
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) result[argv[index]] = argv[index + 1];
  return result;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === INSTALLER_PATH) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args["--mode"] === "install") {
      const evidenceBytes = fs.readFileSync(args["--preflight-evidence"]);
      const evidence = JSON.parse(evidenceBytes);
      const result = installStoppedCandidate({
        bundleDirectory: args["--bundle"],
        expectedManifestSha256: args["--manifest-sha256"],
        preflightEvidence: evidence,
        preflightEvidenceSha256: args["--preflight-sha256"],
        attemptId: args["--attempt-id"],
      });
      process.stdout.write(`${canonical(result)}`);
    } else if (args["--mode"] === "rollback") {
      const result = rollbackStoppedCandidate({
        bundleDirectory: args["--bundle"],
        expectedManifestSha256: args["--manifest-sha256"],
        evidenceDirectory: args["--evidence-directory"],
      });
      process.stdout.write(`${canonical(result)}`);
    } else if (args["--mode"] === "recover") {
      const result = recoverIncompleteStoppedCandidate({
        bundleDirectory: args["--bundle"],
        expectedManifestSha256: args["--manifest-sha256"],
        evidenceDirectory: args["--evidence-directory"],
      });
      process.stdout.write(`${canonical(result)}`);
    } else {
      fail("Usage: --mode install|rollback|recover --bundle <exact-bundle> --manifest-sha256 <sha> [--preflight-evidence <json> --preflight-sha256 <sha> --attempt-id <32-hex> | --evidence-directory <path>]");
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

export {
  INSTALL_CONFIRMATION, LOCK_CONFIRMATION, RECOVERY_CONFIRMATION, ROLLBACK_CONFIRMATION,
};
