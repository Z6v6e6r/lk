/* eslint-disable @typescript-eslint/no-explicit-any */
import test from "node:test";
import assert from "node:assert/strict";
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
const MANAGED_EVALUATOR_FILE =
  "scripts/nodered_subscription_booking_nodes/fn_managed_subscription_policy_evaluate.js";
const MANAGED_BLOCKED_FILE =
  "scripts/nodered_subscription_booking_nodes/fn_managed_subscription_policy_blocked.js";
const MANAGED_GLOBALS = {
  vivacrm_access_token: "service-token",
  subscriptions_runtime_api_base_url: "https://cup.example/api",
  subscriptions_runtime_context_integration_token: "integration-token",
};
const MANAGED_ACTIVATION_GLOBALS = {
  ...MANAGED_GLOBALS,
  subscriptions_activation_integration_token: "activation-integration-token-1234567890",
};
const PITER_STATION_ID = "1ea77cbf-bc36-49a1-96d6-f35c216a409b";
const HUB_STATION_IDS = [
  "0d5504f6-ea6f-44bb-a9e4-947faf0273ab",
  "0ee057dd-908c-4b33-84b9-1a977480b710",
  "14d6d441-635f-47d0-aa8c-553496294fb1",
  "1c323ef3-7e6c-42eb-a6f7-653460540a8a",
  "1cbb7201-2189-41a4-a3b4-4f543da0def6",
  "1ea77cbf-bc36-49a1-96d6-f35c216a409b",
  "233c1405-1eac-40de-8ec6-1cf7e24c9276",
  "3266d827-2662-4540-9376-daac10f3875e",
  "3656cbaa-6426-490f-a44f-915404cbdd2b",
  "3b52e87f-33bb-436b-a1e3-19a3b62b4ed2",
  "3db3fc06-00e2-445a-97eb-e354796f80a1",
  "42c6d4df-833d-480a-bdc8-986716569884",
  "4c564565-3918-40b2-8cb3-b7135c7cc992",
  "5409fdc8-3db3-4e66-a6a9-8994bd591c8f",
  "588b6151-f4f5-47d9-9449-80edf8cbc748",
  "6a7a9edc-6869-40ad-a5a1-8a1cdfb746a1",
  "6b2d7e60-caff-4b22-89f6-6f19d7d311ab",
  "76c67f10-70ee-4296-9145-1c040e4674ca",
  "8380b5db-c12f-495b-a0d7-c7359168a777",
  "855ec72a-d619-4add-ac92-8c64dafb17c2",
  "8e31b902-1981-4b62-b803-6187b8f2a8da",
  "b09d0015-5198-4a94-b88b-2448218e479d",
  "c72eaaff-2163-47cd-87d0-b93499415acc",
  "ed0e3bd4-6edb-43a9-8fe4-8fc3e7febec8",
  "f82775cc-3dd7-4d02-98c8-e43cce470003",
];
const DAY_MS = 24 * 60 * 60 * 1000;
const futureManagedTarget = () => {
  const startsAt = new Date(Date.now() + DAY_MS);
  return {
    serviceDate: startsAt.toISOString().slice(0, 10),
    startsAt: startsAt.toISOString(),
  };
};

function runFunction(
  file: string,
  msg: Record<string, any>,
  globals: Record<string, unknown> = { vivacrm_access_token: "service-token" },
) {
  const source = fs.readFileSync(file, "utf8");
  const globalContext = { get: (key: string) => globals[key] };
  return new Function("msg", "global", source)(msg, globalContext) as any[];
}

