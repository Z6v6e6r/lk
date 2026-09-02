/* eslint-disable @typescript-eslint/no-explicit-any */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import {
  MANAGED_SUBSCRIPTION_ROUTER_CONTRACTS,
  matchesManagedSubscriptionRouterContract,
  matchesManagedSubscriptionRouterTopology,
  resolveManagedSubscriptionRouterContract,
} from "../nodered_subscription_booking_router_contract.mjs";

const ROUTER_FILE = "scripts/nodered_subscription_booking_nodes/fn_subscription_booking_router.js";
const PREPARE_FILE = "scripts/nodered_subscription_booking_nodes/fn_subscription_booking_prepare.js";
const FINALIZE_FILE = "scripts/nodered_subscription_booking_nodes/fn_subscription_booking_finalize.js";
const SPLIT_ROUTER_FILE = "scripts/nodered_games_nodes/fn_split_router.js";
const MANAGED_BLOCKED_FILE =
  "scripts/nodered_subscription_booking_nodes/fn_managed_subscription_policy_blocked.js";
const PITER_PRODUCT_ID = "8bf334ba-3050-4017-b40a-7eef2db1eb16";
const HUB_PRODUCT_ID = "db7a5250-7369-4f43-8ac5-9111be24bc74";
const MANAGED_PURCHASE_DATE = "2026-09-01T00:00:00+03:00";
const LIVE_ROUTER_FLOW_FIXTURE = process.env.LK1_SUBSCRIPTION_LIVE_FLOW_FIXTURE;
const MANAGED_GLOBALS = {
  vivacrm_access_token: "service-token",
  subscriptions_runtime_api_base_url: "https://padlhub.su/api",
  subscriptions_runtime_context_integration_token: "integration-token",
  subscriptions_entitlement_integration_token: "entitlement-integration-token-1234567890",
  subscriptions_managed_enforcement_product_ids: [PITER_PRODUCT_ID],
};
const MANAGED_ACTIVATION_GLOBALS = {
  ...MANAGED_GLOBALS,
  subscriptions_activation_integration_token: "activation-integration-token-1234567890",
};
const PITER_STATION_ID = "1ea77cbf-bc36-49a1-96d6-f35c216a409b";
const DAY_MS = 24 * 60 * 60 * 1000;
const managedEnforcement = (
  enabled: boolean,
  productId: string | null = PITER_PRODUCT_ID,
  purchaseDate: string | null = enabled ? MANAGED_PURCHASE_DATE.slice(0, 10) : null,
) => ({
  source: "SERVER_GLOBAL_ALLOWLIST_AND_VIVA_PURCHASE_DATE",
  configuredProductIds: enabled ? [PITER_PRODUCT_ID] : [],
  exactProductId: productId,
  productIdentity: productId,
  purchaseDate,
  purchaseDateCandidates: purchaseDate ? [purchaseDate] : [],
  purchaseDateEvidenceValid: Boolean(purchaseDate),
  purchaseDateCutoff: "2026-09-01",
  purchaseDateTimeZone: "Europe/Moscow",
  purchaseDateEligible: Boolean(purchaseDate && purchaseDate >= "2026-09-01"),
  enabled,
  planKey: enabled ? "piter_friendship" : null,
});
const futureManagedTarget = () => {
  const futureDate = new Date(Date.now() + 36 * 60 * 60 * 1000);
  const serviceDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(futureDate);
  return {
    serviceDate,
    startsAt: `${serviceDate}T09:00:00.000Z`,
  };
};

function runFunction(
  file: string,
  msg: Record<string, any>,
  globals: Record<string, unknown> = { vivacrm_access_token: "service-token" },
) {
  const source = fs.readFileSync(file, "utf8");
  return runFunctionSource(source, msg, globals);
}

function runFunctionSource(
  source: string,
  msg: Record<string, any>,
  globals: Record<string, unknown> = { vivacrm_access_token: "service-token" },
) {
  const globalContext = { get: (key: string) => globals[key] };
  return new Function("msg", "global", source)(msg, globalContext) as any[];
}

function baseContext(step: string, overrides: Record<string, unknown> = {}) {
  const context: Record<string, any> = {
    caller: "http",
    step,
    tenantKey: "iSkq6G",
    operationId: "idem-operation-1",
    authHeader: "Bearer user-token",
    exerciseId: "exercise-target",
    clientSubscriptionId: "client-subscription-1",
    actorClientId: "client-1",
    actorPhone: "79990000001",
    serviceDate: "2026-08-10",
    category: "tournament",
    planKey: "sport",
    trackedDailyLimit: true,
    limitMode: "shared_day",
    operationKey: "iSkq6G:client-subscription-1:2026-08-10",
    studioId: "studio-1",
    ...overrides,
  };
  if (!("managedEnforcement" in overrides)) {
    context.managedEnforcement = context.planKey === "piter_friendship"
      ? managedEnforcement(true)
      : managedEnforcement(false, "82caad6f-4d19-4d01-852b-932bdbb0f405");
  }
  return context;
}

function flatBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: "booking-existing",
    paymentType: "SUBSCRIPTION",
    clientSubscriptionId: "client-subscription-1",
    exerciseId: "exercise-existing",
    exerciseDate: "2026-08-10",
    exerciseDirection: { id: 4588, name: "Открытая игра" },
    exerciseType: { id: 1613, name: "Открытая игра" },
    timeFrom: "10:00:00",
    timeTo: "11:00:00",
    ...overrides,
  };
}

function trustedExercise({
  directionId = 2617,
  planName = "Лето.Падел.Спорт",
  productId = "82caad6f-4d19-4d01-852b-932bdbb0f405",
  studioId = "studio-1",
  typeId = 839,
} = {}) {
  return {
    id: "exercise-target",
    timeFrom: "2026-08-10T10:00:00+03:00",
    timeTo: "2026-08-10T11:00:00+03:00",
    direction: { id: directionId, name: directionId === 4588 ? "Открытая игра" : "Турнир" },
    type: { id: typeId, name: typeId === 1613 ? "Открытая игра" : "Турнир" },
    studio: { id: studioId },
    availableClientSubscriptions: [{
      clientSubscriptionId: "client-subscription-1",
      productId,
      name: planName,
    }],
  };
}

function managedExercise(
  productId = PITER_PRODUCT_ID,
  name = "Падел.Дружба.Питер — 12 месяцев",
  purchaseDate: string | null = MANAGED_PURCHASE_DATE,
) {
  const exercise = trustedExercise({
    directionId: 4588,
    planName: name,
    productId,
    studioId: PITER_STATION_ID,
    typeId: 1613,
  });
  return {
    ...exercise,
    availableClientSubscriptions: exercise.availableClientSubscriptions.map((subscription) => ({
      ...subscription,
      ...(purchaseDate ? { purchaseDate } : {}),
    })),
    timeFrom: "2026-08-21T18:00:00+03:00",
    timeTo: "2026-08-21T19:00:00+03:00",
  };
}

function managedRuntimeResponse(overrides: Record<string, any> = {}) {
  const stationId = overrides.stationId || PITER_STATION_ID;
  const benefitStationIds = overrides.benefitStationIds || [stationId];
  const policy = {
    runtimeSchemaVersion: 1,
    subscriptionTypeId: overrides.subscriptionTypeId || "subscription-type:piter",
    policyVersion: 1,
    status: "PUBLISHED",
    effectiveAt: "2026-08-01T00:00:00.000Z",
    timeZone: "Europe/Moscow",
    createGame: { enabled: true, durationsMinutes: [60, 90, 120] },
    joinGame: { enabled: true, minDurationMinutes: 60, maxDurationMinutes: 120 },
    activeServicesLimit: { enabled: false, max: null, scope: "SUBSCRIPTION_BENEFIT_ONLY" },
    bookingWindow: { enabled: false, days: null },
    dailyUsageLimit: 1,
    usageUnitsByDuration: { "60": 1, "90": 1, "120": 1 },
    stationAccessRules: [{
      ruleId: "station-rule",
      enabled: true,
      priority: 1,
      selector: overrides.allStations
        ? { kind: "ALL_STATIONS", stationIds: [] }
        : {
          kind: "STATION_LIST",
          stationIds: overrides.stationIds || [stationId],
        },
      surcharge: { kind: "NONE", amountMinor: 0 },
    }],
    benefitRules: [
      {
        ruleId: "create-free",
        enabled: true,
        category: "GAME",
        actions: ["CREATE_GAME"],
        externalEventTypeIds: ["viva:direction:4588:type:1613"],
        productTypeIds: [],
        durationMinutes: [60, 90, 120],
        stationIds: benefitStationIds,
        kind: "FREE_ENTITLEMENT",
        valueMinor: null,
        percentage: null,
        partialPrice: null,
        priority: 1,
      },
      {
        ruleId: "join-free",
        enabled: true,
        category: "GAME",
        actions: ["JOIN_GAME"],
        externalEventTypeIds: ["viva:direction:4588:type:1613"],
        productTypeIds: [],
        durationMinutes: [60, 90, 120],
        stationIds: benefitStationIds,
        kind: "FREE_ENTITLEMENT",
        valueMinor: null,
        percentage: null,
        partialPrice: null,
        priority: 2,
      },
    ],
    lifecycle: {
      activationMode: "FIRST_USE_OR_FIXED_DATE",
      activationWindowDays: 0,
      fixedActivationAt: "2026-09-30T21:00:00.000Z",
      fixedActivationTimeZone: "Europe/Moscow",
      validityDays: 365,
      allowBookingsAfterExpiry: false,
    },
    usage: {
      weeklyUsageLimit: null,
      monthlyUsageLimit: null,
      maxFutureBookings: null,
      minHoursBetweenUses: 0,
      blackoutDates: [],
    },
    ...overrides.policy,
  };
  return {
    schemaVersion: 1,
    subscriptionInstanceId: overrides.subscriptionInstanceId || "subscription-instance-1",
    clientSubscriptionId: overrides.clientSubscriptionId || "client-subscription-1",
    policyDigest: overrides.policyDigest || "a".repeat(64),
    policy,
    instance: {
      subscriptionInstanceId: "subscription-instance-1",
      subscriptionTypeId: policy.subscriptionTypeId,
      policyVersion: policy.policyVersion,
      state: "ACTIVE",
      activeFrom: new Date(Date.now() - DAY_MS).toISOString(),
      activeTo: new Date(Date.now() + 365 * DAY_MS).toISOString(),
      frozenUntil: null,
      noShowBlockedUntil: null,
      homeStationId: stationId,
      ...overrides.instance,
    },
    evidence: overrides.evidence || { mappingRevision: 1, instanceRevision: 1 },
  };
}

function entitlementDecision({
  action = "CREATE_GAME",
  finalPriceMinor = 0,
  durationMinutes = 60,
} = {}) {
  return {
    decisionKind: "ENTITLEMENT",
    policyVersion: 1,
    policyDigest: "a".repeat(64),
    action,
    target: {
      targetId: "exercise-target",
      stationId: PITER_STATION_ID,
      eventTypeId: "viva:direction:4588:type:1613",
      productTypeId: null,
      durationMinutes,
      startsAt: "2026-08-21T15:00:00.000Z",
    },
    usageUnits: 1,
    money: {
      basePriceMinor: 150000,
      discountMinor: 150000 - finalPriceMinor,
      surchargeMinor: 0,
      finalPriceMinor,
      currency: "RUB",
    },
  };
}

function entitlementContext(step: string, overrides: Record<string, unknown> = {}) {
  const runtime = managedRuntimeResponse();
  return baseContext(step, {
    planKey: "piter_friendship",
    category: "open_game",
    managedAction: "CREATE_GAME",
    managedTarget: {
      stationId: PITER_STATION_ID,
      externalEventTypeId: "viva:direction:4588:type:1613",
      productTypeId: null,
      durationMinutes: 60,
      startsAt: "2026-08-21T15:00:00.000Z",
    },
    managedRuntime: {
      subscriptionInstanceId: runtime.subscriptionInstanceId,
      policyDigest: runtime.policyDigest,
      policy: runtime.policy,
      instance: runtime.instance,
      evidence: runtime.evidence,
    },
    ...overrides,
  });
}

test("gateway prepare requires Bearer and operationId and ignores client identity fields", () => {
  const success = runFunction(PREPARE_FILE, {
    payload: {
      exerciseId: "exercise-target",
      clientSubscriptionId: "client-subscription-1",
      clientId: "forged-client",
      phone: "70000000000",
    },
    req: {
      headers: {
        authorization: "Bearer user-token",
      },
      query: { operationId: "idem-operation-1" },
    },
  });
  assert.equal(success[0]._subscriptionBooking.step, "profile");
  assert.equal(success[0]._subscriptionBooking.actorClientId, undefined);
  assert.equal(success[0]._subscriptionBooking.actorPhone, undefined);
  assert.match(success[0].url, /\/profile$/);

  const missingAuth = runFunction(PREPARE_FILE, {
    payload: { exerciseId: "exercise-target", clientSubscriptionId: "client-subscription-1" },
    req: { headers: {}, query: { operationId: "idem-operation-1" } },
  });
  assert.equal(missingAuth[1].statusCode, 401);

  const missingIdempotency = runFunction(PREPARE_FILE, {
    payload: { exerciseId: "exercise-target", clientSubscriptionId: "client-subscription-1" },
    req: { headers: { authorization: "Bearer user-token" } },
  });
  assert.equal(missingIdempotency[1].statusCode, 400);
});

test("release prepare accepts only an exact booking id and starts from the authenticated profile", () => {
  const success = runFunction(PREPARE_FILE, {
    payload: {
      action: "release",
      bookingId: "booking-cancelled",
      exerciseId: "forged-exercise",
      clientSubscriptionId: "forged-subscription",
    },
    req: {
      headers: { authorization: "Bearer user-token" },
      query: { operationId: "lk-subscription-release:booking-cancelled" },
    },
  });
  assert.equal(success[0]._subscriptionBooking.action, "release");
  assert.equal(success[0]._subscriptionBooking.releaseBookingId, "booking-cancelled");
  assert.equal(success[0]._subscriptionBooking.exerciseId, null);
  assert.equal(success[0]._subscriptionBooking.clientSubscriptionId, null);
  assert.equal(success[0]._subscriptionBooking.step, "profile");
  assert.match(success[0].url, /\/profile$/);

  const missingBooking = runFunction(PREPARE_FILE, {
    payload: { action: "release" },
    req: {
      headers: { authorization: "Bearer user-token" },
      query: { operationId: "lk-subscription-release:missing" },
    },
  });
  assert.equal(missingBooking[1].statusCode, 400);
  assert.equal(
    missingBooking[1].payload.details.code,
    "SUBSCRIPTION_BOOKING_RELEASE_BOOKING_ID_REQUIRED",
  );
});

