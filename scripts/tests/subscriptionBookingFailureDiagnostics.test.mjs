import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createDiagnostics } from "../diagnostics/runtime.mjs";
import { diagnosticContract, sanitizeEvent } from "../../src/utils/errorDiagnosticsCore.mjs";
import { applySourceHooks, sha } from "../diagnostics/source-hooks.mjs";
import { bookingPrepareFailureEdits, applyBookingPrepareFailureObserver } from "../diagnostics/booking-prepare-failure-overlay.mjs";

const read = p => fs.readFileSync(p, "utf8");
const gateway = Object.fromEntries(["router", "finalize"].map(role => [role, read(`scripts/nodered_subscription_booking_nodes/fn_subscription_booking_${role}.js`)]));
const ctx = (step, extra = {}) => ({ caller: "http", action: "book", step, tenantKey: "synthetic-tenant",
  operationId: "synthetic-key", exerciseId: "synthetic-exercise", clientSubscriptionId: "synthetic-subscription",
  actorClientId: "synthetic-client", actorPhone: "70000000000", serviceDate: "2026-11-12",
  category: "open_game", planKey: "friendship", trackedDailyLimit: true, limitMode: "shared_day", ...extra });
const req = () => ({ path: "/lk/subscription-bookings", method: "POST", headers: { authorization: "Bearer demo" },
  body: { private: "SYNTHETIC_PRIVATE_BODY" }, query: { private: "SYNTHETIC_PRIVATE_QUERY" } });
const observer = (extra = {}) => { const events = []; return { events,
  diagnostics: createDiagnostics({ sink: event => events.push(event), key: Buffer.alloc(32, 7), ...extra }) }; };
function run(source, msg, diagnostics, token = true) {
  const memory = new Map();
  const global = { get: key => key === "lkDiagnostics" ? diagnostics : key === "vivacrm_access_token"
    ? token ? "synthetic-token" : undefined : memory.get(key), set: (key, value) => memory.set(key, value) };
  return new Function("msg", "global", "env", "flow", "node", "context", source)(msg, global, global, global,
    { warn() {}, error() {}, log() {}, send() {} }, global);
}
const failures = events => events.filter(event => event.httpStatus === 503 && ["booking_finalize", "booking_prepare", "roster_bridge_response", "roster_projection_build", "roster_projection_ack"].includes(event.stage) && event.code !== "STAGE_ENTER");
function safe(event) {
  assert.deepEqual(sanitizeEvent(event), event);
  for (const field of ["entityRef", "operationRef", "bindingRef", "outboxRef"]) assert.equal(event[field], undefined);
  assert(!JSON.stringify(event).includes("synthetic-")); assert(!JSON.stringify(event).includes("SYNTHETIC_PRIVATE"));
  assert.equal(event.outcome, "outcome_unknown");
}

test("gateway 503 codes and actual steps survive without changing business outputs or writes", () => {
  for (const [step, code, extra = {}, token = true, payload = {}] of [
    ["exercise", "SUBSCRIPTION_BOOKING_EXERCISE_UNAVAILABLE"],
    ["operation_fail", "VIVA_SUBSCRIPTION_BOOKING_REJECTED", { finalFailure: { statusCode: 503, rawCode: "VIVA_SUBSCRIPTION_BOOKING_REJECTED" } }],
    ["history_bookings", "VIVA_SERVICE_TOKEN_UNAVAILABLE", { activeBookingsPayload: [] }, false, []],
  ]) {
    const input = { req: req(), statusCode: step === "history_bookings" || step === "operation_fail" ? 200 : 503,
      payload, _subscriptionBooking: ctx(step, extra) };
    const enabled = structuredClone(input), baseline = structuredClone(input), { events, diagnostics } = observer();
    assert.deepEqual(run(gateway.router, enabled, diagnostics, token), run(gateway.router, baseline, undefined, token));
    assert.equal(enabled.statusCode, 503, step);
    assert.deepEqual(run(gateway.finalize, enabled, diagnostics), run(gateway.finalize, baseline));
    const [event] = failures(events); assert.equal(failures(events).length, 1);
    assert.equal(event.code, code); assert.equal(event.action, "book"); assert.equal(event.operationStage, step);
    assert.equal(event.requestId, events[0].requestId); safe(event);
    if (["exercise", "prospective_subscriptions"].includes(step)) {
      assert.equal(event.upstreamStatus, 503); assert.equal(event.upstreamPhase, step);
    }
  }
});

