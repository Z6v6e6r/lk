import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BSON, MongoClient, ObjectId } from "mongodb";

import { buildMongoTargetIdentity, canonicalJson } from "../lib/vivaGameProjectionCutoverContract.mjs";
import {
  installMongoWriteBarrier,
  restorePreviousMongoWriteBarrier,
} from "../lib/vivaGameProjectionMongoWriteBarrier.mjs";
import { buildLegacyTenantMigrationPlan } from "../lib/vivaGameProjectionTenantMigration.mjs";
import { hashCanonicalEjson } from "../lib/vivaGameProjectionTenantMigrationExecution.mjs";
import { main as runMigration } from "../run_viva_game_projection_tenant_migration.mjs";
import { prepareVivaGameProjectionRestoreRehearsal } from "../prepare_viva_game_projection_restore_rehearsal.mjs";

const mongoUri = String(process.env.VIVA_GAME_PROJECTION_TEST_MONGO_URI || "").trim();
const applicationMongoUri = String(process.env.VIVA_GAME_PROJECTION_TEST_APPLICATION_MONGO_URI || "").trim();
const migrationMongoUri = String(process.env.VIVA_GAME_PROJECTION_TEST_MIGRATION_MONGO_URI || "").trim();
const maybeTest = mongoUri && applicationMongoUri && migrationMongoUri ? test : test.skip;
const tenantKey = "fixture-tenant";
const exerciseId = "11111111-1111-4111-8111-111111111111";
const operationId = "viva-projection-fixture-migration-1";
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const write0600 = (filePath, body) => {
  fs.writeFileSync(filePath, body, { mode: 0o600, flag: "wx" });
  fs.chmodSync(filePath, 0o600);
};

