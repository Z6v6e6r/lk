// Focused generation: a confirmed subscription claim is replayed only after the provider
// is re-read, and the replay carries the money evidence the widget validates.
//
// The live incident (2026-09-16, game pay_66a6b649…, client 24dda8e0…): the split
// participant payment-timeout cleanup cancelled the Viva booking and left the claim
// `CONFIRMED`. Every repeat of the same deterministic join returned 200 with a payload
// that carried neither `mode`/`paymentRef`/`gameId` nor a provider check, so the widget
// rendered "Не удалось подтвердить условия подписки" and the player could not rejoin.
//
// These tests pin the reviewed live preimages and postimages, the fail-closed preimage
// gates, the agreement between the patched live bodies and the reviewed sources, and the
// behavioural verdict of the patched bodies. The behavioural cases need the reviewed live
// snapshot; they skip (never silently pass) when it is absent.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { hubGatewaySource } from "../lib/eventPaymentSources.mjs";
import {
  CONFIRMED_REPLAY_FINALIZE_DELTAS,
  CONFIRMED_REPLAY_GATEWAY_DELTAS,
  CONFIRMED_REPLAY_SOURCE_NODE_COUNT,
  CONFIRMED_REPLAY_SOURCE_SHA256,
  CONFIRMED_REPLAY_TARGETS,
  FINALIZE_MARKERS,
  GATEWAY_MARKERS,
  composeConfirmedReplayArtifacts,
  patchConfirmedReplayFinalizeBody,
  patchConfirmedReplayGatewayBody,
  sha256,
} from "../patch_live_lk1_confirmed_replay_guard_hotfix.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LIVE_SNAPSHOT = process.env.LK1_CONFIRMED_REPLAY_LIVE_SNAPSHOT
  ?? "/private/tmp/lk1-confirmed-replay-live/input/source.flow.json";
const snapshotSkip = fs.existsSync(LIVE_SNAPSHOT)
  ? false
  : `live 147 snapshot is absent: ${LIVE_SNAPSHOT} (set LK1_CONFIRMED_REPLAY_LIVE_SNAPSHOT)`;

const liveFlow = () => JSON.parse(fs.readFileSync(LIVE_SNAPSHOT, "utf8"));
const liveFunc = (id) => {
  const node = liveFlow().find((item) => item.id === id);
  assert.ok(node, `${id} is absent from the snapshot`);
  return node.func;
};

test("the deltas are exact, singular and reach the reviewed sources", () => {
  assert.equal(CONFIRMED_REPLAY_SOURCE_NODE_COUNT, 4804);
  assert.match(CONFIRMED_REPLAY_SOURCE_SHA256, /^[0-9a-f]{64}$/);
  for (const [label, deltas] of [
    ["gateway", CONFIRMED_REPLAY_GATEWAY_DELTAS],
    ["finalize", CONFIRMED_REPLAY_FINALIZE_DELTAS],
  ]) {
    assert.ok(deltas.length > 0, `${label} deltas are missing`);
    for (const delta of deltas) {
      assert.ok(delta.before.length > 0 && delta.after.length > 0, `${delta.id} is empty`);
      assert.notEqual(delta.before, delta.after, `${delta.id} is a no-op`);
    }
  }
  const hub = hubGatewaySource();
  for (const marker of GATEWAY_MARKERS) {
    assert.ok(hub.includes(marker), `reviewed gateway source is missing: ${marker}`);
  }
  const finalize = fs.readFileSync(path.join(repoRoot, "scripts/nodered_lk1_hub_nodes/finalize.js"), "utf8");
  for (const marker of FINALIZE_MARKERS) {
    assert.ok(finalize.includes(marker), `reviewed finalize source is missing: ${marker}`);
  }
});