test("release verifies the exact cancelled subscription booking before selecting its operation", () => {
  const profile = runFunction(ROUTER_FILE, {
    statusCode: 200,
    payload: { id: "client-1", phone: "+79990000001" },
    _subscriptionBooking: baseContext("profile", {
      action: "release",
      releaseBookingId: "booking-cancelled",
      exerciseId: undefined,
      clientSubscriptionId: undefined,
    }),
  });
  assert.equal(profile[0]._subscriptionBooking.step, "active_bookings");

  const active = runFunction(ROUTER_FILE, {
    statusCode: 200,
    payload: { content: [] },
    _subscriptionBooking: profile[0]._subscriptionBooking,
  });
  assert.equal(active[0]._subscriptionBooking.step, "history_bookings");

  const history = runFunction(ROUTER_FILE, {
    statusCode: 200,
    payload: { content: [flatBooking({
      id: "booking-cancelled",
      status: "CANCELLED",
      exerciseId: "exercise-cancelled",
    })] },
    _subscriptionBooking: active[0]._subscriptionBooking,
  });
  assert.equal(history[1]._subscriptionBooking.step, "operation_find");
  assert.deepEqual(history[1].payload, {
    tenantKey: "iSkq6G",
    actorClientId: "client-1",
    serviceDate: "2026-08-10",
    exerciseId: "exercise-cancelled",
  });

  const stillActive = runFunction(ROUTER_FILE, {
    statusCode: 200,
    payload: { content: [] },
    _subscriptionBooking: baseContext("history_bookings", {
      action: "release",
      releaseBookingId: "booking-active",
      activeBookingsPayload: { content: [flatBooking({ id: "booking-active" })] },
    }),
  });
  assert.equal(stillActive[4].statusCode, 409);
  assert.equal(stillActive[4].payload.details.code, "SUBSCRIPTION_BOOKING_RELEASE_STILL_ACTIVE");
  assert.equal(stillActive[1], null);
  assert.equal(stillActive[3], null);
});

test("release fails closed when Viva history subscription differs from the actor operation", () => {
  const mismatch = runFunction(ROUTER_FILE, {
    payload: [{
      _id: "iSkq6G:another-subscription:2026-08-10",
      tenantKey: "iSkq6G",
      actorClientId: "client-1",
      clientSubscriptionId: "another-subscription",
      serviceDate: "2026-08-10",
      exerciseId: "exercise-target",
      state: "PENDING_CONFIRMATION",
    }],
    _subscriptionBooking: baseContext("operation_find", {
      action: "release",
      operationId: "lk-subscription-release:booking-cancelled",
      releaseBookingId: "booking-cancelled",
    }),
  });
  assert.equal(mismatch[4].statusCode, 409);
  assert.equal(
    mismatch[4].payload.details.code,
    "SUBSCRIPTION_BOOKING_RELEASE_SUBSCRIPTION_MISMATCH",
  );
  assert.equal(mismatch[3], null);
});

test("exact cancelled booking releases a pending claim once and duplicate release is idempotent", () => {
  const operation = {
    _id: "iSkq6G:client-subscription-1:2026-08-10",
    tenantKey: "iSkq6G",
    clientSubscriptionId: "client-subscription-1",
    serviceDate: "2026-08-10",
    exerciseId: "exercise-target",
    operationId: "original-book-operation",
    state: "PENDING_CONFIRMATION",
  };
  const releaseContext = baseContext("operation_find", {
    action: "release",
    operationId: "lk-subscription-release:booking-cancelled",
    releaseBookingId: "booking-cancelled",
  });
  const release = runFunction(ROUTER_FILE, {
    payload: [operation],
    _subscriptionBooking: releaseContext,
  });
  assert.equal(release[3]._subscriptionBooking.step, "operation_release");
  assert.deepEqual(release[3].payload[0], {
    _id: operation._id,
    state: "PENDING_CONFIRMATION",
    exerciseId: "exercise-target",
    clientSubscriptionId: "client-subscription-1",
    serviceDate: "2026-08-10",
    releasedBookingIds: { $ne: "booking-cancelled" },
  });
  assert.equal(release[3].payload[1].$set.state, "RELEASED");
  assert.equal(release[3].payload[1].$addToSet.releasedBookingIds, "booking-cancelled");

  const done = runFunction(ROUTER_FILE, {
    payload: { matchedCount: 1 },
    _subscriptionBooking: release[3]._subscriptionBooking,
  });
  assert.equal(done[4].statusCode, 200);
  assert.equal(done[4].payload.state, "RELEASED");

  const duplicate = runFunction(ROUTER_FILE, {
    payload: [{ ...operation, state: "PREPARED", releasedBookingIds: ["booking-cancelled"] }],
    _subscriptionBooking: baseContext("operation_find", {
      action: "release",
      operationId: "lk-subscription-release:booking-cancelled",
      releaseBookingId: "booking-cancelled",
    }),
  });
  assert.equal(duplicate[4].statusCode, 200);
  assert.equal(duplicate[4].payload.state, "RELEASED");
  assert.equal(duplicate[3], null);

  const nextBooking = runFunction(ROUTER_FILE, {
    payload: [{ ...operation, state: "RELEASED", releasedBookingIds: ["booking-cancelled"] }],
    _subscriptionBooking: baseContext("operation_find", {
      operationId: "next-book-operation",
    }),
  });
  assert.equal(nextBooking[3]._subscriptionBooking.step, "operation_reclaim");
  assert.equal(nextBooking[3].payload[1].$set.state, "PREPARED");
  assert.equal(nextBooking[3].payload[1].$set.operationId, "next-book-operation");
  assert.equal(nextBooking[3].payload[1].$unset.releaseBookingId, "");
  assert.equal(nextBooking[3].payload[1].$unset.releasedAt, "");
});

test("trusted exercise must expose the exact owned subscription and allowed plan category", () => {
  const allowed = runFunction(ROUTER_FILE, {
    statusCode: 200,
    payload: {
      id: "exercise-target",
      timeFrom: "2026-08-10T18:00:00+03:00",
      direction: { id: 2617, name: "Турнир" },
      type: { id: 839, name: "Падел Турнир" },
      studio: { id: "studio-1" },
      availableClientSubscriptions: [{
        clientSubscriptionId: "client-subscription-1",
        name: "Лето.Падел.Спорт",
      }],
    },
    _subscriptionBooking: baseContext("exercise", {
      serviceDate: undefined,
      category: undefined,
      planKey: undefined,
      trackedDailyLimit: undefined,
    }),
  });
  assert.equal(allowed[0]._subscriptionBooking.step, "active_bookings");
  assert.equal(allowed[0]._subscriptionBooking.planKey, "sport");
  assert.equal(allowed[0]._subscriptionBooking.trackedDailyLimit, true);
  assert.equal(allowed[0]._subscriptionBooking.limitMode, "shared_day");

  const trustedProductId = runFunction(ROUTER_FILE, {
    statusCode: 200,
    payload: {
      id: "exercise-target",
      timeFrom: "2026-08-10T18:00:00+03:00",
      direction: { id: 2617 },
      type: { id: 839 },
      availableClientSubscriptions: [{
        clientSubscriptionId: "client-subscription-1",
        name: "Абонемент",
        productId: "82caad6f-4d19-4d01-852b-932bdbb0f405",
      }],
    },
    _subscriptionBooking: baseContext("exercise", {
      serviceDate: undefined,
      category: undefined,
      planKey: undefined,
      trackedDailyLimit: undefined,
      limitMode: undefined,
    }),
  });
  assert.equal(trustedProductId[0]._subscriptionBooking.planKey, "sport");
  assert.equal(trustedProductId[0]._subscriptionBooking.step, "active_bookings");

  const unavailable = runFunction(ROUTER_FILE, {
    statusCode: 200,
    payload: {
      id: "exercise-target",
      timeFrom: "2026-08-10T18:00:00+03:00",
      direction: { id: 2617 },
      type: { id: 839 },
      availableClientSubscriptions: [{ clientSubscriptionId: "another-subscription" }],
    },
    _subscriptionBooking: baseContext("exercise"),
  });
  assert.equal(unavailable[4].statusCode, 409);
  assert.equal(unavailable[4].payload.details.code, "SUBSCRIPTION_NOT_OWNED_OR_UNAVAILABLE");

  const nestedTemplateIdMustNotMatch = runFunction(ROUTER_FILE, {
    statusCode: 200,
    payload: {
      id: "exercise-target",
      timeFrom: "2026-08-10T18:00:00+03:00",
      direction: { id: 2617 },
      type: { id: 839 },
      availableClientSubscriptions: [{
        clientSubscriptionId: "owned-client-subscription",
        subscription: { id: "client-subscription-1" },
      }],
    },
    _subscriptionBooking: baseContext("exercise"),
  });
  assert.equal(nestedTemplateIdMustNotMatch[4].statusCode, 409);
});

test("Friendship is allowed for tournaments but remains blocked for group training", () => {
  const tournament = runFunction(ROUTER_FILE, {
    statusCode: 200,
    payload: {
      id: "exercise-target",
      timeFrom: "2026-08-14T18:00:00+03:00",
      direction: { id: 4769, name: "Турнир Сириус" },
      type: { id: 839, name: "Падел Турнир" },
      studio: { id: "studio-1" },
      availableClientSubscriptions: [{
        clientSubscriptionId: "client-subscription-1",
        name: "Лето.Падел.Дружба",
      }],
    },
    _subscriptionBooking: baseContext("exercise", {
      serviceDate: undefined,
      category: undefined,
      planKey: undefined,
      trackedDailyLimit: undefined,
      limitMode: undefined,
    }),
  });
  assert.equal(tournament[0]._subscriptionBooking.step, "active_bookings");
  assert.equal(tournament[0]._subscriptionBooking.planKey, "friendship");
  assert.equal(tournament[0]._subscriptionBooking.category, "tournament");
  assert.equal(tournament[0]._subscriptionBooking.limitMode, "shared_day");

  const serv2Hydrated = runFunction(ROUTER_FILE, {
    statusCode: 200,
    payload: { sertName: "Лето.Падел.Дружба" },
    _subscriptionBooking: baseContext("subscription_name", {
      serviceDate: "2026-08-14",
      category: "tournament",
      planKey: undefined,
      subscriptionName: undefined,
      trackedDailyLimit: undefined,
      limitMode: undefined,
    }),
  });
  assert.equal(serv2Hydrated[0]._subscriptionBooking.step, "active_bookings");
  assert.equal(serv2Hydrated[0]._subscriptionBooking.planKey, "friendship");

  const groupTraining = runFunction(ROUTER_FILE, {
    statusCode: 200,
    payload: {
      id: "exercise-target",
      timeFrom: "2026-08-14T18:00:00+03:00",
      direction: { name: "Групповая тренировка" },
      type: { id: 605, name: "Групповая тренировка" },
      availableClientSubscriptions: [{
        clientSubscriptionId: "client-subscription-1",
        name: "Лето.Падел.Дружба",
      }],
    },
    _subscriptionBooking: baseContext("exercise", {
      serviceDate: undefined,
      category: undefined,
      planKey: undefined,
    }),
  });
  assert.equal(groupTraining[4].statusCode, 409);
  assert.equal(groupTraining[4].payload.details.code, "SUBSCRIPTION_CATEGORY_NOT_ALLOWED");
  assert.equal(groupTraining[4].payload.details.category, "group_training");
});

test("Piter split create resolves a server target and requests the actor-owned CUP runtime context", () => {
  const out = runFunction(ROUTER_FILE, {
    statusCode: 200,
    payload: {
      id: "exercise-target",
      timeFrom: "2026-08-21T18:00:00+03:00",
      timeTo: "2026-08-21T19:00:00+03:00",
      direction: { id: 4588, name: "Открытая игра" },
      type: { id: 1613, name: "Открытая игра" },
      studio: { id: "studio-1" },
      availableClientSubscriptions: [{
        clientSubscriptionId: "client-subscription-1",
        productId: PITER_PRODUCT_ID,
        name: "Падел.Дружба.Питер — 12 месяцев",
        purchaseDate: MANAGED_PURCHASE_DATE,
      }],
    },
    _subscriptionBooking: baseContext("exercise", {
      serviceDate: undefined,
      category: undefined,
      planKey: undefined,
      managedAction: "CREATE_GAME",
    }),
  }, MANAGED_GLOBALS);

  assert.equal(out[0]._subscriptionBooking.step, "managed_runtime_context");
  assert.equal(out[0]._subscriptionBooking.planKey, "piter_friendship");
  assert.equal(out[0]._subscriptionBooking.managedTarget.durationMinutes, 60);
  assert.equal(out[0]._subscriptionBooking.managedTarget.stationId, "studio-1");
  assert.equal(out[0]._subscriptionBooking.managedTarget.externalEventTypeId,
    "viva:direction:4588:type:1613");
  assert.equal(out[0].url, "https://padlhub.su/api/internal/subscriptions/runtime-context");
  assert.deepEqual(out[0].payload, { clientSubscriptionId: "client-subscription-1" });
  assert.equal(out[0].headers.Authorization, "Bearer user-token");
  assert.equal(out[0].headers["X-Subscriptions-Integration-Token"], "integration-token");
  assert.equal(out[1], null);
  assert.equal(out[2], null);
  assert.equal(out[3], null);
});

test("managed allowlist is UUID-normalized, deduplicated and deterministic", () => {
  const out = runFunction(ROUTER_FILE, {
    statusCode: 200,
    payload: managedExercise(PITER_PRODUCT_ID.toUpperCase()),
    _subscriptionBooking: baseContext("exercise", {
      serviceDate: undefined, category: undefined, planKey: undefined,
      managedAction: "CREATE_GAME",
    }),
  }, {
    ...MANAGED_GLOBALS,
    subscriptions_managed_enforcement_product_ids: JSON.stringify([
      HUB_PRODUCT_ID.toUpperCase(),
      PITER_PRODUCT_ID.toUpperCase(),
      PITER_PRODUCT_ID,
    ]),
  });

  assert.equal(out[0]._subscriptionBooking.step, "managed_runtime_context");
  assert.deepEqual(out[0]._subscriptionBooking.managedEnforcement.configuredProductIds,
    [PITER_PRODUCT_ID, HUB_PRODUCT_ID].sort());
  assert.equal(out[0]._subscriptionBooking.managedEnforcement.exactProductId, PITER_PRODUCT_ID);
});

test("malformed managed allowlist values fail closed before CUP or Viva writes", () => {
  for (const configured of ["not-json", ["not-a-uuid"], { productId: PITER_PRODUCT_ID }]) {
    const out = runFunction(ROUTER_FILE, {
      statusCode: 200,
      payload: managedExercise(),
      _subscriptionBooking: baseContext("exercise", {
        serviceDate: undefined, category: undefined, planKey: undefined,
        managedAction: "CREATE_GAME",
      }),
    }, {
      ...MANAGED_GLOBALS,
      subscriptions_managed_enforcement_product_ids: configured,
    });
    assert.equal(out[4].statusCode, 503);
    assert.equal(out[4].payload.details.code,
      "MANAGED_SUBSCRIPTION_ENFORCEMENT_CONFIG_INVALID");
    assert.equal(out[0], null);
    assert.equal(out[1], null);
    assert.equal(out[2], null);
    assert.equal(out[3], null);
  }
});

test("conflicting server-owned product identities fail closed before managed routing", () => {
  const exercise = managedExercise();
  exercise.availableClientSubscriptions[0].product = { id: HUB_PRODUCT_ID };
  const out = runFunction(ROUTER_FILE, {
    statusCode: 200,
    payload: exercise,
    _subscriptionBooking: baseContext("exercise", {
      serviceDate: undefined, category: undefined, planKey: undefined,
      managedAction: "CREATE_GAME",
    }),
  }, MANAGED_GLOBALS);

  assert.equal(out[4].statusCode, 409);
  assert.equal(out[4].payload.details.code, "SUBSCRIPTION_PRODUCT_IDENTITY_AMBIGUOUS");
  assert.equal(out[0], null);
});