maybeTest("real replica set applies and restores an exact tenant migration under the held fence", { timeout: 120_000 }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "viva-projection-cutover-mongo-")));
  fs.chmodSync(root, 0o700);
  const client = new MongoClient(mongoUri);
  const applicationClient = new MongoClient(applicationMongoUri);
  const migrationClient = new MongoClient(migrationMongoUri);
  let barrierPreparation = null;
  const originalApply = process.env.VIVA_GAME_PROJECTION_MIGRATION_APPLY;
  const originalRestore = process.env.VIVA_GAME_PROJECTION_MIGRATION_RESTORE;
  const originalRehearsal = process.env.VIVA_GAME_PROJECTION_RESTORE_REHEARSAL;
  try {
    await client.connect();
    await applicationClient.connect();
    await migrationClient.connect();
    const db = client.db("games");
    const hello = await db.admin().command({ hello: 1 });
    assert.equal(Boolean(hello.setName), true, "integration test requires a real replica set");
    const collection = db.collection("lk_games");
    const preimage = {
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
      payment: { paid: true, amount: 4200 },
      participants: [{ id: "player-fixture", name: "Private fixture" }],
    };
    await collection.insertOne(preimage);

    const packetRoot = path.join(root, "packet");
    fs.mkdirSync(packetRoot, { mode: 0o700 });
    fs.chmodSync(packetRoot, 0o700);
    const migrationDirectory = path.join(packetRoot, "migration-plans");
    fs.mkdirSync(migrationDirectory, { mode: 0o700 });
    fs.chmodSync(migrationDirectory, 0o700);
    const flowPath = path.join(packetRoot, "source.flow.json");
    const flowBytes = Buffer.from(`${JSON.stringify([
      { id: "4e820638cc39c730", type: "mongodb4-client", dbName: "games", uri: applicationMongoUri },
      { id: "writer-fixture", type: "mongodb4", collection: "lk_games", operation: "updateOne", clientNode: "4e820638cc39c730" },
    ], null, 2)}\n`);
    write0600(flowPath, flowBytes);
    const sourceFlowSha256 = sha256(flowBytes);
    const candidateSha256 = sourceFlowSha256;
    const nowIso = new Date().toISOString();
    const built = buildLegacyTenantMigrationPlan([
      BSON.EJSON.serialize(preimage, { relaxed: false }),
    ], {
      "2026-09-05": [{
        id: exerciseId,
        studio: { id: "studio-1" },
        date: "2026-09-05",
        timeFrom: "2026-09-05T12:00:00+03:00",
        timeTo: "2026-09-05T14:00:00+03:00",
        status: "ACTIVE",
        active: true,
      }],
    }, { tenantKey, dateFrom: "2026-09-05", dateTo: "2026-09-05", operationId }, nowIso);
    const plan = {
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
    const planPath = path.join(migrationDirectory, "01-plan.json");
    const planBytes = Buffer.from(`${JSON.stringify(plan, null, 2)}\n`);
    write0600(planPath, planBytes);
    const planSha256 = sha256(planBytes);
    const candidatePath = path.join(packetRoot, "candidate.flow.json");
    write0600(candidatePath, flowBytes);
    const controlsPath = path.join(packetRoot, "cutover-controls.json");
    const controlsBytes = Buffer.from("{\"fixture\":true}\n");
    write0600(controlsPath, controlsBytes);
    const reviewedContractPath = path.join(packetRoot, "reviewed-flow.contract.json");
    const reviewedContractBytes = Buffer.from("{\"fixture\":true}\n");
    write0600(reviewedContractPath, reviewedContractBytes);
    const evidenceDirectory = path.join(packetRoot, "evidence");
    fs.mkdirSync(evidenceDirectory, { mode: 0o700 });
    fs.chmodSync(evidenceDirectory, 0o700);
    const externalWriterProofBytes = Buffer.from("{\"fixture\":\"external-writer-proof\"}\n");
    const fullBackupManifestBytes = Buffer.from("{\"fixture\":\"full-backup-manifest\"}\n");
    const fullBackupBytes = Buffer.from("{\"fixture\":\"full-backup\"}\n");
    write0600(path.join(evidenceDirectory, "external-writer-proof.json"), externalWriterProofBytes);
    write0600(path.join(evidenceDirectory, "full-backup.manifest.json"), fullBackupManifestBytes);
    write0600(path.join(evidenceDirectory, "full-backup.ejson"), fullBackupBytes);
    const mongoTarget = buildMongoTargetIdentity({
      connectionFingerprint: sha256(applicationMongoUri),
      replicaSetName: hello.setName,
      database: "games",
      collection: "lk_games",
    });
    mongoTarget.migrationConnectionFingerprint = sha256(migrationMongoUri);
    const rehearsalBackupPath = path.join(root, "rehearsal-full-backup.ejson");
    const rehearsalBackupBytes = Buffer.from(`${BSON.EJSON.stringify([preimage], null, 2, { relaxed: false })}\n`);
    write0600(rehearsalBackupPath, rehearsalBackupBytes);
    const rehearsalStateSha256 = sha256(canonicalJson([{
      mongoId: preimage._id.toHexString(),
      documentSha256: hashCanonicalEjson(preimage),
    }]));
    const rehearsalManifestPath = path.join(root, "rehearsal-full-backup.manifest.json");
    const rehearsalManifestBytes = Buffer.from(canonicalJson({
      formatVersion: 1,
      kind: "viva-game-projection-full-lk-games-backup-manifest",
      backupSha256: sha256(rehearsalBackupBytes),
      fullCollectionStateSha256: rehearsalStateSha256,
      mongoTargetIdentitySha256: mongoTarget.targetIdentitySha256,
      database: "games",
      collection: "lk_games",
      documentCount: 1,
    }));
    write0600(rehearsalManifestPath, rehearsalManifestBytes);
    const rehearsalConnectionPath = path.join(root, "rehearsal-mongo.json");
    write0600(rehearsalConnectionPath, canonicalJson({
      formatVersion: 1, kind: "viva-game-projection-restore-rehearsal-mongo-connection", uri: migrationMongoUri,
    }));
    process.env.VIVA_GAME_PROJECTION_RESTORE_REHEARSAL = "REHEARSE_VIVA_GAME_PROJECTION_FULL_RESTORE_V1";
    const collisionDatabase = "viva_projection_restore_rehearsal_collision01";
    await client.db(collisionDatabase).collection("unrelated").insertOne({ keep: true });
    await assert.rejects(() => prepareVivaGameProjectionRestoreRehearsal({
      backup: rehearsalBackupPath,
      backupManifest: rehearsalManifestPath,
      expectedBackupSha256: sha256(rehearsalBackupBytes),
      expectedManifestSha256: sha256(rehearsalManifestBytes),
      mongoConnectionFile: rehearsalConnectionPath,
      isolatedDatabase: collisionDatabase,
      outputDirectory: path.join(root, "restore-rehearsal-collision-output"),
    }), /target database already exists/);
    assert.equal(await client.db(collisionDatabase).collection("unrelated").countDocuments({ keep: true }), 1);
    await client.db(collisionDatabase).dropDatabase();
    const rehearsal = await prepareVivaGameProjectionRestoreRehearsal({
      backup: rehearsalBackupPath,
      backupManifest: rehearsalManifestPath,
      expectedBackupSha256: sha256(rehearsalBackupBytes),
      expectedManifestSha256: sha256(rehearsalManifestBytes),
      mongoConnectionFile: rehearsalConnectionPath,
      isolatedDatabase: "viva_projection_restore_rehearsal_fixture01",
      outputDirectory: path.join(root, "restore-rehearsal-output"),
    });
    assert.equal(rehearsal.receipt.postRestoreHashMatch, true);
    assert.equal(rehearsal.receipt.restoredDocumentCount, 1);
    const fixtureWriters = [{ nodeId: "writer-fixture", name: "", operation: "updateOne", clientNode: "4e820638cc39c730" }];
    const writerInventorySha256 = sha256(canonicalJson({ sourceWriters: fixtureWriters, candidateWriters: fixtureWriters }));
    const fenceToken = "fixture-fence-token-with-sufficient-entropy";
    const cutoverPath = path.join(packetRoot, "cutover-plan.json");
    const cutoverBytes = Buffer.from(`${JSON.stringify({
      formatVersion: 1,
      kind: "viva-game-projection-tenant-cutover-plan",
      state: "READY_FOR_SEPARATE_LIVE_APPROVAL",
      repository: { commit: "c".repeat(40), branch: "codex/fixture" },
      sourceFlowSha256,
      candidateSha256,
      controlsSha256: sha256(controlsBytes),
      reviewedFlowContractSha256: sha256(reviewedContractBytes),
      tenantKeySha256: sha256(tenantKey),
      migration: { planSha256s: [planSha256] },
      writerFence: {
        exactWriterNodeIds: ["writer-fixture"],
        exactMigrationOperationIds: [operationId],
        fenceTokenSha256: sha256(fenceToken),
        writerInventorySha256,
        externalWriterProofSha256: sha256(externalWriterProofBytes),
        lockPath: "/run/lock/padlhub-viva-game-projection-cutover.lock",
      },
      mongoTarget,
      evidence: {
        externalWriterProofSha256: sha256(externalWriterProofBytes),
        backupManifestSha256: sha256(fullBackupManifestBytes),
        backupSha256: sha256(fullBackupBytes),
      },
      liveMutationAuthorized: false,
    }, null, 2)}\n`);
    write0600(cutoverPath, cutoverBytes);
    const cutoverSha256 = sha256(cutoverBytes);
    const manifestPath = path.join(packetRoot, "packet.manifest.json");
    const manifestBytes = Buffer.from(`${JSON.stringify({
      formatVersion: 1,
      kind: "viva-game-projection-cutover-packet-manifest",
      repository: { commit: "c".repeat(40), branch: "codex/fixture" },
      sourceFlowSha256,
      candidateSha256,
      state: "READY_FOR_SEPARATE_LIVE_APPROVAL",
      files: [
        { path: "candidate.flow.json", sha256: candidateSha256 },
        { path: "cutover-controls.json", sha256: sha256(controlsBytes) },
        { path: "cutover-plan.json", sha256: cutoverSha256 },
        { path: "evidence/external-writer-proof.json", sha256: sha256(externalWriterProofBytes) },
        { path: "evidence/full-backup.ejson", sha256: sha256(fullBackupBytes) },
        { path: "evidence/full-backup.manifest.json", sha256: sha256(fullBackupManifestBytes) },
        { path: "migration-plans/01-plan.json", sha256: planSha256 },
        { path: "reviewed-flow.contract.json", sha256: sha256(reviewedContractBytes) },
        { path: "source.flow.json", sha256: sourceFlowSha256 },
      ],
    }, null, 2)}\n`);
    write0600(manifestPath, manifestBytes);
    const fencePath = path.join(root, "fence.json");
    write0600(fencePath, `${JSON.stringify({
      formatVersion: 1,
      kind: "viva-game-projection-writer-fence-receipt",
      state: "HELD",
      host: "lk-primary-147",
      hostname: "fixture-host",
      processName: "node-red",
      pm2ProcessId: 0,
      fenceToken,
      writerInventorySha256,
      externalWriterProofSha256: sha256(externalWriterProofBytes),
      lockPath: "/run/lock/padlhub-viva-game-projection-cutover.lock",
      sourceFlowSha256,
      candidateSha256,
      tenantKey,
      operationIds: [operationId],
      nodeRedProcessState: "STOPPED",
      ingressWriteRoutesBlocked: true,
      internalSchedulersStopped: true,
      allLkGamesWritersQuiescent: true,
      externalMongoWritersBlocked: true,
      writerNodeIds: ["writer-fixture"],
      observedAt: nowIso,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    }, null, 2)}\n`);
    const migrationConnectionPath = path.join(root, "migration-mongo.json");
    write0600(migrationConnectionPath, `${JSON.stringify({
      formatVersion: 1,
      kind: "viva-game-projection-migration-mongo-connection",
      uri: migrationMongoUri,
    }, null, 2)}\n`);
    const barrierReceipt = await installMongoWriteBarrier({
      migrationClient,
      applicationClient,
      applicationConnectionFingerprint: sha256(applicationMongoUri),
      migrationConnectionFingerprint: sha256(migrationMongoUri),
      replicaSetName: hello.setName,
      fenceTokenSha256: sha256(fenceToken),
      cutoverPlanSha256: cutoverSha256,
      beforeInstall: async (preparation) => { barrierPreparation = preparation; },
    });
    const barrierPath = path.join(root, "mongo-write-barrier.json");
    write0600(barrierPath, canonicalJson(barrierReceipt));
    const common = [
      "--plan", planPath,
      "--cutover-plan", cutoverPath,
      "--packet-manifest", manifestPath,
      "--expected-plan-sha256", planSha256,
      "--expected-cutover-plan-sha256", cutoverSha256,
      "--expected-packet-manifest-sha256", sha256(manifestBytes),
      "--expected-source-flow-sha256", sourceFlowSha256,
      "--expected-runtime-flow-sha256", sourceFlowSha256,
      "--flow-path", flowPath,
      "--fence-receipt", fencePath,
      "--mongo-write-barrier-receipt", barrierPath,
      "--migration-connection-file", migrationConnectionPath,
    ];

    const verifyReport = path.join(root, "verify-report.json");
    const dependencies = {
      assertSystemFenceLease: () => true,
      assertCheapFenceLease: () => true,
      assertExecutorSources: () => true,
    };
    const verified = await runMigration(["--mode", "verify", ...common, "--report", verifyReport], dependencies);
    assert.equal(verified.writeCommandCount, 0);
    assert.equal(verified.liveMutationPerformed, false);

    process.env.VIVA_GAME_PROJECTION_MIGRATION_APPLY = "APPLY_VIVA_GAME_PROJECTION_TENANT_MIGRATION_V1";
    const backupDir = path.join(root, "backups");
    const applyReportPath = path.join(root, "apply-report.json");
    const applied = await runMigration([
      "--mode", "apply", ...common, "--backup-dir", backupDir, "--report", applyReportPath,
    ], dependencies);
    assert.equal(applied.outcome, "SUCCEEDED");
    const migrated = await collection.findOne({ _id: preimage._id });
    assert.equal(migrated.tenantKey, tenantKey);
    assert.equal(migrated.revision, 1);
    assert.equal(migrated.payment.amount, 4200);
    assert.equal(migrated.participants.length, 1);

    const reconcileReportPath = path.join(root, "reconcile-report.json");
    const reconciled = await runMigration([
      "--mode", "reconcile", ...common,
      "--backup", applied.backupPath,
      "--expected-backup-sha256", applied.backupSha256,
      "--report", reconcileReportPath,
    ], dependencies);
    assert.equal(reconciled.outcome, "APPLIED_RECOVERED");

    const applyReportBytes = fs.readFileSync(applyReportPath);
    const preRestoreReconcile = await runMigration([
      "--mode", "reconcile-restore", ...common,
      "--backup", applied.backupPath,
      "--expected-backup-sha256", applied.backupSha256,
      "--apply-receipt", applyReportPath,
      "--expected-apply-report-sha256", sha256(applyReportBytes),
      "--report", path.join(root, "reconcile-restore-before.json"),
    ], dependencies);
    assert.equal(preRestoreReconcile.outcome, "RESTORE_ABORTED_POSTIMAGE");

    process.env.VIVA_GAME_PROJECTION_MIGRATION_RESTORE = "RESTORE_VIVA_GAME_PROJECTION_TENANT_MIGRATION_V1";
    const restoreReportPath = path.join(root, "restore-report.json");
    const restored = await runMigration([
      "--mode", "restore", ...common,
      "--backup", applied.backupPath,
      "--expected-backup-sha256", applied.backupSha256,
      "--apply-receipt", applyReportPath,
      "--expected-apply-report-sha256", sha256(applyReportBytes),
      "--report", restoreReportPath,
    ], dependencies);
    assert.equal(restored.outcome, "SUCCEEDED");
    const finalDocument = await collection.findOne({ _id: preimage._id });
    assert.deepEqual(BSON.EJSON.serialize(finalDocument, { relaxed: false }), BSON.EJSON.serialize(preimage, { relaxed: false }));
    const postRestoreReconcile = await runMigration([
      "--mode", "reconcile-restore", ...common,
      "--backup", applied.backupPath,
      "--expected-backup-sha256", applied.backupSha256,
      "--apply-receipt", applyReportPath,
      "--expected-apply-report-sha256", sha256(applyReportBytes),
      "--report", path.join(root, "reconcile-restore-after.json"),
    ], dependencies);
    assert.equal(postRestoreReconcile.outcome, "RESTORED_RECOVERED");
    const barrierRecovery = await restorePreviousMongoWriteBarrier(migrationClient, barrierPreparation, {
      fenceTokenSha256: sha256(fenceToken),
      cutoverPlanSha256: cutoverSha256,
      mongoTargetIdentitySha256: mongoTarget.targetIdentitySha256,
    });
    assert.equal(barrierRecovery.state, "RELEASED_TO_EXACT_PREIMAGE");
    barrierPreparation = null;
  } finally {
    if (originalApply === undefined) delete process.env.VIVA_GAME_PROJECTION_MIGRATION_APPLY;
    else process.env.VIVA_GAME_PROJECTION_MIGRATION_APPLY = originalApply;
    if (originalRestore === undefined) delete process.env.VIVA_GAME_PROJECTION_MIGRATION_RESTORE;
    else process.env.VIVA_GAME_PROJECTION_MIGRATION_RESTORE = originalRestore;
    if (originalRehearsal === undefined) delete process.env.VIVA_GAME_PROJECTION_RESTORE_REHEARSAL;
    else process.env.VIVA_GAME_PROJECTION_RESTORE_REHEARSAL = originalRehearsal;
    await client.db("games").dropDatabase().catch(() => {});
    await applicationClient.close().catch(() => {});
    await migrationClient.close().catch(() => {});
    await client.close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});