test("the patched bodies parse, carry the guard and drop the superseded replay", { skip: snapshotSkip }, () => {
  const patchedGateway = patchConfirmedReplayGatewayBody(liveFunc("lk_subscription_booking_router_20260804"));
  const patchedFinalize = patchConfirmedReplayFinalizeBody(liveFunc("lk_subscription_booking_finalize_20260804"));
  assert.equal(sha256(patchedGateway), CONFIRMED_REPLAY_TARGETS.gateway.patchedFuncSha256);
  assert.equal(sha256(patchedFinalize), CONFIRMED_REPLAY_TARGETS.finalize.patchedFuncSha256);
  assert.ok(!patchedGateway.includes(`    ctx.confirmedBookingId = operation.bookingId;
    return lk1Finish(ctx);`), "the unverified replay region survived");
  assert.ok(!patchedFinalize.includes(
    `      selectedPaymentMode: payload.toPayMinor > 0 ? "one_time" : "subscription" };`),
  "the money-less replay response survived");
  // Idempotence is not claimed: a second pass must fail closed instead of double-applying.
  assert.throws(() => patchConfirmedReplayGatewayBody(patchedGateway), /does not match exactly one preimage region/);
  assert.throws(() => patchConfirmedReplayFinalizeBody(patchedFinalize), /does not match exactly one preimage region/);
});

test("composition fails closed on a drifted preimage", { skip: snapshotSkip }, () => {
  const bytes = fs.readFileSync(LIVE_SNAPSHOT);
  assert.throws(() => composeConfirmedReplayArtifacts(bytes, "lk1-confirmed-replay-guard",
    { expectedSourceSha256: "0".repeat(64) }), /Live flow preimage drift/);
  const flow = JSON.parse(bytes.toString("utf8"));
  const mutated = Buffer.from(`${JSON.stringify(flow.map((node) => (
    node.id === "lk_subscription_booking_router_20260804" ? { ...node, func: `${node.func}\n` } : node
  )), null, 2)}\n`);
  assert.throws(() => composeConfirmedReplayArtifacts(mutated, "lk1-confirmed-replay-guard"),
    /Live flow preimage drift/);
});

test("the candidate changes exactly the two funcs and no topology", { skip: snapshotSkip }, () => {
  const built = composeConfirmedReplayArtifacts(fs.readFileSync(LIVE_SNAPSHOT), "lk1-confirmed-replay-guard");
  assert.equal(built.flow.length, CONFIRMED_REPLAY_SOURCE_NODE_COUNT);
  assert.equal(built.changes.length, 2);
  assert.deepEqual(built.changes.map((change) => change.fields), [["func"], ["func"]]);
  assert.equal(built.addedNodeCount, 0);
  assert.equal(built.preview.gatewayGuard, true);
  assert.equal(built.preview.finalizeMoneyEvidence, true);
  const candidate = JSON.parse(built.candidateBytes.toString("utf8"));
  const live = JSON.parse(fs.readFileSync(LIVE_SNAPSHOT, "utf8"));
  for (const node of live) {
    const other = candidate.find((item) => item.id === node.id);
    assert.deepEqual({ ...other, func: null }, { ...node, func: null }, `${node.id} changed beyond func`);
  }
});

// --- behavioural: the patched live bodies ------------------------------------------------

const MSG_HELPERS = `
const __sandboxEnv = env;
const __sandboxGlobal = global;
const __noop = () => undefined;
`;

function runBody(body, msg) {
  // Node-RED evaluates the body with the sandbox globals in scope. The provider call
  // needs a cached service token; every other global stays a fixture value.
  const sandboxGlobal = { get: (key) => (key === "vivacrm_access_token" ? "fixture-token" : undefined), set: () => {} };
  const fn = new Function("msg", "node", "env", "global", "context", `${MSG_HELPERS}\n${body}`);
  return fn(msg, { id: "fixture-node" }, { get: () => undefined }, sandboxGlobal,
    { get: () => undefined, set: () => {} });
}

