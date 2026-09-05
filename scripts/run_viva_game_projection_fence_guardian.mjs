#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

import { canonicalJson, sha256 } from "./lib/vivaGameProjectionCutoverContract.mjs";
import {
  isAuthorizedFenceGuardianRecovery,
  isAuthorizedFenceGuardianReadyFinalization,
  isAuthorizedFenceGuardianRelease,
  isAuthorizedRecoveryFenceTakeoverRelease,
} from "./lib/vivaGameProjectionFenceGuardian.mjs";

const fail = (message) => { throw new Error(message); };
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
if (process.argv.slice(2).includes("--help")) {
  process.stdout.write("Usage: node scripts/run_viva_game_projection_fence_guardian.mjs --receipt /private/guardian.json --release-request /private/release-request.json --recovery-request /private/recovery-request.json --ready-request /private/ready-request.json --heartbeat /private/guardian-heartbeat.json\n");
  process.exit(0);
}
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
const recoveryRequestPath = path.resolve(args.get("--recovery-request") || "");
const readyRequestPath = path.resolve(args.get("--ready-request") || "");
const heartbeatPath = path.resolve(args.get("--heartbeat") || "");
const recoveryExecutorPath = fs.realpathSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "recover_viva_game_projection_mongo_write_barrier.mjs"));
const readyFinalizerPath = fs.realpathSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "finalize_viva_game_projection_cutover_ready.mjs"));
const receiptParent = path.dirname(receiptPath);
const parentStat = fs.lstatSync(receiptParent);
if (!Number.isSafeInteger(fd) || fd < 3 || lockPath !== "/run/lock/padlhub-viva-game-projection-cutover.lock"
  || token.length < 32 || !path.isAbsolute(receiptPath) || !path.isAbsolute(releasePath)
  || !path.isAbsolute(recoveryRequestPath) || !path.isAbsolute(readyRequestPath) || !path.isAbsolute(heartbeatPath)
  || path.dirname(releasePath) !== receiptParent || path.dirname(recoveryRequestPath) !== receiptParent
  || path.dirname(readyRequestPath) !== receiptParent
  || path.dirname(heartbeatPath) !== receiptParent
  || !parentStat.isDirectory() || parentStat.isSymbolicLink()
  || fs.realpathSync(receiptParent) !== receiptParent || parentStat.uid !== process.getuid() || (parentStat.mode & 0o077) !== 0
  || fs.existsSync(receiptPath) || fs.existsSync(heartbeatPath) || fs.existsSync(recoveryRequestPath)
  || fs.existsSync(readyRequestPath)
  || new Set([receiptPath, releasePath, recoveryRequestPath, readyRequestPath, heartbeatPath]).size !== 5) fail("Fence guardian inputs are invalid");
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
  releaseRequestPath: releasePath,
  recoveryRequestPath,
  readyRequestPath,
  recoveryExecutorPath,
  recoveryExecutorSha256: sha256(fs.readFileSync(recoveryExecutorPath)),
  readyFinalizerPath,
  readyFinalizerSha256: sha256(fs.readFileSync(readyFinalizerPath)),
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
let lastRejectedRecoveryRequestSha256 = null;
let lastRejectedReadyRequestSha256 = null;
let recoveryChild = null;
let recoveryRequestId = null;
let lastRecoveryResult = null;
let readyChild = null;
let readyRequestId = null;
let lastReadyResult = null;
let recoveryReleaseDelegated = false;
let delegatedRecovery = null;
let recoveryTerminalGuardianFallback = null;
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
    lastRejectedRecoveryRequestSha256,
    lastRejectedReadyRequestSha256,
    recoveryChildPid: recoveryChild?.pid || null,
    recoveryRequestId: recoveryRequestId || delegatedRecovery?.requestId || null,
    lastRecoveryResult,
    readyChildPid: readyChild?.pid || null,
    readyRequestId,
    lastReadyResult,
    recoveryReleaseDelegated,
    recoveryTerminalGuardianFallback,
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
const quarantineRecoveryRequest = (reason) => {
  let digest;
  try { digest = sha256(fs.readFileSync(recoveryRequestPath)); } catch { digest = sha256(reason); }
  const quarantinePath = `${recoveryRequestPath}.rejected-${Date.now()}-${digest.slice(0, 16)}`;
  try {
    fs.renameSync(recoveryRequestPath, quarantinePath);
    syncDirectory(receiptParent);
  } catch { /* retain the lock and retry quarantine on the next loop */ }
  lastRejectedRecoveryRequestSha256 = digest;
};
const quarantineReadyRequest = (reason) => {
  let digest;
  try { digest = sha256(fs.readFileSync(readyRequestPath)); } catch { digest = sha256(reason); }
  const quarantinePath = `${readyRequestPath}.rejected-${Date.now()}-${digest.slice(0, 16)}`;
  try {
    fs.renameSync(readyRequestPath, quarantinePath);
    syncDirectory(receiptParent);
  } catch { /* retain the lock and retry quarantine on the next loop */ }
  lastRejectedReadyRequestSha256 = digest;
};
const waitForAcceptedHandshake = (
  child, handshakeFd, childKind, requestId, onRecoveryTakeoverEstablished = null,
) => new Promise((resolve, reject) => {
  const stream = child.stdio[handshakeFd];
  let buffer = "";
  let inherited = false;
  let takeoverEstablished = childKind !== "recovery";
  let settled = false;
  const timeout = setTimeout(() => finish(new Error("Fence child acceptance handshake timed out")), 15_000);
  const cleanup = () => {
    clearTimeout(timeout);
    stream?.removeListener("data", onData);
    child.removeListener("error", onError);
    child.removeListener("close", onClose);
  };
  const finish = (error) => {
    if (settled) return;
    settled = true;
    cleanup();
    if (error) reject(error); else resolve();
  };
  const onError = (error) => finish(error);
  const onClose = () => finish(new Error("Fence child exited before accepting its request"));
  const onData = (chunk) => {
    buffer += chunk.toString("utf8");
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n");
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      let event;
      try { event = JSON.parse(line); } catch { finish(new Error("Fence child handshake is invalid")); return; }
      if (event?.childKind !== childKind || event?.requestId !== requestId) {
        finish(new Error("Fence child handshake identity mismatch")); return;
      }
      if (!takeoverEstablished && event.state === "TAKEOVER_ESTABLISHED") {
        try { onRecoveryTakeoverEstablished?.(event); } catch (error) { finish(error); return; }
        takeoverEstablished = true;
      } else if (takeoverEstablished && !inherited && event.state === "FENCE_INHERITED") inherited = true;
      else if (inherited && event.state === "REQUEST_ACCEPTED") { finish(); return; }
      else { finish(new Error("Fence child handshake sequence mismatch")); return; }
    }
  };
  stream?.on("data", onData);
  child.once("error", onError);
  child.once("close", onClose);
});
const startRecovery = async (request) => {
  const acceptedPath = `${recoveryRequestPath}.accepted-${request.requestId}`;
  const reportPath = request.argv[request.argv.indexOf("--report") + 1];
  recoveryReleaseDelegated = true;
  delegatedRecovery = { requestId: request.requestId, reportPath };
  const handshakeFd = fd + 1;
  const childStdio = Array.from({ length: handshakeFd + 1 }, (_, index) => (index === 0 ? "ignore" : (index < 3 ? "inherit" : "ignore")));
  childStdio[fd] = fd;
  childStdio[handshakeFd] = "pipe";
  const child = spawn(process.execPath, [recoveryExecutorPath, ...request.argv], {
    stdio: childStdio,
    env: {
      ...process.env,
      PADLHUB_CUTOVER_GUARDIAN_CHILD: "1",
      PADLHUB_CUTOVER_GUARDIAN_RECOVERY_REQUEST_ID: request.requestId,
      PADLHUB_CUTOVER_GUARDIAN_HANDSHAKE_FD: String(handshakeFd),
      PADLHUB_CUTOVER_GUARDIAN_CHILD_REQUEST_PATH: recoveryRequestPath,
      PADLHUB_CUTOVER_GUARDIAN_CHILD_ACCEPTED_PATH: acceptedPath,
      PADLHUB_CUTOVER_GUARDIAN_CHILD_REQUEST_SHA256: sha256(canonicalJson(request)),
    },
  });
  recoveryChild = child;
  recoveryRequestId = request.requestId;
  lastRecoveryResult = null;
  child.once("error", (error) => {
    lastRecoveryResult = { requestId: request.requestId, exitCode: null, signal: null, errorSha256: sha256(String(error?.message || error)) };
    recoveryChild = null;
    recoveryRequestId = null;
  });
  child.once("close", (exitCode, signal) => {
    lastRecoveryResult = { requestId: request.requestId, exitCode, signal: signal || null, completedAt: new Date().toISOString() };
    recoveryChild = null;
    recoveryRequestId = null;
  });
  try {
    await waitForAcceptedHandshake(
      child, handshakeFd, "recovery", request.requestId,
      (event) => markRecoveryTakeoverEstablished(request, event),
    );
  } catch (error) {
    try { child.kill("SIGKILL"); } catch { /* child already exited */ }
    if (recoveryTakeoverArtifactsExist(request.requestId) || fs.existsSync(acceptedPath)) {
      try { markRecoveryTakeoverEstablished(request); } catch {
        // Any exact-path takeover artifact makes release ambiguous. Keep the guardian fail-closed.
      }
    }
    if (fs.existsSync(recoveryRequestPath)) quarantineRecoveryRequest(String(error?.message || error));
  }
};
const startReadyFinalization = async (request) => {
  const acceptedPath = `${readyRequestPath}.accepted-${request.requestId}`;
  const handshakeFd = fd + 1;
  const childStdio = Array(handshakeFd + 1).fill("ignore");
  childStdio[1] = "inherit";
  childStdio[2] = "inherit";
  childStdio[fd] = fd;
  childStdio[handshakeFd] = "pipe";
  const child = spawn(process.execPath, [readyFinalizerPath, ...request.argv], {
    stdio: childStdio,
    env: {
      ...process.env,
      PADLHUB_CUTOVER_GUARDIAN_READY_CHILD: "1",
      PADLHUB_CUTOVER_GUARDIAN_READY_REQUEST_ID: request.requestId,
      PADLHUB_CUTOVER_GUARDIAN_HANDSHAKE_FD: String(handshakeFd),
      PADLHUB_CUTOVER_GUARDIAN_CHILD_REQUEST_PATH: readyRequestPath,
      PADLHUB_CUTOVER_GUARDIAN_CHILD_ACCEPTED_PATH: acceptedPath,
      PADLHUB_CUTOVER_GUARDIAN_CHILD_REQUEST_SHA256: sha256(canonicalJson(request)),
    },
  });
  readyChild = child;
  readyRequestId = request.requestId;
  lastReadyResult = null;
  child.once("error", (error) => {
    lastReadyResult = { requestId: request.requestId, exitCode: null, signal: null, errorSha256: sha256(String(error?.message || error)) };
    readyChild = null;
    readyRequestId = null;
  });
  child.once("close", (exitCode, signal) => {
    lastReadyResult = { requestId: request.requestId, exitCode, signal: signal || null, completedAt: new Date().toISOString() };
    readyChild = null;
    readyRequestId = null;
  });
  try {
    await waitForAcceptedHandshake(child, handshakeFd, "ready", request.requestId);
  } catch (error) {
    try { child.kill("SIGKILL"); } catch { /* child already exited */ }
    if (fs.existsSync(readyRequestPath)) quarantineReadyRequest(String(error?.message || error));
  }
};

