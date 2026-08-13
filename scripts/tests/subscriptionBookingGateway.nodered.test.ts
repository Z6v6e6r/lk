/* eslint-disable @typescript-eslint/no-explicit-any */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const ROUTER_FILE = "scripts/nodered_subscription_booking_nodes/fn_subscription_booking_router.js";
const PREPARE_FILE = "scripts/nodered_subscription_booking_nodes/fn_subscription_booking_prepare.js";
const FINALIZE_FILE = "scripts/nodered_subscription_booking_nodes/fn_subscription_booking_finalize.js";

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
  assert.match(source, /EXPECTED_MANAGED_ROUTER_SHA256/);
  assert.match(source, /originalRouter/);
  assert.match(source, /managedRouter/);
  assert.match(source, /sourceKind === "live-147"/);
  assert.match(source, /Date\.now\(\) - pulledAt <= 30 \* 60 \* 1000/);
  assert.match(source, /url: "\/lk\/subscription-bookings"/);
  assert.match(source, /nextRouter\.outputs = 4/);
  assert.match(source, /nextRouter\.wires = \[\.\.\.nextRouter\.wires, \[IDS\.http\]\]/);
});
