import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { BSON, ObjectId } from "mongodb";

import { canonicalJson, sha256 } from "../lib/vivaGameProjectionCutoverContract.mjs";
import {
  applyRemediationPlan,
  buildRemediationBackup,
  materializeRemediationPostimage,
  reconcileRemediationOutcome,
  reconcileRemediationRestoreOutcome,
  restoreRemediationBackup,
  runRemediationTransaction,
  REMEDIATION_EXECUTOR_SOURCE_PATHS,
  REMEDIATION_RUNTIME_PACKAGE_NAMES,
  validateExecutableRemediationPlan,
  validateRemediationApplyReceipt,
  validateRemediationPlanShape,
} from "../lib/vivaGameProjectionRemediationExecution.mjs";
import { hashCanonicalEjson } from "../lib/vivaGameProjectionTenantMigrationExecution.mjs";
import { mongoAuthenticationRestrictionsSha256 } from "../lib/vivaGameProjectionMongoWriteBarrier.mjs";
import {
  buildRemediationExecutionPlan,
  validateRemediationExecutionIndex,
} from "../lib/vivaGameProjectionRemediationPackage.mjs";
import {
  buildFreshRemediationRuntimeDependencySnapshot,
  parseArgs as parseRemediationPackageArgs,
  prepareVivaGameProjectionRemediationPackage,
} from "../lib/prepareVivaGameProjectionRemediationPackage.mjs";
import {
  main as runRemediationPackageBuilderBootstrap,
  REMEDIATION_BUILDER_RUNTIME_PACKAGE_NAMES,
  REMEDIATION_BUILDER_SOURCE_PATHS,
  REMEDIATION_LIVE_EXECUTOR_SOURCE_PATHS,
} from "../prepare_viva_game_projection_remediation_package.mjs";
import {
  assertFrozenRemediationFullCollection,
  main as runRemediationRunner,
  parseArgs as parseRemediationRunnerArgs,
} from "../run_viva_game_projection_remediation.mjs";
import {
  BOOTSTRAP_REMEDIATION_EXECUTOR_SOURCE_PATHS,
  BOOTSTRAP_REMEDIATION_RUNTIME_PACKAGE_NAMES,
  main as runRemediationBootstrap,
  materializeRemediationExecutorSnapshot,
  verifyRemediationExecutorBootstrap,
} from "../run_viva_game_projection_remediation_bootstrap.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const at = (name, value) => {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  return { name, value, bytes, sha256: sha256(bytes) };
};
const cloneBson = (value) => BSON.EJSON.parse(
  BSON.EJSON.stringify(value, null, 0, { relaxed: false }),
  { relaxed: false },
);

const runtimeDependencyFixture = () => {
  const packageJsonBytes = Buffer.from(`${JSON.stringify({ name: "remediation-runtime-fixture", private: true })}\n`);
  const packageEntries = Object.fromEntries(REMEDIATION_RUNTIME_PACKAGE_NAMES.map((name, index) => [
    `node_modules/${name}`,
    {
      version: `1.0.${index}`,
      resolved: `https://registry.npmjs.org/${name.replace("/", "%2f")}/-/${name.split("/").at(-1)}-1.0.${index}.tgz`,
      integrity: `sha512-${Buffer.from(`integrity:${name}`).toString("base64")}`,
    },
  ]));
  const packageLockBytes = Buffer.from(`${JSON.stringify({ lockfileVersion: 3, packages: packageEntries }, null, 2)}\n`);
  const packages = REMEDIATION_RUNTIME_PACKAGE_NAMES.map((name) => ({
    name,
    version: packageEntries[`node_modules/${name}`].version,
    integrity: packageEntries[`node_modules/${name}`].integrity,
  }));
  const files = REMEDIATION_RUNTIME_PACKAGE_NAMES.map((name) => {
    const bytes = Buffer.from(`${JSON.stringify({ name, version: packageEntries[`node_modules/${name}`].version })}\n`);
    return {
      path: `node_modules/${name}/package.json`,
      size: bytes.length,
      sha256: sha256(bytes),
      bytesBase64: bytes.toString("base64"),
    };
  }).sort((left, right) => left.path.localeCompare(right.path));
  return {
    formatVersion: 1,
    kind: "viva-game-projection-runtime-dependency-snapshot",
    installMethod: "fresh-private-npm-ci-ignore-scripts-omit-dev",
    packageJsonSha256: sha256(packageJsonBytes),
    packageJsonBytesBase64: packageJsonBytes.toString("base64"),
    packageLockSha256: sha256(packageLockBytes),
    packageLockBytesBase64: packageLockBytes.toString("base64"),
    packages,
    files,
  };
};

