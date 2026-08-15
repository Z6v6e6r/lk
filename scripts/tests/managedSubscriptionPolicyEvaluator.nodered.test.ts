/* eslint-disable @typescript-eslint/no-explicit-any */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import type {
  ManagedSubscriptionBenefitRule,
  ManagedSubscriptionPolicyEvaluationInput,
  ManagedSubscriptionRuntimePolicy,
} from "../../src/types/managedSubscriptionRuntime.ts";

const EVALUATOR_FILE =
  "scripts/nodered_subscription_booking_nodes/fn_managed_subscription_policy_evaluate.js";
const evaluatorSource = fs.readFileSync(EVALUATOR_FILE, "utf8");

function basePolicy(
  overrides: Partial<ManagedSubscriptionRuntimePolicy> = {},
): ManagedSubscriptionRuntimePolicy {
  return {
    runtimeSchemaVersion: 1,
    subscriptionTypeId: "friendship-12m-yasenevo",
    policyVersion: 3,
    status: "PUBLISHED",
    effectiveAt: "2026-08-01T00:00:00.000Z",
    timeZone: "Europe/Moscow",
    createGame: { enabled: true, durationsMinutes: [60, 90, 120] },
    joinGame: { enabled: true, minDurationMinutes: 60, maxDurationMinutes: 120 },
    activeServicesLimit: {
      enabled: true,
      max: 3,
      scope: "SUBSCRIPTION_BENEFIT_ONLY",
    },
    bookingWindow: { enabled: true, days: 4 },
    dailyUsageLimit: 1,
    usageUnitsByDuration: { "60": 1, "90": 1, "120": 1 },
    stationAccessRules: [{
      ruleId: "all-stations",
      enabled: true,
      priority: 1,
      selector: { kind: "ALL_STATIONS", stationIds: [] },
      surcharge: { kind: "NONE", amountMinor: 0 },
    }],
    benefitRules: [],
    lifecycle: { allowBookingsAfterExpiry: false },
    usage: {
      weeklyUsageLimit: null,
      monthlyUsageLimit: null,
      maxFutureBookings: null,
      minHoursBetweenUses: 0,
      blackoutDates: [],
    },
    ...overrides,
  };
}

function benefitRule(
  overrides: Partial<ManagedSubscriptionBenefitRule>,
): ManagedSubscriptionBenefitRule {
  return {
    ruleId: "benefit-rule",
    enabled: true,
    category: "GAME",
    actions: ["CREATE_GAME"],
    externalEventTypeIds: ["open-game"],
    productTypeIds: [],
    durationMinutes: [60],
    stationIds: ["station-home"],
    kind: "DISABLED",
    valueMinor: null,
    percentage: null,
    partialPrice: null,
    priority: 1,
    ...overrides,
  };
}

function baseInput(
  overrides: Partial<ManagedSubscriptionPolicyEvaluationInput> = {},
): ManagedSubscriptionPolicyEvaluationInput {
  return {
    evaluatedAt: "2026-08-14T08:00:00.000Z",
    action: "CREATE_GAME",
    policy: basePolicy(),
    instance: {
      subscriptionInstanceId: "subscription-instance-1",
      subscriptionTypeId: "friendship-12m-yasenevo",
      policyVersion: 3,
      state: "ACTIVE",
      activeFrom: "2026-08-01T00:00:00.000Z",
      activeTo: "2027-08-01T23:59:59.999Z",
      homeStationId: "station-home",
      frozenUntil: null,
      noShowBlockedUntil: null,
    },
    target: {
      resolutionSource: "SERVER",
      stationId: "station-home",
      category: "GAME",
      externalEventTypeId: "open-game",
      productTypeId: null,
      eventId: null,
      durationMinutes: 60,
      startsAt: "2026-08-15T07:00:00.000Z",
      basePriceMinor: null,
      currency: "RUB",
    },
    usage: {
      activeServiceScope: "SUBSCRIPTION_BENEFIT_ONLY",
      dailyBucketLocalDate: "2026-08-15",
      activeServices: 0,
      dailyUsed: 0,
      weeklyUsed: 0,
      monthlyUsed: 0,
      futureBookings: 0,
      activeServiceStartsAt: [],
    },
    ...overrides,
  };
}

