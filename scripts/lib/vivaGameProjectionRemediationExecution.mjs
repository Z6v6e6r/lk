import { BSON, ObjectId } from "mongodb";

import { canonicalJson, sha256 } from "./vivaGameProjectionCutoverContract.mjs";
import { hashCanonicalEjson } from "./vivaGameProjectionTenantMigrationExecution.mjs";

const HASH_RE = /^[a-f0-9]{64}$/;
const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const MAX_REMEDIATION_OPERATIONS = 100;
export const REMEDIATION_CATEGORIES = Object.freeze([
  "CANCEL_AND_ARCHIVE",
  "QUARANTINE_AND_ARCHIVE",
  "RECONCILE_PROVIDER_TIME",
  "REPAIR_METADATA_IDENTITY",
]);

const fail = (message) => { throw new Error(message); };
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value, keys, label) => {
  if (!isObject(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} fields do not match the remediation contract`);
  }
};
const assertHash = (value, label) => {
  if (!HASH_RE.test(String(value || ""))) fail(`${label} must be a SHA-256 digest`);
};
const assertTimestamp = (value, label) => {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail(`${label} must be an ISO timestamp`);
  return parsed;
};
const canonicalEjsonSha256 = (value) => sha256(BSON.EJSON.stringify(value, null, 0, { relaxed: false }));
const cloneBson = (value) => BSON.EJSON.parse(
  BSON.EJSON.stringify(value, null, 0, { relaxed: false }),
  { relaxed: false },
);
const mongoId = (value, label = "Remediation Mongo identity") => {
  exactKeys(value, ["$oid"], label);
  if (!OBJECT_ID_RE.test(String(value.$oid || ""))) fail(`${label} must be canonical EJSON ObjectId`);
  return String(value.$oid).toLowerCase();
};
const exactSet = (left, right, label) => {
  const normalizedLeft = [...left].sort();
  const normalizedRight = [...right].sort();
  if (normalizedLeft.length !== normalizedRight.length
    || normalizedLeft.some((value, index) => value !== normalizedRight[index])
    || new Set(normalizedLeft).size !== normalizedLeft.length
    || new Set(normalizedRight).size !== normalizedRight.length) {
    fail(`${label} does not match exactly`);
  }
};
const artifact = (artifacts, name, expectedSha256) => {
  const entry = artifacts?.[name];
  if (!Buffer.isBuffer(entry?.bytes) || !isObject(entry.value)) fail(`Remediation ${name} artifact is missing`);
  if (sha256(entry.bytes) !== expectedSha256) fail(`Remediation ${name} artifact digest mismatch`);
  return entry.value;
};
const byteArtifact = (artifacts, name, expectedSha256) => {
  const entry = artifacts?.[name];
  if (!Buffer.isBuffer(entry?.bytes)) fail(`Remediation ${name} artifact is missing`);
  if (sha256(entry.bytes) !== expectedSha256) fail(`Remediation ${name} artifact digest mismatch`);
  return entry.bytes;
};
const parseFullCollectionArtifact = (bytes, label) => {
  let documents;
  try { documents = BSON.EJSON.parse(bytes.toString("utf8"), { relaxed: false }); }
  catch { fail(`${label} is not canonical EJSON`); }
  if (!Array.isArray(documents) || documents.some((document) => !(document?._id instanceof ObjectId))) {
    fail(`${label} does not contain BSON documents with ObjectId identity`);
  }
  const rows = documents.map((document) => ({
    mongoId: document._id.toHexString(),
    documentSha256: hashCanonicalEjson(document),
  })).sort((left, right) => left.mongoId.localeCompare(right.mongoId));
  if (new Set(rows.map(({ mongoId: id }) => id)).size !== rows.length) {
    fail(`${label} contains duplicate identities`);
  }
  return {
    documents,
    byMongoId: new Map(documents.map((document) => [document._id.toHexString(), document])),
    documentCount: documents.length,
    fullCollectionStateSha256: sha256(canonicalJson(rows)),
  };
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

const providerIdentitySignals = (preimage) => {
  const signals = [
    preimage?.booking?.vivaExerciseId,
    preimage?.booking?.exerciseId,
    preimage?.metadata?.vivaExerciseId,
    preimage?.metadata?.exerciseId,
    String(preimage?.dedupeKey || "").startsWith("viva:") ? String(preimage.dedupeKey).slice(5) : null,
  ].filter((value) => UUID_RE.test(String(value || "")));
  return new Set(signals.map(String));
};
const providerQueryIdentitySignalsSha256 = (preimage) => {
  const signals = [
    preimage?.booking?.vivaExerciseId,
    preimage?.booking?.exerciseId,
    preimage?.metadata?.vivaExerciseId,
    preimage?.metadata?.exerciseId,
    String(preimage?.dedupeKey || "").startsWith("viva:") ? String(preimage.dedupeKey).slice(5) : null,
  ].map((value) => String(value || "").trim()).filter(Boolean);
  return sha256(canonicalJson([...new Set(signals)].sort()));
};

const validateProviderRecord = (record, operation, preimage, review) => {
  exactKeys(record, ["itemFingerprint", "category", "evidence", "evidenceSha256"], "Remediation provider record");
  if (record.itemFingerprint !== operation.itemFingerprint || record.category !== operation.category
    || record.evidenceSha256 !== operation.providerEvidenceSha256
    || sha256(canonicalJson(record.evidence)) !== record.evidenceSha256) {
    fail("Remediation provider record binding mismatch");
  }
  const evidence = record.evidence;
  const booking = preimage?.booking || {};
  const identitySignals = providerIdentitySignals(preimage);
  const identitySignalsSha256 = providerQueryIdentitySignalsSha256(preimage);
  if (operation.category === "CANCEL_AND_ARCHIVE") {
    exactKeys(evidence, [
      "exerciseId", "date", "studioId", "timeFrom", "timeTo", "identitySignalsSha256", "slotMatchCount",
      "status", "cancelled", "active",
    ], "Cancelled provider evidence");
    const invalidIdentitySlotReview = review?.reviewResult === "MANUAL_REVIEW_REQUIRED"
      && review?.originalReason === "EXERCISE_IDENTITY_INVALID"
      && review?.providerMatchCount === 1
      && review?.providerRecordedDateMatchCount === 1
      && review?.providerActiveMatchCount === 0;
    if (!UUID_RE.test(String(evidence.exerciseId || "")) || evidence.cancelled !== true || evidence.active !== false
      || evidence.date !== booking.date || evidence.studioId !== booking.studioId
      || evidence.timeFrom !== booking.timeFrom || evidence.timeTo !== booking.timeTo
      || evidence.identitySignalsSha256 !== identitySignalsSha256 || evidence.slotMatchCount !== 1
      || (!identitySignals.has(evidence.exerciseId) && !invalidIdentitySlotReview)) {
      fail("Cancelled provider evidence is not exact");
    }
  } else if (operation.category === "QUARANTINE_AND_ARCHIVE") {
    exactKeys(evidence, [
      "recordedDate", "studioId", "timeFrom", "timeTo", "identitySignalsSha256", "searchWindowDays", "matchCount",
    ], "Missing provider evidence");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(evidence.recordedDate || ""))
      || evidence.recordedDate !== booking.date || evidence.studioId !== booking.studioId
      || evidence.timeFrom !== booking.timeFrom || evidence.timeTo !== booking.timeTo
      || evidence.identitySignalsSha256 !== identitySignalsSha256
      || evidence.searchWindowDays !== 7 || evidence.matchCount !== 0) {
      fail("Missing provider evidence is not exact");
    }
  } else if (operation.category === "RECONCILE_PROVIDER_TIME") {
    exactKeys(evidence, ["exerciseId", "date", "studioId", "timeFrom", "timeTo", "cancelled", "active"], "Provider time evidence");
    if (!UUID_RE.test(String(evidence.exerciseId || "")) || evidence.active !== true || evidence.cancelled !== false
      || !identitySignals.has(evidence.exerciseId) || evidence.date !== booking.date || evidence.studioId !== booking.studioId
      || operation.update.$set["booking.timeFrom"] !== evidence.timeFrom
      || operation.update.$set["booking.timeTo"] !== evidence.timeTo) {
      fail("Provider time evidence does not bind the exact update");
    }
  } else if (operation.category === "REPAIR_METADATA_IDENTITY") {
    exactKeys(evidence, ["exerciseId", "date", "studioId", "timeFrom", "timeTo", "cancelled", "active"], "Provider identity evidence");
    if (!UUID_RE.test(String(evidence.exerciseId || "")) || evidence.active !== true || evidence.cancelled !== false
      || evidence.date !== booking.date || evidence.studioId !== booking.studioId
      || evidence.timeFrom !== booking.timeFrom || evidence.timeTo !== booking.timeTo
      || operation.update.$set["metadata.vivaExerciseId"] !== evidence.exerciseId
      || operation.update.$set["metadata.exerciseId"] !== evidence.exerciseId) {
      fail("Provider identity evidence does not bind the exact metadata update");
    }
  }
};

const allowedSetKeys = (category) => {
  const shared = [
    "updatedAt", "audit.updatedAt", "audit.lastEvent", "metadata.vivaProjectionRemediation",
  ];
  if (category === "CANCEL_AND_ARCHIVE") return ["status", "archived", ...shared];
  if (category === "QUARANTINE_AND_ARCHIVE") return ["archived", ...shared];
  if (category === "RECONCILE_PROVIDER_TIME") return ["booking.timeFrom", "booking.timeTo", ...shared];
  if (category === "REPAIR_METADATA_IDENTITY") {
    return ["metadata.vivaExerciseId", "metadata.exerciseId", ...shared];
  }
  fail("Remediation category is unsupported");
};

function validateOperation(operation, plan, index) {
  const label = `Remediation operation ${index}`;
  exactKeys(operation, [
    "itemFingerprint", "category", "mongoId", "preimageSha256", "providerEvidenceSha256", "update", "options",
  ], label);
  assertHash(operation.itemFingerprint, `${label} item fingerprint`);
  assertHash(operation.preimageSha256, `${label} preimage`);
  assertHash(operation.providerEvidenceSha256, `${label} provider evidence`);
  if (!REMEDIATION_CATEGORIES.includes(operation.category)) fail(`${label} category is invalid`);
  const id = mongoId(operation.mongoId, `${label} Mongo identity`);
  exactKeys(operation.options, ["upsert"], `${label} options`);
  if (operation.options.upsert !== false) fail(`${label} must disable upsert`);
  exactKeys(operation.update, ["$set", "$push"], `${label} update`);
  exactKeys(operation.update.$set, allowedSetKeys(operation.category), `${label} set payload`);
  exactKeys(operation.update.$push, ["audit.events"], `${label} push payload`);
  exactKeys(operation.update.$push["audit.events"], ["$each", "$slice"], `${label} audit append`);
  const pushed = operation.update.$push["audit.events"];
  if (!Array.isArray(pushed.$each) || pushed.$each.length !== 1 || pushed.$slice !== -100) {
    fail(`${label} audit append contract mismatch`);
  }
  const set = operation.update.$set;
  const marker = set["metadata.vivaProjectionRemediation"];
  const event = set["audit.lastEvent"];
  exactKeys(marker, ["operationId", "action", "at", "category"], `${label} marker`);
  exactKeys(event, ["id", "at", "type", "source", "payload"], `${label} event`);
  exactKeys(event.payload, ["operationId", "category"], `${label} event payload`);
  if (set.updatedAt !== plan.mutationAt || set["audit.updatedAt"] !== plan.mutationAt
    || marker.at !== plan.mutationAt || marker.operationId !== plan.operationId || marker.category !== operation.category
    || event.at !== plan.mutationAt || event.type !== "GAME_VIVA_VISIBILITY_REMEDIATED"
    || event.source !== "viva_game_projection_remediation" || event.payload.operationId !== plan.operationId
    || event.payload.category !== operation.category || pushed.$each[0]?.id !== event.id
    || canonicalEjsonSha256(pushed.$each[0]) !== canonicalEjsonSha256(event)) {
    fail(`${label} audit/marker binding mismatch`);
  }
  const actionByCategory = {
    CANCEL_AND_ARCHIVE: "PROVIDER_CANCELLED_EXCLUDE_ACTIVE_CONTOUR",
    QUARANTINE_AND_ARCHIVE: "PROVIDER_MISSING_QUARANTINE",
    RECONCILE_PROVIDER_TIME: "PROVIDER_TIME_READBACK",
    REPAIR_METADATA_IDENTITY: "EXACT_PROVIDER_IDENTITY_READBACK",
  };
  if (marker.action !== actionByCategory[operation.category]) fail(`${label} action/category mismatch`);
  if (operation.category === "CANCEL_AND_ARCHIVE" && (set.status !== "CANCELLED" || set.archived !== true)) {
    fail(`${label} cancel/archive payload mismatch`);
  }
  if (operation.category === "QUARANTINE_AND_ARCHIVE" && set.archived !== true) {
    fail(`${label} quarantine payload mismatch`);
  }
  if (operation.category === "RECONCILE_PROVIDER_TIME"
    && (!/^\d{2}:\d{2}$/.test(set["booking.timeFrom"]) || !/^\d{2}:\d{2}$/.test(set["booking.timeTo"]))) {
    fail(`${label} provider time payload mismatch`);
  }
  if (operation.category === "REPAIR_METADATA_IDENTITY") {
    const left = String(set["metadata.vivaExerciseId"] || "");
    const right = String(set["metadata.exerciseId"] || "");
    if (left !== right || !UUID_RE.test(left)) fail(`${label} metadata identity payload mismatch`);
  }
  for (const key of Object.keys(set)) {
    if (/payment|refund|provider/i.test(key) && key !== "metadata.vivaProjectionRemediation") {
      fail(`${label} attempts a payment, refund, or provider mutation`);
    }
  }
  return { mongoId: id, itemFingerprint: operation.itemFingerprint };
}

export function validateRemediationPlanShape(plan) {
  exactKeys(plan, [
    "formatVersion", "kind", "state", "generatedAt", "mutationAt", "operationId", "dryRunOnly",
    "executionAuthorized", "liveMutationAuthorized", "productionWritesPerformed", "source", "counts",
    "operations", "expectedPostRemediation", "repository", "executorSources", "executorSourcesSha256",
  ], "Remediation plan");
  if (plan.formatVersion !== 2 || plan.kind !== "viva-game-projection-remediation-execution-plan"
    || plan.state !== "PREPARED_NOT_AUTHORIZED" || plan.dryRunOnly !== true
    || plan.executionAuthorized !== false || plan.liveMutationAuthorized !== false
    || plan.productionWritesPerformed !== 0 || !String(plan.operationId || "").trim()) {
    fail("Remediation plan execution contract mismatch");
  }
  assertTimestamp(plan.generatedAt, "Remediation generatedAt");
  assertTimestamp(plan.mutationAt, "Remediation mutationAt");
  exactKeys(plan.repository, ["commit", "branch"], "Remediation repository identity");
  if (!/^[a-f0-9]{40}$/.test(String(plan.repository.commit || ""))
    || !String(plan.repository.branch || "").startsWith("codex/")
    || !Array.isArray(plan.executorSources) || plan.executorSources.length < 8) {
    fail("Remediation executor repository identity is invalid");
  }
  assertHash(plan.executorSourcesSha256, "Remediation executor source manifest");
  if (sha256(canonicalJson(plan.executorSources)) !== plan.executorSourcesSha256) {
    fail("Remediation executor source manifest digest mismatch");
  }
  for (const entry of plan.executorSources) {
    exactKeys(entry, ["path", "sha256"], "Remediation executor source entry");
    if (!String(entry.path || "").startsWith("scripts/") || !HASH_RE.test(String(entry.sha256 || ""))) {
      fail("Remediation executor source entry is invalid");
    }
  }
  const requiredExecutorSources = [
    "scripts/run_viva_game_projection_fenced_remediation.sh",
    "scripts/run_viva_game_projection_remediation.mjs",
    "scripts/run_viva_game_projection_tenant_migration.mjs",
    "scripts/lib/vivaGameProjectionRemediationExecution.mjs",
    "scripts/lib/vivaGameProjectionMongoWriteBarrier.mjs",
    "scripts/lib/vivaGameProjectionExecutorSource.mjs",
    "scripts/lib/vivaGameProjectionCutoverContract.mjs",
    "scripts/nodered_reviewed_flow_deploy/runtime_contract.mjs",
  ];
  exactSet(plan.executorSources.map((entry) => entry.path), requiredExecutorSources, "Remediation executor source path set");
  exactKeys(plan.source, [
    "packetSha256", "enrichmentSha256", "identityAuditSha256", "providerCaptureSha256",
    "mongoCaptureSha256", "sourceFlowSha256", "servicePrincipalSha256", "cutoverPlanSha256",
    "fullBackupSha256", "fullBackupManifestSha256", "restoreRehearsalReceiptSha256",
    "fullCollectionStateSha256", "restoredArtifactSha256", "fullBackupDocumentCount",
    "fenceReceiptSha256", "mongoWriteBarrierReceiptSha256", "fenceTokenSha256",
    "mongoTargetIdentitySha256", "applicationConnectionFingerprint", "migrationConnectionFingerprint", "replicaSetName",
    "tenantKeySha256", "runtimeMode", "migrationAuthenticationRestrictionsSha256",
    "captureSessionId", "fenceObservedAt", "fenceExpiresAt",
    "backupStartedAt", "backupCompletedAt", "restoreRehearsedAt", "providerCapturedAt", "mongoCapturedAt",
    "itemFingerprintSetSha256",
  ], "Remediation source");
  for (const key of [
    "packetSha256", "enrichmentSha256", "identityAuditSha256", "providerCaptureSha256",
    "mongoCaptureSha256", "sourceFlowSha256", "servicePrincipalSha256", "cutoverPlanSha256",
    "fullBackupSha256", "fullBackupManifestSha256", "restoreRehearsalReceiptSha256",
    "fullCollectionStateSha256", "restoredArtifactSha256",
    "fenceReceiptSha256", "mongoWriteBarrierReceiptSha256", "fenceTokenSha256",
    "mongoTargetIdentitySha256", "applicationConnectionFingerprint", "migrationConnectionFingerprint",
    "tenantKeySha256", "migrationAuthenticationRestrictionsSha256",
    "itemFingerprintSetSha256",
  ]) assertHash(plan.source[key], `Remediation source ${key}`);
  if (!Number.isSafeInteger(plan.source.fullBackupDocumentCount) || plan.source.fullBackupDocumentCount < 1
    || !String(plan.source.replicaSetName || "").trim()
    || plan.source.runtimeMode !== "SHADOW"
    || plan.source.applicationConnectionFingerprint === plan.source.migrationConnectionFingerprint) {
    fail("Remediation Mongo connection identity is invalid");
  }
  if (!/^[A-Za-z0-9._:-]{16,128}$/.test(String(plan.source.captureSessionId || ""))) {
    fail("Remediation capture session identity is invalid");
  }
  const observedAt = assertTimestamp(plan.source.fenceObservedAt, "Remediation fence observedAt");
  const expiresAt = assertTimestamp(plan.source.fenceExpiresAt, "Remediation fence expiresAt");
  const backupStartedAt = assertTimestamp(plan.source.backupStartedAt, "Remediation backup startedAt");
  const backupCompletedAt = assertTimestamp(plan.source.backupCompletedAt, "Remediation backup completedAt");
  const restoreRehearsedAt = assertTimestamp(plan.source.restoreRehearsedAt, "Remediation restore rehearsedAt");
  const providerAt = assertTimestamp(plan.source.providerCapturedAt, "Remediation provider capturedAt");
  const mongoAt = assertTimestamp(plan.source.mongoCapturedAt, "Remediation Mongo capturedAt");
  const generatedAt = Date.parse(plan.generatedAt);
  const mutationAt = Date.parse(plan.mutationAt);
  if (expiresAt <= observedAt || backupStartedAt < observedAt || backupCompletedAt < backupStartedAt
    || restoreRehearsedAt < backupCompletedAt || providerAt < restoreRehearsedAt || mongoAt < providerAt
    || generatedAt < providerAt || generatedAt < mongoAt || generatedAt >= expiresAt
    || mutationAt < generatedAt || mutationAt >= expiresAt) {
    fail("Remediation evidence was not captured under one held fence in the required order");
  }
  exactKeys(plan.counts, [
    "sourceActiveLegacyCount", "alreadyEligibleCount", "remediationTotal", "CANCEL_AND_ARCHIVE",
    "QUARANTINE_AND_ARCHIVE", "RECONCILE_PROVIDER_TIME", "REPAIR_METADATA_IDENTITY",
  ], "Remediation counts");
  if (!Array.isArray(plan.operations) || plan.operations.length < 1
    || plan.operations.length > MAX_REMEDIATION_OPERATIONS || plan.counts.remediationTotal !== plan.operations.length
    || !Number.isSafeInteger(plan.counts.sourceActiveLegacyCount) || plan.counts.sourceActiveLegacyCount < 1
    || !Number.isSafeInteger(plan.counts.alreadyEligibleCount) || plan.counts.alreadyEligibleCount < 0
    || plan.counts.sourceActiveLegacyCount !== plan.counts.alreadyEligibleCount + plan.counts.remediationTotal) {
    fail("Remediation operation count is invalid");
  }
  const identities = plan.operations.map((operation, index) => validateOperation(operation, plan, index));
  exactSet(identities.map(({ mongoId: id }) => id), identities.map(({ mongoId: id }) => id), "Remediation Mongo identities");
  exactSet(identities.map(({ itemFingerprint }) => itemFingerprint), identities.map(({ itemFingerprint }) => itemFingerprint), "Remediation fingerprints");
  for (const category of REMEDIATION_CATEGORIES) {
    const count = plan.operations.filter((operation) => operation.category === category).length;
    if (!Number.isSafeInteger(plan.counts[category]) || plan.counts[category] !== count) {
      fail("Remediation category counts do not reconcile");
    }
  }
  const fingerprints = identities.map(({ itemFingerprint }) => itemFingerprint).sort();
  if (sha256(canonicalJson(fingerprints)) !== plan.source.itemFingerprintSetSha256) {
    fail("Remediation fingerprint set digest mismatch");
  }
  exactKeys(plan.expectedPostRemediation, [
    "sourceActiveLegacyCount", "cancelledAndArchivedCount", "quarantinedAndArchivedCount",
    "correctedTimeCount", "correctedMetadataIdentityCount", "activeLegacyEligibleForFreshTenantMigrationPlan",
    "unresolvedActiveLegacyCount",
  ], "Remediation expected post-state");
  const expected = plan.expectedPostRemediation;
  if (expected.sourceActiveLegacyCount !== plan.counts.sourceActiveLegacyCount
    || expected.cancelledAndArchivedCount !== plan.counts.CANCEL_AND_ARCHIVE
    || expected.quarantinedAndArchivedCount !== plan.counts.QUARANTINE_AND_ARCHIVE
    || expected.correctedTimeCount !== plan.counts.RECONCILE_PROVIDER_TIME
    || expected.correctedMetadataIdentityCount !== plan.counts.REPAIR_METADATA_IDENTITY
    || expected.activeLegacyEligibleForFreshTenantMigrationPlan !== (
      plan.counts.alreadyEligibleCount + plan.counts.RECONCILE_PROVIDER_TIME + plan.counts.REPAIR_METADATA_IDENTITY
    )
    || expected.unresolvedActiveLegacyCount !== 0) {
    fail("Remediation expected post-state does not reconcile with the exact operation set");
  }
  return { operations: identities, fingerprints };
}

export function validateExecutableRemediationPlan(plan, {
  expectedPlanSha256,
  planBytes,
  artifacts,
  expectedExecutorSourcesSha256,
  nowMs,
  maximumAgeMs = 15 * 60_000,
} = {}) {
  const validated = validateRemediationPlanShape(plan);
  assertHash(expectedPlanSha256, "Expected remediation plan digest");
  if (!Buffer.isBuffer(planBytes) || sha256(planBytes) !== expectedPlanSha256) fail("Remediation plan digest mismatch");
  if (expectedExecutorSourcesSha256 && plan.executorSourcesSha256 !== expectedExecutorSourcesSha256) {
    fail("Remediation executor source digest mismatch");
  }
  const packet = artifact(artifacts, "packet", plan.source.packetSha256);
  const cutoverPlan = artifact(artifacts, "cutoverPlan", plan.source.cutoverPlanSha256);
  const enrichment = artifact(artifacts, "enrichment", plan.source.enrichmentSha256);
  const identityAudit = artifact(artifacts, "identityAudit", plan.source.identityAuditSha256);
  const providerCapture = artifact(artifacts, "providerCapture", plan.source.providerCaptureSha256);
  const mongoCapture = artifact(artifacts, "mongoCapture", plan.source.mongoCaptureSha256);
  const fullBackupBytes = byteArtifact(artifacts, "fullBackup", plan.source.fullBackupSha256);
  const restoredArtifactBytes = byteArtifact(artifacts, "restoredArtifact", plan.source.restoredArtifactSha256);
  const fullBackup = parseFullCollectionArtifact(fullBackupBytes, "Remediation full backup");
  const restoredArtifact = parseFullCollectionArtifact(restoredArtifactBytes, "Remediation restored rehearsal artifact");
  const fullBackupManifest = artifact(artifacts, "fullBackupManifest", plan.source.fullBackupManifestSha256);
  const restoreRehearsalReceipt = artifact(
    artifacts,
    "restoreRehearsalReceipt",
    plan.source.restoreRehearsalReceiptSha256,
  );
  const fenceReceipt = artifact(artifacts, "fenceReceipt", plan.source.fenceReceiptSha256);
  const barrierReceipt = artifact(artifacts, "mongoWriteBarrierReceipt", plan.source.mongoWriteBarrierReceiptSha256);
  if (cutoverPlan.formatVersion !== 1 || cutoverPlan.kind !== "viva-game-projection-tenant-cutover-plan"
    || cutoverPlan.state !== "READY_FOR_SEPARATE_LIVE_APPROVAL"
    || cutoverPlan.sourceFlowSha256 !== plan.source.sourceFlowSha256
    || cutoverPlan.tenantKeySha256 !== plan.source.tenantKeySha256
    || cutoverPlan.candidateSha256 !== fenceReceipt.candidateSha256
    || cutoverPlan.mongoTarget?.targetIdentitySha256 !== plan.source.mongoTargetIdentitySha256
    || cutoverPlan.mongoTarget?.connectionFingerprint !== plan.source.applicationConnectionFingerprint
    || cutoverPlan.mongoTarget?.migrationConnectionFingerprint !== plan.source.migrationConnectionFingerprint
    || cutoverPlan.mongoTarget?.replicaSetName !== plan.source.replicaSetName
    || cutoverPlan.evidence?.backupSha256 !== plan.source.fullBackupSha256
    || cutoverPlan.evidence?.backupManifestSha256 !== plan.source.fullBackupManifestSha256
    || cutoverPlan.evidence?.fullCollectionStateSha256 !== plan.source.fullCollectionStateSha256
    || cutoverPlan.evidence?.restoreArtifactSha256 !== plan.source.restoredArtifactSha256
    || cutoverPlan.writerFence?.fenceTokenSha256 !== plan.source.fenceTokenSha256
    || cutoverPlan.liveMutationAuthorized !== false) {
    fail("Remediation cutover-plan internal binding mismatch");
  }
  if (packet.formatVersion !== 2 || packet.kind !== "viva-game-projection-remediation-review-packet"
    || packet.captureSessionId !== plan.source.captureSessionId || packet.sourceFlowSha256 !== plan.source.sourceFlowSha256
    || sha256(String(packet.tenantKey || "")) !== plan.source.tenantKeySha256
    || packet.servicePrincipalSha256 !== plan.source.servicePrincipalSha256 || packet.executionAuthorized !== false) {
    fail("Remediation packet internal binding mismatch");
  }
  if (enrichment.formatVersion !== 2 || enrichment.kind !== "viva-game-projection-remediation-manual-review"
    || enrichment.packetSha256 !== plan.source.packetSha256 || enrichment.captureSessionId !== plan.source.captureSessionId
    || enrichment.sourceFlowSha256 !== plan.source.sourceFlowSha256
    || enrichment.tenantKeySha256 !== plan.source.tenantKeySha256
    || enrichment.servicePrincipalSha256 !== plan.source.servicePrincipalSha256
    || enrichment.providerCaptureSha256 !== plan.source.providerCaptureSha256
    || enrichment.capturedAt !== plan.source.providerCapturedAt || enrichment.executionAuthorized !== false) {
    fail("Remediation enrichment internal binding mismatch");
  }
  if (identityAudit.formatVersion !== 2 || identityAudit.kind !== "viva-game-projection-identity-reference-audit"
    || identityAudit.packetSha256 !== plan.source.packetSha256
    || identityAudit.enrichmentSha256 !== plan.source.enrichmentSha256
    || identityAudit.captureSessionId !== plan.source.captureSessionId
    || identityAudit.sourceFlowSha256 !== plan.source.sourceFlowSha256 || identityAudit.executionAuthorized !== false) {
    fail("Remediation identity-audit internal binding mismatch");
  }
  if (providerCapture.formatVersion !== 1 || providerCapture.kind !== "viva-admin-remediation-provider-capture"
    || providerCapture.captureSessionId !== plan.source.captureSessionId
    || providerCapture.servicePrincipalSha256 !== plan.source.servicePrincipalSha256
    || providerCapture.capturedAt !== plan.source.providerCapturedAt || providerCapture.fenceTokenSha256 !== plan.source.fenceTokenSha256) {
    fail("Remediation provider capture is not bound to the held fence");
  }
  if (mongoCapture.formatVersion !== 1 || mongoCapture.kind !== "viva-game-projection-remediation-mongo-capture"
    || mongoCapture.captureSessionId !== plan.source.captureSessionId
    || mongoCapture.sourceFlowSha256 !== plan.source.sourceFlowSha256
    || mongoCapture.mongoTargetIdentitySha256 !== plan.source.mongoTargetIdentitySha256
    || mongoCapture.capturedAt !== plan.source.mongoCapturedAt || mongoCapture.fenceTokenSha256 !== plan.source.fenceTokenSha256) {
    fail("Remediation Mongo capture is not bound to the held fence");
  }
  exactKeys(fullBackupManifest, [
    "formatVersion", "kind", "backupSha256", "fullCollectionStateSha256", "mongoTargetIdentitySha256",
    "artifactPath", "fenceTokenSha256", "database", "collection", "documentCount", "startedAt", "completedAt",
  ], "Remediation full backup manifest");
  if (fullBackupManifest.formatVersion !== 1
    || fullBackupManifest.kind !== "viva-game-projection-full-lk-games-backup-manifest"
    || fullBackupManifest.backupSha256 !== plan.source.fullBackupSha256
    || fullBackupManifest.fullCollectionStateSha256 !== plan.source.fullCollectionStateSha256
    || fullBackupManifest.fenceTokenSha256 !== plan.source.fenceTokenSha256
    || fullBackupManifest.mongoTargetIdentitySha256 !== plan.source.mongoTargetIdentitySha256
    || fullBackupManifest.database !== "games" || fullBackupManifest.collection !== "lk_games"
    || fullBackupManifest.documentCount !== plan.source.fullBackupDocumentCount
    || fullBackup.documentCount !== plan.source.fullBackupDocumentCount
    || fullBackup.fullCollectionStateSha256 !== plan.source.fullCollectionStateSha256
    || !String(fullBackupManifest.artifactPath || "").startsWith("/")
    || fullBackupManifest.startedAt !== plan.source.backupStartedAt
    || fullBackupManifest.completedAt !== plan.source.backupCompletedAt) {
    fail("Remediation full backup is not bound after the held fence");
  }
  exactKeys(restoreRehearsalReceipt, [
    "formatVersion", "kind", "backupSha256", "manifestSha256", "fullCollectionStateSha256",
    "mongoTargetIdentitySha256", "isolatedTargetIdentitySha256", "restoredArtifactPath",
    "restoredArtifactSha256", "restoredDocumentCount", "isolatedTarget", "postRestoreHashMatch", "rehearsedAt",
  ], "Remediation restore rehearsal receipt");
  if (restoreRehearsalReceipt.formatVersion !== 1
    || restoreRehearsalReceipt.kind !== "viva-game-projection-full-backup-restore-rehearsal"
    || restoreRehearsalReceipt.backupSha256 !== plan.source.fullBackupSha256
    || restoreRehearsalReceipt.manifestSha256 !== plan.source.fullBackupManifestSha256
    || restoreRehearsalReceipt.fullCollectionStateSha256 !== plan.source.fullCollectionStateSha256
    || restoreRehearsalReceipt.mongoTargetIdentitySha256 !== plan.source.mongoTargetIdentitySha256
    || !HASH_RE.test(String(restoreRehearsalReceipt.isolatedTargetIdentitySha256 || ""))
    || restoreRehearsalReceipt.restoredArtifactSha256 !== plan.source.restoredArtifactSha256
    || !String(restoreRehearsalReceipt.restoredArtifactPath || "").startsWith("/")
    || restoreRehearsalReceipt.restoredDocumentCount !== plan.source.fullBackupDocumentCount
    || restoredArtifact.documentCount !== plan.source.fullBackupDocumentCount
    || restoredArtifact.fullCollectionStateSha256 !== plan.source.fullCollectionStateSha256
    || restoreRehearsalReceipt.postRestoreHashMatch !== true
    || restoreRehearsalReceipt.isolatedTarget !== true
    || restoreRehearsalReceipt.rehearsedAt !== plan.source.restoreRehearsedAt) {
    fail("Remediation restore rehearsal is missing or not exact");
  }
  exactSet(fenceReceipt.operationIds || [], cutoverPlan.writerFence?.exactMigrationOperationIds || [], "Remediation fence operation set");
  exactSet(fenceReceipt.writerNodeIds || [], cutoverPlan.writerFence?.exactWriterNodeIds || [], "Remediation fence writer-node set");
  if (fenceReceipt.kind !== "viva-game-projection-writer-fence-receipt" || fenceReceipt.state !== "HELD"
    || sha256(String(fenceReceipt.fenceToken || "")) !== plan.source.fenceTokenSha256
    || fenceReceipt.sourceFlowSha256 !== plan.source.sourceFlowSha256
    || fenceReceipt.candidateSha256 !== cutoverPlan.candidateSha256
    || fenceReceipt.writerInventorySha256 !== cutoverPlan.writerFence?.writerInventorySha256
    || fenceReceipt.externalWriterProofSha256 !== cutoverPlan.writerFence?.externalWriterProofSha256
    || fenceReceipt.lockPath !== cutoverPlan.writerFence?.lockPath
    || sha256(String(fenceReceipt.tenantKey || "")) !== plan.source.tenantKeySha256
    || fenceReceipt.nodeRedProcessState !== "STOPPED" || fenceReceipt.ingressWriteRoutesBlocked !== true
    || fenceReceipt.internalSchedulersStopped !== true || fenceReceipt.allLkGamesWritersQuiescent !== true
    || fenceReceipt.externalMongoWritersBlocked !== true
    || fenceReceipt.observedAt !== plan.source.fenceObservedAt || fenceReceipt.expiresAt !== plan.source.fenceExpiresAt) {
    fail("Remediation writer-fence receipt mismatch");
  }
  if (barrierReceipt.kind !== "viva-game-projection-mongo-write-barrier-receipt" || barrierReceipt.state !== "HELD"
    || barrierReceipt.fenceTokenSha256 !== plan.source.fenceTokenSha256
    || barrierReceipt.cutoverPlanSha256 !== plan.source.cutoverPlanSha256
    || barrierReceipt.mongoTargetIdentitySha256 !== plan.source.mongoTargetIdentitySha256
    || barrierReceipt.applicationConnectionFingerprint !== plan.source.applicationConnectionFingerprint
    || barrierReceipt.migrationConnectionFingerprint !== plan.source.migrationConnectionFingerprint
    || barrierReceipt.replicaSetName !== plan.source.replicaSetName) {
    fail("Remediation Mongo write-barrier receipt mismatch");
  }
  const packetItems = new Map((packet.remediationItems || []).map((item) => [item?.itemFingerprint, item]));
  const itemFingerprints = (packet.remediationItems || []).map((item) => item?.itemFingerprint);
  const reviewFingerprints = (enrichment.reviews || []).map((review) => review?.itemFingerprint);
  const mongoFingerprints = (mongoCapture.records || []).map((record) => record?.itemFingerprint);
  const providerFingerprints = (providerCapture.records || []).map((record) => record?.itemFingerprint);
  exactSet(validated.fingerprints, itemFingerprints, "Remediation packet fingerprint set");
  exactSet(validated.fingerprints, reviewFingerprints, "Remediation review fingerprint set");
  exactSet(validated.fingerprints, mongoFingerprints, "Remediation Mongo-capture fingerprint set");
  exactSet(validated.fingerprints, providerFingerprints, "Remediation provider-capture fingerprint set");
  const reviews = new Map(enrichment.reviews.map((review) => [review.itemFingerprint, review]));
  const mongoRecords = new Map(mongoCapture.records.map((record) => [record.itemFingerprint, record]));
  const providerRecords = new Map(providerCapture.records.map((record) => [record.itemFingerprint, record]));
  const identityResults = new Map((identityAudit.results || []).map((result) => [result.itemFingerprint, result]));
  const identityFingerprints = [];
  for (const operation of plan.operations) {
    const review = reviews.get(operation.itemFingerprint);
    const record = mongoRecords.get(operation.itemFingerprint);
    const preimage = fullBackup.byMongoId.get(operation.mongoId.$oid);
    const packetItem = packetItems.get(operation.itemFingerprint);
    exactKeys(packetItem, [
      "itemFingerprint", "category", "mongoId", "rootGameId", "preimageSha256", "providerEvidenceSha256",
    ], "Remediation packet item");
    if (categoryForReview(review) !== operation.category || review.providerEvidenceSha256 !== operation.providerEvidenceSha256
      || record?.mongoId !== operation.mongoId.$oid || record?.preimageSha256 !== operation.preimageSha256
      || !preimage || hashCanonicalEjson(preimage) !== operation.preimageSha256
      || packetItem.category !== operation.category || packetItem.mongoId !== operation.mongoId.$oid
      || packetItem.rootGameId !== preimage.id || packetItem.preimageSha256 !== operation.preimageSha256
      || packetItem.providerEvidenceSha256 !== operation.providerEvidenceSha256) {
      fail("Remediation operation does not bind its review and Mongo preimage exactly");
    }
    validateProviderRecord(providerRecords.get(operation.itemFingerprint), operation, preimage, review);
    if (operation.category === "REPAIR_METADATA_IDENTITY") {
      identityFingerprints.push(operation.itemFingerprint);
      const result = identityResults.get(operation.itemFingerprint);
      const set = operation.update.$set;
      if (result?.rootGameIdChangeRequired !== false || result?.referenceRewriteRequired !== false
        || result?.fieldsToSet?.["metadata.vivaExerciseId"] !== set["metadata.vivaExerciseId"]
        || result?.fieldsToSet?.["metadata.exerciseId"] !== set["metadata.exerciseId"]
        || Object.keys(result.fieldsToSet || {}).sort().join(",") !== "metadata.exerciseId,metadata.vivaExerciseId") {
        fail("Remediation metadata identity fields are not exact or reference-safe");
      }
    }
  }
  exactSet(identityFingerprints, (identityAudit.results || []).map((result) => result?.itemFingerprint), "Remediation identity-audit target set");
  if (nowMs !== undefined) {
    const generatedAt = Date.parse(plan.generatedAt);
    if (generatedAt > nowMs + 60_000 || nowMs - generatedAt > maximumAgeMs || Date.parse(plan.source.fenceExpiresAt) <= nowMs) {
      fail("Remediation plan is stale or its fence expired");
    }
  }
  return validated;
}

const setPath = (owner, dottedPath, value) => {
  const parts = dottedPath.split(".");
  const leaf = parts.pop();
  const target = parts.reduce((current, part) => {
    if (!isObject(current[part])) current[part] = {};
    return current[part];
  }, owner);
  target[leaf] = cloneBson(value);
};

export function materializeRemediationPostimage(preimage, operation) {
  const postimage = cloneBson(preimage);
  for (const [key, value] of Object.entries(operation.update.$set)) setPath(postimage, key, value);
  const instruction = operation.update.$push["audit.events"];
  const existing = Array.isArray(postimage.audit?.events) ? postimage.audit.events : [];
  if (!isObject(postimage.audit)) postimage.audit = {};
  postimage.audit.events = [...existing, ...cloneBson(instruction.$each)].slice(instruction.$slice);
  return postimage;
}

export function buildRemediationBackup(plan, planSha256, capturedAt, documents) {
  validateRemediationPlanShape(plan);
  assertHash(planSha256, "Remediation backup plan digest");
  assertTimestamp(capturedAt, "Remediation backup capturedAt");
  if (!Array.isArray(documents) || documents.length !== plan.operations.length) fail("Remediation backup count mismatch");
  const operationById = new Map(plan.operations.map((operation) => [mongoId(operation.mongoId), operation]));
  const records = documents.map((document) => {
    if (!(document?._id instanceof ObjectId)) fail("Remediation backup requires BSON ObjectIds");
    const id = document._id.toHexString();
    const operation = operationById.get(id);
    const preimageSha256 = hashCanonicalEjson(document);
    if (!operation || operation.preimageSha256 !== preimageSha256) fail("Remediation backup preimage does not match the frozen plan");
    return { mongoId: id, itemFingerprint: operation.itemFingerprint, preimageSha256, document: cloneBson(document) };
  });
  exactSet([...operationById.keys()], records.map((record) => record.mongoId), "Remediation backup Mongo identity set");
  return {
    formatVersion: 1,
    kind: "viva-game-projection-remediation-backup",
    planSha256,
    sourceFlowSha256: plan.source.sourceFlowSha256,
    fenceTokenSha256: plan.source.fenceTokenSha256,
    mongoTargetIdentitySha256: plan.source.mongoTargetIdentitySha256,
    capturedAt,
    recordCount: records.length,
    records,
  };
}

export function validateRemediationBackup(backup, plan, planSha256) {
  validateRemediationPlanShape(plan);
  exactKeys(backup, [
    "formatVersion", "kind", "planSha256", "sourceFlowSha256", "fenceTokenSha256",
    "mongoTargetIdentitySha256", "capturedAt", "recordCount", "records",
  ], "Remediation backup");
  if (backup.formatVersion !== 1 || backup.kind !== "viva-game-projection-remediation-backup"
    || backup.planSha256 !== planSha256 || backup.sourceFlowSha256 !== plan.source.sourceFlowSha256
    || backup.fenceTokenSha256 !== plan.source.fenceTokenSha256
    || backup.mongoTargetIdentitySha256 !== plan.source.mongoTargetIdentitySha256
    || !Array.isArray(backup.records) || backup.recordCount !== backup.records.length
    || backup.records.length !== plan.operations.length) fail("Remediation backup contract mismatch");
  assertTimestamp(backup.capturedAt, "Remediation backup capturedAt");
  const operations = new Map(plan.operations.map((operation) => [mongoId(operation.mongoId), operation]));
  const ids = [];
  for (const [index, record] of backup.records.entries()) {
    exactKeys(record, ["mongoId", "itemFingerprint", "preimageSha256", "document"], `Remediation backup record ${index}`);
    const operation = operations.get(record.mongoId);
    if (!operation || !(record.document?._id instanceof ObjectId) || record.document._id.toHexString() !== record.mongoId
      || record.itemFingerprint !== operation.itemFingerprint || record.preimageSha256 !== operation.preimageSha256
      || hashCanonicalEjson(record.document) !== record.preimageSha256) fail("Remediation backup record proof mismatch");
    ids.push(record.mongoId);
  }
  exactSet([...operations.keys()], ids, "Remediation backup identity set");
  return true;
}

export async function captureRemediationPreimages(collection, plan, planSha256, capturedAt) {
  validateRemediationPlanShape(plan);
  const documents = [];
  for (const operation of plan.operations) {
    const document = await collection.findOne({ _id: new ObjectId(mongoId(operation.mongoId)) });
    if (!document || hashCanonicalEjson(document) !== operation.preimageSha256) {
      fail("Remediation backup preimage drifted from the frozen Mongo capture");
    }
    documents.push(document);
  }
  return buildRemediationBackup(plan, planSha256, capturedAt, documents);
}

const receiptOperation = (operation, document) => ({
  itemFingerprint: operation.itemFingerprint,
  mongoIdSha256: sha256(mongoId(operation.mongoId)),
  category: operation.category,
  postimageSha256: hashCanonicalEjson(document),
});

const buildApplyReceipt = (plan, planSha256, appliedAt, operations) => ({
  formatVersion: 1,
  kind: "viva-game-projection-remediation-apply-receipt",
  planSha256,
  sourceFlowSha256: plan.source.sourceFlowSha256,
  fenceTokenSha256: plan.source.fenceTokenSha256,
  mongoTargetIdentitySha256: plan.source.mongoTargetIdentitySha256,
  operationId: plan.operationId,
  appliedAt,
  operationCount: operations.length,
  matchedCount: operations.length,
  modifiedCount: operations.length,
  upsertedCount: 0,
  operations,
});

export async function applyRemediationPlan(collection, plan, planSha256, backup, assertFence = async () => {}) {
  validateRemediationBackup(backup, plan, planSha256);
  const backupById = new Map(backup.records.map((record) => [record.mongoId, record]));
  const applied = [];
  for (const [index, operation] of plan.operations.entries()) {
    await assertFence(index, "BEFORE_REMEDIATION_WRITE");
    const record = backupById.get(mongoId(operation.mongoId));
    const current = await collection.findOne({ _id: record.document._id });
    if (!current || hashCanonicalEjson(current) !== record.preimageSha256) fail("Remediation apply rejected preimage drift");
    const postimage = materializeRemediationPostimage(record.document, operation);
    const result = await collection.replaceOne(record.document, postimage, { upsert: false });
    if (result?.acknowledged !== true || result.matchedCount !== 1 || result.modifiedCount !== 1
      || result.upsertedCount !== 0 || result.upsertedId !== null) {
      fail("Remediation full-preimage CAS was not acknowledged exactly once");
    }
    const readback = await collection.findOne({ _id: record.document._id });
    if (!readback || hashCanonicalEjson(readback) !== hashCanonicalEjson(postimage)) fail("Remediation postimage readback failed");
    await assertFence(index, "AFTER_REMEDIATION_READBACK");
    applied.push(receiptOperation(operation, readback));
  }
  return buildApplyReceipt(plan, planSha256, plan.mutationAt, applied);
}

export function validateRemediationApplyReceipt(receipt, plan, planSha256) {
  validateRemediationPlanShape(plan);
  if (!isObject(receipt) || receipt.formatVersion !== 1
    || receipt.kind !== "viva-game-projection-remediation-apply-receipt" || receipt.planSha256 !== planSha256
    || receipt.sourceFlowSha256 !== plan.source.sourceFlowSha256 || receipt.fenceTokenSha256 !== plan.source.fenceTokenSha256
    || receipt.mongoTargetIdentitySha256 !== plan.source.mongoTargetIdentitySha256 || receipt.operationId !== plan.operationId
    || receipt.appliedAt !== plan.mutationAt || !Array.isArray(receipt.operations)
    || receipt.operationCount !== plan.operations.length || receipt.matchedCount !== receipt.operationCount
    || receipt.modifiedCount !== receipt.operationCount || receipt.upsertedCount !== 0) {
    fail("Remediation apply receipt contract mismatch");
  }
  const expected = new Map(plan.operations.map((operation) => [operation.itemFingerprint, operation]));
  for (const row of receipt.operations) {
    const operation = expected.get(row?.itemFingerprint);
    if (!operation || row.mongoIdSha256 !== sha256(mongoId(operation.mongoId)) || row.category !== operation.category) {
      fail("Remediation apply receipt operation mismatch");
    }
    assertHash(row.postimageSha256, "Remediation receipt postimage");
    expected.delete(row.itemFingerprint);
  }
  if (expected.size !== 0) fail("Remediation apply receipt is incomplete");
  return true;
}

export async function reconcileRemediationOutcome(collection, plan, planSha256, backup) {
  validateRemediationBackup(backup, plan, planSha256);
  const operations = new Map(plan.operations.map((operation) => [mongoId(operation.mongoId), operation]));
  let preimageCount = 0;
  let postimageCount = 0;
  let driftCount = 0;
  const receiptRows = [];
  for (const record of backup.records) {
    const current = await collection.findOne({ _id: record.document._id });
    const operation = operations.get(record.mongoId);
    if (!current) { driftCount += 1; continue; }
    const currentSha256 = hashCanonicalEjson(current);
    if (currentSha256 === record.preimageSha256) { preimageCount += 1; continue; }
    const postimage = materializeRemediationPostimage(record.document, operation);
    if (currentSha256 !== hashCanonicalEjson(postimage)) { driftCount += 1; continue; }
    postimageCount += 1;
    receiptRows.push(receiptOperation(operation, current));
  }
  if (preimageCount === plan.operations.length) {
    return { outcome: "ABORTED_NO_MUTATION", preimageCount, postimageCount, driftCount, applyReceipt: null };
  }
  if (postimageCount === plan.operations.length) {
    return {
      outcome: "APPLIED_RECOVERED", preimageCount, postimageCount, driftCount,
      applyReceipt: buildApplyReceipt(plan, planSha256, plan.mutationAt, receiptRows),
    };
  }
  return { outcome: "BLOCKED_MIXED_OR_DRIFT", preimageCount, postimageCount, driftCount, applyReceipt: null };
}

const buildRestoreReceipt = (plan, planSha256, restoredAt, restoredCount, recovered) => ({
  formatVersion: 1,
  kind: "viva-game-projection-remediation-restore-receipt",
  planSha256,
  sourceFlowSha256: plan.source.sourceFlowSha256,
  fenceTokenSha256: plan.source.fenceTokenSha256,
  mongoTargetIdentitySha256: plan.source.mongoTargetIdentitySha256,
  operationId: plan.operationId,
  restoredAt,
  restoredCount,
  recoveredFromUnknownOutcome: recovered,
});

export async function restoreRemediationBackup(
  collection,
  plan,
  planSha256,
  backup,
  applyReceipt,
  assertFence = async () => {},
) {
  validateRemediationBackup(backup, plan, planSha256);
  validateRemediationApplyReceipt(applyReceipt, plan, planSha256);
  const receiptByFingerprint = new Map(applyReceipt.operations.map((row) => [row.itemFingerprint, row]));
  const operationByFingerprint = new Map(plan.operations.map((operation) => [operation.itemFingerprint, operation]));
  let restoredCount = 0;
  for (const [index, record] of backup.records.entries()) {
    await assertFence(index, "BEFORE_REMEDIATION_RESTORE");
    const receipt = receiptByFingerprint.get(record.itemFingerprint);
    const operation = operationByFingerprint.get(record.itemFingerprint);
    const postimage = materializeRemediationPostimage(record.document, operation);
    const current = await collection.findOne({ _id: record.document._id });
    if (!current || hashCanonicalEjson(current) !== receipt.postimageSha256
      || receipt.postimageSha256 !== hashCanonicalEjson(postimage)) fail("Remediation restore rejected postimage drift");
    const result = await collection.replaceOne(postimage, record.document, { upsert: false });
    if (result?.acknowledged !== true || result.matchedCount !== 1 || result.modifiedCount !== 1
      || result.upsertedCount !== 0 || result.upsertedId !== null) fail("Remediation restore CAS was not acknowledged exactly once");
    const readback = await collection.findOne({ _id: record.document._id });
    if (!readback || hashCanonicalEjson(readback) !== record.preimageSha256) fail("Remediation restore readback failed");
    await assertFence(index, "AFTER_REMEDIATION_RESTORE_READBACK");
    restoredCount += 1;
  }
  return buildRestoreReceipt(plan, planSha256, new Date().toISOString(), restoredCount, false);
}

export async function reconcileRemediationRestoreOutcome(collection, plan, planSha256, backup, applyReceipt, recoveredAt) {
  validateRemediationBackup(backup, plan, planSha256);
  validateRemediationApplyReceipt(applyReceipt, plan, planSha256);
  assertTimestamp(recoveredAt, "Remediation restore reconciliation time");
  const receiptByFingerprint = new Map(applyReceipt.operations.map((row) => [row.itemFingerprint, row]));
  let preimageCount = 0;
  let postimageCount = 0;
  let driftCount = 0;
  for (const record of backup.records) {
    const current = await collection.findOne({ _id: record.document._id });
    const receipt = receiptByFingerprint.get(record.itemFingerprint);
    if (!current || !receipt) { driftCount += 1; continue; }
    const currentSha256 = hashCanonicalEjson(current);
    if (currentSha256 === record.preimageSha256) preimageCount += 1;
    else if (currentSha256 === receipt.postimageSha256) postimageCount += 1;
    else driftCount += 1;
  }
  if (preimageCount === plan.operations.length) {
    return {
      outcome: "RESTORED_RECOVERED", preimageCount, postimageCount, driftCount,
      restoreReceipt: buildRestoreReceipt(plan, planSha256, recoveredAt, preimageCount, true),
    };
  }
  if (postimageCount === plan.operations.length) {
    return { outcome: "RESTORE_ABORTED_POSTIMAGE", preimageCount, postimageCount, driftCount, restoreReceipt: null };
  }
  return { outcome: "BLOCKED_MIXED_OR_DRIFT", preimageCount, postimageCount, driftCount, restoreReceipt: null };
}

export async function runRemediationTransaction({
  client,
  mode,
  plan,
  planSha256,
  backup,
  applyReceipt,
  assertFence,
}) {
  if (!new Set(["apply", "restore"]).has(mode)) fail("Remediation transaction mode is invalid");
  const session = client.startSession();
  let receipt;
  try {
    await session.withTransaction(async () => {
      await assertFence(-1, "BEFORE_REMEDIATION_TRANSACTION");
      const collection = client.db("games").collection("lk_games");
      const transactionalCollection = {
        findOne: (filter) => collection.findOne(filter, { session, maxTimeMS: 15_000 }),
        replaceOne: (filter, replacement, options) => collection.replaceOne(filter, replacement, {
          ...options,
          session,
          bypassDocumentValidation: true,
          maxTimeMS: 15_000,
        }),
      };
      receipt = mode === "apply"
        ? await applyRemediationPlan(transactionalCollection, plan, planSha256, backup, assertFence)
        : await restoreRemediationBackup(transactionalCollection, plan, planSha256, backup, applyReceipt, assertFence);
      await assertFence(-1, "AFTER_REMEDIATION_TRANSACTION_BODY");
    }, {
      readConcern: { level: "snapshot" },
      writeConcern: { w: "majority" },
      maxCommitTimeMS: 15_000,
    });
    return receipt;
  } finally {
    await session.endSession();
  }
}
