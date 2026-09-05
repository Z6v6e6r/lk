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
import { writeFileExclusiveAtomicDurable } from "./nodered_reviewed_flow_deploy/runtime_contract.mjs";

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

const assertLiveRecoveryFenceTakeover = (receipt, expected, nowMs = Date.now()) => {
  if (receipt?.formatVersion !== 1
    || receipt?.kind !== "viva-game-projection-recovery-fence-takeover-receipt"
    || receipt?.state !== "HOLDING_UNTIL_EXPLICIT_RELEASE"
    || receipt?.parentGuardianReceiptSha256 !== expected.parentGuardianReceiptSha256
    || receipt?.recoveryRequestId !== expected.recoveryRequestId
    || receipt?.fenceTokenSha256 !== expected.fenceTokenSha256
    || receipt?.lockPath !== expected.lockPath || receipt?.releaseRequestPath !== expected.releaseRequestPath
    || receipt?.automaticRelease !== false || !Number.isSafeInteger(receipt?.pid) || receipt.pid < 1
    || !Number.isSafeInteger(receipt?.fd) || receipt.fd < 3 || !String(receipt?.heartbeatPath || "").startsWith("/")) {
    fail("Recovery fence takeover receipt is invalid");
  }
  try { process.kill(receipt.pid, 0); } catch { fail("Recovery fence takeover is not alive"); }
  if (linuxProcessStartIdentity(receipt.pid) !== receipt.processStartIdentity) fail("Recovery fence takeover PID was reused");
  const descriptorStat = fs.statSync(`/proc/${receipt.pid}/fd/${receipt.fd}`);
  const lockStat = fs.statSync(receipt.lockPath);
  if (String(descriptorStat.dev) !== receipt.lockDevice || String(descriptorStat.ino) !== receipt.lockInode
    || descriptorStat.dev !== lockStat.dev || descriptorStat.ino !== lockStat.ino) {
    fail("Recovery fence takeover no longer holds the canonical lock inode");
  }
  const heartbeatRead = readPrivateJson(receipt.heartbeatPath, "Recovery fence takeover heartbeat", 1024 * 1024);
  const heartbeat = heartbeatRead.value;
  const observedAt = Date.parse(heartbeat?.observedAt);
  if (heartbeat?.formatVersion !== 1
    || heartbeat?.kind !== "viva-game-projection-recovery-fence-takeover-heartbeat"
    || heartbeat?.state !== "HOLDING" || heartbeat?.pid !== receipt.pid || heartbeat?.fd !== receipt.fd
    || heartbeat?.processStartIdentity !== receipt.processStartIdentity || heartbeat?.lockPath !== receipt.lockPath
    || heartbeat?.lockDevice !== receipt.lockDevice || heartbeat?.lockInode !== receipt.lockInode
    || heartbeat?.fenceTokenSha256 !== receipt.fenceTokenSha256
    || heartbeat?.parentGuardianReceiptSha256 !== receipt.parentGuardianReceiptSha256
    || heartbeat?.recoveryRequestId !== receipt.recoveryRequestId || !Number.isSafeInteger(heartbeat?.sequence)
    || !Number.isFinite(observedAt) || observedAt > nowMs + 1_000 || nowMs - observedAt > 5_000) {
    fail("Recovery fence takeover heartbeat is stale or invalid");
  }
  return { heartbeat, bytes: heartbeatRead.bytes, sha256: sha256(heartbeatRead.bytes) };
};

