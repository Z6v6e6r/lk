// The LK1 Topokraty rejection/reclaim generation: the reviewed delivery vehicle for the
// production incident of 2026-09-25 (direction 6233 «Топократы тренировка»).
//
// The hermetic half drives the reviewed predicate and step on synthetic documents and proves
// that the reviewed gateway source carries the same fragments; the snapshot half proves the
// candidate against the exact live flow copied by the operator (skipped when it is absent).
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import {
  TOPOKRATY_RECLAIM_FRAGMENTS,
  TOPOKRATY_RECLAIM_GATEWAY_ID,
  TOPOKRATY_RECLAIM_PREVIEW_ID,
  TOPOKRATY_RECLAIM_TARGET,
  TOPOKRATY_RECLAIM_UPSTREAM_SHA256,
  composeTopokratyReclaimArtifacts,
  sha256,
} from "../patch_live_lk1_topokraty_rejection_reclaim_hotfix.mjs";
import { hubGatewaySource } from "../lib/eventPaymentSources.mjs";

const UPSTREAM_FLOW = process.env.LK1_TOPOKRATY_RECLAIM_UPSTREAM_FLOW
  ?? "/private/tmp/padlhub-topokraty-apply-20260925/input/source.flow.json";
const snapshotSkip = fs.existsSync(UPSTREAM_FLOW)
  ? false
  : `live flow is absent: ${UPSTREAM_FLOW} (pull it with npm run nodered:modular:pull-147, `
    + "or set LK1_TOPOKRATY_RECLAIM_UPSTREAM_FLOW)";

// ---------------------------------------------------------------------------------------------
// The reviewed fragments must be inside the reviewed gateway source: the installed body is a
// delta on the live flow, so a source that lost the rule would silently drop it on the next
// regeneration.
const gatewaySource = fs.readFileSync("scripts/nodered_lk1_hub_nodes/gateway.js", "utf8");
const hooksSource = fs.readFileSync("scripts/nodered_lk1_hub_nodes/gateway_hooks.js", "utf8");
const patcherSource = fs.readFileSync("scripts/patch_live_lk1_topokraty_rejection_reclaim_hotfix.mjs", "utf8");

const normalized = (value) => value.replace(/\s+/g, " ").trim();

test("the reviewed gateway source carries the same reclaim predicate, branch, step and refusal", () => {
  const source = normalized(gatewaySource);
  for (const name of ["helper", "branch", "step"]) {
    assert.ok(source.includes(normalized(TOPOKRATY_RECLAIM_FRAGMENTS[name])),
      `the reviewed gateway source must carry the ${name} fragment`);
  }
  assert.ok(normalized(hooksSource).includes(normalized(TOPOKRATY_RECLAIM_FRAGMENTS.guard)),
    "the reviewed hooks source must carry the Topokraty refusal");
  assert.match(gatewaySource, /const LK1_RECLAIM_ATTEMPT_CAP = 5;/);
  assert.match(patcherSource, /reviewed, versioned code|Reviewed live preimage/);
});

test("the composed hub body carries the reclaim for every reviewed composition path", () => {
  // `hubGatewaySource()` is the booking body without the hook helpers: the reclaim predicate,
  // branch and step are in it, the exercise-step refusal comes from `gateway_hooks.js`.
  const body = normalized(hubGatewaySource());
  for (const name of ["helper", "branch", "step"]) {
    assert.ok(body.includes(normalized(TOPOKRATY_RECLAIM_FRAGMENTS[name])),
      `the composed body must carry the ${name} fragment`);
  }
  assert.ok(!body.includes("TOPOKRATY_SUBSCRIPTION_UNAVAILABLE"),
    "the refusal belongs to the hook section, not to the gateway source alone");
});