function gatewayHelpers(patchedGateway) {
  // The live body is self-contained: it carries its own helpers. Everything before the
  // first step guard is evaluated so the fixture can compute the real operation
  // fingerprint instead of guessing it.
  const head = patchedGateway.slice(0, patchedGateway.indexOf("\nif (ctx."));
  const sandboxGlobal = { get: (key) => (key === "vivacrm_access_token" ? "fixture-token" : undefined), set: () => {} };
  return new Function("msg", "node", "env", "global", "context",
    `${MSG_HELPERS}\n${head}\nreturn { lk1Fingerprint };`)(
    { _subscriptionBooking: {} }, { id: "fixture-node" }, { get: () => undefined },
    sandboxGlobal, { get: () => undefined, set: () => {} });
}

const TENANT = "fixture-tenant";
const ACTOR = "fixture-actor";
const SUBSCRIPTION = "fixture-subscription";
const OPERATION = "lk-split-join-fixture";
const BOOKING = "fixture-booking";
const EXERCISE = "fixture-exercise";
const FINGERPRINTED = { rule: { productId: "fixture-product" },
  target: { eventId: EXERCISE, stationId: "fixture-studio" },
  decision: { eligible: true, subscriptionVisitCount: 1, benefit: { finalPriceMinor: 70000 } } };

function ingressMsg(patchedGateway, overrides = {}) {
  const helpers = gatewayHelpers(patchedGateway);
  const ctx = {
    caller: "split", managedAction: "JOIN_GAME", tenantKey: TENANT, actorClientId: ACTOR,
    operationId: OPERATION, clientSubscriptionId: SUBSCRIPTION, exerciseId: EXERCISE,
    step: "lk1_ingress_operation_find", lk1IngressReplay: true,
    authHeader: "Bearer fixture", confirmedBookingId: null,
  };
  const quote = structuredClone(FINGERPRINTED);
  quote.fingerprint = helpers.lk1Fingerprint(ctx, quote);
  const record = {
    _id: `lk1-product:${JSON.stringify([TENANT, ACTOR, OPERATION])}`,
    operationId: OPERATION, tenantKey: TENANT, actorClientId: ACTOR,
    clientSubscriptionId: SUBSCRIPTION, exerciseId: EXERCISE, category: "open_game",
    state: "CONFIRMED", bookingId: BOOKING, updatedAt: "2026-09-16T14:57:48.606Z",
    lk1: { ...quote, transactionAttemptedAt: "2026-09-16T14:57:48.339Z", transactionId: "fixture-tx",
      transactionIntent: { bookingId: BOOKING, actorClientId: ACTOR, studioId: "fixture-studio", chargeMinor: 70000 },
      checkout: { transactionId: "fixture-tx", toPayMinor: 70000, paymentUrl: "https://example.invalid/pay" } },
    ...overrides,
  };
  return { _subscriptionBooking: ctx, payload: [record] };
}

const bookingRow = (extra = {}) => ({
  id: BOOKING, clientId: ACTOR, clientSubscriptionId: SUBSCRIPTION, exerciseId: EXERCISE,
  status: "ACTIVE", ...extra,
});
const completePage = (rows) => ({ content: rows, totalElements: rows.length, number: 0, totalPages: 1, last: true });

test("a confirmed ingress replay asks the provider before it replays the checkout", { skip: snapshotSkip }, () => {
  const patched = patchConfirmedReplayGatewayBody(liveFunc("lk_subscription_booking_router_20260804"));
  const out = runBody(patched, ingressMsg(patched));
  const request = out[0]._subscriptionBooking;
  assert.equal(request.step, "lk1_ingress_confirmed_booking_recheck");
  assert.equal(request.lk1ConfirmedReplay.bookingId, BOOKING);
  assert.match(out[0].url, /showCancelled=true/);
  assert.equal(out[0].method, "GET");
});

