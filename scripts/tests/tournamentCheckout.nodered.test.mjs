import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { patchTournamentSubscriptionGateway, tournamentCheckoutSource } from "../lib/tournamentCheckoutSources.mjs";
import { composeTournamentCheckoutCandidate, CHECKOUT_ROUTE, SUBSCRIPTION_ROUTER_ID } from "../prepare_lk1_tournament_checkout_candidate.mjs";

const run = new Function("msg", "global", "node", "env", tournamentCheckoutSource());
const store = { get: () => "synthetic-service-token" };
const call = msg => run(msg, store, {}, { get: key => key === "VIVA_TENANT_KEY" ? "iSkq6G" : undefined });
const actor = "actor-fixture", exercise = "exercise-fixture";
const offer = { id: "product-1", name: "Тариф", productType: "SERVICE", cost: 250000 };
const target = { id: exercise, studio: { id: "studio-1" }, timeFrom: new Date(Date.now() + 86400000).toISOString(),
  availableClientOneTimes: [offer] };
const identity = { id: actor, phone: "2025550135" };
const allowed = { actorClientId: actor, exerciseId: exercise, tournamentId: "cup-1",
  mode: "ENFORCE", enforced: true, allowed: true, ruleVersion: "rule-1", reasonCode: "LEVEL_ALLOWED" };
const start = (source = "one-time", overrides = {}) => call({ req: { headers: { authorization: "Bearer synthetic-player" } },
  payload: { exerciseId: exercise, productId: "product-1", source, promoCode: "SYNTHETIC",
    successUrl: "https://padlhub.ru/padel_torneos?authMode=viva",
    failUrl: "https://padlhub.ru/padel_torneos?authMode=viva", ...overrides } })[0];
const response = (msg, payload, statusCode = 200, extra = {}) => call({ ...msg, payload, statusCode, responseUrl: msg.url, ...extra });
const found = (source, overrides) => response(start(source, overrides), identity)[1];
const resolveExercise = (source, overrides) => call({ ...found(source, overrides), payload: [] })[0];
function admission(source, row = offer, overrides) {
  const exerciseResult = response(resolveExercise(source, overrides), target)[0];
  if (source === "client-one-time") return exerciseResult;
  assert.match(exerciseResult.url, source === "subscription" ? /products\/subscriptions\?exerciseId=/ : /products\/one-times\?exerciseId=/);
  return response(exerciseResult, { content: [row], totalElements: 1, last: true })[0];
}
const acquiring = (source, product, extras) => response(admission(source, product, extras), allowed)[1];
const insert = (source, product, extras) => call({ ...acquiring(source, product, extras), payload: [] })[2];
const updateAck = { acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedCount: 0, upsertedId: null };
const ackInsert = (msg) => call({ ...msg, payload: { acknowledged: true, insertedId: msg.payload[0]._id } })[0];

for (const source of ["one-time", "client-one-time", "subscription"]) {
  test(source + " reconstructs the Viva v2 WIDGET payload from authenticated reads", () => {
    const composite = { ...offer, productType: "SUBSCRIPTION", subscriptionId: "offer-subscription-id",
      clientSubscriptionId: "catalog-client-subscription-id" };
    const reserved = insert(source, source === "subscription" ? composite : offer, {
      clientPhone: "attacker", studioId: "wrong-studio", discountAmount: 111, price: 0,
      products: [{ id: "wrong-product", discountAmount: 100000 }], levelLabel: "A", bypassLevelCheck: true,
    });
    assert.equal(reserved.payload[0].owner.admission.ruleVersion, "rule-1");
    assert.deepEqual(reserved.payload[1], { writeConcern: { w: "majority", j: true } });
    const post = ackInsert(reserved);
    assert.equal(post.url, "https://api.vivacrm.ru/end-user/api/v2/iSkq6G/transactions");
    assert.equal(post.method, "POST");
    const successUrl = "https://padlhub.ru/padel_torneos?authMode=viva&TorneosPADL_exercise=exercise-fixture&TorneosPADL_paymentsuccess=true";
    const failUrl = "https://padlhub.ru/padel_torneos?authMode=viva&TorneosPADL_exercise=exercise-fixture&TorneosPADL_paymentfailed=true";
    assert.deepEqual(post.payload, {
      products: [{ id: offer.id, name: offer.name, type: source === "subscription" ? "SUBSCRIPTION" : "SERVICE", count: 1,
        bookingRequests: [{ exerciseId: exercise, client: null, comment: null, marketingAttribution: {} }],
        ...(source === "subscription" ? { clientSubscriptionId: composite.clientSubscriptionId, subscriptionId: composite.subscriptionId } : {}) }],
      clientPhone: "72025550135", paymentMethod: "WIDGET", exerciseId: exercise, studioId: "studio-1", promoCode: "SYNTHETIC",
      successUrl, baseRedirectUrl: successUrl, redirectUrl: successUrl, returnUrl: successUrl, successRedirectUrl: successUrl,
      failUrl, failRedirectUrl: failUrl, failureRedirectUrl: failUrl,
    });
  });
}

