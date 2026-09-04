import crypto from "node:crypto";

const HASH_RE = /^[a-f0-9]{64}$/;
const COMMIT_RE = /^[a-f0-9]{40}$/;
const TENANT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const fail = (message) => { throw new Error(message); };
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
};
export const canonicalJson = (value) => `${JSON.stringify(stableValue(value))}\n`;
export const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

export function buildMongoTargetIdentity({ connectionFingerprint, replicaSetName, database, collection }) {
  assertHash(connectionFingerprint, "Mongo connection fingerprint");
  if (!String(replicaSetName || "").trim() || database !== "games" || collection !== "lk_games") {
    fail("Mongo target identity fields are invalid");
  }
  const identity = {
    connectionFingerprint,
    replicaSetName: String(replicaSetName),
    database,
    collection,
  };
  return { ...identity, targetIdentitySha256: sha256(canonicalJson(identity)) };
}

const assertHash = (value, label) => {
  if (!HASH_RE.test(String(value || ""))) fail(`${label} must be a SHA-256 digest`);
};
const assertState = (value, allowed, label) => {
  if (!allowed.includes(value)) fail(`${label} state is invalid`);
};
const isPass = (value) => value === "PASS";

export function inventoryLkGamesWriters(flow) {
  if (!Array.isArray(flow)) fail("Node-RED flow must be an array");
  const lkGamesTabs = new Set(flow.filter((node) => node?.type === "tab" && node.label === "LK Games").map((node) => node.id));
  const nonWritingOperations = new Set(["find", "findOne", "count", "countDocuments", "distinct"]);
  const mongoNodes = flow.filter((node) => node?.type === "mongodb4");
  for (const node of mongoNodes) {
    const collection = String(node.collection || "").trim();
    const operation = String(node.operation || "").trim();
    const dynamicCollection = !collection || /(?:\{\{|\bmsg\.|\bflow\.|\bglobal\.)/i.test(collection);
    if (dynamicCollection && lkGamesTabs.has(node.z)) {
      fail("LK Games contains an unclassifiable dynamic Mongo collection");
    }
    if (collection === "lk_games" && !operation) fail("lk_games Mongo operation is unclassifiable");
  }
  const writers = mongoNodes.filter((node) => (
    String(node.collection || "").trim() === "lk_games"
    && !nonWritingOperations.has(String(node.operation || "").trim())
  )).map((node) => ({
    nodeId: String(node.id || ""),
    name: String(node.name || ""),
    operation: String(node.operation || ""),
    clientNode: String(node.clientNode || ""),
  })).sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  if (writers.length === 0 || writers.some((writer) => !writer.nodeId || !writer.operation || !writer.clientNode)) {
    fail("Node-RED flow lacks a valid lk_games writer inventory");
  }
  if (new Set(writers.map(({ nodeId }) => nodeId)).size !== writers.length) {
    fail("Node-RED flow contains duplicate lk_games writer IDs");
  }
  return writers;
}

function validatePlans(plans, sourceFlowSha256, tenantKey, generatedAt) {
  if (!Array.isArray(plans) || plans.length === 0) fail("Cutover requires at least one frozen migration plan");
  const hashes = new Set();
  const operationIds = new Set();
  let previousDateTo = null;
  let totalEligible = 0;
  let totalSkipped = 0;
  let totalScanned = 0;
  const cutoverGeneratedAtMs = Date.parse(generatedAt);
  for (const [index, item] of plans.entries()) {
    assertHash(item?.planSha256, `Migration plan ${index} digest`);
    if (hashes.has(item.planSha256)) fail("Cutover migration plan digest is duplicated");
    hashes.add(item.planSha256);
    const plan = item.plan;
    if (!isObject(plan) || plan.source?.sourceFlowSha256 !== sourceFlowSha256
      || plan.scope?.tenantKey !== tenantKey || plan.eligibleCount !== plan.operations?.length
      || !Number.isSafeInteger(plan.scannedCount) || !Number.isSafeInteger(plan.eligibleCount)) {
      fail(`Migration plan ${index} identity/count mismatch`);
    }
    const planGeneratedAtMs = Date.parse(plan.generatedAt);
    if (!Number.isFinite(planGeneratedAtMs) || planGeneratedAtMs > cutoverGeneratedAtMs + 60_000
      || cutoverGeneratedAtMs - planGeneratedAtMs > 30 * 60_000) {
      fail(`Migration plan ${index} is stale or generated too far in the future`);
    }
    if (operationIds.has(plan.scope.operationId)) fail("Cutover migration operationId is duplicated");
    operationIds.add(plan.scope.operationId);
    if (previousDateTo && plan.scope.dateFrom <= previousDateTo) fail("Cutover migration plan ranges overlap or are unordered");
    previousDateTo = plan.scope.dateTo;
    totalEligible += plan.eligibleCount;
    totalSkipped += Object.values(plan.skipped || {}).reduce((sum, value) => sum + Number(value || 0), 0);
    totalScanned += plan.scannedCount;
  }
  return { planSha256s: [...hashes], operationIds: [...operationIds], totalEligible, totalSkipped, totalScanned };
}

export function validateCutoverControls(controls, {
  repositoryCommit,
  sourceFlowSha256,
  candidateSha256,
  tenantKey,
  writerNodeIds,
  writerInventorySha256,
  planSha256s,
  totalSkipped,
  totalScanned,
  generatedAt,
} = {}) {
  if (!isObject(controls) || controls.formatVersion !== 1) fail("Cutover controls format mismatch");
  if (controls.tenantKey !== tenantKey) fail("Cutover controls tenant mismatch");
  const nowMs = Date.parse(generatedAt);
  if (!Number.isFinite(nowMs)) fail("Cutover controls validation time is invalid");
  const isFreshTimestamp = (value, maximumAgeMs) => {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && timestamp <= nowMs + 60_000 && nowMs - timestamp <= maximumAgeMs;
  };
  const blockers = [];

  assertState(controls.ci?.state, ["PASS", "MISSING", "FAIL"], "CI evidence");
  if (isPass(controls.ci.state)) {
    if (controls.ci.headSha !== repositoryCommit || !COMMIT_RE.test(String(controls.ci.headSha || ""))
      || !String(controls.ci.runId || "").trim() || !String(controls.ci.workflow || "").trim()
      || controls.ci.conclusion !== "success" || !/^https:\/\//.test(String(controls.ci.url || ""))
      || !Number.isFinite(Date.parse(controls.ci.completedAt))
      || Date.parse(controls.ci.completedAt) > nowMs + 60_000
      || nowMs - Date.parse(controls.ci.completedAt) > 24 * 60 * 60_000) {
      fail("CI evidence does not bind a successful run to the exact repository commit");
    }
  } else blockers.push("EXACT_HEAD_CI_NOT_PROVEN");

  assertState(controls.runtimeTenant?.state, ["PASS", "MISSING", "FAIL"], "Runtime tenant evidence");
  if (isPass(controls.runtimeTenant.state)) {
    const expectedTenantHash = sha256(tenantKey);
    if (controls.runtimeTenant.tenantKeySha256 !== expectedTenantHash
      || controls.runtimeTenant.durableConfigReadback !== true
      || controls.runtimeTenant.restartUsedUpdateEnv !== true
      || controls.runtimeTenant.postRestartReadback !== true
      || controls.runtimeTenant.host !== "lk-primary-147"
      || !String(controls.runtimeTenant.hostname || "").trim()
      || controls.runtimeTenant.processName !== "node-red"
      || !Number.isSafeInteger(controls.runtimeTenant.pm2ProcessId)
      || !isFreshTimestamp(controls.runtimeTenant.restartAt, 30 * 60_000)
      || !isFreshTimestamp(controls.runtimeTenant.readBackAt, 30 * 60_000)
      || Date.parse(controls.runtimeTenant.restartAt) > Date.parse(controls.runtimeTenant.readBackAt)
      || nowMs - Date.parse(controls.runtimeTenant.readBackAt) > 30 * 60_000) {
      fail("Runtime tenant PASS evidence is internally inconsistent");
    }
  } else blockers.push("RUNTIME_TENANT_NOT_DURABLY_PROVISIONED");

  assertState(controls.writerFence?.state, ["HELD", "NOT_ACQUIRED", "LOST"], "Writer fence evidence");
  if (controls.writerFence.state === "HELD") {
    const observedIds = [...(controls.writerFence.writerNodeIds || [])].sort();
    const expectedIds = [...writerNodeIds].sort();
    if (controls.writerFence.sourceFlowSha256 !== sourceFlowSha256
      || controls.writerFence.candidateSha256 !== candidateSha256
      || controls.writerFence.nodeRedProcessState !== "STOPPED"
      || controls.writerFence.ingressWriteRoutesBlocked !== true
      || controls.writerFence.internalSchedulersStopped !== true
      || controls.writerFence.allLkGamesWritersQuiescent !== true
      || controls.writerFence.externalMongoWritersBlocked !== true
      || controls.writerFence.host !== "lk-primary-147"
      || controls.writerFence.hostname !== controls.runtimeTenant?.hostname
      || controls.writerFence.processName !== "node-red"
      || controls.writerFence.pm2ProcessId !== controls.runtimeTenant?.pm2ProcessId
      || controls.writerFence.lockPath !== "/run/lock/padlhub-viva-game-projection-cutover.lock"
      || !HASH_RE.test(String(controls.writerFence.fenceTokenSha256 || ""))
      || !HASH_RE.test(String(controls.writerFence.externalWriterProofSha256 || ""))
      || !String(controls.writerFence.externalWriterProofPath || "").startsWith("/")
      || controls.writerFence.writerInventorySha256 !== writerInventorySha256
      || JSON.stringify(observedIds) !== JSON.stringify(expectedIds)) {
      fail("Writer fence HELD evidence does not cover the exact writer inventory");
    }
    const observedAt = Date.parse(controls.writerFence.observedAt);
    const expiresAt = Date.parse(controls.writerFence.expiresAt);
    if (!Number.isFinite(observedAt) || !Number.isFinite(expiresAt)
      || observedAt > nowMs + 60_000 || nowMs - observedAt > 5 * 60_000 || expiresAt <= nowMs) {
      fail("Writer fence HELD evidence is stale or expired");
    }
  } else blockers.push("COMPLETE_LK_GAMES_WRITER_FENCE_NOT_HELD");

  assertState(controls.backup?.state, ["PASS", "NOT_RUN", "FAIL"], "Backup evidence");
  if (isPass(controls.backup.state)) {
    assertHash(controls.backup.backupSha256, "Backup digest");
    assertHash(controls.backup.manifestSha256, "Backup manifest digest");
    assertHash(controls.backup.fullCollectionStateSha256, "Backup collection-state digest");
    if (controls.backup.sourceFlowSha256 !== sourceFlowSha256 || controls.backup.database !== "games"
      || controls.backup.collection !== "lk_games" || !Number.isSafeInteger(controls.backup.documentCount)
      || controls.backup.documentCount < 1
      || !String(controls.backup.artifactPath || "").startsWith("/")
      || !String(controls.backup.manifestPath || "").startsWith("/")
      || controls.backup.fenceTokenSha256 !== controls.writerFence.fenceTokenSha256
      || !isFreshTimestamp(controls.backup.startedAt, 24 * 60 * 60_000)
      || !isFreshTimestamp(controls.backup.completedAt, 24 * 60 * 60_000)
      || Date.parse(controls.backup.startedAt) < Date.parse(controls.writerFence.observedAt)
      || Date.parse(controls.backup.completedAt) < Date.parse(controls.backup.startedAt)
      || Date.parse(controls.backup.completedAt) >= Date.parse(controls.writerFence.expiresAt)
      || nowMs - Date.parse(controls.backup.completedAt) > 24 * 60 * 60_000) {
      fail("Backup PASS evidence is internally inconsistent");
    }
  } else blockers.push("CURRENT_LK_GAMES_BACKUP_NOT_PROVEN");

  assertState(controls.restoreRehearsal?.state, ["PASS", "NOT_RUN", "FAIL"], "Restore rehearsal evidence");
  if (isPass(controls.restoreRehearsal.state)) {
    assertHash(controls.restoreRehearsal.backupSha256, "Restore rehearsal backup digest");
    assertHash(controls.restoreRehearsal.manifestSha256, "Restore rehearsal manifest digest");
    assertHash(controls.restoreRehearsal.fullCollectionStateSha256, "Restore rehearsal collection-state digest");
    assertHash(controls.restoreRehearsal.receiptSha256, "Restore rehearsal receipt digest");
    if (!isPass(controls.backup?.state)
      || controls.restoreRehearsal.backupSha256 !== controls.backup.backupSha256
      || controls.restoreRehearsal.manifestSha256 !== controls.backup.manifestSha256
      || controls.restoreRehearsal.fullCollectionStateSha256 !== controls.backup.fullCollectionStateSha256
      || !String(controls.restoreRehearsal.receiptPath || "").startsWith("/")
      || controls.restoreRehearsal.isolatedTarget !== true
      || controls.restoreRehearsal.restoredDocumentCount !== controls.backup.documentCount
      || controls.restoreRehearsal.postRestoreHashMatch !== true
      || !isFreshTimestamp(controls.restoreRehearsal.rehearsedAt, 24 * 60 * 60_000)) {
      fail("Restore rehearsal PASS evidence is internally inconsistent");
    }
  } else blockers.push("BACKUP_RESTORE_REHEARSAL_NOT_PROVEN");

  assertState(controls.coverage?.state, ["PASS", "INCOMPLETE", "FAIL"], "Migration coverage evidence");
  if (isPass(controls.coverage.state)) {
    if (JSON.stringify([...(controls.coverage.planSha256s || [])].sort()) !== JSON.stringify([...planSha256s].sort())
      || controls.coverage.completeReachableScope !== true
      || controls.coverage.unresolvedSkippedCount !== 0
      || !Number.isSafeInteger(controls.coverage.resolvedSkippedCount)
      || controls.coverage.resolvedSkippedCount < 0
      || !Number.isSafeInteger(controls.coverage.quarantinedSkippedCount)
      || controls.coverage.quarantinedSkippedCount < 0
      || controls.coverage.resolvedSkippedCount + controls.coverage.quarantinedSkippedCount !== totalSkipped
      || !Number.isSafeInteger(controls.coverage.activeReachableLegacyBeforeApply)
      || controls.coverage.activeReachableLegacyBeforeApply < 1
      || controls.coverage.activeReachableLegacyBeforeApply !== totalScanned
      || !isFreshTimestamp(controls.coverage.observedAt, 30 * 60_000)) {
      fail("Migration coverage PASS evidence is internally inconsistent");
    }
  } else blockers.push("COMPLETE_LEGACY_SCOPE_AND_SKIP_DISPOSITION_NOT_PROVEN");

  assertState(controls.mongoTarget?.state, ["PASS", "MISSING", "FAIL"], "Mongo target evidence");
  if (isPass(controls.mongoTarget.state)) {
    for (const key of ["connectionFingerprint", "targetIdentitySha256"]) {
      assertHash(controls.mongoTarget[key], `Mongo target ${key}`);
    }
    if (controls.mongoTarget.database !== "games" || controls.mongoTarget.collection !== "lk_games"
      || !String(controls.mongoTarget.replicaSetName || "").trim()
      || controls.mongoTarget.topology !== "REPLICA_SET"
      || !isFreshTimestamp(controls.mongoTarget.verifiedAt, 30 * 60_000)) {
      fail("Mongo target PASS evidence is internally inconsistent");
    }
  } else blockers.push("EXACT_MONGO_TARGET_NOT_PROVEN");

  if (controls.postcheckContract?.state !== "PREPARED"
    || controls.postcheckContract.activeReachableLegacyExpected !== 0
    || controls.postcheckContract.duplicateIdentityExpected !== 0
    || controls.postcheckContract.providerConfirmedTenantBoundMinimum !== 1
    || controls.postcheckContract.workerInitialMode !== "SHADOW"
    || controls.postcheckContract.shadowWritesExpected !== 0
    || controls.postcheckContract.keepFenceOnFailure !== true) {
    fail("Cutover postcheck contract is incomplete");
  }

  return blockers;
}

export function buildVivaGameProjectionCutoverPlan({
  repository,
  sourceFlowSha256,
  candidateSha256,
  tenantKey,
  sourceWriters,
  candidateWriters,
  plans,
  controls,
  controlsSha256,
  reviewedFlowContractSha256,
  generatedAt,
}) {
  if (!isObject(repository) || !COMMIT_RE.test(String(repository.commit || "")) || !String(repository.branch || "").trim()) {
    fail("Cutover packet requires an exact repository identity");
  }
  assertHash(sourceFlowSha256, "Cutover source-flow digest");
  assertHash(candidateSha256, "Cutover candidate digest");
  assertHash(controlsSha256, "Cutover controls digest");
  assertHash(reviewedFlowContractSha256, "Reviewed-flow contract digest");
  if (!TENANT_RE.test(String(tenantKey || "")) || !Number.isFinite(Date.parse(generatedAt))) {
    fail("Cutover tenant or generation time is invalid");
  }
  for (const [label, writers] of [["source", sourceWriters], ["candidate", candidateWriters]]) {
    if (!Array.isArray(writers) || writers.length === 0
      || writers.some((writer) => !writer?.nodeId || !writer?.operation || !writer?.clientNode)
      || new Set(writers.map((writer) => writer.nodeId)).size !== writers.length) {
      fail(`Cutover ${label} writer inventory is invalid`);
    }
  }
  const planSummary = validatePlans(plans, sourceFlowSha256, tenantKey, generatedAt);
  const writerNodeIds = [...new Set([...sourceWriters, ...candidateWriters].map(({ nodeId }) => nodeId))].sort();
  const writerInventorySha256 = sha256(canonicalJson({ sourceWriters, candidateWriters }));
  const blockers = validateCutoverControls(controls, {
    repositoryCommit: repository.commit,
    sourceFlowSha256,
    candidateSha256,
    tenantKey,
    writerNodeIds,
    writerInventorySha256,
    planSha256s: planSummary.planSha256s,
    totalSkipped: planSummary.totalSkipped,
    totalScanned: planSummary.totalScanned,
    generatedAt,
  });
  return {
    formatVersion: 1,
    kind: "viva-game-projection-tenant-cutover-plan",
    generatedAt,
    state: blockers.length === 0 ? "READY_FOR_SEPARATE_LIVE_APPROVAL" : "BLOCKED",
    repository,
    controlsSha256,
    reviewedFlowContractSha256,
    sourceFlowSha256,
    candidateSha256,
    tenantKeySha256: sha256(tenantKey),
    production: isPass(controls.runtimeTenant?.state) ? {
      hostAlias: controls.runtimeTenant.host,
      hostname: controls.runtimeTenant.hostname,
      processName: controls.runtimeTenant.processName,
      pm2ProcessId: controls.runtimeTenant.pm2ProcessId,
      canonicalFlowPath: "/root/.node-red/flows.json",
    } : null,
    migration: {
      planSha256s: planSummary.planSha256s,
      operationIds: planSummary.operationIds,
      totalEligible: planSummary.totalEligible,
      totalSkipped: planSummary.totalSkipped,
      executor: "scripts/run_viva_game_projection_tenant_migration.mjs",
      applyConfirmation: "APPLY_VIVA_GAME_PROJECTION_TENANT_MIGRATION_V1",
      restoreConfirmation: "RESTORE_VIVA_GAME_PROJECTION_TENANT_MIGRATION_V1",
      mongoIdEncoding: "canonical-ejson",
      upsertAllowed: false,
    },
    writerFence: {
      sourceWriterCount: sourceWriters.length,
      candidateWriterCount: candidateWriters.length,
      exactWriterNodeIds: writerNodeIds,
      exactMigrationOperationIds: planSummary.operationIds,
      sourceWriters,
      candidateWriters,
      writerInventorySha256,
      externalWriterProofSha256: controls.writerFence?.externalWriterProofSha256,
      fenceTokenSha256: controls.writerFence?.fenceTokenSha256,
      lockPath: controls.writerFence?.lockPath,
      mustRemainHeldThroughDataAndFlowPostchecks: true,
    },
    mongoTarget: isPass(controls.mongoTarget?.state) ? {
      connectionFingerprint: controls.mongoTarget.connectionFingerprint,
      targetIdentitySha256: controls.mongoTarget.targetIdentitySha256,
      replicaSetName: controls.mongoTarget.replicaSetName,
      database: controls.mongoTarget.database,
      collection: controls.mongoTarget.collection,
    } : null,
    evidence: {
      ciRunId: controls.ci?.runId || null,
      runtimeTenantReadBackAt: controls.runtimeTenant?.readBackAt || null,
      backupManifestSha256: controls.backup?.manifestSha256 || null,
      backupSha256: controls.backup?.backupSha256 || null,
      externalWriterProofSha256: controls.writerFence?.externalWriterProofSha256 || null,
    },
    phases: [
      "provision and read back PADLHUB_PLATFORM_TENANT_KEY with PM2 --update-env under separate approval",
      "block write ingress, stop internal schedulers and Node-RED, then prove every lk_games writer quiescent",
      "capture exact private games.lk_games backup and verify isolated restore",
      "refresh provider and Mongo projections, freeze non-overlapping CAS plans, resolve or quarantine every skip",
      "apply plans transactionally with exact plan/flow/fence confirmations and durable receipts",
      "import the exact reviewed flow, restart with --update-env, and keep the projection worker in SHADOW",
      "while the fence remains held, prove zero active reachable legacy rows, zero duplicate identities and non-zero provider-confirmed tenant rows",
      "open ingress only after all postchecks pass; any failure keeps the fence closed",
    ],
    rollback: {
      requiresSeparateAuthorization: true,
      keepWriterFenceHeld: true,
      restoreExactBackupBeforeOldFlow: true,
      oldFlowWithMigratedRowsForbidden: true,
      applyReceiptRequired: true,
      exactPostimageCasRequired: true,
    },
    postchecks: { ...controls.postcheckContract },
    blockers,
    liveMutationAuthorized: false,
    tenantProvisioningPerformed: false,
    writerFenceMutationPerformed: false,
    databaseMutationPerformed: false,
    deploymentPerformed: false,
    activationPerformed: false,
  };
}

export function validateVivaGameProjectionCutoverPostcheck(receipt, plan, nowMs = Date.now(), evidence = {}) {
  if (!isObject(plan) || plan.kind !== "viva-game-projection-tenant-cutover-plan") {
    fail("Cutover plan contract mismatch");
  }
  if (!isObject(receipt) || receipt.formatVersion !== 1
    || receipt.kind !== "viva-game-projection-tenant-cutover-postcheck"
    || receipt.state !== "PASS" || receipt.sourceFlowSha256 !== plan.sourceFlowSha256
    || receipt.candidateSha256 !== plan.candidateSha256
    || receipt.tenantKeySha256 !== plan.tenantKeySha256
    || JSON.stringify([...(receipt.appliedPlanSha256s || [])].sort())
      !== JSON.stringify([...plan.migration.planSha256s].sort())
    || receipt.writerFenceState !== "HELD"
    || receipt.fenceTokenSha256 !== plan.writerFence.fenceTokenSha256
    || receipt.mongoTargetIdentitySha256 !== plan.mongoTarget?.targetIdentitySha256
    || receipt.activeReachableLegacyCount !== plan.postchecks.activeReachableLegacyExpected
    || receipt.duplicateIdentityCount !== plan.postchecks.duplicateIdentityExpected
    || !Number.isSafeInteger(receipt.providerConfirmedTenantBoundCount)
    || receipt.providerConfirmedTenantBoundCount < plan.postchecks.providerConfirmedTenantBoundMinimum
    || receipt.workerMode !== plan.postchecks.workerInitialMode
    || receipt.workerWriteCount !== plan.postchecks.shadowWritesExpected
    || receipt.runtimeTenantReadback !== true
    || receipt.candidateFlowReadback !== true
    || receipt.ingressReopened !== false
    || !HASH_RE.test(String(receipt.fenceReceiptSha256 || ""))
    || !Number.isFinite(Date.parse(receipt.observedAt))
    || nowMs - Date.parse(receipt.observedAt) > 5 * 60_000
    || Date.parse(receipt.observedAt) > nowMs + 60_000
    || !Number.isFinite(Date.parse(receipt.fenceExpiresAt))
    || Date.parse(receipt.fenceExpiresAt) <= nowMs
    || !Array.isArray(receipt.applyReports)
    || receipt.applyReports.length !== plan.migration.planSha256s.length
    || !isObject(receipt.queryEvidence)) {
    fail("Cutover postcheck does not authorize reopening ingress");
  }
  const expectedPlans = new Set(plan.migration.planSha256s);
  for (const item of receipt.applyReports) {
    if (!expectedPlans.delete(item?.planSha256)) fail("Cutover postcheck apply-report binding mismatch");
    assertHash(item.reportSha256, "Cutover apply report digest");
    assertHash(item.applyReceiptSha256, "Cutover apply receipt digest");
    const reportBytes = evidence.applyReportBytesByPlan?.[item.planSha256];
    if (!Buffer.isBuffer(reportBytes) || sha256(reportBytes) !== item.reportSha256) {
      fail("Cutover postcheck lacks the exact apply-report artifact");
    }
    let report;
    try { report = JSON.parse(reportBytes.toString("utf8")); } catch { fail("Cutover apply-report artifact is invalid"); }
    if (report?.mode !== "APPLY" || report.outcome !== "SUCCEEDED" || report.planSha256 !== item.planSha256
      || sha256(canonicalJson(report.applyReceipt)) !== item.applyReceiptSha256) {
      fail("Cutover apply-report artifact does not prove a successful apply");
    }
  }
  const queryContracts = {
    activeReachableLegacySha256: ["viva-game-projection-active-legacy-query", "count", receipt.activeReachableLegacyCount],
    duplicateIdentitySha256: ["viva-game-projection-duplicate-identity-query", "count", receipt.duplicateIdentityCount],
    providerTenantBoundSha256: ["viva-game-projection-provider-tenant-bound-query", "exactPostimageCount", receipt.providerConfirmedTenantBoundCount],
    workerModeSha256: ["viva-game-projection-worker-mode-query", "writeCount", receipt.workerWriteCount],
  };
  for (const [key, [kind, countKey, expectedCount]] of Object.entries(queryContracts)) {
    assertHash(receipt.queryEvidence[key], `Cutover postcheck ${key}`);
    const bytes = evidence.queryEvidenceBytes?.[key];
    if (!Buffer.isBuffer(bytes) || sha256(bytes) !== receipt.queryEvidence[key]) {
      fail(`Cutover postcheck lacks exact ${key} evidence`);
    }
    let query;
    try { query = JSON.parse(bytes.toString("utf8")); } catch { fail(`Cutover postcheck ${key} evidence is invalid`); }
    if (query?.kind !== kind || query[countKey] !== expectedCount) fail(`Cutover postcheck ${key} evidence mismatch`);
    if (key === "workerModeSha256" && query.mode !== receipt.workerMode) fail("Cutover worker-mode evidence mismatch");
  }
  return true;
}
