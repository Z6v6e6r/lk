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

test("cleanup fails closed when the Viva token request configuration is missing", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_cleanup_router.js", {
    payload: {
      mode: "PARTICIPANT_TIMEOUT",
      gameId: "game-token-config-missing",
      reason: "PAYMENT_TIMEOUT",
      dryRun: false,
      bookingTargets: [{ bookingId: "booking-1", clientId: "client-1" }],
      bookingIds: ["booking-1"],
      nextParticipants: [],
      nextWaitlist: [],
      nextSplitPayments: [],
      nextLeaveEvents: [],
    },
  }) as unknown[];

  assert.equal(out[0], null);
  assert.equal(out[1], null);
  const summaryMsg = asRecord(out[2]);
  const payload = asRecord(summaryMsg.payload);
  assert.equal(payload.cancelledInLk, false);
  assert.equal(payload.withVivaErrors, true);
  assert.equal(payload.blockLocalMutation, true);
  assert.equal(payload.blockReason, "viva_admin_token_not_configured");
  const trace = asTrace(payload.trace);
  assert.ok(trace.some((item) => item.step === "blocked_token_not_configured"));
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

test("Admin token failure remains an error and is never masked as dry-run", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_cleanup_router.js", {
    statusCode: 401,
    payload: { error: "invalid_grant" },
    _splitCleanupCtx: {
      step: "token_request",
      mode: "GAME_CLEANUP",
      gameId: "game-1",
      reason: "FORCED",
      dryRun: false,
      bookingQueue: [{ bookingId: "booking-1", clientId: "client-1" }],
      bookingResults: [],
      initialBookingIds: ["booking-1"],
      trace: [],
      blockLocalMutation: false,
      forceVivaErrors: false,
    },
  }) as unknown[];
  assert.equal(out[0], null);
  assert.equal(out[1], null);
  const summary = asRecord(asRecord(out[2]).payload);
  assert.equal(summary.dryRun, false);
  assert.equal(summary.withVivaErrors, true);
  assert.equal(summary.blockLocalMutation, true);
  assert.equal(summary.blockReason, "viva_admin_token_failed");
});

test("actor booking cleanup starts with an Admin read-before-write check", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_cleanup_router.js", {
    statusCode: 200,
    payload: { access_token: "admin-token" },
    _splitCleanupAuth: { authHeader: "Bearer user-token" },
    _splitCleanupCtx: {
      step: "token_request",
      mode: "GAME_CLEANUP",
      gameId: "game-1",
      actorBookingId: "booking-1",
      actorClientId: "client-1",
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
    "https://api.vivacrm.ru/api/v1/clients/client-1/bookings/booking-1",
  );
  assert.equal(asRecord(requestMsg.headers).Authorization, "Bearer admin-token");
  assert.equal(requestMsg.payload, undefined);
  assert.equal(asRecord(requestMsg._splitCleanupCtx).step, "preflight_actor_booking");
});

test("active actor booking continues from preflight to the authenticated End User probe", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_cleanup_router.js", {
    statusCode: 200,
    payload: { id: "booking-1", isCancelled: false },
    _splitCleanupAuth: { authHeader: "Bearer user-token" },
    _splitCleanupCtx: {
      step: "preflight_actor_booking",
      mode: "GAME_CLEANUP",
      token: "admin-token",
      gameId: "game-1",
      actorBookingId: "booking-1",
      currentBookingId: "booking-1",
      currentClientId: "client-1",
      currentProbeRequest: {
        scope: "end_user",
        method: "GET",
        path: "/bookings/booking-1/cancel",
        payload: undefined,
        label: "end_user_cancel_probe",
      },
      bookingQueue: [],
      bookingResults: [],
      initialBookingIds: ["booking-1"],
      trace: [],
    },
  }) as unknown[];
  const requestMsg = asRecord(out[0]);
  assert.equal(
    requestMsg.url,
    "https://api.vivacrm.ru/end-user/api/v1/iSkq6G/bookings/booking-1/cancel",
  );
  assert.equal(asRecord(requestMsg.headers).Authorization, "Bearer user-token");
  assert.equal(asRecord(requestMsg._splitCleanupCtx).step, "cancel_booking_probe");
});