test("empty allowlist keeps exact PITER on the fresh-live compatibility path", () => {
  const lookup = runFunction(ROUTER_FILE, {
    statusCode: 200,
    payload: managedExercise(PITER_PRODUCT_ID, ""),
    _subscriptionBooking: baseContext("exercise", {
      serviceDate: undefined, category: undefined, planKey: "piter_friendship",
      managedAction: "JOIN_GAME",
      managedEnforcement: managedEnforcement(true),
    }),
  }, {
    vivacrm_access_token: "service-token",
    subscriptions_managed_enforcement_product_ids: [],
  });

  assert.equal(lookup[0]._subscriptionBooking.step, "subscription_name");
  assert.doesNotMatch(lookup[0].url, /runtime-context/);
  const out = runFunction(ROUTER_FILE, {
    statusCode: 200,
    payload: { sertName: "Лето.Падел.Дружба" },
    _subscriptionBooking: lookup[0]._subscriptionBooking,
  }, {
    vivacrm_access_token: "service-token",
    subscriptions_managed_enforcement_product_ids: [],
  });
  assert.equal(out[0]._subscriptionBooking.step, "active_bookings");
  assert.equal(out[0]._subscriptionBooking.planKey, "friendship");
  assert.equal(out[0]._subscriptionBooking.managedEnforcement.enabled, false);
  assert.deepEqual(out[0]._subscriptionBooking.managedEnforcement.configuredProductIds, []);
  assert.doesNotMatch(out[0].url, /runtime-context/);
});

test("browser product, name, planKey and gate fields cannot enable a non-PITER product", () => {
  const ordinaryProductId = "82caad6f-4d19-4d01-852b-932bdbb0f405";
  const out = runFunction(ROUTER_FILE, {
    statusCode: 200,
    payload: managedExercise(ordinaryProductId),
    productId: PITER_PRODUCT_ID,
    subscriptionProductId: PITER_PRODUCT_ID,
    subscriptionName: "Падел.Дружба.Питер — 12 месяцев",
    planKey: "piter_friendship",
    managedEnforcement: managedEnforcement(true),
    _subscriptionBooking: baseContext("exercise", {
      serviceDate: undefined, category: undefined, planKey: "piter_friendship",
      managedAction: "CREATE_GAME",
      managedEnforcement: managedEnforcement(true),
    }),
  }, MANAGED_GLOBALS);

  assert.equal(out[0]._subscriptionBooking.step, "active_bookings");
  assert.equal(out[0]._subscriptionBooking.planKey, "sport");
  assert.equal(out[0]._subscriptionBooking.managedEnforcement.exactProductId, ordinaryProductId);
  assert.equal(out[0]._subscriptionBooking.managedEnforcement.enabled, false);
  assert.doesNotMatch(out[0].url, /runtime-context/);
});

test("direct and split CREATE/JOIN use the same exact PITER rollout gate", () => {
  for (const caller of ["http", "split"]) {
    for (const managedAction of ["CREATE_GAME", "JOIN_GAME"]) {
      const enabled = runFunction(ROUTER_FILE, {
        statusCode: 200,
        payload: managedExercise(),
        _subscriptionBooking: baseContext("exercise", {
          caller,
          serviceDate: undefined, category: undefined, planKey: undefined,
          managedAction,
        }),
      }, MANAGED_GLOBALS);
      assert.equal(enabled[0]._subscriptionBooking.step, "managed_runtime_context");
      assert.equal(enabled[0]._subscriptionBooking.managedAction, managedAction);

      const disabled = runFunction(ROUTER_FILE, {
        statusCode: 200,
        payload: managedExercise(),
        _subscriptionBooking: baseContext("exercise", {
          caller,
          serviceDate: undefined, category: undefined, planKey: undefined,
          managedAction,
        }),
      }, { vivacrm_access_token: "service-token" });
      assert.equal(disabled[0]._subscriptionBooking.step, "active_bookings");
      assert.doesNotMatch(disabled[0].url, /runtime-context/);
    }
  }
});

test("managed PITER rules apply only to subscriptions sold from 2026-09-01 Moscow", () => {
  const cases = [
    { purchaseDate: "2026-08-31T23:59:59+03:00", enabled: false },
    { purchaseDate: "2026-08-31T21:00:00.000Z", enabled: true },
    { purchaseDate: "2026-09-01T00:00:00+03:00", enabled: true },
    { purchaseDate: "2026-09-01T00:00:00", enabled: true },
  ];

  for (const { purchaseDate, enabled } of cases) {
    const out = runFunction(ROUTER_FILE, {
      statusCode: 200,
      payload: managedExercise(PITER_PRODUCT_ID, "Падел.Дружба.Питер — 12 месяцев", purchaseDate),
      _subscriptionBooking: baseContext("exercise", {
        serviceDate: undefined, category: undefined, planKey: undefined,
        managedAction: "CREATE_GAME",
      }),
    }, MANAGED_GLOBALS);
    assert.equal(out[0]._subscriptionBooking.managedEnforcement.enabled, enabled, purchaseDate || "missing");
    assert.equal(
      out[0]._subscriptionBooking.step,
      enabled ? "managed_runtime_context" : "active_bookings",
      purchaseDate || "missing",
    );
    if (!enabled) assert.equal(out[0]._subscriptionBooking.planKey, "friendship");
  }
});

test("pre-cutoff PITER stays on Friendship for direct and split CREATE/JOIN", () => {
  for (const caller of ["http", "split"]) {
    for (const managedAction of ["CREATE_GAME", "JOIN_GAME"]) {
      const out = runFunction(ROUTER_FILE, {
        statusCode: 200,
        payload: managedExercise(
          PITER_PRODUCT_ID,
          "Падел.Дружба.Питер — 12 месяцев",
          "2026-08-31T23:59:59+03:00",
        ),
        _subscriptionBooking: baseContext("exercise", {
          caller,
          serviceDate: undefined, category: undefined, planKey: undefined,
          managedAction,
        }),
      }, MANAGED_GLOBALS);
      assert.equal(out[0]._subscriptionBooking.step, "active_bookings");
      assert.equal(out[0]._subscriptionBooking.planKey, "friendship");
      assert.equal(out[0]._subscriptionBooking.managedEnforcement.enabled, false);
      assert.doesNotMatch(out[0].url, /runtime-context/);
    }
  }
});

test("browser purchase date cannot enable a pre-cutoff PITER subscription", () => {
  for (const serverPurchaseDate of ["2026-08-31T12:00:00+03:00"]) {
    const out = runFunction(ROUTER_FILE, {
      statusCode: 200,
      payload: managedExercise(PITER_PRODUCT_ID, "Падел.Дружба.Питер — 12 месяцев", serverPurchaseDate),
      purchaseDate: MANAGED_PURCHASE_DATE,
      subscription: { purchaseDate: MANAGED_PURCHASE_DATE },
      _subscriptionBooking: baseContext("exercise", {
        serviceDate: undefined, category: undefined, planKey: undefined,
        managedAction: "CREATE_GAME",
      }),
    }, MANAGED_GLOBALS);
    assert.equal(out[0]._subscriptionBooking.managedEnforcement.enabled, false);
    assert.equal(out[0]._subscriptionBooking.step, "active_bookings");
  }
});

test("missing, malformed or conflicting server-owned PITER purchase dates fail closed", () => {
  for (const purchaseDate of [
    null,
    "not-a-date",
    "2026-09-01garbage",
    "2026-09-01T99:99:99",
    "2026-09-01T24:61:61",
  ]) {
    for (const caller of ["http", "split"]) {
      for (const managedAction of ["CREATE_GAME", "JOIN_GAME"]) {
        const label = `${caller}:${managedAction}:${purchaseDate || "missing"}`;
        const out = runFunction(ROUTER_FILE, {
          statusCode: 200,
          payload: managedExercise(PITER_PRODUCT_ID, "Падел.Дружба.Питер — 12 месяцев", purchaseDate),
          purchaseDate: MANAGED_PURCHASE_DATE,
          subscription: { purchaseDate: MANAGED_PURCHASE_DATE },
          _subscriptionBooking: baseContext("exercise", {
            caller,
            serviceDate: undefined, category: undefined, planKey: undefined,
            managedAction,
          }),
        }, MANAGED_GLOBALS);
        assert.equal(out[4].statusCode, 409, label);
        assert.equal(out[4].payload.details.code,
          "SUBSCRIPTION_PURCHASE_DATE_UNRESOLVED", label);
        assert.equal(out[0], null, label);
        assert.equal(out[1], null, label);
        assert.equal(out[2], null, label);
        assert.equal(out[3], null, label);
      }
    }
  }

  const duplicateRows = managedExercise();
  duplicateRows.availableClientSubscriptions.push({
    ...duplicateRows.availableClientSubscriptions[0],
    purchaseDate: "2026-08-31T23:59:59+03:00",
  });
  const duplicateOut = runFunction(ROUTER_FILE, {
    statusCode: 200,
    payload: duplicateRows,
    _subscriptionBooking: baseContext("exercise", {
      serviceDate: undefined, category: undefined, planKey: undefined,
      managedAction: "CREATE_GAME",
    }),
  }, MANAGED_GLOBALS);
  assert.equal(duplicateOut[4].statusCode, 409);
  assert.equal(duplicateOut[4].payload.details.code, "SUBSCRIPTION_PURCHASE_DATE_UNRESOLVED");
  assert.equal(duplicateOut[0], null);

  const invalidRows = managedExercise();
  invalidRows.availableClientSubscriptions.push({
    ...invalidRows.availableClientSubscriptions[0],
    purchaseDate: "invalid-duplicate-date",
  });
  const invalidOut = runFunction(ROUTER_FILE, {
    statusCode: 200,
    payload: invalidRows,
    _subscriptionBooking: baseContext("exercise", {
      serviceDate: undefined, category: undefined, planKey: undefined,
      managedAction: "CREATE_GAME",
    }),
  }, MANAGED_GLOBALS);
  assert.equal(invalidOut[4].statusCode, 409);
  assert.equal(invalidOut[4].payload.details.code, "SUBSCRIPTION_PURCHASE_DATE_UNRESOLVED");
  assert.equal(invalidOut[0], null);

  const missingRows = managedExercise();
  const { purchaseDate: _purchaseDate, ...withoutPurchaseDate } =
    missingRows.availableClientSubscriptions[0];
  missingRows.availableClientSubscriptions.push(withoutPurchaseDate);
  const missingOut = runFunction(ROUTER_FILE, {
    statusCode: 200,
    payload: missingRows,
    _subscriptionBooking: baseContext("exercise", {
      serviceDate: undefined, category: undefined, planKey: undefined,
      managedAction: "CREATE_GAME",
    }),
  }, MANAGED_GLOBALS);
  assert.equal(missingOut[4].statusCode, 409);
  assert.equal(missingOut[4].payload.details.code, "SUBSCRIPTION_PURCHASE_DATE_UNRESOLVED");
  assert.equal(missingOut[0], null);
});

test("missing purchase dates do not activate the strict gate outside allowlisted PITER", () => {
  const rolloutOff = runFunction(ROUTER_FILE, {
    statusCode: 200,
    payload: managedExercise(PITER_PRODUCT_ID, "Падел.Дружба.Питер — 12 месяцев", null),
    _subscriptionBooking: baseContext("exercise", {
      serviceDate: undefined, category: undefined, planKey: undefined,
      managedAction: "CREATE_GAME",
    }),
  }, {
    vivacrm_access_token: "service-token",
    subscriptions_managed_enforcement_product_ids: [],
  });
  assert.equal(rolloutOff[0]._subscriptionBooking.step, "active_bookings");
  assert.equal(rolloutOff[4], null);

  const hub = runFunction(ROUTER_FILE, {
    statusCode: 200,
    payload: managedExercise(HUB_PRODUCT_ID, "Падел.Дружба.ХАБ — 12 месяцев", null),
    _subscriptionBooking: baseContext("exercise", {
      serviceDate: undefined, category: undefined, planKey: undefined,
      managedAction: "JOIN_GAME",
    }),
  }, {
    ...MANAGED_GLOBALS,
    subscriptions_managed_enforcement_product_ids: [PITER_PRODUCT_ID, HUB_PRODUCT_ID],
  });
  assert.equal(hub[0]._subscriptionBooking.step, "active_bookings");
  assert.equal(hub[4], null);
});

test("names cannot enable managed enforcement and an allowlisted exact product still requires canonical target identity", () => {
  const exercise = {
    id: "exercise-target",
    timeFrom: "2026-08-21T18:00:00+03:00",
    timeTo: "2026-08-21T19:00:00+03:00",
    direction: { id: 4588, name: "Открытая игра" },
    type: { id: 1613, name: "Открытая игра" },
    studio: { id: PITER_STATION_ID },
    availableClientSubscriptions: [{
      clientSubscriptionId: "client-subscription-1",
      name: "Падел.Дружба.Питер — 12 месяцев",
    }],
  };
  const byNameOnly = runFunction(ROUTER_FILE, {
    statusCode: 200,
    payload: exercise,
    _subscriptionBooking: baseContext("exercise", {
      serviceDate: undefined, category: undefined, planKey: undefined,
      managedAction: "CREATE_GAME",
    }),
  }, MANAGED_GLOBALS);
  assert.equal(byNameOnly[0]._subscriptionBooking.step, "active_bookings");
  assert.equal(byNameOnly[0]._subscriptionBooking.planKey, "friendship");
  assert.equal(byNameOnly[0]._subscriptionBooking.managedEnforcement.enabled, false);
  assert.doesNotMatch(byNameOnly[0].url, /runtime-context/);

  const missingDirection = runFunction(ROUTER_FILE, {
    statusCode: 200,
    payload: {
      ...exercise,
      direction: { name: "Открытая игра" },
      availableClientSubscriptions: [{
        ...exercise.availableClientSubscriptions[0],
        productId: PITER_PRODUCT_ID,
        purchaseDate: MANAGED_PURCHASE_DATE,
      }],
    },
    _subscriptionBooking: baseContext("exercise", {
      serviceDate: undefined, category: undefined, planKey: undefined,
      managedAction: "CREATE_GAME",
    }),
  }, MANAGED_GLOBALS);
  assert.equal(missingDirection[4].payload.details.code,
    "MANAGED_SUBSCRIPTION_TARGET_UNRESOLVED");
  assert.equal(missingDirection[0], null);
});