test("CUP denial, transport failure, stale identity and switched rule fail before reservation", () => {
  const cases = [
    [{ ...allowed, allowed: false, reasonCode: "LEVEL_NOT_ALLOWED" }, 200, {}, "LEVEL_NOT_ALLOWED"],
    [{ ...allowed, exerciseId: "other-target" }, 200, {}, "TOURNAMENT_LEVEL_CHECK_UNAVAILABLE"],
    [{ ...allowed, actorClientId: "other-actor" }, 200, {}, "TOURNAMENT_LEVEL_CHECK_UNAVAILABLE"],
    [{ ...allowed, enforced: false }, 200, {}, "TOURNAMENT_LEVEL_CHECK_UNAVAILABLE"],
    [allowed, 200, { responseUrl: "https://example.invalid" }, "TOURNAMENT_LEVEL_CHECK_UNAVAILABLE"],
    [{ code: "TOURNAMENT_RULE_CHANGED" }, 409, {}, "TOURNAMENT_RULE_CHANGED"],
  ];
  for (const [body, status, extra, code] of cases) {
    const result = response(admission("subscription", { ...offer, productType: "SUBSCRIPTION" }), body, status, extra);
    assert.equal(result.slice(0, 4).some(Boolean), false);
    assert.equal(result[4].payload.code, code);
  }
});

test("unavailable or stale exercise and mismatched catalog product cannot create checkout", () => {
  const expired = { ...target, timeFrom: "2020-01-01T00:00:00Z" };
  for (const row of [expired, { ...target, inBooking: true }, { ...target, id: "other" }]) {
    const result = response(resolveExercise("one-time"), row);
    assert.equal(result[4].statusCode, 409);
  }
  const catalogRead = response(resolveExercise("subscription"), target)[0];
  assert.equal(response(catalogRead, [{ ...offer, id: "different" }])[4].payload.code, "TOURNAMENT_CHECKOUT_PRODUCT_UNAVAILABLE");
});

test("only the insert winner posts; pending results hold; saved transaction replays by exact ID", () => {
  const winner = insert("one-time");
  const loser = insert("one-time");
  assert.equal(winner.payload[0]._id, loser.payload[0]._id);
  assert.equal(call({ ...loser, payload: { acknowledged: false }, error: { code: 11000 } })[4].statusCode, 202);
  const anotherProduct = found("subscription");
  assert.equal(call({ ...anotherProduct, payload: [winner.payload[0]] })[4].payload.code, "TOURNAMENT_ENROLLMENT_HELD");
  const post = ackInsert(winner);
  assert.equal(response(structuredClone(post), {}, 500)[4].statusCode, 202);
  const save = response(post, { transactionId: "tx-1", toPay: 180000 })[3];
  const saved = call({ ...save, payload: updateAck })[4];
  assert.equal(saved.payload.transactionId, "tx-1");
  const read = call({ ...found("one-time"), payload: [{ ...winner.payload[0], transactionId: "tx-1" }] })[0];
  assert.match(read.url, /\/api\/v1\/transactions\/tx-1$/);
  const replay = response(read, {}, 503);
  assert.deepEqual(replay[4].payload, { transactionId: "tx-1" });
  assert.equal(replay.slice(0, 4).some(Boolean), false);
});