test("cancelled actor booking is accepted idempotently without another refund write", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_cleanup_router.js", {
    statusCode: 200,
    payload: { id: "booking-1", isCancelled: true },
    _splitCleanupCtx: {
      step: "preflight_actor_booking",
      mode: "GAME_CLEANUP",
      token: "admin-token",
      gameId: "game-1",
      reason: "FORCED",
      dryRun: false,
      actorBookingId: "booking-1",
      cancellationActionId: "subscription",
      currentBookingId: "booking-1",
      currentClientId: "client-1",
      currentProbeRequest: { scope: "end_user", method: "GET" },
      bookingQueue: [],
      bookingResults: [],
      initialBookingIds: ["booking-1"],
      trace: [],
      exerciseId: null,
      blockLocalMutation: false,
      forceVivaErrors: false,
      upstreamMutationsAttempted: 0,
    },
  }) as unknown[];
  assert.equal(out[0], null);
  const summary = asRecord(asRecord(out[2]).payload);
  assert.equal(summary.bookingSuccessCount, 1);
  assert.equal(summary.upstreamMutationsAttempted, 0);
  assert.equal(summary.refundMethod, null);
  assert.equal(summary.refundMessage, "Запись уже отменена.");
  const preflightTrace = asTrace(summary.trace).find(
    (item) => item.step === "preflight_actor_booking_already_cancelled",
  );
  assert.ok(preflightTrace);
  assert.equal(preflightTrace.refundMethod, null);
});

test("participant timeout cancel uses a client-scoped Admin probe after transaction check", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_cleanup_router.js", {
    statusCode: 200,
    payload: {
      id: "tx-1",
      status: "UNPAID",
      client: { id: "client-1" },
      products: [{ bookingIds: ["booking-1"] }],
    },
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

test("participant timeout never restores an exact UNPAID transaction", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_cleanup_router.js", {
    statusCode: 200,
    payload: {
      transactionId: "tx-unpaid",
      transactionStatus: "UNPAID",
      toPay: 0,
      client: { id: "client-1" },
      products: [{ bookingIds: ["booking-unpaid"] }],
    },
    _splitCleanupCtx: {
      step: "check_timeout_transaction",
      mode: "PARTICIPANT_TIMEOUT",
      token: "token-1",
      gameId: "game-1",
      currentBookingId: "booking-unpaid",
      currentClientId: "client-1",
      currentTimedOutPayment: { transactionId: "tx-unpaid" },
      bookingQueue: [],
      bookingResults: [],
      initialBookingIds: ["booking-unpaid"],
      trace: [],
    },
  }) as unknown[];

  const requestMsg = asRecord(out[0]);
  const ctx = asRecord(requestMsg._splitCleanupCtx);
  assert.equal(ctx.step, "cancel_booking_probe");
});

test("participant timeout blocks PAID evidence for another transaction", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_cleanup_router.js", {
    statusCode: 200,
    payload: {
      transactionId: "tx-other",
      transactionStatus: "PAID",
      client: { id: "client-1" },
      products: [{ bookingIds: ["booking-expected"] }],
    },
    _splitCleanupCtx: {
      step: "check_timeout_transaction",
      mode: "PARTICIPANT_TIMEOUT",
      token: "token-1",
      gameId: "game-1",
      currentBookingId: "booking-expected",
      currentClientId: "client-1",
      currentTimedOutPayment: { transactionId: "tx-expected" },
      bookingQueue: [],
      bookingResults: [],
      initialBookingIds: ["booking-expected"],
      trace: [],
    },
  }) as unknown[];

  assert.equal(out[0], null);
  const summary = asRecord(asRecord(out[2]).payload);
  assert.equal(summary.blockLocalMutation, true);
  assert.equal(summary.bookingFailedCount, 1);
});