// ---------------------------------------------------------------------------------------------
// Executable behaviour: the reviewed predicate and step run inside the composed gateway body.
const prefix = `
const isObj = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const toStr = value => (typeof value === 'string' && value.trim()) ? value.trim()
  : (typeof value === 'number' && Number.isFinite(value)) ? String(value) : null;
const managedActionForTarget = ctx => ctx.managedAction;
const OUTPUT_FINAL = 4, OUTPUT_MONGO_FIND = 1, OUTPUT_MONGO_INSERT = 2, OUTPUT_MONGO_UPDATE = 3;
const emitted = [];
const emit = output => ({ output, msg });
const finishPending = (ctx, message, details) => ({ output: 4, status: 202, state: 'PENDING_CONFIRMATION',
  message, details });
const finishError = (ctx, status, message, details) => ({ output: 4, status, message, details });
const finishConfirmed = () => { throw new Error('unexpected confirm'); };
const prepareMongoUpdate = (ctx, step, query, update) => {
  ctx.step = step;
  return { output: 3, msg: { _subscriptionBooking: ctx, payload: [query, update, {}] } };
};
const prepareAdminGet = (ctx, step) => { ctx.step = step; return { output: 0, msg: { _subscriptionBooking: ctx } }; };
const prepareUserGet = (ctx, step) => { ctx.step = step; return { output: 0, msg: { _subscriptionBooking: ctx } }; };
const PREPARED_LEASE_MS = 30000;
// Injected by hooks.HELPERS in the real composition; the reviewed predicate/step uses it
// exactly as the installed body does.
const lk1MongoMatched = value => (value && value.accepted === undefined && value.acknowledged === true
  ? value.matchedCount : null);
const ctx = msg._subscriptionBooking;
`;
const body = hubGatewaySource();
const run = new Function("msg", prefix + body + "\nreturn { ctx, msg };");
const helpers = new Function("msg", prefix + body
  + "\nreturn { lk1Fingerprint, lk1ReclaimableAttempt }; ")({ _subscriptionBooking: {} });

const ACTOR = "83756527-cfbe-4b7f-b143-1a6ac96d2a93";
const OPERATION_ID = "lk-subscription-3rv9se1dk5p34";
const EXERCISE_ID = "ea5b5b95-ccfa-44c0-8532-615f2e6dc5fb";

function fixture(overrides = {}) {
  // The ingress path never sets ctx.operationKey: the reclaimed write must fence on the
  // validated _id of the found document.
  const ctx = { caller: "http", managedAction: "BOOK_GROUP_TRAINING", tenantKey: "iSkq6G",
    actorClientId: ACTOR, operationId: OPERATION_ID, clientSubscriptionId: "54de4878-2e04-4dd3-a1c8-1ecca8e14061",
    exerciseId: EXERCISE_ID, step: "lk1_ingress_operation_find", lk1IngressReplay: true };
  const quote = { rule: { productId: "b91e14d1-fe6e-4d0b-be39-3e45ad86b759" }, purchaseDate: "2026-09-16",
    target: { eventId: EXERCISE_ID }, decision: { eligible: true, subscriptionVisitCount: 1,
      benefit: { finalPriceMinor: 0 } } };
  quote.fingerprint = helpers.lk1Fingerprint(ctx, quote);
  const record = {
    _id: `lk1-product:${JSON.stringify([ctx.tenantKey, ctx.actorClientId, ctx.operationId])}`,
    tenantKey: ctx.tenantKey, actorClientId: ctx.actorClientId, operationId: ctx.operationId,
    clientSubscriptionId: ctx.clientSubscriptionId, exerciseId: EXERCISE_ID, category: "group_training",
    state: "FAILED", attempts: 1, lk1: quote, createdAt: "2026-09-25T15:01:51.247Z",
    updatedAt: "2026-09-25T15:01:51.692Z", upstreamAttemptedAt: "2026-09-25T15:01:51.282Z",
    failedAt: "2026-09-25T15:01:51.692Z",
    failure: { statusCode: 400, message: "Абонемент «РА» не действует на этом занятии: другой тип занятия, другое направление", rawCode: "BAD_REQUEST" },
    ...overrides,
  };
  return { ctx, record };
}

