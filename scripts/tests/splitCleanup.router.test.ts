import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

type NodeRedMsg = Record<string, unknown>;
type GlobalValues = Record<string, unknown>;

function runNodeRedFunction(file: string, msg: NodeRedMsg, globalValues: GlobalValues = {}) {
  const source = fs.readFileSync(file, "utf8");
  const store = { ...globalValues };
  const globalContext = {
    get(key: string) {
      return Object.prototype.hasOwnProperty.call(store, key)
        ? store[key]
        : undefined;
    },
    set(key: string, value: unknown) {
      store[key] = value;
    },
  };
  return new Function("msg", "global", source)(msg, globalContext);
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function asTrace(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)));
}

test("router blocks participant timeout cleanup when Viva booking targets are missing", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_cleanup_router.js", {
    payload: {
      mode: "PARTICIPANT_TIMEOUT",
      gameId: "game-timeout",
      reason: "PAYMENT_TIMEOUT",
      dryRun: false,
      bookingIds: [],
      bookingTargets: [],
      exerciseId: null,
      nextParticipants: [],
      nextWaitlist: [],
      nextSplitPayments: [
        {
          status: "EXPIRED",
          cancelReason: "PAYMENT_TIMEOUT",
        },
      ],
      nextLeaveEvents: [],
      timedOutPayments: [
        {
          clientId: "p-1",
          phone: "79990000001",
          name: "Player 1",
          bookingIds: [],
          deadlineAt: "2026-06-03T08:40:00.000Z",
        },
      ],
    },
  }) as unknown[];

  assert.equal(out[0], null);
  assert.equal(out[1], null);
  const summaryMsg = asRecord(out[2]);
  const payload = asRecord(summaryMsg.payload);
  assert.equal(payload.mode, "PARTICIPANT_TIMEOUT");
  assert.equal(payload.cancelledInLk, false);
  assert.equal(payload.withVivaErrors, true);
  assert.equal(payload.blockLocalMutation, true);
  assert.equal(payload.blockReason, "missing_viva_targets");
  assert.equal(payload.bookingSuccessCount, 0);
  const trace = asTrace(payload.trace);
  assert.ok(trace.some((item) => item.step === "blocked_missing_viva_targets"));
});

test("router blocks game cleanup cancellation when booking and exercise targets are missing", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_cleanup_router.js", {
    payload: {
      mode: "GAME_CLEANUP",
      gameId: "game-cleanup",
      reason: "ASSEMBLY_TIMEOUT",
      dryRun: false,
      bookingIds: [],
      bookingTargets: [],
      exerciseId: null,
    },
  }) as unknown[];

  assert.equal(out[0], null);
  assert.equal(out[1], null);
  const summaryMsg = asRecord(out[2]);
  const payload = asRecord(summaryMsg.payload);
  assert.equal(payload.mode, "GAME_CLEANUP");
  assert.equal(payload.cancelledInLk, false);
  assert.equal(payload.withVivaErrors, true);
  assert.equal(payload.blockLocalMutation, true);
  assert.equal(payload.blockReason, "missing_viva_targets");
  assert.equal(payload.exerciseId, null);
  const trace = asTrace(payload.trace);
  assert.ok(trace.some((item) => item.step === "blocked_missing_viva_targets"));
});

test("related booking cleanup starts with the client-scoped Admin cancel probe", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_cleanup_router.js", {
    statusCode: 200,
    payload: { access_token: "token-1" },
    _splitCleanupCtx: {
      step: "token_request",
      mode: "GAME_CLEANUP",
      gameId: "game-1",
      bookingQueue: [{ bookingId: "booking-1", clientId: "client-1" }],
      bookingResults: [],
      initialBookingIds: ["booking-1"],
      trace: [],
    },
  }) as unknown[];

  const requestMsg = asRecord(out[0]);
  const ctx = asRecord(requestMsg._splitCleanupCtx);
  assert.equal(requestMsg.method, "GET");
  assert.equal(
    requestMsg.url,
    "https://api.vivacrm.ru/api/v1/clients/client-1/bookings/booking-1/cancel",
  );
  assert.equal(requestMsg.payload, undefined);
  assert.equal(ctx.step, "cancel_booking_probe");
});

