import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  buildAnnualShadowPolicySource,
  buildShadowBookingOutcome,
  compileDraftPolicy,
  createManagedSubscriptionDevRuntime,
  loadPolicyFromCup,
  resolveShadowIntent,
} from "../managed_subscription_dev_runtime.ts";

const draftPolicy = () => ({
  subscriptionTypeId: "subscription_type:dev-friendship",
  version: 1,
  status: "DRAFT",
  modelVersion: 3,
  effectiveAt: "2026-08-15T00:00:00.000Z",
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
  stationAccessRules: [
    {
      ruleId: "home-free",
      enabled: true,
      priority: 300,
      selector: { kind: "HOME_STATION", stationIds: [] },
      surcharge: { kind: "NONE", amountMinor: 0 },
    },
    {
      ruleId: "selected-plus-150",
      enabled: true,
      priority: 200,
      selector: { kind: "STATION_LIST", stationIds: ["dev-station-a", "dev-station-b"] },
      surcharge: { kind: "FIXED", amountMinor: 15_000 },
    },
  ],
  benefitRules: [
    {
      ruleId: "create-60-free",
      enabled: true,
      category: "GAME",
      actions: ["CREATE_GAME"],
      externalEventTypeIds: ["dev-open-game"],
      productTypeIds: [],
      durationMinutes: [60],
      stationIds: ["dev-station-a"],
      kind: "FREE_ENTITLEMENT",
      valueMinor: null,
      percentage: null,
      partialPrice: null,
      priority: 100,
    },
    {
      ruleId: "create-90-quarter-minus-20",
      enabled: true,
      category: "GAME",
      actions: ["CREATE_GAME"],
      externalEventTypeIds: ["dev-open-game"],
      productTypeIds: [],
      durationMinutes: [90],
      stationIds: ["dev-station-a"],
      kind: "PARTIAL_PRICE_PERCENT_DISCOUNT",
      valueMinor: null,
      percentage: 20,
      partialPrice: { numerator: 1, denominator: 4 },
      priority: 90,
    },
    {
      ruleId: "racket-discount",
      enabled: true,
      category: "ADD_ON_PRODUCT",
      actions: ["PURCHASE_ADD_ON_PRODUCT"],
      externalEventTypeIds: ["dev-rental-event"],
      productTypeIds: ["dev-racket-rental"],
      durationMinutes: [60],
      stationIds: ["dev-station-a"],
      kind: "PERCENT_DISCOUNT",
      valueMinor: null,
      percentage: 10,
      partialPrice: null,
      priority: 80,
    },
  ],
  capabilities: {
    lifecycle: { allowBookingsAfterExpiry: false },
    usage: {
      weeklyUsageLimit: null,
      monthlyUsageLimit: null,
      maxFutureBookings: null,
      minHoursBetweenUses: 0,
      blackoutDates: [],
    },
  },
});