test("the incident document is reclaimable and the reclaim write restarts it under its own id", () => {
  const { ctx, record } = fixture();
  assert.equal(helpers.lk1ReclaimableAttempt(record), true);
  const out = run({ _subscriptionBooking: ctx, payload: [record] });
  assert.equal(out.msg._subscriptionBooking.step, "lk1_ingress_reclaim");
  const [query, update] = out.msg.payload;
  assert.equal(ctx.operationKey, undefined, "the ingress path never sets ctx.operationKey");
  assert.deepEqual(query, {
    _id: record._id, operationId: OPERATION_ID, actorClientId: ACTOR, state: "FAILED",
    bookingId: { $in: [null, ""] }, upstreamBookingId: { $in: [null, ""] }, attempts: 1,
  });
  assert.equal(update.$set.state, "PREPARED");
  assert.equal(update.$set.previousFailure.message, record.failure.message);
  assert.equal(update.$set.previousFailureAt, record.failedAt);
  assert.deepEqual(update.$unset, { failedAt: "", upstreamAttemptedAt: "", leaseUntil: "", pendingUntil: "", failure: "" });
  assert.deepEqual(update.$inc, { attempts: 1, reclaimCount: 1 });
  // The stored document itself is never mutated in place.
  assert.equal(record.state, "FAILED");
});

test("an accepted reclaim continues the fresh path, a lost race keeps the reconciliation stop", () => {
  const { ctx } = fixture();
  ctx.step = "lk1_ingress_reclaim";
  const won = run({ _subscriptionBooking: ctx, payload: { acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedCount: 0, upsertedId: null } });
  assert.equal(won.ctx.step, "lk1_profile_continue");
  assert.equal(won.ctx.lk1IngressReplay, undefined);
  const lost = fixture();
  lost.ctx.step = "lk1_ingress_reclaim";
  const race = run({ _subscriptionBooking: lost.ctx, payload: { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0, upsertedId: null } });
  assert.equal(race.output, 4);
  assert.equal(race.status, 202);
  assert.equal(race.details.code, "LK1_BOOKING_OUTCOME_UNRESOLVED");
});

test("an ambiguous or already-committed attempt is never replayed", () => {
  const cases = [
    ["provider 503", (record) => { record.failure = { statusCode: 503, message: "unavailable", rawCode: null }; }],
    ["provider 500", (record) => { record.failure = { statusCode: 500, message: "boom", rawCode: null }; }],
    ["unknown provider status", (record) => { record.failure = { statusCode: null, message: "socket", rawCode: null }; }],
    ["no failure record", (record) => { delete record.failure; }],
    ["booking created", (record) => { record.bookingId = "3bdd39df-22a2-4827-847f-3766fbf41cfb"; }],
    ["upstream booking created", (record) => { record.upstreamBookingId = "3bdd39df-22a2-4827-847f-3766fbf41cfb"; }],
    ["provider accepted", (record) => { record.acceptedAt = "2026-09-25T15:01:51.500Z"; }],
    ["provider correlation recorded", (record) => { record.correlationId = "corr"; }],
    ["money leg attempted", (record) => { record.lk1.transactionAttemptedAt = "2026-09-25T15:01:51.500Z"; }],
    ["transaction recorded", (record) => { record.lk1.transactionId = "tx-1"; }],
    ["checkout stored", (record) => { record.lk1.checkout = { paymentUrl: "https://example.test/pay" }; }],
    ["visit job stored", (record) => { record.lk1.visitJob = { jobId: "j" }; }],
    ["create attempt recorded", (record) => { record.lk1.createAttemptedAt = "2026-09-25T15:01:51.500Z"; }],
    ["attempt cap reached", (record) => { record.attempts = 5; }],
    ["no write attempt recorded", (record) => { delete record.upstreamAttemptedAt; }],
  ];
  for (const [label, mutate] of cases) {
    const { ctx, record } = fixture();
    mutate(record);
    assert.equal(helpers.lk1ReclaimableAttempt(record), false, `${label} must not be reclaimable`);
    const out = run({ _subscriptionBooking: ctx, payload: [record] });
    assert.equal(out.output, 4, `${label} must keep the reconciliation answer`);
    assert.equal(out.status, 202, `${label} must keep the reconciliation status`);
    // A money leg stored in the quote also fails the replay identity check before the reclaim
    // branch: both are reconciliation answers, and neither writes.
    assert.ok(["LK1_BOOKING_OUTCOME_UNRESOLVED", "LK1_REQUEST_IDENTITY_CHANGED"].includes(out.details.code),
      `${label}: unexpected ${out.details.code}`);
  }
  for (const state of ["PENDING_CONFIRMATION", "CONFIRMED", "RELEASED", "PRECREATE_RESERVING"]) {
    const { ctx, record } = fixture({ state });
    assert.equal(helpers.lk1ReclaimableAttempt(record), false, `${state} must not be reclaimable`);
    const out = run({ _subscriptionBooking: ctx, payload: [record] });
    assert.equal(out.output, 4, `${state} must keep the reconciliation answer`);
    assert.equal(out.status, 202, `${state} must keep the reconciliation status`);
  }
  // An un-attempted reservation is reclaimable; a read-only preflight never writes.
  const reserved = fixture({ state: "PREPARED" });
  delete reserved.record.failure;
  delete reserved.record.failedAt;
  delete reserved.record.upstreamAttemptedAt;
  assert.equal(helpers.lk1ReclaimableAttempt(reserved.record), true);
  const blocked = run({ _subscriptionBooking: createPreflightFixture().ctx,
    payload: [createPreflightFixture().record] });
  assert.equal(blocked.output, 4, "the read-only preflight must never write");
  assert.equal(blocked.status, 202);
  assert.equal(blocked.details.code, "LK1_BOOKING_OUTCOME_UNRESOLVED");
});