test("participant timeout restores only exact PAID transaction evidence", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_cleanup_router.js", {
    statusCode: 200,
    payload: {
      transactionId: "tx-exact",
      transactionStatus: "PAID",
      client: { id: "client-1" },
      products: [{ bookingIds: ["booking-exact"] }],
    },
    _splitCleanupCtx: {
      step: "check_timeout_transaction",
      mode: "PARTICIPANT_TIMEOUT",
      token: "token-1",
      gameId: "game-1",
      reason: "PAYMENT_TIMEOUT",
      dryRun: false,
      currentBookingId: "booking-exact",
      currentClientId: "client-1",
      currentTimedOutPayment: {
        transactionId: "tx-exact",
        bookingIds: ["booking-exact"],
        clientId: "client-1",
        phone: "79990000001",
        name: "Игрок",
        playerBucket: "participants",
      },
      bookingQueue: [],
      bookingResults: [],
      initialBookingIds: ["booking-exact"],
      trace: [],
      exerciseId: null,
      exerciseCancelled: true,
      blockLocalMutation: false,
      forceVivaErrors: false,
      nextParticipants: [],
      nextWaitlist: [],
      nextSplitPayments: [{
        transactionId: "tx-exact",
        bookingIds: ["booking-exact"],
        clientId: "client-1",
        phone: "79990000001",
        status: "EXPIRED",
        cancelReason: "PAYMENT_TIMEOUT",
      }],
      nextLeaveEvents: [],
      timedOutPayments: [],
    },
  }) as unknown[];

  const setDoc = asRecord(asRecord(asRecord(out[1]).payload).$set);
  const payments = setDoc["metadata.splitPayment.payments"] as Array<Record<string, unknown>>;
  assert.equal(payments[0]?.status, "PAID");
  assert.equal((setDoc.participants as Array<Record<string, unknown>>)[0]?.id, "client-1");
});

test("actor subscription keeps the proven empty End User payload and SERVICE audit semantics", () => {
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
  assert.equal(ctx.selectedRefundMethod, "SERVICE");
  assert.equal(ctx.step, "cancel_booking");
});

test("actor no-refund keeps the proven empty End User payload and NONE audit semantics", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_cleanup_router.js", {
    statusCode: 200,
    payload: {
      cancellationOptions: {
        cancellationOnly: { available: true },
      },
    },
    _splitCleanupAuth: { authHeader: "Bearer user-token" },
    _splitCleanupCtx: {
      step: "cancel_booking_probe",
      mode: "GAME_CLEANUP",
      cancellationActionId: "none",
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
  assert.deepEqual(requestMsg.payload, {});
  const ctx = asRecord(requestMsg._splitCleanupCtx);
  assert.equal(ctx.refundMessage, "Запись отменена без возврата средств.");
  assert.equal(ctx.selectedRefundMethod, "NONE");
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

test("whole-exercise cancellation starts with the dated active list before any write", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_cleanup_router.js", {
    statusCode: 200,
    payload: { access_token: "token-1" },
    _splitCleanupCtx: {
      step: "token_request",
      mode: "GAME_CLEANUP",
      gameId: "game-1",
      exerciseId: "exercise-1",
      exerciseDate: "2026-08-14",
      bookingQueue: [],
      bookingResults: [],
      initialBookingIds: [],
      trace: [],
      upstreamMutationsAttempted: 0,
    },
  }) as unknown[];

  const request = asRecord(out[0]);
  assert.equal(request.method, "GET");
  assert.equal(
    request.url,
    "https://api.vivacrm.ru/api/v1/exercises?date=2026-08-14&includeCanceled=false&page=0&size=200",
  );
  const ctx = asRecord(request._splitCleanupCtx);
  assert.equal(ctx.step, "verify_exercise_active_list");
  assert.equal(ctx.upstreamMutationsAttempted, 0);
});

