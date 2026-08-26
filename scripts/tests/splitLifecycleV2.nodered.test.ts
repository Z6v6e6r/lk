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
    get(name: string) {
      if (name === "PADLHUB_PLATFORM_TENANT_KEY") {
        return options.envValues?.[name] ?? "tenant-test";
      }
      return options.envValues?.[name];
    },
  };
  return new Function("msg", "env", "global", source)(msg, env, globalContext);
}

const splitRouter = "scripts/nodered_games_nodes/fn_split_router.js";
const cleanupRouter = "scripts/nodered_games_nodes/fn_split_cleanup_router.js";
const cleanupQuery = "scripts/nodered_games_nodes/fn_split_cleanup_query.js";
const cleanupPrepare = "scripts/nodered_games_nodes/fn_split_cleanup_prepare.js";
const cleanupResponse = "scripts/nodered_games_nodes/fn_split_cleanup_response.js";
const cleanupWriteAck = "scripts/nodered_games_nodes/fn_split_cleanup_write_ack.js";

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
    expectedRevision: 7,
    expectedUpdatedAt: "2026-08-26T12:00:00.000Z",
    paymentPaid: true,
    paymentExerciseId: "exercise-1",
    statusBefore: "PAYMENT_PENDING",
    currentBookingId: "booking-1",
    currentClientId: "client-1",
    currentTimedOutPayment: {
      role: "ORGANIZER",
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
    nextSplitPayments: [{
      role: "ORGANIZER",
      status: "EXPIRED",
      transactionId: "transaction-1",
      bookingId: "booking-1",
      paymentRef: "payment-1",
    }],
    nextLeaveEvents: [],
    timedOutPayments: [],
    blockLocalMutation: false,
    forceVivaErrors: false,
  };
}

function schedulerTimedOutGame(createdAt: unknown = "2026-08-23T07:00:00.000Z") {
  return {
    id: "pay-real-shape",
    revision: 7,
    updatedAt: "2026-08-26T12:00:00.000Z",
    createdAt,
    status: "PAID",
    payment: { paid: true },
    settings: { payMode: "split" },
    booking: {
      date: "2026-08-24",
      timeFrom: "20:30",
      timeTo: "22:00",
      bookingIds: ["booking-1"],
      vivaExerciseId: "exercise-real-shape",
    },
    participants: [{ id: "client-1", status: "CONFIRMED" }],
    waitlist: [],
    metadata: {
      splitPayment: {
        enabled: true,
        shareCount: 4,
        deadlineAt: "2026-08-21T15:29:50.535830252+03:00",
        payments: [{
          status: "PAYMENT_PENDING",
          clientId: "client-1",
          amountMinor: 37500,
          bookingId: "booking-1",
          transactionId: "transaction-1",
          paymentRef: "payment-1",
        }],
      },
    },
  };
}

function transaction(status: string, bookingId = "booking-1", exerciseId = "exercise-1") {
  return {
    id: "transaction-1",
    status,
    toPay: 37500,
    currency: "RUB",
    client: { id: "client-1" },
    exercise: { id: exerciseId },
    products: [{ bookingIds: [bookingId] }],
  };
}

test("verified paid organizer timeout promotes the durable draft to PAID", () => {
  const claimWrite = runNodeRedFunction(cleanupRouter, {
    statusCode: 200,
    payload: {
      ...transaction("PAID"),
      toPay: 37500,
      exercise: { id: "exercise-1" },
    },
    _splitCleanupCtx: cleanupContext(),
  }) as Array<Record<string, any> | null>;

  assert.deepEqual(claimWrite[4]?.payload?.[2], { upsert: true });
  const claimRead = runNodeRedFunction(cleanupRouter, {
    ...claimWrite[4],
    payload: { acknowledged: true },
  }) as Array<Record<string, any> | null>;
  const out = runNodeRedFunction(cleanupRouter, {
    ...claimRead[5],
    payload: [{
      _id: "viva_transaction:transaction-1",
      transactionId: "transaction-1",
      bookingId: "booking-1",
      clientId: "client-1",
      exerciseId: "exercise-1",
      gameId: "game-1",
      paymentRef: "payment-1",
    }],
  }) as Array<Record<string, any> | null>;

  assert.equal(out[0], null);
  assert.equal(out[1]?.payload?.$set?.status, "PAID");
  assert.equal(out[1]?.payload?.$set?.["payment.paid"], true);
  assert.equal(
    out[1]?.payload?.$set?.["metadata.splitPayment.organizerPaymentConfirmationSource"],
    "split_cleanup",
  );
  assert.equal(out[1]?.payload?.$set?.["metadata.splitPayment.payments"]?.[0]?.status, "PAID");
  assert.equal(out[2], null);
  assert.equal(out[3], null);

  const readback = runNodeRedFunction(cleanupWriteAck, {
    ...out[1],
    payload: { acknowledged: true, matchedCount: 1 },
  }) as Array<Record<string, any> | null>;
  assert.deepEqual(readback[0]?.payload, { id: "game-1" });
  const ackCtx = readback[0]?._splitCleanupWriteAck;
  const acknowledged = runNodeRedFunction(cleanupWriteAck, {
    ...readback[0],
    payload: [{
      id: "game-1",
      updatedAt: ackCtx.expectedUpdatedAt,
      status: ackCtx.expectedStatus,
      payment: { paid: true },
    }],
  }) as Array<Record<string, any> | null>;
  assert.equal(acknowledged[1]?.statusCode, 200);
  assert.equal(acknowledged[1]?.payload?.cancelledInLk, true);
  assert.equal(acknowledged[1]?.payload?.blockLocalMutation, false);
});

