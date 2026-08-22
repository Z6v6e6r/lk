import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

type ContextOptions = {
  globalValues?: Map<string, unknown>;
  envValues?: Record<string, string>;
};

function runNodeRedFunction(
  file: string,
  msg: Record<string, any>,
  options: ContextOptions = {},
) {
  const source = fs.readFileSync(file, "utf8");
  const values = options.globalValues ?? new Map<string, unknown>();
  const globalContext = {
    get(name: string) { return values.get(name); },
    set(name: string, value: unknown) { values.set(name, value); },
  };
  const env = {
    get(name: string) { return options.envValues?.[name]; },
  };
  return new Function("msg", "env", "global", source)(msg, env, globalContext);
}

const splitRouter = "scripts/nodered_games_nodes/fn_split_router.js";
const cleanupRouter = "scripts/nodered_games_nodes/fn_split_cleanup_router.js";
const cleanupQuery = "scripts/nodered_games_nodes/fn_split_cleanup_query.js";
const cleanupPrepare = "scripts/nodered_games_nodes/fn_split_cleanup_prepare.js";
const cleanupResponse = "scripts/nodered_games_nodes/fn_split_cleanup_response.js";

function splitCreateContext(overrides: Record<string, unknown> = {}) {
  return {
    action: "create",
    step: "create_booking",
    token: "service-token",
    paymentRef: "pay-create-1",
    exerciseId: "exercise-owned-1",
    ownsExercise: true,
    reusedConflictingExercise: false,
    clientPhone: "+79990000001",
    clientId: "client-1",
    studioId: "studio-1",
    roomId: "room-1",
    shareCount: 4,
    shareAmount: 2500,
    oneTimeBaseAmount: 10000,
    paymentMode: "one_time",
    selectedPaymentMode: "one_time",
    ...overrides,
  };
}

test("failed booking is read back before any exercise compensation", () => {
  const out = runNodeRedFunction(splitRouter, {
    statusCode: 503,
    payload: { error: "upstream timeout" },
    _splitCtx: splitCreateContext(),
  }) as Array<Record<string, any> | null>;

  assert.equal(out[0]?.method, "GET");
  assert.equal(out[0]?.url, "https://api.vivacrm.ru/api/v1/exercises/exercise-owned-1/bookings");
  assert.equal(out[0]?._splitCtx?.step, "reconcile_booking_after_failure");
});

test("confirmed empty booking readback compensates only the owned exercise", () => {
  const readback = runNodeRedFunction(splitRouter, {
    statusCode: 200,
    payload: [],
    _splitCtx: splitCreateContext({
      step: "reconcile_booking_after_failure",
      bookingFailure: { statusCode: 503, payload: { error: "timeout" } },
    }),
  }) as Array<Record<string, any> | null>;
  assert.equal(readback[0]?.method, "DELETE");
  assert.equal(readback[0]?.url, "https://api.vivacrm.ru/api/v1/exercises/exercise-owned-1");

  const deleted = runNodeRedFunction(splitRouter, {
    ...readback[0],
    statusCode: 204,
    payload: null,
  }) as Array<Record<string, any> | null>;
  assert.equal(deleted[0]?.method, "GET");
  assert.equal(deleted[0]?.url, "https://api.vivacrm.ru/api/v1/exercises/exercise-owned-1");
  assert.equal(deleted[0]?._splitCtx?.step, "compensate_verify_exercise");

  const verified = runNodeRedFunction(splitRouter, {
    ...deleted[0],
    statusCode: 404,
    payload: { error: "not found" },
  }) as Array<Record<string, any> | null>;
  assert.equal(verified[1]?.statusCode, 502);
  assert.equal(
    verified[1]?.payload?.details?.code,
    "SPLIT_BOOKING_FAILED_EXERCISE_COMPENSATED",
  );
  assert.equal(verified[1]?.payload?.details?.compensationVerified, true);
});