test("production regression: a historic direct GET cannot cause extra cancellation writes", () => {
  const baseCtx = {
    step: "verify_exercise_active_list",
    mode: "GAME_CLEANUP",
    token: "token-1",
    gameId: "game-1",
    reason: "FORCED",
    dryRun: false,
    exerciseId: "exercise-1",
    exerciseDate: "2026-08-14",
    exerciseReadbackPhase: "PRE_CANCEL",
    exerciseReadbackPage: 0,
    exerciseAttempt: 0,
    bookingQueue: [],
    bookingResults: [],
    initialBookingIds: [],
    trace: [],
    blockLocalMutation: false,
    forceVivaErrors: false,
    timedOutPayments: [],
    upstreamMutationsAttempted: 0,
  };

  let out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_cleanup_router.js", {
    statusCode: 200,
    payload: { content: [{ id: "exercise-1" }], last: true },
    _splitCleanupCtx: baseCtx,
  }) as unknown[];
  let request = asRecord(out[0]);
  assert.equal(request.method, "DELETE");
  assert.equal(request.url, "https://api.vivacrm.ru/api/v1/exercises/exercise-1");

  out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_cleanup_router.js", {
    statusCode: 204,
    payload: null,
    _splitCleanupCtx: request._splitCleanupCtx,
  }) as unknown[];
  request = asRecord(out[0]);
  assert.match(String(request.url), /includeCanceled=false/);

  out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_cleanup_router.js", {
    statusCode: 200,
    payload: { content: [], last: true },
    _splitCleanupCtx: request._splitCleanupCtx,
  }) as unknown[];
  request = asRecord(out[0]);
  assert.match(String(request.url), /includeCanceled=true/);

  out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_cleanup_router.js", {
    statusCode: 200,
    payload: { content: [{ id: "exercise-1", canceled: true }], last: true },
    _splitCleanupCtx: request._splitCleanupCtx,
  }) as unknown[];
  const summary = asRecord(asRecord(out[2]).payload);
  assert.equal(summary.exerciseCancelled, true);
  assert.equal(summary.cancelledInLk, true);
  assert.equal(summary.withVivaErrors, false);
  assert.equal(summary.upstreamMutationsAttempted, 1);
  assert.equal(summary.exerciseVerificationReason, "verified_cancelled_after_mutation");
  assert.ok(!asTrace(summary.trace).some((item) => item.step === "verify_exercise_cancelled_request"));
});

test("already-cancelled exercise is verified idempotently without a Viva write", () => {
  const ctx = {
    step: "verify_exercise_active_list",
    mode: "GAME_CLEANUP",
    token: "token-1",
    gameId: "game-1",
    reason: "FORCED",
    dryRun: false,
    exerciseId: "exercise-1",
    exerciseDate: "2026-08-14",
    exerciseReadbackPhase: "PRE_CANCEL",
    exerciseReadbackPage: 0,
    bookingQueue: [],
    bookingResults: [],
    initialBookingIds: [],
    trace: [],
    blockLocalMutation: false,
    forceVivaErrors: false,
    timedOutPayments: [],
    upstreamMutationsAttempted: 0,
  };
  let out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_cleanup_router.js", {
    statusCode: 200,
    payload: { content: [], last: true },
    _splitCleanupCtx: ctx,
  }) as unknown[];
  const inclusiveRequest = asRecord(out[0]);
  assert.equal(inclusiveRequest.method, "GET");
  assert.match(String(inclusiveRequest.url), /includeCanceled=true/);

  out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_cleanup_router.js", {
    statusCode: 200,
    payload: { content: [{ id: "exercise-1", canceled: true }], last: true },
    _splitCleanupCtx: inclusiveRequest._splitCleanupCtx,
  }) as unknown[];
  const summary = asRecord(asRecord(out[2]).payload);
  assert.equal(summary.exerciseCancelled, true);
  assert.equal(summary.exerciseAlreadyCancelled, true);
  assert.equal(summary.upstreamMutationsAttempted, 0);
  assert.equal(summary.cancelledInLk, true);
});

