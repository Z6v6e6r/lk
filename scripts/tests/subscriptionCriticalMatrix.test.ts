import test from "node:test";
import assert from "node:assert/strict";
import type { ApiError, PadelSplitPaymentResult } from "../../src/utils/apiClient.ts";
import {
  collectSubscriptionDecisionCodes,
  resolveSubscriptionDecisionPresentation,
  type SubscriptionDecisionAction,
  type SubscriptionDecisionKind,
} from "../../src/utils/subscriptionDecisionUi.ts";

const result = (overrides: Partial<PadelSplitPaymentResult> = {}): PadelSplitPaymentResult => ({
  paymentRef: "pay:test",
  paymentUrl: null,
  toPay: 0,
  toPayMinor: 0,
  shareAmount: 0,
  shareAmountMinor: 0,
  baseShareAmount: 0,
  baseShareAmountMinor: 0,
  discountAmount: 0,
  discountAmountMinor: 0,
  deadlineAt: null,
  exerciseId: "exercise:test",
  bookingId: "booking:test",
  productId: "product:test",
  transactionId: null,
  spot: 1,
  directionId: 4588,
  exerciseTypeId: 1613,
  totalAmount: 0,
  oneTimeBaseAmount: 0,
  assembleDeadlineAt: null,
  selectedPaymentMode: "subscription",
  paymentModes: [],
  subscriptionProductId: "subscription-product:test",
  subscriptionProductName: "Годовая подписка",
  oneTimeProductId: "one-time-product:test",
  oneTimeProductName: "Разовая оплата",
  pricingPolicy: null,
  raw: { ok: true, state: "CONFIRMED" },
  ...overrides,
});

const error = (
  code: string,
  status = 409,
  message = "Сервер отклонил действие",
): ApiError => ({
  status,
  message,
  raw: { error: message, details: { code } },
});

test("nested decision codes are extracted without treating arbitrary messages as codes", () => {
  assert.deepEqual(
    collectSubscriptionDecisionCodes({
      state: "PENDING_CONFIRMATION",
      blockers: [{ code: "ACTIVE_SERVICES_LIMIT_REACHED", message: "Лимит исчерпан" }],
      error: "Неизвестная ошибка",
    }),
    ["PENDING_CONFIRMATION", "ACTIVE_SERVICES_LIMIT_REACHED"],
  );
});