const annualDraftPolicy = () => ({
  ...draftPolicy(),
  activeServicesLimit: {
    enabled: true,
    max: 4,
    scope: "SUBSCRIPTION_BENEFIT_ONLY",
  },
  dailyUsagePolicy: {
    actions: ["CREATE_GAME", "JOIN_GAME"],
    limitExceeded: "PERCENT_DISCOUNT",
    percentage: 30,
  },
  stationAccessRules: [{
    ruleId: "annual-all-dev-stations",
    enabled: true,
    priority: 100,
    selector: { kind: "ALL_STATIONS", stationIds: [] },
    surcharge: { kind: "NONE", amountMinor: 0 },
  }],
  benefitRules: [{
    ruleId: "annual-game-60-free",
    enabled: true,
    category: "GAME",
    actions: ["CREATE_GAME", "JOIN_GAME"],
    externalEventTypeIds: ["dev-open-game"],
    productTypeIds: [],
    durationMinutes: [60],
    stationIds: ["dev-station-a", "dev-station-b", "dev-station-home"],
    kind: "FREE_ENTITLEMENT",
    valueMinor: null,
    percentage: null,
    partialPrice: null,
    priority: 100,
  }, {
    ruleId: "annual-game-90-excess-minus-30",
    enabled: true,
    category: "GAME",
    actions: ["CREATE_GAME", "JOIN_GAME"],
    externalEventTypeIds: ["dev-open-game"],
    productTypeIds: [],
    durationMinutes: [90],
    stationIds: ["dev-station-a", "dev-station-b", "dev-station-home"],
    kind: "PARTIAL_PRICE_PERCENT_DISCOUNT",
    valueMinor: null,
    percentage: 30,
    partialPrice: { numerator: 1, denominator: 3 },
    priority: 100,
  }, {
    ruleId: "annual-game-120-excess-minus-30",
    enabled: true,
    category: "GAME",
    actions: ["CREATE_GAME", "JOIN_GAME"],
    externalEventTypeIds: ["dev-open-game"],
    productTypeIds: [],
    durationMinutes: [120],
    stationIds: ["dev-station-a", "dev-station-b", "dev-station-home"],
    kind: "PARTIAL_PRICE_PERCENT_DISCOUNT",
    valueMinor: null,
    percentage: 30,
    partialPrice: { numerator: 1, denominator: 2 },
    priority: 100,
  }, {
    ruleId: "annual-group-minus-50",
    enabled: true,
    category: "GROUP_TRAINING",
    actions: ["BOOK_GROUP_TRAINING"],
    externalEventTypeIds: ["dev-group-training"],
    productTypeIds: [],
    durationMinutes: [60, 90, 120],
    stationIds: ["dev-station-a", "dev-station-b", "dev-station-home"],
    kind: "PERCENT_DISCOUNT",
    valueMinor: null,
    percentage: 50,
    partialPrice: null,
    priority: 100,
  }, {
    ruleId: "annual-tournament-minus-50",
    enabled: true,
    category: "TOURNAMENT",
    actions: ["BOOK_TOURNAMENT"],
    externalEventTypeIds: ["dev-tournament"],
    productTypeIds: [],
    durationMinutes: [60, 90, 120],
    stationIds: ["dev-station-a", "dev-station-b", "dev-station-home"],
    kind: "PERCENT_DISCOUNT",
    valueMinor: null,
    percentage: 50,
    partialPrice: null,
    priority: 100,
  }],
});

const createRuntime = () => {
  const source = compileDraftPolicy(
    {
      subscriptionTypeId: "subscription_type:dev-friendship",
      code: "annual-dev-ac6396e",
      title: "DEV Дружба 12 месяцев",
    },
    draftPolicy(),
    "2026-08-15T10:00:00.000Z",
  );
  return createManagedSubscriptionDevRuntime({ policyLoader: async () => source });
};

const createAnnualRuntime = () => {
  const source = compileDraftPolicy(
    {
      subscriptionTypeId: "subscription_type:dev-friendship",
      code: "annual-dev-ac6396e",
      title: "DEV Дружба 12 месяцев",
    },
    annualDraftPolicy(),
    "2026-08-15T10:00:00.000Z",
  );
  return createManagedSubscriptionDevRuntime({ policyLoader: async () => source });
};

test("DRAFT policy is promoted only to an in-memory published runtime snapshot", () => {
  const source = compileDraftPolicy(
    { subscriptionTypeId: "subscription_type:dev-friendship", code: "annual-dev-ac6396e" },
    draftPolicy(),
  );
  assert.equal(source.sourceStatus, "DRAFT");
  assert.equal(source.policy.status, "PUBLISHED");
  assert.equal(source.policy.policyVersion, 1);
  assert.deepEqual(source.policy.bookingWindow, { enabled: true, days: 4 });
  assert.deepEqual(source.policy.activeServicesLimit, {
    enabled: true,
    max: 3,
    scope: "SUBSCRIPTION_BENEFIT_ONLY",
  });
  assert.deepEqual(source.policy.dailyUsagePolicy, {
    actions: [
      "CREATE_GAME",
      "JOIN_GAME",
      "BOOK_GROUP_TRAINING",
      "BOOK_TOURNAMENT",
      "PURCHASE_ADD_ON_PRODUCT",
    ],
    limitExceeded: "BLOCK",
    percentage: null,
  });
  assert.match(source.digest, /^[a-f0-9]{64}$/);
});

test("CUP loader pins an explicitly requested DRAFT version instead of the latest draft", async () => {
  const fetchImpl = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/subscription-types")) {
      return Response.json({
        items: [{
          subscriptionTypeId: "subscription_type:dev-friendship",
          code: "annual-dev-ac6396e",
          title: "DEV Дружба 12 месяцев",
        }],
      });
    }
    return Response.json([
      { ...draftPolicy(), version: 2, createGame: { enabled: true, durationsMinutes: [60] } },
      draftPolicy(),
    ]);
  };
  const source = await loadPolicyFromCup({
    baseUrl: "http://127.0.0.1:3010",
    typeCode: "annual-dev-ac6396e",
    policyVersion: 1,
    fetchImpl: fetchImpl as typeof fetch,
  });
  assert.equal(source.policy.policyVersion, 1);
  assert.deepEqual(source.policy.createGame.durationsMinutes, [60, 90, 120]);
});

