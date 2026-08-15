import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  compileDraftPolicy,
  createManagedSubscriptionDevRuntime,
  loadPolicyFromCup,
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
  assert.equal(result.decision.benefit?.discountMinor, 400_000);
  assert.equal(result.decision.benefit?.surchargeMinor, 15_000);
  assert.equal(result.decision.benefit?.finalPriceMinor, 15_000);
});

test("90-minute create calculates one quarter, 20 percent discount and surcharge", async () => {
  const runtime = createRuntime();
  await runtime.initialize();
  const result = await runtime.quote("create-station-a-90-aug18");
  assert.equal(result.decision.eligible, true);
  assert.equal(result.decision.benefit?.kind, "PARTIAL_PRICE_PERCENT_DISCOUNT");
  assert.equal(result.decision.benefit?.partialPriceCalculation?.chargeBeforeDiscountMinor, 100_000);
  assert.equal(result.decision.benefit?.discountMinor, 20_000);
  assert.equal(result.decision.benefit?.surchargeMinor, 15_000);
  assert.equal(result.decision.benefit?.finalPriceMinor, 95_000);
});

test("120-minute home create stays eligible without a pricing benefit", async () => {
  const runtime = createRuntime();
  await runtime.initialize();
  const result = await runtime.quote("create-home-120-aug18");
  assert.equal(result.decision.eligible, true);
  assert.equal(result.decision.benefit?.kind, "NONE");
  assert.equal(result.decision.benefit?.finalPriceMinor, 400_000);
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
