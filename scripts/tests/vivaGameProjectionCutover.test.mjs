import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { BSON, ObjectId } from "mongodb";

import {
  assertMongoWriteBarrier,
  installMongoWriteBarrier,
  restorePreviousMongoWriteBarrier,
} from "../lib/vivaGameProjectionMongoWriteBarrier.mjs";
import {
  isAuthorizedFenceGuardianRecovery,
  isAuthorizedFenceGuardianReadyFinalization,
  isAuthorizedFenceGuardianRelease,
  isAuthorizedRecoveryFenceTakeoverRelease,
} from "../lib/vivaGameProjectionFenceGuardian.mjs";
import {
  validateCopiedControlEvidence,
  validateExactCutoverPacket,
} from "../lib/vivaGameProjectionCutoverPacketValidation.mjs";
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
import {
  executeVivaGameProjectionCutover,
  reconstructSuccessfulCoordinatorReport,
} from "../run_viva_game_projection_cutover_coordinator.mjs";
import {
  finalizeVivaGameProjectionCutoverReady,
  requestReadyFinalizationFromGuardian,
} from "../finalize_viva_game_projection_cutover_ready.mjs";
import { buildVivaGameProjectionSyncCandidate } from "../prepare_viva_game_projection_sync_candidate.mjs";
import {
  openRecoveryJournal,
  recoverVivaGameProjectionMongoWriteBarrier,
  requestRecoveryFromGuardian,
  startRecoveryFenceTakeover,
} from "../recover_viva_game_projection_mongo_write_barrier.mjs";
import {
  assertNoConcurrentMongoWrites,
  createDurableReportJournal,
  ensurePrivateDirectory,
  mongoCurrentOpTouchesLkGames,
  recoverDurableTerminalReport,
  validateHeldWriterFence,
} from "../run_viva_game_projection_tenant_migration.mjs";
import { writeFileExclusiveAtomicDurable } from "../nodered_reviewed_flow_deploy/runtime_contract.mjs";

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

const fixtureExecutorSources = Array.from({ length: 8 }, (_, index) => ({
  path: `scripts/fixture-${index}.mjs`, sha256: String(index + 1).repeat(64),
}));
const cutoverPlanItem = (planSha256, plan) => ({
  planSha256,
  plan,
  sourceEvidence: {
    games: { sha256: plan.source.gamesSha256 },
    provider: { sha256: plan.source.providerSha256 },
    providerCaptureReceipt: { sha256: plan.source.providerCaptureReceiptSha256 },
  },
});

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
    pmExecPath: "/usr/local/bin/node-red",
    pmCwd: "/root/.node-red",
    pmArgsSha256: cutoverSha256(canonicalJson([])),
    pmNodeArgsSha256: cutoverSha256(canonicalJson([])),
    restartCount: 3,
    localHealthUrl: "http://127.0.0.1:1880/flows",
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
  let applicationRoles = [{ role: "readWrite", db: "games" }];
  let preparation = null;
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
    async command() { const error = new Error("not authorized"); error.code = 13; throw error; },
    collection: () => ({
      insertOne: async () => { const error = new Error("not authorized"); error.code = 13; throw error; },
      updateOne: async () => { const error = new Error("not authorized"); error.code = 13; throw error; },
      deleteOne: async () => { const error = new Error("not authorized"); error.code = 13; throw error; },
    }),
  };
  const migrationAdmin = {
    async command(command) {
      if (command.hello) return { setName: "rs-fixture" };
      if (command.connectionStatus) return {
        authInfo: {
          authenticatedUsers: [{ user: "migration", db: "admin" }],
          authenticatedUserRoles: [{ role: "root", db: "admin" }],
          authenticatedUserPrivileges: [{ resource: { anyResource: true }, actions: ["anyAction"] }],
        },
      };
      if (command.usersInfo) return { users: [{ user: "application", db: "admin", roles: applicationRoles }] };
      if (command.updateUser === "application") { applicationRoles = command.roles; return { ok: 1 }; }
      throw new Error("unexpected admin command");
    },
  };
  const applicationAdmin = {
    async command(command) {
      if (command.hello) return { setName: "rs-fixture" };
      if (command.connectionStatus) return {
        authInfo: {
          authenticatedUsers: [{ user: "application", db: "admin" }],
          authenticatedUserRoles: applicationRoles,
          authenticatedUserPrivileges: applicationRoles.length ? [{ resource: { db: "games", collection: "" }, actions: ["find", "insert", "update", "remove"] }] : [],
        },
      };
      const error = new Error("not authorized"); error.code = 13; throw error;
    },
  };
  const migrationClient = {
    db: (name) => (name === "admin" ? migrationAdmin : migrationDb),
    startSession: session,
  };
  const applicationClient = {
    db: (name) => (name === "admin" ? applicationAdmin : applicationDb),
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
    beforeInstall: async (value) => { preparation = value; },
  });
  assert.equal(preparation.state, "PREPARED_BEFORE_ACL_AND_COLLMOD");
  assert.equal(receipt.applicationDeleteProbeRejected, true);
  assert.equal(receipt.applicationCollModProbeRejected, true);
  assert.equal(receipt.migrationBypassProbeAborted, true);
  await assertMongoWriteBarrier(migrationClient, receipt, {
    fenceTokenSha256,
    cutoverPlanSha256: "6".repeat(64),
    mongoTargetIdentitySha256: mongoTarget.targetIdentitySha256,
  });
  const recoveryFencePhases = [];
  await restorePreviousMongoWriteBarrier(migrationClient, preparation, {
    fenceTokenSha256,
    cutoverPlanSha256: "6".repeat(64),
    mongoTargetIdentitySha256: mongoTarget.targetIdentitySha256,
    assertFence: async (phase) => { recoveryFencePhases.push(phase); },
  });
  assert.deepEqual(recoveryFencePhases, [
    "BEFORE_RECOVERY_STATE_READ",
    "BEFORE_VALIDATOR_RESTORE",
    "AFTER_VALIDATOR_RESTORE",
    "BEFORE_APPLICATION_ROLES_RESTORE",
    "AFTER_APPLICATION_ROLES_RESTORE",
    "AFTER_RECOVERY_READBACK",
  ]);
  assert.deepEqual(state, { validator: {}, validationLevel: "strict", validationAction: "error" });
  assert.deepEqual(applicationRoles, [{ role: "readWrite", db: "games" }]);
});

test("fence guardian rejects malformed or stale release requests without treating them as authorization", () => {
  const nowMs = Date.parse(nowIso);
  const exact = {
    formatVersion: 1,
    kind: "viva-game-projection-fence-release-request",
    state: "RELEASE_AUTHORIZED",
    confirmation: "RELEASE_VIVA_GAME_PROJECTION_CUTOVER_FENCE_V1",
    fenceTokenSha256,
    authorizedAt: nowIso,
  };
  assert.equal(isAuthorizedFenceGuardianRelease({ release: exact, validPrivateFile: true, fenceTokenSha256, nowMs }), true);
  assert.equal(isAuthorizedFenceGuardianRelease({ release: null, validPrivateFile: true, fenceTokenSha256, nowMs }), false);
  assert.equal(isAuthorizedFenceGuardianRelease({ release: exact, validPrivateFile: false, fenceTokenSha256, nowMs }), false);
  assert.equal(isAuthorizedFenceGuardianRelease({
    release: { ...exact, authorizedAt: new Date(nowMs - 5 * 60_000 - 1).toISOString() },
    validPrivateFile: true, fenceTokenSha256, nowMs,
  }), false);
  const recoveryRequestId = "12345678-1234-4234-8234-123456789abc";
  const recoveryReportPath = "/private/recovery-report.json";
  const takeoverReceiptPath = "/private/takeover.json";
  const takeoverReceiptSha256 = "7".repeat(64);
  const recoveryReport = {
    formatVersion: 1,
    kind: "viva-game-projection-mongo-write-barrier-recovery-receipt",
    state: "RELEASED_TO_EXACT_PREIMAGE",
    recoveryAttemptId: "87654321-4321-4321-8321-cba987654321",
    recoveryJournalPath: `${recoveryReportPath}.journal`,
    guardianRecoveryRequestId: recoveryRequestId,
    recoveryFenceTakeoverState: "HELD_UNTIL_EXPLICIT_FENCE_RELEASE",
    recoveryFenceTakeoverReceiptPath: takeoverReceiptPath,
    recoveryFenceTakeoverReceiptSha256: takeoverReceiptSha256,
  };
  const recoveryReportSha256 = cutoverSha256(Buffer.from(canonicalJson(recoveryReport)));
  const recoveryTerminalJournal = {
    formatVersion: 1,
    mode: "BARRIER_RECOVERY",
    phase: "TERMINAL_RESULT",
    attemptId: recoveryReport.recoveryAttemptId,
    reportSha256: recoveryReportSha256,
    report: recoveryReport,
  };
  const takeoverRelease = {
    ...exact,
    recoveryRequestId,
    recoveryReportPath,
    recoveryReportSha256,
    recoveryTerminalJournalSha256: "8".repeat(64),
    recoveryFenceTakeoverReceiptSha256: takeoverReceiptSha256,
  };
  const takeoverReleaseInput = {
    release: takeoverRelease,
    validPrivateFile: true,
    fenceTokenSha256,
    recoveryRequestId,
    recoveryReportPath,
    recoveryReport,
    recoveryReportSha256,
    recoveryTerminalJournal,
    recoveryTerminalJournalSha256: "8".repeat(64),
    recoveryFenceTakeoverReceiptPath: takeoverReceiptPath,
    recoveryFenceTakeoverReceiptSha256: takeoverReceiptSha256,
    nowMs,
  };
  assert.equal(isAuthorizedRecoveryFenceTakeoverRelease(takeoverReleaseInput), true);
  assert.equal(isAuthorizedRecoveryFenceTakeoverRelease({
    ...takeoverReleaseInput,
    release: exact,
  }), false);
  assert.equal(isAuthorizedRecoveryFenceTakeoverRelease({
    ...takeoverReleaseInput,
    recoveryReport: { ...recoveryReport, state: "RECOVERY_IN_FLIGHT" },
  }), false);
  const recoveryArgv = [
    "--barrier-artifact", "/private/barrier.json.prepared",
    "--expected-barrier-artifact-sha256", "1".repeat(64),
    "--cutover-plan", "/private/cutover.json",
    "--expected-cutover-plan-sha256", "2".repeat(64),
    "--migration-connection-file", "/private/migration.json",
    "--execution-index", "/private/execution.json",
    "--expected-execution-index-sha256", "3".repeat(64),
    "--fence-receipt", "/private/fence.json",
    "--expected-fence-receipt-sha256", "4".repeat(64),
    "--fence-guardian-receipt", "/private/guardian.json",
    "--expected-fence-guardian-receipt-sha256", "5".repeat(64),
    "--fence-guardian-recovery-request", "/private/recovery-request.json",
    "--report", "/private/recovery-report.json",
  ];
  const recoveryRequest = {
    formatVersion: 1,
    kind: "viva-game-projection-fence-recovery-request",
    state: "RECOVERY_AUTHORIZED",
    confirmation: "RECOVER_VIVA_GAME_PROJECTION_MONGO_WRITE_BARRIER_V1",
    requestId: "12345678-1234-4234-8234-123456789abc",
    guardianPid: 123,
    guardianProcessStartIdentity: "123:456",
    fenceTokenSha256,
    argv: recoveryArgv,
    authorizedAt: nowIso,
  };
  assert.equal(isAuthorizedFenceGuardianRecovery({
    request: recoveryRequest, validPrivateFile: true, fenceTokenSha256,
    guardianPid: 123, processStartIdentity: "123:456", nowMs,
  }), true);
  assert.equal(isAuthorizedFenceGuardianRecovery({
    request: { ...recoveryRequest, argv: [...recoveryArgv, "--report", "/tmp/other"] },
    validPrivateFile: true, fenceTokenSha256, guardianPid: 123, processStartIdentity: "123:456", nowMs,
  }), false);
  const readyRequest = {
    formatVersion: 1,
    kind: "viva-game-projection-fence-ready-finalization-request",
    state: "READY_FINALIZATION_AUTHORIZED",
    confirmation: "FINALIZE_VIVA_GAME_PROJECTION_READY_V1",
    requestId: "12345678-1234-4234-8234-123456789abc",
    guardianPid: 123,
    guardianProcessStartIdentity: "123:456",
    fenceTokenSha256,
    argv: [
      "--execution-index", "/private/execution.json",
      "--expected-execution-index-sha256", "1".repeat(64),
      "--coordinator-report", "/private/coordinator.json",
      "--expected-coordinator-report-sha256", "2".repeat(64),
    ],
    authorizedAt: nowIso,
  };
  assert.equal(isAuthorizedFenceGuardianReadyFinalization({
    request: readyRequest, validPrivateFile: true, fenceTokenSha256,
    guardianPid: 123, processStartIdentity: "123:456", nowMs,
  }), true);
  assert.equal(isAuthorizedFenceGuardianReadyFinalization({
    request: { ...readyRequest, guardianProcessStartIdentity: "123:457" },
    validPrivateFile: true, fenceTokenSha256, guardianPid: 123, processStartIdentity: "123:456", nowMs,
  }), false);
});

