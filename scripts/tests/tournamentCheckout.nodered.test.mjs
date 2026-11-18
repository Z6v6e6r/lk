import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { patchTournamentSubscriptionGateway, tournamentCheckoutSource } from "../lib/tournamentCheckoutSources.mjs";
import { composeTournamentCheckoutCandidate, CHECKOUT_ROUTE, SUBSCRIPTION_ROUTER_ID } from "../prepare_lk1_tournament_checkout_candidate.mjs";

const run = new Function("msg", "global", "node", "env", tournamentCheckoutSource());
const call = msg => run(msg, {}, {}, { get: key => key === "VIVA_TENANT_KEY" ? "tenant-fixture" : undefined });
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
const insert = (source, product, extras) => response(admission(source, product, extras), allowed)[2];
const ackInsert = (msg) => call({ ...msg, payload: { acknowledged: true, insertedId: msg.payload[0]._id } })[0];

for (const source of ["one-time", "client-one-time", "subscription"]) {
  test(source + " reconstructs the Viva v2 WIDGET payload from authenticated reads", () => {
    const composite = { ...offer, productType: "SUBSCRIPTION", subscriptionId: "offer-subscription-id",
      clientSubscriptionId: "catalog-client-subscription-id" };
    const reserved = insert(source, source === "subscription" ? composite : offer, {
      clientPhone: "attacker", studioId: "wrong-studio", discountAmount: 111, price: 0,
      products: [{ id: "wrong-product", discountAmount: 100000 }], levelLabel: "A", bypassLevelCheck: true,
    });
    assert.equal(reserved.payload[0].admission.ruleVersion, "rule-1");
    assert.deepEqual(reserved.payload[1], { writeConcern: { w: "majority", j: true } });
    const post = ackInsert(reserved);
    assert.equal(post.url, "https://api.vivacrm.ru/end-user/api/v2/tenant-fixture/transactions");
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
  const losingRead = call({ ...loser, payload: { acknowledged: false }, error: { code: 11000 } })[1];
  assert.equal(call({ ...losingRead, payload: [winner.payload[0]] })[4].statusCode, 202);
  const anotherProduct = found("subscription");
  assert.equal(call({ ...anotherProduct, payload: [winner.payload[0]] })[4].payload.code, "TOURNAMENT_CHECKOUT_SELECTION_CONFLICT");
  const post = ackInsert(winner);
  assert.equal(response(structuredClone(post), {}, 500)[4].statusCode, 202);
  const save = response(post, { transactionId: "tx-1", toPay: 180000 })[3];
  const saved = call({ ...save, payload: { acknowledged: true, matchedCount: 1, modifiedCount: 1 } })[4];
  assert.equal(saved.payload.transactionId, "tx-1");
  const replay = call({ ...found("one-time"), payload: [{ ...winner.payload[0], state: "CREATED", transactionId: "tx-1" }] });
  assert.deepEqual(replay[4].payload, { transactionId: "tx-1" });
  assert.equal(replay.slice(0, 4).some(Boolean), false);
});

const baseGateway = fs.readFileSync(new URL("../nodered_subscription_booking_nodes/fn_subscription_booking_router.js", import.meta.url), "utf8");
// Compose the canonical base router with the production ingress-reclaim anchor.
// A separate local rehearsal uses the fresh installed body when available.
const ingressAnchor = '        state: operation.state, bookingId: { $in: [null, ""] }, upstreamBookingId: { $in: [null, ""] },';
const syntheticGateway = "try {\n" + baseGateway + "\n/* " + ingressAnchor + "\n*/\n} catch (error) { throw error; }";
const gatewaySource = patchTournamentSubscriptionGateway(syntheticGateway);
const gateway = new Function("msg", "global", "node", "env", gatewaySource);
const gateCall = msg => gateway(msg, { get: () => null }, {}, {});
const context = { step: "operation_find", caller: "http", action: "book", category: "tournament",
  actorClientId: actor, exerciseId: exercise, tenantKey: "tenant-fixture", operationId: "operation-fixture",
  operationKey: "mongo-operation-fixture", authHeader: "Bearer synthetic-player", clientSubscriptionId: "sub-fixture" };

test("subscription gate runs before insert or resumed preaccept; other categories remain unchanged", () => {
  const msg = { _subscriptionBooking: { ...context }, payload: [] };
  const askCup = gateCall(msg)[0];
  assert.match(askCup.url, /\/level-decision$/);
  const deny = { ...allowed, allowed: false, reasonCode: "LEVEL_NOT_ALLOWED" };
  assert.equal(gateCall({ ...structuredClone(askCup), statusCode: 200, payload: deny })[4].payload.details.code, "LEVEL_NOT_ALLOWED");
  const permitted = gateCall({ ...askCup, statusCode: 200, payload: allowed })[2];
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
  const source = [{ id: "tab", type: "tab" },
    { id: "mongo", type: "mongodb4-client" },
    { id: "lk_subscription_booking_find_20260804", type: "mongodb4", z: "tab", clientNode: "mongo", operation: "find",
      wires: [[SUBSCRIPTION_ROUTER_ID]] },
    { id: SUBSCRIPTION_ROUTER_ID, type: "function", z: "tab", func: syntheticGateway, outputs: 7,
      wires: Array.from({ length: 7 }, () => []), initialize: "// preserve" },
    { id: "other", type: "comment", z: "tab", name: "preserve" }];
  const sha = input => createHash("sha256").update(input).digest("hex");
  const bytes = Buffer.from(JSON.stringify(source));
  const { bytes: output, contract } = composeTournamentCheckoutCandidate(bytes, sha(bytes), sha(syntheticGateway));
  const rows = JSON.parse(output);
  assert.equal(rows.filter(node => node.type === "http in" && node.url === CHECKOUT_ROUTE).length, 1);
  assert.deepEqual(rows.find(node => node.id === "other"), source.at(-1));
  assert.equal(rows.find(node => node.id === SUBSCRIPTION_ROUTER_ID).initialize, "// preserve");
  assert.equal(contract.allowedChanges.length, 1);
  assert.throws(() => composeTournamentCheckoutCandidate(bytes, "bad", sha(syntheticGateway)), /source SHA drift/);
  assert.throws(() => composeTournamentCheckoutCandidate(bytes, sha(bytes), "bad"), /topology drift/);
});