test("exact incident retry reconciles cancelled booking and exercise with zero upstream writes", () => {
  let out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_cleanup_router.js", {
    statusCode: 200,
    payload: { access_token: "admin-token" },
    _splitCleanupAuth: { authHeader: "Bearer user-token" },
    _splitCleanupCtx: {
      step: "token_request",
      mode: "GAME_CLEANUP",
      gameId: "pay_d8a1dada-3eda-4649-bff6-c1ca48b2ab40",
      reason: "FORCED",
      dryRun: false,
      actorBookingId: "3f9ad506-da5d-4f98-a2d0-c40025c73185",
      actorClientId: "83756527-cfbe-4b7f-b143-1a6ac96d2a93",
      cancellationActionId: "subscription",
      exerciseId: "db0a1eed-1773-4495-bdaf-c5b6c989f9a0",
      exerciseDate: "2026-08-14",
      bookingQueue: [{
        bookingId: "3f9ad506-da5d-4f98-a2d0-c40025c73185",
        clientId: null,
      }],
      bookingResults: [],
      initialBookingIds: ["3f9ad506-da5d-4f98-a2d0-c40025c73185"],
      trace: [],
      blockLocalMutation: false,
      forceVivaErrors: false,
      timedOutPayments: [],
      upstreamMutationsAttempted: 0,
    },
  }) as unknown[];
  let request = asRecord(out[0]);
  assert.match(String(request.url), /\/clients\/83756527-cfbe-4b7f-b143-1a6ac96d2a93\/bookings\//);

  out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_cleanup_router.js", {
    statusCode: 200,
    payload: {
      id: "3f9ad506-da5d-4f98-a2d0-c40025c73185",
      isCancelled: true,
      paymentType: "SUBSCRIPTION",
    },
    _splitCleanupCtx: request._splitCleanupCtx,
  }) as unknown[];
  request = asRecord(out[0]);
  assert.match(String(request.url), /includeCanceled=false/);

  out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_cleanup_router.js", {
    statusCode: 200,
    payload: [],
    _splitCleanupCtx: request._splitCleanupCtx,
  }) as unknown[];
  request = asRecord(out[0]);
  assert.match(String(request.url), /includeCanceled=true/);

  out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_cleanup_router.js", {
    statusCode: 200,
    payload: [{ id: "db0a1eed-1773-4495-bdaf-c5b6c989f9a0", canceled: true }],
    _splitCleanupCtx: request._splitCleanupCtx,
  }) as unknown[];
  const dbMsg = asRecord(out[1]);
  const summary = asRecord(asRecord(out[2]).payload);
  assert.equal(asRecord(asRecord(dbMsg.payload).$set).status, "CANCELLED");
  assert.equal(summary.bookingSuccessCount, 1);
  assert.equal(summary.exerciseCancelled, true);
  assert.equal(summary.exerciseAlreadyCancelled, true);
  assert.equal(summary.upstreamMutationsAttempted, 0);
  assert.equal(summary.cancelledInLk, true);
  assert.equal(summary.withVivaErrors, false);
});

test("active exercise after the final cancellation attempt blocks LK archival", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_cleanup_router.js", {
    statusCode: 200,
    payload: { content: [{ id: "exercise-1", status: "ACTIVE" }], last: true },
    _splitCleanupCtx: {
      step: "verify_exercise_active_list",
      exerciseReadbackPhase: "POST_CANCEL",
      exerciseReadbackPage: 0,
      mode: "GAME_CLEANUP",
      token: "token-1",
      gameId: "game-1",
      reason: "FORCED",
      dryRun: false,
      exerciseId: "exercise-1",
      exerciseDate: "2026-08-14",
      exerciseAttempt: 2,
      bookingQueue: [],
      bookingResults: [],
      initialBookingIds: [],
      trace: [],
      blockLocalMutation: false,
      forceVivaErrors: false,
      timedOutPayments: [],
      upstreamMutationsAttempted: 3,
    },
  }) as unknown[];

  assert.equal(out[1], null);
  const summary = asRecord(asRecord(out[2]).payload);
  assert.equal(summary.cancelledInLk, false);
  assert.equal(summary.withVivaErrors, true);
  assert.equal(summary.exerciseCancelled, false);
  assert.equal(summary.blockReason, "viva_exercise_still_active_after_mutation");
});

