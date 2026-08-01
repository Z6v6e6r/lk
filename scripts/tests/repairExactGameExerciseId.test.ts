import test from "node:test";
import assert from "node:assert/strict";
import {
  buildExactMongoFilter,
  buildMongoUpdate,
  parseArgs,
  precheckGame,
  runRepair,
} from "../repair_exact_game_exercise_id.mjs";

const ids = {
  gameId: "pay_c4ec264c-9820-41d7-a4da-d99c6fd2ffee",
  bookingId: "f2ad9c92-e536-4f69-ab20-2aeb4f1536f5",
  exerciseId: "dd201ee0-9193-4e8d-aac2-028ae54a10e2",
};

const game = (overrides: Record<string, unknown> = {}) => ({
  id: ids.gameId,
  status: "PAID",
  booking: {
    bookingIds: [ids.bookingId],
    studioId: "studio-1",
    roomId: "room-1",
    date: "2026-08-01",
    timeFrom: "14:00",
    timeTo: "15:30",
  },
  metadata: {
    paymentRef: "c4ec264c-9820-41d7-a4da-d99c6fd2ffee",
    bookingIds: [ids.bookingId],
    source: "games_widget",
  },
  ...overrides,
});

const response = (payload: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  async text() {
    return JSON.stringify(payload);
  },
});

test("all three exact identifiers are mandatory", () => {
  assert.throws(() => parseArgs([]), /--game-id is required/);
  assert.throws(() => parseArgs(["--game-id", ids.gameId]), /--booking-id is required/);
  assert.throws(() => parseArgs([
    "--game-id", ids.gameId,
    "--booking-id", ids.bookingId,
  ]), /--exercise-id is required/);
});

test("precheck rejects booking mismatch and a different existing exerciseId", () => {
  assert.throws(
    () => precheckGame(game(), { ...ids, bookingId: "11111111-1111-4111-8111-111111111111" }),
    /Booking mismatch/,
  );
  assert.throws(
    () => precheckGame(game({
      booking: {
        ...game().booking,
        bookingIds: [ids.bookingId, "33333333-3333-4333-8333-333333333333"],
      },
    }), ids),
    /Booking mismatch/,
  );
  assert.throws(
    () => precheckGame(game({
      booking: {
        ...game().booking,
        exerciseId: "22222222-2222-4222-8222-222222222222",
      },
    }), ids),
    /Exercise mismatch/,
  );
  assert.throws(
    () => precheckGame(game({ dedupeKey: "viva:22222222-2222-4222-8222-222222222222" }), ids),
    /Exercise mismatch/,
  );
});

test("Mongo update contains only the four exercise ID dotted fields", () => {
  assert.deepEqual(buildMongoUpdate(ids.exerciseId), {
    $set: {
      "booking.exerciseId": ids.exerciseId,
      "booking.vivaExerciseId": ids.exerciseId,
      "metadata.exerciseId": ids.exerciseId,
      "metadata.vivaExerciseId": ids.exerciseId,
    },
  });
});

test("dry-run performs one exact GET and never PATCHes", async () => {
  const calls: Array<{ url: string; method: string }> = [];
  const report = await runRepair({
    ...ids,
    baseUrl: "https://example.test/lk",
    tokenEnv: "TEST_TOKEN",
    apply: false,
  }, {
    env: { TEST_TOKEN: "secret-from-env" },
    fetchImpl: async (url: string, options: RequestInit) => {
      calls.push({ url, method: options.method || "GET" });
      assert.equal((options.headers as Record<string, string>).Authorization, "Bearer secret-from-env");
      return response(game());
    },
  });

  assert.equal(report.mode, "dry-run");
  assert.equal(report.applied, false);
  assert.deepEqual(calls, [{
    url: `https://example.test/lk/games/${ids.gameId}`,
    method: "GET",
  }]);
});

test("apply backs up and changes no snapshot or phone index fields", async () => {
  const rawGame = game({
    _id: "mongo-object-id",
    resultRosterSnapshot: { version: 3, activeRoster: [{ memberKey: "id:organizer-1" }] },
    participantPhones: ["79850000000"],
    allRelatedPhones: ["79850000000"],
    metadata: { ...game().metadata, playerPhoneIndex: ["79850000000"] },
  });
  const repaired = game({
    ...rawGame,
    booking: { ...game().booking, exerciseId: ids.exerciseId, vivaExerciseId: ids.exerciseId },
    metadata: { ...rawGame.metadata, exerciseId: ids.exerciseId, vivaExerciseId: ids.exerciseId },
  });
  const mongoReads = [rawGame, rawGame, repaired];
  const updates: Array<{ filter: Record<string, unknown>; update: Record<string, unknown> }> = [];
  let backup: Record<string, unknown> | null = null;
  let liveGetCount = 0;
  const collection = {
    async findOne() { return mongoReads.shift() || null; },
    async updateOne(filter: Record<string, unknown>, update: Record<string, unknown>) {
      updates.push({ filter, update });
      return { matchedCount: 1, modifiedCount: 1 };
    },
  };
  const report = await runRepair({
    ...ids,
    baseUrl: "https://example.test/lk",
    tokenEnv: "TEST_TOKEN",
    mongoUriEnv: "TEST_MONGO_URI",
    db: "games",
    collection: "lk_games",
    backupDir: "tmp/test-backups",
    apply: true,
  }, {
    env: { TEST_MONGO_URI: "mongodb://example.invalid/games" },
    fetchImpl: async (_url: string, options: RequestInit) => {
      assert.equal(options.method, "GET");
      liveGetCount += 1;
      return response(liveGetCount === 1 ? rawGame : repaired);
    },
    mongoClientFactory: () => ({
      async connect() {},
      db() { return { collection: () => collection }; },
      async close() {},
    }),
    backupWriter: (doc: Record<string, unknown>) => {
      backup = structuredClone(doc);
      return "/safe/backup.ejson";
    },
  });

  assert.equal(report.applied, true);
  assert.equal(report.backupPath, "/safe/backup.ejson");
  assert.deepEqual(backup, rawGame);
  assert.equal(liveGetCount, 2);
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].update, buildMongoUpdate(ids.exerciseId));
  assert.deepEqual(updates[0].filter, buildExactMongoFilter(rawGame));
  assert.deepEqual(repaired.resultRosterSnapshot, rawGame.resultRosterSnapshot);
  assert.deepEqual(repaired.participantPhones, rawGame.participantPhones);
  assert.deepEqual(repaired.allRelatedPhones, rawGame.allRelatedPhones);
  assert.deepEqual(repaired.metadata.playerPhoneIndex, rawGame.metadata.playerPhoneIndex);
});