function fixture() {
  const fenceToken = "fixture-remediation-fence-token-with-entropy";
  const fenceTokenSha256 = sha256(fenceToken);
  const fenceObservedAt = "2026-09-06T10:00:00.000Z";
  const backupStartedAt = "2026-09-06T10:00:10.000Z";
  const backupCompletedAt = "2026-09-06T10:00:20.000Z";
  const restoreRehearsedAt = "2026-09-06T10:00:30.000Z";
  const barrierInstalledAt = "2026-09-06T10:00:45.000Z";
  const providerCapturedAt = "2026-09-06T10:01:00.000Z";
  const mongoCapturedAt = "2026-09-06T10:02:00.000Z";
  const generatedAt = "2026-09-06T10:03:00.000Z";
  const mutationAt = "2026-09-06T10:04:00.000Z";
  const fenceExpiresAt = "2026-09-06T10:30:00.000Z";
  const captureSessionId = "remediation-fixture-session-01";
  const operationId = "viva-remediation-fixture-01";
  const tenantKey = "fixture-tenant";
  const sourceFlowBytes = Buffer.from("[{\"id\":\"fixture-flow\"}]\n");
  const sourceFlowSha256 = sha256(sourceFlowBytes);
  const servicePrincipalSha256 = "b".repeat(64);
  const mongoTargetIdentitySha256 = "c".repeat(64);
  const applicationConnectionFingerprint = "e".repeat(64);
  const migrationUri = "mongodb://fixture-migration.invalid/games?replicaSet=rs-fixture";
  const migrationConnectionFingerprint = sha256(migrationUri);
  const migrationAuthenticationRestrictions = [{ clientSource: ["127.0.0.1"], serverAddress: ["127.0.0.1"] }];
  const executorSources = REMEDIATION_EXECUTOR_SOURCE_PATHS.map((sourcePath, index) => ({
    path: sourcePath,
    sha256: sha256(`${index}:${sourcePath}`),
  }));
  const executorSourcesSha256 = sha256(canonicalJson(executorSources));
  const runtimeDependencies = runtimeDependencyFixture();
  const exerciseIds = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    "33333333-3333-4333-8333-333333333333",
    "44444444-4444-4444-8444-444444444444",
  ];
  const categories = [
    "CANCEL_AND_ARCHIVE",
    "QUARANTINE_AND_ARCHIVE",
    "RECONCILE_PROVIDER_TIME",
    "REPAIR_METADATA_IDENTITY",
  ];
  const documents = categories.map((category, index) => ({
    _id: new ObjectId(`${index + 1}`.repeat(24)),
    id: `pay_fixture_${index + 1}`,
    tenantKey: null,
    revision: null,
    status: "PAID",
    archived: false,
    dedupeKey: `viva:${exerciseIds[index]}`,
    updatedAt: `2026-09-06T09:0${index}:00.000Z`,
    booking: {
      vivaExerciseId: exerciseIds[index],
      exerciseId: exerciseIds[index],
      studioId: "studio-piter",
      date: "2026-09-07",
      timeFrom: "12:00",
      timeTo: "14:00",
    },
    metadata: {
      vivaExerciseId: category === "REPAIR_METADATA_IDENTITY" ? exerciseIds[0] : exerciseIds[index],
      exerciseId: category === "REPAIR_METADATA_IDENTITY" ? exerciseIds[0] : exerciseIds[index],
    },
    audit: { events: [] },
    payment: { paid: true, amount: 4200, providerTransactionId: `txn-${index}` },
    participants: [{ id: `player-${index}` }],
  }));
  for (let index = 0; index < 10; index += 1) {
    documents.push({
      _id: new ObjectId(String(index + 5).padStart(24, "0")),
      id: `pay_fixture_eligible_${index}`,
      tenantKey: null,
      revision: null,
      status: "PAID",
      archived: false,
      booking: {
        studioId: "studio-piter",
        date: "2026-09-07",
        timeFrom: "12:00",
        timeTo: "14:00",
      },
    });
  }
  const providerEvidence = categories.map((category, index) => {
    const document = documents[index];
    const identitySignals = [
      document.booking.vivaExerciseId,
      document.booking.exerciseId,
      document.metadata.vivaExerciseId,
      document.metadata.exerciseId,
      document.dedupeKey.startsWith("viva:") ? document.dedupeKey.slice(5) : null,
    ].map((value) => String(value || "").trim()).filter(Boolean);
    const identitySignalsSha256 = sha256(canonicalJson([...new Set(identitySignals)].sort()));
    if (category === "CANCEL_AND_ARCHIVE") {
      return {
        exerciseId: exerciseIds[index], date: "2026-09-07", studioId: "studio-piter",
        timeFrom: "12:00", timeTo: "14:00", identitySignalsSha256, slotMatchCount: 1,
        status: "CANCELLED", cancelled: true, active: false,
      };
    }
    if (category === "QUARANTINE_AND_ARCHIVE") {
      return {
        recordedDate: "2026-09-07", studioId: "studio-piter", timeFrom: "12:00", timeTo: "14:00",
        identitySignalsSha256, searchWindowDays: 7, matchCount: 0,
      };
    }
    return {
      exerciseId: exerciseIds[index],
      date: "2026-09-07",
      studioId: "studio-piter",
      timeFrom: category === "RECONCILE_PROVIDER_TIME" ? "13:00" : "12:00",
      timeTo: category === "RECONCILE_PROVIDER_TIME" ? "15:00" : "14:00",
      cancelled: false,
      active: true,
    };
  });
  const operations = categories.map((category, index) => {
    const itemFingerprint = sha256(`fingerprint-${index}`);
    const event = {
      id: `viva_remediation_fixture_${index}`,
      at: mutationAt,
      type: "GAME_VIVA_VISIBILITY_REMEDIATED",
      source: "viva_game_projection_remediation",
      payload: { operationId, category },
    };
    const actionByCategory = {
      CANCEL_AND_ARCHIVE: "PROVIDER_CANCELLED_EXCLUDE_ACTIVE_CONTOUR",
      QUARANTINE_AND_ARCHIVE: "PROVIDER_MISSING_QUARANTINE",
      RECONCILE_PROVIDER_TIME: "PROVIDER_TIME_READBACK",
      REPAIR_METADATA_IDENTITY: "EXACT_PROVIDER_IDENTITY_READBACK",
    };
    const categorySet = category === "CANCEL_AND_ARCHIVE"
      ? { status: "CANCELLED", archived: true }
      : category === "QUARANTINE_AND_ARCHIVE"
        ? { archived: true }
        : category === "RECONCILE_PROVIDER_TIME"
          ? { "booking.timeFrom": "13:00", "booking.timeTo": "15:00" }
          : { "metadata.vivaExerciseId": exerciseIds[index], "metadata.exerciseId": exerciseIds[index] };
    return {
      itemFingerprint,
      category,
      mongoId: { $oid: documents[index]._id.toHexString() },
      preimageSha256: hashCanonicalEjson(documents[index]),
      providerEvidenceSha256: sha256(canonicalJson(providerEvidence[index])),
      update: {
        $set: {
          ...categorySet,
          updatedAt: mutationAt,
          "audit.updatedAt": mutationAt,
          "audit.lastEvent": event,
          "metadata.vivaProjectionRemediation": { operationId, action: actionByCategory[category], at: mutationAt, category },
        },
        $push: { "audit.events": { $each: [event], $slice: -100 } },
      },
      options: { upsert: false },
    };
  });
  const packet = at("packet", {
    formatVersion: 2,
    kind: "viva-game-projection-remediation-review-packet",
    captureSessionId,
    sourceFlowSha256,
    tenantKey,
    servicePrincipalSha256,
    executionAuthorized: false,
    remediationItems: operations.map((operation, index) => ({
      itemFingerprint: operation.itemFingerprint,
      category: operation.category,
      mongoId: operation.mongoId.$oid,
      rootGameId: documents[index].id,
      preimageSha256: operation.preimageSha256,
      providerEvidenceSha256: operation.providerEvidenceSha256,
    })),
  });
  const providerCapture = at("providerCapture", {
    formatVersion: 1,
    kind: "viva-admin-remediation-provider-capture",
    captureSessionId,
    servicePrincipalSha256,
    fenceTokenSha256,
    capturedAt: providerCapturedAt,
    records: operations.map((operation, index) => ({
      itemFingerprint: operation.itemFingerprint,
      category: operation.category,
      evidence: providerEvidence[index],
      evidenceSha256: operation.providerEvidenceSha256,
    })),
  });
  const reviews = operations.map((operation) => ({
    itemFingerprint: operation.itemFingerprint,
    reviewResult: {
      CANCEL_AND_ARCHIVE: "CANCELLED_READBACK_CONFIRMED",
      QUARANTINE_AND_ARCHIVE: "PROVIDER_ABSENT_WITHIN_PLUS_MINUS_7_DAYS",
      RECONCILE_PROVIDER_TIME: "EXACT_EXERCISE_SAME_DATE_STUDIO_TIME_CHANGED",
      REPAIR_METADATA_IDENTITY: "ONE_IDENTITY_SIGNAL_HAS_UNIQUE_EXACT_PROVIDER_SLOT",
    }[operation.category],
    providerEvidenceSha256: operation.providerEvidenceSha256,
  }));
  const enrichment = at("enrichment", {
    formatVersion: 2,
    kind: "viva-game-projection-remediation-manual-review",
    packetSha256: packet.sha256,
    providerCaptureSha256: providerCapture.sha256,
    captureSessionId,
    sourceFlowSha256,
    tenantKeySha256: sha256(tenantKey),
    servicePrincipalSha256,
    capturedAt: providerCapturedAt,
    executionAuthorized: false,
    reviews,
  });
  const identityOperation = operations.find(({ category }) => category === "REPAIR_METADATA_IDENTITY");
  const identityAudit = at("identityAudit", {
    formatVersion: 2,
    kind: "viva-game-projection-identity-reference-audit",
    packetSha256: packet.sha256,
    enrichmentSha256: enrichment.sha256,
    captureSessionId,
    sourceFlowSha256,
    executionAuthorized: false,
    results: [{
      itemFingerprint: identityOperation.itemFingerprint,
      rootGameIdChangeRequired: false,
      referenceRewriteRequired: false,
      fieldsToSet: {
        "metadata.vivaExerciseId": exerciseIds[3],
        "metadata.exerciseId": exerciseIds[3],
      },
    }],
  });
  const mongoCapture = at("mongoCapture", {
    formatVersion: 1,
    kind: "viva-game-projection-remediation-mongo-capture",
    captureSessionId,
    sourceFlowSha256,
    fenceTokenSha256,
    mongoTargetIdentitySha256,
    capturedAt: mongoCapturedAt,
    records: operations.map((operation) => ({
      itemFingerprint: operation.itemFingerprint,
      mongoId: operation.mongoId.$oid,
      preimageSha256: operation.preimageSha256,
    })),
  });
  const fenceReceipt = at("fenceReceipt", {
    formatVersion: 1,
    kind: "viva-game-projection-writer-fence-receipt",
    state: "HELD",
    fenceToken,
    sourceFlowSha256,
    tenantKey,
    candidateSha256: "d".repeat(64),
    operationIds: [operationId],
    writerNodeIds: ["writer-fixture"],
    writerInventorySha256: "1".repeat(64),
    externalWriterProofSha256: "2".repeat(64),
    lockPath: "/run/lock/padlhub-viva-game-projection-cutover.lock",
    nodeRedProcessState: "STOPPED",
    ingressWriteRoutesBlocked: true,
    internalSchedulersStopped: true,
    allLkGamesWritersQuiescent: true,
    externalMongoWritersBlocked: true,
    observedAt: fenceObservedAt,
    expiresAt: fenceExpiresAt,
  });
  const fullBackupBytes = Buffer.from(`${BSON.EJSON.stringify(documents, null, 2, { relaxed: false })}\n`);
  const fullBackup = { name: "fullBackup", bytes: fullBackupBytes, sha256: sha256(fullBackupBytes) };
  const fullCollectionRows = documents.map((document) => ({
    mongoId: document._id.toHexString(), documentSha256: hashCanonicalEjson(document),
  })).sort((left, right) => left.mongoId.localeCompare(right.mongoId));
  const fullCollectionStateSha256 = sha256(canonicalJson(fullCollectionRows));
  const fullBackupManifest = at("fullBackupManifest", {
    formatVersion: 1,
    kind: "viva-game-projection-full-lk-games-backup-manifest",
    backupSha256: fullBackup.sha256,
    fullCollectionStateSha256,
    fenceTokenSha256,
    mongoTargetIdentitySha256,
    artifactPath: "/private/full-backup.ejson",
    database: "games",
    collection: "lk_games",
    documentCount: documents.length,
    startedAt: backupStartedAt,
    completedAt: backupCompletedAt,
  });
  const migrationPlanBytes = Buffer.from(`${JSON.stringify({
    formatVersion: 1,
    eligibleCount: 10,
    operations: documents.slice(4).map((document) => ({ filter: { _id: { $oid: document._id.toHexString() } } })),
  }, null, 2)}\n`);
  const migrationPlanSha256 = sha256(migrationPlanBytes);
  const migrationPlanBundle = at("migrationPlanBundle", {
    formatVersion: 1,
    kind: "viva-game-projection-migration-plan-bundle",
    plans: [{ sha256: migrationPlanSha256, bytesBase64: migrationPlanBytes.toString("base64") }],
  });
  const cutoverPlan = at("cutoverPlan", {
    formatVersion: 1,
    kind: "viva-game-projection-tenant-cutover-plan",
    state: "READY_FOR_SEPARATE_LIVE_APPROVAL",
    sourceFlowSha256,
    tenantKeySha256: sha256(tenantKey),
    candidateSha256: fenceReceipt.value.candidateSha256,
    writerFence: {
      exactMigrationOperationIds: [...fenceReceipt.value.operationIds],
      exactWriterNodeIds: [...fenceReceipt.value.writerNodeIds],
      writerInventorySha256: fenceReceipt.value.writerInventorySha256,
      externalWriterProofSha256: fenceReceipt.value.externalWriterProofSha256,
      fenceTokenSha256,
      lockPath: fenceReceipt.value.lockPath,
    },
    mongoTarget: {
      targetIdentitySha256: mongoTargetIdentitySha256,
      connectionFingerprint: applicationConnectionFingerprint,
      migrationConnectionFingerprint,
      replicaSetName: "rs-fixture",
    },
    evidence: {
      backupSha256: fullBackup.sha256,
      backupManifestSha256: fullBackupManifest.sha256,
      fullCollectionStateSha256,
      restoreArtifactSha256: fullBackup.sha256,
    },
    migration: {
      futureBoundaryDate: "2026-09-06",
      futureBoundaryTimeZone: "UTC",
      planSha256s: [migrationPlanSha256],
      totalEligible: 10,
      totalSkipped: 4,
    },
    liveMutationAuthorized: false,
  });
  const cutoverPlanSha256 = cutoverPlan.sha256;
  const mongoWriteBarrierReceipt = at("mongoWriteBarrierReceipt", {
    formatVersion: 1,
    kind: "viva-game-projection-mongo-write-barrier-receipt",
    state: "HELD",
    fenceTokenSha256,
    cutoverPlanSha256,
    mongoTargetIdentitySha256,
    applicationConnectionFingerprint,
    migrationConnectionFingerprint,
    replicaSetName: "rs-fixture",
    installedAt: barrierInstalledAt,
  });
  const migrationConnectionFile = at("migrationConnectionFile", {
    formatVersion: 1,
    kind: "viva-game-projection-migration-mongo-connection",
    uri: migrationUri,
    authenticationRestrictions: migrationAuthenticationRestrictions,
  });
  const restoreRehearsalReceipt = at("restoreRehearsalReceipt", {
    formatVersion: 1,
    kind: "viva-game-projection-full-backup-restore-rehearsal",
    backupSha256: fullBackup.sha256,
    manifestSha256: fullBackupManifest.sha256,
    fullCollectionStateSha256,
    mongoTargetIdentitySha256,
    isolatedTargetIdentitySha256: "3".repeat(64),
    restoredArtifactPath: "/private/full-backup.restored.ejson",
    restoredArtifactSha256: fullBackup.sha256,
    restoredDocumentCount: documents.length,
    postRestoreHashMatch: true,
    isolatedTarget: true,
    rehearsedAt: restoreRehearsedAt,
  });
  const artifacts = Object.fromEntries([
    cutoverPlan, migrationPlanBundle, packet, enrichment, identityAudit, providerCapture, mongoCapture,
    fenceReceipt, mongoWriteBarrierReceipt,
    migrationConnectionFile,
    fullBackupManifest, restoreRehearsalReceipt,
  ].map(({ name, value, bytes }) => [name, { value, bytes }]));
  artifacts.fullBackup = { bytes: fullBackup.bytes };
  artifacts.restoredArtifact = { bytes: fullBackup.bytes };
  artifacts.flow = { bytes: sourceFlowBytes };
  const counts = {
    sourceActiveLegacyCount: 14,
    alreadyEligibleCount: 10,
    remediationTotal: 4,
    CANCEL_AND_ARCHIVE: 1,
    QUARANTINE_AND_ARCHIVE: 1,
    RECONCILE_PROVIDER_TIME: 1,
    REPAIR_METADATA_IDENTITY: 1,
  };
  const plan = {
    formatVersion: 2,
    kind: "viva-game-projection-remediation-execution-plan",
    state: "PREPARED_NOT_AUTHORIZED",
    generatedAt,
    mutationAt,
    operationId,
    dryRunOnly: true,
    executionAuthorized: false,
    liveMutationAuthorized: false,
    productionWritesPerformed: 0,
    repository: { commit: "4".repeat(40), branch: "codex/remediation-fixture" },
    executorSources,
    executorSourcesSha256,
    runtimeDependencies,
    runtimeDependenciesSha256: sha256(canonicalJson(runtimeDependencies)),
    source: {
      packetSha256: packet.sha256,
      enrichmentSha256: enrichment.sha256,
      identityAuditSha256: identityAudit.sha256,
      providerCaptureSha256: providerCapture.sha256,
      mongoCaptureSha256: mongoCapture.sha256,
      sourceFlowSha256,
      servicePrincipalSha256,
      cutoverPlanSha256,
      migrationPlanBundleSha256: migrationPlanBundle.sha256,
      eligibleMongoIdSetSha256: sha256(canonicalJson(documents.slice(4).map((document) => document._id.toHexString()).sort())),
      fullBackupSha256: fullBackup.sha256,
      fullBackupManifestSha256: fullBackupManifest.sha256,
      restoreRehearsalReceiptSha256: restoreRehearsalReceipt.sha256,
      fullCollectionStateSha256,
      restoredArtifactSha256: fullBackup.sha256,
      fullBackupDocumentCount: documents.length,
      fenceReceiptSha256: fenceReceipt.sha256,
      mongoWriteBarrierReceiptSha256: mongoWriteBarrierReceipt.sha256,
      fenceTokenSha256,
      mongoTargetIdentitySha256,
      applicationConnectionFingerprint,
      migrationConnectionFingerprint,
      replicaSetName: "rs-fixture",
      tenantKeySha256: sha256(tenantKey),
      runtimeMode: "SHADOW",
      migrationAuthenticationRestrictionsSha256: mongoAuthenticationRestrictionsSha256(
        migrationAuthenticationRestrictions,
      ),
      captureSessionId,
      fenceObservedAt,
      fenceExpiresAt,
      barrierInstalledAt,
      backupStartedAt,
      backupCompletedAt,
      restoreRehearsedAt,
      providerCapturedAt,
      mongoCapturedAt,
      itemFingerprintSetSha256: sha256(canonicalJson(operations.map(({ itemFingerprint }) => itemFingerprint).sort())),
    },
    counts,
    operations,
    expectedPostRemediation: {
      sourceActiveLegacyCount: 14,
      cancelledAndArchivedCount: 1,
      quarantinedAndArchivedCount: 1,
      correctedTimeCount: 1,
      correctedMetadataIdentityCount: 1,
      activeLegacyEligibleForFreshTenantMigrationPlan: 12,
      unresolvedActiveLegacyCount: 0,
    },
  };
  const planBytes = Buffer.from(`${JSON.stringify(plan, null, 2)}\n`);
  return {
    plan,
    planBytes,
    planSha256: sha256(planBytes),
    artifacts,
    documents,
    executorSourcesSha256,
    runtimeDependencies,
    generatedAt,
    mutationAt,
    operationId,
  };
}

