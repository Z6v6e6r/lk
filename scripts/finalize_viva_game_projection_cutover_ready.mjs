#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MongoClient } from "mongodb";

import {
  canonicalJson,
  sha256,
  validateVivaGameProjectionCutoverPostcheck,
} from "./lib/vivaGameProjectionCutoverContract.mjs";
import { assertExactExecutorSources } from "./lib/vivaGameProjectionExecutorSource.mjs";
import { validateExactCutoverPacket } from "./lib/vivaGameProjectionCutoverPacketValidation.mjs";
import { assertMongoWriteBarrier } from "./lib/vivaGameProjectionMongoWriteBarrier.mjs";
import {
  acceptFenceGuardianChildRequest,
  FENCE_READY_CONFIRMATION,
  isAuthorizedFenceGuardianReadyFinalization,
} from "./lib/vivaGameProjectionFenceGuardian.mjs";
import {
  assertLiveFenceGuardian,
  assertNoCutoverEnvironment,
  assertPm2RuntimeIdentity,
  envValue,
  probeLocalRuntimeHealth,
  readPm2,
} from "./prepare_viva_game_projection_cutover_postcheck.mjs";
import {
  assertExclusiveFenceLease,
  assertNoConcurrentMongoWrites,
  ensurePrivateDirectory,
  readPrivateBytes,
  readPrivateJson,
  readPrivateMongoConnection,
  recoverDurableTerminalReport,
  validateHeldWriterFence,
} from "./run_viva_game_projection_tenant_migration.mjs";
import {
  recoverAtomicExclusivePublication,
  writeFileExclusiveAtomicDurable,
} from "./nodered_reviewed_flow_deploy/runtime_contract.mjs";

