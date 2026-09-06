#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BSON, MongoClient } from "mongodb";

import { canonicalJson, sha256 } from "./lib/vivaGameProjectionCutoverContract.mjs";
import { buildGlobalActiveLegacyTenantQuery } from "./lib/vivaGameProjectionTenantMigration.mjs";
import { decodeTenantMigrationOperation } from "./lib/vivaGameProjectionTenantMigrationExecution.mjs";
import { assertExactExecutorSources } from "./lib/vivaGameProjectionExecutorSource.mjs";
import { validateExactCutoverPacket } from "./lib/vivaGameProjectionCutoverPacketValidation.mjs";
import { finalizeVivaGameProjectionCutoverReady } from "./finalize_viva_game_projection_cutover_ready.mjs";
import {
  assertLiveFenceGuardian,
  prepareVivaGameProjectionCutoverPostcheck,
} from "./prepare_viva_game_projection_cutover_postcheck.mjs";
import {
  assertExclusiveFenceLease,
  createDurableReportJournal,
  ensurePrivateDirectory,
  main as runMigration,
  readPrivateBytes,
  readPrivateJson,
  readFlowConnection,
  readPrivateMongoConnection,
  recoverDurableTerminalReport,
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
  recoverAtomicExclusivePublication,
  validateReviewedFlowContract,
  writeFileExclusiveAtomicDurable,
} from "./nodered_reviewed_flow_deploy/runtime_contract.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const CONFIRMATION = "EXECUTE_VIVA_GAME_PROJECTION_CUTOVER_V1";
const HASH_RE = /^[a-f0-9]{64}$/;
const MAX_JSON_BYTES = 64 * 1024 * 1024;
const CUTOVER_ONLY_ENV_KEYS = [
  "PADLHUB_CUTOVER_FENCE_TOKEN",
  "PADLHUB_CUTOVER_FENCE_FD",
  "PADLHUB_CUTOVER_FENCE_LOCK_PATH",
  "PADLHUB_CUTOVER_GUARDIAN_RECEIPT",
  "PADLHUB_CUTOVER_GUARDIAN_RELEASE_REQUEST",
  "PADLHUB_CUTOVER_GUARDIAN_RECOVERY_REQUEST",
  "PADLHUB_CUTOVER_GUARDIAN_READY_REQUEST",
  "PADLHUB_CUTOVER_GUARDIAN_HEARTBEAT",
  "PADLHUB_CUTOVER_GUARDIAN_PID",
  "PADLHUB_CUTOVER_GUARDIAN_CHILD",
  "PADLHUB_CUTOVER_GUARDIAN_RECOVERY_REQUEST_ID",
  "PADLHUB_CUTOVER_GUARDIAN_READY_CHILD",
  "PADLHUB_CUTOVER_GUARDIAN_READY_REQUEST_ID",
  "PADLHUB_CUTOVER_GUARDIAN_HANDSHAKE_FD",
  "PADLHUB_CUTOVER_GUARDIAN_CHILD_REQUEST_PATH",
  "PADLHUB_CUTOVER_GUARDIAN_CHILD_ACCEPTED_PATH",
  "PADLHUB_CUTOVER_GUARDIAN_CHILD_REQUEST_SHA256",
  "VIVA_GAME_PROJECTION_CUTOVER_EXECUTE",
  "VIVA_GAME_PROJECTION_MIGRATION_APPLY",
  "VIVA_GAME_PROJECTION_MIGRATION_RESTORE",
  "VIVA_GAME_PROJECTION_MONGO_BARRIER_RECOVER",
  "VIVA_GAME_PROJECTION_READY_FINALIZE",
];
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