function evaluate(input: ManagedSubscriptionPolicyEvaluationInput | Record<string, unknown>) {
  const msg = {
    _managedSubscriptionPolicyInput: structuredClone(input),
  } as Record<string, any>;
  const output = new Function("msg", evaluatorSource)(msg) as Array<Record<string, any> | null>;
  const resultMsg = output[0] || output[1];
  assert.ok(resultMsg, "evaluator must route the message to one output");
  return {
    allowedOutput: output[0],
    blockedOutput: output[1],
    decision: resultMsg._managedSubscriptionPolicyDecision,
  };
}

function blockerCodes(input: ManagedSubscriptionPolicyEvaluationInput | Record<string, unknown>) {
  return evaluate(input).decision.blockers.map((item: { code: string }) => item.code);
}

test("published policy allows a server-resolved 60 minute game", () => {
  const result = evaluate(baseInput());
  assert.ok(result.allowedOutput);
  assert.equal(result.blockedOutput, null);
  assert.equal(result.decision.eligible, true);
  assert.equal(result.decision.policyVersion, 3);
  assert.equal(result.decision.usageUnits, 1);
  assert.deepEqual(result.decision.blockers, []);
  assert.deepEqual(result.decision.benefit, {
    kind: "NONE",
    ruleId: null,
    basePriceMinor: null,
    discountMinor: 0,
    surchargeMinor: 0,
    finalPriceMinor: null,
    partialPriceCalculation: null,
    currency: "RUB",
  });
});

test("client-resolved target and draft or mismatched policy fail closed", () => {
  const input = baseInput();
  (input.target as { resolutionSource: string }).resolutionSource = "CLIENT";
  (input.policy as { status: string }).status = "DRAFT";
  input.instance.subscriptionTypeId = "another-subscription-type";
  input.instance.policyVersion = 2;
  assert.deepEqual(
    blockerCodes(input).filter((code: string) => [
      "TARGET_NOT_SERVER_RESOLVED",
      "POLICY_NOT_PUBLISHED",
      "SUBSCRIPTION_TYPE_MISMATCH",
      "POLICY_VERSION_MISMATCH",
    ].includes(code)),
    [
      "POLICY_NOT_PUBLISHED",
      "SUBSCRIPTION_TYPE_MISMATCH",
      "POLICY_VERSION_MISMATCH",
      "TARGET_NOT_SERVER_RESOLVED",
    ],
  );
});

test("currency, active-service scope and target-day usage bucket must match", () => {
  const input = baseInput({
    target: { ...baseInput().target, currency: "USD" as "RUB" },
    usage: {
      ...baseInput().usage,
      activeServiceScope: "ALL_BOOKINGS",
      dailyBucketLocalDate: "2026-08-16",
    },
  });
  const codes = blockerCodes(input);
  assert.ok(codes.includes("CURRENCY_UNSUPPORTED"));
  assert.ok(codes.includes("ACTIVE_SERVICE_SCOPE_MISMATCH"));
  assert.ok(codes.includes("USAGE_SNAPSHOT_BUCKET_MISMATCH"));
});

test("create toggle and duration allow-list are independent", () => {
  const disabled = baseInput({
    policy: basePolicy({ createGame: { enabled: false, durationsMinutes: [] } }),
  });
  assert.ok(blockerCodes(disabled).includes("SUBSCRIPTION_CREATE_DISABLED"));

  const wrongDuration = baseInput({
    policy: basePolicy({ createGame: { enabled: true, durationsMinutes: [60] } }),
    target: { ...baseInput().target, durationMinutes: 90 },
  });
  assert.ok(blockerCodes(wrongDuration).includes("DURATION_NOT_ALLOWED"));
});

