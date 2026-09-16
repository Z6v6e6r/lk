// Focused generation for the plan-product money mandate and the first-use state on the
// direct group-training route.
//
// The live incident: a РА subscription bought 2026-09-16 (status NEW, no activation or
// expiry yet) selecting the 2026-09-29 group training was refused with
// `LK1_MONEY_SUBSCRIPTION_VALIDITY_UNPROVEN` / `observed.stage: "money_evidence"`. The
// product-identity projection rejected every non-HUB product, so the readback never
// produced the proof `lk1Quote` demanded, the deep validity pass had lost the first-use
// relaxation the diagnostics generation split away, and both operation-replay identity
// checks still required the HUB product id, so no plan-product booking could ever be
// polled to confirmation.
//
// These tests pin the reviewed preimages/postimages, the fail-closed preimage gates, the
// agreement between the patched live body and the reviewed sources, the behavioural
// verdict of the installed and the patched body, and the wrapper.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { hubGatewaySource } from "../lib/eventPaymentSources.mjs";
import { patchMoneyCohortBookingBody } from "../patch_live_lk1_money_cohort_hotfix.mjs";
import {
  PLAN_FIRST_USE_BOOKING_ID,
  PLAN_FIRST_USE_DELTAS,
  PLAN_FIRST_USE_SOURCE_NODE_COUNT,
  PLAN_FIRST_USE_SOURCE_SHA256,
  PLAN_FIRST_USE_TARGET,
  composePlanFirstUseArtifacts,
  patchPlanFirstUseBookingBody,
  sha256,
} from "../patch_live_lk1_plan_money_first_use_hotfix.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LIVE_SNAPSHOT = process.env.LK1_MONEY_COHORT_LIVE_SNAPSHOT
  ?? "/private/tmp/lk1-cohort-live/input/source.flow.json";
const snapshotSkip = fs.existsSync(LIVE_SNAPSHOT)
  ? false
  : `live 147 snapshot is absent: ${LIVE_SNAPSHOT} (set LK1_MONEY_COHORT_LIVE_SNAPSHOT)`;

const HUB_PRODUCT = "db7a5250-7369-4f43-8ac5-9111be24bc74";
const RA_PRODUCT = "b91e14d1-fe6e-4d0b-be39-3e45ad86b759";
const FRIENDSHIP_PRODUCT = "b2e6a9d4-53b5-4f79-87ec-3fb076381e9b";
const ACTOR = "83756527-cfbe-4b7f-b143-1a6ac96d2a93";
const SUBSCRIPTION = "54de4878-2e04-4dd3-a1c8-1ecca8e14061";
const EXERCISE = "eec906d7-8b23-47f0-8d9c-5b0a9590f7e0";
const OPERATION = "lk-subscription-fixture";
const ONE_TIME = "p-one-time";
const RULE_FIELDS = { maxActiveBookings: 4, freeGameMinutesPerDay: 60, gameOverageDiscountPercent: 30,
  groupTrainingDiscountPercent: 50, tournamentDiscountPercent: 50 };

// The reviewed preimage of this generation is the INSTALLED flow after `lk1-money-cohort`.
// It is rebuilt from the same pull the money-cohort generation pins, through that
// generation's own reviewed patcher, so the chain cannot drift silently.
function livePreimageBytes() {
  const flow = JSON.parse(fs.readFileSync(LIVE_SNAPSHOT, "utf8"));
  const booking = flow.find((node) => node.id === PLAN_FIRST_USE_BOOKING_ID);
  booking.func = patchMoneyCohortBookingBody(booking.func);
  return Buffer.from(`${JSON.stringify(flow, null, 2)}\n`);
}

function globals() {
  return new Map([
    ["subscriptions_lk1_product_policy", { productId: HUB_PRODUCT, ...RULE_FIELDS }],
    ["subscriptions_lk1_plan_rules", { formatVersion: 1, rules: [
      { productId: RA_PRODUCT, planKey: "ra", enforceFrom: "2026-09-01", ...RULE_FIELDS },
      { productId: FRIENDSHIP_PRODUCT, planKey: "friendship", enforceFrom: "2026-09-01", ...RULE_FIELDS },
      { productId: HUB_PRODUCT, planKey: "hub", enforceFrom: null, ...RULE_FIELDS },
    ] }],
  ]);
}

