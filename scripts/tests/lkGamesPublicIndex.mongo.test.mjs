import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { MongoClient } from "mongodb";

import {
  INDEX_KEY,
  INDEX_NAME,
  classifyIndex,
  publicDateStationQuery,
} from "../manage_lk_games_public_index.mjs";
import { summarizeExplain } from "../manage_lk_games_lookup_index.mjs";

const mongoUri = String(process.env.LK_GAMES_PUBLIC_INDEX_TEST_MONGO_URI || "").trim();
const isolatedConfirmed = process.env.LK_GAMES_PUBLIC_INDEX_TEST_ISOLATED === "YES";
const loopbackOnly = mongoUri && ["127.0.0.1", "localhost"].includes(new URL(mongoUri).hostname);

test("real Mongo date/station index avoids scanning 19,007 games", {
  skip: isolatedConfirmed && loopbackOnly
    ? false
    : "Set LK_GAMES_PUBLIC_INDEX_TEST_MONGO_URI to isolated loopback MongoDB and LK_GAMES_PUBLIC_INDEX_TEST_ISOLATED=YES",
  timeout: 120_000,
}, async (t) => {
  const client = new MongoClient(mongoUri, {
    appName: "PadlHubLkGamesPublicIndexTest",
    maxPoolSize: 2,
    serverSelectionTimeoutMS: 10_000,
  });
  const databaseName = `test_lk_games_public_${crypto.randomUUID().replaceAll("-", "")}`;
  try {
    await client.connect();
    const db = client.db(databaseName);
    const games = db.collection("lk_games");
    const future = Date.parse("2026-10-01T12:00:00Z");
    const targetDate = "2026-10-02";
    const targetStation = "target-station";
    for (let start = 0; start < 19_001; start += 1_000) {
      const count = Math.min(1_000, 19_001 - start);
      await games.insertMany(Array.from({ length: count }, (_, offset) => ({
        _id: `noise-${start + offset}`,
        archived: false,
        booking: { date: targetDate, studioId: `other-${(start + offset) % 8}`, endTs: future + 86_400_000 },
        settings: { isPrivate: false },
      })));
    }
    await games.insertMany(Array.from({ length: 6 }, (_, index) => ({
      _id: `target-${index}`,
      archived: false,
      booking: { date: targetDate, studioId: targetStation, endTs: future + 86_400_000 },
      settings: { isPrivate: false },
    })));
    const query = publicDateStationQuery(targetDate, targetStation, future);
    const before = summarizeExplain(await games.find(query).explain("executionStats"));
    assert.equal(before.nReturned, 6);
    assert.ok(before.stages.includes("COLLSCAN"));
    assert.equal(before.totalDocsExamined, 19_007);

    await games.createIndex(INDEX_KEY, { name: INDEX_NAME });
    assert.equal(classifyIndex(await games.listIndexes().toArray()), "matching");
    const after = summarizeExplain(await games.find(query).explain("executionStats"));
    assert.equal(after.nReturned, 6);
    assert.equal(after.stages.includes("COLLSCAN"), false);
    assert.ok(after.stages.includes("IXSCAN"));
    assert.ok(after.indexes.includes(INDEX_NAME));
    assert.ok(after.totalDocsExamined <= 6);
    assert.ok(after.totalKeysExamined <= 6);
    t.diagnostic(JSON.stringify({
      before: { docsExamined: before.totalDocsExamined, millis: before.executionTimeMillis },
      after: {
        docsExamined: after.totalDocsExamined,
        keysExamined: after.totalKeysExamined,
        millis: after.executionTimeMillis,
      },
    }));
  } finally {
    try { await client.db(databaseName).dropDatabase(); } finally { await client.close(); }
  }
});
