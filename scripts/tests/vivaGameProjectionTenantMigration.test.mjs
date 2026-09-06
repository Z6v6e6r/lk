import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildLegacyTenantMigrationMongoQuery,
  buildLegacyTenantMigrationPlan,
  classifyLegacyTenantMigrationGame,
} from "../lib/vivaGameProjectionTenantMigration.mjs";
import {
  prepareVivaGameProjectionTenantMigration,
  validateCaptureReceipt,
} from "../prepare_viva_game_projection_tenant_migration.mjs";

const exerciseId = "11111111-1111-4111-8111-111111111111";
const scope = { tenantKey: "iSkq6G", dateFrom: "2026-09-04", dateTo: "2026-09-11", operationId: "viva-projection-migration-20260904" };
const providerServicePrincipalSha256 = crypto.createHash("sha256").update("viva-service-subject").digest("hex");
const game = (overrides = {}) => ({
  _id: { $oid: "111111111111111111111111" },
  id: `viva_${exerciseId}`,
  tenantKey: null,
  revision: null,
  status: "PAID",
  archived: false,
  dedupeKey: `viva:${exerciseId}`,
  updatedAt: "2026-09-04T08:00:00.000Z",
  booking: { vivaExerciseId: exerciseId, exerciseId, studioId: "studio-1", date: "2026-09-05", timeFrom: "12:00", timeTo: "14:00" },
  metadata: { vivaExerciseId: exerciseId, exerciseId },
  ...overrides,
});
const provider = (overrides = {}) => ({
  id: exerciseId,
  studio: { id: "studio-1" },
  date: "2026-09-05",
  timeFrom: "2026-09-05T12:00:00+03:00",
  timeTo: "2026-09-05T14:00:00+03:00",
  status: "ACTIVE",
  active: true,
  ...overrides,
});

test("migration query selects only bounded active legacy records", () => {
  assert.deepEqual(buildLegacyTenantMigrationMongoQuery(scope), {
    archived: { $ne: true },
    status: { $nin: ["CANCELLED", "CANCELED"] },
    tenantKey: null,
    revision: null,
    "booking.date": { $gte: scope.dateFrom, $lte: scope.dateTo },
    "booking.timeFrom": { $type: "string", $ne: "" },
    "booking.timeTo": { $type: "string", $ne: "" },
    "booking.studioId": { $type: "string", $ne: "" },
  });
});

test("migration requires one exact provider identity inside the configured tenant snapshot", () => {
  const accepted = classifyLegacyTenantMigrationGame(game(), [provider()], scope);
  assert.equal(accepted.eligible, true);
  assert.equal(accepted.reason, "PROVIDER_IDENTITY_CONFIRMED");
  assert.equal(classifyLegacyTenantMigrationGame(game({ metadata: { vivaExerciseId: "22222222-2222-4222-8222-222222222222" } }), [provider()], scope).reason, "EXERCISE_IDENTITY_INVALID");
  assert.equal(classifyLegacyTenantMigrationGame(game({ metadata: { vivaExerciseId: exerciseId, exerciseId: "22222222-2222-4222-8222-222222222222" } }), [provider()], scope).reason, "EXERCISE_IDENTITY_INVALID");
  assert.equal(classifyLegacyTenantMigrationGame(game(), [], scope).reason, "PROVIDER_EXERCISE_MISSING");
  assert.equal(classifyLegacyTenantMigrationGame(game(), [provider(), provider()], scope).reason, "PROVIDER_EXERCISE_DUPLICATE");
  assert.equal(classifyLegacyTenantMigrationGame(game(), [provider({ studio: { id: "other-studio" } })], scope).reason, "PROVIDER_SLOT_MISMATCH");
  assert.equal(classifyLegacyTenantMigrationGame(game(), [provider({ status: "CANCELLED" })], scope).reason, "PROVIDER_EXERCISE_INACTIVE");
  assert.equal(classifyLegacyTenantMigrationGame(game(), [provider({ status: undefined, active: undefined })], scope).reason, "PROVIDER_EXERCISE_STATUS_UNKNOWN");
  assert.equal(classifyLegacyTenantMigrationGame(game(), [provider({ uuid: "22222222-2222-4222-8222-222222222222" })], scope).reason, "PROVIDER_IDENTITY_AMBIGUOUS");
  assert.equal(classifyLegacyTenantMigrationGame(game(), [provider({ studioId: "other-studio" })], scope).reason, "PROVIDER_IDENTITY_AMBIGUOUS");
  assert.equal(classifyLegacyTenantMigrationGame(game(), [provider({ studio: { id: "studio-1", uuid: "other-studio" } })], scope).reason, "PROVIDER_IDENTITY_AMBIGUOUS");
  assert.equal(classifyLegacyTenantMigrationGame(game(), [provider({ startTime: "2026-09-05T13:00:00+03:00" })], scope).reason, "PROVIDER_IDENTITY_AMBIGUOUS");
  assert.equal(classifyLegacyTenantMigrationGame(game(), [provider({ date: "2026-09-06" })], scope).reason, "PROVIDER_IDENTITY_AMBIGUOUS");
  assert.equal(classifyLegacyTenantMigrationGame(game(), [provider({ status: "UNKNOWN" })], scope).reason, "PROVIDER_EXERCISE_STATUS_UNKNOWN");
  assert.equal(classifyLegacyTenantMigrationGame(game(), [provider({ state: "CANCELLED" })], scope).reason, "PROVIDER_LIFECYCLE_AMBIGUOUS");
  assert.equal(classifyLegacyTenantMigrationGame(game({ status: "UNKNOWN" }), [provider()], scope).reason, "GAME_STATUS_UNKNOWN");
});