test("HUB split join stays on the fresh-live compatibility path while Kotelniki stays closed", () => {
  const exercise = (name: string, productId?: string) => ({
    id: "exercise-target",
    timeFrom: "2026-08-21T18:00:00+03:00",
    timeTo: "2026-08-21T20:00:00+03:00",
    direction: { id: 4588, name: "Открытая игра" },
    type: { id: 1613, name: "Открытая игра" },
    studio: { id: "studio-1" },
    availableClientSubscriptions: [{
      clientSubscriptionId: "client-subscription-1",
      productId,
      name,
    }],
  });
  const hubLookup = runFunction(ROUTER_FILE, {
    statusCode: 200,
    payload: exercise("", HUB_PRODUCT_ID),
    _subscriptionBooking: baseContext("exercise", {
      serviceDate: undefined, category: undefined, planKey: undefined,
      managedAction: "JOIN_GAME",
    }),
  }, {
    ...MANAGED_GLOBALS,
    subscriptions_managed_enforcement_product_ids: [PITER_PRODUCT_ID, HUB_PRODUCT_ID],
  });
  assert.equal(hubLookup[0]._subscriptionBooking.step, "subscription_name");
  assert.doesNotMatch(hubLookup[0].url, /runtime-context/);
  const hub = runFunction(ROUTER_FILE, {
    statusCode: 200,
    payload: { sertName: "Лето.Падел.Дружба" },
    _subscriptionBooking: hubLookup[0]._subscriptionBooking,
  }, {
    ...MANAGED_GLOBALS,
    subscriptions_managed_enforcement_product_ids: [PITER_PRODUCT_ID, HUB_PRODUCT_ID],
  });
  assert.equal(hub[0]._subscriptionBooking.step, "active_bookings");
  assert.equal(hub[0]._subscriptionBooking.planKey, "friendship");
  assert.equal(hub[0]._subscriptionBooking.managedEnforcement.exactProductId, HUB_PRODUCT_ID);
  assert.equal(hub[0]._subscriptionBooking.managedEnforcement.enabled, false);
  assert.doesNotMatch(hub[0].url, /runtime-context/);

  const kotelniki = runFunction(ROUTER_FILE, {
    statusCode: 200,
    payload: exercise("Падел.Дружба.Котельники — 12 месяцев"),
    _subscriptionBooking: baseContext("exercise", {
      serviceDate: undefined, category: undefined, planKey: undefined,
      managedAction: "CREATE_GAME",
    }),
  }, MANAGED_GLOBALS);
  assert.equal(kotelniki[4].statusCode, 409);
  assert.equal(kotelniki[4].payload.details.code, "MANAGED_SUBSCRIPTION_PLAN_NOT_ACTIVATED");
});

test("published managed policy is evaluated before Mongo and persists its audit identity", () => {
  const futureTarget = futureManagedTarget();
  const runtime = runFunction(ROUTER_FILE, {
    statusCode: 200,
    payload: managedRuntimeResponse(),
    _subscriptionBooking: baseContext("managed_runtime_context", {
      serviceDate: futureTarget.serviceDate,
      category: "open_game",
      planKey: "piter_friendship",
      managedAction: "CREATE_GAME",
      managedTarget: {
        resolutionSource: "SERVER", stationId: PITER_STATION_ID, category: "GAME",
        externalEventTypeId: "viva:direction:4588:type:1613", productTypeId: null, eventId: "exercise-target",
        durationMinutes: 60, startsAt: futureTarget.startsAt,
        basePriceMinor: null, currency: "RUB",
      },
    }),
  }, MANAGED_GLOBALS);
  assert.equal(runtime[0]._subscriptionBooking.step, "active_bookings");

  const active = runFunction(ROUTER_FILE, {
    statusCode: 200, payload: { content: [] },
    _subscriptionBooking: runtime[0]._subscriptionBooking,
  }, MANAGED_GLOBALS);
  const history = runFunction(ROUTER_FILE, {
    statusCode: 200, payload: { content: [] },
    _subscriptionBooking: active[0]._subscriptionBooking,
  }, MANAGED_GLOBALS);
  assert.equal(history[1]._subscriptionBooking.step, "operation_find");
  assert.equal(history[6], null, "legacy in-memory policy never authorizes the provider write");
  assert.equal(history[1]._subscriptionBooking.managedDecision, undefined);
});

test("forged HUB planKey and runtime step cannot bypass the exact PITER gate", () => {
  const runtime = runFunction(ROUTER_FILE, {
    statusCode: 200,
    payload: managedRuntimeResponse({ subscriptionTypeId: "subscription-type:hub" }),
    _subscriptionBooking: baseContext("managed_runtime_context", {
      serviceDate: "2026-08-21",
      category: "open_game",
      planKey: "network_friendship",
      managedAction: "JOIN_GAME",
      managedEnforcement: managedEnforcement(false, HUB_PRODUCT_ID),
    }),
  }, MANAGED_GLOBALS);

  assert.equal(runtime[4].statusCode, 409);
  assert.equal(runtime[4].payload.details.code,
    "MANAGED_SUBSCRIPTION_ENFORCEMENT_CONTEXT_INVALID");
  assert.equal(runtime[0], null);
});

test("the managed runtime call graph contains no HUB product identity", () => {
  const source = fs.readFileSync(ROUTER_FILE, "utf8");
  assert.match(source, /internal\/subscriptions\/runtime-context/);
  assert.match(source, new RegExp(PITER_PRODUCT_ID));
  assert.doesNotMatch(source, new RegExp(HUB_PRODUCT_ID));
});

test("HUB response and external command prefix match the exact fresh-live preimage", {
  skip: !LIVE_ROUTER_FLOW_FIXTURE,
}, () => {
  const flow = JSON.parse(fs.readFileSync(LIVE_ROUTER_FLOW_FIXTURE, "utf8"));
  const liveTargets = flow.filter((node: Record<string, any>) => (
    node.id === "lk_subscription_booking_router_20260804"
  ));
  assert.equal(liveTargets.length, 1);
  const payload = {
    id: "exercise-target",
    timeFrom: "2026-08-21T18:00:00+03:00",
    timeTo: "2026-08-21T19:00:00+03:00",
    direction: { name: "Групповая тренировка" },
    type: { id: 605, name: "Групповая тренировка" },
    studio: { id: "studio-1" },
    availableClientSubscriptions: [{
      clientSubscriptionId: "client-subscription-1",
      productId: HUB_PRODUCT_ID,
      name: "",
    }],
  };
  const input = {
    statusCode: 200,
    payload,
    _subscriptionBooking: baseContext("exercise", {
      serviceDate: undefined, category: undefined, planKey: undefined,
      managedAction: "JOIN_GAME",
    }),
  };
  const globals = {
    ...MANAGED_GLOBALS,
    subscriptions_managed_enforcement_product_ids: [PITER_PRODUCT_ID],
  };
  const liveLookup = runFunctionSource(liveTargets[0].func, structuredClone(input), globals);
  const candidateLookup = runFunction(ROUTER_FILE, structuredClone(input), globals);
  const externalCommand = (output: any[]) => ({
    step: output[0]?._subscriptionBooking?.step,
    method: output[0]?.method,
    url: output[0]?.url,
    payload: output[0]?.payload,
  });
  assert.deepEqual(externalCommand(candidateLookup), externalCommand(liveLookup));
  assert.equal(candidateLookup[0]._subscriptionBooking.managedEnforcement.enabled, false);
  assert.doesNotMatch(candidateLookup[0].url, /runtime-context/);

  const lookupResponse = { statusCode: 200, payload: { sertName: "Лето.Падел.Дружба" } };
  const liveResponse = runFunctionSource(liveTargets[0].func, {
    ...lookupResponse,
    _subscriptionBooking: liveLookup[0]._subscriptionBooking,
  }, globals);
  const candidateResponse = runFunction(ROUTER_FILE, {
    ...lookupResponse,
    _subscriptionBooking: candidateLookup[0]._subscriptionBooking,
  }, globals);
  assert.equal(candidateResponse[4].statusCode, liveResponse[4].statusCode);
  assert.deepEqual(candidateResponse[4].payload, liveResponse[4].payload);
  assert.equal(candidateResponse[0], null);
});

test("pending annual subscription fails before Viva reads when CUP activation is not configured", () => {
  const runtime = runFunction(ROUTER_FILE, {
    statusCode: 200,
    payload: managedRuntimeResponse({
      instance: { state: "PENDING_ACTIVATION", activeFrom: null, activeTo: null },
    }),
    _subscriptionBooking: baseContext("managed_runtime_context", {
      serviceDate: "2026-08-21",
      category: "open_game",
      planKey: "piter_friendship",
      managedAction: "CREATE_GAME",
      managedTarget: {
        resolutionSource: "SERVER", stationId: PITER_STATION_ID, category: "GAME",
        externalEventTypeId: "viva:direction:4588:type:1613", productTypeId: null, eventId: "exercise-target",
        durationMinutes: 60, startsAt: "2026-08-21T15:00:00.000Z",
        basePriceMinor: null, currency: "RUB",
      },
    }),
  }, MANAGED_GLOBALS);

  assert.equal(runtime[4].statusCode, 503);
  assert.equal(runtime[4].payload.details.code, "SUBSCRIPTION_ACTIVATION_NOT_CONFIGURED");
  assert.equal(runtime[0], null, "no Viva booking/read request is emitted");

  const shortToken = runFunction(ROUTER_FILE, {
    statusCode: 200,
    payload: managedRuntimeResponse({
      instance: { state: "PENDING_ACTIVATION", activeFrom: null, activeTo: null },
    }),
    _subscriptionBooking: runtime[4]._subscriptionBooking,
  }, {
    ...MANAGED_GLOBALS,
    subscriptions_activation_integration_token: "too-short",
  });
  assert.equal(shortToken[4].payload.details.code, "SUBSCRIPTION_ACTIVATION_NOT_CONFIGURED");
  assert.equal(shortToken[0], null);
});

test("pending annual subscription is projected for policy and activates only after Viva read-back", () => {
  const runtime = runFunction(ROUTER_FILE, {
    statusCode: 200,
    payload: managedRuntimeResponse({
      instance: { state: "PENDING_ACTIVATION", activeFrom: null, activeTo: null },
    }),
    _subscriptionBooking: baseContext("managed_runtime_context", {
      serviceDate: "2026-08-21",
      category: "open_game",
      planKey: "piter_friendship",
      managedAction: "CREATE_GAME",
      managedTarget: {
        resolutionSource: "SERVER", stationId: PITER_STATION_ID, category: "GAME",
        externalEventTypeId: "viva:direction:4588:type:1613", productTypeId: null, eventId: "exercise-target",
        durationMinutes: 60, startsAt: "2026-08-21T15:00:00.000Z",
        basePriceMinor: null, currency: "RUB",
      },
    }),
  }, MANAGED_ACTIVATION_GLOBALS);
  assert.equal(runtime[0]._subscriptionBooking.managedActivationRequired, true);
  assert.equal(runtime[0]._subscriptionBooking.managedActivationExpectedRevision, 1);

  const active = runFunction(ROUTER_FILE, {
    statusCode: 200,
    payload: { content: [] },
    _subscriptionBooking: runtime[0]._subscriptionBooking,
  }, MANAGED_ACTIVATION_GLOBALS);
  const history = runFunction(ROUTER_FILE, {
    statusCode: 200,
    payload: { content: [] },
    _subscriptionBooking: active[0]._subscriptionBooking,
  }, MANAGED_ACTIVATION_GLOBALS);
  assert.equal(history[1]._subscriptionBooking.step, "operation_find");
  assert.equal(history[6], null);

  const activationRequest = runFunction(ROUTER_FILE, {
    payload: { matchedCount: 1 },
    _subscriptionBooking: baseContext("operation_confirm", {
      planKey: "piter_friendship",
      managedActivationRequired: true,
      managedActivationExpectedRevision: 1,
      confirmedBookingId: "booking-first-use",
      managedRuntime: {
        subscriptionInstanceId: "subscription-instance-1",
      },
    }),
  }, MANAGED_ACTIVATION_GLOBALS);
  assert.equal(activationRequest[0]._subscriptionBooking.step, "managed_first_use_activation");
  assert.equal(
    activationRequest[0].url,
    "https://padlhub.su/api/internal/subscriptions/activate-first-use",
  );
  assert.deepEqual(activationRequest[0].payload, {
    subscriptionInstanceId: "subscription-instance-1",
    clientSubscriptionId: "client-subscription-1",
    providerBookingId: "booking-first-use",
    expectedInstanceRevision: 1,
  });
  assert.equal(
    activationRequest[0].headers["X-Subscriptions-Integration-Token"],
    "activation-integration-token-1234567890",
  );

  const activationConfirmed = runFunction(ROUTER_FILE, {
    statusCode: 200,
    payload: {
      schemaVersion: 1,
      outcome: "ACTIVATED",
      subscriptionInstanceId: "subscription-instance-1",
      state: "ACTIVE",
      activeFrom: "2026-08-21T10:00:00.000Z",
      activeTo: "2027-08-21T09:59:59.999Z",
      revision: 2,
    },
    _subscriptionBooking: activationRequest[0]._subscriptionBooking,
  }, MANAGED_ACTIVATION_GLOBALS);
  assert.equal(
    activationConfirmed[3]._subscriptionBooking.step,
    "operation_activation_confirm",
  );
  assert.equal(activationConfirmed[3].payload[1].$set.activationState, "CONFIRMED");
  assert.equal(activationConfirmed[3].payload[1].$set.activationRevision, 2);

  const done = runFunction(ROUTER_FILE, {
    payload: { matchedCount: 1 },
    _subscriptionBooking: activationConfirmed[3]._subscriptionBooking,
  }, MANAGED_ACTIVATION_GLOBALS);
  assert.equal(done[4].statusCode, 201);
  assert.equal(done[4].payload.state, "CONFIRMED");
});

test("temporary CUP activation failure stays retryable without another Viva create", () => {
  const pending = runFunction(ROUTER_FILE, {
    statusCode: 503,
    payload: { error: { code: "UPSTREAM_UNAVAILABLE" } },
    _subscriptionBooking: baseContext("managed_first_use_activation", {
      planKey: "piter_friendship",
      managedActivationRequired: true,
      managedActivationExpectedRevision: 1,
      confirmedBookingId: "booking-first-use",
      managedRuntime: { subscriptionInstanceId: "subscription-instance-1" },
    }),
  }, MANAGED_ACTIVATION_GLOBALS);
  assert.equal(pending[4].statusCode, 202);
  assert.equal(pending[4].payload.details.code, "SUBSCRIPTION_ACTIVATION_PENDING");
  assert.equal(pending[0], null, "failure never emits a second Viva request");

  const retry = runFunction(ROUTER_FILE, {
    payload: [{
      _id: "iSkq6G:client-subscription-1:2026-08-10",
      operationId: "original-operation",
      state: "CONFIRMED",
      bookingId: "booking-first-use",
      activationState: "PENDING",
    }],
    _subscriptionBooking: baseContext("operation_find", {
      planKey: "piter_friendship",
      managedActivationRequired: true,
      managedActivationExpectedRevision: 1,
      confirmedBookingId: "booking-first-use",
      sameExerciseBooking: flatBooking({
        id: "booking-first-use",
        exerciseId: "exercise-target",
      }),
      cancelledSubscriptionBookings: [],
      managedRuntime: { subscriptionInstanceId: "subscription-instance-1" },
    }),
  }, MANAGED_ACTIVATION_GLOBALS);
  assert.equal(retry[0]._subscriptionBooking.step, "managed_first_use_activation");
  assert.equal(retry[0]._subscriptionBooking.activationOperationId, "original-operation");
  assert.equal(retry[0].payload.providerBookingId, "booking-first-use");
  assert.doesNotMatch(retry[0].url, /vivacrm/i);
});

