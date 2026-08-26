import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { auditLegacyGameRevisionWriters } from "../audit_legacy_game_revision_writers.mjs";
import {
  assertLocalApplyAllowed,
  buildLegacyPrerequisiteRollbackPlan,
  parseLegacyPrerequisiteArgs,
  verifyIndexes,
} from "../migrate_legacy_game_command_prerequisites.mjs";
import { buildLegacyGameCommandPrerequisiteCandidate } from "../patch_live_games_command_prerequisites.mjs";
import {
  buildLegacyResultId,
  LEGACY_COMMAND_COLLECTIONS,
  LEGACY_COMMAND_INDEX_SPECS,
  validateLegacyIdentityMapping,
} from "../../node-red/custom-nodes/legacy-game-command-transaction/legacy-game-command-core.mjs";

const registry = JSON.parse(fs.readFileSync("scripts/legacy_game_revision_writers.json", "utf8"));
const reconciliation = JSON.parse(fs.readFileSync("scripts/legacy_game_command_live_reconciliation.json", "utf8"));
const liveFlowPath = process.env.LEGACY_COMMAND_LIVE_FLOW_FIXTURE;
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

test("PATCH writer registry separates the active live preimage from the combined tracked candidate", () => {
  const patchWriter = registry.writers.find((writer) => writer.nodeId === "591234d213742276");
  const patchSource = patchWriter?.sourceNodes?.find((source) => source.nodeId === "e0d7883bc1a9fa8c");
  assert.ok(patchSource);
  assert.equal(patchSource.activeGenerated, true);
  assert.equal(patchSource.activeSha256, "4fb7d6ca9961e854cefb22f0752f9c1f921e1b6cbacfea3ce16e8b8681538931");
  assert.equal(patchSource.sourcePath, undefined);
  assert.equal(patchSource.candidateSourcePath, "scripts/nodered_games_nodes/fn_patch.js");
  assert.equal(
    patchSource.candidateSha256,
    sha256(fs.readFileSync(patchSource.candidateSourcePath, "utf8")),
  );
  assert.notEqual(patchSource.activeSha256, patchSource.candidateSha256);
});

test("migration CLI is read-only by default and production apply is impossible", () => {
  const localTargetId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  assert.deepEqual(parseLegacyPrerequisiteArgs([]), { mode: "audit", environment: "local" });
  assert.throws(
    () => assertLocalApplyAllowed({ mode: "apply", environment: "production", databaseName: "production", confirmLocalApply: true, localTargetId, mongoUri: "mongodb://127.0.0.1:27017" }),
    /Production and shared-environment apply are forbidden/,
  );
  assert.throws(
    () => assertLocalApplyAllowed({ mode: "apply", environment: "local", databaseName: "lk", confirmLocalApply: true, localTargetId, mongoUri: "mongodb://127.0.0.1:27017" }),
    /database name containing local, test, or dev/,
  );
  assert.doesNotThrow(() => assertLocalApplyAllowed({
    mode: "apply",
    environment: "test",
    databaseName: "lk_command_test",
    confirmLocalApply: true,
    localTargetId,
    mongoUri: "mongodb://127.0.0.1:27017/?directConnection=true",
  }));
  assert.throws(() => assertLocalApplyAllowed({
    mode: "apply",
    environment: "test",
    databaseName: "lk_command_test",
    confirmLocalApply: true,
    localTargetId,
    mongoUri: "mongodb://mongo.internal:27017",
  }), /loopback Mongo destination/);
});

test("rollback plan preserves revision and forensic ledgers", () => {
  const plan = buildLegacyPrerequisiteRollbackPlan();
  assert.equal(plan.automaticRollback, false);
  assert.match(plan.steps.join("\n"), /Keep revision values/);
  assert.match(plan.steps.join("\n"), /Revoke incorrect mappings/);
  assert.match(plan.steps.join("\n"), /forensic records/);
});

test("writer inventory fails closed on an unregistered lk_games writer", () => {
  const fixture = registry.writers.map((writer) => ({
    id: writer.nodeId,
    type: "mongodb4",
    collection: "lk_games",
    operation: "updateOne",
    wires: [[]],
  }));
  fixture.push({ id: "new-unregistered-writer", type: "mongodb4", collection: "lk_games", operation: "updateOne", wires: [[]] });
  assert.throws(
    () => auditLegacyGameRevisionWriters(fixture, registry, { stage: "active" }),
    /unknown=new-unregistered-writer/,
  );
  fixture.pop();
  fixture.push({ id: "new-replace-writer", type: "mongodb4", collection: "lk_games", operation: "replaceOne", wires: [[]] });
  assert.throws(
    () => auditLegacyGameRevisionWriters(fixture, registry, { stage: "active" }),
    /unknown=new-replace-writer/,
  );
  fixture.pop();
  fixture.push({ id: "new-aggregate-writer", type: "mongodb4", collection: "another_collection", operation: "aggregate", wires: [[]] });
  assert.throws(
    () => auditLegacyGameRevisionWriters(fixture, registry, { stage: "active" }),
    /unknown=new-aggregate-writer/,
  );
});

