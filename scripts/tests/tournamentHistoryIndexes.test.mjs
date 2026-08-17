import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  TOURNAMENT_HISTORY_INDEX_CONFIRM,
  TOURNAMENT_HISTORY_INDEX_SPECS,
  TOURNAMENT_HISTORY_LOOKUP_FIELDS,
  TOURNAMENT_HISTORY_TEST_MODE_CONFIRM,
  buildIndexPlanDigest,
  buildTournamentHistoryPublicationQuery,
  classifyManagedIndexes,
  cleanupNewTournamentHistoryIndexes,
  stableStringify,
  summarizeExplain,
} from "../manage_tournament_history_indexes.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationScript = path.resolve(testDirectory, "../manage_tournament_history_indexes.mjs");

const materializeIndexes = () => TOURNAMENT_HISTORY_INDEX_SPECS.map((spec) => ({
  name: spec.options.name,
  key: spec.key,
  partialFilterExpression: spec.options.partialFilterExpression,
}));

test("migration defines one narrow partial index for every publication lookup branch", () => {
  assert.equal(TOURNAMENT_HISTORY_INDEX_SPECS.length, 5);
  assert.equal(new Set(TOURNAMENT_HISTORY_INDEX_SPECS.map((spec) => spec.options.name)).size, 5);

  for (const { field, indexName } of TOURNAMENT_HISTORY_LOOKUP_FIELDS) {
    const spec = TOURNAMENT_HISTORY_INDEX_SPECS.find((item) => item.options.name === indexName);
    assert.ok(spec);
    assert.deepEqual(spec.key, { [field]: 1, archived: 1 });
    assert.deepEqual(spec.options.partialFilterExpression, {
      kind: "TOURNAMENT",
    });
    assert.equal(spec.options.unique, undefined);
  }
});

test("publication query preserves all five live Node-RED lookup branches", () => {
  const query = buildTournamentHistoryPublicationQuery("tournament-1");
  assert.deepEqual(query, {
    archived: { $ne: true },
    kind: "TOURNAMENT",
    $or: TOURNAMENT_HISTORY_LOOKUP_FIELDS.map(({ field }) => ({ [field]: "tournament-1" })),
  });
  assert.throws(() => buildTournamentHistoryPublicationQuery(""), /probe id is absent/);
});

test("catalog classifier is idempotent and fails closed on name or equivalent conflicts", () => {
  assert.deepEqual(classifyManagedIndexes([{ name: "_id_", key: { _id: 1 } }]), {
    matching: [],
    missing: TOURNAMENT_HISTORY_INDEX_SPECS.map((spec) => spec.options.name),
    conflicts: [],
  });

  assert.deepEqual(classifyManagedIndexes(materializeIndexes()), {
    matching: TOURNAMENT_HISTORY_INDEX_SPECS.map((spec) => spec.options.name),
    missing: [],
    conflicts: [],
  });

  const wrongName = materializeIndexes();
  wrongName[0] = { ...wrongName[0], key: { wrong: 1 } };
  assert.deepEqual(classifyManagedIndexes(wrongName).conflicts, [{
    code: "INDEX_NAME_CONFLICT",
    indexName: TOURNAMENT_HISTORY_INDEX_SPECS[0].options.name,
  }]);

  const equivalentDifferentName = materializeIndexes();
  equivalentDifferentName[0] = { ...equivalentDifferentName[0], name: "foreign-equivalent-name" };
  assert.deepEqual(classifyManagedIndexes(equivalentDifferentName).conflicts, [{
    code: "EQUIVALENT_INDEX_DIFFERENT_NAME",
    indexName: TOURNAMENT_HISTORY_INDEX_SPECS[0].options.name,
    existingIndexName: "foreign-equivalent-name",
  }]);

  const hiddenManagedIndex = materializeIndexes();
  hiddenManagedIndex[0] = { ...hiddenManagedIndex[0], hidden: true };
  assert.deepEqual(classifyManagedIndexes(hiddenManagedIndex).conflicts, [{
    code: "INDEX_NAME_CONFLICT",
    indexName: TOURNAMENT_HISTORY_INDEX_SPECS[0].options.name,
  }]);
});