test("cleanup CAS miss never reports local cancellation success", () => {
  const out = runNodeRedFunction(cleanupWriteAck, {
    _splitCleanupWriteAck: {
      step: "write_ack",
      gameId: "game-1",
      expectedUpdatedAt: "2026-08-26T12:01:00.000Z",
      expectedStatus: "PAID",
      expectedPaid: true,
      summaryPayload: { gameId: "game-1", cancelledInLk: true },
    },
    payload: { acknowledged: true, matchedCount: 0 },
  }) as Array<Record<string, any> | null>;
  assert.equal(out[1]?.statusCode, 409);
  assert.equal(out[1]?.payload?.cancelledInLk, false);
  assert.equal(out[1]?.payload?.blockLocalMutation, true);
  assert.equal(out[1]?.payload?.blockReason, "SPLIT_CLEANUP_CAS_MISS");
});

test("participant cleanup preserves an already-paid game through ACK readback", () => {
  const write = runNodeRedFunction(cleanupRouter, {
    _splitCleanupCtx: cleanupContext("finalize_after_test"),
    payload: null,
  }) as Array<Record<string, any> | null>;
  assert.equal(write[1]?._splitCleanupWriteAck?.expectedPaid, true);
  assert.equal(Object.hasOwn(write[1]?.payload?.$set || {}, "payment.paid"), false);

  const readback = runNodeRedFunction(cleanupWriteAck, {
    ...write[1],
    payload: { acknowledged: true, matchedCount: 1 },
  }) as Array<Record<string, any> | null>;
  const ctx = readback[0]?._splitCleanupWriteAck;
  const acknowledged = runNodeRedFunction(cleanupWriteAck, {
    ...readback[0],
    payload: [{
      id: "game-1",
      updatedAt: ctx.expectedUpdatedAt,
      status: ctx.expectedStatus,
      payment: { paid: true },
    }],
  }) as Array<Record<string, any> | null>;
  assert.equal(acknowledged[1]?.statusCode, 200);
  assert.equal(acknowledged[1]?.payload?.cancelledInLk, true);
});

test("cleanup cannot reuse transaction evidence claimed by another game", () => {
  const ctx = cleanupContext("payment_claim_read");
  ctx.paymentEvidenceClaim = {
    claimId: "viva_transaction:transaction-1",
    transactionId: "transaction-1",
    bookingId: "booking-1",
    paymentRef: "payment-1",
    clientId: "client-1",
    exerciseId: "exercise-1",
    timeoutMeta: ctx.currentTimedOutPayment,
    providerPayload: transaction("PAID"),
    method: "transaction_recheck",
    statusCode: 200,
  };
  const out = runNodeRedFunction(cleanupRouter, {
    payload: [{
      _id: "viva_transaction:transaction-1",
      transactionId: "transaction-1",
      bookingId: "booking-1",
      clientId: "client-1",
      exerciseId: "exercise-1",
      gameId: "another-game",
      paymentRef: "payment-other",
    }],
    _splitCleanupCtx: ctx,
  }) as Array<Record<string, any> | null>;
  assert.equal(out[1], null);
  const summary = out[2]?.payload || out[3]?.payload;
  assert.equal(summary?.blockLocalMutation, true);
  assert.equal(summary?.blockReason, "payment_evidence_replay");
});

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
      currency: "RUB",
      client: { id: "client-1" },
      exercise: { id: "exercise-1" },
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
      currency: "RUB",
      client: { id: "client-1" },
      exercise: { id: "exercise-1" },
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
      currency: "RUB",
      client: { id: "client-1" },
      exercise: { id: "exercise-1" },
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

