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
import { buildLegacyTenantMigrationMongoQuery } from "./lib/vivaGameProjectionTenantMigration.mjs";
import {
  decodeTenantMigrationOperation,
  hashCanonicalEjson,
  validateApplyReceipt,
  validateExecutableTenantMigrationPlan,
} from "./lib/vivaGameProjectionTenantMigrationExecution.mjs";
import {
  assertInheritedFenceLease,
  assertNoConcurrentMongoWrites,
  ensurePrivateDirectory,
  readFlowConnection,
  readPrivateBytes,
  readPrivateJson,
  validateHeldWriterFence,
} from "./run_viva_game_projection_tenant_migration.mjs";
import { writeFileExclusiveAtomicDurable } from "./nodered_reviewed_flow_deploy/runtime_contract.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const HASH_RE = /^[a-f0-9]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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
  for (const key of [
    "--cutover-plan", "--packet-manifest", "--expected-cutover-plan-sha256",
    "--expected-packet-manifest-sha256", "--apply-index", "--expected-apply-index-sha256",
    "--runtime-flow", "--fence-receipt", "--expected-fence-receipt-sha256", "--output-directory",
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

const readPm2 = () => {
  const result = spawnSync("pm2", ["jlist"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (result.status !== 0) fail("Unable to read PM2 state for cutover postcheck");
  let processes;
  try { processes = JSON.parse(result.stdout); } catch { fail("PM2 state is not valid JSON"); }
  return processes;
};

const envValue = (processEntry, key) => (
  processEntry?.pm2_env?.[key] ?? processEntry?.pm2_env?.env?.[key] ?? null
);

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

export async function prepareVivaGameProjectionCutoverPostcheck(options, dependencies = {}) {
  const nowMs = dependencies.nowMs ?? Date.now();
  const cutoverRead = readPrivateJson(options.cutoverPlan, "Cutover plan", MAX_JSON_BYTES);
  const manifestRead = readPrivateJson(options.packetManifest, "Packet manifest", MAX_JSON_BYTES);
  const applyIndexRead = readPrivateJson(options.applyIndex, "Apply index", MAX_JSON_BYTES);
  const fenceRead = readPrivateJson(options.fenceReceipt, "Writer fence receipt", MAX_JSON_BYTES);
  for (const [actual, expected, label] of [
    [sha256(cutoverRead.bytes), options.expectedCutoverPlanSha256, "Cutover plan"],
    [sha256(manifestRead.bytes), options.expectedPacketManifestSha256, "Packet manifest"],
    [sha256(applyIndexRead.bytes), options.expectedApplyIndexSha256, "Apply index"],
    [sha256(fenceRead.bytes), options.expectedFenceReceiptSha256, "Writer fence receipt"],
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
  const packetRoot = fs.realpathSync(path.dirname(options.cutoverPlan));
  if (fs.realpathSync(path.dirname(options.packetManifest)) !== packetRoot) fail("Packet inputs do not share one root");
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
  else assertInheritedFenceLease(fenceRead.value);

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

  if (!isObject(applyIndexRead.value) || applyIndexRead.value.formatVersion !== 1
    || applyIndexRead.value.kind !== "viva-game-projection-cutover-apply-index"
    || applyIndexRead.value.cutoverPlanSha256 !== options.expectedCutoverPlanSha256
    || sha256(applyIndexRead.value.tenantKey || "") !== plan.tenantKeySha256
    || !Array.isArray(applyIndexRead.value.items)
    || applyIndexRead.value.items.length !== plan.migration.planSha256s.length) {
    fail("Apply index does not bind the cutover plan");
  }

  let ownedClient = null;
  const mongoContext = dependencies.mongoContext || await (async () => {
    ownedClient = new MongoClient(connection.uri, {
      appName: "PadlHubVivaGameProjectionCutoverPostcheck",
      maxPoolSize: 1,
      serverSelectionTimeoutMS: 20_000,
      connectTimeoutMS: 20_000,
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
    if (dependencies.assertNoConcurrentWrites) await dependencies.assertNoConcurrentWrites();
    else await assertNoConcurrentMongoWrites(mongoContext.client);

    const expectedPlanHashes = new Set(plan.migration.planSha256s);
    const operationIds = new Set();
    const planScopes = [];
    const applyReports = [];
    const applyReportBytesByPlan = {};
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
      planScopes.push(planRead.value.scope);
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

    const legacyQueries = planScopes.map(buildLegacyTenantMigrationMongoQuery);
    const activeLegacyQuery = legacyQueries.length === 1 ? legacyQueries[0] : { $or: legacyQueries };
    const activeReachableLegacyCount = await mongoContext.collection.countDocuments(activeLegacyQuery);
    const minDate = planScopes.map((scope) => scope.dateFrom).sort()[0];
    const maxDate = planScopes.map((scope) => scope.dateTo).sort().at(-1);
    const tenantDocuments = await mongoContext.collection.find({
      tenantKey,
      archived: { $ne: true },
      "booking.date": { $gte: minDate, $lte: maxDate },
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
    else assertInheritedFenceLease(fenceRead.value);

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
      observedAt: new Date(nowMs).toISOString(),
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
      fenceExpiresAt: fenceRead.value.expiresAt,
      mongoTargetIdentitySha256: mongoTarget.targetIdentitySha256,
      activeReachableLegacyCount,
      duplicateIdentityCount: duplicateCount,
      providerConfirmedTenantBoundCount,
      workerMode,
      workerWriteCount,
      runtimeTenantReadback: true,
      candidateFlowReadback: true,
      observedAt: new Date(nowMs).toISOString(),
      applyReports,
      queryEvidence: {
        activeReachableLegacySha256: activeEvidence.sha256,
        duplicateIdentitySha256: duplicateEvidence.sha256,
        providerTenantBoundSha256: providerEvidence.sha256,
        workerModeSha256: workerEvidence.sha256,
      },
      ingressReopened: false,
    };
    validateVivaGameProjectionCutoverPostcheck(receipt, plan, nowMs, {
      applyReportBytesByPlan,
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
      files: [activeEvidence, duplicateEvidence, providerEvidence, workerEvidence, receiptArtifact]
        .map((entry) => ({ path: path.basename(entry.path), sha256: entry.sha256 })),
    };
    const manifestArtifact = writeEvidence(outputDirectory, "postcheck.manifest.json", outputManifest);
    const readyMarker = writeEvidence(outputDirectory, "READY_TO_REOPEN_INGRESS.json", {
      formatVersion: 1,
      kind: "viva-game-projection-cutover-ready-marker",
      state: "READY_TO_REOPEN_INGRESS",
      postcheckReceiptSha256: receiptArtifact.sha256,
      postcheckManifestSha256: manifestArtifact.sha256,
      fenceTokenSha256: plan.writerFence.fenceTokenSha256,
      ingressReopenEligible: true,
      ingressReopened: false,
      observedAt: new Date(nowMs).toISOString(),
    });
    return { receipt, outputManifest, readyMarkerPath: readyMarker.path, readyMarkerSha256: readyMarker.sha256 };
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
    outputDirectory: values.get("--output-directory"),
  }, dependencies);
  process.stdout.write(`${JSON.stringify({ state: result.receipt.state, readyMarkerSha256: result.readyMarkerSha256 })}\n`);
  return result;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === SCRIPT_PATH) {
  if (process.argv.slice(2).includes("--help")) {
    process.stdout.write("Usage: node scripts/prepare_viva_game_projection_cutover_postcheck.mjs --cutover-plan /private/packet/cutover-plan.json --packet-manifest /private/packet/packet.manifest.json --expected-cutover-plan-sha256 SHA256 --expected-packet-manifest-sha256 SHA256 --apply-index /private/apply-index.json --expected-apply-index-sha256 SHA256 --runtime-flow /root/.node-red/flows.json --fence-receipt /private/fence.json --expected-fence-receipt-sha256 SHA256 --output-directory /private/new-postcheck\n");
  } else {
    main().catch((error) => {
      process.stderr.write(`${String(error instanceof Error ? error.message : error).replace(/mongodb(?:\+srv)?:\/\/[^\s]+/gi, "[REDACTED_MONGO_URI]").slice(0, 500)}\n`);
      process.exitCode = 1;
    });
  }
}
