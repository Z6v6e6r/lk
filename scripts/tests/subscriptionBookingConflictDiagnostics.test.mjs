import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createDiagnostics } from "../diagnostics/runtime.mjs";
import { sanitizeEvent } from "../../src/utils/errorDiagnosticsCore.mjs";
import { schemaV1 } from "../diagnostics/schema.mjs";

test("published schema includes exactly the executable diagnostic allowlist", () => {
  assert.deepEqual(JSON.parse(fs.readFileSync("docs/diagnostics/schema.v1.json", "utf8")), schemaV1());
});

const sources = Object.fromEntries(["router", "finalize"].map(role => [role,
  fs.readFileSync(`scripts/nodered_subscription_booking_nodes/fn_subscription_booking_${role}.js`, "utf8")]));
const at = new Date("2026-11-12T09:10:00.000Z");
const context = (step, extra = {}) => ({ caller: "http", action: "book", step,
  tenantKey: "synthetic-tenant", operationId: "synthetic-key", exerciseId: "synthetic-exercise",
  clientSubscriptionId: "synthetic-subscription", actorClientId: "synthetic-client",
  actorPhone: "70000000000", serviceDate: "2026-11-12", category: "open_game",
  planKey: "friendship", trackedDailyLimit: true, limitMode: "shared_day", ...extra });
const request = () => ({ path: "/lk/subscription-bookings", method: "POST",
  headers: { "idempotency-key": "SYNTHETIC_PRIVATE_KEY", authorization: "Bearer demo" },
  query: { operationId: "SYNTHETIC_PRIVATE_QUERY" }, body: { token: "SYNTHETIC_PRIVATE_BODY" } });
const row = (extra = {}) => ({ operationId: "synthetic-other-key", exerciseId: "synthetic-exercise",
  clientSubscriptionId: "synthetic-subscription", bookingId: "synthetic-booking", state: "CONFIRMED", ...extra });
function observer(extra = {}) {
  const events = [];
  return { events, diagnostics: createDiagnostics({ sink: e => events.push(e),
    now: () => at, key: Buffer.alloc(32, 7), ...extra }) };
}
function run(role, msg, diagnostics) {
  const globals = { get: key => key === "lkDiagnostics" ? diagnostics
    : key === "vivacrm_access_token" ? "synthetic-token" : undefined, set() {} };
  return new Function("msg", "global", "env", "flow", "node", "context", sources[role])(
    msg, globals, globals, globals, { warn() {}, error() {}, send() {} }, globals);
}
const conflicts = events => events.filter(e => e.stage === "booking_finalize" && e.httpStatus === 409);
function finish(msg, diagnostics) { return run("finalize", msg, diagnostics); }

test("different key / same event 409 is correlated and does not alter response or writes", () => {
  const input = { req: request(), statusCode: 200, payload: [row()],
    _subscriptionBooking: context("operation_find", { sameExerciseBooking: { id: "synthetic-booking" } }) };
  const enabled = structuredClone(input), baseline = structuredClone(input), { diagnostics, events } = observer();
  assert.deepEqual(run("router", enabled, diagnostics), run("router", baseline));
  assert.deepEqual(finish(enabled, diagnostics), finish(baseline));
  const [event] = conflicts(events);
  assert.equal(conflicts(events).length, 1);
  assert.equal(event.code, "SUBSCRIPTION_CATEGORY_DAILY_LIMIT_REACHED");
  assert.equal(event.action, "book"); assert.equal(event.operationStage, "operation_find");
  assert.equal(event.idempotencyKeyPresent, true); assert.equal(event.operationReadValid, true);
  assert.equal(event.operationFound, true); assert.equal(event.sameOperationKey, false);
  assert.equal(event.sameOperationTarget, true); assert.equal(event.operationState, "CONFIRMED");
  assert.equal(event.requestId, events.find(e => e.stage === "booking_router").requestId);
  for (const key of ["operationRef", "entityRef", "bindingRef", "outboxRef"]) assert.equal(event[key], undefined);
  assert(!JSON.stringify(event).includes("synthetic-"));
  assert(!JSON.stringify(event).includes("SYNTHETIC_PRIVATE"));
  assert.deepEqual(sanitizeEvent(event), event);
});