test("missing expected amount and non-RUB provider currency fail closed before claim", () => {
  for (const currentTimedOutPayment of [
    { ...cleanupContext().currentTimedOutPayment, amountMinor: null },
    cleanupContext().currentTimedOutPayment,
  ]) {
    const providerPayload = {
      ...transaction("PAID"),
      ...(currentTimedOutPayment.amountMinor === null ? {} : { currency: "USD" }),
    };
    const out = runNodeRedFunction(cleanupRouter, {
      statusCode: 200,
      payload: providerPayload,
      _splitCleanupCtx: {
        ...cleanupContext(),
        currentTimedOutPayment,
      },
    }) as Array<Record<string, any> | null>;
    assert.equal(Boolean(out[4]), false, "payment evidence claim must stay closed");
    const summary = out[2]?.payload || out[3]?.payload;
    assert.equal(summary?.blockLocalMutation, true);
    assert.ok(summary?.trace?.some((item: Record<string, unknown>) => (
      item.step === "check_timeout_transaction_manual_review"
      && ["expected_amount_missing", "currency_mismatch"].includes(
        String((item.evidence as Record<string, unknown>)?.reason || ""),
      )
    )));
  }
});

test("cleanup PAID evidence requires provider client, exercise and currency", () => {
  for (const [payload, reason] of [
    [transaction("PAID", "booking-1", "exercise-1"), null],
    [transaction("PAID", "booking-1", "exercise-other"), "exercise_binding_mismatch"],
    [{ ...transaction("PAID"), client: undefined }, "client_binding_mismatch"],
    [{ ...transaction("PAID"), currency: undefined }, "currency_mismatch"],
  ] as const) {
    if (reason === null) continue;
    const out = runNodeRedFunction(cleanupRouter, {
      statusCode: 200,
      payload,
      _splitCleanupCtx: cleanupContext(),
    }) as Array<Record<string, any> | null>;
    assert.equal(Boolean(out[4]), false);
    const summary = out[2]?.payload || out[3]?.payload;
    assert.ok(summary?.trace?.some((item: Record<string, unknown>) => (
      item.step === "check_timeout_transaction_manual_review"
      && (item.evidence as Record<string, unknown>)?.reason === reason
    )));
  }
});

test("forced game cleanup carries a CAS snapshot and missing guards stop before Viva", () => {
  const prepared = runNodeRedFunction(cleanupPrepare, {
    payload: [{
      id: "forced-game-1",
      revision: 9,
      updatedAt: "2026-08-26T12:00:00.000Z",
      status: "PAID",
      organizer: { id: "organizer-1" },
      payment: { paid: true },
      settings: { payMode: "split" },
      booking: {
        date: "2026-08-30",
        bookingIds: ["booking-1"],
        vivaExerciseId: "exercise-1",
      },
      participants: [{ id: "organizer-1" }],
      waitlist: [],
      metadata: { splitPayment: { enabled: true, payments: [] } },
    }],
    _splitCleanupRequest: {
      force: true,
      allowForceGameCancel: true,
      intent: "cancel_game",
      gameId: "forced-game-1",
      actorClientId: "organizer-1",
      nowIso: "2026-08-26T12:05:00.000Z",
    },
  }) as Array<Record<string, any> | null>;
  const task = prepared[0]?.payload?.[0];
  assert.equal(task?.mode, "GAME_CLEANUP");
  assert.equal(task?.expectedRevision, 9);
  assert.equal(task?.expectedUpdatedAt, "2026-08-26T12:00:00.000Z");

  const blocked = runNodeRedFunction(cleanupRouter, {
    payload: {
      ...task,
      expectedRevision: null,
      expectedUpdatedAt: null,
    },
  }) as Array<Record<string, any> | null>;
  assert.equal(blocked[0], null, "no Viva request may escape without a stale-write guard");
  assert.equal(blocked[1], null, "no Mongo write may escape without a stale-write guard");
  const summary = blocked[2]?.payload || blocked[3]?.payload;
  assert.equal(summary?.blockLocalMutation, true);
  assert.equal(summary?.blockReason, "stale_write_guard_missing");
  assert.equal(summary?.upstreamMutationsAttempted, 0);
});

