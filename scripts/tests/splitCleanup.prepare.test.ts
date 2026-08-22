import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

function runNodeRedFunction(file: string, msg: Record<string, unknown>) {
  const source = fs.readFileSync(file, "utf8");
  return new Function("msg", source)(msg);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asTaskList(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> => Boolean(asRecord(item)));
}

function buildSplitGame(overrides: Record<string, unknown> = {}) {
  return {
    id: "game-1",
    status: "ACTIVE",
    organizer: { id: "organizer-1", phone: "79990000001" },
    settings: { payMode: "split" },
    booking: {
      date: "2026-06-02",
      timeFrom: "18:00",
      timeTo: "20:00",
    },
    participants: [{ id: "p-1", name: "Player 1", phone: "79990000001" }],
    waitlist: [],
    metadata: {
      splitPayment: {
        shareCount: 4,
        payments: [{ status: "CANCELLED", cancelReason: "PLAYER_LEFT" }],
      },
    },
    ...overrides,
  };
}

test("force cleanup ignores game when cancel intent is not explicitly allowed", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_cleanup_prepare.js", {
    payload: [buildSplitGame()],
    _splitCleanupRequest: {
      nowTs: Date.parse("2026-06-03T12:00:00+03:00"),
      nowIso: "2026-06-03T09:00:00.000Z",
      force: true,
      gameId: "game-1",
      dryRun: false,
      limit: 10,
      allowForceGameCancel: false,
    },
  }) as unknown[];

  assert.equal(out[0], null);
  const response = asRecord(out[1]);
  assert.ok(response);
  assert.equal(response.statusCode, 200);
  const payload = asRecord(response.payload);
  assert.ok(payload);
  assert.deepEqual(payload.items, []);
});

test("force cleanup creates FORCED task only with explicit cancel intent", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_cleanup_prepare.js", {
    payload: [buildSplitGame()],
    _splitCleanupRequest: {
      nowTs: Date.parse("2026-06-03T12:00:00+03:00"),
      nowIso: "2026-06-03T09:00:00.000Z",
      force: true,
      gameId: "game-1",
      dryRun: false,
      limit: 10,
      allowForceGameCancel: true,
      intent: "cancel_game",
      actorClientId: "organizer-1",
    },
  }) as unknown[];

  const prepared = asRecord(out[0]);
  assert.ok(prepared);
  const tasks = asTaskList(prepared.payload);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].gameId, "game-1");
  assert.equal(tasks[0].mode, "GAME_CLEANUP");
  assert.equal(tasks[0].reason, "FORCED");
});

test("force cleanup carries explicit preferred refund method into cleanup task", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_cleanup_prepare.js", {
    payload: [buildSplitGame()],
    _splitCleanupRequest: {
      nowTs: Date.parse("2026-06-03T12:00:00+03:00"),
      nowIso: "2026-06-03T09:00:00.000Z",
      force: true,
      gameId: "game-1",
      dryRun: false,
      limit: 10,
      allowForceGameCancel: true,
      intent: "cancel_game",
      actorClientId: "organizer-1",
      preferredRefundMethod: "DEPOSIT",
    },
  }) as unknown[];

  const prepared = asRecord(out[0]);
  assert.ok(prepared);
  const tasks = asTaskList(prepared.payload);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].preferredRefundMethod, "DEPOSIT");
});

test("force game cancellation rejects a verified user who is not the organizer", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_cleanup_prepare.js", {
    payload: [buildSplitGame()],
    _splitCleanupRequest: {
      nowTs: Date.parse("2026-06-03T12:00:00+03:00"),
      nowIso: "2026-06-03T09:00:00.000Z",
      force: true,
      gameId: "game-1",
      dryRun: false,
      limit: 10,
      allowForceGameCancel: true,
      intent: "cancel_game",
      actorClientId: "another-client",
    },
  }) as unknown[];

  assert.equal(out[0], null);
  const response = asRecord(out[1]);
  assert.ok(response);
  assert.equal(response.statusCode, 403);
  assert.equal(
    asRecord(response.payload)?.code,
    "SPLIT_CLEANUP_ORGANIZER_REQUIRED",
  );
});