test("join applies enabled flag and configured duration range", () => {
  const allowed = baseInput({
    action: "JOIN_GAME",
    policy: basePolicy({
      joinGame: { enabled: true, minDurationMinutes: 60, maxDurationMinutes: 90 },
    }),
    target: { ...baseInput().target, durationMinutes: 90, eventId: "event-1" },
  });
  assert.equal(evaluate(allowed).decision.eligible, true);

  const blocked = {
    ...allowed,
    target: { ...allowed.target, durationMinutes: 120 },
  };
  assert.ok(blockerCodes(blocked).includes("DURATION_NOT_ALLOWED"));
});

test("active-service and duration-unit daily limits include current reservations", () => {
  const activeLimit = baseInput({
    usage: { ...baseInput().usage, activeServices: 3 },
  });
  assert.ok(blockerCodes(activeLimit).includes("ACTIVE_SERVICES_LIMIT_REACHED"));

  const dailyLimit = baseInput({
    policy: basePolicy({
      dailyUsageLimit: 2,
      usageUnitsByDuration: { "60": 1, "90": 2, "120": 3 },
    }),
    target: { ...baseInput().target, durationMinutes: 90 },
    usage: { ...baseInput().usage, dailyUsed: 1 },
  });
  const result = evaluate(dailyLimit);
  assert.equal(result.decision.usageUnits, 2);
  assert.ok(result.decision.blockers.some(
    (item: { code: string }) => item.code === "DAILY_USAGE_LIMIT_REACHED",
  ));
});

test("active-service maximum can be disabled without requiring a limit or scope match", () => {
  const input = baseInput({
    policy: basePolicy({
      activeServicesLimit: {
        enabled: false,
        max: null,
        scope: "SUBSCRIPTION_BENEFIT_ONLY",
      },
    }),
    usage: {
      ...baseInput().usage,
      activeServiceScope: "ALL_BOOKINGS",
      activeServices: null,
    },
  });
  const result = evaluate(input);
  assert.equal(result.decision.eligible, true);
  assert.equal(result.decision.activeServices, null);
  assert.equal(result.decision.maxActiveServices, null);
  assert.ok(!blockerCodes(input).includes("ACTIVE_SERVICES_LIMIT_REACHED"));
});

test("enabled active-service limit treats a missing counter as invalid instead of zero", () => {
  const input = baseInput({
    usage: { ...baseInput().usage, activeServices: null },
  });
  const codes = blockerCodes(input);
  assert.ok(codes.includes("USAGE_SNAPSHOT_INVALID"));
  assert.ok(codes.includes("ACTIVE_SERVICES_LIMIT_INVALID"));
});

test("bookingWindowDays uses station-local calendar dates", () => {
  const atMoscowLateNight = baseInput({
    evaluatedAt: "2026-08-14T20:30:00.000Z",
    target: {
      ...baseInput().target,
      startsAt: "2026-08-17T20:59:00.000Z",
    },
    usage: { ...baseInput().usage, dailyBucketLocalDate: "2026-08-17" },
  });
  assert.equal(evaluate(atMoscowLateNight).decision.eligible, true);

  const outsideFourthDay = {
    ...atMoscowLateNight,
    target: {
      ...atMoscowLateNight.target,
      startsAt: "2026-08-17T21:01:00.000Z",
    },
    usage: { ...atMoscowLateNight.usage, dailyBucketLocalDate: "2026-08-18" },
  };
  assert.ok(blockerCodes(outsideFourthDay).includes("BOOKING_WINDOW_EXCEEDED"));
});

