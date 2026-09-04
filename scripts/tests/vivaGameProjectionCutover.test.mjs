import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { BSON, ObjectId } from "mongodb";

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
  reconcileTenantMigrationOutcome,
  restoreTenantMigrationBackup,
  validateExecutableTenantMigrationPlan,
} from "../lib/vivaGameProjectionTenantMigrationExecution.mjs";
import { buildLegacyTenantMigrationPlan } from "../lib/vivaGameProjectionTenantMigration.mjs";
import { prepareVivaGameProjectionCutoverPacket } from "../prepare_viva_game_projection_cutover_packet.mjs";
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
    writerNodeIds: ["source-writer", "candidate-writer"],
    observedAt: nowIso,
    expiresAt: "2026-09-04T12:10:00.000Z",
  },
  backup: {
    state: "PASS",
    backupSha256: "1".repeat(64),
    manifestSha256: "2".repeat(64),
    fullCollectionStateSha256: "3".repeat(64),
    fenceTokenSha256,
    sourceFlowSha256,
    database: "games",
    collection: "lk_games",
    documentCount: 10,
    startedAt: nowIso,
    completedAt: nowIso,
  },
  restoreRehearsal: {
    state: "PASS",
    backupSha256: "1".repeat(64),
    manifestSha256: "2".repeat(64),
    receiptSha256: "4".repeat(64),
    fullCollectionStateSha256: "3".repeat(64),
    isolatedTarget: true,
    restoredDocumentCount: 10,
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
    fenceExpiresAt: "2026-09-04T12:10:00.000Z",
    mongoTargetIdentitySha256: mongoTarget.targetIdentitySha256,
    observedAt: nowIso,
    applyReports: [{ planSha256, reportSha256: "a".repeat(64), applyReceiptSha256: "b".repeat(64) }],
    queryEvidence: {
      activeReachableLegacySha256: "c".repeat(64),
      duplicateIdentitySha256: "d".repeat(64),
      providerTenantBoundSha256: "e".repeat(64),
      workerModeSha256: "f".repeat(64),
    },
  };
  assert.equal(validateVivaGameProjectionCutoverPostcheck(postcheck, result, Date.parse(nowIso)), true);
  assert.throws(
    () => validateVivaGameProjectionCutoverPostcheck({ ...postcheck, duplicateIdentityCount: 1 }, result, Date.parse(nowIso)),
    /does not authorize reopening ingress/,
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
    operationId: scope.operationId,
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
    operationId: scope.operationId,
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
  assert.doesNotMatch(packetSource, /\bssh\b|\bscp\b|\bcurl\b|pm2\s+(?:restart|stop|start)/);
  assert.doesNotMatch(executorSource, /process\.env\.MONGO_URI|mongodb(?:\+srv)?:\/\//);
  assert.match(executorSource, /APPLY_VIVA_GAME_PROJECTION_TENANT_MIGRATION_V1/);
  assert.match(executorSource, /RESTORE_VIVA_GAME_PROJECTION_TENANT_MIGRATION_V1/);
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

test("packet builder deterministically rebuilds the candidate and embeds hashed backup evidence", () => {
  const privateRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "viva-cutover-packet-")));
  fs.chmodSync(privateRoot, 0o700);
  try {
    const liveCreateSource = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/viva_game_projection_sync/live_create_08c2.txt"),
      "utf8",
    );
    const source = [
      { id: "4b91e2a2413688db", type: "tab", label: "LK Games", disabled: false },
      { id: "mongo-client", type: "mongodb4-client", name: "mongo" },
      {
        id: "8b64bb43086a39e1", type: "mongodb4", z: "4b91e2a2413688db", name: "Find lk game by id",
        clientNode: "mongo-client", mode: "collection", collection: "lk_games", operation: "find",
        output: "toArray", maxTimeMS: "0", handleDocId: false, wires: [["terminal"]],
      },
      {
        id: "source-writer", type: "mongodb4", z: "4b91e2a2413688db", name: "Existing writer",
        clientNode: "mongo-client", mode: "collection", collection: "lk_games", operation: "updateOne", wires: [["terminal"]],
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

    const backupManifestPath = path.join(privateRoot, "full-backup.manifest.json");
    const backupManifestBytes = Buffer.from(`${JSON.stringify({
      formatVersion: 1,
      kind: "viva-game-projection-full-lk-games-backup-manifest",
      backupSha256: "1".repeat(64),
      fullCollectionStateSha256: "3".repeat(64),
      fenceTokenSha256,
      database: "games",
      collection: "lk_games",
      documentCount: 10,
      startedAt: nowIso,
      completedAt: nowIso,
    }, null, 2)}\n`);
    write0600(backupManifestPath, backupManifestBytes);
    const backupManifestSha256 = cutoverSha256(backupManifestBytes);
    const restoreReceiptPath = path.join(privateRoot, "restore-rehearsal.json");
    const restoreReceiptBytes = Buffer.from(`${JSON.stringify({
      formatVersion: 1,
      kind: "viva-game-projection-full-backup-restore-rehearsal",
      backupSha256: "1".repeat(64),
      manifestSha256: backupManifestSha256,
      fullCollectionStateSha256: "3".repeat(64),
      restoredDocumentCount: 10,
      isolatedTarget: true,
      postRestoreHashMatch: true,
      rehearsedAt: nowIso,
    }, null, 2)}\n`);
    write0600(restoreReceiptPath, restoreReceiptBytes);
    const dynamicControls = controls();
    dynamicControls.writerFence.sourceFlowSha256 = actualSourceSha256;
    dynamicControls.writerFence.candidateSha256 = actualCandidateSha256;
    const dynamicSourceWriters = inventoryLkGamesWriters(source);
    const dynamicCandidateWriters = inventoryLkGamesWriters(builtCandidate.candidate);
    dynamicControls.writerFence.writerNodeIds = dynamicCandidateWriters.map(({ nodeId }) => nodeId);
    dynamicControls.writerFence.writerInventorySha256 = cutoverSha256(canonicalJson({
      sourceWriters: dynamicSourceWriters,
      candidateWriters: dynamicCandidateWriters,
    }));
    dynamicControls.backup.sourceFlowSha256 = actualSourceSha256;
    dynamicControls.backup.manifestPath = backupManifestPath;
    dynamicControls.backup.manifestSha256 = backupManifestSha256;
    dynamicControls.restoreRehearsal.manifestSha256 = backupManifestSha256;
    dynamicControls.restoreRehearsal.receiptPath = restoreReceiptPath;
    dynamicControls.restoreRehearsal.receiptSha256 = cutoverSha256(restoreReceiptBytes);
    dynamicControls.coverage.planSha256s = [migrationPlanSha256];
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