const readPrivateJson = (filePath, label, maximumBytes = 16 * 1024 * 1024) => {
  const fileStat = fs.lstatSync(filePath);
  if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.nlink !== 1
    || fileStat.uid !== process.getuid() || (fileStat.mode & 0o077) !== 0 || fileStat.size > maximumBytes) {
    fail(`${label} is not private`);
  }
  const bytes = fs.readFileSync(filePath);
  return { bytes, value: JSON.parse(bytes.toString("utf8")) };
};

const recoveryTakeoverPaths = (requestId) => {
  const prefix = path.join(receiptParent, `.viva-recovery-fence-takeover-${requestId}`);
  return { receiptPath: `${prefix}.json`, heartbeatPath: `${prefix}.heartbeat.json` };
};
const recoveryTakeoverArtifactsExist = (requestId) => {
  const paths = recoveryTakeoverPaths(requestId);
  return fs.existsSync(paths.receiptPath) || fs.existsSync(paths.heartbeatPath);
};
const markRecoveryTakeoverEstablished = (request, event = null) => {
  const reportIndex = request.argv.indexOf("--report");
  const reportPath = request.argv[reportIndex + 1];
  const paths = recoveryTakeoverPaths(request.requestId);
  recoveryReleaseDelegated = true;
  delegatedRecovery = { requestId: request.requestId, reportPath };
  const takeoverRead = readPrivateJson(paths.receiptPath, "Recovery takeover receipt", 1024 * 1024);
  const takeover = takeoverRead.value;
  const takeoverReceiptSha256 = sha256(takeoverRead.bytes);
  if (reportIndex < 0 || !path.isAbsolute(String(reportPath || ""))
    || event && (event.receiptPath !== paths.receiptPath || event.receiptSha256 !== takeoverReceiptSha256)
    || takeover?.formatVersion !== 1
    || takeover?.kind !== "viva-game-projection-recovery-fence-takeover-receipt"
    || takeover?.state !== "HOLDING_UNTIL_EXPLICIT_RELEASE"
    || takeover?.custodyState !== "TAKEOVER_ESTABLISHED"
    || takeover?.parentGuardianReceiptSha256 !== sha256(canonicalJson(receipt))
    || takeover?.parentGuardianPid !== process.pid
    || takeover?.parentGuardianProcessStartIdentity !== processStartIdentity
    || takeover?.recoveryRequestId !== request.requestId
    || takeover?.fenceTokenSha256 !== tokenSha256
    || takeover?.lockPath !== lockPath || takeover?.lockDevice !== String(lockStat.dev)
    || takeover?.lockInode !== String(lockStat.ino) || takeover?.heartbeatPath !== paths.heartbeatPath
    || takeover?.releaseRequestPath !== releasePath || takeover?.recoveryReportPath !== reportPath
    || takeover?.automaticRelease !== false || !Number.isSafeInteger(takeover?.pid) || takeover.pid < 1
    || !Number.isSafeInteger(takeover?.fd) || takeover.fd < 3
    || !/^\d+:\d+$/.test(String(takeover?.processStartIdentity || ""))) {
    fail("Recovery takeover cannot establish guardian delegation");
  }
};