test("identity mapping requires trimmed tenant and canonical lowercase UUIDs", () => {
  const base = {
    tenantKey: "tenant-1",
    canonicalUserId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    legacyUserId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    status: "ACTIVE",
    source: "TEST_FIXTURE",
    version: 1,
    evidenceRef: "fixture:canonical",
    createdAt: "2026-08-26T00:00:00.000Z",
  };
  assert.deepEqual(validateLegacyIdentityMapping(base), []);
  assert.match(validateLegacyIdentityMapping({ ...base, tenantKey: " tenant-1 " }).join(" "), /trimmed/);
  assert.match(validateLegacyIdentityMapping({ ...base, canonicalUserId: base.canonicalUserId.toUpperCase() }).join(" "), /lowercase/);
  assert.match(validateLegacyIdentityMapping({ ...base, legacyUserId: base.legacyUserId.toUpperCase() }).join(" "), /lowercase/);
});

test("index postcheck rejects weakened sparse, partial, collation, TTL, and hidden options", async () => {
  const weakenings = [
    { sparse: true },
    { partialFilterExpression: { tenantKey: { $exists: true } } },
    { collation: { locale: "en", strength: 2 } },
    { expireAfterSeconds: 60 },
    { hidden: true },
  ];
  for (const weakening of weakenings) {
    const db = {
      collection: (collectionName) => ({
        indexes: async () => Object.entries(LEGACY_COMMAND_INDEX_SPECS).flatMap(([logicalName, specs]) => {
          if (LEGACY_COMMAND_COLLECTIONS[logicalName] !== collectionName) return [];
          return specs.map((spec, index) => ({
            name: spec.name,
            key: spec.key,
            ...(spec.unique ? { unique: true } : {}),
            ...(logicalName === "results" && index === 0 ? weakening : {}),
          }));
        }),
      }),
    };
    const mismatches = await verifyIndexes(db);
    assert.ok(mismatches.some((item) => item.endsWith(`:${Object.keys(weakening)[0]}`)));
  }
});

