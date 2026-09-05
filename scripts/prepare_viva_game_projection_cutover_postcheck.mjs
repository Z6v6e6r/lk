#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { MongoClient } from "mongodb";

import {
  buildMongoTargetIdentity,
  canonicalJson,
  sha256,
  validateVivaGameProjectionCutoverPostcheck,
} from "./lib/vivaGameProjectionCutoverContract.mjs";
import { buildGlobalActiveLegacyTenantQuery } from "./lib/vivaGameProjectionTenantMigration.mjs";
import {
  decodeTenantMigrationOperation,
  hashCanonicalEjson,
  validateApplyReceipt,
  validateExecutableTenantMigrationPlan,
} from "./lib/vivaGameProjectionTenantMigrationExecution.mjs";
import {
  assertExclusiveFenceLease,
  assertNoConcurrentMongoWrites,
  ensurePrivateDirectory,
  readFlowConnection,
  readPrivateBytes,
  readPrivateJson,
  readPrivateMongoConnection,
  validateHeldWriterFence,
} from "./run_viva_game_projection_tenant_migration.mjs";
import { assertMongoWriteBarrier } from "./lib/vivaGameProjectionMongoWriteBarrier.mjs";
import { assertExactExecutorSources } from "./lib/vivaGameProjectionExecutorSource.mjs";
import { validateExactCutoverPacket } from "./lib/vivaGameProjectionCutoverPacketValidation.mjs";
import { writeFileExclusiveAtomicDurable } from "./nodered_reviewed_flow_deploy/runtime_contract.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const HASH_RE = /^[a-f0-9]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_JSON_BYTES = 64 * 1024 * 1024;
const CUTOVER_ONLY_ENV_KEYS = [
  "PADLHUB_CUTOVER_FENCE_TOKEN", "PADLHUB_CUTOVER_FENCE_FD", "PADLHUB_CUTOVER_FENCE_LOCK_PATH",
  "PADLHUB_CUTOVER_GUARDIAN_RECEIPT", "PADLHUB_CUTOVER_GUARDIAN_RELEASE_REQUEST",
  "PADLHUB_CUTOVER_GUARDIAN_HEARTBEAT", "PADLHUB_CUTOVER_GUARDIAN_PID",
  "VIVA_GAME_PROJECTION_CUTOVER_EXECUTE", "VIVA_GAME_PROJECTION_MIGRATION_APPLY",
  "VIVA_GAME_PROJECTION_MIGRATION_RESTORE", "VIVA_GAME_PROJECTION_MONGO_BARRIER_RECOVER",
];
const fail = (message) => { throw new Error(message); };
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

const parseArgs = (argv) => {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--") || values.has(key)) {
      fail(`Invalid argument: ${key || ""}`);
    }
    values.set(key, value);
  }
  for (const key of [
    "--cutover-plan", "--packet-manifest", "--expected-cutover-plan-sha256",
    "--expected-packet-manifest-sha256", "--apply-index", "--expected-apply-index-sha256",
    "--runtime-flow", "--fence-receipt", "--expected-fence-receipt-sha256", "--output-directory",
    "--mongo-write-barrier-receipt", "--expected-mongo-write-barrier-receipt-sha256",
    "--migration-connection-file", "--execution-index", "--expected-execution-index-sha256",
    "--coordinator-attempt-id", "--fence-guardian-receipt-sha256",
    "--fence-guardian-receipt", "--coordinator-journal",
  ]) if (!values.get(key)) fail(`Missing ${key}`);
  return values;
};

const assertHash = (value, label) => {
  if (!HASH_RE.test(String(value || ""))) fail(`${label} must be a SHA-256 digest`);
};

const manifestEntry = (manifest, relativePath, expectedSha256) => {
  const matches = (manifest.files || []).filter((entry) => entry?.path === relativePath);
  if (matches.length !== 1 || matches[0].sha256 !== expectedSha256) {
    fail(`Packet manifest does not bind ${relativePath}`);
  }
};

