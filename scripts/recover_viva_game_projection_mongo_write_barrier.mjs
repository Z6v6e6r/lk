#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
  ensurePrivateDirectory,
  readPrivateBytes,
  readPrivateJson,
  readPrivateMongoConnection,
  validateHeldWriterFence,
} from "./run_viva_game_projection_tenant_migration.mjs";
import { writeFileExclusiveAtomicDurable } from "./nodered_reviewed_flow_deploy/runtime_contract.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const CONFIRMATION = "RECOVER_VIVA_GAME_PROJECTION_MONGO_WRITE_BARRIER_V1";
const HASH_RE = /^[a-f0-9]{64}$/;
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

const openRecoveryJournal = (reportPath, bindings, dynamicEvidence) => {
  const journalDirectory = `${reportPath}.journal`;
  if (fs.existsSync(reportPath)) fail("Mongo barrier recovery report must be new");
  let attemptId;
  let sequence;
  let resumed = false;
  if (!fs.existsSync(journalDirectory)) {
    fs.mkdirSync(journalDirectory, { mode: 0o700 });
    fs.chmodSync(journalDirectory, 0o700);
    syncDirectory(path.dirname(journalDirectory));
    attemptId = crypto.randomUUID();
    sequence = 0;
  } else {
    const canonical = fs.realpathSync(journalDirectory);
    const stat = fs.lstatSync(canonical);
    if (canonical !== path.resolve(journalDirectory) || !stat.isDirectory() || stat.isSymbolicLink()
      || stat.uid !== privateOptions().uid || (stat.mode & 0o077) !== 0) {
      fail("Mongo barrier recovery journal is not private and canonical");
    }
    const names = fs.readdirSync(canonical).sort();
    const entries = names.map((name, index) => {
      if (!new RegExp(`^${String(index).padStart(4, "0")}-[a-z0-9-]+\\.json$`).test(name)) {
        fail("Mongo barrier recovery journal sequence is incomplete");
      }
      return readPrivateJson(path.join(canonical, name), "Mongo barrier recovery journal", 1024 * 1024).value;
    });
    attemptId = entries[0]?.attemptId;
    if (!attemptId || entries.length < 2 || entries.some((entry, index) => entry?.formatVersion !== 1
      || entry?.attemptId !== attemptId || entry?.mode !== "BARRIER_RECOVERY" || entry?.sequence !== index)
      || entries[0]?.phase !== "ATTEMPT_STARTED" || entries.some((entry) => entry.phase === "TERMINAL_RESULT")
      || !entries.some((entry) => entry.phase === "BARRIER_RECOVERY_OUTCOME_UNKNOWN"
        && Object.entries(bindings).every(([key, value]) => entry[key] === value))) {
      fail("Mongo barrier recovery journal cannot be reconciled to these exact inputs");
    }
    sequence = entries.length;
    resumed = true;
  }
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
  append(resumed ? "BARRIER_RECOVERY_RECONCILE_OUTCOME_UNKNOWN" : "BARRIER_RECOVERY_OUTCOME_UNKNOWN", {
    ...bindings, ...dynamicEvidence,
  });
  return { attemptId, journalDirectory, resumed, append };
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
    "--fence-guardian-receipt", "--expected-fence-guardian-receipt-sha256", "--report",
  ]) if (!values.get(key)) fail(`Missing ${key}`);
  return values;
};

export async function recoverVivaGameProjectionMongoWriteBarrier(options, dependencies = {}) {
  if ((dependencies.getUid ? dependencies.getUid() : process.getuid?.()) !== 0) fail("Mongo barrier recovery requires root");
  if (process.env.VIVA_GAME_PROJECTION_MONGO_BARRIER_RECOVER !== CONFIRMATION) fail("Mongo barrier recovery confirmation is absent");
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
      || currentGuardian?.automaticRelease !== false) {
      fail("Mongo barrier recovery fence receipts do not bind the exact cutover");
    }
    const guardianLease = dependencies.assertGuardianLease
      ? await dependencies.assertGuardianLease(currentGuardian, nowMs)
      : assertLiveFenceGuardian(currentGuardian, nowMs);
    if (!HASH_RE.test(String(guardianLease?.sha256 || ""))) fail("Mongo barrier recovery lacks a fresh guardian heartbeat digest");
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
      guardianHeartbeatSha256: guardianLease.sha256,
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
  const initialFenceEvidence = await assertRecoveryFence();
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
  const journal = openRecoveryJournal(options.report, journalBindings, initialFenceEvidence);
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
    });
    const report = {
      ...recovery,
      barrierArtifactSha256: options.expectedBarrierArtifactSha256,
      fenceReceiptSha256: options.expectedFenceReceiptSha256,
      executionIndexSha256: options.expectedExecutionIndexSha256,
      fenceGuardianReceiptSha256: options.expectedFenceGuardianReceiptSha256,
      fenceGuardianHeartbeatSha256: boundaryFenceEvidence.guardianHeartbeatSha256,
      pm2StateSha256: boundaryFenceEvidence.pm2StateSha256,
      recoveryAttemptId: journal.attemptId,
      recoveryJournalPath: journal.journalDirectory,
      reconciledPriorUnknownOutcome: journal.resumed,
      migrationConnectionFingerprint: connection.connectionFingerprint,
    };
    writeFileExclusiveAtomicDurable(options.report, Buffer.from(canonicalJson(report)), privateOptions());
    journal.append("TERMINAL_RESULT", {
      state: report.state,
      mutationAttempted: true,
      reconciledPriorUnknownOutcome: journal.resumed,
    });
    return report;
  } finally {
    if (!dependencies.migrationClient) await client.close().catch(() => {});
  }
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const values = parseArgs(argv);
  const result = await recoverVivaGameProjectionMongoWriteBarrier({
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
    report: values.get("--report"),
  }, dependencies);
  process.stdout.write(`${JSON.stringify({ state: result.state })}\n`);
  return result;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === SCRIPT_PATH) {
  if (process.argv.slice(2).includes("--help")) {
    process.stdout.write("Usage: node scripts/recover_viva_game_projection_mongo_write_barrier.mjs --barrier-artifact /private/barrier.json.prepared --expected-barrier-artifact-sha256 SHA256 --cutover-plan /private/packet/cutover-plan.json --expected-cutover-plan-sha256 SHA256 --execution-index /private/execution-index.json --expected-execution-index-sha256 SHA256 --migration-connection-file /private/migration-mongo.json --fence-receipt /private/fence.json --expected-fence-receipt-sha256 SHA256 --fence-guardian-receipt /private/guardian.json --expected-fence-guardian-receipt-sha256 SHA256 --report /private/new-recovery-report.json\n");
  } else main().catch((error) => {
    process.stderr.write(`${String(error?.message || error).replace(/mongodb(?:\+srv)?:\/\/[^\s]+/gi, "[REDACTED_MONGO_URI]").slice(0, 500)}\n`);
    process.exitCode = 1;
  });
}