test("booking window can be disabled while target-day bucket validation remains active", () => {
  const input = baseInput({
    policy: basePolicy({ bookingWindow: { enabled: false, days: null } }),
    target: { ...baseInput().target, startsAt: "2026-12-20T07:00:00.000Z" },
    usage: { ...baseInput().usage, dailyBucketLocalDate: "2026-12-20" },
  });
  assert.equal(evaluate(input).decision.eligible, true);
  assert.ok(!blockerCodes(input).includes("BOOKING_WINDOW_EXCEEDED"));

  const invalidZone = {
    ...input,
    policy: { ...input.policy, timeZone: "Invalid/Zone" },
  };
  assert.ok(blockerCodes(invalidZone).includes("TARGET_LOCAL_DATE_UNRESOLVED"));
});

test("group training requires exact event-type and station rule and calculates percent discount", () => {
  const rule = benefitRule({
    ruleId: "group-yasenevo-20",
    enabled: true,
    category: "GROUP_TRAINING" as const,
    actions: ["BOOK_GROUP_TRAINING"],
    externalEventTypeIds: ["group-d"],
    durationMinutes: [60],
    stationIds: ["station-home"],
    kind: "PERCENT_DISCOUNT" as const,
    valueMinor: null,
    percentage: 20,
    priority: 100,
  });
  const input = baseInput({
    action: "BOOK_GROUP_TRAINING",
    policy: basePolicy({ benefitRules: [rule] }),
    target: {
      ...baseInput().target,
      category: "GROUP_TRAINING",
      externalEventTypeId: "group-d",
      eventId: "group-event-1",
      basePriceMinor: 500000,
    },
  });
  const result = evaluate(input);
  assert.equal(result.decision.eligible, true);
  assert.deepEqual(result.decision.benefit, {
    kind: "PERCENT_DISCOUNT",
    ruleId: "group-yasenevo-20",
    basePriceMinor: 500000,
    discountMinor: 100000,
    surchargeMinor: 0,
    finalPriceMinor: 400000,
    partialPriceCalculation: null,
    currency: "RUB",
  });

  const wrongType = {
    ...input,
    target: { ...input.target, externalEventTypeId: "unknown-group" },
  };
  assert.ok(blockerCodes(wrongType).includes("EVENT_NOT_INCLUDED"));
});

for (const scenario of [
  {
    name: "free entitlement",
    kind: "FREE_ENTITLEMENT" as const,
    valueMinor: null,
    expectedDiscount: 300000,
    expectedFinal: 0,
  },
  {
    name: "fixed price",
    kind: "FIXED_PRICE" as const,
    valueMinor: 180000,
    expectedDiscount: 120000,
    expectedFinal: 180000,
  },
  {
    name: "fixed discount",
    kind: "FIXED_DISCOUNT" as const,
    valueMinor: 50000,
    expectedDiscount: 50000,
    expectedFinal: 250000,
  },
]) {
  test(`benefit pricing supports ${scenario.name} in RUB minor units`, () => {
    const input = baseInput({
      action: "BOOK_GROUP_TRAINING",
      policy: basePolicy({
        benefitRules: [benefitRule({
          ruleId: `group-${scenario.kind.toLowerCase()}`,
          enabled: true,
          category: "GROUP_TRAINING",
          actions: ["BOOK_GROUP_TRAINING"],
          externalEventTypeIds: ["group-d"],
          durationMinutes: [60],
          stationIds: ["station-home"],
          kind: scenario.kind,
          valueMinor: scenario.valueMinor,
          percentage: null,
          priority: 100,
        })],
      }),
      target: {
        ...baseInput().target,
        category: "GROUP_TRAINING",
        externalEventTypeId: "group-d",
        eventId: "group-event-price",
        basePriceMinor: 300000,
      },
    });
    const result = evaluate(input);
    assert.equal(result.decision.eligible, true);
    assert.equal(result.decision.benefit.discountMinor, scenario.expectedDiscount);
    assert.equal(result.decision.benefit.finalPriceMinor, scenario.expectedFinal);
  });
}

