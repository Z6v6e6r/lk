#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BSON, MongoClient } from "mongodb";

import { canonicalJson, sha256 } from "./lib/vivaGameProjectionCutoverContract.mjs";
import { prepareVivaGameProjectionCutoverPostcheck } from "./prepare_viva_game_projection_cutover_postcheck.mjs";
import {
  assertExclusiveFenceLease,
  createDurableReportJournal,
  ensurePrivateDirectory,
  main as runMigration,
  readPrivateBytes,
  readPrivateJson,
  readFlowConnection,
  readPrivateMongoConnection,
  validateHeldWriterFence,
} from "./run_viva_game_projection_tenant_migration.mjs";
import {
  assertMongoWriteBarrier,
  hashFullCollectionDocuments,
  hashLiveFullCollection,
  installMongoWriteBarrier,
} from "./lib/vivaGameProjectionMongoWriteBarrier.mjs";
import {
  atomicWrite,
  validateReviewedFlowContract,
  writeFileExclusiveAtomicDurable,
} from "./nodered_reviewed_flow_deploy/runtime_contract.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const CONFIRMATION = "EXECUTE_VIVA_GAME_PROJECTION_CUTOVER_V1";
const HASH_RE = /^[a-f0-9]{64}$/;
const MAX_JSON_BYTES = 64 * 1024 * 1024;
const fail = (message) => { throw new Error(message); };
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

const parseArgs = (argv) => {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--") || values.has(key)) {
      fail(`Invalid argument: ${key || ""}`);
    }
    values.set(key, value);
  }
  for (const key of ["--execution-index", "--expected-execution-index-sha256", "--report"]) {
    if (!values.get(key)) fail(`Missing ${key}`);
  }
  return values;
};

const assertHash = (value, label) => {
  if (!HASH_RE.test(String(value || ""))) fail(`${label} must be a SHA-256 digest`);
};

const assertPacketFile = (packetRoot, requestedPath, expectedRelativePath, label) => {
  const actual = fs.realpathSync(requestedPath);
  const expected = path.join(packetRoot, expectedRelativePath);
  if (actual !== expected) fail(`${label} is outside the exact packet`);
  return actual;
};

const runPm2 = (args) => {
  const result = spawnSync("pm2", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) fail(`PM2 command failed: pm2 ${args.join(" ")}`);
  return result.stdout;
};

const pm2Entry = (processName) => {
  let rows;
  try { rows = JSON.parse(runPm2(["jlist"])); } catch { fail("PM2 process list is invalid"); }
  const matches = Array.isArray(rows) ? rows.filter((row) => row?.name === processName) : [];
  if (matches.length !== 1) fail("Expected exactly one PM2 process during cutover");
  return matches[0];
};

const protectedOptions = () => ({
  uid: typeof process.getuid === "function" ? process.getuid() : 0,
  gid: typeof process.getgid === "function" ? process.getgid() : 0,
  mode: 0o600,
});

const writePrivate = (filePath, value) => {
  const bytes = Buffer.from(canonicalJson(value));
  writeFileExclusiveAtomicDurable(filePath, bytes, protectedOptions());
  return { bytes, sha256: sha256(bytes) };
};

