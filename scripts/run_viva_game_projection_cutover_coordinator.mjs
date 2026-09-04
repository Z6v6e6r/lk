#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { canonicalJson, sha256 } from "./lib/vivaGameProjectionCutoverContract.mjs";
import { prepareVivaGameProjectionCutoverPostcheck } from "./prepare_viva_game_projection_cutover_postcheck.mjs";
import {
  assertInheritedFenceLease,
  ensurePrivateDirectory,
  main as runMigration,
  readPrivateBytes,
  readPrivateJson,
  validateHeldWriterFence,
} from "./run_viva_game_projection_tenant_migration.mjs";
import {
  atomicWrite,
  validateReviewedFlowContract,
  writeFileExclusiveAtomicDurable,
} from "./nodered_reviewed_flow_deploy/runtime_contract.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const CONFIRMATION = "EXECUTE_VIVA_GAME_PROJECTION_CUTOVER_V1";
const HASH_RE = /^[a-f0-9]{64}$/;
const MAX_JSON_BYTES = 64 * 1024 * 1024;
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
  for (const key of ["--execution-index", "--expected-execution-index-sha256", "--report"]) {
    if (!values.get(key)) fail(`Missing ${key}`);
  }
  return values;
};

const assertHash = (value, label) => {
  if (!HASH_RE.test(String(value || ""))) fail(`${label} must be a SHA-256 digest`);
};

const assertPacketFile = (packetRoot, requestedPath, expectedRelativePath, label) => {
  const actual = fs.realpathSync(requestedPath);
  const expected = path.join(packetRoot, expectedRelativePath);
  if (actual !== expected) fail(`${label} is outside the exact packet`);
  return actual;
};

const runPm2 = (args) => {
  const result = spawnSync("pm2", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) fail(`PM2 command failed: pm2 ${args.join(" ")}`);
  return result.stdout;
};

const pm2Entry = (processName) => {
  let rows;
  try { rows = JSON.parse(runPm2(["jlist"])); } catch { fail("PM2 process list is invalid"); }
  const matches = Array.isArray(rows) ? rows.filter((row) => row?.name === processName) : [];
  if (matches.length !== 1) fail("Expected exactly one PM2 process during cutover");
  return matches[0];
};

const protectedOptions = () => ({
  uid: typeof process.getuid === "function" ? process.getuid() : 0,
  gid: typeof process.getgid === "function" ? process.getgid() : 0,
  mode: 0o600,
});

const writePrivate = (filePath, value) => {
  const bytes = Buffer.from(canonicalJson(value));
  writeFileExclusiveAtomicDurable(filePath, bytes, protectedOptions());
  return { bytes, sha256: sha256(bytes) };
};