const startRecoveryFenceTakeover = async (options, guardian, guardianReceiptSha256, requestId, dependencies) => {
  if (dependencies.startFenceTakeover) {
    return dependencies.startFenceTakeover({ options, guardian, guardianReceiptSha256, requestId });
  }
  const paths = takeoverPaths(options, requestId);
  if (fs.existsSync(paths.receiptPath) || fs.existsSync(paths.heartbeatPath)) fail("Recovery fence takeover outputs must be new");
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
    "--parent-guardian-receipt-sha256", guardianReceiptSha256,
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
  const expected = {
    parentGuardianReceiptSha256: guardianReceiptSha256,
    recoveryRequestId: requestId,
    fenceTokenSha256: guardian.fenceTokenSha256,
    lockPath: guardian.lockPath,
    releaseRequestPath: guardian.releaseRequestPath,
  };
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

const openRecoveryJournal = (reportPath, bindings) => {
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
    const names = fs.readdirSync(canonical).sort();
    entries = names.map((name, index) => {
      if (!new RegExp(`^${String(index).padStart(4, "0")}-[a-z0-9-]+\\.json$`).test(name)) {
        fail("Mongo barrier recovery journal sequence is incomplete");
      }
      return readPrivateJson(path.join(canonical, name), "Mongo barrier recovery journal", 1024 * 1024).value;
    });
    attemptId = entries[0]?.attemptId;
    if ((entries.length > 0 && !attemptId) || entries.some((entry, index) => entry?.formatVersion !== 1
      || entry?.attemptId !== attemptId || entry?.mode !== "BARRIER_RECOVERY" || entry?.sequence !== index)
      || (entries.length > 0 && (entries[0]?.phase !== "ATTEMPT_STARTED"
        || Object.entries(bindings).some(([key, value]) => entries[0]?.[key] !== value)))
      || entries.filter((entry) => entry.phase === "TERMINAL_RESULT").length > 1
      || entries.some((entry, index) => entry.phase === "TERMINAL_RESULT" && index !== entries.length - 1)) {
      fail("Mongo barrier recovery journal cannot be reconciled to these exact inputs");
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
    append("TERMINAL_RESULT", {
      state: report.state,
      mutationAttempted: true,
      reconciledPriorUnknownOutcome: report.reconciledPriorUnknownOutcome,
      reportSha256: sha256(reportBytes),
      report,
    });
    return reportBytes;
  };
  const terminal = entries.find((entry) => entry.phase === "TERMINAL_RESULT");
  if (terminal) {
    const reportBytes = validateCompletedRecoveryReport(terminal.report, bindings, attemptId, journalDirectory);
    if (terminal.reportSha256 !== sha256(reportBytes)) fail("Mongo barrier recovery terminal report digest mismatch");
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
  if (fs.existsSync(options.fenceGuardianRecoveryRequest)) fail("Fence guardian recovery-request path must be new");
  const nowMs = typeof dependencies.nowMs === "function" ? dependencies.nowMs() : (dependencies.nowMs ?? Date.now());
  if (dependencies.assertGuardianLease) await dependencies.assertGuardianLease(guardianRead.value, nowMs);
  else assertLiveFenceGuardian(guardianRead.value, nowMs);
  const requestId = dependencies.requestId || crypto.randomUUID();
  if (!UUID_RE.test(String(requestId || ""))) fail("Fence guardian recovery request ID is invalid");
  const request = {
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
    // The request is already authorized. Keep observing this exact request ID
    // instead of returning while the guardian may still accept it.
  }
  const bindings = {
    barrierArtifactSha256: options.expectedBarrierArtifactSha256,
    cutoverPlanSha256: options.expectedCutoverPlanSha256,
    executionIndexSha256: options.expectedExecutionIndexSha256,
    fenceReceiptSha256: options.expectedFenceReceiptSha256,
    fenceGuardianReceiptSha256: options.expectedFenceGuardianReceiptSha256,
  };
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
    if (childFinished && heartbeat.lastRecoveryResult.exitCode !== 0) {
      fail("Fence guardian recovery child failed while the canonical fence remained held");
    }
    if (childFinished && heartbeat.lastRecoveryResult.exitCode === 0
      && !fs.existsSync(options.fenceGuardianRecoveryRequest) && fs.existsSync(options.report)) {
      const journal = openRecoveryJournal(options.report, bindings);
      if (!journal.completedReport) fail("Fence guardian recovery child exited without a durable terminal report");
    }
    if (childFinished && heartbeat.lastRecoveryResult.exitCode === 0
      && !fs.existsSync(options.fenceGuardianRecoveryRequest) && !fs.existsSync(options.report)) {
      fail("Fence guardian recovery child exited without publishing its durable report");
    }
    if (fs.existsSync(options.report)) {
      const journal = openRecoveryJournal(options.report, bindings);
      const completed = journal.completedReport;
      if (!completed) fail("Recovery report exists without a durable terminal journal");
      const completedRequestId = String(completed.guardianRecoveryRequestId || "");
      if (!UUID_RE.test(completedRequestId)) fail("Completed recovery report lacks its guardian request identity");
      const completedTakeoverPaths = takeoverPaths(options, completedRequestId);
      if (completed.recoveryFenceTakeoverState !== "HELD_UNTIL_EXPLICIT_FENCE_RELEASE"
        || completed.recoveryFenceTakeoverReceiptPath !== completedTakeoverPaths.receiptPath
        || !fs.existsSync(completedTakeoverPaths.receiptPath)) {
        fail("Completed recovery report lacks its exact takeover receipt");
      }
      const takeoverRead = readPrivateJson(
        completedTakeoverPaths.receiptPath, "Recovery fence takeover receipt", 1024 * 1024,
      );
      const takeoverExpected = {
        parentGuardianReceiptSha256: options.expectedFenceGuardianReceiptSha256,
        recoveryRequestId: completedRequestId,
        fenceTokenSha256: guardianRead.value.fenceTokenSha256,
        lockPath: guardianRead.value.lockPath,
        releaseRequestPath: guardianRead.value.releaseRequestPath,
      };
      const takeoverLease = dependencies.assertTakeoverLease
        ? await dependencies.assertTakeoverLease(takeoverRead.value, takeoverExpected, pollNowMs)
        : assertLiveRecoveryFenceTakeover(takeoverRead.value, takeoverExpected, pollNowMs);
      if (!HASH_RE.test(String(takeoverLease?.sha256 || ""))) fail("Recovery takeover lacks a fresh heartbeat digest");
      if (completed.recoveryFenceTakeoverReceiptSha256 !== sha256(takeoverRead.bytes)) {
        fail("Recovery takeover does not bind the completed recovery report");
      }
      return completed;
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
  let recoveryFenceTakeover = null;
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
      nowMs,
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
        recoveryRequestId: guardianRecoveryRequestId,
        fenceTokenSha256: currentGuardian.fenceTokenSha256,
        lockPath: currentGuardian.lockPath,
        releaseRequestPath: currentGuardian.releaseRequestPath,
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
      recoveryRequestId: completedRequestId,
      fenceTokenSha256: guardianRead.value.fenceTokenSha256,
      lockPath: guardianRead.value.lockPath,
      releaseRequestPath: guardianRead.value.releaseRequestPath,
    };
    if (dependencies.assertTakeoverLease) {
      await dependencies.assertTakeoverLease(takeoverRead.value, takeoverExpected, Date.now());
    } else assertLiveRecoveryFenceTakeover(takeoverRead.value, takeoverExpected, Date.now());
    return completed;
  }
  await assertRecoveryFence();
  recoveryFenceTakeover = await startRecoveryFenceTakeover(
    options, guardianRead.value, options.expectedFenceGuardianReceiptSha256,
    guardianRecoveryRequestId, dependencies,
  );
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
  const result = process.env.PADLHUB_CUTOVER_GUARDIAN_CHILD === "1" || dependencies.forceDirectRecovery
    ? await recoverVivaGameProjectionMongoWriteBarrier(options, dependencies)
    : await requestRecoveryFromGuardian(argv, options, dependencies);
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