test("ambiguous booking POST recovered by exact actor readback is never deleted", () => {
  const out = runNodeRedFunction(splitRouter, {
    statusCode: 200,
    payload: [{
      id: "booking-recovered-1",
      client: { id: "client-1", phone: "+79990000001" },
      exercise: { id: "exercise-owned-1" },
      studio: { id: "studio-1" },
    }],
    _splitCtx: splitCreateContext({
      step: "reconcile_booking_after_failure",
      bookingFailure: { statusCode: 503, payload: { error: "timeout" } },
    }),
  }) as Array<Record<string, any> | null>;

  assert.equal(out[0]?.method, "POST");
  assert.equal(out[0]?.url, "https://api.vivacrm.ru/api/v1/products/available/by-booking");
  assert.deepEqual(out[0]?.payload?.bookingIds, ["booking-recovered-1"]);
  assert.equal(out[0]?._splitCtx?.bookingRecoveredByReadback, true);
});

test("non-empty booking readback without actor identity fails closed", () => {
  const out = runNodeRedFunction(splitRouter, {
    statusCode: 200,
    payload: [{
      id: "booking-unknown-1",
      exercise: { id: "exercise-owned-1" },
      paymentType: "ON_PLACE",
    }],
    _splitCtx: splitCreateContext({
      step: "reconcile_booking_after_failure",
      bookingFailure: { statusCode: 503, payload: { error: "timeout" } },
    }),
  }) as Array<Record<string, any> | null>;

  assert.equal(out[0], null);
  assert.equal(out[1]?.statusCode, 409);
  assert.equal(out[1]?.payload?.details?.code, "SPLIT_BOOKING_RECONCILIATION_AMBIGUOUS");
  assert.equal(out[1]?.url, undefined);
});

test("a reused conflicting exercise is never compensated by this operation", () => {
  const out = runNodeRedFunction(splitRouter, {
    statusCode: 503,
    payload: { error: "booking failed" },
    _splitCtx: splitCreateContext({ ownsExercise: false, reusedConflictingExercise: true }),
  }) as Array<Record<string, any> | null>;

  assert.equal(out[0], null);
  assert.equal(out[1]?.statusCode, 503);
  assert.equal(out[1]?.url, undefined);
});

function cleanupContext(step = "check_timeout_transaction") {
  return {
    mode: "PARTICIPANT_TIMEOUT",
    step,
    token: "service-token",
    gameId: "game-1",
    currentBookingId: "booking-1",
    currentClientId: "client-1",
    currentTimedOutPayment: {
      transactionId: "transaction-1",
      bookingIds: ["booking-1"],
      clientId: "client-1",
      paymentRef: "payment-1",
      amountMinor: 37500,
    },
    bookingQueue: [],
    bookingResults: [],
    initialBookingIds: ["booking-1"],
    trace: [],
    nextParticipants: [],
    nextWaitlist: [],
    nextSplitPayments: [],
    nextLeaveEvents: [],
    timedOutPayments: [],
    blockLocalMutation: false,
    forceVivaErrors: false,
  };
}

function transaction(status: string, bookingId = "booking-1") {
  return {
    id: "transaction-1",
    status,
    client: { id: "client-1" },
    products: [{ bookingIds: [bookingId] }],
  };
}

test("verified UNPAID is the only direct path from transaction readback to booking cancel", () => {
  const out = runNodeRedFunction(cleanupRouter, {
    statusCode: 200,
    payload: transaction("UNPAID"),
    _splitCleanupCtx: cleanupContext(),
  }) as Array<Record<string, any> | null>;

  assert.equal(out[0]?.method, "GET");
  assert.match(out[0]?.url || "", /\/clients\/client-1\/bookings\/booking-1\/cancel$/);
  assert.equal(out[0]?._splitCleanupCtx?.step, "cancel_booking_probe");
});

test("verified UNPAID accepts the real Viva payment booking binding shape", () => {
  const out = runNodeRedFunction(cleanupRouter, {
    statusCode: 200,
    payload: {
      id: "transaction-1",
      status: "UNPAID",
      toPay: 37500,
      client: { id: "client-1" },
      products: [{
        paymentBookingIds: ["booking-1"],
        pricingDetails: [{ clientBookingId: "booking-1" }],
      }],
    },
    _splitCleanupCtx: cleanupContext(),
  }) as Array<Record<string, any> | null>;

  assert.equal(out[0]?.method, "GET");
  assert.match(out[0]?.url || "", /\/clients\/client-1\/bookings\/booking-1\/cancel$/);
  assert.equal(out[0]?._splitCleanupCtx?.step, "cancel_booking_probe");
});