test("force game cancellation rejects an actor booking not linked to the game", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_cleanup_prepare.js", {
    payload: [buildSplitGame({
      booking: {
        date: "2026-06-02",
        timeFrom: "18:00",
        timeTo: "20:00",
        bookingId: "booking-linked",
      },
    })],
    _splitCleanupRequest: {
      nowTs: Date.parse("2026-06-03T12:00:00+03:00"),
      nowIso: "2026-06-03T09:00:00.000Z",
      force: true,
      gameId: "game-1",
      dryRun: false,
      limit: 10,
      allowForceGameCancel: true,
      intent: "cancel_game",
      actorClientId: "organizer-1",
      actorBookingId: "booking-unrelated",
    },
  }) as unknown[];

  assert.equal(out[0], null);
  const response = asRecord(out[1]);
  assert.ok(response);
  assert.equal(response.statusCode, 403);
  assert.equal(
    asRecord(response.payload)?.code,
    "SPLIT_CLEANUP_ACTOR_BOOKING_NOT_LINKED",
  );
});

test("cleanup query and prepare preserve the selected cancellation action", () => {
  const queryOut = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_cleanup_query.js", {
    _splitCleanupAuth: {
      verified: true,
      actorClientId: "organizer-1",
      actorPhoneNorm: "79990000001",
    },
    req: {
      query: {},
    },
    payload: {
      gameId: "game-1",
      force: true,
      intent: "cancel_game",
      cancellationActionId: "subscription",
      actorBookingId: "booking-1",
    },
  }) as unknown[];

  const queryMsg = asRecord(queryOut[0]);
  assert.ok(queryMsg);
  const cleanupRequest = asRecord(queryMsg._splitCleanupRequest);
  assert.ok(cleanupRequest);
  assert.equal(cleanupRequest.cancellationActionId, "subscription");
  assert.equal(cleanupRequest.actorBookingId, "booking-1");

  queryMsg.payload = [buildSplitGame({
    organizer: { id: "organizer-1", phone: "79990000001" },
    booking: {
      date: "2026-06-02",
      timeFrom: "18:00",
      timeTo: "20:00",
      bookingId: "booking-1",
    },
  })];
  const prepareOut = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_split_cleanup_prepare.js",
    queryMsg,
  ) as unknown[];

  const prepared = asRecord(prepareOut[0]);
  assert.ok(prepared);
  const tasks = asTaskList(prepared.payload);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].cancellationActionId, "subscription");
});

test("forced cleanup carries the exact exercise date for authoritative read-back", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_cleanup_prepare.js", {
    payload: [buildSplitGame({
      booking: {
        exerciseId: "exercise-1",
        timeFromIso: "2026-08-13T21:30:00.000Z",
        timeToIso: "2026-08-13T22:30:00.000Z",
      },
    })],
    _splitCleanupRequest: {
      nowTs: Date.parse("2026-07-31T18:00:00+03:00"),
      nowIso: "2026-07-31T15:00:00.000Z",
      force: true,
      gameId: "game-1",
      dryRun: false,
      limit: 1,
      intent: "cancel_game",
      actorClientId: "organizer-1",
    },
  }) as unknown[];

  const tasks = asTaskList(asRecord(out[0])?.payload);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].exerciseId, "exercise-1");
  assert.equal(tasks[0].exerciseDate, "2026-08-14");
  assert.equal(tasks[0].blockLocalMutation, false);
});

test("forced cleanup with an exercise but no exact date fails closed", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_cleanup_prepare.js", {
    payload: [buildSplitGame({
      booking: { exerciseId: "exercise-1" },
    })],
    _splitCleanupRequest: {
      nowTs: Date.parse("2026-07-31T18:00:00+03:00"),
      nowIso: "2026-07-31T15:00:00.000Z",
      force: true,
      gameId: "game-1",
      dryRun: false,
      limit: 1,
      intent: "cancel_game",
      actorClientId: "organizer-1",
    },
  }) as unknown[];

  const tasks = asTaskList(asRecord(out[0])?.payload);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].blockLocalMutation, true);
  assert.equal(tasks[0].blockReason, "missing_exercise_date");
});

