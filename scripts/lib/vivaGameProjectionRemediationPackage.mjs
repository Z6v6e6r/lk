import { BSON, ObjectId } from "mongodb";

import { canonicalJson, sha256 } from "./vivaGameProjectionCutoverContract.mjs";
import { mongoAuthenticationRestrictionsSha256 } from "./vivaGameProjectionMongoWriteBarrier.mjs";
import {
  REMEDIATION_EXECUTOR_SOURCE_PATHS,
  validateMigrationPlanBundle,
  validateRemediationPlanShape,
} from "./vivaGameProjectionRemediationExecution.mjs";
import { hashCanonicalEjson } from "./vivaGameProjectionTenantMigrationExecution.mjs";

const HASH_RE = /^[a-f0-9]{64}$/;
const COMMIT_RE = /^[a-f0-9]{40}$/;
const OPERATION_ID_RE = /^[A-Za-z0-9._:-]{16,128}$/;
export const REMEDIATION_PACKAGE_INPUT_NAMES = Object.freeze([
  "cutoverPlan",
  "migrationPlanBundle",
  "packet",
  "enrichment",
  "identityAudit",
  "providerCapture",
  "mongoCapture",
  "fullBackup",
  "fullBackupManifest",
  "restoreRehearsalReceipt",
  "restoredArtifact",
  "fenceReceipt",
  "mongoWriteBarrierReceipt",
  "migrationConnectionFile",
  "flow",
]);

const fail = (message) => { throw new Error(message); };
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const assertHash = (value, label) => {
  if (!HASH_RE.test(String(value || ""))) fail(`${label} must be a SHA-256 digest`);
};
const exactKeys = (value, keys, label) => {
  if (!isObject(value) || Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) {
    fail(`${label} fields do not match the remediation package contract`);
  }
};
const artifactValue = (artifacts, name) => {
  const artifact = artifacts?.[name];
  if (!Buffer.isBuffer(artifact?.bytes)) fail(`Remediation package ${name} bytes are missing`);
  if (!isObject(artifact.value)) fail(`Remediation package ${name} JSON is missing`);
  return artifact;
};

const categoryForReview = (review) => {
  if (review?.reviewResult === "CANCELLED_READBACK_CONFIRMED"
    || (review?.reviewResult === "MANUAL_REVIEW_REQUIRED"
      && review?.originalReason === "EXERCISE_IDENTITY_INVALID"
      && review?.providerMatchCount === 1
      && review?.providerRecordedDateMatchCount === 1
      && review?.providerActiveMatchCount === 0)) return "CANCEL_AND_ARCHIVE";
  if (review?.reviewResult === "PROVIDER_ABSENT_WITHIN_PLUS_MINUS_7_DAYS") return "QUARANTINE_AND_ARCHIVE";
  if (review?.reviewResult === "EXACT_EXERCISE_SAME_DATE_STUDIO_TIME_CHANGED") return "RECONCILE_PROVIDER_TIME";
  if (review?.reviewResult === "ONE_IDENTITY_SIGNAL_HAS_UNIQUE_EXACT_PROVIDER_SLOT") return "REPAIR_METADATA_IDENTITY";
  fail("Remediation review result has no deterministic execution category");
};

const parseFullCollection = (artifact, label) => {
  let documents;
  try { documents = BSON.EJSON.parse(artifact.bytes.toString("utf8"), { relaxed: false }); }
  catch { fail(`${label} is not canonical EJSON`); }
  if (!Array.isArray(documents) || documents.length < 1
    || documents.some((document) => !(document?._id instanceof ObjectId))) {
    fail(`${label} must contain BSON documents with ObjectId identity`);
  }
  const rows = documents.map((document) => ({
    mongoId: document._id.toHexString(),
    documentSha256: hashCanonicalEjson(document),
  })).sort((left, right) => left.mongoId.localeCompare(right.mongoId));
  if (new Set(rows.map(({ mongoId }) => mongoId)).size !== rows.length) {
    fail(`${label} contains duplicate Mongo identities`);
  }
  return {
    documents,
    byMongoId: new Map(documents.map((document) => [document._id.toHexString(), document])),
    documentCount: documents.length,
    stateSha256: sha256(canonicalJson(rows)),
  };
};