test("real scheduler payload reaches only the exact UNPAID booking cancel probe", () => {
  const prepared = runNodeRedFunction(cleanupPrepare, {
    payload: [schedulerTimedOutGame()],
    _splitCleanupRequest: {
      nowTs: Date.parse("2026-08-23T11:00:00+03:00"),
      nowIso: "2026-08-23T08:00:00.000Z",
      dryRun: false,
      limit: 10,
      internalScheduler: true,
      lifecycleMode: "ENFORCE_NEW",
      activationCutoffTs: Date.parse("2026-08-23T07:00:00.000Z"),
      activationCutoffIso: "2026-08-23T07:00:00.000Z",
    },
  }) as Array<Record<string, any> | null>;
  const task = prepared[0]?.payload?.[0];
  assert.equal(task?.mode, "PARTICIPANT_TIMEOUT");
  assert.deepEqual(task?.bookingIds, ["booking-1"]);
  assert.equal(task?.timedOutPayments?.[0]?.transactionId, "transaction-1");
  assert.equal(task?.timedOutPayments?.[0]?.amountMinor, 37500);
  assert.equal(task?.expectedRevision, 7);

  const globalValues = new Map<string, unknown>([
    ["vivacrm_access_token", "cached-service-token"],
    ["vivacrm_token_expires_at", Date.now() + 60_000],
  ]);
  const transactionReadback = runNodeRedFunction(cleanupRouter, {
    payload: task,
  }, { globalValues }) as Array<Record<string, any> | null>;
  assert.equal(transactionReadback[0]?.method, "GET");
  assert.equal(
    transactionReadback[0]?.url,
    "https://api.vivacrm.ru/api/v1/transactions/transaction-1",
  );

  const cancelProbe = runNodeRedFunction(cleanupRouter, {
    ...transactionReadback[0],
    statusCode: 200,
    payload: {
      id: "transaction-1",
      status: "UNPAID",
      toPay: 37500,
      currency: "RUB",
      client: { id: "client-1" },
      exercise: { id: "exercise-real-shape" },
      products: [{
        paymentBookingIds: ["booking-1"],
        pricingDetails: [{ clientBookingId: "booking-1" }],
      }],
    },
  }, { globalValues }) as Array<Record<string, any> | null>;
  assert.equal(cancelProbe[0]?.method, "GET");
  assert.equal(
    cancelProbe[0]?.url,
    "https://api.vivacrm.ru/api/v1/clients/client-1/bookings/booking-1/cancel",
  );
  assert.equal(cancelProbe[0]?._splitCleanupCtx?.step, "cancel_booking_probe");

  const cancelRequest = runNodeRedFunction(cleanupRouter, {
    ...cancelProbe[0],
    statusCode: 200,
    payload: {
      cancellationOptions: {
        money: { available: true },
        cancellationOnly: { available: true },
      },
    },
  }, { globalValues }) as Array<Record<string, any> | null>;
  assert.equal(cancelRequest[0]?.method, "PUT");
  assert.equal(
    cancelRequest[0]?.url,
    "https://api.vivacrm.ru/api/v1/clients/client-1/bookings/booking-1/cancel",
  );
  assert.deepEqual(cancelRequest[0]?.payload, {
    refundMethod: "NONE",
    cancelExercise: false,
  });
  assert.equal(cancelRequest[0]?._splitCleanupCtx?.selectedRefundMethod, "NONE");
  assert.equal(cancelRequest[0]?._splitCleanupCtx?.step, "cancel_booking");
});