test("fresh live preimage builds a source-only revision candidate without adding routes", {
  skip: liveFlowPath ? false : "Set LEGACY_COMMAND_LIVE_FLOW_FIXTURE to the fresh external live-flow snapshot",
}, () => {
  const source = JSON.parse(fs.readFileSync(path.resolve(liveFlowPath), "utf8"));
  const result = buildLegacyGameCommandPrerequisiteCandidate(source);
  assert.equal(reconciliation.schemaVersion, 2);
  assert.equal(reconciliation.source.sha256, sha256(fs.readFileSync(path.resolve(liveFlowPath))));
  assert.equal(reconciliation.candidate.sha256, "6c8512eeffbf57edc720019487a60a2779b1ec180f1ae373a201519f96a6271e");
  assert.equal(result.writerAudit.ok, true);
  assert.equal(result.flow.length, source.length + 36);
  assert.equal(
    result.flow.filter((node) => node.type === "http in").length,
    source.filter((node) => node.type === "http in").length,
  );
  assert.equal(result.changes.filter((change) => change.kind === "changed").length, 47);
  assert.equal(
    sha256(result.flow.find((node) => node.id === "e0d7883bc1a9fa8c")?.func || ""),
    "9c6aaf4578c69fa30daa2326506900a5ee0a265f2299f1f0e3ab20b11e01a130",
  );
  assert.equal(
    sha256(`${JSON.stringify(result.flow, null, 2)}\n`),
    "949c16d1be1d04672f33ab90fa3ac1c70a7eac7d1cf9ad50680b60edab0774aa",
  );
  assert.deepEqual(Object.keys(reconciliation).sort(), [
    "candidate",
    "candidateSelectedTab",
    "deploymentPerformed",
    "liveTransitions",
    "schemaVersion",
    "selectedTab",
    "source",
  ]);
  assert.deepEqual(reconciliation.liveTransitions, [
    {
      changedNodeCount: 1,
      drifts: [{
        changedFields: ["func"],
        newFieldSha256: "286ec1bf11b9c5abe65e5bf3affdd8c9183289104a764d97d34530f13ed38552",
        nodeId: "f3f9a60354d394da",
        nodeName: "Prepare split game payment",
        nodeType: "function",
        preservedInCandidate: true,
        previousFieldSha256: "743a09502587b1ebab20d8ec9bb2a2ebe22341c3ea3a49214d5d0a0dc9a176fb",
      }],
      fromFlowSha256: "0d25df4289a38978ac925f46689eaa30b6fc38efb5de00061ba86266f613a24e",
      toFlowSha256: "42cbd9a4fc3e53aacadb24601c2a430e78f36d9b79a5f5725782667a87735c42",
    },
    {
      changedNodeCount: 2,
      drifts: [
        {
          changedFields: ["func"],
          newFieldSha256: "90bbd7f76a53d33336e83dc465b6676fcdd6ef5a25ff1fe98b9eeb39c0ba1a08",
          nodeId: "e92e68bf3f08a70c",
          nodeName: "Prepare split join payment",
          nodeType: "function",
          preservedInCandidate: true,
          previousFieldSha256: "132a6b2ae0b445da6874e9a3f03f82987eb87f50b4cac7b2b1929f541f5ae983",
        },
        {
          changedFields: ["func"],
          newFieldSha256: "4fe085c17796439ef77576714305c8d7a754d90017e34bd50367eeafca001774",
          nodeId: "8f7bd5b482fe9763",
          nodeName: "Route Viva split payment",
          nodeType: "function",
          preservedInCandidate: true,
          previousFieldSha256: "bc8b5630f52ff4315d64cb83c2e0df172444549a668573304aead17df49bb825",
        },
      ],
      fromFlowSha256: "42cbd9a4fc3e53aacadb24601c2a430e78f36d9b79a5f5725782667a87735c42",
      toFlowSha256: "14b5aff65e0b49fd4f37d6d1d9465af8af3ccdf2e6cfa77bc76b4a9f2a831350",
    },
  ]);
  const liveDrifts = reconciliation.liveTransitions.flatMap((transition) => {
    assert.equal(transition.drifts.length, transition.changedNodeCount);
    return transition.drifts;
  });
  assert.deepEqual(liveDrifts.map((drift) => drift.nodeId).sort(), [
    "8f7bd5b482fe9763",
    "e92e68bf3f08a70c",
    "f3f9a60354d394da",
  ]);
  for (const drift of liveDrifts) {
    const sourceNode = source.find((node) => node.id === drift.nodeId);
    const candidateNode = result.flow.find((node) => node.id === drift.nodeId);
    assert.equal(drift.changedFields.join(","), "func");
    assert.match(drift.previousFieldSha256, /^[a-f0-9]{64}$/);
    assert.notEqual(drift.previousFieldSha256, drift.newFieldSha256);
    assert.equal(sha256(JSON.stringify(sourceNode.func)), drift.newFieldSha256);
    assert.equal(candidateNode.func, sourceNode.func, `${drift.nodeId} must preserve parallel live source`);
    assert.equal(drift.preservedInCandidate, true);
    assert.equal(result.changes.some((change) => change.id === drift.nodeId), false);
  }
  const selectedSource = source.filter((node) => node.type !== "tab" && node.z === reconciliation.selectedTab.tabId);
  assert.equal(sha256(`${JSON.stringify(selectedSource, null, 2)}\n`), reconciliation.selectedTab.sha256);
  assert.equal(reconciliation.candidateSelectedTab.sha256, "490a5311a6be9ab7078bf5c00db608c36af35546614824e289ae2f0ce806741d");
  assert.equal(
    sha256(`${JSON.stringify(result.flow.filter((node) => node.type !== "tab" && node.z === reconciliation.selectedTab.tabId), null, 2)}\n`),
    "0b5bfdf93302ac79bd9376cd8414c22d83d6e9ef3073d6210efd89e5dafaade4",
  );
  const disconnected = structuredClone(result.flow);
  const revisionQuery = disconnected.find((node) => node.id === "eb7060667c2da065");
  revisionQuery.wires = [[]];
  assert.throws(
    () => auditLegacyGameRevisionWriters(disconnected, registry, { stage: "candidate" }),
    /disconnected from ancestor eb7060667c2da065/,
  );
  for (const nodeId of ["4ba07d3d50014066", "c67e08684d1e4fe9"]) {
    const func = result.flow.find((node) => node.id === nodeId)?.func || "";
    assert.match(func, /LEGACY_GAME_PROJECTION_INCOMPLETE/);
    assert.match(func, /recoveryRequired:\s*true/);
  }

  const run = (nodeId, msg, tenantKey = "tenant-1") => new Function(
    "msg",
    "env",
    result.flow.find((node) => node.id === nodeId).func,
  )(msg, { get: (key) => key === "PADLHUB_PLATFORM_TENANT_KEY" ? tenantKey : null });

  const buildTenantResult = (tenantKey, idempotencyKey = "shared-idempotency-key", scoreA = 2) => run("4ba07d3d50014066", {
    payload: [],
    _resultExistingRows: [],
    _resultSubmit: {
      tenantKey,
      gameId: "shared-game-id",
      idempotencyKey,
      game: { tenantKey, id: "shared-game-id", booking: {}, settings: { ratingGame: false } },
      actorMember: { memberKey: "member-1", id: "actor-1", name: "Actor" },
      scoreA,
      scoreB: 0,
      sets: [{ left: 6, right: 3 }],
      scoringSets: [{ left: 6, right: 3 }],
      setPairings: [],
      teams: { teamA: [], teamB: [] },
      ratingEnabled: false,
    },
  }, tenantKey)[0];
  const tenantOneResult = buildTenantResult("tenant-1");
  const tenantTwoResult = buildTenantResult("tenant-2");
  assert.notEqual(tenantOneResult.payload[0].id, tenantTwoResult.payload[0].id);
  assert.equal(tenantOneResult.payload[0].id, buildLegacyResultId("tenant-1", "shared-idempotency-key"));
  assert.equal(tenantTwoResult.payload[0].id, buildLegacyResultId("tenant-2", "shared-idempotency-key"));
  assert.equal(tenantOneResult.payload[0].tenantKey, "tenant-1");
  assert.equal(tenantTwoResult.payload[0].tenantKey, "tenant-2");
  const collisionOne = buildTenantResult("tenant-1", "y58r2hkvetwf", 1);
  const collisionTwo = buildTenantResult("tenant-1", "ytkvy947mxsr", 2);
  assert.notEqual(collisionOne.payload[0].id, collisionTwo.payload[0].id);
  const separatorCollisionOne = buildTenantResult("a_b", "c1234567", 1);
  const separatorCollisionTwo = buildTenantResult("a", "b_c1234567", 2);
  assert.notEqual(separatorCollisionOne.payload[0].id, separatorCollisionTwo.payload[0].id);

  const storedResult = tenantOneResult._resultSubmitDoc;
  const readbackOk = run("lk_result_submit_idempotency_ack_20260826", {
    _resultSubmitDoc: storedResult,
    _resultSubmitStoredDoc: storedResult,
    _resultSubmit: {
      game: {
        tenantKey: storedResult.tenantKey,
        id: storedResult.gameId,
        resultId: storedResult.id,
        resultLifecycleState: storedResult.lifecycleState,
      },
    },
  });
  assert.equal(readbackOk[0]._resultSubmitDoc.idempotent, true);
  const readbackConflict = run("lk_result_submit_idempotency_ack_20260826", {
    _resultSubmitDoc: storedResult,
    _resultSubmitStoredDoc: { ...storedResult, resultSignature: "different" },
    _resultSubmit: { game: { tenantKey: storedResult.tenantKey, id: storedResult.gameId } },
  });
  assert.equal(readbackConflict[1].statusCode, 409);
  assert.equal(readbackConflict[1].payload.code, "RESULT_IDEMPOTENCY_CONFLICT");
  const rejectedUpdatedAt = run("lk_game_patch_cas_guard_20260801", {
    req: { params: { gameId: "game-1" } },
    payload: { participants: [], expectedUpdatedAt: "2026-08-26T00:00:00.000Z" },
  });
  assert.equal(rejectedUpdatedAt[1].statusCode, 428);
  const guarded = run("lk_game_patch_cas_guard_20260801", {
    req: { params: { gameId: "game-1" } },
    payload: { waitlist: [], expectedRevision: 7 },
  })[0];
  guarded.payload = [
    { id: "game-1", archived: { $ne: true } },
    { $set: { waitlist: [], updatedAt: "2026-08-26T00:00:00.000Z" } },
    {},
  ];
  const revisionWrite = run("lk_game_patch_apply_cas_20260801", guarded);
  assert.equal(revisionWrite.payload[0].revision, 7);
  assert.equal(revisionWrite.payload[0].tenantKey, "tenant-1");
  assert.equal(revisionWrite.payload[1].$inc.revision, 1);
  assert.equal(revisionWrite._gamePatchCas.nextRevision, 8);
  for (const field of ["status", "archived", "settings", "invite", "booking", "payment"]) {
    const rejected = run("lk_game_patch_cas_guard_20260801", {
      req: { params: { gameId: "game-1" } },
      payload: { [field]: field === "archived" ? true : {} },
    });
    assert.equal(rejected[1].statusCode, 428, `${field} must not bypass revision CAS`);
  }

  const resultRevision = run("eb7060667c2da065", {
    _resultConfirm: { game: { tenantKey: "tenant-1", id: "game-1", revision: 11 } },
    payload: [{ id: "game-1" }, { $set: { resultStatus: "CONFIRMED" } }, { upsert: false }],
  });
  assert.deepEqual(resultRevision.payload[0], { id: "game-1", tenantKey: "tenant-1", revision: 11 });
  assert.equal(resultRevision.payload[1].$inc.revision, 1);
  const provisionalProjection = run("result_submit_after_write_003", {
    payload: { acknowledged: true, upsertedCount: 1, upsertedId: "result-1" },
    _resultSubmit: { game: { tenantKey: "tenant-1", id: "game-1", revision: 12 } },
    _resultSubmitDoc: {
      id: "result-1",
      gameId: "game-1",
      submittedAt: "2026-08-26T00:00:00.000Z",
      updatedAt: "2026-08-26T00:00:00.000Z",
      ratingEnabled: false,
      ratingWork: { status: "SKIPPED" },
    },
  });
  assert.deepEqual(provisionalProjection[1].payload[0], { tenantKey: "tenant-1", id: "game-1", revision: 12 });
  assert.equal(provisionalProjection[1].payload[1].$inc.revision, 1);
  assert.equal(provisionalProjection[0], null);
  assert.equal(provisionalProjection[2], null);
  const provisionalConflict = run("lk_result_submit_game_revision_ack_20260826", {
    ...provisionalProjection[1],
    payload: { acknowledged: true, matchedCount: 0, modifiedCount: 0 },
  });
  assert.equal(provisionalConflict[0], null);
  assert.equal(provisionalConflict[1], null);
  assert.equal(provisionalConflict[2].statusCode, 409);

  const confirmRoute = run("cb002a5dcea9ce51", {
    payload: { acknowledged: true, matchedCount: 1, modifiedCount: 1 },
    _resultConfirm: { game: { tenantKey: "tenant-1", id: "game-1", revision: 13 } },
    _resultConfirmBundle: {
      ratingsPayload: [{ update: { $set: { clientId: "actor-1" } } }],
      gamePayload: [{ id: "game-1" }, { $set: { resultStatus: "CONFIRMED" } }, { upsert: false }],
      response: { statusCode: 200, payload: { status: "CONFIRMED" } },
      eventPayload: [{ id: "event-1" }, { $set: { status: "FINAL" } }, { upsert: true }],
    },
  });
  assert.equal(confirmRoute[0], null);
  assert.ok(confirmRoute[1]._resultConfirmRevisionDeferred);
  assert.equal(confirmRoute[2], null);
  assert.equal(confirmRoute[4], null);
  const confirmWrite = run("eb7060667c2da065", confirmRoute[1]);
  const confirmConflict = run("lk_result_confirm_game_revision_ack_20260826", {
    ...confirmWrite,
    payload: { acknowledged: true, matchedCount: 0, modifiedCount: 0 },
  });
  assert.equal(confirmConflict[0], null);
  assert.equal(confirmConflict[1].statusCode, 409);
  assert.equal(confirmConflict.length, 3);

  const create = run("e656cff36a8cd210", {
    req: { path: "/lk/games", query: {} },
    payload: {
      tenantKey: "tenant-1",
      id: "game-create-1",
      expectedRevision: 4,
      organizer: { id: "actor-1", name: "Actor" },
      booking: {},
      payment: {},
      settings: {},
      invite: {},
    },
  });
  assert.equal(create[0].query.tenantKey, "tenant-1");
  assert.equal(create[0].query.id, "game-create-1");
  assert.equal(create[0].query.revision, 4);
  assert.equal(create[0].payload.$inc.revision, 1);
  assert.equal(create[1], null);
  assert.equal(create[3], null);
  const createAck = run("lk_game_create_revision_ack_20260826", {
    payload: { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0 },
    _recordForResponse: { id: "game-create-1", revision: 5 },
  });
  assert.equal(createAck[0].statusCode, 409);
  assert.equal(createAck[0].payload.code, "LEGACY_GAME_VERSION_CONFLICT");
  assert.equal(createAck[2], null);
  const createSuccess = run("lk_game_create_revision_ack_20260826", {
    payload: { acknowledged: true, matchedCount: 1, modifiedCount: 1 },
    _recordForResponse: { id: "game-create-1", revision: 5 },
    _httpStatus: 200,
  });
  assert.equal(createSuccess[0].statusCode, 200);
  assert.equal(createSuccess[0].payload.revision, 5);
  assert.equal(createSuccess[2].payload.revision, 5);

  for (const nodeId of [
    "lk_game_patch_apply_cas_20260801",
    "bcc3dccf8d64f9bb",
    "lk_split_leave_game_update_build_20260801",
    "legacy_roster_bridge_build_20260816",
    "eb7060667c2da065",
    "result_submit_after_write_003",
  ]) {
    assert.match(result.flow.find((node) => node.id === nodeId).func, /tenantKey/);
  }

  const cleanupConflict = run("lk_split_cleanup_revision_ack_20260826", {
    payload: { acknowledged: true, matchedCount: 0, modifiedCount: 0 },
    _splitCleanupRevisionDeferred: {
      tenantKey: "tenant-1",
      gameId: "same-game-id",
      sourceRevision: 9,
      operationKey: "cleanup-op-1",
      summaryMsg: { payload: { ok: true, gameId: "same-game-id", cancelledInLk: true } },
    },
  });
  assert.equal(cleanupConflict[1], null);
  assert.equal(cleanupConflict[0]._legacyCleanupRecovery.intentId.startsWith("cleanup-revision:tenant-1:same-game-id:9:"), true);
  const cleanupRecovery = run("lk_split_cleanup_revision_recovery_ack_20260826", {
    ...cleanupConflict[0],
    _legacyCleanupRecoveryResult: { persisted: true },
  });
  assert.equal(cleanupRecovery.statusCode, 202);
  assert.equal(cleanupRecovery.payload.cancelledInLk, false);
  assert.equal(cleanupRecovery.payload.manualReviewRequired, true);

  const replayBundle = {
    ratingsPayload: [{ update: { $set: { clientId: "actor-1" } } }],
    response: { statusCode: 200, payload: { status: "CONFIRMED" } },
    gamePayload: [
      { id: "game-1" },
      { $set: { resultId: "result-1", resultLifecycleState: "CORRECTION_PENDING", resultStatus: "CORRECTION_PENDING" } },
      { upsert: false },
    ],
    eventPayload: [{ id: "event-1" }, { $set: { status: "FINAL" } }, { upsert: true }],
    syncBatch: { tasks: [{ outboxId: "viva-1", player: { id: "actor-1" } }] },
  };
  const replayOutbox = {
    version: 2,
    stateRevision: 0,
    status: "PENDING",
    transitionAction: "DISPUTE",
    transitionStatus: "CORRECTION_PENDING",
    tenantKey: "tenant-1",
    resultId: "result-1",
    resultRevision: 2,
    gameId: "game-1",
    sourceGameRevision: 7,
    bundleId: "bundle-1",
    response: replayBundle.response,
    payloadJson: JSON.stringify(replayBundle),
    sinks: [
      { key: "rating:evt-1", kind: "RATING", retryPolicy: "FENCED", status: "PENDING", payloadIndex: 0 },
      { key: "event:evt-1", kind: "EVENT", retryPolicy: "FENCED", status: "PENDING", payloadIndex: 0 },
      { key: "provider:viva-1", kind: "PROVIDER", retryPolicy: "AT_MOST_ONCE", status: "PENDING", payloadIndex: 0, providerOutboxId: "viva-1", dependsOnSinkKey: "rating:evt-1" },
    ],
  };
  const replay = run("lk_result_confirm_replay_outbox_20260826", { _resultConfirmReplayOutbox: replayOutbox });
  assert.equal(replay[0].length, 1);
  assert.equal(replay[1].length, 1);
  assert.equal(replay[2].length, 1);
  assert.equal(replay[2][0]._legacyResultSideEffect.sinkKey, "provider:viva-1");
  assert.equal(replay[2][0]._legacyResultSideEffect.retryPolicy, "AT_MOST_ONCE");
  assert.equal(replay[3].statusCode, 202);

  const disputeReplayPrepare = run("66ced3f3c4046229", {
    _resultConfirm: {
      action: "DISPUTE",
      tenantKey: "tenant-1",
      game: {
        tenantKey: "tenant-1",
        id: "game-1",
        resultId: "result-1",
        resultLifecycleState: "CORRECTION_PENDING",
        settings: { ratingGame: false },
      },
    },
    payload: [{
      id: "result-1",
      tenantKey: "tenant-1",
      revision: 2,
      status: "CORRECTION_PENDING",
      lifecycleState: "CORRECTION_PENDING",
      ratingEnabled: false,
      legacyGameProjectionOutbox: replayOutbox,
    }],
  });
  assert.equal(disputeReplayPrepare[0]._resultPending.replayDurableOutbox, true);
  const disputeReplayApply = run("c67e08684d1e4fe9", disputeReplayPrepare[0]);
  assert.equal(disputeReplayApply[6]._resultConfirmReplayOutbox.bundleId, "bundle-1");

  const crashReplayPrepare = run("66ced3f3c4046229", {
    _resultConfirm: {
      action: "DISPUTE",
      tenantKey: "tenant-1",
      game: {
        tenantKey: "tenant-1",
        id: "game-1",
        revision: 7,
        resultId: "result-1",
        resultLifecycleState: "PENDING_REVIEW",
        settings: { ratingGame: false },
      },
    },
    payload: [{
      id: "result-1",
      tenantKey: "tenant-1",
      revision: 2,
      status: "CORRECTION_PENDING",
      lifecycleState: "CORRECTION_PENDING",
      ratingEnabled: false,
      legacyGameProjectionOutbox: replayOutbox,
    }],
  });
  const crashReplayApply = run("c67e08684d1e4fe9", crashReplayPrepare[0]);
  assert.equal(crashReplayApply[6], null);
  assert.equal(crashReplayApply[7]._resultConfirmRecovery.bundleId, "bundle-1");
  assert.equal(crashReplayApply[7]._resultConfirmRecovery.sourceGameRevision, 7);
  const recoveryGameWrite = run("eb7060667c2da065", crashReplayApply[7]);
  assert.deepEqual(recoveryGameWrite.payload[0], { id: "game-1", tenantKey: "tenant-1", revision: 7 });
  assert.equal(recoveryGameWrite.payload[1].$inc.revision, 1);
  const recoveryAccepted = run("lk_result_confirm_game_revision_ack_20260826", {
    ...recoveryGameWrite,
    payload: { acknowledged: true, matchedCount: 1, modifiedCount: 1 },
  });
  assert.equal(recoveryAccepted[1].statusCode, 202);
  assert.equal(recoveryAccepted[0]._resultConfirmOutbox.bundleId, "bundle-1");

  const driftReplayPrepare = run("66ced3f3c4046229", {
    _resultConfirm: {
      action: "DISPUTE",
      tenantKey: "tenant-1",
      game: {
        tenantKey: "tenant-1",
        id: "game-1",
        revision: 8,
        resultId: "result-1",
        resultLifecycleState: "PENDING_REVIEW",
        settings: { ratingGame: false },
      },
    },
    payload: [{
      id: "result-1",
      tenantKey: "tenant-1",
      revision: 2,
      status: "CORRECTION_PENDING",
      lifecycleState: "CORRECTION_PENDING",
      ratingEnabled: false,
      legacyGameProjectionOutbox: replayOutbox,
    }],
  });
  const driftReplayApply = run("c67e08684d1e4fe9", driftReplayPrepare[0]);
  assert.equal(driftReplayApply[7], null);
  assert.equal(driftReplayApply[4].statusCode, 503);
  assert.equal(driftReplayApply[4].payload.code, "LEGACY_GAME_PROJECTION_INCOMPLETE");
  assert.equal(driftReplayApply[4].payload.recoveryRequired, true);

  const expiredReplayOutbox = {
    ...replayOutbox,
    transitionAction: "EXPIRE_CRON",
    transitionStatus: "NO_RESULT_EXPIRED",
  };
  const expiredReplayPrepare = run("66ced3f3c4046229", {
    _resultConfirm: {
      action: "EXPIRE",
      tenantKey: "tenant-1",
      game: {
        tenantKey: "tenant-1",
        id: "game-1",
        resultId: "result-1",
        resultLifecycleState: "NO_RESULT_EXPIRED",
        settings: { ratingGame: false },
      },
    },
    payload: [{
      id: "result-1",
      tenantKey: "tenant-1",
      revision: 2,
      status: "NO_RESULT_EXPIRED",
      lifecycleState: "NO_RESULT_EXPIRED",
      ratingEnabled: false,
      legacyGameProjectionOutbox: expiredReplayOutbox,
    }],
  });
  assert.equal(expiredReplayPrepare[0]._resultPending.replayDurableOutbox, true);
  const expiredReplayApply = run("c67e08684d1e4fe9", expiredReplayPrepare[0]);
  assert.equal(expiredReplayApply[6]._resultConfirmReplayOutbox.transitionAction, "EXPIRE_CRON");

  const firstProviderUpsertAck = run("lk_result_side_effect_viva_outbox_ack_20260826", {
    payload: { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 1, upsertedId: "result_viva_sync:tenant-1:viva-1" },
    _resultVivaSyncOriginalTask: {
      outboxId: "result_viva_sync:tenant-1:viva-1",
      tenantKey: "tenant-1",
      resultId: "result-1",
      resultRevision: 2,
    },
  });
  assert.deepEqual(firstProviderUpsertAck[0]._resultVivaOutboxIdentityRead, {
    outboxId: "result_viva_sync:tenant-1:viva-1",
    tenantKey: "tenant-1",
    resultId: "result-1",
    resultRevision: 2,
  });
  assert.equal(firstProviderUpsertAck[1], null);

  const transitionBlocked = run("66ced3f3c4046229", {
    _resultConfirm: {
      action: "ACCEPT_CORRECTION",
      tenantKey: "tenant-1",
      game: { tenantKey: "tenant-1", id: "game-1", settings: { ratingGame: false } },
      actor: { id: "actor-1" },
      actorMember: { id: "actor-1" },
    },
    payload: [{
      id: "result-1",
      tenantKey: "tenant-1",
      status: "CORRECTION_PENDING",
      submittedBy: { id: "actor-1" },
      legacyGameProjectionOutbox: {
        version: 2,
        bundleId: "prior-bundle",
        status: "PROCESSING",
        sinks: [{ status: "PROCESSING" }],
      },
    }],
  });
  assert.equal(transitionBlocked[0], null);
  assert.equal(transitionBlocked[1].statusCode, 409);
  assert.equal(transitionBlocked[1].payload.code, "RESULT_SIDE_EFFECTS_NOT_TERMINAL");

  const deliveredOutbox = {
    ...replayOutbox,
    status: "DELIVERED",
    sinks: replayOutbox.sinks.map((sink) => ({ ...sink, status: "DELIVERED", attempts: 1 })),
  };
  const accepted = run("lk_result_confirm_game_revision_ack_20260826", {
    payload: { acknowledged: true, matchedCount: 1, modifiedCount: 1 },
    _resultConfirmRevisionDeferred: {
      outbox: deliveredOutbox,
      responseMsg: { statusCode: 200, payload: { status: "CONFIRMED" } },
    },
  });
  assert.equal(accepted[1].statusCode, 202);
  assert.equal(accepted[1].payload.code, "RESULT_SIDE_EFFECTS_ACCEPTED");
  const initialDeliveredDispatch = run("lk_result_confirm_replay_outbox_20260826", accepted[0]);
  assert.equal(initialDeliveredDispatch[3], null);
  const replayDeliveredDispatch = run("lk_result_confirm_replay_outbox_20260826", {
    _resultConfirmReplayOutbox: deliveredOutbox,
  });
  assert.equal(replayDeliveredDispatch[3].statusCode, 200);
  const recoveryOutbox = {
    ...replayOutbox,
    status: "RECOVERY_REQUIRED",
    sinks: replayOutbox.sinks.map((sink, index) => index === 0 ? { ...sink, status: "UNKNOWN" } : sink),
  };
  const initialRecoveryDispatch = run("lk_result_confirm_replay_outbox_20260826", {
    _resultConfirmOutbox: recoveryOutbox,
  });
  assert.equal(initialRecoveryDispatch[3], null);
  const replayRecoveryDispatch = run("lk_result_confirm_replay_outbox_20260826", {
    _resultConfirmReplayOutbox: recoveryOutbox,
  });
  assert.equal(replayRecoveryDispatch[3].statusCode, 202);
  assert.equal(replayRecoveryDispatch[3].payload.code, "RESULT_SIDE_EFFECT_RECOVERY_REQUIRED");
  for (let retry = 0; retry < 2; retry += 1) {
    const terminal = run("lk_result_confirm_replay_outbox_20260826", { _resultConfirmReplayOutbox: deliveredOutbox });
    assert.equal(terminal[0], null);
    assert.equal(terminal[1], null);
    assert.equal(terminal[2], null);
    assert.equal(terminal[3].statusCode, 200);
    assert.deepEqual(deliveredOutbox.sinks.map((sink) => sink.attempts), [1, 1, 1]);
  }
});

