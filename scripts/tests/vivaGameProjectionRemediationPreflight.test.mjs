import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BSON, ObjectId } from "mongodb";

import { canonicalJson, sha256 } from "../lib/vivaGameProjectionCutoverContract.mjs";
import { hashFullCollectionDocuments } from "../lib/vivaGameProjectionMongoWriteBarrier.mjs";
import {
  buildVivaGameProjectionRemediationEvidence,
  normalizeVivaRemediationProviderRow,
} from "../lib/vivaGameProjectionRemediationEvidence.mjs";
import { buildRemediationExecutionPlan } from "../lib/vivaGameProjectionRemediationPackage.mjs";
import {
  REMEDIATION_EXECUTOR_SOURCE_PATHS,
  REMEDIATION_RUNTIME_PACKAGE_NAMES,
  validateExecutableRemediationPlan,
} from "../lib/vivaGameProjectionRemediationExecution.mjs";
import {
  assertDisjointPreflightPaths,
  assertStableProviderCapture,
  executeVivaGameProjectionRemediationPreflight,
  parseArgs,
} from "../run_viva_game_projection_remediation_preflight.mjs";
import {
  assertAttestedFenceLease,
  PREFLIGHT_EXECUTOR_SOURCE_PATHS,
} from "../run_viva_game_projection_remediation_preflight_bootstrap.mjs";

const writePrivate = (filePath, value, canonical = true) => {
  const bytes = Buffer.isBuffer(value)
    ? value
    : Buffer.from(canonical ? canonicalJson(value) : `${JSON.stringify(value, null, 2)}\n`);
  fs.writeFileSync(filePath, bytes, { mode: 0o600, flag: "wx" });
  fs.chmodSync(filePath, 0o600);
  return { bytes, sha256: sha256(bytes), value: Buffer.isBuffer(value) ? undefined : value };
};

const privateRoot = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "viva-remediation-preflight-test-"));
  fs.chmodSync(root, 0o700);
  return fs.realpathSync(root);
};

const stableProviderPasses = (rows, requestedDates = null) => {
  const normalized = rows.map((row) => normalizeVivaRemediationProviderRow(row))
    .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  const canonicalRowsSha256 = sha256(canonicalJson(normalized));
  const defaultDates = new Set();
  for (const date of new Set(normalized.map((row) => row.date))) {
    for (let offset = -7; offset <= 7; offset += 1) {
      const value = new Date(`${date}T00:00:00.000Z`);
      value.setUTCDate(value.getUTCDate() + offset);
      defaultDates.add(value.toISOString().slice(0, 10));
    }
  }
  const dates = (requestedDates || [...defaultDates].sort()).map((date) => {
    const dateRows = normalized.filter((row) => row.date === date);
    return {
      date,
      rowCount: dateRows.length,
      rawPayloadSha256: sha256(canonicalJson(dateRows)),
      canonicalRowsSha256: sha256(canonicalJson(dateRows)),
    };
  });
  const captureTreeSha256 = sha256(canonicalJson(dates.map(({ date, rowCount, canonicalRowsSha256: dateSha256 }) => ({
    date, rowCount, canonicalRowsSha256: dateSha256,
  }))));
  return [1, 2].map((pass) => ({ pass, dates, canonicalRowsSha256, captureTreeSha256 }));
};

const runtimeDependencies = () => {
  const packageJsonBytes = Buffer.from("{}\n");
  const packageEntries = Object.fromEntries(REMEDIATION_RUNTIME_PACKAGE_NAMES.map((name, index) => [
    `node_modules/${name}`,
    {
      version: `1.0.${index}`,
      integrity: `sha512-${Buffer.from(`integrity:${name}`).toString("base64")}`,
    },
  ]));
  const packageLockBytes = Buffer.from(`${JSON.stringify({ lockfileVersion: 3, packages: packageEntries })}\n`);
  return {
    formatVersion: 1,
    kind: "viva-game-projection-runtime-dependency-snapshot",
    installMethod: "fresh-private-npm-ci-ignore-scripts-omit-dev",
    packageJsonSha256: sha256(packageJsonBytes),
    packageJsonBytesBase64: packageJsonBytes.toString("base64"),
    packageLockSha256: sha256(packageLockBytes),
    packageLockBytesBase64: packageLockBytes.toString("base64"),
    packages: REMEDIATION_RUNTIME_PACKAGE_NAMES.map((name) => ({ name, ...packageEntries[`node_modules/${name}`] })),
    files: REMEDIATION_RUNTIME_PACKAGE_NAMES.map((name) => {
      const bytes = Buffer.from(`${JSON.stringify({ name })}\n`);
      return {
        path: `node_modules/${name}/package.json`,
        size: bytes.length,
        sha256: sha256(bytes),
        bytesBase64: bytes.toString("base64"),
      };
    }).sort((left, right) => left.path.localeCompare(right.path)),
  };
};

