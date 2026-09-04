import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { BSON, ObjectId } from "mongodb";

import {
  assertMongoWriteBarrier,
  installMongoWriteBarrier,
} from "../lib/vivaGameProjectionMongoWriteBarrier.mjs";
import {
  buildMongoTargetIdentity,
  buildVivaGameProjectionCutoverPlan,
  canonicalJson,
  inventoryLkGamesWriters,
  sha256 as cutoverSha256,
  validateVivaGameProjectionCutoverPostcheck,
} from "../lib/vivaGameProjectionCutoverContract.mjs";
import {
  applyTenantMigrationPlan,
  captureTenantMigrationPreimages,
  decodeTenantMigrationOperation,
  hashCanonicalEjson,
  MAX_TRANSACTION_OPERATIONS,
  reconcileTenantMigrationOutcome,
  reconcileTenantRestoreOutcome,
  restoreTenantMigrationBackup,
  validateExecutableTenantMigrationPlan,
} from "../lib/vivaGameProjectionTenantMigrationExecution.mjs";
import { buildLegacyTenantMigrationPlan } from "../lib/vivaGameProjectionTenantMigration.mjs";
import { prepareVivaGameProjectionCutoverPacket } from "../prepare_viva_game_projection_cutover_packet.mjs";
import { prepareVivaGameProjectionCutoverPostcheck } from "../prepare_viva_game_projection_cutover_postcheck.mjs";
import { buildVivaGameProjectionSyncCandidate } from "../prepare_viva_game_projection_sync_candidate.mjs";
import {
  createDurableReportJournal,
  ensurePrivateDirectory,
  validateHeldWriterFence,
} from "../run_viva_game_projection_tenant_migration.mjs";

const sourceFlowSha256 = "a".repeat(64);
const candidateSha256 = "b".repeat(64);
const repositoryCommit = "c".repeat(40);
const tenantKey = "iSkq6G";
const nowIso = "2026-09-04T12:00:00.000Z";
const fenceToken = "fixture-fence-token-with-sufficient-entropy";
const fenceTokenSha256 = cutoverSha256(fenceToken);
const mongoConnectionFingerprint = "9".repeat(64);
const migrationConnectionFingerprint = "0".repeat(64);
const mongoTarget = buildMongoTargetIdentity({
  connectionFingerprint: mongoConnectionFingerprint,
  replicaSetName: "rs-fixture",
  database: "games",
  collection: "lk_games",
});
const sourceWriterInventory = [{ nodeId: "source-writer", name: "", operation: "updateOne", clientNode: "mongo" }];
const candidateWriterInventory = [
  { nodeId: "candidate-writer", name: "", operation: "findOneAndUpdate", clientNode: "mongo" },
  { nodeId: "source-writer", name: "", operation: "updateOne", clientNode: "mongo" },
];
const writerInventorySha256 = cutoverSha256(canonicalJson({
  sourceWriters: sourceWriterInventory,
  candidateWriters: candidateWriterInventory,
}));
const scope = {
  tenantKey,
  dateFrom: "2026-09-05",
  dateTo: "2026-09-05",
  operationId: "viva-projection-migration-20260904-a",
};
const exerciseId = "11111111-1111-4111-8111-111111111111";

const legacyGame = () => ({
  _id: new ObjectId("111111111111111111111111"),
  id: `viva_${exerciseId}`,
  tenantKey: null,
  revision: null,
  status: "PAID",
  archived: false,
  dedupeKey: `viva:${exerciseId}`,
  updatedAt: "2026-09-04T08:00:00.000Z",
  booking: {
    vivaExerciseId: exerciseId,
    exerciseId,
    studioId: "studio-1",
    date: "2026-09-05",
    timeFrom: "12:00",
    timeTo: "14:00",
  },
  metadata: { vivaExerciseId: exerciseId, exerciseId },
});

const providerRows = {
  "2026-09-05": [{
    id: exerciseId,
    studio: { id: "studio-1" },
    date: "2026-09-05",
    timeFrom: "2026-09-05T12:00:00+03:00",
    timeTo: "2026-09-05T14:00:00+03:00",
    status: "ACTIVE",
    active: true,
  }],
};

const write0600 = (filePath, bytes) => {
  fs.writeFileSync(filePath, bytes, { mode: 0o600, flag: "wx" });
  fs.chmodSync(filePath, 0o600);
};

function executablePlan() {
  const projectedGame = BSON.EJSON.serialize(legacyGame(), { relaxed: false });
  const built = buildLegacyTenantMigrationPlan([projectedGame], providerRows, scope, nowIso);
  return {
    formatVersion: 1,
    mongoIdEncoding: "canonical-ejson",
    generatedAt: nowIso,
    dryRunOnly: true,
    source: {
      gamesSha256: "d".repeat(64),
      providerSha256: "e".repeat(64),
      providerCaptureReceiptSha256: "f".repeat(64),
      sourceFlowSha256,
      expectedSourceFlowSha256: sourceFlowSha256,
      gamesCapturedAt: nowIso,
      providerCapturedAt: nowIso,
      providerTenantKey: tenantKey,
    },
    ...built,
  };
}

const cloneBson = (value) => BSON.EJSON.parse(BSON.EJSON.stringify(value, null, 0, { relaxed: false }), { relaxed: false });
const getPath = (owner, dotted) => dotted.split(".").reduce((value, key) => value?.[key], owner);
const setPath = (owner, dotted, value) => {
  const keys = dotted.split(".");
  const leaf = keys.pop();
  const target = keys.reduce((current, key) => (current[key] ??= {}), owner);
  target[leaf] = cloneBson(value);
};
const matches = (document, filter) => Object.entries(filter).every(([key, expected]) => {
  const actual = getPath(document, key);
  if (expected instanceof ObjectId) return actual instanceof ObjectId && actual.equals(expected);
  if (expected && typeof expected === "object" && Object.hasOwn(expected, "$exists")) {
    return (actual !== undefined) === expected.$exists;
  }
  if (expected && typeof expected === "object" && Object.hasOwn(expected, "$ne")) return actual !== expected.$ne;
  if (expected === null) return actual === null || actual === undefined;
  if (typeof expected === "number" && typeof actual?.valueOf === "function") return actual.valueOf() === expected;
  return assert.deepEqual(actual, expected) === undefined;
});

class FakeCollection {
  constructor(document) { this.document = cloneBson(document); }
  async findOne(filter) { return matches(this.document, filter) ? cloneBson(this.document) : null; }
  async updateOne(filter, update, options) {
    assert.equal(options.upsert, false);
    if (!matches(this.document, filter)) return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0, upsertedId: null };
    for (const [key, value] of Object.entries(update.$set)) setPath(this.document, key, value);
    for (const [key, push] of Object.entries(update.$push)) {
      const existing = getPath(this.document, key);
      const next = [...(Array.isArray(existing) ? existing : []), ...push.$each].slice(push.$slice);
      setPath(this.document, key, next);
    }
    return { acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedCount: 0, upsertedId: null };
  }
  async replaceOne(filter, replacement, options) {
    assert.equal(options.upsert, false);
    if (!matches(this.document, filter)) return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0, upsertedId: null };
    this.document = cloneBson(replacement);
    return { acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedCount: 0, upsertedId: null };
  }
}

