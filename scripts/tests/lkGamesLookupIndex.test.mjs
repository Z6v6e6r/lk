import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  LK_GAMES_BOOKING_LOOKUP_FIELDS,
  LK_GAMES_LOOKUP_APPLY_RECEIPT_KIND,
  LK_GAMES_LOOKUP_INDEX_CONFIRM,
  LK_GAMES_LOOKUP_INDEX_NAME,
  LK_GAMES_LOOKUP_INDEX_SPEC,
  LK_GAMES_LOOKUP_MONGODB_DRIVER_VERSION,
  LK_GAMES_LOOKUP_MONGO_NODE_ID,
  LK_GAMES_LOOKUP_QUERY_SHA256,
  LK_GAMES_LOOKUP_ROLLBACK_CONFIRM,
  LK_GAMES_LOOKUP_TEST_MODE_CONFIRM,
  LK_GAMES_PAYMENT_LOOKUP_FIELDS,
  buildBookingLookupQuery,
  buildApplyReceipt,
  buildCombinedLookupQuery,
  buildIndexPlanDigest,
  buildPaymentLookupQuery,
  classifyManagedIndex,
  cleanupNewLookupIndex,
  inspectFlowBinding,
  stableStringify,
  summarizeExplain,
  validateApplyReceipt,
} from "../manage_lk_games_lookup_index.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationScript = path.resolve(testDirectory, "../manage_lk_games_lookup_index.mjs");
const querySourcePath = path.resolve(testDirectory, "../nodered_games_nodes/fn_list_query.js");

const materializedIndex = (overrides = {}) => ({
  name: LK_GAMES_LOOKUP_INDEX_NAME,
  key: LK_GAMES_LOOKUP_INDEX_SPEC.key,
  wildcardProjection: LK_GAMES_LOOKUP_INDEX_SPEC.options.wildcardProjection,
  ...overrides,
});

const makeBoundFlow = (uri = "mongodb://127.0.0.1:27017/games") => {
  const querySource = fs.readFileSync(querySourcePath, "utf8");
  return [
    {
      id: "4e820638cc39c730",
      type: "mongodb4-client",
      uri,
      dbName: "games",
    },
    {
      id: "route",
      type: "http in",
      method: "get",
      url: "/lk/games",
      wires: [["query"]],
    },
    {
      id: "query",
      type: "function",
      func: querySource,
      wires: [[LK_GAMES_LOOKUP_MONGO_NODE_ID]],
    },
    {
      id: LK_GAMES_LOOKUP_MONGO_NODE_ID,
      type: "mongodb4",
      collection: "lk_games",
      operation: "find",
      output: "toArray",
      clientNode: "4e820638cc39c730",
      wires: [],
    },
  ];
};

test("candidate is one projected wildcard index covering every live lookup branch", () => {
  const projectedFields = Object.keys(LK_GAMES_LOOKUP_INDEX_SPEC.options.wildcardProjection).sort();
  const lookupFields = [...LK_GAMES_PAYMENT_LOOKUP_FIELDS, ...LK_GAMES_BOOKING_LOOKUP_FIELDS].sort();

  assert.deepEqual(LK_GAMES_LOOKUP_INDEX_SPEC.key, { "$**": 1 });
  assert.equal(LK_GAMES_LOOKUP_INDEX_SPEC.options.name, LK_GAMES_LOOKUP_INDEX_NAME);
  assert.equal(LK_GAMES_PAYMENT_LOOKUP_FIELDS.length, 4);
  assert.equal(LK_GAMES_BOOKING_LOOKUP_FIELDS.length, 11);
  assert.deepEqual(projectedFields, lookupFields);
  assert.equal(new Set(projectedFields).size, 15);
});

test("query builders preserve the production payment and booking OR contracts", () => {
  assert.deepEqual(buildPaymentLookupQuery("payment-1"), {
    archived: { $ne: true },
    $or: LK_GAMES_PAYMENT_LOOKUP_FIELDS.map((field) => ({ [field]: "payment-1" })),
  });
  assert.deepEqual(buildBookingLookupQuery("booking-1"), {
    archived: { $ne: true },
    $or: LK_GAMES_BOOKING_LOOKUP_FIELDS.map((field) => ({
      [field]: { $in: ["booking-1"] },
    })),
  });
  assert.deepEqual(buildBookingLookupQuery(["booking-1", "booking-2"]), {
    archived: { $ne: true },
    $or: LK_GAMES_BOOKING_LOOKUP_FIELDS.map((field) => ({
      [field]: { $in: ["booking-1", "booking-2"] },
    })),
  });
  assert.deepEqual(buildCombinedLookupQuery("payment-1", ["booking-1", "booking-2"]), {
    archived: { $ne: true },
    $or: [
      ...LK_GAMES_PAYMENT_LOOKUP_FIELDS.map((field) => ({ [field]: "payment-1" })),
      ...LK_GAMES_BOOKING_LOOKUP_FIELDS.map((field) => ({
        [field]: { $in: ["booking-1", "booking-2"] },
      })),
    ],
  });
  assert.throws(() => buildPaymentLookupQuery(""), /probe is absent/);
  assert.throws(() => buildBookingLookupQuery(""), /probe is absent/);
});