test("plan digest is stable but changes with server or index catalog drift", () => {
  const indexes = [{ name: "_id_", key: { _id: 1 } }];
  const first = buildIndexPlanDigest({ serverMajor: 8, existingIndexes: indexes });
  const reordered = buildIndexPlanDigest({ serverMajor: 8, existingIndexes: [{ key: { _id: 1 }, name: "_id_" }] });
  const changedServer = buildIndexPlanDigest({ serverMajor: 7, existingIndexes: indexes });
  const changedPatch = buildIndexPlanDigest({
    serverVersion: "8.0.18",
    serverMajor: 8,
    existingIndexes: indexes,
  });
  const changedCatalog = buildIndexPlanDigest({ serverMajor: 8, existingIndexes: materializeIndexes() });

  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(first, reordered);
  assert.notEqual(first, changedServer);
  assert.notEqual(first, changedPatch);
  assert.notEqual(first, changedCatalog);
  assert.equal(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }));
});

test("explain summary exposes stages and index names without query data", () => {
  const summary = summarizeExplain({
    queryPlanner: {
      winningPlan: {
        stage: "FETCH",
        inputStage: {
          stage: "OR",
          inputStages: [
            { stage: "IXSCAN", indexName: "index-a" },
            { stage: "IXSCAN", indexName: "index-b" },
          ],
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
    indexes: ["index-a", "index-b"],
    nReturned: 1,
    totalKeysExamined: 2,
    totalDocsExamined: 1,
    executionTimeMillis: 3,
    rejectedPlans: 1,
  });
  assert.equal(TOURNAMENT_HISTORY_INDEX_CONFIRM, "CONFIRM_LK_COMMUNITY_FEED");
});

test("apply fails closed before connecting when explicit confirmation is absent", () => {
  const result = spawnSync(process.execPath, [
    migrationScript,
    "apply",
    "--expected-plan-digest",
    "a".repeat(64),
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      MONGO_URI: "",
      TOURNAMENT_HISTORY_INDEX_APPLY: "",
    },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Apply confirmation is absent/);
  assert.doesNotMatch(result.stderr, /Provide a protected --flow-path or MONGO_URI/);
});

test("CLI loads with the CommonJS export shape used by the production MongoDB driver", () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "th-index-cjs-driver-"));
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

    const result = spawnSync(process.execPath, [temporaryScript, "--help"], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /Named export 'MongoClient' not found/);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("apply rejects an environment URI even in explicit isolated test mode", () => {
  const result = spawnSync(process.execPath, [
    migrationScript,
    "apply",
    "--expected-plan-digest",
    "a".repeat(64),
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      MONGO_URI: "mongodb://127.0.0.1:1",
      TOURNAMENT_HISTORY_INDEX_APPLY: TOURNAMENT_HISTORY_INDEX_CONFIRM,
      TOURNAMENT_HISTORY_INDEX_TEST_MODE: TOURNAMENT_HISTORY_TEST_MODE_CONFIRM,
    },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Apply requires a protected --flow-path/);
  assert.doesNotMatch(result.stderr, /ECONNREFUSED|MongoServerSelectionError/);
});

test("cleanup removes only exact managed indexes that were absent before apply", async () => {
  const exact = materializeIndexes()[0];
  const conflicting = {
    ...materializeIndexes()[1],
    key: { wrong: 1 },
  };
  const dropped = [];
  const collection = {
    listIndexes: () => ({ toArray: async () => [exact, conflicting] }),
    dropIndex: async (indexName) => { dropped.push(indexName); },
  };

  const result = await cleanupNewTournamentHistoryIndexes(collection, [
    exact.name,
    conflicting.name,
  ]);

  assert.deepEqual(result, { dropped: [exact.name], failures: [] });
  assert.deepEqual(dropped, [exact.name]);
});