test("disabled game benefit keeps create entitlement but disables only the discount", () => {
  const input = baseInput({
    policy: basePolicy({
      benefitRules: [benefitRule({
        ruleId: "game-discount-off",
        enabled: true,
        category: "GAME",
        externalEventTypeIds: ["open-game"],
        stationIds: ["station-home"],
        kind: "DISABLED",
        valueMinor: null,
        percentage: null,
        priority: 10,
      })],
    }),
    target: { ...baseInput().target, basePriceMinor: 100000 },
  });
  const result = evaluate(input);
  assert.equal(result.decision.eligible, true);
  assert.equal(result.decision.benefit.kind, "NONE");
  assert.equal(result.decision.benefit.finalPriceMinor, 100000);
});

test("home-only station blocks cross-station use and surcharge mode adds exact minor amount", () => {
  const blocked = baseInput({
    policy: basePolicy({
      stationAccessRules: [{
        ruleId: "home-only",
        enabled: true,
        priority: 100,
        selector: { kind: "HOME_STATION", stationIds: [] },
        surcharge: { kind: "NONE", amountMinor: 0 },
      }],
    }),
    target: { ...baseInput().target, stationId: "station-other" },
  });
  assert.ok(blockerCodes(blocked).includes("STATION_NOT_ALLOWED"));

  const surcharge = baseInput({
    policy: basePolicy({
      stationAccessRules: [{
        ruleId: "other-stations-150",
        enabled: true,
        priority: 100,
        selector: { kind: "STATION_LIST", stationIds: ["station-other"] },
        surcharge: { kind: "FIXED", amountMinor: 15000 },
      }],
    }),
    target: {
      ...baseInput().target,
      stationId: "station-other",
      basePriceMinor: 100000,
    },
  });
  const result = evaluate(surcharge);
  assert.equal(result.decision.eligible, true);
  assert.equal(result.decision.benefit.surchargeMinor, 15000);
  assert.equal(result.decision.benefit.finalPriceMinor, 115000);
});

test("ordered station rows support different station groups and exact surcharges", () => {
  const stationAccessRules = [
    {
      ruleId: "home-free",
      enabled: true,
      priority: 300,
      selector: { kind: "HOME_STATION" as const, stationIds: [] as [] },
      surcharge: { kind: "NONE" as const, amountMinor: 0 },
    },
    {
      ruleId: "group-a-150",
      enabled: true,
      priority: 200,
      selector: { kind: "STATION_LIST" as const, stationIds: ["station-a", "station-b"] },
      surcharge: { kind: "FIXED" as const, amountMinor: 15000 },
    },
    {
      ruleId: "group-b-300",
      enabled: true,
      priority: 100,
      selector: { kind: "STATION_LIST" as const, stationIds: ["station-c"] },
      surcharge: { kind: "FIXED" as const, amountMinor: 30000 },
    },
  ];
  const stationA = baseInput({
    policy: basePolicy({ stationAccessRules }),
    target: { ...baseInput().target, stationId: "station-a", basePriceMinor: 100000 },
  });
  const stationC = baseInput({
    policy: basePolicy({ stationAccessRules }),
    target: { ...baseInput().target, stationId: "station-c", basePriceMinor: 100000 },
  });
  assert.equal(evaluate(stationA).decision.benefit.surchargeMinor, 15000);
  assert.equal(evaluate(stationC).decision.benefit.surchargeMinor, 30000);
  assert.ok(blockerCodes(baseInput({
    policy: basePolicy({ stationAccessRules }),
    target: { ...baseInput().target, stationId: "station-x" },
  })).includes("STATION_NOT_ALLOWED"));
});