test("live product guards preserve their exact returned 503 code/step through the finalizer", () => {
  // These stages exist in the audited installed router, not the older local router fixture.
  for (const [step, code] of [["prospective_subscriptions", "SUBSCRIPTION_PRODUCT_CURRENT_STATE_UNAVAILABLE"],
    ["lk1_money_owned_subscriptions", "SUBSCRIPTION_PRODUCT_CURRENT_STATE_UNAVAILABLE"],
    ["lk1_product_identity_return", "SUBSCRIPTION_PRODUCT_UNRESOLVED"]]) {
    const { diagnostics, events } = observer(), request = req();
    diagnostics.observe({ req: request, statusCode: 503, payload: {}, _subscriptionBooking: ctx(step) }, "booking_router");
    const msg = { req: request, statusCode: 503, payload: { details: { code } }, _subscriptionBooking: ctx(step) };
    const baseline = structuredClone(msg);
    assert.deepEqual(run(gateway.finalize, msg, diagnostics), run(gateway.finalize, baseline));
    const [event] = failures(events); assert.equal(event.code, code); assert.equal(event.operationStage, step);
    assert.equal(event.upstreamPhase, step); assert.equal(event.upstreamStatus, 503); safe(event);
  }
});

test("profile upstream 503 remains 502 and does not masquerade as terminal 503", () => {
  const { events, diagnostics } = observer();
  const msg = { req: req(), payload: {}, statusCode: 503, _subscriptionBooking: ctx("profile") };
  run(gateway.router, msg, diagnostics); run(gateway.finalize, msg, diagnostics);
  assert.equal(msg.statusCode, 502); assert.deepEqual(failures(events), []);
});

const roster = [
  ["fn_legacy_roster_bridge_response.js", "roster_bridge_response", "bc18bbb2240b5f7964b366db1bec51b32f2bae41a9e72925eb2c5e1f6b5f02d2"],
  ["fn_legacy_roster_projection_build.js", "roster_projection_build", "a55ba88590866f93e7ebc7b432a00435acf022f463a1c8b6bd007f374e0e13b0"],
  ["fn_legacy_roster_projection_ack.js", "roster_projection_ack", "3ab7a8741336a9879803b727722fa65d8522c6e1aa941b18c9476df7041a19dd"],
];
function rosterSources(name, hash) {
  const path = `scripts/nodered_games_nodes/${name}`, source = read(path);
  const prefixEnd = source.indexOf("\n};\n") + 4;
  const original = source.slice(prefixEnd).replace("  lkDiagnosticFailure(statusCode, code);\n", "");
  assert.equal(sha(original), hash); return { path, source, original };
}

test("direct bridge/projection 503 responses report their emitting node without finalizer", () => {
  for (const [index, input, code] of [
    [0, { payload: {}, statusCode: 503 }, "LEGACY_GAME_BRIDGE_UPSTREAM_FAILED"],
    [1, { payload: [] }, "LEGACY_ROSTER_PROJECTION_CONTEXT_INVALID"],
    [2, { payload: {} }, "LEGACY_ROSTER_PROJECTION_CONTEXT_INVALID"],
    [2, { _legacyRosterBridge: {}, _legacyRosterProjectionWrite: {}, error: {} }, "LEGACY_ROSTER_PROJECTION_WRITE_FAILED"],
    [2, { _legacyRosterBridge: {}, _legacyRosterProjectionWrite: {}, payload: { acknowledged: false, matchedCount: 0 } }, "LEGACY_ROSTER_PROJECTION_UNACKNOWLEDGED"],
  ]) {
    const [name, stage, hash] = roster[index], { source, original } = rosterSources(name, hash);
    const enabled = { req: req(), ...structuredClone(input) }, baseline = structuredClone(enabled), { events, diagnostics } = observer();
    assert.deepEqual(run(source, enabled, diagnostics), run(original, baseline));
    const [event] = failures(events); assert.equal(failures(events).length, 1);
    assert.equal(event.code, code); assert.equal(event.stage, stage); assert.equal(event.operationStage, stage);
    assert.equal(event.action, "UNKNOWN"); assert.equal(event.sourceHash, hash); safe(event);
    if (index === 0) { assert.equal(event.upstreamStatus, 503); assert.equal(event.upstreamPhase, stage); }
    else assert.equal(event.upstreamStatus, undefined);
  }
});