const baseGateway = fs.readFileSync(new URL("../nodered_subscription_booking_nodes/fn_subscription_booking_router.js", import.meta.url), "utf8");
// Compose the canonical base router with the production ingress-reclaim anchor.
// A separate local rehearsal uses the fresh installed body when available.
const ingressAnchor = '        state: operation.state, bookingId: { $in: [null, ""] }, upstreamBookingId: { $in: [null, ""] },';
const syntheticGateway = "try {\n" + baseGateway + "\n/* " + ingressAnchor + "\n*/\n} catch (error) { throw error; }";
const gatewaySource = patchTournamentSubscriptionGateway(syntheticGateway.replace('if (ctx.step === "profile") {',
  'if (ctx.step === "test_ready_to_dispatch") return prepareBookingCreate(ctx);\n'
  + 'if (ctx.step === "test_before_provider_failure") return prepareFailedUpdate(ctx, 409, "precheck", "FIXTURE_PRECHECK");\n'
  + 'if (ctx.step === "test_ingress_reclaim") return prepareMongoUpdate(ctx, "lk1_ingress_reclaim", '
  + '{ _id: "mongo-operation-fixture", category: "tournament" }, { $set: { state: "PREPARED" } });\n'
  + 'if (ctx.step === "profile") {'));
const gateway = new Function("msg", "global", "node", "env", gatewaySource);
const gateCall = msg => gateway(msg, store, {}, {});
const context = { step: "operation_find", caller: "http", action: "book", category: "tournament",
  actorClientId: actor, exerciseId: exercise, tenantKey: "iSkq6G", operationId: "operation-fixture",
  operationKey: "mongo-operation-fixture", authHeader: "Bearer synthetic-player", clientSubscriptionId: "sub-fixture" };

test("subscription gate runs before insert or resumed preaccept; other categories remain unchanged", () => {
  const msg = { _subscriptionBooking: { ...context }, payload: [] };
  const askCup = gateCall(msg)[0];
  assert.match(askCup.url, /\/level-decision$/);
  const deny = { ...allowed, allowed: false, reasonCode: "LEVEL_NOT_ALLOWED" };
  assert.equal(gateCall({ ...structuredClone(askCup), statusCode: 200, payload: deny })[4].payload.details.code, "LEVEL_NOT_ALLOWED");
  const lookup = gateCall({ ...askCup, statusCode: 200, payload: allowed })[1];
  const acquire = gateCall({ ...lookup, payload: [] })[1];
  const reservation = gateCall({ ...acquire, payload: [] })[2];
  assert.equal(reservation.payload[0].state, "RESERVED");
  const permitted = gateCall({ ...reservation, payload: mongoInsertAck(reservation) })[2];
  assert.equal(permitted.payload.cupTournamentAdmission.ruleVersion, "rule-1");
  const next = gateCall({ ...permitted, payload: { acknowledged: true, insertedId: context.operationKey } })[3];
  assert.equal(next.payload[1].$set.cupTournamentAdmission.ruleVersion, "rule-1");
  const replay = gateCall({ _subscriptionBooking: { ...context },
    payload: [{ state: "PREPARED", operationId: context.operationId }] })[0];
  assert.match(replay.url, /\/level-decision$/);
  const training = gateCall({ _subscriptionBooking: { ...context, category: "group_training" }, payload: [] });
  assert.equal(training[2].payload.category, "group_training");
  assert.equal(training[0], null);
});

test("graph candidate preserves unrelated node fields and fails on source/router drift", () => {
  const ids = ["find", "insert", "update"].map(kind => "lk_subscription_booking_" + kind + "_20260804");
  const mongo = ["find", "insertOne", "updateOne"].map((operation, index) => ({
    id: ids[index], operation, type: "mongodb4", z: "tab", clientNode: "mongo", collection: "fixture-operations",
    wires: [[SUBSCRIPTION_ROUTER_ID]],
  }));
  const source = [{ id: "tab", type: "tab" }, { id: "mongo", type: "mongodb4-client" }, ...mongo,
    { id: SUBSCRIPTION_ROUTER_ID, type: "function", z: "tab", func: syntheticGateway, outputs: 7,
      wires: [[], ...ids.map(id => [id]), [], [], []], initialize: "// preserve" },
    { id: "other", type: "comment", z: "tab", name: "preserve" }];
  const sha = input => createHash("sha256").update(input).digest("hex");
  const bytes = Buffer.from(JSON.stringify(source));
  const { bytes: output, contract } = composeTournamentCheckoutCandidate(bytes, sha(bytes), sha(syntheticGateway));
  const rows = JSON.parse(output);
  assert.equal(rows.filter(node => node.type === "http in" && node.url === CHECKOUT_ROUTE).length, 1);
  assert.deepEqual(rows.find(node => node.id === "other"), source.at(-1));
  assert.equal(rows.find(node => node.id === SUBSCRIPTION_ROUTER_ID).initialize, "// preserve");
  assert.equal(contract.allowedChanges.length, 1);
  assert.ok(rows.filter(node => node.type === "mongodb4").every(node => node.collection === "fixture-operations"));
  const different = structuredClone(source);
  different.find(node => node.id === ids[2]).collection = "other";
  const differentBytes = Buffer.from(JSON.stringify(different));
  assert.throws(() => composeTournamentCheckoutCandidate(differentBytes, sha(differentBytes), sha(syntheticGateway)),
    /same Mongo collection/);
  assert.throws(() => composeTournamentCheckoutCandidate(bytes, "bad", sha(syntheticGateway)), /source SHA drift/);
  assert.throws(() => composeTournamentCheckoutCandidate(bytes, sha(bytes), "bad"), /topology drift/);
});

