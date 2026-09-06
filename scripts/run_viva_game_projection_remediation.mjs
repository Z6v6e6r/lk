#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BSON, MongoClient } from "mongodb";

import { canonicalJson, sha256 } from "./lib/vivaGameProjectionCutoverContract.mjs";
import { assertExactExecutorSources } from "./lib/vivaGameProjectionExecutorSource.mjs";
import {
  assertMongoWriteBarrier,
  hashLiveFullCollection,
  mongoAuthenticationRestrictionsSha256,
} from "./lib/vivaGameProjectionMongoWriteBarrier.mjs";
import {
  captureRemediationPreimages,
  reconcileRemediationOutcome,
  reconcileRemediationRestoreOutcome,
  runRemediationTransaction,
  validateExecutableRemediationPlan,
  validateRemediationApplyReceipt,
  validateRemediationBackup,
} from "./lib/vivaGameProjectionRemediationExecution.mjs";
import { validateRemediationExecutionIndex } from "./lib/vivaGameProjectionRemediationPackage.mjs";
import {
  assertExclusiveFenceLease,
  assertNoConcurrentMongoWrites,
  createDurableReportJournal,
  ensurePrivateDirectory,
  readFlowConnection,
  readPrivateBytes,
  readPrivateJson,
  readPrivateMongoConnection,
  validateHeldWriterFence,
} from "./run_viva_game_projection_tenant_migration.mjs";
import { writeFileExclusiveAtomicDurable } from "./nodered_reviewed_flow_deploy/runtime_contract.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const APPLY_CONFIRMATION = "APPLY_VIVA_GAME_PROJECTION_REMEDIATION_V2";
const RESTORE_CONFIRMATION = "RESTORE_VIVA_GAME_PROJECTION_REMEDIATION_V2";
const PRODUCTION_FLOW_PATH = "/root/.node-red/flows.json";
const MAX_JSON_BYTES = 64 * 1024 * 1024;
const MAX_BACKUP_BYTES = 1024 * 1024 * 1024;
const WRITE_COMMANDS = new Set([
  "insert", "update", "delete", "findAndModify", "createIndexes", "drop", "dropDatabase", "renameCollection", "collMod",
]);
const INDEX_INPUT_OPTIONS = Object.freeze({
  plan: "--plan",
  cutoverPlan: "--cutover-plan",
  migrationPlanBundle: "--migration-plan-bundle",
  packet: "--packet",
  enrichment: "--enrichment",
  identityAudit: "--identity-audit",
  providerCapture: "--provider-capture",
  mongoCapture: "--mongo-capture",
  fullBackup: "--full-backup",
  fullBackupManifest: "--full-backup-manifest",
  restoreRehearsalReceipt: "--restore-rehearsal-receipt",
  restoredArtifact: "--restored-artifact",
  fenceReceipt: "--fence-receipt",
  mongoWriteBarrierReceipt: "--mongo-write-barrier-receipt",
  migrationConnectionFile: "--migration-connection-file",
  flow: "--flow-path",
});

const fail = (message) => { throw new Error(message); };
const safeError = (error) => String(error instanceof Error ? error.message : error)
  .replace(/mongodb(?:\+srv)?:\/\/[^\s]+/gi, "[REDACTED_MONGO_URI]")
  .slice(0, 500);

function parseValues(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--") || values.has(key)) {
      fail(`Invalid argument: ${key || ""}`);
    }
    values.set(key, value);
  }
  return values;
}