const errorCases: Array<{
  id: string;
  action: SubscriptionDecisionAction;
  apiError: ApiError;
  expected: SubscriptionDecisionKind;
  retryable: boolean;
  continueWithoutSubscription: boolean;
  message: RegExp;
}> = [
  {
    id: "NS-NO-FALSE-APPLY",
    action: "CREATE_GAME",
    apiError: error("SUBSCRIPTION_SELECTION_REQUIRED", 400),
    expected: "SUBSCRIPTION_INVALID",
    retryable: false,
    continueWithoutSubscription: true,
    message: /Сервер отклонил действие/,
  },
  {
    id: "AS-CONSUMED",
    action: "JOIN_GAME",
    apiError: error("SUBSCRIPTION_CATEGORY_DAILY_LIMIT_REACHED", 409, "Лимит использован"),
    expected: "LIMIT_USED",
    retryable: false,
    continueWithoutSubscription: true,
    message: /Лимит использован/,
  },
  {
    id: "EDGE-ALREADY-JOINED",
    action: "JOIN_GAME",
    apiError: error("GAME_ALREADY_JOINED"),
    expected: "ACTION_UNAVAILABLE",
    retryable: false,
    continueWithoutSubscription: false,
    message: /уже участвуете/,
  },
  {
    id: "EDGE-FULL",
    action: "JOIN_GAME",
    apiError: error("GAME_FULL"),
    expected: "ACTION_UNAVAILABLE",
    retryable: false,
    continueWithoutSubscription: false,
    message: /нет свободных мест/,
  },
  {
    id: "EDGE-STALE",
    action: "CREATE_GAME",
    apiError: error("REVISION_CONFLICT"),
    expected: "STALE_STATE",
    retryable: true,
    continueWithoutSubscription: false,
    message: /Обновите игру|Обновите.*время/,
  },
  {
    id: "EDGE-EXPIRED",
    action: "JOIN_GAME",
    apiError: error("TARGET_AFTER_SUBSCRIPTION_EXPIRY"),
    expected: "SUBSCRIPTION_INVALID",
    retryable: false,
    continueWithoutSubscription: true,
    message: /Сервер отклонил действие/,
  },
  {
    id: "EDGE-MISSING-INSTANCE",
    action: "CREATE_GAME",
    apiError: error("MANAGED_SUBSCRIPTION_INSTANCE_NOT_FOUND"),
    expected: "SUBSCRIPTION_INVALID",
    retryable: false,
    continueWithoutSubscription: true,
    message: /Сервер отклонил действие/,
  },
  {
    id: "EDGE-NO-SUBSCRIPTIONS-LEGACY-CONTRACT",
    action: "JOIN_GAME",
    apiError: { status: 400, message: "No subscriptions available", raw: null },
    expected: "SUBSCRIPTION_INVALID",
    retryable: false,
    continueWithoutSubscription: true,
    message: /No subscriptions available/,
  },
  {
    id: "EDGE-BACKEND-UNAVAILABLE",
    action: "JOIN_GAME",
    apiError: error("BACKEND_UNAVAILABLE", 503),
    expected: "TECHNICAL_ERROR",
    retryable: true,
    continueWithoutSubscription: false,
    message: /не удалось подтвердить условия/i,
  },
  {
    id: "EDGE-RUNTIME-UNKNOWN",
    action: "CREATE_GAME",
    apiError: error("UNRECOGNISED_NEW_SERVER_CODE", 418),
    expected: "TECHNICAL_ERROR",
    retryable: true,
    continueWithoutSubscription: false,
    message: /Сервер не подтвердил условия/i,
  },
  {
    id: "EDGE-TIMEOUT-RETRY",
    action: "JOIN_GAME",
    apiError: error("REQUEST_TIMEOUT", 503),
    expected: "TECHNICAL_ERROR",
    retryable: true,
    continueWithoutSubscription: false,
    message: /не удалось подтвердить условия/i,
  },
  {
    id: "AS-PENDING-REPLAY",
    action: "CREATE_GAME",
    apiError: error("PENDING_CONFIRMATION", 202),
    expected: "PENDING_CONFIRMATION",
    retryable: true,
    continueWithoutSubscription: false,
    message: /новая льгота не спишется/i,
  },
  {
    id: "AS-CONFIRM-PENDING-REPLAY",
    action: "JOIN_GAME",
    apiError: error("SUBSCRIPTION_ENTITLEMENT_CONFIRM_PENDING", 202),
    expected: "PENDING_CONFIRMATION",
    retryable: true,
    continueWithoutSubscription: false,
    message: /новая льгота не спишется/i,
  },
  {
    id: "DUR-INVALID",
    action: "CREATE_GAME",
    apiError: error("DURATION_NOT_ALLOWED", 409),
    expected: "ACTION_UNAVAILABLE",
    retryable: false,
    continueWithoutSubscription: false,
    message: /Сервер отклонил действие/,
  },
];

for (const scenario of errorCases) {
  test(`${scenario.id}: deterministic error decision`, () => {
    const presentation = resolveSubscriptionDecisionPresentation({
      action: scenario.action,
      requestedPaymentMode: "subscription",
      durationMinutes: 60,
      error: scenario.apiError,
    });
    assert.equal(presentation.kind, scenario.expected);
    assert.equal(presentation.retryable, scenario.retryable);
    assert.equal(
      presentation.continueWithoutSubscription,
      scenario.continueWithoutSubscription,
    );
    assert.equal(presentation.subscriptionApplied, false);
    assert.match(presentation.message, scenario.message);
    assert.notEqual(presentation.reasonCode, "");
  });
}

test("NS-CREATE and NS-PAYMENT: ordinary create never claims subscription", () => {
  const presentation = resolveSubscriptionDecisionPresentation({
    action: "CREATE_GAME",
    requestedPaymentMode: "one_time",
    result: result({
      paymentUrl: "https://payments.invalid/test",
      toPay: 1_500,
      toPayMinor: 150_000,
      selectedPaymentMode: "one_time",
    }),
  });
  assert.equal(presentation.kind, "ORDINARY_PAYMENT_ALLOWED");
  assert.equal(presentation.subscriptionApplied, false);
  assert.match(presentation.message, /Создание игры.*1\s*500/);
});