function rebindProviderEvidence(value, index, patch) {
  const providerRecord = value.artifacts.providerCapture.value.records[index];
  Object.assign(providerRecord.evidence, patch);
  providerRecord.evidenceSha256 = sha256(canonicalJson(providerRecord.evidence));
  value.plan.operations[index].providerEvidenceSha256 = providerRecord.evidenceSha256;
  value.artifacts.packet.value.remediationItems[index].providerEvidenceSha256 = providerRecord.evidenceSha256;
  value.artifacts.enrichment.value.reviews[index].providerEvidenceSha256 = providerRecord.evidenceSha256;
}

class MemoryCollection {
  constructor(documents) {
    this.documents = new Map(documents.map((document) => [document._id.toHexString(), cloneBson(document)]));
  }

  async findOne(filter) {
    const id = filter?._id?.toHexString?.();
    const current = id ? this.documents.get(id) : null;
    if (!current) return null;
    if (Object.keys(filter).length > 1 && hashCanonicalEjson(current) !== hashCanonicalEjson(filter)) return null;
    return cloneBson(current);
  }

  async replaceOne(filter, replacement, options) {
    assert.equal(options.upsert, false);
    const current = await this.findOne(filter);
    if (!current) return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0, upsertedId: null };
    this.documents.set(current._id.toHexString(), cloneBson(replacement));
    return { acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedCount: 0, upsertedId: null };
  }
}