const mongoInsertAck = input => ({ acknowledged: true, insertedId: input.payload[0]._id });
function subscriptionAcquiring() {
  const msg = { _subscriptionBooking: { ...context }, payload: [] };
  const cup = gateCall(msg)[0];
  const inspect = gateCall({ ...cup, statusCode: 200, payload: allowed })[1];
  return gateCall({ ...inspect, payload: [] })[1];
}
const subscriptionClaim = () => gateCall({ ...subscriptionAcquiring(), payload: [] })[2];
function subscriptionDispatch(reservation) {
  const claimed = gateCall({ ...reservation, payload: mongoInsertAck(reservation) })[2];
  assert.equal(claimed.payload._id, context.operationKey);
  return gateCall({ _subscriptionBooking: { ...claimed._subscriptionBooking, step: "test_ready_to_dispatch",
    tournamentPreaccepted: true } })[3];
}

test("Viva checkout and an active subscription race before any subscription reservation", () => {
  const paid = insert("one-time");
  const visit = subscriptionClaim();
  assert.equal(paid.payload[0]._id, visit.payload[0]._id);
  assert.equal(visit.payload[0].owner.operationKey, context.operationKey);
  assert.deepEqual(visit.payload[1], paid.payload[1]);
  const lost = { acknowledged: false };
  const refusal = gateCall({ ...structuredClone(visit), payload: lost, error: { code: 11000 } });
  assert.equal(refusal[0], null);
  assert.equal(refusal[2], null, "the loser cannot insert its subscription operation or acquire a daily visit");
  assert.equal(call({ ...structuredClone(paid), payload: lost, error: { code: 11000 } })[0], null);
  assert.equal(ackInsert(paid).method, "POST");
  const actualDispatch = subscriptionDispatch(visit);
  assert.equal(actualDispatch.payload[0].state, "RESERVED");
  assert.deepEqual(actualDispatch.payload[0].$expr, { $gt: [{ $toDate: "$reservedUntil" }, "$$NOW"] });
  assert.equal(actualDispatch.payload[1].$set.state, "HELD");
  const bind = gateCall({ ...actualDispatch, payload: updateAck })[3];
  assert.equal(bind.payload[0].upstreamAttemptedAt, visit.payload[0].owner.attemptedAt);
  assert.equal(bind.payload[0].state, "PENDING_CONFIRMATION");
  assert.equal(bind.payload[1].$set.tournamentEnrollment.generation, 1);
  assert.deepEqual(bind.payload[2], { writeConcern: { w: "majority", j: true } });
  assert.equal(gateCall({ ...structuredClone(bind), payload: { ...updateAck, modifiedCount: 0 } })[0], null);
  const writer = gateCall({ ...bind, payload: updateAck })[0];
  assert.match(writer.url, /\/api\/v2\/exercises\/exercise-fixture\/bookings$/);
  assert.equal(writer.method, "POST");
});

test("ingress reclaim acquires against the verified operation key before ctx.operationKey exists", () => {
  const { operationKey, ...early } = context;
  const request = gateCall({ _subscriptionBooking: { ...early, step: "test_ingress_reclaim" } })[0];
  const inspect = gateCall({ ...request, statusCode: 200, payload: allowed })[1];
  const acquire = gateCall({ ...inspect, payload: [] })[1];
  const reserve = gateCall({ ...acquire, payload: [] })[2];
  assert.equal(reserve.payload[0].owner.operationKey, operationKey);
  const resume = gateCall({ ...reserve, payload: mongoInsertAck(reserve) })[3];
  assert.equal(resume.payload[0]._id, operationKey);
  const wrongTarget = gateCall({ _subscriptionBooking: { ...resume._subscriptionBooking,
    operationKey: "different-operation", step: "test_ready_to_dispatch", tournamentPreaccepted: true } });
  assert.equal(wrongTarget[0], null);
  assert.equal(wrongTarget[3], null);
});

