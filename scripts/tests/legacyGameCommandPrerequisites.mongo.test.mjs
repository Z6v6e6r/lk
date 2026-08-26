import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { MongoClient } from "mongodb";

import {
  buildLegacyResultId,
  LEGACY_COMMAND_COLLECTIONS,
  LegacyCommandError,
  LegacyGameCommandTransactionService,
} from "../../node-red/custom-nodes/legacy-game-command-transaction/legacy-game-command-core.mjs";
import {
  applyLegacyCommandPrerequisites,
  auditLegacyCommandPrerequisites,
  LOCAL_MIGRATION_SENTINEL_COLLECTION,
  LOCAL_MIGRATION_SENTINEL_ID,
  runLegacyPrerequisiteMode,
} from "../migrate_legacy_game_command_prerequisites.mjs";
import {
  buildProductionMigrationContext,
  executeProductionMigration,
  EXPECTED_CANDIDATE_FLOW_SHA256,
  EXPECTED_LIVE_FLOW_SHA256,
  PRODUCTION_APPLY_CONFIRMATION,
  PRODUCTION_MIGRATION_ID,
  PRODUCTION_PACKET_SCHEMA_VERSION,
  sha256,
} from "../run_legacy_game_command_production_migration.mjs";

const mongoUri = String(process.env.LEGACY_COMMAND_TEST_MONGO_URI || "").trim();
const tenantKey = "local-padel";
const execFileAsync = promisify(execFile);

const hash = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const commandInput = (overrides = {}) => ({
  tenantKey,
  idempotencyKey: crypto.randomUUID(),
  requestHash: hash({ command: "TEST_ROSTER_MUTATION", nonce: crypto.randomUUID() }),
  correlationId: `corr-${crypto.randomUUID()}`,
  command: "TEST_ROSTER_MUTATION",
  canonicalUserId: "11111111-1111-4111-8111-111111111111",
  legacyGameId: "game-1",
  expectedRevision: 1,
  buildMutation: ({ legacyUserId, operationId }) => ({
    update: { $addToSet: { participantIds: legacyUserId } },
    auditIntents: [{ intentKey: "roster", payload: { operationId } }],
    outboxIntents: [{ intentKey: "projection", kind: "LEGACY_ROSTER_CHANGED", payload: { operationId } }],
    verifyReadBack: (game) => game.participantIds.includes(legacyUserId),
    buildResult: (game) => ({ revision: game.revision, participantCount: game.participantIds.length }),
  }),
  ...overrides,
});

const isoOffset = (now, offsetMs) => new Date(now.getTime() + offsetMs).toISOString();

const productionPacket = (context, releaseSha, nonce, now) => ({
  schemaVersion: PRODUCTION_PACKET_SCHEMA_VERSION,
  migrationId: PRODUCTION_MIGRATION_ID,
  environment: "test",
  target: { databaseName: context.target.databaseName, fingerprint: context.target.targetFingerprint },
  source: {
    repositoryCommit: releaseSha,
    liveFlowSha256: EXPECTED_LIVE_FLOW_SHA256,
    candidateFlowSha256: EXPECTED_CANDIDATE_FLOW_SHA256,
    packageSha256: context.source.packageSha256,
    writerRegistrySha256: context.source.writerRegistrySha256,
    runnerSha256: context.source.runnerSha256,
    migrationCoreSha256: context.source.migrationCoreSha256,
  },
  plan: { digest: context.planDigest, generatedAt: context.generatedAt },
  backup: {
    manifestSha256: "5".repeat(64),
    snapshotIdentitySha256: "6".repeat(64),
    restoreVerificationSha256: "7".repeat(64),
    completedAt: isoOffset(now, -6 * 60_000),
    restoreVerifiedAt: isoOffset(now, -5 * 60_000),
  },
  quiescence: {
    attestationSha256: "8".repeat(64),
    writerCount: 7,
    writerRegistrySha256: context.source.writerRegistrySha256,
    writersStoppedAt: isoOffset(now, -8 * 60_000),
    observedFrom: isoOffset(now, -7 * 60_000),
    observedTo: isoOffset(now, -2 * 60_000),
    expiresAt: isoOffset(now, 20 * 60_000),
  },
  runtime: {
    compatibilityReportSha256: "9".repeat(64),
    nodeVersion: process.version,
    mongodbDriverVersion: "test-installed-driver",
    verifiedAt: isoOffset(now, -4 * 60_000),
  },
  authorization: {
    approvedAt: isoOffset(now, -60_000),
    expiresAt: isoOffset(now, 20 * 60_000),
  },
  execution: { nonce },
});

