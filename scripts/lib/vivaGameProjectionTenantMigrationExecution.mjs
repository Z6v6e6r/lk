import crypto from "node:crypto";
import { BSON, ObjectId } from "mongodb";

import { validateTenantMigrationScope } from "./vivaGameProjectionTenantMigration.mjs";

const HASH_RE = /^[a-f0-9]{64}$/;
const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WRITE_OPERATORS = new Set(["$set", "$push"]);
export const MAX_TRANSACTION_OPERATIONS = 100;

const fail = (message) => { throw new Error(message); };
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
};

export const sha256 = (value) => crypto.createHash("sha256")
  .update(Buffer.isBuffer(value) ? value : String(value))
  .digest("hex");

export const hashCanonicalEjson = (value) => sha256(BSON.EJSON.stringify(
  stableValue(BSON.EJSON.serialize(value, { relaxed: false })),
  null,
  0,
  { relaxed: false },
));

const exactKeys = (value, keys, label) => {
  if (!isObject(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} fields do not match the execution contract`);
  }
};

const assertHash = (value, label) => {
  if (!HASH_RE.test(String(value || ""))) fail(`${label} must be a SHA-256 digest`);
};

const mongoIdFromPlan = (value, label = "Migration operation _id") => {
  exactKeys(value, ["$oid"], label);
  if (!OBJECT_ID_RE.test(String(value.$oid || ""))) fail(`${label} must use canonical EJSON ObjectId`);
  return String(value.$oid).toLowerCase();
};

const stringSnapshot = (value) => typeof value === "string" && value.trim() ? value.trim() : null;
const normalizeTime = (value) => stringSnapshot(value)?.match(/(?:T|^)(\d{2}:\d{2})(?::\d{2})?/)?.[1] || null;

const sumSkipped = (skipped) => {
  if (!isObject(skipped)) fail("Migration skipped summary must be an object");
  return Object.entries(skipped).reduce((total, [reason, count]) => {
    if (!/^[A-Z][A-Z0-9_]*$/.test(reason) || !Number.isSafeInteger(count) || count < 1) {
      fail("Migration skipped summary is invalid");
    }
    return total + count;
  }, 0);
};

const safeIntegerValue = (value, label) => {
  const normalized = typeof value === "number" ? value : Number(value?.valueOf?.());
  if (!Number.isSafeInteger(normalized)) fail(`${label} must be a safe integer`);
  return normalized;
};

function validateOperation(operation, plan, index) {
  const label = `Migration operation ${index}`;
  exactKeys(operation, ["fingerprint", "filter", "update", "options", "report"], label);
  assertHash(operation.fingerprint, `${label} fingerprint`);
  exactKeys(operation.options, ["upsert"], `${label} options`);
  if (operation.options.upsert !== false) fail(`${label} must disable upsert`);
  if (!isObject(operation.filter) || !isObject(operation.update)) fail(`${label} filter/update is invalid`);
  exactKeys(operation.filter, [
    "_id", "tenantKey", "revision", "archived", "booking.studioId", "booking.date",
    "booking.timeFrom", "booking.timeTo", "status", "updatedAt", "id", "dedupeKey",
    "booking.vivaExerciseId", "booking.exerciseId", "metadata.vivaExerciseId",
    "metadata.exerciseId",
  ], `${label} filter`);
  const mongoId = mongoIdFromPlan(operation.filter._id, `${label} _id`);
  if (operation.filter.tenantKey !== null || operation.filter.revision !== null
    || operation.filter.archived?.$ne !== true) {
    fail(`${label} lacks the legacy tenant/revision CAS precondition`);
  }
  for (const key of ["booking.studioId", "booking.date", "booking.timeFrom", "booking.timeTo"]) {
    if (!Object.hasOwn(operation.filter, key)) fail(`${label} lacks slot precondition ${key}`);
  }
  for (const [key, value] of Object.entries(operation.filter)) {
    if (key === "_id" || key === "archived" || value === null || typeof value !== "object") continue;
    if (Object.keys(value).length !== 1 || value.$exists !== false) {
      fail(`${label} contains an unapproved filter operator`);
    }
  }
  const operators = Object.keys(operation.update);
  if (operators.length !== 2 || operators.some((key) => !WRITE_OPERATORS.has(key))) {
    fail(`${label} contains an unapproved update operator`);
  }
  exactKeys(operation.update.$push, ["audit.events"], `${label} audit append`);
  exactKeys(operation.update.$push["audit.events"], ["$each", "$slice"], `${label} audit append payload`);
  if (!Array.isArray(operation.update.$push["audit.events"].$each)
    || operation.update.$push["audit.events"].$each.length !== 1
    || operation.update.$push["audit.events"].$slice !== -100) {
    fail(`${label} audit append contract mismatch`);
  }
  const set = operation.update.$set;
  exactKeys(set, [
    "tenantKey", "revision", "updatedAt", "audit.updatedAt", "audit.lastEvent",
    "metadata.tenantRevisionMigration",
  ], `${label} set payload`);
  const marker = set["metadata.tenantRevisionMigration"];
  exactKeys(marker, ["operationId", "eventId", "tenantKey", "migratedAt", "previousUpdatedAt"], `${label} marker`);
  const event = set["audit.lastEvent"];
  exactKeys(event, ["id", "at", "type", "source", "payload"], `${label} audit event`);
  exactKeys(event.payload, ["operationId", "tenantKey", "exerciseId", "reason"], `${label} audit payload`);
  if (set.tenantKey !== plan.scope.tenantKey || set.revision !== 1
    || marker.tenantKey !== plan.scope.tenantKey || marker.operationId !== plan.scope.operationId
    || marker.eventId !== event?.id || marker.migratedAt !== set.updatedAt
    || event.at !== set.updatedAt || event.type !== "GAME_TENANT_REVISION_MIGRATED"
    || event.source !== "viva_game_projection_tenant_migration"
    || event.payload.operationId !== plan.scope.operationId || event.payload.tenantKey !== plan.scope.tenantKey
    || event.payload.reason !== "PROVIDER_IDENTITY_CONFIRMED"
    || operation.update.$push["audit.events"].$each[0]?.id !== event?.id
    || JSON.stringify(operation.update.$push["audit.events"].$each[0]) !== JSON.stringify(event)) {
    fail(`${label} tenant/revision/audit binding mismatch`);
  }
  const rootId = stringSnapshot(operation.filter.id);
  const dedupeKey = stringSnapshot(operation.filter.dedupeKey);
  const exerciseSignals = [
    stringSnapshot(operation.filter["booking.vivaExerciseId"]),
    stringSnapshot(operation.filter["booking.exerciseId"]),
    stringSnapshot(operation.filter["metadata.vivaExerciseId"]),
    stringSnapshot(operation.filter["metadata.exerciseId"]),
    dedupeKey?.startsWith("viva:") ? stringSnapshot(dedupeKey.slice(5)) : null,
    rootId?.startsWith("viva_") ? stringSnapshot(rootId.slice(5)) : null,
  ].filter(Boolean);
  const uniqueExercises = [...new Set(exerciseSignals)];
  const date = stringSnapshot(operation.filter["booking.date"]);
  const studioId = stringSnapshot(operation.filter["booking.studioId"]);
  const timeFrom = normalizeTime(operation.filter["booking.timeFrom"]);
  const timeTo = normalizeTime(operation.filter["booking.timeTo"]);
  if (uniqueExercises.length !== 1 || !UUID_RE.test(uniqueExercises[0])
    || !date || !studioId || !timeFrom || !timeTo) {
    fail(`${label} semantic provider identity is invalid`);
  }
  const exerciseId = uniqueExercises[0];
  const expectedFingerprint = sha256(`${mongoId}|${exerciseId}|${studioId}|${date}|${timeFrom}|${timeTo}`);
  exactKeys(operation.report, ["fingerprint", "exerciseIdHash", "date", "reason"], `${label} report`);
  if (operation.report.fingerprint !== operation.fingerprint
    || operation.fingerprint !== expectedFingerprint
    || operation.report.exerciseIdHash !== sha256(exerciseId)
    || event.payload.exerciseId !== exerciseId
    || operation.report.date !== date
    || operation.report.reason !== "PROVIDER_IDENTITY_CONFIRMED") {
    fail(`${label} report binding mismatch`);
  }
  assertHash(operation.report.exerciseIdHash, `${label} exercise identity`);
  return { mongoId, eventId: event.id };
}

export function validateExecutableTenantMigrationPlan(plan, {
  expectedPlanSha256,
  planBytes,
  expectedSourceFlowSha256,
  expectedTenantKey,
  nowMs,
  maximumAgeMs = 30 * 60_000,
} = {}) {
  if (!isObject(plan) || plan.formatVersion !== 1 || plan.mongoIdEncoding !== "canonical-ejson"
    || plan.dryRunOnly !== true) fail("Migration plan execution contract mismatch");
  if (planBytes) {
    assertHash(expectedPlanSha256, "Expected plan digest");
    if (sha256(planBytes) !== expectedPlanSha256) fail("Migration plan digest mismatch");
  }
  validateTenantMigrationScope(plan.scope || {});
  if (expectedTenantKey && plan.scope.tenantKey !== expectedTenantKey) fail("Migration plan tenant mismatch");
  if (!isObject(plan.source)) fail("Migration plan source proof is missing");
  assertHash(plan.source.sourceFlowSha256, "Migration source-flow digest");
  if (plan.source.expectedSourceFlowSha256 !== plan.source.sourceFlowSha256
    || (expectedSourceFlowSha256 && plan.source.sourceFlowSha256 !== expectedSourceFlowSha256)) {
    fail("Migration plan source-flow proof mismatch");
  }
  if (plan.source.providerTenantKey !== plan.scope.tenantKey) fail("Migration plan provider tenant mismatch");
  for (const key of ["gamesSha256", "providerSha256", "providerCaptureReceiptSha256"]) {
    assertHash(plan.source[key], `Migration source ${key}`);
  }
  const generatedAtMs = Date.parse(plan.generatedAt);
  if (!Number.isFinite(generatedAtMs)) fail("Migration generatedAt is invalid");
  if (nowMs !== undefined && (generatedAtMs > nowMs + 60_000 || nowMs - generatedAtMs > maximumAgeMs)) {
    fail("Migration plan is stale or generated too far in the future");
  }
  if (nowMs !== undefined) {
    for (const key of ["gamesCapturedAt", "providerCapturedAt"]) {
      const capturedAtMs = Date.parse(plan.source[key]);
      if (!Number.isFinite(capturedAtMs) || capturedAtMs > nowMs + 60_000 || nowMs - capturedAtMs > maximumAgeMs) {
        fail(`Migration source ${key} is stale or invalid`);
      }
    }
  }
  if (!Number.isSafeInteger(plan.scannedCount) || plan.scannedCount < 0
    || !Number.isSafeInteger(plan.eligibleCount) || plan.eligibleCount < 0
    || !Array.isArray(plan.operations) || plan.operations.length !== plan.eligibleCount
    || plan.operations.length > MAX_TRANSACTION_OPERATIONS) {
    fail("Migration plan counts are invalid");
  }
  if (plan.scannedCount !== plan.eligibleCount + sumSkipped(plan.skipped)) {
    fail("Migration plan scanned/eligible/skipped counts do not reconcile");
  }
  const mongoIds = new Set();
  const fingerprints = new Set();
  const eventIds = new Set();
  const operations = plan.operations.map((operation, index) => {
    const identity = validateOperation(operation, plan, index);
    if (mongoIds.has(identity.mongoId) || fingerprints.has(operation.fingerprint) || eventIds.has(identity.eventId)) {
      fail("Migration plan contains duplicate operation identity");
    }
    mongoIds.add(identity.mongoId);
    fingerprints.add(operation.fingerprint);
    eventIds.add(identity.eventId);
    return { ...identity, fingerprint: operation.fingerprint };
  });
  return { operations, skippedCount: sumSkipped(plan.skipped) };
}

export function decodeTenantMigrationOperation(operation) {
  const mongoId = mongoIdFromPlan(operation?.filter?._id);
  return {
    filter: { ...structuredClone(operation.filter), _id: new ObjectId(mongoId) },
    update: structuredClone(operation.update),
    options: { upsert: false },
  };
}

const cloneBson = (value) => BSON.EJSON.parse(
  BSON.EJSON.stringify(value, null, 0, { relaxed: false }),
  { relaxed: false },
);

const setPath = (owner, dottedPath, value) => {
  const parts = dottedPath.split(".");
  const leaf = parts.pop();
  const target = parts.reduce((current, part) => {
    if (!isObject(current[part])) current[part] = {};
    return current[part];
  }, owner);
  target[leaf] = cloneBson(value);
};

export function materializeTenantMigrationPostimage(preimage, operation) {
  const result = cloneBson(preimage);
  for (const [key, value] of Object.entries(operation.update.$set)) setPath(result, key, value);
  for (const [key, instruction] of Object.entries(operation.update.$push)) {
    const parts = key.split(".");
    const leaf = parts.pop();
    const target = parts.reduce((current, part) => {
      if (!isObject(current[part])) current[part] = {};
      return current[part];
    }, result);
    const existing = Array.isArray(target[leaf]) ? target[leaf] : [];
    target[leaf] = [...existing, ...cloneBson(instruction.$each)].slice(instruction.$slice);
  }
  return result;
}

function buildApplyReceipt(plan, planSha256, operations, appliedAt) {
  return {
    formatVersion: 1,
    kind: "viva-game-projection-tenant-migration-apply-receipt",
    planSha256,
    sourceFlowSha256: plan.source.sourceFlowSha256,
    tenantKey: plan.scope.tenantKey,
    operationId: plan.scope.operationId,
    appliedAt,
    operationCount: operations.length,
    matchedCount: operations.length,
    modifiedCount: operations.length,
    upsertedCount: 0,
    operations,
  };
}

export function buildMigrationBackup({ planSha256, sourceFlowSha256, tenantKey, capturedAt, documents }) {
  assertHash(planSha256, "Backup plan digest");
  assertHash(sourceFlowSha256, "Backup source-flow digest");
  if (!Number.isFinite(Date.parse(capturedAt)) || !Array.isArray(documents) || documents.length === 0) {
    fail("Migration backup capture is invalid");
  }
  const records = documents.map((document) => {
    if (!(document?._id instanceof ObjectId)) fail("Migration backup requires BSON ObjectId documents");
    return {
      mongoId: document._id.toHexString(),
      preimageSha256: hashCanonicalEjson(document),
      document,
    };
  });
  if (new Set(records.map(({ mongoId }) => mongoId)).size !== records.length) {
    fail("Migration backup contains duplicate documents");
  }
  return {
    formatVersion: 1,
    kind: "viva-game-projection-tenant-migration-backup",
    planSha256,
    sourceFlowSha256,
    tenantKey,
    capturedAt,
    recordCount: records.length,
    records,
  };
}

export function validateMigrationBackup(backup, plan, planSha256) {
  if (!isObject(backup) || safeIntegerValue(backup.formatVersion, "Migration backup formatVersion") !== 1
    || backup.kind !== "viva-game-projection-tenant-migration-backup") fail("Migration backup contract mismatch");
  if (backup.planSha256 !== planSha256 || backup.sourceFlowSha256 !== plan.source.sourceFlowSha256
    || backup.tenantKey !== plan.scope.tenantKey || !Number.isFinite(Date.parse(backup.capturedAt))
    || !Array.isArray(backup.records)
    || safeIntegerValue(backup.recordCount, "Migration backup recordCount") !== backup.records.length
    || backup.records.length !== plan.operations.length) fail("Migration backup identity/count mismatch");
  const expectedIds = new Set(plan.operations.map((operation) => mongoIdFromPlan(operation.filter._id)));
  const observed = new Set();
  for (const [index, record] of backup.records.entries()) {
    exactKeys(record, ["mongoId", "preimageSha256", "document"], `Migration backup record ${index}`);
    if (!expectedIds.has(record.mongoId) || observed.has(record.mongoId)
      || !(record.document?._id instanceof ObjectId) || record.document._id.toHexString() !== record.mongoId
      || hashCanonicalEjson(record.document) !== record.preimageSha256) {
      fail("Migration backup record proof mismatch");
    }
    observed.add(record.mongoId);
  }
  return true;
}

export async function captureTenantMigrationPreimages(collection, plan, planSha256, capturedAt) {
  const validated = validateExecutableTenantMigrationPlan(plan);
  if (validated.operations.length === 0) fail("Migration apply requires at least one eligible operation");
  const documents = [];
  for (const operation of plan.operations) {
    const decoded = decodeTenantMigrationOperation(operation);
    const document = await collection.findOne(decoded.filter);
    if (!document) fail("Migration backup CAS precondition failed");
    documents.push(document);
  }
  return buildMigrationBackup({
    planSha256,
    sourceFlowSha256: plan.source.sourceFlowSha256,
    tenantKey: plan.scope.tenantKey,
    capturedAt,
    documents,
  });
}

export async function applyTenantMigrationPlan(collection, plan, planSha256, appliedAt, assertFence = async () => {}) {
  const validated = validateExecutableTenantMigrationPlan(plan);
  if (!Number.isFinite(Date.parse(appliedAt))) fail("Migration apply timestamp is invalid");
  const applied = [];
  for (const [index, operation] of plan.operations.entries()) {
    await assertFence(index, "BEFORE_WRITE");
    const decoded = decodeTenantMigrationOperation(operation);
    const result = await collection.updateOne(decoded.filter, decoded.update, decoded.options);
    if (result?.acknowledged !== true || result.matchedCount !== 1 || result.modifiedCount !== 1
      || result.upsertedCount !== 0 || result.upsertedId !== null) {
      fail(`Migration CAS write ${index} was not acknowledged exactly once`);
    }
    const identity = validated.operations[index];
    const postimage = await collection.findOne({
      _id: new ObjectId(identity.mongoId),
      tenantKey: plan.scope.tenantKey,
      revision: 1,
      "metadata.tenantRevisionMigration.operationId": plan.scope.operationId,
      "metadata.tenantRevisionMigration.eventId": identity.eventId,
    });
    if (!postimage) fail(`Migration CAS readback ${index} failed`);
    await assertFence(index, "AFTER_READBACK");
    applied.push({
      mongoIdHash: sha256(identity.mongoId),
      fingerprint: identity.fingerprint,
      eventId: identity.eventId,
      postimageSha256: hashCanonicalEjson(postimage),
    });
  }
  return buildApplyReceipt(plan, planSha256, applied, appliedAt);
}

export async function reconcileTenantMigrationOutcome(collection, plan, planSha256, backup) {
  validateMigrationBackup(backup, plan, planSha256);
  const backupById = new Map(backup.records.map((record) => [record.mongoId, record]));
  const recovered = [];
  let preimageCount = 0;
  let postimageCount = 0;
  let driftCount = 0;
  for (const [index, operation] of plan.operations.entries()) {
    const identity = validateOperation(operation, plan, index);
    const backupRecord = backupById.get(identity.mongoId);
    const current = await collection.findOne({ _id: new ObjectId(identity.mongoId) });
    if (!current || !backupRecord) {
      driftCount += 1;
      continue;
    }
    const currentSha256 = hashCanonicalEjson(current);
    if (currentSha256 === backupRecord.preimageSha256) {
      preimageCount += 1;
      continue;
    }
    const expectedPostimageSha256 = hashCanonicalEjson(
      materializeTenantMigrationPostimage(backupRecord.document, operation),
    );
    if (currentSha256 !== expectedPostimageSha256) {
      driftCount += 1;
      continue;
    }
    postimageCount += 1;
    recovered.push({
      mongoIdHash: sha256(identity.mongoId),
      fingerprint: identity.fingerprint,
      eventId: identity.eventId,
      postimageSha256: currentSha256,
    });
  }
  const operationCount = plan.operations.length;
  if (preimageCount === operationCount) {
    return { outcome: "ABORTED_NO_MUTATION", preimageCount, postimageCount, driftCount, applyReceipt: null };
  }
  if (postimageCount === operationCount) {
    const appliedAt = plan.operations[0]?.update?.$set?.updatedAt;
    return {
      outcome: "APPLIED_RECOVERED",
      preimageCount,
      postimageCount,
      driftCount,
      applyReceipt: buildApplyReceipt(plan, planSha256, recovered, appliedAt),
    };
  }
  return { outcome: "BLOCKED_MIXED_OR_DRIFT", preimageCount, postimageCount, driftCount, applyReceipt: null };
}

function buildRestoreReceipt(plan, planSha256, applyReceipt, restoredCount, restoredAt, recovered) {
  return {
    formatVersion: 1,
    kind: "viva-game-projection-tenant-migration-restore-receipt",
    planSha256,
    sourceFlowSha256: plan.source.sourceFlowSha256,
    tenantKey: plan.scope.tenantKey,
    operationId: plan.scope.operationId,
    applyReceiptAppliedAt: applyReceipt.appliedAt,
    restoredCount,
    restoredAt,
    recoveredFromUnknownOutcome: recovered,
  };
}

export async function reconcileTenantRestoreOutcome(collection, plan, planSha256, backup, applyReceipt, recoveredAt) {
  validateMigrationBackup(backup, plan, planSha256);
  validateApplyReceipt(applyReceipt, plan, planSha256);
  if (!Number.isFinite(Date.parse(recoveredAt))) fail("Restore reconciliation timestamp is invalid");
  const backupById = new Map(backup.records.map((record) => [record.mongoId, record]));
  const receiptByFingerprint = new Map(applyReceipt.operations.map((row) => [row.fingerprint, row]));
  let preimageCount = 0;
  let postimageCount = 0;
  let driftCount = 0;
  for (const operation of plan.operations) {
    const mongoId = mongoIdFromPlan(operation.filter._id);
    const current = await collection.findOne({ _id: new ObjectId(mongoId) });
    const backupRecord = backupById.get(mongoId);
    const applyRow = receiptByFingerprint.get(operation.fingerprint);
    if (!current || !backupRecord || !applyRow) {
      driftCount += 1;
      continue;
    }
    const currentSha256 = hashCanonicalEjson(current);
    if (currentSha256 === backupRecord.preimageSha256) preimageCount += 1;
    else if (currentSha256 === applyRow.postimageSha256) postimageCount += 1;
    else driftCount += 1;
  }
  const operationCount = plan.operations.length;
  if (preimageCount === operationCount) {
    return {
      outcome: "RESTORED_RECOVERED",
      preimageCount,
      postimageCount,
      driftCount,
      restoreReceipt: buildRestoreReceipt(plan, planSha256, applyReceipt, operationCount, recoveredAt, true),
    };
  }
  if (postimageCount === operationCount) {
    return { outcome: "RESTORE_ABORTED_POSTIMAGE", preimageCount, postimageCount, driftCount, restoreReceipt: null };
  }
  return { outcome: "BLOCKED_MIXED_OR_DRIFT", preimageCount, postimageCount, driftCount, restoreReceipt: null };
}

export function validateApplyReceipt(receipt, plan, planSha256) {
  if (!isObject(receipt) || receipt.formatVersion !== 1
    || receipt.kind !== "viva-game-projection-tenant-migration-apply-receipt"
    || receipt.planSha256 !== planSha256 || receipt.sourceFlowSha256 !== plan.source.sourceFlowSha256
    || receipt.tenantKey !== plan.scope.tenantKey || receipt.operationId !== plan.scope.operationId
    || !Number.isFinite(Date.parse(receipt.appliedAt)) || !Array.isArray(receipt.operations)
    || receipt.operationCount !== plan.operations.length || receipt.matchedCount !== receipt.operationCount
    || receipt.modifiedCount !== receipt.operationCount || receipt.upsertedCount !== 0) {
    fail("Migration apply receipt contract mismatch");
  }
  const expected = new Map(plan.operations.map((operation) => [
    operation.fingerprint,
    { mongoIdHash: sha256(mongoIdFromPlan(operation.filter._id)), eventId: operation.update.$set["audit.lastEvent"].id },
  ]));
  for (const row of receipt.operations) {
    const match = expected.get(row?.fingerprint);
    if (!match || row.mongoIdHash !== match.mongoIdHash || row.eventId !== match.eventId) {
      fail("Migration apply receipt operation mismatch");
    }
    assertHash(row.postimageSha256, "Migration postimage digest");
    expected.delete(row.fingerprint);
  }
  if (expected.size !== 0) fail("Migration apply receipt is incomplete");
  return true;
}

export async function restoreTenantMigrationBackup(
  collection,
  plan,
  planSha256,
  backup,
  applyReceipt,
  assertFence = async () => {},
) {
  validateMigrationBackup(backup, plan, planSha256);
  validateApplyReceipt(applyReceipt, plan, planSha256);
  const receiptByFingerprint = new Map(applyReceipt.operations.map((row) => [row.fingerprint, row]));
  const backupById = new Map(backup.records.map((row) => [row.mongoId, row]));
  let restoredCount = 0;
  for (const [index, operation] of plan.operations.entries()) {
    await assertFence(index, "BEFORE_RESTORE");
    const mongoId = mongoIdFromPlan(operation.filter._id);
    const current = await collection.findOne({ _id: new ObjectId(mongoId) });
    const receipt = receiptByFingerprint.get(operation.fingerprint);
    const preimage = backupById.get(mongoId);
    if (!current || !receipt || !preimage || hashCanonicalEjson(current) !== receipt.postimageSha256) {
      fail("Migration restore rejected post-apply drift");
    }
    const result = await collection.replaceOne({
      _id: current._id,
      tenantKey: plan.scope.tenantKey,
      revision: 1,
      "metadata.tenantRevisionMigration.operationId": plan.scope.operationId,
      "metadata.tenantRevisionMigration.eventId": operation.update.$set["audit.lastEvent"].id,
    }, preimage.document, { upsert: false });
    if (result?.acknowledged !== true || result.matchedCount !== 1 || result.modifiedCount !== 1
      || result.upsertedCount !== 0 || result.upsertedId !== null) {
      fail("Migration restore CAS was not acknowledged exactly once");
    }
    const restored = await collection.findOne({ _id: current._id });
    if (!restored || hashCanonicalEjson(restored) !== preimage.preimageSha256) {
      fail("Migration restore readback failed");
    }
    await assertFence(index, "AFTER_RESTORE_READBACK");
    restoredCount += 1;
  }
  return buildRestoreReceipt(plan, planSha256, applyReceipt, restoredCount, new Date().toISOString(), false);
}
