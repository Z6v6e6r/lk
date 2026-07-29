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
  return value.filter((item): item is Record<string, unknown> => (
    Boolean(item && typeof item === "object" && !Array.isArray(item))
  ));
}

test("split leave starts with a client-scoped Admin cancel probe", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_leave_router.js", {
    statusCode: 200,
    payload: { access_token: "token-1" },
    _splitLeaveCtx: {
      step: "token_request",
      gameId: "game-1",
      bookingQueue: [{ bookingId: "booking-1", clientId: "client-1" }],
      bookingResults: [],
      initialBookingIds: ["booking-1"],
      trace: [],
    },
  }) as unknown[];

  const request = asRecord(out[0]);
  assert.equal(request.method, "GET");
  assert.equal(
    request.url,
    "https://api.vivacrm.ru/api/v1/clients/client-1/bookings/booking-1/cancel",
  );
  assert.equal(asRecord(request._splitLeaveCtx).step, "cancel_probe");
});

test("split leave uses an exercise-scoped probe when clientId is unavailable", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_leave_router.js", {
    statusCode: 200,
    payload: { access_token: "token-1" },
    _splitLeaveCtx: {
      step: "token_request",
      gameId: "game-1",
      exerciseId: "exercise-1",
      bookingQueue: [{ bookingId: "booking-1" }],
      bookingResults: [],
      initialBookingIds: ["booking-1"],
      trace: [],
    },
  }) as unknown[];

  const request = asRecord(out[0]);
  assert.equal(request.method, "GET");
  assert.equal(
    request.url,
    "https://api.vivacrm.ru/api/v1/exercises/exercise-1/bookings/booking-1/cancel",
  );
});

test("subscription return uses client-scoped SERVICE cancellation", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_leave_router.js", {
    statusCode: 200,
    payload: {
      cancellationOptions: {
        subscription: { available: true },
      },
    },
    _splitLeaveCtx: {
      step: "cancel_probe",
      token: "token-1",
      gameId: "game-1",
      currentBookingId: "booking-1",
      currentClientId: "client-1",
      bookingQueue: [],
      bookingResults: [],
      initialBookingIds: ["booking-1"],
      trace: [],
    },
  }) as unknown[];

  const request = asRecord(out[0]);
  assert.equal(request.method, "PUT");
  assert.equal(
    request.url,
    "https://api.vivacrm.ru/api/v1/clients/client-1/bookings/booking-1/cancel",
  );
  assert.deepEqual(request.payload, {
    refundMethod: "SERVICE",
    cancelExercise: false,
  });
});

test("service return uses exercise-scoped DELETE without cancelling the exercise", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_leave_router.js", {
    statusCode: 200,
    payload: {
      cancellationOptions: {
        exercise: { available: true },
      },
    },
    _splitLeaveCtx: {
      step: "cancel_probe",
      token: "token-1",
      gameId: "game-1",
      exerciseId: "exercise-1",
      currentBookingId: "booking-1",
      currentClientId: null,
      bookingQueue: [],
      bookingResults: [],
      initialBookingIds: ["booking-1"],
      trace: [],
    },
  }) as unknown[];

  const request = asRecord(out[0]);
  assert.equal(request.method, "DELETE");
  assert.equal(
    request.url,
    "https://api.vivacrm.ru/api/v1/exercises/exercise-1/bookings/booking-1",
  );
  assert.deepEqual(request.payload, {
    refundMethod: "SERVICE",
    cancelExercise: false,
  });
});

test("probe 404 triggers read-back and never a blind DELETE", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_leave_router.js", {
    statusCode: 404,
    payload: { status: 404, error: "Not Found" },
    _splitLeaveCtx: {
      step: "cancel_probe",
      token: "token-1",
      gameId: "game-1",
      exerciseId: "exercise-1",
      currentBookingId: "booking-1",
      currentClientId: "client-1",
      bookingQueue: [],
      bookingResults: [],
      initialBookingIds: ["booking-1"],
      trace: [],
    },
  }) as unknown[];

  const request = asRecord(out[0]);
  const ctx = asRecord(request._splitLeaveCtx);
  assert.equal(request.method, "GET");
  assert.equal(
    request.url,
    "https://api.vivacrm.ru/api/v1/clients/client-1/bookings/booking-1",
  );
  assert.equal(ctx.step, "verify_booking_cancelled");
  assert.ok(asTrace(ctx.trace).some((item) => item.step === "cancel_booking_probe_not_found"));
  assert.ok(!asTrace(ctx.trace).some((item) => item.step === "cancel_booking_request"));
});