test("flow binding requires the exact active query implementation", () => {
  const flow = makeBoundFlow();

  const result = inspectFlowBinding(flow);
  assert.equal(result.dbName, "games");
  assert.equal(result.binding.routeId, "route");
  assert.equal(result.binding.queryFunctionId, "query");
  assert.equal(result.binding.queryFunctionSha256, LK_GAMES_LOOKUP_QUERY_SHA256);
  assert.equal(result.binding.mongoNodeId, LK_GAMES_LOOKUP_MONGO_NODE_ID);
  assert.equal(result.binding.mongoCollection, "lk_games");
  assert.match(result.connectionFingerprint, /^[a-f0-9]{64}$/);
  assert.notEqual(result.connectionFingerprint, flow[0].uri);
  assert.throws(
    () => inspectFlowBinding(flow.map((node) => node.id === "query" ? { ...node, func: `${node.func}\n// drift` } : node)),
    /SHA mismatch/,
  );
  for (const [field, value] of [
    ["id", "wrong-id"],
    ["collection", "other"],
    ["operation", "aggregate"],
    ["output", "single"],
    ["clientNode", "other-config"],
  ]) {
    assert.throws(
      () => inspectFlowBinding(flow.map((node) => (
        node.id === LK_GAMES_LOOKUP_MONGO_NODE_ID ? { ...node, [field]: value } : node
      ))),
      /Mongo find node binding mismatch|exactly one reachable games Mongo find node/,
    );
  }
});

test("catalog classifier is idempotent and fails closed on index conflicts", () => {
  assert.deepEqual(classifyManagedIndex([{ name: "_id_", key: { _id: 1 } }]), {
    matching: [],
    missing: [LK_GAMES_LOOKUP_INDEX_NAME],
    conflicts: [],
  });
  assert.deepEqual(classifyManagedIndex([materializedIndex()]), {
    matching: [LK_GAMES_LOOKUP_INDEX_NAME],
    missing: [],
    conflicts: [],
  });
  assert.deepEqual(classifyManagedIndex([materializedIndex({ key: { wrong: 1 } })]).conflicts, [{
    code: "INDEX_NAME_CONFLICT",
    indexName: LK_GAMES_LOOKUP_INDEX_NAME,
  }]);
  assert.deepEqual(classifyManagedIndex([materializedIndex({ name: "foreign-equivalent" })]).conflicts, [{
    code: "EQUIVALENT_INDEX_DIFFERENT_NAME",
    indexName: LK_GAMES_LOOKUP_INDEX_NAME,
    existingIndexName: "foreign-equivalent",
  }]);
  assert.deepEqual(classifyManagedIndex([materializedIndex({ hidden: true })]).conflicts, [{
    code: "INDEX_NAME_CONFLICT",
    indexName: LK_GAMES_LOOKUP_INDEX_NAME,
  }]);
});

test("plan digest binds server, route, target identity, and current index catalog", () => {
  const indexes = [{ name: "_id_", key: { _id: 1 } }];
  const queryBinding = {
    routeId: "route",
    queryFunctionSha256: LK_GAMES_LOOKUP_QUERY_SHA256,
    mongoNodeId: LK_GAMES_LOOKUP_MONGO_NODE_ID,
    mongoCollection: "lk_games",
  };
  const base = buildIndexPlanDigest({
    serverVersion: "8.0.17-6",
    serverMajor: 8,
    queryBinding,
    targetFingerprint: "1".repeat(64),
    existingIndexes: indexes,
  });
  const reordered = buildIndexPlanDigest({
    serverVersion: "8.0.17-6",
    serverMajor: 8,
    queryBinding: { ...queryBinding },
    targetFingerprint: "1".repeat(64),
    existingIndexes: [{ key: { _id: 1 }, name: "_id_" }],
  });
  const changedQuery = buildIndexPlanDigest({
    serverVersion: "8.0.17-6",
    serverMajor: 8,
    queryBinding: { ...queryBinding, queryFunctionSha256: "a".repeat(64) },
    targetFingerprint: "1".repeat(64),
    existingIndexes: indexes,
  });
  const changedTarget = buildIndexPlanDigest({
    serverVersion: "8.0.17-6",
    serverMajor: 8,
    queryBinding,
    targetFingerprint: "2".repeat(64),
    existingIndexes: indexes,
  });
  const changedCatalog = buildIndexPlanDigest({
    serverVersion: "8.0.17-6",
    serverMajor: 8,
    queryBinding,
    targetFingerprint: "1".repeat(64),
    existingIndexes: [...indexes, materializedIndex()],
  });

  assert.match(base, /^[a-f0-9]{64}$/);
  assert.equal(base, reordered);
  assert.notEqual(base, changedQuery);
  assert.notEqual(base, changedTarget);
  assert.notEqual(base, changedCatalog);
  assert.equal(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }));
});