test("release mismatches report release action and safe key/target comparisons", () => {
  const { diagnostics, events } = observer();
  const msg = { req: request(), payload: [row({ operationId: "synthetic-key", clientSubscriptionId: "other-subscription" })],
    _subscriptionBooking: context("operation_find", { action: "release", releaseBookingId: "synthetic-booking" }) };
  run("router", msg, diagnostics); finish(msg, diagnostics);
  const [event] = conflicts(events);
  assert.equal(event.code, "SUBSCRIPTION_BOOKING_RELEASE_SUBSCRIPTION_MISMATCH");
  assert.equal(event.action, "release"); assert.equal(event.sameOperationKey, true);
  assert.equal(event.sameOperationTarget, false);
});

test("source-driven daily-visit guard preserves its actual 409 code/step and LK1 read aliases", () => {
  const guard = fs.readFileSync("scripts/nodered_lk1_hub_nodes/daily_visit_guard.js", "utf8");
  // Full source guard, synthetic Mongo acknowledgement, and no HTTP/DB adapters.
  const source = `global.get("lkDiagnostics")?.observe(msg, "booking_router");
    const ctx = msg._subscriptionBooking;
    const lk1MongoMatched = result => result?.matchedCount;
    const finishError = (ctx, status, error, details) => {
      msg.statusCode = status; msg.payload = { error, details }; return msg;
    };
    ${guard}`;
  for (const step of ["lk1_ingress_operation_find", "lk1_operation_find"]) {
    const { diagnostics, events } = observer(), req = request();
    diagnostics.observe({ req, payload: [row({ operationId: "synthetic-key" })], _subscriptionBooking: context(step) }, "booking_router");
    const input = { req, payload: { matchedCount: 1, modifiedCount: 1 }, _subscriptionBooking: context("lk1_daily_visit_conflict_saved") };
    const baseline = structuredClone(input), enabled = structuredClone(input);
    // Keep the real HTTP request identity across router and finalizer messages.
    enabled.req = req;
    const execute = (msg, diagnostics) => new Function("msg", "global", source)(msg, { get: () => diagnostics });
    assert.deepEqual(execute(enabled, diagnostics), execute(baseline));
    assert.deepEqual(finish(enabled, diagnostics), finish(baseline));
    const [event] = conflicts(events);
    assert.equal(event.code, "LK1_DAILY_VISIT_CHANGED");
    assert.equal(event.operationStage, "lk1_daily_visit_conflict_saved");
    assert.equal(event.sameOperationKey, true); assert.equal(event.sameOperationTarget, true);
  }
});

test("known LK1 quote/exclusion/free-cancel refusal families keep bounded enums", () => {
  for (const [step, action, codes] of [
    ["lk1_policy_decision", "book", ["GROUP_DISCOUNT_QUOTE_CHANGED", "TOURNAMENT_DISCOUNT_QUOTE_CHANGED"]],
    ["exercise", "book", ["SPANISH_TRAINING_SUBSCRIPTION_UNAVAILABLE", "TOPOKRATY_SUBSCRIPTION_UNAVAILABLE", "PRO_TRAINING_SUBSCRIPTION_UNAVAILABLE"]],
    ["lk1_free_cancel_booking_gate", "book", ["LK1_FREE_CANCEL_RETURN_PENDING"]],
    ["lk1_free_cancel_effect", "cancel-free", ["LK1_FREE_CANCEL_OWNER_UNVERIFIED", "LK1_FREE_CANCEL_VISIT_IN_FLIGHT", "LK1_FREE_CANCEL_SERVICE_UNAVAILABLE", "LK1_FREE_CANCEL_ACTIVE_BOOKING_UNVERIFIED", "LK1_FREE_CANCEL_BASELINE_UNAVAILABLE"]],
  ]) for (const code of codes) {
    const { diagnostics, events } = observer();
    finish({ req: request(), statusCode: 409, payload: { details: { code } }, _subscriptionBooking: context(step, { action }) }, diagnostics);
    const [event] = conflicts(events);
    assert.equal(event.code, code); assert.equal(event.action, action); assert.equal(event.operationStage, step);
    assert.equal(event.operationFound, undefined);
  }
});