const readTerminalRecoveryTakeoverEvidence = () => {
  if (!delegatedRecovery || recoveryChild || lastRecoveryResult?.requestId !== delegatedRecovery.requestId
    || lastRecoveryResult?.exitCode !== 0) fail("Recovery takeover handoff is not terminal");
  const { receiptPath: takeoverReceiptPath, heartbeatPath: takeoverHeartbeatPath } = recoveryTakeoverPaths(
    delegatedRecovery.requestId,
  );
  const takeoverRead = readPrivateJson(takeoverReceiptPath, "Recovery takeover receipt", 1024 * 1024);
  const takeover = takeoverRead.value;
  if (takeover?.formatVersion !== 1
    || takeover?.kind !== "viva-game-projection-recovery-fence-takeover-receipt"
    || takeover?.state !== "HOLDING_UNTIL_EXPLICIT_RELEASE"
    || takeover?.custodyState !== "TAKEOVER_ESTABLISHED"
    || takeover?.parentGuardianReceiptSha256 !== sha256(canonicalJson(receipt))
    || takeover?.parentGuardianPid !== process.pid
    || takeover?.parentGuardianProcessStartIdentity !== processStartIdentity
    || takeover?.recoveryRequestId !== delegatedRecovery.requestId
    || takeover?.fenceTokenSha256 !== tokenSha256
    || takeover?.lockPath !== lockPath || takeover?.lockDevice !== String(lockStat.dev)
    || takeover?.lockInode !== String(lockStat.ino)
    || takeover?.heartbeatPath !== takeoverHeartbeatPath
    || takeover?.releaseRequestPath !== releasePath
    || takeover?.recoveryReportPath !== delegatedRecovery.reportPath
    || takeover?.automaticRelease !== false || !Number.isSafeInteger(takeover?.pid) || takeover.pid < 1
    || !Number.isSafeInteger(takeover?.fd) || takeover.fd < 3) {
    fail("Recovery takeover cannot receive guardian custody");
  }
  const reportRead = readPrivateJson(delegatedRecovery.reportPath, "Mongo barrier recovery report");
  const report = reportRead.value;
  if (report?.formatVersion !== 1
    || report?.kind !== "viva-game-projection-mongo-write-barrier-recovery-receipt"
    || report?.state !== "RELEASED_TO_EXACT_PREIMAGE"
    || report?.guardianRecoveryRequestId !== delegatedRecovery.requestId
    || report?.recoveryFenceTakeoverState !== "HELD_UNTIL_EXPLICIT_FENCE_RELEASE"
    || report?.recoveryFenceTakeoverReceiptPath !== takeoverReceiptPath
    || report?.recoveryFenceTakeoverReceiptSha256 !== sha256(takeoverRead.bytes)
    || report?.recoveryJournalPath !== `${delegatedRecovery.reportPath}.journal`) {
    fail("Recovery report cannot authorize guardian handoff");
  }
  const journalStat = fs.lstatSync(report.recoveryJournalPath);
  if (!journalStat.isDirectory() || journalStat.isSymbolicLink() || journalStat.uid !== process.getuid()
    || (journalStat.mode & 0o077) !== 0 || fs.realpathSync(report.recoveryJournalPath) !== report.recoveryJournalPath) {
    fail("Recovery terminal journal cannot authorize guardian handoff");
  }
  const terminalNames = fs.readdirSync(report.recoveryJournalPath).filter((name) => !name.startsWith(".")).sort();
  const terminalRead = readPrivateJson(
    path.join(report.recoveryJournalPath, terminalNames.at(-1) || ""), "Recovery terminal journal", 16 * 1024 * 1024,
  );
  if (terminalRead.value?.phase !== "TERMINAL_RESULT"
    || terminalRead.value?.attemptId !== report.recoveryAttemptId
    || terminalRead.value?.reportSha256 !== sha256(reportRead.bytes)
    || canonicalJson(terminalRead.value?.report) !== canonicalJson(report)) {
    fail("Recovery terminal journal does not authorize guardian handoff");
  }
  return {
    takeover,
    takeoverRead,
    takeoverReceiptPath,
    takeoverHeartbeatPath,
    reportRead,
    terminalRead,
  };
};

