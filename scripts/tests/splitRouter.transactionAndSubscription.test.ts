import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

function runNodeRedFunction(file: string, msg: Record<string, unknown>) {
  const source = fs.readFileSync(file, "utf8");
  return new Function("msg", source)(msg);
}

type RouterMessage = {
  method?: string;
  url?: string;
  statusCode?: number;
  payload?: {
    error?: string;
    details?: {
      requestedClientSubscriptionId?: string;
      actualClientSubscriptionId?: string;
    };
    subscriptionProductId?: string;
    paymentModes?: Array<{ productId?: string }>;
    transactionId?: string;
    paymentUrl?: string;
    paymentType?: string;
    clientSubscriptionId?: string;
    count?: number;
  };
};

test("subscription booking request sends the exact selected client subscription id through the atomic gateway", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_router.js", {
    statusCode: 200,
    payload: { access_token: "token" },
    req: {
      headers: {
        authorization: "Bearer user-token",
      },
      query: { operationId: "split-idem-1" },
    },
    _splitCtx: {
      step: "token",
      action: "join",
      paymentMode: "subscription",
      clientSubscriptionId: "new-subscription",
      clientPhone: "79990000001",
      exerciseId: "exercise-1",
      durationMinutes: 120,
      spot: 1,
    },
  }) as unknown[];

  const requestMsg = out[3] as RouterMessage & {
    _subscriptionBooking?: {
      operationId?: string;
      exerciseId?: string;
      clientSubscriptionId?: string;
      subscriptionVisitCount?: number;
    };
  };
  assert.equal(requestMsg.method, "GET");
  assert.match(requestMsg.url || "", /\/profile$/);
  assert.equal(requestMsg._subscriptionBooking?.operationId, "split-idem-1");
  assert.equal(requestMsg._subscriptionBooking?.exerciseId, "exercise-1");
  assert.equal(requestMsg._subscriptionBooking?.clientSubscriptionId, "new-subscription");
  assert.equal(requestMsg._subscriptionBooking?.subscriptionVisitCount, 2);
});

test("subscription booking router rejects a product id used in place of clientSubscriptionId", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_router.js", {
    statusCode: 200,
    payload: { access_token: "token" },
    req: {
      headers: { authorization: "Bearer user-token" },
      query: { operationId: "split-idem-missing-selection" },
    },
    _splitCtx: {
      step: "token",
      action: "join",
      paymentMode: "subscription",
      subscriptionId: "product-template-only",
      clientPhone: "79990000001",
      exerciseId: "exercise-1",
      durationMinutes: 60,
      spot: 1,
    },
  }) as unknown[];

  const errorMsg = out[1] as RouterMessage;
  assert.equal(errorMsg.statusCode, 400);
  assert.equal(errorMsg.payload?.error, "clientSubscriptionId is required for subscription payment");
});

test("subscription booking fails when Viva confirms a different client subscription", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_router.js", {
    statusCode: 200,
    payload: {
      id: "booking-1",
      clientSubscriptionId: "friendship-subscription",
      client: { id: "client-1", phone: "79990000001" },
      studio: { id: "studio-1" },
      spot: 1,
    },
    _splitCtx: {
      step: "create_booking",
      action: "create",
      paymentMode: "subscription",
      selectedPaymentMode: "subscription",
      clientSubscriptionId: "sport-subscription",
      shareCount: 4,
      oneTimeBaseAmount: 10000,
      shareAmount: 2500,
      paymentRef: "split-ref-1",
      exerciseId: "exercise-1",
      vivaDirectionId: 4588,
      vivaExerciseTypeId: 1613,
      totalAmount: 10000,
      deadlineAt: null,
      assembleDeadlineAt: null,
      spot: 1,
    },
  }) as unknown[];

  const errorMsg = out[1] as RouterMessage;
  assert.equal(errorMsg.statusCode, 409);
  assert.equal(errorMsg.payload?.error, "Viva списала другой абонемент");
  assert.equal(errorMsg.payload?.details?.requestedClientSubscriptionId, "sport-subscription");
  assert.equal(errorMsg.payload?.details?.actualClientSubscriptionId, "friendship-subscription");
});