test("successful Admin cancellation still requires exact Viva read-back", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_leave_router.js", {
    statusCode: 200,
    payload: {},
    _splitLeaveCtx: {
      step: "cancel_booking",
      token: "token-1",
      gameId: "game-1",
      exerciseId: "exercise-1",
      currentBookingId: "booking-1",
      currentClientId: "client-1",
      currentCancelRequest: {
        label: "client_cancel_service",
        refundMethod: "SERVICE",
      },
      bookingQueue: [],
      bookingResults: [],
      initialBookingIds: ["booking-1"],
      trace: [],
    },
  }) as unknown[];

  const request = asRecord(out[0]);
  assert.equal(request.method, "GET");
  assert.equal(
    request.url,
    "https://api.vivacrm.ru/api/v1/clients/client-1/bookings/booking-1",
  );
});

test("client read-back 404 falls through to cancelled exercise history", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_leave_router.js", {
    statusCode: 404,
    payload: { status: 404, error: "Not Found" },
    _splitLeaveCtx: {
      step: "verify_booking_cancelled",
      token: "token-1",
      gameId: "game-1",
      exerciseId: "exercise-1",
      currentBookingId: "booking-1",
      currentClientId: "client-1",
      currentVerifyRequest: {
        scope: "client",
        originStatusCode: 200,
      },
      bookingQueue: [],
      bookingResults: [],
      initialBookingIds: ["booking-1"],
      trace: [],
    },
  }) as unknown[];

  const request = asRecord(out[0]);
  assert.equal(
    request.url,
    "https://api.vivacrm.ru/api/v1/exercises/exercise-1/bookings?showCancelled=true&page=0&size=200",
  );
  assert.equal(asRecord(asRecord(request._splitLeaveCtx).currentVerifyRequest).scope, "exercise");
});

test("active read-back blocks split leave success", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_leave_router.js", {
    statusCode: 200,
    payload: { id: "booking-1", isCancelled: false },
    _splitLeaveCtx: {
      step: "verify_booking_cancelled",
      token: "token-1",
      gameId: "game-1",
      currentBookingId: "booking-1",
      currentClientId: "client-1",
      currentVerifyRequest: { scope: "client", originStatusCode: 200 },
      bookingQueue: [],
      bookingResults: [],
      initialBookingIds: ["booking-1"],
      trace: [],
    },
  }) as unknown[];

  const response = asRecord(out[1]);
  const payload = asRecord(response.payload);
  assert.equal(payload.ok, false);
  assert.deepEqual(payload.bookingFailed, ["booking-1"]);
  assert.ok(asTrace(payload.trace).some((item) => item.step === "cancel_booking_still_active"));
});

test("cancelled read-back succeeds and strips internal auth context", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_leave_router.js", {
    statusCode: 200,
    headers: { Authorization: "Bearer admin-token" },
    payload: {
      id: "booking-1",
      isCancelled: true,
      cancellationDate: "2026-07-28T10:00:00+03:00",
    },
    _splitCleanupAuth: { authHeader: "Bearer user-token" },
    _splitLeaveCtx: {
      step: "verify_booking_cancelled",
      token: "admin-token",
      gameId: "game-1",
      currentBookingId: "booking-1",
      currentClientId: "client-1",
      currentVerifyRequest: { scope: "client", originStatusCode: 200 },
      bookingQueue: [],
      bookingResults: [],
      initialBookingIds: ["booking-1"],
      trace: [],
    },
  }) as unknown[];

  const response = asRecord(out[1]);
  const payload = asRecord(response.payload);
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.bookingSuccess, ["booking-1"]);
  assert.equal(response._splitCleanupAuth, undefined);
  assert.equal(response._splitLeaveCtx, undefined);
  assert.equal(asRecord(response.headers).Authorization, undefined);
  assert.equal(response.method, undefined);
  assert.equal(response.url, undefined);
});