test("90 minute create can charge one quarter of full price with an additional percent discount", () => {
  const input = baseInput({
    policy: basePolicy({
      benefitRules: [
        benefitRule({
          ruleId: "create-60-free",
          actions: ["CREATE_GAME"],
          durationMinutes: [60],
          kind: "FREE_ENTITLEMENT",
          priority: 100,
        }),
        benefitRule({
          ruleId: "create-90-quarter-minus-20",
          actions: ["CREATE_GAME"],
          durationMinutes: [90],
          kind: "PARTIAL_PRICE_PERCENT_DISCOUNT",
          percentage: 20,
          partialPrice: { numerator: 1, denominator: 4 },
          priority: 100,
        }),
      ],
    }),
    target: { ...baseInput().target, durationMinutes: 90, basePriceMinor: 400000 },
  });
  const result = evaluate(input);
  assert.equal(result.decision.eligible, true);
  assert.equal(result.decision.benefit.discountMinor, 20000);
  assert.equal(result.decision.benefit.finalPriceMinor, 80000);
  assert.deepEqual(result.decision.benefit.partialPriceCalculation, {
    numerator: 1,
    denominator: 4,
    chargeBeforeDiscountMinor: 100000,
  });

  const sixtyMinutes = {
    ...input,
    target: { ...input.target, durationMinutes: 60 },
  };
  assert.equal(evaluate(sixtyMinutes).decision.benefit.finalPriceMinor, 0);
});

test("add-on product benefit requires exact product, event type and station", () => {
  const input = baseInput({
    action: "PURCHASE_ADD_ON_PRODUCT",
    policy: basePolicy({
      benefitRules: [benefitRule({
        ruleId: "racket-rental-fixed-price",
        category: "ADD_ON_PRODUCT",
        actions: ["PURCHASE_ADD_ON_PRODUCT"],
        externalEventTypeIds: ["rental"],
        productTypeIds: ["racket-rental"],
        durationMinutes: [60],
        kind: "FIXED_PRICE",
        valueMinor: 30000,
        priority: 100,
      })],
    }),
    target: {
      ...baseInput().target,
      category: "ADD_ON_PRODUCT",
      externalEventTypeId: "rental",
      productTypeId: "racket-rental",
      eventId: "add-on-1",
      basePriceMinor: 50000,
    },
  });
  assert.equal(evaluate(input).decision.benefit.finalPriceMinor, 30000);
  assert.ok(blockerCodes({
    ...input,
    target: { ...input.target, productTypeId: "balls" },
  }).includes("EVENT_NOT_INCLUDED"));
});

test("freeze, expiry, no-show block and blackout date are separate blockers", () => {
  const input = baseInput({
    instance: {
      ...baseInput().instance,
      state: "FROZEN",
      frozenUntil: "2026-08-20T00:00:00.000Z",
      noShowBlockedUntil: "2026-08-21T00:00:00.000Z",
      activeTo: "2026-08-14T09:00:00.000Z",
    },
    policy: basePolicy({
      usage: { ...basePolicy().usage, blackoutDates: ["2026-08-15"] },
    }),
  });
  const codes = blockerCodes(input);
  assert.ok(codes.includes("SUBSCRIPTION_FROZEN"));
  assert.ok(codes.includes("SUBSCRIPTION_NO_SHOW_BLOCKED"));
  assert.ok(codes.includes("TARGET_AFTER_SUBSCRIPTION_EXPIRY"));
  assert.ok(codes.includes("SUBSCRIPTION_BLACKOUT_DATE"));
});

test("weekly, monthly, future-booking and minimum-interval limits are enforced independently", () => {
  const input = baseInput({
    policy: basePolicy({
      dailyUsageLimit: 10,
      usage: {
        ...basePolicy().usage,
        weeklyUsageLimit: 4,
        monthlyUsageLimit: 8,
        maxFutureBookings: 2,
        minHoursBetweenUses: 3,
      },
    }),
    usage: {
      ...baseInput().usage,
      weeklyUsed: 4,
      monthlyUsed: 8,
      futureBookings: 2,
      activeServiceStartsAt: ["2026-08-15T08:00:00.000Z"],
    },
  });
  const codes = blockerCodes(input);
  assert.ok(codes.includes("WEEKLY_USAGE_LIMIT_REACHED"));
  assert.ok(codes.includes("MONTHLY_USAGE_LIMIT_REACHED"));
  assert.ok(codes.includes("FUTURE_BOOKINGS_LIMIT_REACHED"));
  assert.ok(codes.includes("MIN_USE_INTERVAL_NOT_MET"));
});