const assertSuccessfulRecoveryTakeoverHandoff = () => {
  const evidence = readTerminalRecoveryTakeoverEvidence();
  const { takeover, takeoverHeartbeatPath } = evidence;
  process.kill(takeover.pid, 0);
  if (linuxProcessStartIdentity(takeover.pid) !== takeover.processStartIdentity) {
    fail("Recovery takeover PID changed before guardian handoff");
  }
  const takeoverDescriptor = fs.statSync(`/proc/${takeover.pid}/fd/${takeover.fd}`);
  if (takeoverDescriptor.dev !== lockStat.dev || takeoverDescriptor.ino !== lockStat.ino) {
    fail("Recovery takeover does not hold the guardian lock inode");
  }
  const heartbeatRead = readPrivateJson(takeoverHeartbeatPath, "Recovery takeover heartbeat", 1024 * 1024);
  const heartbeat = heartbeatRead.value;
  const heartbeatAt = Date.parse(heartbeat?.observedAt);
  if (heartbeat?.formatVersion !== 1
    || heartbeat?.kind !== "viva-game-projection-recovery-fence-takeover-heartbeat"
    || heartbeat?.state !== "HOLDING" || heartbeat?.pid !== takeover.pid || heartbeat?.fd !== takeover.fd
    || heartbeat?.processStartIdentity !== takeover.processStartIdentity
    || heartbeat?.lockPath !== lockPath || heartbeat?.lockDevice !== String(lockStat.dev)
    || heartbeat?.lockInode !== String(lockStat.ino) || heartbeat?.fenceTokenSha256 !== tokenSha256
    || heartbeat?.parentGuardianReceiptSha256 !== takeover.parentGuardianReceiptSha256
    || heartbeat?.parentGuardianPid !== process.pid
    || heartbeat?.parentGuardianProcessStartIdentity !== processStartIdentity
    || heartbeat?.recoveryRequestId !== delegatedRecovery.requestId
    || !Number.isFinite(heartbeatAt) || heartbeatAt > Date.now() + 1_000 || Date.now() - heartbeatAt > 5_000) {
    fail("Recovery takeover heartbeat cannot receive guardian custody");
  }
  return { takeoverReceiptSha256: sha256(evidence.takeoverRead.bytes), takeoverHeartbeatSha256: sha256(heartbeatRead.bytes) };
};