const controls = (overrides = {}) => ({
  formatVersion: 1,
  tenantKey,
  ci: {
    state: "PASS",
    headSha: repositoryCommit,
    runId: "33873141278",
    workflow: "source-quality",
    conclusion: "success",
    url: "https://github.com/padlhub/lk/actions/runs/33873141278",
    completedAt: nowIso,
  },
  runtimeTenant: {
    state: "PASS",
    host: "lk-primary-147",
    hostname: "padlhub-lk-primary",
    processName: "node-red",
    pm2ProcessId: 0,
    tenantKeySha256: cutoverSha256(tenantKey),
    durableConfigReadback: true,
    restartUsedUpdateEnv: true,
    postRestartReadback: true,
    restartAt: nowIso,
    readBackAt: nowIso,
  },
  writerFence: {
    state: "HELD",
    host: "lk-primary-147",
    hostname: "padlhub-lk-primary",
    processName: "node-red",
    pm2ProcessId: 0,
    fenceTokenSha256,
    writerInventorySha256,
    lockPath: "/run/lock/padlhub-viva-game-projection-cutover.lock",
    sourceFlowSha256,
    candidateSha256,
    nodeRedProcessState: "STOPPED",
    ingressWriteRoutesBlocked: true,
    internalSchedulersStopped: true,
    allLkGamesWritersQuiescent: true,
    externalMongoWritersBlocked: true,
    externalWriterProofSha256: "8".repeat(64),
    externalWriterProofPath: "/private/external-writer-proof.json",
    writerNodeIds: ["source-writer", "candidate-writer"],
    observedAt: nowIso,
    expiresAt: "2026-09-04T12:10:00.000Z",
  },
  backup: {
    state: "PASS",
    backupSha256: "1".repeat(64),
    manifestSha256: "2".repeat(64),
    fullCollectionStateSha256: "3".repeat(64),
    mongoTargetIdentitySha256: mongoTarget.targetIdentitySha256,
    artifactPath: "/private/full-backup.ejson",
    manifestPath: "/private/full-backup.manifest.json",
    fenceTokenSha256,
    sourceFlowSha256,
    database: "games",
    collection: "lk_games",
    documentCount: 1,
    startedAt: nowIso,
    completedAt: nowIso,
  },
  restoreRehearsal: {
    state: "PASS",
    backupSha256: "1".repeat(64),
    manifestSha256: "2".repeat(64),
    receiptSha256: "4".repeat(64),
    restoredArtifactSha256: "5".repeat(64),
    restoredArtifactPath: "/private/full-backup.restored.ejson",
    fullCollectionStateSha256: "3".repeat(64),
    mongoTargetIdentitySha256: mongoTarget.targetIdentitySha256,
    isolatedTargetIdentitySha256: "6".repeat(64),
    receiptPath: "/private/restore-rehearsal.json",
    isolatedTarget: true,
    restoredDocumentCount: 1,
    postRestoreHashMatch: true,
    rehearsedAt: nowIso,
  },
  coverage: {
    state: "PASS",
    planSha256s: [],
    completeReachableScope: true,
    unresolvedSkippedCount: 0,
    resolvedSkippedCount: 0,
    quarantinedSkippedCount: 0,
    activeReachableLegacyBeforeApply: 1,
    observedAt: nowIso,
  },
  mongoTarget: {
    state: "PASS",
    connectionFingerprint: mongoConnectionFingerprint,
    migrationConnectionFingerprint,
    targetIdentitySha256: mongoTarget.targetIdentitySha256,
    replicaSetName: mongoTarget.replicaSetName,
    topology: "REPLICA_SET",
    database: "games",
    collection: "lk_games",
    verifiedAt: nowIso,
  },
  postcheckContract: {
    state: "PREPARED",
    activeReachableLegacyExpected: 0,
    duplicateIdentityExpected: 0,
    providerConfirmedTenantBoundMinimum: 1,
    workerInitialMode: "SHADOW",
    shadowWritesExpected: 0,
    keepFenceOnFailure: true,
  },
  ...overrides,
});

test("migration executor decodes canonical EJSON ObjectId and rejects upsert or duplicate identity", () => {
  const plan = executablePlan();
  const bytes = Buffer.from(`${JSON.stringify(plan, null, 2)}\n`);
  const planSha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const checked = validateExecutableTenantMigrationPlan(plan, {
    expectedPlanSha256: planSha256,
    planBytes: bytes,
    expectedSourceFlowSha256: sourceFlowSha256,
    expectedTenantKey: tenantKey,
  });
  assert.equal(checked.operations.length, 1);
  assert.ok(decodeTenantMigrationOperation(plan.operations[0]).filter._id instanceof ObjectId);
  const withUpsert = structuredClone(plan);
  withUpsert.operations[0].options.upsert = true;
  assert.throws(() => validateExecutableTenantMigrationPlan(withUpsert), /disable upsert/);
  const duplicate = structuredClone(plan);
  duplicate.operations.push(structuredClone(duplicate.operations[0]));
  duplicate.eligibleCount = 2;
  duplicate.scannedCount = 2;
  assert.throws(() => validateExecutableTenantMigrationPlan(duplicate), /duplicate operation identity/);
  const oversized = structuredClone(plan);
  oversized.operations = Array.from({ length: MAX_TRANSACTION_OPERATIONS + 1 }, () => structuredClone(plan.operations[0]));
  oversized.eligibleCount = oversized.operations.length;
  oversized.scannedCount = oversized.operations.length;
  assert.throws(() => validateExecutableTenantMigrationPlan(oversized), /counts are invalid/);
});