test("real scheduler amount mismatch fails closed before paid promotion", () => {
  const prepared = runNodeRedFunction(cleanupPrepare, {
    payload: [schedulerTimedOutGame()],
    _splitCleanupRequest: {
      nowTs: Date.parse("2026-08-23T11:00:00+03:00"),
      nowIso: "2026-08-23T08:00:00.000Z",
      dryRun: false,
      limit: 10,
      internalScheduler: true,
      lifecycleMode: "ENFORCE_NEW",
      activationCutoffTs: Date.parse("2026-08-23T07:00:00.000Z"),
      activationCutoffIso: "2026-08-23T07:00:00.000Z",
    },
  }) as Array<Record<string, any> | null>;
  const globalValues = new Map<string, unknown>([
    ["vivacrm_access_token", "cached-service-token"],
    ["vivacrm_token_expires_at", Date.now() + 60_000],
  ]);
  const transactionReadback = runNodeRedFunction(cleanupRouter, {
    payload: prepared[0]?.payload?.[0],
  }, { globalValues }) as Array<Record<string, any> | null>;
  const out = runNodeRedFunction(cleanupRouter, {
    ...transactionReadback[0],
    statusCode: 200,
    payload: {
      ...transaction("PAID", "booking-1", "exercise-real-shape"),
      toPay: 50000,
    },
  }, { globalValues }) as Array<Record<string, any> | null>;
  assert.equal(out[1], null);
  const summary = out[2]?.payload || out[3]?.payload;
  assert.equal(summary?.blockLocalMutation, true);
  assert.ok(summary?.trace?.some((item: Record<string, unknown>) => (
    item.step === "check_timeout_transaction_manual_review"
    && (item.evidence as Record<string, unknown>)?.reason === "amount_mismatch"
  )));
});

test("verified UNPAID fails closed when Viva offers only refund options", () => {
  const out = runNodeRedFunction(cleanupRouter, {
    statusCode: 200,
    payload: {
      cancellationOptions: {
        money: { available: true },
        deposit: { available: true },
      },
    },
    _splitCleanupCtx: {
      ...cleanupContext("cancel_booking_probe"),
      currentTransactionUnpaidVerified: true,
    },
  }) as Array<Record<string, any> | null>;

  assert.equal(out[0], null);
  const summary = out[2]?.payload || out[3]?.payload;
  assert.equal(summary?.blockLocalMutation, true);
  assert.equal(summary?.blockReason, "verified_unpaid_cancellation_only_unavailable");
  assert.equal(summary?.upstreamMutationsAttempted, 0);
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
  assert.equal(cancel[0]?._splitCleanupCtx?.currentTransactionUnpaidVerified, true);

  const cancelRequest = runNodeRedFunction(cleanupRouter, {
    ...cancel[0],
    statusCode: 200,
    payload: {
      cancellationOptions: {
        money: { available: true },
        cancellationOnly: { available: true },
      },
    },
  }) as Array<Record<string, any> | null>;
  assert.equal(cancelRequest[0]?.method, "PUT");
  assert.deepEqual(cancelRequest[0]?.payload, {
    refundMethod: "NONE",
    cancelExercise: false,
  });
  assert.equal(cancelRequest[0]?._splitCleanupCtx?.selectedRefundMethod, "NONE");
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
  }, {
    globalValues: values,
    envValues: { SPLIT_LIFECYCLE_V2_ENFORCE_FROM: "2026-08-23T10:00:00+03:00" },
  }) as Array<Record<string, any> | null>;
  assert.equal(first[0]?._splitCleanupRequest?.internalScheduler, true);
  assert.equal(first[0]?._splitCleanupRequest?.lifecycleMode, "SHADOW");
  assert.equal(first[0]?._splitCleanupRequest?.dryRun, true);
  assert.equal(first[0]?._splitCleanupRequest?.activationCutoffIso, "2026-08-23T07:00:00.000Z");
  assert.equal(first[0]?.payload?.archived?.$ne, true);
  assert.deepEqual(first[0]?.payload?.createdAt, { $gte: "2026-08-23T07:00:00.000Z" });
  assert.ok(Number(values.get("lk_split_cleanup_scheduler_lease_until")) > Date.now());

  const second = runNodeRedFunction(cleanupQuery, {
    _splitCleanupInternal: { source: "scheduler" },
    payload: {},
  }, {
    globalValues: values,
    envValues: { SPLIT_LIFECYCLE_V2_ENFORCE_FROM: "2026-08-23T10:00:00+03:00" },
  }) as Array<Record<string, any> | null>;
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
    envValues: {
      SPLIT_LIFECYCLE_V2_MODE: "ENFORCE_NEW",
      SPLIT_LIFECYCLE_V2_ENFORCE_FROM: "2026-08-23T07:00:00.000Z",
    },
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