function subscriptionRow(productId, purchaseDate, rowChanges) {
  return { subscriptionId: SUBSCRIPTION, clientSubscriptionId: SUBSCRIPTION, id: SUBSCRIPTION,
    clientId: ACTOR, subscriptionProductId: productId, productId, product: { id: productId },
    status: "NEW", purchaseDate, purchaseAt: purchaseDate, autoActivationDate: "2026-09-17",
    activationDate: null, expirationDate: null, holdUntil: null, validityDays: 30,
    visitsTotal: 30, visitsLeft: 30, variant: "BY_VISITS", ...rowChanges };
}

function groupExercise(row) {
  return { id: EXERCISE, typeId: 605, directionId: 3685, studioId: "studio-1", roomId: "room-1",
    timeFrom: "2026-09-29T08:00:00+03:00", timeTo: "2026-09-29T09:00:00+03:00",
    availableClientSubscriptions: [row] };
}

function requestContext(productId, name, row, purchaseDate, overrides = {}) {
  return { caller: "http", tenantKey: "iSkq6G", actorClientId: ACTOR, clientSubscriptionId: SUBSCRIPTION,
    operationId: OPERATION, exerciseId: EXERCISE, managedAction: "BOOK_GROUP_TRAINING",
    lk1ProductIdentity: { tenantKey: "iSkq6G", actorClientId: ACTOR, subscriptionId: SUBSCRIPTION,
      productId, name, purchaseDate, subscription: row }, ...overrides };
}

/** Run the real composed booking body once and return the messages it emitted. */
function execBody(body, msg) {
  const store = globals();
  const global = { get: (key) => store.get(key), set: (key, value) => store.set(key, value) };
  const node = { send: () => {}, warn: () => {}, error: () => {}, status: () => {}, log: () => {} };
  const result = new Function("msg", "node", "global", "env", "context", "flow", "RED", body)(
    msg, node, global, { get: () => undefined }, {}, {}, {});
  return Array.isArray(result) ? result.flat(3).filter(Boolean) : [];
}

const summarize = (messages) => messages.map((message) => ({
  step: message._subscriptionBooking?.step,
  statusCode: message.statusCode,
  code: message.payload?.details?.code,
  observed: message.payload?.details?.observed,
  method: message.method,
}));

/** Drive the direct group-training money step with one owned row. */
function runMoneyStep(body, { productId, name, purchaseDate = "2026-09-16T07:26:17.599551", rowChanges = {} }) {
  const row = subscriptionRow(productId, purchaseDate, rowChanges);
  const ctx = requestContext(productId, name, row, purchaseDate, {
    step: "lk1_money_owned_subscriptions", lk1MoneyExercise: groupExercise(row),
    lk1MoneyReturnStep: "exercise" });
  const sent = execBody(body, { payload: { content: [row], totalElements: 1, number: 0, last: true },
    statusCode: 200, _subscriptionBooking: ctx });
  return { ownership: ctx.lk1MoneyOwnership ? "SET" : "ABSENT", phase: ctx.lk1MoneyReadbackPhase,
    sent: summarize(sent) };
}

/**
 * Money readback, then the event-tariff read the fixed flow now reaches, then the stored
 * operation lookup. Returns the priced quote the flow persisted in its context.
 */