test("regional policy requires the exact first-use deadline lifecycle before any booking read", () => {
  const variants = [
    {},
    {
      activationMode: "FIRST_USE",
      activationWindowDays: 0,
      fixedActivationAt: "2026-09-30T21:00:00.000Z",
      fixedActivationTimeZone: "Europe/Moscow",
      validityDays: 365,
      allowBookingsAfterExpiry: false,
    },
    {
      activationMode: "FIRST_USE_OR_FIXED_DATE",
      activationWindowDays: 0,
      fixedActivationAt: "2026-10-01T00:00:00.000Z",
      fixedActivationTimeZone: "Europe/Moscow",
      validityDays: 365,
      allowBookingsAfterExpiry: false,
    },
    {
      activationMode: "FIRST_USE_OR_FIXED_DATE",
      activationWindowDays: "0",
      fixedActivationAt: "2026-09-30T21:00:00.000Z",
      fixedActivationTimeZone: "Europe/Moscow",
      validityDays: "365",
      allowBookingsAfterExpiry: false,
    },
    {
      activationMode: "FIRST_USE_OR_FIXED_DATE",
      activationWindowDays: false,
      fixedActivationAt: "2026-09-30T21:00:00.000Z",
      fixedActivationTimeZone: "Europe/Moscow",
      validityDays: 365,
      allowBookingsAfterExpiry: false,
    },
  ];

  for (const lifecycle of variants) {
    const runtime = runFunction(ROUTER_FILE, {
      statusCode: 200,
      payload: managedRuntimeResponse({ policy: { lifecycle } }),
      _subscriptionBooking: baseContext("managed_runtime_context", {
        serviceDate: "2026-08-21",
        category: "open_game",
        planKey: "piter_friendship",
        managedAction: "CREATE_GAME",
        managedTarget: {
          resolutionSource: "SERVER", stationId: PITER_STATION_ID, category: "GAME",
          externalEventTypeId: "viva:direction:4588:type:1613", productTypeId: null, eventId: "exercise-target",
          durationMinutes: 60, startsAt: "2026-08-21T15:00:00.000Z",
          basePriceMinor: null, currency: "RUB",
        },
      }),
    }, MANAGED_GLOBALS);

    assert.equal(runtime[4].statusCode, 409);
    assert.equal(runtime[4].payload.details.code, "MANAGED_SUBSCRIPTION_POLICY_UNSUPPORTED");
    assert.equal(runtime[0], null);
    assert.equal(runtime[1], null);
    assert.equal(runtime[2], null);
    assert.equal(runtime[3], null);
  }
});

test("Piter rejects an all-stations policy and routes tournament discounts to CUP", () => {
  const invalidPolicy = managedRuntimeResponse({ allStations: true });
  const runtime = runFunction(ROUTER_FILE, {
    statusCode: 200,
    payload: invalidPolicy,
    _subscriptionBooking: baseContext("managed_runtime_context", {
      serviceDate: "2026-08-21", category: "open_game", planKey: "piter_friendship",
      managedAction: "CREATE_GAME",
      managedTarget: {
        resolutionSource: "SERVER", stationId: PITER_STATION_ID, category: "GAME",
        externalEventTypeId: "viva:direction:4588:type:1613", productTypeId: null, eventId: "exercise-target",
        durationMinutes: 60, startsAt: "2026-08-21T15:00:00.000Z",
        basePriceMinor: null, currency: "RUB",
      },
    }),
  }, MANAGED_GLOBALS);
  assert.equal(runtime[4].statusCode, 409);
  assert.equal(runtime[4].payload.details.code, "MANAGED_SUBSCRIPTION_POLICY_UNSUPPORTED");

  const tournament = runFunction(ROUTER_FILE, {
    statusCode: 200,
    payload: {
      id: "exercise-target",
      timeFrom: "2026-08-21T18:00:00+03:00",
      timeTo: "2026-08-21T19:00:00+03:00",
      direction: { id: 2617, name: "Турнир" },
      type: { id: 839, name: "Падел Турнир" },
      studio: { id: PITER_STATION_ID },
      availableClientSubscriptions: [{
        clientSubscriptionId: "client-subscription-1",
        productId: "8bf334ba-3050-4017-b40a-7eef2db1eb16",
        name: "Падел.Дружба.Питер — 12 месяцев",
        purchaseDate: MANAGED_PURCHASE_DATE,
      }],
    },
    _subscriptionBooking: baseContext("exercise", {
      serviceDate: undefined, category: undefined, planKey: undefined,
    }),
  }, MANAGED_GLOBALS);
  assert.equal(tournament[0]._subscriptionBooking.step, "managed_runtime_context");
  assert.equal(tournament[0]._subscriptionBooking.managedAction, "BOOK_TOURNAMENT");
  assert.equal(tournament[0].url,
    "https://padlhub.su/api/internal/subscriptions/runtime-context");
  assert.equal(tournament[4], null);
});

test("90 minute create and 120 minute join both proceed to the atomic CUP operation", () => {
  const futureTarget = futureManagedTarget();
  const evaluateDuration = (action: "CREATE_GAME" | "JOIN_GAME", durationMinutes: number) => {
    const ctx = baseContext("history_bookings", {
      serviceDate: futureTarget.serviceDate, category: "open_game", planKey: "piter_friendship",
      managedAction: action, managedRuntime: {
        subscriptionInstanceId: "subscription-instance-1",
        policyDigest: "a".repeat(64),
        policy: managedRuntimeResponse().policy,
        instance: managedRuntimeResponse().instance,
      },
      managedTarget: {
        resolutionSource: "SERVER", stationId: PITER_STATION_ID, category: "GAME",
        externalEventTypeId: "viva:direction:4588:type:1613", productTypeId: null, eventId: "exercise-target",
        durationMinutes, startsAt: futureTarget.startsAt,
        basePriceMinor: null, currency: "RUB",
      },
      activeBookingsPayload: { content: [] },
    });
    const history = runFunction(ROUTER_FILE, {
      statusCode: 200, payload: { content: [] }, _subscriptionBooking: ctx,
    }, MANAGED_GLOBALS);
    return history;
  };
  const create = evaluateDuration("CREATE_GAME", 90);
  assert.equal(create[1]._subscriptionBooking.step, "operation_find");
  assert.equal(create[6], null);
  const join = evaluateDuration("JOIN_GAME", 120);
  assert.equal(join[1]._subscriptionBooking.step, "operation_find");
  assert.equal(join[6], null);
});

test("blocked managed policy exposes stable blocker codes without the runtime payload", () => {
  const result = runFunction(MANAGED_BLOCKED_FILE, {
    _managedSubscriptionPolicyInput: { secretRuntimePayload: true },
    _managedSubscriptionPolicyDecision: {
      eligible: false,
      policyVersion: 1,
      blockers: [
        { code: "DURATION_NOT_ALLOWED", message: "Такая длительность недоступна" },
        { code: "DAILY_USAGE_LIMIT_REACHED", message: "Лимит исчерпан" },
      ],
    },
  });
  assert.equal(result.statusCode, 409);
  assert.equal(result.payload.details.code, "DURATION_NOT_ALLOWED");
  assert.deepEqual(result.payload.details.blockerCodes, [
    "DURATION_NOT_ALLOWED", "DAILY_USAGE_LIMIT_REACHED",
  ]);
  assert.equal(result._managedSubscriptionPolicyInput, undefined);
  assert.doesNotMatch(JSON.stringify(result.payload), /secretRuntimePayload/);
});

test("flat Viva Admin booking blocks another allowed event for the same subscription and date", () => {
  const out = runFunction(ROUTER_FILE, {
    statusCode: 200,
    payload: { content: [] },
    _subscriptionBooking: baseContext("history_bookings", {
      activeBookingsPayload: { content: [flatBooking()] },
    }),
  });
  assert.equal(out[4].statusCode, 409);
  assert.equal(out[4].payload.details.code, "SUBSCRIPTION_CATEGORY_DAILY_LIMIT_REACHED");
  assert.equal(out[4].payload.details.existingEvent.exerciseId, "exercise-existing");
});

test("untracked subscriptions use an event-scoped claim and keep the Energy daily-limit bypass", () => {
  const exercise = runFunction(ROUTER_FILE, {
    statusCode: 200,
    payload: {
      id: "exercise-target",
      timeFrom: "2026-08-10T18:00:00+03:00",
      direction: { id: 2617, name: "Турнир" },
      type: { id: 839, name: "Падел Турнир" },
      availableClientSubscriptions: [{
        clientSubscriptionId: "client-subscription-1",
        name: "Энергия 5",
      }],
    },
    _subscriptionBooking: baseContext("exercise", {
      serviceDate: undefined,
      category: undefined,
      planKey: undefined,
      trackedDailyLimit: undefined,
      limitMode: undefined,
    }),
  });
  assert.equal(exercise[0]._subscriptionBooking.planKey, null);
  assert.equal(exercise[0]._subscriptionBooking.limitMode, "event");
  assert.equal(exercise[0]._subscriptionBooking.trackedDailyLimit, false);

  const history = runFunction(ROUTER_FILE, {
    statusCode: 200,
    payload: { content: [] },
    _subscriptionBooking: {
      ...exercise[0]._subscriptionBooking,
      step: "history_bookings",
      activeBookingsPayload: { content: [flatBooking()] },
    },
  });
  assert.equal(history[1]._subscriptionBooking.step, "operation_find");
  assert.equal(
    history[1].payload._id,
    "iSkq6G:client-subscription-1:2026-08-10:exercise-target",
  );
});

test("unknown active or history payload schemas fail closed before Mongo and Viva writes", () => {
  const active = runFunction(ROUTER_FILE, {
    statusCode: 200,
    payload: { unexpected: true },
    _subscriptionBooking: baseContext("active_bookings"),
  });
  assert.equal(active[4].statusCode, 502);
  assert.equal(active[4].payload.details.code, "SUBSCRIPTION_BOOKINGS_ACTIVE_SCHEMA_UNRECOGNIZED");
  assert.equal(active[0], null);
  assert.equal(active[1], null);

  const history = runFunction(ROUTER_FILE, {
    statusCode: 200,
    payload: { unexpected: true },
    _subscriptionBooking: baseContext("history_bookings", {
      activeBookingsPayload: { content: [] },
    }),
  });
  assert.equal(history[4].statusCode, 502);
  assert.equal(history[4].payload.details.code, "SUBSCRIPTION_BOOKINGS_HISTORY_SCHEMA_UNRECOGNIZED");
  assert.equal(history[2], null);
  assert.equal(history[3], null);

  const truncated = runFunction(ROUTER_FILE, {
    statusCode: 200,
    payload: { content: [], totalElements: 1001, last: false },
    _subscriptionBooking: baseContext("active_bookings"),
  });
  assert.equal(truncated[4].statusCode, 502);
  assert.equal(truncated[4].payload.details.code, "SUBSCRIPTION_BOOKINGS_ACTIVE_INCOMPLETE");
});

test("cancelled and different exact subscriptions do not consume the atomic date slot", () => {
  const out = runFunction(ROUTER_FILE, {
    statusCode: 200,
    payload: { content: [] },
    _subscriptionBooking: baseContext("history_bookings", {
      activeBookingsPayload: {
        content: [
          flatBooking({ exercise: { id: "exercise-existing", status: "CANCELLED" } }),
          flatBooking({ id: "other-booking", clientSubscriptionId: "other-subscription" }),
        ],
      },
    }),
  });
  assert.equal(out[1]._subscriptionBooking.step, "operation_find");
  assert.equal(out[1].payload._id, "iSkq6G:client-subscription-1:2026-08-10");
  assert.deepEqual(out[1]._subscriptionBooking.cancelledSubscriptionBookings, [{
    bookingId: "booking-existing",
    exerciseId: "exercise-existing",
  }]);
});

test("confirmed operation is reclaimed only after authoritative cancellation evidence", () => {
  const operation = {
    _id: "iSkq6G:client-subscription-1:2026-08-10",
    operationId: "idem-operation-1",
    state: "CONFIRMED",
    bookingId: "booking-existing",
    exerciseId: "exercise-existing",
  };
  const reclaimed = runFunction(ROUTER_FILE, {
    payload: [operation],
    _subscriptionBooking: baseContext("operation_find", {
      cancelledSubscriptionBookings: [{
        bookingId: "booking-existing",
        exerciseId: "exercise-existing",
      }],
    }),
  });
  assert.equal(reclaimed[3]._subscriptionBooking.step, "operation_reclaim");
  assert.deepEqual(reclaimed[3].payload[0], {
    _id: operation._id,
    operationId: operation.operationId,
    state: "CONFIRMED",
  });
  assert.equal(reclaimed[3].payload[1].$set.state, "PREPARED");
  assert.equal(reclaimed[3].payload[1].$unset.bookingId, "");

  const unresolved = runFunction(ROUTER_FILE, {
    payload: [operation],
    _subscriptionBooking: baseContext("operation_find", {
      cancelledSubscriptionBookings: [],
    }),
  });
  assert.equal(unresolved[4].statusCode, 202);
  assert.equal(
    unresolved[4].payload.details.code,
    "SUBSCRIPTION_BOOKING_CONFIRMED_RECONCILIATION_REQUIRED",
  );
  assert.equal(unresolved[0], null);
  assert.equal(unresolved[3], null);

  const differentBookingSameExercise = runFunction(ROUTER_FILE, {
    payload: [operation],
    _subscriptionBooking: baseContext("operation_find", {
      cancelledSubscriptionBookings: [{
        bookingId: "older-cancelled-booking",
        exerciseId: "exercise-existing",
      }],
    }),
  });
  assert.equal(differentBookingSameExercise[4].statusCode, 202);
  assert.equal(differentBookingSameExercise[3], null);
});

test("active lease and pending confirmation never dispatch a second Viva booking", () => {
  const pending = runFunction(ROUTER_FILE, {
    payload: [{
      _id: "iSkq6G:client-subscription-1:2026-08-10",
      operationId: "another-operation",
      state: "PENDING_CONFIRMATION",
    }],
    _subscriptionBooking: baseContext("operation_find"),
  });
  assert.equal(pending[4].statusCode, 202);
  assert.equal(pending[0], null);
  assert.equal(pending[2], null);
  assert.equal(pending[3], null);

  const prepared = runFunction(ROUTER_FILE, {
    payload: [{
      _id: "iSkq6G:client-subscription-1:2026-08-10",
      operationId: "another-operation",
      state: "PREPARED",
      leaseUntil: new Date(Date.now() + 60_000).toISOString(),
    }],
    _subscriptionBooking: baseContext("operation_find"),
  });
  assert.equal(prepared[4].statusCode, 202);
  assert.equal(prepared[0], null);
});