const assertRecoveryTakeoverPositivelyDead = (takeover) => {
  try {
    process.kill(takeover.pid, 0);
  } catch (error) {
    if (error?.code === "ESRCH") return;
    throw error;
  }
  let currentIdentity;
  try {
    currentIdentity = linuxProcessStartIdentity(takeover.pid);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (currentIdentity === takeover.processStartIdentity) {
    fail("Recovery takeover remains alive before guardian fallback");
  }
  try {
    const reusedDescriptor = fs.statSync(`/proc/${takeover.pid}/fd/${takeover.fd}`);
    if (reusedDescriptor.dev === lockStat.dev && reusedDescriptor.ino === lockStat.ino) {
      fail("Reused recovery takeover PID still references the canonical lock inode");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
};

const assertTerminalGuardianFallbackCustody = () => {
  const evidence = readTerminalRecoveryTakeoverEvidence();
  assertRecoveryTakeoverPositivelyDead(evidence.takeover);
  return evidence;
};

const establishTerminalGuardianFallbackCustody = () => {
  const evidence = assertTerminalGuardianFallbackCustody();
  const fallback = {
    state: "HOLDING_TERMINAL_RECOVERY_FALLBACK",
    recoveryRequestId: delegatedRecovery.requestId,
    recoveryReportPath: delegatedRecovery.reportPath,
    recoveryReportSha256: sha256(evidence.reportRead.bytes),
    recoveryTerminalJournalSha256: sha256(evidence.terminalRead.bytes),
    recoveryFenceTakeoverReceiptSha256: sha256(evidence.takeoverRead.bytes),
  };
  if (recoveryTerminalGuardianFallback
    && canonicalJson(recoveryTerminalGuardianFallback) !== canonicalJson(fallback)) {
    fail("Recovery terminal guardian fallback custody changed");
  }
  recoveryTerminalGuardianFallback = fallback;
  return evidence;
};

while (true) {
  const currentFd = fs.fstatSync(fd);
  const currentLock = fs.statSync(lockPath);
  if (currentFd.dev !== currentLock.dev || currentFd.ino !== currentLock.ino
    || String(currentFd.dev) !== receipt.lockDevice || String(currentFd.ino) !== receipt.lockInode) {
    fail("Fence guardian lost the canonical lock inode");
  }
  if (recoveryReleaseDelegated && lastRecoveryResult?.exitCode === 0 && !recoveryChild) {
    try {
      assertSuccessfulRecoveryTakeoverHandoff();
      process.exit(0);
    } catch (error) {
      lastRecoveryResult = {
        ...lastRecoveryResult,
        handoffErrorSha256: sha256(String(error?.message || error)),
      };
      try { establishTerminalGuardianFallbackCustody(); } catch {
        recoveryTerminalGuardianFallback = null;
      }
    }
  }
  if (fs.existsSync(recoveryRequestPath)) {
    let request = null;
    let validPrivateFile = false;
    try {
      const requestStat = fs.lstatSync(recoveryRequestPath);
      validPrivateFile = requestStat.isFile() && !requestStat.isSymbolicLink() && requestStat.nlink === 1
        && requestStat.uid === process.getuid() && (requestStat.mode & 0o077) === 0 && requestStat.size <= 64 * 1024;
      if (validPrivateFile) request = JSON.parse(fs.readFileSync(recoveryRequestPath, "utf8"));
    } catch { /* malformed requests are quarantined while the lock remains held */ }
    const authorized = !recoveryTerminalGuardianFallback && !recoveryChild && !readyChild
      && (!recoveryReleaseDelegated || request?.requestId === delegatedRecovery?.requestId)
      && isAuthorizedFenceGuardianRecovery({
      request,
      validPrivateFile,
      fenceTokenSha256: tokenSha256,
      guardianPid: process.pid,
      processStartIdentity,
      nowMs: Date.now(),
    });
    if (authorized) {
      try { await startRecovery(request); } catch (error) {
        lastRecoveryResult = {
          requestId: request.requestId, exitCode: null, signal: null,
          errorSha256: sha256(String(error?.message || error)),
        };
        if (fs.existsSync(recoveryRequestPath)) quarantineRecoveryRequest(String(error?.message || error));
      }
    } else quarantineRecoveryRequest(recoveryChild || readyChild ? "Fence child operation already running" : "Fence recovery request is invalid");
  }
  if (fs.existsSync(readyRequestPath)) {
    let request = null;
    let validPrivateFile = false;
    try {
      const requestStat = fs.lstatSync(readyRequestPath);
      validPrivateFile = requestStat.isFile() && !requestStat.isSymbolicLink() && requestStat.nlink === 1
        && requestStat.uid === process.getuid() && (requestStat.mode & 0o077) === 0 && requestStat.size <= 64 * 1024;
      if (validPrivateFile) request = JSON.parse(fs.readFileSync(readyRequestPath, "utf8"));
    } catch { /* malformed requests are quarantined while the lock remains held */ }
    const authorized = !recoveryReleaseDelegated && !recoveryChild && !readyChild
      && isAuthorizedFenceGuardianReadyFinalization({
      request,
      validPrivateFile,
      fenceTokenSha256: tokenSha256,
      guardianPid: process.pid,
      processStartIdentity,
      nowMs: Date.now(),
    });
    if (authorized) {
      try { await startReadyFinalization(request); } catch (error) {
        lastReadyResult = {
          requestId: request.requestId, exitCode: null, signal: null,
          errorSha256: sha256(String(error?.message || error)),
        };
        if (fs.existsSync(readyRequestPath)) quarantineReadyRequest(String(error?.message || error));
      }
    } else quarantineReadyRequest(recoveryChild || readyChild ? "Fence child operation already running" : "Fence READY request is invalid");
  }
  if (fs.existsSync(releasePath)) {
    if (recoveryReleaseDelegated) {
      if (!recoveryTerminalGuardianFallback) {
        writeHeartbeat();
        await sleep(1000);
        continue;
      }
      let release = null;
      let validPrivateFile = false;
      try {
        const releaseStat = fs.lstatSync(releasePath);
        validPrivateFile = releaseStat.isFile() && !releaseStat.isSymbolicLink() && releaseStat.nlink === 1
          && releaseStat.uid === process.getuid() && (releaseStat.mode & 0o077) === 0 && releaseStat.size <= 64 * 1024;
        if (validPrivateFile) release = JSON.parse(fs.readFileSync(releasePath, "utf8"));
      } catch { /* malformed requests remain unauthorized */ }
      let evidence = null;
      try { evidence = assertTerminalGuardianFallbackCustody(); } catch { /* retain the lock fail-closed */ }
      const authorized = evidence && !recoveryChild && !readyChild
        && isAuthorizedRecoveryFenceTakeoverRelease({
          release,
          validPrivateFile,
          fenceTokenSha256: tokenSha256,
          recoveryRequestId: delegatedRecovery.requestId,
          recoveryReportPath: delegatedRecovery.reportPath,
          recoveryReport: evidence.reportRead.value,
          recoveryReportSha256: sha256(evidence.reportRead.bytes),
          recoveryTerminalJournal: evidence.terminalRead.value,
          recoveryTerminalJournalSha256: sha256(evidence.terminalRead.bytes),
          recoveryFenceTakeoverReceiptPath: evidence.takeoverReceiptPath,
          recoveryFenceTakeoverReceiptSha256: sha256(evidence.takeoverRead.bytes),
          nowMs: Date.now(),
        });
      if (authorized) process.exit(0);
      quarantineReleaseRequest("Terminal recovery guardian fallback release is invalid");
      writeHeartbeat();
      await sleep(1000);
      continue;
    }
    let release = null;
    let validPrivateFile = false;
    try {
      const releaseStat = fs.lstatSync(releasePath);
      validPrivateFile = releaseStat.isFile() && !releaseStat.isSymbolicLink() && releaseStat.nlink === 1
        && releaseStat.uid === process.getuid() && (releaseStat.mode & 0o077) === 0 && releaseStat.size <= 64 * 1024;
      if (validPrivateFile) release = JSON.parse(fs.readFileSync(releasePath, "utf8"));
    } catch { /* malformed requests are quarantined while the lock remains held */ }
    const nowMs = Date.now();
    const authorized = !recoveryChild && !readyChild
      && isAuthorizedFenceGuardianRelease({ release, validPrivateFile, fenceTokenSha256: tokenSha256, nowMs });
    if (authorized) process.exit(0);
    quarantineReleaseRequest("Fence release request is invalid");
  }
  writeHeartbeat();
  await sleep(1000);
}