const SCRIPT_PATH = fs.realpathSync(fileURLToPath(import.meta.url));
const CONFIRMATION = FENCE_READY_CONFIRMATION;
const HASH_RE = /^[a-f0-9]{64}$/;
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_JSON_BYTES = 64 * 1024 * 1024;
const fail = (message) => { throw new Error(message); };
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const protectedOptions = () => ({
  uid: typeof process.getuid === "function" ? process.getuid() : 0,
  gid: typeof process.getgid === "function" ? process.getgid() : 0,
  mode: 0o600,
});
const assertHash = (value, label) => {
  if (!HASH_RE.test(String(value || ""))) fail(`${label} must be a SHA-256 digest`);
};
const readJournalTerminal = (reportPath, attemptId, reportRead) => {
  const directory = `${reportPath}.journal`;
  const canonical = fs.realpathSync(directory);
  const stat = fs.lstatSync(canonical);
  if (canonical !== path.resolve(directory) || !stat.isDirectory() || stat.isSymbolicLink()
    || stat.uid !== protectedOptions().uid || (stat.mode & 0o077) !== 0) fail("Coordinator journal is not private and canonical");
  const names = fs.readdirSync(canonical).sort();
  const entries = names.map((name, index) => {
    if (!new RegExp(`^${String(index).padStart(4, "0")}-[a-z0-9-]+\\.json$`).test(name)) {
      fail("Coordinator journal sequence is incomplete");
    }
    return { name, ...readPrivateJson(path.join(canonical, name), "Coordinator journal", 1024 * 1024) };
  });
  if (entries.length === 0 || entries.some((entry, index) => entry.value?.formatVersion !== 1
    || entry.value?.attemptId !== attemptId || entry.value?.mode !== "CUTOVER" || entry.value?.sequence !== index)
    || entries.at(-1).value?.phase !== "TERMINAL_RESULT"
    || entries.at(-1).value?.state !== "POSTCHECK_PASS_INGRESS_STILL_BLOCKED"
    || entries.at(-1).value?.reportSha256 !== sha256(reportRead.bytes)
    || canonicalJson(entries.at(-1).value?.report) !== canonicalJson(reportRead.value)) {
    fail("Coordinator journal does not contain the exact terminal success");
  }
  return entries.at(-1);
};
const validatePostcheckArtifacts = ({ outputDirectory, report, plan, executionRead, barrierRead, guardianRead, nowMs }) => {
  const manifestRead = readPrivateJson(path.join(outputDirectory, "postcheck.manifest.json"), "Postcheck manifest", MAX_JSON_BYTES);
  const receiptRead = readPrivateJson(path.join(outputDirectory, "postcheck.receipt.json"), "Postcheck receipt", MAX_JSON_BYTES);
  if (sha256(manifestRead.bytes) !== report.postcheckManifestSha256
    || sha256(receiptRead.bytes) !== report.postcheckReceiptSha256) fail("Coordinator report does not bind the postcheck artifacts");
  const manifest = manifestRead.value;
  const receipt = receiptRead.value;
  if (manifest?.formatVersion !== 1 || manifest?.kind !== "viva-game-projection-cutover-postcheck-manifest"
    || manifest?.state !== "PASS" || manifest?.cutoverPlanSha256 !== report.cutoverPlanSha256
    || manifest?.packetManifestSha256 !== executionRead.value.packetManifestSha256
    || manifest?.applyIndexSha256 !== report.applyIndexSha256
    || manifest?.fenceReceiptSha256 !== executionRead.value.fenceReceiptSha256
    || manifest?.mongoWriteBarrierReceiptSha256 !== report.mongoWriteBarrierReceiptSha256
    || manifest?.executionIndexSha256 !== sha256(executionRead.bytes)
    || manifest?.coordinatorAttemptId !== report.coordinatorAttemptId
    || manifest?.fenceGuardianReceiptSha256 !== report.fenceGuardianReceiptSha256
    || !Array.isArray(manifest?.files)) fail("Postcheck manifest does not bind the terminal coordinator report");
  const fileEntries = new Map();
  for (const item of manifest.files) {
    if (!item?.path || path.basename(item.path) !== item.path || !HASH_RE.test(String(item.sha256 || ""))
      || fileEntries.has(item.path)) fail("Postcheck manifest file inventory is invalid");
    const bytes = readPrivateBytes(path.join(outputDirectory, item.path), `Postcheck ${item.path}`, MAX_JSON_BYTES);
    if (sha256(bytes) !== item.sha256) fail("Postcheck artifact differs from its manifest");
    fileEntries.set(item.path, bytes);
  }
  const exactFileNames = [
    "active-reachable-legacy.query.json",
    "duplicate-identity.query.json",
    "fence-guardian-heartbeat.snapshot.json",
    "postcheck.receipt.json",
    "provider-tenant-bound.query.json",
    "worker-mode.query.json",
  ].sort();
  if (JSON.stringify([...fileEntries.keys()].sort()) !== JSON.stringify(exactFileNames)
    || fileEntries.get("postcheck.receipt.json")?.equals(receiptRead.bytes) !== true) {
    fail("Postcheck manifest does not contain the exact finalization evidence set");
  }
  const applyIndexRead = readPrivateJson(executionRead.value.applyIndexOutputPath, "Apply index", MAX_JSON_BYTES);
  if (sha256(applyIndexRead.bytes) !== report.applyIndexSha256) fail("Apply index differs from the terminal report");
  const applyReportBytesByPlan = Object.fromEntries((applyIndexRead.value?.items || []).map((item) => [
    item.planSha256, readPrivateBytes(item.reportPath, "Apply report", MAX_JSON_BYTES),
  ]));
  const guardianHeartbeatBytes = fileEntries.get("fence-guardian-heartbeat.snapshot.json");
  if (!guardianHeartbeatBytes || sha256(guardianHeartbeatBytes) !== receipt.fenceGuardianHeartbeatSha256) {
    fail("Postcheck lacks its immutable guardian-heartbeat snapshot");
  }
  validateVivaGameProjectionCutoverPostcheck(receipt, plan, nowMs, {
    applyReportBytesByPlan,
    mongoWriteBarrierReceiptBytes: barrierRead.bytes,
    executionIndexBytes: executionRead.bytes,
    fenceGuardianReceiptBytes: guardianRead.bytes,
    fenceGuardianHeartbeatBytes: guardianHeartbeatBytes,
    queryEvidenceBytes: {
      activeReachableLegacySha256: fileEntries.get("active-reachable-legacy.query.json"),
      duplicateIdentitySha256: fileEntries.get("duplicate-identity.query.json"),
      providerTenantBoundSha256: fileEntries.get("provider-tenant-bound.query.json"),
      workerModeSha256: fileEntries.get("worker-mode.query.json"),
    },
  }, { maximumAgeMs: 30 * 60_000 });
  return { receipt, manifestRead, receiptRead };
};
const validateReadyMarker = (marker, expected, nowMs, {
  allowAnyGuardianRequestId = false,
  maximumAgeMs = 5 * 60_000,
} = {}) => {
  const { runtimeHealthUrl, candidateCanonicalSha256 } = expected;
  const bindings = Object.fromEntries(Object.entries(expected).filter(([key]) => ![
    "runtimeHealthUrl", "candidateCanonicalSha256", "guardianReadyRequestId",
  ].includes(key)));
  if (marker?.formatVersion !== 1 || marker?.kind !== "viva-game-projection-cutover-ready-marker"
    || marker?.state !== "READY_TO_REOPEN_INGRESS" || marker?.ingressReopenEligible !== true
    || marker?.ingressReopened !== false
    || Object.entries(bindings).some(([key, value]) => marker?.[key] !== value)
    || marker?.runtimeHealth?.url !== runtimeHealthUrl
    || marker?.runtimeHealth?.statusCode !== 200
    || marker?.runtimeHealth?.bodyCanonicalSha256 !== candidateCanonicalSha256
    || (allowAnyGuardianRequestId
      ? !(marker?.guardianReadyRequestId === null || UUID_V4_RE.test(String(marker?.guardianReadyRequestId || "")))
      : marker?.guardianReadyRequestId !== expected.guardianReadyRequestId)
    || !HASH_RE.test(String(marker?.runtimeHealth?.bodySha256 || ""))
    || !HASH_RE.test(String(marker?.fenceGuardianHeartbeatSha256 || ""))
    || !Number.isFinite(Date.parse(marker?.observedAt)) || Date.parse(marker.observedAt) > nowMs + 60_000
    || nowMs - Date.parse(marker.observedAt) > maximumAgeMs) fail("READY marker does not bind the exact live finalization gates");
};