/** A CREATE-shaped readonly preflight that passes the replay identity check. */
function createPreflightFixture() {
  const startsAt = "2026-09-28T14:00:00.000Z";
  const ctx = { caller: "split_create_readonly_preflight", managedAction: "CREATE_GAME", tenantKey: "iSkq6G",
    actorClientId: ACTOR, operationId: OPERATION_ID, clientSubscriptionId: "54de4878-2e04-4dd3-a1c8-1ecca8e14061",
    exerciseId: EXERCISE_ID, step: "lk1_ingress_operation_find", lk1IngressReplay: true,
    lk1CreatePayload: { roomId: "ca1a97e7-9b52-4b67-b48f-cc9b4f9f7c5f" },
    prospectiveTarget: { studioId: "6b2d7e60-caff-4b22-89f6-6f19d7d311ab",
      roomId: "ca1a97e7-9b52-4b67-b48f-cc9b4f9f7c5f", timeFrom: startsAt, timeTo: "2026-09-28T16:00:00.000Z" } };
  const quote = { rule: { productId: "b91e14d1-fe6e-4d0b-be39-3e45ad86b759" }, purchaseDate: "2026-09-16",
    target: { eventId: EXERCISE_ID, stationId: ctx.prospectiveTarget.studioId,
      roomId: ctx.prospectiveTarget.roomId, startsAt, durationMinutes: 120 },
    createPayload: ctx.lk1CreatePayload,
    decision: { eligible: true, subscriptionVisitCount: 1, benefit: { finalPriceMinor: 0 } } };
  quote.fingerprint = helpers.lk1Fingerprint(ctx, quote);
  const record = { _id: `lk1-product:${JSON.stringify([ctx.tenantKey, ctx.actorClientId, ctx.operationId])}`,
    tenantKey: ctx.tenantKey, actorClientId: ctx.actorClientId, operationId: ctx.operationId,
    clientSubscriptionId: ctx.clientSubscriptionId, exerciseId: EXERCISE_ID, category: "group_training",
    state: "FAILED", attempts: 1, lk1: quote, upstreamAttemptedAt: "2026-09-25T15:01:51.282Z",
    failedAt: "2026-09-25T15:01:51.692Z",
    failure: { statusCode: 400, message: "Отклонено", rawCode: "BAD_REQUEST" } };
  assert.equal(helpers.lk1ReclaimableAttempt(record), true,
    "the predicate alone would reclaim it; the caller guard is what refuses");
  return { ctx, record };
}

test("an unknown operation still starts a fresh attempt", () => {
  const { ctx } = fixture();
  const out = run({ _subscriptionBooking: ctx, payload: [] });
  assert.equal(out.ctx.step, "lk1_profile_continue");
  assert.equal(out.msg._subscriptionBooking.step, "lk1_profile_continue");
});

