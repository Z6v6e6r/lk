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

test("split leave starts with client-scoped Viva cancel probe when clientId is known", () => {
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

  const requestMsg = asRecord(out[0]);
  const ctx = asRecord(requestMsg._splitLeaveCtx);
  assert.equal(requestMsg.method, "GET");
  assert.equal(requestMsg.url, "https://api.vivacrm.ru/api/v1/clients/client-1/bookings/booking-1/cancel");
  assert.equal(requestMsg.payload, undefined);
  assert.equal(ctx.step, "client_cancel_probe");
});

test("split leave uses client-scoped cancel for subscription return when Viva exposes subscription option", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_leave_router.js", {
    statusCode: 200,
    payload: {
      cancellationOptions: {
        subscription: { available: true },
      },
    },
    _splitLeaveCtx: {
      step: "client_cancel_probe",
      gameId: "game-1",
      currentBookingId: "booking-1",
      currentClientId: "client-1",
      bookingQueue: [],
      bookingResults: [],
      initialBookingIds: ["booking-1"],
      trace: [],
    },
  }) as unknown[];

  const requestMsg = asRecord(out[0]);
  const ctx = asRecord(requestMsg._splitLeaveCtx);
  assert.equal(requestMsg.method, "PUT");
  assert.equal(requestMsg.url, "https://api.vivacrm.ru/api/v1/clients/client-1/bookings/booking-1/cancel");
  assert.deepEqual(requestMsg.payload, {
    refundMethod: "SERVICE",
    cancelExercise: false,
  });
  assert.equal(ctx.step, "client_cancel_booking");
  assert.equal((ctx.currentCancelRequest as Record<string, unknown> | undefined)?.refundMessage, "Вернули 1 занятие на абонемент.");
  assert.equal((ctx.currentCancelRequest as Record<string, unknown> | undefined)?.refundMethod, "SERVICE");
});

test("split leave proceeds when clientId is absent", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_leave_router.js", {
    statusCode: 200,
    payload: { access_token: "token-1" },
    _splitLeaveCtx: {
      step: "token_request",
      gameId: "game-1",
      bookingQueue: [{ bookingId: "booking-1" }],
      bookingResults: [],
      initialBookingIds: ["booking-1"],
      trace: [],
    },
  }) as unknown[];

  const requestMsg = asRecord(out[0]);
  const ctx = asRecord(requestMsg._splitLeaveCtx);
  assert.equal(requestMsg.method, "GET");
  assert.equal(requestMsg.url, "https://api.vivacrm.ru/api/v1/bookings/booking-1/cancel");
  assert.equal(requestMsg.payload, undefined);
  assert.equal(ctx.step, "cancel_probe");
  const trace = Array.isArray(ctx.trace) ? ctx.trace.map((item) => asRecord(item)) : [];
  assert.ok(trace.some((item) => item.step === "cancel_booking_without_client"));
});

test("split leave falls back to generic probe when client-scoped probe fails", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_leave_router.js", {
    statusCode: 404,
    payload: {
      status: 404,
      error: "Not Found",
      path: "/api/v1/clients/client-1/bookings/booking-1/cancel",
    },
    _splitLeaveCtx: {
      step: "client_cancel_probe",
      gameId: "game-1",
      currentBookingId: "booking-1",
      currentClientId: "client-1",
      bookingQueue: [],
      bookingResults: [],
      initialBookingIds: ["booking-1"],
      trace: [],
    },
  }) as unknown[];

  const requestMsg = asRecord(out[0]);
  const ctx = asRecord(requestMsg._splitLeaveCtx);
  assert.equal(requestMsg.method, "GET");
  assert.equal(requestMsg.url, "https://api.vivacrm.ru/api/v1/bookings/booking-1/cancel");
  assert.equal(ctx.step, "cancel_probe");
  const trace = Array.isArray(ctx.trace) ? ctx.trace.map((item) => asRecord(item)) : [];
  assert.ok(trace.some((item) => item.step === "client_cancel_probe_failed"));
  assert.ok(trace.some((item) => item.step === "cancel_probe_request"));
});