const readyExpected = ({
  execution, report, terminal, plan, options, guardianReadyRequestId, readyFinalizationReceiptSha256,
}) => ({
  cutoverPlanSha256: execution.cutoverPlanSha256,
  executionIndexSha256: options.expectedExecutionIndexSha256,
  coordinatorAttemptId: report.coordinatorAttemptId,
  coordinatorReportSha256: options.expectedCoordinatorReportSha256,
  guardianReadyRequestId,
  coordinatorTerminalJournalSha256: sha256(terminal.bytes),
  postcheckReceiptSha256: report.postcheckReceiptSha256,
  postcheckManifestSha256: report.postcheckManifestSha256,
  mongoWriteBarrierReceiptSha256: report.mongoWriteBarrierReceiptSha256,
  fenceGuardianReceiptSha256: report.fenceGuardianReceiptSha256,
  ...(readyFinalizationReceiptSha256 ? { readyFinalizationReceiptSha256 } : {}),
  runtimeHealthUrl: plan.production.localHealthUrl,
  candidateCanonicalSha256: plan.candidateCanonicalSha256,
});

const validateReadyFinalizationReceipt = (receipt, expected, nowMs, { maximumAgeMs = 5 * 60_000 } = {}) => {
  const stable = Object.fromEntries(Object.entries(expected).filter(([key]) => ![
    "runtimeHealthUrl", "candidateCanonicalSha256", "readyFinalizationReceiptSha256",
  ].includes(key)));
  if (receipt?.formatVersion !== 1
    || receipt?.kind !== "viva-game-projection-ready-finalization-receipt"
    || receipt?.state !== "PASS_CURRENT_GATES"
    || Object.entries(stable).some(([key, value]) => receipt?.[key] !== value)
    || !HASH_RE.test(String(receipt?.fenceGuardianHeartbeatSha256 || ""))
    || !HASH_RE.test(String(receipt?.pm2StateSha256 || ""))
    || !HASH_RE.test(String(receipt?.liveFlowSha256 || ""))
    || receipt?.runtimeHealth?.url !== expected.runtimeHealthUrl
    || receipt?.runtimeHealth?.statusCode !== 200
    || receipt?.runtimeHealth?.bodyCanonicalSha256 !== expected.candidateCanonicalSha256
    || !HASH_RE.test(String(receipt?.runtimeHealth?.bodySha256 || ""))
    || typeof receipt?.mongoReplicaSetName !== "string" || !receipt.mongoReplicaSetName
    || receipt?.mongoCurrentOpClear !== true
    || !Number.isFinite(Date.parse(receipt?.observedAt)) || Date.parse(receipt.observedAt) > nowMs + 60_000
    || nowMs - Date.parse(receipt.observedAt) > maximumAgeMs) {
    fail("READY finalization receipt does not bind the exact current gates");
  }
};