test("recovery request waits for the exact guardian child terminal result", async () => {
  const privateRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "viva-guardian-recovery-request-")));
  fs.chmodSync(privateRoot, 0o700);
  const previousConfirmation = process.env.VIVA_GAME_PROJECTION_MONGO_BARRIER_RECOVER;
  process.env.VIVA_GAME_PROJECTION_MONGO_BARRIER_RECOVER = "RECOVER_VIVA_GAME_PROJECTION_MONGO_WRITE_BARRIER_V1";
  try {
    const executorPath = fs.realpathSync(path.resolve(
      path.dirname(fileURLToPath(import.meta.url)), "../recover_viva_game_projection_mongo_write_barrier.mjs",
    ));
    const requestPath = path.join(privateRoot, "recovery-request.json");
    const reportPath = path.join(privateRoot, "recovery-report.json");
    const guardianPath = path.join(privateRoot, "guardian.json");
    const requestId = "12345678-1234-4234-8234-123456789abc";
    const attemptId = "87654321-4321-4321-8321-cba987654321";
    const expected = {
      expectedBarrierArtifactSha256: "1".repeat(64),
      expectedCutoverPlanSha256: "2".repeat(64),
      expectedExecutionIndexSha256: "3".repeat(64),
      expectedFenceReceiptSha256: "4".repeat(64),
    };
    const guardian = {
      formatVersion: 1,
      kind: "viva-game-projection-fence-guardian-receipt",
      state: "HOLDING_UNTIL_EXPLICIT_RELEASE",
      pid: 123,
      fd: 9,
      processStartIdentity: "123:456",
      fenceTokenSha256,
      lockPath: "/run/lock/padlhub-viva-game-projection-cutover.lock",
      lockDevice: "1",
      lockInode: "2",
      heartbeatPath: path.join(privateRoot, "guardian-heartbeat.json"),
      releaseRequestPath: path.join(privateRoot, "release-request.json"),
      recoveryRequestPath: requestPath,
      recoveryExecutorPath: executorPath,
      recoveryExecutorSha256: cutoverSha256(fs.readFileSync(executorPath)),
    };
    const guardianBytes = Buffer.from(canonicalJson(guardian));
    write0600(guardianPath, guardianBytes);
    const expectedGuardianSha256 = cutoverSha256(guardianBytes);
    const options = {
      ...expected,
      barrierArtifact: path.join(privateRoot, "barrier.json"),
      cutoverPlan: path.join(privateRoot, "cutover.json"),
      migrationConnectionFile: path.join(privateRoot, "migration.json"),
      executionIndex: path.join(privateRoot, "execution.json"),
      fenceReceipt: path.join(privateRoot, "fence.json"),
      fenceGuardianReceipt: guardianPath,
      expectedFenceGuardianReceiptSha256: expectedGuardianSha256,
      fenceGuardianRecoveryRequest: requestPath,
      report: reportPath,
    };
    const argv = Object.entries({
      "--barrier-artifact": options.barrierArtifact,
      "--expected-barrier-artifact-sha256": options.expectedBarrierArtifactSha256,
      "--cutover-plan": options.cutoverPlan,
      "--expected-cutover-plan-sha256": options.expectedCutoverPlanSha256,
      "--migration-connection-file": options.migrationConnectionFile,
      "--execution-index": options.executionIndex,
      "--expected-execution-index-sha256": options.expectedExecutionIndexSha256,
      "--fence-receipt": options.fenceReceipt,
      "--expected-fence-receipt-sha256": options.expectedFenceReceiptSha256,
      "--fence-guardian-receipt": options.fenceGuardianReceipt,
      "--expected-fence-guardian-receipt-sha256": options.expectedFenceGuardianReceiptSha256,
      "--fence-guardian-recovery-request": options.fenceGuardianRecoveryRequest,
      "--report": options.report,
    }).flat();
    let pollCount = 0;
    const result = await requestRecoveryFromGuardian(argv, options, {
      getUid: () => 0,
      nowMs: Date.parse(nowIso),
      requestId,
      maximumPolls: 4,
      assertGuardianLease: async () => ({
        heartbeat: pollCount < 1
          ? { recoveryChildPid: 456, lastRecoveryResult: null }
          : { recoveryChildPid: null, lastRecoveryResult: { requestId, exitCode: 0 } },
      }),
      assertTakeoverLease: async () => ({ sha256: "6".repeat(64) }),
      waitForPoll: async () => {
        pollCount += 1;
        if (pollCount !== 1) return;
        const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
        assert.equal(request.requestId, requestId);
        fs.unlinkSync(requestPath);
        const bindings = {
          barrierArtifactSha256: options.expectedBarrierArtifactSha256,
          cutoverPlanSha256: options.expectedCutoverPlanSha256,
          executionIndexSha256: options.expectedExecutionIndexSha256,
          fenceReceiptSha256: options.expectedFenceReceiptSha256,
          fenceGuardianReceiptSha256: options.expectedFenceGuardianReceiptSha256,
        };
        const journalDirectory = `${reportPath}.journal`;
        fs.mkdirSync(journalDirectory, { mode: 0o700 });
        const takeoverPath = path.join(privateRoot, `.viva-recovery-fence-takeover-${requestId}.json`);
        const takeoverBytes = Buffer.from(canonicalJson({
          formatVersion: 1,
          kind: "viva-game-projection-recovery-fence-takeover-receipt",
          state: "HOLDING_UNTIL_EXPLICIT_RELEASE",
          custodyState: "TAKEOVER_ESTABLISHED",
          pid: 456,
          fd: 9,
          processStartIdentity: "456:789",
          lockPath: guardian.lockPath,
          lockDevice: guardian.lockDevice,
          lockInode: guardian.lockInode,
          heartbeatPath: takeoverPath.replace(/\.json$/, ".heartbeat.json"),
          releaseRequestPath: guardian.releaseRequestPath,
          recoveryReportPath: reportPath,
          parentGuardianReceiptSha256: expectedGuardianSha256,
          parentGuardianPid: guardian.pid,
          parentGuardianProcessStartIdentity: guardian.processStartIdentity,
          recoveryRequestId: requestId,
          fenceTokenSha256: guardian.fenceTokenSha256,
          automaticRelease: false,
        }));
        write0600(takeoverPath, takeoverBytes);
        const report = {
          formatVersion: 1,
          kind: "viva-game-projection-mongo-write-barrier-recovery-receipt",
          state: "RELEASED_TO_EXACT_PREIMAGE",
          recoveryAttemptId: attemptId,
          recoveryJournalPath: journalDirectory,
          guardianRecoveryRequestId: requestId,
          recoveryFenceTakeoverState: "HELD_UNTIL_EXPLICIT_FENCE_RELEASE",
          recoveryFenceTakeoverReceiptPath: takeoverPath,
          recoveryFenceTakeoverReceiptSha256: cutoverSha256(takeoverBytes),
          ...bindings,
        };
        const reportBytes = Buffer.from(canonicalJson(report));
        write0600(path.join(journalDirectory, "0000-attempt-started.json"), Buffer.from(canonicalJson({
          formatVersion: 1, attemptId, mode: "BARRIER_RECOVERY", sequence: 0,
          at: nowIso, phase: "ATTEMPT_STARTED", ...bindings,
        })));
        const recoveryTerminalDetail = {
          state: report.state, mutationAttempted: true,
          reportSha256: cutoverSha256(reportBytes), reportBytesBase64: reportBytes.toString("base64"), report,
        };
        write0600(path.join(journalDirectory, "0001-terminal-result-intent.json"), Buffer.from(canonicalJson({
          formatVersion: 1, attemptId, mode: "BARRIER_RECOVERY", sequence: 1,
          at: nowIso, phase: "TERMINAL_RESULT_INTENT", ...recoveryTerminalDetail,
        })));
        write0600(path.join(journalDirectory, "0002-terminal-result.json"), Buffer.from(canonicalJson({
          formatVersion: 1, attemptId, mode: "BARRIER_RECOVERY", sequence: 2,
          at: nowIso, phase: "TERMINAL_RESULT", ...recoveryTerminalDetail,
        })));
        write0600(reportPath, reportBytes);
      },
    });
    assert.equal(pollCount, 1);
    assert.equal(result.recoveryAttemptId, attemptId);
    let guardianRechecked = false;
    const resumed = await requestRecoveryFromGuardian(argv, options, {
      getUid: () => 0,
      nowMs: Date.parse(nowIso) + 10 * 60_000,
      requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      assertGuardianLease: async () => {
        guardianRechecked = true;
        throw new Error("fixture guardian is gone");
      },
      assertTakeoverLease: async (_receipt, takeoverExpected) => {
        assert.equal(takeoverExpected.recoveryRequestId, requestId);
        assert.equal(takeoverExpected.recoveryReportPath, reportPath);
        return { sha256: "6".repeat(64) };
      },
    });
    assert.equal(resumed.recoveryAttemptId, attemptId);
    assert.equal(guardianRechecked, false);
    assert.equal(fs.existsSync(requestPath), false);
    const completedReportBytes = fs.readFileSync(reportPath);
    const terminalPath = path.join(`${reportPath}.journal`, "0002-terminal-result.json");
    const terminalBytes = fs.readFileSync(terminalPath);
    const fallbackResumed = await requestRecoveryFromGuardian(argv, options, {
      getUid: () => 0,
      nowMs: Date.parse(nowIso) + 10 * 60_000,
      requestId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      assertTakeoverLease: async () => { throw new Error("fixture takeover is dead"); },
      assertGuardianLease: async () => ({
        heartbeat: {
          recoveryTerminalGuardianFallback: {
            state: "HOLDING_TERMINAL_RECOVERY_FALLBACK",
            recoveryRequestId: requestId,
            recoveryReportPath: reportPath,
            recoveryReportSha256: cutoverSha256(completedReportBytes),
            recoveryTerminalJournalSha256: cutoverSha256(terminalBytes),
            recoveryFenceTakeoverReceiptSha256: cutoverSha256(fs.readFileSync(
              path.join(privateRoot, `.viva-recovery-fence-takeover-${requestId}.json`),
            )),
          },
        },
      }),
    });
    assert.equal(fallbackResumed.recoveryAttemptId, attemptId);
    assert.equal(fs.existsSync(requestPath), false);
    fs.unlinkSync(path.join(privateRoot, `.viva-recovery-fence-takeover-${requestId}.json`));

    const failedRequestId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const retryRequestId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const retryReportPath = path.join(privateRoot, "retry-recovery-report.json");
    const retryOptions = { ...options, report: retryReportPath };
    const retryArgv = argv.map((value) => (value === reportPath ? retryReportPath : value));
    const preacceptedRequestId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const preacceptedTakeoverPath = path.join(
      privateRoot, `.viva-recovery-fence-takeover-${preacceptedRequestId}.json`,
    );
    write0600(preacceptedTakeoverPath, Buffer.from(canonicalJson({
      formatVersion: 1,
      kind: "viva-game-projection-recovery-fence-takeover-receipt",
      state: "HOLDING_UNTIL_EXPLICIT_RELEASE",
      custodyState: "TAKEOVER_ESTABLISHED",
      pid: 456,
      fd: 9,
      processStartIdentity: "456:789",
      lockPath: guardian.lockPath,
      lockDevice: guardian.lockDevice,
      lockInode: guardian.lockInode,
      heartbeatPath: preacceptedTakeoverPath.replace(/\.json$/, ".heartbeat.json"),
      releaseRequestPath: guardian.releaseRequestPath,
      recoveryReportPath: retryReportPath,
      parentGuardianReceiptSha256: expectedGuardianSha256,
      parentGuardianPid: guardian.pid,
      parentGuardianProcessStartIdentity: guardian.processStartIdentity,
      recoveryRequestId: preacceptedRequestId,
      fenceTokenSha256: guardian.fenceTokenSha256,
      automaticRelease: false,
    })));
    write0600(requestPath, Buffer.from(canonicalJson({
      formatVersion: 1,
      kind: "viva-game-projection-fence-recovery-request",
      state: "RECOVERY_AUTHORIZED",
      confirmation: "RECOVER_VIVA_GAME_PROJECTION_MONGO_WRITE_BARRIER_V1",
      requestId: retryRequestId,
      guardianPid: guardian.pid,
      guardianProcessStartIdentity: guardian.processStartIdentity,
      fenceTokenSha256: guardian.fenceTokenSha256,
      argv: retryArgv,
      authorizedAt: nowIso,
    })));
    await assert.rejects(requestRecoveryFromGuardian(retryArgv, retryOptions, {
      getUid: () => 0,
      nowMs: Date.parse(nowIso),
      requestId: retryRequestId,
      maximumPolls: 1,
      assertGuardianLease: async () => ({ heartbeat: { recoveryChildPid: null, lastRecoveryResult: null } }),
      waitForPoll: async () => {},
    }), /Timed out waiting for the fence guardian recovery child/);
    assert.equal(JSON.parse(fs.readFileSync(requestPath, "utf8")).requestId, preacceptedRequestId);
    assert.equal(fs.existsSync(
      `${requestPath}.superseded-${retryRequestId}-by-${preacceptedRequestId}`,
    ), true);
    fs.unlinkSync(requestPath);
    fs.unlinkSync(preacceptedTakeoverPath);
    write0600(`${requestPath}.accepted-${failedRequestId}`, Buffer.from(canonicalJson({
      formatVersion: 1,
      kind: "viva-game-projection-fence-recovery-request",
      state: "RECOVERY_AUTHORIZED",
      confirmation: "RECOVER_VIVA_GAME_PROJECTION_MONGO_WRITE_BARRIER_V1",
      requestId: failedRequestId,
      guardianPid: guardian.pid,
      guardianProcessStartIdentity: guardian.processStartIdentity,
      fenceTokenSha256: guardian.fenceTokenSha256,
      argv: retryArgv,
      authorizedAt: nowIso,
    })));
    await assert.rejects(requestRecoveryFromGuardian(retryArgv, retryOptions, {
      getUid: () => 0,
      nowMs: Date.parse(nowIso),
      requestId: retryRequestId,
      maximumPolls: 1,
      assertGuardianLease: async () => ({
        heartbeat: {
          recoveryChildPid: null,
          recoveryRequestId: null,
          lastRecoveryResult: { requestId: failedRequestId, exitCode: 1 },
        },
      }),
      waitForPoll: async () => {},
    }), /Timed out waiting for the fence guardian recovery child/);
    assert.equal(JSON.parse(fs.readFileSync(requestPath, "utf8")).requestId, failedRequestId);
  } finally {
    if (previousConfirmation === undefined) delete process.env.VIVA_GAME_PROJECTION_MONGO_BARRIER_RECOVER;
    else process.env.VIVA_GAME_PROJECTION_MONGO_BARRIER_RECOVER = previousConfirmation;
    fs.rmSync(privateRoot, { recursive: true, force: true });
  }
});

test("takeover reconciliation replaces only an exact dead keeper and fails closed on a live partial keeper", async () => {
  const privateRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "viva-takeover-reconcile-")));
  fs.chmodSync(privateRoot, 0o700);
  try {
    const requestId = "12345678-1234-4234-8234-123456789abc";
    const guardianReceiptSha256 = "a".repeat(64);
    const options = {
      fenceGuardianReceipt: path.join(privateRoot, "guardian.json"),
      report: path.join(privateRoot, "recovery-report.json"),
    };
    const guardian = {
      pid: 123,
      processStartIdentity: "123:456",
      fenceTokenSha256,
      lockPath: "/run/lock/padlhub-viva-game-projection-cutover.lock",
      lockDevice: "1",
      lockInode: "2",
      releaseRequestPath: path.join(privateRoot, "release-request.json"),
    };
    const receiptPath = path.join(privateRoot, `.viva-recovery-fence-takeover-${requestId}.json`);
    const heartbeatPath = receiptPath.replace(/\.json$/, ".heartbeat.json");
    const receipt = {
      formatVersion: 1,
      kind: "viva-game-projection-recovery-fence-takeover-receipt",
      state: "HOLDING_UNTIL_EXPLICIT_RELEASE",
      custodyState: "TAKEOVER_ESTABLISHED",
      pid: 456,
      fd: 9,
      processStartIdentity: "456:789",
      lockPath: guardian.lockPath,
      lockDevice: guardian.lockDevice,
      lockInode: guardian.lockInode,
      heartbeatPath,
      releaseRequestPath: guardian.releaseRequestPath,
      recoveryReportPath: options.report,
      parentGuardianReceiptSha256: guardianReceiptSha256,
      parentGuardianPid: guardian.pid,
      parentGuardianProcessStartIdentity: guardian.processStartIdentity,
      recoveryRequestId: requestId,
      fenceTokenSha256: guardian.fenceTokenSha256,
      automaticRelease: false,
    };
    const heartbeat = {
      formatVersion: 1,
      kind: "viva-game-projection-recovery-fence-takeover-heartbeat",
      state: "HOLDING",
      pid: receipt.pid,
      fd: receipt.fd,
      processStartIdentity: receipt.processStartIdentity,
      lockPath: receipt.lockPath,
      lockDevice: receipt.lockDevice,
      lockInode: receipt.lockInode,
      fenceTokenSha256: receipt.fenceTokenSha256,
      parentGuardianReceiptSha256: receipt.parentGuardianReceiptSha256,
      parentGuardianPid: receipt.parentGuardianPid,
      parentGuardianProcessStartIdentity: receipt.parentGuardianProcessStartIdentity,
      recoveryRequestId: requestId,
      sequence: 0,
      observedAt: nowIso,
    };
    let restartCount = 0;
    const deadDependencies = {
      isTakeoverAlive: async () => false,
      startFenceTakeover: async ({ requestId: restartedRequestId }) => {
        restartCount += 1;
        return { restarted: true, requestId: restartedRequestId };
      },
    };
    write0600(receiptPath, Buffer.from(canonicalJson(receipt)));
    assert.deepEqual(
      await startRecoveryFenceTakeover(options, guardian, guardianReceiptSha256, requestId, deadDependencies),
      { restarted: true, requestId },
    );
    assert.equal(fs.existsSync(receiptPath), false);
    assert.equal(restartCount, 1);

    write0600(receiptPath, Buffer.from(canonicalJson(receipt)));
    write0600(heartbeatPath, Buffer.from(canonicalJson(heartbeat)));
    await startRecoveryFenceTakeover(options, guardian, guardianReceiptSha256, requestId, deadDependencies);
    assert.equal(fs.existsSync(receiptPath), false);
    assert.equal(fs.existsSync(heartbeatPath), false);
    assert.equal(restartCount, 2);

    write0600(receiptPath, Buffer.from(canonicalJson(receipt)));
    await assert.rejects(startRecoveryFenceTakeover(
      options, guardian, guardianReceiptSha256, requestId,
      { ...deadDependencies, isTakeoverAlive: async () => true },
    ), /has not published its first heartbeat/);
    assert.equal(fs.existsSync(receiptPath), true);
    assert.equal(restartCount, 2);
  } finally {
    fs.rmSync(privateRoot, { recursive: true, force: true });
  }
});

test("a SIGKILLed receipt-only takeover is replaced with the same request ID", {
  skip: process.platform !== "linux" || process.getuid?.() !== 0
    || process.env.PADLHUB_RUN_LINUX_FLOCK_TESTS !== "1",
}, async () => {
  const privateRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "viva-dead-partial-takeover-")));
  fs.chmodSync(privateRoot, 0o700);
  let keeper = null;
  try {
    const requestId = "12345678-1234-4234-8234-123456789abc";
    const guardianReceiptSha256 = "a".repeat(64);
    const options = {
      fenceGuardianReceipt: path.join(privateRoot, "guardian.json"),
      report: path.join(privateRoot, "recovery-report.json"),
    };
    const guardian = {
      pid: process.pid,
      processStartIdentity: `${process.pid}:1`,
      fenceTokenSha256,
      lockPath: "/run/lock/padlhub-viva-game-projection-cutover.lock",
      lockDevice: "1",
      lockInode: "2",
      releaseRequestPath: path.join(privateRoot, "release-request.json"),
    };
    keeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const body = fs.readFileSync(`/proc/${keeper.pid}/stat`, "utf8").trim();
    const tail = body.slice(body.lastIndexOf(")") + 2).split(/\s+/);
    const processStartIdentity = `${keeper.pid}:${tail[19]}`;
    const receiptPath = path.join(privateRoot, `.viva-recovery-fence-takeover-${requestId}.json`);
    write0600(receiptPath, Buffer.from(canonicalJson({
      formatVersion: 1,
      kind: "viva-game-projection-recovery-fence-takeover-receipt",
      state: "HOLDING_UNTIL_EXPLICIT_RELEASE",
      custodyState: "TAKEOVER_ESTABLISHED",
      pid: keeper.pid,
      fd: 9,
      processStartIdentity,
      lockPath: guardian.lockPath,
      lockDevice: guardian.lockDevice,
      lockInode: guardian.lockInode,
      heartbeatPath: receiptPath.replace(/\.json$/, ".heartbeat.json"),
      releaseRequestPath: guardian.releaseRequestPath,
      recoveryReportPath: options.report,
      parentGuardianReceiptSha256: guardianReceiptSha256,
      parentGuardianPid: guardian.pid,
      parentGuardianProcessStartIdentity: guardian.processStartIdentity,
      recoveryRequestId: requestId,
      fenceTokenSha256: guardian.fenceTokenSha256,
      automaticRelease: false,
    })));
    keeper.kill("SIGKILL");
    await new Promise((resolve) => keeper.once("close", resolve));
    let restartedRequestId = null;
    await startRecoveryFenceTakeover(options, guardian, guardianReceiptSha256, requestId, {
      startFenceTakeover: async ({ requestId: value }) => {
        restartedRequestId = value;
        return { restarted: true };
      },
    });
    assert.equal(restartedRequestId, requestId);
    assert.equal(fs.existsSync(receiptPath), false);
  } finally {
    try { if (keeper?.pid) process.kill(keeper.pid, "SIGKILL"); } catch { /* already stopped */ }
    fs.rmSync(privateRoot, { recursive: true, force: true });
  }
});