test("subscription booking response keeps the actual matched client subscription id", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_router.js", {
    statusCode: 200,
    payload: {
      id: "booking-1",
      clientSubscriptionId: "sport-subscription",
      client: { id: "client-1", phone: "79990000001" },
      studio: { id: "studio-1" },
      spot: 1,
    },
    _splitCtx: {
      step: "create_booking",
      action: "create",
      paymentMode: "subscription",
      selectedPaymentMode: "subscription",
      clientSubscriptionId: "sport-subscription",
      shareCount: 4,
      oneTimeBaseAmount: 10000,
      shareAmount: 2500,
      paymentRef: "split-ref-2",
      exerciseId: "exercise-2",
      vivaDirectionId: 4588,
      vivaExerciseTypeId: 1613,
      totalAmount: 10000,
      deadlineAt: null,
      assembleDeadlineAt: null,
      spot: 1,
    },
  }) as unknown[];

  const responseMsg = out[1] as RouterMessage;
  assert.equal(responseMsg.statusCode, 201);
  assert.equal(responseMsg.payload?.subscriptionProductId, "sport-subscription");
  assert.equal(responseMsg.payload?.paymentModes?.[0]?.productId, "sport-subscription");
});

test("subscription product resolution never falls back to another subscription or one-time payment", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_router.js", {
    statusCode: 200,
    payload: [
      {
        id: "control-subscription",
        clientSubscriptionId: "control-subscription",
        productType: "SUBSCRIPTION",
        name: "РА",
        status: "ACTIVE",
        cost: 0,
      },
      {
        id: "one-time-product",
        productType: "BOOKING_PAYMENT",
        name: "Разовая оплата",
        status: "ACTIVE",
        cost: 250000,
      },
    ],
    _splitCtx: {
      step: "available_products",
      action: "join",
      paymentMode: "subscription",
      clientSubscriptionId: "friendship-subscription",
      clientPhone: "79990000001",
      exerciseId: "exercise-1",
      bookingId: "booking-1",
      studioId: "studio-1",
      shareCount: 4,
      shareAmount: 2500,
      oneTimeBaseAmount: 10000,
    },
  }) as unknown[];

  const errorMsg = out[1] as RouterMessage;
  assert.equal(errorMsg.statusCode, 409);
  assert.equal(errorMsg.payload?.error, "Выбранный абонемент недоступен для списания");
  assert.equal(
    errorMsg.payload?.details?.requestedClientSubscriptionId,
    "friendship-subscription",
  );
});

test("transaction step preserves transactionId when Viva returns transactionId field without id", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_router.js", {
    statusCode: 200,
    payload: {
      transactionId: "tx-1",
      paymentUrl: "https://pay.example/tx-1",
      toPay: 2500,
    },
    _splitCtx: {
      step: "transaction",
      action: "join",
      paymentMode: "one_time",
      selectedPaymentMode: "one_time",
      paymentRef: "split-ref-3",
      exerciseId: "exercise-3",
      bookingId: "booking-3",
      shareAmount: 2500,
      shareAmountMinor: 250000,
      baseShareAmount: 2500,
      baseShareAmountMinor: 250000,
      discountAmount: 0,
      discountAmountMinor: 0,
      vivaDirectionId: 4588,
      vivaExerciseTypeId: 1613,
      totalAmount: 10000,
      oneTimeBaseAmount: 10000,
      availablePaymentModes: [],
      deadlineAt: null,
      assembleDeadlineAt: null,
      spot: 2,
      reusedConflictingExercise: false,
    },
  }) as unknown[];

  const responseMsg = out[1] as RouterMessage;
  assert.equal(responseMsg.statusCode, 201);
  assert.equal(responseMsg.payload?.transactionId, "tx-1");
  assert.equal(responseMsg.payload?.paymentUrl, "https://pay.example/tx-1");
});