test("invalid active-service timestamp is not ignored by minimum-interval check", () => {
  const input = baseInput({
    policy: basePolicy({
      usage: { ...basePolicy().usage, minHoursBetweenUses: 3 },
    }),
    usage: {
      ...baseInput().usage,
      activeServiceStartsAt: ["not-a-date"],
    },
  });
  assert.ok(blockerCodes(input).includes("ACTIVE_SERVICE_TIMES_INVALID"));
});

test("invalid lifecycle timestamps and benefit priority fail closed", () => {
  const input = baseInput({
    instance: {
      ...baseInput().instance,
      frozenUntil: "not-a-date",
      noShowBlockedUntil: "also-not-a-date",
    },
    policy: basePolicy({
      benefitRules: [benefitRule({
        ruleId: "invalid-priority",
        enabled: true,
        category: "GAME",
        externalEventTypeIds: ["open-game"],
        stationIds: ["station-home"],
        kind: "DISABLED",
        valueMinor: null,
        percentage: null,
        priority: Number.NaN,
      })],
    }),
  });
  const codes = blockerCodes(input);
  assert.ok(codes.includes("SUBSCRIPTION_FREEZE_STATE_INVALID"));
  assert.ok(codes.includes("SUBSCRIPTION_NO_SHOW_STATE_INVALID"));
  assert.ok(codes.includes("BENEFIT_RULE_PRIORITY_INVALID"));
});

test("equal-priority overlapping benefit rules fail closed", () => {
  const shared = benefitRule({
    enabled: true,
    category: "GROUP_TRAINING" as const,
    actions: ["BOOK_GROUP_TRAINING"],
    externalEventTypeIds: ["group-d"],
    durationMinutes: [60],
    stationIds: ["station-home"],
    kind: "FIXED_PRICE" as const,
    valueMinor: 200000,
    percentage: null,
    priority: 50,
  });
  const input = baseInput({
    action: "BOOK_GROUP_TRAINING",
    policy: basePolicy({
      benefitRules: [
        { ...shared, ruleId: "rule-a" },
        { ...shared, ruleId: "rule-b" },
      ],
    }),
    target: {
      ...baseInput().target,
      category: "GROUP_TRAINING",
      externalEventTypeId: "group-d",
      basePriceMinor: 300000,
    },
  });
  assert.ok(blockerCodes(input).includes("AMBIGUOUS_BENEFIT_RULE"));
});

test("price-based benefit fails closed without server base price", () => {
  const input = baseInput({
    action: "BOOK_TOURNAMENT",
    policy: basePolicy({
      benefitRules: [benefitRule({
        ruleId: "tournament-discount",
        enabled: true,
        category: "TOURNAMENT",
        actions: ["BOOK_TOURNAMENT"],
        externalEventTypeIds: ["americano"],
        durationMinutes: [60],
        stationIds: ["station-home"],
        kind: "FIXED_DISCOUNT",
        valueMinor: 50000,
        percentage: null,
        priority: 10,
      })],
    }),
    target: {
      ...baseInput().target,
      category: "TOURNAMENT",
      externalEventTypeId: "americano",
      basePriceMinor: null,
    },
  });
  assert.ok(blockerCodes(input).includes("BASE_PRICE_UNRESOLVED"));
});

test("malformed evaluator context routes to blocked output without throwing", () => {
  const result = evaluate({});
  assert.equal(result.allowedOutput, null);
  assert.ok(result.blockedOutput);
  assert.deepEqual(
    result.decision.blockers.map((item: { code: string }) => item.code),
    ["MANAGED_SUBSCRIPTION_CONTEXT_INVALID"],
  );
});