test("successful exercise mutation never falls through to a second write on stale read-back", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_cleanup_router.js", {
    statusCode: 200,
    payload: { content: [{ id: "exercise-1", status: "ACTIVE" }], last: true },
    _splitCleanupCtx: {
      step: "verify_exercise_active_list",
      exerciseReadbackPhase: "POST_CANCEL",
      exerciseReadbackPage: 0,
      exerciseCancelOriginStatusCode: 204,
      mode: "GAME_CLEANUP",
      token: "token-1",
      gameId: "game-1",
      reason: "FORCED",
      dryRun: false,
      exerciseId: "exercise-1",
      exerciseDate: "2026-08-14",
      exerciseAttempt: 0,
      bookingQueue: [],
      bookingResults: [],
      initialBookingIds: [],
      trace: [],
      blockLocalMutation: false,
      forceVivaErrors: false,
      timedOutPayments: [],
      upstreamMutationsAttempted: 1,
    },
  }) as unknown[];
  assert.equal(out[0], null);
  assert.equal(out[1], null);
  const summary = asRecord(asRecord(out[2]).payload);
  assert.equal(summary.upstreamMutationsAttempted, 1);
  assert.equal(summary.cancelledInLk, false);
  assert.equal(summary.blockReason, "viva_exercise_still_active_after_mutation");
});

test("absence from both complete exercise lists is unverified and fails closed", () => {
  const ctx = {
    step: "verify_exercise_active_list",
    exerciseReadbackPhase: "PRE_CANCEL",
    exerciseReadbackPage: 0,
    mode: "GAME_CLEANUP",
    token: "token-1",
    gameId: "game-1",
    reason: "FORCED",
    dryRun: false,
    exerciseId: "exercise-1",
    exerciseDate: "2026-08-14",
    bookingQueue: [],
    bookingResults: [],
    initialBookingIds: [],
    trace: [],
    blockLocalMutation: false,
    forceVivaErrors: false,
    timedOutPayments: [],
  };
  let out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_cleanup_router.js", {
    statusCode: 200,
    payload: { content: [], last: true },
    _splitCleanupCtx: ctx,
  }) as unknown[];
  const request = asRecord(out[0]);
  out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_cleanup_router.js", {
    statusCode: 200,
    payload: { content: [], last: true },
    _splitCleanupCtx: request._splitCleanupCtx,
  }) as unknown[];
  const summary = asRecord(asRecord(out[2]).payload);
  assert.equal(summary.cancelledInLk, false);
  assert.equal(summary.blockReason, "viva_exercise_state_unverified");
});

test("inclusive exercise row without a cancellation marker fails closed", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_cleanup_router.js", {
    statusCode: 200,
    payload: { content: [{ id: "exercise-1", status: "ACTIVE" }], last: true },
    _splitCleanupCtx: {
      step: "verify_exercise_inclusive_list",
      exerciseReadbackPhase: "PRE_CANCEL",
      exerciseReadbackPage: 0,
      mode: "GAME_CLEANUP",
      token: "token-1",
      gameId: "game-1",
      reason: "FORCED",
      dryRun: false,
      exerciseId: "exercise-1",
      exerciseDate: "2026-08-14",
      bookingQueue: [],
      bookingResults: [],
      initialBookingIds: [],
      trace: [],
      blockLocalMutation: false,
      forceVivaErrors: false,
    },
  }) as unknown[];
  const summary = asRecord(asRecord(out[2]).payload);
  assert.equal(summary.cancelledInLk, false);
  assert.equal(summary.blockReason, "viva_exercise_inclusive_row_ambiguous");
});