test("real replica set proves atomic command, revision, idempotency, recovery, and migrations", {
  skip: mongoUri ? false : "Set LEGACY_COMMAND_TEST_MONGO_URI to a disposable replica-set Mongo",
  timeout: 120_000,
}, async () => {
  const client = new MongoClient(mongoUri, {
    appName: "PadlHubLegacyCommandPrerequisiteTest",
    readPreference: "primary",
    retryReads: true,
    retryWrites: true,
    serverSelectionTimeoutMS: 10_000,
  });
  const databaseName = `lk_command_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const localTargetId = crypto.randomUUID();
  const migrationOptions = {
    mode: "apply",
    environment: "test",
    databaseName,
    confirmLocalApply: true,
    localTargetId,
    mongoUri,
  };
  try {
    await client.connect();
    const db = client.db(databaseName);
    const hello = await db.admin().command({ hello: 1 });
    assert.equal(Boolean(hello.setName), true, "integration test requires a real replica set");
    assert.equal(hello.isWritablePrimary, true);
    await db.collection(LOCAL_MIGRATION_SENTINEL_COLLECTION).insertOne({
      _id: LOCAL_MIGRATION_SENTINEL_ID,
      databaseName,
      localTargetId,
      purpose: "DISPOSABLE_LEGACY_COMMAND_PREREQUISITE_TEST",
      createdAt: new Date().toISOString(),
    });

    await db.collection(LEGACY_COMMAND_COLLECTIONS.games).insertMany([
      { tenantKey, id: "legacy-no-revision", participantIds: [] },
      { tenantKey, id: "game-1", revision: 1, participantIds: [], archived: false },
    ]);
    await db.collection(LEGACY_COMMAND_COLLECTIONS.games).insertOne({ tenantKey, id: "game-1", revision: 1 });
    let readiness = await auditLegacyCommandPrerequisites(db);
    assert.equal(readiness.duplicateGameIdentityCount, 1);
    await db.collection(LEGACY_COMMAND_COLLECTIONS.games).deleteOne({ tenantKey, id: "game-1", participantIds: { $exists: false } });
    await db.collection(LEGACY_COMMAND_COLLECTIONS.games).insertOne({ id: "missing-tenant", revision: 1 });
    await db.collection(LEGACY_COMMAND_COLLECTIONS.games).insertOne({ tenantKey: "   ", id: "   ", revision: 1 });
    readiness = await auditLegacyCommandPrerequisites(db);
    assert.equal(readiness.invalidGameIdentityCount, 2);
    await db.collection(LEGACY_COMMAND_COLLECTIONS.games).deleteMany({
      $or: [{ id: "missing-tenant" }, { tenantKey: "   " }],
    });
    await db.collection(LEGACY_COMMAND_COLLECTIONS.mappings).insertOne({
      tenantKey,
      canonicalUserId: "not-a-uuid",
      legacyUserId: "also-not-a-uuid",
      status: "ACTIVE",
      source: "TEST_FIXTURE",
      version: 1.5,
      evidenceRef: "fixture:invalid",
      createdAt: "not-a-date",
    });
    readiness = await auditLegacyCommandPrerequisites(db);
    assert.equal(readiness.invalidMappingCount, 1);
    await db.collection(LEGACY_COMMAND_COLLECTIONS.mappings).deleteMany({});
    await db.collection(LEGACY_COMMAND_COLLECTIONS.mappings).insertMany([
      {
        tenantKey,
        canonicalUserId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        legacyUserId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        status: "ACTIVE",
        source: "TEST_FIXTURE",
        version: 1,
        evidenceRef: "fixture:canonical-alias",
        createdAt: new Date().toISOString(),
      },
      {
        tenantKey: ` ${tenantKey} `,
        canonicalUserId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
        legacyUserId: "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB",
        status: "ACTIVE",
        source: "TEST_FIXTURE",
        version: 1,
        evidenceRef: "fixture:case-alias",
        createdAt: new Date().toISOString(),
      },
    ]);
    readiness = await auditLegacyCommandPrerequisites(db);
    assert.equal(readiness.invalidMappingCount, 1);
    assert.equal(readiness.normalizedCanonicalAliasCount, 1);
    assert.equal(readiness.normalizedLegacyAliasCount, 1);
    await db.collection(LEGACY_COMMAND_COLLECTIONS.mappings).deleteMany({});
    await db.collection(LEGACY_COMMAND_COLLECTIONS.results).insertOne({
      _id: "res_a_b_c1234567",
      id: "res_a_b_c1234567",
      tenantKey: "a_b",
      gameId: "game-1",
      idempotencyKey: "c1234567",
      revision: 1,
    });
    readiness = await auditLegacyCommandPrerequisites(db);
    assert.equal(readiness.invalidResultIdentityCount, 1);
    await db.collection(LEGACY_COMMAND_COLLECTIONS.results).deleteMany({});
    await db.collection(LEGACY_COMMAND_COLLECTIONS.resultVivaSyncOutbox).insertOne({
      _id: `result_viva_sync:${tenantKey}:orphan`,
      id: `result_viva_sync:${tenantKey}:orphan`,
      tenantKey,
      resultId: "missing-result",
      resultRevision: 1,
    });
    readiness = await auditLegacyCommandPrerequisites(db);
    assert.equal(readiness.invalidProviderOutboxIdentityCount, 1);
    await db.collection(LEGACY_COMMAND_COLLECTIONS.resultVivaSyncOutbox).deleteMany({});
    const dryRun = await runLegacyPrerequisiteMode(db, { mode: "dry-run" });
    assert.equal(dryRun.plannedRevisionBackfillCount, 1);
    assert.equal(dryRun.mutationsPerformed, false);
    assert.equal((await db.collection(LEGACY_COMMAND_COLLECTIONS.games).findOne({ id: "legacy-no-revision" })).revision, undefined);

    const migration = await applyLegacyCommandPrerequisites(db, migrationOptions);
    assert.equal(migration.revisionModifiedCount, 1);
    assert.equal((await auditLegacyCommandPrerequisites(db)).invalidRevisionCount, 0);
    await runLegacyPrerequisiteMode(db, { mode: "postcheck" });
    const commands = db.collection(LEGACY_COMMAND_COLLECTIONS.commands);
    await commands.dropIndex("uniq_tenant_idempotency_key");
    await commands.createIndex(
      { tenantKey: 1, idempotencyKey: -1 },
      { name: "uniq_tenant_idempotency_key", unique: false },
    );
    await assert.rejects(() => runLegacyPrerequisiteMode(db, { mode: "postcheck" }), /index mismatches=.*keys/);
    await commands.dropIndex("uniq_tenant_idempotency_key");
    await commands.createIndex(
      { tenantKey: 1, idempotencyKey: 1 },
      { name: "uniq_tenant_idempotency_key", unique: true },
    );

    const resultOutboxService = new LegacyGameCommandTransactionService({ client, db });
    const resultOutboxContext = {
      tenantKey,
      resultId: buildLegacyResultId(tenantKey, "result-outbox-idempotency-1"),
      resultRevision: 2,
      bundleId: "bundle-outbox-1",
    };
    await db.collection(LEGACY_COMMAND_COLLECTIONS.results).insertOne({
      _id: resultOutboxContext.resultId,
      tenantKey,
      id: resultOutboxContext.resultId,
      idempotencyKey: "result-outbox-idempotency-1",
      revision: resultOutboxContext.resultRevision,
      gameId: "game-1",
      legacyGameProjectionOutbox: {
        version: 2,
        stateRevision: 0,
        ...resultOutboxContext,
        status: "PENDING",
        response: { statusCode: 200, payload: { status: "CONFIRMED" } },
        sinks: [
          { key: "rating:one", kind: "RATING", retryPolicy: "FENCED", status: "PENDING", attempts: 0 },
          { key: "provider:one", kind: "PROVIDER", retryPolicy: "AT_MOST_ONCE", status: "PENDING", attempts: 0, providerOutboxId: `result_viva_sync:${tenantKey}:late-1` },
          { key: "provider:success", kind: "PROVIDER", retryPolicy: "AT_MOST_ONCE", status: "PENDING", attempts: 0, providerOutboxId: `result_viva_sync:${tenantKey}:success-1` },
        ],
      },
    });
    const resultIdentity = await resultOutboxService.readResultIdempotencyIdentity({
      tenantKey,
      idempotencyKey: "result-outbox-idempotency-1",
      resultId: resultOutboxContext.resultId,
    });
    assert.equal(resultIdentity.id, resultOutboxContext.resultId);
    assert.equal(
      buildLegacyResultId(tenantKey, "result-outbox-idempotency-1").startsWith("res_v1_"),
      true,
    );
    await assert.rejects(
      () => resultOutboxService.readResultIdempotencyIdentity({
        tenantKey,
        idempotencyKey: "result-outbox-idempotency-1",
        resultId: "result-outbox-conflict",
      }),
      (error) => error instanceof LegacyCommandError && error.code === "RESULT_IDEMPOTENCY_CONFLICT",
    );
    const ratingContext = {
      ...resultOutboxContext,
      sinkKey: "rating:one",
      kind: "RATING",
      retryPolicy: "FENCED",
    };
    const concurrentClaims = await Promise.all([
      resultOutboxService.claimResultSideEffect(ratingContext),
      resultOutboxService.claimResultSideEffect(ratingContext),
    ]);
    assert.equal(concurrentClaims.filter((item) => item.claimed).length, 1);
    assert.equal(concurrentClaims.filter((item) => !item.claimed).length, 1);
    const ratingClaim = concurrentClaims.find((item) => item.claimed);
    const ratingCompletion = await resultOutboxService.completeResultSideEffect(ratingContext, {
      leaseToken: ratingClaim.leaseToken,
      outcome: "DELIVERED",
    });
    assert.equal(ratingCompletion.sinkState, "DELIVERED");
    const duplicateRatingCompletion = await resultOutboxService.completeResultSideEffect(ratingContext, {
      leaseToken: ratingClaim.leaseToken,
      outcome: "DELIVERED",
    });
    assert.equal(duplicateRatingCompletion.sinkState, "DELIVERED");
    const deliveredRatingReplay = await resultOutboxService.claimResultSideEffect(ratingContext);
    assert.equal(deliveredRatingReplay.claimed, false);
    assert.equal(deliveredRatingReplay.sinkState, "DELIVERED");

    const providerContext = {
      ...resultOutboxContext,
      sinkKey: "provider:one",
      kind: "PROVIDER",
      retryPolicy: "AT_MOST_ONCE",
    };
    const providerClaim = await resultOutboxService.claimResultSideEffect(providerContext, { leaseMs: 1_000 });
    assert.equal(providerClaim.claimed, true);
    await db.collection(LEGACY_COMMAND_COLLECTIONS.results).updateOne(
      { tenantKey, id: resultOutboxContext.resultId, "legacyGameProjectionOutbox.sinks.key": "provider:one" },
      { $set: { "legacyGameProjectionOutbox.sinks.$.leaseUntil": "2026-01-01T00:00:00.000Z" } },
    );
    const ambiguousProviderReplay = await resultOutboxService.claimResultSideEffect(providerContext);
    assert.equal(ambiguousProviderReplay.claimed, false);
    assert.equal(ambiguousProviderReplay.sinkState, "UNKNOWN");
    assert.equal(ambiguousProviderReplay.outboxState, "RECOVERY_REQUIRED");
    const secondProviderReplay = await resultOutboxService.claimResultSideEffect(providerContext);
    assert.equal(secondProviderReplay.claimed, false);
    assert.equal(secondProviderReplay.sinkState, "UNKNOWN");
    await db.collection(LEGACY_COMMAND_COLLECTIONS.resultVivaSyncOutbox).insertOne({
      _id: `result_viva_sync:${tenantKey}:late-1`,
      id: `result_viva_sync:${tenantKey}:late-1`,
      tenantKey,
      resultId: resultOutboxContext.resultId,
      resultRevision: resultOutboxContext.resultRevision,
      status: "SYNCED",
      retryable: false,
      attempts: 1,
    }, { writeConcern: { w: "majority" } });
    const providerIdentity = await resultOutboxService.readProviderOutboxIdentity({
      tenantKey,
      outboxId: `result_viva_sync:${tenantKey}:late-1`,
      resultId: resultOutboxContext.resultId,
      resultRevision: resultOutboxContext.resultRevision,
    });
    assert.equal(providerIdentity.resultId, resultOutboxContext.resultId);
    await assert.rejects(
      () => resultOutboxService.readProviderOutboxIdentity({
        tenantKey,
        outboxId: `result_viva_sync:${tenantKey}:late-1`,
        resultId: resultOutboxContext.resultId,
        resultRevision: resultOutboxContext.resultRevision + 1,
      }),
      (error) => error instanceof LegacyCommandError && error.code === "PROVIDER_OUTBOX_IDENTITY_CONFLICT",
    );
    await assert.rejects(
      () => resultOutboxService.completeResultSideEffect(providerContext, {
        leaseToken: providerClaim.leaseToken,
        outcome: "DELIVERED",
      }),
      /conflicts with its durable terminal outcome/,
    );
    const storedOutbox = await db.collection(LEGACY_COMMAND_COLLECTIONS.results).findOne({
      tenantKey,
      id: resultOutboxContext.resultId,
    });
    assert.equal(storedOutbox.legacyGameProjectionOutbox.sinks.find((sink) => sink.key === "provider:one").attempts, 1);

    const successfulProviderContext = {
      ...resultOutboxContext,
      sinkKey: "provider:success",
      kind: "PROVIDER",
      retryPolicy: "AT_MOST_ONCE",
    };
    const successfulProviderClaim = await resultOutboxService.claimResultSideEffect(successfulProviderContext);
    assert.equal(successfulProviderClaim.claimed, true);
    await db.collection(LEGACY_COMMAND_COLLECTIONS.resultVivaSyncOutbox).insertOne({
      _id: `result_viva_sync:${tenantKey}:success-1`,
      id: `result_viva_sync:${tenantKey}:success-1`,
      tenantKey,
      resultId: resultOutboxContext.resultId,
      resultRevision: resultOutboxContext.resultRevision,
      status: "SYNCED",
      retryable: false,
      attempts: 1,
    }, { writeConcern: { w: "majority" } });
    const successfulProviderCompletion = await resultOutboxService.completeResultSideEffect(successfulProviderContext, {
      leaseToken: successfulProviderClaim.leaseToken,
      outcome: "DELIVERED",
    });
    assert.equal(successfulProviderCompletion.sinkState, "DELIVERED");
    const successfulProviderReplay = await resultOutboxService.claimResultSideEffect(successfulProviderContext);
    assert.equal(successfulProviderReplay.claimed, false);
    assert.equal(successfulProviderReplay.sinkState, "DELIVERED");
    const otherTenantKey = "local-padel-other";
    await db.collection(LEGACY_COMMAND_COLLECTIONS.resultVivaSyncOutbox).insertOne({
      _id: `result_viva_sync:${otherTenantKey}:success-1`,
      id: `result_viva_sync:${otherTenantKey}:success-1`,
      tenantKey: otherTenantKey,
      resultId: resultOutboxContext.resultId,
      resultRevision: 2,
      status: "SYNCED",
      retryable: false,
      attempts: 1,
    });
    assert.equal(
      await db.collection(LEGACY_COMMAND_COLLECTIONS.resultVivaSyncOutbox).countDocuments({
        id: { $in: [
          `result_viva_sync:${tenantKey}:success-1`,
          `result_viva_sync:${otherTenantKey}:success-1`,
        ] },
      }),
      2,
    );

    const concurrentTerminalContext = {
      tenantKey,
      resultId: buildLegacyResultId(tenantKey, "result-outbox-idempotency-concurrent"),
      resultRevision: 1,
      bundleId: "bundle-outbox-concurrent-terminal",
    };
    await db.collection(LEGACY_COMMAND_COLLECTIONS.results).insertOne({
      _id: concurrentTerminalContext.resultId,
      tenantKey,
      id: concurrentTerminalContext.resultId,
      idempotencyKey: "result-outbox-idempotency-concurrent",
      revision: concurrentTerminalContext.resultRevision,
      gameId: "game-1",
      legacyGameProjectionOutbox: {
        version: 2,
        stateRevision: 0,
        ...concurrentTerminalContext,
        status: "PENDING",
        response: { statusCode: 200, payload: { status: "CONFIRMED" } },
        sinks: [
          { key: "rating:left", kind: "RATING", retryPolicy: "FENCED", status: "PENDING", attempts: 0 },
          { key: "rating:right", kind: "RATING", retryPolicy: "FENCED", status: "PENDING", attempts: 0 },
        ],
      },
    });
    const leftContext = { ...concurrentTerminalContext, sinkKey: "rating:left", kind: "RATING", retryPolicy: "FENCED" };
    const rightContext = { ...concurrentTerminalContext, sinkKey: "rating:right", kind: "RATING", retryPolicy: "FENCED" };
    const [leftClaim, rightClaim] = await Promise.all([
      resultOutboxService.claimResultSideEffect(leftContext),
      resultOutboxService.claimResultSideEffect(rightContext),
    ]);
    await Promise.all([
      resultOutboxService.completeResultSideEffect(leftContext, { leaseToken: leftClaim.leaseToken, outcome: "DELIVERED" }),
      resultOutboxService.completeResultSideEffect(rightContext, { leaseToken: rightClaim.leaseToken, outcome: "DELIVERED" }),
    ]);
    const terminalOutbox = await db.collection(LEGACY_COMMAND_COLLECTIONS.results).findOne({
      tenantKey,
      id: concurrentTerminalContext.resultId,
    }, { readPreference: "primary", readConcern: { level: "majority" } });
    assert.equal(terminalOutbox.legacyGameProjectionOutbox.status, "DELIVERED");
    assert.equal(terminalOutbox.legacyGameProjectionOutbox.sinks.every((sink) => sink.status === "DELIVERED"), true);

    const cleanupIntent = await resultOutboxService.persistCleanupReconciliationIntent({
      tenantKey,
      intentId: "cleanup-revision:local-padel:game-1:1:test",
      legacyGameId: "game-1",
      sourceRevision: 1,
      operationKey: "test",
      reason: "REVISION_CONFLICT",
    });
    assert.equal(cleanupIntent.persisted, true);
    assert.equal(
      await db.collection(LEGACY_COMMAND_COLLECTIONS.cleanupReconciliationIntents).countDocuments({ tenantKey }),
      1,
    );

    const mappings = db.collection(LEGACY_COMMAND_COLLECTIONS.mappings);
    await mappings.insertOne({
      tenantKey,
      canonicalUserId: "11111111-1111-4111-8111-111111111111",
      legacyUserId: "22222222-2222-4222-8222-222222222222",
      status: "ACTIVE",
      source: "TEST_FIXTURE",
      version: 1,
      evidenceRef: "fixture:actor-1",
      createdAt: new Date().toISOString(),
    });
    await assert.rejects(
      () => mappings.insertOne({
        tenantKey,
        canonicalUserId: "11111111-1111-4111-8111-111111111111",
        legacyUserId: "33333333-3333-4333-8333-333333333333",
        status: "ACTIVE",
        source: "TEST_FIXTURE",
        version: 2,
      }),
      (error) => error?.code === 11000,
    );
    await assert.rejects(
      () => mappings.insertOne({
        tenantKey,
        canonicalUserId: "44444444-4444-4444-8444-444444444444",
        legacyUserId: "22222222-2222-4222-8222-222222222222",
        status: "ACTIVE",
        source: "TEST_FIXTURE",
        version: 1,
      }),
      (error) => error?.code === 11000,
    );

    const missingMapping = await new LegacyGameCommandTransactionService({ client, db })
      .executeLegacyGameCommandTransaction(commandInput({
        canonicalUserId: "55555555-5555-4555-8555-555555555555",
      }));
    assert.equal(missingMapping.status, "REJECTED");
    assert.equal(missingMapping.error.code, "ACTOR_MAPPING_NOT_FOUND");

    await mappings.dropIndex("uniq_tenant_canonical_user");
    await mappings.insertOne({
      tenantKey,
      canonicalUserId: "11111111-1111-4111-8111-111111111111",
      legacyUserId: "66666666-6666-4666-8666-666666666666",
      status: "ACTIVE",
      source: "TEST_FIXTURE",
      version: 1,
      evidenceRef: "fixture:ambiguous",
    });
    const ambiguousMapping = await new LegacyGameCommandTransactionService({ client, db })
      .executeLegacyGameCommandTransaction(commandInput());
    assert.equal(ambiguousMapping.status, "REJECTED");
    assert.equal(ambiguousMapping.error.code, "ACTOR_MAPPING_AMBIGUOUS");
    await mappings.deleteOne({ legacyUserId: "66666666-6666-4666-8666-666666666666" });
    await mappings.createIndex(
      { tenantKey: 1, canonicalUserId: 1 },
      { name: "uniq_tenant_canonical_user", unique: true },
    );

    const service = new LegacyGameCommandTransactionService({ client, db });
    const firstInput = commandInput();
    const first = await service.executeLegacyGameCommandTransaction(firstInput);
    assert.equal(first.status, "SUCCEEDED");
    assert.equal(first.replayed, false);
    assert.equal(first.sourceVersionAfter, 2);
    const gameAfter = await db.collection(LEGACY_COMMAND_COLLECTIONS.games).findOne({ id: "game-1" });
    assert.equal(gameAfter.revision, 2);
    assert.deepEqual(gameAfter.participantIds, ["22222222-2222-4222-8222-222222222222"]);
    assert.equal(
      await db.collection(LEGACY_COMMAND_COLLECTIONS.commands).countDocuments({ idempotencyKey: firstInput.idempotencyKey }),
      1,
    );
    assert.equal(await db.collection(LEGACY_COMMAND_COLLECTIONS.auditIntents).countDocuments({}), 1);
    assert.equal(await db.collection(LEGACY_COMMAND_COLLECTIONS.outboxIntents).countDocuments({}), 1);

    const replayService = new LegacyGameCommandTransactionService({ client, db });
    const replay = await replayService.executeLegacyGameCommandTransaction(firstInput);
    assert.equal(replay.replayed, true);
    assert.equal(replay.operationId, first.operationId);
    assert.equal((await db.collection(LEGACY_COMMAND_COLLECTIONS.games).findOne({ id: "game-1" })).revision, 2);
    await assert.rejects(
      () => replayService.executeLegacyGameCommandTransaction({ ...firstInput, requestHash: hash({ changed: true }) }),
      (error) => error instanceof LegacyCommandError && error.code === "IDEMPOTENCY_KEY_REUSED",
    );

    await db.collection(LEGACY_COMMAND_COLLECTIONS.games).updateOne(
      { id: "game-1" },
      { $set: { revision: 3, participantIds: [] }, $unset: { legacyCommand: "" } },
    );
    const duplicateBase = commandInput({ expectedRevision: 3 });
    const duplicateCalls = await Promise.all([
      service.executeLegacyGameCommandTransaction(duplicateBase),
      replayService.executeLegacyGameCommandTransaction(duplicateBase),
    ]);
    assert.equal(duplicateCalls.filter((item) => item.replayed === false).length, 1);
    assert.equal(duplicateCalls.filter((item) => item.replayed === true).length, 1);
    assert.equal((await db.collection(LEGACY_COMMAND_COLLECTIONS.games).findOne({ id: "game-1" })).revision, 4);

    await client.db("admin").command({
      configureFailPoint: "failCommand",
      mode: { times: 1 },
      data: { failCommands: ["commitTransaction"], closeConnection: true },
    });
    const ambiguousCommit = commandInput({ expectedRevision: 4 });
    const recoveredCommit = await service.executeLegacyGameCommandTransaction(ambiguousCommit);
    assert.equal(recoveredCommit.status, "SUCCEEDED");
    assert.equal((await db.collection(LEGACY_COMMAND_COLLECTIONS.games).findOne({ id: "game-1" })).revision, 5);
    assert.equal(
      await db.collection(LEGACY_COMMAND_COLLECTIONS.commands).countDocuments({ idempotencyKey: ambiguousCommit.idempotencyKey }),
      1,
    );

    const delayedEvidenceInput = commandInput({ expectedRevision: 5 });
    const delayedOperationId = crypto.randomUUID();
    const delayedUnknown = Object.assign(new Error("ambiguous commit with delayed evidence"), {
      errorLabels: ["UnknownTransactionCommitResult"],
    });
    const delayedEvidenceService = new LegacyGameCommandTransactionService({
      client,
      db,
      operationIdFactory: () => delayedOperationId,
      transactionExecutor: async () => { throw delayedUnknown; },
      ambiguousReadAttempts: 3,
      ambiguousReadBarrier: async (attempt) => {
        if (attempt !== 1) return;
        const nowIso = new Date().toISOString();
        await db.collection(LEGACY_COMMAND_COLLECTIONS.commands).insertOne({
          tenantKey,
          idempotencyKey: delayedEvidenceInput.idempotencyKey,
          requestHash: delayedEvidenceInput.requestHash,
          operationId: delayedOperationId,
          correlationId: delayedEvidenceInput.correlationId,
          command: delayedEvidenceInput.command,
          canonicalUserId: delayedEvidenceInput.canonicalUserId,
          legacyGameId: delayedEvidenceInput.legacyGameId,
          state: "SUCCEEDED",
          result: {
            operationId: delayedOperationId,
            command: delayedEvidenceInput.command,
            status: "SUCCEEDED",
            replayed: false,
            legacyGameId: delayedEvidenceInput.legacyGameId,
          },
          createdAt: nowIso,
          updatedAt: nowIso,
          completedAt: nowIso,
        }, { writeConcern: { w: "majority" } });
      },
    });
    const delayedEvidence = await delayedEvidenceService.executeLegacyGameCommandTransaction(delayedEvidenceInput);
    assert.equal(delayedEvidence.status, "SUCCEEDED");
    assert.equal(delayedEvidence.replayed, true);

    const unresolvedInput = commandInput({ expectedRevision: 5 });
    const unresolvedError = Object.assign(new Error("persistently unresolved commit"), {
      errorLabels: ["UnknownTransactionCommitResult"],
    });
    const unresolvedService = new LegacyGameCommandTransactionService({
      client,
      db,
      transactionExecutor: async () => { throw unresolvedError; },
      ambiguousReadAttempts: 2,
      ambiguousReadBarrier: async () => {},
    });
    await assert.rejects(
      () => unresolvedService.executeLegacyGameCommandTransaction(unresolvedInput),
      (error) => error instanceof LegacyCommandError && error.code === "COMMAND_STATE_UNKNOWN",
    );
    const unknownLedger = await db.collection(LEGACY_COMMAND_COLLECTIONS.commands).findOne({
      tenantKey,
      idempotencyKey: unresolvedInput.idempotencyKey,
    });
    assert.equal(unknownLedger.state, "UNKNOWN");
    assert.equal(unknownLedger.reconciliationEvidence.markerObserved, false);
    const restartedService = new LegacyGameCommandTransactionService({ client, db });
    const unknownReplay = await restartedService.executeLegacyGameCommandTransaction(unresolvedInput);
    assert.equal(unknownReplay.status, "UNKNOWN");
    assert.equal(unknownReplay.replayed, true);
    const restartProbeInput = Object.fromEntries(
      Object.entries(unresolvedInput).filter(([, value]) => typeof value !== "function"),
    );
    const restartProbe = await execFileAsync(process.execPath, ["scripts/tests/legacyGameCommandReplayProbe.mjs"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        LEGACY_COMMAND_REPLAY_PROBE: JSON.stringify({ mongoUri, databaseName, input: restartProbeInput }),
      },
    });
    const processReplay = JSON.parse(restartProbe.stdout.trim());
    assert.equal(processReplay.status, "UNKNOWN");
    assert.equal(processReplay.replayed, true);
    assert.equal((await db.collection(LEGACY_COMMAND_COLLECTIONS.games).findOne({ id: "game-1" })).revision, 5);

    const crashBeforeMutation = commandInput({
      expectedRevision: 5,
      buildMutation: () => { throw new Error("simulated crash before mutation"); },
    });
    await assert.rejects(() => service.executeLegacyGameCommandTransaction(crashBeforeMutation), /simulated crash/);
    assert.equal(await db.collection(LEGACY_COMMAND_COLLECTIONS.commands).countDocuments({ idempotencyKey: crashBeforeMutation.idempotencyKey }), 0);
    assert.equal((await db.collection(LEGACY_COMMAND_COLLECTIONS.games).findOne({ id: "game-1" })).revision, 5);

    const protectedParentMutation = commandInput({
      expectedRevision: 5,
      buildMutation: () => ({ update: { $unset: { legacyCommand: "" } } }),
    });
    await assert.rejects(
      () => service.executeLegacyGameCommandTransaction(protectedParentMutation),
      (error) => error instanceof LegacyCommandError && error.code === "INVALID_MUTATION_PLAN",
    );
    assert.equal(await db.collection(LEGACY_COMMAND_COLLECTIONS.commands).countDocuments({ idempotencyKey: protectedParentMutation.idempotencyKey }), 0);

    const crashAfterMutation = commandInput({
      expectedRevision: 5,
      buildMutation: ({ legacyUserId }) => ({
        update: { $addToSet: { participantIds: legacyUserId } },
        auditIntents: [{ intentKey: "will-rollback", payload: {} }],
        outboxIntents: [{ intentKey: "will-rollback", kind: "TEST", payload: {} }],
        verifyReadBack: () => { throw new Error("simulated crash after mutation"); },
      }),
    });
    await assert.rejects(() => service.executeLegacyGameCommandTransaction(crashAfterMutation), /simulated crash after mutation/);
    assert.equal(await db.collection(LEGACY_COMMAND_COLLECTIONS.commands).countDocuments({ idempotencyKey: crashAfterMutation.idempotencyKey }), 0);
    assert.equal(await db.collection(LEGACY_COMMAND_COLLECTIONS.auditIntents).countDocuments({ operationId: { $ne: first.operationId } }), 2);
    assert.equal(await db.collection(LEGACY_COMMAND_COLLECTIONS.outboxIntents).countDocuments({ operationId: { $ne: first.operationId } }), 2);
    assert.equal((await db.collection(LEGACY_COMMAND_COLLECTIONS.games).findOne({ id: "game-1" })).revision, 5);

    const stale = await service.executeLegacyGameCommandTransaction(commandInput({ expectedRevision: 1 }));
    assert.equal(stale.status, "REJECTED");
    assert.equal(stale.error.code, "LEGACY_GAME_VERSION_CONFLICT");

    await mappings.updateOne(
      { tenantKey, canonicalUserId: "11111111-1111-4111-8111-111111111111" },
      { $set: { status: "REVOKED", revokedAt: new Date().toISOString() } },
    );
    const revoked = await service.executeLegacyGameCommandTransaction(commandInput({ expectedRevision: 5 }));
    assert.equal(revoked.status, "REJECTED");
    assert.equal(revoked.error.code, "ACTOR_MAPPING_REVOKED");
    await mappings.updateOne(
      { tenantKey, canonicalUserId: "11111111-1111-4111-8111-111111111111" },
      { $set: { status: "ACTIVE" }, $unset: { revokedAt: "" } },
    );

    await db.collection(LEGACY_COMMAND_COLLECTIONS.games).updateOne({ id: "game-1" }, { $unset: { revision: "" } });
    const missingRevision = await service.executeLegacyGameCommandTransaction(commandInput({ expectedRevision: 5 }));
    assert.equal(missingRevision.status, "REJECTED");
    assert.equal(missingRevision.error.code, "LEGACY_GAME_REVISION_REQUIRED");
  } finally {
    try { await client.db(databaseName).dropDatabase(); } catch { /* isolated best-effort cleanup */ }
    await client.close();
  }
});

test("production runner audits a disposable replica but blocks apply until an approval trust anchor is bound", {
  skip: mongoUri ? false : "Set LEGACY_COMMAND_TEST_MONGO_URI to a disposable replica-set Mongo",
  timeout: 120_000,
}, async () => {
  const client = new MongoClient(mongoUri, {
    appName: "PadlHubLegacyCommandProductionMigrationRehearsal",
    readPreference: "primary",
    serverSelectionTimeoutMS: 10_000,
  });
  const databaseName = `lk_cmd_prod_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const releaseSha = "b".repeat(40);
  const executionNonce = crypto.randomUUID();
  try {
    await client.connect();
    const db = client.db(databaseName);
    await db.collection(LEGACY_COMMAND_COLLECTIONS.games).insertOne({ tenantKey, id: "needs-revision" });
    const rating = db.collection("player_rating_state");
    await rating.createIndex({ playerKey: 1 }, { name: "player_rating_state_key_uq", unique: true });
    await rating.createIndex(
      { clientId: 1 },
      { name: "player_rating_state_client_uq", unique: true, partialFilterExpression: { clientId: { $type: "string" } } },
    );
    await rating.createIndex(
      { phoneNorm: 1 },
      { name: "player_rating_state_phone_uq", unique: true, partialFilterExpression: { phoneNorm: { $type: "string" } } },
    );

    const now = new Date();
    const planTime = new Date(now.getTime() - 3 * 60_000);
    const context = await buildProductionMigrationContext(db, { now: planTime });
    assert.equal(context.readyForExecutionPacket, true);
    assert.equal(context.audit.invalidRevisionCount, 1);
    const packet = productionPacket(context, releaseSha, executionNonce, now);
    const packetSha256 = sha256(Buffer.from(JSON.stringify(packet)));
    await assert.rejects(() => executeProductionMigration(db, {
      packet,
      packetSha256,
      actualPacketSha256: packetSha256,
      releaseSha,
      confirmation: PRODUCTION_APPLY_CONFIRMATION,
      environment: "test",
      now,
      evidenceSha256: {
        backupManifestSha256: "5".repeat(64),
        restoreVerificationSha256: "7".repeat(64),
        quiescenceAttestationSha256: "8".repeat(64),
        runtimeCompatibilitySha256: "9".repeat(64),
      },
    }), /approval trust anchor is not bound/);
    assert.equal((await db.collection(LEGACY_COMMAND_COLLECTIONS.games).findOne({ id: "needs-revision" })).revision, undefined);
    assert.equal(await db.collection("lk_legacy_game_prerequisite_migration_executions").countDocuments({}), 0);
  } finally {
    try { await client.db(databaseName).dropDatabase(); } catch { /* isolated best-effort cleanup */ }
    await client.close();
  }
});
