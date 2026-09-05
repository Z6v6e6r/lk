#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { canonicalJson, sha256 } from "./lib/vivaGameProjectionCutoverContract.mjs";
import { isAuthorizedRecoveryFenceTakeoverRelease } from "./lib/vivaGameProjectionFenceGuardian.mjs";

const fail = (message) => { throw new Error(message); };
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
if (process.argv.slice(2).includes("--help")) {
  process.stdout.write("Usage: node scripts/run_viva_game_projection_recovery_fence_takeover.mjs --receipt /private/takeover.json --heartbeat /private/takeover-heartbeat.json --release-request /private/release-request.json --recovery-report /private/recovery-report.json --parent-guardian-receipt-sha256 SHA256 --recovery-request-id UUID\n");
  process.exit(0);
}

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (!key?.startsWith("--") || !value || value.startsWith("--") || args.has(key)) fail("Invalid takeover argument");
  args.set(key, value);
}
const HASH_RE = /^[a-f0-9]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const syncDirectory = (directory) => {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
};
const atomicPrivateWrite = (filePath, value) => {
  const temporary = `${filePath}.tmp-${process.pid}`;
  const descriptor = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  try {
    fs.writeFileSync(descriptor, canonicalJson(value));
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, filePath);
  syncDirectory(path.dirname(filePath));
};
const linuxProcessStartIdentity = (pid) => {
  const body = fs.readFileSync(`/proc/${pid}/stat`, "utf8").trim();
  const tail = body.slice(body.lastIndexOf(")") + 2).split(/\s+/);
  if (!/^\d+$/.test(String(tail[19] || ""))) fail("Unable to read takeover process start identity");
  return `${pid}:${tail[19]}`;
};

if (process.getuid?.() !== 0 || process.platform !== "linux") fail("Recovery fence takeover requires Linux root");
const fd = Number(process.env.PADLHUB_CUTOVER_FENCE_FD);
const lockPath = String(process.env.PADLHUB_CUTOVER_FENCE_LOCK_PATH || "");
const token = String(process.env.PADLHUB_CUTOVER_FENCE_TOKEN || "");
const receiptPath = path.resolve(args.get("--receipt") || "");
const heartbeatPath = path.resolve(args.get("--heartbeat") || "");
const releasePath = path.resolve(args.get("--release-request") || "");
const recoveryReportPath = path.resolve(args.get("--recovery-report") || "");
const parentGuardianReceiptSha256 = String(args.get("--parent-guardian-receipt-sha256") || "");
const recoveryRequestId = String(args.get("--recovery-request-id") || "");
const parent = path.dirname(receiptPath);
const parentStat = fs.lstatSync(parent);
if (!Number.isSafeInteger(fd) || fd < 3 || lockPath !== "/run/lock/padlhub-viva-game-projection-cutover.lock"
  || token.length < 32 || !HASH_RE.test(parentGuardianReceiptSha256) || !UUID_RE.test(recoveryRequestId)
  || !path.isAbsolute(receiptPath) || !path.isAbsolute(heartbeatPath) || !path.isAbsolute(releasePath)
  || !path.isAbsolute(recoveryReportPath)
  || path.dirname(heartbeatPath) !== parent || path.dirname(releasePath) !== parent
  || new Set([receiptPath, heartbeatPath, releasePath, recoveryReportPath]).size !== 4
  || !parentStat.isDirectory() || parentStat.isSymbolicLink() || fs.realpathSync(parent) !== parent
  || parentStat.uid !== process.getuid() || (parentStat.mode & 0o077) !== 0
  || fs.existsSync(receiptPath) || fs.existsSync(heartbeatPath)) fail("Recovery fence takeover inputs are invalid");
const descriptorStat = fs.fstatSync(fd);
const lockStat = fs.statSync(lockPath);
if (!descriptorStat.isFile() || descriptorStat.dev !== lockStat.dev || descriptorStat.ino !== lockStat.ino) {
  fail("Recovery fence takeover did not inherit the canonical lock descriptor");
}
const probe = spawnSync("flock", ["-n", lockPath, "-c", "true"], { stdio: "ignore" });
if (probe.error || probe.status === 0) fail("Recovery fence takeover did not inherit an exclusive lock");