test("early provider 409 and eligibility rejection preserve known codes without invented operation facts", () => {
  for (const [step, payload, extra, code] of [
    ["profile", {}, {}, "SUBSCRIPTION_BOOKING_PROFILE_UNAVAILABLE"],
    ["exercise", {}, {}, "SUBSCRIPTION_BOOKING_EXERCISE_UNAVAILABLE"],
    ["operation_fail", {}, { finalFailure: { statusCode: 409, rawCode: "SUBSCRIPTION_ELIGIBILITY_CHANGED_BEFORE_WRITE" } }, "SUBSCRIPTION_ELIGIBILITY_CHANGED_BEFORE_WRITE"],
    ["operation_fail", {}, { finalFailure: { statusCode: 409, rawCode: "SYNTHETIC_PRIVATE_PROVIDER_CODE" } }, "UNKNOWN"],
  ]) {
    const input = { req: request(), statusCode: 409, payload, _subscriptionBooking: context(step, extra) };
    const msg = structuredClone(input), baseline = structuredClone(input), { diagnostics, events } = observer();
    assert.deepEqual(run("router", msg, diagnostics), run("router", baseline));
    assert.deepEqual(finish(msg, diagnostics), finish(baseline));
    const [event] = conflicts(events);
    assert.equal(event.code, code); assert.equal(event.operationStage, step);
    assert.equal(event.operationFound, undefined); assert.equal(event.sameOperationKey, undefined);
    assert(!JSON.stringify(event).includes("SYNTHETIC_PRIVATE"));
  }
});

test("pending and confirmed-orphan branches stay 202 without a conflict event", () => {
  for (const operation of [
    row({ operationId: "synthetic-key", state: "PENDING_CONFIRMATION", pendingUntil: "2099-01-01T00:00:00Z" }),
    row({ state: "PREPARED", leaseUntil: "2099-01-01T00:00:00Z" }),
    row({ operationId: "synthetic-key", state: "CONFIRMED" }),
  ]) {
    const { diagnostics, events } = observer();
    const input = { req: request(), payload: [operation], _subscriptionBooking: context("operation_find") };
    const msg = structuredClone(input), baseline = structuredClone(input);
    assert.deepEqual(run("router", msg, diagnostics), run("router", baseline));
    assert.equal(msg.statusCode, 202);
    assert.deepEqual(finish(msg, diagnostics), finish(baseline));
    assert.deepEqual(conflicts(events), []);
  }
});

test("missing, invalid, ambiguous and superseded reads distinguish unknown from false", () => {
  for (const [rows, error, expected] of [
    [[], undefined, { operationReadValid: true, operationFound: false }],
    [[{}], undefined, { operationReadValid: true, operationFound: true }],
    [[row(), row()], undefined, { operationReadValid: false }],
    [null, undefined, { operationReadValid: false }],
    [[null], undefined, { operationReadValid: false }],
    [[row()], {}, { operationReadValid: false }],
  ]) {
    const { diagnostics, events } = observer(), req = request();
    diagnostics.observe({ req, payload: [row()], _subscriptionBooking: context("operation_find") }, "booking_router");
    const msg = { req, payload: rows, error, _subscriptionBooking: context("operation_find") };
    diagnostics.observe(msg, "booking_router");
    msg.statusCode = 409; msg.payload = { details: { code: "SUBSCRIPTION_CATEGORY_DAILY_LIMIT_REACHED" } };
    diagnostics.observe(msg, "booking_finalize");
    const [event] = conflicts(events);
    for (const key of ["operationReadValid", "operationFound", "sameOperationKey", "sameOperationTarget", "operationState"])
      assert.equal(event[key], expected[key]);
  }
});