test("a live provider row keeps the ordinary replay with its money evidence", { skip: snapshotSkip }, () => {
  const patched = patchConfirmedReplayGatewayBody(liveFunc("lk_subscription_booking_router_20260804"));
  const msg = runBody(patched, ingressMsg(patched))[0];
  msg.statusCode = 200;
  msg.payload = completePage([bookingRow()]);
  const out = runBody(patched, msg);
  const final = out[4];
  assert.equal(final.statusCode, 200);
  assert.equal(final.payload.state, "CONFIRMED");
  assert.equal(final.payload.toPayMinor, 70000);
  assert.equal(final.payload.transactionId, "fixture-tx");
  assert.equal(final.lk1ConfirmedReplay, undefined);
});

test("a cancelled or deleted provider booking releases the claim before any replay", { skip: snapshotSkip }, () => {
  const patched = patchConfirmedReplayGatewayBody(liveFunc("lk_subscription_booking_router_20260804"));
  const scenarios = [
    ["cancelled row", completePage([bookingRow({ status: "CANCELLED" })])],
    ["deleted row", completePage([bookingRow({ id: "other", clientId: "other-actor" })])],
    ["empty page", completePage([])],
  ];
  for (const [label, page] of scenarios) {
    const msg = runBody(patched, ingressMsg(patched))[0];
    msg.statusCode = 200;
    msg.payload = page;
    const out = runBody(patched, msg);
    const update = out[3];
    assert.ok(update, `${label} must produce a compare-and-swap update`);
    assert.equal(update._subscriptionBooking.step, "lk1_confirmed_orphan_release");
    const [query, mutation] = update.payload;
    assert.equal(query.state, "CONFIRMED");
    assert.equal(query.bookingId, BOOKING);
    assert.equal(mutation.$set.state, "RELEASED");
    assert.equal(mutation.$set.releaseReason, "CONFIRMED_BOOKING_GONE");
    // The stored money leg stays in the document for the operator.
    assert.equal(mutation.$unset, undefined);
  }
});

test("unverified provider evidence and a live neighbour keep the claim", { skip: snapshotSkip }, () => {
  const patched = patchConfirmedReplayGatewayBody(liveFunc("lk_subscription_booking_router_20260804"));
  const incomplete = runBody(patched, (() => {
    const msg = runBody(patched, ingressMsg(patched))[0];
    msg.statusCode = 200;
    msg.payload = { content: [], last: false };
    return msg;
  })());
  assert.equal(incomplete[4].statusCode, 202);
  assert.equal(incomplete[4].payload.details.code, "LK1_CONFIRMED_BOOKING_EVIDENCE_UNAVAILABLE");
  const liveNeighbour = runBody(patched, (() => {
    const msg = runBody(patched, ingressMsg(patched))[0];
    msg.statusCode = 200;
    msg.payload = completePage([bookingRow({ id: "other" })]);
    return msg;
  })());
  assert.equal(liveNeighbour[4].statusCode, 202);
  assert.equal(liveNeighbour[4].payload.details.code, "LK1_CONFIRMED_BOOKING_STILL_ACTIVE");
});

test("the release acknowledge answers 409 and a lost race stays pending", { skip: snapshotSkip }, () => {
  const patched = patchConfirmedReplayGatewayBody(liveFunc("lk_subscription_booking_router_20260804"));
  const prepared = runBody(patched, (() => {
    const msg = runBody(patched, ingressMsg(patched))[0];
    msg.statusCode = 200;
    msg.payload = completePage([]);
    return msg;
  })())[3];
  const released = runBody(patched, { ...prepared, payload: { matchedCount: 1, modifiedCount: 1 } });
  assert.equal(released[4].statusCode, 409);
  assert.equal(released[4].payload.details.code, "SUBSCRIPTION_BOOKING_CONFIRMED_ORPHAN_RELEASED");
  const lost = runBody(patched, { ...prepared, payload: { matchedCount: 0, modifiedCount: 0 } });
  assert.equal(lost[4].statusCode, 202);
  assert.equal(lost[4].payload.details.code, "LK1_CONFIRMED_ORPHAN_RELEASE_CONFLICT");
});