test("migration accepts a single fallback identity while CAS preserves a missing booking identity", () => {
  const fallback = game({
    booking: { exerciseId, studioId: "studio-1", date: "2026-09-05", timeFrom: "12:00", timeTo: "14:00" },
    metadata: {},
    dedupeKey: null,
  });
  const plan = buildLegacyTenantMigrationPlan([fallback], { "2026-09-05": [provider()] }, scope, "2026-09-04T09:00:00.000Z");
  assert.equal(plan.eligibleCount, 1);
  assert.deepEqual(plan.operations[0].filter["booking.vivaExerciseId"], { $exists: false });
});

test("migration operation is CAS-bound and changes no payment or roster state", () => {
  const plan = buildLegacyTenantMigrationPlan([game()], { "2026-09-05": [provider()] }, scope, "2026-09-04T09:00:00.000Z");
  assert.equal(plan.eligibleCount, 1);
  const operation = plan.operations[0];
  assert.deepEqual(operation.filter._id, { $oid: "111111111111111111111111" });
  assert.equal(operation.filter.tenantKey, null);
  assert.equal(operation.filter.revision, null);
  assert.equal(operation.filter["booking.vivaExerciseId"], exerciseId);
  assert.equal(operation.filter["booking.exerciseId"], exerciseId);
  assert.equal(operation.filter["metadata.vivaExerciseId"], exerciseId);
  assert.equal(operation.filter["metadata.exerciseId"], exerciseId);
  assert.equal(operation.filter.dedupeKey, `viva:${exerciseId}`);
  assert.equal(operation.filter.status, "PAID");
  assert.equal(operation.filter.updatedAt, "2026-09-04T08:00:00.000Z");
  assert.deepEqual(operation.options, { upsert: false });
  assert.equal(operation.update.$set.tenantKey, "iSkq6G");
  assert.equal(operation.update.$set.revision, 1);
  assert.equal(operation.update.$set["metadata.tenantRevisionMigration"].operationId, scope.operationId);
  assert.equal(Object.keys(operation.update.$set).some((key) => /payment|participant|roster/i.test(key)), false);
});