const pm2EnvValue = (entry, key) => entry?.pm2_env?.[key] ?? entry?.pm2_env?.env?.[key] ?? null;
const pm2ArraySha256 = (value) => sha256(canonicalJson(Array.isArray(value) ? value : (value == null ? [] : [String(value)])));
const assertPm2RuntimeIdentity = (entry, production) => {
  if (entry?.pm2_env?.pm_exec_path !== production.pmExecPath || entry?.pm2_env?.pm_cwd !== production.pmCwd
    || pm2ArraySha256(entry?.pm2_env?.args) !== production.pmArgsSha256
    || pm2ArraySha256(entry?.pm2_env?.node_args) !== production.pmNodeArgsSha256) {
    fail("PM2 runtime identity differs from the frozen Node-RED service");
  }
};
const assertNoCutoverEnvironment = (entry) => {
  if (CUTOVER_ONLY_ENV_KEYS.some((key) => String(pm2EnvValue(entry, key) || "") !== "")) {
    fail("Node-RED PM2 environment retained cutover-only credentials or confirmations");
  }
};
const probeLocalRuntimeHealth = async (url, expectedCanonicalSha256) => {
  const response = await fetch(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(5_000) });
  const body = Buffer.from(await response.arrayBuffer());
  let flow;
  try { flow = JSON.parse(body.toString("utf8")); } catch { fail("Local Node-RED /flows response is invalid JSON"); }
  const bodyCanonicalSha256 = sha256(canonicalJson(flow));
  if (response.status !== 200 || body.length > 256 * 1024 * 1024 || bodyCanonicalSha256 !== expectedCanonicalSha256) {
    fail("Local Node-RED health probe failed");
  }
  return { url, statusCode: response.status, bodySha256: sha256(body), bodyCanonicalSha256, observedAt: new Date().toISOString() };
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