export async function executeVivaGameProjectionCutover(options, dependencies = {}) {
  if ((dependencies.getUid ? dependencies.getUid() : process.getuid?.()) !== 0) fail("Cutover coordinator requires root");
  if (process.env.VIVA_GAME_PROJECTION_CUTOVER_EXECUTE !== CONFIRMATION) fail("Cutover execution confirmation is absent");
  const executionRead = readPrivateJson(options.executionIndex, "Cutover execution index", MAX_JSON_BYTES);
  assertHash(options.expectedExecutionIndexSha256, "Expected execution-index digest");
  if (sha256(executionRead.bytes) !== options.expectedExecutionIndexSha256) fail("Cutover execution-index digest mismatch");
  const execution = executionRead.value;
  if (!isObject(execution) || execution.formatVersion !== 1
    || execution.kind !== "viva-game-projection-cutover-execution-index"
    || !Array.isArray(execution.items) || execution.items.length === 0) {
    fail("Cutover execution index contract mismatch");
  }
  for (const key of ["cutoverPlanSha256", "packetManifestSha256", "fenceReceiptSha256"]) {
    assertHash(execution[key], `Execution index ${key}`);
  }
  const cutoverRead = readPrivateJson(execution.cutoverPlanPath, "Cutover plan", MAX_JSON_BYTES);
  const manifestRead = readPrivateJson(execution.packetManifestPath, "Packet manifest", MAX_JSON_BYTES);
  const fenceRead = readPrivateJson(execution.fenceReceiptPath, "Writer fence receipt", MAX_JSON_BYTES);
  if (sha256(cutoverRead.bytes) !== execution.cutoverPlanSha256
    || sha256(manifestRead.bytes) !== execution.packetManifestSha256
    || sha256(fenceRead.bytes) !== execution.fenceReceiptSha256) {
    fail("Cutover execution inputs changed after approval");
  }
  const plan = cutoverRead.value;
  if (plan?.kind !== "viva-game-projection-tenant-cutover-plan"
    || plan.state !== "READY_FOR_SEPARATE_LIVE_APPROVAL" || plan.liveMutationAuthorized !== false) {
    fail("Cutover plan is not eligible for separately confirmed execution");
  }
  const packetRoot = fs.realpathSync(path.dirname(execution.cutoverPlanPath));
  if (fs.realpathSync(path.dirname(execution.packetManifestPath)) !== packetRoot) fail("Packet manifest root mismatch");
  const candidatePath = assertPacketFile(packetRoot, execution.candidatePath, "candidate.flow.json", "Candidate flow");
  const contractPath = assertPacketFile(packetRoot, execution.reviewedFlowContractPath, "reviewed-flow.contract.json", "Reviewed-flow contract");
  const liveFlowPath = fs.realpathSync(execution.liveFlowPath);
  if (liveFlowPath !== "/root/.node-red/flows.json" && !dependencies.allowFixturePaths) fail("Live flow path is not canonical production flow");
  if (os.hostname() !== plan.production?.hostname && !dependencies.allowFixtureHostname) fail("Cutover host differs from the approved production host");

  validateHeldWriterFence(fenceRead.value, {
    sourceFlowSha256: plan.sourceFlowSha256,
    candidateSha256: plan.candidateSha256,
    tenantKey: execution.tenantKey,
    expectedOperationIds: plan.writerFence?.exactMigrationOperationIds,
    expectedWriterNodeIds: plan.writerFence?.exactWriterNodeIds,
    writerInventorySha256: plan.writerFence?.writerInventorySha256,
    externalWriterProofSha256: plan.writerFence?.externalWriterProofSha256,
    fenceTokenSha256: plan.writerFence?.fenceTokenSha256,
    lockPath: plan.writerFence?.lockPath,
    nowMs: dependencies.nowMs ?? Date.now(),
  });
  if (dependencies.assertFenceLease) dependencies.assertFenceLease(fenceRead.value);
  else assertInheritedFenceLease(fenceRead.value);

  const expectedPlans = new Set(plan.migration.planSha256s);
  for (const item of execution.items) {
    if (!expectedPlans.delete(item?.planSha256)) fail("Execution index plan set mismatch");
    assertPacketFile(packetRoot, item.planPath, path.join("migration-plans", path.basename(item.planPath)), "Migration plan");
    ensurePrivateDirectory(item.backupDirectory, "Migration backup directory");
    const reportPath = path.resolve(item.reportPath);
    ensurePrivateDirectory(path.dirname(reportPath), "Migration report directory");
    if (reportPath !== item.reportPath || fs.existsSync(reportPath) || fs.existsSync(`${reportPath}.journal`)) {
      fail("Migration report path is not a new canonical path");
    }
  }
  if (expectedPlans.size !== 0) fail("Execution index omits a migration plan");

  const coordinatorReportPath = path.resolve(options.report);
  const applyIndexPath = path.resolve(execution.applyIndexOutputPath);
  const flowBackupDirectory = ensurePrivateDirectory(execution.flowBackupDirectory, "Flow backup directory");
  const postcheckOutputDirectory = ensurePrivateDirectory(execution.postcheckOutputDirectory, "Postcheck output directory");
  ensurePrivateDirectory(path.dirname(coordinatorReportPath), "Coordinator report directory");
  ensurePrivateDirectory(path.dirname(applyIndexPath), "Apply-index directory");
  if (coordinatorReportPath !== options.report || applyIndexPath !== execution.applyIndexOutputPath
    || postcheckOutputDirectory !== execution.postcheckOutputDirectory
    || fs.existsSync(coordinatorReportPath) || fs.existsSync(applyIndexPath)
    || fs.readdirSync(postcheckOutputDirectory).length !== 0) {
    fail("Cutover output paths must be new, canonical, and private");
  }
  const flowBackupPath = path.join(flowBackupDirectory, `flows-pre-viva-projection-${execution.cutoverPlanSha256}.json`);
  if (fs.existsSync(flowBackupPath)) fail("Cutover flow backup already exists");

  const currentFlowBytes = readPrivateBytes(liveFlowPath, "Live source flow", MAX_JSON_BYTES);
  const candidateBytes = readPrivateBytes(candidatePath, "Candidate flow", MAX_JSON_BYTES);
  const contractBytes = readPrivateBytes(contractPath, "Reviewed-flow contract", MAX_JSON_BYTES);
  if (sha256(currentFlowBytes) !== plan.sourceFlowSha256 || sha256(candidateBytes) !== plan.candidateSha256) {
    fail("Live source or candidate digest differs from the cutover plan");
  }
  let reviewedContract;
  try { reviewedContract = JSON.parse(contractBytes.toString("utf8")); } catch { fail("Reviewed-flow contract is invalid"); }
  validateReviewedFlowContract({ liveBytes: currentFlowBytes, candidateBytes, contract: reviewedContract });
  if (reviewedContract.sourceSha256 !== plan.sourceFlowSha256 || reviewedContract.candidateSha256 !== plan.candidateSha256) {
    fail("Reviewed-flow contract differs from the cutover plan");
  }

  const initialPm2 = dependencies.inspectPm2 ? await dependencies.inspectPm2() : pm2Entry(plan.production.processName);
  if (initialPm2?.pm_id !== plan.production.pm2ProcessId
    || String(initialPm2?.pm2_env?.status || "").toLowerCase() !== "stopped") {
    fail("Node-RED is not stopped at cutover start");
  }

  let candidatePublished = false;
  let applyIndexArtifact = null;
  try {
    const appliedItems = [];
    for (const item of execution.items) {
      const migrationArgs = [
        "--mode", "apply",
        "--plan", item.planPath,
        "--cutover-plan", execution.cutoverPlanPath,
        "--packet-manifest", execution.packetManifestPath,
        "--expected-plan-sha256", item.planSha256,
        "--expected-cutover-plan-sha256", execution.cutoverPlanSha256,
        "--expected-packet-manifest-sha256", execution.packetManifestSha256,
        "--expected-source-flow-sha256", plan.sourceFlowSha256,
        "--expected-runtime-flow-sha256", plan.sourceFlowSha256,
        "--flow-path", liveFlowPath,
        "--fence-receipt", execution.fenceReceiptPath,
        "--backup-dir", item.backupDirectory,
        "--report", item.reportPath,
      ];
      const result = dependencies.runMigration
        ? await dependencies.runMigration(migrationArgs)
        : await runMigration(migrationArgs);
      if (result?.mode !== "APPLY" || result.outcome !== "SUCCEEDED") fail("Migration apply did not succeed exactly");
      const reportBytes = readPrivateBytes(item.reportPath, "Migration apply report", MAX_JSON_BYTES);
      appliedItems.push({
        planPath: item.planPath,
        planSha256: item.planSha256,
        reportPath: item.reportPath,
        reportSha256: sha256(reportBytes),
        backupPath: result.backupPath,
        backupSha256: result.backupSha256,
      });
    }
    applyIndexArtifact = writePrivate(applyIndexPath, {
      formatVersion: 1,
      kind: "viva-game-projection-cutover-apply-index",
      cutoverPlanSha256: execution.cutoverPlanSha256,
      tenantKey: execution.tenantKey,
      items: appliedItems,
    });

    writeFileExclusiveAtomicDurable(flowBackupPath, currentFlowBytes, protectedOptions());
    if (sha256(fs.readFileSync(liveFlowPath)) !== plan.sourceFlowSha256) fail("Live flow drifted before candidate publication");
    if (dependencies.publishCandidate) await dependencies.publishCandidate(liveFlowPath, candidateBytes);
    else atomicWrite(liveFlowPath, candidateBytes, { uid: 0, gid: 0 });
    candidatePublished = true;
    if (sha256(fs.readFileSync(liveFlowPath)) !== plan.candidateSha256) fail("Candidate flow readback failed");
    if (dependencies.restartNodeRed) await dependencies.restartNodeRed();
    else runPm2(["restart", plan.production.processName, "--update-env"]);
    const activePm2 = dependencies.inspectPm2 ? await dependencies.inspectPm2() : pm2Entry(plan.production.processName);
    if (activePm2?.pm_id !== plan.production.pm2ProcessId
      || String(activePm2?.pm2_env?.status || "").toLowerCase() !== "online") {
      fail("Node-RED candidate did not become online");
    }
    const postcheckResult = await prepareVivaGameProjectionCutoverPostcheck({
      cutoverPlan: execution.cutoverPlanPath,
      packetManifest: execution.packetManifestPath,
      expectedCutoverPlanSha256: execution.cutoverPlanSha256,
      expectedPacketManifestSha256: execution.packetManifestSha256,
      applyIndex: applyIndexPath,
      expectedApplyIndexSha256: applyIndexArtifact.sha256,
      runtimeFlow: liveFlowPath,
      fenceReceipt: execution.fenceReceiptPath,
      expectedFenceReceiptSha256: execution.fenceReceiptSha256,
      outputDirectory: postcheckOutputDirectory,
    }, dependencies.postcheckDependencies || {});
    const result = {
      formatVersion: 1,
      kind: "viva-game-projection-cutover-coordinator-report",
      state: "POSTCHECK_PASS_INGRESS_STILL_BLOCKED",
      cutoverPlanSha256: execution.cutoverPlanSha256,
      applyIndexSha256: applyIndexArtifact.sha256,
      activeFlowSha256: plan.candidateSha256,
      readyMarkerSha256: postcheckResult.readyMarkerSha256,
      ingressReopened: false,
      completedAt: new Date(dependencies.nowMs ?? Date.now()).toISOString(),
    };
    writePrivate(coordinatorReportPath, result);
    return result;
  } catch (error) {
    if (candidatePublished) {
      try {
        if (dependencies.stopNodeRed) await dependencies.stopNodeRed();
        else runPm2(["stop", plan.production.processName]);
      } catch { /* ingress remains externally blocked; report the original failure */ }
    }
    try {
      writePrivate(coordinatorReportPath, {
        formatVersion: 1,
        kind: "viva-game-projection-cutover-coordinator-report",
        state: "FAILED_INGRESS_REMAINS_BLOCKED",
        cutoverPlanSha256: execution.cutoverPlanSha256,
        activeFlowSha256: sha256(fs.readFileSync(liveFlowPath)),
        candidatePublished,
        migrationOutcome: error?.migrationResult?.outcome || null,
        ingressReopened: false,
        failedAt: new Date(dependencies.nowMs ?? Date.now()).toISOString(),
      });
    } catch { /* per-plan durable journals and the unchanged ingress fence remain authoritative */ }
    throw error;
  }
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const values = parseArgs(argv);
  const result = await executeVivaGameProjectionCutover({
    executionIndex: values.get("--execution-index"),
    expectedExecutionIndexSha256: values.get("--expected-execution-index-sha256"),
    report: values.get("--report"),
  }, dependencies);
  process.stdout.write(`${JSON.stringify({ state: result.state, ingressReopened: false })}\n`);
  return result;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === SCRIPT_PATH) {
  if (process.argv.slice(2).includes("--help")) {
    process.stdout.write("Usage: scripts/run_viva_game_projection_cutover.sh --execution-index /private/execution-index.json --expected-execution-index-sha256 SHA256 --report /private/new-cutover-report.json\n");
  } else {
    main().catch((error) => {
      process.stderr.write(`${String(error instanceof Error ? error.message : error).replace(/mongodb(?:\+srv)?:\/\/[^\s]+/gi, "[REDACTED_MONGO_URI]").slice(0, 500)}\n`);
      process.exitCode = 1;
    });
  }
}