test("remediation plan binds exact packet, provider, Mongo, identity and held-fence evidence", () => {
  const value = fixture();
  const checked = validateExecutableRemediationPlan(value.plan, {
    expectedPlanSha256: value.planSha256,
    planBytes: value.planBytes,
    artifacts: value.artifacts,
    expectedExecutorSourcesSha256: value.executorSourcesSha256,
    nowMs: Date.parse("2026-09-06T10:05:00.000Z"),
  });
  assert.equal(checked.operations.length, 4);

  const digestMismatch = Buffer.from(value.planBytes);
  digestMismatch[0] ^= 1;
  assert.throws(() => validateExecutableRemediationPlan(value.plan, {
    expectedPlanSha256: value.planSha256,
    planBytes: digestMismatch,
    artifacts: value.artifacts,
  }), /digest mismatch/);

  const linkage = structuredClone(value.plan);
  linkage.source.packetSha256 = "e".repeat(64);
  assert.throws(() => validateExecutableRemediationPlan(linkage, {
    expectedPlanSha256: value.planSha256,
    planBytes: value.planBytes,
    artifacts: value.artifacts,
  }), /packet artifact digest mismatch/);

  const duplicatePacket = Object.fromEntries(Object.entries(value.artifacts).map(([name, entry]) => [
    name,
    { bytes: entry.bytes, value: structuredClone(entry.value) },
  ]));
  duplicatePacket.packet.value.remediationItems[1].itemFingerprint = duplicatePacket.packet.value.remediationItems[0].itemFingerprint;
  assert.throws(() => validateExecutableRemediationPlan(value.plan, {
    expectedPlanSha256: value.planSha256,
    planBytes: value.planBytes,
    artifacts: duplicatePacket,
  }), /packet fingerprint set/);

  const dependencyTamper = structuredClone(value.plan);
  dependencyTamper.runtimeDependencies.files.find((entry) => entry.path === "node_modules/mongodb/package.json")
    .bytesBase64 = Buffer.from("tampered mongodb runtime").toString("base64");
  dependencyTamper.runtimeDependenciesSha256 = sha256(canonicalJson(dependencyTamper.runtimeDependencies));
  const dependencyTamperBytes = Buffer.from(`${JSON.stringify(dependencyTamper, null, 2)}\n`);
  assert.throws(() => validateExecutableRemediationPlan(dependencyTamper, {
    expectedPlanSha256: sha256(dependencyTamperBytes),
    planBytes: dependencyTamperBytes,
    artifacts: value.artifacts,
  }), /runtime dependency file byte stream mismatch/);
});

test("remediation package builder deterministically derives the exact executable plan", () => {
  const value = fixture();
  const plan = buildRemediationExecutionPlan({
    artifacts: value.artifacts,
    generatedAt: value.generatedAt,
    mutationAt: value.mutationAt,
    operationId: value.operationId,
    repository: value.plan.repository,
    executorSources: value.plan.executorSources,
    runtimeDependencies: value.plan.runtimeDependencies,
  });
  const planBytes = Buffer.from(`${JSON.stringify(plan, null, 2)}\n`);
  const planSha256 = sha256(planBytes);
  const checked = validateExecutableRemediationPlan(plan, {
    expectedPlanSha256: planSha256,
    planBytes,
    artifacts: value.artifacts,
    expectedExecutorSourcesSha256: value.executorSourcesSha256,
    nowMs: Date.parse("2026-09-06T10:05:00.000Z"),
  });
  assert.equal(checked.operations.length, 4);
  assert.deepEqual(plan.counts, {
    sourceActiveLegacyCount: 14,
    alreadyEligibleCount: 10,
    remediationTotal: 4,
    CANCEL_AND_ARCHIVE: 1,
    QUARANTINE_AND_ARCHIVE: 1,
    RECONCILE_PROVIDER_TIME: 1,
    REPAIR_METADATA_IDENTITY: 1,
  });
  assert.equal(plan.expectedPostRemediation.activeLegacyEligibleForFreshTenantMigrationPlan, 12);
});