test("actor booking cleanup uses the authenticated End User cancel probe from the HAR", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_cleanup_router.js", {
    statusCode: 200,
    payload: { access_token: "admin-token" },
    _splitCleanupAuth: { authHeader: "Bearer user-token" },
    _splitCleanupCtx: {
      step: "token_request",
      mode: "GAME_CLEANUP",
      gameId: "game-1",
      actorBookingId: "booking-1",
      bookingQueue: [{ bookingId: "booking-1", clientId: "client-1" }],
      bookingResults: [],
      initialBookingIds: ["booking-1"],
      trace: [],
    },
  }) as unknown[];

  const requestMsg = asRecord(out[0]);
  assert.equal(requestMsg.method, "GET");
  assert.equal(
    requestMsg.url,
    "https://api.vivacrm.ru/end-user/api/v1/iSkq6G/bookings/booking-1/cancel",
  );
  assert.equal(asRecord(requestMsg.headers).Authorization, "Bearer user-token");
  assert.equal(requestMsg.payload, undefined);
});

test("participant timeout cancel uses a client-scoped Admin probe after transaction check", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_cleanup_router.js", {
    statusCode: 200,
    payload: { status: "FAILED" },
    _splitCleanupCtx: {
      step: "check_timeout_transaction",
      mode: "PARTICIPANT_TIMEOUT",
      token: "token-1",
      gameId: "game-1",
      currentBookingId: "booking-1",
      currentClientId: "client-1",
      currentTimedOutPayment: {
        transactionId: "tx-1",
      },
      bookingQueue: [],
      bookingResults: [],
      initialBookingIds: ["booking-1"],
      trace: [],
    },
  }) as unknown[];

  const requestMsg = asRecord(out[0]);
  const ctx = asRecord(requestMsg._splitCleanupCtx);
  assert.equal(requestMsg.method, "GET");
  assert.equal(
    requestMsg.url,
    "https://api.vivacrm.ru/api/v1/clients/client-1/bookings/booking-1/cancel",
  );
  assert.equal(requestMsg.payload, undefined);
  assert.equal(ctx.step, "cancel_booking_probe");
});

test("actor subscription return follows the HAR DELETE contract with an empty object body", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_cleanup_router.js", {
    statusCode: 200,
    payload: {
      cancellationOptions: {
        subscription: { available: true },
      },
    },
    _splitCleanupAuth: { authHeader: "Bearer user-token" },
    _splitCleanupCtx: {
      step: "cancel_booking_probe",
      mode: "GAME_CLEANUP",
      cancellationActionId: "subscription",
      gameId: "game-1",
      actorBookingId: "booking-1",
      currentBookingId: "booking-1",
      currentClientId: "client-1",
      bookingQueue: [],
      bookingResults: [],
      initialBookingIds: ["booking-1"],
      trace: [],
    },
  }) as unknown[];

  const requestMsg = asRecord(out[0]);
  const ctx = asRecord(requestMsg._splitCleanupCtx);
  assert.equal(requestMsg.method, "DELETE");
  assert.equal(
    requestMsg.url,
    "https://api.vivacrm.ru/end-user/api/v1/iSkq6G/bookings/booking-1",
  );
  assert.deepEqual(requestMsg.payload, {});
  assert.equal(asRecord(requestMsg.headers).Authorization, "Bearer user-token");
  assert.equal(ctx.refundMessage, "Вернули 1 занятие на абонемент.");
  assert.equal(ctx.step, "cancel_booking");
});