function baseContext(step: string, overrides: Record<string, unknown> = {}) {
  return {
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
    createGame: { enabled: true, durationsMinutes: [60] },
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
        externalEventTypeIds: ["1613"],
        productTypeIds: [],
        durationMinutes: [60],
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
        externalEventTypeIds: ["1613"],
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
    subscriptionInstanceId: "subscription-instance-1",
    clientSubscriptionId: "client-subscription-1",
    policyDigest: "a".repeat(64),
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
    evidence: { mappingRevision: 1, instanceRevision: 1 },
  };
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
      direction: { name: "Открытая игра" },
      type: { id: 1613, name: "Открытая игра" },
      studio: { id: "studio-1" },
      availableClientSubscriptions: [{
        clientSubscriptionId: "client-subscription-1",
        name: "Падел.Дружба.Питер — 12 месяцев",
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
  assert.equal(out[0]._subscriptionBooking.managedTarget.externalEventTypeId, "1613");
  assert.equal(out[0].url, "https://cup.example/api/internal/subscriptions/runtime-context");
  assert.deepEqual(out[0].payload, { clientSubscriptionId: "client-subscription-1" });
  assert.equal(out[0].headers.Authorization, "Bearer user-token");
  assert.equal(out[0].headers["X-Subscriptions-Integration-Token"], "integration-token");
  assert.equal(out[1], null);
  assert.equal(out[2], null);
  assert.equal(out[3], null);
});

test("HUB split join uses the same CUP policy path while Kotelniki stays closed", () => {
  const exercise = (name: string) => ({
    id: "exercise-target",
    timeFrom: "2026-08-21T18:00:00+03:00",
    timeTo: "2026-08-21T20:00:00+03:00",
    direction: { name: "Открытая игра" },
    type: { id: 1613, name: "Открытая игра" },
    studio: { id: "studio-1" },
    availableClientSubscriptions: [{
      clientSubscriptionId: "client-subscription-1",
      name,
    }],
  });
  const hub = runFunction(ROUTER_FILE, {
    statusCode: 200,
    payload: exercise("Падел.Дружба.ХАБ — 12 месяцев"),
    _subscriptionBooking: baseContext("exercise", {
      serviceDate: undefined, category: undefined, planKey: undefined,
      managedAction: "JOIN_GAME",
    }),
  }, MANAGED_GLOBALS);
  assert.equal(hub[0]._subscriptionBooking.planKey, "network_friendship");
  assert.equal(hub[0]._subscriptionBooking.managedTarget.durationMinutes, 120);
  assert.equal(hub[0]._subscriptionBooking.managedAction, "JOIN_GAME");

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
        externalEventTypeId: "1613", productTypeId: null, eventId: "exercise-target",
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
  assert.equal(history[6]._subscriptionBooking.step, "managed_policy_decision");
  assert.equal(history[1], null);

  const evaluated = runFunction(MANAGED_EVALUATOR_FILE, history[6]);
  assert.ok(evaluated[0]);
  const routed = runFunction(ROUTER_FILE, evaluated[0], MANAGED_GLOBALS);
  assert.equal(routed[1]._subscriptionBooking.step, "operation_find");
  assert.equal(routed[1]._subscriptionBooking.managedDecision.policyVersion, 1);
  assert.equal(routed[1]._subscriptionBooking.managedDecision.subscriptionInstanceId,
    "subscription-instance-1");
  assert.equal(routed[1]._subscriptionBooking.managedDecision.benefit.kind, "FREE_ENTITLEMENT");
});

test("HUB accepts the exact first-use deadline lifecycle with the pinned station set", () => {
  const futureTarget = futureManagedTarget();
  const runtime = runFunction(ROUTER_FILE, {
    statusCode: 200,
    payload: managedRuntimeResponse({
      stationId: HUB_STATION_IDS[0],
      stationIds: [...HUB_STATION_IDS].reverse(),
      benefitStationIds: [...HUB_STATION_IDS],
      subscriptionTypeId: "subscription-type:hub",
    }),
    _subscriptionBooking: baseContext("managed_runtime_context", {
      serviceDate: futureTarget.serviceDate,
      category: "open_game",
      planKey: "network_friendship",
      managedAction: "JOIN_GAME",
      managedTarget: {
        resolutionSource: "SERVER", stationId: HUB_STATION_IDS[0], category: "GAME",
        externalEventTypeId: "1613", productTypeId: null, eventId: "exercise-target",
        durationMinutes: 120, startsAt: futureTarget.startsAt,
        basePriceMinor: null, currency: "RUB",
      },
    }),
  }, MANAGED_GLOBALS);

  assert.equal(runtime[0]._subscriptionBooking.step, "active_bookings");
  assert.equal(runtime[0]._subscriptionBooking.managedRuntime.policy.lifecycle.activationMode,
    "FIRST_USE_OR_FIXED_DATE");
  const active = runFunction(ROUTER_FILE, {
    statusCode: 200, payload: { content: [] },
    _subscriptionBooking: runtime[0]._subscriptionBooking,
  }, MANAGED_GLOBALS);
  const history = runFunction(ROUTER_FILE, {
    statusCode: 200, payload: { content: [] },
    _subscriptionBooking: active[0]._subscriptionBooking,
  }, MANAGED_GLOBALS);
  const evaluated = runFunction(MANAGED_EVALUATOR_FILE, history[6]);
  assert.ok(evaluated[0]);
  assert.equal(evaluated[0]._managedSubscriptionPolicyDecision.eligible, true);
});

test("HUB rejects all-stations, missing and additional station scopes before Viva or Mongo", () => {
  const evaluate = (overrides: Record<string, unknown>) => runFunction(ROUTER_FILE, {
    statusCode: 200,
    payload: managedRuntimeResponse({
      subscriptionTypeId: "subscription-type:hub",
      ...overrides,
    }),
    _subscriptionBooking: baseContext("managed_runtime_context", {
      serviceDate: "2026-08-21",
      category: "open_game",
      planKey: "network_friendship",
      managedAction: "JOIN_GAME",
      managedTarget: {
        resolutionSource: "SERVER", stationId: "studio-1", category: "GAME",
        externalEventTypeId: "1613", productTypeId: null, eventId: "exercise-target",
        durationMinutes: 120, startsAt: "2026-08-21T15:00:00.000Z",
        basePriceMinor: null, currency: "RUB",
      },
    }),
  }, MANAGED_GLOBALS);

  for (const output of [
    evaluate({ allStations: true }),
    evaluate({ stationIds: HUB_STATION_IDS.slice(0, -1) }),
    evaluate({ stationIds: [...HUB_STATION_IDS, "station:unreviewed"] }),
  ]) {
    assert.equal(output[4].statusCode, 409);
    assert.equal(output[4].payload.details.code, "MANAGED_SUBSCRIPTION_POLICY_UNSUPPORTED");
    assert.equal(output[0], null);
    assert.equal(output[1], null);
    assert.equal(output[2], null);
    assert.equal(output[3], null);
  }
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
        externalEventTypeId: "1613", productTypeId: null, eventId: "exercise-target",
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
        externalEventTypeId: "1613", productTypeId: null, eventId: "exercise-target",
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
  assert.equal(history[6]._managedSubscriptionPolicyInput.instance.state, "ACTIVE");
  assert.ok(history[6]._managedSubscriptionPolicyInput.instance.activeFrom);
  assert.ok(history[6]._managedSubscriptionPolicyInput.instance.activeTo);

  const activationRequest = runFunction(ROUTER_FILE, {
    payload: { matchedCount: 1 },
    _subscriptionBooking: baseContext("operation_confirm", {
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
    "https://cup.example/api/internal/subscriptions/activate-first-use",
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
          externalEventTypeId: "1613", productTypeId: null, eventId: "exercise-target",
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

test("Piter rejects an all-stations policy and regional tournament discounts stay closed", () => {
  const invalidPolicy = managedRuntimeResponse({ allStations: true });
  const runtime = runFunction(ROUTER_FILE, {
    statusCode: 200,
    payload: invalidPolicy,
    _subscriptionBooking: baseContext("managed_runtime_context", {
      serviceDate: "2026-08-21", category: "open_game", planKey: "piter_friendship",
      managedAction: "CREATE_GAME",
      managedTarget: {
        resolutionSource: "SERVER", stationId: PITER_STATION_ID, category: "GAME",
        externalEventTypeId: "1613", productTypeId: null, eventId: "exercise-target",
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
        name: "Падел.Дружба.Питер — 12 месяцев",
      }],
    },
    _subscriptionBooking: baseContext("exercise", {
      serviceDate: undefined, category: undefined, planKey: undefined,
    }),
  }, MANAGED_GLOBALS);
  assert.equal(tournament[4].statusCode, 409);
  assert.equal(tournament[4].payload.details.code,
    "MANAGED_SUBSCRIPTION_DISCOUNT_NOT_CONFIGURED");
});

test("90 minute create is blocked while 120 minute join is allowed by the same policy", () => {
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
        externalEventTypeId: "1613", productTypeId: null, eventId: "exercise-target",
        durationMinutes, startsAt: futureTarget.startsAt,
        basePriceMinor: null, currency: "RUB",
      },
      activeBookingsPayload: { content: [] },
    });
    const history = runFunction(ROUTER_FILE, {
      statusCode: 200, payload: { content: [] }, _subscriptionBooking: ctx,
    }, MANAGED_GLOBALS);
    return runFunction(MANAGED_EVALUATOR_FILE, history[6]);
  };
  const create = evaluateDuration("CREATE_GAME", 90);
  assert.equal(create[0], null);
  assert.ok(create[1]._managedSubscriptionPolicyDecision.blockers
    .some((item: any) => item.code === "DURATION_NOT_ALLOWED"));
  const join = evaluateDuration("JOIN_GAME", 120);
  assert.ok(join[0]);
  assert.equal(join[0]._managedSubscriptionPolicyDecision.eligible, true);
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

  const create = runFunction(ROUTER_FILE, {
    payload: { acknowledged: true, matchedCount: 1 },
    _subscriptionBooking: preaccept[3]._subscriptionBooking,
  });
  assert.equal(create[0]._subscriptionBooking.step, "booking_create");
  assert.match(create[0].url, /\/api\/v2\/exercises\/exercise-target\/bookings$/);
  assert.equal(create[0].payload.clientId, "client-1");
  assert.equal(create[0].payload.clientSubscriptionId, "client-subscription-1");
  assert.equal(create[0].payload.paymentType, "SUBSCRIPTION");
  assert.deepEqual(create[0].payload.customFields, []);
  assert.equal("familyMemberId" in create[0].payload, false);
  assert.equal("count" in create[0].payload, false, "direct tournament/group booking remains one visit");

  const splitCreate = runFunction(ROUTER_FILE, {
    payload: { acknowledged: true, matchedCount: 1 },
    _subscriptionBooking: baseContext("operation_preaccept", {
      caller: "split",
      subscriptionVisitCount: 2,
    }),
  });
  assert.equal(splitCreate[0].payload.count, 2, "split keeps the existing 90/120-minute debit contract");
  assert.match(splitCreate[0].url, /\/api\/v1\/exercises\/exercise-target\/bookings$/);
  assert.equal(
    splitCreate[0]._subscriptionBooking.operationKey,
    "iSkq6G:client-subscription-1:2026-08-10",
    "the debit count still consumes one daily event slot",
  );
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
  assert.match(source, /managedAction: ctx\.action === "create"/);
  assert.match(source, /readFunction\("fn_managed_subscription_policy_evaluate\.js"\)/);
  assert.match(source, /\[IDS\.debug\], \[IDS\.managedPolicy\]/);
  assert.match(source, /nextRouter\.outputs = 4/);
  assert.match(source, /nextRouter\.wires = \[\.\.\.nextRouter\.wires, \[IDS\.http\]\]/);
  assert.match(source, /patchManagedRouterSource/);
  assert.match(source, /managedAction: ctx\.action === "create"/);
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