test("the patched finalizer names the intent and the stored checkout", { skip: snapshotSkip }, () => {
  const patched = patchConfirmedReplayFinalizeBody(liveFunc("lk_subscription_booking_finalize_20260804"));
  const ctx = { lk1IngressReplay: true, lk1: { fingerprint: "f", checkout: { transactionId: "fixture-tx", toPayMinor: 70000, paymentUrl: "https://example.invalid/pay" } } };
  const payload = { ok: true, state: "CONFIRMED", operationId: OPERATION, exerciseId: EXERCISE,
    bookingId: BOOKING, clientSubscriptionId: SUBSCRIPTION, transactionId: "fixture-tx",
    paymentUrl: "https://example.invalid/pay", toPayMinor: 70000, toPay: 700, paid: false };
  const paid = runBody(patched, { _subscriptionBooking: ctx, payload: { ...payload }, statusCode: 200,
    _splitCtx: { action: "join", paymentRef: "fixture-payment-ref", gameId: "pay_fixture" } });
  assert.equal(paid[0], null);
  const response = paid[1].payload;
  assert.equal(response.mode, "join");
  assert.equal(response.paymentRef, "fixture-payment-ref");
  assert.equal(response.gameId, "pay_fixture");
  assert.equal(response.toPayMinor, 70000);
  assert.equal(response.toPay, 700);
  assert.equal(response.settlementState, "PAYMENT_REQUIRED");
  assert.equal(response.selectedPaymentMode, "one_time");
  assert.equal(response.transactionId, "fixture-tx");
  assert.equal(response.paymentUrl, "https://example.invalid/pay");
  // A free covered event replay stays a subscription decision, with explicit zero money.
  const free = runBody(patched, { _subscriptionBooking: { ...ctx, lk1: { fingerprint: "f" } },
    payload: { ...payload, toPayMinor: 0, toPay: 0, transactionId: null, paymentUrl: null }, statusCode: 200,
    _splitCtx: { action: "create", paymentRef: "fixture-payment-ref", gameId: null } });
  assert.equal(free[1].payload.toPayMinor, 0);
  assert.equal(free[1].payload.selectedPaymentMode, "subscription");
  assert.equal(free[1].payload.settlementState, "CONFIRMED");
  assert.equal(free[1].payload.mode, "create");
  // Without the split context the intent falls back to the managed action.
  const fallback = runBody(patched, { _subscriptionBooking: { ...ctx, managedAction: "JOIN_GAME" },
    payload: { ...payload }, statusCode: 200, _splitCtx: undefined });
  assert.equal(fallback[1].payload.mode, "join");
  assert.equal(fallback[1].payload.paymentRef, null);
});

test("the patched finalizer leaves a pending or refused replay untouched", { skip: snapshotSkip }, () => {
  const patched = patchConfirmedReplayFinalizeBody(liveFunc("lk_subscription_booking_finalize_20260804"));
  const pending = runBody(patched, { _subscriptionBooking: { lk1IngressReplay: true, lk1: {} },
    payload: { ok: true, state: "PENDING_CONFIRMATION" }, statusCode: 202, _splitCtx: {} });
  assert.deepEqual(pending[1].payload, { ok: true, state: "PENDING_CONFIRMATION" });
  const refused = runBody(patched, { _subscriptionBooking: { lk1IngressReplay: true, lk1: {} },
    payload: { error: "refused", details: { code: "SUBSCRIPTION_BOOKING_CONFIRMED_ORPHAN_RELEASED" } },
    statusCode: 409, _splitCtx: {} });
  assert.equal(refused[1].payload.error, "refused");
  assert.equal(refused[1].statusCode, 409);
});