function evidenceFixture(root = privateRoot()) {
  const tenantKey = "iSkq6G";
  const sourceFlowBytes = Buffer.from(`${JSON.stringify([{
    id: "4e820638cc39c730",
    type: "mongodb4-client",
    uri: "mongodb://application.invalid/games?replicaSet=rs-test",
    dbName: "games",
  }])}\n`);
  const sourceFlowSha256 = sha256(sourceFlowBytes);
  const applicationConnectionFingerprint = sha256("mongodb://application.invalid/games?replicaSet=rs-test");
  const migrationUri = "mongodb://migration.invalid/games?replicaSet=rs-test";
  const migrationConnectionFingerprint = sha256(migrationUri);
  const fenceToken = "fixture-remediation-preflight-fence-token";
  const fenceTokenSha256 = sha256(fenceToken);
  const servicePrincipalSha256 = "b".repeat(64);
  const mongoTargetIdentitySha256 = "c".repeat(64);
  const ids = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    "33333333-3333-4333-8333-333333333333",
    "44444444-4444-4444-8444-444444444444",
    "55555555-5555-4555-8555-555555555555",
  ];
  const documents = ids.map((id, index) => ({
    _id: new ObjectId(String(index + 1).repeat(24)),
    id: `pay_fixture_${index}`,
    tenantKey: null,
    revision: null,
    status: "PAID",
    archived: false,
    dedupeKey: `viva:${id}`,
    updatedAt: `2026-09-06T09:0${index}:00.000Z`,
    booking: {
      vivaExerciseId: id,
      exerciseId: id,
      studioId: "studio-piter",
      date: "2026-09-07",
      timeFrom: "12:00",
      timeTo: "14:00",
    },
    metadata: { vivaExerciseId: id, exerciseId: id },
    audit: { events: [] },
  }));
  documents[3].metadata.vivaExerciseId = ids[0];
  documents[3].metadata.exerciseId = ids[0];
  const providerRows = [
    { id: ids[0], studioId: "studio-piter", date: "2026-09-07", timeFrom: "12:00", timeTo: "14:00", status: "CANCELLED", cancelled: true },
    { id: ids[2], studioId: "studio-piter", date: "2026-09-07", timeFrom: "13:00", timeTo: "15:00", status: "ACTIVE", active: true },
    { id: ids[3], studioId: "studio-piter", date: "2026-09-07", timeFrom: "12:00", timeTo: "14:00", status: "ACTIVE", active: true },
  ];
  const fullBackupBytes = Buffer.from(`${BSON.EJSON.stringify(documents, null, 2, { relaxed: false })}\n`);
  const fullState = hashFullCollectionDocuments(documents);
  const migrationPlanValue = {
    formatVersion: 1,
    eligibleCount: 1,
    source: { providerServicePrincipalSha256: servicePrincipalSha256 },
    operations: [{ filter: { _id: { $oid: documents[4]._id.toHexString() } } }],
  };
  const migrationPlanBytes = Buffer.from(`${JSON.stringify(migrationPlanValue, null, 2)}\n`);
  const migrationPlanSha256 = sha256(migrationPlanBytes);
  const migrationBundle = {
    value: {
      formatVersion: 1,
      kind: "viva-game-projection-migration-plan-bundle",
      plans: [{ sha256: migrationPlanSha256, bytesBase64: migrationPlanBytes.toString("base64") }],
    },
  };
  migrationBundle.bytes = Buffer.from(canonicalJson(migrationBundle.value));
  const plan = {
    formatVersion: 1,
    kind: "viva-game-projection-tenant-cutover-plan",
    state: "READY_FOR_SEPARATE_LIVE_APPROVAL",
    repository: { commit: "4".repeat(40), branch: "codex/remediation-preflight-fixture" },
    executorSources: [{ path: "scripts/fixture.mjs", sha256: "9".repeat(64) }],
    executorSourcesSha256: "8".repeat(64),
    sourceFlowSha256,
    candidateSha256: "d".repeat(64),
    tenantKeySha256: sha256(tenantKey),
    liveMutationAuthorized: false,
    production: {
      hostAlias: "lk-primary-147",
      hostname: "fixture-host",
      processName: "node-red",
      pm2ProcessId: 0,
      pmExecPath: "/usr/local/bin/node-red",
      pmCwd: "/root/.node-red",
      pmArgsSha256: sha256(canonicalJson([])),
      pmNodeArgsSha256: sha256(canonicalJson([])),
    },
    writerFence: {
      exactMigrationOperationIds: ["fixture-remediation-operation"],
      exactWriterNodeIds: ["writer-fixture"],
      writerInventorySha256: "1".repeat(64),
      externalWriterProofSha256: "2".repeat(64),
      fenceTokenSha256,
      lockPath: "/run/lock/padlhub-viva-game-projection-cutover.lock",
    },
    mongoTarget: {
      targetIdentitySha256: mongoTargetIdentitySha256,
      connectionFingerprint: applicationConnectionFingerprint,
      migrationConnectionFingerprint,
      replicaSetName: "rs-test",
    },
    evidence: {
      backupSha256: sha256(fullBackupBytes),
      backupManifestSha256: null,
      fullCollectionStateSha256: fullState.fullCollectionStateSha256,
      restoreArtifactSha256: sha256(fullBackupBytes),
    },
    migration: {
      futureBoundaryDate: "2026-09-06",
      futureBoundaryTimeZone: "UTC",
      planSha256s: [migrationPlanSha256],
      totalEligible: 1,
      totalSkipped: 4,
    },
  };
  return {
    root,
    tenantKey,
    plan,
    documents,
    providerRows,
    migrationBundle,
    migrationPlanBytes,
    migrationPlanSha256,
    fullBackupBytes,
    fullState,
    fenceToken,
    fenceTokenSha256,
    servicePrincipalSha256,
    mongoTargetIdentitySha256,
    migrationUri,
    sourceFlowBytes,
  };
}

