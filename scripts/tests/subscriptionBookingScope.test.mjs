import assert from "node:assert/strict";
import test from "node:test";
import { createScopedBookingObserver, SUBSCRIPTION_BOOKING_SCOPE } from "../diagnostics/subscription-booking-scope.mjs";

const req = () => ({ method: "POST", path: "/lk/subscription-bookings", headers: { "idempotency-key": "SYNTHETIC_PRIVATE" } });
const ctx = step => ({ caller: "http", action: "book", step, operationId: "synthetic-key", exerciseId: "synthetic-exercise", clientSubscriptionId: "synthetic-subscription" });
const setup = (extra = {}) => { const events = []; return { events, observer: createScopedBookingObserver({ sink: e => events.push(e), ...extra }) }; };
const safe = event => {
  assert(!JSON.stringify(event).includes("synthetic-")); assert(!JSON.stringify(event).includes("SYNTHETIC_PRIVATE"));
  for (const key of ["entityRef", "operationRef", "bindingRef", "outboxRef"]) assert.equal(event[key], undefined);
};

test("scoped facade retains409 equality facts, actual503 phases and request correlation", () => {
  const { events, observer } = setup(), request = req();
  assert.equal(observer.scope, SUBSCRIPTION_BOOKING_SCOPE);
  const msg = { req: request, payload: [{ state: "CONFIRMED", operationId: "synthetic-other-key", exerciseId: "synthetic-exercise", clientSubscriptionId: "synthetic-subscription" }], _subscriptionBooking: ctx("operation_find") };
  observer.observe(msg, "booking_router"); assert.equal(events.length, 0);
  observer.observe({ req: request, _subscriptionBooking: msg._subscriptionBooking, statusCode: 409, payload: { details: { code: "SUBSCRIPTION_CATEGORY_DAILY_LIMIT_REACHED" } } }, "booking_finalize");
  assert.equal(events[0].sameOperationKey, false); assert.equal(events[0].sameOperationTarget, true);
  observer.observe({ req: request, statusCode: 503, payload: { private: "SYNTHETIC_PRIVATE" }, _subscriptionBooking: ctx("exercise") }, "booking_router");
  assert.equal(events.length, 1);
  observer.observe({ req: request, statusCode: 503, payload: { details: { code: "SUBSCRIPTION_BOOKING_EXERCISE_UNAVAILABLE" } }, _subscriptionBooking: ctx("exercise") }, "booking_finalize");
  assert.equal(events[1].upstreamStatus, 503); assert.equal(events[1].upstreamPhase, "exercise");
  assert.equal(events[1].requestId, events[0].requestId); assert.equal(events[1].outcome, "outcome_unknown");
  events.forEach(safe);
});

test("direct503 events survive facade without a gateway context or finalizer", () => {
  for (const [stage, code] of [["roster_bridge_response", "LEGACY_GAME_BRIDGE_UPSTREAM_FAILED"], ["roster_projection_build", "LEGACY_ROSTER_PROJECTION_CONTEXT_INVALID"], ["roster_projection_ack", "LEGACY_ROSTER_PROJECTION_UNACKNOWLEDGED"], ["booking_prepare", "GAME_CREATE_OWNER_GRAPH_UNAVAILABLE"]]) {
    const { events, observer } = setup();
    const msg = { req: req(), payload: { private: "SYNTHETIC_PRIVATE" }, _quarterCreateCapability: {} }, before = structuredClone(msg);
    observer.observe(msg, stage, { code, httpStatus: 503, upstreamStatus: stage === "roster_bridge_response" ? 503 : undefined });
    assert.deepEqual(msg, before); assert.equal(events.length, 1); assert.equal(events[0].stage, stage);
    assert.equal(events[0].code, code); safe(events[0]);
  }
});

test("other methods/routes/hooks,202 and nonordinary409 remain disabled", () => {
  const { events, observer } = setup();
  for (const msg of [
    { req: { ...req(), method: "GET" }, statusCode: 503, _subscriptionBooking: ctx("exercise") },
    { req: { ...req(), path: "/lk/subscriptions/game-price-preview" }, statusCode: 503, _subscriptionBooking: ctx("exercise") },
    { req: req(), statusCode: 202, _subscriptionBooking: ctx("operation_find") },
    { req: req(), statusCode: 409, _subscriptionBooking: { ...ctx("operation_find"), caller: "split" } },
    { req: req(), statusCode: 409, _subscriptionBooking: ctx("operation_find"), _gameCreateOwner: {} },
  ]) observer.observe(msg, "booking_finalize");
  observer.observe({ req: req() }, "participants_cache", { code: "UPSTREAM_REFUSED", httpStatus: 503 });
  observer.upstream({}, "exercise"); observer.transport({}, "booking_error", Error("synthetic")); observer.bindMax({});
  observer.media({}); observer.ingestClient({}); assert.equal(observer.clientEnvelope({}), null);
  let next = 0; observer.middleware({}, {}, () => next++); assert.equal(next, 1);
  assert.equal(events.length, 0);
});

test("unlisted values/isolation remain unknown and throwing sinks are harmless", () => {
  const { events, observer } = setup();
  observer.observe({ req: req(), statusCode: 503, payload: { details: { code: "SYNTHETIC_PRIVATE_CODE" } }, _subscriptionBooking: { ...ctx("SYNTHETIC_PRIVATE_STEP"), action: "SYNTHETIC_PRIVATE_ACTION" } }, "booking_finalize");
  assert.equal(events[0].code, "UNKNOWN"); assert.equal(events[0].operationStage, "UNKNOWN"); assert.equal(events[0].action, "UNKNOWN"); safe(events[0]);
  const broken = createScopedBookingObserver({ sink() { throw Error("synthetic"); } });
  assert.doesNotThrow(() => broken.observe({ req: req(), statusCode: 503, payload: {}, _subscriptionBooking: ctx("exercise") }, "booking_finalize"));
});

test("suppression remains a count of forwarded stages, never a count of failures", () => {
  const { events, observer } = setup({ detailLimit: 1 }), request = req();
  observer.observe({ req: request, statusCode: 200, payload: {}, _subscriptionBooking: ctx("exercise") }, "booking_router");
  observer.observe({ req: request, statusCode: 503, payload: {}, _subscriptionBooking: ctx("exercise") }, "booking_finalize");
  observer.flushSuppressed();
  assert.equal(events.length, 1); assert.equal(events[0].eventKind, "suppression"); assert.equal(events[0].suppressedCount, 1);
  assert.equal(events[0].requestId, undefined); observer.dispose();
});