export async function executeVivaGameProjectionCutover(options, dependencies = {}) {
  const coordinatorAttemptId = dependencies.attemptId || crypto.randomUUID();
  if ((dependencies.getUid ? dependencies.getUid() : process.getuid?.()) !== 0) fail("Cutover coordinator requires root");
  if (process.env.VIVA_GAME_PROJECTION_CUTOVER_EXECUTE !== CONFIRMATION) fail("Cutover execution confirmation is absent");
  const executionRead = readPrivateJson(options.executionIndex, "Cutover execution index", MAX_JSON_BYTES);
  assertHash(options.expectedExecutionIndexSha256, "Expected execution-index digest");
  if (sha256(executionRead.bytes) !== options.expectedExecutionIndexSha256) fail("Cutover execution-index digest mismatch");
  const execution = executionRead.value;
  if (!isObject(execution) || execution.formatVersion !== 1
    || execution.kind !== "viva-game-projection-cutover-execution-index"
    || !Array.isArray(execution.items) || execution.items.length === 0
    || !path.isAbsolute(String(execution.migrationConnectionFile || ""))
    || !path.isAbsolute(String(execution.mongoWriteBarrierReceiptOutputPath || ""))) {
    fail("Cutover execution index contract mismatch");
  }
  for (const key of ["cutoverPlanSha256", "packetManifestSha256", "fenceReceiptSha256", "migrationConnectionFileSha256"]) {
    assertHash(execution[key], `Execution index ${key}`);
  }
  const cutoverRead = readPrivateJson(execution.cutoverPlanPath, "Cutover plan", MAX_JSON_BYTES);
  const manifestRead = readPrivateJson(execution.packetManifestPath, "Packet manifest", MAX_JSON_BYTES);
  const fenceRead = readPrivateJson(execution.fenceReceiptPath, "Writer fence receipt", MAX_JSON_BYTES);
  if (sha256(cutoverRead.bytes) !== execution.cutoverPlanSha256
    || sha256(manifestRead.bytes) !== execution.packetManifestSha256
    || sha256(fenceRead.bytes) !== execution.fenceReceiptSha256) {
    fail("Cutover execution inputs changed after approval");
  }
  const plan = cutoverRead.value;
  if (plan?.kind !== "viva-game-projection-tenant-cutover-plan"
    || plan.state !== "READY_FOR_SEPARATE_LIVE_APPROVAL" || plan.liveMutationAuthorized !== false
    || sha256(String(execution.tenantKey || "")) !== plan.tenantKeySha256) {
    fail("Cutover plan is not eligible for separately confirmed execution");
  }
  const packetRoot = fs.realpathSync(path.dirname(execution.cutoverPlanPath));
  if (fs.realpathSync(path.dirname(execution.packetManifestPath)) !== packetRoot) fail("Packet manifest root mismatch");
  const candidatePath = assertPacketFile(packetRoot, execution.candidatePath, "candidate.flow.json", "Candidate flow");
  const contractPath = assertPacketFile(packetRoot, execution.reviewedFlowContractPath, "reviewed-flow.contract.json", "Reviewed-flow contract");
  const liveFlowPath = fs.realpathSync(execution.liveFlowPath);
  if (liveFlowPath !== "/root/.node-red/flows.json" && !dependencies.allowFixturePaths) fail("Live flow path is not canonical production flow");
  if (os.hostname() !== plan.production?.hostname && !dependencies.allowFixtureHostname) fail("Cutover host differs from the approved production host");

  validateHeldWriterFence(fenceRead.value, {
    sourceFlowSha256: plan.sourceFlowSha256,
    candidateSha256: plan.candidateSha256,
    tenantKey: execution.tenantKey,
    expectedOperationIds: plan.writerFence?.exactMigrationOperationIds,
    expectedWriterNodeIds: plan.writerFence?.exactWriterNodeIds,
    writerInventorySha256: plan.writerFence?.writerInventorySha256,
    externalWriterProofSha256: plan.writerFence?.externalWriterProofSha256,
    fenceTokenSha256: plan.writerFence?.fenceTokenSha256,
    lockPath: plan.writerFence?.lockPath,
    nowMs: dependencies.nowMs ?? Date.now(),
  });
  if (dependencies.assertFenceLease) dependencies.assertFenceLease(fenceRead.value);
  else assertExclusiveFenceLease(fenceRead.value);
  const guardianPath = String(process.env.PADLHUB_CUTOVER_GUARDIAN_RECEIPT || "");
  const guardianPid = Number(process.env.PADLHUB_CUTOVER_GUARDIAN_PID);
  const guardianRead = dependencies.guardianReceipt || readPrivateJson(guardianPath, "Fence guardian receipt", 1024 * 1024);
  const guardian = guardianRead.value || guardianRead;
  if (guardian?.kind !== "viva-game-projection-fence-guardian-receipt"
    || guardian.state !== "HOLDING_UNTIL_EXPLICIT_RELEASE" || guardian.pid !== guardianPid
    || guardian.lockPath !== plan.writerFence.lockPath
    || guardian.fenceTokenSha256 !== plan.writerFence.fenceTokenSha256 || guardian.automaticRelease !== false) {
    fail("Persistent fence guardian does not bind the cutover fence");
  }
  if (!dependencies.guardianReceipt) {
    try { process.kill(guardianPid, 0); } catch { fail("Persistent fence guardian is not alive"); }
  }
  const guardianReceiptSha256 = dependencies.guardianReceipt
    ? sha256(canonicalJson(guardian)) : sha256(guardianRead.bytes);

  const expectedPlans = new Set(plan.migration.planSha256s);
  for (const item of execution.items) {
    if (!expectedPlans.delete(item?.planSha256)) fail("Execution index plan set mismatch");
    assertPacketFile(packetRoot, item.planPath, path.join("migration-plans", path.basename(item.planPath)), "Migration plan");
    ensurePrivateDirectory(item.backupDirectory, "Migration backup directory");
    const reportPath = path.resolve(item.reportPath);
    ensurePrivateDirectory(path.dirname(reportPath), "Migration report directory");
    if (reportPath !== item.reportPath || fs.existsSync(reportPath) || fs.existsSync(`${reportPath}.journal`)) {
      fail("Migration report path is not a new canonical path");
    }
  }
  if (expectedPlans.size !== 0) fail("Execution index omits a migration plan");

  const coordinatorReportPath = path.resolve(options.report);
  const applyIndexPath = path.resolve(execution.applyIndexOutputPath);
  const flowBackupDirectory = ensurePrivateDirectory(execution.flowBackupDirectory, "Flow backup directory");
  const postcheckOutputDirectory = ensurePrivateDirectory(execution.postcheckOutputDirectory, "Postcheck output directory");
  const barrierReceiptPath = path.resolve(execution.mongoWriteBarrierReceiptOutputPath);
  ensurePrivateDirectory(path.dirname(barrierReceiptPath), "Mongo write-barrier receipt directory");
  const migrationConnectionBytes = readPrivateBytes(execution.migrationConnectionFile, "Migration Mongo connection", 1024 * 1024);
  if (sha256(migrationConnectionBytes) !== execution.migrationConnectionFileSha256) fail("Migration Mongo connection file digest mismatch");
  ensurePrivateDirectory(path.dirname(coordinatorReportPath), "Coordinator report directory");
  ensurePrivateDirectory(path.dirname(applyIndexPath), "Apply-index directory");
  if (coordinatorReportPath !== options.report || applyIndexPath !== execution.applyIndexOutputPath
    || postcheckOutputDirectory !== execution.postcheckOutputDirectory
    || barrierReceiptPath !== execution.mongoWriteBarrierReceiptOutputPath
    || fs.existsSync(coordinatorReportPath) || fs.existsSync(applyIndexPath) || fs.existsSync(barrierReceiptPath)
    || fs.existsSync(`${barrierReceiptPath}.prepared`)
    || fs.readdirSync(postcheckOutputDirectory).length !== 0) {
    fail("Cutover output paths must be new, canonical, and private");
  }
  const flowBackupPath = path.join(flowBackupDirectory, `flows-pre-viva-projection-${execution.cutoverPlanSha256}.json`);
  if (fs.existsSync(flowBackupPath)) fail("Cutover flow backup already exists");

  const currentFlowBytes = readPrivateBytes(liveFlowPath, "Live source flow", MAX_JSON_BYTES);
  const candidateBytes = readPrivateBytes(candidatePath, "Candidate flow", MAX_JSON_BYTES);
  const contractBytes = readPrivateBytes(contractPath, "Reviewed-flow contract", MAX_JSON_BYTES);
  if (sha256(currentFlowBytes) !== plan.sourceFlowSha256 || sha256(candidateBytes) !== plan.candidateSha256) {
    fail("Live source or candidate digest differs from the cutover plan");
  }
  let reviewedContract;
  try { reviewedContract = JSON.parse(contractBytes.toString("utf8")); } catch { fail("Reviewed-flow contract is invalid"); }
  validateReviewedFlowContract({ liveBytes: currentFlowBytes, candidateBytes, contract: reviewedContract });
  if (reviewedContract.sourceSha256 !== plan.sourceFlowSha256 || reviewedContract.candidateSha256 !== plan.candidateSha256) {
    fail("Reviewed-flow contract differs from the cutover plan");
  }

  const initialPm2 = dependencies.inspectPm2 ? await dependencies.inspectPm2() : pm2Entry(plan.production.processName);
  if (initialPm2?.pm_id !== plan.production.pm2ProcessId
    || String(initialPm2?.pm2_env?.status || "").toLowerCase() !== "stopped"
    || sha256(String(initialPm2?.pm2_env?.PADLHUB_PLATFORM_TENANT_KEY || initialPm2?.pm2_env?.env?.PADLHUB_PLATFORM_TENANT_KEY || "")) !== plan.tenantKeySha256
    || String(initialPm2?.pm2_env?.VIVA_GAME_PROJECTION_SYNC_MODE || initialPm2?.pm2_env?.env?.VIVA_GAME_PROJECTION_SYNC_MODE || "") !== "SHADOW") {
    fail("Node-RED is not stopped with the exact tenant and SHADOW mode at cutover start");
  }

  let candidatePublished = false;
  let applyIndexArtifact = null;
  let barrierArtifact = null;
  let barrierPreparationArtifact = null;
  let barrierInstallAttempted = false;
  let appliedItems = [];
  let inFlightPlanSha256 = null;
  const coordinatorJournal = createDurableReportJournal(coordinatorReportPath, "cutover", coordinatorAttemptId);
  try {
    const applicationConnection = readFlowConnection(liveFlowPath, plan.sourceFlowSha256);
    const migrationConnection = readPrivateMongoConnection(
      execution.migrationConnectionFile, plan.mongoTarget.migrationConnectionFingerprint,
    );
    const applicationClient = dependencies.applicationMongoClient || new MongoClient(applicationConnection.uri, {
      appName: "PadlHubVivaGameCutoverBarrierApplicationProbe", maxPoolSize: 1,
      serverSelectionTimeoutMS: 20_000, connectTimeoutMS: 20_000, socketTimeoutMS: 20_000, timeoutMS: 20_000,
    });
    const migrationClient = dependencies.migrationMongoClient || new MongoClient(migrationConnection.uri, {
      appName: "PadlHubVivaGameCutoverBarrierMigration", maxPoolSize: 1,
      serverSelectionTimeoutMS: 20_000, connectTimeoutMS: 20_000, socketTimeoutMS: 20_000, timeoutMS: 20_000,
    });
    try {
      if (!dependencies.applicationMongoClient) await applicationClient.connect();
      if (!dependencies.migrationMongoClient) await migrationClient.connect();
      barrierInstallAttempted = true;
      const barrierReceipt = dependencies.installMongoWriteBarrier
        ? await dependencies.installMongoWriteBarrier({ applicationClient, migrationClient })
        : await installMongoWriteBarrier({
          applicationClient,
          migrationClient,
          applicationConnectionFingerprint: applicationConnection.connectionFingerprint,
          migrationConnectionFingerprint: migrationConnection.connectionFingerprint,
          replicaSetName: plan.mongoTarget.replicaSetName,
          fenceTokenSha256: plan.writerFence.fenceTokenSha256,
          cutoverPlanSha256: execution.cutoverPlanSha256,
          beforeInstall: async (preparation) => {
            barrierPreparationArtifact = writePrivate(`${barrierReceiptPath}.prepared`, preparation);
            coordinatorJournal.append("MONGO_WRITE_BARRIER_PREPARED", { receiptSha256: barrierPreparationArtifact.sha256 });
          },
        });
      barrierArtifact = writePrivate(barrierReceiptPath, barrierReceipt);
      coordinatorJournal.append("MONGO_WRITE_BARRIER_HELD", { receiptSha256: barrierArtifact.sha256 });
      const backupPath = assertPacketFile(packetRoot, path.join(packetRoot, "evidence/full-backup.ejson"), "evidence/full-backup.ejson", "Full backup");
      const backupBytes = readPrivateBytes(backupPath, "Full backup", 1024 * 1024 * 1024);
      let backupDocuments;
      try { backupDocuments = BSON.EJSON.parse(backupBytes.toString("utf8"), { relaxed: false }); } catch { fail("Full backup is invalid canonical EJSON"); }
      const backupState = hashFullCollectionDocuments(backupDocuments);
      const liveState = dependencies.hashLiveFullCollection
        ? await dependencies.hashLiveFullCollection(migrationClient.db("games").collection("lk_games"))
        : await hashLiveFullCollection(migrationClient.db("games").collection("lk_games"));
      if (sha256(backupBytes) !== plan.evidence.backupSha256
        || backupState.documentCount !== liveState.documentCount
        || backupState.fullCollectionStateSha256 !== plan.evidence.fullCollectionStateSha256
        || liveState.fullCollectionStateSha256 !== plan.evidence.fullCollectionStateSha256) {
        fail("Live games.lk_games state does not exactly match the full backup under the Mongo barrier");
      }
      coordinatorJournal.append("FULL_BACKUP_MATCHED_LIVE_COLLECTION", liveState);
      const barrierReadback = readPrivateJson(barrierReceiptPath, "Mongo write-barrier receipt", MAX_JSON_BYTES);
      if (sha256(barrierReadback.bytes) !== barrierArtifact.sha256) fail("Mongo write-barrier receipt readback mismatch");
      if (dependencies.assertMongoWriteBarrier) await dependencies.assertMongoWriteBarrier(barrierReadback.value);
      else await assertMongoWriteBarrier(migrationClient.db("games"), barrierReadback.value, {
        fenceTokenSha256: plan.writerFence.fenceTokenSha256,
        cutoverPlanSha256: execution.cutoverPlanSha256,
        mongoTargetIdentitySha256: plan.mongoTarget.targetIdentitySha256,
      });
    } finally {
      if (!dependencies.applicationMongoClient) await applicationClient.close().catch(() => {});
      if (!dependencies.migrationMongoClient) await migrationClient.close().catch(() => {});
    }

    for (const item of execution.items) {
      inFlightPlanSha256 = item.planSha256;
      const migrationArgs = [
        "--mode", "apply",
        "--plan", item.planPath,
        "--cutover-plan", execution.cutoverPlanPath,
        "--packet-manifest", execution.packetManifestPath,
        "--expected-plan-sha256", item.planSha256,
        "--expected-cutover-plan-sha256", execution.cutoverPlanSha256,
        "--expected-packet-manifest-sha256", execution.packetManifestSha256,
        "--expected-source-flow-sha256", plan.sourceFlowSha256,
        "--expected-runtime-flow-sha256", plan.sourceFlowSha256,
        "--flow-path", liveFlowPath,
        "--fence-receipt", execution.fenceReceiptPath,
        "--mongo-write-barrier-receipt", barrierReceiptPath,
        "--migration-connection-file", execution.migrationConnectionFile,
        "--backup-dir", item.backupDirectory,
        "--report", item.reportPath,
      ];
      const result = dependencies.runMigration
        ? await dependencies.runMigration(migrationArgs)
        : await runMigration(migrationArgs);
      if (result?.mode !== "APPLY" || result.outcome !== "SUCCEEDED") fail("Migration apply did not succeed exactly");
      const reportBytes = readPrivateBytes(item.reportPath, "Migration apply report", MAX_JSON_BYTES);
      appliedItems.push({
        planPath: item.planPath,
        planSha256: item.planSha256,
        reportPath: item.reportPath,
        reportSha256: sha256(reportBytes),
        backupPath: result.backupPath,
        backupSha256: result.backupSha256,
      });
      coordinatorJournal.append("MIGRATION_PLAN_APPLIED", {
        planSha256: item.planSha256, reportSha256: sha256(reportBytes), backupSha256: result.backupSha256,
      });
      inFlightPlanSha256 = null;
    }
    applyIndexArtifact = writePrivate(applyIndexPath, {
      formatVersion: 1,
      kind: "viva-game-projection-cutover-apply-index",
      cutoverPlanSha256: execution.cutoverPlanSha256,
      tenantKey: execution.tenantKey,
      items: appliedItems,
    });

    writeFileExclusiveAtomicDurable(flowBackupPath, currentFlowBytes, protectedOptions());
    if (sha256(fs.readFileSync(liveFlowPath)) !== plan.sourceFlowSha256) fail("Live flow drifted before candidate publication");
    coordinatorJournal.append("CANDIDATE_PUBLICATION_OUTCOME_UNKNOWN", { flowBackupPath });
    if (dependencies.publishCandidate) await dependencies.publishCandidate(liveFlowPath, candidateBytes);
    else atomicWrite(liveFlowPath, candidateBytes, { uid: 0, gid: 0 });
    candidatePublished = true;
    if (sha256(fs.readFileSync(liveFlowPath)) !== plan.candidateSha256) fail("Candidate flow readback failed");
    coordinatorJournal.append("CANDIDATE_PUBLISHED", { candidateSha256: plan.candidateSha256 });
    coordinatorJournal.append("RUNTIME_RESTART_OUTCOME_UNKNOWN");
    if (dependencies.restartNodeRed) await dependencies.restartNodeRed({
      PADLHUB_PLATFORM_TENANT_KEY: execution.tenantKey, VIVA_GAME_PROJECTION_SYNC_MODE: "SHADOW",
    });
    else {
      const restart = spawnSync("pm2", ["restart", plan.production.processName, "--update-env"], {
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PADLHUB_PLATFORM_TENANT_KEY: execution.tenantKey, VIVA_GAME_PROJECTION_SYNC_MODE: "SHADOW" },
      });
      if (restart.status !== 0) fail("PM2 restart with pinned SHADOW environment failed");
    }
    const activePm2 = dependencies.inspectPm2 ? await dependencies.inspectPm2() : pm2Entry(plan.production.processName);
    if (activePm2?.pm_id !== plan.production.pm2ProcessId
      || String(activePm2?.pm2_env?.status || "").toLowerCase() !== "online"
      || sha256(String(activePm2?.pm2_env?.PADLHUB_PLATFORM_TENANT_KEY || activePm2?.pm2_env?.env?.PADLHUB_PLATFORM_TENANT_KEY || "")) !== plan.tenantKeySha256
      || String(activePm2?.pm2_env?.VIVA_GAME_PROJECTION_SYNC_MODE || activePm2?.pm2_env?.env?.VIVA_GAME_PROJECTION_SYNC_MODE || "").toUpperCase() !== "SHADOW") {
      fail("Node-RED candidate did not become online");
    }
    coordinatorJournal.append("RUNTIME_ONLINE_SHADOW", { candidateSha256: plan.candidateSha256 });
    const postcheckResult = await prepareVivaGameProjectionCutoverPostcheck({
      cutoverPlan: execution.cutoverPlanPath,
      packetManifest: execution.packetManifestPath,
      expectedCutoverPlanSha256: execution.cutoverPlanSha256,
      expectedPacketManifestSha256: execution.packetManifestSha256,
      applyIndex: applyIndexPath,
      expectedApplyIndexSha256: applyIndexArtifact.sha256,
      runtimeFlow: liveFlowPath,
      fenceReceipt: execution.fenceReceiptPath,
      expectedFenceReceiptSha256: execution.fenceReceiptSha256,
      mongoWriteBarrierReceipt: barrierReceiptPath,
      expectedMongoWriteBarrierReceiptSha256: barrierArtifact.sha256,
      migrationConnectionFile: execution.migrationConnectionFile,
      executionIndex: options.executionIndex,
      expectedExecutionIndexSha256: options.expectedExecutionIndexSha256,
      coordinatorAttemptId,
      fenceGuardianReceiptSha256: guardianReceiptSha256,
      fenceGuardianReceipt: guardianPath,
      outputDirectory: postcheckOutputDirectory,
    }, dependencies.postcheckDependencies || {});
    const result = {
      formatVersion: 1,
      kind: "viva-game-projection-cutover-coordinator-report",
      state: "POSTCHECK_PASS_INGRESS_STILL_BLOCKED",
      cutoverPlanSha256: execution.cutoverPlanSha256,
      applyIndexSha256: applyIndexArtifact.sha256,
      activeFlowSha256: plan.candidateSha256,
      readyMarkerSha256: postcheckResult.readyMarkerSha256,
      mongoWriteBarrierReceiptSha256: barrierArtifact.sha256,
      mongoWriteBarrierState: "HELD",
      fenceGuardianReceiptSha256: guardianReceiptSha256,
      coordinatorAttemptId,
      ingressReopened: false,
      completedAt: new Date(dependencies.nowMs ?? Date.now()).toISOString(),
    };
    coordinatorJournal.finalize(result);
    return result;
  } catch (error) {
    let runtimeStopped = !candidatePublished;
    let stopError = null;
    if (candidatePublished) {
      try {
        if (dependencies.stopNodeRed) await dependencies.stopNodeRed();
        else runPm2(["stop", plan.production.processName]);
        const stoppedPm2 = dependencies.inspectPm2 ? await dependencies.inspectPm2() : pm2Entry(plan.production.processName);
        runtimeStopped = stoppedPm2?.pm_id === plan.production.pm2ProcessId
          && String(stoppedPm2?.pm2_env?.status || "").toLowerCase() === "stopped";
        if (!runtimeStopped) fail("Node-RED stop readback failed after cutover error");
      } catch (caught) { stopError = caught; }
    }
    try {
      coordinatorJournal.finalize({
        formatVersion: 1,
        kind: "viva-game-projection-cutover-coordinator-report",
        state: barrierArtifact
          ? (runtimeStopped ? "FAILED_BARRIERS_HELD_RUNTIME_STOPPED" : "FAILED_MONGO_BARRIER_HELD_RUNTIME_STOP_UNPROVEN")
          : (barrierInstallAttempted ? "FAILED_BARRIER_INSTALL_OUTCOME_UNKNOWN_INGRESS_BLOCKED" : "FAILED_BEFORE_MONGO_BARRIER_INGRESS_BLOCKED"),
        cutoverPlanSha256: execution.cutoverPlanSha256,
        activeFlowSha256: sha256(fs.readFileSync(liveFlowPath)),
        candidatePublished,
        migrationOutcome: error?.migrationResult?.outcome || null,
        appliedPlanSha256s: appliedItems.map((item) => item.planSha256),
        inFlightPlanSha256,
        inFlightPlanOutcome: error?.migrationResult?.outcome || "UNKNOWN_OR_NOT_STARTED",
        mongoWriteBarrierState: barrierArtifact ? "HELD" : (barrierInstallAttempted ? "INSTALL_OUTCOME_UNKNOWN_KEEP_INGRESS_BLOCKED" : "NOT_INSTALLED"),
        mongoWriteBarrierReceiptSha256: barrierArtifact?.sha256 || null,
        mongoWriteBarrierPreparationSha256: barrierPreparationArtifact?.sha256 || null,
        fenceGuardianReceiptSha256: guardianReceiptSha256,
        coordinatorAttemptId,
        runtimeStopped,
        ingressReopened: false,
        failedAt: new Date(dependencies.nowMs ?? Date.now()).toISOString(),
      });
    } catch { /* per-plan durable journals and the unchanged ingress fence remain authoritative */ }
    if (stopError) fail(`Cutover failed and runtime stop is unproven: ${String(stopError?.message || stopError)}`);
    throw error;
  }
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const values = parseArgs(argv);
  const result = await executeVivaGameProjectionCutover({
    executionIndex: values.get("--execution-index"),
    expectedExecutionIndexSha256: values.get("--expected-execution-index-sha256"),
    report: values.get("--report"),
  }, dependencies);
  process.stdout.write(`${JSON.stringify({ state: result.state, ingressReopened: false })}\n`);
  return result;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === SCRIPT_PATH) {
  if (process.argv.slice(2).includes("--help")) {
    process.stdout.write("Usage: scripts/run_viva_game_projection_cutover.sh --execution-index /private/execution-index.json --expected-execution-index-sha256 SHA256 --report /private/new-cutover-report.json\n");
  } else {
    main().catch((error) => {
      process.stderr.write(`${String(error instanceof Error ? error.message : error).replace(/mongodb(?:\+srv)?:\/\/[^\s]+/gi, "[REDACTED_MONGO_URI]").slice(0, 500)}\n`);
      process.exitCode = 1;
    });
  }
}