test("expired pending claim is released only after an exact Viva readback finds no booking", () => {
  const expired = {
    _id: "iSkq6G:client-subscription-1:2026-08-10",
    operationId: "another-operation",
    actorClientId: "client-1",
    clientSubscriptionId: "client-subscription-1",
    state: "PENDING_CONFIRMATION",
    pendingUntil: "2000-01-01T00:00:00.000Z",
  };
  const reconciliation = runFunction(ROUTER_FILE, {
    payload: [expired],
    _subscriptionBooking: baseContext("operation_find"),
  });
  assert.equal(reconciliation[0]._subscriptionBooking.step, "expired_pending_reconciliation");
  assert.match(reconciliation[0].url, /\/api\/v1\/exercises\/exercise-target\/bookings\?showCancelled=true&size=200$/);
  assert.equal(reconciliation[2], null);
  assert.equal(reconciliation[3], null);

  const release = runFunction(ROUTER_FILE, {
    statusCode: 200,
    payload: { content: [] },
    _subscriptionBooking: reconciliation[0]._subscriptionBooking,
  });
  assert.equal(release[3]._subscriptionBooking.step, "operation_expired_pending_release");
  assert.deepEqual(release[3].payload[0], {
    _id: expired._id,
    operationId: expired.operationId,
    state: "PENDING_CONFIRMATION",
    pendingUntil: expired.pendingUntil,
    $and: [
      { $or: [{ bookingId: { $exists: false } }, { bookingId: null }, { bookingId: "" }] },
      { $or: [{ upstreamBookingId: { $exists: false } }, { upstreamBookingId: null }, { upstreamBookingId: "" }] },
    ],
  });
  assert.equal(release[3].payload[1].$set.state, "RELEASED");
  assert.equal(release[3].payload[1].$unset.pendingUntil, "");

  const refetch = runFunction(ROUTER_FILE, {
    payload: { matchedCount: 1 },
    _subscriptionBooking: release[3]._subscriptionBooking,
  });
  assert.equal(refetch[1]._subscriptionBooking.step, "operation_find");
});

test("expired pending claim stays blocked when Viva has an active exact booking or incomplete identity", () => {
  const expired = {
    _id: "iSkq6G:client-subscription-1:2026-08-10",
    operationId: "another-operation",
    actorClientId: "client-1",
    clientSubscriptionId: "client-subscription-1",
    state: "PENDING_CONFIRMATION",
    pendingUntil: "2000-01-01T00:00:00.000Z",
  };
  const reconciliation = runFunction(ROUTER_FILE, {
    payload: [expired],
    _subscriptionBooking: baseContext("operation_find"),
  });
  const active = runFunction(ROUTER_FILE, {
    statusCode: 200,
    payload: { content: [flatBooking({ clientId: "client-1", exerciseId: "exercise-target" })] },
    _subscriptionBooking: reconciliation[0]._subscriptionBooking,
  });
  assert.equal(active[4].statusCode, 202);
  assert.equal(active[3], null);

  const incomplete = runFunction(ROUTER_FILE, {
    statusCode: 200,
    payload: { content: [{ id: "opaque", clientId: "client-1" }] },
    _subscriptionBooking: reconciliation[0]._subscriptionBooking,
  });
  assert.equal(incomplete[4].statusCode, 202);
  assert.equal(incomplete[3], null);
});

test("definitive failed attempt can be retried without releasing an ambiguous pending claim", () => {
  const failed = runFunction(ROUTER_FILE, {
    payload: [{
      _id: "iSkq6G:client-subscription-1:2026-08-10",
      operationId: "idem-operation-1",
      state: "FAILED",
      failure: { statusCode: 409, rawCode: "NO_SPOTS" },
    }],
    _subscriptionBooking: baseContext("operation_find"),
  });
  assert.equal(failed[3]._subscriptionBooking.step, "operation_reclaim");
  assert.equal(failed[3].payload[0].state, "FAILED");
  assert.equal(failed[3].payload[1].$set.state, "PREPARED");
});

test("new operation is inserted, persisted as pending, then posts exact subscription through Admin v2", () => {
  const insert = runFunction(ROUTER_FILE, {
    payload: [],
    _subscriptionBooking: baseContext("operation_find"),
  });
  assert.equal(insert[2]._subscriptionBooking.step, "operation_insert");
  assert.equal(insert[2].payload.state, "PREPARED");

  const preaccept = runFunction(ROUTER_FILE, {
    payload: { acknowledged: true, insertedId: "operation" },
    _subscriptionBooking: insert[2]._subscriptionBooking,
  });
  assert.equal(preaccept[3]._subscriptionBooking.step, "operation_preaccept");
  assert.equal(preaccept[3].payload[1].$set.state, "PENDING_CONFIRMATION");

  const recheck = runFunction(ROUTER_FILE, {
    payload: { acknowledged: true, matchedCount: 1 },
    _subscriptionBooking: preaccept[3]._subscriptionBooking,
  });
  assert.equal(recheck[0]._subscriptionBooking.step, "exercise_recheck");
  const create = runFunction(ROUTER_FILE, {
    statusCode: 200,
    payload: trustedExercise(),
    _subscriptionBooking: recheck[0]._subscriptionBooking,
  });
  assert.equal(create[0]._subscriptionBooking.step, "booking_create");
  assert.match(create[0].url, /\/api\/v2\/exercises\/exercise-target\/bookings$/);
  assert.equal(create[0].payload.clientId, "client-1");
  assert.equal(create[0].payload.clientSubscriptionId, "client-subscription-1");
  assert.equal(create[0].payload.paymentType, "SUBSCRIPTION");
  assert.deepEqual(create[0].payload.customFields, []);
  assert.equal("familyMemberId" in create[0].payload, false);
  assert.equal("count" in create[0].payload, false, "direct tournament/group booking remains one visit");

  const splitRecheck = runFunction(ROUTER_FILE, {
    payload: { acknowledged: true, matchedCount: 1 },
    _subscriptionBooking: baseContext("operation_preaccept", {
      caller: "split",
      subscriptionVisitCount: 2,
    }),
  });
  const splitCreate = runFunction(ROUTER_FILE, {
    statusCode: 200,
    payload: trustedExercise(),
    _subscriptionBooking: splitRecheck[0]._subscriptionBooking,
  });
  assert.equal(splitCreate[0].payload.count, 2, "split keeps the existing 90/120-minute debit contract");
  assert.match(splitCreate[0].url, /\/api\/v1\/exercises\/exercise-target\/bookings$/);
  assert.equal(
    splitCreate[0]._subscriptionBooking.operationKey,
    "iSkq6G:client-subscription-1:2026-08-10",
    "the debit count still consumes one daily event slot",
  );
});

test("ordinary subscription eligibility is re-read after preaccept and fails if ownership disappeared", () => {
  const missing = runFunction(ROUTER_FILE, {
    statusCode: 200,
    payload: { ...trustedExercise(), availableClientSubscriptions: [] },
    _subscriptionBooking: baseContext("exercise_recheck"),
  });
  assert.equal(missing[0], null);
  assert.equal(missing[3]._subscriptionBooking.step, "operation_fail");
  assert.equal(missing[3].payload[1].$set.failure.rawCode,
    "SUBSCRIPTION_ELIGIBILITY_CHANGED_BEFORE_WRITE");
});

test("final pre-write recheck rejects product or rollout drift without a Viva request", () => {
  const managedContext = baseContext("exercise_recheck", {
    serviceDate: "2026-08-21",
    studioId: PITER_STATION_ID,
    planKey: "piter_friendship",
    category: "open_game",
    managedAction: "CREATE_GAME",
    managedTarget: {
      resolutionSource: "SERVER",
      stationId: PITER_STATION_ID,
      category: "GAME",
      externalEventTypeId: "viva:direction:4588:type:1613",
      productTypeId: null,
      eventId: "exercise-target",
      durationMinutes: 60,
      startsAt: "2026-08-21T15:00:00.000Z",
      basePriceMinor: null,
      currency: "RUB",
    },
  });

  const changedProduct = runFunction(ROUTER_FILE, {
    statusCode: 200,
    payload: managedExercise(HUB_PRODUCT_ID, "Падел.Дружба.ХАБ — 12 месяцев"),
    _subscriptionBooking: structuredClone(managedContext),
  }, MANAGED_GLOBALS);
  assert.equal(changedProduct[3]._subscriptionBooking.step, "operation_fail");
  assert.equal(changedProduct[3].payload[1].$set.failure.rawCode,
    "SUBSCRIPTION_PRODUCT_IDENTITY_CHANGED_BEFORE_WRITE");
  assert.equal(changedProduct[0], null);

  const changedRollout = runFunction(ROUTER_FILE, {
    statusCode: 200,
    payload: managedExercise(),
    _subscriptionBooking: structuredClone(managedContext),
  }, {
    vivacrm_access_token: "service-token",
    subscriptions_managed_enforcement_product_ids: [],
  });
  assert.equal(changedRollout[3]._subscriptionBooking.step, "operation_fail");
  assert.equal(changedRollout[3].payload[1].$set.failure.rawCode,
    "MANAGED_SUBSCRIPTION_ENFORCEMENT_CHANGED_BEFORE_WRITE");
  assert.equal(changedRollout[0], null);

  const changedPurchaseDate = runFunction(ROUTER_FILE, {
    statusCode: 200,
    payload: managedExercise(
      PITER_PRODUCT_ID,
      "Падел.Дружба.Питер — 12 месяцев",
      "2026-08-31T23:59:59+03:00",
    ),
    _subscriptionBooking: structuredClone(managedContext),
  }, MANAGED_GLOBALS);
  assert.equal(changedPurchaseDate[3]._subscriptionBooking.step, "operation_fail");
  assert.equal(changedPurchaseDate[3].payload[1].$set.failure.rawCode,
    "SUBSCRIPTION_PURCHASE_DATE_CHANGED_BEFORE_WRITE");
  assert.equal(changedPurchaseDate[0], null);

  const malformedPurchaseDate = runFunction(ROUTER_FILE, {
    statusCode: 200,
    payload: managedExercise(
      PITER_PRODUCT_ID,
      "Падел.Дружба.Питер — 12 месяцев",
      "invalid-purchase-date",
    ),
    _subscriptionBooking: structuredClone(managedContext),
  }, MANAGED_GLOBALS);
  assert.equal(malformedPurchaseDate[3]._subscriptionBooking.step, "operation_fail");
  assert.equal(malformedPurchaseDate[3].payload[1].$set.failure.rawCode,
    "SUBSCRIPTION_PURCHASE_DATE_UNRESOLVED");
  assert.equal(malformedPurchaseDate[0], null);

  const missingPurchaseDate = runFunction(ROUTER_FILE, {
    statusCode: 200,
    payload: managedExercise(PITER_PRODUCT_ID, "Падел.Дружба.Питер — 12 месяцев", null),
    _subscriptionBooking: structuredClone(managedContext),
  }, MANAGED_GLOBALS);
  assert.equal(missingPurchaseDate[3]._subscriptionBooking.step, "operation_fail");
  assert.equal(missingPurchaseDate[3].payload[1].$set.failure.rawCode,
    "SUBSCRIPTION_PURCHASE_DATE_UNRESOLVED");
  assert.equal(missingPurchaseDate[0], null);

  const conflictingPurchaseDates = managedExercise();
  conflictingPurchaseDates.availableClientSubscriptions.push({
    ...conflictingPurchaseDates.availableClientSubscriptions[0],
    purchaseDate: "2026-08-31T23:59:59+03:00",
  });
  const conflictingPurchaseDate = runFunction(ROUTER_FILE, {
    statusCode: 200,
    payload: conflictingPurchaseDates,
    _subscriptionBooking: structuredClone(managedContext),
  }, MANAGED_GLOBALS);
  assert.equal(conflictingPurchaseDate[3]._subscriptionBooking.step, "operation_fail");
  assert.equal(conflictingPurchaseDate[3].payload[1].$set.failure.rawCode,
    "SUBSCRIPTION_PURCHASE_DATE_UNRESOLVED");
  assert.equal(conflictingPurchaseDate[0], null);
});

test("managed booking rechecks CUP identity and policy after preaccept before Viva write", () => {
  const runtime = managedRuntimeResponse();
  const target = futureManagedTarget();
  const managedContext = baseContext("operation_preaccept", {
    serviceDate: target.serviceDate,
    studioId: PITER_STATION_ID,
    planKey: "piter_friendship",
    category: "open_game",
    managedAction: "CREATE_GAME",
    managedTarget: {
      resolutionSource: "SERVER",
      stationId: PITER_STATION_ID,
      category: "GAME",
      externalEventTypeId: "viva:direction:4588:type:1613",
      productTypeId: null,
      eventId: "exercise-target",
      durationMinutes: 60,
      startsAt: target.startsAt,
      basePriceMinor: null,
      currency: "RUB",
    },
    managedRuntime: {
      subscriptionInstanceId: runtime.subscriptionInstanceId,
      policyDigest: runtime.policyDigest,
      policy: runtime.policy,
      instance: runtime.instance,
      evidence: runtime.evidence,
    },
    managedActivationRequired: false,
    managedActivationExpectedRevision: 1,
  });

  const exerciseRecheck = runFunction(ROUTER_FILE, {
    payload: { acknowledged: true, matchedCount: 1 },
    _subscriptionBooking: managedContext,
  }, MANAGED_GLOBALS);
  assert.equal(exerciseRecheck[0]._subscriptionBooking.step, "exercise_recheck");
  const recheck = runFunction(ROUTER_FILE, {
    statusCode: 200,
    payload: {
      ...trustedExercise({
        directionId: 4588,
        planName: "Падел.Дружба.Питер — 12 месяцев",
        productId: "8bf334ba-3050-4017-b40a-7eef2db1eb16",
        studioId: PITER_STATION_ID,
        typeId: 1613,
      }),
      timeFrom: target.startsAt,
      timeTo: new Date(new Date(target.startsAt).getTime() + 60 * 60 * 1000).toISOString(),
      availableClientSubscriptions: [{
        ...trustedExercise({
          directionId: 4588,
          planName: "Падел.Дружба.Питер — 12 месяцев",
          productId: PITER_PRODUCT_ID,
          studioId: PITER_STATION_ID,
          typeId: 1613,
        }).availableClientSubscriptions[0],
        purchaseDate: MANAGED_PURCHASE_DATE,
      }],
    },
    _subscriptionBooking: exerciseRecheck[0]._subscriptionBooking,
  }, MANAGED_GLOBALS);
  assert.ok(recheck[0], JSON.stringify(recheck[3]?.payload ?? recheck[4]?.payload));
  assert.equal(recheck[0]._subscriptionBooking.step, "managed_runtime_recheck");
  assert.equal(recheck[0].url, "https://padlhub.su/api/internal/subscriptions/runtime-context");

  const changed = runFunction(ROUTER_FILE, {
    statusCode: 200,
    payload: managedRuntimeResponse({
      policyDigest: "b".repeat(64),
      evidence: { mappingRevision: 1, instanceRevision: 2 },
    }),
    _subscriptionBooking: structuredClone(recheck[0]._subscriptionBooking),
  }, MANAGED_GLOBALS);
  assert.equal(changed[3]._subscriptionBooking.step, "operation_fail");
  assert.equal(changed[3].payload[1].$set.failure.rawCode,
    "MANAGED_SUBSCRIPTION_RUNTIME_CHANGED_BEFORE_WRITE");
  assert.equal(changed[0], null, "changed authoritative identity never reaches Viva");

  const unchanged = runFunction(ROUTER_FILE, {
    statusCode: 200,
    payload: runtime,
    _subscriptionBooking: structuredClone(recheck[0]._subscriptionBooking),
  }, MANAGED_GLOBALS);
  assert.equal(unchanged[0]._subscriptionBooking.step, "managed_entitlement_reserve");
  assert.equal(unchanged[0].url,
    "https://padlhub.su/api/internal/subscriptions/entitlements/reserve");
  assert.equal(unchanged[0].headers.Authorization, "Bearer user-token");
  assert.equal(unchanged[0].headers["X-Subscriptions-Integration-Token"],
    "entitlement-integration-token-1234567890");
  assert.deepEqual(unchanged[0].payload, {
    subscriptionInstanceId: "subscription-instance-1",
    action: "CREATE_GAME",
    target: { targetId: "exercise-target" },
  });

  const reserved = runFunction(ROUTER_FILE, {
    statusCode: 200,
    payload: {
      schemaVersion: 1,
      outcome: "RESERVED",
      replayed: false,
      operationId: "booking:entitlement-operation-1",
      subscriptionInstanceId: "subscription-instance-1",
      aggregateRevision: 2,
      operationState: "RESERVED",
      blockers: [],
      decision: {
        decisionKind: "ENTITLEMENT",
        policyVersion: 1,
        policyDigest: "a".repeat(64),
        action: "CREATE_GAME",
        target: {
          targetId: "exercise-target",
          stationId: PITER_STATION_ID,
          eventTypeId: "viva:direction:4588:type:1613",
          productTypeId: null,
          durationMinutes: 60,
          startsAt: target.startsAt,
        },
        usageUnits: 1,
        money: {
          basePriceMinor: 150000,
          discountMinor: 150000,
          surchargeMinor: 0,
          finalPriceMinor: 0,
          currency: "RUB",
        },
      },
    },
    _subscriptionBooking: unchanged[0]._subscriptionBooking,
  }, MANAGED_GLOBALS);
  assert.equal(reserved[3]._subscriptionBooking.step, "operation_entitlement_bind");
  assert.equal(reserved[3].payload[1].$set.managedEntitlementOperationId,
    "booking:entitlement-operation-1");
  const create = runFunction(ROUTER_FILE, {
    payload: { matchedCount: 1 },
    _subscriptionBooking: reserved[3]._subscriptionBooking,
  }, MANAGED_GLOBALS);
  assert.equal(create[0]._subscriptionBooking.step, "booking_create");
  assert.equal(create[0].payload.clientSubscriptionId, "client-subscription-1");
  assert.equal(create[0].payload.paymentType, "SUBSCRIPTION");
});