function expandExecutionIndex(values) {
  const executionIndexPath = values.get("--execution-index");
  if (!executionIndexPath) return values;
  const allowed = new Set([
    "--execution-index", "--expected-execution-index-sha256", "--mode", "--report", "--backup-dir",
    "--backup", "--expected-backup-sha256", "--apply-receipt", "--expected-apply-report-sha256",
  ]);
  if ([...values.keys()].some((key) => !allowed.has(key))) {
    fail("Remediation execution-index mode does not allow overriding pinned inputs");
  }
  const expectedSha256 = values.get("--expected-execution-index-sha256");
  if (!expectedSha256) fail("Missing --expected-execution-index-sha256");
  const indexRead = readPrivateJson(executionIndexPath, "Remediation execution index", MAX_JSON_BYTES);
  const index = validateRemediationExecutionIndex(indexRead.value, {
    expectedSha256,
    bytes: indexRead.bytes,
  });
  const expanded = new Map([...values].filter(([key]) => !key.startsWith("--execution-index")));
  const pinnedBytes = new Map();
  for (const [name, option] of Object.entries(INDEX_INPUT_OPTIONS)) {
    const entry = index.inputs[name];
    const maximumSize = new Set(["fullBackup", "restoredArtifact"]).has(name)
      ? MAX_BACKUP_BYTES
      : name === "flow" ? 256 * 1024 * 1024 : MAX_JSON_BYTES;
    const bytes = readPrivateBytes(entry.path, `Remediation execution index ${name}`, maximumSize);
    if (sha256(bytes) !== entry.sha256) fail(`Remediation execution index ${name} digest mismatch`);
    pinnedBytes.set(name, bytes);
    expanded.set(option, entry.path);
  }
  let plan;
  try { plan = JSON.parse(pinnedBytes.get("plan").toString("utf8")); }
  catch { fail("Remediation execution index plan is not valid JSON"); }
  if (canonicalJson(plan?.repository) !== canonicalJson(index.repository)
    || plan?.source?.sourceFlowSha256 !== index.inputs.flow.sha256) {
    fail("Remediation execution index does not bind the plan repository and runtime flow");
  }
  expanded.set("--expected-plan-sha256", index.inputs.plan.sha256);
  return expanded;
}

export function parseArgs(argv) {
  const values = expandExecutionIndex(parseValues(argv));
  const mode = values.get("--mode");
  if (!new Set(["verify", "apply", "restore", "reconcile", "reconcile-restore"]).has(mode)) {
    fail("--mode must be verify, apply, restore, reconcile, or reconcile-restore");
  }
  for (const key of [
    "--plan", "--expected-plan-sha256", "--cutover-plan", "--migration-plan-bundle", "--packet", "--enrichment", "--identity-audit",
    "--provider-capture", "--mongo-capture", "--full-backup", "--full-backup-manifest",
    "--restore-rehearsal-receipt", "--restored-artifact", "--fence-receipt", "--mongo-write-barrier-receipt",
    "--migration-connection-file", "--flow-path", "--report",
  ]) if (!values.get(key)) fail(`Missing ${key}`);
  if (mode === "apply" && !values.get("--backup-dir")) fail("Apply requires --backup-dir");
  if (new Set(["restore", "reconcile-restore"]).has(mode)
    && (!values.get("--backup") || !values.get("--expected-backup-sha256")
      || !values.get("--apply-receipt") || !values.get("--expected-apply-report-sha256"))) {
    fail("Restore requires the exact remediation backup and apply report digests");
  }
  if (mode === "reconcile" && (!values.get("--backup") || !values.get("--expected-backup-sha256"))) {
    fail("Reconcile requires the exact remediation backup digest");
  }
  return { mode, values };
}

const jsonArtifact = (values, option, label) => readPrivateJson(values.get(option), label, MAX_JSON_BYTES);
const readEjson = (filePath, label) => {
  const bytes = readPrivateBytes(filePath, label, MAX_BACKUP_BYTES);
  try { return { bytes, value: BSON.EJSON.parse(bytes.toString("utf8"), { relaxed: false }) }; }
  catch { fail(`${label} is not canonical EJSON`); }
};

function writeBackup(backupDirectory, planSha256, backup, plan) {
  const directory = ensurePrivateDirectory(backupDirectory, "Remediation backup directory");
  const filePath = path.join(directory, `viva-remediation-${planSha256}-${Date.now()}.ejson`);
  const bytes = Buffer.from(`${BSON.EJSON.stringify(backup, null, 2, { relaxed: false })}\n`);
  writeFileExclusiveAtomicDurable(filePath, bytes, {
    uid: typeof process.getuid === "function" ? process.getuid() : 0,
    gid: typeof process.getgid === "function" ? process.getgid() : 0,
    mode: 0o600,
  });
  const readback = readEjson(filePath, "Remediation backup readback");
  if (sha256(readback.bytes) !== sha256(bytes)) fail("Remediation backup durable readback mismatch");
  validateRemediationBackup(readback.value, plan, planSha256);
  return { path: filePath, sha256: sha256(bytes), value: readback.value };
}