test("exercise read-back paginates and finds the exact id on page two", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_cleanup_router.js", {
    statusCode: 200,
    payload: { content: [], last: false },
    _splitCleanupCtx: {
      step: "verify_exercise_active_list",
      exerciseReadbackPhase: "PRE_CANCEL",
      exerciseReadbackPage: 0,
      mode: "GAME_CLEANUP",
      token: "token-1",
      gameId: "game-1",
      exerciseId: "exercise-1",
      exerciseDate: "2026-08-14",
      bookingQueue: [],
      bookingResults: [],
      initialBookingIds: [],
      trace: [],
    },
  }) as unknown[];
  const pageTwo = asRecord(out[0]);
  assert.match(String(pageTwo.url), /page=1/);
  const next = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_cleanup_router.js", {
    statusCode: 200,
    payload: { content: [{ id: "exercise-1" }], last: true },
    _splitCleanupCtx: pageTwo._splitCleanupCtx,
  }) as unknown[];
  assert.equal(asRecord(next[0]).method, "DELETE");
});

test("exercise read-back treats an exact repeated unpaginated page as complete", () => {
  const repeatedRows = Array.from({ length: 221 }, (_, index) => ({
    id: `active-exercise-${index}`,
  }));
  const ctx = {
    step: "verify_exercise_active_list",
    exerciseReadbackPhase: "PRE_CANCEL",
    exerciseReadbackPage: 0,
    mode: "GAME_CLEANUP",
    token: "token-1",
    gameId: "game-1",
    exerciseId: "cancelled-exercise",
    exerciseDate: "2026-08-26",
    bookingQueue: [],
    bookingResults: [],
    initialBookingIds: [],
    trace: [],
    upstreamMutationsAttempted: 0,
  };

  let out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_cleanup_router.js", {
    statusCode: 200,
    payload: repeatedRows,
    _splitCleanupCtx: ctx,
  }) as unknown[];
  let request = asRecord(out[0]);
  assert.match(String(request.url), /includeCanceled=false/);
  assert.match(String(request.url), /page=1/);

  out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_cleanup_router.js", {
    statusCode: 200,
    payload: repeatedRows,
    _splitCleanupCtx: request._splitCleanupCtx,
  }) as unknown[];
  request = asRecord(out[0]);
  assert.match(String(request.url), /includeCanceled=true/);
  assert.match(String(request.url), /page=0/);
  const repeatedTrace = asTrace(asRecord(request._splitCleanupCtx).trace)
    .find((item) => item.step === "verify_exercise_active_list_absent" && item.page === 1);
  assert.equal(repeatedTrace?.pageRepeated, true);

  out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_cleanup_router.js", {
    statusCode: 200,
    payload: [{ id: "cancelled-exercise", canceled: true }],
    _splitCleanupCtx: request._splitCleanupCtx,
  }) as unknown[];
  const summary = asRecord(asRecord(out[2]).payload);
  assert.equal(summary.exerciseCancelled, true);
  assert.equal(summary.exerciseAlreadyCancelled, true);
  assert.equal(summary.upstreamMutationsAttempted, 0);
  assert.equal(summary.cancelledInLk, true);
});