test("actor deposit return sends the selected End User refund method", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_cleanup_router.js", {
    statusCode: 200,
    payload: {
      cancellationOptions: {
        money: { available: true, refundSum: 900, refundMethod: "ONLINE" },
        deposit: { available: true, refundSum: 3000 },
      },
    },
    _splitCleanupAuth: { authHeader: "Bearer user-token" },
    _splitCleanupCtx: {
      step: "cancel_booking_probe",
      mode: "GAME_CLEANUP",
      cancellationActionId: "deposit",
      gameId: "game-1",
      actorBookingId: "booking-1",
      currentBookingId: "booking-1",
      currentClientId: "client-1",
      bookingQueue: [],
      bookingResults: [],
      initialBookingIds: ["booking-1"],
      trace: [],
    },
  }) as unknown[];

  const requestMsg = asRecord(out[0]);
  assert.equal(requestMsg.method, "DELETE");
  assert.equal(
    requestMsg.url,
    "https://api.vivacrm.ru/end-user/api/v1/iSkq6G/bookings/booking-1",
  );
  assert.deepEqual(requestMsg.payload, { refundMethod: "DEPOSIT" });
});

test("related client booking uses Admin SERVICE refund without cancelling the exercise", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_cleanup_router.js", {
    statusCode: 200,
    payload: {
      cancellationOptions: {
        exercise: { available: true },
      },
    },
    _splitCleanupCtx: {
      step: "cancel_booking_probe",
      mode: "GAME_CLEANUP",
      gameId: "game-1",
      currentBookingId: "booking-1",
      currentClientId: "client-1",
      bookingQueue: [],
      bookingResults: [],
      initialBookingIds: ["booking-1"],
      trace: [],
      dryRun: false,
      exerciseId: null,
      exerciseCancelled: true,
      blockLocalMutation: false,
      forceVivaErrors: false,
      timedOutPayments: [],
    },
  }) as unknown[];

  const requestMsg = asRecord(out[0]);
  assert.equal(requestMsg.method, "PUT");
  assert.equal(
    requestMsg.url,
    "https://api.vivacrm.ru/api/v1/clients/client-1/bookings/booking-1/cancel",
  );
  assert.deepEqual(requestMsg.payload, {
    refundMethod: "SERVICE",
    cancelExercise: false,
  });
});

test("probe 404 never triggers a blind cancellation request", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_cleanup_router.js", {
    _splitCleanupCtx: {
      step: "cancel_booking_probe",
      mode: "GAME_CLEANUP",
      token: "token-1",
      gameId: "game-1",
      currentBookingId: "booking-1",
      currentClientId: "player-2",
      bookingQueue: [],
      bookingResults: [],
      initialBookingIds: ["booking-1"],
      trace: [],
      dryRun: false,
      exerciseId: "exercise-1",
      exerciseCancelled: true,
      blockLocalMutation: false,
      forceVivaErrors: false,
      timedOutPayments: [],
    },
    statusCode: 404,
    payload: { status: 404, error: "Not Found" },
  }) as unknown[];

  const requestMsg = asRecord(out[0]);
  const ctx = asRecord(requestMsg._splitCleanupCtx);
  assert.equal(out[1], null);
  assert.equal(requestMsg.method, "GET");
  assert.equal(
    requestMsg.url,
    "https://api.vivacrm.ru/api/v1/clients/player-2/bookings/booking-1",
  );
  assert.equal(requestMsg.payload, undefined);
  assert.equal(ctx.step, "verify_booking_cancelled");
  assert.equal((ctx.bookingResults as unknown[]).length, 0);
  const trace = asTrace(ctx.trace);
  assert.ok(trace.some((item) => item.step === "cancel_booking_probe_not_found"));
  assert.ok(!trace.some((item) => item.step === "cancel_booking_request"));
});