test("Mongo write barrier proves application denial and migration-only bypass", async () => {
  let state = { validator: {}, validationLevel: "strict", validationAction: "error" };
  const session = () => ({
    startTransaction() {},
    async abortTransaction() {},
    async endSession() {},
  });
  const migrationDb = {
    async command(command) {
      if (command.hello) return { setName: "rs-fixture" };
      if (command.collMod === "lk_games") {
        state = { validator: command.validator, validationLevel: command.validationLevel, validationAction: command.validationAction };
        return { ok: 1 };
      }
      throw new Error("unexpected command");
    },
    listCollections: () => ({ toArray: async () => [{ name: "lk_games", options: state }] }),
    collection: () => ({
      findOne: async () => ({ _id: new ObjectId("111111111111111111111111") }),
      updateOne: async () => ({ acknowledged: true, matchedCount: 1 }),
    }),
  };
  const applicationDb = {
    collection: () => ({
      updateOne: async () => { const error = new Error("Document failed validation"); error.code = 121; throw error; },
    }),
  };
  const migrationClient = {
    db: (name) => (name === "admin" ? { command: async () => ({ setName: "rs-fixture" }) } : migrationDb),
    startSession: session,
  };
  const applicationClient = {
    db: (name) => (name === "admin" ? { command: async () => ({ setName: "rs-fixture" }) } : applicationDb),
    startSession: session,
  };
  const receipt = await installMongoWriteBarrier({
    migrationClient,
    applicationClient,
    applicationConnectionFingerprint: mongoConnectionFingerprint,
    migrationConnectionFingerprint,
    replicaSetName: "rs-fixture",
    fenceTokenSha256,
    cutoverPlanSha256: "6".repeat(64),
    installedAt: nowIso,
  });
  assert.equal(receipt.applicationWriteProbeRejected, true);
  assert.equal(receipt.migrationBypassProbeAborted, true);
  await assertMongoWriteBarrier(migrationDb, receipt, {
    fenceTokenSha256,
    cutoverPlanSha256: "6".repeat(64),
    mongoTargetIdentitySha256: mongoTarget.targetIdentitySha256,
  });
});

test("migration apply and restore require exact CAS readback and preserve the full BSON preimage", async () => {
  const plan = executablePlan();
  const planSha256 = "2".repeat(64);
  const collection = new FakeCollection(legacyGame());
  const beforeHash = hashCanonicalEjson(collection.document);
  const backup = await captureTenantMigrationPreimages(collection, plan, planSha256, nowIso);
  const receipt = await applyTenantMigrationPlan(collection, plan, planSha256, nowIso);
  assert.equal(receipt.modifiedCount, 1);
  assert.equal(receipt.upsertedCount, 0);
  assert.equal(collection.document.tenantKey, tenantKey);
  assert.equal(collection.document.revision.valueOf(), 1);
  const restore = await restoreTenantMigrationBackup(collection, plan, planSha256, backup, receipt);
  assert.equal(restore.restoredCount, 1);
  assert.equal(hashCanonicalEjson(collection.document), beforeHash);
});

test("restore fails closed after any post-apply drift", async () => {
  const plan = executablePlan();
  const planSha256 = "3".repeat(64);
  const collection = new FakeCollection(legacyGame());
  const backup = await captureTenantMigrationPreimages(collection, plan, planSha256, nowIso);
  const receipt = await applyTenantMigrationPlan(collection, plan, planSha256, nowIso);
  collection.document.status = "CONFIRMED";
  await assert.rejects(
    restoreTenantMigrationBackup(collection, plan, planSha256, backup, receipt),
    /post-apply drift/,
  );
});

test("read-only reconciliation distinguishes aborted, committed, and drifted transaction outcomes", async () => {
  const plan = executablePlan();
  const planSha256 = "3".repeat(64);
  const collection = new FakeCollection(legacyGame());
  const backup = await captureTenantMigrationPreimages(collection, plan, planSha256, nowIso);
  const aborted = await reconcileTenantMigrationOutcome(collection, plan, planSha256, backup);
  assert.equal(aborted.outcome, "ABORTED_NO_MUTATION");
  await applyTenantMigrationPlan(collection, plan, planSha256, nowIso);
  const committed = await reconcileTenantMigrationOutcome(collection, plan, planSha256, backup);
  assert.equal(committed.outcome, "APPLIED_RECOVERED");
  assert.equal(committed.applyReceipt.operations.length, 1);
  collection.document.status = "CONFIRMED";
  const drifted = await reconcileTenantMigrationOutcome(collection, plan, planSha256, backup);
  assert.equal(drifted.outcome, "BLOCKED_MIXED_OR_DRIFT");
});

test("read-only restore reconciliation distinguishes postimage, recovered restore, and drift", async () => {
  const plan = executablePlan();
  const planSha256 = "4".repeat(64);
  const collection = new FakeCollection(legacyGame());
  const backup = await captureTenantMigrationPreimages(collection, plan, planSha256, nowIso);
  const receipt = await applyTenantMigrationPlan(collection, plan, planSha256, nowIso);
  const notRestored = await reconcileTenantRestoreOutcome(collection, plan, planSha256, backup, receipt, nowIso);
  assert.equal(notRestored.outcome, "RESTORE_ABORTED_POSTIMAGE");
  await restoreTenantMigrationBackup(collection, plan, planSha256, backup, receipt);
  const restored = await reconcileTenantRestoreOutcome(collection, plan, planSha256, backup, receipt, nowIso);
  assert.equal(restored.outcome, "RESTORED_RECOVERED");
  assert.equal(restored.restoreReceipt.recoveredFromUnknownOutcome, true);
  collection.document.status = "CONFIRMED";
  const drifted = await reconcileTenantRestoreOutcome(collection, plan, planSha256, backup, receipt, nowIso);
  assert.equal(drifted.outcome, "BLOCKED_MIXED_OR_DRIFT");
});

test("writer inventory fails closed for dynamic collections and classifies aggregate as a writer", () => {
  const flow = [
    { id: "tab", type: "tab", label: "LK Games" },
    { id: "aggregate", type: "mongodb4", z: "tab", collection: "lk_games", operation: "aggregate", clientNode: "mongo" },
  ];
  assert.deepEqual(inventoryLkGamesWriters(flow).map(({ nodeId, operation }) => ({ nodeId, operation })), [
    { nodeId: "aggregate", operation: "aggregate" },
  ]);
  assert.throws(() => inventoryLkGamesWriters([
    ...flow,
    { id: "dynamic", type: "mongodb4", z: "tab", collection: "msg.collection", operation: "find", clientNode: "mongo" },
  ]), /unclassifiable dynamic Mongo collection/);
});

test("execution rejects stale migration plans", () => {
  const plan = executablePlan();
  assert.throws(() => validateExecutableTenantMigrationPlan(plan, {
    nowMs: Date.parse(nowIso) + 31 * 60_000,
  }), /stale/);
});