test("only an expired reserved generation can be replaced by time", () => {
  const reservation = subscriptionClaim();
  const held = { ...reservation.payload[0], state: "HELD" };
  const expires = new Date(Date.now() - 10000).toISOString();
  assert.equal(call({ ...acquiring("one-time"), payload: [held] })[3], null);
  const replace = call({ ...acquiring("one-time"), payload: [{ ...reservation.payload[0], reservedUntil: expires }] })[3];
  assert.equal(replace.payload[0].state, "RESERVED");
  assert.deepEqual(replace.payload[0].$expr, { $lte: [{ $toDate: "$reservedUntil" }, "$$NOW"] });
  assert.equal(replace.payload[1].$set.generation, 2);
  const stale = subscriptionDispatch(reservation);
  const ack = { ...updateAck, matchedCount: 0, modifiedCount: 0 };
  assert.equal(gateCall({ ...stale, payload: ack })[0], null);
});

test("pre-dispatch local refusal fences the legacy reservation without requiring a provider stamp", () => {
  const reservation = subscriptionClaim();
  const claimed = gateCall({ ...reservation, payload: mongoInsertAck(reservation) })[2];
  const failure = gateCall({ _subscriptionBooking: { ...claimed._subscriptionBooking, step: "test_before_provider_failure",
    tournamentPreaccepted: true } })[3];
  assert.deepEqual(failure.payload[0].tournamentEnrollment, { $exists: false });
  assert.equal(failure.payload[0].upstreamAttemptedAt, reservation.payload[0].owner.attemptedAt);
  assert.equal(failure.payload[1].$set.tournamentRejection, undefined);
  assert.equal(gateCall({ ...structuredClone(failure), payload: { ...updateAck, matchedCount: 0, modifiedCount: 0 } })[4].statusCode, 202);
  assert.equal(gateCall({ ...failure, payload: updateAck })[4].statusCode, 409);
});

function subscriptionFailure(status) {
  const claim = subscriptionClaim();
  const dispatch = subscriptionDispatch(claim);
  const bind = gateCall({ ...dispatch, payload: updateAck })[3];
  const post = gateCall({ ...bind, payload: updateAck })[0];
  const failure = gateCall({ ...post, statusCode: status, responseUrl: post.url, payload: { message: "fixture refusal" } })[3];
  return { claim: { ...claim.payload[0], state: "HELD" }, failure };
}
function failureOperation(claim, change) {
  return { _id: context.operationKey, operationId: context.operationId, tenantKey: context.tenantKey,
    actorClientId: actor, exerciseId: exercise, category: "tournament",
    tournamentEnrollment: { generation: claim.generation, attemptedAt: claim.owner.attemptedAt }, ...change };
}

test("only a fenced, definite subscription refusal releases its enrollment generation", () => {
  const { claim, failure } = subscriptionFailure(403);
  assert.equal(failure.payload[0]["tournamentEnrollment.generation"], 1);
  const update = failure.payload[1].$set;
  assert.equal(update.tournamentRejection.status, 403);
  const owner = call({ ...found("one-time"), payload: [claim] })[1];
  assert.equal(owner.payload[0]._id, context.operationKey);
  const refused = failureOperation(claim, update);
  for (const stale of [{ ...refused, upstreamBookingId: "accepted-1" },
    { ...refused, tournamentEnrollment: { generation: 2, attemptedAt: claim.owner.attemptedAt } },
    { ...refused, tournamentRejection: undefined },
    { ...refused, managedEntitlementOperationId: "still-held" }]) {
    assert.equal(call({ ...structuredClone(owner), payload: [stale] })[4].payload.code, "TOURNAMENT_ENROLLMENT_HELD");
  }
  const release = call({ ...owner, payload: [refused] })[3];
  assert.equal(release.payload[0].generation, 1);
  assert.equal(release.payload[1].$set.proof.type, "SUBSCRIPTION_REJECTED");
  assert.equal(call({ ...release, payload: updateAck })[4].payload.code, "TOURNAMENT_PREVIOUS_ATTEMPT_CLOSED");
  for (const status of [409, 429]) {
    const uncertain = subscriptionFailure(status).failure;
    assert.equal(uncertain.payload[1].$set.tournamentRejection, undefined);
  }
});