test("split leave falls back to generic probe when client-scoped cancel request fails", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_leave_router.js", {
    statusCode: 400,
    payload: {
      status: 400,
      error: "Bad Request",
    },
    _splitLeaveCtx: {
      step: "client_cancel_booking",
      gameId: "game-1",
      currentBookingId: "booking-1",
      currentClientId: "client-1",
      currentCancelRequest: {
        method: "PUT",
        path: "/clients/client-1/bookings/booking-1/cancel",
        payload: {
          refundMethod: "SERVICE",
          cancelExercise: false,
        },
        label: "client_cancel_subscription",
        refundMethod: "SERVICE",
        refundMessage: "Вернули 1 занятие на абонемент.",
      },
      bookingQueue: [],
      bookingResults: [],
      initialBookingIds: ["booking-1"],
      trace: [],
    },
  }) as unknown[];

  const requestMsg = asRecord(out[0]);
  const ctx = asRecord(requestMsg._splitLeaveCtx);
  assert.equal(requestMsg.method, "GET");
  assert.equal(requestMsg.url, "https://api.vivacrm.ru/api/v1/bookings/booking-1/cancel");
  assert.equal(ctx.step, "cancel_probe");
  const trace = Array.isArray(ctx.trace) ? ctx.trace.map((item) => asRecord(item)) : [];
  assert.ok(trace.some((item) => item.step === "client_cancel_failed"));
  assert.ok(trace.some((item) => item.step === "cancel_probe_request"));
});

test("split leave falls back to generic probe when client-scoped probe offers only unsupported service refund", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_leave_router.js", {
    statusCode: 200,
    payload: {
      cancellationOptions: {
        exercise: { available: true },
      },
    },
    _splitLeaveCtx: {
      step: "client_cancel_probe",
      gameId: "game-1",
      currentBookingId: "booking-1",
      currentClientId: "client-1",
      bookingQueue: [],
      bookingResults: [],
      initialBookingIds: ["booking-1"],
      trace: [],
    },
  }) as unknown[];

  const requestMsg = asRecord(out[0]);
  const ctx = asRecord(requestMsg._splitLeaveCtx);
  assert.equal(requestMsg.method, "GET");
  assert.equal(requestMsg.url, "https://api.vivacrm.ru/api/v1/bookings/booking-1/cancel");
  assert.equal(ctx.step, "cancel_probe");
  const trace = Array.isArray(ctx.trace) ? ctx.trace.map((item) => asRecord(item)) : [];
  assert.ok(trace.some((item) => item.step === "client_cancel_probe_unsupported"));
  assert.ok(trace.some((item) => item.step === "cancel_probe_request"));
});

test("split leave fails when Viva offers only service refund", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_leave_router.js", {
    statusCode: 200,
    payload: {
      cancellationOptions: {
        exercise: { available: true },
      },
    },
    _splitLeaveCtx: {
      step: "cancel_probe",
      gameId: "game-1",
      clientId: "client-1",
      currentBookingId: "booking-1",
      currentClientId: "client-1",
      bookingQueue: [],
      bookingResults: [],
      initialBookingIds: ["booking-1"],
      trace: [],
    },
  }) as unknown[];

  assert.equal(out[0], null);
  const summaryMsg = asRecord(out[1]);
  const payload = asRecord(summaryMsg.payload);
  assert.deepEqual(payload.bookingFailed, ["booking-1"]);
  assert.equal(payload.withVivaErrors, true);
  const trace = Array.isArray(payload.trace) ? payload.trace.map((item) => asRecord(item)) : [];
  assert.ok(trace.some((item) => item.step === "cancel_booking_probe_unsupported"));
});