export const reconstructSuccessfulCoordinatorReport = ({ execution, plan, reportPath }) => {
  const journalDirectory = fs.realpathSync(`${reportPath}.journal`);
  const journalStat = fs.lstatSync(journalDirectory);
  if (journalDirectory !== path.resolve(`${reportPath}.journal`) || !journalStat.isDirectory()
    || journalStat.isSymbolicLink() || (journalStat.mode & 0o077) !== 0
    || (typeof process.getuid === "function" && journalStat.uid !== process.getuid())) {
    fail("Coordinator resume journal is not private and canonical");
  }
  let allNames = fs.readdirSync(journalDirectory).sort();
  for (const name of allNames.filter((entry) => !entry.startsWith("."))) {
    recoverAtomicExclusivePublication(path.join(journalDirectory, name), protectedOptions());
  }
  allNames = fs.readdirSync(journalDirectory).sort();
  const names = allNames.filter((name) => !name.startsWith(".")).sort();
  const entries = [];
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index];
    if (!new RegExp(`^${String(index).padStart(4, "0")}-[a-z0-9-]+\\.json$`).test(name)) {
      fail("Coordinator resume journal sequence is incomplete");
    }
    try {
      entries.push(readPrivateJson(path.join(journalDirectory, name), "Coordinator resume journal", MAX_JSON_BYTES).value);
    } catch (error) {
      if (index !== names.length - 1
        || (!name.endsWith("-terminal-result-intent.json") && !name.endsWith("-terminal-result.json"))) throw error;
    }
  }
  const attemptId = entries[0]?.attemptId;
  if (!attemptId || entries.some((entry, index) => entry?.formatVersion !== 1
    || entry?.attemptId !== attemptId || entry?.mode !== "CUTOVER" || entry?.sequence !== index)) {
    fail("Coordinator resume journal identity mismatch");
  }
  const postcheckIndex = entries.findLastIndex((entry) => entry?.phase === "POSTCHECK_EVIDENCE_PASS_READY_PENDING");
  if (postcheckIndex < 0 || entries.slice(postcheckIndex + 1).some((entry) => (
    !new Set(["TERMINAL_RESULT_INTENT", "TERMINAL_RESULT"]).has(entry?.phase)
  ))) fail("Coordinator resume lacks one durable successful postcheck boundary");
  const postcheckEntry = entries[postcheckIndex];
  const applyIndexRead = readPrivateJson(execution.applyIndexOutputPath, "Coordinator resume apply index", MAX_JSON_BYTES);
  const barrierRead = readPrivateJson(
    execution.mongoWriteBarrierReceiptOutputPath, "Coordinator resume Mongo barrier", MAX_JSON_BYTES,
  );
  const postcheckReceiptRead = readPrivateJson(
    path.join(execution.postcheckOutputDirectory, "postcheck.receipt.json"), "Coordinator resume postcheck receipt", MAX_JSON_BYTES,
  );
  const postcheckManifestRead = readPrivateJson(
    path.join(execution.postcheckOutputDirectory, "postcheck.manifest.json"), "Coordinator resume postcheck manifest", MAX_JSON_BYTES,
  );
  const postcheckReceipt = postcheckReceiptRead.value;
  const postcheckManifest = postcheckManifestRead.value;
  const completedAt = postcheckReceipt?.observedAt;
  const resumeChecks = {
    receiptHash: sha256(postcheckReceiptRead.bytes) === postcheckEntry.postcheckReceiptSha256,
    manifestHash: sha256(postcheckManifestRead.bytes) === postcheckEntry.postcheckManifestSha256,
    receiptKind: postcheckReceipt?.kind === "viva-game-projection-tenant-cutover-postcheck",
    receiptState: postcheckReceipt?.state === "PASS" && postcheckReceipt?.ingressReopened === false,
    receiptAttempt: postcheckReceipt?.coordinatorAttemptId === attemptId,
    receiptCandidate: postcheckReceipt?.candidateSha256 === plan.candidateSha256,
    receiptExecution: postcheckReceipt?.executionIndexSha256 === execution.executionIndexSha256,
    receiptBarrier: postcheckReceipt?.mongoWriteBarrierReceiptSha256 === sha256(barrierRead.bytes),
    manifestKind: postcheckManifest?.kind === "viva-game-projection-cutover-postcheck-manifest",
    manifestState: postcheckManifest?.state === "PASS",
    manifestAttempt: postcheckManifest?.coordinatorAttemptId === attemptId,
    manifestPlan: postcheckManifest?.cutoverPlanSha256 === execution.cutoverPlanSha256,
    manifestApply: postcheckManifest?.applyIndexSha256 === sha256(applyIndexRead.bytes),
    manifestBarrier: postcheckManifest?.mongoWriteBarrierReceiptSha256 === sha256(barrierRead.bytes),
    completionTime: Number.isFinite(Date.parse(completedAt)),
  };
  const failedChecks = Object.entries(resumeChecks).filter(([, passed]) => !passed).map(([name]) => name);
  if (failedChecks.length > 0) {
    fail(`Coordinator resume postcheck artifacts failed: ${failedChecks.join(",")}`);
  }
  return {
    formatVersion: 1,
    kind: "viva-game-projection-cutover-coordinator-report",
    state: "POSTCHECK_PASS_INGRESS_STILL_BLOCKED",
    cutoverPlanSha256: execution.cutoverPlanSha256,
    applyIndexSha256: sha256(applyIndexRead.bytes),
    activeFlowSha256: plan.candidateSha256,
    postcheckReceiptSha256: postcheckEntry.postcheckReceiptSha256,
    postcheckManifestSha256: postcheckEntry.postcheckManifestSha256,
    mongoWriteBarrierReceiptSha256: sha256(barrierRead.bytes),
    mongoWriteBarrierState: "HELD",
    fenceGuardianReceiptSha256: postcheckReceipt.fenceGuardianReceiptSha256,
    coordinatorAttemptId: attemptId,
    ingressReopened: false,
    mutationAttempted: true,
    completedAt,
  };
};