test("projection retry, exhausted conflict and successful ACK preserve exact outputs and fan-out", () => {
  const { source, original } = rosterSources(roster[2][0], roster[2][2]);
  for (const extra of [
    { _legacyRosterBridge: { retryCount: 0 }, payload: { acknowledged: true, matchedCount: 0 } },
    { _legacyRosterBridge: { retryCount: 3 }, payload: { acknowledged: true, matchedCount: 0 } },
    { payload: { acknowledged: true, matchedCount: 1 } },
  ]) {
    const input = { req: req(), _legacyRosterBridge: { gameId: "synthetic-game" },
      _legacyRosterProjectionWrite: { nextRevision: 1, response: { statusCode: 200, payload: { ok: true } } }, ...extra };
    const { events, diagnostics } = observer();
    assert.deepEqual(run(source, structuredClone(input), diagnostics), run(original, structuredClone(input)));
    assert.deepEqual(failures(events), []);
  }
});

test("attested roster hooks preserve graph and reject source/candidate/route drift", () => {
  for (const [name, , hash] of roster) {
    const { path, source, original } = rosterSources(name, hash);
    const route = { id: "synthetic-route", type: "http in", method: "post", url: "/lk/subscription-bookings", z: "tab", wires: [["synthetic-node"]] };
    const node = { id: "synthetic-node", type: "function", z: "tab", func: original, wires: [[]] };
    const flow = [route, node], before = structuredClone(flow);
    const att = { id: node.id, path, routeId: route.id, routeHash: sha(JSON.stringify(route)), preimageHash: hash, candidateHash: sha(source) };
    const actual = applySourceHooks(flow, [att]); assert.deepEqual(flow, before); assert.equal(actual[1].func, source);
    assert.deepEqual(actual.map(node => ({ ...node, func: undefined })), flow.map(node => ({ ...node, func: undefined })));
    assert.throws(() => applySourceHooks([route, { ...node, func: original + "\n" }], [att]), /DRIFT/);
    assert.throws(() => applySourceHooks(flow, [{ ...att, candidateHash: "0".repeat(64) }]), /DRIFT/);
    assert.throws(() => applySourceHooks([{ ...route, wires: [[]] }, node], [{ ...att, routeHash: sha(JSON.stringify({ ...route, wires: [[]] })) }]), /BINDING/);
  }
});

test("owner capability early 503 overlay preserves outputs and rejects unknown installed text", () => {
  const original = read("scripts/nodered_subscription_booking_nodes/fn_subscription_booking_prepare.js");
  const { needle, replacement } = bookingPrepareFailureEdits(); assert.equal(original.split(needle).length, 2);
  // Offline fixture differs from installed opaque text. Production admission remains exact-hash-only.
  const source = original.replace(needle, replacement);
  const input = { req: req(), _quarterCreateCapability: { version: 0 }, _gameCreateOwner: {} };
  const { events, diagnostics } = observer();
  assert.deepEqual(run(source, structuredClone(input), diagnostics), run(original, structuredClone(input)));
  const [event] = failures(events); assert.equal(event.code, "GAME_CREATE_OWNER_GRAPH_UNAVAILABLE");
  assert.equal(event.stage, "booking_prepare"); safe(event);
  assert.throws(() => applyBookingPrepareFailureObserver(original, { preimageHash: sha(original), candidateHash: sha(source) }), /DRIFT/);
});