test("60-minute create is free except for the configured station surcharge", async () => {
  const runtime = createRuntime();
  await runtime.initialize();
  const result = await runtime.quote("create-station-a-60-aug18");
  assert.equal(result.decision.eligible, true);
  assert.equal(result.decision.benefit?.kind, "FREE_ENTITLEMENT");
  assert.equal(result.decision.benefit?.discountMinor, 150_000);
  assert.equal(result.decision.benefit?.surchargeMinor, 15_000);
  assert.equal(result.decision.benefit?.finalPriceMinor, 15_000);
});

test("90-minute create calculates one quarter, 20 percent discount and surcharge", async () => {
  const runtime = createRuntime();
  await runtime.initialize();
  const result = await runtime.quote("create-station-a-90-aug18");
  assert.equal(result.decision.eligible, true);
  assert.equal(result.decision.benefit?.kind, "PARTIAL_PRICE_PERCENT_DISCOUNT");
  assert.equal(result.decision.benefit?.partialPriceCalculation?.chargeBeforeDiscountMinor, 56_250);
  assert.equal(result.decision.benefit?.partialPriceCalculation?.percentageDiscountMinor, 11_250);
  assert.equal(result.decision.benefit?.discountMinor, 180_000);
  assert.equal(result.decision.benefit?.surchargeMinor, 15_000);
  assert.equal(result.decision.benefit?.finalPriceMinor, 60_000);
});

test("120-minute home create stays eligible without a pricing benefit", async () => {
  const runtime = createRuntime();
  await runtime.initialize();
  const result = await runtime.quote("create-home-120-aug18");
  assert.equal(result.decision.eligible, true);
  assert.equal(result.decision.benefit?.kind, "NONE");
  assert.equal(result.decision.benefit?.finalPriceMinor, 300_000);
});

test("add-on product applies its exact discount and the station surcharge", async () => {
  const runtime = createRuntime();
  await runtime.initialize();
  const result = await runtime.quote("addon-racket-station-a-aug18");
  assert.equal(result.decision.eligible, true);
  assert.equal(result.decision.benefit?.kind, "PERCENT_DISCOUNT");
  assert.equal(result.decision.benefit?.discountMinor, 10_000);
  assert.equal(result.decision.benefit?.surchargeMinor, 15_000);
  assert.equal(result.decision.benefit?.finalPriceMinor, 105_000);
});

test("booking window, station access and missing group benefit fail closed", async () => {
  const runtime = createRuntime();
  await runtime.initialize();
  const far = await runtime.quote("create-station-a-60-aug22");
  assert.ok(far.decision.blockers.some((item) => item.code === "BOOKING_WINDOW_EXCEEDED"));
  const station = await runtime.quote("create-unknown-station-60-aug18");
  assert.ok(station.decision.blockers.some((item) => item.code === "STATION_NOT_ALLOWED"));
  const group = await runtime.quote("group-station-a-60-aug18");
  assert.ok(group.decision.blockers.some((item) => item.code === "EVENT_NOT_INCLUDED"));
});

test("annual DEV runtime covers free hour, excess-time pricing and post-limit discount", async () => {
  const runtime = createAnnualRuntime();
  await runtime.initialize();
  await runtime.seed(0);

  for (const [targetId, expectedFinal] of [
    ["create-station-a-60-aug18", 0],
    ["create-station-a-90-aug18", 52_500],
    ["create-home-120-aug18", 105_000],
    ["join-station-b-90-aug18", 52_500],
    ["join-station-b-120-aug18", 105_000],
  ] as const) {
    const result = await runtime.quote(targetId);
    assert.equal(result.decision.eligible, true, targetId);
    assert.equal(result.decision.benefit?.finalPriceMinor, expectedFinal, targetId);
  }

  await runtime.reserve("create-station-a-60-aug18", "reserve:annual-free-game");
  const excessCreate = await runtime.quote("create-station-a-90-aug18");
  const excessJoin = await runtime.quote("join-station-b-120-aug18");
  assert.equal(excessCreate.decision.benefit?.kind, "PERCENT_DISCOUNT");
  assert.equal(excessCreate.decision.benefit?.finalPriceMinor, 157_500);
  assert.equal(excessJoin.decision.benefit?.kind, "PERCENT_DISCOUNT");
  assert.equal(excessJoin.decision.benefit?.finalPriceMinor, 210_000);
});