test("payment confirmation emits evidence only for a paid transaction bound to the booking and phone", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_router.js", {
    statusCode: 200,
    payload: {
      id: "tx-confirmed-1",
      status: "PAID",
      client: { id: "client-1", phone: "+79990000001" },
      products: [{
        bookingIds: ["booking-confirmed-1"],
        bookingRequests: [{ exerciseId: "exercise-confirmed-1" }],
      }],
      amountMinor: 250000,
      currency: "RUB",
    },
    _splitCtx: {
      step: "confirm_transaction_lookup",
      action: "confirm_payment",
      operationType: "TRANSACTION",
      operationId: "tx-confirmed-1",
      bookingId: "booking-confirmed-1",
      clientId: "client-1",
      expectedExerciseId: "exercise-confirmed-1",
    },
  }) as Array<Record<string, any> | null>;

  assert.equal(out[0], null);
  assert.equal(out[1], null);
  assert.equal(out[4]?._verifiedPaymentEvidence?.operationId, "tx-confirmed-1");
  assert.equal(out[4]?._verifiedPaymentEvidence?.bookingId, "booking-confirmed-1");
  assert.equal(out[4]?._verifiedPaymentEvidence?.clientPhoneE164, "+79990000001");
});

test("payment confirmation fails closed for a pending transaction", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_router.js", {
    statusCode: 200,
    payload: {
      id: "tx-pending-1",
      status: "PAYMENT_PENDING",
      client: { phone: "+79990000001" },
      products: [{
        bookingIds: ["booking-pending-1"],
        bookingRequests: [{ exerciseId: "exercise-pending-1" }],
      }],
    },
    _splitCtx: {
      step: "confirm_transaction_lookup",
      action: "confirm_payment",
      operationType: "TRANSACTION",
      operationId: "tx-pending-1",
      bookingId: "booking-pending-1",
      clientId: "client-1",
      expectedExerciseId: "exercise-pending-1",
    },
  }) as Array<RouterMessage | null>;

  assert.equal(out[1]?.statusCode, 409);
  assert.equal((out[1]?.payload?.details as Record<string, unknown>)?.code, "LEGACY_PAYMENT_NOT_CONFIRMED");
});

test("subscription confirmation binds the booking to the expected exercise and client", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_router.js", {
    statusCode: 200,
    payload: {
      id: "booking-subscription-1",
      isCancelled: false,
      cancelled: false,
      paymentType: "SUBSCRIPTION",
      clientSubscriptionId: "client-subscription-1",
      client: { id: "client-1", phone: "+79990000001" },
      exercise: { id: "exercise-1" },
    },
    _splitCtx: {
      step: "confirm_subscription_booking_lookup",
      action: "confirm_payment",
      operationType: "SUBSCRIPTION_BOOKING",
      operationId: "booking-subscription-1",
      bookingId: "booking-subscription-1",
      clientId: "client-1",
      expectedExerciseId: "exercise-1",
    },
  }) as Array<Record<string, any> | null>;

  assert.equal(out[4]?._verifiedPaymentEvidence?.operationType, "SUBSCRIPTION_BOOKING");
  assert.equal(out[4]?._verifiedPaymentEvidence?.clientPhoneE164, "+79990000001");
});

test("payment confirmation rejects a paid transaction bound to another exercise", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_router.js", {
    statusCode: 200,
    payload: {
      id: "tx-wrong-exercise",
      status: "PAID",
      client: { phone: "+79990000001" },
      products: [{
        bookingIds: ["booking-wrong-exercise"],
        bookingRequests: [{ exerciseId: "exercise-other" }],
      }],
    },
    _splitCtx: {
      step: "confirm_transaction_lookup",
      action: "confirm_payment",
      operationType: "TRANSACTION",
      operationId: "tx-wrong-exercise",
      bookingId: "booking-wrong-exercise",
      clientId: "client-1",
      expectedExerciseId: "exercise-expected",
    },
  }) as Array<RouterMessage | null>;

  assert.equal(out[1]?.statusCode, 409);
  assert.equal((out[1]?.payload?.details as Record<string, unknown>)?.code, "LEGACY_PAYMENT_NOT_CONFIRMED");
});