function assertProductionFence(values, receipt, plan, cutoverPlan, nowMs, { allowExpiredLease = false } = {}) {
  if (typeof process.getuid !== "function" || process.getuid() !== 0
    || path.resolve(values.get("--flow-path")) !== PRODUCTION_FLOW_PATH
    || os.hostname() !== receipt.hostname) {
    fail("Remediation executor is not on the exact production host and canonical flow path");
  }
  validateHeldWriterFence(receipt, {
    sourceFlowSha256: plan.source.sourceFlowSha256,
    candidateSha256: cutoverPlan.candidateSha256,
    tenantKey: receipt.tenantKey,
    expectedOperationIds: cutoverPlan.writerFence.exactMigrationOperationIds,
    expectedWriterNodeIds: cutoverPlan.writerFence.exactWriterNodeIds,
    writerInventorySha256: cutoverPlan.writerFence.writerInventorySha256,
    externalWriterProofSha256: cutoverPlan.writerFence.externalWriterProofSha256,
    fenceTokenSha256: plan.source.fenceTokenSha256,
    lockPath: cutoverPlan.writerFence.lockPath,
    nowMs,
    allowExpiredLease,
  });
  assertExclusiveFenceLease(receipt);
  const pm2 = spawnSync("pm2", ["jlist"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  let processes;
  try { processes = JSON.parse(pm2.stdout); } catch { fail("Unable to read stopped Node-RED state under remediation fence"); }
  const matches = Array.isArray(processes) ? processes.filter((entry) => entry?.name === receipt.processName) : [];
  if (pm2.status !== 0 || matches.length !== 1 || matches[0]?.pm_id !== receipt.pm2ProcessId
    || String(matches[0]?.pm2_env?.status || "").toLowerCase() !== "stopped"
    || sha256(String(matches[0]?.pm2_env?.PADLHUB_PLATFORM_TENANT_KEY
      || matches[0]?.pm2_env?.env?.PADLHUB_PLATFORM_TENANT_KEY || "")) !== plan.source.tenantKeySha256
    || String(matches[0]?.pm2_env?.VIVA_GAME_PROJECTION_SYNC_MODE
      || matches[0]?.pm2_env?.env?.VIVA_GAME_PROJECTION_SYNC_MODE || "") !== plan.source.runtimeMode) {
    fail("Node-RED is no longer stopped under the exact remediation fence");
  }
}

export async function assertFrozenRemediationFullCollection(collection, plan, hashLive = hashLiveFullCollection) {
  const live = await hashLive(collection);
  if (live?.documentCount !== plan.source.fullBackupDocumentCount
    || live?.fullCollectionStateSha256 !== plan.source.fullCollectionStateSha256) {
    fail("Live games.lk_games state does not exactly match the frozen remediation backup under the Mongo barrier");
  }
  return live;
}

async function run({ mode, values }, dependencies = {}) {
  const clockNow = () => (typeof dependencies.nowMs === "function" ? dependencies.nowMs() : (dependencies.nowMs ?? Date.now()));
  const planRead = jsonArtifact(values, "--plan", "Remediation plan");
  const plan = planRead.value;
  const expectedPlanSha256 = values.get("--expected-plan-sha256");
  const inputs = {
    cutoverPlan: jsonArtifact(values, "--cutover-plan", "Remediation cutover plan"),
    migrationPlanBundle: jsonArtifact(values, "--migration-plan-bundle", "Remediation migration plan bundle"),
    packet: jsonArtifact(values, "--packet", "Remediation packet"),
    enrichment: jsonArtifact(values, "--enrichment", "Remediation enrichment"),
    identityAudit: jsonArtifact(values, "--identity-audit", "Remediation identity audit"),
    providerCapture: jsonArtifact(values, "--provider-capture", "Remediation provider capture"),
    mongoCapture: jsonArtifact(values, "--mongo-capture", "Remediation Mongo capture"),
    fullBackup: { bytes: readPrivateBytes(values.get("--full-backup"), "Remediation full backup", MAX_BACKUP_BYTES) },
    restoredArtifact: { bytes: readPrivateBytes(values.get("--restored-artifact"), "Remediation restored artifact", MAX_BACKUP_BYTES) },
    fullBackupManifest: jsonArtifact(values, "--full-backup-manifest", "Remediation full backup manifest"),
    restoreRehearsalReceipt: jsonArtifact(values, "--restore-rehearsal-receipt", "Remediation restore rehearsal"),
    fenceReceipt: jsonArtifact(values, "--fence-receipt", "Remediation writer fence"),
    mongoWriteBarrierReceipt: jsonArtifact(values, "--mongo-write-barrier-receipt", "Remediation Mongo barrier"),
  };
  validateExecutableRemediationPlan(plan, {
    expectedPlanSha256,
    planBytes: planRead.bytes,
    artifacts: inputs,
    nowMs: clockNow(),
    enforceFreshness: mode === "apply" || mode === "verify",
  });
  (dependencies.assertExecutorSources || assertExactExecutorSources)(plan);
  const flowConnection = readFlowConnection(values.get("--flow-path"), plan.source.sourceFlowSha256);
  if (flowConnection.connectionFingerprint !== plan.source.applicationConnectionFingerprint) {
    fail("Remediation application Mongo connection fingerprint mismatch");
  }
  const migrationConnection = readPrivateMongoConnection(
    values.get("--migration-connection-file"),
    plan.source.migrationConnectionFingerprint,
  );
  if (mongoAuthenticationRestrictionsSha256(migrationConnection.authenticationRestrictions)
    !== plan.source.migrationAuthenticationRestrictionsSha256) {
    fail("Remediation migration network allowlist differs from the frozen plan");
  }
  const journal = createDurableReportJournal(values.get("--report"), mode, dependencies.attemptId);
  const client = dependencies.mongoClient || new MongoClient(migrationConnection.uri, {
    appName: `PadlHubVivaProjectionRemediation:${mode}`,
    maxPoolSize: 1,
    serverSelectionTimeoutMS: 20_000,
    connectTimeoutMS: 20_000,
    socketTimeoutMS: 20_000,
    timeoutMS: 20_000,
    monitorCommands: true,
  });
  let writeCommandCount = 0;
  let mutationAttempted = false;
  let phase = "CONNECTING";
  let backupPath = null;
  let backupSha256 = null;
  const recoveryMode = new Set(["reconcile", "reconcile-restore", "restore"]).has(mode);
  client.on?.("commandStarted", (event) => { if (WRITE_COMMANDS.has(event.commandName)) writeCommandCount += 1; });
  try {
    if (!dependencies.mongoClient) await client.connect();
    const hello = await client.db("admin").command({ hello: 1 });
    if (hello.setName !== plan.source.replicaSetName) fail("Remediation Mongo replica set mismatch");
    const collection = client.db("games").collection("lk_games");
    const assertFence = async () => {
      const currentFence = jsonArtifact(values, "--fence-receipt", "Current remediation writer fence");
      const currentBarrier = jsonArtifact(values, "--mongo-write-barrier-receipt", "Current remediation Mongo barrier");
      if (sha256(currentFence.bytes) !== plan.source.fenceReceiptSha256
        || sha256(currentBarrier.bytes) !== plan.source.mongoWriteBarrierReceiptSha256) {
        fail("Remediation fence or Mongo barrier receipt changed during execution");
      }
      if (dependencies.assertProductionFence) {
        await dependencies.assertProductionFence(currentFence.value, plan, inputs.cutoverPlan.value, clockNow(), {
          allowExpiredLease: recoveryMode,
        });
      } else assertProductionFence(values, currentFence.value, plan, inputs.cutoverPlan.value, clockNow(), {
        allowExpiredLease: recoveryMode,
      });
      await assertMongoWriteBarrier(client, currentBarrier.value, {
        fenceTokenSha256: plan.source.fenceTokenSha256,
        cutoverPlanSha256: plan.source.cutoverPlanSha256,
        mongoTargetIdentitySha256: plan.source.mongoTargetIdentitySha256,
        migrationAuthenticationRestrictions: migrationConnection.authenticationRestrictions,
      });
      await assertNoConcurrentMongoWrites(client);
    };
    await assertFence();
    if (mode === "apply" || mode === "verify") {
      await assertFrozenRemediationFullCollection(
        collection,
        plan,
        dependencies.hashLiveFullCollection || hashLiveFullCollection,
      );
    } else {
      journal.append("RECOVERY_CONTROLS_INTENT", {
        planSha256: expectedPlanSha256,
        expectedBackupSha256: values.get("--expected-backup-sha256"),
        expectedApplyReportSha256: values.get("--expected-apply-report-sha256") || null,
        fenceReceiptSha256: plan.source.fenceReceiptSha256,
        mongoWriteBarrierReceiptSha256: plan.source.mongoWriteBarrierReceiptSha256,
        initiatedAt: new Date(clockNow()).toISOString(),
      });
    }
    journal.append("TARGET_AND_FENCE_VERIFIED", { mongoTargetIdentitySha256: plan.source.mongoTargetIdentitySha256 });
    if (mode === "verify") {
      if (writeCommandCount !== 0) fail("Remediation verify attempted a Mongo write command");
      const result = {
        formatVersion: 1, mode: "VERIFY", outcome: "VERIFIED_NO_MUTATION", mutationAttempted: false,
        planSha256: expectedPlanSha256, operationId: plan.operationId, operationCount: plan.operations.length,
        mongoTargetIdentitySha256: plan.source.mongoTargetIdentitySha256, writeCommandCount,
      };
      journal.finalize(result);
      return result;
    }
    let backup;
    let applyReceipt;
    if (mode === "apply") {
      if (process.env.VIVA_GAME_PROJECTION_REMEDIATION_APPLY !== APPLY_CONFIRMATION) fail("Remediation apply confirmation is absent");
      const captured = await captureRemediationPreimages(collection, plan, expectedPlanSha256, new Date().toISOString());
      const durable = writeBackup(values.get("--backup-dir"), expectedPlanSha256, captured, plan);
      backup = durable.value;
      backupPath = durable.path;
      backupSha256 = durable.sha256;
      journal.append("REMEDIATION_BACKUP_DURABLE", { backupPath, backupSha256, recordCount: backup.recordCount });
    } else {
      const backupRead = readEjson(values.get("--backup"), "Remediation execution backup");
      backupSha256 = sha256(backupRead.bytes);
      backupPath = values.get("--backup");
      if (backupSha256 !== values.get("--expected-backup-sha256")) fail("Remediation backup digest mismatch");
      backup = backupRead.value;
      validateRemediationBackup(backup, plan, expectedPlanSha256);
    }
    if (new Set(["restore", "reconcile-restore"]).has(mode)) {
      const applyRead = jsonArtifact(values, "--apply-receipt", "Remediation apply report");
      if (sha256(applyRead.bytes) !== values.get("--expected-apply-report-sha256")
        || applyRead.value?.backupSha256 !== backupSha256) fail("Remediation apply report digest/binding mismatch");
      applyReceipt = applyRead.value?.applyReceipt;
      validateRemediationApplyReceipt(applyReceipt, plan, expectedPlanSha256);
    }
    if (recoveryMode) {
      journal.append("RECOVERY_CONTROLS_VERIFIED", {
        planSha256: expectedPlanSha256,
        backupSha256,
        applyReportSha256: values.get("--expected-apply-report-sha256") || null,
        fenceReceiptSha256: plan.source.fenceReceiptSha256,
        mongoWriteBarrierReceiptSha256: plan.source.mongoWriteBarrierReceiptSha256,
        verifiedAt: new Date(clockNow()).toISOString(),
      });
    }
    if (mode === "reconcile" || mode === "reconcile-restore") {
      const reconciliation = mode === "reconcile"
        ? await reconcileRemediationOutcome(collection, plan, expectedPlanSha256, backup)
        : await reconcileRemediationRestoreOutcome(
          collection, plan, expectedPlanSha256, backup, applyReceipt, new Date().toISOString(),
        );
      await assertFence();
      if (writeCommandCount !== 0) fail("Remediation reconciliation attempted a Mongo write command");
      const result = {
        formatVersion: 1, mode: mode.toUpperCase(), outcome: reconciliation.outcome, mutationAttempted: false,
        planSha256: expectedPlanSha256, operationId: plan.operationId, backupPath, backupSha256,
        mongoTargetIdentitySha256: plan.source.mongoTargetIdentitySha256, writeCommandCount,
        applyReceipt: reconciliation.applyReceipt || null,
        restoreReceipt: reconciliation.restoreReceipt || null,
        counts: {
          preimage: reconciliation.preimageCount,
          postimage: reconciliation.postimageCount,
          drift: reconciliation.driftCount,
        },
      };
      journal.finalize(result);
      return result;
    }
    if (mode === "restore" && process.env.VIVA_GAME_PROJECTION_REMEDIATION_RESTORE !== RESTORE_CONFIRMATION) {
      fail("Remediation restore confirmation is absent");
    }
    phase = mode === "apply" ? "REMEDIATION_TRANSACTION_OUTCOME_UNKNOWN" : "REMEDIATION_RESTORE_OUTCOME_UNKNOWN";
    journal.append(phase, { backupPath, backupSha256, mutationAttempted: true });
    mutationAttempted = true;
    const receipt = await runRemediationTransaction({
      client,
      mode,
      plan,
      planSha256: expectedPlanSha256,
      backup,
      applyReceipt,
      assertFence,
    });
    await assertFence();
    phase = mode === "apply" ? "REMEDIATION_TRANSACTION_COMMITTED" : "REMEDIATION_RESTORE_COMMITTED";
    journal.append(phase, { receiptSha256: sha256(canonicalJson(receipt)) });
    const result = {
      formatVersion: 1,
      mode: mode.toUpperCase(),
      outcome: "SUCCEEDED",
      mutationAttempted,
      planSha256: expectedPlanSha256,
      operationId: plan.operationId,
      backupPath,
      backupSha256,
      mongoTargetIdentitySha256: plan.source.mongoTargetIdentitySha256,
      applyReceipt: mode === "apply" ? receipt : applyReceipt,
      restoreReceipt: mode === "restore" ? receipt : null,
    };
    journal.finalize(result);
    return result;
  } catch (error) {
    const result = {
      formatVersion: 1,
      mode: mode.toUpperCase(),
      outcome: mutationAttempted ? "UNKNOWN_RECONCILIATION_REQUIRED" : "FAILED_NO_MUTATION",
      mutationAttempted,
      phase,
      planSha256: expectedPlanSha256,
      backupPath,
      backupSha256,
      error: safeError(error),
    };
    try { journal.append("EXECUTION_FAILED", result); journal.finalize(result); } catch { /* durable prior entries remain */ }
    throw Object.assign(new Error(result.error), { remediationResult: result });
  } finally {
    if (!dependencies.mongoClient) await client.close().catch(() => {});
  }
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  if (!argv.includes("--execution-index") && dependencies.allowDirectInputs !== true) {
    fail("Production remediation runner requires the exact execution index");
  }
  const result = await run(parseArgs(argv), dependencies);
  process.stdout.write(`${JSON.stringify({
    mode: result.mode,
    outcome: result.outcome,
    planSha256: result.planSha256,
    operationId: result.operationId,
    liveMutationPerformed: ["APPLY", "RESTORE"].includes(result.mode) && result.outcome === "SUCCEEDED",
  })}\n`);
  return result;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === SCRIPT_PATH) {
  if (process.argv.slice(2).includes("--help")) {
    process.stdout.write("Usage: node scripts/run_viva_game_projection_remediation.mjs --mode verify|apply|restore|reconcile|reconcile-restore --execution-index /private/index.json --expected-execution-index-sha256 SHA256 --report /private/new-report.json\nProduction execution requires the exact reviewed index. Apply and restore also require separate live authorization and their exact environment confirmation phrase.\n");
  } else {
    main().catch((error) => {
      process.stderr.write(`${safeError(error)}\n`);
      process.exitCode = 1;
    });
  }
}