test("known expiry flags use observer clock; malformed dates and state are omitted", () => {
  for (const [operation, leaseExpired, pendingExpired, state] of [
    [row({ leaseUntil: at.toISOString(), pendingUntil: "2099-01-01T00:00:00Z" }), true, false, "CONFIRMED"],
    [row({ leaseUntil: "invalid", pendingUntil: {}, state: "SYNTHETIC_PRIVATE_STATE" }), undefined, undefined, undefined],
  ]) {
    const { diagnostics, events } = observer(), req = request();
    diagnostics.observe({ req, payload: [operation], _subscriptionBooking: context("operation_find") }, "booking_router");
    diagnostics.observe({ req, statusCode: 409, payload: {}, _subscriptionBooking: context("operation_fail") }, "booking_finalize");
    const [event] = conflicts(events);
    assert.equal(event.leaseExpired, leaseExpired); assert.equal(event.pendingExpired, pendingExpired);
    assert.equal(event.operationState, state);
  }
});

test("request isolation, unknown enums and absent key never export supplied values", () => {
  const { diagnostics, events } = observer();
  diagnostics.observe({ req: request(), payload: [row()], _subscriptionBooking: context("operation_find") }, "booking_router");
  const msg = { req: request(), statusCode: 409, payload: { details: { code: "SYNTHETIC_PRIVATE_CODE" } },
    _subscriptionBooking: context("SYNTHETIC_PRIVATE_STEP", { action: "SYNTHETIC_PRIVATE_ACTION", operationId: undefined }) };
  const before = structuredClone(msg); diagnostics.observe(msg, "booking_finalize");
  assert.deepEqual(msg, before);
  const [event] = conflicts(events);
  assert.equal(event.action, "UNKNOWN"); assert.equal(event.operationStage, "UNKNOWN");
  assert.equal(event.code, "UNKNOWN"); assert.equal(event.idempotencyKeyPresent, false);
  assert.equal(event.operationReadValid, undefined);
  assert(!JSON.stringify(event).includes("SYNTHETIC_PRIVATE"));
});

test("other routes, methods, internal callers and non-409 statuses receive no new fields", () => {
  for (const [req, ctx, extra, status] of [
    [{ ...request(), path: "/lk/subscription-bookings/other" }, context("operation_fail"), {}, 409],
    [{ ...request(), method: "GET" }, context("operation_fail"), {}, 409],
    [request(), context("operation_fail", { caller: "split" }), {}, 409],
    [request(), context("operation_fail", { trainingRegistration: {} }), {}, 409],
    [request(), context("operation_fail", { managedCreateBinding: {} }), {}, 409],
    [request(), context("operation_fail"), { _quarterCreateCapability: {} }, 409],
    ...[200, 201, 202, 400, 401, 403, 404, 422, 500].map(status => [request(), context("operation_fail"), {}, status]),
  ]) {
    const { diagnostics, events } = observer();
    diagnostics.observe({ req, _subscriptionBooking: ctx, statusCode: status, payload: {}, ...extra }, "booking_finalize");
    assert.deepEqual(conflicts(events), []);
    assert.equal(events[0]?.idempotencyKeyPresent, undefined);
  }
});

test("throwing sinks and malformed diagnostic inputs cannot change business response", () => {
  const input = { req: request(), statusCode: 409, payload: {}, _subscriptionBooking: context("exercise") };
  const broken = observer({ sink() { throw Error("synthetic-logger-failure"); } }).diagnostics;
  const msg = structuredClone(input), baseline = structuredClone(input);
  assert.deepEqual(run("router", msg, broken), run("router", baseline));
  assert.deepEqual(finish(msg, broken), finish(baseline));
  const bad = { req: request(), payload: {}, _subscriptionBooking: { caller: "http", get step() { throw Error("synthetic-getter"); } } };
  assert.doesNotThrow(() => broken.observe(bad, "booking_router"));
});