test("NS-JOIN: ordinary join never claims subscription", () => {
  const presentation = resolveSubscriptionDecisionPresentation({
    action: "JOIN_GAME",
    requestedPaymentMode: "one_time",
    result: result({ toPay: 500, toPayMinor: 50_000, selectedPaymentMode: "one_time" }),
  });
  assert.equal(presentation.kind, "ORDINARY_PAYMENT_ALLOWED");
  assert.equal(presentation.subscriptionApplied, false);
  assert.match(presentation.message, /Присоединение к игре.*500/);
});

for (const action of ["CREATE_GAME", "JOIN_GAME"] as const) {
  test(`AS-${action}: zero-price subscription action is explicitly allowed`, () => {
    const presentation = resolveSubscriptionDecisionPresentation({
      action,
      requestedPaymentMode: "subscription",
      durationMinutes: 60,
      result: result(),
    });
    assert.equal(presentation.kind, "SUBSCRIPTION_ALLOWED");
    assert.equal(presentation.subscriptionApplied, true);
    assert.match(presentation.title, /Можно по подписке/);
  });
}

for (const [id, duration, amountMinor, extra] of [
  ["DUR-30", 90, 52_500, 30],
  ["DUR-60", 120, 105_000, 60],
] as const) {
  test(`${id}: extra duration has an exact additional-payment answer`, () => {
    const presentation = resolveSubscriptionDecisionPresentation({
      action: "CREATE_GAME",
      requestedPaymentMode: "subscription",
      durationMinutes: duration,
      result: result({ toPay: amountMinor / 100, toPayMinor: amountMinor }),
    });
    assert.equal(presentation.kind, "ADDITIONAL_PAYMENT_REQUIRED");
    assert.equal(presentation.subscriptionApplied, true);
    assert.match(presentation.message, new RegExp(`доплата за ${extra} минут`, "i"));
    assert.match(presentation.message, new RegExp(amountMinor === 52_500 ? "525" : "1\\s*050"));
  });
}

test("LIMIT_ENFORCEMENT: server full-price fallback is never shown as a subscription discount", () => {
  const presentation = resolveSubscriptionDecisionPresentation({
    action: "CREATE_GAME",
    requestedPaymentMode: "subscription",
    result: result({
      selectedPaymentMode: "one_time",
      toPay: 1_500,
      toPayMinor: 150_000,
      raw: {
        state: "FULL_PRICE_WITHOUT_SUBSCRIPTION",
        blockers: [{ code: "ACTIVE_SERVICES_LIMIT_REACHED" }],
      },
    }),
  });
  assert.equal(presentation.kind, "LIMIT_USED");
  assert.equal(presentation.subscriptionApplied, false);
  assert.equal(presentation.continueWithoutSubscription, true);
  assert.match(presentation.message, /полной стоимости.*1\s*500/i);
});

test("UNKNOWN_P0=0: an absent or malformed response is a known fail-closed technical state", () => {
  const presentation = resolveSubscriptionDecisionPresentation({
    action: "JOIN_GAME",
    requestedPaymentMode: "subscription",
    result: null,
    error: null,
  });
  assert.equal(presentation.kind, "TECHNICAL_ERROR");
  assert.equal(presentation.subscriptionApplied, false);
  assert.equal(presentation.reasonCode, "RESPONSE_CONTRACT_INVALID");

  const missingSelectedMode = resolveSubscriptionDecisionPresentation({
    action: "JOIN_GAME",
    requestedPaymentMode: "subscription",
    result: result({ selectedPaymentMode: null, raw: { ok: true } }),
  });
  assert.equal(missingSelectedMode.kind, "TECHNICAL_ERROR");
  assert.equal(missingSelectedMode.subscriptionApplied, false);
  assert.equal(missingSelectedMode.reasonCode, "RESPONSE_CONTRACT_INVALID");

  const missingBookingEvidence = resolveSubscriptionDecisionPresentation({
    action: "CREATE_GAME",
    requestedPaymentMode: "subscription",
    result: result({ bookingId: null, paymentUrl: null }),
  });
  assert.equal(missingBookingEvidence.kind, "TECHNICAL_ERROR");
  assert.equal(missingBookingEvidence.subscriptionApplied, false);
});