test("real Viva binding keys still fail closed when they point to another booking", () => {
  const out = runNodeRedFunction(cleanupRouter, {
    statusCode: 200,
    payload: {
      id: "transaction-1",
      status: "UNPAID",
      client: { id: "client-1" },
      products: [{
        paymentBookingIds: ["booking-other"],
        pricingDetails: [{ clientBookingId: "booking-other" }],
      }],
    },
    _splitCleanupCtx: cleanupContext(),
  }) as Array<Record<string, any> | null>;

  assert.equal(out[0], null);
  const summary = out[2]?.payload || out[3]?.payload;
  assert.equal(summary?.blockLocalMutation, true);
  assert.equal(summary?.bookingFailedCount, 1);
  assert.ok(summary?.trace?.some((item: Record<string, unknown>) => (
    item.step === "check_timeout_transaction_manual_review"
    && (item.evidence as Record<string, unknown>)?.reason === "booking_binding_missing"
  )));
});

test("real Viva toPay must match the exact pending payment amount", () => {
  const out = runNodeRedFunction(cleanupRouter, {
    statusCode: 200,
    payload: {
      id: "transaction-1",
      status: "UNPAID",
      toPay: 50000,
      client: { id: "client-1" },
      products: [{ paymentBookingIds: ["booking-1"] }],
    },
    _splitCleanupCtx: cleanupContext(),
  }) as Array<Record<string, any> | null>;

  assert.equal(out[0], null);
  const summary = out[2]?.payload || out[3]?.payload;
  assert.equal(summary?.blockLocalMutation, true);
  assert.ok(summary?.trace?.some((item: Record<string, unknown>) => (
    item.step === "check_timeout_transaction_manual_review"
    && (item.evidence as Record<string, unknown>)?.reason === "amount_mismatch"
  )));
});

test("WAITING transaction is expired and then read back before cancellation", () => {
  const expire = runNodeRedFunction(cleanupRouter, {
    statusCode: 200,
    payload: transaction("WAITING"),
    _splitCleanupCtx: cleanupContext(),
  }) as Array<Record<string, any> | null>;
  assert.equal(expire[0]?.method, "POST");
  assert.equal(
    expire[0]?.url,
    "https://api.vivacrm.ru/api/v1/transactions/transaction-1/expire",
  );

  const readback = runNodeRedFunction(cleanupRouter, {
    ...expire[0],
    statusCode: 200,
    payload: { ok: true },
  }) as Array<Record<string, any> | null>;
  assert.equal(readback[0]?.method, "GET");
  assert.equal(
    readback[0]?.url,
    "https://api.vivacrm.ru/api/v1/transactions/transaction-1",
  );
  assert.equal(readback[0]?._splitCleanupCtx?.step, "check_timeout_transaction_after_expire");

  const cancel = runNodeRedFunction(cleanupRouter, {
    ...readback[0],
    statusCode: 200,
    payload: transaction("UNPAID"),
  }) as Array<Record<string, any> | null>;
  assert.equal(cancel[0]?.method, "GET");
  assert.match(cancel[0]?.url || "", /\/bookings\/booking-1\/cancel$/);
});

test("provider error, partial payment and mismatched booking all fail closed", () => {
  const cases = [
    { statusCode: 503, payload: { error: "unavailable" } },
    { statusCode: 200, payload: transaction("PARTIALLY_PAID") },
    { statusCode: 200, payload: transaction("UNPAID", "booking-other") },
  ];
  for (const input of cases) {
    const out = runNodeRedFunction(cleanupRouter, {
      ...input,
      _splitCleanupCtx: cleanupContext(),
    }) as Array<Record<string, any> | null>;
    assert.equal(out[0], null);
    const summary = out[2]?.payload || out[3]?.payload;
    assert.equal(summary?.blockLocalMutation, true);
    assert.equal(summary?.bookingFailedCount, 1);
  }
});