test("cutover plan binds all source and candidate Mongo writers and keeps live authority false", () => {
  const plan = executablePlan();
  const planBytes = Buffer.from(`${JSON.stringify(plan, null, 2)}\n`);
  const planSha256 = crypto.createHash("sha256").update(planBytes).digest("hex");
  const completeControls = controls();
  completeControls.coverage.planSha256s = [planSha256];
  const result = buildVivaGameProjectionCutoverPlan({
    repository: { commit: repositoryCommit, branch: "codex/viva-cutover" },
    sourceFlowSha256,
    candidateSha256,
    tenantKey,
    sourceWriters: sourceWriterInventory,
    candidateWriters: candidateWriterInventory,
    plans: [{ planSha256, plan }],
    controls: completeControls,
    controlsSha256: "6".repeat(64),
    reviewedFlowContractSha256: "7".repeat(64),
    generatedAt: nowIso,
  });
  assert.equal(result.state, "READY_FOR_SEPARATE_LIVE_APPROVAL");
  assert.deepEqual(result.writerFence.exactWriterNodeIds, ["candidate-writer", "source-writer"]);
  assert.equal(result.liveMutationAuthorized, false);
  assert.equal(result.databaseMutationPerformed, false);
  assert.equal(result.deploymentPerformed, false);
  assert.equal(result.rollback.restoreExactBackupBeforeOldFlow, true);
  const fixtureApplyReceipt = { fixture: true };
  const fixtureApplyReport = Buffer.from(canonicalJson({
    mode: "APPLY", outcome: "SUCCEEDED", planSha256, applyReceipt: fixtureApplyReceipt,
  }));
  const fixtureQueries = {
    activeReachableLegacySha256: Buffer.from(canonicalJson({ kind: "viva-game-projection-active-legacy-query", count: 0 })),
    duplicateIdentitySha256: Buffer.from(canonicalJson({ kind: "viva-game-projection-duplicate-identity-query", count: 0 })),
    providerTenantBoundSha256: Buffer.from(canonicalJson({ kind: "viva-game-projection-provider-tenant-bound-query", exactPostimageCount: 1 })),
    workerModeSha256: Buffer.from(canonicalJson({ kind: "viva-game-projection-worker-mode-query", mode: "SHADOW", writeCount: 0 })),
  };
  const fixtureBarrierBytes = Buffer.from(canonicalJson({ fixture: "barrier" }));
  const fixtureExecutionBytes = Buffer.from(canonicalJson({ fixture: "execution" }));
  const fixtureGuardianBytes = Buffer.from(canonicalJson({ fixture: "guardian" }));
  const postcheckEvidence = {
    applyReportBytesByPlan: { [planSha256]: fixtureApplyReport },
    queryEvidenceBytes: fixtureQueries,
    mongoWriteBarrierReceiptBytes: fixtureBarrierBytes,
    executionIndexBytes: fixtureExecutionBytes,
    fenceGuardianReceiptBytes: fixtureGuardianBytes,
  };
  const postcheck = {
    formatVersion: 1,
    kind: "viva-game-projection-tenant-cutover-postcheck",
    state: "PASS",
    sourceFlowSha256,
    candidateSha256,
    tenantKeySha256: cutoverSha256(tenantKey),
    appliedPlanSha256s: [planSha256],
    writerFenceState: "HELD",
    activeReachableLegacyCount: 0,
    duplicateIdentityCount: 0,
    providerConfirmedTenantBoundCount: 1,
    workerMode: "SHADOW",
    workerWriteCount: 0,
    runtimeTenantReadback: true,
    candidateFlowReadback: true,
    fenceTokenSha256,
    fenceReceiptSha256: "9".repeat(64),
    mongoWriteBarrierReceiptSha256: cutoverSha256(fixtureBarrierBytes),
    executionIndexSha256: cutoverSha256(fixtureExecutionBytes),
    coordinatorAttemptId: "11111111-1111-4111-8111-111111111111",
    fenceGuardianReceiptSha256: cutoverSha256(fixtureGuardianBytes),
    fenceExpiresAt: "2026-09-04T12:10:00.000Z",
    mongoTargetIdentitySha256: mongoTarget.targetIdentitySha256,
    observedAt: nowIso,
    applyReports: [{
      planSha256,
      reportSha256: cutoverSha256(fixtureApplyReport),
      applyReceiptSha256: cutoverSha256(canonicalJson(fixtureApplyReceipt)),
    }],
    queryEvidence: Object.fromEntries(Object.entries(fixtureQueries).map(([key, bytes]) => [key, cutoverSha256(bytes)])),
    ingressReopened: false,
  };
  assert.equal(validateVivaGameProjectionCutoverPostcheck(postcheck, result, Date.parse(nowIso), postcheckEvidence), true);
  assert.throws(
    () => validateVivaGameProjectionCutoverPostcheck({ ...postcheck, duplicateIdentityCount: 1 }, result, Date.parse(nowIso), postcheckEvidence),
    /does not authorize reopening ingress/,
  );
  assert.throws(
    () => validateVivaGameProjectionCutoverPostcheck(postcheck, result, Date.parse(nowIso), {
      ...postcheckEvidence, applyReportBytesByPlan: {},
    }),
    /lacks the exact apply-report artifact/,
  );
});

test("cutover plan reports missing CI, tenant, fence, backup, restore and coverage as blockers", () => {
  const plan = executablePlan();
  const planSha256 = "4".repeat(64);
  const incomplete = controls({
    ci: { state: "MISSING" },
    runtimeTenant: { state: "MISSING" },
    writerFence: { state: "NOT_ACQUIRED" },
    backup: { state: "NOT_RUN" },
    restoreRehearsal: { state: "NOT_RUN" },
    coverage: { state: "INCOMPLETE" },
    mongoTarget: { state: "MISSING" },
  });
  const result = buildVivaGameProjectionCutoverPlan({
    repository: { commit: repositoryCommit, branch: "codex/viva-cutover" },
    sourceFlowSha256,
    candidateSha256,
    tenantKey,
    sourceWriters: sourceWriterInventory,
    candidateWriters: candidateWriterInventory,
    plans: [{ planSha256, plan }],
    controls: incomplete,
    controlsSha256: "6".repeat(64),
    reviewedFlowContractSha256: "7".repeat(64),
    generatedAt: nowIso,
  });
  assert.equal(result.state, "BLOCKED");
  assert.deepEqual(result.blockers, [
    "EXACT_HEAD_CI_NOT_PROVEN",
    "RUNTIME_TENANT_NOT_DURABLY_PROVISIONED",
    "COMPLETE_LK_GAMES_WRITER_FENCE_NOT_HELD",
    "CURRENT_LK_GAMES_BACKUP_NOT_PROVEN",
    "BACKUP_RESTORE_REHEARSAL_NOT_PROVEN",
    "COMPLETE_LEGACY_SCOPE_AND_SKIP_DISPOSITION_NOT_PROVEN",
    "EXACT_MONGO_TARGET_NOT_PROVEN",
  ]);
});