test("standalone READY finalization requests an exact guardian child and waits for its marker", async () => {
  const privateRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "viva-guardian-ready-request-")));
  fs.chmodSync(privateRoot, 0o700);
  const previous = {
    confirmation: process.env.VIVA_GAME_PROJECTION_READY_FINALIZE,
    guardian: process.env.PADLHUB_CUTOVER_GUARDIAN_RECEIPT,
    request: process.env.PADLHUB_CUTOVER_GUARDIAN_READY_REQUEST,
  };
  try {
    const finalizerPath = fs.realpathSync(path.resolve(
      path.dirname(fileURLToPath(import.meta.url)), "../finalize_viva_game_projection_cutover_ready.mjs",
    ));
    const guardianPath = path.join(privateRoot, "guardian.json");
    const requestPath = path.join(privateRoot, "ready-request.json");
    const postcheckOutputDirectory = path.join(privateRoot, "postcheck");
    fs.mkdirSync(postcheckOutputDirectory, { mode: 0o700 });
    const requestId = "12345678-1234-4234-8234-123456789abc";
    const guardian = {
      formatVersion: 1,
      kind: "viva-game-projection-fence-guardian-receipt",
      state: "HOLDING_UNTIL_EXPLICIT_RELEASE",
      pid: 123,
      processStartIdentity: "123:456",
      fenceTokenSha256,
      readyRequestPath: requestPath,
      readyFinalizerPath: finalizerPath,
      readyFinalizerSha256: cutoverSha256(fs.readFileSync(finalizerPath)),
    };
    const guardianBytes = Buffer.from(canonicalJson(guardian));
    write0600(guardianPath, guardianBytes);
    const cutoverPath = path.join(privateRoot, "cutover.json");
    const cutover = {
      candidateCanonicalSha256: "f".repeat(64),
      production: { localHealthUrl: "http://127.0.0.1:1880/flows" },
    };
    const cutoverBytes = Buffer.from(canonicalJson(cutover));
    write0600(cutoverPath, cutoverBytes);
    const executionPath = path.join(privateRoot, "execution.json");
    const execution = {
      postcheckOutputDirectory,
      cutoverPlanPath: cutoverPath,
      cutoverPlanSha256: cutoverSha256(cutoverBytes),
    };
    const executionBytes = Buffer.from(canonicalJson(execution));
    write0600(executionPath, executionBytes);
    const reportPath = path.join(privateRoot, "coordinator.json");
    const attemptId = "87654321-4321-4321-8321-cba987654321";
    const report = {
      formatVersion: 1,
      kind: "viva-game-projection-cutover-coordinator-report",
      state: "POSTCHECK_PASS_INGRESS_STILL_BLOCKED",
      coordinatorAttemptId: attemptId,
      cutoverPlanSha256: execution.cutoverPlanSha256,
      postcheckReceiptSha256: "1".repeat(64),
      postcheckManifestSha256: "2".repeat(64),
      mongoWriteBarrierReceiptSha256: "3".repeat(64),
      fenceGuardianReceiptSha256: cutoverSha256(guardianBytes),
      ingressReopened: false,
    };
    const reportBytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
    const reportSha256 = cutoverSha256(reportBytes);
    const reportJournal = `${reportPath}.journal`;
    fs.mkdirSync(reportJournal, { mode: 0o700 });
    write0600(path.join(reportJournal, "0000-attempt-started.json"), Buffer.from(canonicalJson({
      formatVersion: 1, attemptId, mode: "CUTOVER", sequence: 0, at: nowIso, phase: "ATTEMPT_STARTED",
    })));
    const terminalDetail = {
      state: report.state, mutationAttempted: true, reportSha256,
      reportBytesBase64: reportBytes.toString("base64"), report,
    };
    write0600(path.join(reportJournal, "0001-terminal-result-intent.json"), Buffer.from(canonicalJson({
      formatVersion: 1, attemptId, mode: "CUTOVER", sequence: 1, at: nowIso,
      phase: "TERMINAL_RESULT_INTENT", ...terminalDetail,
    })));
    const terminalBytes = Buffer.from(canonicalJson({
      formatVersion: 1, attemptId, mode: "CUTOVER", sequence: 2, at: nowIso,
      phase: "TERMINAL_RESULT", ...terminalDetail,
    }));
    write0600(path.join(reportJournal, "0002-terminal-result.json"), terminalBytes);
    write0600(reportPath, reportBytes);
    process.env.VIVA_GAME_PROJECTION_READY_FINALIZE = "FINALIZE_VIVA_GAME_PROJECTION_READY_V1";
    process.env.PADLHUB_CUTOVER_GUARDIAN_RECEIPT = guardianPath;
    process.env.PADLHUB_CUTOVER_GUARDIAN_READY_REQUEST = requestPath;
    write0600(requestPath, Buffer.from(canonicalJson({
      formatVersion: 1,
      kind: "viva-game-projection-fence-ready-finalization-request",
      state: "READY_FINALIZATION_AUTHORIZED",
      confirmation: "FINALIZE_VIVA_GAME_PROJECTION_READY_V1",
      requestId,
      guardianPid: guardian.pid,
      guardianProcessStartIdentity: guardian.processStartIdentity,
      fenceTokenSha256: guardian.fenceTokenSha256,
      argv: [
        "--execution-index", executionPath,
        "--expected-execution-index-sha256", cutoverSha256(executionBytes),
        "--coordinator-report", reportPath,
        "--expected-coordinator-report-sha256", reportSha256,
      ],
      authorizedAt: nowIso,
    })));
    let requestObserved = false;
    const result = await requestReadyFinalizationFromGuardian({
      executionIndex: executionPath,
      expectedExecutionIndexSha256: cutoverSha256(executionBytes),
      coordinatorReport: reportPath,
      expectedCoordinatorReportSha256: reportSha256,
    }, {
      getUid: () => 0,
      nowMs: Date.parse(nowIso),
      requestId,
      maximumPolls: 2,
      assertGuardianLease: async () => ({
        heartbeat: requestObserved
          ? { lastReadyResult: { requestId, exitCode: 0, signal: null } }
          : { recoveryChildPid: null, readyChildPid: null },
      }),
      waitForPoll: async () => {
        const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
        assert.equal(request.requestId, requestId);
        assert.deepEqual(request.argv, [
          "--execution-index", executionPath,
          "--expected-execution-index-sha256", cutoverSha256(executionBytes),
          "--coordinator-report", reportPath,
          "--expected-coordinator-report-sha256", reportSha256,
        ]);
        fs.unlinkSync(requestPath);
        const finalizationReceiptBytes = Buffer.from(canonicalJson({
          formatVersion: 1,
          kind: "viva-game-projection-ready-finalization-receipt",
          state: "PASS_CURRENT_GATES",
          cutoverPlanSha256: execution.cutoverPlanSha256,
          executionIndexSha256: cutoverSha256(executionBytes),
          coordinatorAttemptId: attemptId,
          coordinatorReportSha256: reportSha256,
          guardianReadyRequestId: requestId,
          coordinatorTerminalJournalSha256: cutoverSha256(terminalBytes),
          postcheckReceiptSha256: report.postcheckReceiptSha256,
          postcheckManifestSha256: report.postcheckManifestSha256,
          mongoWriteBarrierReceiptSha256: report.mongoWriteBarrierReceiptSha256,
          fenceGuardianReceiptSha256: report.fenceGuardianReceiptSha256,
          fenceGuardianHeartbeatSha256: "4".repeat(64),
          pm2StateSha256: "6".repeat(64),
          liveFlowSha256: "7".repeat(64),
          runtimeHealth: {
            url: cutover.production.localHealthUrl,
            statusCode: 200,
            bodySha256: "5".repeat(64),
            bodyCanonicalSha256: cutover.candidateCanonicalSha256,
          },
          mongoReplicaSetName: "rs-fixture",
          mongoCurrentOpClear: true,
          observedAt: nowIso,
        }));
        write0600(path.join(postcheckOutputDirectory, "ready-finalization.receipt.json"), finalizationReceiptBytes);
        write0600(path.join(postcheckOutputDirectory, "READY_TO_REOPEN_INGRESS.json"), Buffer.from(canonicalJson({
          formatVersion: 1,
          kind: "viva-game-projection-cutover-ready-marker",
          state: "READY_TO_REOPEN_INGRESS",
          cutoverPlanSha256: execution.cutoverPlanSha256,
          guardianReadyRequestId: requestId,
          executionIndexSha256: cutoverSha256(executionBytes),
          coordinatorAttemptId: attemptId,
          coordinatorReportSha256: reportSha256,
          coordinatorTerminalJournalSha256: cutoverSha256(terminalBytes),
          postcheckReceiptSha256: report.postcheckReceiptSha256,
          postcheckManifestSha256: report.postcheckManifestSha256,
          mongoWriteBarrierReceiptSha256: report.mongoWriteBarrierReceiptSha256,
          fenceGuardianReceiptSha256: report.fenceGuardianReceiptSha256,
          readyFinalizationReceiptSha256: cutoverSha256(finalizationReceiptBytes),
          fenceGuardianHeartbeatSha256: "4".repeat(64),
          runtimeHealth: {
            url: cutover.production.localHealthUrl,
            statusCode: 200,
            bodySha256: "5".repeat(64),
            bodyCanonicalSha256: cutover.candidateCanonicalSha256,
          },
          ingressReopenEligible: true,
          ingressReopened: false,
          observedAt: nowIso,
        })));
        requestObserved = true;
      },
    });
    assert.equal(result.state, "READY_TO_REOPEN_INGRESS");
    assert.equal(result.resumed, true);
    const retried = await requestReadyFinalizationFromGuardian({
      executionIndex: executionPath,
      expectedExecutionIndexSha256: cutoverSha256(executionBytes),
      coordinatorReport: reportPath,
      expectedCoordinatorReportSha256: reportSha256,
    }, {
      getUid: () => 0,
      nowMs: Date.parse(nowIso) + 1_000,
      requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      assertGuardianLease: async () => ({
        heartbeat: { lastReadyResult: { requestId, exitCode: 0, signal: null } },
      }),
      waitForPoll: async () => { throw new Error("exact READY retry must not publish another request"); },
    });
    assert.equal(retried.state, "READY_TO_REOPEN_INGRESS");
    assert.equal(fs.existsSync(requestPath), false);
  } finally {
    for (const [key, value] of [
      ["VIVA_GAME_PROJECTION_READY_FINALIZE", previous.confirmation],
      ["PADLHUB_CUTOVER_GUARDIAN_RECEIPT", previous.guardian],
      ["PADLHUB_CUTOVER_GUARDIAN_READY_REQUEST", previous.request],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(privateRoot, { recursive: true, force: true });
  }
});