test("participant timeout marks tasks without Viva targets as blocked", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_cleanup_prepare.js", {
    payload: [
      buildSplitGame({
        metadata: {
          splitPayment: {
            shareCount: 4,
            payments: [
              {
                status: "PAYMENT_PENDING",
                clientId: "p-1",
                phone: "79990000001",
                amountMinor: 150000,
                createdAt: "2026-06-03T08:30:00.000Z",
              },
            ],
          },
        },
      }),
    ],
    _splitCleanupRequest: {
      nowTs: Date.parse("2026-06-03T12:00:00+03:00"),
      nowIso: "2026-06-03T09:00:00.000Z",
      force: false,
      dryRun: false,
      limit: 10,
    },
  }) as unknown[];

  const prepared = asRecord(out[0]);
  assert.ok(prepared);
  const tasks = asTaskList(prepared.payload);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].mode, "PARTICIPANT_TIMEOUT");
  assert.deepEqual(tasks[0].bookingIds, []);
  assert.equal(tasks[0].blockLocalMutation, true);
  assert.equal(tasks[0].blockReason, "missing_viva_targets");
});

test("participant timeout falls back to the persisted split payment deadline", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_cleanup_prepare.js", {
    payload: [
      buildSplitGame({
        id: "pay-real-shape",
        status: "PAID",
        payment: { paid: true },
        booking: {
          date: "2026-08-24",
          timeFrom: "20:30",
          timeTo: "22:00",
          bookingIds: ["booking-real-shape"],
          vivaExerciseId: "exercise-real-shape",
        },
        participants: [{ id: "client-real-shape", status: "CONFIRMED" }],
        metadata: {
          splitPayment: {
            enabled: true,
            shareCount: 4,
            deadlineAt: "2026-08-21T15:29:50.535830252+03:00",
            payments: [
              {
                status: "PAYMENT_PENDING",
                clientId: "client-real-shape",
                amountMinor: 37500,
                bookingId: "booking-real-shape",
                transactionId: "transaction-real-shape",
                paymentRef: "payment-real-shape",
              },
            ],
          },
        },
      }),
    ],
    _splitCleanupRequest: {
      nowTs: Date.parse("2026-08-22T22:00:00+03:00"),
      nowIso: "2026-08-22T19:00:00.000Z",
      force: false,
      dryRun: true,
      limit: 10,
      internalScheduler: true,
    },
  }) as unknown[];

  const tasks = asTaskList(asRecord(out[0])?.payload);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].mode, "PARTICIPANT_TIMEOUT");
  assert.deepEqual(tasks[0].bookingIds, ["booking-real-shape"]);
  assert.equal(tasks[0].blockLocalMutation, false);
  const timedOutPayments = tasks[0].timedOutPayments as Array<Record<string, unknown>>;
  assert.equal(timedOutPayments[0].transactionId, "transaction-real-shape");
  assert.equal(timedOutPayments[0].deadlineAt, "2026-08-21T12:29:50.535Z");
});

test("assembly timeout cancels only empty roster split games", () => {
  const gameWithRoster = buildSplitGame({
    id: "game-with-roster",
    participants: [{ id: "p-1", name: "Player 1", phone: "79990000001" }],
    waitlist: [],
  });
  const emptyGame = buildSplitGame({
    id: "game-empty",
    participants: [],
    waitlist: [],
  });

  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_cleanup_prepare.js", {
    payload: [gameWithRoster, emptyGame],
    _splitCleanupRequest: {
      nowTs: Date.parse("2026-06-03T12:00:00+03:00"),
      nowIso: "2026-06-03T09:00:00.000Z",
      force: false,
      dryRun: false,
      limit: 10,
    },
  }) as unknown[];

  const prepared = asRecord(out[0]);
  assert.ok(prepared);
  const tasks = asTaskList(prepared.payload);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].gameId, "game-empty");
  assert.equal(tasks[0].reason, "ASSEMBLY_TIMEOUT");
  assert.equal(tasks[0].blockLocalMutation, true);
  assert.equal(tasks[0].blockReason, "missing_viva_targets");
});
