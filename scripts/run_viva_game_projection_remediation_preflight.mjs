#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BSON, MongoClient, ObjectId } from "mongodb";

import { canonicalJson, sha256 } from "./lib/vivaGameProjectionCutoverContract.mjs";
import { validateExactCutoverPacket } from "./lib/vivaGameProjectionCutoverPacketValidation.mjs";
import { assertExactExecutorSources } from "./lib/vivaGameProjectionExecutorSource.mjs";
import {
  assertMongoWriteBarrier,
  hashFullCollectionDocuments,
  hashLiveFullCollection,
  installMongoWriteBarrier,
} from "./lib/vivaGameProjectionMongoWriteBarrier.mjs";
import {
  buildVivaGameProjectionRemediationEvidence,
  normalizeVivaRemediationProviderRow,
  remediationCaptureDates,
  selectRemediationSkippedDocuments,
} from "./lib/vivaGameProjectionRemediationEvidence.mjs";
import {
  assertLiveFenceGuardian,
  assertPm2RuntimeIdentity,
  envValue,
  readPm2,
} from "./prepare_viva_game_projection_cutover_postcheck.mjs";
import {
  assertExclusiveFenceLease,
  createDurableReportJournal,
  ensurePrivateDirectory,
  readFlowConnection,
  readPrivateBytes,
  readPrivateJson,
  readPrivateMongoConnection,
  validateHeldWriterFence,
} from "./run_viva_game_projection_tenant_migration.mjs";
import {
  syncDirectory,
  writeFileExclusiveAtomicDurable,
} from "./nodered_reviewed_flow_deploy/runtime_contract.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const CONFIRMATION = "CAPTURE_VIVA_GAME_PROJECTION_REMEDIATION_PREFLIGHT_V1";
const HASH_RE = /^[a-f0-9]{64}$/;
const MAX_JSON_BYTES = 64 * 1024 * 1024;
const MAX_BACKUP_BYTES = 1024 * 1024 * 1024;
const PROVIDER_ORIGIN = "https://api.vivacrm.ru";
const fail = (message) => { throw new Error(message); };

const nowMs = (dependencies) => (
  typeof dependencies.nowMs === "function" ? dependencies.nowMs() : (dependencies.nowMs ?? Date.now())
);

const assertHash = (value, label) => {
  if (!HASH_RE.test(String(value || ""))) fail(`${label} must be a SHA-256 digest`);
};

const privateOptions = () => ({
  uid: typeof process.getuid === "function" ? process.getuid() : 0,
  gid: typeof process.getgid === "function" ? process.getgid() : 0,
  mode: 0o600,
});

const writePrivate = (filePath, bytes) => {
  writeFileExclusiveAtomicDurable(filePath, bytes, privateOptions());
  const readback = readPrivateBytes(filePath, "Remediation preflight output", Math.max(bytes.length + 1, 1024));
  if (!readback.equals(bytes)) fail("Remediation preflight output readback mismatch");
  return sha256(readback);
};

const assertNewOutputDirectory = (outputDirectory) => {
  if (!path.isAbsolute(String(outputDirectory || ""))) fail("Evidence output path must be absolute");
  const output = path.resolve(outputDirectory);
  if (output !== outputDirectory) fail("Evidence output path must be canonical");
  const parent = ensurePrivateDirectory(path.dirname(output), "Evidence output parent");
  if (output === parent || fs.existsSync(output)) fail("Evidence output directory must be new");
  return { output, parent };
};