export async function finalizeVivaGameProjectionCutoverReady(options, dependencies = {}) {
  const clockNow = () => (typeof dependencies.nowMs === "function" ? dependencies.nowMs() : (dependencies.nowMs ?? Date.now()));
  if ((dependencies.getUid ? dependencies.getUid() : process.getuid?.()) !== 0) fail("READY finalizer requires root");
  const guardianRequestId = String(dependencies.guardianReadyRequestId
    || process.env.PADLHUB_CUTOVER_GUARDIAN_READY_REQUEST_ID || "");
  const authorizedByGuardian = dependencies.authorizedByGuardian === true
    && process.env.PADLHUB_CUTOVER_GUARDIAN_READY_CHILD === "1" && UUID_V4_RE.test(guardianRequestId);
  if (!dependencies.authorizedByCoordinator && !authorizedByGuardian) fail("READY finalizer lacks guardian or coordinator custody");
  assertHash(options.expectedExecutionIndexSha256, "Expected execution-index digest");
  assertHash(options.expectedCoordinatorReportSha256, "Expected coordinator-report digest");
  const executionRead = readPrivateJson(options.executionIndex, "Cutover execution index", MAX_JSON_BYTES);
  const recoveredReport = recoverDurableTerminalReport(
    options.coordinatorReport, "CUTOVER", options.expectedCoordinatorReportSha256,
  );
  const reportRead = { value: recoveredReport.report, bytes: recoveredReport.bytes };
  if (sha256(executionRead.bytes) !== options.expectedExecutionIndexSha256
    || sha256(reportRead.bytes) !== options.expectedCoordinatorReportSha256) fail("READY finalizer input digest mismatch");
  const execution = executionRead.value;
  const report = reportRead.value;
  const cutoverRead = readPrivateJson(execution.cutoverPlanPath, "Cutover plan", MAX_JSON_BYTES);
  const packetManifestRead = readPrivateJson(execution.packetManifestPath, "Packet manifest", MAX_JSON_BYTES);
  const fenceRead = readPrivateJson(execution.fenceReceiptPath, "Writer fence receipt", MAX_JSON_BYTES);
  const barrierRead = readPrivateJson(execution.mongoWriteBarrierReceiptOutputPath, "Mongo write-barrier receipt", MAX_JSON_BYTES);
  const guardianPath = String(process.env.PADLHUB_CUTOVER_GUARDIAN_RECEIPT || "");
  const providedGuardian = dependencies.guardianReceipt?.value || dependencies.guardianReceipt;
  const guardianRead = providedGuardian
    ? { value: providedGuardian, bytes: Buffer.from(canonicalJson(providedGuardian)) }
    : readPrivateJson(guardianPath, "Fence guardian receipt", 1024 * 1024);
  const plan = cutoverRead.value;
  const historicalCompletionMs = Date.parse(report?.completedAt);
  if (!Number.isFinite(historicalCompletionMs)) fail("Coordinator terminal completion time is invalid");
  if (sha256(cutoverRead.bytes) !== execution.cutoverPlanSha256
    || sha256(packetManifestRead.bytes) !== execution.packetManifestSha256
    || sha256(fenceRead.bytes) !== execution.fenceReceiptSha256
    || sha256(barrierRead.bytes) !== report.mongoWriteBarrierReceiptSha256
    || sha256(guardianRead.bytes) !== report.fenceGuardianReceiptSha256
    || report?.formatVersion !== 1 || report?.kind !== "viva-game-projection-cutover-coordinator-report"
    || report?.state !== "POSTCHECK_PASS_INGRESS_STILL_BLOCKED" || report?.ingressReopened !== false
    || report?.cutoverPlanSha256 !== execution.cutoverPlanSha256
    || report?.activeFlowSha256 !== plan?.candidateSha256 || report?.mongoWriteBarrierState !== "HELD") {
    fail("READY finalizer inputs do not bind one terminal successful cutover");
  }
  const terminal = readJournalTerminal(options.coordinatorReport, report.coordinatorAttemptId, reportRead);
  const packetRoot = fs.realpathSync(path.dirname(execution.cutoverPlanPath));
  if (dependencies.assertExecutorSources) await dependencies.assertExecutorSources(plan);
  else assertExactExecutorSources(plan);
  if (dependencies.validateExactCutoverPacket) {
    await dependencies.validateExactCutoverPacket({
      packetRoot, plan, manifest: packetManifestRead.value, nowMs: historicalCompletionMs,
    });
  } else validateExactCutoverPacket({
    packetRoot, plan, manifest: packetManifestRead.value, nowMs: historicalCompletionMs,
  });
  validateHeldWriterFence(fenceRead.value, {
    sourceFlowSha256: plan.sourceFlowSha256,
    candidateSha256: plan.candidateSha256,
    tenantKey: execution.tenantKey,
    expectedOperationIds: plan.writerFence.exactMigrationOperationIds,
    expectedWriterNodeIds: plan.writerFence.exactWriterNodeIds,
    writerInventorySha256: plan.writerFence.writerInventorySha256,
    externalWriterProofSha256: plan.writerFence.externalWriterProofSha256,
    fenceTokenSha256: plan.writerFence.fenceTokenSha256,
    lockPath: plan.writerFence.lockPath,
    nowMs: historicalCompletionMs,
  });
  if (dependencies.assertFenceLease) await dependencies.assertFenceLease(fenceRead.value);
  else assertExclusiveFenceLease(fenceRead.value);
  const nowMs = clockNow();
  const guardianLease = dependencies.assertGuardianLease
    ? await dependencies.assertGuardianLease(guardianRead.value, nowMs)
    : assertLiveFenceGuardian(guardianRead.value, nowMs);
  const postcheckOutputDirectory = ensurePrivateDirectory(execution.postcheckOutputDirectory, "Postcheck output directory");
  const postcheck = validatePostcheckArtifacts({
    outputDirectory: postcheckOutputDirectory, report, plan, executionRead, barrierRead, guardianRead,
    nowMs: historicalCompletionMs,
  });
  const pm2Rows = dependencies.inspectPm2
    ? [await dependencies.inspectPm2()] : (dependencies.readPm2 ? await dependencies.readPm2() : readPm2());
  const matches = Array.isArray(pm2Rows) ? pm2Rows.filter((item) => item?.name === plan.production.processName) : [];
  const processEntry = matches[0];
  const liveFlowSha256 = sha256(readPrivateBytes(execution.liveFlowPath, "Final candidate flow", 256 * 1024 * 1024));
  if (matches.length !== 1 || processEntry?.pm_id !== plan.production.pm2ProcessId
    || String(processEntry?.pm2_env?.status || "").toLowerCase() !== "online"
    || sha256(String(envValue(processEntry, "PADLHUB_PLATFORM_TENANT_KEY") || "")) !== plan.tenantKeySha256
    || String(envValue(processEntry, "VIVA_GAME_PROJECTION_SYNC_MODE") || "").toUpperCase() !== "SHADOW"
    || Number(processEntry?.pm2_env?.restart_time) !== postcheck.receipt.runtimeRestartCount
    || nowMs - Number(processEntry?.pm2_env?.pm_uptime) < 10_000
    || liveFlowSha256 !== plan.candidateSha256) {
    fail("READY finalizer runtime gate failed");
  }
  assertPm2RuntimeIdentity(processEntry, plan.production);
  assertNoCutoverEnvironment(processEntry);
  const pm2StateSha256 = sha256(canonicalJson({
    name: processEntry.name,
    pmId: processEntry.pm_id,
    status: processEntry.pm2_env.status,
    restartCount: Number(processEntry.pm2_env.restart_time),
    pmUptime: Number(processEntry.pm2_env.pm_uptime),
    execPath: processEntry.pm2_env.pm_exec_path,
    cwd: processEntry.pm2_env.pm_cwd,
  }));
  const health = dependencies.probeRuntimeHealth
    ? await dependencies.probeRuntimeHealth(plan.production.localHealthUrl)
    : await probeLocalRuntimeHealth(plan.production.localHealthUrl, plan.candidateCanonicalSha256);
  if (health?.url !== plan.production.localHealthUrl || health?.statusCode !== 200
    || health?.bodyCanonicalSha256 !== plan.candidateCanonicalSha256) fail("READY finalizer /flows proof failed");
  const connection = readPrivateMongoConnection(
    execution.migrationConnectionFile, plan.mongoTarget.migrationConnectionFingerprint,
  );
  const client = dependencies.finalizationMongoClient || new MongoClient(connection.uri, {
    appName: "PadlHubVivaGameProjectionReadyFinalizer", maxPoolSize: 1,
    serverSelectionTimeoutMS: 20_000, connectTimeoutMS: 20_000, socketTimeoutMS: 20_000, timeoutMS: 20_000,
  });
  let mongoReplicaSetName = null;
  try {
    if (!dependencies.finalizationMongoClient) await client.connect();
    const hello = await client.db("admin").command({ hello: 1 });
    if (hello?.setName !== plan.mongoTarget.replicaSetName) fail("READY finalizer Mongo target changed");
    mongoReplicaSetName = hello.setName;
    if (dependencies.assertMongoWriteBarrier) await dependencies.assertMongoWriteBarrier(barrierRead.value);
    else await assertMongoWriteBarrier(client, barrierRead.value, {
      fenceTokenSha256: plan.writerFence.fenceTokenSha256,
      cutoverPlanSha256: execution.cutoverPlanSha256,
      mongoTargetIdentitySha256: plan.mongoTarget.targetIdentitySha256,
      migrationAuthenticationRestrictions: connection.authenticationRestrictions,
    });
    if (dependencies.assertNoConcurrentWrites) await dependencies.assertNoConcurrentWrites();
    else await assertNoConcurrentMongoWrites(client);
  } finally {
    if (!dependencies.finalizationMongoClient) await client.close().catch(() => {});
  }
  const readyPath = path.join(postcheckOutputDirectory, "READY_TO_REOPEN_INGRESS.json");
  const finalizationReceiptPath = path.join(postcheckOutputDirectory, "ready-finalization.receipt.json");
  const baseExpected = readyExpected({
    execution, report, terminal, plan, options, guardianReadyRequestId: guardianRequestId || null,
  });
  recoverAtomicExclusivePublication(readyPath, protectedOptions());
  if (fs.existsSync(readyPath)) {
    const existing = readPrivateJson(readyPath, "READY marker", MAX_JSON_BYTES);
    const existingReceiptRead = readPrivateJson(
      finalizationReceiptPath, "READY finalization receipt", MAX_JSON_BYTES,
    );
    if (sha256(existingReceiptRead.bytes) !== existing.value?.readyFinalizationReceiptSha256
      || existingReceiptRead.value?.fenceGuardianHeartbeatSha256 !== existing.value?.fenceGuardianHeartbeatSha256
      || canonicalJson(existingReceiptRead.value?.runtimeHealth) !== canonicalJson(existing.value?.runtimeHealth)) {
      fail("READY marker does not bind its finalization receipt");
    }
    const existingExpected = {
      ...baseExpected,
      guardianReadyRequestId: existing.value.guardianReadyRequestId,
      readyFinalizationReceiptSha256: sha256(existingReceiptRead.bytes),
    };
    validateReadyFinalizationReceipt(existingReceiptRead.value, existingExpected, nowMs, {
      maximumAgeMs: Number.POSITIVE_INFINITY,
    });
    validateReadyMarker(existing.value, existingExpected, nowMs, {
      allowAnyGuardianRequestId: true, maximumAgeMs: Number.POSITIVE_INFINITY,
    });
    if (nowMs - Date.parse(existing.value.observedAt) <= 5 * 60_000
      && nowMs - Date.parse(existingReceiptRead.value.observedAt) <= 5 * 60_000) {
      return { state: existing.value.state, readyMarkerSha256: sha256(existing.bytes), resumed: true };
    }
    fs.unlinkSync(readyPath);
    const directory = fs.openSync(path.dirname(readyPath), fs.constants.O_RDONLY);
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  }
  recoverAtomicExclusivePublication(finalizationReceiptPath, protectedOptions());
  if (fs.existsSync(finalizationReceiptPath)) {
    const stale = readPrivateJson(finalizationReceiptPath, "READY finalization receipt", MAX_JSON_BYTES);
    validateReadyFinalizationReceipt(stale.value, {
      ...baseExpected, guardianReadyRequestId: stale.value?.guardianReadyRequestId,
    }, nowMs, { maximumAgeMs: Number.POSITIVE_INFINITY });
    fs.unlinkSync(finalizationReceiptPath);
    const directory = fs.openSync(path.dirname(finalizationReceiptPath), fs.constants.O_RDONLY);
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  }
  const finalizationReceipt = {
    formatVersion: 1,
    kind: "viva-game-projection-ready-finalization-receipt",
    state: "PASS_CURRENT_GATES",
    ...Object.fromEntries(Object.entries(baseExpected).filter(([key]) => ![
      "runtimeHealthUrl", "candidateCanonicalSha256",
    ].includes(key))),
    fenceGuardianHeartbeatSha256: guardianLease.sha256,
    pm2StateSha256,
    liveFlowSha256,
    runtimeHealth: health,
    mongoReplicaSetName,
    mongoCurrentOpClear: true,
    observedAt: new Date(nowMs).toISOString(),
  };
  const finalizationReceiptBytes = Buffer.from(canonicalJson(finalizationReceipt));
  writeFileExclusiveAtomicDurable(finalizationReceiptPath, finalizationReceiptBytes, protectedOptions());
  const expected = {
    ...baseExpected,
    readyFinalizationReceiptSha256: sha256(finalizationReceiptBytes),
  };
  validateReadyFinalizationReceipt(finalizationReceipt, expected, nowMs);
  const marker = {
    formatVersion: 1,
    kind: "viva-game-projection-cutover-ready-marker",
    state: "READY_TO_REOPEN_INGRESS",
    cutoverPlanSha256: expected.cutoverPlanSha256,
    executionIndexSha256: expected.executionIndexSha256,
    coordinatorAttemptId: expected.coordinatorAttemptId,
    coordinatorReportSha256: expected.coordinatorReportSha256,
    coordinatorTerminalJournalSha256: expected.coordinatorTerminalJournalSha256,
    postcheckReceiptSha256: expected.postcheckReceiptSha256,
    postcheckManifestSha256: expected.postcheckManifestSha256,
    mongoWriteBarrierReceiptSha256: expected.mongoWriteBarrierReceiptSha256,
    fenceGuardianReceiptSha256: expected.fenceGuardianReceiptSha256,
    readyFinalizationReceiptSha256: expected.readyFinalizationReceiptSha256,
    guardianReadyRequestId: expected.guardianReadyRequestId,
    fenceGuardianHeartbeatSha256: guardianLease.sha256,
    runtimeHealth: health,
    ingressReopenEligible: true,
    ingressReopened: false,
    observedAt: new Date(nowMs).toISOString(),
  };
  const bytes = Buffer.from(canonicalJson(marker));
  writeFileExclusiveAtomicDurable(readyPath, bytes, protectedOptions());
  const readback = readPrivateJson(readyPath, "READY marker", MAX_JSON_BYTES);
  validateReadyMarker(readback.value, expected, nowMs);
  if (!readback.bytes.equals(bytes)) fail("READY marker readback changed");
  return { state: marker.state, readyMarkerSha256: sha256(bytes), resumed: false };
}