test("a paid checkout can take over an exact subscription cancellation with a returned visit", () => {
  const claim = { ...subscriptionClaim().payload[0], state: "HELD" };
  const before = { left: 2, total: 5, other: "proof", targetPresent: true };
  const at = new Date().toISOString();
  const operation = failureOperation(claim, { state: "RELEASED", releasedAt: at, clientSubscriptionId: context.clientSubscriptionId,
    serviceDate: "2026-11-18", bookingId: "booking-1", releaseBookingId: "booking-1", releasedBookingIds: ["booking-1"],
    releaseReason: "LK1_FREE_VISIT_RETURN_VERIFIED",
    lk1: { fingerprint: "quote", decision: { subscriptionVisitCount: 1, benefit: { finalPriceMinor: 0 } },
      freeCancellationReturn: { schemaVersion: 1, method: "SERVICE", count: 1, verifiedAt: at,
        binding: { actorClientId: actor, exerciseId: exercise, tenantKey: context.tenantKey, operationKey: context.operationKey,
          operationId: context.operationId, clientSubscriptionId: context.clientSubscriptionId, bookingId: "booking-1",
          serviceDate: "2026-11-18", fingerprint: "quote" },
        before, after: { ...before, left: 3, targetPresent: false } } },
  });
  const lookup = call({ ...found("one-time"), payload: [claim] })[1];
  const unsafe = structuredClone(operation);
  unsafe.lk1.freeCancellationReturn.after.left = 2;
  assert.equal(call({ ...structuredClone(lookup), payload: [unsafe] })[4].payload.code, "TOURNAMENT_ENROLLMENT_HELD");
  const release = call({ ...lookup, payload: [operation] })[3];
  assert.equal(release.payload[1].$set.proof.type, "SUBSCRIPTION_VISIT_RETURNED");
});

function terminalCheckout() {
  const createdAt = new Date(Date.now() - 3_600_000).toISOString();
  const held = { ...insert("one-time").payload[0], createdAt, transactionId: "tx-closed" };
  const tx = { id: held.transactionId, clientId: actor, status: "CANCELLED", paymentStatus: "UNPAID", paymentMethod: "WIDGET", createDate: createdAt,
    paymentDueDate: new Date(Date.now() - 2_000_000).toISOString(), processingStatus: null, receiptPending: false,
    possibleDoublePayment: false, deposit: 0, toPay: 240000, purchasedServices: [], receipts: [], executedSurcharges: [],
    paidByOtherSaleBookingIds: [], transactionRefunds: [], paymentLegs: [{ source: "CARD", amountKopecks: 240000 }],
    cardPaymentInfo: { paymentId: "test-card", status: "REJECTED", declineOutcome: "CANCELLED" },
    products: [{ id: offer.id, type: "SERVICE", count: 1, bookingRequests: [{ exerciseId: exercise, bookingId: "booking-1" }] }] };
  const lookup = call({ ...found("one-time"), payload: [held] })[0];
  return { held, tx, lookup };
}