test("annual group and tournament receive 50 percent without consuming the game-day quota", async () => {
  const runtime = createAnnualRuntime();
  await runtime.initialize();
  await runtime.seed(0);
  const group = await runtime.reserve("group-station-a-60-aug18", "reserve:annual-group");
  const tournament = await runtime.quote("tournament-station-a-120-aug18");
  const gameAfterGroup = await runtime.quote("create-station-a-60-aug18");
  assert.equal(group.decision.benefit?.finalPriceMinor, 150_000);
  assert.equal(tournament.decision.benefit?.finalPriceMinor, 250_000);
  assert.equal(gameAfterGroup.decision.benefit?.kind, "FREE_ENTITLEMENT");
  assert.equal(gameAfterGroup.decision.benefit?.finalPriceMinor, 0);
});

test("annual limit blocks a fifth service and serializes the final slot", async () => {
  const runtime = createAnnualRuntime();
  await runtime.initialize();
  await runtime.seed(4);
  const blocked = await runtime.quote("create-station-a-60-aug18");
  assert.ok(blocked.decision.blockers.some(
    (item) => item.code === "ACTIVE_SERVICES_LIMIT_REACHED",
  ));

  await runtime.seed(3);
  const results = await Promise.allSettled([
    runtime.reserve("create-station-a-60-aug18", "reserve:annual-parallel-one"),
    runtime.reserve("group-station-a-60-aug18", "reserve:annual-parallel-two"),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal((await runtime.snapshot()).limits.activeServices, 4);
});

test("three active services block the fourth and release restores eligibility", async () => {
  const runtime = createRuntime();
  await runtime.initialize();
  const seeded = await runtime.seed(3);
  assert.equal(seeded.limits.activeServices, 3);
  const blocked = await runtime.quote("create-station-a-60-aug18");
  assert.ok(blocked.decision.blockers.some((item) => item.code === "ACTIVE_SERVICES_LIMIT_REACHED"));
  await runtime.release("dev-seed:1", "release:seed-one");
  const allowed = await runtime.quote("create-station-a-60-aug18");
  assert.equal(allowed.decision.eligible, true);
});

test("reserve and release replay safely and conflicting operation IDs are rejected", async () => {
  const runtime = createRuntime();
  await runtime.initialize();
  await runtime.seed(0);
  const first = await runtime.reserve("create-station-a-60-aug18", "reserve:stable-one");
  const replay = await runtime.reserve("create-station-a-60-aug18", "reserve:stable-one");
  assert.equal(replay.replayed, true);
  assert.equal(replay.reservation.reservationId, first.reservation.reservationId);
  await assert.rejects(
    () => runtime.reserve("create-station-a-90-aug18", "reserve:stable-one"),
    /operationId уже использован/,
  );
  const released = await runtime.release(first.reservation.reservationId, "release:stable-one");
  const releaseReplay = await runtime.release(first.reservation.reservationId, "release:stable-one");
  assert.equal(released.reservation.status, "RELEASED");
  assert.equal(releaseReplay.replayed, true);
});

test("parallel requests cannot both consume the final active-service slot", async () => {
  const runtime = createRuntime();
  await runtime.initialize();
  await runtime.seed(2);
  const results = await Promise.allSettled([
    runtime.reserve("create-station-a-60-aug18", "reserve:parallel-one"),
    runtime.reserve("create-station-a-90-aug18", "reserve:parallel-two"),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  const snapshot = await runtime.snapshot();
  assert.equal(snapshot.limits.activeServices, 3);
});

test("browser cannot inject an arbitrary station, date or price", async () => {
  const runtime = createRuntime();
  await runtime.initialize();
  await assert.rejects(
    () => runtime.quote({
      targetId: "create-station-a-60-aug18",
      stationId: "attacker-station",
      basePriceMinor: 0,
    }),
    /Тестовое событие не найдено/,
  );
});

test("server-resolved create intent ignores browser price and uses one-quarter of fixture court price", async () => {
  const stationId = "station-terekhovo";
  const target = resolveShadowIntent({
    action: "CREATE_GAME",
    intent: {
      targetKind: "NEW_GAME",
      slotId: "slot-90",
      stationId,
      roomId: "room-6",
      masterServiceId: "master-padel",
      subServiceIds: ["sub-padel"],
      startsAt: "2026-08-30T10:30:00+03:00",
      durationMinutes: 90,
      basePriceMinor: 1,
    } as never,
    createFixtures: new Map([
      [`${stationId}|room-6|2026-08-30T10:30:00+03:00|90`, 1_200_000],
    ]),
    stationIds: [stationId],
    joinFixtures: new Map(),
  });
  assert.equal(target.courtPriceMinor, 1_200_000);
  assert.equal(target.participantCount, 4);
  assert.equal(target.target.basePriceMinor, 300_000);

  const runtime = createManagedSubscriptionDevRuntime({
    policyLoader: async () => buildAnnualShadowPolicySource([stationId]),
  });
  const firstUse = await runtime.quoteResolved(target, { activeServices: 0, dailyGameUsage: 0 });
  assert.equal(firstUse.decision.benefit?.partialPriceCalculation?.chargeBeforeDiscountMinor, 100_000);
  assert.equal(firstUse.decision.benefit?.finalPriceMinor, 70_000);

  const afterFreeHour = await runtime.quoteResolved(target, { activeServices: 0, dailyGameUsage: 1 });
  assert.equal(afterFreeHour.decision.benefit?.kind, "PERCENT_DISCOUNT");
  assert.equal(afterFreeHour.decision.benefit?.finalPriceMinor, 210_000);

  const overActiveLimit = await runtime.quoteResolved(target, { activeServices: 4, dailyGameUsage: 0 });
  assert.ok(overActiveLimit.decision.blockers.some(
    (blocker) => blocker.code === "ACTIVE_SERVICES_LIMIT_REACHED",
  ));
  assert.deepEqual(buildShadowBookingOutcome(target, overActiveLimit.decision), {
    allowed: true,
    subscriptionApplied: false,
    pricingMode: "FULL_PRICE_WITHOUT_SUBSCRIPTION",
    finalPriceMinor: 300_000,
    reasonCodes: ["ACTIVE_SERVICES_LIMIT_REACHED"],
  });
});

test("server-resolved 120 minute create charges only the second player-hour with 30 percent discount", async () => {
  const stationId = "station-terekhovo";
  const target = resolveShadowIntent({
    action: "CREATE_GAME",
    intent: {
      targetKind: "NEW_GAME",
      slotId: "slot-120",
      stationId,
      roomId: "room-6",
      masterServiceId: "master-padel",
      subServiceIds: ["sub-padel"],
      startsAt: "2026-08-30T12:30:00+03:00",
      durationMinutes: 120,
    },
    createFixtures: new Map([
      [`${stationId}|room-6|2026-08-30T12:30:00+03:00|120`, 1_600_000],
    ]),
    stationIds: [stationId],
    joinFixtures: new Map(),
  });
  const runtime = createManagedSubscriptionDevRuntime({
    policyLoader: async () => buildAnnualShadowPolicySource([stationId]),
  });
  const result = await runtime.quoteResolved(target, { activeServices: 0, dailyGameUsage: 0 });
  assert.equal(target.courtPriceMinor, 1_600_000);
  assert.equal(target.target.basePriceMinor, 400_000);
  assert.equal(result.decision.benefit?.partialPriceCalculation?.chargeBeforeDiscountMinor, 200_000);
  assert.equal(result.decision.benefit?.finalPriceMinor, 140_000);
});

test("server-resolved create fails closed when the exact slot is absent from the server catalog", () => {
  assert.throws(() => resolveShadowIntent({
    action: "CREATE_GAME",
    intent: {
      targetKind: "NEW_GAME",
      slotId: "unknown-slot",
      stationId: "station-terekhovo",
      roomId: "room-6",
      masterServiceId: "master-padel",
      subServiceIds: ["sub-padel"],
      startsAt: "2026-08-30T15:00:00+03:00",
      durationMinutes: 90,
    },
    createFixtures: new Map(),
    stationIds: ["station-terekhovo"],
    joinFixtures: new Map(),
  }), /Цена выбранного слота отсутствует/);
});

test("DEV page is available only behind import.meta.env.DEV and contains no Viva mutation client", () => {
  const appSource = fs.readFileSync("src/MyApp.tsx", "utf8");
  const pageSource = fs.readFileSync(
    "src/components/subscriptions/ManagedSubscriptionDevPage.tsx",
    "utf8",
  );
  assert.match(appSource, /import\.meta\.env\.DEV[\s\S]*\/lk_subscription_dev/);
  assert.match(pageSource, /\/__dev\/managed-subscriptions/);
  assert.match(pageSource, /Viva, деньги и реальные записи не вызываются/);
  assert.doesNotMatch(pageSource, /clientSubscriptionId|api\.vivacrm\.ru|paymentType/);
});