const readyArgv = (options) => [
  "--execution-index", options.executionIndex,
  "--expected-execution-index-sha256", options.expectedExecutionIndexSha256,
  "--coordinator-report", options.coordinatorReport,
  "--expected-coordinator-report-sha256", options.expectedCoordinatorReportSha256,
];

const readExactReadyRequest = (requestPath, argv, guardian, nowMs, { accepted = false } = {}) => {
  const requestRead = readPrivateJson(requestPath, "Fence guardian READY request", 1024 * 1024);
  const request = requestRead.value;
  const validationNowMs = accepted ? Date.parse(request?.authorizedAt) : nowMs;
  if (!isAuthorizedFenceGuardianReadyFinalization({
    request,
    validPrivateFile: true,
    fenceTokenSha256: guardian.fenceTokenSha256,
    guardianPid: guardian.pid,
    processStartIdentity: guardian.processStartIdentity,
    nowMs: validationNowMs,
  }) || canonicalJson(request.argv) !== canonicalJson(argv)) {
    fail("Existing guardian READY request does not bind this exact finalization");
  }
  return request;
};

export async function requestReadyFinalizationFromGuardian(options, dependencies = {}) {
  const clockNow = () => (typeof dependencies.nowMs === "function" ? dependencies.nowMs() : (dependencies.nowMs ?? Date.now()));
  const nowMs = clockNow();
  if ((dependencies.getUid ? dependencies.getUid() : process.getuid?.()) !== 0) fail("READY finalization request requires root");
  if (process.env.VIVA_GAME_PROJECTION_READY_FINALIZE !== CONFIRMATION) fail("READY finalization confirmation is absent");
  assertHash(options.expectedExecutionIndexSha256, "Expected execution-index digest");
  assertHash(options.expectedCoordinatorReportSha256, "Expected coordinator-report digest");
  const executionRead = readPrivateJson(options.executionIndex, "Cutover execution index", MAX_JSON_BYTES);
  const recoveredReport = recoverDurableTerminalReport(
    options.coordinatorReport, "CUTOVER", options.expectedCoordinatorReportSha256,
  );
  const reportRead = { value: recoveredReport.report, bytes: recoveredReport.bytes };
  if (sha256(executionRead.bytes) !== options.expectedExecutionIndexSha256
    || sha256(reportRead.bytes) !== options.expectedCoordinatorReportSha256) fail("READY finalization request input digest mismatch");
  const guardianPath = String(process.env.PADLHUB_CUTOVER_GUARDIAN_RECEIPT || "");
  const readyRequestPath = String(process.env.PADLHUB_CUTOVER_GUARDIAN_READY_REQUEST || "");
  const guardianRead = readPrivateJson(guardianPath, "Fence guardian receipt", 1024 * 1024);
  const guardian = guardianRead.value;
  if (reportRead.value?.fenceGuardianReceiptSha256 !== sha256(guardianRead.bytes)
    || guardian?.formatVersion !== 1 || guardian?.kind !== "viva-game-projection-fence-guardian-receipt"
    || guardian?.state !== "HOLDING_UNTIL_EXPLICIT_RELEASE"
    || guardian?.readyRequestPath !== readyRequestPath
    || guardian?.readyFinalizerPath !== SCRIPT_PATH
    || guardian?.readyFinalizerSha256 !== sha256(fs.readFileSync(SCRIPT_PATH))) {
    fail("READY request does not bind the exact live guardian and finalizer");
  }
  const guardianLease = dependencies.assertGuardianLease
    ? await dependencies.assertGuardianLease(guardian, nowMs)
    : assertLiveFenceGuardian(guardian, nowMs);
  if (guardianLease.heartbeat?.recoveryChildPid) fail("Fence guardian already has an active recovery operation");
  const argv = readyArgv(options);
  const terminal = readJournalTerminal(
    options.coordinatorReport, reportRead.value.coordinatorAttemptId, reportRead,
  );
  const cutoverRead = readPrivateJson(executionRead.value.cutoverPlanPath, "Cutover plan", MAX_JSON_BYTES);
  if (sha256(cutoverRead.bytes) !== executionRead.value.cutoverPlanSha256) {
    fail("READY request cutover plan differs from the terminal execution");
  }
  const readyPath = path.join(executionRead.value.postcheckOutputDirectory, "READY_TO_REOPEN_INGRESS.json");
  const finalizationReceiptPath = path.join(
    executionRead.value.postcheckOutputDirectory, "ready-finalization.receipt.json",
  );
  const readExactReadyResult = (markerRequestId, validationNowMs, maximumAgeMs) => {
    const readyRead = readPrivateJson(readyPath, "READY marker", MAX_JSON_BYTES);
    const receiptRead = readPrivateJson(finalizationReceiptPath, "READY finalization receipt", MAX_JSON_BYTES);
    if (readyRead.value?.readyFinalizationReceiptSha256 !== sha256(receiptRead.bytes)
      || readyRead.value?.fenceGuardianHeartbeatSha256 !== receiptRead.value?.fenceGuardianHeartbeatSha256
      || canonicalJson(readyRead.value?.runtimeHealth) !== canonicalJson(receiptRead.value?.runtimeHealth)) {
      fail("READY marker does not bind its exact current-gate receipt");
    }
    const expected = readyExpected({
      execution: executionRead.value,
      report: reportRead.value,
      terminal,
      plan: cutoverRead.value,
      options,
      guardianReadyRequestId: markerRequestId,
      readyFinalizationReceiptSha256: sha256(receiptRead.bytes),
    });
    validateReadyFinalizationReceipt(receiptRead.value, expected, validationNowMs, { maximumAgeMs });
    validateReadyMarker(readyRead.value, expected, validationNowMs, { maximumAgeMs });
    return readyRead;
  };
  const activeRequestId = guardianLease.heartbeat?.readyRequestId;
  let request = null;
  if (fs.existsSync(readyRequestPath)) {
    request = readExactReadyRequest(readyRequestPath, argv, guardian, nowMs);
  } else if (guardianLease.heartbeat?.readyChildPid && UUID_V4_RE.test(String(activeRequestId || ""))) {
    const acceptedPath = `${readyRequestPath}.accepted-${activeRequestId}`;
    if (!fs.existsSync(acceptedPath)) fail("Active guardian READY child lacks its accepted request");
    request = readExactReadyRequest(acceptedPath, argv, guardian, nowMs, { accepted: true });
  } else if (guardianLease.heartbeat?.readyChildPid) {
    fail("Active guardian READY child identity is invalid");
  }
  if (!request && fs.existsSync(readyPath)) {
    const existing = readPrivateJson(readyPath, "READY marker", MAX_JSON_BYTES);
    const markerRequestId = existing.value?.guardianReadyRequestId;
    readExactReadyResult(markerRequestId, nowMs, Number.POSITIVE_INFINITY);
    const markerAgeMs = nowMs - Date.parse(existing.value.observedAt);
    const markerResult = guardianLease.heartbeat?.lastReadyResult;
    if (markerAgeMs <= 5 * 60_000 && (markerRequestId === null
      || (markerResult?.requestId === markerRequestId && markerResult.exitCode === 0 && !markerResult.signal))) {
      return { state: existing.value.state, readyMarkerSha256: sha256(existing.bytes), resumed: true };
    }
  }
  let requestId = request?.requestId || dependencies.requestId || crypto.randomUUID();
  if (!UUID_V4_RE.test(requestId)) fail("READY request ID is invalid");
  if (!request) {
    request = {
      formatVersion: 1,
      kind: "viva-game-projection-fence-ready-finalization-request",
      state: "READY_FINALIZATION_AUTHORIZED",
      confirmation: CONFIRMATION,
      requestId,
      guardianPid: guardian.pid,
      guardianProcessStartIdentity: guardian.processStartIdentity,
      fenceTokenSha256: guardian.fenceTokenSha256,
      argv,
      authorizedAt: new Date(nowMs).toISOString(),
    };
    writeFileExclusiveAtomicDurable(readyRequestPath, Buffer.from(canonicalJson(request)), protectedOptions());
  }
  const maximumPolls = dependencies.maximumPolls ?? 300;
  for (let poll = 0; poll < maximumPolls; poll += 1) {
    if (dependencies.waitForPoll) await dependencies.waitForPoll();
    else await sleep(1000);
    const lease = dependencies.assertGuardianLease
      ? await dependencies.assertGuardianLease(guardian, clockNow())
      : assertLiveFenceGuardian(guardian, clockNow());
    const result = lease.heartbeat?.lastReadyResult;
    if (result?.requestId !== requestId) continue;
    if (result.exitCode !== 0 || result.signal) fail("Guardian READY finalizer child failed");
    const published = readPrivateJson(readyPath, "READY marker", MAX_JSON_BYTES);
    const readyRead = readExactReadyResult(
      published.value?.guardianReadyRequestId, clockNow(), 5 * 60_000,
    );
    return { state: readyRead.value.state, readyMarkerSha256: sha256(readyRead.bytes), resumed: true };
  }
  fail("Timed out waiting for the guardian READY finalizer child");
}