test("subscription delete 404 is verified instead of retried without refund semantics", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_cleanup_router.js", {
    statusCode: 404,
    payload: { status: 404, error: "Not Found" },
    _splitCleanupCtx: {
      step: "cancel_booking",
      mode: "GAME_CLEANUP",
      token: "token-1",
      gameId: "game-1",
      exerciseId: "exercise-1",
      currentBookingId: "booking-1",
      currentClientId: "client-1",
      currentCancelRequest: {
        label: "delete_subscription_probe_404",
        refundMethod: null,
      },
      bookingQueue: [],
      bookingResults: [],
      initialBookingIds: ["booking-1"],
      trace: [],
    },
  }) as unknown[];

  const requestMsg = asRecord(out[0]);
  const ctx = asRecord(requestMsg._splitCleanupCtx);
  assert.equal(requestMsg.method, "GET");
  assert.equal(
    requestMsg.url,
    "https://api.vivacrm.ru/api/v1/clients/client-1/bookings/booking-1",
  );
  assert.equal(ctx.step, "verify_booking_cancelled");
  assert.equal(asRecord(ctx.currentVerifyRequest).scope, "client");
});

test("successful booking delete still requires exact Viva read-back", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_cleanup_router.js", {
    statusCode: 204,
    payload: null,
    _splitCleanupCtx: {
      step: "cancel_booking",
      mode: "GAME_CLEANUP",
      token: "token-1",
      gameId: "game-1",
      exerciseId: "exercise-1",
      currentBookingId: "booking-1",
      currentClientId: "client-1",
      currentCancelRequest: {
        label: "delete_currency",
        refundMethod: "CURRENCY",
      },
      bookingQueue: [],
      bookingResults: [],
      initialBookingIds: ["booking-1"],
      trace: [],
    },
  }) as unknown[];

  const requestMsg = asRecord(out[0]);
  const ctx = asRecord(requestMsg._splitCleanupCtx);
  assert.equal(requestMsg.method, "GET");
  assert.equal(
    requestMsg.url,
    "https://api.vivacrm.ru/api/v1/clients/client-1/bookings/booking-1",
  );
  assert.equal(ctx.step, "verify_booking_cancelled");
  assert.equal(asRecord(ctx.currentVerifyRequest).originStatusCode, 204);
});

test("client read-back 404 falls through to the cancelled exercise history", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_cleanup_router.js", {
    statusCode: 404,
    payload: { status: 404, error: "Not Found" },
    _splitCleanupCtx: {
      step: "verify_booking_cancelled",
      mode: "GAME_CLEANUP",
      token: "token-1",
      gameId: "game-1",
      exerciseId: "exercise-1",
      currentBookingId: "booking-1",
      currentClientId: "client-1",
      currentCancelRequest: {
        label: "end_user_delete_subscription",
        refundMethod: null,
      },
      currentVerifyRequest: {
        label: "verify_client_booking",
        scope: "client",
        originStatusCode: 204,
      },
      bookingQueue: [],
      bookingResults: [],
      initialBookingIds: ["booking-1"],
      trace: [],
    },
  }) as unknown[];

  const requestMsg = asRecord(out[0]);
  const ctx = asRecord(requestMsg._splitCleanupCtx);
  assert.equal(requestMsg.method, "GET");
  assert.equal(
    requestMsg.url,
    "https://api.vivacrm.ru/api/v1/exercises/exercise-1/bookings?showCancelled=true&page=0&size=200",
  );
  assert.equal(requestMsg.payload, undefined);
  assert.equal(asRecord(ctx.currentVerifyRequest).scope, "exercise");
  assert.ok(asTrace(ctx.trace).some((item) => item.step === "cancel_booking_verify_history_request"));
});

test("cleanup verifies an exact client booking after the final delete returns 404", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_cleanup_router.js", {
    statusCode: 404,
    payload: { status: 404, error: "Not Found" },
    _splitCleanupCtx: {
      step: "cancel_booking",
      mode: "GAME_CLEANUP",
      token: "token-1",
      gameId: "game-1",
      exerciseId: null,
      currentBookingId: "booking-1",
      currentClientId: "client-1",
      currentCancelRequest: {
        label: "delete_plain_probe_404",
        refundMethod: "CURRENCY",
      },
      bookingQueue: [],
      bookingResults: [],
      initialBookingIds: ["booking-1"],
      trace: [],
    },
  }) as unknown[];

  const requestMsg = asRecord(out[0]);
  const ctx = asRecord(requestMsg._splitCleanupCtx);
  assert.equal(requestMsg.method, "GET");
  assert.equal(
    requestMsg.url,
    "https://api.vivacrm.ru/api/v1/clients/client-1/bookings/booking-1",
  );
  assert.equal(ctx.step, "verify_booking_cancelled");
  assert.equal(asRecord(ctx.currentVerifyRequest).scope, "client");
});