test("claimed PASS controls reject future runtime, backup, restore, coverage, and Mongo evidence", () => {
  const migrationPlan = executablePlan();
  const planSha256 = "5".repeat(64);
  const futureIso = "2026-09-04T12:02:00.000Z";
  for (const mutate of [
    (value) => { value.runtimeTenant.readBackAt = futureIso; },
    (value) => { value.backup.completedAt = futureIso; },
    (value) => { value.restoreRehearsal.rehearsedAt = futureIso; },
    (value) => { value.coverage.observedAt = futureIso; },
    (value) => { value.mongoTarget.verifiedAt = futureIso; },
  ]) {
    const evidence = controls();
    evidence.coverage.planSha256s = [planSha256];
    mutate(evidence);
    assert.throws(() => buildVivaGameProjectionCutoverPlan({
      repository: { commit: repositoryCommit, branch: "codex/viva-cutover" },
      sourceFlowSha256,
      candidateSha256,
      tenantKey,
      sourceWriters: sourceWriterInventory,
      candidateWriters: candidateWriterInventory,
      plans: [{ planSha256, plan: migrationPlan }],
      controls: evidence,
      controlsSha256: "6".repeat(64),
      reviewedFlowContractSha256: "7".repeat(64),
      generatedAt: nowIso,
    }), /internally inconsistent/);
  }
});

test("claimed PASS controls fail closed when evidence is incomplete", () => {
  const plan = executablePlan();
  assert.throws(() => buildVivaGameProjectionCutoverPlan({
    repository: { commit: repositoryCommit, branch: "codex/viva-cutover" },
    sourceFlowSha256,
    candidateSha256,
    tenantKey,
    sourceWriters: sourceWriterInventory,
    candidateWriters: candidateWriterInventory,
    plans: [{ planSha256: "5".repeat(64), plan }],
    controls: controls({ writerFence: { state: "HELD", writerNodeIds: [] } }),
    controlsSha256: "6".repeat(64),
    reviewedFlowContractSha256: "7".repeat(64),
    generatedAt: nowIso,
  }), /does not cover the exact writer inventory/);
});

test("writer fence receipt requires a fresh stopped runtime and complete quiescence", () => {
  const nowMs = Date.parse(nowIso);
  const receipt = {
    formatVersion: 1,
    kind: "viva-game-projection-writer-fence-receipt",
    state: "HELD",
    host: "lk-primary-147",
    hostname: "padlhub-lk-primary",
    processName: "node-red",
    pm2ProcessId: 0,
    fenceToken,
    writerInventorySha256,
    lockPath: "/run/lock/padlhub-viva-game-projection-cutover.lock",
    sourceFlowSha256,
    candidateSha256,
    tenantKey,
    operationIds: [scope.operationId],
    nodeRedProcessState: "STOPPED",
    ingressWriteRoutesBlocked: true,
    internalSchedulersStopped: true,
    allLkGamesWritersQuiescent: true,
    externalMongoWritersBlocked: true,
    writerNodeIds: ["writer"],
    observedAt: nowIso,
    expiresAt: "2026-09-04T12:10:00.000Z",
  };
  const expected = {
    sourceFlowSha256,
    candidateSha256,
    tenantKey,
    expectedOperationIds: [scope.operationId],
    expectedWriterNodeIds: ["writer"],
    fenceTokenSha256,
    writerInventorySha256,
    lockPath: "/run/lock/padlhub-viva-game-projection-cutover.lock",
    nowMs,
  };
  assert.doesNotThrow(() => validateHeldWriterFence(receipt, expected));
  assert.throws(() => validateHeldWriterFence({ ...receipt, nodeRedProcessState: "ONLINE" }, expected), /complete held fence/);
  assert.throws(() => validateHeldWriterFence({ ...receipt, writerNodeIds: ["other"] }, expected), /cutover writer inventory/);
  assert.throws(() => validateHeldWriterFence({ ...receipt, expiresAt: "2026-09-04T11:59:00.000Z" }, expected), /stale, expired/);
});

test("cutover tools contain no remote-control or inline credential path", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const packetSource = fs.readFileSync(path.join(root, "prepare_viva_game_projection_cutover_packet.mjs"), "utf8");
  const executorSource = fs.readFileSync(path.join(root, "run_viva_game_projection_tenant_migration.mjs"), "utf8");
  const coordinatorSource = fs.readFileSync(path.join(root, "run_viva_game_projection_cutover_coordinator.mjs"), "utf8");
  const coordinatorShell = fs.readFileSync(path.join(root, "run_viva_game_projection_cutover.sh"), "utf8");
  const postcheckSource = fs.readFileSync(path.join(root, "prepare_viva_game_projection_cutover_postcheck.mjs"), "utf8");
  const guardianSource = fs.readFileSync(path.join(root, "run_viva_game_projection_fence_guardian.mjs"), "utf8");
  assert.doesNotMatch(packetSource, /\bssh\b|\bscp\b|\bcurl\b|pm2\s+(?:restart|stop|start)/);
  assert.doesNotMatch(executorSource, /process\.env\.MONGO_URI|mongodb(?:\+srv)?:\/\//);
  assert.doesNotMatch(coordinatorSource, /\bssh\b|\bscp\b|\bcurl\b/);
  assert.match(executorSource, /APPLY_VIVA_GAME_PROJECTION_TENANT_MIGRATION_V1/);
  assert.match(executorSource, /RESTORE_VIVA_GAME_PROJECTION_TENANT_MIGRATION_V1/);
  assert.match(coordinatorShell, /exec 9>"\$\{lock_path\}"[\s\S]+flock -n 9[\s\S]+exec node/);
  assert.match(coordinatorShell, /nohup node[\s\S]+run_viva_game_projection_fence_guardian\.mjs[\s\S]+9>&9/);
  assert.match(guardianSource, /HOLDING_UNTIL_EXPLICIT_RELEASE/);
  assert.match(guardianSource, /RELEASE_VIVA_GAME_PROJECTION_CUTOVER_FENCE_V1/);
  assert.ok(coordinatorSource.indexOf("installMongoWriteBarrier") < coordinatorSource.indexOf("await runMigration"));
  assert.ok(coordinatorSource.indexOf("hashLiveFullCollection") < coordinatorSource.indexOf("await runMigration"));
  assert.ok(coordinatorSource.indexOf("await runMigration") < coordinatorSource.indexOf("atomicWrite(liveFlowPath"));
  assert.ok(coordinatorSource.indexOf("atomicWrite(liveFlowPath") < coordinatorSource.indexOf("await prepareVivaGameProjectionCutoverPostcheck"));
  assert.match(postcheckSource, /countDocuments\(activeLegacyQuery\)/);
  assert.match(postcheckSource, /assertExclusiveFenceLease[\s\S]+finalNowMs[\s\S]+assertMongoWriteBarrier/);
  assert.match(postcheckSource, /writeFileExclusiveAtomicDurable/);
});