export async function executeVivaGameProjectionCutover(options, dependencies = {}) {
  const coordinatorAttemptId = dependencies.attemptId || crypto.randomUUID();
  const clockNow = () => (typeof dependencies.nowMs === "function" ? dependencies.nowMs() : (dependencies.nowMs ?? Date.now()));
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
  const coordinatorReportPath = path.resolve(options.report);
  if (coordinatorReportPath !== options.report) fail("Coordinator report path is not canonical");
  if (fs.existsSync(`${coordinatorReportPath}.journal`)) {
    ensurePrivateDirectory(path.dirname(coordinatorReportPath), "Coordinator report directory");
    const preparedReport = reconstructSuccessfulCoordinatorReport({
      execution: { ...execution, executionIndexSha256: options.expectedExecutionIndexSha256 },
      plan,
      reportPath: coordinatorReportPath,
    });
    const recovered = recoverDurableTerminalReport(
      coordinatorReportPath, "CUTOVER", null, preparedReport,
    );
    if (canonicalJson(recovered.report) !== canonicalJson(preparedReport)) {
      fail("Recovered coordinator report differs from the durable successful postcheck");
    }
    const guardianPath = String(process.env.PADLHUB_CUTOVER_GUARDIAN_RECEIPT || "");
    const resumedGuardianRead = dependencies.guardianReceipt
      || readPrivateJson(guardianPath, "Fence guardian receipt", 1024 * 1024);
    const resumedGuardian = resumedGuardianRead.value || resumedGuardianRead;
    const readyMarker = await finalizeVivaGameProjectionCutoverReady({
      executionIndex: options.executionIndex,
      expectedExecutionIndexSha256: options.expectedExecutionIndexSha256,
      coordinatorReport: coordinatorReportPath,
      expectedCoordinatorReportSha256: recovered.sha256,
    }, {
      ...dependencies,
      authorizedByCoordinator: true,
      guardianReceipt: resumedGuardian,
    });
    return { ...preparedReport, readyMarkerSha256: readyMarker.readyMarkerSha256, resumed: true };
  }
  if (dependencies.assertExecutorSources) await dependencies.assertExecutorSources(plan);
  else assertExactExecutorSources(plan);
  const packetRoot = fs.realpathSync(path.dirname(execution.cutoverPlanPath));
  if (fs.realpathSync(path.dirname(execution.packetManifestPath)) !== packetRoot) fail("Packet manifest root mismatch");
  if (dependencies.validateExactCutoverPacket) await dependencies.validateExactCutoverPacket({ packetRoot, plan, manifest: manifestRead.value });
  else validateExactCutoverPacket({ packetRoot, plan, manifest: manifestRead.value, nowMs: clockNow() });
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
    nowMs: clockNow(),
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
  const guardianNowMs = clockNow();
  if (dependencies.assertGuardianLease) await dependencies.assertGuardianLease(guardian, guardianNowMs);
  else if (!dependencies.guardianReceipt) assertLiveFenceGuardian(guardian, guardianNowMs);
  const guardianReceiptSha256 = dependencies.guardianReceipt
    ? sha256(canonicalJson(guardian)) : sha256(guardianRead.bytes);
  const assertFreshWriterFence = () => {
    const currentFenceRead = readPrivateJson(execution.fenceReceiptPath, "Writer fence receipt", MAX_JSON_BYTES);
    if (sha256(currentFenceRead.bytes) !== execution.fenceReceiptSha256) fail("Writer fence receipt changed during cutover");
    validateHeldWriterFence(currentFenceRead.value, {
      sourceFlowSha256: plan.sourceFlowSha256,
      candidateSha256: plan.candidateSha256,
      tenantKey: execution.tenantKey,
      expectedOperationIds: plan.writerFence.exactMigrationOperationIds,
      expectedWriterNodeIds: plan.writerFence.exactWriterNodeIds,
      writerInventorySha256: plan.writerFence.writerInventorySha256,
      externalWriterProofSha256: plan.writerFence.externalWriterProofSha256,
      fenceTokenSha256: plan.writerFence.fenceTokenSha256,
      lockPath: plan.writerFence.lockPath,
      nowMs: clockNow(),
    });
    if (dependencies.assertFenceLease) dependencies.assertFenceLease(currentFenceRead.value);
    else assertExclusiveFenceLease(currentFenceRead.value);
    return currentFenceRead.value;
  };

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
  assertPm2RuntimeIdentity(initialPm2, plan.production);

  let candidatePublished = false;
  let applyIndexArtifact = null;
  let barrierArtifact = null;
  let barrierPreparationArtifact = null;
  let barrierInstallAttempted = false;
  let appliedItems = [];
  let inFlightPlanSha256 = null;
  let globalLegacyCoverage = null;
  const readyMarkerPath = path.join(postcheckOutputDirectory, "READY_TO_REOPEN_INGRESS.json");
  let readyPublicationAttempted = false;
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
      assertFreshWriterFence();
      coordinatorJournal.append("FENCE_REVALIDATED_BEFORE_MONGO_BARRIER");
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
          expectedMigrationAuthenticationRestrictions: migrationConnection.authenticationRestrictions,
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
      const coverageDateFrom = plan.migration.futureBoundaryDate;
      const plannedMongoIds = execution.items.flatMap((item) => {
        const migrationPlan = readPrivateJson(item.planPath, "Migration coverage plan", MAX_JSON_BYTES).value;
        return (migrationPlan.operations || []).map((operation) => decodeTenantMigrationOperation(operation).filter._id.toHexString());
      }).sort();
      const liveGlobalRows = await migrationClient.db("games").collection("lk_games")
        .find(buildGlobalActiveLegacyTenantQuery({ dateFrom: coverageDateFrom }), { projection: { _id: 1 } })
        .sort({ _id: 1 }).toArray();
      const liveGlobalMongoIds = liveGlobalRows.map((row) => row?._id?.toHexString?.()).sort();
      if (liveGlobalMongoIds.some((value) => !value)
        || JSON.stringify(liveGlobalMongoIds) !== JSON.stringify(plannedMongoIds)) {
        fail("Frozen migration plans do not cover every active legacy row from the global future boundary");
      }
      globalLegacyCoverage = {
        dateFrom: coverageDateFrom,
        mongoIds: liveGlobalMongoIds,
        mongoIdsSha256: sha256(canonicalJson(liveGlobalMongoIds)),
      };
      coordinatorJournal.append("GLOBAL_LEGACY_SCOPE_COVERED", {
        dateFrom: coverageDateFrom,
        recordCount: liveGlobalMongoIds.length,
        mongoIdsSha256: globalLegacyCoverage.mongoIdsSha256,
      });
      const barrierReadback = readPrivateJson(barrierReceiptPath, "Mongo write-barrier receipt", MAX_JSON_BYTES);
      if (sha256(barrierReadback.bytes) !== barrierArtifact.sha256) fail("Mongo write-barrier receipt readback mismatch");
      if (dependencies.assertMongoWriteBarrier) await dependencies.assertMongoWriteBarrier(barrierReadback.value);
      else await assertMongoWriteBarrier(migrationClient, barrierReadback.value, {
        fenceTokenSha256: plan.writerFence.fenceTokenSha256,
        cutoverPlanSha256: execution.cutoverPlanSha256,
        mongoTargetIdentitySha256: plan.mongoTarget.targetIdentitySha256,
        migrationAuthenticationRestrictions: migrationConnection.authenticationRestrictions,
      });
    } finally {
      if (!dependencies.applicationMongoClient) await applicationClient.close().catch(() => {});
      if (!dependencies.migrationMongoClient) await migrationClient.close().catch(() => {});
    }

    for (const item of execution.items) {
      inFlightPlanSha256 = item.planSha256;
      coordinatorJournal.append("MIGRATION_PLAN_IN_FLIGHT", {
        coordinatorAttemptId,
        planPath: item.planPath,
        planSha256: item.planSha256,
        reportPath: item.reportPath,
        backupDirectory: item.backupDirectory,
      });
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
        coordinatorAttemptId, planSha256: item.planSha256,
        reportPath: item.reportPath, reportSha256: sha256(reportBytes),
        backupPath: result.backupPath, backupSha256: result.backupSha256,
      });
      inFlightPlanSha256 = null;
    }
    applyIndexArtifact = writePrivate(applyIndexPath, {
      formatVersion: 1,
      kind: "viva-game-projection-cutover-apply-index",
      cutoverPlanSha256: execution.cutoverPlanSha256,
      tenantKey: execution.tenantKey,
      globalLegacyCoverage,
      items: appliedItems,
    });

    writeFileExclusiveAtomicDurable(flowBackupPath, currentFlowBytes, protectedOptions());
    assertFreshWriterFence();
    coordinatorJournal.append("FENCE_REVALIDATED_BEFORE_CANDIDATE_PUBLICATION");
    if (sha256(fs.readFileSync(liveFlowPath)) !== plan.sourceFlowSha256) fail("Live flow drifted before candidate publication");
    coordinatorJournal.append("CANDIDATE_PUBLICATION_OUTCOME_UNKNOWN", { flowBackupPath });
    if (dependencies.publishCandidate) await dependencies.publishCandidate(liveFlowPath, candidateBytes);
    else atomicWrite(liveFlowPath, candidateBytes, { uid: 0, gid: 0 });
    candidatePublished = true;
    if (sha256(fs.readFileSync(liveFlowPath)) !== plan.candidateSha256) fail("Candidate flow readback failed");
    coordinatorJournal.append("CANDIDATE_PUBLISHED", { candidateSha256: plan.candidateSha256 });
    coordinatorJournal.append("RUNTIME_RESTART_OUTCOME_UNKNOWN");
    assertFreshWriterFence();
    if (dependencies.restartNodeRed) await dependencies.restartNodeRed({
      PADLHUB_PLATFORM_TENANT_KEY: execution.tenantKey,
      VIVA_GAME_PROJECTION_SYNC_MODE: "SHADOW",
      ...Object.fromEntries(CUTOVER_ONLY_ENV_KEYS.map((key) => [key, ""])),
    });
    else {
      const runtimeEnv = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        PADLHUB_PLATFORM_TENANT_KEY: execution.tenantKey,
        VIVA_GAME_PROJECTION_SYNC_MODE: "SHADOW",
        ...Object.fromEntries(CUTOVER_ONLY_ENV_KEYS.map((key) => [key, ""])),
      };
      const restart = spawnSync("pm2", ["restart", plan.production.processName, "--update-env"], {
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
        env: runtimeEnv,
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
    assertPm2RuntimeIdentity(activePm2, plan.production);
    assertNoCutoverEnvironment(activePm2);
    const activeRestartCount = Number(activePm2?.pm2_env?.restart_time);
    if (!Number.isSafeInteger(activeRestartCount) || activeRestartCount < plan.production.restartCountAtEvidence) {
      fail("PM2 restart counter is invalid after candidate restart");
    }
    if (dependencies.waitForRuntimeDwell) await dependencies.waitForRuntimeDwell();
    else await new Promise((resolve) => setTimeout(resolve, 10_000));
    const stablePm2 = dependencies.inspectPm2 ? await dependencies.inspectPm2() : pm2Entry(plan.production.processName);
    const stableNowMs = clockNow();
    if (stablePm2?.pm_id !== plan.production.pm2ProcessId
      || String(stablePm2?.pm2_env?.status || "").toLowerCase() !== "online"
      || Number(stablePm2?.pm2_env?.restart_time) !== activeRestartCount
      || stableNowMs - Number(stablePm2?.pm2_env?.pm_uptime) < 10_000) {
      fail("Node-RED did not remain stable through the post-restart dwell");
    }
    assertPm2RuntimeIdentity(stablePm2, plan.production);
    assertNoCutoverEnvironment(stablePm2);
    const runtimeHealth = dependencies.probeRuntimeHealth
      ? await dependencies.probeRuntimeHealth(plan.production.localHealthUrl)
      : await probeLocalRuntimeHealth(plan.production.localHealthUrl, plan.candidateCanonicalSha256);
    if (runtimeHealth?.url !== plan.production.localHealthUrl
      || runtimeHealth?.statusCode !== 200
      || runtimeHealth?.bodyCanonicalSha256 !== plan.candidateCanonicalSha256) {
      fail("Node-RED health proof is not bound to the frozen local endpoint");
    }
    coordinatorJournal.append("RUNTIME_ONLINE_SHADOW", {
      candidateSha256: plan.candidateSha256,
      restartCount: activeRestartCount,
      pmUptime: stablePm2.pm2_env.pm_uptime,
      healthUrl: runtimeHealth.url,
      healthStatusCode: runtimeHealth.statusCode,
      healthBodySha256: runtimeHealth.bodySha256,
    });
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
      coordinatorJournal: coordinatorJournal.journalDirectory,
      fenceGuardianReceiptSha256: guardianReceiptSha256,
      fenceGuardianReceipt: guardianPath,
      outputDirectory: postcheckOutputDirectory,
    }, {
      ...(dependencies.postcheckDependencies || {}),
      assertExecutorSources: dependencies.postcheckDependencies?.assertExecutorSources || dependencies.assertExecutorSources,
    });
    coordinatorJournal.append("POSTCHECK_EVIDENCE_PASS_READY_PENDING", {
      postcheckReceiptSha256: postcheckResult.postcheckReceiptSha256,
      postcheckManifestSha256: postcheckResult.postcheckManifestSha256,
    });
    const result = {
      formatVersion: 1,
      kind: "viva-game-projection-cutover-coordinator-report",
      state: "POSTCHECK_PASS_INGRESS_STILL_BLOCKED",
      cutoverPlanSha256: execution.cutoverPlanSha256,
      applyIndexSha256: applyIndexArtifact.sha256,
      activeFlowSha256: plan.candidateSha256,
      postcheckReceiptSha256: postcheckResult.postcheckReceiptSha256,
      postcheckManifestSha256: postcheckResult.postcheckManifestSha256,
      mongoWriteBarrierReceiptSha256: barrierArtifact.sha256,
      mongoWriteBarrierState: "HELD",
      fenceGuardianReceiptSha256: guardianReceiptSha256,
      coordinatorAttemptId,
      ingressReopened: false,
      mutationAttempted: barrierInstallAttempted || appliedItems.length > 0 || candidatePublished,
      completedAt: postcheckResult.receipt.observedAt,
    };
    coordinatorJournal.finalize(result);
    const coordinatorReportBytes = readPrivateBytes(coordinatorReportPath, "Coordinator terminal report", MAX_JSON_BYTES);
    const terminalJournalName = fs.readdirSync(coordinatorJournal.journalDirectory).sort().at(-1);
    const terminalJournalRead = readPrivateJson(
      path.join(coordinatorJournal.journalDirectory, terminalJournalName), "Coordinator terminal journal", 1024 * 1024,
    );
    if (terminalJournalRead.value?.phase !== "TERMINAL_RESULT"
      || terminalJournalRead.value?.attemptId !== coordinatorAttemptId
      || terminalJournalRead.value?.state !== result.state) {
      fail("Coordinator durable terminal result is not exact");
    }

    readyPublicationAttempted = true;
    const readyMarker = await finalizeVivaGameProjectionCutoverReady({
      executionIndex: options.executionIndex,
      expectedExecutionIndexSha256: options.expectedExecutionIndexSha256,
      coordinatorReport: coordinatorReportPath,
      expectedCoordinatorReportSha256: sha256(coordinatorReportBytes),
    }, {
      ...dependencies,
      authorizedByCoordinator: true,
      guardianReceipt: guardian,
    });
    return { ...result, readyMarkerSha256: readyMarker.readyMarkerSha256 };
  } catch (error) {
    const readyPublicationOutcomeUnknown = readyPublicationAttempted
      && error?.publicationOutcome === "UNKNOWN" && error?.publicationPath === readyMarkerPath;
    let runtimeStopped = !candidatePublished;
    let stopError = null;
    if (candidatePublished && !readyPublicationOutcomeUnknown) {
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
        readyPublicationOutcome: readyPublicationOutcomeUnknown ? "UNKNOWN_KEEP_RUNTIME_ONLINE" : "NOT_READY_OR_FAILED",
        ingressReopened: false,
        mutationAttempted: appliedItems.length > 0 || inFlightPlanSha256 !== null || candidatePublished || barrierInstallAttempted,
        failedAt: new Date(clockNow()).toISOString(),
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
