import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { MongoClient } from "mongodb";

import {
  TOURNAMENT_HISTORY_COLLECTION,
  TOURNAMENT_HISTORY_INDEX_SPECS,
  applyTournamentHistoryIndexes,
  classifyManagedIndexes,
  explainTournamentHistoryQuery,
} from "../manage_tournament_history_indexes.mjs";

const mongoUri = String(process.env.TOURNAMENT_HISTORY_INDEX_TEST_MONGO_URI || "").trim();

test("real Mongo uses all managed indexes for the five-branch history query", {
  skip: mongoUri ? false : "Set TOURNAMENT_HISTORY_INDEX_TEST_MONGO_URI",
  timeout: 120_000,
}, async () => {
  const client = new MongoClient(mongoUri, {
    appName: "PadlHubTournamentHistoryIndexTest",
    maxPoolSize: 2,
    serverSelectionTimeoutMS: 10_000,
  });
  const databaseName = `test_th_idx_${crypto.randomUUID().replaceAll("-", "")}`;
  const probeId = "probe-tournament";

  try {
    await client.connect();
    const db = client.db(databaseName);
    const collection = db.collection(TOURNAMENT_HISTORY_COLLECTION);
    const bulk = [];
    for (let index = 0; index < 5_000; index += 1) {
      bulk.push({ kind: "COMMUNITY_POST", archived: false, sequence: index });
    }
    for (let index = 0; index < 1_000; index += 1) {
      bulk.push({
        kind: "TOURNAMENT",
        archived: false,
        details: { publicTournament: { exerciseId: `exercise-${index}` } },
      });
    }
    bulk.push(
      { kind: "TOURNAMENT", archived: false, relatedTournamentId: probeId },
      { kind: "TOURNAMENT", archived: false, tournamentId: probeId },
      { kind: "TOURNAMENT", archived: false, details: { relatedTournamentId: probeId } },
      { kind: "TOURNAMENT", archived: false, details: { publicTournament: { exerciseId: probeId } } },
      { kind: "TOURNAMENT", archived: false, details: { publicTournament: { tournamentId: probeId } } },
      { kind: "TOURNAMENT", archived: true, details: { publicTournament: { exerciseId: probeId } } },
      { kind: "TOURNAMENT", archived: false, details: { publicTournament: { exerciseId: 12345 } } },
    );
    await collection.insertMany(bulk, { ordered: true });

    const before = await explainTournamentHistoryQuery(collection, probeId);
    assert.ok(before.stages.includes("COLLSCAN"));
    assert.equal(before.indexes.length, 0);
    assert.equal(before.nReturned, 5);

    const created = await applyTournamentHistoryIndexes(collection);
    assert.deepEqual(created, TOURNAMENT_HISTORY_INDEX_SPECS.map((spec) => spec.options.name));
    const existing = await collection.listIndexes().toArray();
    assert.deepEqual(classifyManagedIndexes(existing), {
      matching: TOURNAMENT_HISTORY_INDEX_SPECS.map((spec) => spec.options.name),
      missing: [],
      conflicts: [],
    });

    const after = await explainTournamentHistoryQuery(collection, probeId);
    assert.equal(after.stages.includes("COLLSCAN"), false);
    assert.ok(after.stages.includes("IXSCAN"));
    assert.equal(after.nReturned, 5);
    assert.deepEqual(after.indexes, TOURNAMENT_HISTORY_INDEX_SPECS.map((spec) => spec.options.name).sort());
    assert.ok(after.totalDocsExamined <= 6);

    assert.deepEqual(await applyTournamentHistoryIndexes(collection, []), []);
    assert.equal(await collection.countDocuments({
      kind: "TOURNAMENT",
      archived: true,
      "details.publicTournament.exerciseId": probeId,
    }), 1);
  } finally {
    try { await client.db(databaseName).dropDatabase(); } catch { /* best-effort isolated cleanup */ }
    await client.close();
  }
});