test("v2 generator creates all four deterministic remediation categories accepted by the executor", () => {
  const fixture = evidenceFixture();
  const providerCapturedAt = "2026-09-06T10:01:00.000Z";
  const mongoCapturedAt = "2026-09-06T10:02:00.000Z";
  const captureSessionId = "remediation-preflight-fixture-01";
  const evidence = buildVivaGameProjectionRemediationEvidence({
    cutoverPlan: fixture.plan,
    migrationPlanBundle: fixture.migrationBundle.value,
    migrationPlanBundleBytes: fixture.migrationBundle.bytes,
    fullBackupBytes: fixture.fullBackupBytes,
    mongoDocuments: fixture.documents.slice(0, 4),
    providerRows: fixture.providerRows,
    captureSessionId,
    tenantKey: fixture.tenantKey,
    servicePrincipalSha256: fixture.servicePrincipalSha256,
    fenceTokenSha256: fixture.fenceTokenSha256,
    providerCapturedAt,
    mongoCapturedAt,
    providerCapturePasses: stableProviderPasses(fixture.providerRows),
  });
  assert.deepEqual(evidence.counts, {
    CANCEL_AND_ARCHIVE: 1,
    QUARANTINE_AND_ARCHIVE: 1,
    RECONCILE_PROVIDER_TIME: 1,
    REPAIR_METADATA_IDENTITY: 1,
  });
  assert.throws(() => buildVivaGameProjectionRemediationEvidence({
    cutoverPlan: fixture.plan,
    migrationPlanBundle: fixture.migrationBundle.value,
    migrationPlanBundleBytes: fixture.migrationBundle.bytes,
    fullBackupBytes: fixture.fullBackupBytes,
    mongoDocuments: fixture.documents.slice(0, 4),
    providerRows: [...fixture.providerRows, {
      id: "22222222-2222-4222-8222-222222222222",
      studioId: "another-studio",
      date: "2026-09-07",
      timeFrom: "12:00",
      timeTo: "14:00",
      status: "ACTIVE",
      active: true,
    }],
    captureSessionId,
    tenantKey: fixture.tenantKey,
    servicePrincipalSha256: fixture.servicePrincipalSha256,
    fenceTokenSha256: fixture.fenceTokenSha256,
    providerCapturedAt,
    mongoCapturedAt,
    providerCapturePasses: stableProviderPasses([...fixture.providerRows, {
      id: "22222222-2222-4222-8222-222222222222",
      studioId: "another-studio",
      date: "2026-09-07",
      timeFrom: "12:00",
      timeTo: "14:00",
      status: "ACTIVE",
      active: true,
    }]),
  }), /remains ambiguous/);
  assert.throws(() => normalizeVivaRemediationProviderRow({
    id: fixture.providerRows[1].id,
    exerciseId: fixture.providerRows[2].id,
    studio: { id: "studio-piter" },
    studioId: "other-studio",
    date: "2026-09-07",
    timeFrom: "2026-09-08T13:00:00Z",
    timeTo: "2026-09-08T15:00:00Z",
    status: "ACTIVE",
    state: "CANCELLED",
    active: true,
  }), /aliases are ambiguous/);

  const rootIdentityConflict = BSON.EJSON.parse(
    BSON.EJSON.stringify(fixture.documents, null, 0, { relaxed: false }), { relaxed: false },
  );
  rootIdentityConflict[2].id = `viva_${fixture.providerRows[0].id}`;
  const rootIdentityConflictBytes = Buffer.from(`${BSON.EJSON.stringify(
    rootIdentityConflict, null, 2, { relaxed: false },
  )}\n`);
  assert.throws(() => buildVivaGameProjectionRemediationEvidence({
    cutoverPlan: fixture.plan,
    migrationPlanBundle: fixture.migrationBundle.value,
    migrationPlanBundleBytes: fixture.migrationBundle.bytes,
    fullBackupBytes: rootIdentityConflictBytes,
    mongoDocuments: rootIdentityConflict.slice(0, 4),
    providerRows: fixture.providerRows,
    captureSessionId,
    tenantKey: fixture.tenantKey,
    servicePrincipalSha256: fixture.servicePrincipalSha256,
    fenceTokenSha256: fixture.fenceTokenSha256,
    providerCapturedAt,
    mongoCapturedAt,
    providerCapturePasses: stableProviderPasses(fixture.providerRows),
  }), /postimage is not tenant-migration eligible/);

  const duplicateRepairRows = [...fixture.providerRows, {
    ...fixture.providerRows[2], timeFrom: "15:00", timeTo: "17:00",
  }];
  assert.throws(() => buildVivaGameProjectionRemediationEvidence({
    cutoverPlan: fixture.plan,
    migrationPlanBundle: fixture.migrationBundle.value,
    migrationPlanBundleBytes: fixture.migrationBundle.bytes,
    fullBackupBytes: fixture.fullBackupBytes,
    mongoDocuments: fixture.documents.slice(0, 4),
    providerRows: duplicateRepairRows,
    captureSessionId,
    tenantKey: fixture.tenantKey,
    servicePrincipalSha256: fixture.servicePrincipalSha256,
    fenceTokenSha256: fixture.fenceTokenSha256,
    providerCapturedAt,
    mongoCapturedAt,
    providerCapturePasses: stableProviderPasses(duplicateRepairRows),
  }), /postimage is not tenant-migration eligible/);

  const backupManifest = {
    formatVersion: 1,
    kind: "viva-game-projection-full-lk-games-backup-manifest",
    backupSha256: sha256(fixture.fullBackupBytes),
    fullCollectionStateSha256: fixture.fullState.fullCollectionStateSha256,
    mongoTargetIdentitySha256: fixture.mongoTargetIdentitySha256,
    artifactPath: path.join(fixture.root, "full-backup.ejson"),
    fenceTokenSha256: fixture.fenceTokenSha256,
    database: "games",
    collection: "lk_games",
    documentCount: fixture.documents.length,
    startedAt: "2026-09-06T10:00:10.000Z",
    completedAt: "2026-09-06T10:00:20.000Z",
  };
  const backupManifestArtifact = { value: backupManifest, bytes: Buffer.from(canonicalJson(backupManifest)) };
  fixture.plan.evidence.backupManifestSha256 = sha256(backupManifestArtifact.bytes);
  const cutoverPlanBytes = Buffer.from(canonicalJson(fixture.plan));
  const cutoverPlanSha256 = sha256(cutoverPlanBytes);
  const fenceReceipt = {
    formatVersion: 1,
    kind: "viva-game-projection-writer-fence-receipt",
    state: "HELD",
    fenceToken: fixture.fenceToken,
    sourceFlowSha256: fixture.plan.sourceFlowSha256,
    tenantKey: fixture.tenantKey,
    candidateSha256: fixture.plan.candidateSha256,
    operationIds: fixture.plan.writerFence.exactMigrationOperationIds,
    writerNodeIds: fixture.plan.writerFence.exactWriterNodeIds,
    writerInventorySha256: fixture.plan.writerFence.writerInventorySha256,
    externalWriterProofSha256: fixture.plan.writerFence.externalWriterProofSha256,
    lockPath: fixture.plan.writerFence.lockPath,
    nodeRedProcessState: "STOPPED",
    ingressWriteRoutesBlocked: true,
    internalSchedulersStopped: true,
    allLkGamesWritersQuiescent: true,
    externalMongoWritersBlocked: true,
    observedAt: "2026-09-06T10:00:00.000Z",
    expiresAt: "2026-09-06T10:30:00.000Z",
  };
  const barrier = {
    formatVersion: 1,
    kind: "viva-game-projection-mongo-write-barrier-receipt",
    state: "HELD",
    fenceTokenSha256: fixture.fenceTokenSha256,
    cutoverPlanSha256,
    mongoTargetIdentitySha256: fixture.mongoTargetIdentitySha256,
    applicationConnectionFingerprint: fixture.plan.mongoTarget.connectionFingerprint,
    migrationConnectionFingerprint: fixture.plan.mongoTarget.migrationConnectionFingerprint,
    replicaSetName: "rs-test",
    installedAt: "2026-09-06T10:00:45.000Z",
  };
  const connection = {
    formatVersion: 1,
    kind: "viva-game-projection-migration-mongo-connection",
    uri: fixture.migrationUri,
    authenticationRestrictions: [{ clientSource: ["127.0.0.1"], serverAddress: ["127.0.0.1"] }],
  };
  const restore = {
    formatVersion: 1,
    kind: "viva-game-projection-full-backup-restore-rehearsal",
    backupSha256: sha256(fixture.fullBackupBytes),
    manifestSha256: sha256(backupManifestArtifact.bytes),
    fullCollectionStateSha256: fixture.fullState.fullCollectionStateSha256,
    mongoTargetIdentitySha256: fixture.mongoTargetIdentitySha256,
    isolatedTargetIdentitySha256: "3".repeat(64),
    restoredArtifactPath: path.join(fixture.root, "restored.ejson"),
    restoredArtifactSha256: sha256(fixture.fullBackupBytes),
    restoredDocumentCount: fixture.documents.length,
    isolatedTarget: true,
    postRestoreHashMatch: true,
    rehearsedAt: "2026-09-06T10:00:30.000Z",
  };
  const artifact = (value) => ({ value, bytes: Buffer.from(canonicalJson(value)) });
  const artifacts = {
    cutoverPlan: { value: fixture.plan, bytes: cutoverPlanBytes },
    migrationPlanBundle: { value: fixture.migrationBundle.value, bytes: fixture.migrationBundle.bytes },
    packet: evidence.packet,
    enrichment: evidence.enrichment,
    identityAudit: evidence.identityAudit,
    providerCapture: evidence.providerCapture,
    mongoCapture: evidence.mongoCapture,
    fullBackup: { bytes: fixture.fullBackupBytes },
    fullBackupManifest: backupManifestArtifact,
    restoreRehearsalReceipt: artifact(restore),
    restoredArtifact: { bytes: fixture.fullBackupBytes },
    fenceReceipt: artifact(fenceReceipt),
    mongoWriteBarrierReceipt: artifact(barrier),
    migrationConnectionFile: artifact(connection),
    flow: { bytes: fixture.sourceFlowBytes },
  };
  const executorSources = REMEDIATION_EXECUTOR_SOURCE_PATHS.map((sourcePath, index) => ({
    path: sourcePath,
    sha256: sha256(`${index}:${sourcePath}`),
  }));
  const dependencies = runtimeDependencies();
  const plan = buildRemediationExecutionPlan({
    artifacts,
    generatedAt: "2026-09-06T10:03:00.000Z",
    mutationAt: "2026-09-06T10:04:00.000Z",
    operationId: "viva-remediation-fixture-01",
    repository: { commit: "4".repeat(40), branch: "codex/remediation-fixture" },
    executorSources,
    runtimeDependencies: dependencies,
  });
  const planBytes = Buffer.from(`${JSON.stringify(plan, null, 2)}\n`);
  assert.equal(validateExecutableRemediationPlan(plan, {
    expectedPlanSha256: sha256(planBytes),
    planBytes,
    artifacts,
    expectedExecutorSourcesSha256: plan.executorSourcesSha256,
    nowMs: Date.parse("2026-09-06T10:05:00.000Z"),
  }).operations.length, 4);
});