test("fresh private npm ci dependency capture ignores coherently tampered repository node_modules", () => {
  const expected = runtimeDependencyFixture();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "viva-remediation-runtime-build-test-")));
  fs.chmodSync(root, 0o700);
  try {
    const malicious = path.join(root, "node_modules/mongodb/package.json");
    fs.mkdirSync(path.dirname(malicious), { recursive: true, mode: 0o700 });
    fs.writeFileSync(malicious, "coherently tampered repository mongodb", { mode: 0o600 });
    const packageJsonBytes = Buffer.from(expected.packageJsonBytesBase64, "base64");
    const packageLockBytes = Buffer.from(expected.packageLockBytesBase64, "base64");
    const captured = buildFreshRemediationRuntimeDependencySnapshot({
      repositoryCommit: "a".repeat(40),
      privateParent: root,
      repoRoot: root,
    }, {
      repository: {
        committedBytes: (_commit, relativePath) => (
          relativePath === "package.json" ? packageJsonBytes : packageLockBytes
        ),
      },
      runNpmCi({ installRoot, npmUserConfig, npmGlobalConfig }) {
        assert.notEqual(installRoot, root);
        assert.equal(fs.statSync(installRoot).mode & 0o077, 0);
        assert.notEqual(npmUserConfig, npmGlobalConfig);
        assert.equal(fs.statSync(npmUserConfig).mode & 0o777, 0o400);
        assert.equal(fs.statSync(npmGlobalConfig).mode & 0o777, 0o400);
        for (const entry of expected.files) {
          const target = path.join(installRoot, entry.path);
          fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
          fs.writeFileSync(target, Buffer.from(entry.bytesBase64, "base64"), { mode: 0o600 });
        }
        return { status: 0 };
      },
    });
    const mongodb = captured.files.find((entry) => entry.path === "node_modules/mongodb/package.json");
    assert.deepEqual(Buffer.from(mongodb.bytesBase64, "base64"), Buffer.from(
      expected.files.find((entry) => entry.path === "node_modules/mongodb/package.json").bytesBase64,
      "base64",
    ));
    assert.notEqual(Buffer.from(mongodb.bytesBase64, "base64").toString("utf8"), fs.readFileSync(malicious, "utf8"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("built-in remediation builder bootstrap imports only its fresh private committed closure", async () => {
  assert.deepEqual(REMEDIATION_BUILDER_RUNTIME_PACKAGE_NAMES, REMEDIATION_RUNTIME_PACKAGE_NAMES);
  assert.deepEqual(REMEDIATION_LIVE_EXECUTOR_SOURCE_PATHS, REMEDIATION_EXECUTOR_SOURCE_PATHS);
  const declared = new Set(REMEDIATION_BUILDER_SOURCE_PATHS);
  for (const relativePath of REMEDIATION_BUILDER_SOURCE_PATHS) {
    const source = fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
    const imports = [...source.matchAll(/from\s+["'](\.\.?\/[^"']+)["']/g)].map((match) => (
      path.relative(REPO_ROOT, path.resolve(REPO_ROOT, path.dirname(relativePath), match[1]))
    ));
    for (const imported of imports) {
      assert.equal(declared.has(imported), true, `${relativePath} imports undeclared local builder source ${imported}`);
    }
  }
  const bootstrapSource = fs.readFileSync(
    path.join(REPO_ROOT, "scripts/prepare_viva_game_projection_remediation_package.mjs"),
    "utf8",
  );
  assert.deepEqual(
    [...bootstrapSource.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]).sort(),
    ["node:child_process", "node:crypto", "node:fs", "node:path", "node:url"],
  );

  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "viva-remediation-builder-bootstrap-test-")));
  fs.chmodSync(root, 0o700);
  try {
    const repositoryRoot = path.join(root, "repo");
    fs.mkdirSync(repositoryRoot, { mode: 0o700 });
    const maliciousMarker = path.join(root, "repository-node-modules-loaded");
    const maliciousModule = path.join(repositoryRoot, "node_modules/mongodb/index.js");
    fs.mkdirSync(path.dirname(maliciousModule), { recursive: true, mode: 0o700 });
    fs.writeFileSync(maliciousModule, `require("node:fs").writeFileSync(${JSON.stringify(maliciousMarker)}, "loaded")\n`, { mode: 0o600 });
    const runtime = runtimeDependencyFixture();
    const packageJsonBytes = Buffer.from(runtime.packageJsonBytesBase64, "base64");
    const packageLockBytes = Buffer.from(runtime.packageLockBytesBase64, "base64");
    const committed = (relativePath) => {
      if (relativePath === "package.json") return packageJsonBytes;
      if (relativePath === "package-lock.json") return packageLockBytes;
      return fs.readFileSync(path.join(REPO_ROOT, relativePath));
    };
    const output = path.join(root, "prepared-output");
    let importedEntrypoint;
    const result = await runRemediationPackageBuilderBootstrap([
      "--output-directory", output,
    ], {
      repoRoot: repositoryRoot,
      repository: {
        head: () => "a".repeat(40),
        branch: () => "codex/bootstrap-fixture",
        status: () => "",
        committedBytes: (_commit, relativePath) => committed(relativePath),
      },
      runNpmCi({ runtimeRoot, npmUserConfig, npmGlobalConfig }) {
        assert.notEqual(npmUserConfig, npmGlobalConfig);
        assert.equal(fs.statSync(npmUserConfig).mode & 0o777, 0o400);
        assert.equal(fs.statSync(npmGlobalConfig).mode & 0o777, 0o400);
        for (const entry of runtime.files) {
          const target = path.join(runtimeRoot, entry.path);
          fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
          fs.writeFileSync(target, Buffer.from(entry.bytesBase64, "base64"), { mode: 0o600 });
        }
        return { status: 0 };
      },
      async loadBuilder(entrypoint) {
        importedEntrypoint = entrypoint;
        assert.match(entrypoint, /\/executor\/scripts\/lib\/prepareVivaGameProjectionRemediationPackage\.mjs$/);
        assert.equal(fs.statSync(entrypoint).mode & 0o777, 0o400);
        assert.equal(fs.statSync(path.dirname(entrypoint)).mode & 0o777, 0o500);
        return {
          parseArgs: () => ({}),
          collectInstalledRuntimeDependencies: () => runtime,
          prepareVivaGameProjectionRemediationPackage: () => ({ output }),
          reportPreparedRemediationPackage: () => {},
        };
      },
    });
    assert.ok(importedEntrypoint);
    assert.equal(result.output, output);
    assert.equal(fs.existsSync(maliciousMarker), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("committed lockfile carries SRI for every mandatory remediation runtime package", () => {
  const packageLock = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package-lock.json"), "utf8"));
  for (const name of REMEDIATION_RUNTIME_PACKAGE_NAMES) {
    const locked = packageLock.packages?.[`node_modules/${name}`];
    assert.ok(locked?.version, `${name} version missing`);
    assert.match(locked?.resolved || "", /^https:\/\/registry\.npmjs\.org\//, `${name} resolved URL missing`);
    assert.match(locked?.integrity || "", /^sha512-[A-Za-z0-9+/]+={0,2}$/, `${name} integrity missing`);
  }
});

test("remediation package builder rejects provider evidence changed after review", () => {
  const value = fixture();
  value.artifacts.providerCapture.value.records[2].evidence.timeFrom = "13:30";
  assert.throws(() => buildRemediationExecutionPlan({
    artifacts: value.artifacts,
    generatedAt: value.generatedAt,
    mutationAt: value.mutationAt,
    operationId: value.operationId,
    repository: value.plan.repository,
    executorSources: value.plan.executorSources,
    runtimeDependencies: value.plan.runtimeDependencies,
  }), /exact reviewed preimage and provider evidence/);
});

test("remediation package builder rejects a skipped-scope count not proven by the cutover plan", () => {
  const value = fixture();
  value.artifacts.cutoverPlan.value.migration.totalSkipped = 3;
  assert.throws(() => buildRemediationExecutionPlan({
    artifacts: value.artifacts,
    generatedAt: value.generatedAt,
    mutationAt: value.mutationAt,
    operationId: value.operationId,
    repository: value.plan.repository,
    executorSources: value.plan.executorSources,
    runtimeDependencies: value.plan.runtimeDependencies,
  }), /does not exactly cover the cutover plan skipped scope/);
});

test("remediation package builder rejects a count-preserving eligible and skipped identity swap", () => {
  const value = fixture();
  const bundle = value.artifacts.migrationPlanBundle.value;
  const migrationPlan = JSON.parse(Buffer.from(bundle.plans[0].bytesBase64, "base64").toString("utf8"));
  migrationPlan.operations[0].filter._id.$oid = value.plan.operations[0].mongoId.$oid;
  const bytes = Buffer.from(`${JSON.stringify(migrationPlan, null, 2)}\n`);
  bundle.plans[0] = { sha256: sha256(bytes), bytesBase64: bytes.toString("base64") };
  value.artifacts.migrationPlanBundle.bytes = Buffer.from(`${JSON.stringify(bundle, null, 2)}\n`);
  value.artifacts.cutoverPlan.value.migration.planSha256s = [sha256(bytes)];
  assert.throws(() => buildRemediationExecutionPlan({
    artifacts: value.artifacts,
    generatedAt: value.generatedAt,
    mutationAt: value.mutationAt,
    operationId: value.operationId,
    repository: value.plan.repository,
    executorSources: value.plan.executorSources,
    runtimeDependencies: value.plan.runtimeDependencies,
  }), /overlap or differ|does not exactly cover/);
});

test("remediation package CLI rejects operation, plan, authorization, and arbitrary overrides", () => {
  const base = [
    "--cutover-plan", "/private/cutover", "--migration-plan-bundle", "/private/migrations",
    "--packet", "/private/packet", "--enrichment", "/private/enrichment",
    "--identity-audit", "/private/identity", "--provider-capture", "/private/provider",
    "--mongo-capture", "/private/mongo", "--full-backup", "/private/backup",
    "--full-backup-manifest", "/private/backup-manifest",
    "--restore-rehearsal-receipt", "/private/rehearsal", "--restored-artifact", "/private/restored",
    "--fence-receipt", "/private/fence", "--mongo-write-barrier-receipt", "/private/barrier",
    "--migration-connection-file", "/private/connection", "--flow-path", "/private/flow",
    "--generated-at", "2026-09-06T10:03:00.000Z", "--mutation-at", "2026-09-06T10:04:00.000Z",
    "--operation-id", "viva-remediation-cli-test", "--output-directory", "/private/output",
  ];
  for (const option of ["--operations", "--plan", "--execution-authorized", "--unexpected"]) {
    assert.throws(() => parseRemediationPackageArgs([...base, option, "value"]), new RegExp(`Unknown argument: ${option}`));
  }
});

test("remediation execution index is prepared-only and contains the exact pinned input set", () => {
  const inputs = Object.fromEntries([
    "plan", "cutoverPlan", "migrationPlanBundle", "packet", "enrichment", "identityAudit", "providerCapture", "mongoCapture",
    "fullBackup", "fullBackupManifest", "restoreRehearsalReceipt", "restoredArtifact", "fenceReceipt",
    "mongoWriteBarrierReceipt", "migrationConnectionFile", "flow",
  ].map((name) => [name, { path: `/private/${name}`, sha256: sha256(name) }]));
  const index = {
    formatVersion: 1,
    kind: "viva-game-projection-remediation-execution-index",
    state: "PREPARED_NOT_AUTHORIZED",
    repository: { commit: "4".repeat(40), branch: "codex/remediation-fixture" },
    inputs,
    executionAuthorized: false,
    liveMutationAuthorized: false,
    productionWritesPerformed: 0,
    finalCutoverPlanReusable: false,
  };
  const bytes = Buffer.from(canonicalJson(index));
  assert.equal(validateRemediationExecutionIndex(index, {
    expectedSha256: sha256(bytes),
    bytes,
  }), index);
  assert.throws(() => validateRemediationExecutionIndex({
    ...index,
    finalCutoverPlanReusable: true,
  }), /contract mismatch/);
});

test("remediation package is privately published and its index expands without input overrides", () => {
  const value = fixture();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "viva-remediation-package-test-")));
  fs.chmodSync(root, 0o700);
  try {
    const paths = {};
    for (const [name, artifact] of Object.entries(value.artifacts)) {
      const filePath = path.join(root, `${name}.input`);
      fs.writeFileSync(filePath, artifact.bytes, { mode: 0o600 });
      fs.chmodSync(filePath, 0o600);
      paths[name] = filePath;
    }
    const outputDirectory = path.join(root, "package");
    const result = prepareVivaGameProjectionRemediationPackage({
      ...paths,
      generatedAt: value.generatedAt,
      mutationAt: value.mutationAt,
      operationId: value.operationId,
      outputDirectory,
    }, {
      repository: value.plan.repository,
      executorSources: value.plan.executorSources,
      runtimeDependencies: value.plan.runtimeDependencies,
      allowTestRuntimeDependencies: true,
      skipCutoverExecutorVerification: true,
      skipRemediationExecutorVerification: true,
      nowMs: Date.parse("2026-09-06T10:05:00.000Z"),
    });
    assert.equal(fs.statSync(outputDirectory).mode & 0o077, 0);
    assert.equal(result.plan.operations.length, 4);
    assert.equal(result.executionIndex.finalCutoverPlanReusable, false);
    const indexPath = path.join(outputDirectory, "remediation-execution-index.json");
    const reportDirectory = path.join(root, "reports");
    fs.mkdirSync(reportDirectory, { mode: 0o700 });
    const parsed = parseRemediationRunnerArgs([
      "--execution-index", indexPath,
      "--expected-execution-index-sha256", result.executionIndexSha256,
      "--mode", "verify",
      "--report", path.join(reportDirectory, "verify.json"),
    ]);
    assert.equal(parsed.values.get("--plan"), path.join(outputDirectory, "remediation-plan.json"));
    assert.equal(parsed.values.get("--flow-path"), paths.flow);
    assert.throws(() => parseRemediationRunnerArgs([
      "--execution-index", indexPath,
      "--expected-execution-index-sha256", result.executionIndexSha256,
      "--mode", "verify",
      "--report", path.join(reportDirectory, "verify-override.json"),
      "--plan", paths.packet,
    ]), /does not allow overriding pinned inputs/);
    const mismatchedIndex = structuredClone(result.executionIndex);
    mismatchedIndex.repository.branch = "codex/different-reviewed-branch";
    const mismatchedBytes = Buffer.from(canonicalJson(mismatchedIndex));
    const mismatchedPath = path.join(root, "mismatched-index.json");
    fs.writeFileSync(mismatchedPath, mismatchedBytes, { mode: 0o600 });
    fs.chmodSync(mismatchedPath, 0o600);
    assert.throws(() => parseRemediationRunnerArgs([
      "--execution-index", mismatchedPath,
      "--expected-execution-index-sha256", sha256(mismatchedBytes),
      "--mode", "verify",
      "--report", path.join(reportDirectory, "verify-mismatch.json"),
    ]), /does not bind the plan repository and runtime flow/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("remediation plan rejects unexpected fields, loose identity updates, and evidence outside the fence", () => {
  const value = fixture();
  const payment = structuredClone(value.plan);
  payment.operations[0].update.$set["payment.status"] = "REFUNDED";
  assert.throws(() => validateRemediationPlanShape(payment), /fields do not match/);

  const identity = structuredClone(value.plan);
  identity.operations[3].update.$set["metadata.vivaExerciseId"] = "55555555-5555-4555-8555-555555555555";
  assert.throws(() => validateExecutableRemediationPlan(identity, {
    expectedPlanSha256: value.planSha256,
    planBytes: value.planBytes,
    artifacts: value.artifacts,
  }), /metadata identity payload mismatch|provider identity evidence/);

  const stale = structuredClone(value.plan);
  stale.source.providerCapturedAt = "2026-09-06T09:59:59.000Z";
  assert.throws(() => validateRemediationPlanShape(stale), /required order/);

  const oldPreparedPlan = structuredClone(value.plan);
  oldPreparedPlan.formatVersion = 1;
  assert.throws(() => validateRemediationPlanShape(oldPreparedPlan), /execution contract mismatch/);

  const captureBeforeBarrier = structuredClone(value.plan);
  captureBeforeBarrier.source.barrierInstalledAt = "2026-09-06T10:01:30.000Z";
  assert.throws(() => validateRemediationPlanShape(captureBeforeBarrier), /required order/);
});

test("remediation recovery validation survives plan and fence expiry while fresh apply validation fails", () => {
  const value = fixture();
  const afterExpiry = Date.parse("2026-09-06T11:00:00.000Z");
  assert.throws(() => validateExecutableRemediationPlan(value.plan, {
    expectedPlanSha256: value.planSha256,
    planBytes: value.planBytes,
    artifacts: value.artifacts,
    nowMs: afterExpiry,
  }), /stale or its fence expired/);
  assert.equal(validateExecutableRemediationPlan(value.plan, {
    expectedPlanSha256: value.planSha256,
    planBytes: value.planBytes,
    artifacts: value.artifacts,
    nowMs: afterExpiry,
    enforceFreshness: false,
  }).operations.length, 4);
});

test("remediation full-state gate rejects backup and live drift under the held barrier", async () => {
  const value = fixture();
  const exact = await assertFrozenRemediationFullCollection({}, value.plan, async () => ({
    documentCount: value.plan.source.fullBackupDocumentCount,
    fullCollectionStateSha256: value.plan.source.fullCollectionStateSha256,
  }));
  assert.equal(exact.fullCollectionStateSha256, value.plan.source.fullCollectionStateSha256);
  await assert.rejects(() => assertFrozenRemediationFullCollection({}, value.plan, async () => ({
    documentCount: value.plan.source.fullBackupDocumentCount,
    fullCollectionStateSha256: "f".repeat(64),
  })), /does not exactly match the frozen remediation backup/);
});

test("remediation execution rejects cross-game provider tuples, tenant drift, writer drift, and invalid restore artifacts", () => {
  const wrongProvider = fixture();
  rebindProviderEvidence(wrongProvider, 2, { studioId: "studio-other" });
  assert.throws(() => validateExecutableRemediationPlan(wrongProvider.plan, {
    expectedPlanSha256: wrongProvider.planSha256,
    planBytes: wrongProvider.planBytes,
    artifacts: wrongProvider.artifacts,
  }), /Provider time evidence does not bind the exact update/);

  const wrongCancelledQuery = fixture();
  Object.assign(wrongCancelledQuery.artifacts.enrichment.value.reviews[0], {
    reviewResult: "MANUAL_REVIEW_REQUIRED",
    originalReason: "EXERCISE_IDENTITY_INVALID",
    providerMatchCount: 1,
    providerRecordedDateMatchCount: 1,
    providerActiveMatchCount: 0,
  });
  rebindProviderEvidence(wrongCancelledQuery, 0, { identitySignalsSha256: "8".repeat(64) });
  assert.throws(() => validateExecutableRemediationPlan(wrongCancelledQuery.plan, {
    expectedPlanSha256: wrongCancelledQuery.planSha256,
    planBytes: wrongCancelledQuery.planBytes,
    artifacts: wrongCancelledQuery.artifacts,
  }), /Cancelled provider evidence is not exact/);

  const wrongMissingQuery = fixture();
  rebindProviderEvidence(wrongMissingQuery, 1, { identitySignalsSha256: "8".repeat(64) });
  assert.throws(() => validateExecutableRemediationPlan(wrongMissingQuery.plan, {
    expectedPlanSha256: wrongMissingQuery.planSha256,
    planBytes: wrongMissingQuery.planBytes,
    artifacts: wrongMissingQuery.artifacts,
  }), /Missing provider evidence is not exact/);

  const wrongTenant = fixture();
  wrongTenant.artifacts.packet.value.tenantKey = "other-tenant";
  assert.throws(() => validateExecutableRemediationPlan(wrongTenant.plan, {
    expectedPlanSha256: wrongTenant.planSha256,
    planBytes: wrongTenant.planBytes,
    artifacts: wrongTenant.artifacts,
  }), /packet internal binding mismatch/);

  const wrongWriterInventory = fixture();
  wrongWriterInventory.artifacts.cutoverPlan.value.writerFence.writerInventorySha256 = "9".repeat(64);
  assert.throws(() => validateExecutableRemediationPlan(wrongWriterInventory.plan, {
    expectedPlanSha256: wrongWriterInventory.planSha256,
    planBytes: wrongWriterInventory.planBytes,
    artifacts: wrongWriterInventory.artifacts,
  }), /writer-fence receipt mismatch/);

  const wrongBackupCount = fixture();
  wrongBackupCount.artifacts.fullBackupManifest.value.documentCount -= 1;
  assert.throws(() => validateExecutableRemediationPlan(wrongBackupCount.plan, {
    expectedPlanSha256: wrongBackupCount.planSha256,
    planBytes: wrongBackupCount.planBytes,
    artifacts: wrongBackupCount.artifacts,
  }), /full backup is not bound/);

  const invalidRestoredArtifact = fixture();
  invalidRestoredArtifact.artifacts.restoredArtifact.bytes = Buffer.from("not-ejson");
  invalidRestoredArtifact.plan.source.restoredArtifactSha256 = sha256(
    invalidRestoredArtifact.artifacts.restoredArtifact.bytes,
  );
  invalidRestoredArtifact.artifacts.cutoverPlan.value.evidence.restoreArtifactSha256 = invalidRestoredArtifact.plan.source.restoredArtifactSha256;
  invalidRestoredArtifact.artifacts.restoreRehearsalReceipt.value.restoredArtifactSha256 = invalidRestoredArtifact.plan.source.restoredArtifactSha256;
  assert.throws(() => validateExecutableRemediationPlan(invalidRestoredArtifact.plan, {
    expectedPlanSha256: invalidRestoredArtifact.planSha256,
    planBytes: invalidRestoredArtifact.planBytes,
    artifacts: invalidRestoredArtifact.artifacts,
  }), /restored rehearsal artifact is not canonical EJSON/);
});

test("remediation apply, reconcile, and restore preserve unrelated BSON fields with full-document CAS", async () => {
  const value = fixture();
  const collection = new MemoryCollection(value.documents);
  const remediationDocuments = value.documents.slice(0, value.plan.operations.length);
  const backup = buildRemediationBackup(
    value.plan,
    value.planSha256,
    "2026-09-06T10:03:30.000Z",
    remediationDocuments,
  );
  const fencePhases = [];
  const receipt = await applyRemediationPlan(
    collection,
    value.plan,
    value.planSha256,
    backup,
    async (_index, phase) => fencePhases.push(phase),
  );
  validateRemediationApplyReceipt(receipt, value.plan, value.planSha256);
  assert.equal(fencePhases.length, 8);
  for (const original of remediationDocuments) {
    const current = await collection.findOne({ _id: original._id });
    assert.equal(hashCanonicalEjson(current.payment), hashCanonicalEjson(original.payment));
    assert.deepEqual(current.participants, original.participants);
  }
  const identityCurrent = await collection.findOne({ _id: value.documents[3]._id });
  assert.equal(identityCurrent.id, value.documents[3].id);
  assert.equal(identityCurrent.dedupeKey, value.documents[3].dedupeKey);
  assert.deepEqual(identityCurrent.booking, value.documents[3].booking);
  const applied = await reconcileRemediationOutcome(collection, value.plan, value.planSha256, backup);
  assert.equal(applied.outcome, "APPLIED_RECOVERED");

  const restore = await restoreRemediationBackup(collection, value.plan, value.planSha256, backup, receipt);
  assert.equal(restore.restoredCount, 4);
  for (const original of remediationDocuments) {
    assert.equal(hashCanonicalEjson(await collection.findOne({ _id: original._id })), hashCanonicalEjson(original));
  }
  const restored = await reconcileRemediationRestoreOutcome(
    collection,
    value.plan,
    value.planSha256,
    backup,
    receipt,
    "2026-09-06T10:06:00.000Z",
  );
  assert.equal(restored.outcome, "RESTORED_RECOVERED");
});

test("remediation transaction uses one snapshot/majority transaction and rejects drift before CAS", async () => {
  const value = fixture();
  const collection = new MemoryCollection(value.documents);
  const remediationDocuments = value.documents.slice(0, value.plan.operations.length);
  const backup = buildRemediationBackup(
    value.plan, value.planSha256, "2026-09-06T10:03:30.000Z", remediationDocuments,
  );
  let transactionOptions;
  let ended = false;
  const client = {
    startSession: () => ({
      async withTransaction(callback, options) { transactionOptions = options; await callback(); },
      async endSession() { ended = true; },
    }),
    db: () => ({ collection: () => collection }),
  };
  const receipt = await runRemediationTransaction({
    client,
    mode: "apply",
    plan: value.plan,
    planSha256: value.planSha256,
    backup,
    assertFence: async () => true,
  });
  assert.equal(receipt.operationCount, 4);
  assert.deepEqual(transactionOptions, {
    readConcern: { level: "snapshot" },
    writeConcern: { w: "majority" },
    maxCommitTimeMS: 15_000,
  });
  assert.equal(ended, true);

  const driftedCollection = new MemoryCollection(value.documents);
  driftedCollection.documents.get(value.documents[0]._id.toHexString()).status = "DRIFTED";
  await assert.rejects(
    () => applyRemediationPlan(driftedCollection, value.plan, value.planSha256, backup),
    /preimage drift/,
  );
});

test("materialized remediation postimage changes only the category allowlist and audit trail", () => {
  const value = fixture();
  value.plan.operations.forEach((operation, index) => {
    const before = value.documents[index];
    const after = materializeRemediationPostimage(before, operation);
    assert.equal(hashCanonicalEjson(after.payment), hashCanonicalEjson(before.payment));
    assert.deepEqual(after.participants, before.participants);
    assert.equal(after.id, before.id);
    assert.equal(after.dedupeKey, before.dedupeKey);
  });
});

test("remediation runner journals unknown outcome before one transaction and the barrier has no broad role replacement", () => {
  const runner = fs.readFileSync(path.join(REPO_ROOT, "scripts/run_viva_game_projection_remediation.mjs"), "utf8");
  const barrier = fs.readFileSync(path.join(REPO_ROOT, "scripts/lib/vivaGameProjectionMongoWriteBarrier.mjs"), "utf8");
  const replica = fs.readFileSync(path.join(REPO_ROOT, "scripts/run_viva_game_projection_replica_tests.sh"), "utf8");
  assert.ok(runner.indexOf("REMEDIATION_TRANSACTION_OUTCOME_UNKNOWN") < runner.indexOf("runRemediationTransaction({"));
  assert.match(runner, /assertMongoWriteBarrier[\s\S]+assertNoConcurrentMongoWrites/);
  assert.match(barrier, /revokeRolesFromUser[\s\S]+grantRolesToUser/);
  assert.doesNotMatch(barrier, /updateUser:/);
  assert.doesNotMatch(replica, /user:'migration'[\s\S]+role:'root'/);
  assert.match(replica, /SCRAM-SHA-256[\s\S]+authenticationRestrictions/);
});

test("recovery controls are not journalled as verified before backup and apply receipt validation", () => {
  const runner = fs.readFileSync(path.join(REPO_ROOT, "scripts/run_viva_game_projection_remediation.mjs"), "utf8");
  const intent = runner.indexOf('journal.append("RECOVERY_CONTROLS_INTENT"');
  const backupValidation = runner.indexOf("validateRemediationBackup(backup, plan, expectedPlanSha256)");
  const applyValidation = runner.indexOf("validateRemediationApplyReceipt(applyReceipt, plan, expectedPlanSha256)");
  const verified = runner.indexOf('journal.append("RECOVERY_CONTROLS_VERIFIED"');
  assert.ok(intent >= 0);
  assert.ok(backupValidation > intent);
  assert.ok(applyValidation > backupValidation);
  assert.ok(verified > applyValidation);
  assert.equal(runner.indexOf('journal.append("RECOVERY_CONTROLS_VERIFIED"', verified + 1), -1);
});

test("minimal bootstrap verifies every recursive local executor source before importing the runner", async () => {
  assert.deepEqual(BOOTSTRAP_REMEDIATION_EXECUTOR_SOURCE_PATHS, REMEDIATION_EXECUTOR_SOURCE_PATHS);
  assert.deepEqual(BOOTSTRAP_REMEDIATION_RUNTIME_PACKAGE_NAMES, REMEDIATION_RUNTIME_PACKAGE_NAMES);
  const declared = new Set(REMEDIATION_EXECUTOR_SOURCE_PATHS);
  for (const relativePath of REMEDIATION_EXECUTOR_SOURCE_PATHS.filter((entry) => entry.endsWith(".mjs"))) {
    const source = fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
    const imports = [...source.matchAll(/from\s+["'](\.\.?\/[^"']+)["']/g)].map((match) => (
      path.relative(REPO_ROOT, path.resolve(REPO_ROOT, path.dirname(relativePath), match[1]))
    ));
    for (const imported of imports) {
      assert.equal(declared.has(imported), true, `${relativePath} imports undeclared local executor source ${imported}`);
    }
  }
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "viva-remediation-bootstrap-test-")));
  fs.chmodSync(root, 0o700);
  try {
    const commit = "a".repeat(40);
    const committed = new Map();
    for (const relativePath of BOOTSTRAP_REMEDIATION_EXECUTOR_SOURCE_PATHS) {
      const absolutePath = path.join(root, relativePath);
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true, mode: 0o700 });
      const bytes = Buffer.from(`fixture:${relativePath}\n`);
      fs.writeFileSync(absolutePath, bytes, { mode: 0o600 });
      committed.set(relativePath, bytes);
    }
    const executorSources = BOOTSTRAP_REMEDIATION_EXECUTOR_SOURCE_PATHS.map((relativePath) => ({
      path: relativePath,
      sha256: sha256(committed.get(relativePath)),
    }));
    const runtimeDependencies = runtimeDependencyFixture();
    committed.set("package.json", Buffer.from(runtimeDependencies.packageJsonBytesBase64, "base64"));
    committed.set("package-lock.json", Buffer.from(runtimeDependencies.packageLockBytesBase64, "base64"));
    const plan = {
      repository: { commit, branch: "codex/bootstrap-fixture" },
      executorSources,
      executorSourcesSha256: sha256(canonicalJson(executorSources)),
      runtimeDependencies,
      runtimeDependenciesSha256: sha256(canonicalJson(runtimeDependencies)),
    };
    const planBytes = Buffer.from(`${JSON.stringify(plan, null, 2)}\n`);
    const planPath = path.join(root, "plan.json");
    fs.writeFileSync(planPath, planBytes, { mode: 0o600 });
    const index = {
      kind: "viva-game-projection-remediation-execution-index",
      inputs: { plan: { path: planPath, sha256: sha256(planBytes) } },
    };
    const indexBytes = Buffer.from(canonicalJson(index));
    const indexPath = path.join(root, "index.json");
    fs.writeFileSync(indexPath, indexBytes, { mode: 0o600 });
    const argv = [
      "--execution-index", indexPath,
      "--expected-execution-index-sha256", sha256(indexBytes),
      "--mode", "verify",
      "--report", path.join(root, "report.json"),
    ];
    const repository = {
      head: () => commit,
      status: () => "",
      committedBytes: (_commit, relativePath) => committed.get(relativePath),
    };
    const attestation = verifyRemediationExecutorBootstrap(argv, { repoRoot: root, repository });
    assert.equal(attestation.repositoryCommit, commit);
    const runtimeRoot = path.join(root, "runtime");
    fs.mkdirSync(runtimeRoot, { mode: 0o700 });
    const snapshot = materializeRemediationExecutorSnapshot(attestation, { runtimeRoot });
    const originalRunner = committed.get("scripts/run_viva_game_projection_remediation.mjs");
    fs.appendFileSync(path.join(root, "scripts/run_viva_game_projection_remediation.mjs"), "tamper-after-attestation");
    assert.deepEqual(fs.readFileSync(path.join(snapshot, "scripts/run_viva_game_projection_remediation.mjs")), originalRunner);
    const mongodbRuntime = runtimeDependencies.files.find((entry) => entry.path === "node_modules/mongodb/package.json");
    assert.deepEqual(fs.readFileSync(path.join(snapshot, mongodbRuntime.path)), Buffer.from(mongodbRuntime.bytesBase64, "base64"));
    fs.writeFileSync(path.join(root, "scripts/run_viva_game_projection_remediation.mjs"), originalRunner, { mode: 0o600 });
    assert.throws(() => verifyRemediationExecutorBootstrap([
      "--plan", planPath,
      "--expected-plan-sha256", sha256(planBytes),
      "--mode", "verify",
      "--report", path.join(root, "direct.json"),
    ], { repoRoot: root, repository }), /only execution-index mode/);
    for (const relativePath of BOOTSTRAP_REMEDIATION_EXECUTOR_SOURCE_PATHS) {
      const originalCommitted = committed.get(relativePath);
      committed.set(relativePath, Buffer.concat([originalCommitted, Buffer.from("tamper")]));
      let imported = false;
      await assert.rejects(() => runRemediationBootstrap(argv, {
        repoRoot: root,
        repository,
        trustAnchorVerified: true,
        loadRunner: async () => { imported = true; return { main: async () => null }; },
      }), /differs before import/);
      assert.equal(imported, false);
      committed.set(relativePath, originalCommitted);
    }
    const dependencyTamper = structuredClone(plan);
    dependencyTamper.runtimeDependencies.files.find((entry) => entry.path === "node_modules/mongodb/package.json")
      .bytesBase64 = Buffer.from("tampered mongodb runtime").toString("base64");
    dependencyTamper.runtimeDependenciesSha256 = sha256(canonicalJson(dependencyTamper.runtimeDependencies));
    const dependencyTamperBytes = Buffer.from(`${JSON.stringify(dependencyTamper, null, 2)}\n`);
    const dependencyTamperPath = path.join(root, "tampered-plan.json");
    fs.writeFileSync(dependencyTamperPath, dependencyTamperBytes, { mode: 0o600 });
    const dependencyTamperIndex = {
      kind: "viva-game-projection-remediation-execution-index",
      inputs: { plan: { path: dependencyTamperPath, sha256: sha256(dependencyTamperBytes) } },
    };
    const dependencyTamperIndexBytes = Buffer.from(canonicalJson(dependencyTamperIndex));
    const dependencyTamperIndexPath = path.join(root, "tampered-index.json");
    fs.writeFileSync(dependencyTamperIndexPath, dependencyTamperIndexBytes, { mode: 0o600 });
    let importedTamperedDependency = false;
    await assert.rejects(() => runRemediationBootstrap([
      "--execution-index", dependencyTamperIndexPath,
      "--expected-execution-index-sha256", sha256(dependencyTamperIndexBytes),
      "--mode", "verify",
      "--report", path.join(root, "tampered-report.json"),
    ], {
      repoRoot: root,
      repository,
      trustAnchorVerified: true,
      loadRunner: async () => { importedTamperedDependency = true; return { main: async () => null }; },
    }), /runtime dependency differs before import/);
    assert.equal(importedTamperedDependency, false);
  } finally {
    const makeWritable = (directory) => {
      if (!fs.existsSync(directory)) return;
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return;
      fs.chmodSync(directory, 0o700);
      for (const entry of fs.readdirSync(directory)) makeWritable(path.join(directory, entry));
    };
    makeWritable(root);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("direct remediation runner CLI cannot bypass the reviewed execution index", async () => {
  await assert.rejects(() => runRemediationRunner(["--mode", "verify"]), /requires the exact execution index/);
});

test("clean-environment launcher excludes BASH_ENV and NODE_OPTIONS before trusted interpreters", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "viva-remediation-clean-env-test-"));
  try {
    const bashMarker = path.join(root, "bash-env-executed");
    const nodeMarker = path.join(root, "node-options-executed");
    const bashPayload = path.join(root, "bash-env.sh");
    const nodePayload = path.join(root, "node-options.cjs");
    fs.writeFileSync(bashPayload, `printf executed >${JSON.stringify(bashMarker)}\n`, { mode: 0o600 });
    fs.writeFileSync(nodePayload, `require("node:fs").writeFileSync(${JSON.stringify(nodeMarker)}, "executed")\n`, { mode: 0o600 });
    const ambient = {
      ...process.env,
      BASH_ENV: bashPayload,
      NODE_OPTIONS: `--require=${nodePayload}`,
      NODE_PATH: root,
    };
    const bash = spawnSync("/usr/bin/env", [
      "-i", "PATH=/usr/sbin:/usr/bin:/sbin:/bin", "/bin/bash", "--noprofile", "--norc", "-c", "exit 0",
    ], { env: ambient, encoding: "utf8" });
    const node = spawnSync("/usr/bin/env", [
      "-i", "PATH=/usr/sbin:/usr/bin:/sbin:/bin", process.execPath, "-e", "process.exit(0)",
    ], { env: ambient, encoding: "utf8" });
    assert.equal(bash.status, 0, bash.stderr);
    assert.equal(node.status, 0, node.stderr);
    assert.equal(fs.existsSync(bashMarker), false);
    assert.equal(fs.existsSync(nodeMarker), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