function capturePricedQuote(body, productId, name) {
  const row = subscriptionRow(productId, "2026-09-16T07:26:17.599551", {});
  const exercise = groupExercise(row);
  const ctx = requestContext(productId, name, row, row.purchaseDate, {
    step: "lk1_money_owned_subscriptions", lk1MoneyExercise: exercise, lk1MoneyReturnStep: "exercise" });
  execBody(body, { payload: { content: [row], totalElements: 1, number: 0, last: true }, statusCode: 200,
    _subscriptionBooking: ctx });
  const tariffUrl = `https://api.vivacrm.ru/end-user/api/v2/iSkq6G/products/one-times?exerciseId=${EXERCISE}`;
  const tariff = execBody(body, { payload: { content: [{ id: ONE_TIME, productId: ONE_TIME,
    exerciseId: EXERCISE, cost: 550000, productType: "ONE_TIME" }], totalElements: 1, last: true },
    statusCode: 200, method: "GET", url: tariffUrl, responseUrl: tariffUrl, _subscriptionBooking: ctx });
  execBody(body, { payload: [], statusCode: 200, _subscriptionBooking: ctx });
  return { ctx, quote: ctx.lk1, tariff: summarize(tariff) };
}

/** Replay a stored, not-yet-confirmed operation through the ingress identity check. */
function replayStoredOperation(body, productId, name, quote) {
  const operation = { _id: `lk1-product:${JSON.stringify(["iSkq6G", ACTOR, OPERATION])}`,
    tenantKey: "iSkq6G", actorClientId: ACTOR, clientSubscriptionId: SUBSCRIPTION, operationId: OPERATION,
    exerciseId: EXERCISE, serviceDate: "2026-09-29", category: "group_training",
    state: "PENDING_CONFIRMATION", attempts: 1,
    lk1: { ...quote, decision: { eligible: true, subscriptionVisitCount: 0,
      benefit: { finalPriceMinor: 275000, kind: "PERCENT_DISCOUNT" } } } };
  const ctx = requestContext(productId, name, subscriptionRow(productId, quote.purchaseDate, {}),
    quote.purchaseDate, { step: "lk1_ingress_operation_find", lk1IngressReplay: true });
  return summarize(execBody(body, { payload: [operation], statusCode: 200, _subscriptionBooking: ctx }));
}

test("the generation pins the installed flow and one node field", () => {
  assert.equal(PLAN_FIRST_USE_SOURCE_NODE_COUNT, 4804);
  assert.equal(PLAN_FIRST_USE_SOURCE_SHA256,
    "ccb9eabb9f3bbf4f7013e3cea3bb39677b1e05825c8647614c3efc10eba77b4c");
  assert.equal(PLAN_FIRST_USE_BOOKING_ID, "lk_subscription_booking_router_20260804");
  assert.equal(PLAN_FIRST_USE_TARGET.liveFuncSha256,
    "967185637bf9c5e4d5e44df899edac86ff431f2f1b719d80bbdceee5fd41f19c");
  assert.notEqual(PLAN_FIRST_USE_TARGET.liveFuncSha256, PLAN_FIRST_USE_TARGET.patchedFuncSha256);
  assert.equal(PLAN_FIRST_USE_DELTAS.length, 4);
  for (const delta of PLAN_FIRST_USE_DELTAS) assert.ok(delta.before && delta.after, delta.id);
});

test("the reviewed sources carry the reviewed deltas verbatim", () => {
  const reviewedProduct = fs.readFileSync(
    path.join(repoRoot, "scripts/nodered_subscription_product_nodes/gateway.js"), "utf8");
  const reviewedHub = fs.readFileSync(path.join(repoRoot, "scripts/nodered_lk1_hub_nodes/gateway.js"), "utf8");
  assert.ok(reviewedProduct.includes(PLAN_FIRST_USE_DELTAS[0].after), "product identity projection drift");
  assert.ok(reviewedHub.includes(PLAN_FIRST_USE_DELTAS[1].after), "first-use lifecycle guards drift");
  // The live body is reformatted (four-space operands), so the helper delta is compared by
  // its reviewed fragment rather than by the live indentation.
  assert.ok(reviewedHub.includes("|| !isObj(quote) || !isObj(quote.rule) || !isObj(quote.target)"),
    "replay identity helper drift");
  // The reviewed hub source cannot depend on the production `preflightAvailability` library:
  // it names the first-use state directly and documents that it is the same verdict.
  assert.equal(hubGatewaySource().includes("preflightAvailability"), false);
  assert.ok(reviewedHub.includes('const firstUse = String(subscription?.status || "").trim().toUpperCase() === "NEW"'));
  // Neither reviewed layer may re-introduce a HUB-only contour: the mandate and the replay
  // identity both follow the resolver / the stored fingerprint.
  assert.equal(reviewedProduct.includes("if (normalizeId(p.productId) !== LK1_OVERLAY_HUB_PRODUCT_ID) return [];"), false);
  assert.equal(reviewedHub.includes("quote.rule?.productId !== LK1_OVERLAY_HUB_PRODUCT_ID"), false);
});