test("preflight coordinator publishes v2 captures and leaves all operational barriers held", async () => {
  const fixture = evidenceFixture();
  const packetRoot = path.join(fixture.root, "cutover-packet");
  fs.mkdirSync(packetRoot, { mode: 0o700 });
  fs.mkdirSync(path.join(packetRoot, "evidence"), { mode: 0o700 });
  fs.mkdirSync(path.join(packetRoot, "migration-plans"), { mode: 0o700 });
  const flowPath = path.join(fixture.root, "flows.json");
  writePrivate(flowPath, fixture.sourceFlowBytes);
  const backup = writePrivate(path.join(packetRoot, "evidence/full-backup.ejson"), fixture.fullBackupBytes);
  const backupManifestValue = {
    formatVersion: 1,
    kind: "viva-game-projection-full-lk-games-backup-manifest",
    backupSha256: backup.sha256,
    fullCollectionStateSha256: fixture.fullState.fullCollectionStateSha256,
    mongoTargetIdentitySha256: fixture.mongoTargetIdentitySha256,
    artifactPath: path.join(packetRoot, "evidence/full-backup.ejson"),
    fenceTokenSha256: fixture.fenceTokenSha256,
    database: "games",
    collection: "lk_games",
    documentCount: fixture.documents.length,
    startedAt: "2026-09-06T10:00:10.000Z",
    completedAt: "2026-09-06T10:00:20.000Z",
  };
  const backupManifest = writePrivate(path.join(packetRoot, "evidence/full-backup.manifest.json"), backupManifestValue);
  fixture.plan.evidence.backupManifestSha256 = backupManifest.sha256;
  const restoreValue = {
    formatVersion: 1,
    kind: "viva-game-projection-full-backup-restore-rehearsal",
    backupSha256: backup.sha256,
    manifestSha256: backupManifest.sha256,
    fullCollectionStateSha256: fixture.fullState.fullCollectionStateSha256,
    mongoTargetIdentitySha256: fixture.mongoTargetIdentitySha256,
    isolatedTargetIdentitySha256: "3".repeat(64),
    restoredArtifactPath: path.join(packetRoot, "evidence/full-backup.restored.ejson"),
    restoredArtifactSha256: backup.sha256,
    restoredDocumentCount: fixture.documents.length,
    isolatedTarget: true,
    postRestoreHashMatch: true,
    rehearsedAt: "2026-09-06T10:00:30.000Z",
  };
  writePrivate(path.join(packetRoot, "evidence/full-backup.restore-rehearsal.json"), restoreValue);
  writePrivate(path.join(packetRoot, "evidence/full-backup.restored.ejson"), fixture.fullBackupBytes);
  const cutoverPlan = writePrivate(path.join(packetRoot, "cutover-plan.json"), fixture.plan);
  const packetManifest = writePrivate(path.join(packetRoot, "packet.manifest.json"), { fixture: true });
  const migrationPlanPath = path.join(packetRoot, `migration-plans/01-${fixture.migrationPlanSha256}.json`);
  writePrivate(migrationPlanPath, fixture.migrationPlanBytes);
  const observedAt = "2026-09-06T10:00:00.000Z";
  const fenceValue = {
    formatVersion: 1,
    kind: "viva-game-projection-writer-fence-receipt",
    state: "HELD",
    fenceToken: fixture.fenceToken,
    sourceFlowSha256: fixture.plan.sourceFlowSha256,
    candidateSha256: fixture.plan.candidateSha256,
    tenantKey: fixture.tenantKey,
    operationIds: fixture.plan.writerFence.exactMigrationOperationIds,
    writerNodeIds: fixture.plan.writerFence.exactWriterNodeIds,
    writerInventorySha256: fixture.plan.writerFence.writerInventorySha256,
    externalWriterProofSha256: fixture.plan.writerFence.externalWriterProofSha256,
    lockPath: fixture.plan.writerFence.lockPath,
    host: "lk-primary-147",
    hostname: "fixture-host",
    processName: "node-red",
    pm2ProcessId: 0,
    nodeRedProcessState: "STOPPED",
    ingressWriteRoutesBlocked: true,
    internalSchedulersStopped: true,
    allLkGamesWritersQuiescent: true,
    externalMongoWritersBlocked: true,
    observedAt,
    expiresAt: "2026-09-06T10:30:00.000Z",
  };
  const fence = writePrivate(path.join(fixture.root, "writer-fence.json"), fenceValue);
  const migrationConnectionValue = {
    formatVersion: 1,
    kind: "viva-game-projection-migration-mongo-connection",
    uri: fixture.migrationUri,
    authenticationRestrictions: [{ clientSource: ["127.0.0.1"], serverAddress: ["127.0.0.1"] }],
  };
  const migrationConnection = writePrivate(path.join(fixture.root, "migration-connection.json"), migrationConnectionValue);
  const barrierPath = path.join(fixture.root, "mongo-barrier.json");
  const executionValue = {
    formatVersion: 1,
    kind: "viva-game-projection-cutover-execution-index",
    cutoverPlanPath: path.join(packetRoot, "cutover-plan.json"),
    cutoverPlanSha256: cutoverPlan.sha256,
    packetManifestPath: path.join(packetRoot, "packet.manifest.json"),
    packetManifestSha256: packetManifest.sha256,
    fenceReceiptPath: path.join(fixture.root, "writer-fence.json"),
    fenceReceiptSha256: fence.sha256,
    liveFlowPath: flowPath,
    migrationConnectionFile: path.join(fixture.root, "migration-connection.json"),
    migrationConnectionFileSha256: migrationConnection.sha256,
    mongoWriteBarrierReceiptOutputPath: barrierPath,
    tenantKey: fixture.tenantKey,
    items: [{ planPath: migrationPlanPath, planSha256: fixture.migrationPlanSha256 }],
  };
  const execution = writePrivate(path.join(fixture.root, "execution-index.json"), executionValue);
  const recoveryExecutorPath = path.join(fixture.root, "recover.mjs");
  const recoveryExecutor = writePrivate(recoveryExecutorPath, Buffer.from("// fixture recovery\n"));
  const guardian = {
    formatVersion: 1,
    kind: "viva-game-projection-fence-guardian-receipt",
    state: "HOLDING_UNTIL_EXPLICIT_RELEASE",
    pid: 123,
    fenceTokenSha256: fixture.fenceTokenSha256,
    lockPath: fixture.plan.writerFence.lockPath,
    automaticRelease: false,
    recoveryExecutorPath,
    recoveryExecutorSha256: recoveryExecutor.sha256,
    recoveryRequestPath: path.join(fixture.root, "recovery-request.json"),
    releaseRequestPath: path.join(fixture.root, "release-request.json"),
    receiptPath: path.join(fixture.root, "guardian.json"),
  };
  const collection = {};
  const migrationClient = { db: () => ({ collection: () => collection }) };
  let installCalls = 0;
  let fullHashCalls = 0;
  let barrierAssertionCalls = 0;
  let providerCaptured = false;
  let providerCaptureCalls = 0;
  const outputDirectory = path.join(fixture.root, "evidence-v2");
  const reportPath = path.join(fixture.root, "preflight-report.json");
  const report = await executeVivaGameProjectionRemediationPreflight({
    executionIndex: path.join(fixture.root, "execution-index.json"),
    expectedExecutionIndexSha256: execution.sha256,
    outputDirectory,
    report: reportPath,
    guardianReceiptPath: path.join(fixture.root, "guardian.json"),
  }, {
    getUid: () => 0,
    confirmation: "CAPTURE_VIVA_GAME_PROJECTION_REMEDIATION_PREFLIGHT_V1",
    nowMs: Date.parse("2026-09-06T10:03:00.000Z"),
    allowFixturePaths: true,
    allowFixtureHostname: true,
    assertExecutorSources: async () => true,
    bootstrapAttested: true,
    providerToken: "fixture-provider-token-that-is-never-used",
    providerTokenValidated: true,
    validateExactCutoverPacket: async () => true,
    assertFenceLease: () => true,
    guardianReceipt: guardian,
    assertGuardianLease: async () => true,
    inspectPm2: async () => [{
      name: "node-red",
      pm_id: 0,
      pm2_env: {
        status: "stopped",
        pm_exec_path: "/usr/local/bin/node-red",
        pm_cwd: "/root/.node-red",
        args: [],
        node_args: [],
        PADLHUB_PLATFORM_TENANT_KEY: fixture.tenantKey,
        VIVA_GAME_PROJECTION_SYNC_MODE: "SHADOW",
      },
    }],
    applicationMongoClient: {},
    migrationMongoClient: migrationClient,
    installMongoWriteBarrier: async () => {
      installCalls += 1;
      return {
        formatVersion: 1,
        kind: "viva-game-projection-mongo-write-barrier-receipt",
        state: "HELD",
        fenceTokenSha256: fixture.fenceTokenSha256,
        cutoverPlanSha256: cutoverPlan.sha256,
        mongoTargetIdentitySha256: fixture.mongoTargetIdentitySha256,
        applicationConnectionFingerprint: fixture.plan.mongoTarget.connectionFingerprint,
        migrationConnectionFingerprint: fixture.plan.mongoTarget.migrationConnectionFingerprint,
        replicaSetName: "rs-test",
        installedAt: "2026-09-06T10:00:45.000Z",
      };
    },
    hashLiveFullCollection: async () => {
      fullHashCalls += 1;
      if (fullHashCalls === 2) assert.equal(providerCaptured, true);
      return fixture.fullState;
    },
    assertMongoWriteBarrier: async () => { barrierAssertionCalls += 1; },
    captureProviderRows: async ({ pass, dates }) => {
      providerCaptured = true;
      providerCaptureCalls += 1;
      const normalized = fixture.providerRows.map((row) => normalizeVivaRemediationProviderRow(row))
        .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
      return { ...stableProviderPasses(fixture.providerRows, dates)[pass - 1], rows: normalized };
    },
    readMongoDocuments: async () => fixture.documents.slice(0, 4),
    captureSessionId: "remediation-preflight-fixture-01",
  });
  assert.equal(installCalls, 1);
  assert.equal(fullHashCalls, 2);
  assert.equal(barrierAssertionCalls, 2);
  assert.equal(providerCaptureCalls, 2);
  assert.equal(report.state, "EVIDENCE_READY_BARRIERS_HELD_RUNTIME_STOPPED");
  assert.equal(report.mongoWriteBarrierState, "HELD");
  assert.equal(report.tenantMigrationApplied, false);
  assert.equal(report.candidatePublished, false);
  assert.equal(report.nodeRedRestarted, false);
  assert.equal(report.gameDocumentWritesPerformed, 0);
  assert.equal(report.providerWritesPerformed, 0);
  assert.equal(report.recovery.automaticRecovery, false);
  assert.equal(fs.existsSync(path.join(outputDirectory, "remediation-review.packet.json")), true);
  const providerCapture = JSON.parse(fs.readFileSync(path.join(outputDirectory, "provider.capture.json"), "utf8"));
  assert.equal(providerCapture.stablePasses.length, 2);
  assert.equal(fs.existsSync(reportPath), true);
});

