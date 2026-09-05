#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { MongoClient } from "mongodb";

import { canonicalJson, sha256 } from "./lib/vivaGameProjectionCutoverContract.mjs";
import { assertExactExecutorSources } from "./lib/vivaGameProjectionExecutorSource.mjs";
import { restorePreviousMongoWriteBarrier } from "./lib/vivaGameProjectionMongoWriteBarrier.mjs";
import {
  assertLiveFenceGuardian,
  assertNoCutoverEnvironment,
  assertPm2RuntimeIdentity,
  envValue,
  readPm2,
} from "./prepare_viva_game_projection_cutover_postcheck.mjs";
import {
  assertExclusiveFenceLease,
  ensurePrivateDirectory,
  readPrivateBytes,
  readPrivateJson,
  readPrivateMongoConnection,
  validateHeldWriterFence,
} from "./run_viva_game_projection_tenant_migration.mjs";
import {
  recoverAtomicExclusivePublication,
  writeFileExclusiveAtomicDurable,
} from "./nodered_reviewed_flow_deploy/runtime_contract.mjs";
import {
  acceptFenceGuardianChildRequest,
  announceFenceGuardianRecoveryTakeoverEstablished,
  isAuthorizedFenceGuardianRecovery,
} from "./lib/vivaGameProjectionFenceGuardian.mjs";

const SCRIPT_PATH = fs.realpathSync(fileURLToPath(import.meta.url));
const TAKEOVER_SCRIPT_PATH = fs.realpathSync(path.join(
  path.dirname(SCRIPT_PATH), "run_viva_game_projection_recovery_fence_takeover.mjs",
));
const CONFIRMATION = "RECOVER_VIVA_GAME_PROJECTION_MONGO_WRITE_BARRIER_V1";
const HASH_RE = /^[a-f0-9]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = (message) => { throw new Error(message); };
const privateOptions = () => ({
  uid: typeof process.getuid === "function" ? process.getuid() : 0,
  gid: typeof process.getgid === "function" ? process.getgid() : 0,
  mode: 0o600,
});

const syncDirectory = (directory) => {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
};

const linuxProcessStartIdentity = (pid) => {
  const body = fs.readFileSync(`/proc/${pid}/stat`, "utf8").trim();
  const tail = body.slice(body.lastIndexOf(")") + 2).split(/\s+/);
  if (!/^\d+$/.test(String(tail[19] || ""))) fail("Recovery fence takeover process identity is unavailable");
  return `${pid}:${tail[19]}`;
};

const takeoverPaths = (options, requestId) => {
  const parent = path.dirname(options.fenceGuardianReceipt);
  const prefix = path.join(parent, `.viva-recovery-fence-takeover-${requestId}`);
  return { receiptPath: `${prefix}.json`, heartbeatPath: `${prefix}.heartbeat.json` };
};

const validateRecoveryFenceTakeoverReceipt = (receipt, expected) => {
  if (receipt?.formatVersion !== 1
    || receipt?.kind !== "viva-game-projection-recovery-fence-takeover-receipt"
    || receipt?.state !== "HOLDING_UNTIL_EXPLICIT_RELEASE"
    || receipt?.parentGuardianReceiptSha256 !== expected.parentGuardianReceiptSha256
    || receipt?.parentGuardianPid !== expected.parentGuardianPid
    || receipt?.parentGuardianProcessStartIdentity !== expected.parentGuardianProcessStartIdentity
    || receipt?.recoveryRequestId !== expected.recoveryRequestId
    || receipt?.fenceTokenSha256 !== expected.fenceTokenSha256
    || receipt?.lockPath !== expected.lockPath || receipt?.lockDevice !== expected.lockDevice
    || receipt?.lockInode !== expected.lockInode || receipt?.heartbeatPath !== expected.heartbeatPath
    || receipt?.releaseRequestPath !== expected.releaseRequestPath
    || receipt?.recoveryReportPath !== expected.recoveryReportPath
    || receipt?.custodyState !== "TAKEOVER_ESTABLISHED"
    || receipt?.automaticRelease !== false || !Number.isSafeInteger(receipt?.pid) || receipt.pid < 1
    || !Number.isSafeInteger(receipt?.fd) || receipt.fd < 3
    || !/^\d+:\d+$/.test(String(receipt?.processStartIdentity || ""))
    || !String(receipt.processStartIdentity).startsWith(`${receipt.pid}:`)) {
    fail("Recovery fence takeover receipt is invalid");
  }
  return receipt;
};