export const readPm2 = () => {
  const result = spawnSync("pm2", ["jlist"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (result.status !== 0) fail("Unable to read PM2 state for cutover postcheck");
  let processes;
  try { processes = JSON.parse(result.stdout); } catch { fail("PM2 state is not valid JSON"); }
  return processes;
};

export const envValue = (processEntry, key) => (
  processEntry?.pm2_env?.[key] ?? processEntry?.pm2_env?.env?.[key] ?? null
);
export const assertNoCutoverEnvironment = (entry) => {
  if (CUTOVER_ONLY_ENV_KEYS.some((key) => String(envValue(entry, key) || "") !== "")) {
    fail("Live PM2 process retained cutover-only credentials or confirmations");
  }
};
const pm2ArraySha256 = (value) => sha256(canonicalJson(Array.isArray(value) ? value : (value == null ? [] : [String(value)])));
export const assertPm2RuntimeIdentity = (entry, production) => {
  if (entry?.pm2_env?.pm_exec_path !== production.pmExecPath || entry?.pm2_env?.pm_cwd !== production.pmCwd
    || pm2ArraySha256(entry?.pm2_env?.args) !== production.pmArgsSha256
    || pm2ArraySha256(entry?.pm2_env?.node_args) !== production.pmNodeArgsSha256) {
    fail("PM2 runtime identity differs from the frozen Node-RED service");
  }
};
const probeLocalRuntimeHealth = async (url, expectedCanonicalSha256) => {
  const response = await fetch(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(5_000) });
  const body = Buffer.from(await response.arrayBuffer());
  let flow;
  try { flow = JSON.parse(body.toString("utf8")); } catch { fail("Local Node-RED /flows response is invalid JSON"); }
  const bodyCanonicalSha256 = sha256(canonicalJson(flow));
  if (response.status !== 200 || body.length > 256 * 1024 * 1024 || bodyCanonicalSha256 !== expectedCanonicalSha256) {
    fail("Local Node-RED health probe failed");
  }
  return { url, statusCode: response.status, bodySha256: sha256(body), bodyCanonicalSha256, observedAt: new Date().toISOString() };
};

const identitySignals = (document) => {
  const values = [
    document?.booking?.vivaExerciseId,
    document?.booking?.exerciseId,
    document?.metadata?.vivaExerciseId,
    document?.metadata?.exerciseId,
  ];
  const id = String(document?.id || "").trim();
  const dedupeKey = String(document?.dedupeKey || "").trim();
  if (id.startsWith("viva_")) values.push(id.slice(5));
  if (dedupeKey.startsWith("viva:")) values.push(dedupeKey.slice(5));
  return [...new Set(values.map((value) => String(value || "").trim()).filter((value) => UUID_RE.test(value)))];
};

const duplicateIdentityCount = (documents, tenantKey) => {
  const seen = new Map();
  let invalidOrAmbiguous = 0;
  for (const document of documents) {
    const signals = identitySignals(document);
    if (signals.length !== 1) {
      invalidOrAmbiguous += 1;
      continue;
    }
    const key = `${tenantKey}:${signals[0].toLowerCase()}`;
    seen.set(key, (seen.get(key) || 0) + 1);
  }
  return invalidOrAmbiguous + [...seen.values()].reduce((total, count) => total + Math.max(0, count - 1), 0);
};

const privateOptions = () => {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const gid = typeof process.getgid === "function" ? process.getgid() : 0;
  return { uid, gid, mode: 0o600 };
};

const writeEvidence = (outputDirectory, name, value) => {
  const bytes = Buffer.from(canonicalJson(value));
  const filePath = path.join(outputDirectory, name);
  writeFileExclusiveAtomicDurable(filePath, bytes, privateOptions());
  return { path: filePath, bytes, sha256: sha256(bytes) };
};

const linuxProcessStartIdentity = (pid) => {
  const body = fs.readFileSync(`/proc/${pid}/stat`, "utf8").trim();
  const tail = body.slice(body.lastIndexOf(")") + 2).split(/\s+/);
  if (!/^\d+$/.test(String(tail[19] || ""))) fail("Fence guardian process start identity is unavailable");
  return `${pid}:${tail[19]}`;
};

export function assertLiveFenceGuardian(receipt, nowMs = Date.now()) {
  if (!Number.isSafeInteger(receipt?.pid) || receipt.pid < 1 || !Number.isSafeInteger(receipt?.fd) || receipt.fd < 3
    || !String(receipt?.processStartIdentity || "") || !String(receipt?.heartbeatPath || "").startsWith("/")
    || !/^\d+$/.test(String(receipt?.lockDevice || "")) || !/^\d+$/.test(String(receipt?.lockInode || ""))) {
    fail("Fence guardian receipt lacks a verifiable live process identity");
  }
  try { process.kill(receipt.pid, 0); } catch { fail("Persistent fence guardian is not alive"); }
  if (linuxProcessStartIdentity(receipt.pid) !== receipt.processStartIdentity) fail("Fence guardian PID was reused");
  const descriptorStat = fs.statSync(`/proc/${receipt.pid}/fd/${receipt.fd}`);
  const lockStat = fs.statSync(receipt.lockPath);
  if (String(descriptorStat.dev) !== receipt.lockDevice || String(descriptorStat.ino) !== receipt.lockInode
    || descriptorStat.dev !== lockStat.dev || descriptorStat.ino !== lockStat.ino) {
    fail("Fence guardian no longer holds the canonical lock inode");
  }
  const heartbeatRead = readPrivateJson(receipt.heartbeatPath, "Fence guardian heartbeat", 1024 * 1024);
  const heartbeat = heartbeatRead.value;
  const observedAt = Date.parse(heartbeat?.observedAt);
  if (heartbeat?.formatVersion !== 1 || heartbeat?.kind !== "viva-game-projection-fence-guardian-heartbeat"
    || heartbeat?.state !== "HOLDING" || heartbeat?.pid !== receipt.pid || heartbeat?.fd !== receipt.fd
    || heartbeat?.processStartIdentity !== receipt.processStartIdentity || heartbeat?.lockPath !== receipt.lockPath
    || heartbeat?.lockDevice !== receipt.lockDevice || heartbeat?.lockInode !== receipt.lockInode
    || heartbeat?.fenceTokenSha256 !== receipt.fenceTokenSha256 || !Number.isSafeInteger(heartbeat?.sequence)
    || !Number.isFinite(observedAt) || observedAt > nowMs + 1_000 || nowMs - observedAt > 5_000) {
    fail("Fence guardian heartbeat is stale or does not bind the live lock holder");
  }
  return { heartbeat, bytes: heartbeatRead.bytes, sha256: sha256(heartbeatRead.bytes) };
}

const readCoordinatorJournal = (directory, attemptId) => {
  const canonical = fs.realpathSync(directory);
  if (canonical !== path.resolve(directory)) fail("Coordinator journal path is not canonical");
  const entries = fs.readdirSync(canonical).sort().map((name, index) => {
    if (!new RegExp(`^${String(index).padStart(4, "0")}-[a-z0-9-]+\\.json$`).test(name)) {
      fail("Coordinator journal sequence is incomplete or ambiguous");
    }
    return readPrivateJson(path.join(canonical, name), "Coordinator journal entry", 1024 * 1024).value;
  });
  if (entries.length === 0 || entries.some((entry, index) => entry?.formatVersion !== 1
    || entry?.attemptId !== attemptId || entry?.mode !== "CUTOVER" || entry?.sequence !== index)) {
    fail("Coordinator journal does not bind this exact attempt");
  }
  return entries;
};

export async function prepareVivaGameProjectionCutoverPostcheck(options, dependencies = {}) {
  const clockNow = () => (typeof dependencies.nowMs === "function" ? dependencies.nowMs() : (dependencies.nowMs ?? Date.now()));
  const nowMs = clockNow();
  if (!UUID_RE.test(String(options.coordinatorAttemptId || ""))) fail("Coordinator attempt ID is invalid");
  assertHash(options.fenceGuardianReceiptSha256, "Fence guardian receipt digest");
  const cutoverRead = readPrivateJson(options.cutoverPlan, "Cutover plan", MAX_JSON_BYTES);
  const manifestRead = readPrivateJson(options.packetManifest, "Packet manifest", MAX_JSON_BYTES);
  const applyIndexRead = readPrivateJson(options.applyIndex, "Apply index", MAX_JSON_BYTES);
  const fenceRead = readPrivateJson(options.fenceReceipt, "Writer fence receipt", MAX_JSON_BYTES);
  const barrierRead = readPrivateJson(options.mongoWriteBarrierReceipt, "Mongo write-barrier receipt", MAX_JSON_BYTES);
  const executionRead = readPrivateJson(options.executionIndex, "Cutover execution index", MAX_JSON_BYTES);
  const guardianRead = readPrivateJson(options.fenceGuardianReceipt, "Fence guardian receipt", MAX_JSON_BYTES);
  const execution = executionRead.value;
  for (const [actual, expected, label] of [
    [sha256(cutoverRead.bytes), options.expectedCutoverPlanSha256, "Cutover plan"],
    [sha256(manifestRead.bytes), options.expectedPacketManifestSha256, "Packet manifest"],
    [sha256(applyIndexRead.bytes), options.expectedApplyIndexSha256, "Apply index"],
    [sha256(fenceRead.bytes), options.expectedFenceReceiptSha256, "Writer fence receipt"],
    [sha256(barrierRead.bytes), options.expectedMongoWriteBarrierReceiptSha256, "Mongo write-barrier receipt"],
    [sha256(executionRead.bytes), options.expectedExecutionIndexSha256, "Cutover execution index"],
    [sha256(guardianRead.bytes), options.fenceGuardianReceiptSha256, "Fence guardian receipt"],
  ]) {
    assertHash(expected, `${label} expected digest`);
    if (actual !== expected) fail(`${label} digest mismatch`);
  }
  const plan = cutoverRead.value;
  const manifest = manifestRead.value;
  if (!isObject(plan) || plan.kind !== "viva-game-projection-tenant-cutover-plan"
    || plan.state !== "READY_FOR_SEPARATE_LIVE_APPROVAL" || plan.liveMutationAuthorized !== false
    || !isObject(manifest) || manifest.kind !== "viva-game-projection-cutover-packet-manifest"
    || manifest.state !== plan.state || manifest.sourceFlowSha256 !== plan.sourceFlowSha256
    || manifest.candidateSha256 !== plan.candidateSha256) {
    fail("Cutover plan or packet manifest is not postcheck eligible");
  }
  if (dependencies.assertExecutorSources) await dependencies.assertExecutorSources(plan);
  else assertExactExecutorSources(plan);
  if (!isObject(execution) || execution.formatVersion !== 1
    || execution.kind !== "viva-game-projection-cutover-execution-index"
    || execution.cutoverPlanPath !== options.cutoverPlan
    || execution.packetManifestPath !== options.packetManifest
    || execution.fenceReceiptPath !== options.fenceReceipt
    || execution.migrationConnectionFile !== options.migrationConnectionFile
    || execution.mongoWriteBarrierReceiptOutputPath !== options.mongoWriteBarrierReceipt
    || execution.applyIndexOutputPath !== options.applyIndex
    || execution.liveFlowPath !== options.runtimeFlow
    || execution.cutoverPlanSha256 !== options.expectedCutoverPlanSha256
    || execution.packetManifestSha256 !== options.expectedPacketManifestSha256
    || execution.fenceReceiptSha256 !== options.expectedFenceReceiptSha256
    || execution.migrationConnectionFileSha256 !== sha256(readPrivateBytes(
      options.migrationConnectionFile, "Migration Mongo connection", 1024 * 1024,
    ))
    || sha256(String(execution.tenantKey || "")) !== plan.tenantKeySha256
    || !path.isAbsolute(String(execution.migrationConnectionFile || ""))
    || !path.isAbsolute(String(execution.mongoWriteBarrierReceiptOutputPath || ""))
    || !path.isAbsolute(String(execution.applyIndexOutputPath || ""))
    || !path.isAbsolute(String(execution.liveFlowPath || ""))
    || !Array.isArray(execution.items) || execution.items.length !== plan.migration.planSha256s.length
    || execution.items.some((item) => !path.isAbsolute(String(item?.planPath || ""))
      || !path.isAbsolute(String(item?.reportPath || ""))
      || !path.isAbsolute(String(item?.backupDirectory || "")))) {
    fail("Cutover execution index is not the coordinator's exact execution contract");
  }
  const journalEntries = readCoordinatorJournal(options.coordinatorJournal, options.coordinatorAttemptId);
  const phases = journalEntries.map((entry) => entry.phase);
  if (phases[0] !== "ATTEMPT_STARTED" || phases.includes("TERMINAL_RESULT")
    || !phases.includes("MONGO_WRITE_BARRIER_HELD") || !phases.includes("GLOBAL_LEGACY_SCOPE_COVERED")
    || !phases.includes("CANDIDATE_PUBLISHED") || !phases.includes("RUNTIME_ONLINE_SHADOW")) {
    fail("Coordinator journal has not reached the exact pre-postcheck phase");
  }
  const barrierPhaseIndex = phases.indexOf("MONGO_WRITE_BARRIER_HELD");
  const coveragePhaseIndex = phases.indexOf("GLOBAL_LEGACY_SCOPE_COVERED");
  const candidatePhaseIndex = phases.indexOf("CANDIDATE_PUBLISHED");
  const runtimePhaseIndex = phases.indexOf("RUNTIME_ONLINE_SHADOW");
  if (!(barrierPhaseIndex < coveragePhaseIndex && coveragePhaseIndex < candidatePhaseIndex
    && candidatePhaseIndex < runtimePhaseIndex)) {
    fail("Coordinator journal phase order is invalid");
  }
  if (guardianRead.value?.kind !== "viva-game-projection-fence-guardian-receipt"
    || guardianRead.value?.state !== "HOLDING_UNTIL_EXPLICIT_RELEASE"
    || guardianRead.value?.fenceTokenSha256 !== plan.writerFence.fenceTokenSha256
    || guardianRead.value?.lockPath !== plan.writerFence.lockPath
    || guardianRead.value?.automaticRelease !== false) fail("Fence guardian receipt is not held for this cutover");
  let guardianLease = dependencies.assertGuardianLease
    ? await dependencies.assertGuardianLease(guardianRead.value, nowMs)
    : assertLiveFenceGuardian(guardianRead.value, nowMs);
  const packetRoot = fs.realpathSync(path.dirname(options.cutoverPlan));
  if (fs.realpathSync(path.dirname(options.packetManifest)) !== packetRoot) fail("Packet inputs do not share one root");
  if (dependencies.validateExactCutoverPacket) await dependencies.validateExactCutoverPacket({ packetRoot, plan, manifest });
  else validateExactCutoverPacket({ packetRoot, plan, manifest, nowMs });
  manifestEntry(manifest, "cutover-plan.json", options.expectedCutoverPlanSha256);

  const runtimeFlowRead = readPrivateBytes(options.runtimeFlow, "Runtime flow", MAX_JSON_BYTES);
  if (sha256(runtimeFlowRead) !== plan.candidateSha256) fail("Runtime flow is not the exact reviewed candidate");
  const connection = readFlowConnection(options.runtimeFlow, plan.candidateSha256);
  if (connection.connectionFingerprint !== plan.mongoTarget?.connectionFingerprint) fail("Runtime Mongo connection differs from the cutover target");

  validateHeldWriterFence(fenceRead.value, {
    sourceFlowSha256: plan.sourceFlowSha256,
    candidateSha256: plan.candidateSha256,
    tenantKey: applyIndexRead.value?.tenantKey,
    expectedOperationIds: plan.writerFence?.exactMigrationOperationIds,
    expectedWriterNodeIds: plan.writerFence?.exactWriterNodeIds,
    writerInventorySha256: plan.writerFence?.writerInventorySha256,
    externalWriterProofSha256: plan.writerFence?.externalWriterProofSha256,
    fenceTokenSha256: plan.writerFence?.fenceTokenSha256,
    lockPath: plan.writerFence?.lockPath,
    nowMs,
  });
  if (dependencies.assertFenceLease) dependencies.assertFenceLease(fenceRead.value);
  else assertExclusiveFenceLease(fenceRead.value);

  const pm2Processes = dependencies.readPm2 ? await dependencies.readPm2() : readPm2();
  const matches = Array.isArray(pm2Processes) ? pm2Processes.filter((item) => item?.name === plan.production?.processName) : [];
  const processEntry = matches[0];
  const tenantKey = String(envValue(processEntry, "PADLHUB_PLATFORM_TENANT_KEY") || "");
  const workerMode = String(envValue(processEntry, "VIVA_GAME_PROJECTION_SYNC_MODE") || "").toUpperCase();
  const restartAtMs = Number(processEntry?.pm2_env?.pm_uptime);
  if (os.hostname() !== plan.production?.hostname && !dependencies.allowFixtureHostname) fail("Postcheck host differs from the cutover production host");
  if (matches.length !== 1 || processEntry?.pm_id !== plan.production?.pm2ProcessId
    || String(processEntry?.pm2_env?.status || "").toLowerCase() !== "online"
    || sha256(tenantKey) !== plan.tenantKeySha256 || workerMode !== "SHADOW"
    || !Number.isFinite(restartAtMs) || restartAtMs > nowMs + 60_000 || nowMs - restartAtMs > 10 * 60_000) {
    fail("Live PM2 candidate, tenant, or SHADOW state is not proven");
  }
  assertNoCutoverEnvironment(processEntry);
  assertPm2RuntimeIdentity(processEntry, plan.production);
  const restartCount = Number(processEntry?.pm2_env?.restart_time);
  if (!Number.isSafeInteger(restartCount) || nowMs - restartAtMs < 10_000) {
    fail("Live PM2 candidate has not completed a stable runtime dwell");
  }

  if (!isObject(applyIndexRead.value) || applyIndexRead.value.formatVersion !== 1
    || applyIndexRead.value.kind !== "viva-game-projection-cutover-apply-index"
    || applyIndexRead.value.cutoverPlanSha256 !== options.expectedCutoverPlanSha256
    || sha256(applyIndexRead.value.tenantKey || "") !== plan.tenantKeySha256
    || !Array.isArray(applyIndexRead.value.items)
    || !/^\d{4}-\d{2}-\d{2}$/.test(String(applyIndexRead.value.globalLegacyCoverage?.dateFrom || ""))
    || applyIndexRead.value.globalLegacyCoverage?.dateFrom !== plan.migration?.futureBoundaryDate
    || !Array.isArray(applyIndexRead.value.globalLegacyCoverage?.mongoIds)
    || sha256(canonicalJson(applyIndexRead.value.globalLegacyCoverage?.mongoIds || []))
      !== applyIndexRead.value.globalLegacyCoverage?.mongoIdsSha256
    || applyIndexRead.value.items.length !== plan.migration.planSha256s.length) {
    fail("Apply index does not bind the cutover plan");
  }
  for (const [index, item] of applyIndexRead.value.items.entries()) {
    const executionItem = execution.items[index];
    const inFlightIndex = journalEntries.findIndex((entry) => entry.phase === "MIGRATION_PLAN_IN_FLIGHT"
      && entry.planSha256 === item?.planSha256 && entry.planPath === item?.planPath && entry.reportPath === item?.reportPath);
    const appliedIndex = journalEntries.findIndex((entry) => entry.phase === "MIGRATION_PLAN_APPLIED"
      && entry.planSha256 === item?.planSha256 && entry.reportPath === item?.reportPath
      && entry.reportSha256 === item?.reportSha256 && entry.backupPath === item?.backupPath
      && entry.backupSha256 === item?.backupSha256);
    if (item?.planPath !== executionItem?.planPath || item?.planSha256 !== executionItem?.planSha256
      || item?.reportPath !== executionItem?.reportPath || item?.backupPath === undefined
      || inFlightIndex <= coveragePhaseIndex || appliedIndex <= inFlightIndex || appliedIndex >= candidatePhaseIndex) {
      fail("Apply index is not backed by the exact coordinator journal");
    }
  }

  let ownedClient = null;
  const migrationConnection = dependencies.mongoContext ? null : readPrivateMongoConnection(
    options.migrationConnectionFile, plan.mongoTarget?.migrationConnectionFingerprint,
  );
  const mongoContext = dependencies.mongoContext || await (async () => {
    ownedClient = new MongoClient(migrationConnection.uri, {
      appName: "PadlHubVivaGameProjectionCutoverPostcheck",
      maxPoolSize: 1,
      serverSelectionTimeoutMS: 20_000,
      connectTimeoutMS: 20_000,
      socketTimeoutMS: 20_000,
      timeoutMS: 20_000,
    });
    await ownedClient.connect();
    return {
      client: ownedClient,
      collection: ownedClient.db(connection.dbName).collection("lk_games"),
      hello: await ownedClient.db("admin").command({ hello: 1 }),
    };
  })();
  try {
    const mongoTarget = buildMongoTargetIdentity({
      connectionFingerprint: connection.connectionFingerprint,
      replicaSetName: mongoContext.hello?.setName,
      database: connection.dbName,
      collection: "lk_games",
    });
    if (mongoTarget.targetIdentitySha256 !== plan.mongoTarget?.targetIdentitySha256) {
      fail("Postcheck Mongo target differs from the cutover target");
    }
    if (dependencies.assertMongoWriteBarrier) await dependencies.assertMongoWriteBarrier(barrierRead.value);
    else await assertMongoWriteBarrier(mongoContext.client, barrierRead.value, {
      fenceTokenSha256: plan.writerFence.fenceTokenSha256,
      cutoverPlanSha256: options.expectedCutoverPlanSha256,
      mongoTargetIdentitySha256: mongoTarget.targetIdentitySha256,
    });
    if (dependencies.assertNoConcurrentWrites) await dependencies.assertNoConcurrentWrites();
    else await assertNoConcurrentMongoWrites(mongoContext.client);

    const expectedPlanHashes = new Set(plan.migration.planSha256s);
    const operationIds = new Set();
    const applyReports = [];
    const applyReportBytesByPlan = {};
    const plannedMongoIds = [];
    let providerConfirmedTenantBoundCount = 0;
    for (const item of applyIndexRead.value.items) {
      assertHash(item?.planSha256, "Apply-index plan digest");
      assertHash(item?.reportSha256, "Apply-index report digest");
      if (!expectedPlanHashes.delete(item.planSha256)) fail("Apply index contains an unexpected or duplicate plan");
      const planPath = fs.realpathSync(item.planPath);
      const expectedPlanPath = path.join(packetRoot, "migration-plans", path.basename(planPath));
      if (planPath !== expectedPlanPath) fail("Apply-index migration plan is outside the packet");
      const planRead = readPrivateJson(planPath, "Migration plan", MAX_JSON_BYTES);
      if (sha256(planRead.bytes) !== item.planSha256) fail("Migration plan digest changed after packet preparation");
      manifestEntry(manifest, `migration-plans/${path.basename(planPath)}`, item.planSha256);
      validateExecutableTenantMigrationPlan(planRead.value, {
        expectedPlanSha256: item.planSha256,
        planBytes: planRead.bytes,
        expectedSourceFlowSha256: plan.sourceFlowSha256,
        expectedTenantKey: applyIndexRead.value.tenantKey,
        nowMs,
      });
      if (operationIds.has(planRead.value.scope.operationId)) fail("Apply index repeats a migration operationId");
      operationIds.add(planRead.value.scope.operationId);
      const reportRead = readPrivateJson(item.reportPath, "Migration apply report", MAX_JSON_BYTES);
      if (sha256(reportRead.bytes) !== item.reportSha256) fail("Migration apply report digest mismatch");
      const report = reportRead.value;
      if (report?.mode !== "APPLY" || report.outcome !== "SUCCEEDED"
        || report.planSha256 !== item.planSha256 || report.sourceFlowSha256 !== plan.sourceFlowSha256
        || report.mongoTargetIdentitySha256 !== mongoTarget.targetIdentitySha256) {
        fail("Migration apply report is not a successful exact-target receipt");
      }
      validateApplyReceipt(report.applyReceipt, planRead.value, item.planSha256);
      applyReportBytesByPlan[item.planSha256] = reportRead.bytes;
      for (const [index, operation] of planRead.value.operations.entries()) {
        const decoded = decodeTenantMigrationOperation(operation);
        plannedMongoIds.push(decoded.filter._id.toHexString());
        const current = await mongoContext.collection.findOne({ _id: decoded.filter._id });
        if (!current || hashCanonicalEjson(current) !== report.applyReceipt.operations[index].postimageSha256) {
          fail("Provider-confirmed migrated row changed before postcheck");
        }
        providerConfirmedTenantBoundCount += 1;
      }
      applyReports.push({
        planSha256: item.planSha256,
        reportSha256: item.reportSha256,
        applyReceiptSha256: sha256(canonicalJson(report.applyReceipt)),
      });
    }
    if (expectedPlanHashes.size !== 0
      || JSON.stringify([...operationIds].sort()) !== JSON.stringify([...(plan.migration.operationIds || [])].sort())) {
      fail("Apply index does not cover every cutover migration plan");
    }
    if (JSON.stringify(plannedMongoIds.sort()) !== JSON.stringify([...applyIndexRead.value.globalLegacyCoverage.mongoIds].sort())) {
      fail("Apply index global legacy coverage does not match the exact migrated identities");
    }

    const activeLegacyQuery = buildGlobalActiveLegacyTenantQuery({
      dateFrom: applyIndexRead.value.globalLegacyCoverage.dateFrom,
    });
    const activeReachableLegacyCount = await mongoContext.collection.countDocuments(activeLegacyQuery);
    const tenantDocuments = await mongoContext.collection.find({
      archived: { $ne: true },
      "booking.date": { $gte: applyIndexRead.value.globalLegacyCoverage.dateFrom },
      $or: [{ tenantKey }, { tenantKey: null }, { tenantKey: { $exists: false } }],
    }, { projection: {
      id: 1, dedupeKey: 1, "booking.vivaExerciseId": 1, "booking.exerciseId": 1,
      "metadata.vivaExerciseId": 1, "metadata.exerciseId": 1,
    } }).toArray();
    const duplicateCount = duplicateIdentityCount(tenantDocuments, tenantKey);
    const restartAt = new Date(restartAtMs).toISOString();
    const workerWriteCount = await mongoContext.collection.countDocuments({
      "audit.events": { $elemMatch: { source: "viva_game_projection_sync", at: { $gte: restartAt } } },
    });
    if (dependencies.assertNoConcurrentWrites) await dependencies.assertNoConcurrentWrites();
    else await assertNoConcurrentMongoWrites(mongoContext.client);
    if (dependencies.assertFenceLease) dependencies.assertFenceLease(fenceRead.value);
    else assertExclusiveFenceLease(fenceRead.value);

    const finalNowMs = clockNow();
    if (dependencies.assertExecutorSources) await dependencies.assertExecutorSources(plan);
    else assertExactExecutorSources(plan);
    validateHeldWriterFence(fenceRead.value, {
      sourceFlowSha256: plan.sourceFlowSha256,
      candidateSha256: plan.candidateSha256,
      tenantKey,
      expectedOperationIds: plan.writerFence.exactMigrationOperationIds,
      expectedWriterNodeIds: plan.writerFence.exactWriterNodeIds,
      writerInventorySha256: plan.writerFence.writerInventorySha256,
      externalWriterProofSha256: plan.writerFence.externalWriterProofSha256,
      fenceTokenSha256: plan.writerFence.fenceTokenSha256,
      lockPath: plan.writerFence.lockPath,
      nowMs: finalNowMs,
    });
    if (dependencies.assertFenceLease) dependencies.assertFenceLease(fenceRead.value);
    else assertExclusiveFenceLease(fenceRead.value);
    if (dependencies.assertMongoWriteBarrier) await dependencies.assertMongoWriteBarrier(barrierRead.value);
    else await assertMongoWriteBarrier(mongoContext.client, barrierRead.value, {
      fenceTokenSha256: plan.writerFence.fenceTokenSha256,
      cutoverPlanSha256: options.expectedCutoverPlanSha256,
      mongoTargetIdentitySha256: mongoTarget.targetIdentitySha256,
    });
    guardianLease = dependencies.assertGuardianLease
      ? await dependencies.assertGuardianLease(guardianRead.value, finalNowMs)
      : assertLiveFenceGuardian(guardianRead.value, finalNowMs);
    const finalPm2 = dependencies.readPm2 ? await dependencies.readPm2() : readPm2();
    const finalMatches = Array.isArray(finalPm2) ? finalPm2.filter((item) => item?.name === plan.production.processName) : [];
    if (finalMatches.length !== 1 || finalMatches[0]?.pm_id !== plan.production.pm2ProcessId
      || String(finalMatches[0]?.pm2_env?.status || "").toLowerCase() !== "online"
      || sha256(String(envValue(finalMatches[0], "PADLHUB_PLATFORM_TENANT_KEY") || "")) !== plan.tenantKeySha256
      || String(envValue(finalMatches[0], "VIVA_GAME_PROJECTION_SYNC_MODE") || "").toUpperCase() !== "SHADOW"
      || Number(finalMatches[0]?.pm2_env?.restart_time) !== restartCount
      || finalNowMs - Number(finalMatches[0]?.pm2_env?.pm_uptime) < 10_000
      || sha256(readPrivateBytes(options.runtimeFlow, "Runtime flow final readback", MAX_JSON_BYTES)) !== plan.candidateSha256) {
      fail("Final runtime, tenant, SHADOW, or candidate readback failed");
    }
    assertNoCutoverEnvironment(finalMatches[0]);
    assertPm2RuntimeIdentity(finalMatches[0], plan.production);
    const runtimeHealth = dependencies.probeRuntimeHealth
      ? await dependencies.probeRuntimeHealth(plan.production.localHealthUrl)
      : await probeLocalRuntimeHealth(plan.production.localHealthUrl, plan.candidateCanonicalSha256);
    if (runtimeHealth?.url !== plan.production.localHealthUrl
      || runtimeHealth?.statusCode !== 200
      || runtimeHealth?.bodyCanonicalSha256 !== plan.candidateCanonicalSha256) {
      fail("Final Node-RED health proof is not bound to the frozen local endpoint");
    }

    const outputDirectory = ensurePrivateDirectory(options.outputDirectory, "Postcheck output directory");
    const activeEvidence = writeEvidence(outputDirectory, "active-reachable-legacy.query.json", {
      formatVersion: 1, kind: "viva-game-projection-active-legacy-query", mongoTargetIdentitySha256: mongoTarget.targetIdentitySha256,
      planSha256s: plan.migration.planSha256s, count: activeReachableLegacyCount, observedAt: new Date(nowMs).toISOString(),
    });
    const duplicateEvidence = writeEvidence(outputDirectory, "duplicate-identity.query.json", {
      formatVersion: 1, kind: "viva-game-projection-duplicate-identity-query", tenantKeySha256: plan.tenantKeySha256,
      inspectedDocumentCount: tenantDocuments.length, count: duplicateCount, observedAt: new Date(nowMs).toISOString(),
    });
    const providerEvidence = writeEvidence(outputDirectory, "provider-tenant-bound.query.json", {
      formatVersion: 1, kind: "viva-game-projection-provider-tenant-bound-query", tenantKeySha256: plan.tenantKeySha256,
      appliedPlanSha256s: plan.migration.planSha256s, exactPostimageCount: providerConfirmedTenantBoundCount,
      observedAt: new Date(finalNowMs).toISOString(),
    });
    const workerEvidence = writeEvidence(outputDirectory, "worker-mode.query.json", {
      formatVersion: 1, kind: "viva-game-projection-worker-mode-query", candidateSha256: plan.candidateSha256,
      mode: workerMode, restartAt, writeCount: workerWriteCount, observedAt: new Date(nowMs).toISOString(),
    });
    const receipt = {
      formatVersion: 1,
      kind: "viva-game-projection-tenant-cutover-postcheck",
      state: "PASS",
      sourceFlowSha256: plan.sourceFlowSha256,
      candidateSha256: plan.candidateSha256,
      tenantKeySha256: plan.tenantKeySha256,
      appliedPlanSha256s: plan.migration.planSha256s,
      writerFenceState: "HELD",
      fenceTokenSha256: plan.writerFence.fenceTokenSha256,
      fenceReceiptSha256: options.expectedFenceReceiptSha256,
      mongoWriteBarrierReceiptSha256: options.expectedMongoWriteBarrierReceiptSha256,
      executionIndexSha256: options.expectedExecutionIndexSha256,
      coordinatorAttemptId: options.coordinatorAttemptId,
      fenceGuardianReceiptSha256: options.fenceGuardianReceiptSha256,
      fenceGuardianHeartbeatSha256: guardianLease.sha256,
      fenceExpiresAt: fenceRead.value.expiresAt,
      mongoTargetIdentitySha256: mongoTarget.targetIdentitySha256,
      activeReachableLegacyCount,
      duplicateIdentityCount: duplicateCount,
      providerConfirmedTenantBoundCount,
      workerMode,
      workerWriteCount,
      runtimeTenantReadback: true,
      candidateFlowReadback: true,
      runtimeHealth,
      observedAt: new Date(finalNowMs).toISOString(),
      applyReports,
      queryEvidence: {
        activeReachableLegacySha256: activeEvidence.sha256,
        duplicateIdentitySha256: duplicateEvidence.sha256,
        providerTenantBoundSha256: providerEvidence.sha256,
        workerModeSha256: workerEvidence.sha256,
      },
      ingressReopened: false,
    };
    validateVivaGameProjectionCutoverPostcheck(receipt, plan, finalNowMs, {
      applyReportBytesByPlan,
      mongoWriteBarrierReceiptBytes: barrierRead.bytes,
      executionIndexBytes: executionRead.bytes,
      fenceGuardianReceiptBytes: guardianRead.bytes,
      fenceGuardianHeartbeatBytes: guardianLease.bytes,
      queryEvidenceBytes: {
        activeReachableLegacySha256: activeEvidence.bytes,
        duplicateIdentitySha256: duplicateEvidence.bytes,
        providerTenantBoundSha256: providerEvidence.bytes,
        workerModeSha256: workerEvidence.bytes,
      },
    });
    const receiptArtifact = writeEvidence(outputDirectory, "postcheck.receipt.json", receipt);
    const outputManifest = {
      formatVersion: 1,
      kind: "viva-game-projection-cutover-postcheck-manifest",
      state: "PASS",
      cutoverPlanSha256: options.expectedCutoverPlanSha256,
      packetManifestSha256: options.expectedPacketManifestSha256,
      applyIndexSha256: options.expectedApplyIndexSha256,
      fenceReceiptSha256: options.expectedFenceReceiptSha256,
      mongoWriteBarrierReceiptSha256: options.expectedMongoWriteBarrierReceiptSha256,
      executionIndexSha256: options.expectedExecutionIndexSha256,
      coordinatorAttemptId: options.coordinatorAttemptId,
      fenceGuardianReceiptSha256: options.fenceGuardianReceiptSha256,
      fenceGuardianHeartbeatSha256: guardianLease.sha256,
      files: [activeEvidence, duplicateEvidence, providerEvidence, workerEvidence, receiptArtifact]
        .map((entry) => ({ path: path.basename(entry.path), sha256: entry.sha256 })),
    };
    const manifestArtifact = writeEvidence(outputDirectory, "postcheck.manifest.json", outputManifest);
    return {
      receipt,
      outputManifest,
      postcheckReceiptPath: receiptArtifact.path,
      postcheckReceiptSha256: receiptArtifact.sha256,
      postcheckManifestPath: manifestArtifact.path,
      postcheckManifestSha256: manifestArtifact.sha256,
    };
  } finally {
    await ownedClient?.close().catch(() => {});
  }
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const values = parseArgs(argv);
  const result = await prepareVivaGameProjectionCutoverPostcheck({
    cutoverPlan: values.get("--cutover-plan"),
    packetManifest: values.get("--packet-manifest"),
    expectedCutoverPlanSha256: values.get("--expected-cutover-plan-sha256"),
    expectedPacketManifestSha256: values.get("--expected-packet-manifest-sha256"),
    applyIndex: values.get("--apply-index"),
    expectedApplyIndexSha256: values.get("--expected-apply-index-sha256"),
    runtimeFlow: values.get("--runtime-flow"),
    fenceReceipt: values.get("--fence-receipt"),
    expectedFenceReceiptSha256: values.get("--expected-fence-receipt-sha256"),
    mongoWriteBarrierReceipt: values.get("--mongo-write-barrier-receipt"),
    expectedMongoWriteBarrierReceiptSha256: values.get("--expected-mongo-write-barrier-receipt-sha256"),
    migrationConnectionFile: values.get("--migration-connection-file"),
    executionIndex: values.get("--execution-index"),
    expectedExecutionIndexSha256: values.get("--expected-execution-index-sha256"),
      coordinatorAttemptId: values.get("--coordinator-attempt-id"),
    fenceGuardianReceiptSha256: values.get("--fence-guardian-receipt-sha256"),
      fenceGuardianReceipt: values.get("--fence-guardian-receipt"),
      coordinatorJournal: values.get("--coordinator-journal"),
    outputDirectory: values.get("--output-directory"),
  }, dependencies);
  process.stdout.write(`${JSON.stringify({
    state: result.receipt.state,
    postcheckReceiptSha256: result.postcheckReceiptSha256,
    postcheckManifestSha256: result.postcheckManifestSha256,
    readyMarkerPublished: false,
  })}\n`);
  return result;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === SCRIPT_PATH) {
  if (process.argv.slice(2).includes("--help")) {
    process.stdout.write("Usage: node scripts/prepare_viva_game_projection_cutover_postcheck.mjs --cutover-plan /private/packet/cutover-plan.json --packet-manifest /private/packet/packet.manifest.json --expected-cutover-plan-sha256 SHA256 --expected-packet-manifest-sha256 SHA256 --apply-index /private/apply-index.json --expected-apply-index-sha256 SHA256 --runtime-flow /root/.node-red/flows.json --fence-receipt /private/fence.json --expected-fence-receipt-sha256 SHA256 --mongo-write-barrier-receipt /private/barrier.json --expected-mongo-write-barrier-receipt-sha256 SHA256 --migration-connection-file /private/migration-mongo.json --execution-index /private/execution-index.json --expected-execution-index-sha256 SHA256 --coordinator-attempt-id UUID --coordinator-journal /private/cutover-report.json.journal --fence-guardian-receipt /private/guardian.json --fence-guardian-receipt-sha256 SHA256 --output-directory /private/new-postcheck\n");
  } else {
    main().catch((error) => {
      process.stderr.write(`${String(error instanceof Error ? error.message : error).replace(/mongodb(?:\+srv)?:\/\/[^\s]+/gi, "[REDACTED_MONGO_URI]").slice(0, 500)}\n`);
      process.exitCode = 1;
    });
  }
}