test("exercise read-back keeps paginating when unpaginated pages differ", () => {
  const firstPageRows = Array.from({ length: 200 }, (_, index) => ({ id: `page-0-${index}` }));
  const secondPageRows = Array.from({ length: 200 }, (_, index) => ({ id: `page-1-${index}` }));
  const baseCtx = {
    step: "verify_exercise_active_list",
    exerciseReadbackPhase: "PRE_CANCEL",
    exerciseReadbackPage: 0,
    mode: "GAME_CLEANUP",
    token: "token-1",
    gameId: "game-1",
    exerciseId: "exercise-on-later-page",
    exerciseDate: "2026-08-26",
    bookingQueue: [],
    bookingResults: [],
    initialBookingIds: [],
    trace: [],
  };

  let out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_cleanup_router.js", {
    statusCode: 200,
    payload: firstPageRows,
    _splitCleanupCtx: baseCtx,
  }) as unknown[];
  let request = asRecord(out[0]);
  assert.match(String(request.url), /page=1/);

  out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_cleanup_router.js", {
    statusCode: 200,
    payload: secondPageRows,
    _splitCleanupCtx: request._splitCleanupCtx,
  }) as unknown[];
  request = asRecord(out[0]);
  assert.match(String(request.url), /includeCanceled=false/);
  assert.match(String(request.url), /page=2/);
});

test("exercise list failure blocks local mutation", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_cleanup_router.js", {
    statusCode: 503,
    payload: { error: "Viva unavailable" },
    _splitCleanupCtx: {
      step: "verify_exercise_active_list",
      exerciseReadbackPhase: "PRE_CANCEL",
      exerciseReadbackPage: 0,
      mode: "GAME_CLEANUP",
      token: "token-1",
      gameId: "game-1",
      exerciseId: "exercise-1",
      exerciseDate: "2026-08-14",
      bookingQueue: [],
      bookingResults: [],
      initialBookingIds: [],
      trace: [],
    },
  }) as unknown[];
  const summary = asRecord(asRecord(out[2]).payload);
  assert.equal(summary.cancelledInLk, false);
  assert.equal(summary.blockReason, "exercise_active_list_failed");
});

test("unfinished exercise pagination is bounded and fails closed", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_cleanup_router.js", {
    statusCode: 200,
    payload: { content: [], last: false },
    _splitCleanupCtx: {
      step: "verify_exercise_active_list",
      exerciseReadbackPhase: "PRE_CANCEL",
      exerciseReadbackPage: 4,
      mode: "GAME_CLEANUP",
      token: "token-1",
      gameId: "game-1",
      exerciseId: "exercise-1",
      exerciseDate: "2026-08-14",
      bookingQueue: [],
      bookingResults: [],
      initialBookingIds: [],
      trace: [],
    },
  }) as unknown[];
  const summary = asRecord(asRecord(out[2]).payload);
  assert.equal(summary.cancelledInLk, false);
  assert.equal(summary.blockReason, "exercise_readback_truncated");
});

test("missing exercise date blocks before token or Viva requests", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_cleanup_router.js", {
    payload: {
      mode: "GAME_CLEANUP",
      gameId: "game-1",
      reason: "FORCED",
      dryRun: false,
      exerciseId: "exercise-1",
    },
  }) as unknown[];
  assert.equal(out[0], null);
  const summary = asRecord(asRecord(out[2]).payload);
  assert.equal(summary.cancelledInLk, false);
  assert.equal(summary.blockReason, "missing_exercise_date");
  assert.equal(summary.upstreamMutationsAttempted, 0);
});

test("dry-run returns a plan without requesting a token or mutating Viva", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_cleanup_router.js", {
    payload: {
      mode: "GAME_CLEANUP",
      gameId: "game-1",
      reason: "FORCED",
      dryRun: true,
      bookingIds: ["booking-1"],
      exerciseId: "exercise-1",
      exerciseDate: "2026-08-14",
    },
  }) as unknown[];
  assert.equal(out[0], null);
  assert.equal(out[1], null);
  const summary = asRecord(asRecord(out[2]).payload);
  assert.equal(summary.dryRun, true);
  assert.equal(summary.cancelledInLk, false);
  assert.equal(summary.withVivaErrors, false);
  assert.equal(summary.upstreamMutationsAttempted, 0);
  assert.ok(asTrace(summary.trace).some((item) => item.step === "dry_run_no_upstream_mutation"));
});