const isWithin = (parent, candidate) => {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

export const assertDisjointPreflightPaths = ({ packetRoot, execution, guardian, report, outputDirectory }) => {
  const writes = [
    path.resolve(report),
    path.resolve(`${report}.journal`),
    path.resolve(outputDirectory),
    path.resolve(execution.mongoWriteBarrierReceiptOutputPath),
    path.resolve(`${execution.mongoWriteBarrierReceiptOutputPath}.prepared`),
  ];
  const protectedPaths = [
    packetRoot,
    execution.cutoverPlanPath,
    execution.packetManifestPath,
    execution.fenceReceiptPath,
    execution.liveFlowPath,
    execution.migrationConnectionFile,
    guardian?.receiptPath,
    guardian?.heartbeatPath,
    guardian?.releaseRequestPath,
    guardian?.recoveryRequestPath,
    guardian?.readyRequestPath,
    guardian?.recoveryExecutorPath,
  ].filter(Boolean).map((value) => path.resolve(value));
  for (const target of writes) {
    if (protectedPaths.some((protectedPath) => isWithin(protectedPath, target) || isWithin(target, protectedPath))) {
      fail("Remediation preflight output overlaps a pinned custody input");
    }
  }
  for (let left = 0; left < writes.length; left += 1) {
    for (let right = left + 1; right < writes.length; right += 1) {
      if (isWithin(writes[left], writes[right]) || isWithin(writes[right], writes[left])) {
        fail("Remediation preflight output paths are not pairwise disjoint");
      }
    }
  }
  return true;
};

const exactPacketPath = (packetRoot, requestedPath, relativePath, label) => {
  const expected = path.join(packetRoot, relativePath);
  if (fs.realpathSync(requestedPath) !== expected) fail(`${label} is outside the exact cutover packet`);
  return expected;
};

const buildMigrationPlanBundle = (execution, packetRoot) => {
  if (!Array.isArray(execution.items) || execution.items.length < 1) {
    fail("Remediation preflight requires the complete migration plan set");
  }
  const plans = execution.items.map((item, index) => {
    assertHash(item?.planSha256, `Migration plan ${index} digest`);
    const planPath = exactPacketPath(
      packetRoot,
      item.planPath,
      path.join("migration-plans", path.basename(item.planPath)),
      `Migration plan ${index}`,
    );
    const bytes = readPrivateBytes(planPath, `Migration plan ${index}`, MAX_JSON_BYTES);
    if (sha256(bytes) !== item.planSha256) fail(`Migration plan ${index} digest mismatch`);
    return { sha256: item.planSha256, bytesBase64: bytes.toString("base64") };
  });
  const value = {
    formatVersion: 1,
    kind: "viva-game-projection-migration-plan-bundle",
    plans,
  };
  return { value, bytes: Buffer.from(canonicalJson(value)) };
};

const providerPrincipalFromBundle = (bundle) => {
  const hashes = new Set();
  for (const entry of bundle.value.plans) {
    let plan;
    try { plan = JSON.parse(Buffer.from(entry.bytesBase64, "base64").toString("utf8")); }
    catch { fail("Migration plan provider binding is invalid JSON"); }
    const principal = plan?.source?.providerServicePrincipalSha256;
    assertHash(principal, "Migration plan provider service principal");
    hashes.add(principal);
  }
  if (hashes.size !== 1) fail("Migration plans disagree on the provider service principal");
  return [...hashes][0];
};

const captureProviderRows = async (dates, token, fetchImplementation = fetch) => {
  const rows = [];
  const datesAudit = [];
  for (const date of dates) {
    const requestPath = `/api/v1/exercises?date=${encodeURIComponent(date)}&includeCanceled=true&page=0&size=1000`;
    const response = await fetchImplementation(`${PROVIDER_ORIGIN}${requestPath}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status !== 200) fail(`Viva remediation capture failed for ${date} with status ${response.status}`);
    const rawBody = await response.text();
    const rawBytes = Buffer.from(rawBody);
    if (rawBytes.length < 2 || rawBytes.length > 16 * 1024 * 1024) {
      fail(`Viva remediation capture size is invalid for ${date}`);
    }
    let payload;
    try { payload = JSON.parse(rawBody); } catch { fail(`Viva remediation capture is invalid JSON for ${date}`); }
    if (!Array.isArray(payload) || payload.length >= 1000) {
      fail(`Viva remediation capture completeness failed for ${date}`);
    }
    const normalized = payload.map((row) => normalizeVivaRemediationProviderRow(row))
      .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
    if (normalized.some((row) => row.date !== date)) {
      fail(`Viva remediation capture returned a row outside requested date ${date}`);
    }
    rows.push(...normalized);
    datesAudit.push({
      date,
      rowCount: normalized.length,
      rawPayloadSha256: sha256(rawBytes),
      canonicalRowsSha256: sha256(canonicalJson(normalized)),
    });
  }
  const canonicalRows = [...rows].sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  return {
    rows: canonicalRows,
    dates: datesAudit,
    canonicalRowsSha256: sha256(canonicalJson(canonicalRows)),
    captureTreeSha256: sha256(canonicalJson(datesAudit.map(({ date, rowCount, canonicalRowsSha256 }) => ({
      date, rowCount, canonicalRowsSha256,
    })))),
  };
};

export const assertStableProviderCapture = (first, second, dates) => {
  for (const capture of [first, second]) {
    if (!capture || !Array.isArray(capture.rows) || !Array.isArray(capture.dates)
      || capture.dates.map((entry) => entry?.date).join("\0") !== dates.join("\0")
      || !HASH_RE.test(String(capture.canonicalRowsSha256 || ""))
      || capture.canonicalRowsSha256 !== sha256(canonicalJson(capture.rows))
      || capture.captureTreeSha256 !== sha256(canonicalJson(capture.dates.map(({
        date, rowCount, canonicalRowsSha256,
      }) => ({ date, rowCount, canonicalRowsSha256 }))))) {
      fail("Viva remediation provider capture pass is incomplete");
    }
  }
  if (first.canonicalRowsSha256 !== second.canonicalRowsSha256
    || canonicalJson(first.rows) !== canonicalJson(second.rows)) {
    fail("Viva remediation provider state drifted between complete capture passes");
  }
  return second.rows;
};

const publishEvidence = ({ outputDirectory, evidence, migrationPlanBundle, bindings }) => {
  const { output, parent } = assertNewOutputDirectory(outputDirectory);
  const temporary = fs.mkdtempSync(path.join(parent, `.${path.basename(output)}.stage-`));
  let published = false;
  try {
    fs.chmodSync(temporary, 0o700);
    const files = [
      ["remediation-review.packet.json", evidence.packet.bytes],
      ["remediation-manual-review.json", evidence.enrichment.bytes],
      ["identity-reference-audit.json", evidence.identityAudit.bytes],
      ["provider.capture.json", evidence.providerCapture.bytes],
      ["mongo.capture.json", evidence.mongoCapture.bytes],
      ["migration-plan-bundle.json", migrationPlanBundle.bytes],
    ];
    const manifestFiles = files.map(([name, bytes]) => {
      const digest = writePrivate(path.join(temporary, name), bytes);
      return { path: name, size: bytes.length, sha256: digest };
    });
    const manifest = {
      formatVersion: 1,
      kind: "viva-game-projection-remediation-evidence-manifest",
      state: "CAPTURED_BARRIERS_HELD",
      captureSessionId: bindings.captureSessionId,
      cutoverPlanSha256: bindings.cutoverPlanSha256,
      fenceReceiptSha256: bindings.fenceReceiptSha256,
      mongoWriteBarrierReceiptSha256: bindings.mongoWriteBarrierReceiptSha256,
      sourceFlowSha256: bindings.sourceFlowSha256,
      gameDocumentWritesPerformed: 0,
      providerWritesPerformed: 0,
      mongoWriteBarrierState: "HELD",
      files: manifestFiles.sort((left, right) => left.path.localeCompare(right.path)),
    };
    const manifestBytes = Buffer.from(canonicalJson(manifest));
    const manifestSha256 = writePrivate(path.join(temporary, "evidence.manifest.json"), manifestBytes);
    syncDirectory(temporary);
    fs.renameSync(temporary, output);
    published = true;
    syncDirectory(parent);
    return { output, manifest, manifestSha256 };
  } catch (error) {
    fs.rmSync(published ? output : temporary, { recursive: true, force: true });
    throw error;
  }
};

const recoveryBinding = ({
  guardian, guardianReceiptPath, guardianReceiptSha256, barrierReceiptPath, execution, options,
}) => ({
  automaticRecovery: false,
  recoveryExecutorPath: guardian.recoveryExecutorPath,
  recoveryExecutorSha256: guardian.recoveryExecutorSha256,
  fenceGuardianReceiptPath: guardianReceiptPath,
  fenceGuardianReceiptSha256: guardianReceiptSha256,
  fenceGuardianRecoveryRequestPath: guardian.recoveryRequestPath,
  fenceGuardianReleaseRequestPath: guardian.releaseRequestPath,
  mongoWriteBarrierReceiptPath: barrierReceiptPath,
  mongoWriteBarrierArtifactPath: `${barrierReceiptPath}.prepared`,
  cutoverPlanPath: execution.cutoverPlanPath,
  cutoverPlanSha256: execution.cutoverPlanSha256,
  cutoverExecutionIndexPath: options.executionIndex,
  cutoverExecutionIndexSha256: options.expectedExecutionIndexSha256,
  fenceReceiptPath: execution.fenceReceiptPath,
  fenceReceiptSha256: execution.fenceReceiptSha256,
  migrationConnectionFile: execution.migrationConnectionFile,
  confirmationEnvironmentKey: "VIVA_GAME_PROJECTION_MONGO_BARRIER_RECOVER",
  confirmationValue: "RECOVER_VIVA_GAME_PROJECTION_MONGO_WRITE_BARRIER_V1",
});

async function executeVivaGameProjectionRemediationPreflightCore(
  options, dependencies, attemptId, journal, reportPath,
) {
  if (dependencies.bootstrapAttested !== true) {
    fail("Remediation preflight coordinator accepts only the attested private bootstrap");
  }
  if ((dependencies.getUid ? dependencies.getUid() : process.getuid?.()) !== 0) {
    fail("Remediation preflight coordinator requires root");
  }
  if ((dependencies.confirmation ?? process.env.VIVA_GAME_PROJECTION_REMEDIATION_PREFLIGHT) !== CONFIRMATION) {
    fail("Remediation preflight confirmation is absent");
  }
  const executionRead = readPrivateJson(options.executionIndex, "Cutover execution index", MAX_JSON_BYTES);
  assertHash(options.expectedExecutionIndexSha256, "Expected cutover execution-index digest");
  if (sha256(executionRead.bytes) !== options.expectedExecutionIndexSha256) {
    fail("Cutover execution-index digest mismatch");
  }
  const execution = executionRead.value;
  if (execution?.formatVersion !== 1 || execution.kind !== "viva-game-projection-cutover-execution-index"
    || !path.isAbsolute(String(execution.cutoverPlanPath || ""))
    || !path.isAbsolute(String(execution.packetManifestPath || ""))
    || !path.isAbsolute(String(execution.fenceReceiptPath || ""))
    || !path.isAbsolute(String(execution.liveFlowPath || ""))
    || !path.isAbsolute(String(execution.migrationConnectionFile || ""))
    || !path.isAbsolute(String(execution.mongoWriteBarrierReceiptOutputPath || ""))) {
    fail("Cutover execution-index contract is incomplete for remediation preflight");
  }
  for (const key of ["cutoverPlanSha256", "packetManifestSha256", "fenceReceiptSha256", "migrationConnectionFileSha256"]) {
    assertHash(execution[key], `Cutover execution index ${key}`);
  }
  const cutoverRead = readPrivateJson(execution.cutoverPlanPath, "Cutover plan", MAX_JSON_BYTES);
  const packetManifestRead = readPrivateJson(execution.packetManifestPath, "Cutover packet manifest", MAX_JSON_BYTES);
  const fenceRead = readPrivateJson(execution.fenceReceiptPath, "Writer fence receipt", MAX_JSON_BYTES);
  if (sha256(cutoverRead.bytes) !== execution.cutoverPlanSha256
    || sha256(packetManifestRead.bytes) !== execution.packetManifestSha256
    || sha256(fenceRead.bytes) !== execution.fenceReceiptSha256) {
    fail("Cutover preflight inputs changed after approval");
  }
  const plan = cutoverRead.value;
  if (plan?.kind !== "viva-game-projection-tenant-cutover-plan"
    || plan.state !== "READY_FOR_SEPARATE_LIVE_APPROVAL" || plan.liveMutationAuthorized !== false
    || sha256(String(execution.tenantKey || "")) !== plan.tenantKeySha256) {
    fail("Cutover plan is not eligible for remediation capture");
  }
  if (dependencies.assertExecutorSources) await dependencies.assertExecutorSources(plan);
  else assertExactExecutorSources(plan);

  const packetRoot = fs.realpathSync(path.dirname(execution.cutoverPlanPath));
  if (fs.realpathSync(path.dirname(execution.packetManifestPath)) !== packetRoot) {
    fail("Cutover packet manifest root mismatch");
  }
  if (dependencies.validateExactCutoverPacket) {
    await dependencies.validateExactCutoverPacket({ packetRoot, plan, manifest: packetManifestRead.value });
  } else {
    validateExactCutoverPacket({ packetRoot, plan, manifest: packetManifestRead.value, nowMs: nowMs(dependencies) });
  }
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
    nowMs: nowMs(dependencies),
  });
  if (dependencies.assertFenceLease) dependencies.assertFenceLease(fenceRead.value);
  else assertExclusiveFenceLease(fenceRead.value);

  const guardianReceiptPath = String(process.env.PADLHUB_CUTOVER_GUARDIAN_RECEIPT || "");
  const guardianRead = dependencies.guardianReceipt
    || readPrivateJson(guardianReceiptPath, "Fence guardian receipt", 1024 * 1024);
  const guardian = guardianRead.value || guardianRead;
  const guardianReceiptSha256 = dependencies.guardianReceipt
    ? sha256(canonicalJson(guardian)) : sha256(guardianRead.bytes);
  const expectedGuardianPid = dependencies.guardianReceipt
    ? guardian.pid : Number(process.env.PADLHUB_CUTOVER_GUARDIAN_PID);
  if (guardian?.kind !== "viva-game-projection-fence-guardian-receipt"
    || guardian.state !== "HOLDING_UNTIL_EXPLICIT_RELEASE" || guardian.pid !== expectedGuardianPid
    || guardian.lockPath !== plan.writerFence.lockPath
    || guardian.fenceTokenSha256 !== plan.writerFence.fenceTokenSha256 || guardian.automaticRelease !== false
    || !path.isAbsolute(String(guardian.recoveryExecutorPath || ""))
    || !HASH_RE.test(String(guardian.recoveryExecutorSha256 || ""))) {
    fail("Persistent fence guardian does not bind remediation preflight recovery");
  }
  if (fs.realpathSync(guardian.recoveryExecutorPath) !== guardian.recoveryExecutorPath
    || sha256(fs.readFileSync(guardian.recoveryExecutorPath)) !== guardian.recoveryExecutorSha256) {
    fail("Fence guardian recovery executor differs from its exact receipt");
  }
  if (dependencies.assertGuardianLease) await dependencies.assertGuardianLease(guardian, nowMs(dependencies));
  else if (!dependencies.guardianReceipt) assertLiveFenceGuardian(guardian, nowMs(dependencies));
  const revalidateFenceAndGuardian = async () => {
    const currentFenceRead = readPrivateJson(execution.fenceReceiptPath, "Writer fence receipt", MAX_JSON_BYTES);
    if (sha256(currentFenceRead.bytes) !== execution.fenceReceiptSha256) {
      fail("Writer fence receipt changed during remediation preflight");
    }
    validateHeldWriterFence(currentFenceRead.value, {
      sourceFlowSha256: plan.sourceFlowSha256,
      candidateSha256: plan.candidateSha256,
      tenantKey: execution.tenantKey,
      expectedOperationIds: plan.writerFence?.exactMigrationOperationIds,
      expectedWriterNodeIds: plan.writerFence?.exactWriterNodeIds,
      writerInventorySha256: plan.writerFence?.writerInventorySha256,
      externalWriterProofSha256: plan.writerFence?.externalWriterProofSha256,
      fenceTokenSha256: plan.writerFence?.fenceTokenSha256,
      lockPath: plan.writerFence?.lockPath,
      nowMs: nowMs(dependencies),
    });
    if (dependencies.assertFenceLease) dependencies.assertFenceLease(currentFenceRead.value);
    else assertExclusiveFenceLease(currentFenceRead.value);
    if (dependencies.assertGuardianLease) await dependencies.assertGuardianLease(guardian, nowMs(dependencies));
    else if (!dependencies.guardianReceipt) assertLiveFenceGuardian(guardian, nowMs(dependencies));
  };

  const pm2Rows = dependencies.inspectPm2 ? await dependencies.inspectPm2() : readPm2();
  const pm2Matches = Array.isArray(pm2Rows) ? pm2Rows.filter((entry) => entry?.name === plan.production?.processName) : [];
  const runtime = pm2Matches.length === 1 ? pm2Matches[0] : null;
  if (!runtime || runtime.pm_id !== plan.production.pm2ProcessId
    || String(runtime?.pm2_env?.status || "").toLowerCase() !== "stopped"
    || sha256(String(envValue(runtime, "PADLHUB_PLATFORM_TENANT_KEY") || "")) !== plan.tenantKeySha256
    || String(envValue(runtime, "VIVA_GAME_PROJECTION_SYNC_MODE") || "") !== "SHADOW") {
    fail("Node-RED is not stopped with the exact tenant and SHADOW mode");
  }
  assertPm2RuntimeIdentity(runtime, plan.production);

  const migrationBundle = buildMigrationPlanBundle(execution, packetRoot);
  const expectedServicePrincipalSha256 = providerPrincipalFromBundle(migrationBundle);
  if (dependencies.providerTokenValidated !== true || typeof dependencies.providerToken !== "string") {
    fail("Remediation provider credential was not validated before guardian and barrier custody");
  }
  const providerToken = dependencies.providerToken;
  const fullBackupPath = exactPacketPath(packetRoot, path.join(packetRoot, "evidence/full-backup.ejson"), "evidence/full-backup.ejson", "Full backup");
  const fullBackupManifestPath = exactPacketPath(packetRoot, path.join(packetRoot, "evidence/full-backup.manifest.json"), "evidence/full-backup.manifest.json", "Full backup manifest");
  const restoreReceiptPath = exactPacketPath(packetRoot, path.join(packetRoot, "evidence/full-backup.restore-rehearsal.json"), "evidence/full-backup.restore-rehearsal.json", "Restore rehearsal receipt");
  const restoredArtifactPath = exactPacketPath(packetRoot, path.join(packetRoot, "evidence/full-backup.restored.ejson"), "evidence/full-backup.restored.ejson", "Restored backup artifact");
  const fullBackupBytes = readPrivateBytes(fullBackupPath, "Full backup", MAX_BACKUP_BYTES);
  const fullBackupManifestRead = readPrivateJson(fullBackupManifestPath, "Full backup manifest", MAX_JSON_BYTES);
  const restoreReceiptRead = readPrivateJson(restoreReceiptPath, "Restore rehearsal receipt", MAX_JSON_BYTES);
  const restoredArtifactBytes = readPrivateBytes(restoredArtifactPath, "Restored backup artifact", MAX_BACKUP_BYTES);
  if (sha256(fullBackupBytes) !== plan.evidence?.backupSha256
    || sha256(fullBackupManifestRead.bytes) !== plan.evidence?.backupManifestSha256
    || sha256(restoredArtifactBytes) !== plan.evidence?.restoreArtifactSha256
    || restoreReceiptRead.value?.restoredArtifactSha256 !== plan.evidence?.restoreArtifactSha256) {
    fail("Cutover backup or restore evidence differs before remediation capture");
  }
  const skippedDocuments = selectRemediationSkippedDocuments({
    cutoverPlan: plan,
    migrationPlanBundle: migrationBundle.value,
    migrationPlanBundleBytes: migrationBundle.bytes,
    fullBackupBytes,
  });
  const dates = remediationCaptureDates(skippedDocuments);
  const barrierReceiptPath = path.resolve(execution.mongoWriteBarrierReceiptOutputPath);
  if (barrierReceiptPath !== execution.mongoWriteBarrierReceiptOutputPath
    || fs.existsSync(barrierReceiptPath) || fs.existsSync(`${barrierReceiptPath}.prepared`)) {
    fail("Mongo write-barrier output must be a new canonical path");
  }
  ensurePrivateDirectory(path.dirname(barrierReceiptPath), "Mongo write-barrier receipt parent");
  assertNewOutputDirectory(options.outputDirectory);
  assertDisjointPreflightPaths({
    packetRoot,
    execution,
    guardian: {
      ...guardian,
      receiptPath: dependencies.guardianReceipt ? options.guardianReceiptPath : guardianReceiptPath,
    },
    report: reportPath,
    outputDirectory: options.outputDirectory,
  });

  const liveFlowPath = fs.realpathSync(execution.liveFlowPath);
  if (liveFlowPath !== "/root/.node-red/flows.json" && !dependencies.allowFixturePaths) {
    fail("Live flow path is not the canonical production flow");
  }
  if (os.hostname() !== plan.production?.hostname && !dependencies.allowFixtureHostname) {
    fail("Remediation preflight host differs from the cutover plan");
  }
  const applicationConnection = readFlowConnection(liveFlowPath, plan.sourceFlowSha256);
  const migrationConnectionBytes = readPrivateBytes(
    execution.migrationConnectionFile, "Migration Mongo connection", 1024 * 1024,
  );
  if (sha256(migrationConnectionBytes) !== execution.migrationConnectionFileSha256) {
    fail("Migration Mongo connection digest mismatch");
  }
  const migrationConnection = readPrivateMongoConnection(
    execution.migrationConnectionFile, plan.mongoTarget.migrationConnectionFingerprint,
  );
  const recovery = recoveryBinding({
    guardian,
    guardianReceiptPath: dependencies.guardianReceipt ? options.guardianReceiptPath : guardianReceiptPath,
    guardianReceiptSha256,
    barrierReceiptPath,
    execution,
    options,
  });

  let barrierInstallAttempted = false;
  let barrierArtifact = null;
  let barrierPreparationArtifact = null;
  let failurePhase = "CONNECT_MONGO";
  let terminalFinalizationStarted = false;
  let applicationClient;
  let migrationClient;
  try {
    applicationClient = dependencies.applicationMongoClient || new MongoClient(applicationConnection.uri, {
      appName: "PadlHubVivaRemediationPreflightApplicationProbe", maxPoolSize: 1,
      serverSelectionTimeoutMS: 20_000, connectTimeoutMS: 20_000, socketTimeoutMS: 20_000, timeoutMS: 20_000,
    });
    migrationClient = dependencies.migrationMongoClient || new MongoClient(migrationConnection.uri, {
      appName: "PadlHubVivaRemediationPreflightMigration", maxPoolSize: 1,
      serverSelectionTimeoutMS: 20_000, connectTimeoutMS: 20_000, socketTimeoutMS: 20_000, timeoutMS: 20_000,
    });
    if (!dependencies.applicationMongoClient) await applicationClient.connect();
    if (!dependencies.migrationMongoClient) await migrationClient.connect();
    failurePhase = "REVALIDATE_FENCE_BEFORE_BARRIER";
    await revalidateFenceAndGuardian();
    journal.append("FENCE_REVALIDATED_BEFORE_MONGO_BARRIER");
    barrierInstallAttempted = true;
    failurePhase = "INSTALL_MONGO_WRITE_BARRIER";
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
          const bytes = Buffer.from(canonicalJson(preparation));
          barrierPreparationArtifact = {
            value: preparation,
            bytes,
            sha256: writePrivate(`${barrierReceiptPath}.prepared`, bytes),
          };
          journal.append("MONGO_WRITE_BARRIER_PREPARED", { preparedSha256: barrierPreparationArtifact.sha256 });
        },
      });
    if (barrierReceipt?.formatVersion !== 1
      || barrierReceipt.kind !== "viva-game-projection-mongo-write-barrier-receipt"
      || barrierReceipt.state !== "HELD"
      || barrierReceipt.fenceTokenSha256 !== plan.writerFence.fenceTokenSha256
      || barrierReceipt.cutoverPlanSha256 !== execution.cutoverPlanSha256
      || barrierReceipt.mongoTargetIdentitySha256 !== plan.mongoTarget.targetIdentitySha256
      || barrierReceipt.applicationConnectionFingerprint !== applicationConnection.connectionFingerprint
      || barrierReceipt.migrationConnectionFingerprint !== migrationConnection.connectionFingerprint
      || barrierReceipt.replicaSetName !== plan.mongoTarget.replicaSetName
      || !Number.isFinite(Date.parse(barrierReceipt.installedAt))) {
      fail("Mongo write-barrier receipt does not bind the remediation preflight");
    }
    const barrierBytes = Buffer.from(canonicalJson(barrierReceipt));
    barrierArtifact = { value: barrierReceipt, bytes: barrierBytes, sha256: writePrivate(barrierReceiptPath, barrierBytes) };
    if (!dependencies.installMongoWriteBarrier && !barrierPreparationArtifact) {
      fail("Mongo write-barrier recovery artifact was not durably prepared");
    }
    journal.append("MONGO_WRITE_BARRIER_HELD", { receiptSha256: barrierArtifact.sha256 });

    failurePhase = "COMPARE_FULL_BACKUP";
    const backupDocuments = BSON.EJSON.parse(fullBackupBytes.toString("utf8"), { relaxed: false });
    const backupState = hashFullCollectionDocuments(backupDocuments);
    const liveState = dependencies.hashLiveFullCollection
      ? await dependencies.hashLiveFullCollection(migrationClient.db("games").collection("lk_games"))
      : await hashLiveFullCollection(migrationClient.db("games").collection("lk_games"));
    if (backupState.documentCount !== liveState.documentCount
      || backupState.fullCollectionStateSha256 !== plan.evidence.fullCollectionStateSha256
      || liveState.fullCollectionStateSha256 !== plan.evidence.fullCollectionStateSha256) {
      fail("Live games.lk_games state differs from the full backup under the Mongo barrier");
    }
    if (dependencies.assertMongoWriteBarrier) await dependencies.assertMongoWriteBarrier(barrierReceipt);
    else await assertMongoWriteBarrier(migrationClient, barrierReceipt, {
      fenceTokenSha256: plan.writerFence.fenceTokenSha256,
      cutoverPlanSha256: execution.cutoverPlanSha256,
      mongoTargetIdentitySha256: plan.mongoTarget.targetIdentitySha256,
      migrationAuthenticationRestrictions: migrationConnection.authenticationRestrictions,
    });
    journal.append("FULL_BACKUP_MATCHED_AND_BARRIER_REVALIDATED", liveState);

    failurePhase = "CAPTURE_VIVA_PROVIDER";
    const capturePass = async (pass) => (dependencies.captureProviderRows
      ? dependencies.captureProviderRows({ dates, expectedServicePrincipalSha256, pass })
      : captureProviderRows(dates, providerToken, dependencies.fetch));
    const firstProviderCapture = await capturePass(1);
    const secondProviderCapture = await capturePass(2);
    const providerRows = assertStableProviderCapture(firstProviderCapture, secondProviderCapture, dates);
    const providerCapturePasses = [firstProviderCapture, secondProviderCapture].map((capture, index) => ({
      pass: index + 1,
      canonicalRowsSha256: capture.canonicalRowsSha256,
      captureTreeSha256: capture.captureTreeSha256,
      dates: capture.dates,
    }));
    const providerCapturedAt = new Date(nowMs(dependencies)).toISOString();
    const skippedIds = skippedDocuments.map((document) => new ObjectId(document._id.toHexString()));
    failurePhase = "CAPTURE_MONGO_PREIMAGES";
    const mongoDocuments = dependencies.readMongoDocuments
      ? await dependencies.readMongoDocuments({ ids: skippedIds, migrationClient })
      : await migrationClient.db("games").collection("lk_games")
        .find({ _id: { $in: skippedIds } }).sort({ _id: 1 }).toArray();
    const mongoCapturedAt = new Date(nowMs(dependencies)).toISOString();
    if (Date.parse(barrierReceipt.installedAt) > Date.parse(providerCapturedAt)
      || Date.parse(providerCapturedAt) > Date.parse(mongoCapturedAt)) {
      fail("Remediation capture timestamps do not follow barrier installation");
    }
    failurePhase = "REVALIDATE_CAPTURE_CUSTODY";
    await revalidateFenceAndGuardian();
    if (dependencies.assertMongoWriteBarrier) await dependencies.assertMongoWriteBarrier(barrierReceipt);
    else await assertMongoWriteBarrier(migrationClient, barrierReceipt, {
      fenceTokenSha256: plan.writerFence.fenceTokenSha256,
      cutoverPlanSha256: execution.cutoverPlanSha256,
      mongoTargetIdentitySha256: plan.mongoTarget.targetIdentitySha256,
      migrationAuthenticationRestrictions: migrationConnection.authenticationRestrictions,
    });
    const finalLiveState = dependencies.hashLiveFullCollection
      ? await dependencies.hashLiveFullCollection(migrationClient.db("games").collection("lk_games"))
      : await hashLiveFullCollection(migrationClient.db("games").collection("lk_games"));
    if (finalLiveState.documentCount !== liveState.documentCount
      || finalLiveState.fullCollectionStateSha256 !== liveState.fullCollectionStateSha256) {
      fail("Live games.lk_games state drifted during remediation provider capture");
    }
    journal.append("CAPTURE_CUSTODY_REVALIDATED", finalLiveState);
    const captureSessionId = dependencies.captureSessionId || `viva-remediation-${attemptId}`;
    failurePhase = "BUILD_V2_EVIDENCE";
    const evidence = buildVivaGameProjectionRemediationEvidence({
      cutoverPlan: plan,
      migrationPlanBundle: migrationBundle.value,
      migrationPlanBundleBytes: migrationBundle.bytes,
      fullBackupBytes,
      mongoDocuments,
      providerRows,
      captureSessionId,
      tenantKey: execution.tenantKey,
      servicePrincipalSha256: expectedServicePrincipalSha256,
      fenceTokenSha256: plan.writerFence.fenceTokenSha256,
      providerCapturedAt,
      mongoCapturedAt,
      providerCapturePasses,
    });
    failurePhase = "PUBLISH_V2_EVIDENCE";
    const publication = publishEvidence({
      outputDirectory: options.outputDirectory,
      evidence,
      migrationPlanBundle: migrationBundle,
      bindings: {
        captureSessionId,
        cutoverPlanSha256: execution.cutoverPlanSha256,
        fenceReceiptSha256: execution.fenceReceiptSha256,
        mongoWriteBarrierReceiptSha256: barrierArtifact.sha256,
        sourceFlowSha256: plan.sourceFlowSha256,
      },
    });
    journal.append("REMEDIATION_V2_EVIDENCE_PUBLISHED", {
      evidenceManifestSha256: publication.manifestSha256,
      outputDirectory: publication.output,
    });
    const report = {
      formatVersion: 1,
      kind: "viva-game-projection-remediation-preflight-report",
      state: "EVIDENCE_READY_BARRIERS_HELD_RUNTIME_STOPPED",
      outcome: "SUCCEEDED",
      attemptId,
      cutoverExecutionIndexSha256: options.expectedExecutionIndexSha256,
      cutoverPlanSha256: execution.cutoverPlanSha256,
      fenceReceiptSha256: execution.fenceReceiptSha256,
      mongoWriteBarrierReceiptSha256: barrierArtifact.sha256,
      evidenceOutputDirectory: publication.output,
      evidenceManifestSha256: publication.manifestSha256,
      captureSessionId,
      remediationCounts: evidence.counts,
      nodeRedState: "STOPPED",
      mongoWriteBarrierState: "HELD",
      fenceGuardianState: "HOLDING_UNTIL_EXPLICIT_RELEASE",
      gameDocumentWritesPerformed: 0,
      providerWritesPerformed: 0,
      tenantMigrationApplied: false,
      candidatePublished: false,
      nodeRedRestarted: false,
      mutationAttempted: true,
      operatorActionRequired: true,
      recovery: {
        ...recovery,
        mongoWriteBarrierArtifactSha256: barrierPreparationArtifact?.sha256 || null,
      },
      completedAt: new Date(nowMs(dependencies)).toISOString(),
    };
    failurePhase = "FINALIZE_SUCCESS_REPORT";
    terminalFinalizationStarted = true;
    journal.finalize(report);
    return report;
  } catch {
    if (terminalFinalizationStarted) {
      throw new Error("Remediation preflight success-report publication is incomplete; custody remains fail-closed");
    }
    const report = {
      formatVersion: 1,
      kind: "viva-game-projection-remediation-preflight-report",
      state: barrierArtifact
        ? "FAILED_BARRIERS_HELD_RUNTIME_STOPPED"
        : barrierInstallAttempted
          ? "FAILED_BARRIER_OUTCOME_UNKNOWN_FENCE_HELD_RUNTIME_STOPPED"
          : "FAILED_FENCE_HELD_RUNTIME_STOPPED",
      outcome: "FAILED",
      attemptId,
      failurePhase,
      barrierInstallAttempted,
      mongoWriteBarrierState: barrierArtifact ? "HELD" : barrierInstallAttempted ? "OUTCOME_UNKNOWN" : "NOT_INSTALLED",
      fenceGuardianState: "HOLDING_UNTIL_EXPLICIT_RELEASE",
      nodeRedState: "STOPPED",
      gameDocumentWritesPerformed: 0,
      providerWritesPerformed: 0,
      tenantMigrationApplied: false,
      candidatePublished: false,
      nodeRedRestarted: false,
      mutationAttempted: barrierInstallAttempted,
      operatorActionRequired: true,
      recovery: {
        ...recovery,
        mongoWriteBarrierArtifactSha256: barrierPreparationArtifact?.sha256 || null,
      },
      completedAt: new Date(nowMs(dependencies)).toISOString(),
    };
    journal.finalize(report);
    const wrapped = new Error(`Remediation preflight failed during ${failurePhase}; it remains fail-closed`);
    wrapped.report = report;
    throw wrapped;
  } finally {
    if (!dependencies.applicationMongoClient) await applicationClient?.close().catch(() => {});
    if (!dependencies.migrationMongoClient) await migrationClient?.close().catch(() => {});
  }
}

export async function executeVivaGameProjectionRemediationPreflight(options, dependencies = {}) {
  const attemptId = dependencies.attemptId || crypto.randomUUID();
  const reportPath = path.resolve(options?.report || "");
  if (!path.isAbsolute(String(options?.report || "")) || reportPath !== options.report) {
    fail("Remediation preflight report path must be canonical");
  }
  const executionRead = readPrivateJson(options.executionIndex, "Cutover execution index", MAX_JSON_BYTES);
  if (!HASH_RE.test(String(options.expectedExecutionIndexSha256 || ""))
    || sha256(executionRead.bytes) !== options.expectedExecutionIndexSha256
    || !path.isAbsolute(String(executionRead.value?.cutoverPlanPath || ""))
    || !path.isAbsolute(String(executionRead.value?.mongoWriteBarrierReceiptOutputPath || ""))) {
    fail("Cutover execution index cannot establish preflight journal custody");
  }
  const packetRoot = fs.realpathSync(path.dirname(executionRead.value.cutoverPlanPath));
  assertDisjointPreflightPaths({
    packetRoot,
    execution: executionRead.value,
    guardian: dependencies.guardianReceipt ? {
      ...dependencies.guardianReceipt,
      receiptPath: options.guardianReceiptPath,
    } : {
      receiptPath: process.env.PADLHUB_CUTOVER_GUARDIAN_RECEIPT,
      heartbeatPath: process.env.PADLHUB_CUTOVER_GUARDIAN_HEARTBEAT,
      releaseRequestPath: process.env.PADLHUB_CUTOVER_GUARDIAN_RELEASE_REQUEST,
      recoveryRequestPath: process.env.PADLHUB_CUTOVER_GUARDIAN_RECOVERY_REQUEST,
      readyRequestPath: process.env.PADLHUB_CUTOVER_GUARDIAN_READY_REQUEST,
    },
    report: reportPath,
    outputDirectory: options.outputDirectory,
  });
  ensurePrivateDirectory(path.dirname(reportPath), "Remediation preflight report parent");
  const journal = createDurableReportJournal(reportPath, "remediation-preflight", attemptId);
  try {
    return await executeVivaGameProjectionRemediationPreflightCore(
      options, dependencies, attemptId, journal, reportPath,
    );
  } catch (error) {
    if (error?.report) throw error;
    const report = {
      formatVersion: 1,
      kind: "viva-game-projection-remediation-preflight-report",
      state: "FAILED_PRE_BARRIER_VALIDATION_CUSTODY_UNVERIFIED",
      outcome: "FAILED",
      attemptId,
      failurePhase: "PRE_BARRIER_VALIDATION",
      barrierInstallAttempted: false,
      mongoWriteBarrierState: "NOT_INSTALLED",
      fenceGuardianState: "UNVERIFIED",
      nodeRedState: "UNVERIFIED",
      gameDocumentWritesPerformed: 0,
      providerWritesPerformed: 0,
      tenantMigrationApplied: false,
      candidatePublished: false,
      nodeRedRestarted: false,
      mutationAttempted: false,
      operatorActionRequired: true,
      recovery: {
        automaticRecovery: false,
        cutoverExecutionIndexPath: options.executionIndex,
        cutoverExecutionIndexSha256: options.expectedExecutionIndexSha256,
        fenceGuardianReceiptPath: dependencies.guardianReceipt
          ? options.guardianReceiptPath : process.env.PADLHUB_CUTOVER_GUARDIAN_RECEIPT,
        fenceGuardianRecoveryRequestPath: dependencies.guardianReceipt?.recoveryRequestPath
          || process.env.PADLHUB_CUTOVER_GUARDIAN_RECOVERY_REQUEST,
        mongoWriteBarrierReceiptPath: executionRead.value.mongoWriteBarrierReceiptOutputPath,
        mongoWriteBarrierArtifactPath: `${executionRead.value.mongoWriteBarrierReceiptOutputPath}.prepared`,
      },
      completedAt: new Date(nowMs(dependencies)).toISOString(),
    };
    journal.finalize(report);
    const wrapped = new Error("Remediation preflight failed during pre-barrier validation; custody remains fail-closed");
    wrapped.report = report;
    throw wrapped;
  }
}

export function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--") || Object.hasOwn(values, key)) {
      fail(`Invalid argument: ${key || ""}`);
    }
    values[key] = value;
  }
  const required = ["--execution-index", "--expected-execution-index-sha256", "--output-directory", "--report"];
  if (Object.keys(values).some((key) => !required.includes(key))) fail("Unknown remediation preflight argument");
  for (const key of required) if (!values[key]) fail(`Missing ${key}`);
  return {
    executionIndex: values["--execution-index"],
    expectedExecutionIndexSha256: values["--expected-execution-index-sha256"],
    outputDirectory: values["--output-directory"],
    report: values["--report"],
  };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(SCRIPT_PATH)) {
  process.stderr.write("Direct remediation preflight coordinator invocation is rejected; use the externally pinned private launcher\n");
  process.exitCode = 1;
}