test("payment confirmation rejects non-canonical success-like statuses", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_router.js", {
    statusCode: 200,
    payload: {
      id: "tx-success-like",
      status: "SUCCESS",
      client: { phone: "+79990000001" },
      products: [{
        bookingIds: ["booking-success-like"],
        bookingRequests: [{ exerciseId: "exercise-success-like" }],
      }],
    },
    _splitCtx: {
      step: "confirm_transaction_lookup",
      action: "confirm_payment",
      operationType: "TRANSACTION",
      operationId: "tx-success-like",
      bookingId: "booking-success-like",
      clientId: "client-1",
      expectedExerciseId: "exercise-success-like",
    },
  }) as Array<RouterMessage | null>;

  assert.equal(out[1]?.statusCode, 409);
});

test("subscription confirmation requires explicit active non-cancelled fields", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_router.js", {
    statusCode: 200,
    payload: {
      id: "booking-subscription-implicit",
      paymentType: "SUBSCRIPTION",
      clientSubscriptionId: "client-subscription-implicit",
      client: { id: "client-1", phone: "+79990000001" },
      exercise: { id: "exercise-implicit" },
    },
    _splitCtx: {
      step: "confirm_subscription_booking_lookup",
      action: "confirm_payment",
      operationType: "SUBSCRIPTION_BOOKING",
      operationId: "booking-subscription-implicit",
      bookingId: "booking-subscription-implicit",
      clientId: "client-1",
      expectedExerciseId: "exercise-implicit",
    },
  }) as Array<RouterMessage | null>;

  assert.equal(out[1]?.statusCode, 409);
  assert.equal(
    (out[1]?.payload?.details as Record<string, unknown>)?.code,
    "LEGACY_SUBSCRIPTION_BOOKING_NOT_CONFIRMED",
  );
});

test("payment confirmation rejects fields mixed from sibling provider records", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_router.js", {
    statusCode: 200,
    payload: {
      items: [
        {
          id: "tx-mix-match",
          status: "PAID",
          client: { phone: "+79990000001" },
          products: [{ bookingIds: ["booking-other"] }],
        },
        {
          id: "unrelated-record",
          products: [{
            bookingIds: ["booking-expected"],
            bookingRequests: [{ exerciseId: "exercise-expected" }],
          }],
        },
      ],
    },
    _splitCtx: {
      step: "confirm_transaction_lookup",
      action: "confirm_payment",
      operationType: "TRANSACTION",
      operationId: "tx-mix-match",
      bookingId: "booking-expected",
      clientId: "client-1",
      expectedExerciseId: "exercise-expected",
    },
  }) as Array<RouterMessage | null>;

  assert.equal(out[1]?.statusCode, 409);
});

test("subscription confirmation requires exercise, client and phone on the exact booking", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_router.js", {
    statusCode: 200,
    payload: {
      items: [
        {
          id: "booking-exact",
          isCancelled: false,
          cancelled: false,
          paymentType: "SUBSCRIPTION",
          clientSubscriptionId: "subscription-1",
        },
        {
          id: "booking-sibling",
          client: { id: "client-1", phone: "+79990000001" },
          exercise: { id: "exercise-1" },
        },
      ],
    },
    _splitCtx: {
      step: "confirm_subscription_booking_lookup",
      action: "confirm_payment",
      operationType: "SUBSCRIPTION_BOOKING",
      operationId: "booking-exact",
      bookingId: "booking-exact",
      clientId: "client-1",
      expectedExerciseId: "exercise-1",
    },
  }) as Array<RouterMessage | null>;

  assert.equal(out[1]?.statusCode, 409);
  assert.equal(
    (out[1]?.payload?.details as Record<string, unknown>)?.code,
    "LEGACY_SUBSCRIPTION_BOOKING_NOT_CONFIRMED",
  );
});