test("explain summary contains plan evidence without lookup values", () => {
  const summary = summarizeExplain({
    queryPlanner: {
      winningPlan: {
        stage: "FETCH",
        inputStage: {
          stage: "OR",
          inputStages: [{ stage: "IXSCAN", indexName: LK_GAMES_LOOKUP_INDEX_NAME }],
        },
      },
      rejectedPlans: [{ stage: "COLLSCAN" }],
    },
    executionStats: {
      nReturned: 1,
      totalKeysExamined: 2,
      totalDocsExamined: 1,
      executionTimeMillis: 3,
    },
  });

  assert.deepEqual(summary, {
    stages: ["FETCH", "IXSCAN", "OR"],
    indexes: [LK_GAMES_LOOKUP_INDEX_NAME],
    nReturned: 1,
    totalKeysExamined: 2,
    totalDocsExamined: 1,
    executionTimeMillis: 3,
    rejectedPlans: 1,
  });
});

test("apply fails closed before connecting without confirmation and protected flow", () => {
  const missingConfirmation = spawnSync(process.execPath, [
    migrationScript,
    "apply",
    "--expected-plan-digest",
    "a".repeat(64),
  ], {
    encoding: "utf8",
    env: { ...process.env, MONGO_URI: "", LK_GAMES_LOOKUP_INDEX_APPLY: "" },
  });
  assert.equal(missingConfirmation.status, 1);
  assert.match(missingConfirmation.stderr, /Apply confirmation is absent/);

  const environmentUri = spawnSync(process.execPath, [
    migrationScript,
    "apply",
    "--expected-plan-digest",
    "a".repeat(64),
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      MONGO_URI: "mongodb://127.0.0.1:1",
      LK_GAMES_LOOKUP_INDEX_APPLY: LK_GAMES_LOOKUP_INDEX_CONFIRM,
      LK_GAMES_LOOKUP_INDEX_TEST_MODE: LK_GAMES_LOOKUP_TEST_MODE_CONFIRM,
    },
  });
  assert.equal(environmentUri.status, 1);
  assert.match(environmentUri.stderr, /Apply requires a protected --flow-path/);
  assert.doesNotMatch(environmentUri.stderr, /ECONNREFUSED|MongoServerSelectionError/);

  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "lk-games-index-gates-"));
  try {
    const flowPath = path.join(temporaryDirectory, "flows.json");
    fs.writeFileSync(flowPath, JSON.stringify(makeBoundFlow("mongodb://127.0.0.1:1/games")), {
      mode: 0o600,
    });
    const missingDurableReport = spawnSync(process.execPath, [
      migrationScript,
      "apply",
      "--flow-path",
      flowPath,
      "--expected-plan-digest",
      "a".repeat(64),
    ], {
      encoding: "utf8",
      env: { ...process.env, LK_GAMES_LOOKUP_INDEX_APPLY: LK_GAMES_LOOKUP_INDEX_CONFIRM },
    });
    assert.equal(missingDurableReport.status, 1);
    assert.match(missingDurableReport.stderr, /require --out for durable reconciliation evidence/);
    assert.doesNotMatch(missingDurableReport.stderr, /ECONNREFUSED|MongoServerSelectionError/);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }

  const rollback = spawnSync(process.execPath, [
    migrationScript,
    "rollback",
    "--expected-plan-digest",
    "a".repeat(64),
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      LK_GAMES_LOOKUP_INDEX_ROLLBACK: "",
    },
  });
  assert.equal(rollback.status, 1);
  assert.match(rollback.stderr, /Rollback confirmation is absent/);
  assert.equal(LK_GAMES_LOOKUP_ROLLBACK_CONFIRM, "ROLLBACK_LK_GAMES_LOOKUP_WILDCARD_V1");

  const missingReceipt = spawnSync(process.execPath, [
    migrationScript,
    "rollback",
    "--flow-path",
    "/unused",
    "--expected-plan-digest",
    "a".repeat(64),
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      LK_GAMES_LOOKUP_INDEX_ROLLBACK: LK_GAMES_LOOKUP_ROLLBACK_CONFIRM,
    },
  });
  assert.equal(missingReceipt.status, 1);
  assert.match(missingReceipt.stderr, /Rollback requires --apply-receipt/);
});