const isActiveLegacyDocument = (document, dateFrom) => document?.archived !== true
  && !new Set(["CANCELLED", "CANCELED"]).has(String(document?.status || ""))
  && (document?.tenantKey === null || document?.tenantKey === undefined)
  && (document?.revision === null || document?.revision === undefined)
  && typeof document?.booking?.date === "string" && document.booking.date >= dateFrom
  && typeof document?.booking?.timeFrom === "string" && document.booking.timeFrom !== ""
  && typeof document?.booking?.timeTo === "string" && document.booking.timeTo !== ""
  && typeof document?.booking?.studioId === "string" && document.booking.studioId !== "";

const exactMap = (items, key, label) => {
  if (!Array.isArray(items) || items.length < 1) fail(`${label} must be a non-empty array`);
  const mapped = new Map();
  for (const item of items) {
    const identity = item?.[key];
    if (!identity || mapped.has(identity)) fail(`${label} contains a missing or duplicate ${key}`);
    mapped.set(identity, item);
  }
  return mapped;
};

const operationSet = (category, providerRecord, identityResult) => {
  if (category === "CANCEL_AND_ARCHIVE") return { status: "CANCELLED", archived: true };
  if (category === "QUARANTINE_AND_ARCHIVE") return { archived: true };
  if (category === "RECONCILE_PROVIDER_TIME") {
    return {
      "booking.timeFrom": providerRecord?.evidence?.timeFrom,
      "booking.timeTo": providerRecord?.evidence?.timeTo,
    };
  }
  if (category === "REPAIR_METADATA_IDENTITY") {
    return {
      "metadata.vivaExerciseId": identityResult?.fieldsToSet?.["metadata.vivaExerciseId"],
      "metadata.exerciseId": identityResult?.fieldsToSet?.["metadata.exerciseId"],
    };
  }
  fail("Remediation category is unsupported");
};

const actionByCategory = Object.freeze({
  CANCEL_AND_ARCHIVE: "PROVIDER_CANCELLED_EXCLUDE_ACTIVE_CONTOUR",
  QUARANTINE_AND_ARCHIVE: "PROVIDER_MISSING_QUARANTINE",
  RECONCILE_PROVIDER_TIME: "PROVIDER_TIME_READBACK",
  REPAIR_METADATA_IDENTITY: "EXACT_PROVIDER_IDENTITY_READBACK",
});

function buildOperations({
  packet, enrichment, identityAudit, providerCapture, mongoCapture, fullBackup, dateFrom, mutationAt, operationId,
}) {
  const packetItems = exactMap(packet.remediationItems, "itemFingerprint", "Remediation packet items");
  const reviews = exactMap(enrichment.reviews, "itemFingerprint", "Remediation reviews");
  const providerRecords = exactMap(providerCapture.records, "itemFingerprint", "Provider remediation capture");
  const mongoRecords = exactMap(mongoCapture.records, "itemFingerprint", "Mongo remediation capture");
  if (!Array.isArray(identityAudit.results)) fail("Remediation identity audit results are invalid");
  const identityResults = new Map();
  for (const result of identityAudit.results) {
    if (!result?.itemFingerprint || identityResults.has(result.itemFingerprint)) {
      fail("Remediation identity audit contains a missing or duplicate target");
    }
    identityResults.set(result.itemFingerprint, result);
  }
  const fingerprints = [...packetItems.keys()].sort();
  for (const mapped of [reviews, providerRecords, mongoRecords]) {
    if (mapped.size !== fingerprints.length || fingerprints.some((fingerprint) => !mapped.has(fingerprint))) {
      fail("Remediation package fingerprint sets do not match exactly");
    }
  }
  const operations = fingerprints.map((itemFingerprint) => {
    assertHash(itemFingerprint, "Remediation item fingerprint");
    const item = packetItems.get(itemFingerprint);
    const review = reviews.get(itemFingerprint);
    const providerRecord = providerRecords.get(itemFingerprint);
    const mongoRecord = mongoRecords.get(itemFingerprint);
    const category = categoryForReview(review);
    const preimage = fullBackup.byMongoId.get(String(mongoRecord?.mongoId || ""));
    const providerEvidenceSha256 = sha256(canonicalJson(providerRecord?.evidence));
    if (!preimage || !isActiveLegacyDocument(preimage, dateFrom)
      || item?.category !== category || providerRecord?.category !== category
      || providerRecord?.evidenceSha256 !== providerEvidenceSha256
      || review?.providerEvidenceSha256 !== providerEvidenceSha256
      || item?.providerEvidenceSha256 !== providerEvidenceSha256
      || item?.mongoId !== mongoRecord?.mongoId || item?.mongoId !== preimage._id.toHexString()
      || item?.rootGameId !== preimage.id || item?.preimageSha256 !== hashCanonicalEjson(preimage)
      || mongoRecord?.preimageSha256 !== item.preimageSha256) {
      fail("Remediation package item does not bind the exact reviewed preimage and provider evidence");
    }
    const identityResult = identityResults.get(itemFingerprint);
    if ((category === "REPAIR_METADATA_IDENTITY") !== Boolean(identityResult)) {
      fail("Remediation identity audit target set does not match the metadata repair set");
    }
    const event = {
      id: `viva_remediation_${sha256(canonicalJson({ operationId, itemFingerprint, mutationAt })).slice(0, 32)}`,
      at: mutationAt,
      type: "GAME_VIVA_VISIBILITY_REMEDIATED",
      source: "viva_game_projection_remediation",
      payload: { operationId, category },
    };
    return {
      itemFingerprint,
      category,
      mongoId: { $oid: item.mongoId },
      preimageSha256: item.preimageSha256,
      providerEvidenceSha256,
      update: {
        $set: {
          ...operationSet(category, providerRecord, identityResult),
          updatedAt: mutationAt,
          "audit.updatedAt": mutationAt,
          "audit.lastEvent": event,
          "metadata.vivaProjectionRemediation": {
            operationId,
            action: actionByCategory[category],
            at: mutationAt,
            category,
          },
        },
        $push: { "audit.events": { $each: [event], $slice: -100 } },
      },
      options: { upsert: false },
    };
  });
  if (identityResults.size !== operations.filter(({ category }) => category === "REPAIR_METADATA_IDENTITY").length) {
    fail("Remediation identity audit contains an extra or duplicate target");
  }
  return operations;
}