const parseArgs = (argv) => {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--") || values.has(key)) fail("Invalid READY finalizer argument");
    values.set(key, value);
  }
  for (const key of [
    "--execution-index", "--expected-execution-index-sha256",
    "--coordinator-report", "--expected-coordinator-report-sha256",
  ]) if (!values.get(key)) fail(`Missing ${key}`);
  return {
    executionIndex: values.get("--execution-index"),
    expectedExecutionIndexSha256: values.get("--expected-execution-index-sha256"),
    coordinatorReport: values.get("--coordinator-report"),
    expectedCoordinatorReportSha256: values.get("--expected-coordinator-report-sha256"),
  };
};

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  let result;
  if (process.env.PADLHUB_CUTOVER_GUARDIAN_READY_CHILD === "1") {
    acceptFenceGuardianChildRequest({
      childKind: "ready",
      requestId: process.env.PADLHUB_CUTOVER_GUARDIAN_READY_REQUEST_ID,
    });
    result = await finalizeVivaGameProjectionCutoverReady(options, { authorizedByGuardian: true });
  } else result = await requestReadyFinalizationFromGuardian(options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === SCRIPT_PATH) {
  if (process.argv.slice(2).includes("--help")) {
    process.stdout.write("Usage: node scripts/finalize_viva_game_projection_cutover_ready.mjs --execution-index /private/execution-index.json --expected-execution-index-sha256 SHA256 --coordinator-report /private/coordinator-report.json --expected-coordinator-report-sha256 SHA256\n");
  } else main().catch((error) => {
    process.stderr.write(`${String(error?.message || error).replace(/mongodb(?:\+srv)?:\/\/[^\s]+/gi, "[REDACTED_MONGO_URI]").slice(0, 500)}\n`);
    process.exitCode = 1;
  });
}