test("the deltas apply and revert on the installed flow only", { skip: snapshotSkip }, () => {
  const bytes = livePreimageBytes();
  assert.equal(sha256(bytes), PLAN_FIRST_USE_SOURCE_SHA256, "money-cohort postimage drift");
  const flow = JSON.parse(bytes.toString("utf8"));
  const body = flow.find((node) => node.id === PLAN_FIRST_USE_BOOKING_ID).func;
  const patched = patchPlanFirstUseBookingBody(body);
  assert.equal(sha256(patched), PLAN_FIRST_USE_TARGET.patchedFuncSha256);
  let reverted = patched;
  for (const delta of [...PLAN_FIRST_USE_DELTAS].reverse()) reverted = reverted.replace(delta.after, () => delta.before);
  assert.equal(reverted, body);
  // The plan cohort is judged by the resolver, the first-use state is honoured, and both
  // replay checks are contour-bound; hold/freeze and a failed row identity still refuse.
  assert.equal(patched.includes("const configured = lk1Config(projected);"), true);
  assert.equal(patched.includes("if ((!firstUse && row.status !== 'ACTIVE')"), true);
  assert.equal(patched.includes("    if (!firstUse) {"), true);
  assert.equal(patched.includes('violations.push("expiry_before_target_end");'), true);
  assert.equal(patched.includes("if (normalizeId(p.productId) !== LK1_OVERLAY_HUB_PRODUCT_ID) return [];"), false);
  assert.equal(patched.includes("quote.rule?.productId !== LK1_OVERLAY_HUB_PRODUCT_ID"), false);
  assert.equal((patched.split("\n    || !isObj(quote) || !isObj(quote.rule) || !isObj(quote.target)\n").length - 1), 1);
  assert.equal((patched.split("\n      || !isObj(quote) || !isObj(quote.rule) || !isObj(quote.target)\n").length - 1), 1);
});

test("the generation refuses any flow that is not the installed one", () => {
  const flow = [{ id: "x", type: "function", func: "", initialize: "", outputs: 1, wires: [[]] }];
  assert.throws(() => composePlanFirstUseArtifacts(flow, "probe"), /Live flow preimage drift/);
  if (snapshotSkip) return;
  const drifted = JSON.parse(livePreimageBytes().toString("utf8"));
  drifted.find((node) => node.id === PLAN_FIRST_USE_BOOKING_ID).func += "\n// drift";
  assert.throws(() => composePlanFirstUseArtifacts(Buffer.from(`${JSON.stringify(drifted, null, 2)}\n`), "probe"),
    /Live flow preimage drift/);
});