export function buildRemediationExecutionPlan({
  artifacts,
  generatedAt,
  mutationAt,
  operationId,
  repository,
  executorSources,
  runtimeDependencies,
} = {}) {
  if (!OPERATION_ID_RE.test(String(operationId || ""))) fail("Remediation operation id is invalid");
  if (!COMMIT_RE.test(String(repository?.commit || ""))
    || !String(repository?.branch || "").startsWith("codex/")) {
    fail("Remediation repository identity is invalid");
  }
  if (!Array.isArray(executorSources)
    || executorSources.map(({ path }) => path).sort().join("\0") !== [...REMEDIATION_EXECUTOR_SOURCE_PATHS].sort().join("\0")) {
    fail("Remediation executor source set is incomplete");
  }
  if (!isObject(runtimeDependencies)) fail("Remediation runtime dependency snapshot is missing");
  const inputs = Object.fromEntries([
    "cutoverPlan", "migrationPlanBundle", "packet", "enrichment", "identityAudit", "providerCapture", "mongoCapture",
    "fullBackupManifest", "restoreRehearsalReceipt", "fenceReceipt", "mongoWriteBarrierReceipt",
    "migrationConnectionFile",
  ].map((name) => [name, artifactValue(artifacts, name)]));
  for (const name of ["fullBackup", "restoredArtifact", "flow"]) {
    if (!Buffer.isBuffer(artifacts?.[name]?.bytes)) fail(`Remediation package ${name} bytes are missing`);
  }
  const fullBackup = parseFullCollection(artifacts.fullBackup, "Remediation full backup");
  const restored = parseFullCollection(artifacts.restoredArtifact, "Remediation restored artifact");
  const cutoverPlan = inputs.cutoverPlan.value;
  const packet = inputs.packet.value;
  const fenceReceipt = inputs.fenceReceipt.value;
  const connection = inputs.migrationConnectionFile.value;
  if (connection?.formatVersion !== 1 || connection?.kind !== "viva-game-projection-migration-mongo-connection"
    || typeof connection.uri !== "string" || !connection.uri.trim()
    || sha256(connection.uri.trim()) !== cutoverPlan?.mongoTarget?.migrationConnectionFingerprint) {
    fail("Remediation migration connection does not match the cutover plan");
  }
  if (sha256(artifacts.flow.bytes) !== cutoverPlan?.sourceFlowSha256) {
    fail("Remediation runtime flow does not match the cutover plan");
  }
  const dateFrom = cutoverPlan?.migration?.futureBoundaryDate;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateFrom || ""))
    || cutoverPlan?.migration?.futureBoundaryTimeZone !== "UTC") {
    fail("Remediation cutover plan lacks the exact future boundary date");
  }
  const sourceActiveLegacyCount = fullBackup.documents.filter((document) => (
    isActiveLegacyDocument(document, dateFrom)
  )).length;
  if (sourceActiveLegacyCount < 1) fail("Remediation full backup contains no active legacy scope");
  if (fullBackup.documentCount !== restored.documentCount || fullBackup.stateSha256 !== restored.stateSha256) {
    fail("Remediation restore rehearsal does not reproduce the full collection state");
  }
  const operations = buildOperations({
    packet,
    enrichment: inputs.enrichment.value,
    identityAudit: inputs.identityAudit.value,
    providerCapture: inputs.providerCapture.value,
    mongoCapture: inputs.mongoCapture.value,
    fullBackup,
    dateFrom,
    mutationAt,
    operationId,
  });
  const alreadyEligibleCount = cutoverPlan?.migration?.totalEligible;
  const previouslySkippedCount = cutoverPlan?.migration?.totalSkipped;
  const eligibleMongoIds = validateMigrationPlanBundle(inputs.migrationPlanBundle, cutoverPlan);
  const remediationMongoIds = operations.map((operation) => operation.mongoId.$oid).sort();
  const activeLegacyMongoIds = fullBackup.documents
    .filter((document) => isActiveLegacyDocument(document, dateFrom))
    .map((document) => document._id.toHexString()).sort();
  if (!Number.isSafeInteger(alreadyEligibleCount) || alreadyEligibleCount < 0
    || !Number.isSafeInteger(previouslySkippedCount) || previouslySkippedCount < 1
    || previouslySkippedCount !== operations.length
    || alreadyEligibleCount !== eligibleMongoIds.length
    || alreadyEligibleCount + previouslySkippedCount !== sourceActiveLegacyCount
    || remediationMongoIds.some((mongoId) => eligibleMongoIds.includes(mongoId))
    || JSON.stringify([...eligibleMongoIds, ...remediationMongoIds].sort()) !== JSON.stringify(activeLegacyMongoIds)) {
    fail("Remediation operation set does not exactly cover the cutover plan skipped scope");
  }
  const categoryCounts = Object.fromEntries(Object.keys(actionByCategory).map((category) => [
    category,
    operations.filter((operation) => operation.category === category).length,
  ]));
  const counts = {
    sourceActiveLegacyCount,
    alreadyEligibleCount,
    remediationTotal: operations.length,
    ...categoryCounts,
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
    repository,
    executorSources,
    executorSourcesSha256: sha256(canonicalJson(executorSources)),
    runtimeDependencies,
    runtimeDependenciesSha256: sha256(canonicalJson(runtimeDependencies)),
    source: {
      packetSha256: sha256(inputs.packet.bytes),
      enrichmentSha256: sha256(inputs.enrichment.bytes),
      identityAuditSha256: sha256(inputs.identityAudit.bytes),
      providerCaptureSha256: sha256(inputs.providerCapture.bytes),
      mongoCaptureSha256: sha256(inputs.mongoCapture.bytes),
      sourceFlowSha256: cutoverPlan.sourceFlowSha256,
      servicePrincipalSha256: packet.servicePrincipalSha256,
      cutoverPlanSha256: sha256(inputs.cutoverPlan.bytes),
      migrationPlanBundleSha256: sha256(inputs.migrationPlanBundle.bytes),
      eligibleMongoIdSetSha256: sha256(canonicalJson(eligibleMongoIds)),
      fullBackupSha256: sha256(artifacts.fullBackup.bytes),
      fullBackupManifestSha256: sha256(inputs.fullBackupManifest.bytes),
      restoreRehearsalReceiptSha256: sha256(inputs.restoreRehearsalReceipt.bytes),
      fullCollectionStateSha256: fullBackup.stateSha256,
      restoredArtifactSha256: sha256(artifacts.restoredArtifact.bytes),
      fullBackupDocumentCount: fullBackup.documentCount,
      fenceReceiptSha256: sha256(inputs.fenceReceipt.bytes),
      mongoWriteBarrierReceiptSha256: sha256(inputs.mongoWriteBarrierReceipt.bytes),
      fenceTokenSha256: sha256(String(fenceReceipt.fenceToken || "")),
      mongoTargetIdentitySha256: cutoverPlan.mongoTarget?.targetIdentitySha256,
      applicationConnectionFingerprint: cutoverPlan.mongoTarget?.connectionFingerprint,
      migrationConnectionFingerprint: cutoverPlan.mongoTarget?.migrationConnectionFingerprint,
      replicaSetName: cutoverPlan.mongoTarget?.replicaSetName,
      tenantKeySha256: cutoverPlan.tenantKeySha256,
      runtimeMode: "SHADOW",
      migrationAuthenticationRestrictionsSha256: mongoAuthenticationRestrictionsSha256(
        connection.authenticationRestrictions,
      ),
      captureSessionId: packet.captureSessionId,
      fenceObservedAt: fenceReceipt.observedAt,
      fenceExpiresAt: fenceReceipt.expiresAt,
      barrierInstalledAt: inputs.mongoWriteBarrierReceipt.value.installedAt,
      backupStartedAt: inputs.fullBackupManifest.value.startedAt,
      backupCompletedAt: inputs.fullBackupManifest.value.completedAt,
      restoreRehearsedAt: inputs.restoreRehearsalReceipt.value.rehearsedAt,
      providerCapturedAt: inputs.providerCapture.value.capturedAt,
      mongoCapturedAt: inputs.mongoCapture.value.capturedAt,
      itemFingerprintSetSha256: sha256(canonicalJson(operations.map(({ itemFingerprint }) => itemFingerprint).sort())),
    },
    counts,
    operations,
    expectedPostRemediation: {
      sourceActiveLegacyCount,
      cancelledAndArchivedCount: counts.CANCEL_AND_ARCHIVE,
      quarantinedAndArchivedCount: counts.QUARANTINE_AND_ARCHIVE,
      correctedTimeCount: counts.RECONCILE_PROVIDER_TIME,
      correctedMetadataIdentityCount: counts.REPAIR_METADATA_IDENTITY,
      activeLegacyEligibleForFreshTenantMigrationPlan: counts.alreadyEligibleCount
        + counts.RECONCILE_PROVIDER_TIME + counts.REPAIR_METADATA_IDENTITY,
      unresolvedActiveLegacyCount: 0,
    },
  };
  validateRemediationPlanShape(plan);
  return plan;
}