test("standalone Mongo barrier recovery requires stopped fenced runtime and reconciles its durable unknown journal", async () => {
  const privateRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "viva-barrier-recovery-")));
  fs.chmodSync(privateRoot, 0o700);
  const previousConfirmation = process.env.VIVA_GAME_PROJECTION_MONGO_BARRIER_RECOVER;
  process.env.VIVA_GAME_PROJECTION_MONGO_BARRIER_RECOVER = "RECOVER_VIVA_GAME_PROJECTION_MONGO_WRITE_BARRIER_V1";
  try {
    const localUri = "mongodb://127.0.0.1:27017/?directConnection=true";
    const localMigrationFingerprint = cutoverSha256(localUri);
    const plan = {
      formatVersion: 1,
      kind: "viva-game-projection-tenant-cutover-plan",
      state: "READY_FOR_SEPARATE_LIVE_APPROVAL",
      liveMutationAuthorized: false,
      sourceFlowSha256,
      candidateSha256,
      tenantKeySha256: cutoverSha256(tenantKey),
      production: {
        hostname: "fixture-host",
        processName: "node-red",
        pm2ProcessId: 0,
        pmExecPath: "/usr/local/bin/node-red",
        pmCwd: "/root/.node-red",
        pmArgsSha256: cutoverSha256(canonicalJson([])),
        pmNodeArgsSha256: cutoverSha256(canonicalJson([])),
        restartCountAtEvidence: 3,
      },
      writerFence: {
        exactMigrationOperationIds: [scope.operationId],
        exactWriterNodeIds: ["source-writer"],
        writerInventorySha256,
        externalWriterProofSha256: "8".repeat(64),
        fenceTokenSha256,
        lockPath: "/run/lock/padlhub-viva-game-projection-cutover.lock",
      },
      mongoTarget: {
        migrationConnectionFingerprint: localMigrationFingerprint,
        replicaSetName: "rs-fixture",
        targetIdentitySha256: mongoTarget.targetIdentitySha256,
      },
    };
    const cutoverPlanPath = path.join(privateRoot, "cutover-plan.json");
    const cutoverPlanBytes = Buffer.from(canonicalJson(plan));
    write0600(cutoverPlanPath, cutoverPlanBytes);
    const cutoverPlanSha256 = cutoverSha256(cutoverPlanBytes);
    const barrierReceiptOutputPath = path.join(privateRoot, "barrier.json");
    const artifactPath = `${barrierReceiptOutputPath}.prepared`;
    const artifactBytes = Buffer.from(canonicalJson({
      kind: "viva-game-projection-mongo-write-barrier-preparation",
      cutoverPlanSha256,
    }));
    write0600(artifactPath, artifactBytes);
    const fenceReceiptPath = path.join(privateRoot, "fence.json");
    const fenceReceiptBytes = Buffer.from(canonicalJson({
      formatVersion: 1,
      kind: "viva-game-projection-writer-fence-receipt",
      state: "HELD",
      sourceFlowSha256,
      candidateSha256,
      tenantKey,
      operationIds: [scope.operationId],
      fenceToken,
      writerInventorySha256,
      externalWriterProofSha256: "8".repeat(64),
      lockPath: "/run/lock/padlhub-viva-game-projection-cutover.lock",
      host: "lk-primary-147",
      hostname: "fixture-host",
      processName: "node-red",
      pm2ProcessId: 0,
      nodeRedProcessState: "STOPPED",
      ingressWriteRoutesBlocked: true,
      internalSchedulersStopped: true,
      allLkGamesWritersQuiescent: true,
      externalMongoWritersBlocked: true,
      writerNodeIds: ["source-writer"],
      observedAt: nowIso,
      expiresAt: new Date(Date.parse(nowIso) + 10 * 60_000).toISOString(),
    }));
    write0600(fenceReceiptPath, fenceReceiptBytes);
    const guardianReceiptPath = path.join(privateRoot, "guardian.json");
    const guardianRecoveryRequestPath = path.join(privateRoot, "guardian-recovery-request.json");
    const guardianReleaseRequestPath = path.join(privateRoot, "guardian-release-request.json");
    const recoveryExecutorPath = fs.realpathSync(path.resolve(
      path.dirname(fileURLToPath(import.meta.url)), "../recover_viva_game_projection_mongo_write_barrier.mjs",
    ));
    const guardianReceiptBytes = Buffer.from(canonicalJson({
      formatVersion: 1,
      kind: "viva-game-projection-fence-guardian-receipt",
      state: "HOLDING_UNTIL_EXPLICIT_RELEASE",
      pid: 123,
      fd: 9,
      processStartIdentity: "123:456",
      fenceTokenSha256,
      lockPath: "/run/lock/padlhub-viva-game-projection-cutover.lock",
      lockDevice: "1",
      lockInode: "2",
      heartbeatPath: path.join(privateRoot, "guardian-heartbeat.json"),
      releaseRequestPath: guardianReleaseRequestPath,
      recoveryRequestPath: guardianRecoveryRequestPath,
      recoveryExecutorPath,
      recoveryExecutorSha256: cutoverSha256(fs.readFileSync(recoveryExecutorPath)),
      automaticRelease: false,
    }));
    write0600(guardianReceiptPath, guardianReceiptBytes);
    const connectionPath = path.join(privateRoot, "migration.json");
    const connectionBytes = Buffer.from(canonicalJson({
      formatVersion: 1,
      kind: "viva-game-projection-migration-mongo-connection",
      uri: localUri,
    }));
    write0600(connectionPath, connectionBytes);
    const executionIndexPath = path.join(privateRoot, "execution-index.json");
    const executionIndexBytes = Buffer.from(canonicalJson({
      formatVersion: 1,
      kind: "viva-game-projection-cutover-execution-index",
      cutoverPlanPath,
      cutoverPlanSha256,
      fenceReceiptPath,
      fenceReceiptSha256: cutoverSha256(fenceReceiptBytes),
      migrationConnectionFile: connectionPath,
      migrationConnectionFileSha256: cutoverSha256(connectionBytes),
      mongoWriteBarrierReceiptOutputPath: barrierReceiptOutputPath,
      tenantKey,
    }));
    write0600(executionIndexPath, executionIndexBytes);
    let runtimeStatus = "online";
    let restoreAttempts = 0;
    let takeoverStartAttempts = 0;
    let guardianLostDuringRoleRestore = false;
    const pm2Fixture = () => [{
      name: "node-red",
      pm_id: 0,
      pm2_env: {
        status: runtimeStatus,
        restart_time: 4,
        pm_exec_path: "/usr/local/bin/node-red",
        pm_cwd: "/root/.node-red",
        args: [],
        node_args: [],
        PADLHUB_PLATFORM_TENANT_KEY: tenantKey,
        VIVA_GAME_PROJECTION_SYNC_MODE: "SHADOW",
      },
    }];
    const common = {
      barrierArtifact: artifactPath,
      expectedBarrierArtifactSha256: cutoverSha256(artifactBytes),
      cutoverPlan: cutoverPlanPath,
      expectedCutoverPlanSha256: cutoverPlanSha256,
      migrationConnectionFile: connectionPath,
      executionIndex: executionIndexPath,
      expectedExecutionIndexSha256: cutoverSha256(executionIndexBytes),
      fenceReceipt: fenceReceiptPath,
      expectedFenceReceiptSha256: cutoverSha256(fenceReceiptBytes),
      fenceGuardianReceipt: guardianReceiptPath,
      expectedFenceGuardianReceiptSha256: cutoverSha256(guardianReceiptBytes),
      fenceGuardianRecoveryRequest: guardianRecoveryRequestPath,
    };
    const dependencies = {
      getUid: () => 0,
      allowFixtureGuardianChild: true,
      allowFixtureHostname: true,
      guardianRecoveryRequestId: "12345678-1234-4234-8234-123456789abc",
      nowMs: Date.parse(nowIso) + 10 * 60_000,
      assertExecutorSources: async () => true,
      assertGuardianLease: async () => {
        if (guardianLostDuringRoleRestore) throw new Error("simulated guardian SIGKILL");
        return { sha256: "7".repeat(64) };
      },
      startFenceTakeover: async ({ options, guardian, guardianReceiptSha256, requestId }) => {
        takeoverStartAttempts += 1;
        const receiptPath = path.join(
          privateRoot, `.viva-recovery-fence-takeover-${requestId}.json`,
        );
        const heartbeatPath = receiptPath.replace(/\.json$/, ".heartbeat.json");
        const receipt = {
          formatVersion: 1,
          kind: "viva-game-projection-recovery-fence-takeover-receipt",
          state: "HOLDING_UNTIL_EXPLICIT_RELEASE",
          custodyState: "TAKEOVER_ESTABLISHED",
          pid: 456,
          fd: 9,
          processStartIdentity: "456:789",
          lockPath: guardian.lockPath,
          lockDevice: guardian.lockDevice,
          lockInode: guardian.lockInode,
          heartbeatPath,
          releaseRequestPath: guardian.releaseRequestPath,
          recoveryReportPath: options.report,
          parentGuardianReceiptSha256: guardianReceiptSha256,
          parentGuardianPid: guardian.pid,
          parentGuardianProcessStartIdentity: guardian.processStartIdentity,
          recoveryRequestId: requestId,
          fenceTokenSha256: guardian.fenceTokenSha256,
          automaticRelease: false,
        };
        const receiptBytes = Buffer.from(canonicalJson(receipt));
        if (!fs.existsSync(receiptPath)) write0600(receiptPath, receiptBytes);
        if (!fs.existsSync(heartbeatPath)) write0600(heartbeatPath, Buffer.from(canonicalJson({ fixture: "heartbeat" })));
        return {
          receiptPath,
          heartbeatPath,
          receiptSha256: cutoverSha256(receiptBytes),
          receipt,
        };
      },
      assertTakeoverLease: async () => ({ sha256: "5".repeat(64) }),
      assertFenceLease: async () => true,
      readPm2: async () => pm2Fixture(),
      migrationClient: { db: () => ({ command: async () => ({ setName: "rs-fixture" }) }) },
      restorePreviousMongoWriteBarrier: async (_client, _artifact, expected) => {
        restoreAttempts += 1;
        await expected.assertFence("BEFORE_RECOVERY_STATE_READ");
        if (restoreAttempts === 1) throw new Error("simulated recovery interruption");
        await expected.assertFence("BEFORE_APPLICATION_ROLES_RESTORE");
        guardianLostDuringRoleRestore = true;
        await expected.assertFence("AFTER_RECOVERY_READBACK");
        return {
          formatVersion: 1,
          kind: "viva-game-projection-mongo-write-barrier-recovery-receipt",
          state: "RELEASED_TO_EXACT_PREIMAGE",
        };
      },
    };
    await assert.rejects(
      recoverVivaGameProjectionMongoWriteBarrier({ ...common, report: path.join(privateRoot, "online-report.json") }, dependencies),
      /requires the exact stopped Node-RED runtime/,
    );
    assert.equal(restoreAttempts, 0);
    runtimeStatus = "stopped";
    const reportPath = path.join(privateRoot, "recovery-report.json");
    await assert.rejects(
      recoverVivaGameProjectionMongoWriteBarrier({ ...common, report: reportPath }, dependencies),
      /simulated recovery interruption/,
    );
    assert.equal(fs.existsSync(reportPath), false);
    assert.equal(fs.existsSync(`${reportPath}.journal`), true);
    let reportPublicationAttempts = 0;
    const interruptedPublicationDependencies = {
      ...dependencies,
      writeRecoveryReport: async () => {
        reportPublicationAttempts += 1;
        throw new Error("simulated recovery report publication interruption");
      },
    };
    await assert.rejects(
      recoverVivaGameProjectionMongoWriteBarrier({ ...common, report: reportPath }, interruptedPublicationDependencies),
      /simulated recovery report publication interruption/,
    );
    assert.equal(fs.existsSync(reportPath), false);
    const result = await recoverVivaGameProjectionMongoWriteBarrier({ ...common, report: reportPath }, dependencies);
    assert.equal(result.state, "RELEASED_TO_EXACT_PREIMAGE");
    assert.equal(result.reconciledPriorUnknownOutcome, true);
    assert.equal(result.recoveryFenceTakeoverState, "HELD_UNTIL_EXPLICIT_FENCE_RELEASE");
    assert.equal(restoreAttempts, 2);
    assert.equal(takeoverStartAttempts, 1);
    assert.equal(reportPublicationAttempts, 1);
    const phases = fs.readdirSync(`${reportPath}.journal`).sort().map((name) => (
      JSON.parse(fs.readFileSync(path.join(`${reportPath}.journal`, name), "utf8")).phase
    ));
    assert.equal(phases[0], "ATTEMPT_STARTED");
    assert.equal(phases[1], "BARRIER_RECOVERY_OUTCOME_UNKNOWN");
    assert.ok(phases.includes("BARRIER_RECOVERY_RECONCILE_OUTCOME_UNKNOWN"));
    assert.equal(phases.filter((phase) => phase === "FENCE_REVALIDATED_DURING_BARRIER_RECOVERY").length, 4);
    assert.equal(phases.at(-3), "FENCE_REVALIDATED_AFTER_BARRIER_RECOVERY");
    assert.equal(phases.at(-2), "TERMINAL_RESULT_INTENT");
    assert.equal(phases.at(-1), "TERMINAL_RESULT");
  } finally {
    if (previousConfirmation === undefined) delete process.env.VIVA_GAME_PROJECTION_MONGO_BARRIER_RECOVER;
    else process.env.VIVA_GAME_PROJECTION_MONGO_BARRIER_RECOVER = previousConfirmation;
    fs.rmSync(privateRoot, { recursive: true, force: true });
  }
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
    candidateCanonicalSha256: "f".repeat(64),
    tenantKey,
    sourceWriters: sourceWriterInventory,
    candidateWriters: candidateWriterInventory,
    plans: [cutoverPlanItem(planSha256, plan)],
    controls: completeControls,
    controlsSha256: "6".repeat(64),
    reviewedFlowContractSha256: "7".repeat(64),
    executorSources: fixtureExecutorSources,
    generatedAt: nowIso,
  });
  assert.equal(result.state, "READY_FOR_SEPARATE_LIVE_APPROVAL");
  assert.deepEqual(result.writerFence.exactWriterNodeIds, ["candidate-writer", "source-writer"]);
  assert.equal(result.liveMutationAuthorized, false);
  assert.equal(result.migration.futureBoundaryDate, nowIso.slice(0, 10));
  assert.equal(result.migration.futureBoundaryTimeZone, "UTC");
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
  const fixtureGuardianHeartbeatBytes = Buffer.from(canonicalJson({ fixture: "guardian-heartbeat" }));
  const postcheckEvidence = {
    applyReportBytesByPlan: { [planSha256]: fixtureApplyReport },
    queryEvidenceBytes: fixtureQueries,
    mongoWriteBarrierReceiptBytes: fixtureBarrierBytes,
    executionIndexBytes: fixtureExecutionBytes,
    fenceGuardianReceiptBytes: fixtureGuardianBytes,
    fenceGuardianHeartbeatBytes: fixtureGuardianHeartbeatBytes,
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
    runtimeRestartCount: 4,
    runtimeTenantReadback: true,
    candidateFlowReadback: true,
    runtimeHealth: {
      url: "http://127.0.0.1:1880/flows", statusCode: 200, bodySha256: "a".repeat(64),
      bodyCanonicalSha256: "f".repeat(64), observedAt: nowIso,
    },
    fenceTokenSha256,
    fenceReceiptSha256: "9".repeat(64),
    mongoWriteBarrierReceiptSha256: cutoverSha256(fixtureBarrierBytes),
    executionIndexSha256: cutoverSha256(fixtureExecutionBytes),
    coordinatorAttemptId: "11111111-1111-4111-8111-111111111111",
    fenceGuardianReceiptSha256: cutoverSha256(fixtureGuardianBytes),
    fenceGuardianHeartbeatSha256: cutoverSha256(fixtureGuardianHeartbeatBytes),
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
    () => validateVivaGameProjectionCutoverPostcheck({
      ...postcheck, runtimeHealth: { ...postcheck.runtimeHealth, statusCode: 302 },
    }, result, Date.parse(nowIso), postcheckEvidence),
    /does not authorize reopening ingress/,
  );
  assert.throws(
    () => validateVivaGameProjectionCutoverPostcheck({
      ...postcheck, runtimeHealth: { ...postcheck.runtimeHealth, bodyCanonicalSha256: "0".repeat(64) },
    }, result, Date.parse(nowIso), postcheckEvidence),
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
    candidateCanonicalSha256: "f".repeat(64),
    tenantKey,
    sourceWriters: sourceWriterInventory,
    candidateWriters: candidateWriterInventory,
    plans: [cutoverPlanItem(planSha256, plan)],
    controls: incomplete,
    controlsSha256: "6".repeat(64),
    reviewedFlowContractSha256: "7".repeat(64),
    executorSources: fixtureExecutorSources,
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
      candidateCanonicalSha256: "f".repeat(64),
      tenantKey,
      sourceWriters: sourceWriterInventory,
      candidateWriters: candidateWriterInventory,
      plans: [cutoverPlanItem(planSha256, migrationPlan)],
      controls: evidence,
      controlsSha256: "6".repeat(64),
      reviewedFlowContractSha256: "7".repeat(64),
      executorSources: fixtureExecutorSources,
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
    candidateCanonicalSha256: "f".repeat(64),
    tenantKey,
    sourceWriters: sourceWriterInventory,
    candidateWriters: candidateWriterInventory,
    plans: [cutoverPlanItem("5".repeat(64), plan)],
    controls: controls({ writerFence: { state: "HELD", writerNodeIds: [] } }),
    controlsSha256: "6".repeat(64),
    reviewedFlowContractSha256: "7".repeat(64),
    executorSources: fixtureExecutorSources,
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

test("current-op gate detects DML, DDL, rename and aggregate writes targeting lk_games", async () => {
  const conflicts = [
    { ns: "games.$cmd", command: { $db: "games", drop: "lk_games" } },
    { ns: "games.$cmd", command: { $db: "games", dropDatabase: 1 } },
    { ns: "admin.$cmd", command: { $db: "admin", renameCollection: "games.lk_games", to: "archive.lk_games" } },
    { ns: "admin.$cmd", command: { $db: "admin", renameCollection: "archive.lk_games", to: "games.lk_games" } },
    { ns: "games.$cmd", command: { $db: "games", createIndexes: "lk_games" } },
    { ns: "games.$cmd", command: { $db: "games", collMod: "lk_games" } },
    { ns: "games.$cmd", command: { $db: "games", aggregate: "source", pipeline: [{ $out: "lk_games" }] } },
    { ns: "other.$cmd", command: { $db: "other", aggregate: "source", pipeline: [{ $merge: { into: { db: "games", coll: "lk_games" } } }] } },
  ];
  conflicts.forEach((row) => assert.equal(mongoCurrentOpTouchesLkGames(row), true));
  assert.equal(mongoCurrentOpTouchesLkGames({ ns: "games.$cmd", command: { $db: "games", drop: "other" } }), false);
  assert.equal(mongoCurrentOpTouchesLkGames({ ns: "games.$cmd", command: { $db: "games", aggregate: "lk_games", pipeline: [] } }), false);
  await assert.rejects(() => assertNoConcurrentMongoWrites({
    db: () => ({ aggregate: () => ({ toArray: async () => conflicts }) }),
  }), /Concurrent games\.lk_games writer/);
});

test("cutover tools contain no remote-control or inline credential path", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const packetSource = fs.readFileSync(path.join(root, "prepare_viva_game_projection_cutover_packet.mjs"), "utf8");
  const executorSource = fs.readFileSync(path.join(root, "run_viva_game_projection_tenant_migration.mjs"), "utf8");
  const coordinatorSource = fs.readFileSync(path.join(root, "run_viva_game_projection_cutover_coordinator.mjs"), "utf8");
  const coordinatorShell = fs.readFileSync(path.join(root, "run_viva_game_projection_cutover.sh"), "utf8");
  const postcheckSource = fs.readFileSync(path.join(root, "prepare_viva_game_projection_cutover_postcheck.mjs"), "utf8");
  const guardianSource = fs.readFileSync(path.join(root, "run_viva_game_projection_fence_guardian.mjs"), "utf8");
  const guardianContractSource = fs.readFileSync(path.join(root, "lib/vivaGameProjectionFenceGuardian.mjs"), "utf8");
  const recoverySource = fs.readFileSync(path.join(root, "recover_viva_game_projection_mongo_write_barrier.mjs"), "utf8");
  const recoveryTakeoverSource = fs.readFileSync(path.join(root, "run_viva_game_projection_recovery_fence_takeover.mjs"), "utf8");
  const readyFinalizerSource = fs.readFileSync(path.join(root, "finalize_viva_game_projection_cutover_ready.mjs"), "utf8");
  const barrierSource = fs.readFileSync(path.join(root, "lib/vivaGameProjectionMongoWriteBarrier.mjs"), "utf8");
  assert.doesNotMatch(packetSource, /\bssh\b|\bscp\b|\bcurl\b|pm2\s+(?:restart|stop|start)/);
  assert.doesNotMatch(executorSource, /process\.env\.MONGO_URI|mongodb(?:\+srv)?:\/\//);
  assert.doesNotMatch(coordinatorSource, /\bssh\b|\bscp\b|\bcurl\b/);
  assert.match(executorSource, /APPLY_VIVA_GAME_PROJECTION_TENANT_MIGRATION_V1/);
  assert.match(executorSource, /RESTORE_VIVA_GAME_PROJECTION_TENANT_MIGRATION_V1/);
  assert.match(coordinatorShell, /exec 9>"\$\{lock_path\}"[\s\S]+flock -n 9[\s\S]+exec node/);
  assert.match(coordinatorShell, /nohup node[\s\S]+run_viva_game_projection_fence_guardian\.mjs[\s\S]+9>&9/);
  assert.match(guardianSource, /HOLDING_UNTIL_EXPLICIT_RELEASE/);
  assert.match(guardianContractSource, /RELEASE_VIVA_GAME_PROJECTION_CUTOVER_FENCE_V1/);
  assert.match(guardianSource, /quarantineReleaseRequest/);
  assert.match(guardianSource, /waitForAcceptedHandshake[\s\S]+spawn\(process\.execPath[\s\S]+recoveryReleaseDelegated = true/);
  assert.match(guardianSource, /if \(recoveryReleaseDelegated\)[\s\S]+continue;[\s\S]+isAuthorizedFenceGuardianRelease/);
  assert.match(guardianContractSource, /FENCE_INHERITED[\s\S]+renameSync\(requestPath, acceptedPath\)[\s\S]+REQUEST_ACCEPTED/);
  assert.match(guardianSource, /isAuthorizedFenceGuardianRecovery[\s\S]+childStdio\[fd\] = fd[\s\S]+PADLHUB_CUTOVER_GUARDIAN_CHILD/);
  assert.match(guardianSource, /isAuthorizedFenceGuardianReadyFinalization[\s\S]+childStdio\[fd\] = fd[\s\S]+PADLHUB_CUTOVER_GUARDIAN_READY_CHILD/);
  assert.match(recoverySource, /assertExclusiveFenceLease[\s\S]+FENCE_REVALIDATED_DURING_BARRIER_RECOVERY/);
  assert.match(recoverySource, /startRecoveryFenceTakeover[\s\S]+restorePreviousMongoWriteBarrier/);
  assert.match(recoveryTakeoverSource, /HOLDING_UNTIL_EXPLICIT_RELEASE/);
  assert.match(recoveryTakeoverSource, /--recovery-report[\s\S]+isAuthorizedRecoveryFenceTakeoverRelease/);
  assert.doesNotMatch(recoveryTakeoverSource, /isAuthorizedFenceGuardianRelease\s*\(/);
  assert.match(readyFinalizerSource, /requestReadyFinalizationFromGuardian/);
  assert.match(readyFinalizerSource, /recoverAtomicExclusivePublication/);
  assert.match(barrierSource, /BEFORE_VALIDATOR_RESTORE[\s\S]+BEFORE_APPLICATION_ROLES_RESTORE[\s\S]+AFTER_RECOVERY_READBACK/);
  assert.ok(coordinatorSource.indexOf("MIGRATION_PLAN_IN_FLIGHT") < coordinatorSource.indexOf("await runMigration"));
  assert.ok(coordinatorSource.indexOf("installMongoWriteBarrier") < coordinatorSource.indexOf("await runMigration"));
  assert.ok(coordinatorSource.indexOf("hashLiveFullCollection") < coordinatorSource.indexOf("await runMigration"));
  assert.ok(coordinatorSource.indexOf("await runMigration") < coordinatorSource.indexOf("atomicWrite(liveFlowPath"));
  assert.ok(coordinatorSource.indexOf("atomicWrite(liveFlowPath") < coordinatorSource.indexOf("await prepareVivaGameProjectionCutoverPostcheck"));
  assert.ok(coordinatorSource.indexOf("coordinatorJournal.finalize(result)") < coordinatorSource.indexOf("readyPublicationAttempted = true"));
  assert.match(coordinatorSource, /readyPublicationOutcomeUnknown[\s\S]+candidatePublished && !readyPublicationOutcomeUnknown/);
  assert.doesNotMatch(postcheckSource, /READY_TO_REOPEN_INGRESS\.json/);
  assert.match(postcheckSource, /countDocuments\(activeLegacyQuery\)/);
  assert.match(postcheckSource, /assertExclusiveFenceLease[\s\S]+finalNowMs[\s\S]+assertMongoWriteBarrier/);
  assert.match(postcheckSource, /writeFileExclusiveAtomicDurable/);
});

test("a recovery takeover child keeps the inherited flock after guardian SIGKILL", {
  skip: process.platform !== "linux",
}, async () => {
  const privateRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "viva-takeover-flock-")));
  fs.chmodSync(privateRoot, 0o700);
  const lockPath = path.join(privateRoot, "cutover.lock");
  const guardianPath = path.join(privateRoot, "guardian.mjs");
  const keeperPath = path.join(privateRoot, "keeper.mjs");
  const keeperPidPath = path.join(privateRoot, "keeper.pid");
  const releasePath = path.join(privateRoot, "release");
  let guardian = null;
  let keeperPid = null;
  try {
    write0600(keeperPath, Buffer.from(`
      import fs from "node:fs";
      const releasePath = process.argv[2];
      process.on("SIGHUP", () => {});
      process.on("SIGINT", () => {});
      process.on("SIGTERM", () => {});
      while (!fs.existsSync(releasePath)) await new Promise((resolve) => setTimeout(resolve, 25));
    `));
    write0600(guardianPath, Buffer.from(`
      import fs from "node:fs";
      import { spawn } from "node:child_process";
      const [keeperPath, keeperPidPath, releasePath] = process.argv.slice(2);
      const fd = 9;
      const stdio = Array(fd + 1).fill("ignore");
      stdio[fd] = fd;
      const child = spawn(process.execPath, [keeperPath, releasePath], { detached: true, stdio });
      child.unref();
      fs.writeFileSync(keeperPidPath, String(child.pid), { mode: 0o600, flag: "wx" });
      while (true) await new Promise((resolve) => setTimeout(resolve, 1000));
    `));
    guardian = spawn("/bin/bash", [
      "-c",
      "exec 9>\"$1\"\nflock -n 9\nexec node \"$2\" \"$3\" \"$4\" \"$5\"",
      "viva-flock-fixture",
      lockPath,
      guardianPath,
      keeperPath,
      keeperPidPath,
      releasePath,
    ], { stdio: "ignore" });
    for (let poll = 0; poll < 50 && !fs.existsSync(keeperPidPath); poll += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(fs.existsSync(keeperPidPath), true);
    keeperPid = Number(fs.readFileSync(keeperPidPath, "utf8"));
    process.kill(guardian.pid, "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.notEqual(spawnSync("flock", ["-n", lockPath, "-c", "true"], { stdio: "ignore" }).status, 0);
    write0600(releasePath, Buffer.from("release\n"));
    let acquired = false;
    for (let poll = 0; poll < 50 && !acquired; poll += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      acquired = spawnSync("flock", ["-n", lockPath, "-c", "true"], { stdio: "ignore" }).status === 0;
    }
    assert.equal(acquired, true);
  } finally {
    try { if (guardian?.pid) process.kill(guardian.pid, "SIGKILL"); } catch { /* already stopped */ }
    try { if (keeperPid) process.kill(keeperPid, "SIGKILL"); } catch { /* already stopped */ }
    fs.rmSync(privateRoot, { recursive: true, force: true });
  }
});

test("a guardian child accepts only after inheriting the flock and survives guardian SIGKILL before accept", {
  skip: process.platform !== "linux",
}, async () => {
  const privateRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "viva-child-accept-flock-")));
  fs.chmodSync(privateRoot, 0o700);
  const lockPath = path.join(privateRoot, "cutover.lock");
  const requestPath = path.join(privateRoot, "recovery-request.json");
  const requestId = "12345678-1234-4234-8234-123456789abc";
  const acceptedPath = `${requestPath}.accepted-${requestId}`;
  const guardianPath = path.join(privateRoot, "guardian.mjs");
  const childPath = path.join(privateRoot, "child.mjs");
  const childPidPath = path.join(privateRoot, "child.pid");
  const handshakePath = path.join(privateRoot, "handshake.log");
  const releasePath = path.join(privateRoot, "release");
  const contractPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)), "../lib/vivaGameProjectionFenceGuardian.mjs",
  );
  let guardian = null;
  let childPid = null;
  try {
    write0600(requestPath, Buffer.from(canonicalJson({
      kind: "viva-game-projection-fence-recovery-request", requestId,
    })));
    write0600(childPath, Buffer.from(`
      import fs from "node:fs";
      import { pathToFileURL } from "node:url";
      const [contractPath, requestId, releasePath] = process.argv.slice(2);
      await new Promise((resolve) => setTimeout(resolve, 200));
      const { acceptFenceGuardianChildRequest } = await import(pathToFileURL(contractPath).href);
      acceptFenceGuardianChildRequest({ childKind: "recovery", requestId });
      while (!fs.existsSync(releasePath)) await new Promise((resolve) => setTimeout(resolve, 20));
    `));
    write0600(guardianPath, Buffer.from(`
      import fs from "node:fs";
      import { spawn } from "node:child_process";
      import crypto from "node:crypto";
      const [childPath, contractPath, requestPath, acceptedPath, requestId, childPidPath, handshakePath, releasePath, lockPath] = process.argv.slice(2);
      const handshakeFd = 10;
      const handshake = fs.openSync(handshakePath, "wx", 0o600);
      const stdio = Array(handshakeFd + 1).fill("ignore");
      stdio[9] = 9;
      stdio[handshakeFd] = handshake;
      const child = spawn(process.execPath, [childPath, contractPath, requestId, releasePath], {
        detached: true,
        stdio,
        env: {
          ...process.env,
          PADLHUB_CUTOVER_FENCE_FD: "9",
          PADLHUB_CUTOVER_FENCE_LOCK_PATH: lockPath,
          PADLHUB_CUTOVER_GUARDIAN_HANDSHAKE_FD: String(handshakeFd),
          PADLHUB_CUTOVER_GUARDIAN_CHILD_REQUEST_PATH: requestPath,
          PADLHUB_CUTOVER_GUARDIAN_CHILD_ACCEPTED_PATH: acceptedPath,
          PADLHUB_CUTOVER_GUARDIAN_CHILD_REQUEST_SHA256: crypto.createHash("sha256").update(fs.readFileSync(requestPath)).digest("hex"),
        },
      });
      child.unref();
      fs.writeFileSync(childPidPath, String(child.pid), { mode: 0o600, flag: "wx" });
      while (true) await new Promise((resolve) => setTimeout(resolve, 1000));
    `));
    guardian = spawn("/bin/bash", [
      "-c",
      "exec 9>\"$1\"\nflock -n 9\nexec node \"$2\" \"$3\" \"$4\" \"$5\" \"$6\" \"$7\" \"$8\" \"$9\" \"${10}\" \"${11}\"",
      "viva-child-accept-fixture",
      lockPath,
      guardianPath,
      childPath,
      contractPath,
      requestPath,
      acceptedPath,
      requestId,
      childPidPath,
      handshakePath,
      releasePath,
      lockPath,
    ], { stdio: "ignore" });
    for (let poll = 0; poll < 50 && !fs.existsSync(childPidPath); poll += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(fs.existsSync(childPidPath), true);
    childPid = Number(fs.readFileSync(childPidPath, "utf8"));
    process.kill(guardian.pid, "SIGKILL");
    assert.notEqual(spawnSync("flock", ["-n", lockPath, "-c", "true"], { stdio: "ignore" }).status, 0);
    for (let poll = 0; poll < 100 && !fs.existsSync(acceptedPath); poll += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(fs.existsSync(requestPath), false);
    assert.equal(fs.existsSync(acceptedPath), true);
    for (let poll = 0; poll < 50
      && !fs.readFileSync(handshakePath, "utf8").includes("REQUEST_ACCEPTED"); poll += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.match(fs.readFileSync(handshakePath, "utf8"), /FENCE_INHERITED[\s\S]+REQUEST_ACCEPTED/);
    assert.notEqual(spawnSync("flock", ["-n", lockPath, "-c", "true"], { stdio: "ignore" }).status, 0);
    write0600(releasePath, Buffer.from("release\n"));
    let acquired = false;
    for (let poll = 0; poll < 100 && !acquired; poll += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      acquired = spawnSync("flock", ["-n", lockPath, "-c", "true"], { stdio: "ignore" }).status === 0;
    }
    assert.equal(acquired, true);
  } finally {
    try { if (guardian?.pid) process.kill(guardian.pid, "SIGKILL"); } catch { /* already stopped */ }
    try { if (childPid) process.kill(childPid, "SIGKILL"); } catch { /* already stopped */ }
    fs.rmSync(privateRoot, { recursive: true, force: true });
  }
});

test("the real recovery child establishes takeover custody before an accepted validation failure", {
  skip: process.platform !== "linux" || process.getuid?.() !== 0
    || process.env.PADLHUB_RUN_LINUX_FLOCK_TESTS !== "1",
}, async () => {
  const privateRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "viva-real-recovery-takeover-")));
  fs.chmodSync(privateRoot, 0o700);
  const lockPath = "/run/lock/padlhub-viva-game-projection-cutover.lock";
  const guardianPath = path.join(privateRoot, "guardian.mjs");
  const childPidPath = path.join(privateRoot, "recovery-child.pid");
  const handshakePath = path.join(privateRoot, "handshake.log");
  const guardianReceiptPath = path.join(privateRoot, "guardian.json");
  const guardianHeartbeatPath = path.join(privateRoot, "guardian-heartbeat.json");
  const requestPath = path.join(privateRoot, "recovery-request.json");
  const releasePath = path.join(privateRoot, "release.json");
  const reportPath = path.join(privateRoot, "recovery-report.json");
  const recoveryPath = fs.realpathSync(path.resolve(
    path.dirname(fileURLToPath(import.meta.url)), "../recover_viva_game_projection_mongo_write_barrier.mjs",
  ));
  const requestId = "12345678-1234-4234-8234-123456789abc";
  const token = "fixture-fence-token-with-sufficient-entropy";
  let guardian = null;
  let childPid = null;
  let takeoverPid = null;
  try {
    write0600(guardianPath, Buffer.from(`
      import crypto from "node:crypto";
      import fs from "node:fs";
      import { spawn } from "node:child_process";
      const [recoveryPath, receiptPath, heartbeatPath, requestPath, releasePath, reportPath, childPidPath, handshakePath, requestId, lockPath] = process.argv.slice(2);
      const canonical = (value) => JSON.stringify(value, Object.keys(value).sort());
      const digest = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
      const body = fs.readFileSync(\`/proc/\${process.pid}/stat\`, "utf8").trim();
      const tail = body.slice(body.lastIndexOf(")") + 2).split(/\\s+/);
      const processStartIdentity = \`\${process.pid}:\${tail[19]}\`;
      const token = process.env.PADLHUB_CUTOVER_FENCE_TOKEN;
      const lockStat = fs.fstatSync(9);
      const guardian = {
        formatVersion: 1,
        kind: "viva-game-projection-fence-guardian-receipt",
        state: "HOLDING_UNTIL_EXPLICIT_RELEASE",
        pid: process.pid,
        fd: 9,
        processStartIdentity,
        lockPath,
        lockDevice: String(lockStat.dev),
        lockInode: String(lockStat.ino),
        heartbeatPath,
        releaseRequestPath: releasePath,
        recoveryRequestPath: requestPath,
        recoveryExecutorPath: recoveryPath,
        recoveryExecutorSha256: digest(fs.readFileSync(recoveryPath)),
        fenceTokenSha256: digest(token),
        automaticRelease: false,
      };
      const guardianBytes = Buffer.from(JSON.stringify(guardian));
      fs.writeFileSync(receiptPath, guardianBytes, { mode: 0o600, flag: "wx" });
      const guardianSha = digest(guardianBytes);
      const missing = (name) => new URL(name, \`file://\${reportPath}\`).pathname;
      const argv = [
        "--barrier-artifact", missing("missing-barrier.json"),
        "--expected-barrier-artifact-sha256", "a".repeat(64),
        "--cutover-plan", missing("missing-cutover.json"),
        "--expected-cutover-plan-sha256", "b".repeat(64),
        "--migration-connection-file", missing("missing-connection.json"),
        "--execution-index", missing("missing-execution.json"),
        "--expected-execution-index-sha256", "c".repeat(64),
        "--fence-receipt", missing("missing-fence.json"),
        "--expected-fence-receipt-sha256", "d".repeat(64),
        "--fence-guardian-receipt", receiptPath,
        "--expected-fence-guardian-receipt-sha256", guardianSha,
        "--fence-guardian-recovery-request", requestPath,
        "--report", reportPath,
      ];
      const request = {
        formatVersion: 1,
        kind: "viva-game-projection-fence-recovery-request",
        state: "RECOVERY_AUTHORIZED",
        confirmation: "RECOVER_VIVA_GAME_PROJECTION_MONGO_WRITE_BARRIER_V1",
        requestId,
        guardianPid: process.pid,
        guardianProcessStartIdentity: processStartIdentity,
        fenceTokenSha256: guardian.fenceTokenSha256,
        argv,
        authorizedAt: new Date().toISOString(),
      };
      const requestBytes = Buffer.from(JSON.stringify(request));
      fs.writeFileSync(requestPath, requestBytes, { mode: 0o600, flag: "wx" });
      const handshakeFd = 10;
      const handshake = fs.openSync(handshakePath, "wx", 0o600);
      const stdio = Array(handshakeFd + 1).fill("ignore");
      stdio[9] = 9;
      stdio[handshakeFd] = handshake;
      const child = spawn(process.execPath, [recoveryPath, ...argv], {
        stdio,
        env: {
          ...process.env,
          VIVA_GAME_PROJECTION_MONGO_BARRIER_RECOVER: "RECOVER_VIVA_GAME_PROJECTION_MONGO_WRITE_BARRIER_V1",
          PADLHUB_CUTOVER_GUARDIAN_CHILD: "1",
          PADLHUB_CUTOVER_GUARDIAN_RECOVERY_REQUEST_ID: requestId,
          PADLHUB_CUTOVER_GUARDIAN_HANDSHAKE_FD: String(handshakeFd),
          PADLHUB_CUTOVER_GUARDIAN_CHILD_REQUEST_PATH: requestPath,
          PADLHUB_CUTOVER_GUARDIAN_CHILD_ACCEPTED_PATH: \`\${requestPath}.accepted-\${requestId}\`,
          PADLHUB_CUTOVER_GUARDIAN_CHILD_REQUEST_SHA256: digest(requestBytes),
          PADLHUB_CUTOVER_FENCE_FD: "9",
          PADLHUB_CUTOVER_FENCE_LOCK_PATH: lockPath,
        },
      });
      fs.closeSync(handshake);
      fs.writeFileSync(childPidPath, String(child.pid), { mode: 0o600, flag: "wx" });
      while (true) await new Promise((resolve) => setTimeout(resolve, 1000));
    `));
    guardian = spawn("/bin/bash", [
      "-c",
      "exec 9>\"$1\"\nflock -n 9\nexec node \"$2\" \"$3\" \"$4\" \"$5\" \"$6\" \"$7\" \"$8\" \"$9\" \"${10}\" \"${11}\" \"${12}\" \"${13}\"",
      "viva-real-recovery-takeover",
      lockPath,
      guardianPath,
      recoveryPath,
      guardianReceiptPath,
      guardianHeartbeatPath,
      requestPath,
      releasePath,
      reportPath,
      childPidPath,
      handshakePath,
      requestId,
      lockPath,
    ], { stdio: "ignore", env: { ...process.env, PADLHUB_CUTOVER_FENCE_TOKEN: token } });
    const acceptedPath = `${requestPath}.accepted-${requestId}`;
    const takeoverReceiptPath = path.join(privateRoot, `.viva-recovery-fence-takeover-${requestId}.json`);
    for (let poll = 0; poll < 150 && (!fs.existsSync(acceptedPath) || !fs.existsSync(takeoverReceiptPath)); poll += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(fs.existsSync(acceptedPath), true);
    assert.equal(fs.existsSync(takeoverReceiptPath), true);
    childPid = Number(fs.readFileSync(childPidPath, "utf8"));
    takeoverPid = JSON.parse(fs.readFileSync(takeoverReceiptPath, "utf8")).pid;
    process.kill(guardian.pid, "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.notEqual(spawnSync("flock", ["-n", lockPath, "-c", "true"], { stdio: "ignore" }).status, 0);
    assert.match(
      fs.readFileSync(handshakePath, "utf8"),
      /TAKEOVER_ESTABLISHED[\s\S]+FENCE_INHERITED[\s\S]+REQUEST_ACCEPTED/,
    );
  } finally {
    try { if (guardian?.pid) process.kill(guardian.pid, "SIGKILL"); } catch { /* already stopped */ }
    try { if (childPid) process.kill(childPid, "SIGKILL"); } catch { /* already stopped */ }
    try { if (takeoverPid) process.kill(takeoverPid, "SIGKILL"); } catch { /* already stopped */ }
    fs.rmSync(privateRoot, { recursive: true, force: true });
  }
});