test("the generation composes exactly the reviewed postimage", { skip: snapshotSkip }, () => {
  const bytes = livePreimageBytes();
  const built = composePlanFirstUseArtifacts(bytes, "lk1-plan-money-first-use");
  assert.equal(built.changes.length, 1);
  assert.equal(built.changes[0].id, PLAN_FIRST_USE_BOOKING_ID);
  assert.deepEqual(built.changes[0].fields, ["func"]);
  assert.equal(built.changes[0].func.afterSha256, PLAN_FIRST_USE_TARGET.patchedFuncSha256);
  assert.equal(built.addedNodeCount, 0);
  assert.equal(built.booking.otherFieldsUnchanged, true);
  assert.equal(built.booking.planProjectionResolverBound, true);
  assert.equal(built.booking.firstUseGuarded, true);
  assert.equal(built.booking.replayContourBound, true);
  assert.equal(built.contract.allowedChanges.length, 1);
  assert.equal((built.contract.allowedAdditions ?? []).length, 0);
  const candidate = JSON.parse(built.candidateBytes.toString("utf8"));
  const live = JSON.parse(bytes.toString("utf8"));
  const differing = candidate.filter((node, index) => JSON.stringify(node) !== JSON.stringify(live[index]));
  assert.deepEqual(differing.map((node) => node.id), [PLAN_FIRST_USE_BOOKING_ID]);
});

test("the installed body refuses the live РА first-use booking and the patched body proves it",
  { skip: snapshotSkip }, () => {
    const bytes = livePreimageBytes();
    const installed = JSON.parse(bytes.toString("utf8")).find((node) => node.id === PLAN_FIRST_USE_BOOKING_ID).func;
    const patched = composePlanFirstUseArtifacts(bytes, "lk1-plan-money-first-use")
      .flow.find((node) => node.id === PLAN_FIRST_USE_BOOKING_ID).func;
    const ra = { productId: RA_PRODUCT, name: "РА" };

    // The exact production refusal: no product proof, so the quote stops with the bare
    // money-evidence verdict although the selected instance is the enforced one.
    const before = runMoneyStep(installed, ra);
    assert.equal(before.ownership, "ABSENT");
    assert.equal(before.sent.length, 1);
    assert.equal(before.sent[0].code, "LK1_MONEY_SUBSCRIPTION_VALIDITY_UNPROVEN");
    // The serialized body is byte-for-byte the production refusal, including the absent
    // `evidencePresent` (the unset ownership makes it `undefined`, which JSON drops).
    assert.deepEqual(JSON.parse(JSON.stringify(before.sent[0].observed)),
      { stage: "money_evidence", readbackPhase: "exercise", selectedOwned: 1, eventCategory: "group_training" });

    // After the fix the readback proves the instance and the flow advances to the event
    // tariff read, which is the next step of the managed quote.
    for (const plan of [ra, { productId: FRIENDSHIP_PRODUCT, name: "Дружба" }]) {
      const after = runMoneyStep(patched, plan);
      assert.equal(after.ownership, "SET", plan.name);
      assert.equal(after.phase, "exercise", plan.name);
      assert.deepEqual(after.sent.map((message) => message.step), ["lk1_event_tariff"], plan.name);
    }

    // Same for the annual HUB first-use instance the lost guard used to refuse.
    const hubAfter = runMoneyStep(patched, { productId: HUB_PRODUCT, name: "ХАБ" });
    assert.equal(hubAfter.ownership, "SET");
    assert.deepEqual(hubAfter.sent.map((message) => message.step), ["lk1_event_tariff"]);

    // Nothing else moves: a held first-use instance, an unusable instance and a legacy or
    // unrecognised product keep their previous verdicts.
    const hold = runMoneyStep(patched, { ...ra, rowChanges: { holdUntil: "2026-10-01" } });
    assert.equal(hold.ownership, "ABSENT");
    assert.equal(hold.sent[0].code, "LK1_MONEY_SUBSCRIPTION_VALIDITY_UNPROVEN");
    assert.deepEqual(hold.sent[0].observed.violations, ["hold"]);
    const refunded = runMoneyStep(patched, { ...ra, rowChanges: { status: "REFUNDED" } });
    assert.equal(refunded.ownership, "ABSENT");
    assert.equal(refunded.sent[0].observed.stage, "money_evidence");
    const legacy = runMoneyStep(patched, { ...ra, purchaseDate: "2026-08-15T07:26:17.599551" });
    assert.equal(legacy.ownership, "ABSENT");
    assert.equal(legacy.sent.some((message) => message.code === "LK1_MONEY_SUBSCRIPTION_VALIDITY_UNPROVEN"), false);
    const unknown = runMoneyStep(patched, { productId: "5a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d", name: "Иное" });
    assert.equal(unknown.ownership, "ABSENT");
    assert.equal(unknown.sent.some((message) => message.code === "LK1_MONEY_SUBSCRIPTION_VALIDITY_UNPROVEN"), false);
  });