test("cleanup verifies exercise bookings when final delete returns 404 without client id", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_cleanup_router.js", {
    statusCode: 404,
    payload: { status: 404, error: "Not Found" },
    _splitCleanupCtx: {
      step: "cancel_booking",
      mode: "GAME_CLEANUP",
      token: "token-1",
      gameId: "game-1",
      exerciseId: "exercise-1",
      currentBookingId: "booking-1",
      currentClientId: null,
      currentCancelRequest: {
        label: "delete_exercise_booking",
        refundMethod: null,
      },
      bookingQueue: [],
      bookingResults: [],
      initialBookingIds: ["booking-1"],
      trace: [],
    },
  }) as unknown[];

  const requestMsg = asRecord(out[0]);
  const ctx = asRecord(requestMsg._splitCleanupCtx);
  assert.equal(requestMsg.method, "GET");
  assert.equal(
    requestMsg.url,
    "https://api.vivacrm.ru/api/v1/exercises/exercise-1/bookings?showCancelled=true&page=0&size=200",
  );
  assert.equal(ctx.step, "verify_booking_cancelled");
  assert.equal(asRecord(ctx.currentVerifyRequest).scope, "exercise");
});

test("cleanup blocks local cancellation when client verification finds an active booking", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_cleanup_router.js", {
    statusCode: 200,
    payload: {
      id: "booking-1",
      isCancelled: false,
    },
    _splitCleanupCtx: {
      step: "verify_booking_cancelled",
      mode: "GAME_CLEANUP",
      token: "token-1",
      gameId: "game-1",
      reason: "FORCED",
      dryRun: false,
      exerciseId: null,
      exerciseCancelled: true,
      currentBookingId: "booking-1",
      currentClientId: "client-1",
      currentCancelRequest: {
        label: "delete_plain_probe_404",
        refundMethod: "CURRENCY",
      },
      currentVerifyRequest: {
        label: "verify_client_booking",
        scope: "client",
      },
      bookingQueue: [],
      bookingResults: [],
      initialBookingIds: ["booking-1"],
      trace: [],
      blockLocalMutation: false,
      forceVivaErrors: false,
      timedOutPayments: [],
    },
  }) as unknown[];

  assert.equal(out[0], null);
  assert.equal(out[1], null);
  const summary = asRecord(asRecord(out[2]).payload);
  assert.equal(summary.cancelledInLk, false);
  assert.equal(summary.withVivaErrors, true);
  assert.equal(summary.blockLocalMutation, true);
  assert.equal(summary.blockReason, "viva_booking_still_active");
  assert.equal(summary.bookingFailedCount, 1);
  const trace = asTrace(summary.trace);
  assert.ok(trace.some((item) => item.step === "cancel_booking_still_active"));
});