const recoveryFenceTakeoverIsAlive = (receipt) => {
  try {
    process.kill(receipt.pid, 0);
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
  try {
    return linuxProcessStartIdentity(receipt.pid) === receipt.processStartIdentity;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
};

const validateRecoveryFenceTakeoverHeartbeat = (heartbeat, receipt) => {
  if (heartbeat?.formatVersion !== 1
    || heartbeat?.kind !== "viva-game-projection-recovery-fence-takeover-heartbeat"
    || heartbeat?.state !== "HOLDING" || heartbeat?.pid !== receipt.pid || heartbeat?.fd !== receipt.fd
    || heartbeat?.processStartIdentity !== receipt.processStartIdentity || heartbeat?.lockPath !== receipt.lockPath
    || heartbeat?.lockDevice !== receipt.lockDevice || heartbeat?.lockInode !== receipt.lockInode
    || heartbeat?.fenceTokenSha256 !== receipt.fenceTokenSha256
    || heartbeat?.parentGuardianReceiptSha256 !== receipt.parentGuardianReceiptSha256
    || heartbeat?.parentGuardianPid !== receipt.parentGuardianPid
    || heartbeat?.parentGuardianProcessStartIdentity !== receipt.parentGuardianProcessStartIdentity
    || heartbeat?.recoveryRequestId !== receipt.recoveryRequestId || !Number.isSafeInteger(heartbeat?.sequence)
    || !Number.isFinite(Date.parse(heartbeat?.observedAt))) {
    fail("Recovery fence takeover heartbeat is invalid");
  }
  return heartbeat;
};

const assertLiveRecoveryFenceTakeover = (receipt, expected, nowMs = Date.now()) => {
  validateRecoveryFenceTakeoverReceipt(receipt, expected);
  try { process.kill(receipt.pid, 0); } catch { fail("Recovery fence takeover is not alive"); }
  if (linuxProcessStartIdentity(receipt.pid) !== receipt.processStartIdentity) fail("Recovery fence takeover PID was reused");
  const descriptorStat = fs.statSync(`/proc/${receipt.pid}/fd/${receipt.fd}`);
  const lockStat = fs.statSync(receipt.lockPath);
  if (String(descriptorStat.dev) !== receipt.lockDevice || String(descriptorStat.ino) !== receipt.lockInode
    || descriptorStat.dev !== lockStat.dev || descriptorStat.ino !== lockStat.ino) {
    fail("Recovery fence takeover no longer holds the canonical lock inode");
  }
  const heartbeatRead = readPrivateJson(receipt.heartbeatPath, "Recovery fence takeover heartbeat", 1024 * 1024);
  const heartbeat = validateRecoveryFenceTakeoverHeartbeat(heartbeatRead.value, receipt);
  const observedAt = Date.parse(heartbeat?.observedAt);
  if (observedAt > nowMs + 1_000 || nowMs - observedAt > 5_000) {
    fail("Recovery fence takeover heartbeat is stale or invalid");
  }
  return { heartbeat, bytes: heartbeatRead.bytes, sha256: sha256(heartbeatRead.bytes) };
};

const discoverRecoveryFenceTakeoverRequestIds = (options, guardian, guardianReceiptSha256) => {
  const directory = path.dirname(options.fenceGuardianReceipt);
  const receiptPattern = /^\.viva-recovery-fence-takeover-([0-9a-f-]+)\.json$/i;
  const heartbeatPattern = /^\.viva-recovery-fence-takeover-([0-9a-f-]+)\.heartbeat\.json$/i;
  const names = fs.readdirSync(directory);
  const receiptIds = names.map((name) => name.match(receiptPattern)?.[1]).filter(Boolean);
  const heartbeatIds = names.map((name) => name.match(heartbeatPattern)?.[1]).filter(Boolean);
  const matching = [];
  for (const requestId of receiptIds) {
    if (!UUID_RE.test(requestId)) fail("Recovery fence takeover receipt name is ambiguous");
    const paths = takeoverPaths(options, requestId);
    const takeoverRead = readPrivateJson(paths.receiptPath, "Prior recovery takeover receipt", 1024 * 1024);
    if (takeoverRead.value?.parentGuardianReceiptSha256 !== guardianReceiptSha256) continue;
    validateRecoveryFenceTakeoverReceipt(takeoverRead.value, {
      parentGuardianReceiptSha256: guardianReceiptSha256,
      parentGuardianPid: guardian.pid,
      parentGuardianProcessStartIdentity: guardian.processStartIdentity,
      recoveryRequestId: requestId,
      fenceTokenSha256: guardian.fenceTokenSha256,
      lockPath: guardian.lockPath,
      lockDevice: guardian.lockDevice,
      lockInode: guardian.lockInode,
      heartbeatPath: paths.heartbeatPath,
      releaseRequestPath: guardian.releaseRequestPath,
      recoveryReportPath: options.report,
    });
    matching.push(requestId);
  }
  if (heartbeatIds.some((requestId) => !receiptIds.includes(requestId))) {
    fail("Recovery fence takeover heartbeat lacks its exact receipt");
  }
  if (matching.length > 1) fail("Multiple recovery fence takeovers match this exact guardian");
  return matching;
};

export const startRecoveryFenceTakeover = async (
  options, guardian, guardianReceiptSha256, requestId, dependencies = {},
) => {
  const paths = takeoverPaths(options, requestId);
  const expected = {
    parentGuardianReceiptSha256: guardianReceiptSha256,
    parentGuardianPid: guardian.pid,
    parentGuardianProcessStartIdentity: guardian.processStartIdentity,
    recoveryRequestId: requestId,
    fenceTokenSha256: guardian.fenceTokenSha256,
    lockPath: guardian.lockPath,
    lockDevice: guardian.lockDevice,
    lockInode: guardian.lockInode,
    heartbeatPath: paths.heartbeatPath,
    releaseRequestPath: guardian.releaseRequestPath,
    recoveryReportPath: options.report,
  };
  const receiptExists = fs.existsSync(paths.receiptPath);
  const heartbeatExists = fs.existsSync(paths.heartbeatPath);
  if (receiptExists || heartbeatExists) {
    if (!receiptExists) fail("Recovery fence takeover heartbeat lacks its exact receipt");
    const receiptRead = readPrivateJson(paths.receiptPath, "Recovery fence takeover receipt", 1024 * 1024);
    validateRecoveryFenceTakeoverReceipt(receiptRead.value, expected);
    if (dependencies.assertTakeoverLease && heartbeatExists) {
      const lease = await dependencies.assertTakeoverLease(receiptRead.value, expected, Date.now());
      if (!HASH_RE.test(String(lease?.sha256 || ""))) fail("Existing recovery fence takeover lacks a fresh heartbeat digest");
      return { ...paths, receipt: receiptRead.value, receiptSha256: sha256(receiptRead.bytes), lease, adopted: true };
    }
    const isAlive = dependencies.isTakeoverAlive
      ? await dependencies.isTakeoverAlive(receiptRead.value)
      : recoveryFenceTakeoverIsAlive(receiptRead.value);
    if (isAlive !== true && isAlive !== false) fail("Recovery fence takeover liveness is ambiguous");
    if (isAlive) {
      if (!heartbeatExists) fail("Live recovery fence takeover has not published its first heartbeat");
      const lease = assertLiveRecoveryFenceTakeover(receiptRead.value, expected);
      return { ...paths, receipt: receiptRead.value, receiptSha256: sha256(receiptRead.bytes), lease, adopted: true };
    }
    if (heartbeatExists) {
      const heartbeatRead = readPrivateJson(
        paths.heartbeatPath, "Dead recovery fence takeover heartbeat", 1024 * 1024,
      );
      validateRecoveryFenceTakeoverHeartbeat(heartbeatRead.value, receiptRead.value);
      fs.unlinkSync(paths.heartbeatPath);
    }
    fs.unlinkSync(paths.receiptPath);
    syncDirectory(path.dirname(paths.receiptPath));
  }
  if (dependencies.startFenceTakeover) {
    return dependencies.startFenceTakeover({ options, guardian, guardianReceiptSha256, requestId });
  }
  const fd = Number(process.env.PADLHUB_CUTOVER_FENCE_FD);
  if (!Number.isSafeInteger(fd) || fd < 3 || guardian.releaseRequestPath !== path.resolve(guardian.releaseRequestPath || "")) {
    fail("Recovery fence takeover lacks the inherited descriptor or release path");
  }
  const childStdio = Array(fd + 1).fill("ignore");
  childStdio[fd] = fd;
  const child = spawn(process.execPath, [
    TAKEOVER_SCRIPT_PATH,
    "--receipt", paths.receiptPath,
    "--heartbeat", paths.heartbeatPath,
    "--release-request", guardian.releaseRequestPath,
    "--recovery-report", options.report,
    "--parent-guardian-receipt-sha256", guardianReceiptSha256,
    "--parent-guardian-pid", String(guardian.pid),
    "--parent-guardian-process-start-identity", guardian.processStartIdentity,
    "--recovery-request-id", requestId,
  ], { detached: true, stdio: childStdio, env: process.env });
  child.unref();
  for (let poll = 0; poll < 50; poll += 1) {
    if (fs.existsSync(paths.receiptPath) && fs.existsSync(paths.heartbeatPath)) break;
    try { process.kill(child.pid, 0); } catch { fail("Recovery fence takeover failed to start"); }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!fs.existsSync(paths.receiptPath) || !fs.existsSync(paths.heartbeatPath)) {
    fail("Recovery fence takeover did not publish its receipt and heartbeat");
  }
  const receiptRead = readPrivateJson(paths.receiptPath, "Recovery fence takeover receipt", 1024 * 1024);
  const lease = assertLiveRecoveryFenceTakeover(receiptRead.value, expected);
  return { ...paths, receipt: receiptRead.value, receiptSha256: sha256(receiptRead.bytes), lease };
};

const validateCompletedRecoveryReport = (report, bindings, attemptId, journalDirectory) => {
  if (report?.formatVersion !== 1
    || report?.kind !== "viva-game-projection-mongo-write-barrier-recovery-receipt"
    || report?.state !== "RELEASED_TO_EXACT_PREIMAGE"
    || report?.recoveryAttemptId !== attemptId
    || report?.recoveryJournalPath !== journalDirectory
    || Object.entries(bindings).some(([key, value]) => report?.[key] !== value)) {
    fail("Mongo barrier recovery report does not bind the exact completed attempt");
  }
  return Buffer.from(canonicalJson(report));
};

export const openRecoveryJournal = (reportPath, bindings) => {
  const journalDirectory = `${reportPath}.journal`;
  let attemptId;
  let sequence;
  let entries = [];
  if (!fs.existsSync(journalDirectory)) {
    fs.mkdirSync(journalDirectory, { mode: 0o700 });
    fs.chmodSync(journalDirectory, 0o700);
    syncDirectory(path.dirname(journalDirectory));
  } else {
    const canonical = fs.realpathSync(journalDirectory);
    const stat = fs.lstatSync(canonical);
    if (canonical !== path.resolve(journalDirectory) || !stat.isDirectory() || stat.isSymbolicLink()
      || stat.uid !== privateOptions().uid || (stat.mode & 0o077) !== 0) {
      fail("Mongo barrier recovery journal is not private and canonical");
    }
    let allNames = fs.readdirSync(canonical).sort();
    for (const name of allNames.filter((entry) => !entry.startsWith("."))) {
      recoverAtomicExclusivePublication(path.join(canonical, name), privateOptions());
    }
    allNames = fs.readdirSync(canonical).sort();
    const names = allNames.filter((name) => !name.startsWith("."));
    let partialTerminalPath = null;
    entries = [];
    for (let index = 0; index < names.length; index += 1) {
      const name = names[index];
      if (!new RegExp(`^${String(index).padStart(4, "0")}-[a-z0-9-]+\\.json$`).test(name)) {
        fail("Mongo barrier recovery journal sequence is incomplete");
      }
      try {
        entries.push(readPrivateJson(path.join(canonical, name), "Mongo barrier recovery journal", 1024 * 1024).value);
      } catch (error) {
        if (index !== names.length - 1 || !name.endsWith("-terminal-result.json")) throw error;
        partialTerminalPath = path.join(canonical, name);
      }
    }
    attemptId = entries[0]?.attemptId;
    if ((entries.length > 0 && !attemptId) || entries.some((entry, index) => entry?.formatVersion !== 1
      || entry?.attemptId !== attemptId || entry?.mode !== "BARRIER_RECOVERY" || entry?.sequence !== index)
      || (entries.length > 0 && (entries[0]?.phase !== "ATTEMPT_STARTED"
        || Object.entries(bindings).some(([key, value]) => entries[0]?.[key] !== value)))
      || entries.filter((entry) => entry.phase === "TERMINAL_RESULT_INTENT").length > 1
      || entries.filter((entry) => entry.phase === "TERMINAL_RESULT").length > 1
      || entries.some((entry, index) => entry.phase === "TERMINAL_RESULT" && index !== entries.length - 1)) {
      fail("Mongo barrier recovery journal cannot be reconciled to these exact inputs");
    }
    let terminalIntent = entries.at(-1)?.phase === "TERMINAL_RESULT_INTENT" ? entries.at(-1) : null;
    let hiddenNames = allNames.filter((name) => name.startsWith("."));
    if (!terminalIntent && hiddenNames.length > 0) {
      const nextSequence = String(entries.length).padStart(4, "0");
      const orphanPattern = new RegExp(`^\\.(${nextSequence}-([a-z0-9-]+)\\.json)\\.\\d+\\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.tmp$`, "i");
      const match = hiddenNames.length === 1 ? hiddenNames[0].match(orphanPattern) : null;
      if (!match) fail("Mongo barrier recovery journal has an unrelated or ambiguous temporary artifact");
      const orphanPath = path.join(canonical, hiddenNames[0]);
      const orphanRead = readPrivateJson(orphanPath, "Mongo barrier recovery next-sequence temporary", 1024 * 1024);
      const orphan = orphanRead.value;
      const allowedPhases = new Set([
        "ATTEMPT_STARTED",
        "BARRIER_RECOVERY_OUTCOME_UNKNOWN",
        "BARRIER_RECOVERY_RECONCILE_OUTCOME_UNKNOWN",
        "FENCE_REVALIDATED_BEFORE_BARRIER_RECOVERY",
        "FENCE_REVALIDATED_DURING_BARRIER_RECOVERY",
        "FENCE_REVALIDATED_AFTER_BARRIER_RECOVERY",
        "TERMINAL_RESULT_INTENT",
      ]);
      const expectedAttemptId = entries[0]?.attemptId;
      const lastPhase = entries.at(-1)?.phase;
      const hasUnknownOutcome = entries.some((entry) => entry.phase === "BARRIER_RECOVERY_OUTCOME_UNKNOWN"
        || entry.phase === "BARRIER_RECOVERY_RECONCILE_OUTCOME_UNKNOWN");
      const admissibleTransition = (entries.length === 0 && orphan?.phase === "ATTEMPT_STARTED")
        || (lastPhase === "ATTEMPT_STARTED" && !hasUnknownOutcome
          && orphan?.phase === "BARRIER_RECOVERY_OUTCOME_UNKNOWN")
        || (hasUnknownOutcome && !["TERMINAL_RESULT_INTENT", "TERMINAL_RESULT"].includes(lastPhase)
          && orphan?.phase === "BARRIER_RECOVERY_RECONCILE_OUTCOME_UNKNOWN")
        || (["BARRIER_RECOVERY_OUTCOME_UNKNOWN", "BARRIER_RECOVERY_RECONCILE_OUTCOME_UNKNOWN"].includes(lastPhase)
          && orphan?.phase === "FENCE_REVALIDATED_BEFORE_BARRIER_RECOVERY")
        || (["FENCE_REVALIDATED_BEFORE_BARRIER_RECOVERY", "FENCE_REVALIDATED_DURING_BARRIER_RECOVERY"].includes(lastPhase)
          && orphan?.phase === "FENCE_REVALIDATED_DURING_BARRIER_RECOVERY")
        || (lastPhase === "FENCE_REVALIDATED_DURING_BARRIER_RECOVERY"
          && orphan?.phase === "FENCE_REVALIDATED_AFTER_BARRIER_RECOVERY")
        || (lastPhase === "FENCE_REVALIDATED_AFTER_BARRIER_RECOVERY"
          && orphan?.phase === "TERMINAL_RESULT_INTENT");
      const phaseSlug = String(orphan?.phase || "").toLowerCase().replace(/[^a-z0-9]+/g, "-");
      if (orphan?.formatVersion !== 1 || orphan?.mode !== "BARRIER_RECOVERY"
        || orphan?.sequence !== entries.length || !allowedPhases.has(orphan?.phase) || !admissibleTransition
        || phaseSlug !== match[2] || !Number.isFinite(Date.parse(orphan?.at))
        || (entries.length === 0 && (orphan?.phase !== "ATTEMPT_STARTED" || !UUID_RE.test(String(orphan?.attemptId || ""))))
        || (entries.length > 0 && orphan?.attemptId !== expectedAttemptId)
        || (orphan?.phase === "ATTEMPT_STARTED"
          && Object.entries(bindings).some(([key, value]) => orphan?.[key] !== value))
        || (orphan?.phase.startsWith("BARRIER_RECOVERY_")
          && Object.entries(bindings).some(([key, value]) => orphan?.[key] !== value))) {
        fail("Mongo barrier recovery next-sequence temporary is not a valid journal entry");
      }
      const destinationPath = path.join(canonical, match[1]);
      fs.linkSync(orphanPath, destinationPath);
      syncDirectory(canonical);
      fs.unlinkSync(orphanPath);
      syncDirectory(canonical);
      entries.push(orphan);
      attemptId ||= orphan.attemptId;
      hiddenNames = [];
      terminalIntent = orphan.phase === "TERMINAL_RESULT_INTENT" ? orphan : null;
    }
    if (terminalIntent) {
      const terminalSequence = terminalIntent.sequence + 1;
      const terminalName = `${String(terminalSequence).padStart(4, "0")}-terminal-result.json`;
      const terminalPath = path.join(canonical, terminalName);
      const orphanPattern = new RegExp(`^\\.${terminalName.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\.[^.]+\\.[^.]+\\.tmp$`);
      const orphanNames = hiddenNames.filter((name) => orphanPattern.test(name));
      if ((partialTerminalPath && partialTerminalPath !== terminalPath) || orphanNames.length > 1
        || hiddenNames.length !== orphanNames.length) {
        fail("Mongo barrier recovery terminal publication is ambiguous");
      }
      const reportBytes = validateCompletedRecoveryReport(
        terminalIntent.report, bindings, attemptId, journalDirectory,
      );
      if (terminalIntent.reportSha256 !== sha256(reportBytes)
        || terminalIntent.reportBytesBase64 !== reportBytes.toString("base64")) {
        fail("Mongo barrier recovery terminal intent digest mismatch");
      }
      for (const candidate of [partialTerminalPath, ...orphanNames.map((name) => path.join(canonical, name))].filter(Boolean)) {
        const candidateStat = fs.lstatSync(candidate);
        if (!candidateStat.isFile() || candidateStat.isSymbolicLink() || candidateStat.nlink !== 1
          || candidateStat.uid !== privateOptions().uid || (candidateStat.mode & 0o077) !== 0) {
          fail("Mongo barrier recovery terminal artifact is not private");
        }
        fs.unlinkSync(candidate);
      }
      if (partialTerminalPath || orphanNames.length > 0) syncDirectory(canonical);
      const terminal = { ...terminalIntent, sequence: terminalSequence, phase: "TERMINAL_RESULT" };
      writeFileExclusiveAtomicDurable(terminalPath, Buffer.from(canonicalJson(terminal)), privateOptions());
      entries.push(terminal);
    } else if (partialTerminalPath || hiddenNames.length > 0) {
      fail("Mongo barrier recovery terminal publication is missing its exact intent");
    }
  }
  attemptId ||= crypto.randomUUID();
  sequence = entries.length;
  const append = (phase, detail = {}) => {
    const entry = {
      formatVersion: 1, attemptId, mode: "BARRIER_RECOVERY", sequence,
      at: new Date().toISOString(), phase, ...detail,
    };
    const name = `${String(sequence).padStart(4, "0")}-${phase.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.json`;
    writeFileExclusiveAtomicDurable(path.join(journalDirectory, name), Buffer.from(canonicalJson(entry)), privateOptions());
    sequence += 1;
    return entry;
  };
  if (sequence === 0) append("ATTEMPT_STARTED", bindings);
  const appendTerminal = (report) => {
    const reportBytes = validateCompletedRecoveryReport(report, bindings, attemptId, journalDirectory);
    const terminalDetail = {
      state: report.state,
      mutationAttempted: true,
      reconciledPriorUnknownOutcome: report.reconciledPriorUnknownOutcome,
      reportSha256: sha256(reportBytes),
      reportBytesBase64: reportBytes.toString("base64"),
      report,
    };
    append("TERMINAL_RESULT_INTENT", terminalDetail);
    append("TERMINAL_RESULT", terminalDetail);
    return reportBytes;
  };
  const terminal = entries.find((entry) => entry.phase === "TERMINAL_RESULT");
  if (terminal) {
    const terminalIndex = entries.indexOf(terminal);
    const terminalIntent = entries[terminalIndex - 1];
    const reportBytes = validateCompletedRecoveryReport(terminal.report, bindings, attemptId, journalDirectory);
    if (terminalIntent?.phase !== "TERMINAL_RESULT_INTENT"
      || terminalIntent.reportSha256 !== sha256(reportBytes)
      || terminalIntent.reportBytesBase64 !== reportBytes.toString("base64")
      || terminal.reportSha256 !== terminalIntent.reportSha256
      || terminal.reportBytesBase64 !== terminalIntent.reportBytesBase64
      || canonicalJson(terminal.report) !== canonicalJson(terminalIntent.report)) {
      fail("Mongo barrier recovery terminal report digest mismatch");
    }
    if (fs.existsSync(reportPath)) {
      const existing = readPrivateJson(reportPath, "Mongo barrier recovery report", 16 * 1024 * 1024);
      if (sha256(existing.bytes) !== terminal.reportSha256) fail("Mongo barrier recovery report differs from terminal journal");
    } else writeFileExclusiveAtomicDurable(reportPath, reportBytes, privateOptions());
    return { attemptId, journalDirectory, resumed: true, append, completedReport: terminal.report };
  }
  if (fs.existsSync(reportPath)) {
    const existing = readPrivateJson(reportPath, "Mongo barrier recovery report", 16 * 1024 * 1024);
    const reportBytes = appendTerminal(existing.value);
    if (sha256(existing.bytes) !== sha256(reportBytes)) fail("Mongo barrier recovery report canonical bytes mismatch");
    return { attemptId, journalDirectory, resumed: true, append, completedReport: existing.value };
  }
  const resumed = entries.some((entry) => entry.phase === "BARRIER_RECOVERY_OUTCOME_UNKNOWN"
    || entry.phase === "BARRIER_RECOVERY_RECONCILE_OUTCOME_UNKNOWN");
  return { attemptId, journalDirectory, resumed, append, appendTerminal, completedReport: null };
};

const readCompletedRecoveryWithLiveTakeover = async ({
  options, bindings, guardian, nowMs, dependencies, requiredRequestId = null,
}) => {
  if (!fs.existsSync(options.report) && !fs.existsSync(`${options.report}.journal`)) return null;
  const journal = openRecoveryJournal(options.report, bindings);
  const completed = journal.completedReport;
  if (!completed) return null;
  const completedRequestId = String(completed.guardianRecoveryRequestId || "");
  if (!UUID_RE.test(completedRequestId)) fail("Completed recovery report lacks its guardian request identity");
  if (requiredRequestId && completedRequestId !== requiredRequestId) return null;
  const paths = takeoverPaths(options, completedRequestId);
  if (completed.recoveryFenceTakeoverState !== "HELD_UNTIL_EXPLICIT_FENCE_RELEASE"
    || completed.recoveryFenceTakeoverReceiptPath !== paths.receiptPath || !fs.existsSync(paths.receiptPath)) {
    fail("Completed recovery report lacks its exact takeover receipt");
  }
  const takeoverRead = readPrivateJson(paths.receiptPath, "Recovery fence takeover receipt", 1024 * 1024);
  if (completed.recoveryFenceTakeoverReceiptSha256 !== sha256(takeoverRead.bytes)) {
    fail("Recovery takeover does not bind the completed recovery report");
  }
  const expected = {
    parentGuardianReceiptSha256: options.expectedFenceGuardianReceiptSha256,
    parentGuardianPid: guardian.pid,
    parentGuardianProcessStartIdentity: guardian.processStartIdentity,
    recoveryRequestId: completedRequestId,
    fenceTokenSha256: guardian.fenceTokenSha256,
    lockPath: guardian.lockPath,
    lockDevice: guardian.lockDevice,
    lockInode: guardian.lockInode,
    heartbeatPath: paths.heartbeatPath,
    releaseRequestPath: guardian.releaseRequestPath,
    recoveryReportPath: options.report,
  };
  const lease = dependencies.assertTakeoverLease
    ? await dependencies.assertTakeoverLease(takeoverRead.value, expected, nowMs)
    : assertLiveRecoveryFenceTakeover(takeoverRead.value, expected, nowMs);
  if (!HASH_RE.test(String(lease?.sha256 || ""))) fail("Recovery takeover lacks a fresh heartbeat digest");
  return completed;
};

const readExactRecoveryRequest = (requestPath, argv, guardian, nowMs, { accepted = false } = {}) => {
  const requestRead = readPrivateJson(requestPath, "Fence guardian recovery request", 1024 * 1024);
  const request = requestRead.value;
  const validationNowMs = accepted ? Date.parse(request?.authorizedAt) : nowMs;
  if (!isAuthorizedFenceGuardianRecovery({
    request,
    validPrivateFile: true,
    fenceTokenSha256: guardian.fenceTokenSha256,
    guardianPid: guardian.pid,
    processStartIdentity: guardian.processStartIdentity,
    nowMs: validationNowMs,
  }) || canonicalJson(request.argv) !== canonicalJson(argv)) {
    fail("Existing fence guardian recovery request does not bind this exact recovery");
  }
  return request;
};

const parseArgs = (argv) => {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--") || values.has(key)) fail("Invalid recovery argument");
    values.set(key, value);
  }
  for (const key of [
    "--barrier-artifact", "--expected-barrier-artifact-sha256", "--cutover-plan",
    "--expected-cutover-plan-sha256", "--migration-connection-file",
    "--execution-index", "--expected-execution-index-sha256",
    "--fence-receipt", "--expected-fence-receipt-sha256",
    "--fence-guardian-receipt", "--expected-fence-guardian-receipt-sha256",
    "--fence-guardian-recovery-request", "--report",
  ]) if (!values.get(key)) fail(`Missing ${key}`);
  return values;
};

const optionsFromValues = (values) => ({
  barrierArtifact: values.get("--barrier-artifact"),
  expectedBarrierArtifactSha256: values.get("--expected-barrier-artifact-sha256"),
  cutoverPlan: values.get("--cutover-plan"),
  expectedCutoverPlanSha256: values.get("--expected-cutover-plan-sha256"),
  migrationConnectionFile: values.get("--migration-connection-file"),
  executionIndex: values.get("--execution-index"),
  expectedExecutionIndexSha256: values.get("--expected-execution-index-sha256"),
  fenceReceipt: values.get("--fence-receipt"),
  expectedFenceReceiptSha256: values.get("--expected-fence-receipt-sha256"),
  fenceGuardianReceipt: values.get("--fence-guardian-receipt"),
  expectedFenceGuardianReceiptSha256: values.get("--expected-fence-guardian-receipt-sha256"),
  fenceGuardianRecoveryRequest: values.get("--fence-guardian-recovery-request"),
  report: values.get("--report"),
});

const startRecoveryFenceTakeoverBeforeAcceptance = async (options, requestId, dependencies = {}) => {
  const guardianRead = readPrivateJson(options.fenceGuardianReceipt, "Fence-guardian receipt", 1024 * 1024);
  const guardian = guardianRead.value;
  if (sha256(guardianRead.bytes) !== options.expectedFenceGuardianReceiptSha256
    || guardian?.formatVersion !== 1
    || guardian?.kind !== "viva-game-projection-fence-guardian-receipt"
    || guardian?.state !== "HOLDING_UNTIL_EXPLICIT_RELEASE"
    || guardian?.recoveryRequestPath !== options.fenceGuardianRecoveryRequest
    || guardian?.recoveryExecutorPath !== SCRIPT_PATH
    || guardian?.recoveryExecutorSha256 !== sha256(fs.readFileSync(SCRIPT_PATH))
    || !path.isAbsolute(String(guardian?.releaseRequestPath || ""))
    || guardian?.automaticRelease !== false) {
    fail("Recovery child cannot establish takeover custody for this exact guardian");
  }
  return startRecoveryFenceTakeover(
    options, guardian, options.expectedFenceGuardianReceiptSha256, requestId, dependencies,
  );
};

export async function requestRecoveryFromGuardian(argv, options, dependencies = {}) {
  if ((dependencies.getUid ? dependencies.getUid() : process.getuid?.()) !== 0) fail("Mongo barrier recovery requires root");
  if (process.env.VIVA_GAME_PROJECTION_MONGO_BARRIER_RECOVER !== CONFIRMATION) fail("Mongo barrier recovery confirmation is absent");
  const guardianRead = readPrivateJson(options.fenceGuardianReceipt, "Fence-guardian receipt", 1024 * 1024);
  if (sha256(guardianRead.bytes) !== options.expectedFenceGuardianReceiptSha256
    || guardianRead.value?.kind !== "viva-game-projection-fence-guardian-receipt"
    || guardianRead.value?.state !== "HOLDING_UNTIL_EXPLICIT_RELEASE"
    || guardianRead.value?.recoveryRequestPath !== options.fenceGuardianRecoveryRequest
    || !path.isAbsolute(String(guardianRead.value?.releaseRequestPath || ""))
    || guardianRead.value?.recoveryExecutorPath !== SCRIPT_PATH
    || guardianRead.value?.recoveryExecutorSha256 !== sha256(fs.readFileSync(SCRIPT_PATH))) {
    fail("Fence guardian cannot accept this exact recovery executor request");
  }
  if (!path.isAbsolute(options.fenceGuardianRecoveryRequest)
    || path.resolve(options.fenceGuardianRecoveryRequest) !== options.fenceGuardianRecoveryRequest
    || path.dirname(options.fenceGuardianRecoveryRequest) !== path.dirname(options.fenceGuardianReceipt)) {
    fail("Fence guardian recovery-request path is not canonical");
  }
  const nowMs = typeof dependencies.nowMs === "function" ? dependencies.nowMs() : (dependencies.nowMs ?? Date.now());
  const bindings = {
    barrierArtifactSha256: options.expectedBarrierArtifactSha256,
    cutoverPlanSha256: options.expectedCutoverPlanSha256,
    executionIndexSha256: options.expectedExecutionIndexSha256,
    fenceReceiptSha256: options.expectedFenceReceiptSha256,
    fenceGuardianReceiptSha256: options.expectedFenceGuardianReceiptSha256,
  };
  if (!fs.existsSync(options.fenceGuardianRecoveryRequest)) {
    const completed = await readCompletedRecoveryWithLiveTakeover({
      options, bindings, guardian: guardianRead.value, nowMs, dependencies,
    });
    if (completed) return completed;
  }
  let initialGuardianLease = null;
  let guardianLeaseError = null;
  try {
    initialGuardianLease = dependencies.assertGuardianLease
      ? await dependencies.assertGuardianLease(guardianRead.value, nowMs)
      : assertLiveFenceGuardian(guardianRead.value, nowMs);
  } catch (error) { guardianLeaseError = error; }
  let requestId = null;
  let request = null;
  let shouldPublishRequest = false;
  const takeoverIds = discoverRecoveryFenceTakeoverRequestIds(
    options, guardianRead.value, options.expectedFenceGuardianReceiptSha256,
  );
  if (fs.existsSync(options.fenceGuardianRecoveryRequest)) {
    request = readExactRecoveryRequest(
      options.fenceGuardianRecoveryRequest, argv, guardianRead.value, nowMs,
    );
    requestId = request.requestId;
    if (takeoverIds.length === 1 && takeoverIds[0] !== requestId) {
      const supersededPath = `${options.fenceGuardianRecoveryRequest}.superseded-${requestId}-by-${takeoverIds[0]}`;
      if (fs.existsSync(supersededPath)) fail("Superseded recovery request evidence already exists");
      fs.renameSync(options.fenceGuardianRecoveryRequest, supersededPath);
      syncDirectory(path.dirname(options.fenceGuardianRecoveryRequest));
      requestId = takeoverIds[0];
      request = null;
      shouldPublishRequest = true;
    }
  } else {
    const heartbeatRequestId = initialGuardianLease?.heartbeat?.recoveryRequestId;
    const acceptedPrefix = `${path.basename(options.fenceGuardianRecoveryRequest)}.accepted-`;
    const acceptedIds = fs.readdirSync(path.dirname(options.fenceGuardianRecoveryRequest))
      .filter((name) => name.startsWith(acceptedPrefix))
      .map((name) => name.slice(acceptedPrefix.length))
      .filter((value) => UUID_RE.test(value));
    const candidateIds = [...new Set([
      ...(UUID_RE.test(String(heartbeatRequestId || "")) ? [heartbeatRequestId] : []),
      ...acceptedIds,
      ...takeoverIds,
    ])];
    const accepted = [];
    for (const candidateId of candidateIds) {
      const acceptedPath = `${options.fenceGuardianRecoveryRequest}.accepted-${candidateId}`;
      if (!fs.existsSync(acceptedPath)) continue;
      try {
        accepted.push(readExactRecoveryRequest(acceptedPath, argv, guardianRead.value, nowMs, { accepted: true }));
      } catch { /* unrelated or corrupt accepted requests never authorize this retry */ }
    }
    if (accepted.length > 1) fail("Multiple accepted recovery requests match this exact recovery");
    if (accepted.length === 1) {
      request = accepted[0];
      requestId = request.requestId;
      if (takeoverIds.length === 1 && takeoverIds[0] !== requestId) {
        fail("Accepted recovery and takeover request IDs disagree");
      }
      const recoveryIsActive = UUID_RE.test(String(heartbeatRequestId || ""))
        && heartbeatRequestId === requestId
        && Number.isSafeInteger(initialGuardianLease?.heartbeat?.recoveryChildPid);
      if (initialGuardianLease && !recoveryIsActive) {
        request = null;
        shouldPublishRequest = true;
      }
    } else if (takeoverIds.length === 1) {
      [requestId] = takeoverIds;
      shouldPublishRequest = true;
    } else if (UUID_RE.test(String(heartbeatRequestId || ""))
      && initialGuardianLease?.heartbeat?.recoveryReleaseDelegated === true) {
      requestId = heartbeatRequestId;
      shouldPublishRequest = true;
    } else {
      const failedRequestId = initialGuardianLease?.heartbeat?.lastRecoveryResult?.requestId;
      if (UUID_RE.test(String(failedRequestId || ""))) {
        const paths = takeoverPaths(options, failedRequestId);
        const receiptExists = fs.existsSync(paths.receiptPath);
        const heartbeatExists = fs.existsSync(paths.heartbeatPath);
        if (receiptExists || heartbeatExists) {
          if (!receiptExists) fail("Prior recovery takeover heartbeat lacks its exact receipt");
          const takeoverRead = readPrivateJson(paths.receiptPath, "Prior recovery takeover receipt", 1024 * 1024);
          const expected = {
            parentGuardianReceiptSha256: options.expectedFenceGuardianReceiptSha256,
            parentGuardianPid: guardianRead.value.pid,
            parentGuardianProcessStartIdentity: guardianRead.value.processStartIdentity,
            recoveryRequestId: failedRequestId,
            fenceTokenSha256: guardianRead.value.fenceTokenSha256,
            lockPath: guardianRead.value.lockPath,
            lockDevice: guardianRead.value.lockDevice,
            lockInode: guardianRead.value.lockInode,
            heartbeatPath: paths.heartbeatPath,
            releaseRequestPath: guardianRead.value.releaseRequestPath,
            recoveryReportPath: options.report,
          };
          validateRecoveryFenceTakeoverReceipt(takeoverRead.value, expected);
          requestId = failedRequestId;
          shouldPublishRequest = true;
        }
      }
    }
  }
  if (!requestId && guardianLeaseError) throw guardianLeaseError;
  if (!requestId) {
    requestId = dependencies.requestId || crypto.randomUUID();
    shouldPublishRequest = true;
  }
  if (!UUID_RE.test(String(requestId || ""))) fail("Fence guardian recovery request ID is invalid");
  if (shouldPublishRequest) {
    request = {
      formatVersion: 1,
      kind: "viva-game-projection-fence-recovery-request",
      state: "RECOVERY_AUTHORIZED",
      confirmation: CONFIRMATION,
      requestId,
      guardianPid: guardianRead.value.pid,
      guardianProcessStartIdentity: guardianRead.value.processStartIdentity,
      fenceTokenSha256: guardianRead.value.fenceTokenSha256,
      argv,
      authorizedAt: new Date(nowMs).toISOString(),
    };
    try {
      writeFileExclusiveAtomicDurable(
        options.fenceGuardianRecoveryRequest, Buffer.from(canonicalJson(request)), privateOptions(),
      );
    } catch (error) {
      if (error?.publicationOutcome !== "UNKNOWN"
        || error?.publicationPath !== options.fenceGuardianRecoveryRequest) throw error;
    }
  }
  const maximumPolls = dependencies.maximumPolls ?? 360;
  for (let poll = 0; poll < maximumPolls; poll += 1) {
    const pollNowMs = typeof dependencies.nowMs === "function" ? dependencies.nowMs() : (dependencies.nowMs ?? Date.now());
    let guardianLease = null;
    try {
      guardianLease = dependencies.assertGuardianLease
        ? await dependencies.assertGuardianLease(guardianRead.value, pollNowMs)
        : assertLiveFenceGuardian(guardianRead.value, pollNowMs);
    } catch { /* a recovery-owned takeover can remain the live canonical custodian */ }
    const heartbeat = guardianLease?.heartbeat;
    const childFinished = heartbeat?.recoveryChildPid == null
      && heartbeat?.lastRecoveryResult?.requestId === requestId;
    const requestConsumed = !fs.existsSync(options.fenceGuardianRecoveryRequest);
    if (childFinished && requestConsumed && heartbeat.lastRecoveryResult.exitCode !== 0) {
      fail("Fence guardian recovery child failed while the canonical fence remained held");
    }
    if (childFinished && heartbeat.lastRecoveryResult.exitCode === 0 && requestConsumed) {
      const completed = await readCompletedRecoveryWithLiveTakeover({
        options, bindings, guardian: guardianRead.value, nowMs: pollNowMs, dependencies,
      });
      if (!completed) fail("Fence guardian recovery child exited without a durable terminal report");
      return completed;
    }
    if (!guardianLease && requestConsumed) {
      const completed = await readCompletedRecoveryWithLiveTakeover({
        options, bindings, guardian: guardianRead.value, nowMs: pollNowMs, dependencies,
        requiredRequestId: requestId,
      });
      if (completed) return completed;
    }
    if (dependencies.waitForPoll) await dependencies.waitForPoll();
    else await new Promise((resolve) => setTimeout(resolve, 500));
  }
  fail("Timed out waiting for the fence guardian recovery child");
}

export async function recoverVivaGameProjectionMongoWriteBarrier(options, dependencies = {}) {
  if ((dependencies.getUid ? dependencies.getUid() : process.getuid?.()) !== 0) fail("Mongo barrier recovery requires root");
  if (process.env.VIVA_GAME_PROJECTION_MONGO_BARRIER_RECOVER !== CONFIRMATION) fail("Mongo barrier recovery confirmation is absent");
  if (!dependencies.allowFixtureGuardianChild && process.env.PADLHUB_CUTOVER_GUARDIAN_CHILD !== "1") {
    fail("Mongo barrier recovery must be spawned by the live fence guardian");
  }
  const guardianRecoveryRequestId = dependencies.guardianRecoveryRequestId
    || process.env.PADLHUB_CUTOVER_GUARDIAN_RECOVERY_REQUEST_ID;
  if (!UUID_RE.test(String(guardianRecoveryRequestId || ""))) fail("Mongo barrier recovery guardian request identity is invalid");
  for (const [value, label] of [
    [options.expectedBarrierArtifactSha256, "Barrier artifact digest"],
    [options.expectedCutoverPlanSha256, "Cutover-plan digest"],
    [options.expectedExecutionIndexSha256, "Execution-index digest"],
    [options.expectedFenceReceiptSha256, "Writer-fence receipt digest"],
    [options.expectedFenceGuardianReceiptSha256, "Fence-guardian receipt digest"],
  ]) if (!HASH_RE.test(String(value || ""))) fail(`${label} is invalid`);
  const artifactRead = readPrivateJson(options.barrierArtifact, "Mongo barrier artifact", 16 * 1024 * 1024);
  const cutoverRead = readPrivateJson(options.cutoverPlan, "Cutover plan", 64 * 1024 * 1024);
  const executionRead = readPrivateJson(options.executionIndex, "Cutover execution index", 16 * 1024 * 1024);
  const fenceRead = readPrivateJson(options.fenceReceipt, "Writer-fence receipt", 16 * 1024 * 1024);
  const guardianRead = readPrivateJson(options.fenceGuardianReceipt, "Fence-guardian receipt", 1024 * 1024);
  const plan = cutoverRead.value;
  const execution = executionRead.value;
  if (sha256(artifactRead.bytes) !== options.expectedBarrierArtifactSha256
    || sha256(cutoverRead.bytes) !== options.expectedCutoverPlanSha256
    || sha256(executionRead.bytes) !== options.expectedExecutionIndexSha256
    || sha256(fenceRead.bytes) !== options.expectedFenceReceiptSha256
    || sha256(guardianRead.bytes) !== options.expectedFenceGuardianReceiptSha256
    || plan?.kind !== "viva-game-projection-tenant-cutover-plan"
    || plan.state !== "READY_FOR_SEPARATE_LIVE_APPROVAL" || plan.liveMutationAuthorized !== false
    || artifactRead.value?.cutoverPlanSha256 !== options.expectedCutoverPlanSha256
    || execution?.formatVersion !== 1
    || execution?.kind !== "viva-game-projection-cutover-execution-index"
    || execution?.cutoverPlanPath !== options.cutoverPlan
    || execution?.cutoverPlanSha256 !== options.expectedCutoverPlanSha256
    || execution?.fenceReceiptPath !== options.fenceReceipt
    || execution?.fenceReceiptSha256 !== options.expectedFenceReceiptSha256
    || execution?.migrationConnectionFile !== options.migrationConnectionFile
    || !HASH_RE.test(String(execution?.migrationConnectionFileSha256 || ""))
    || sha256(readPrivateBytes(
      options.migrationConnectionFile, "Migration Mongo connection", 1024 * 1024,
    )) !== execution.migrationConnectionFileSha256
    || sha256(String(execution?.tenantKey || "")) !== plan.tenantKeySha256
    || ![execution?.mongoWriteBarrierReceiptOutputPath, `${execution?.mongoWriteBarrierReceiptOutputPath}.prepared`]
      .includes(options.barrierArtifact)) {
    fail("Mongo barrier recovery inputs do not bind one exact cutover");
  }
  if (dependencies.assertExecutorSources) await dependencies.assertExecutorSources(plan);
  else assertExactExecutorSources(plan);
  if (os.hostname() !== plan.production?.hostname && !dependencies.allowFixtureHostname) {
    fail("Mongo barrier recovery host differs from the cutover production host");
  }
  const now = () => (typeof dependencies.nowMs === "function" ? dependencies.nowMs() : (dependencies.nowMs ?? Date.now()));
  let recoveryFenceTakeover = dependencies.prestartedFenceTakeover || null;
  const assertRecoveryFence = async () => {
    const nowMs = now();
    const currentFenceRead = readPrivateJson(options.fenceReceipt, "Writer-fence receipt", 16 * 1024 * 1024);
    const currentGuardianRead = readPrivateJson(options.fenceGuardianReceipt, "Fence-guardian receipt", 1024 * 1024);
    if (sha256(currentFenceRead.bytes) !== options.expectedFenceReceiptSha256
      || sha256(currentGuardianRead.bytes) !== options.expectedFenceGuardianReceiptSha256) {
      fail("Mongo barrier recovery fence evidence changed during recovery");
    }
    const currentFence = currentFenceRead.value;
    const currentGuardian = currentGuardianRead.value;
    validateHeldWriterFence(currentFence, {
      sourceFlowSha256: plan.sourceFlowSha256,
      candidateSha256: plan.candidateSha256,
      tenantKey: currentFence?.tenantKey,
      expectedOperationIds: plan.writerFence?.exactMigrationOperationIds,
      expectedWriterNodeIds: plan.writerFence?.exactWriterNodeIds,
      writerInventorySha256: plan.writerFence?.writerInventorySha256,
      externalWriterProofSha256: plan.writerFence?.externalWriterProofSha256,
      fenceTokenSha256: plan.writerFence?.fenceTokenSha256,
      lockPath: plan.writerFence?.lockPath,
      nowMs: Date.parse(currentFence?.observedAt),
    });
    if (sha256(String(currentFence?.tenantKey || "")) !== plan.tenantKeySha256
      || currentFence?.pm2ProcessId !== plan.production?.pm2ProcessId
      || currentGuardian?.kind !== "viva-game-projection-fence-guardian-receipt"
      || currentGuardian?.state !== "HOLDING_UNTIL_EXPLICIT_RELEASE"
      || currentGuardian?.fenceTokenSha256 !== plan.writerFence?.fenceTokenSha256
      || currentGuardian?.lockPath !== plan.writerFence?.lockPath
      || !path.isAbsolute(String(currentGuardian?.releaseRequestPath || ""))
      || currentGuardian?.recoveryRequestPath !== options.fenceGuardianRecoveryRequest
      || currentGuardian?.recoveryExecutorPath !== SCRIPT_PATH
      || currentGuardian?.recoveryExecutorSha256 !== sha256(fs.readFileSync(SCRIPT_PATH))
      || currentGuardian?.automaticRelease !== false) {
      fail("Mongo barrier recovery fence receipts do not bind the exact cutover");
    }
    if (dependencies.assertFenceLease) await dependencies.assertFenceLease(currentFence);
    else assertExclusiveFenceLease(currentFence);
    let takeoverLease = null;
    if (recoveryFenceTakeover) {
      const takeoverExpected = {
        parentGuardianReceiptSha256: options.expectedFenceGuardianReceiptSha256,
        parentGuardianPid: currentGuardian.pid,
        parentGuardianProcessStartIdentity: currentGuardian.processStartIdentity,
        recoveryRequestId: guardianRecoveryRequestId,
        fenceTokenSha256: currentGuardian.fenceTokenSha256,
        lockPath: currentGuardian.lockPath,
        lockDevice: currentGuardian.lockDevice,
        lockInode: currentGuardian.lockInode,
        heartbeatPath: recoveryFenceTakeover.heartbeatPath,
        releaseRequestPath: currentGuardian.releaseRequestPath,
        recoveryReportPath: options.report,
      };
      takeoverLease = dependencies.assertTakeoverLease
        ? await dependencies.assertTakeoverLease(recoveryFenceTakeover.receipt, takeoverExpected, nowMs)
        : assertLiveRecoveryFenceTakeover(recoveryFenceTakeover.receipt, takeoverExpected, nowMs);
      if (!HASH_RE.test(String(takeoverLease?.sha256 || ""))) fail("Mongo barrier recovery lacks a fresh takeover heartbeat digest");
    }
    let guardianLease = null;
    try {
      guardianLease = dependencies.assertGuardianLease
        ? await dependencies.assertGuardianLease(currentGuardian, nowMs)
        : assertLiveFenceGuardian(currentGuardian, nowMs);
    } catch (error) {
      if (!takeoverLease) throw error;
    }
    const processes = dependencies.readPm2 ? await dependencies.readPm2() : readPm2();
    const matches = Array.isArray(processes) ? processes.filter((entry) => entry?.name === plan.production?.processName) : [];
    const processEntry = matches[0];
    if (matches.length !== 1 || processEntry?.pm_id !== plan.production?.pm2ProcessId
      || String(processEntry?.pm2_env?.status || "").toLowerCase() !== "stopped"
      || sha256(String(envValue(processEntry, "PADLHUB_PLATFORM_TENANT_KEY") || "")) !== plan.tenantKeySha256
      || String(envValue(processEntry, "VIVA_GAME_PROJECTION_SYNC_MODE") || "").toUpperCase() !== "SHADOW"
      || !Number.isSafeInteger(Number(processEntry?.pm2_env?.restart_time))
      || Number(processEntry.pm2_env.restart_time) < plan.production?.restartCountAtEvidence) {
      fail("Mongo barrier recovery requires the exact stopped Node-RED runtime");
    }
    assertPm2RuntimeIdentity(processEntry, plan.production);
    assertNoCutoverEnvironment(processEntry);
    return {
      guardianHeartbeatSha256: guardianLease?.sha256 || null,
      recoveryFenceTakeoverHeartbeatSha256: takeoverLease?.sha256 || null,
      pm2StateSha256: sha256(canonicalJson({
        name: processEntry.name,
        pmId: processEntry.pm_id,
        status: processEntry.pm2_env.status,
        restartCount: Number(processEntry.pm2_env.restart_time),
        execPath: processEntry.pm2_env.pm_exec_path,
        cwd: processEntry.pm2_env.pm_cwd,
      })),
      restartCount: Number(processEntry.pm2_env.restart_time),
    };
  };
  const connection = readPrivateMongoConnection(
    options.migrationConnectionFile, plan.mongoTarget?.migrationConnectionFingerprint,
  );
  if (!path.isAbsolute(String(options.report || "")) || path.resolve(options.report) !== options.report) {
    fail("Mongo barrier recovery report path must be absolute and canonical");
  }
  ensurePrivateDirectory(path.dirname(options.report), "Mongo barrier recovery report directory");
  const journalBindings = {
    barrierArtifactSha256: options.expectedBarrierArtifactSha256,
    cutoverPlanSha256: options.expectedCutoverPlanSha256,
    executionIndexSha256: options.expectedExecutionIndexSha256,
    fenceReceiptSha256: options.expectedFenceReceiptSha256,
    fenceGuardianReceiptSha256: options.expectedFenceGuardianReceiptSha256,
  };
  const journal = openRecoveryJournal(options.report, journalBindings);
  if (journal.completedReport) {
    const completed = journal.completedReport;
    const completedRequestId = String(completed.guardianRecoveryRequestId || "");
    if (!UUID_RE.test(completedRequestId)) fail("Completed Mongo barrier recovery lacks its guardian request identity");
    const expectedPaths = takeoverPaths(options, completedRequestId);
    if (completed.recoveryFenceTakeoverState !== "HELD_UNTIL_EXPLICIT_FENCE_RELEASE"
      || completed.recoveryFenceTakeoverReceiptPath !== expectedPaths.receiptPath
      || !HASH_RE.test(String(completed.recoveryFenceTakeoverReceiptSha256 || ""))) {
      fail("Completed Mongo barrier recovery lacks durable fence-takeover custody");
    }
    const takeoverRead = readPrivateJson(
      completed.recoveryFenceTakeoverReceiptPath, "Recovery fence takeover receipt", 1024 * 1024,
    );
    if (sha256(takeoverRead.bytes) !== completed.recoveryFenceTakeoverReceiptSha256) {
      fail("Completed Mongo barrier recovery fence-takeover receipt changed");
    }
    const takeoverExpected = {
      parentGuardianReceiptSha256: options.expectedFenceGuardianReceiptSha256,
      parentGuardianPid: guardianRead.value.pid,
      parentGuardianProcessStartIdentity: guardianRead.value.processStartIdentity,
      recoveryRequestId: completedRequestId,
      fenceTokenSha256: guardianRead.value.fenceTokenSha256,
      lockPath: guardianRead.value.lockPath,
      lockDevice: guardianRead.value.lockDevice,
      lockInode: guardianRead.value.lockInode,
      heartbeatPath: expectedPaths.heartbeatPath,
      releaseRequestPath: guardianRead.value.releaseRequestPath,
      recoveryReportPath: options.report,
    };
    if (dependencies.assertTakeoverLease) {
      await dependencies.assertTakeoverLease(takeoverRead.value, takeoverExpected, Date.now());
    } else assertLiveRecoveryFenceTakeover(takeoverRead.value, takeoverExpected, Date.now());
    return completed;
  }
  await assertRecoveryFence();
  if (!recoveryFenceTakeover) {
    recoveryFenceTakeover = await startRecoveryFenceTakeover(
      options, guardianRead.value, options.expectedFenceGuardianReceiptSha256,
      guardianRecoveryRequestId, dependencies,
    );
  }
  const initialFenceEvidence = await assertRecoveryFence();
  journal.append(journal.resumed ? "BARRIER_RECOVERY_RECONCILE_OUTCOME_UNKNOWN" : "BARRIER_RECOVERY_OUTCOME_UNKNOWN", {
    ...journalBindings,
    ...initialFenceEvidence,
    guardianRecoveryRequestId,
  });
  const client = dependencies.migrationClient || new MongoClient(connection.uri, {
    appName: "PadlHubVivaGameProjectionMongoBarrierRecovery",
    maxPoolSize: 1, serverSelectionTimeoutMS: 20_000, connectTimeoutMS: 20_000,
    socketTimeoutMS: 20_000, timeoutMS: 20_000,
  });
  try {
    if (!dependencies.migrationClient) await client.connect();
    const hello = await client.db("admin").command({ hello: 1 });
    if (hello.setName !== plan.mongoTarget?.replicaSetName) fail("Mongo barrier recovery replica set mismatch");
    const boundaryFenceEvidence = await assertRecoveryFence();
    journal.append("FENCE_REVALIDATED_BEFORE_BARRIER_RECOVERY", boundaryFenceEvidence);
    const recovery = await (dependencies.restorePreviousMongoWriteBarrier || restorePreviousMongoWriteBarrier)(client, artifactRead.value, {
      fenceTokenSha256: plan.writerFence?.fenceTokenSha256,
      cutoverPlanSha256: options.expectedCutoverPlanSha256,
      mongoTargetIdentitySha256: plan.mongoTarget?.targetIdentitySha256,
      assertFence: async (phase) => {
        const evidence = await assertRecoveryFence();
        journal.append("FENCE_REVALIDATED_DURING_BARRIER_RECOVERY", { fencePhase: phase, ...evidence });
        return evidence;
      },
    });
    const finalFenceEvidence = await assertRecoveryFence();
    journal.append("FENCE_REVALIDATED_AFTER_BARRIER_RECOVERY", finalFenceEvidence);
    const report = {
      ...recovery,
      barrierArtifactSha256: options.expectedBarrierArtifactSha256,
      cutoverPlanSha256: options.expectedCutoverPlanSha256,
      fenceReceiptSha256: options.expectedFenceReceiptSha256,
      executionIndexSha256: options.expectedExecutionIndexSha256,
      fenceGuardianReceiptSha256: options.expectedFenceGuardianReceiptSha256,
      fenceGuardianHeartbeatSha256: boundaryFenceEvidence.guardianHeartbeatSha256,
      recoveryFenceTakeoverReceiptPath: recoveryFenceTakeover.receiptPath,
      recoveryFenceTakeoverReceiptSha256: recoveryFenceTakeover.receiptSha256,
      recoveryFenceTakeoverHeartbeatSha256: boundaryFenceEvidence.recoveryFenceTakeoverHeartbeatSha256,
      recoveryFenceTakeoverState: "HELD_UNTIL_EXPLICIT_FENCE_RELEASE",
      pm2StateSha256: boundaryFenceEvidence.pm2StateSha256,
      recoveryAttemptId: journal.attemptId,
      recoveryJournalPath: journal.journalDirectory,
      guardianRecoveryRequestId,
      reconciledPriorUnknownOutcome: journal.resumed,
      migrationConnectionFingerprint: connection.connectionFingerprint,
    };
    const reportBytes = journal.appendTerminal(report);
    if (dependencies.writeRecoveryReport) await dependencies.writeRecoveryReport(options.report, reportBytes);
    else writeFileExclusiveAtomicDurable(options.report, reportBytes, privateOptions());
    return report;
  } finally {
    if (!dependencies.migrationClient) await client.close().catch(() => {});
  }
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const values = parseArgs(argv);
  const options = optionsFromValues(values);
  let effectiveDependencies = dependencies;
  if (process.env.PADLHUB_CUTOVER_GUARDIAN_CHILD === "1") {
    const requestId = process.env.PADLHUB_CUTOVER_GUARDIAN_RECOVERY_REQUEST_ID;
    const prestartedFenceTakeover = await startRecoveryFenceTakeoverBeforeAcceptance(
      options, requestId, dependencies,
    );
    announceFenceGuardianRecoveryTakeoverEstablished({
      requestId,
      receiptPath: prestartedFenceTakeover.receiptPath,
      receiptSha256: prestartedFenceTakeover.receiptSha256,
    });
    acceptFenceGuardianChildRequest({
      childKind: "recovery",
      requestId,
    });
    effectiveDependencies = { ...dependencies, prestartedFenceTakeover };
  }
  const result = process.env.PADLHUB_CUTOVER_GUARDIAN_CHILD === "1" || effectiveDependencies.forceDirectRecovery
    ? await recoverVivaGameProjectionMongoWriteBarrier(options, effectiveDependencies)
    : await requestRecoveryFromGuardian(argv, options, effectiveDependencies);
  process.stdout.write(`${JSON.stringify({ state: result.state })}\n`);
  return result;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === SCRIPT_PATH) {
  if (process.argv.slice(2).includes("--help")) {
    process.stdout.write("Usage: node scripts/recover_viva_game_projection_mongo_write_barrier.mjs --barrier-artifact /private/barrier.json.prepared --expected-barrier-artifact-sha256 SHA256 --cutover-plan /private/packet/cutover-plan.json --expected-cutover-plan-sha256 SHA256 --execution-index /private/execution-index.json --expected-execution-index-sha256 SHA256 --migration-connection-file /private/migration-mongo.json --fence-receipt /private/fence.json --expected-fence-receipt-sha256 SHA256 --fence-guardian-receipt /private/guardian.json --expected-fence-guardian-receipt-sha256 SHA256 --fence-guardian-recovery-request /private/guardian-recovery-request.json --report /private/new-recovery-report.json\n");
  } else main().catch((error) => {
    process.stderr.write(`${String(error?.message || error).replace(/mongodb(?:\+srv)?:\/\/[^\s]+/gi, "[REDACTED_MONGO_URI]").slice(0, 500)}\n`);
    process.exitCode = 1;
  });
}