test("durable reports use append-only private journals outside Git worktrees", () => {
  const privateRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "viva-cutover-journal-")));
  fs.chmodSync(privateRoot, 0o700);
  try {
    const reportPath = path.join(privateRoot, "apply.json");
    const journal = createDurableReportJournal(reportPath, "apply", "fixture-attempt");
    journal.append("TRANSACTION_OUTCOME_UNKNOWN", { backupSha256: "a".repeat(64) });
    journal.finalize({ outcome: "UNKNOWN_RECONCILIATION_REQUIRED", mutationAttempted: true });
    assert.equal(fs.statSync(reportPath).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(`${reportPath}.journal`).sort(), [
      "0000-attempt-started.json",
      "0001-transaction-outcome-unknown.json",
      "0002-terminal-result.json",
    ]);
    const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    assert.throws(() => ensurePrivateDirectory(path.join(repositoryRoot, "tmp-cutover-output"), "Fixture"), /outside the repository/);
  } finally {
    fs.rmSync(privateRoot, { recursive: true, force: true });
  }
});

test("packet builder deterministically rebuilds the candidate and emits an evidence-backed postcheck gate", async () => {
  const privateRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "viva-cutover-packet-")));
  fs.chmodSync(privateRoot, 0o700);
  try {
    const liveCreateSource = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/viva_game_projection_sync/live_create_08c2.txt"),
      "utf8",
    );
    const source = [
      { id: "4b91e2a2413688db", type: "tab", label: "LK Games", disabled: false },
      { id: "4e820638cc39c730", type: "mongodb4-client", name: "mongo", dbName: "games", uri: "mongodb://127.0.0.1:27017" },
      {
        id: "8b64bb43086a39e1", type: "mongodb4", z: "4b91e2a2413688db", name: "Find lk game by id",
        clientNode: "4e820638cc39c730", mode: "collection", collection: "lk_games", operation: "find",
        output: "toArray", maxTimeMS: "0", handleDocId: false, wires: [["terminal"]],
      },
      {
        id: "source-writer", type: "mongodb4", z: "4b91e2a2413688db", name: "Existing writer",
        clientNode: "4e820638cc39c730", mode: "collection", collection: "lk_games", operation: "updateOne", wires: [["terminal"]],
      },
      { id: "route", type: "http in", z: "4b91e2a2413688db", method: "get", url: "/existing", wires: [["terminal"]] },
      {
        id: "e656cff36a8cd210", type: "function", z: "4b91e2a2413688db", name: "Prepare game upsert",
        func: liveCreateSource, outputs: 4, wires: [["terminal"], ["terminal"], ["terminal"], ["terminal"]],
      },
      { id: "terminal", type: "debug", z: "4b91e2a2413688db", wires: [] },
    ];
    const workspace = path.join(privateRoot, "workspace");
    const input = path.join(workspace, "input");
    fs.mkdirSync(input, { recursive: true, mode: 0o700 });
    fs.chmodSync(workspace, 0o700);
    fs.chmodSync(input, 0o700);
    const sourcePath = path.join(input, "source.flow.json");
    const sourceBytes = Buffer.from(`${JSON.stringify(source, null, 2)}\n`);
    write0600(sourcePath, sourceBytes);
    const actualSourceSha256 = cutoverSha256(sourceBytes);
    write0600(path.join(input, "source.flow.meta.json"), Buffer.from(`${JSON.stringify({
      formatVersion: 1,
      sourceKind: "live-147",
      sourceHost: "lk-primary-147",
      sourceUser: "root",
      sourcePort: "22",
      remoteFlowPath: "/root/.node-red/flows.json",
      localSourcePath: sourcePath,
      pulledAt: nowIso,
      sourceSha256: actualSourceSha256,
      nodeCount: source.length,
    }, null, 2)}\n`));

    const builtCandidate = buildVivaGameProjectionSyncCandidate(structuredClone(source), actualSourceSha256);
    const candidateDirectory = path.join(privateRoot, "candidate");
    fs.mkdirSync(candidateDirectory, { mode: 0o700 });
    const candidateBytes = Buffer.from(`${JSON.stringify(builtCandidate.candidate, null, 2)}\n`);
    const actualCandidateSha256 = cutoverSha256(candidateBytes);
    write0600(path.join(candidateDirectory, "candidate.flow.json"), candidateBytes);
    write0600(path.join(candidateDirectory, "report.json"), Buffer.from(`${JSON.stringify({
      ...builtCandidate.report,
      candidateSha256: actualCandidateSha256,
    }, null, 2)}\n`));

    const migrationPlan = executablePlan();
    migrationPlan.source.sourceFlowSha256 = actualSourceSha256;
    migrationPlan.source.expectedSourceFlowSha256 = actualSourceSha256;
    const migrationPlanPath = path.join(privateRoot, "migration-plan.json");
    const migrationPlanBytes = Buffer.from(`${JSON.stringify(migrationPlan, null, 2)}\n`);
    write0600(migrationPlanPath, migrationPlanBytes);
    const migrationPlanSha256 = cutoverSha256(migrationPlanBytes);
    const migrationIndexPath = path.join(privateRoot, "migration-index.json");
    write0600(migrationIndexPath, Buffer.from(`${JSON.stringify({
      formatVersion: 1,
      tenantKey,
      plans: [{ path: migrationPlanPath, sha256: migrationPlanSha256 }],
    }, null, 2)}\n`));

    const dynamicSourceWriters = inventoryLkGamesWriters(source);
    const dynamicCandidateWriters = inventoryLkGamesWriters(builtCandidate.candidate);
    const dynamicWriterInventorySha256 = cutoverSha256(canonicalJson({
      sourceWriters: dynamicSourceWriters,
      candidateWriters: dynamicCandidateWriters,
    }));
    const externalWriterProofPath = path.join(privateRoot, "external-writer-proof.json");
    const externalWriterProofBytes = Buffer.from(`${JSON.stringify({
      formatVersion: 1,
      kind: "viva-game-projection-external-writer-proof",
      writerInventorySha256: dynamicWriterInventorySha256,
      fenceTokenSha256,
      host: "lk-primary-147",
      hostname: "padlhub-lk-primary",
      canonicalLockPath: "/run/lock/padlhub-viva-game-projection-cutover.lock",
      allWritersUseCanonicalLock: true,
      unfencedWriterCount: 0,
      writerProcessCount: 1,
      writerProcesses: [{ pid: 4242, commandSha256: "a".repeat(64), canonicalLockObserved: true }],
      observedAt: nowIso,
    }, null, 2)}\n`);
    write0600(externalWriterProofPath, externalWriterProofBytes);
    const dynamicMongoTarget = buildMongoTargetIdentity({
      connectionFingerprint: cutoverSha256("mongodb://127.0.0.1:27017"),
      replicaSetName: "rs-fixture",
      database: "games",
      collection: "lk_games",
    });
    const fullBackupArtifactPath = path.join(privateRoot, "full-backup.ejson");
    const backupDocument = legacyGame();
    const fullBackupBytes = Buffer.from(`${BSON.EJSON.stringify([backupDocument], null, 2, { relaxed: false })}\n`);
    write0600(fullBackupArtifactPath, fullBackupBytes);
    const fullBackupSha256 = cutoverSha256(fullBackupBytes);
    const fullCollectionStateSha256 = cutoverSha256(canonicalJson([{
      mongoId: backupDocument._id.toHexString(),
      documentSha256: hashCanonicalEjson(backupDocument),
    }]));
    const backupManifestPath = path.join(privateRoot, "full-backup.manifest.json");
    const backupManifestBytes = Buffer.from(`${JSON.stringify({
      formatVersion: 1,
      kind: "viva-game-projection-full-lk-games-backup-manifest",
      artifactPath: fullBackupArtifactPath,
      backupSha256: fullBackupSha256,
      fullCollectionStateSha256,
      mongoTargetIdentitySha256: dynamicMongoTarget.targetIdentitySha256,
      fenceTokenSha256,
      database: "games",
      collection: "lk_games",
      documentCount: 1,
      startedAt: nowIso,
      completedAt: nowIso,
    }, null, 2)}\n`);
    write0600(backupManifestPath, backupManifestBytes);
    const backupManifestSha256 = cutoverSha256(backupManifestBytes);
    const restoreReceiptPath = path.join(privateRoot, "restore-rehearsal.json");
    const restoredArtifactPath = path.join(privateRoot, "full-backup.restored.ejson");
    write0600(restoredArtifactPath, fullBackupBytes);
    const restoredArtifactSha256 = cutoverSha256(fullBackupBytes);
    const restoreReceiptBytes = Buffer.from(`${JSON.stringify({
      formatVersion: 1,
      kind: "viva-game-projection-full-backup-restore-rehearsal",
      backupSha256: fullBackupSha256,
      manifestSha256: backupManifestSha256,
      fullCollectionStateSha256,
      mongoTargetIdentitySha256: dynamicMongoTarget.targetIdentitySha256,
      isolatedTargetIdentitySha256: "6".repeat(64),
      restoredArtifactPath,
      restoredArtifactSha256,
      restoredDocumentCount: 1,
      isolatedTarget: true,
      postRestoreHashMatch: true,
      rehearsedAt: nowIso,
    }, null, 2)}\n`);
    write0600(restoreReceiptPath, restoreReceiptBytes);
    const dynamicControls = controls();
    dynamicControls.writerFence.sourceFlowSha256 = actualSourceSha256;
    dynamicControls.writerFence.candidateSha256 = actualCandidateSha256;
    dynamicControls.writerFence.writerNodeIds = dynamicCandidateWriters.map(({ nodeId }) => nodeId);
    dynamicControls.writerFence.writerInventorySha256 = dynamicWriterInventorySha256;
    dynamicControls.writerFence.externalWriterProofPath = externalWriterProofPath;
    dynamicControls.writerFence.externalWriterProofSha256 = cutoverSha256(externalWriterProofBytes);
    dynamicControls.backup.sourceFlowSha256 = actualSourceSha256;
    dynamicControls.backup.artifactPath = fullBackupArtifactPath;
    dynamicControls.backup.backupSha256 = fullBackupSha256;
    dynamicControls.backup.fullCollectionStateSha256 = fullCollectionStateSha256;
    dynamicControls.backup.mongoTargetIdentitySha256 = dynamicMongoTarget.targetIdentitySha256;
    dynamicControls.backup.manifestPath = backupManifestPath;
    dynamicControls.backup.manifestSha256 = backupManifestSha256;
    dynamicControls.restoreRehearsal.manifestSha256 = backupManifestSha256;
    dynamicControls.restoreRehearsal.backupSha256 = fullBackupSha256;
    dynamicControls.restoreRehearsal.fullCollectionStateSha256 = fullCollectionStateSha256;
    dynamicControls.restoreRehearsal.mongoTargetIdentitySha256 = dynamicMongoTarget.targetIdentitySha256;
    dynamicControls.restoreRehearsal.isolatedTargetIdentitySha256 = "6".repeat(64);
    dynamicControls.restoreRehearsal.restoredArtifactPath = restoredArtifactPath;
    dynamicControls.restoreRehearsal.restoredArtifactSha256 = restoredArtifactSha256;
    dynamicControls.restoreRehearsal.receiptPath = restoreReceiptPath;
    dynamicControls.restoreRehearsal.receiptSha256 = cutoverSha256(restoreReceiptBytes);
    dynamicControls.coverage.planSha256s = [migrationPlanSha256];
    dynamicControls.mongoTarget = {
      ...dynamicControls.mongoTarget,
      connectionFingerprint: dynamicMongoTarget.connectionFingerprint,
      migrationConnectionFingerprint,
      targetIdentitySha256: dynamicMongoTarget.targetIdentitySha256,
      replicaSetName: dynamicMongoTarget.replicaSetName,
    };
    const controlsPath = path.join(privateRoot, "controls.json");
    write0600(controlsPath, Buffer.from(`${JSON.stringify(dynamicControls, null, 2)}\n`));

    const outputDirectory = path.join(privateRoot, "packet");
    const result = prepareVivaGameProjectionCutoverPacket({
      workspace,
      candidateDirectory,
      migrationIndexFile: migrationIndexPath,
      controlsFile: controlsPath,
      outputDirectory,
      tenantKey,
      repository: { commit: repositoryCommit, branch: "codex/viva-cutover" },
      nowMs: Date.parse(nowIso),
    });
    assert.equal(result.plan.state, "READY_FOR_SEPARATE_LIVE_APPROVAL");
    assert.equal(result.plan.candidateSha256, actualCandidateSha256);
    assert.ok(result.manifest.files.some((entry) => entry.path === "evidence/full-backup.manifest.json"));

    const migratedCollection = new FakeCollection(legacyGame());
    const migrationBackup = await captureTenantMigrationPreimages(migratedCollection, migrationPlan, migrationPlanSha256, nowIso);
    const applyReceipt = await applyTenantMigrationPlan(migratedCollection, migrationPlan, migrationPlanSha256, nowIso);
    assert.equal(migrationBackup.recordCount, 1);
    const applyReportPath = path.join(privateRoot, "apply-report.json");
    const applyReportBytes = Buffer.from(`${JSON.stringify({
      formatVersion: 1,
      mode: "APPLY",
      outcome: "SUCCEEDED",
      planSha256: migrationPlanSha256,
      sourceFlowSha256: actualSourceSha256,
      mongoTargetIdentitySha256: dynamicMongoTarget.targetIdentitySha256,
      applyReceipt,
    }, null, 2)}\n`);
    write0600(applyReportPath, applyReportBytes);
    const copiedPlanEntry = result.manifest.files.find((entry) => entry.path.startsWith("migration-plans/"));
    const cutoverEntry = result.manifest.files.find((entry) => entry.path === "cutover-plan.json");
    const packetManifestPath = path.join(outputDirectory, "packet.manifest.json");
    const cutoverPlanPath = path.join(outputDirectory, "cutover-plan.json");
    const applyIndexPath = path.join(privateRoot, "apply-index.json");
    const applyIndexBytes = Buffer.from(`${JSON.stringify({
      formatVersion: 1,
      kind: "viva-game-projection-cutover-apply-index",
      cutoverPlanSha256: cutoverEntry.sha256,
      tenantKey,
      items: [{
        planPath: path.join(outputDirectory, copiedPlanEntry.path),
        planSha256: migrationPlanSha256,
        reportPath: applyReportPath,
        reportSha256: cutoverSha256(applyReportBytes),
      }],
    }, null, 2)}\n`);
    write0600(applyIndexPath, applyIndexBytes);
    const fenceReceiptPath = path.join(privateRoot, "fence-receipt.json");
    const fenceReceiptBytes = Buffer.from(`${JSON.stringify({
      formatVersion: 1,
      kind: "viva-game-projection-writer-fence-receipt",
      state: "HELD",
      host: "lk-primary-147",
      hostname: "padlhub-lk-primary",
      processName: "node-red",
      pm2ProcessId: 0,
      fenceToken,
      writerInventorySha256: dynamicWriterInventorySha256,
      externalWriterProofSha256: cutoverSha256(externalWriterProofBytes),
      lockPath: "/run/lock/padlhub-viva-game-projection-cutover.lock",
      sourceFlowSha256: actualSourceSha256,
      candidateSha256: actualCandidateSha256,
      tenantKey,
      operationIds: [migrationPlan.scope.operationId],
      nodeRedProcessState: "STOPPED",
      ingressWriteRoutesBlocked: true,
      internalSchedulersStopped: true,
      allLkGamesWritersQuiescent: true,
      externalMongoWritersBlocked: true,
      writerNodeIds: result.plan.writerFence.exactWriterNodeIds,
      observedAt: nowIso,
      expiresAt: "2026-09-04T12:10:00.000Z",
    }, null, 2)}\n`);
    write0600(fenceReceiptPath, fenceReceiptBytes);
    const barrierReceiptPath = path.join(privateRoot, "mongo-write-barrier.json");
    const barrierReceiptBytes = Buffer.from(canonicalJson({
      formatVersion: 1,
      kind: "viva-game-projection-mongo-write-barrier-receipt",
      state: "HELD",
      fixture: true,
    }));
    write0600(barrierReceiptPath, barrierReceiptBytes);
    const executionIndexPath = path.join(privateRoot, "execution-index.json");
    const executionIndexBytes = Buffer.from(canonicalJson({ formatVersion: 1, kind: "fixture-execution-index" }));
    write0600(executionIndexPath, executionIndexBytes);
    const guardianReceiptPath = path.join(privateRoot, "guardian-receipt.json");
    const guardianReceiptBytes = Buffer.from(canonicalJson({
      formatVersion: 1,
      kind: "viva-game-projection-fence-guardian-receipt",
      state: "HOLDING_UNTIL_EXPLICIT_RELEASE",
      pid: 4242,
      lockPath: "/run/lock/padlhub-viva-game-projection-cutover.lock",
      fenceTokenSha256,
      startedAt: nowIso,
      automaticRelease: false,
    }));
    write0600(guardianReceiptPath, guardianReceiptBytes);
    const postcheckCollection = {
      findOne: (filter) => migratedCollection.findOne(filter),
      countDocuments: async (query) => (Object.hasOwn(query, "audit.events") ? 0 : 0),
      find: () => ({ toArray: async () => [cloneBson(migratedCollection.document)] }),
    };
    const postcheck = await prepareVivaGameProjectionCutoverPostcheck({
      cutoverPlan: cutoverPlanPath,
      packetManifest: packetManifestPath,
      expectedCutoverPlanSha256: cutoverEntry.sha256,
      expectedPacketManifestSha256: cutoverSha256(fs.readFileSync(packetManifestPath)),
      applyIndex: applyIndexPath,
      expectedApplyIndexSha256: cutoverSha256(applyIndexBytes),
      runtimeFlow: path.join(outputDirectory, "candidate.flow.json"),
      fenceReceipt: fenceReceiptPath,
      expectedFenceReceiptSha256: cutoverSha256(fenceReceiptBytes),
      mongoWriteBarrierReceipt: barrierReceiptPath,
      expectedMongoWriteBarrierReceiptSha256: cutoverSha256(barrierReceiptBytes),
      migrationConnectionFile: path.join(privateRoot, "unused-migration-connection.json"),
      executionIndex: executionIndexPath,
      expectedExecutionIndexSha256: cutoverSha256(executionIndexBytes),
      coordinatorAttemptId: "11111111-1111-4111-8111-111111111111",
      fenceGuardianReceiptSha256: cutoverSha256(guardianReceiptBytes),
      fenceGuardianReceipt: guardianReceiptPath,
      outputDirectory: path.join(privateRoot, "postcheck"),
    }, {
      nowMs: Date.parse(nowIso),
      allowFixtureHostname: true,
      assertFenceLease: () => true,
      assertMongoWriteBarrier: async () => true,
      assertNoConcurrentWrites: async () => true,
      readPm2: async () => [{
        name: "node-red",
        pm_id: 0,
        pm2_env: {
          status: "online",
          pm_uptime: Date.parse(nowIso),
          PADLHUB_PLATFORM_TENANT_KEY: tenantKey,
          VIVA_GAME_PROJECTION_SYNC_MODE: "SHADOW",
        },
      }],
      mongoContext: { collection: postcheckCollection, hello: { setName: "rs-fixture" } },
    });
    assert.equal(postcheck.receipt.state, "PASS");
    assert.equal(postcheck.receipt.ingressReopened, false);
    assert.equal(fs.existsSync(postcheck.readyMarkerPath), true);

    const tamperedDirectory = path.join(privateRoot, "tampered-candidate");
    fs.cpSync(candidateDirectory, tamperedDirectory, { recursive: true });
    fs.chmodSync(tamperedDirectory, 0o700);
    const tamperedPath = path.join(tamperedDirectory, "candidate.flow.json");
    const tampered = JSON.parse(fs.readFileSync(tamperedPath, "utf8"));
    tampered.push({ id: "unreviewed", type: "function", func: "return msg;", wires: [] });
    fs.writeFileSync(tamperedPath, `${JSON.stringify(tampered, null, 2)}\n`, { mode: 0o600 });
    assert.throws(() => prepareVivaGameProjectionCutoverPacket({
      workspace,
      candidateDirectory: tamperedDirectory,
      migrationIndexFile: migrationIndexPath,
      controlsFile: controlsPath,
      outputDirectory: path.join(privateRoot, "tampered-packet"),
      tenantKey,
      repository: { commit: repositoryCommit, branch: "codex/viva-cutover" },
      nowMs: Date.parse(nowIso),
    }), /does not match the reviewed cutover contract/);
  } finally {
    fs.rmSync(privateRoot, { recursive: true, force: true });
  }
});