test("cleanup may persist only after client verification confirms cancellation", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_cleanup_router.js", {
    statusCode: 200,
    payload: {
      id: "booking-1",
      isCancelled: true,
      cancellationDate: "2026-07-28T10:00:00+03:00",
    },
    headers: { Authorization: "Bearer admin-token" },
    _splitCleanupAuth: { authHeader: "Bearer user-token" },
    _splitCleanupCtx: {
      step: "verify_booking_cancelled",
      mode: "GAME_CLEANUP",
      token: "token-1",
      gameId: "game-1",
      reason: "FORCED",
      dryRun: false,
      exerciseId: null,
      exerciseCancelled: true,
      currentBookingId: "booking-1",
      currentClientId: "client-1",
      currentCancelRequest: {
        label: "delete_plain_probe_404",
        refundMethod: "CURRENCY",
      },
      currentVerifyRequest: {
        label: "verify_client_booking",
        scope: "client",
      },
      bookingQueue: [],
      bookingResults: [],
      initialBookingIds: ["booking-1"],
      trace: [],
      blockLocalMutation: false,
      forceVivaErrors: false,
      timedOutPayments: [],
    },
  }) as unknown[];

  assert.equal(out[0], null);
  const dbMsg = asRecord(out[1]);
  const summaryMsg = asRecord(out[2]);
  const setDoc = asRecord(asRecord(dbMsg.payload).$set);
  const summary = asRecord(summaryMsg.payload);
  assert.equal(setDoc.status, "CANCELLED");
  assert.equal(setDoc.archived, true);
  assert.equal(summary.cancelledInLk, true);
  assert.equal(summary.withVivaErrors, false);
  assert.equal(summary.bookingSuccessCount, 1);
  const trace = asTrace(summary.trace);
  assert.ok(trace.some((item) => item.step === "cancel_booking_verified_cancelled"));
  assert.equal(summaryMsg._splitCleanupAuth, undefined);
  assert.equal(summaryMsg._splitCleanupCtx, undefined);
  assert.equal(asRecord(summaryMsg.headers).Authorization, undefined);
  assert.equal(summaryMsg.method, undefined);
  assert.equal(summaryMsg.url, undefined);
  assert.equal(dbMsg._splitCleanupAuth, undefined);
  assert.equal(dbMsg._splitCleanupCtx, undefined);
  assert.equal(dbMsg.headers, undefined);
});

test("verified participant timeout cleanup still rewrites identity projections", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_cleanup_router.js", {
    statusCode: 200,
    payload: {
      id: "booking-1",
      isCancelled: true,
    },
    _splitCleanupCtx: {
      step: "verify_booking_cancelled",
      mode: "PARTICIPANT_TIMEOUT",
      token: "token-1",
      gameId: "game-1",
      dryRun: false,
      exerciseId: null,
      exerciseCancelled: true,
      currentBookingId: "booking-1",
      currentClientId: "player-2",
      currentCancelRequest: {
        label: "delete_plain_probe_404",
        refundMethod: null,
      },
      currentVerifyRequest: {
        label: "verify_client_booking",
        scope: "client",
      },
      bookingQueue: [],
      bookingResults: [],
      initialBookingIds: ["booking-1"],
      trace: [],
      blockLocalMutation: false,
      forceVivaErrors: false,
      nextParticipants: [
        { id: "org-1", phone: "79035107512", status: "CONFIRMED" },
      ],
      nextWaitlist: [],
      nextSplitPayments: [
        { clientId: "org-1", phoneNorm: "79035107512", status: "PAID" },
        { clientId: "player-2", phoneNorm: "79998704790", status: "EXPIRED", cancelReason: "PAYMENT_TIMEOUT" },
      ],
      nextLeaveEvents: [],
      timedOutPayments: [],
    },
  }) as unknown[];

  const setDoc = asRecord(asRecord(asRecord(out[1]).payload).$set);
  assert.deepEqual(setDoc.participantPhones, ["79035107512"]);
  assert.deepEqual(setDoc.waitlistPhones, []);
  assert.deepEqual(setDoc.allRelatedPhones, ["79035107512"]);
  assert.deepEqual(setDoc.participantIds, ["org-1"]);
  assert.deepEqual(setDoc.waitlistIds, []);
  assert.deepEqual(setDoc.allRelatedClientIds, ["org-1"]);
});