test("SHADOW and ENFORCE_NEW fail closed before lease and Mongo when activation cutoff is missing or invalid", () => {
  for (const mode of ["SHADOW", "ENFORCE_NEW"]) {
    for (const cutoff of [undefined, "2026-08-23 10:00:00", "2026-02-30T10:00:00Z", "not-a-date"]) {
      const values = new Map<string, unknown>();
      const out = runNodeRedFunction(cleanupQuery, {
        _splitCleanupInternal: { source: "scheduler" },
        payload: {},
      }, {
        globalValues: values,
        envValues: {
          SPLIT_LIFECYCLE_V2_MODE: mode,
          ...(cutoff ? { SPLIT_LIFECYCLE_V2_ENFORCE_FROM: cutoff } : {}),
        },
      }) as Array<Record<string, any> | null>;
      assert.equal(out[0], null);
      assert.equal(out[1], null);
      assert.equal(out[2]?.payload?.mode, mode);
      assert.equal(out[2]?.payload?.skipped, true);
      assert.equal(
        out[2]?.payload?.reason,
        cutoff ? "activation_cutoff_invalid" : "activation_cutoff_missing",
      );
      assert.equal(values.has("lk_split_cleanup_scheduler_lease_until"), false);
    }
  }
});

test("prepare independently excludes historical, missing and invalid scheduler rows", () => {
  const values = new Map<string, unknown>([["lk_split_cleanup_scheduler_lease_until", Date.now() + 90_000]]);
  const out = runNodeRedFunction(cleanupPrepare, {
    payload: [
      schedulerTimedOutGame("2026-08-23T06:59:59.999Z"),
      schedulerTimedOutGame(null),
      schedulerTimedOutGame("invalid"),
      schedulerTimedOutGame("2026-02-30T07:00:00.000Z"),
    ],
    _splitCleanupRequest: {
      nowTs: Date.parse("2026-08-23T08:00:00.000Z"),
      nowIso: "2026-08-23T08:00:00.000Z",
      dryRun: false,
      limit: 10,
      internalScheduler: true,
      schedulerLeaseKey: "lk_split_cleanup_scheduler_lease_until",
      lifecycleMode: "ENFORCE_NEW",
      activationCutoffTs: Date.parse("2026-08-23T07:00:00.000Z"),
      activationCutoffIso: "2026-08-23T07:00:00.000Z",
    },
  }, { globalValues: values }) as Array<Record<string, any> | null>;

  assert.equal(out[0], null);
  assert.equal(out[1], null);
  assert.equal(out[2]?.payload?.processed, 0);
  assert.equal(out[2]?.payload?.eligibleChecked, 0);
  assert.equal(out[2]?.payload?.excludedBeforeActivation, 4);
  assert.equal(values.get("lk_split_cleanup_scheduler_lease_until"), 0);
});

test("prepare fails closed when scheduler cutoff context is missing or invalid", () => {
  for (const activationCutoffIso of [undefined, "invalid"]) {
    const out = runNodeRedFunction(cleanupPrepare, {
      payload: [schedulerTimedOutGame("2026-08-23T07:00:00.000Z")],
      _splitCleanupRequest: {
        nowTs: Date.parse("2026-08-23T08:00:00.000Z"),
        nowIso: "2026-08-23T08:00:00.000Z",
        dryRun: false,
        limit: 10,
        internalScheduler: true,
        lifecycleMode: "ENFORCE_NEW",
        activationCutoffTs: Date.parse("2026-08-23T07:00:00.000Z"),
        ...(activationCutoffIso ? { activationCutoffIso } : {}),
      },
    }) as Array<Record<string, any> | null>;

    assert.equal(out[0], null);
    assert.equal(out[1], null);
    assert.equal(out[2]?.payload?.processed, 0);
    assert.equal(out[2]?.payload?.eligibleChecked, 0);
    assert.equal(out[2]?.payload?.excludedBeforeActivation, 1);
  }
});

test("prepare accepts the exact activation boundary for scheduler work", () => {
  const out = runNodeRedFunction(cleanupPrepare, {
    payload: [schedulerTimedOutGame("2026-08-23T07:00:00.000Z")],
    _splitCleanupRequest: {
      nowTs: Date.parse("2026-08-23T08:00:00.000Z"),
      nowIso: "2026-08-23T08:00:00.000Z",
      dryRun: true,
      limit: 10,
      internalScheduler: true,
      lifecycleMode: "SHADOW",
      activationCutoffTs: Date.parse("2026-08-23T07:00:00.000Z"),
      activationCutoffIso: "2026-08-23T07:00:00.000Z",
    },
  }) as Array<Record<string, any> | null>;

  assert.equal(out[0]?.payload?.length, 1);
  assert.equal(out[0]?.payload?.[0]?.gameId, "pay-real-shape");
  assert.equal(out[0]?.payload?.[0]?.dryRun, true);
  assert.equal(out[0]?._splitCleanupRequest?.excludedBeforeActivationCount, 0);
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