test("entitlement token is never sent when the configured origin is not the trusted CUP origin", () => {
  const out = runFunction(ROUTER_FILE, {
    statusCode: 200,
    payload: managedRuntimeResponse(),
    _subscriptionBooking: entitlementContext("managed_runtime_recheck", {
      managedActivationRequired: false,
    }),
  }, {
    ...MANAGED_GLOBALS,
    subscriptions_runtime_api_base_url: "https://attacker.example/api",
    subscriptions_entitlement_integration_token: "do-not-leak-entitlement-token-123456",
  });

  assert.equal(out[0], null);
  assert.equal(out[3]._subscriptionBooking.step, "operation_fail");
  assert.equal(out[3].payload[1].$set.failure.rawCode,
    "SUBSCRIPTION_ENTITLEMENT_ORIGIN_NOT_TRUSTED");
  assert.doesNotMatch(JSON.stringify(out), /do-not-leak-entitlement-token/);
});

test("CUP active-service limit releases the local claim into an explicit full-price fallback", () => {
  const fallback = runFunction(ROUTER_FILE, {
    statusCode: 200,
    payload: {
      schemaVersion: 1,
      outcome: "FULL_PRICE_WITHOUT_SUBSCRIPTION",
      replayed: false,
      operationId: null,
      subscriptionInstanceId: "subscription-instance-1",
      aggregateRevision: 4,
      operationState: null,
      decision: null,
      blockers: [{ code: "ACTIVE_SERVICES_LIMIT_REACHED" }],
    },
    _subscriptionBooking: entitlementContext("managed_entitlement_reserve"),
  }, MANAGED_GLOBALS);
  assert.equal(fallback[3]._subscriptionBooking.step, "operation_full_price_fallback");
  assert.equal(fallback[3].payload[1].$set.state, "RELEASED");

  const done = runFunction(ROUTER_FILE, {
    payload: { matchedCount: 1 },
    _subscriptionBooking: fallback[3]._subscriptionBooking,
  }, MANAGED_GLOBALS);
  assert.equal(done[4].payload.state, "FULL_PRICE_WITHOUT_SUBSCRIPTION");
  assert.equal(done[4].payload.blockers[0].code, "ACTIVE_SERVICES_LIMIT_REACHED");
});

test("replayed already-confirmed entitlement never dispatches a second Viva booking", () => {
  const replay = runFunction(ROUTER_FILE, {
    statusCode: 200,
    payload: {
      schemaVersion: 1,
      outcome: "RESERVED",
      replayed: true,
      operationId: "booking:already-confirmed",
      subscriptionInstanceId: "subscription-instance-1",
      aggregateRevision: 5,
      operationState: "CONFIRMED",
      decision: entitlementDecision(),
      blockers: [],
    },
    _subscriptionBooking: entitlementContext("managed_entitlement_reserve"),
  }, MANAGED_GLOBALS);
  assert.equal(replay[3]._subscriptionBooking.step, "operation_entitlement_bind");

  const pending = runFunction(ROUTER_FILE, {
    payload: { matchedCount: 1 },
    _subscriptionBooking: replay[3]._subscriptionBooking,
  }, MANAGED_GLOBALS);
  assert.equal(pending[4].statusCode, 202);
  assert.equal(pending[4].payload.details.code,
    "SUBSCRIPTION_ENTITLEMENT_CONFIRMED_RECONCILIATION_REQUIRED");
  assert.equal(pending[0], null);
});

test("discounted entitlement is released without a Viva write until provider pricing is wired", () => {
  const reserved = runFunction(ROUTER_FILE, {
    statusCode: 200,
    payload: {
      schemaVersion: 1,
      outcome: "RESERVED",
      replayed: false,
      operationId: "booking:discounted-entitlement",
      subscriptionInstanceId: "subscription-instance-1",
      aggregateRevision: 5,
      operationState: "RESERVED",
      decision: entitlementDecision({ finalPriceMinor: 52500, durationMinutes: 90 }),
      blockers: [],
    },
    _subscriptionBooking: entitlementContext("managed_entitlement_reserve", {
      managedTarget: {
        stationId: PITER_STATION_ID,
        externalEventTypeId: "viva:direction:4588:type:1613",
        productTypeId: null,
        durationMinutes: 90,
        startsAt: "2026-08-21T15:00:00.000Z",
      },
    }),
  }, MANAGED_GLOBALS);
  assert.equal(reserved[3]._subscriptionBooking.step, "operation_entitlement_bind");

  const release = runFunction(ROUTER_FILE, {
    payload: { matchedCount: 1 },
    _subscriptionBooking: reserved[3]._subscriptionBooking,
  }, MANAGED_GLOBALS);
  assert.equal(release[0]._subscriptionBooking.step, "managed_entitlement_release");
  assert.equal(release[0].url,
    "https://padlhub.su/api/internal/subscriptions/entitlements/release");
  assert.equal(release[0].payload.reason, "PROVIDER_REJECTED");
  assert.doesNotMatch(release[0].url, /vivacrm/);

  const released = runFunction(ROUTER_FILE, {
    statusCode: 200,
    payload: {
      schemaVersion: 1,
      outcome: "RELEASED",
      replayed: false,
      operationId: "booking:discounted-entitlement",
      subscriptionInstanceId: "subscription-instance-1",
      aggregateRevision: 6,
      operationState: "FAILED",
    },
    _subscriptionBooking: release[0]._subscriptionBooking,
  }, MANAGED_GLOBALS);
  assert.equal(released[3]._subscriptionBooking.step, "operation_fail");
  assert.equal(released[3].payload[1].$set.failure.rawCode,
    "MANAGED_SUBSCRIPTION_PROVIDER_PRICING_NOT_CONFIGURED");

  const failed = runFunction(ROUTER_FILE, {
    payload: { matchedCount: 1 },
    _subscriptionBooking: released[3]._subscriptionBooking,
  }, MANAGED_GLOBALS);
  assert.equal(failed[4].statusCode, 409);
  assert.equal(failed[4].payload.details.code,
    "MANAGED_SUBSCRIPTION_PROVIDER_PRICING_NOT_CONFIGURED");
  assert.equal(failed[0], null);
});

test("definitive Viva rejection releases the exact reserved entitlement before returning the error", () => {
  const release = runFunction(ROUTER_FILE, {
    statusCode: 409,
    payload: { message: "No available spots", code: "NO_SPOTS" },
    _subscriptionBooking: entitlementContext("booking_create", {
      managedEntitlementOperationId: "booking:provider-rejected",
      managedDecision: entitlementDecision(),
    }),
  }, MANAGED_GLOBALS);
  assert.equal(release[0]._subscriptionBooking.step, "managed_entitlement_release");
  assert.equal(release[0].payload.operationId, "booking:provider-rejected");

  const persist = runFunction(ROUTER_FILE, {
    statusCode: 200,
    payload: {
      schemaVersion: 1,
      outcome: "RELEASED",
      replayed: false,
      operationId: "booking:provider-rejected",
      subscriptionInstanceId: "subscription-instance-1",
      aggregateRevision: 7,
      operationState: "FAILED",
    },
    _subscriptionBooking: release[0]._subscriptionBooking,
  }, MANAGED_GLOBALS);
  assert.equal(persist[3]._subscriptionBooking.step, "operation_fail");
  const done = runFunction(ROUTER_FILE, {
    payload: { matchedCount: 1 },
    _subscriptionBooking: persist[3]._subscriptionBooking,
  }, MANAGED_GLOBALS);
  assert.equal(done[4].statusCode, 409);
  assert.equal(done[4].payload.details.code, "NO_SPOTS");
});

test("Viva readback must be followed by exact CUP entitlement confirmation", () => {
  const confirm = runFunction(ROUTER_FILE, {
    payload: { matchedCount: 1 },
    _subscriptionBooking: entitlementContext("operation_confirm", {
      managedEntitlementOperationId: "booking:confirmed-entitlement",
      confirmedBookingId: "booking-viva-1",
    }),
  }, MANAGED_GLOBALS);
  assert.equal(confirm[0]._subscriptionBooking.step, "managed_entitlement_confirm");
  assert.equal(confirm[0].payload.providerBookingId, "booking-viva-1");
  assert.equal(confirm[0].url,
    "https://padlhub.su/api/internal/subscriptions/entitlements/confirm");

  const bound = runFunction(ROUTER_FILE, {
    statusCode: 200,
    payload: {
      schemaVersion: 1,
      outcome: "CONFIRMED",
      replayed: false,
      operationId: "booking:confirmed-entitlement",
      subscriptionInstanceId: "subscription-instance-1",
      aggregateRevision: 8,
      operationState: "CONFIRMED",
    },
    _subscriptionBooking: confirm[0]._subscriptionBooking,
  }, MANAGED_GLOBALS);
  assert.equal(bound[3]._subscriptionBooking.step, "operation_entitlement_confirm");
  const done = runFunction(ROUTER_FILE, {
    payload: { matchedCount: 1 },
    _subscriptionBooking: bound[3]._subscriptionBooking,
  }, MANAGED_GLOBALS);
  assert.equal(done[4].statusCode, 201);
  assert.equal(done[4].payload.bookingId, "booking-viva-1");
});

test("verified Viva cancellation releases CUP before changing the local operation", () => {
  const release = runFunction(ROUTER_FILE, {
    payload: [{
      _id: "managed-operation",
      operationId: "original-operation",
      state: "CONFIRMED",
      exerciseId: "exercise-target",
      clientSubscriptionId: "client-subscription-1",
      serviceDate: "2026-08-10",
      bookingId: "booking-viva-1",
      managedEntitlementOperationId: "booking:cancelled-entitlement",
      managedSubscriptionInstanceId: "subscription-instance-1",
    }],
    _subscriptionBooking: baseContext("operation_find", {
      action: "release",
      releaseBookingId: "booking-viva-1",
    }),
  }, MANAGED_GLOBALS);
  assert.equal(release[0]._subscriptionBooking.step, "managed_entitlement_release");
  assert.equal(release[0].payload.reason, "BOOKING_CANCELLED");
  assert.equal(release[0].payload.providerBookingId, "booking-viva-1");

  const local = runFunction(ROUTER_FILE, {
    statusCode: 200,
    payload: {
      schemaVersion: 1,
      outcome: "RELEASED",
      replayed: false,
      operationId: "booking:cancelled-entitlement",
      subscriptionInstanceId: "subscription-instance-1",
      aggregateRevision: 9,
      operationState: "COMPENSATED",
    },
    _subscriptionBooking: release[0]._subscriptionBooking,
  }, MANAGED_GLOBALS);
  assert.equal(local[3]._subscriptionBooking.step, "operation_release");
  assert.equal(local[3].payload[1].$set.state, "RELEASED");
});

test("expired ambiguous managed claim releases CUP before the local lease", () => {
  const operation = {
    _id: "managed-expired-operation",
    operationId: "idem-operation-1",
    state: "PENDING_CONFIRMATION",
    actorClientId: "client-1",
    clientSubscriptionId: "client-subscription-1",
    exerciseId: "exercise-target",
    managedEntitlementOperationId: "booking:expired-entitlement",
    managedSubscriptionInstanceId: "subscription-instance-1",
  };
  const release = runFunction(ROUTER_FILE, {
    statusCode: 200,
    payload: { content: [] },
    _subscriptionBooking: baseContext("expired_pending_reconciliation", {
      expiredPendingOperation: operation,
    }),
  }, MANAGED_GLOBALS);
  assert.equal(release[0]._subscriptionBooking.step, "managed_entitlement_release");
  assert.equal(release[0].payload.operationId, "booking:expired-entitlement");

  const local = runFunction(ROUTER_FILE, {
    statusCode: 200,
    payload: {
      schemaVersion: 1,
      outcome: "RELEASED",
      replayed: false,
      operationId: "booking:expired-entitlement",
      subscriptionInstanceId: "subscription-instance-1",
      aggregateRevision: 10,
      operationState: "FAILED",
    },
    _subscriptionBooking: release[0]._subscriptionBooking,
  }, MANAGED_GLOBALS);
  assert.equal(local[3]._subscriptionBooking.step, "operation_expired_pending_release");
  assert.equal(local[3].payload[1].$set.state, "RELEASED");
});