// ---------------------------------------------------------------------------------------------
test("the candidate is composed against the live flow with only two changed nodes", { skip: snapshotSkip }, () => {
  const bytes = fs.readFileSync(UPSTREAM_FLOW);
  assert.equal(sha256(bytes), TOPOKRATY_RECLAIM_UPSTREAM_SHA256);
  const built = composeTopokratyReclaimArtifacts(bytes);
  assert.equal(built.addedNodeCount, 0);
  assert.deepEqual(built.changes.map((change) => ({ id: change.id, fields: change.fields })), [
    { id: TOPOKRATY_RECLAIM_GATEWAY_ID, fields: ["func"] },
    { id: TOPOKRATY_RECLAIM_PREVIEW_ID, fields: ["func"] },
  ]);
  assert.equal(built.booking.reclaimBound, true);
  assert.equal(built.booking.reclaimPrecedesStop, true);
  assert.equal(built.booking.refusalBound, true);
  assert.equal(built.preview.topokratyBound, true);
  assert.equal(built.preview.proTrainingKept, true);
  // The shared preview composition stays byte-identical to the installed generation: the
  // exclusion enters the composed body as this generation's own delta.
  assert.equal(built.preview.sharedPreviewSourcesUnchanged, true);
  const booking = built.flow.find((node) => node.id === TOPOKRATY_RECLAIM_GATEWAY_ID).func;
  assert.equal(sha256(booking), TOPOKRATY_RECLAIM_TARGET.patchedFuncSha256);
  const preview = built.flow.find((node) => node.id === TOPOKRATY_RECLAIM_PREVIEW_ID).func;
  assert.equal(sha256(preview), TOPOKRATY_RECLAIM_TARGET.patchedPreviewFuncSha256);
  assert.match(booking, /TOPOKRATY_SUBSCRIPTION_UNAVAILABLE/);
  assert.match(booking, /ctx\.caller !== "split_create_readonly_preflight" && lk1ReclaimableAttempt\(operation\)/);
  assert.match(booking, /const lk1ReclaimIsRecord = \(value\) => value !== null/);
  assert.match(booking, /function isTopokratyClubPack\(value\) \{/);
  assert.match(booking, /function isProTrainingEnergyPack\(value\) \{/);
  // The installed preimage still documents the rule this generation replaces.
  assert.match(booking, /Never reclaim\/overwrite an LK1 request or repeat an ambiguous Viva write/);
  // The generation is idempotent-refusing: a second run on its own postimage stops.
  assert.throws(() => composeTopokratyReclaimArtifacts(built.candidateBytes),
    /Live flow preimage drift/);
});

test("a modified live preimage is refused", { skip: snapshotSkip }, () => {
  const flow = JSON.parse(fs.readFileSync(UPSTREAM_FLOW, "utf8"));
  flow.find((node) => node.id === TOPOKRATY_RECLAIM_GATEWAY_ID).func += "\n// drift";
  const bytes = Buffer.from(JSON.stringify(flow));
  assert.throws(() => composeTopokratyReclaimArtifacts(bytes), /preimage drift|node count drift/);
});

test("the candidate keeps every unrelated node byte-identical", { skip: snapshotSkip }, () => {
  const bytes = fs.readFileSync(UPSTREAM_FLOW);
  const built = composeTopokratyReclaimArtifacts(bytes);
  const live = JSON.parse(bytes.toString("utf8"));
  const changed = new Set([TOPOKRATY_RECLAIM_GATEWAY_ID, TOPOKRATY_RECLAIM_PREVIEW_ID]);
  for (const node of live) {
    if (changed.has(node.id)) continue;
    const after = built.flow.find((candidate) => candidate.id === node.id);
    assert.deepEqual(after, node, `node ${node.id} must stay byte-identical`);
  }
  assert.equal(sha256(JSON.stringify(built.flow.map((node) => node.id))),
    sha256(JSON.stringify(live.map((node) => node.id))), "the node order must stay identical");
  assert.equal(crypto.createHash("sha256").update(built.candidateBytes).digest("hex"), built.candidateSha256);
});