const processStartIdentity = linuxProcessStartIdentity(process.pid);
const tokenSha256 = sha256(token);
const receipt = {
  formatVersion: 1,
  kind: "viva-game-projection-recovery-fence-takeover-receipt",
  state: "HOLDING_UNTIL_EXPLICIT_RELEASE",
  pid: process.pid,
  fd,
  processStartIdentity,
  lockPath,
  lockDevice: String(lockStat.dev),
  lockInode: String(lockStat.ino),
  heartbeatPath,
  releaseRequestPath: releasePath,
  recoveryReportPath,
  parentGuardianReceiptSha256,
  recoveryRequestId,
  fenceTokenSha256: tokenSha256,
  startedAt: new Date().toISOString(),
  automaticRelease: false,
};
const receiptBytes = Buffer.from(canonicalJson(receipt));
const receiptDescriptor = fs.openSync(receiptPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
try {
  fs.writeFileSync(receiptDescriptor, receiptBytes);
  fs.fsyncSync(receiptDescriptor);
} finally { fs.closeSync(receiptDescriptor); }
syncDirectory(parent);

process.on("SIGHUP", () => {});
process.on("SIGINT", () => {});
process.on("SIGTERM", () => {});
let sequence = 0;
let lastRejectedReleaseRequestSha256 = null;
const readPrivateJson = (filePath, maximumBytes) => {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid()
    || (stat.mode & 0o077) !== 0 || stat.size > maximumBytes) fail("Recovery takeover evidence is not private");
  const bytes = fs.readFileSync(filePath);
  return { bytes, value: JSON.parse(bytes.toString("utf8")) };
};
const readTerminalRecovery = () => {
  const reportRead = readPrivateJson(recoveryReportPath, 16 * 1024 * 1024);
  const journalPath = `${recoveryReportPath}.journal`;
  const journalStat = fs.lstatSync(journalPath);
  if (!journalStat.isDirectory() || journalStat.isSymbolicLink() || journalStat.uid !== process.getuid()
    || (journalStat.mode & 0o077) !== 0 || fs.realpathSync(journalPath) !== path.resolve(journalPath)) {
    fail("Recovery takeover journal is not private and canonical");
  }
  const names = fs.readdirSync(journalPath).sort();
  if (names.length === 0) fail("Recovery takeover terminal journal is absent");
  const terminalRead = readPrivateJson(path.join(journalPath, names.at(-1)), 16 * 1024 * 1024);
  return { reportRead, terminalRead };
};
const quarantineReleaseRequest = (digest) => {
  const quarantinePath = `${releasePath}.rejected-takeover-${Date.now()}-${digest.slice(0, 16)}`;
  try {
    fs.renameSync(releasePath, quarantinePath);
    syncDirectory(parent);
  } catch { /* another lock custodian may already have consumed or quarantined it */ }
};
while (true) {
  const currentDescriptor = fs.fstatSync(fd);
  const currentLock = fs.statSync(lockPath);
  if (currentDescriptor.dev !== currentLock.dev || currentDescriptor.ino !== currentLock.ino
    || String(currentDescriptor.dev) !== receipt.lockDevice || String(currentDescriptor.ino) !== receipt.lockInode) {
    fail("Recovery fence takeover lost the canonical lock inode");
  }
  if (fs.existsSync(releasePath)) {
    let release;
    let validPrivateFile = false;
    try {
      const releaseStat = fs.lstatSync(releasePath);
      validPrivateFile = releaseStat.isFile() && !releaseStat.isSymbolicLink() && releaseStat.nlink === 1
        && releaseStat.uid === process.getuid() && (releaseStat.mode & 0o077) === 0 && releaseStat.size <= 64 * 1024;
      if (validPrivateFile) release = JSON.parse(fs.readFileSync(releasePath, "utf8"));
    } catch { /* keep the lock and report only the request digest */ }
    let releaseDigest = null;
    try { releaseDigest = sha256(fs.readFileSync(releasePath)); } catch { /* another custodian handled it */ }
    let terminal = null;
    try { terminal = readTerminalRecovery(); } catch { /* recovery is incomplete or unreconciled */ }
    const authorized = terminal && isAuthorizedRecoveryFenceTakeoverRelease({
      release,
      validPrivateFile,
      fenceTokenSha256: tokenSha256,
      recoveryRequestId,
      recoveryReportPath,
      recoveryReport: terminal.reportRead.value,
      recoveryReportSha256: sha256(terminal.reportRead.bytes),
      recoveryTerminalJournal: terminal.terminalRead.value,
      recoveryTerminalJournalSha256: sha256(terminal.terminalRead.bytes),
      recoveryFenceTakeoverReceiptPath: receiptPath,
      recoveryFenceTakeoverReceiptSha256: sha256(receiptBytes),
      nowMs: Date.now(),
    });
    if (authorized) process.exit(0);
    if (releaseDigest) {
      lastRejectedReleaseRequestSha256 = releaseDigest;
      quarantineReleaseRequest(releaseDigest);
    }
  }
  atomicPrivateWrite(heartbeatPath, {
    formatVersion: 1,
    kind: "viva-game-projection-recovery-fence-takeover-heartbeat",
    state: "HOLDING",
    pid: process.pid,
    fd,
    processStartIdentity,
    lockPath,
    lockDevice: receipt.lockDevice,
    lockInode: receipt.lockInode,
    fenceTokenSha256: tokenSha256,
    parentGuardianReceiptSha256,
    recoveryRequestId,
    sequence,
    observedAt: new Date().toISOString(),
    lastRejectedReleaseRequestSha256,
  });
  sequence += 1;
  await sleep(1000);
}