test("internal cleanup scheduler acquires a bounded lease and skips overlap", () => {
  const values = new Map<string, unknown>();
  const first = runNodeRedFunction(cleanupQuery, {
    _splitCleanupInternal: { source: "scheduler" },
    payload: {},
  }, { globalValues: values }) as Array<Record<string, any> | null>;
  assert.equal(first[0]?._splitCleanupRequest?.internalScheduler, true);
  assert.equal(first[0]?._splitCleanupRequest?.lifecycleMode, "SHADOW");
  assert.equal(first[0]?._splitCleanupRequest?.dryRun, true);
  assert.equal(first[0]?.payload?.archived?.$ne, true);
  assert.ok(Number(values.get("lk_split_cleanup_scheduler_lease_until")) > Date.now());

  const second = runNodeRedFunction(cleanupQuery, {
    _splitCleanupInternal: { source: "scheduler" },
    payload: {},
  }, { globalValues: values }) as Array<Record<string, any> | null>;
  assert.equal(second[0], null);
  assert.equal(second[2]?.payload?.reason, "lease_active");
});

test("ENFORCE_NEW is explicit and OFF does not acquire a scheduler lease", () => {
  const enforceValues = new Map<string, unknown>();
  const enforce = runNodeRedFunction(cleanupQuery, {
    _splitCleanupInternal: { source: "scheduler" },
    payload: {},
  }, {
    globalValues: enforceValues,
    envValues: { SPLIT_LIFECYCLE_V2_MODE: "ENFORCE_NEW" },
  }) as Array<Record<string, any> | null>;
  assert.equal(enforce[0]?._splitCleanupRequest?.dryRun, false);
  assert.equal(enforce[0]?._splitCleanupRequest?.lifecycleMode, "ENFORCE_NEW");

  const offValues = new Map<string, unknown>();
  const off = runNodeRedFunction(cleanupQuery, {
    _splitCleanupInternal: { source: "scheduler" },
    payload: {},
  }, {
    globalValues: offValues,
    envValues: { SPLIT_LIFECYCLE_V2_MODE: "OFF" },
  }) as Array<Record<string, any> | null>;
  assert.equal(off[0], null);
  assert.equal(off[2]?.payload?.reason, "feature_off");
  assert.equal(offValues.has("lk_split_cleanup_scheduler_lease_until"), false);
});

test("scheduler empty result releases its lease without touching an HTTP response", () => {
  const values = new Map<string, unknown>([["lk_split_cleanup_scheduler_lease_until", Date.now() + 90_000]]);
  const out = runNodeRedFunction(cleanupPrepare, {
    payload: [],
    _splitCleanupRequest: {
      internalScheduler: true,
      schedulerLeaseKey: "lk_split_cleanup_scheduler_lease_until",
      nowTs: Date.now(),
      nowIso: new Date().toISOString(),
    },
  }, { globalValues: values }) as Array<Record<string, any> | null>;
  assert.equal(out[0], null);
  assert.equal(out[1], null);
  assert.equal(out[2]?.payload?.processed, 0);
  assert.equal(values.get("lk_split_cleanup_scheduler_lease_until"), 0);
});

test("scheduler summary is debug-only and releases the lease", () => {
  const values = new Map<string, unknown>([["lk_split_cleanup_scheduler_lease_until", Date.now() + 90_000]]);
  const out = runNodeRedFunction(cleanupResponse, {
    payload: [{
      gameId: "game-1",
      reason: "PAYMENT_TIMEOUT",
      internalScheduler: true,
      cancelledInLk: true,
      withVivaErrors: false,
    }],
  }, { globalValues: values }) as Array<Record<string, any> | null>;
  assert.equal(out[0], null);
  assert.equal(out[1]?.payload?.source, "scheduler");
  assert.equal(values.get("lk_split_cleanup_scheduler_lease_until"), 0);
});