test("the real guardian adopts one live takeover after its recovery child dies before accept", {
  skip: process.platform !== "linux" || process.getuid?.() !== 0
    || process.env.PADLHUB_RUN_LINUX_FLOCK_TESTS !== "1",
}, async () => {
  const privateRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "viva-real-guardian-retry-")));
  fs.chmodSync(privateRoot, 0o700);
  const lockPath = "/run/lock/padlhub-viva-game-projection-cutover.lock";
  const guardianScript = fs.realpathSync(path.resolve(
    path.dirname(fileURLToPath(import.meta.url)), "../run_viva_game_projection_fence_guardian.mjs",
  ));
  const receiptPath = path.join(privateRoot, "guardian.json");
  const heartbeatPath = path.join(privateRoot, "guardian-heartbeat.json");
  const requestPath = path.join(privateRoot, "recovery-request.json");
  const readyPath = path.join(privateRoot, "ready-request.json");
  const releasePath = path.join(privateRoot, "release.json");
  const reportPath = path.join(privateRoot, "recovery-report.json");
  const firstRequestId = "12345678-1234-4234-8234-123456789abc";
  const unusedFreshRequestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const token = "fixture-fence-token-with-sufficient-entropy";
  const previousConfirmation = process.env.VIVA_GAME_PROJECTION_MONGO_BARRIER_RECOVER;
  let guardian = null;
  let takeoverPid = null;
  let watcher = null;
  try {
    guardian = spawn("/bin/bash", [
      "-c",
      "exec 9>\"$1\"\nflock -n 9\nexec node \"$2\" --receipt \"$3\" --release-request \"$4\" --recovery-request \"$5\" --ready-request \"$6\" --heartbeat \"$7\"",
      "viva-real-guardian-retry",
      lockPath,
      guardianScript,
      receiptPath,
      releasePath,
      requestPath,
      readyPath,
      heartbeatPath,
    ], {
      stdio: "ignore",
      env: {
        ...process.env,
        PADLHUB_CUTOVER_FENCE_FD: "9",
        PADLHUB_CUTOVER_FENCE_LOCK_PATH: lockPath,
        PADLHUB_CUTOVER_FENCE_TOKEN: token,
      },
    });
    for (let poll = 0; poll < 100 && (!fs.existsSync(receiptPath) || !fs.existsSync(heartbeatPath)); poll += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const guardianBytes = fs.readFileSync(receiptPath);
    const options = {
      barrierArtifact: path.join(privateRoot, "missing-barrier.json"),
      expectedBarrierArtifactSha256: "a".repeat(64),
      cutoverPlan: path.join(privateRoot, "missing-cutover.json"),
      expectedCutoverPlanSha256: "b".repeat(64),
      migrationConnectionFile: path.join(privateRoot, "missing-connection.json"),
      executionIndex: path.join(privateRoot, "missing-execution.json"),
      expectedExecutionIndexSha256: "c".repeat(64),
      fenceReceipt: path.join(privateRoot, "missing-fence.json"),
      expectedFenceReceiptSha256: "d".repeat(64),
      fenceGuardianReceipt: receiptPath,
      expectedFenceGuardianReceiptSha256: cutoverSha256(guardianBytes),
      fenceGuardianRecoveryRequest: requestPath,
      report: reportPath,
    };
    const argv = Object.entries({
      "--barrier-artifact": options.barrierArtifact,
      "--expected-barrier-artifact-sha256": options.expectedBarrierArtifactSha256,
      "--cutover-plan": options.cutoverPlan,
      "--expected-cutover-plan-sha256": options.expectedCutoverPlanSha256,
      "--migration-connection-file": options.migrationConnectionFile,
      "--execution-index": options.executionIndex,
      "--expected-execution-index-sha256": options.expectedExecutionIndexSha256,
      "--fence-receipt": options.fenceReceipt,
      "--expected-fence-receipt-sha256": options.expectedFenceReceiptSha256,
      "--fence-guardian-receipt": options.fenceGuardianReceipt,
      "--expected-fence-guardian-receipt-sha256": options.expectedFenceGuardianReceiptSha256,
      "--fence-guardian-recovery-request": options.fenceGuardianRecoveryRequest,
      "--report": options.report,
    }).flat();
    process.env.VIVA_GAME_PROJECTION_MONGO_BARRIER_RECOVER = "RECOVER_VIVA_GAME_PROJECTION_MONGO_WRITE_BARRIER_V1";
    const takeoverReceiptPath = path.join(privateRoot, `.viva-recovery-fence-takeover-${firstRequestId}.json`);
    let killedRecoveryChildPid = null;
    const killedBeforeAccept = new Promise((resolve, reject) => {
      watcher = fs.watch(privateRoot, (_event, filename) => {
        if (filename !== path.basename(takeoverReceiptPath) || killedRecoveryChildPid) return;
        try {
          const children = fs.readFileSync(
            `/proc/${guardian.pid}/task/${guardian.pid}/children`, "utf8",
          ).trim().split(/\s+/).filter(Boolean).map(Number);
          assert.equal(children.length, 1);
          [killedRecoveryChildPid] = children;
          process.kill(killedRecoveryChildPid, "SIGKILL");
          resolve();
        } catch (error) { reject(error); }
      });
    });
    const firstRequest = assert.rejects(requestRecoveryFromGuardian(argv, options, {
      getUid: () => 0,
      requestId: firstRequestId,
      maximumPolls: 80,
    }), /recovery child failed/);
    await Promise.race([
      killedBeforeAccept,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Did not intercept pre-accept recovery child")), 5_000)),
    ]);
    await firstRequest;
    watcher.close();
    watcher = null;
    assert.equal(fs.existsSync(`${requestPath}.accepted-${firstRequestId}`), false);
    for (let poll = 0; poll < 100; poll += 1) {
      const heartbeat = JSON.parse(fs.readFileSync(heartbeatPath, "utf8"));
      if (heartbeat.recoveryReleaseDelegated && heartbeat.recoveryRequestId === firstRequestId) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const delegatedHeartbeat = JSON.parse(fs.readFileSync(heartbeatPath, "utf8"));
    assert.equal(delegatedHeartbeat.recoveryReleaseDelegated, true);
    assert.equal(delegatedHeartbeat.recoveryRequestId, firstRequestId);
    const firstTakeoverReceipt = JSON.parse(fs.readFileSync(takeoverReceiptPath, "utf8"));
    takeoverPid = firstTakeoverReceipt.pid;
    write0600(releasePath, Buffer.from(canonicalJson({
      formatVersion: 1,
      kind: "viva-game-projection-fence-release-request",
      state: "RELEASE_AUTHORIZED",
      confirmation: "RELEASE_VIVA_GAME_PROJECTION_CUTOVER_FENCE_V1",
      fenceTokenSha256: cutoverSha256(token),
      authorizedAt: new Date().toISOString(),
    })));
    await new Promise((resolve) => setTimeout(resolve, 1100));
    process.kill(guardian.pid, 0);
    assert.equal(fs.existsSync(releasePath), true);
    await assert.rejects(requestRecoveryFromGuardian(argv, options, {
      getUid: () => 0,
      requestId: unusedFreshRequestId,
      maximumPolls: 40,
    }), /recovery child failed/);
    const acceptedNames = fs.readdirSync(privateRoot).filter((name) => name.startsWith("recovery-request.json.accepted-"));
    const takeoverReceiptNames = fs.readdirSync(privateRoot)
      .filter((name) => /^\.viva-recovery-fence-takeover-[^.]+\.json$/.test(name));
    assert.deepEqual(acceptedNames, [`recovery-request.json.accepted-${firstRequestId}`]);
    assert.deepEqual(takeoverReceiptNames, [`.viva-recovery-fence-takeover-${firstRequestId}.json`]);
    assert.equal(JSON.parse(fs.readFileSync(takeoverReceiptPath, "utf8")).pid, takeoverPid);
    process.kill(guardian.pid, "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.notEqual(spawnSync("flock", ["-n", lockPath, "-c", "true"], { stdio: "ignore" }).status, 0);
  } finally {
    if (previousConfirmation === undefined) delete process.env.VIVA_GAME_PROJECTION_MONGO_BARRIER_RECOVER;
    else process.env.VIVA_GAME_PROJECTION_MONGO_BARRIER_RECOVER = previousConfirmation;
    try { if (guardian?.pid) process.kill(guardian.pid, "SIGKILL"); } catch { /* already stopped */ }
    try { if (takeoverPid) process.kill(takeoverPid, "SIGKILL"); } catch { /* already stopped */ }
    try { watcher?.close(); } catch { /* already closed */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
    fs.rmSync(privateRoot, { recursive: true, force: true });
  }
});

test("the real guardian releases terminal fallback only after the exact takeover is dead", {
  skip: process.platform !== "linux" || process.getuid?.() !== 0
    || process.env.PADLHUB_RUN_LINUX_FLOCK_TESTS !== "1",
}, async () => {
  const privateRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "viva-terminal-guardian-fallback-")));
  fs.chmodSync(privateRoot, 0o700);
  const lockPath = "/run/lock/padlhub-viva-game-projection-cutover.lock";
  const repoRoot = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."));
  const guardianScript = fs.realpathSync(path.join(repoRoot, "scripts/run_viva_game_projection_fence_guardian.mjs"));
  const receiptPath = path.join(privateRoot, "guardian.json");
  const heartbeatPath = path.join(privateRoot, "guardian-heartbeat.json");
  const requestPath = path.join(privateRoot, "recovery-request.json");
  const readyPath = path.join(privateRoot, "ready-request.json");
  const releasePath = path.join(privateRoot, "release.json");
  const reportPath = path.join(privateRoot, "recovery-report.json");
  const requestId = "12345678-1234-4234-8234-123456789abc";
  const attemptId = "87654321-4321-4321-8321-cba987654321";
  const token = "fixture-fence-token-with-sufficient-entropy";
  let guardian = null;
  let recoveryPid = null;
  let takeoverPid = null;
  let watcher = null;
  try {
    guardian = spawn("/bin/bash", [
      "-c",
      "exec 9>\"$1\"\nflock -n 9\nexec node \"$2\" --receipt \"$3\" --release-request \"$4\" --recovery-request \"$5\" --ready-request \"$6\" --heartbeat \"$7\"",
      "viva-terminal-guardian-fallback",
      lockPath,
      guardianScript,
      receiptPath,
      releasePath,
      requestPath,
      readyPath,
      heartbeatPath,
    ], {
      stdio: "ignore",
      env: {
        ...process.env,
        VIVA_GAME_PROJECTION_MONGO_BARRIER_RECOVER: "RECOVER_VIVA_GAME_PROJECTION_MONGO_WRITE_BARRIER_V1",
        PADLHUB_CUTOVER_FENCE_FD: "9",
        PADLHUB_CUTOVER_FENCE_LOCK_PATH: lockPath,
        PADLHUB_CUTOVER_FENCE_TOKEN: token,
      },
    });
    for (let poll = 0; poll < 100 && (!fs.existsSync(receiptPath) || !fs.existsSync(heartbeatPath)); poll += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const guardianBytes = fs.readFileSync(receiptPath);
    const guardianReceipt = JSON.parse(guardianBytes.toString("utf8"));
    const guardianSha256 = cutoverSha256(guardianBytes);
    const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).stdout.trim();
    const executorPaths = [
      "scripts/recover_viva_game_projection_mongo_write_barrier.mjs",
      "scripts/run_viva_game_projection_fence_guardian.mjs",
      "scripts/run_viva_game_projection_recovery_fence_takeover.mjs",
      "scripts/prepare_viva_game_projection_cutover_postcheck.mjs",
      "scripts/run_viva_game_projection_tenant_migration.mjs",
      "scripts/lib/vivaGameProjectionCutoverContract.mjs",
      "scripts/lib/vivaGameProjectionExecutorSource.mjs",
      "scripts/lib/vivaGameProjectionFenceGuardian.mjs",
    ];
    const executorSources = executorPaths.map((relativePath) => ({
      path: relativePath,
      sha256: cutoverSha256(fs.readFileSync(path.join(repoRoot, relativePath))),
    }));
    const localUri = "mongodb://127.0.0.1:27017/?directConnection=true";
    const plan = {
      formatVersion: 1,
      kind: "viva-game-projection-tenant-cutover-plan",
      state: "READY_FOR_SEPARATE_LIVE_APPROVAL",
      liveMutationAuthorized: false,
      repository: { commit: head },
      tenantKeySha256: cutoverSha256(tenantKey),
      executorSources,
      executorSourcesSha256: cutoverSha256(canonicalJson(executorSources)),
      production: { hostname: os.hostname() },
      mongoTarget: { migrationConnectionFingerprint: cutoverSha256(localUri) },
    };
    const cutoverPath = path.join(privateRoot, "cutover-plan.json");
    const cutoverBytes = Buffer.from(canonicalJson(plan));
    write0600(cutoverPath, cutoverBytes);
    const cutoverPlanSha256 = cutoverSha256(cutoverBytes);
    const barrierOutputPath = path.join(privateRoot, "barrier.json");
    const barrierPath = `${barrierOutputPath}.prepared`;
    const barrierBytes = Buffer.from(canonicalJson({
      kind: "viva-game-projection-mongo-write-barrier-preparation",
      cutoverPlanSha256,
    }));
    write0600(barrierPath, barrierBytes);
    const fencePath = path.join(privateRoot, "fence.json");
    const fenceBytes = Buffer.from(canonicalJson({ state: "HELD" }));
    write0600(fencePath, fenceBytes);
    const connectionPath = path.join(privateRoot, "migration.json");
    const connectionBytes = Buffer.from(canonicalJson({
      formatVersion: 1,
      kind: "viva-game-projection-migration-mongo-connection",
      uri: localUri,
    }));
    write0600(connectionPath, connectionBytes);
    const executionPath = path.join(privateRoot, "execution-index.json");
    const executionBytes = Buffer.from(canonicalJson({
      formatVersion: 1,
      kind: "viva-game-projection-cutover-execution-index",
      cutoverPlanPath: cutoverPath,
      cutoverPlanSha256,
      fenceReceiptPath: fencePath,
      fenceReceiptSha256: cutoverSha256(fenceBytes),
      migrationConnectionFile: connectionPath,
      migrationConnectionFileSha256: cutoverSha256(connectionBytes),
      mongoWriteBarrierReceiptOutputPath: barrierOutputPath,
      tenantKey,
    }));
    write0600(executionPath, executionBytes);
    const options = {
      barrierArtifact: barrierPath,
      expectedBarrierArtifactSha256: cutoverSha256(barrierBytes),
      cutoverPlan: cutoverPath,
      expectedCutoverPlanSha256: cutoverPlanSha256,
      migrationConnectionFile: connectionPath,
      executionIndex: executionPath,
      expectedExecutionIndexSha256: cutoverSha256(executionBytes),
      fenceReceipt: fencePath,
      expectedFenceReceiptSha256: cutoverSha256(fenceBytes),
      fenceGuardianReceipt: receiptPath,
      expectedFenceGuardianReceiptSha256: guardianSha256,
      fenceGuardianRecoveryRequest: requestPath,
      report: reportPath,
    };
    const argv = Object.entries({
      "--barrier-artifact": options.barrierArtifact,
      "--expected-barrier-artifact-sha256": options.expectedBarrierArtifactSha256,
      "--cutover-plan": options.cutoverPlan,
      "--expected-cutover-plan-sha256": options.expectedCutoverPlanSha256,
      "--migration-connection-file": options.migrationConnectionFile,
      "--execution-index": options.executionIndex,
      "--expected-execution-index-sha256": options.expectedExecutionIndexSha256,
      "--fence-receipt": options.fenceReceipt,
      "--expected-fence-receipt-sha256": options.expectedFenceReceiptSha256,
      "--fence-guardian-receipt": options.fenceGuardianReceipt,
      "--expected-fence-guardian-receipt-sha256": options.expectedFenceGuardianReceiptSha256,
      "--fence-guardian-recovery-request": options.fenceGuardianRecoveryRequest,
      "--report": options.report,
    }).flat();
    const takeoverReceiptPath = path.join(privateRoot, `.viva-recovery-fence-takeover-${requestId}.json`);
    const recoveryStopped = new Promise((resolve, reject) => {
      watcher = fs.watch(privateRoot, (_event, filename) => {
        if (filename !== path.basename(takeoverReceiptPath) || recoveryPid) return;
        try {
          const children = fs.readFileSync(`/proc/${guardian.pid}/task/${guardian.pid}/children`, "utf8")
            .trim().split(/\s+/).filter(Boolean).map(Number);
          assert.equal(children.length, 1);
          [recoveryPid] = children;
          process.kill(recoveryPid, "SIGSTOP");
          resolve();
        } catch (error) { reject(error); }
      });
    });
    write0600(requestPath, Buffer.from(canonicalJson({
      formatVersion: 1,
      kind: "viva-game-projection-fence-recovery-request",
      state: "RECOVERY_AUTHORIZED",
      confirmation: "RECOVER_VIVA_GAME_PROJECTION_MONGO_WRITE_BARRIER_V1",
      requestId,
      guardianPid: guardianReceipt.pid,
      guardianProcessStartIdentity: guardianReceipt.processStartIdentity,
      fenceTokenSha256: guardianReceipt.fenceTokenSha256,
      argv,
      authorizedAt: new Date().toISOString(),
    })));
    await Promise.race([
      recoveryStopped,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Did not stop terminal recovery child")), 5_000)),
    ]);
    watcher.close();
    watcher = null;
    for (let poll = 0; poll < 100 && !fs.existsSync(takeoverReceiptPath); poll += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const takeoverBytes = fs.readFileSync(takeoverReceiptPath);
    const takeoverReceipt = JSON.parse(takeoverBytes.toString("utf8"));
    takeoverPid = takeoverReceipt.pid;
    for (let poll = 0; poll < 100 && !fs.existsSync(takeoverReceipt.heartbeatPath); poll += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(fs.existsSync(takeoverReceipt.heartbeatPath), true);
    process.kill(takeoverPid, "SIGSTOP");
    const bindings = {
      barrierArtifactSha256: options.expectedBarrierArtifactSha256,
      cutoverPlanSha256: options.expectedCutoverPlanSha256,
      executionIndexSha256: options.expectedExecutionIndexSha256,
      fenceReceiptSha256: options.expectedFenceReceiptSha256,
      fenceGuardianReceiptSha256: options.expectedFenceGuardianReceiptSha256,
    };
    const journalPath = `${reportPath}.journal`;
    fs.mkdirSync(journalPath, { mode: 0o700 });
    const report = {
      formatVersion: 1,
      kind: "viva-game-projection-mongo-write-barrier-recovery-receipt",
      state: "RELEASED_TO_EXACT_PREIMAGE",
      recoveryAttemptId: attemptId,
      recoveryJournalPath: journalPath,
      guardianRecoveryRequestId: requestId,
      recoveryFenceTakeoverState: "HELD_UNTIL_EXPLICIT_FENCE_RELEASE",
      recoveryFenceTakeoverReceiptPath: takeoverReceiptPath,
      recoveryFenceTakeoverReceiptSha256: cutoverSha256(takeoverBytes),
      ...bindings,
    };
    const reportBytes = Buffer.from(canonicalJson(report));
    const terminalDetail = {
      state: report.state,
      mutationAttempted: true,
      reportSha256: cutoverSha256(reportBytes),
      reportBytesBase64: reportBytes.toString("base64"),
      report,
    };
    write0600(path.join(journalPath, "0000-attempt-started.json"), Buffer.from(canonicalJson({
      formatVersion: 1, attemptId, mode: "BARRIER_RECOVERY", sequence: 0,
      at: new Date().toISOString(), phase: "ATTEMPT_STARTED", ...bindings,
    })));
    write0600(path.join(journalPath, "0001-terminal-result-intent.json"), Buffer.from(canonicalJson({
      formatVersion: 1, attemptId, mode: "BARRIER_RECOVERY", sequence: 1,
      at: new Date().toISOString(), phase: "TERMINAL_RESULT_INTENT", ...terminalDetail,
    })));
    const terminalBytes = Buffer.from(canonicalJson({
      formatVersion: 1, attemptId, mode: "BARRIER_RECOVERY", sequence: 2,
      at: new Date().toISOString(), phase: "TERMINAL_RESULT", ...terminalDetail,
    }));
    write0600(path.join(journalPath, "0002-terminal-result.json"), terminalBytes);
    write0600(reportPath, reportBytes);
    process.kill(recoveryPid, "SIGCONT");
    for (let poll = 0; poll < 250; poll += 1) {
      const heartbeat = JSON.parse(fs.readFileSync(heartbeatPath, "utf8"));
      if (heartbeat.lastRecoveryResult?.requestId === requestId && heartbeat.lastRecoveryResult.exitCode === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const completedHeartbeat = JSON.parse(fs.readFileSync(heartbeatPath, "utf8"));
    assert.equal(completedHeartbeat.lastRecoveryResult?.exitCode, 0);
    process.kill(takeoverPid, "SIGKILL");
    for (let poll = 0; poll < 250; poll += 1) {
      const heartbeat = JSON.parse(fs.readFileSync(heartbeatPath, "utf8"));
      if (heartbeat.recoveryTerminalGuardianFallback?.state === "HOLDING_TERMINAL_RECOVERY_FALLBACK") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const fallbackHeartbeat = JSON.parse(fs.readFileSync(heartbeatPath, "utf8"));
    assert.equal(fallbackHeartbeat.recoveryTerminalGuardianFallback?.recoveryRequestId, requestId);
    assert.notEqual(spawnSync("flock", ["-n", lockPath, "-c", "true"], { stdio: "ignore" }).status, 0);
    const resumed = await requestRecoveryFromGuardian(argv, options, {
      getUid: () => 0,
      maximumPolls: 1,
    });
    assert.equal(resumed.guardianRecoveryRequestId, requestId);
    write0600(releasePath, Buffer.from(canonicalJson({
      formatVersion: 1,
      kind: "viva-game-projection-fence-release-request",
      state: "RELEASE_AUTHORIZED",
      confirmation: "RELEASE_VIVA_GAME_PROJECTION_CUTOVER_FENCE_V1",
      fenceTokenSha256: cutoverSha256(token),
      authorizedAt: new Date().toISOString(),
    })));
    for (let poll = 0; poll < 150 && fs.existsSync(releasePath); poll += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    process.kill(guardian.pid, 0);
    assert.equal(fs.existsSync(releasePath), false);
    assert.notEqual(spawnSync("flock", ["-n", lockPath, "-c", "true"], { stdio: "ignore" }).status, 0);
    write0600(releasePath, Buffer.from(canonicalJson({
      formatVersion: 1,
      kind: "viva-game-projection-fence-release-request",
      state: "RELEASE_AUTHORIZED",
      confirmation: "RELEASE_VIVA_GAME_PROJECTION_CUTOVER_FENCE_V1",
      fenceTokenSha256: cutoverSha256(token),
      recoveryRequestId: requestId,
      recoveryReportPath: reportPath,
      recoveryReportSha256: cutoverSha256(reportBytes),
      recoveryTerminalJournalSha256: cutoverSha256(terminalBytes),
      recoveryFenceTakeoverReceiptSha256: cutoverSha256(takeoverBytes),
      authorizedAt: new Date().toISOString(),
    })));
    await new Promise((resolve) => guardian.once("close", resolve));
    guardian = null;
    assert.equal(spawnSync("flock", ["-n", lockPath, "-c", "true"], { stdio: "ignore" }).status, 0);
  } finally {
    try { if (guardian?.pid) process.kill(guardian.pid, "SIGKILL"); } catch { /* already stopped */ }
    try { if (recoveryPid) process.kill(recoveryPid, "SIGKILL"); } catch { /* already stopped */ }
    try { if (takeoverPid) process.kill(takeoverPid, "SIGKILL"); } catch { /* already stopped */ }
    try { watcher?.close(); } catch { /* already closed */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
    fs.rmSync(privateRoot, { recursive: true, force: true });
  }
});

test("the real takeover waits for guardian handoff and exact release frees the final flock", {
  skip: process.platform !== "linux" || process.getuid?.() !== 0
    || process.env.PADLHUB_RUN_LINUX_FLOCK_TESTS !== "1",
}, async () => {
  const privateRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "viva-takeover-release-")));
  fs.chmodSync(privateRoot, 0o700);
  const lockPath = "/run/lock/padlhub-viva-game-projection-cutover.lock";
  const guardianPath = path.join(privateRoot, "guardian.mjs");
  const exitPath = path.join(privateRoot, "guardian-exit");
  const receiptPath = path.join(privateRoot, "takeover.json");
  const heartbeatPath = path.join(privateRoot, "takeover-heartbeat.json");
  const releasePath = path.join(privateRoot, "release.json");
  const reportPath = path.join(privateRoot, "recovery-report.json");
  const takeoverPath = fs.realpathSync(path.resolve(
    path.dirname(fileURLToPath(import.meta.url)), "../run_viva_game_projection_recovery_fence_takeover.mjs",
  ));
  const requestId = "12345678-1234-4234-8234-123456789abc";
  const token = "fixture-fence-token-with-sufficient-entropy";
  let guardian = null;
  let takeoverPid = null;
  try {
    write0600(guardianPath, Buffer.from(`
      import fs from "node:fs";
      import { spawn } from "node:child_process";
      const [takeoverPath, receiptPath, heartbeatPath, releasePath, reportPath, exitPath, requestId, lockPath] = process.argv.slice(2);
      const body = fs.readFileSync(\`/proc/\${process.pid}/stat\`, "utf8").trim();
      const tail = body.slice(body.lastIndexOf(")") + 2).split(/\\s+/);
      const identity = \`\${process.pid}:\${tail[19]}\`;
      const stdio = Array(10).fill("ignore");
      stdio[9] = 9;
      const child = spawn(process.execPath, [takeoverPath,
        "--receipt", receiptPath,
        "--heartbeat", heartbeatPath,
        "--release-request", releasePath,
        "--recovery-report", reportPath,
        "--parent-guardian-receipt-sha256", "a".repeat(64),
        "--parent-guardian-pid", String(process.pid),
        "--parent-guardian-process-start-identity", identity,
        "--recovery-request-id", requestId,
      ], { detached: true, stdio, env: process.env });
      child.unref();
      while (!fs.existsSync(exitPath)) await new Promise((resolve) => setTimeout(resolve, 20));
    `));
    guardian = spawn("/bin/bash", [
      "-c",
      "exec 9>\"$1\"\nflock -n 9\nexec node \"$2\" \"$3\" \"$4\" \"$5\" \"$6\" \"$7\" \"$8\" \"$9\" \"${10}\"",
      "viva-takeover-release",
      lockPath,
      guardianPath,
      takeoverPath,
      receiptPath,
      heartbeatPath,
      releasePath,
      reportPath,
      exitPath,
      requestId,
      lockPath,
    ], {
      stdio: "ignore",
      env: {
        ...process.env,
        PADLHUB_CUTOVER_FENCE_FD: "9",
        PADLHUB_CUTOVER_FENCE_LOCK_PATH: lockPath,
        PADLHUB_CUTOVER_FENCE_TOKEN: token,
      },
    });
    for (let poll = 0; poll < 100 && (!fs.existsSync(receiptPath) || !fs.existsSync(heartbeatPath)); poll += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const takeoverReceiptBytes = fs.readFileSync(receiptPath);
    const takeoverReceipt = JSON.parse(takeoverReceiptBytes.toString("utf8"));
    takeoverPid = takeoverReceipt.pid;
    const journalPath = `${reportPath}.journal`;
    fs.mkdirSync(journalPath, { mode: 0o700 });
    const attemptId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const report = {
      formatVersion: 1,
      kind: "viva-game-projection-mongo-write-barrier-recovery-receipt",
      state: "RELEASED_TO_EXACT_PREIMAGE",
      recoveryAttemptId: attemptId,
      recoveryJournalPath: journalPath,
      guardianRecoveryRequestId: requestId,
      recoveryFenceTakeoverState: "HELD_UNTIL_EXPLICIT_FENCE_RELEASE",
      recoveryFenceTakeoverReceiptPath: receiptPath,
      recoveryFenceTakeoverReceiptSha256: cutoverSha256(takeoverReceiptBytes),
    };
    const reportBytes = Buffer.from(canonicalJson(report));
    write0600(reportPath, reportBytes);
    const terminal = {
      formatVersion: 1,
      attemptId,
      mode: "BARRIER_RECOVERY",
      sequence: 1,
      at: new Date().toISOString(),
      phase: "TERMINAL_RESULT",
      reportSha256: cutoverSha256(reportBytes),
      reportBytesBase64: reportBytes.toString("base64"),
      report,
    };
    const terminalBytes = Buffer.from(canonicalJson(terminal));
    write0600(path.join(journalPath, "0001-terminal-result.json"), terminalBytes);
    write0600(releasePath, Buffer.from(canonicalJson({
      formatVersion: 1,
      kind: "viva-game-projection-fence-release-request",
      state: "RELEASE_AUTHORIZED",
      confirmation: "RELEASE_VIVA_GAME_PROJECTION_CUTOVER_FENCE_V1",
      fenceTokenSha256: cutoverSha256(token),
      recoveryRequestId: requestId,
      recoveryReportPath: reportPath,
      recoveryReportSha256: cutoverSha256(reportBytes),
      recoveryTerminalJournalSha256: cutoverSha256(terminalBytes),
      recoveryFenceTakeoverReceiptSha256: cutoverSha256(takeoverReceiptBytes),
      authorizedAt: new Date().toISOString(),
    })));
    await new Promise((resolve) => setTimeout(resolve, 1200));
    process.kill(takeoverPid, 0);
    assert.equal(fs.existsSync(releasePath), true);
    assert.notEqual(spawnSync("flock", ["-n", lockPath, "-c", "true"], { stdio: "ignore" }).status, 0);
    write0600(exitPath, Buffer.from("handoff\n"));
    await new Promise((resolve) => guardian.once("close", resolve));
    let acquired = false;
    for (let poll = 0; poll < 150 && !acquired; poll += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      acquired = spawnSync("flock", ["-n", lockPath, "-c", "true"], { stdio: "ignore" }).status === 0;
    }
    assert.equal(acquired, true);
  } finally {
    try { if (guardian?.pid) process.kill(guardian.pid, "SIGKILL"); } catch { /* already stopped */ }
    try { if (takeoverPid) process.kill(takeoverPid, "SIGKILL"); } catch { /* already stopped */ }
    fs.rmSync(privateRoot, { recursive: true, force: true });
  }
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
      "0002-terminal-result-intent.json",
      "0003-terminal-result.json",
    ]);
    const exactReportBytes = fs.readFileSync(reportPath);
    const exactReportSha256 = cutoverSha256(exactReportBytes);
    fs.unlinkSync(reportPath);
    const recoveredMissing = recoverDurableTerminalReport(reportPath, "APPLY", exactReportSha256);
    assert.equal(recoveredMissing.sha256, exactReportSha256);
    fs.writeFileSync(reportPath, exactReportBytes.subarray(0, Math.floor(exactReportBytes.length / 2)), { mode: 0o600 });
    const recoveredPartial = recoverDurableTerminalReport(reportPath, "APPLY", exactReportSha256);
    assert.deepEqual(recoveredPartial.bytes, exactReportBytes);
    fs.unlinkSync(reportPath);
    const terminalJournalPath = path.join(`${reportPath}.journal`, "0003-terminal-result.json");
    const terminalJournalBytes = fs.readFileSync(terminalJournalPath);
    fs.unlinkSync(terminalJournalPath);
    fs.writeFileSync(terminalJournalPath, terminalJournalBytes.subarray(0, 16), { mode: 0o600 });
    const recoveredPartialTerminal = recoverDurableTerminalReport(reportPath, "APPLY", exactReportSha256);
    assert.deepEqual(recoveredPartialTerminal.bytes, exactReportBytes);
    assert.equal(JSON.parse(fs.readFileSync(terminalJournalPath, "utf8")).phase, "TERMINAL_RESULT");
    fs.unlinkSync(reportPath);
    const rebuiltTerminalBytes = fs.readFileSync(terminalJournalPath);
    fs.unlinkSync(terminalJournalPath);
    const orphanTerminalPath = path.join(
      `${reportPath}.journal`, `.0003-terminal-result.json.${process.pid}.${crypto.randomUUID()}.tmp`,
    );
    fs.writeFileSync(orphanTerminalPath, rebuiltTerminalBytes.subarray(0, 16), { mode: 0o600 });
    const recoveredOrphanTerminal = recoverDurableTerminalReport(reportPath, "APPLY", exactReportSha256);
    assert.deepEqual(recoveredOrphanTerminal.bytes, exactReportBytes);
    assert.equal(fs.existsSync(orphanTerminalPath), false);
    const failedReportPath = path.join(privateRoot, "cutover-finalize-failure.json");
    const failedJournal = createDurableReportJournal(failedReportPath, "cutover", "fixture-cutover-attempt");
    fs.mkdirSync(failedReportPath, { mode: 0o700 });
    assert.throws(() => failedJournal.finalize({
      state: "FAILED_MONGO_BARRIER_HELD_RUNTIME_STOPPED", mutationAttempted: true,
    }));
    const terminal = JSON.parse(fs.readFileSync(
      path.join(`${failedReportPath}.journal`, "0002-terminal-result.json"), "utf8",
    ));
    assert.equal(terminal.outcome, "FAILED_MONGO_BARRIER_HELD_RUNTIME_STOPPED");
    assert.equal(terminal.mutationAttempted, true);
    const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    assert.throws(() => ensurePrivateDirectory(path.join(repositoryRoot, "tmp-cutover-output"), "Fixture"), /outside the repository/);
  } finally {
    fs.rmSync(privateRoot, { recursive: true, force: true });
  }
});

test("recovery journal publishes one exact private next-sequence orphan for every nonterminal append", () => {
  const privateRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "viva-recovery-orphans-")));
  fs.chmodSync(privateRoot, 0o700);
  const bindings = {
    barrierArtifactSha256: "1".repeat(64),
    cutoverPlanSha256: "2".repeat(64),
    executionIndexSha256: "3".repeat(64),
    fenceReceiptSha256: "4".repeat(64),
    fenceGuardianReceiptSha256: "5".repeat(64),
  };
  const cases = [
    { phase: "ATTEMPT_STARTED", prefix: [] },
    { phase: "BARRIER_RECOVERY_OUTCOME_UNKNOWN", prefix: ["ATTEMPT_STARTED"] },
    { phase: "BARRIER_RECOVERY_RECONCILE_OUTCOME_UNKNOWN", prefix: ["ATTEMPT_STARTED", "BARRIER_RECOVERY_OUTCOME_UNKNOWN"] },
    { phase: "FENCE_REVALIDATED_BEFORE_BARRIER_RECOVERY", prefix: ["ATTEMPT_STARTED", "BARRIER_RECOVERY_OUTCOME_UNKNOWN"] },
    { phase: "FENCE_REVALIDATED_DURING_BARRIER_RECOVERY", prefix: ["ATTEMPT_STARTED", "BARRIER_RECOVERY_OUTCOME_UNKNOWN", "FENCE_REVALIDATED_BEFORE_BARRIER_RECOVERY"] },
    { phase: "FENCE_REVALIDATED_AFTER_BARRIER_RECOVERY", prefix: ["ATTEMPT_STARTED", "BARRIER_RECOVERY_OUTCOME_UNKNOWN", "FENCE_REVALIDATED_BEFORE_BARRIER_RECOVERY", "FENCE_REVALIDATED_DURING_BARRIER_RECOVERY"] },
  ];
  try {
    for (const [caseIndex, { phase, prefix }] of cases.entries()) {
      const reportPath = path.join(privateRoot, `report-${caseIndex}.json`);
      const journalPath = `${reportPath}.journal`;
      fs.mkdirSync(journalPath, { mode: 0o700 });
      const attemptId = `12345678-1234-4234-8234-${String(caseIndex).padStart(12, "0")}`;
      for (const [sequence, prefixPhase] of prefix.entries()) {
        const prefixSlug = prefixPhase.toLowerCase().replace(/[^a-z0-9]+/g, "-");
        write0600(path.join(journalPath, `${String(sequence).padStart(4, "0")}-${prefixSlug}.json`), Buffer.from(canonicalJson({
          formatVersion: 1, attemptId, mode: "BARRIER_RECOVERY", sequence,
          at: nowIso, phase: prefixPhase,
          ...(prefixPhase === "ATTEMPT_STARTED" || prefixPhase.startsWith("BARRIER_RECOVERY_") ? bindings : {}),
        })));
      }
      const sequence = prefix.length;
      const phaseSlug = phase.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      const orphanName = `.${String(sequence).padStart(4, "0")}-${phaseSlug}.json.321.aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.tmp`;
      const orphan = {
        formatVersion: 1, attemptId, mode: "BARRIER_RECOVERY", sequence,
        at: nowIso, phase,
        ...(phase === "ATTEMPT_STARTED" || phase.startsWith("BARRIER_RECOVERY_") ? bindings : {}),
      };
      write0600(path.join(journalPath, orphanName), Buffer.from(canonicalJson(orphan)));
      openRecoveryJournal(reportPath, bindings);
      assert.equal(fs.readdirSync(journalPath).some((name) => name.startsWith(".")), false);
      const recoveredPath = path.join(journalPath, `${String(sequence).padStart(4, "0")}-${phaseSlug}.json`);
      assert.deepEqual(JSON.parse(fs.readFileSync(recoveredPath, "utf8")), orphan);
    }
    const ambiguousReportPath = path.join(privateRoot, "report-ambiguous.json");
    const ambiguousJournalPath = `${ambiguousReportPath}.journal`;
    fs.mkdirSync(ambiguousJournalPath, { mode: 0o700 });
    for (const suffix of ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"]) {
      write0600(path.join(ambiguousJournalPath, `.0000-attempt-started.json.321.${suffix}.tmp`), Buffer.from("partial"));
    }
    assert.throws(() => openRecoveryJournal(ambiguousReportPath, bindings), /unrelated or ambiguous/);
  } finally {
    fs.rmSync(privateRoot, { recursive: true, force: true });
  }
});