test("checkout cancellation verifies the exact payment and linked cancelled seat before a new click can acquire", () => {
  const { held, tx, lookup } = terminalCheckout();
  for (const invalid of [
    v => { v.status = "PAID"; }, v => { v.status = "UNPAID"; }, v => { v.paidAmount = 1; }, v => { v.id = "other"; },
    v => { v.clientId = "different-owner"; }, v => { v.clientSubscriptionId = "issued"; },
    v => { v.products[0].bookingRequests = []; }, v => { delete v.products[0].bookingRequests[0].bookingId; }, v => { v.cardPaymentInfo.status = "UNPAID"; },
    v => { v.payments = [{ paidAmount: 1 }]; },
  ]) {
    const changed = structuredClone(tx);
    invalid(changed);
    assert.equal(response(structuredClone(lookup), changed)[3], null);
  }
  const bookings = response(lookup, tx)[0];
  assert.match(bookings.url, /showCancelled=true/);
  const booking = { id: "booking-1", clientId: actor, isCancelled: true };
  for (const invalid of [[], [{ ...booking, isCancelled: false }], [{ ...booking, clientId: "other" }],
    [{ ...booking, pendingPayments: [{}] }], [{ ...booking, isPaid: true }],
    [{ ...booking, transactionStatus: { status: "PAID" } }], [{ ...booking, amountDue: "unknown" }],
    [{ ...booking, exerciseId: "different" }], { content: [booking], last: false, totalElements: 2 }]) {
    assert.equal(response(structuredClone(bookings), invalid)[3], null);
  }
  const release = response(bookings, [booking])[3];
  const closed = call({ ...release, payload: updateAck });
  assert.equal(closed[4].payload.code, "TOURNAMENT_PREVIOUS_ATTEMPT_CLOSED");
  assert.equal(closed[0], null);
  const released = { ...held, ...release.payload[1].$set };
  const next = call({ ...acquiring("one-time", offer, { promoCode: "NEW" }), payload: [released] })[3];
  assert.equal(next.payload[0].generation, 1);
  assert.equal(next.payload[0].state, "RELEASED");
  assert.equal(next.payload[1].$set.generation, 2);
  assert.equal(next.payload[1].$set.owner.selection[2], "NEW");
  assert.equal(call({ ...structuredClone(next), payload: { ...updateAck, matchedCount: 0, modifiedCount: 0 } })[0], null);
  assert.equal(call({ ...next, payload: updateAck })[0].method, "POST");
});

const mongoFixtureUri = process.env.GITHUB_ACTIONS === "true"
  ? process.env.COMMUNITY_MONTHLY_TEST_MONGO_URI : process.env.LK_TOURNAMENT_MONGO_FIXTURE;
if (mongoFixtureUri && !/^mongodb:\/\/127\.0\.0\.1:\d{1,5}$/.test(mongoFixtureUri)) {
  throw new Error("Tournament Mongo test requires the disposable loopback fixture");
}
test("Mongo serializes separate clients and fences an expired subscription reservation", {
  skip: mongoFixtureUri ? false : "requires a disposable loopback Mongo fixture",
}, async t => {
  const { MongoClient } = await import("mongodb");
  const { randomUUID } = await import("node:crypto");
  const name = "lk445_tournament_" + randomUUID().replaceAll("-", "");
  const clients = Array.from({ length: 2 }, () => new MongoClient(mongoFixtureUri, { serverSelectionTimeoutMS: 4000 }));
  t.after(async () => {
    try {
      await clients[0].db(name).dropDatabase();
    } finally {
      await Promise.all(clients.map(client => client.close()));
    }
  });
  await Promise.all(clients.map(client => client.connect()));
  const [checkoutOps, subscriptionOps] = clients.map(client => client.db(name).collection("fixture"));
  const paid = insert("one-time");
  const visit = subscriptionClaim();
  const inserted = await Promise.allSettled([checkoutOps.insertOne(...paid.payload), subscriptionOps.insertOne(...visit.payload)]);
  assert.equal(inserted.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(inserted.find(result => result.status === "rejected").reason.code, 11000);
  const id = paid.payload[0]._id;
  assert.equal(await checkoutOps.countDocuments({ _id: id }), 1);
  assert.equal(await subscriptionOps.countDocuments({ _id: context.operationKey }), 0);

  // Exercise real server-time predicates. An expired RESERVED row can be
  // replaced, but its old owner can never commit a Viva dispatch afterward.
  const expired = structuredClone(visit.payload[0]);
  expired.reservedUntil = new Date(Date.now() - 60000).toISOString();
  await subscriptionOps.replaceOne({ _id: id }, expired);
  const staleDispatch = subscriptionDispatch(visit);
  staleDispatch.payload[0].reservedUntil = expired.reservedUntil;
  const next = call({ ...acquiring("one-time"), payload: [expired] })[3];
  const [replacement, stale] = await Promise.all([
    checkoutOps.updateOne(...next.payload),
    subscriptionOps.updateOne(...staleDispatch.payload),
  ]);
  assert.equal(replacement.modifiedCount, 1);
  assert.equal(stale.matchedCount, 0);
  assert.equal(gateCall({ ...staleDispatch, payload: stale })[0], null);
  assert.equal(call({ ...next, payload: replacement })[0].method, "POST");
  const record = await checkoutOps.findOne({ _id: id });
  assert.equal(record.generation, 2);
  assert.equal(record.state, "HELD");
  assert.equal(record.reservedUntil, undefined);
});