test("a stored plan-product operation replays instead of being refused on identity",
  { skip: snapshotSkip }, () => {
    const bytes = livePreimageBytes();
    const installed = JSON.parse(bytes.toString("utf8")).find((node) => node.id === PLAN_FIRST_USE_BOOKING_ID).func;
    const patched = composePlanFirstUseArtifacts(bytes, "lk1-plan-money-first-use")
      .flow.find((node) => node.id === PLAN_FIRST_USE_BOOKING_ID).func;

    // The installed body cannot even price a plan product, so the replay is built on the
    // patched body: the quote must exist before an operation can be stored for it.
    const ra = capturePricedQuote(patched, RA_PRODUCT, "РА");
    assert.ok(ra.quote?.fingerprint, "the plan-product quote must be priced");
    const hub = capturePricedQuote(patched, HUB_PRODUCT, "ХАБ");
    assert.ok(hub.quote?.fingerprint, "the HUB quote must be priced");

    // The client polls the same deterministic operationId until the gateway reports the
    // confirmed booking; the HUB replay reaches the pending-replay path, and the plan
    // product must reach the same path instead of `LK1_REQUEST_IDENTITY_CHANGED`.
    const hubReplay = replayStoredOperation(patched, HUB_PRODUCT, "ХАБ", hub.quote);
    assert.equal(hubReplay[0].code, "LK1_BOOKING_OUTCOME_UNRESOLVED", JSON.stringify(hubReplay));
    const raReplay = replayStoredOperation(patched, RA_PRODUCT, "РА", ra.quote);
    assert.equal(raReplay[0].code, "LK1_BOOKING_OUTCOME_UNRESOLVED", JSON.stringify(raReplay));
    // The installed body keeps refusing it: the leftover HUB equality is what this pins.
    const installedReplay = replayStoredOperation(installed, RA_PRODUCT, "РА", ra.quote);
    assert.equal(installedReplay[0].code, "LK1_REQUEST_IDENTITY_CHANGED", JSON.stringify(installedReplay));
  });

test("the deploy wrapper keeps the confirmation gate, the exact allowance and rollback", () => {
  const wrapper = fs.readFileSync(
    path.join(repoRoot, "scripts/deploy_nodered_lk1_plan_money_first_use_hotfix_147.sh"), "utf8");
  assert.ok(wrapper.includes('NODE_RED_LK1_PLAN_MONEY_FIRST_USE_DEPLOY:-}" != "CONFIRM_147"'));
  assert.ok(wrapper.includes(`allow_nodes=(${PLAN_FIRST_USE_BOOKING_ID})`));
  assert.ok(wrapper.includes(`"${PLAN_FIRST_USE_BOOKING_ID}:func"`));
  assert.ok(wrapper.includes("expected_changed_nodes=1"));
  assert.ok(wrapper.includes("patch_live_lk1_plan_money_first_use_hotfix.mjs"));
  assert.ok(wrapper.includes("prepare_exact_graph_contract.mjs"));
  assert.equal(wrapper.includes("nodered_reviewed_flow_deploy/prepare_contract.mjs"), false);
  assert.ok(wrapper.includes("value.booking?.planProjectionResolverBound !== true"));
  assert.ok(wrapper.includes("value.booking?.firstUseGuarded !== true"));
  assert.ok(wrapper.includes("value.booking?.replayContourBound !== true"));
  assert.ok(wrapper.includes("rollback --deployment-id"));
  assert.ok(wrapper.includes("sha256sum"));
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(pkg.scripts["nodered:lk1-plan-money-first-use:deploy-147"],
    "bash scripts/deploy_nodered_lk1_plan_money_first_use_hotfix_147.sh");
});