test("migration rejects the public End User exercise capture contract", () => {
  const dates = ["2026-09-04", "2026-09-05", "2026-09-06", "2026-09-07", "2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11"];
  const rowsByDate = Object.fromEntries(dates.map((date) => [date, []]));
  const receipt = {
    formatVersion: 1,
    sourceKind: "viva-end-user-tenant-capture-receipt",
    capturedAt: "2026-09-04T08:56:00.000Z",
    tenantKey: scope.tenantKey,
    endpointOrigin: "https://api.vivacrm.ru",
    captures: dates.map((date) => ({
      date,
      requestPath: `/end-user/api/v1/${scope.tenantKey}/exercises?date=${date}`,
      statusCode: 200,
      complete: true,
      responseShape: "array",
      rowCount: 0,
      rowsSha256: crypto.createHash("sha256").update("[]").digest("hex"),
    })),
  };
  const receiptSha256 = crypto.createHash("sha256").update(JSON.stringify(receipt)).digest("hex");
  assert.throws(() => validateCaptureReceipt(receipt, receiptSha256, {
    capturedAt: receipt.capturedAt,
    captureReceiptSha256: receiptSha256,
    rowsByDate,
  }, scope), /Provider capture receipt contract mismatch/);
});

test("offline preparer writes a private dry-run plan and performs zero writes", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "viva-tenant-migration-")));
  try {
    fs.chmodSync(root, 0o700);
    const gamesFile = path.join(root, "games.json");
    const providerFile = path.join(root, "provider.json");
    const receiptFile = path.join(root, "provider-receipt.json");
    fs.writeFileSync(gamesFile, `${JSON.stringify({
      formatVersion: 1,
      sourceKind: "live-147-mongo-projection",
      sourceHost: "lk-primary-147",
      sourceFlowSha256: "a".repeat(64),
      database: "games",
      collection: "lk_games",
      capturedAt: "2026-09-04T08:55:00.000Z",
      games: [game()],
    })}\n`, { mode: 0o600 });
    const dates = ["2026-09-04", "2026-09-05", "2026-09-06", "2026-09-07", "2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11"];
    const rowsByDate = Object.fromEntries(dates.map((date) => [date, date === "2026-09-05" ? [provider()] : []]));
    const receiptBytes = Buffer.from(`${JSON.stringify({
      formatVersion: 1,
      sourceKind: "viva-admin-service-capture-receipt",
      capturedAt: "2026-09-04T08:56:00.000Z",
      tenantKey: scope.tenantKey,
      servicePrincipalSha256: providerServicePrincipalSha256,
      endpointOrigin: "https://api.vivacrm.ru",
      captures: dates.map((date) => ({
        date,
        requestPath: `/api/v1/exercises?date=${date}&includeCanceled=false&page=0&size=1000`,
        statusCode: 200,
        complete: true,
        responseShape: "array",
        rowCount: rowsByDate[date].length,
        rowsSha256: crypto.createHash("sha256").update(JSON.stringify(rowsByDate[date])).digest("hex"),
      })),
    })}\n`);
    const receiptSha256 = crypto.createHash("sha256").update(receiptBytes).digest("hex");
    fs.writeFileSync(receiptFile, receiptBytes, { mode: 0o600 });
    fs.writeFileSync(providerFile, `${JSON.stringify({
      formatVersion: 1,
      sourceKind: "viva-admin-service-projection",
      capturedAt: "2026-09-04T08:56:00.000Z",
      tenantKey: scope.tenantKey,
      servicePrincipalSha256: providerServicePrincipalSha256,
      captureReceiptSha256: receiptSha256,
      rowsByDate,
    })}\n`, { mode: 0o600 });
    fs.chmodSync(gamesFile, 0o600);
    fs.chmodSync(providerFile, 0o600);
    fs.chmodSync(receiptFile, 0o600);
    const custody = {
      providerCaptureReceiptFile: receiptFile,
      expectedProviderReceiptSha256: receiptSha256,
      expectedProviderServicePrincipalSha256: providerServicePrincipalSha256,
    };
    const outputDirectory = path.join(root, "plan");
    const summary = prepareVivaGameProjectionTenantMigration({
      gamesFile,
      providerFile,
      ...custody,
      outputDirectory,
      scope,
      configuredTenantKey: scope.tenantKey,
      expectedSourceFlowSha256: "a".repeat(64),
      nowIso: "2026-09-04T09:00:00.000Z",
    });
    assert.equal(summary.eligibleCount, 1);
    assert.equal(summary.writesPerformed, 0);
    assert.equal(summary.dryRunOnly, true);
    assert.equal(summary.providerServicePrincipalSha256, providerServicePrincipalSha256);
    assert.equal(fs.statSync(outputDirectory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(outputDirectory, "plan.json")).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(outputDirectory, "summary.json")).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(outputDirectory, "READY")).mode & 0o777, 0o600);
    const plan = JSON.parse(fs.readFileSync(path.join(outputDirectory, "plan.json"), "utf8"));
    assert.equal(plan.dryRunOnly, true);
    assert.equal(plan.operations.length, 1);
    assert.equal(fs.readFileSync(path.join(outputDirectory, "READY"), "utf8").trim(), summary.planSha256);

    assert.throws(() => prepareVivaGameProjectionTenantMigration({
      gamesFile, providerFile, ...custody,
      expectedProviderServicePrincipalSha256: "0".repeat(64),
      outputDirectory: path.join(root, "principal-mismatch"), scope,
      configuredTenantKey: scope.tenantKey, expectedSourceFlowSha256: "a".repeat(64), nowIso: "2026-09-04T09:00:00.000Z",
    }), /does not match the independently verified runtime principal/);

    const broadGamesFile = path.join(root, "broad-games.json");
    const broadGames = JSON.parse(fs.readFileSync(gamesFile, "utf8"));
    broadGames.games[0].participants = [];
    fs.writeFileSync(broadGamesFile, `${JSON.stringify(broadGames)}\n`, { mode: 0o600 });
    fs.chmodSync(broadGamesFile, 0o600);
    assert.throws(() => prepareVivaGameProjectionTenantMigration({
      gamesFile: broadGamesFile, providerFile, ...custody, outputDirectory: path.join(root, "broad-input"), scope,
      configuredTenantKey: scope.tenantKey, expectedSourceFlowSha256: "a".repeat(64), nowIso: "2026-09-04T09:00:00.000Z",
    }), /Game 0 contains unexpected field: participants/);

    const operatorGamesFile = path.join(root, "operator-games.json");
    const operatorGames = JSON.parse(fs.readFileSync(gamesFile, "utf8"));
    operatorGames.games[0].status = { $ne: "CANCELLED" };
    fs.writeFileSync(operatorGamesFile, `${JSON.stringify(operatorGames)}\n`, { mode: 0o600 });
    fs.chmodSync(operatorGamesFile, 0o600);
    assert.throws(() => prepareVivaGameProjectionTenantMigration({
      gamesFile: operatorGamesFile, providerFile, ...custody, outputDirectory: path.join(root, "operator-input"), scope,
      configuredTenantKey: scope.tenantKey, expectedSourceFlowSha256: "a".repeat(64), nowIso: "2026-09-04T09:00:00.000Z",
    }), /Game 0 status must be a non-empty string/);

    assert.throws(() => prepareVivaGameProjectionTenantMigration({
      gamesFile, providerFile, ...custody, outputDirectory: path.join(root, "mismatch"), scope: { ...scope, tenantKey: "other-tenant" },
      configuredTenantKey: scope.tenantKey, expectedSourceFlowSha256: "a".repeat(64), nowIso: "2026-09-04T09:00:00.000Z",
    }), /Requested tenant does not match PADLHUB_PLATFORM_TENANT_KEY/);
    assert.throws(() => prepareVivaGameProjectionTenantMigration({
      gamesFile, providerFile, ...custody, outputDirectory: path.join(root, "flow-mismatch"), scope,
      configuredTenantKey: scope.tenantKey, expectedSourceFlowSha256: "b".repeat(64), nowIso: "2026-09-04T09:00:00.000Z",
    }), /source-flow proof mismatch/);

    const staleGamesFile = path.join(root, "stale-games.json");
    const staleGames = JSON.parse(fs.readFileSync(gamesFile, "utf8"));
    staleGames.capturedAt = "2026-09-04T08:00:00.000Z";
    fs.writeFileSync(staleGamesFile, `${JSON.stringify(staleGames)}\n`, { mode: 0o600 });
    fs.chmodSync(staleGamesFile, 0o600);
    assert.throws(() => prepareVivaGameProjectionTenantMigration({
      gamesFile: staleGamesFile, providerFile, ...custody, outputDirectory: path.join(root, "stale"), scope,
      configuredTenantKey: scope.tenantKey, expectedSourceFlowSha256: "a".repeat(64), nowIso: "2026-09-04T09:00:00.000Z",
    }), /Games projection is stale/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