test("new prerequisite sources contain no credential value or Mongo URI", () => {
  const sourceFiles = [
    "node-red/custom-nodes/legacy-game-command-transaction/legacy-game-command-core.mjs",
    "node-red/custom-nodes/legacy-game-command-transaction/legacy-game-command-node.cjs",
    "scripts/migrate_legacy_game_command_prerequisites.mjs",
    "scripts/run_legacy_game_command_production_migration.mjs",
    "scripts/patch_live_games_command_prerequisites.mjs",
    "scripts/nodered_legacy_command_prerequisite_nodes/fn_patch_revision_guard.js",
    "scripts/nodered_legacy_command_prerequisite_nodes/fn_patch_revision_query.js",
  ];
  const sources = sourceFiles.map((file) => fs.readFileSync(file, "utf8")).join("\n");
  assert.doesNotMatch(sources, /mongodb(?:\+srv)?:\/\/[^'"\s]+/i);
  assert.doesNotMatch(sources, /Bearer\s+[A-Za-z0-9._~-]{16,}/i);
  assert.doesNotMatch(sources, /(?:password|secret|token)\s*[:=]\s*["'][^"']{8,}["']/i);
  const operationNodeSource = fs.readFileSync(
    "node-red/custom-nodes/legacy-game-command-transaction/legacy-game-command-node.cjs",
    "utf8",
  );
  assert.doesNotMatch(operationNodeSource, /message:\s*error\?\.message/);
  assert.match(operationNodeSource, /Legacy command operation failed/);
});

test("custom Node-RED config node has no input port and fails closed without server-only URI", async () => {
  const registered = new Map();
  const closeHandlers = [];
  const RED = {
    nodes: {
      createNode(node) {
        node.on = (event, handler) => {
          if (event === "close") closeHandlers.push(handler);
        };
      },
      registerType(name, constructor) {
        registered.set(name, constructor);
      },
    },
  };
  const register = (await import("../../node-red/custom-nodes/legacy-game-command-transaction/legacy-game-command-node.cjs")).default;
  register(RED);
  const Constructor = registered.get("padlhub-legacy-game-command-store");
  assert.equal(typeof Constructor, "function");
  assert.equal(typeof registered.get("padlhub-legacy-game-command-operation"), "function");
  const envName = `MISSING_LEGACY_COMMAND_URI_${Date.now()}`;
  const node = {};
  Constructor.call(node, { mongoUriEnv: envName, databaseName: "lk_command_test" });
  await assert.rejects(() => node.getService(), new RegExp(envName));
  assert.equal(typeof node.executeLegacyGameCommandTransaction, "function");
  assert.equal(closeHandlers.length, 1);
});

test("custom operation node never exposes raw driver errors", async () => {
  const registered = new Map();
  let inputHandler = null;
  const RED = {
    nodes: {
      createNode(node) {
        node.on = (event, handler) => {
          if (event === "input") inputHandler = handler;
        };
      },
      getNode() {
        return {
          async readProviderOutboxIdentity() {
            throw new Error("MongoServerError RAW_DRIVER_SECRET_SHOULD_NOT_ESCAPE");
          },
        };
      },
      registerType(name, constructor) {
        registered.set(name, constructor);
      },
    },
  };
  const register = (await import("../../node-red/custom-nodes/legacy-game-command-transaction/legacy-game-command-node.cjs")).default;
  register(RED);
  const Operation = registered.get("padlhub-legacy-game-command-operation");
  const node = {};
  Operation.call(node, { store: "store-1", action: "read-provider-outbox-identity" });
  assert.equal(typeof inputHandler, "function");
  let emitted = null;
  await new Promise((resolve) => inputHandler({
    _resultVivaOutboxIdentityRead: {
      outboxId: "outbox-1",
      tenantKey: "tenant-1",
      resultId: "result-1",
      resultRevision: 1,
    },
  }, (outputs) => { emitted = outputs; }, resolve));
  assert.equal(emitted[0], null);
  assert.equal(emitted[1]._legacyCommandOperationError.code, "LEGACY_COMMAND_OPERATION_FAILED");
  assert.equal(emitted[1]._legacyCommandOperationError.message, "Legacy command operation failed");
  assert.doesNotMatch(JSON.stringify(emitted), /mongodb|raw_driver_secret_should_not_escape/i);
  assert.deepEqual(emitted[1]._legacyResultSideEffectOutcome, {
    status: "UNKNOWN",
    error: "Provider outbox identity was not durably verified",
  });
});