test("preflight rejects unknown arguments and has no apply, publication, or restart capability", () => {
  assert.throws(() => parseArgs(["--execution-index", "/tmp/x", "--unknown", "x"]), /Unknown|Missing/);
  const source = fs.readFileSync(new URL("../run_viva_game_projection_remediation_preflight.mjs", import.meta.url), "utf8");
  for (const prohibited of [
    "runMigration(",
    "publishCandidate(",
    "VIVA_GAME_PROJECTION_MIGRATION_APPLY",
    "VIVA_GAME_PROJECTION_CUTOVER_EXECUTE",
    "pm2 restart",
    "pm2 start",
  ]) assert.equal(source.includes(prohibited), false, `unexpected capability: ${prohibited}`);
  const wrapper = fs.readFileSync(new URL("../run_viva_game_projection_remediation_preflight.sh", import.meta.url), "utf8");
  assert.match(wrapper, /\/usr\/bin\/env -i/);
  assert.match(wrapper, /unset BASH_ENV ENV CDPATH NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH/);
  assert.match(wrapper, /run_viva_game_projection_remediation_preflight_bootstrap\.mjs/);
  assert.doesNotMatch(wrapper, /run_viva_game_projection_remediation_preflight\.mjs/);
  const bootstrap = fs.readFileSync(new URL("../run_viva_game_projection_remediation_preflight_bootstrap.mjs", import.meta.url), "utf8");
  assert.match(bootstrap, /O_NOFOLLOW/);
  assert.match(bootstrap, /\/usr\/bin\/npm/);
  assert.match(bootstrap, /providerTokenValidated: true/);
  assert.match(bootstrap, /GUARDIAN_STARTED_FENCE_HELD_RUNTIME_UNVERIFIED/);
  assert.doesNotMatch(bootstrap, /GUARDIAN_STARTED_FENCE_HELD_RUNTIME_STOPPED/);
  const sourceSet = new Set(PREFLIGHT_EXECUTOR_SOURCE_PATHS);
  const visit = (relativePath, visited = new Set()) => {
    if (visited.has(relativePath)) return visited;
    visited.add(relativePath);
    const absolutePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..", relativePath);
    const body = fs.readFileSync(absolutePath, "utf8");
    const importPattern = /(?:from\s+|import\s+)["'](\.[^"']+)["']/g;
    for (const match of body.matchAll(importPattern)) {
      const resolved = path.resolve(path.dirname(absolutePath), match[1]);
      const sourcePath = path.relative(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."), resolved);
      visit(path.extname(sourcePath) ? sourcePath : `${sourcePath}.mjs`, visited);
    }
    return visited;
  };
  const recursiveClosure = new Set();
  for (const entrypoint of [
    "scripts/run_viva_game_projection_remediation_preflight.mjs",
    "scripts/run_viva_game_projection_fence_guardian.mjs",
    "scripts/recover_viva_game_projection_mongo_write_barrier.mjs",
    "scripts/finalize_viva_game_projection_cutover_ready.mjs",
  ]) visit(entrypoint, recursiveClosure);
  for (const requiredSource of recursiveClosure) assert.equal(sourceSet.has(requiredSource), true, requiredSource);
  const cutoverPacketSource = fs.readFileSync(new URL("../prepare_viva_game_projection_cutover_packet.mjs", import.meta.url), "utf8");
  for (const requiredSource of PREFLIGHT_EXECUTOR_SOURCE_PATHS) {
    assert.match(cutoverPacketSource, new RegExp(requiredSource.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  const leaseRoot = privateRoot();
  const leasePath = path.join(leaseRoot, "cutover.lock");
  fs.writeFileSync(leasePath, "", { mode: 0o600, flag: "wx" });
  const leaseDescriptor = fs.openSync(leasePath, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
  const fenceToken = "fixture-attested-fence-token-value";
  const receipt = { lockPath: leasePath, fenceToken, fenceTokenSha256: sha256(fenceToken) };
  assert.equal(assertAttestedFenceLease({
    receipt, lockDescriptor: leaseDescriptor, fenceToken, lockPath: leasePath, probe: () => true,
  }), true);
  assert.throws(() => assertAttestedFenceLease({
    receipt, lockDescriptor: leaseDescriptor, fenceToken: `${fenceToken}-wrong`, lockPath: leasePath, probe: () => true,
  }), /differs/);
  fs.closeSync(leaseDescriptor);
  const driftDate = "2026-09-07";
  const stableRows = fixtureProviderRowsForDriftTest();
  const changedRows = stableRows.map((row, index) => (index === 0 ? { ...row, timeFrom: "13:30" } : row));
  const capture = (rows) => {
    const dates = [{
      date: driftDate,
      rowCount: rows.length,
      rawPayloadSha256: sha256(canonicalJson(rows)),
      canonicalRowsSha256: sha256(canonicalJson(rows)),
    }];
    return {
      rows,
      canonicalRowsSha256: sha256(canonicalJson(rows)),
      captureTreeSha256: sha256(canonicalJson(dates.map(({ date, rowCount, canonicalRowsSha256 }) => ({
        date, rowCount, canonicalRowsSha256,
      })))),
      dates,
    };
  };
  assert.throws(() => assertStableProviderCapture(capture(stableRows), capture(changedRows), [driftDate]), /drifted/);
  const packetRoot = "/private/cutover-packet";
  const execution = {
    cutoverPlanPath: `${packetRoot}/cutover-plan.json`,
    packetManifestPath: `${packetRoot}/packet.manifest.json`,
    fenceReceiptPath: "/private/custody/fence.json",
    liveFlowPath: "/root/.node-red/flows.json",
    migrationConnectionFile: "/private/custody/mongo.json",
    mongoWriteBarrierReceiptOutputPath: "/private/output/barrier.json",
  };
  assert.throws(() => assertDisjointPreflightPaths({
    packetRoot,
    execution,
    guardian: {},
    report: `${packetRoot}/report.json`,
    outputDirectory: "/private/output/evidence",
  }), /overlaps/);
  assert.throws(() => assertDisjointPreflightPaths({
    packetRoot,
    execution,
    guardian: {},
    report: execution.mongoWriteBarrierReceiptOutputPath,
    outputDirectory: "/private/output/evidence",
  }), /pairwise disjoint/);
});

function fixtureProviderRowsForDriftTest() {
  return [normalizeVivaRemediationProviderRow({
    id: "33333333-3333-4333-8333-333333333333",
    studioId: "studio-piter",
    date: "2026-09-07",
    timeFrom: "13:00",
    timeTo: "15:00",
    status: "ACTIVE",
    active: true,
  })];
}

test("snapshot-aware source gate validates frozen recovery bytes without a Git worktree", () => {
  const snapshot = privateRoot();
  const sources = [
    "scripts/lib/vivaGameProjectionExecutorSource.mjs",
    "scripts/lib/vivaGameProjectionCutoverContract.mjs",
    ...Array.from({ length: 6 }, (_, index) => `scripts/fixture-${index}.mjs`),
  ];
  for (const relativePath of sources) {
    const target = path.join(snapshot, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const bytes = relativePath.includes("/lib/")
      ? fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..", relativePath))
      : Buffer.from(`export default ${JSON.stringify(relativePath)};\n`);
    fs.writeFileSync(target, bytes, { mode: 0o400, flag: "wx" });
    fs.chmodSync(target, 0o400);
  }
  for (const directory of [path.join(snapshot, "scripts/lib"), path.join(snapshot, "scripts"), snapshot]) {
    fs.chmodSync(directory, 0o500);
  }
  const executorSources = sources.map((relativePath) => ({
    path: relativePath,
    sha256: sha256(fs.readFileSync(path.join(snapshot, relativePath))),
  }));
  const plan = {
    repository: { commit: "a".repeat(40) },
    executorSources,
    executorSourcesSha256: sha256(canonicalJson(executorSources)),
  };
  const moduleUrl = pathToFileURL(path.join(snapshot, "scripts/lib/vivaGameProjectionExecutorSource.mjs")).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", [
    `import { assertExactExecutorSources } from ${JSON.stringify(moduleUrl)};`,
    `assertExactExecutorSources(JSON.parse(Buffer.from(${JSON.stringify(Buffer.from(JSON.stringify(plan)).toString("base64"))}, "base64")));`,
  ].join("\n")], {
    encoding: "utf8",
    env: {
      PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
      PADLHUB_ATTESTED_EXECUTOR_SNAPSHOT_ROOT: snapshot,
      PADLHUB_ATTESTED_EXECUTOR_COMMIT: plan.repository.commit,
    },
  });
  assert.equal(child.status, 0, child.stderr);
});