export function validateRemediationExecutionIndex(index, { expectedSha256, bytes } = {}) {
  exactKeys(index, [
    "formatVersion", "kind", "state", "repository", "inputs", "executionAuthorized",
    "liveMutationAuthorized", "productionWritesPerformed", "finalCutoverPlanReusable",
  ], "Remediation execution index");
  exactKeys(index.repository, ["commit", "branch"], "Remediation execution index repository");
  if (index.formatVersion !== 1
    || index.kind !== "viva-game-projection-remediation-execution-index"
    || index.state !== "PREPARED_NOT_AUTHORIZED"
    || index.executionAuthorized !== false || index.liveMutationAuthorized !== false
    || index.productionWritesPerformed !== 0 || index.finalCutoverPlanReusable !== false
    || !COMMIT_RE.test(String(index.repository?.commit || ""))
    || !String(index.repository?.branch || "").startsWith("codex/")
    || !isObject(index.inputs)) {
    fail("Remediation execution index contract mismatch");
  }
  const keys = Object.keys(index.inputs).sort();
  if (keys.join("\0") !== [...REMEDIATION_PACKAGE_INPUT_NAMES, "plan"].sort().join("\0")) {
    fail("Remediation execution index input set mismatch");
  }
  for (const [name, entry] of Object.entries(index.inputs)) {
    exactKeys(entry, ["path", "sha256"], `Remediation execution index ${name}`);
    if (!String(entry.path || "").startsWith("/") || !HASH_RE.test(String(entry.sha256 || ""))) {
      fail(`Remediation execution index ${name} entry is invalid`);
    }
  }
  if (expectedSha256 !== undefined) {
    assertHash(expectedSha256, "Expected remediation execution index digest");
    if (!Buffer.isBuffer(bytes) || sha256(bytes) !== expectedSha256) {
      fail("Remediation execution index digest mismatch");
    }
  }
  return index;
}