test("cleanup drops only the exact newly-created managed index", async () => {
  const dropped = [];
  const exactCollection = {
    listIndexes: () => ({ toArray: async () => [materializedIndex()] }),
    dropIndex: async (name) => { dropped.push(name); },
  };
  assert.deepEqual(await cleanupNewLookupIndex(exactCollection, true), {
    dropped: [LK_GAMES_LOOKUP_INDEX_NAME],
    failures: [],
  });
  assert.deepEqual(dropped, [LK_GAMES_LOOKUP_INDEX_NAME]);

  const conflictingCollection = {
    listIndexes: () => ({ toArray: async () => [materializedIndex({ key: { wrong: 1 } })] }),
    dropIndex: async () => { throw new Error("must not run"); },
  };
  assert.deepEqual(await cleanupNewLookupIndex(conflictingCollection, true), {
    dropped: [],
    failures: [],
  });
  assert.deepEqual(await cleanupNewLookupIndex(exactCollection, false), {
    dropped: [],
    failures: [],
  });
});

test("rollback receipt proves exact apply ownership and target/catalog continuity", () => {
  const before = {
    planDigest: "1".repeat(64),
    targetIdentity: { targetFingerprint: "a".repeat(64) },
  };
  const after = {
    planDigest: "2".repeat(64),
    targetIdentity: { targetFingerprint: "a".repeat(64) },
  };
  const applyReceipt = buildApplyReceipt({
    operationId: "operation-1",
    before,
    after,
    createdIndexes: [LK_GAMES_LOOKUP_INDEX_NAME],
  });
  const report = { mode: "APPLY", outcome: "SUCCEEDED", applyReceipt };

  assert.equal(applyReceipt.kind, LK_GAMES_LOOKUP_APPLY_RECEIPT_KIND);
  assert.equal(validateApplyReceipt(report, after).operationId, "operation-1");
  assert.throws(
    () => validateApplyReceipt({ ...report, applyReceipt: { ...applyReceipt, receiptDigest: "0".repeat(64) } }, after),
    /digest mismatch/,
  );
  assert.throws(
    () => validateApplyReceipt(report, { ...after, planDigest: "3".repeat(64) }),
    /target\/catalog no longer matches/,
  );
  const idempotentReceipt = buildApplyReceipt({
    operationId: "operation-2",
    before,
    after,
    createdIndexes: [],
  });
  assert.throws(
    () => validateApplyReceipt(
      { mode: "APPLY", outcome: "SUCCEEDED", applyReceipt: idempotentReceipt },
      after,
    ),
    /does not prove ownership/,
  );
});

test("CLI rejects the unsupported CommonJS server driver before connecting", () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "lk-games-index-cjs-"));
  const temporaryScript = path.join(temporaryDirectory, "migration.mjs");
  const packageDirectory = path.join(temporaryDirectory, "node_modules", "mongodb");
  try {
    fs.mkdirSync(packageDirectory, { recursive: true });
    fs.copyFileSync(migrationScript, temporaryScript);
    fs.writeFileSync(path.join(packageDirectory, "package.json"), JSON.stringify({
      name: "mongodb",
      version: "3.7.4-test-fixture",
      main: "index.js",
    }));
    fs.writeFileSync(
      path.join(packageDirectory, "index.js"),
      "module.exports = { MongoClient: class MongoClient {} };\n",
    );

    const scriptInput = fs.readFileSync(temporaryScript, "utf8");
    const help = spawnSync(process.execPath, ["--input-type=module", "-", "--help"], {
      cwd: temporaryDirectory,
      encoding: "utf8",
      input: scriptInput,
    });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, new RegExp(LK_GAMES_LOOKUP_MONGODB_DRIVER_VERSION.replaceAll(".", "\\.")));

    const result = spawnSync(process.execPath, ["--input-type=module", "-", "plan"], {
      cwd: temporaryDirectory,
      encoding: "utf8",
      input: scriptInput,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /MongoDB driver 7\.2\.0 is required; found 3\.7\.4-test-fixture/);
    assert.doesNotMatch(result.stderr, /ECONNREFUSED|MongoServerSelectionError/);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