test("managed lifecycle cancellation is rejected by the atomic CUP reserve before Viva write", () => {
  const runtime = managedRuntimeResponse();
  const target = futureManagedTarget();
  const rechecked = runFunction(ROUTER_FILE, {
    statusCode: 200,
    payload: managedRuntimeResponse({ instance: { state: "CANCELLED" } }),
    _subscriptionBooking: baseContext("managed_runtime_recheck", {
      planKey: "piter_friendship",
      serviceDate: target.serviceDate,
      category: "open_game",
      managedAction: "CREATE_GAME",
      managedTarget: {
        resolutionSource: "SERVER", stationId: PITER_STATION_ID, category: "GAME",
        externalEventTypeId: "viva:direction:4588:type:1613", productTypeId: null, eventId: "exercise-target",
        durationMinutes: 60, startsAt: target.startsAt,
        basePriceMinor: null, currency: "RUB",
      },
      managedRuntime: {
        subscriptionInstanceId: runtime.subscriptionInstanceId,
        policyDigest: runtime.policyDigest,
        policy: runtime.policy,
        instance: runtime.instance,
        evidence: runtime.evidence,
      },
      managedActivationRequired: false,
    }),
  }, MANAGED_GLOBALS);
  assert.equal(rechecked[0]._subscriptionBooking.step, "managed_entitlement_reserve");
  const failed = runFunction(ROUTER_FILE, {
    statusCode: 409,
    payload: { code: "SUBSCRIPTION_ENTITLEMENT_BLOCKED" },
    _subscriptionBooking: rechecked[0]._subscriptionBooking,
  }, MANAGED_GLOBALS);
  assert.equal(failed[3]._subscriptionBooking.step, "operation_fail");
  assert.equal(failed[3].payload[1].$set.failure.rawCode,
    "SUBSCRIPTION_ENTITLEMENT_BLOCKED");
  assert.equal(failed[0], null);
});

test("ambiguous upstream result remains pending while definitive rejection is persisted", () => {
  const ambiguous = runFunction(ROUTER_FILE, {
    statusCode: 502,
    error: { message: "socket reset" },
    payload: null,
    _subscriptionBooking: baseContext("booking_create"),
  });
  assert.equal(ambiguous[4].statusCode, 202);
  assert.equal(ambiguous[4].payload.state, "PENDING_CONFIRMATION");
  assert.equal(ambiguous[3], null);

  const rejected = runFunction(ROUTER_FILE, {
    statusCode: 409,
    payload: { message: "No available spots", code: "NO_SPOTS" },
    _subscriptionBooking: baseContext("booking_create"),
  });
  assert.equal(rejected[3]._subscriptionBooking.step, "operation_fail");
  assert.equal(rejected[3].payload[1].$set.state, "FAILED");
});

test("ambiguous upstream claim expires into Viva reconciliation after fifteen minutes", () => {
  const preaccept = runFunction(ROUTER_FILE, {
    payload: { acknowledged: true, insertedId: "operation" },
    _subscriptionBooking: baseContext("operation_insert"),
  });
  const pendingUntil = Date.parse(preaccept[3].payload[1].$set.pendingUntil);
  const upstreamAttemptedAt = Date.parse(preaccept[3].payload[1].$set.upstreamAttemptedAt);
  assert.ok(Number.isFinite(pendingUntil));
  assert.equal(pendingUntil - upstreamAttemptedAt, 15 * 60 * 1000);
});

test("accepted booking is confirmed only after exact-subscription readback", () => {
  const accept = runFunction(ROUTER_FILE, {
    statusCode: 202,
    payload: { correlationId: "corr-1" },
    _subscriptionBooking: baseContext("booking_create"),
  });
  assert.equal(accept[3]._subscriptionBooking.step, "operation_accept");

  const readbackRequest = runFunction(ROUTER_FILE, {
    payload: { matchedCount: 1 },
    _subscriptionBooking: accept[3]._subscriptionBooking,
  });
  assert.equal(readbackRequest[0]._subscriptionBooking.step, "confirmation_bookings");

  const confirm = runFunction(ROUTER_FILE, {
    statusCode: 200,
    payload: { content: [flatBooking({
      id: "booking-created",
      exerciseId: "exercise-target",
      exerciseDirection: { id: 2617 },
      exerciseType: { id: 839 },
    })] },
    _subscriptionBooking: readbackRequest[0]._subscriptionBooking,
  });
  assert.equal(confirm[3]._subscriptionBooking.step, "operation_confirm");
  assert.equal(confirm[3].payload[1].$set.bookingId, "booking-created");

  const done = runFunction(ROUTER_FILE, {
    payload: { matchedCount: 1 },
    _subscriptionBooking: confirm[3]._subscriptionBooking,
  });
  assert.equal(done[4].statusCode, 201);
  assert.equal(done[4].payload.state, "CONFIRMED");
  assert.equal(done[4].payload.bookingId, "booking-created");
});

test("split caller receives a synthetic trusted booking only after gateway confirmation", () => {
  const out = runFunction(FINALIZE_FILE, {
    statusCode: 201,
    payload: { state: "CONFIRMED", bookingId: "booking-created" },
    _subscriptionBooking: baseContext("operation_confirm", { caller: "split", confirmedSpot: 2 }),
    _splitCtx: { paymentMode: "subscription", clientSubscriptionId: "client-subscription-1" },
  });
  assert.equal(out[0]._splitCtx.subscriptionGuardDone, true);
  assert.equal(out[0]._splitCtx.step, "create_booking");
  assert.equal(out[0].payload.id, "booking-created");
  assert.equal(out[1], null);
});

test("active-service limit keeps the created exercise and continues at full price", () => {
  const finalized = runFunction(FINALIZE_FILE, {
    statusCode: 200,
    payload: {
      ok: true,
      state: "FULL_PRICE_WITHOUT_SUBSCRIPTION",
      blockers: [{ code: "ACTIVE_SERVICES_LIMIT_REACHED" }],
    },
    _subscriptionBooking: baseContext("operation_full_price_fallback", {
      caller: "split",
      exerciseId: "exercise-created",
    }),
    _splitCtx: {
      action: "create",
      step: "create_booking",
      token: "service-token",
      exerciseId: "exercise-created",
      ownsExercise: true,
      clientPhone: "+79990000001",
    },
  });

  assert.equal(finalized[1], null);
  assert.equal(finalized[0].statusCode, 200);
  assert.equal(finalized[0]._splitCtx.step, "subscription_full_price_fallback");
  assert.equal(finalized[0]._splitCtx.paymentMode, "one_time");
  assert.equal(finalized[0]._splitCtx.subscriptionGuardDone, true);
  assert.equal(finalized[0]._splitCtx.fullPriceFallback.blockers[0].code,
    "ACTIVE_SERVICES_LIMIT_REACHED");

  const createAtFullPrice = runFunction(SPLIT_ROUTER_FILE, finalized[0]);
  assert.equal(createAtFullPrice[0]._splitCtx.step, "create_booking");
  assert.equal(createAtFullPrice[0].method, "POST");
  assert.match(createAtFullPrice[0].url, /\/exercises\/exercise-created\/bookings$/);
  assert.equal(createAtFullPrice[0].payload.paymentType, "ON_PLACE");
  assert.equal(createAtFullPrice[0].payload.clientSubscriptionId, undefined);
  assert.doesNotMatch(createAtFullPrice[0].url, /delete/i);
});

test("split rejection never compensates an exercise not owned by this CREATE", () => {
  for (const splitCtx of [
    {
      action: "create",
      step: "create_booking",
      exerciseId: "exercise-conflict",
      ownsExercise: false,
      reusedConflictingExercise: true,
    },
    {
      action: "join",
      step: "create_booking",
      exerciseId: "exercise-existing",
      ownsExercise: false,
    },
  ]) {
    const out = runFunction(FINALIZE_FILE, {
      statusCode: 409,
      payload: {
        error: "Правила подписки не разрешили запись",
        details: { code: "MANAGED_SUBSCRIPTION_POLICY_BLOCKED" },
      },
      _subscriptionBooking: baseContext("managed_policy_decision", { caller: "split" }),
      _splitCtx: splitCtx,
    });
    assert.equal(out[0], null);
    assert.equal(out[1].statusCode, 409);
    assert.equal(out[1]._splitCtx.step, "create_booking");
  }
});

test("split pending confirmation never starts exercise compensation", () => {
  const out = runFunction(FINALIZE_FILE, {
    statusCode: 202,
    payload: {
      ok: true,
      state: "PENDING_CONFIRMATION",
      message: "Запись ожидает подтверждения Viva",
    },
    _subscriptionBooking: baseContext("confirmation_bookings", {
      caller: "split",
      exerciseId: "exercise-created",
    }),
    _splitCtx: {
      action: "create",
      step: "create_booking",
      exerciseId: "exercise-created",
      ownsExercise: true,
    },
  });

  assert.equal(out[0], null);
  assert.equal(out[1].statusCode, 202);
  assert.equal(out[1].payload.state, "PENDING_CONFIRMATION");
  assert.equal(out[1]._splitCtx.step, "create_booking");
  assert.equal(out[1]._splitCtx.bookingFailure, undefined);
});

test("managed rejection never deletes an owned exercise with an ambiguous booking readback", () => {
  const out = runFunction(SPLIT_ROUTER_FILE, {
    statusCode: 200,
    payload: [{ id: "booking-other", client: { id: "other-client" } }],
    _splitCtx: {
      action: "create",
      step: "reconcile_booking_after_failure",
      token: "service-token",
      exerciseId: "exercise-created",
      ownsExercise: true,
      clientId: "client-1",
      clientPhone: "+79990000001",
      bookingFailure: {
        statusCode: 409,
        source: "MANAGED_SUBSCRIPTION_GATEWAY",
        payload: {
          error: "Правила подписки не разрешили запись",
          details: { code: "MANAGED_SUBSCRIPTION_POLICY_BLOCKED" },
        },
      },
    },
  });

  assert.equal(out[0], null);
  assert.equal(out[1].statusCode, 409);
  assert.equal(out[1].payload.details.code, "SPLIT_BOOKING_RECONCILIATION_AMBIGUOUS");
  assert.equal(out[1].payload.details.destructiveRetryBlocked, true);
});

test("guarded patcher requires the exact live preimage and wires split subscriptions into the gateway", () => {
  const source = fs.readFileSync("scripts/patch_nodered_subscription_booking_flow.mjs", "utf8");
  assert.match(source, /EXPECTED_LIVE_ROUTER_SHA256/);
  assert.match(source, /resolveManagedSubscriptionRouterContract/);
  assert.match(source, /matchesManagedSubscriptionRouterTopology/);
  assert.match(source, /originalRouter/);
  assert.match(source, /managedRouter/);
  assert.match(source, /sourceKind === "live-147"/);
  assert.match(source, /Date\.now\(\) - pulledAt <= 30 \* 60 \* 1000/);
  assert.match(source, /url: "\/lk\/subscription-bookings"/);
  assert.match(source, /name: "Subscription booking Viva request"[\s\S]*requestTimeout: "20000"/);
  assert.match(source, /managedAction: ctx\.action === "create"/);
  assert.match(source, /readFunction\("fn_managed_subscription_policy_evaluate\.js"\)/);
  assert.match(source, /\[IDS\.debug\], \[IDS\.managedPolicy\]/);
  assert.match(source, /nextRouter\.outputs = 4/);
  assert.match(source, /nextRouter\.wires = \[\.\.\.nextRouter\.wires, \[IDS\.http\]\]/);
  assert.match(source, /patchManagedRouterSource/);
  assert.match(source, /managedAction: ctx\.action === "create"/);
});

test("guarded patcher accepts the exact current tracked split router", () => {
  const funcSha256 = crypto.createHash("sha256")
    .update(fs.readFileSync("scripts/nodered_games_nodes/fn_split_router.js", "utf8"))
    .digest("hex");
  const router = {
    id: "8f7bd5b482fe9763",
    type: "function",
    name: "Route Viva split payment",
    outputs: 5,
    wires: [
      ["ee7ba8cdd68bdf74"],
      ["802af8a1810db60f"],
      ["ef42932e1ba864b8"],
      ["lk_subscription_booking_http_20260804"],
      ["legacy_payment_confirm_canonical_prepare_20260816"],
    ],
  };

  assert.equal(funcSha256, "5f380562e98dd2f94a0197c498c94df12eb1797be0c3345bb21d8e4f051de7c9");
  assert.equal(resolveManagedSubscriptionRouterContract(router, funcSha256)?.managedActionCandidateSha256, null);
});

test("guarded patcher accepts the exact reviewed five-output router without dropping canonical payment", () => {
  const contract = MANAGED_SUBSCRIPTION_ROUTER_CONTRACTS.find((item) => (
    item.outputs === 5 && item.managedActionCandidateSha256
  ));
  assert.ok(contract);
  const router = {
    id: "8f7bd5b482fe9763",
    type: "function",
    name: "Route Viva split payment",
    outputs: contract.outputs,
    wires: structuredClone(contract.wires),
  };

  assert.equal(
    matchesManagedSubscriptionRouterContract(router, contract.funcSha256[0]),
    true,
  );
  assert.equal(matchesManagedSubscriptionRouterTopology(router), true);
  assert.deepEqual(router.wires[4], ["legacy_payment_confirm_canonical_prepare_20260816"]);
  assert.equal(
    resolveManagedSubscriptionRouterContract(router, contract.funcSha256[0])
      ?.managedActionCandidateSha256,
    "a9477e5e76419cc7317edb96cdbeda94a6745d07cb9aa0c5f1e82b2cebde2611",
  );

  const postimage = MANAGED_SUBSCRIPTION_ROUTER_CONTRACTS.find((item) => (
    item.outputs === 5 && item.managedActionCandidateSha256 === null
  ));
  assert.ok(postimage);
  assert.equal(
    resolveManagedSubscriptionRouterContract(router, postimage.funcSha256[0])
      ?.managedActionCandidateSha256,
    null,
  );
});

test("guarded patcher accepts the reviewed split-create router and pins its managed-action postimage", () => {
  const router = {
    id: "8f7bd5b482fe9763",
    type: "function",
    name: "Route Viva split payment",
    outputs: 5,
    wires: [
      ["ee7ba8cdd68bdf74"],
      ["802af8a1810db60f"],
      ["ef42932e1ba864b8"],
      ["lk_subscription_booking_http_20260804"],
      ["legacy_payment_confirm_canonical_prepare_20260816"],
    ],
  };
  const splitCreateSha = "2e16ee303fcae77e0d09f2a527d0fd77378bc8ea6af4027ef9636ebf8f36813f";
  const managedActionSha = "953c84c1885b77b4f7b7e826430b49a97e14656fa2a53e135aa35a93f72fe53d";

  assert.equal(
    resolveManagedSubscriptionRouterContract(router, splitCreateSha)
      ?.managedActionCandidateSha256,
    managedActionSha,
  );
  assert.equal(
    resolveManagedSubscriptionRouterContract(router, managedActionSha)
      ?.managedActionCandidateSha256,
    null,
  );
  assert.deepEqual(router.wires[4], ["legacy_payment_confirm_canonical_prepare_20260816"]);
});

test("guarded patcher rejects hash and topology drift around the five-output router", () => {
  const contract = MANAGED_SUBSCRIPTION_ROUTER_CONTRACTS.find((item) => (
    item.outputs === 5 && item.managedActionCandidateSha256
  ));
  assert.ok(contract);
  const router = {
    id: "8f7bd5b482fe9763",
    type: "function",
    name: "Route Viva split payment",
    outputs: contract.outputs,
    wires: structuredClone(contract.wires),
  };

  assert.equal(matchesManagedSubscriptionRouterContract(router, "0".repeat(64)), false);
  router.wires[4] = ["unexpected-target"];
  assert.equal(
    matchesManagedSubscriptionRouterContract(router, contract.funcSha256[0]),
    false,
  );
  assert.equal(matchesManagedSubscriptionRouterTopology(router), false);
});
