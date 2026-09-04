import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { MongoClient } from "mongodb";

import {
  LK_GAMES_BOOKING_LOOKUP_FIELDS,
  LK_GAMES_LOOKUP_COLLECTION,
  LK_GAMES_LOOKUP_INDEX_NAME,
  LK_GAMES_PAYMENT_LOOKUP_FIELDS,
  applyLookupIndex,
  buildBookingLookupQuery,
  buildCombinedLookupQuery,
  buildPaymentLookupQuery,
  classifyManagedIndex,
  cleanupNewLookupIndex,
  explainLookupQuery,
} from "../manage_lk_games_lookup_index.mjs";

const mongoUri = String(process.env.LK_GAMES_LOOKUP_INDEX_TEST_MONGO_URI || "").trim();

const documentForPath = (id, path, value, archived = false) => {
  const doc = { _id: id, archived };
  const parts = path.split(".");
  let current = doc;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    const last = index === parts.length - 1;
    const nextPart = parts[index + 1];
    if (last) {
      current[part] = path.endsWith("bookingIds") ? [value] : value;
    } else if (part === "payments") {
      current[part] = [{}];
      current = current[part][0];
    } else {
      current[part] ||= nextPart === "payments" ? {} : {};
      current = current[part];
    }
  }
  return doc;
};

test("real Mongo uses one projected wildcard index for all 15 lookup branches", {
  skip: mongoUri ? false : "Set LK_GAMES_LOOKUP_INDEX_TEST_MONGO_URI",
  timeout: 120_000,
}, async () => {
  const client = new MongoClient(mongoUri, {
    appName: "PadlHubLkGamesLookupIndexTest",
    maxPoolSize: 2,
    serverSelectionTimeoutMS: 10_000,
  });
  const databaseName = `test_lk_games_lookup_${crypto.randomUUID().replaceAll("-", "")}`;
  const paymentProbe = "payment-probe";
  const bookingProbe = "booking-probe";

  try {
    await client.connect();
    const db = client.db(databaseName);
    const collection = db.collection(LK_GAMES_LOOKUP_COLLECTION);
    const noise = Array.from({ length: 5_000 }, (_, index) => ({
      _id: `noise-${index}`,
      archived: false,
      booking: { date: "2026-09-04" },
    }));
    const paymentDocs = LK_GAMES_PAYMENT_LOOKUP_FIELDS.map((field, index) => (
      documentForPath(`payment-${index}`, field, paymentProbe)
    ));
    const bookingDocs = LK_GAMES_BOOKING_LOOKUP_FIELDS.map((field, index) => (
      documentForPath(`booking-${index}`, field, bookingProbe)
    ));
    const archivedDocs = [
      documentForPath("payment-archived", LK_GAMES_PAYMENT_LOOKUP_FIELDS[0], paymentProbe, true),
      documentForPath("booking-archived", LK_GAMES_BOOKING_LOOKUP_FIELDS[0], bookingProbe, true),
    ];
    await collection.insertMany([...noise, ...paymentDocs, ...bookingDocs, ...archivedDocs], { ordered: true });

    const bookingIds = [bookingProbe, "booking-probe-secondary"];
    const beforePayment = await explainLookupQuery(collection, buildPaymentLookupQuery(paymentProbe));
    const beforeBooking = await explainLookupQuery(collection, buildBookingLookupQuery(bookingIds));
    const beforeCombined = await explainLookupQuery(
      collection,
      buildCombinedLookupQuery(paymentProbe, bookingIds),
    );
    assert.ok(beforePayment.stages.includes("COLLSCAN"));
    assert.ok(beforeBooking.stages.includes("COLLSCAN"));
    assert.ok(beforeCombined.stages.includes("COLLSCAN"));
    assert.equal(beforePayment.nReturned, LK_GAMES_PAYMENT_LOOKUP_FIELDS.length);
    assert.equal(beforeBooking.nReturned, LK_GAMES_BOOKING_LOOKUP_FIELDS.length);
    assert.equal(
      beforeCombined.nReturned,
      LK_GAMES_PAYMENT_LOOKUP_FIELDS.length + LK_GAMES_BOOKING_LOOKUP_FIELDS.length,
    );

    const createResult = await applyLookupIndex(db);
    assert.deepEqual(createResult, {
      indexName: LK_GAMES_LOOKUP_INDEX_NAME,
      created: true,
      numIndexesBefore: 1,
      numIndexesAfter: 2,
    });
    const indexes = await collection.listIndexes().toArray();
    assert.deepEqual(classifyManagedIndex(indexes), {
      matching: [LK_GAMES_LOOKUP_INDEX_NAME],
      missing: [],
      conflicts: [],
    });

    const afterPayment = await explainLookupQuery(collection, buildPaymentLookupQuery(paymentProbe));
    const afterBooking = await explainLookupQuery(collection, buildBookingLookupQuery(bookingIds));
    const afterCombined = await explainLookupQuery(
      collection,
      buildCombinedLookupQuery(paymentProbe, bookingIds),
    );
    for (const explain of [afterPayment, afterBooking, afterCombined]) {
      assert.equal(explain.stages.includes("COLLSCAN"), false);
      assert.ok(explain.stages.includes("IXSCAN"));
      assert.deepEqual(explain.indexes, [LK_GAMES_LOOKUP_INDEX_NAME]);
    }
    assert.equal(afterPayment.nReturned, LK_GAMES_PAYMENT_LOOKUP_FIELDS.length);
    assert.equal(afterBooking.nReturned, LK_GAMES_BOOKING_LOOKUP_FIELDS.length);
    assert.equal(
      afterCombined.nReturned,
      LK_GAMES_PAYMENT_LOOKUP_FIELDS.length + LK_GAMES_BOOKING_LOOKUP_FIELDS.length,
    );
    assert.ok(afterPayment.totalDocsExamined <= LK_GAMES_PAYMENT_LOOKUP_FIELDS.length + 1);
    assert.ok(afterBooking.totalDocsExamined <= LK_GAMES_BOOKING_LOOKUP_FIELDS.length + 1);
    assert.ok(
      afterCombined.totalDocsExamined
        <= LK_GAMES_PAYMENT_LOOKUP_FIELDS.length + LK_GAMES_BOOKING_LOOKUP_FIELDS.length + 2,
      `combined lookup examined ${afterCombined.totalDocsExamined} documents`,
    );

    assert.deepEqual(await cleanupNewLookupIndex(collection, true), {
      dropped: [LK_GAMES_LOOKUP_INDEX_NAME],
      failures: [],
    });
  } finally {
    try { await client.db(databaseName).dropDatabase(); } catch { /* best-effort isolated cleanup */ }
    await client.close();
  }
});
