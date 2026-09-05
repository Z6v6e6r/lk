#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { canonicalJson, sha256 } from "./lib/vivaGameProjectionCutoverContract.mjs";
import { isAuthorizedFenceGuardianRelease } from "./lib/vivaGameProjectionFenceGuardian.mjs";

const fail = (message) => { throw new Error(message); };
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (!key?.startsWith("--") || !value || value.startsWith("--") || args.has(key)) fail("Invalid guardian argument");
  args.set(key, value);
}

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
  const startTicks = tail[19];
  if (!/^\d+$/.test(String(startTicks || ""))) fail("Unable to read guardian process start identity");
  return `${pid}:${startTicks}`;
};

if (process.getuid?.() !== 0) fail("Fence guardian requires root");
const fd = Number(process.env.PADLHUB_CUTOVER_FENCE_FD);
const lockPath = String(process.env.PADLHUB_CUTOVER_FENCE_LOCK_PATH || "");
const token = String(process.env.PADLHUB_CUTOVER_FENCE_TOKEN || "");
const receiptPath = path.resolve(args.get("--receipt") || "");
const releasePath = path.resolve(args.get("--release-request") || "");
const heartbeatPath = path.resolve(args.get("--heartbeat") || "");
const receiptParent = path.dirname(receiptPath);
const parentStat = fs.lstatSync(receiptParent);
if (!Number.isSafeInteger(fd) || fd < 3 || lockPath !== "/run/lock/padlhub-viva-game-projection-cutover.lock"
  || token.length < 32 || !path.isAbsolute(receiptPath) || !path.isAbsolute(releasePath) || !path.isAbsolute(heartbeatPath)
  || path.dirname(releasePath) !== receiptParent || path.dirname(heartbeatPath) !== receiptParent
  || !parentStat.isDirectory() || parentStat.isSymbolicLink()
  || fs.realpathSync(receiptParent) !== receiptParent || parentStat.uid !== process.getuid() || (parentStat.mode & 0o077) !== 0
  || fs.existsSync(receiptPath) || fs.existsSync(heartbeatPath)
  || new Set([receiptPath, releasePath, heartbeatPath]).size !== 3) fail("Fence guardian inputs are invalid");
const stat = fs.fstatSync(fd);
const lockStat = fs.statSync(lockPath);
if (!stat.isFile() || stat.dev !== lockStat.dev || stat.ino !== lockStat.ino) fail("Fence guardian did not inherit the canonical lock descriptor");
const probe = spawnSync("flock", ["-n", lockPath, "-c", "true"], { stdio: "ignore" });
if (probe.error || probe.status === 0) fail("Fence guardian did not inherit an exclusive lock");

const tokenSha256 = sha256(token);
const processStartIdentity = linuxProcessStartIdentity(process.pid);
const receipt = {
  formatVersion: 1,
  kind: "viva-game-projection-fence-guardian-receipt",
  state: "HOLDING_UNTIL_EXPLICIT_RELEASE",
  pid: process.pid,
  fd,
  processStartIdentity,
  lockPath,
  lockDevice: String(lockStat.dev),
  lockInode: String(lockStat.ino),
  heartbeatPath,
  fenceTokenSha256: tokenSha256,
  startedAt: new Date().toISOString(),
  automaticRelease: false,
};
const descriptor = fs.openSync(receiptPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
try {
  fs.writeFileSync(descriptor, canonicalJson(receipt));
  fs.fsyncSync(descriptor);
} finally { fs.closeSync(descriptor); }
syncDirectory(receiptParent);

process.on("SIGHUP", () => {});
process.on("SIGINT", () => {});
process.on("SIGTERM", () => {});

let heartbeatSequence = 0;
let lastRejectedReleaseRequestSha256 = null;
const writeHeartbeat = () => {
  atomicPrivateWrite(heartbeatPath, {
    formatVersion: 1,
    kind: "viva-game-projection-fence-guardian-heartbeat",
    state: "HOLDING",
    pid: process.pid,
    fd,
    processStartIdentity,
    lockPath,
    lockDevice: String(lockStat.dev),
    lockInode: String(lockStat.ino),
    fenceTokenSha256: tokenSha256,
    sequence: heartbeatSequence,
    observedAt: new Date().toISOString(),
    lastRejectedReleaseRequestSha256,
  });
  heartbeatSequence += 1;
};
const quarantineReleaseRequest = (reason) => {
  let digest;
  try { digest = sha256(fs.readFileSync(releasePath)); } catch { digest = sha256(reason); }
  const quarantinePath = `${releasePath}.rejected-${Date.now()}-${digest.slice(0, 16)}`;
  try {
    fs.renameSync(releasePath, quarantinePath);
    syncDirectory(receiptParent);
  } catch { /* retain the lock and retry quarantine on the next loop */ }
  lastRejectedReleaseRequestSha256 = digest;
};

while (true) {
  const currentFd = fs.fstatSync(fd);
  const currentLock = fs.statSync(lockPath);
  if (currentFd.dev !== currentLock.dev || currentFd.ino !== currentLock.ino
    || String(currentFd.dev) !== receipt.lockDevice || String(currentFd.ino) !== receipt.lockInode) {
    fail("Fence guardian lost the canonical lock inode");
  }
  if (fs.existsSync(releasePath)) {
    let release = null;
    let validPrivateFile = false;
    try {
      const releaseStat = fs.lstatSync(releasePath);
      validPrivateFile = releaseStat.isFile() && !releaseStat.isSymbolicLink() && releaseStat.nlink === 1
        && releaseStat.uid === process.getuid() && (releaseStat.mode & 0o077) === 0 && releaseStat.size <= 64 * 1024;
      if (validPrivateFile) release = JSON.parse(fs.readFileSync(releasePath, "utf8"));
    } catch { /* malformed requests are quarantined while the lock remains held */ }
    const nowMs = Date.now();
    const authorized = isAuthorizedFenceGuardianRelease({ release, validPrivateFile, fenceTokenSha256: tokenSha256, nowMs });
    if (authorized) process.exit(0);
    quarantineReleaseRequest("Fence release request is invalid");
  }
  writeHeartbeat();
  await sleep(1000);
}