test("split leave falls back to delete when the probe returns 404", () => {
  const probeOut = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_leave_router.js", {
    statusCode: 404,
    payload: {
      timestamp: "2026-06-17T14:23:27.232+00:00",
      status: 404,
      error: "Not Found",
      path: "/api/v1/bookings/booking-1/cancel",
    },
    _splitLeaveCtx: {
      step: "cancel_probe",
      gameId: "game-1",
      currentBookingId: "booking-1",
      currentClientId: null,
      bookingQueue: [],
      bookingResults: [],
      initialBookingIds: ["booking-1"],
      trace: [],
    },
  }) as unknown[];

  const requestMsg = asRecord(probeOut[0]);
  const requestCtx = asRecord(requestMsg._splitLeaveCtx);
  assert.equal(requestMsg.method, "DELETE");
  assert.equal(requestMsg.url, "https://api.vivacrm.ru/api/v1/bookings/booking-1");
  assert.deepEqual(requestMsg.payload, {});
  assert.equal(requestCtx.step, "cancel_booking");
  assert.equal((requestCtx.currentCancelRequest as Record<string, unknown> | undefined)?.label, "delete_plain");

  const finalOut = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_leave_router.js", {
    statusCode: 200,
    payload: {},
    _splitLeaveCtx: requestCtx,
  }) as unknown[];

  const summaryMsg = asRecord(finalOut[1]);
  const payload = asRecord(summaryMsg.payload);
  assert.deepEqual(payload.bookingSuccess, ["booking-1"]);
  assert.equal(payload.withVivaErrors, false);
  const trace = Array.isArray(payload.trace) ? payload.trace.map((item) => asRecord(item)) : [];
  assert.ok(trace.some((item) => item.step === "cancel_booking_probe_not_found"));
  assert.ok(trace.some((item) => item.step === "cancel_booking_success"));
});

test("split leave retries via exercise-scoped delete when plain booking delete returns 404", () => {
  const retryOut = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_leave_router.js", {
    statusCode: 404,
    payload: {
      timestamp: "2026-06-18T20:21:03.941+00:00",
      status: 404,
      error: "Not Found",
      path: "/api/v1/bookings/booking-1",
    },
    _splitLeaveCtx: {
      step: "cancel_booking",
      gameId: "game-1",
      exerciseId: "exercise-1",
      currentBookingId: "booking-1",
      currentClientId: "client-1",
      currentCancelRequest: {
        method: "DELETE",
        path: "/bookings/booking-1",
        payload: {},
        label: "delete_plain",
        refundMethod: null,
        refundMessage: "Запись отменена без возврата средств.",
      },
      bookingQueue: [],
      bookingResults: [],
      initialBookingIds: ["booking-1"],
      trace: [],
    },
  }) as unknown[];

  const requestMsg = asRecord(retryOut[0]);
  const requestCtx = asRecord(requestMsg._splitLeaveCtx);
  assert.equal(requestMsg.method, "DELETE");
  assert.equal(requestMsg.url, "https://api.vivacrm.ru/api/v1/exercises/exercise-1/bookings/booking-1");
  assert.deepEqual(requestMsg.payload, {
    refundMethod: "NONE",
    cancelExercise: false,
  });
  assert.equal((requestCtx.currentCancelRequest as Record<string, unknown> | undefined)?.label, "delete_exercise_booking_none");

  const finalOut = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_leave_router.js", {
    statusCode: 200,
    payload: {},
    _splitLeaveCtx: requestCtx,
  }) as unknown[];

  const summaryMsg = asRecord(finalOut[1]);
  const payload = asRecord(summaryMsg.payload);
  assert.deepEqual(payload.bookingSuccess, ["booking-1"]);
  assert.equal(payload.withVivaErrors, false);
  const trace = Array.isArray(payload.trace) ? payload.trace.map((item) => asRecord(item)) : [];
  assert.ok(trace.some((item) => item.step === "cancel_booking_retry_exercise_scope"));
  assert.ok(trace.some((item) => item.step === "cancel_booking_success"));
});