test("closed code catalog preserves audited 503 families and excludes free text", () => {
  for (const code of ["SUBSCRIPTION_PRODUCT_LOOKUP_BUSY", "VIVA_SERVICE_TOKEN_REFRESH_IN_PROGRESS",
    "SUBSCRIPTION_PRODUCT_UNRESOLVED", "MANAGED_SUBSCRIPTION_ENVIRONMENT_CHANGED", "TRIAL_TRAINING_HISTORY_INCOMPLETE",
    "TRIAL_TRAINING_ATTENDANCE_UNVERIFIED", "SPLIT_EXERCISE_COMPENSATION_UNVERIFIED", "SUBSCRIPTION_ENTITLEMENT_NOT_CONFIGURED"]) {
    const { events, diagnostics } = observer();
    diagnostics.observe({ req: req(), statusCode: 503, payload: { details: { code } }, _subscriptionBooking: ctx("operation_fail") }, "booking_finalize");
    assert.equal(failures(events)[0].code, code);
  }
  const { events, diagnostics } = observer();
  diagnostics.observe({ req: req(), statusCode: 503, payload: { details: { code: "SYNTHETIC_PRIVATE_CODE" } },
    _subscriptionBooking: ctx("SYNTHETIC_PRIVATE_STEP", { action: "SYNTHETIC_PRIVATE_ACTION" }) }, "booking_finalize");
  const [event] = failures(events); safe(event); assert.equal(event.code, "UNKNOWN");
  assert.equal(event.action, "UNKNOWN"); assert.equal(event.operationStage, "UNKNOWN");
});

test("last upstream facts are request-isolated; invalid latest status cannot retain an older status", () => {
  const { events, diagnostics } = observer(), request = req();
  for (const statusCode of [503, "SYNTHETIC_PRIVATE_STATUS"]) diagnostics.observe({ req: request, statusCode, payload: {}, _subscriptionBooking: ctx("exercise") }, "booking_router");
  diagnostics.observe({ req: request, statusCode: 503, payload: {}, _subscriptionBooking: ctx("operation_fail") }, "booking_finalize");
  assert.equal(failures(events)[0].upstreamStatus, undefined); assert.equal(failures(events)[0].upstreamPhase, "exercise");
  diagnostics.observe({ req: req(), statusCode: 503, payload: {}, _subscriptionBooking: ctx("operation_fail") }, "booking_finalize");
  assert.equal(failures(events)[1].upstreamPhase, undefined);
});

test("503 enrichment stays on exact POST and logging failures do not change any operation", () => {
  for (const request of [{ ...req(), method: "GET" }, { ...req(), path: "/lk/subscription-bookings/other" }]) {
    const { events, diagnostics } = observer();
    diagnostics.observe({ req: request, statusCode: 503, payload: {}, _subscriptionBooking: ctx("operation_fail") }, "booking_finalize");
    assert.equal(events[0]?.action, undefined);
  }
  for (const [name, , hash] of roster) {
    const { source, original } = rosterSources(name, hash), input = { req: req(), statusCode: 503, payload: {} };
    for (const diagnostics of [undefined, { observe() { throw Error("synthetic-observer"); } }, observer({ sink() { throw Error("synthetic-sink"); } }).diagnostics])
      assert.deepEqual(run(source, structuredClone(input), diagnostics), run(original, structuredClone(input)));
  }
  assert(diagnosticContract.enums.code.includes("LEGACY_ROSTER_PROJECTION_UNACKNOWLEDGED"));
});

test("source-only installed prepare receipt is bound to the shipped overlay", () => {
  const receipt = JSON.parse(read("docs/diagnostics/booking-prepare-503-preimage.json"));
  assert.equal(receipt.overlay_module_sha256, sha(read("scripts/diagnostics/booking-prepare-failure-overlay.mjs")));
  assert.equal(receipt.function_match_count, 1); assert.equal(receipt.source_edit_validated, true);
  assert.equal(receipt.original_recovered, true); assert.equal(receipt.business_executed, false);
  assert.equal(receipt.server_write, false); assert.equal(receipt.does_not_prove_runtime_activation, true);
});