test("exclusive durable publication reconciles every linked READY fault boundary", () => {
  const privateRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "viva-ready-publication-")));
  fs.chmodSync(privateRoot, 0o700);
  try {
    const bytes = Buffer.from(canonicalJson({ state: "READY_TO_REOPEN_INGRESS" }));
    for (const phase of [
      "destination-linked-before-directory-sync",
      "destination-linked",
      "temporary-unlinked-before-directory-sync",
    ]) {
      const filePath = path.join(privateRoot, `${phase}.json`);
      writeFileExclusiveAtomicDurable(filePath, bytes, {
        uid: process.getuid?.() ?? 0,
        gid: process.getgid?.() ?? 0,
        mode: 0o600,
        onTransition: (observed) => {
          if (observed === phase) throw new Error(`simulated ${phase} fault`);
        },
      });
      assert.deepEqual(fs.readFileSync(filePath), bytes);
      const stat = fs.lstatSync(filePath);
      assert.equal(stat.nlink, 1);
      assert.equal(stat.mode & 0o777, 0o600);
    }
    const unknownPath = path.join(privateRoot, "persistent-outcome-unknown.json");
    assert.throws(() => writeFileExclusiveAtomicDurable(unknownPath, bytes, {
      uid: process.getuid?.() ?? 0,
      gid: process.getgid?.() ?? 0,
      mode: 0o600,
      onTransition: (observed) => {
        if (observed !== "destination-linked-before-directory-sync") return;
        fs.unlinkSync(unknownPath);
        fs.mkdirSync(unknownPath, { mode: 0o700 });
        throw new Error("simulated unreconcilable publication fault");
      },
    }), (error) => error?.publicationOutcome === "UNKNOWN" && error?.publicationPath === unknownPath);
    fs.rmSync(unknownPath, { recursive: true, force: true });
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
    const migrationGamesPath = path.join(privateRoot, "migration-games.json");
    const migrationGamesBytes = Buffer.from(`${JSON.stringify({
      formatVersion: 1,
      sourceKind: "live-147-mongo-projection",
      sourceHost: "lk-primary-147",
      sourceFlowSha256: actualSourceSha256,
      database: "games",
      collection: "lk_games",
      capturedAt: nowIso,
      games: [BSON.EJSON.serialize(legacyGame(), { relaxed: false })],
    }, null, 2)}\n`);
    write0600(migrationGamesPath, migrationGamesBytes);
    const migrationProviderReceiptPath = path.join(privateRoot, "migration-provider-receipt.json");
    const migrationProviderReceiptBytes = Buffer.from(`${JSON.stringify({
      formatVersion: 1,
      sourceKind: "viva-end-user-tenant-capture-receipt",
      tenantKey,
      capturedAt: nowIso,
      endpointOrigin: "https://api.vivacrm.ru",
      captures: [{
        date: scope.dateFrom,
        requestPath: `/end-user/api/v1/${tenantKey}/exercises?date=${scope.dateFrom}`,
        statusCode: 200,
        complete: true,
        responseShape: "array",
        rowCount: providerRows[scope.dateFrom].length,
        rowsSha256: cutoverSha256(Buffer.from(JSON.stringify(providerRows[scope.dateFrom]))),
      }],
    }, null, 2)}\n`);
    write0600(migrationProviderReceiptPath, migrationProviderReceiptBytes);
    const migrationProviderPath = path.join(privateRoot, "migration-provider.json");
    const migrationProviderBytes = Buffer.from(`${JSON.stringify({
      formatVersion: 1,
      sourceKind: "viva-end-user-tenant-projection",
      capturedAt: nowIso,
      tenantKey,
      captureReceiptSha256: cutoverSha256(migrationProviderReceiptBytes),
      rowsByDate: providerRows,
    }, null, 2)}\n`);
    write0600(migrationProviderPath, migrationProviderBytes);
    migrationPlan.source.gamesSha256 = cutoverSha256(migrationGamesBytes);
    migrationPlan.source.providerSha256 = cutoverSha256(migrationProviderBytes);
    migrationPlan.source.providerCaptureReceiptSha256 = cutoverSha256(migrationProviderReceiptBytes);
    const migrationPlanPath = path.join(privateRoot, "migration-plan.json");
    const migrationPlanBytes = Buffer.from(`${JSON.stringify(migrationPlan, null, 2)}\n`);
    write0600(migrationPlanPath, migrationPlanBytes);
    const migrationPlanSha256 = cutoverSha256(migrationPlanBytes);
    const migrationIndexPath = path.join(privateRoot, "migration-index.json");
    write0600(migrationIndexPath, Buffer.from(`${JSON.stringify({
      formatVersion: 1,
      tenantKey,
      plans: [{
        path: migrationPlanPath,
        sha256: migrationPlanSha256,
        gamesPath: migrationGamesPath,
        providerPath: migrationProviderPath,
        providerCaptureReceiptPath: migrationProviderReceiptPath,
      }],
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
    const finalizerMigrationUri = "mongodb://migration-fixture.invalid:27017/?replicaSet=rs-fixture";
    const dynamicControls = controls();
    dynamicControls.mongoTarget.migrationConnectionFingerprint = cutoverSha256(finalizerMigrationUri);
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
      migrationConnectionFingerprint: cutoverSha256(finalizerMigrationUri),
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
      executorSources: fixtureExecutorSources,
      nowMs: Date.parse(nowIso),
    });
    assert.equal(result.plan.state, "READY_FOR_SEPARATE_LIVE_APPROVAL");
    assert.equal(result.plan.candidateSha256, actualCandidateSha256);
    assert.ok(result.manifest.files.some((entry) => entry.path === "evidence/full-backup.manifest.json"));

    const copiedExternalWriterProofPath = path.join(outputDirectory, "evidence/external-writer-proof.json");
    const copiedExternalWriterProofBytes = fs.readFileSync(copiedExternalWriterProofPath);
    const falseExternalWriterProofBytes = Buffer.from(canonicalJson({
      ...JSON.parse(copiedExternalWriterProofBytes.toString("utf8")),
      allWritersUseCanonicalLock: false,
    }));
    fs.writeFileSync(copiedExternalWriterProofPath, falseExternalWriterProofBytes, { mode: 0o600 });
    assert.throws(() => validateCopiedControlEvidence(outputDirectory, {
      ...dynamicControls,
      writerFence: {
        ...dynamicControls.writerFence,
        externalWriterProofSha256: cutoverSha256(falseExternalWriterProofBytes),
      },
    }), /does not bind every writer/);
    fs.writeFileSync(copiedExternalWriterProofPath, copiedExternalWriterProofBytes, { mode: 0o600 });
    fs.chmodSync(copiedExternalWriterProofPath, 0o644);
    assert.throws(() => validateExactCutoverPacket({
      packetRoot: outputDirectory, plan: result.plan, manifest: result.manifest, nowMs: Date.parse(nowIso),
    }), /not an owned private packet file/);
    fs.chmodSync(copiedExternalWriterProofPath, 0o600);
    const hardlinkAlias = path.join(privateRoot, "external-writer-proof-hardlink.json");
    fs.linkSync(copiedExternalWriterProofPath, hardlinkAlias);
    assert.throws(() => validateExactCutoverPacket({
      packetRoot: outputDirectory, plan: result.plan, manifest: result.manifest, nowMs: Date.parse(nowIso),
    }), /not an owned private packet file/);
    fs.unlinkSync(hardlinkAlias);

    const copiedRestoreReceiptPath = path.join(outputDirectory, "evidence/full-backup.restore-rehearsal.json");
    const copiedRestoreReceiptBytes = fs.readFileSync(copiedRestoreReceiptPath);
    const falseRestoreReceiptBytes = Buffer.from(canonicalJson({
      ...JSON.parse(copiedRestoreReceiptBytes.toString("utf8")),
      postRestoreHashMatch: false,
    }));
    fs.writeFileSync(copiedRestoreReceiptPath, falseRestoreReceiptBytes, { mode: 0o600 });
    assert.throws(() => validateCopiedControlEvidence(outputDirectory, {
      ...dynamicControls,
      restoreRehearsal: {
        ...dynamicControls.restoreRehearsal,
        receiptSha256: cutoverSha256(falseRestoreReceiptBytes),
      },
    }), /does not bind the declared restore control/);
    fs.writeFileSync(copiedRestoreReceiptPath, copiedRestoreReceiptBytes, { mode: 0o600 });

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
    const applyBackupPath = path.join(privateRoot, "apply-backup.ejson");
    const applyBackupBytes = Buffer.from(canonicalJson({ fixture: "apply-backup" }));
    write0600(applyBackupPath, applyBackupBytes);
    const applyIndexBytes = Buffer.from(`${JSON.stringify({
      formatVersion: 1,
      kind: "viva-game-projection-cutover-apply-index",
      cutoverPlanSha256: cutoverEntry.sha256,
      tenantKey,
      globalLegacyCoverage: {
        dateFrom: result.plan.migration.futureBoundaryDate,
        mongoIds: [legacyGame()._id.toHexString()],
        mongoIdsSha256: cutoverSha256(canonicalJson([legacyGame()._id.toHexString()])),
      },
      items: [{
        planPath: path.join(outputDirectory, copiedPlanEntry.path),
        planSha256: migrationPlanSha256,
        reportPath: applyReportPath,
        reportSha256: cutoverSha256(applyReportBytes),
        backupPath: applyBackupPath,
        backupSha256: cutoverSha256(applyBackupBytes),
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
    const migrationConnectionFile = path.join(privateRoot, "unused-migration-connection.json");
    const migrationConnectionBytes = Buffer.from(canonicalJson({
      formatVersion: 1,
      kind: "viva-game-projection-migration-mongo-connection",
      uri: finalizerMigrationUri,
    }));
    write0600(migrationConnectionFile, migrationConnectionBytes);
    const executionIndexPath = path.join(privateRoot, "execution-index.json");
    const packetManifestSha256 = cutoverSha256(fs.readFileSync(packetManifestPath));
    const executionIndexBytes = Buffer.from(canonicalJson({
      formatVersion: 1,
      kind: "viva-game-projection-cutover-execution-index",
      cutoverPlanPath,
      cutoverPlanSha256: cutoverEntry.sha256,
      packetManifestPath,
      packetManifestSha256,
      fenceReceiptPath,
      fenceReceiptSha256: cutoverSha256(fenceReceiptBytes),
      migrationConnectionFile,
      migrationConnectionFileSha256: cutoverSha256(migrationConnectionBytes),
      mongoWriteBarrierReceiptOutputPath: barrierReceiptPath,
      applyIndexOutputPath: applyIndexPath,
      liveFlowPath: path.join(outputDirectory, "candidate.flow.json"),
      postcheckOutputDirectory: path.join(privateRoot, "postcheck"),
      tenantKey,
      items: [{
        planPath: path.join(outputDirectory, copiedPlanEntry.path),
        planSha256: migrationPlanSha256,
        reportPath: applyReportPath,
        backupDirectory: path.join(privateRoot, "migration-backups"),
      }],
    }));
    write0600(executionIndexPath, executionIndexBytes);
    const guardianReceiptPath = path.join(privateRoot, "guardian-receipt.json");
    const guardianReceiptBytes = Buffer.from(canonicalJson({
      formatVersion: 1,
      kind: "viva-game-projection-fence-guardian-receipt",
      state: "HOLDING_UNTIL_EXPLICIT_RELEASE",
      pid: 4242,
      fd: 9,
      processStartIdentity: "4242:12345",
      lockPath: "/run/lock/padlhub-viva-game-projection-cutover.lock",
      lockDevice: "1",
      lockInode: "2",
      heartbeatPath: path.join(privateRoot, "guardian-heartbeat.json"),
      fenceTokenSha256,
      startedAt: nowIso,
      automaticRelease: false,
    }));
    write0600(guardianReceiptPath, guardianReceiptBytes);
    const guardianHeartbeatBytes = Buffer.from(canonicalJson({ fixture: "live-heartbeat" }));
    const coordinatorJournal = path.join(privateRoot, "coordinator-report.json.journal");
    fs.mkdirSync(coordinatorJournal, { mode: 0o700 });
    const attemptId = "11111111-1111-4111-8111-111111111111";
    const journalEntries = [
      { phase: "ATTEMPT_STARTED" },
      { phase: "MONGO_WRITE_BARRIER_HELD" },
      { phase: "GLOBAL_LEGACY_SCOPE_COVERED" },
      {
        phase: "MIGRATION_PLAN_IN_FLIGHT", planSha256: migrationPlanSha256,
        planPath: path.join(outputDirectory, copiedPlanEntry.path), reportPath: applyReportPath,
      },
      {
        phase: "MIGRATION_PLAN_APPLIED", planSha256: migrationPlanSha256,
        reportPath: applyReportPath, reportSha256: cutoverSha256(applyReportBytes),
        backupPath: applyBackupPath, backupSha256: cutoverSha256(applyBackupBytes),
      },
      { phase: "CANDIDATE_PUBLISHED" },
      { phase: "RUNTIME_ONLINE_SHADOW" },
    ].map((entry, sequence) => ({
      formatVersion: 1, attemptId, mode: "CUTOVER", sequence, at: nowIso, ...entry,
    }));
    journalEntries.forEach((entry, sequence) => write0600(
      path.join(coordinatorJournal, `${String(sequence).padStart(4, "0")}-${entry.phase.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.json`),
      Buffer.from(canonicalJson(entry)),
    ));
    const postcheckCollection = {
      findOne: (filter) => migratedCollection.findOne(filter),
      countDocuments: async (query) => (Object.hasOwn(query, "audit.events") ? 0 : 0),
      find: () => ({ toArray: async () => [cloneBson(migratedCollection.document)] }),
    };
    const postcheck = await prepareVivaGameProjectionCutoverPostcheck({
      cutoverPlan: cutoverPlanPath,
      packetManifest: packetManifestPath,
      expectedCutoverPlanSha256: cutoverEntry.sha256,
      expectedPacketManifestSha256: packetManifestSha256,
      applyIndex: applyIndexPath,
      expectedApplyIndexSha256: cutoverSha256(applyIndexBytes),
      runtimeFlow: path.join(outputDirectory, "candidate.flow.json"),
      fenceReceipt: fenceReceiptPath,
      expectedFenceReceiptSha256: cutoverSha256(fenceReceiptBytes),
      mongoWriteBarrierReceipt: barrierReceiptPath,
      expectedMongoWriteBarrierReceiptSha256: cutoverSha256(barrierReceiptBytes),
      migrationConnectionFile,
      executionIndex: executionIndexPath,
      expectedExecutionIndexSha256: cutoverSha256(executionIndexBytes),
      coordinatorAttemptId: attemptId,
      coordinatorJournal,
      fenceGuardianReceiptSha256: cutoverSha256(guardianReceiptBytes),
      fenceGuardianReceipt: guardianReceiptPath,
      outputDirectory: path.join(privateRoot, "postcheck"),
    }, {
      nowMs: Date.parse(nowIso),
      allowFixtureHostname: true,
      assertFenceLease: () => true,
      assertMongoWriteBarrier: async () => true,
      assertNoConcurrentWrites: async () => true,
      assertExecutorSources: async () => true,
      assertGuardianLease: async () => ({
        bytes: guardianHeartbeatBytes, sha256: cutoverSha256(guardianHeartbeatBytes),
      }),
      probeRuntimeHealth: async (url) => ({
        url, statusCode: 200, bodySha256: "a".repeat(64),
        bodyCanonicalSha256: result.plan.candidateCanonicalSha256, observedAt: nowIso,
      }),
      readPm2: async () => [{
        name: "node-red",
        pm_id: 0,
        pm2_env: {
          status: "online",
          pm_uptime: Date.parse(nowIso) - 20_000,
          restart_time: 4,
          pm_exec_path: "/usr/local/bin/node-red",
          pm_cwd: "/root/.node-red",
          args: [],
          node_args: [],
          PADLHUB_PLATFORM_TENANT_KEY: tenantKey,
          VIVA_GAME_PROJECTION_SYNC_MODE: "SHADOW",
        },
      }],
      mongoContext: { collection: postcheckCollection, hello: { setName: "rs-fixture" } },
    });
    assert.equal(postcheck.receipt.state, "PASS");
    assert.equal(postcheck.receipt.ingressReopened, false);
    assert.equal(fs.existsSync(path.join(privateRoot, "postcheck", "READY_TO_REOPEN_INGRESS.json")), false);
    assert.match(postcheck.postcheckReceiptSha256, /^[a-f0-9]{64}$/);
    assert.match(postcheck.postcheckManifestSha256, /^[a-f0-9]{64}$/);

    const coordinatorReportPath = path.join(privateRoot, "coordinator-report.json");
    const coordinatorReport = {
      formatVersion: 1,
      kind: "viva-game-projection-cutover-coordinator-report",
      state: "POSTCHECK_PASS_INGRESS_STILL_BLOCKED",
      cutoverPlanSha256: cutoverEntry.sha256,
      applyIndexSha256: cutoverSha256(applyIndexBytes),
      activeFlowSha256: result.plan.candidateSha256,
      postcheckReceiptSha256: postcheck.postcheckReceiptSha256,
      postcheckManifestSha256: postcheck.postcheckManifestSha256,
      mongoWriteBarrierReceiptSha256: cutoverSha256(barrierReceiptBytes),
      mongoWriteBarrierState: "HELD",
      fenceGuardianReceiptSha256: cutoverSha256(guardianReceiptBytes),
      coordinatorAttemptId: attemptId,
      ingressReopened: false,
      mutationAttempted: true,
      completedAt: nowIso,
    };
    const postcheckSequence = journalEntries.length;
    const postcheckJournalPath = path.join(
      coordinatorJournal, `${String(postcheckSequence).padStart(4, "0")}-postcheck-evidence-pass-ready-pending.json`,
    );
    write0600(
      postcheckJournalPath,
      Buffer.from(canonicalJson({
        formatVersion: 1, attemptId, mode: "CUTOVER", sequence: postcheckSequence, at: nowIso,
        phase: "POSTCHECK_EVIDENCE_PASS_READY_PENDING",
        postcheckReceiptSha256: postcheck.postcheckReceiptSha256,
        postcheckManifestSha256: postcheck.postcheckManifestSha256,
      })),
    );
    const postcheckJournalAlias = path.join(
      coordinatorJournal, `.${path.basename(postcheckJournalPath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
    );
    fs.linkSync(postcheckJournalPath, postcheckJournalAlias);
    assert.equal(fs.lstatSync(postcheckJournalPath).nlink, 2);
    const reconstructedReport = reconstructSuccessfulCoordinatorReport({
      execution: {
        ...JSON.parse(executionIndexBytes.toString("utf8")),
        executionIndexSha256: cutoverSha256(executionIndexBytes),
      },
      plan: result.plan,
      reportPath: coordinatorReportPath,
    });
    assert.deepEqual(reconstructedReport, coordinatorReport);
    assert.equal(fs.existsSync(postcheckJournalAlias), false);
    assert.equal(fs.lstatSync(postcheckJournalPath).nlink, 1);
    const intentSequence = postcheckSequence + 1;
    const orphanIntentPath = path.join(
      coordinatorJournal,
      `.${String(intentSequence).padStart(4, "0")}-terminal-result-intent.json.${process.pid}.${crypto.randomUUID()}.tmp`,
    );
    write0600(orphanIntentPath, Buffer.from("partial intent"));
    const packetValidationTimes = [];
    const finalizerDependencies = {
      getUid: () => 0,
      authorizedByCoordinator: true,
      guardianReceipt: JSON.parse(guardianReceiptBytes.toString("utf8")),
      nowMs: Date.parse(nowIso),
      assertExecutorSources: async () => true,
      validateExactCutoverPacket: async ({ nowMs }) => { packetValidationTimes.push(nowMs); },
      assertFenceLease: async () => true,
      assertGuardianLease: async () => ({ sha256: cutoverSha256(guardianHeartbeatBytes) }),
      inspectPm2: async () => ({
        name: "node-red",
        pm_id: 0,
        pm2_env: {
          status: "online",
          pm_uptime: Date.parse(nowIso) - 20_000,
          restart_time: 4,
          pm_exec_path: "/usr/local/bin/node-red",
          pm_cwd: "/root/.node-red",
          args: [],
          node_args: [],
          PADLHUB_PLATFORM_TENANT_KEY: tenantKey,
          VIVA_GAME_PROJECTION_SYNC_MODE: "SHADOW",
        },
      }),
      probeRuntimeHealth: async (url) => ({
        url,
        statusCode: 200,
        bodySha256: "a".repeat(64),
        bodyCanonicalSha256: result.plan.candidateCanonicalSha256,
        observedAt: nowIso,
      }),
      finalizationMongoClient: {
        db: () => ({ command: async () => ({ setName: "rs-fixture" }) }),
      },
      assertMongoWriteBarrier: async () => true,
      assertNoConcurrentWrites: async () => true,
    };
    const previousCutoverConfirmation = process.env.VIVA_GAME_PROJECTION_CUTOVER_EXECUTE;
    process.env.VIVA_GAME_PROJECTION_CUTOVER_EXECUTE = "EXECUTE_VIVA_GAME_PROJECTION_CUTOVER_V1";
    let resumedCoordinator;
    try {
      resumedCoordinator = await executeVivaGameProjectionCutover({
        executionIndex: executionIndexPath,
        expectedExecutionIndexSha256: cutoverSha256(executionIndexBytes),
        report: coordinatorReportPath,
      }, finalizerDependencies);
    } finally {
      if (previousCutoverConfirmation === undefined) delete process.env.VIVA_GAME_PROJECTION_CUTOVER_EXECUTE;
      else process.env.VIVA_GAME_PROJECTION_CUTOVER_EXECUTE = previousCutoverConfirmation;
    }
    assert.equal(resumedCoordinator.resumed, true);
    assert.equal(fs.existsSync(orphanIntentPath), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(coordinatorReportPath, "utf8")), coordinatorReport);
    const coordinatorReportBytes = fs.readFileSync(coordinatorReportPath);
    const finalizerOptions = {
      executionIndex: executionIndexPath,
      expectedExecutionIndexSha256: cutoverSha256(executionIndexBytes),
      coordinatorReport: coordinatorReportPath,
      expectedCoordinatorReportSha256: cutoverSha256(coordinatorReportBytes),
    };
    const readyPath = path.join(privateRoot, "postcheck", "READY_TO_REOPEN_INGRESS.json");
    const linkedAlias = path.join(path.dirname(readyPath), `.${path.basename(readyPath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    fs.linkSync(readyPath, linkedAlias);
    assert.equal(fs.lstatSync(readyPath).nlink, 2);
    const delayedNowMs = Date.parse(nowIso) + 10 * 60_000;
    const resumedReady = await finalizeVivaGameProjectionCutoverReady(finalizerOptions, {
      ...finalizerDependencies,
      nowMs: delayedNowMs,
      probeRuntimeHealth: async (url) => ({
        url,
        statusCode: 200,
        bodySha256: "b".repeat(64),
        bodyCanonicalSha256: result.plan.candidateCanonicalSha256,
        observedAt: new Date(delayedNowMs).toISOString(),
      }),
    });
    assert.equal(resumedReady.resumed, false);
    assert.equal(fs.existsSync(linkedAlias), false);
    assert.equal(fs.lstatSync(readyPath).nlink, 1);
    assert.equal(JSON.parse(fs.readFileSync(readyPath, "utf8")).observedAt, new Date(delayedNowMs).toISOString());
    assert.deepEqual(packetValidationTimes, [Date.parse(nowIso), Date.parse(nowIso)]);

    const copiedProviderEvidencePath = path.join(outputDirectory, result.plan.migration.sourceEvidence[0].providerPath);
    const copiedProviderEvidenceBytes = fs.readFileSync(copiedProviderEvidencePath);
    fs.writeFileSync(copiedProviderEvidencePath, Buffer.from(canonicalJson({ tampered: true })), { mode: 0o600 });
    assert.throws(() => validateExactCutoverPacket({
      packetRoot: outputDirectory,
      plan: result.plan,
      manifest: result.manifest,
      nowMs: Date.parse(nowIso),
    }), /packet tree differs from its exact manifest/);
    fs.writeFileSync(copiedProviderEvidencePath, copiedProviderEvidenceBytes, { mode: 0o600 });

    fs.writeFileSync(migrationProviderPath, Buffer.from(canonicalJson({ tampered: true })), { mode: 0o600 });
    assert.throws(() => prepareVivaGameProjectionCutoverPacket({
      workspace,
      candidateDirectory,
      migrationIndexFile: migrationIndexPath,
      controlsFile: controlsPath,
      outputDirectory: path.join(privateRoot, "tampered-source-evidence-packet"),
      tenantKey,
      repository: { commit: repositoryCommit, branch: "codex/viva-cutover" },
      executorSources: fixtureExecutorSources,
      nowMs: Date.parse(nowIso),
    }), /source evidence digest mismatch/);
    fs.writeFileSync(migrationProviderPath, migrationProviderBytes, { mode: 0o600 });

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
      executorSources: fixtureExecutorSources,
      nowMs: Date.parse(nowIso),
    }), /does not match the reviewed cutover contract/);
  } finally {
    fs.rmSync(privateRoot, { recursive: true, force: true });
  }
});
