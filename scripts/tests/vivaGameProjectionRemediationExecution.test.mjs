import assert from "node:assert/strict";
import fs from "node:fs";
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
  validateExecutableRemediationPlan,
  validateRemediationApplyReceipt,
  validateRemediationPlanShape,
} from "../lib/vivaGameProjectionRemediationExecution.mjs";
import { hashCanonicalEjson } from "../lib/vivaGameProjectionTenantMigrationExecution.mjs";
import { mongoAuthenticationRestrictionsSha256 } from "../lib/vivaGameProjectionMongoWriteBarrier.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const at = (name, value) => {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  return { name, value, bytes, sha256: sha256(bytes) };
};
const cloneBson = (value) => BSON.EJSON.parse(
  BSON.EJSON.stringify(value, null, 0, { relaxed: false }),
  { relaxed: false },
);

function fixture() {
  const fenceToken = "fixture-remediation-fence-token-with-entropy";
  const fenceTokenSha256 = sha256(fenceToken);
  const fenceObservedAt = "2026-09-06T10:00:00.000Z";
  const backupStartedAt = "2026-09-06T10:00:10.000Z";
  const backupCompletedAt = "2026-09-06T10:00:20.000Z";
  const restoreRehearsedAt = "2026-09-06T10:00:30.000Z";
  const providerCapturedAt = "2026-09-06T10:01:00.000Z";
  const mongoCapturedAt = "2026-09-06T10:02:00.000Z";
  const generatedAt = "2026-09-06T10:03:00.000Z";
  const mutationAt = "2026-09-06T10:04:00.000Z";
  const fenceExpiresAt = "2026-09-06T10:30:00.000Z";
  const captureSessionId = "remediation-fixture-session-01";
  const operationId = "viva-remediation-fixture-01";
  const tenantKey = "fixture-tenant";
  const sourceFlowSha256 = "a".repeat(64);
  const servicePrincipalSha256 = "b".repeat(64);
  const mongoTargetIdentitySha256 = "c".repeat(64);
  const applicationConnectionFingerprint = "e".repeat(64);
  const migrationConnectionFingerprint = "f".repeat(64);
  const migrationAuthenticationRestrictions = [{ clientSource: ["127.0.0.1"], serverAddress: ["127.0.0.1"] }];
  const executorSources = [
    "scripts/run_viva_game_projection_fenced_remediation.sh",
    "scripts/run_viva_game_projection_remediation.mjs",
    "scripts/run_viva_game_projection_tenant_migration.mjs",
    "scripts/lib/vivaGameProjectionRemediationExecution.mjs",
    "scripts/lib/vivaGameProjectionMongoWriteBarrier.mjs",
    "scripts/lib/vivaGameProjectionExecutorSource.mjs",
    "scripts/lib/vivaGameProjectionCutoverContract.mjs",
    "scripts/nodered_reviewed_flow_deploy/runtime_contract.mjs",
  ].map((sourcePath, index) => ({
    path: sourcePath,
    sha256: String(index + 1).repeat(64),
  }));
  const executorSourcesSha256 = sha256(canonicalJson(executorSources));
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
    cutoverPlan, packet, enrichment, identityAudit, providerCapture, mongoCapture, fenceReceipt, mongoWriteBarrierReceipt,
    fullBackupManifest, restoreRehearsalReceipt,
  ].map(({ name, value, bytes }) => [name, { value, bytes }]));
  artifacts.fullBackup = { bytes: fullBackup.bytes };
  artifacts.restoredArtifact = { bytes: fullBackup.bytes };
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
    source: {
      packetSha256: packet.sha256,
      enrichmentSha256: enrichment.sha256,
      identityAuditSha256: identityAudit.sha256,
      providerCaptureSha256: providerCapture.sha256,
      mongoCaptureSha256: mongoCapture.sha256,
      sourceFlowSha256,
      servicePrincipalSha256,
      cutoverPlanSha256,
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
  const backup = buildRemediationBackup(
    value.plan,
    value.planSha256,
    "2026-09-06T10:03:30.000Z",
    value.documents,
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
  for (const original of value.documents) {
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
  for (const original of value.documents) {
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
  const backup = buildRemediationBackup(value.plan, value.planSha256, "2026-09-06T10:03:30.000Z", value.documents);
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