test("cleanup blocks local cancellation when a final 404 cannot be verified", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_cleanup_router.js", {
    statusCode: 404,
    payload: { status: 404, error: "Not Found" },
    _splitCleanupCtx: {
      step: "cancel_booking",
      mode: "GAME_CLEANUP",
      token: "token-1",
      gameId: "game-1",
      reason: "FORCED",
      dryRun: false,
      exerciseId: null,
      exerciseCancelled: true,
      currentBookingId: "booking-1",
      currentClientId: null,
      currentCancelRequest: {
        label: "delete_plain_probe_404",
        refundMethod: null,
      },
      bookingQueue: [],
      bookingResults: [],
      initialBookingIds: ["booking-1"],
      trace: [],
      blockLocalMutation: false,
      forceVivaErrors: false,
      timedOutPayments: [],
    },
  }) as unknown[];

  assert.equal(out[0], null);
  assert.equal(out[1], null);
  const summary = asRecord(asRecord(out[2]).payload);
  assert.equal(summary.cancelledInLk, false);
  assert.equal(summary.withVivaErrors, true);
  assert.equal(summary.blockReason, "viva_cancel_unverified");
  assert.equal(summary.bookingFailedCount, 1);
});

test("booking failure does not continue with whole-exercise cancellation", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_cleanup_router.js", {
    statusCode: 500,
    payload: { error: "Viva unavailable" },
    _splitCleanupCtx: {
      step: "cancel_booking",
      mode: "GAME_CLEANUP",
      token: "token-1",
      gameId: "game-1",
      reason: "FORCED",
      dryRun: false,
      exerciseId: "exercise-1",
      exerciseAttempt: 0,
      exerciseProcessed: false,
      exerciseCancelled: null,
      currentBookingId: "booking-1",
      currentClientId: "client-1",
      currentCancelRequest: {
        label: "delete_currency",
        refundMethod: "CURRENCY",
      },
      bookingQueue: [],
      bookingResults: [],
      initialBookingIds: ["booking-1"],
      trace: [],
      blockLocalMutation: false,
      forceVivaErrors: false,
      timedOutPayments: [],
    },
  }) as unknown[];

  assert.equal(out[0], null);
  assert.equal(out[1], null);
  const summary = asRecord(asRecord(out[2]).payload);
  assert.equal(summary.cancelledInLk, false);
  assert.equal(summary.blockLocalMutation, true);
  assert.equal(summary.blockReason, "viva_cancel_failed");
  const trace = asTrace(summary.trace);
  assert.ok(!trace.some((item) => item.step === "cancel_exercise_request"));
});

test("whole-exercise cancellation requires an exact Viva read-back", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_cleanup_router.js", {
    statusCode: 204,
    payload: null,
    _splitCleanupCtx: {
      step: "cancel_exercise",
      mode: "GAME_CLEANUP",
      token: "token-1",
      gameId: "game-1",
      exerciseId: "exercise-1",
      exerciseAttempt: 0,
      bookingQueue: [],
      bookingResults: [],
      initialBookingIds: [],
      trace: [],
    },
  }) as unknown[];

  const request = asRecord(out[0]);
  assert.equal(request.method, "GET");
  assert.equal(
    request.url,
    "https://api.vivacrm.ru/api/v1/exercises/exercise-1",
  );
  assert.equal(asRecord(request._splitCleanupCtx).step, "verify_exercise_cancelled");
});

test("active whole-exercise read-back blocks LK archival after final retry", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_cleanup_router.js", {
    statusCode: 200,
    payload: { id: "exercise-1", status: "ACTIVE" },
    _splitCleanupCtx: {
      step: "verify_exercise_cancelled",
      mode: "GAME_CLEANUP",
      token: "token-1",
      gameId: "game-1",
      reason: "FORCED",
      dryRun: false,
      exerciseId: "exercise-1",
      exerciseAttempt: 2,
      bookingQueue: [],
      bookingResults: [],
      initialBookingIds: [],
      trace: [],
      blockLocalMutation: false,
      forceVivaErrors: false,
      timedOutPayments: [],
    },
  }) as unknown[];

  assert.equal(out[1], null);
  const summary = asRecord(asRecord(out[2]).payload);
  assert.equal(summary.cancelledInLk, false);
  assert.equal(summary.withVivaErrors, true);
  assert.equal(summary.exerciseCancelled, false);
  assert.ok(asTrace(summary.trace).some((item) => item.step === "verify_exercise_still_active"));
});
