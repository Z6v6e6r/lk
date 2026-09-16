// Focused generation for the free-first-event rule (owner decision 2026-09-16) and the
// sale-date fix the discounted checkout needs.
//
// For РА and Академия the first event of the subscription's local service day in the covered
// categories is carried by the plan itself — one visit, nothing charged — and every later
// event that day, or any event once the visits are used up, keeps the configured discount.
// Covered: РА — group training (including «Игра+Тренер») and tournaments; Академия — group
// training only. The tests pin the installed preimages, the fail-closed anchors, the
// three-node composition and the end-to-end verdict of gateway + evaluator.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { patchMoneyCohortBookingBody } from "../patch_live_lk1_money_cohort_hotfix.mjs";
import { PLAN_FIRST_USE_DELTAS } from "../patch_live_lk1_plan_money_first_use_hotfix.mjs";
import {
  FREE_FIRST_EVENT_BOOKING_DELTAS,
  FREE_FIRST_EVENT_BOOKING_ID,
  FREE_FIRST_EVENT_EVALUATOR_DELTAS,
  FREE_FIRST_EVENT_EVALUATOR_IDS,
  FREE_FIRST_EVENT_SOURCE_NODE_COUNT,
  FREE_FIRST_EVENT_SOURCE_SHA256,
  FREE_FIRST_EVENT_TARGET,
  composeFreeFirstEventArtifacts,
  patchFreeFirstEventBookingBody,
  patchFreeFirstEventEvaluatorBody,
  sha256,
} from "../patch_live_lk1_free_first_event_hotfix.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LIVE_SNAPSHOT = process.env.LK1_MONEY_COHORT_LIVE_SNAPSHOT
  ?? "/private/tmp/lk1-cohort-live/input/source.flow.json";
const snapshotSkip = fs.existsSync(LIVE_SNAPSHOT)
  ? false
  : `live 147 snapshot is absent: ${LIVE_SNAPSHOT} (set LK1_MONEY_COHORT_LIVE_SNAPSHOT)`;

const HUB_PRODUCT = "db7a5250-7369-4f43-8ac5-9111be24bc74";
const RA_PRODUCT = "b91e14d1-fe6e-4d0b-be39-3e45ad86b759";
const ACADEMY_PRODUCT = "9eb8a7a4-c195-492a-95e4-3fb82899ac10";
const FRIENDSHIP_PRODUCT = "b2e6a9d4-53b5-4f79-87ec-3fb076381e9b";
const ACTOR = "83756527-cfbe-4b7f-b143-1a6ac96d2a93";
const SUBSCRIPTION = "54de4878-2e04-4dd3-a1c8-1ecca8e14061";
const EXERCISE = "eec906d7-8b23-47f0-8d9c-5b0a9590f7e0";
const RULE_FIELDS = { maxActiveBookings: 4, freeGameMinutesPerDay: 60, gameOverageDiscountPercent: 30,
  groupTrainingDiscountPercent: 50, tournamentDiscountPercent: 50 };

/** The installed flow: the reviewed money-cohort postimage plus the four deployed deltas. */
function installedFlowBytes() {
  const flow = JSON.parse(fs.readFileSync(LIVE_SNAPSHOT, "utf8"));
  const booking = flow.find((node) => node.id === FREE_FIRST_EVENT_BOOKING_ID);
  booking.func = patchMoneyCohortBookingBody(booking.func);
  for (const delta of PLAN_FIRST_USE_DELTAS.slice(0, 4)) {
    const occurrences = booking.func.split(delta.before).length - 1;
    assert.equal(occurrences, 1, `installed generation anchor drift for ${delta.id}`);
    booking.func = booking.func.replace(delta.before, () => delta.after);
  }
  return Buffer.from(`${JSON.stringify(flow, null, 2)}\n`);
}

function globals() {
  return new Map([
    ["subscriptions_lk1_product_policy", { productId: HUB_PRODUCT, ...RULE_FIELDS }],
    ["subscriptions_lk1_plan_rules", { formatVersion: 1, rules: [
      { productId: RA_PRODUCT, planKey: "ra", enforceFrom: "2026-09-01", ...RULE_FIELDS },
      { productId: ACADEMY_PRODUCT, planKey: "academy", enforceFrom: "2026-09-01", ...RULE_FIELDS },
      { productId: FRIENDSHIP_PRODUCT, planKey: "friendship", enforceFrom: "2026-09-01", ...RULE_FIELDS },
      { productId: HUB_PRODUCT, planKey: "hub", enforceFrom: null, ...RULE_FIELDS },
    ] }],
  ]);
}

function execBody(body, msg) {
  const store = globals();
  const global = { get: (key) => store.get(key), set: (key, value) => store.set(key, value) };
  const node = { send: () => {}, warn: () => {}, error: () => {}, status: () => {}, log: () => {} };
  const result = new Function("msg", "node", "global", "env", "context", "flow", "RED", body)(
    msg, node, global, { get: () => undefined }, {}, {}, {});
  return Array.isArray(result) ? result.flat(3).filter(Boolean) : [];
}

function subscriptionRow(productId, changes = {}) {
  return { subscriptionId: SUBSCRIPTION, clientSubscriptionId: SUBSCRIPTION, id: SUBSCRIPTION,
    clientId: ACTOR, subscriptionProductId: productId, productId, product: { id: productId },
    status: "NEW", purchaseDate: "2026-09-16T07:26:17.599551", purchaseAt: "2026-09-16T07:26:17.599551",
    autoActivationDate: "2026-09-17", activationDate: null, expirationDate: null, holdUntil: null,
    validityDays: 30, visitsTotal: 30, visitsLeft: 30, variant: "BY_VISITS", ...changes };
}

/** Drive the booking gateway to the managed policy input for one event category. */
function capturePolicyInput(bookingBody, productId, { typeId = 605, rowChanges = {}, operations = [] } = {}) {
  const row = subscriptionRow(productId, rowChanges);
  const exercise = { id: EXERCISE, typeId, directionId: 3685, studioId: "studio-1", roomId: "room-1",
    timeFrom: "2026-09-29T08:00:00+03:00", timeTo: "2026-09-29T09:00:00+03:00",
    availableClientSubscriptions: [row] };
  const ctx = { caller: "http", tenantKey: "iSkq6G", actorClientId: ACTOR, clientSubscriptionId: SUBSCRIPTION,
    operationId: "lk-subscription-fixture", exerciseId: EXERCISE,
    managedAction: typeId === 839 ? "BOOK_TOURNAMENT" : "BOOK_GROUP_TRAINING",
    step: "lk1_money_owned_subscriptions", lk1MoneyExercise: exercise, lk1MoneyReturnStep: "exercise",
    lk1ProductIdentity: { tenantKey: "iSkq6G", actorClientId: ACTOR, subscriptionId: SUBSCRIPTION,
      productId, name: "fixture", purchaseDate: row.purchaseDate, subscription: row } };
  execBody(bookingBody, { payload: { content: [row], totalElements: 1, number: 0, last: true },
    statusCode: 200, _subscriptionBooking: ctx });
  const tariffUrl = `https://api.vivacrm.ru/end-user/api/v2/iSkq6G/products/one-times?exerciseId=${EXERCISE}`;
  execBody(bookingBody, { payload: { content: [{ id: "p-one-time", productId: "p-one-time",
    exerciseId: EXERCISE, cost: 550000, productType: "ONE_TIME" }], totalElements: 1, last: true },
    statusCode: 200, method: "GET", url: tariffUrl, responseUrl: tariffUrl, _subscriptionBooking: ctx });
  execBody(bookingBody, { payload: [], statusCode: 200, _subscriptionBooking: ctx });
  execBody(bookingBody, { payload: { content: [], totalElements: 0, number: 0, last: true }, statusCode: 200,
    _subscriptionBooking: ctx });
  execBody(bookingBody, { payload: { content: [], totalElements: 0, number: 0, last: true }, statusCode: 200,
    _subscriptionBooking: ctx });
  const out = execBody(bookingBody, { payload: operations, statusCode: 200, _subscriptionBooking: ctx });
  return out.map((message) => message._managedSubscriptionPolicyInput).find(Boolean) || null;
}

function decide(evaluatorBody, input) {
  const outputs = new Function("msg", evaluatorBody)({ _managedSubscriptionPolicyInput: structuredClone(input) });
  const routed = outputs[0] || outputs[1];
  return routed?._managedSubscriptionPolicyDecision || null;
}

function verdict(bookingBody, evaluatorBody, productId, options = {}) {
  const input = capturePolicyInput(bookingBody, productId, options);
  if (!input) return { input: null };
  return { input, decision: decide(evaluatorBody, input) };
}

test("the generation pins the installed flow and its three nodes", () => {
  assert.equal(FREE_FIRST_EVENT_SOURCE_NODE_COUNT, 4804);
  assert.equal(FREE_FIRST_EVENT_SOURCE_SHA256,
    "a20697fbd9a268d431a7954ca19c173af45d4408502c22e36fcb4496ea9f6985");
  assert.equal(FREE_FIRST_EVENT_BOOKING_ID, "lk_subscription_booking_router_20260804");
  assert.deepEqual([...FREE_FIRST_EVENT_EVALUATOR_IDS],
    ["lk_subscription_managed_policy_20260820", "lk_subscription_price_preview_20260908_evaluate"]);
  assert.equal(FREE_FIRST_EVENT_TARGET.liveBookingFuncSha256,
    "17ec2cac9ad30bb01aab67363349c498f6439fa9d7f4766a5acfdcd5964a429f");
  assert.equal(FREE_FIRST_EVENT_TARGET.liveEvaluatorFuncSha256,
    "d410acdba09996926869373c4836cc9ff3676f1cbb5bf074449a47ed3bc3b1ed");
  assert.notEqual(FREE_FIRST_EVENT_TARGET.liveBookingFuncSha256, FREE_FIRST_EVENT_TARGET.patchedBookingFuncSha256);
  assert.notEqual(FREE_FIRST_EVENT_TARGET.liveEvaluatorFuncSha256, FREE_FIRST_EVENT_TARGET.patchedEvaluatorFuncSha256);
  assert.equal(FREE_FIRST_EVENT_BOOKING_DELTAS.length, 8);
  assert.equal(FREE_FIRST_EVENT_EVALUATOR_DELTAS.length, 1);
});

test("the reviewed sources carry the reviewed deltas verbatim", () => {
  const reviewedHub = fs.readFileSync(path.join(repoRoot, "scripts/nodered_lk1_hub_nodes/gateway.js"), "utf8");
  const reviewedEvaluator = fs.readFileSync(path.join(repoRoot, "scripts/nodered_lk1_hub_nodes/evaluator.js"), "utf8");
  for (const delta of FREE_FIRST_EVENT_BOOKING_DELTAS) {
    if (delta.id === "free-first-event-cohort") {
      // The reviewed cohort table has since gained the promo products, so this delta is
      // compared by its reviewed roots instead of by the full historical text.
      assert.ok(reviewedHub.includes('"b91e14d1-fe6e-4d0b-be39-3e45ad86b759": Object.freeze(["group_training", "tournament"]),'));
      assert.ok(reviewedHub.includes('"9eb8a7a4-c195-492a-95e4-3fb82899ac10": Object.freeze(["group_training"]),'));
      continue;
    }
    if (delta.id === "free-first-event-policy-input") {
      // The installed body carries the policy input in its reformatted shape, so this delta
      // is compared by its reviewed fragment instead of by the live indentation.
      assert.ok(reviewedHub.includes("freeFirstEvent: freeFirstCovered"));
      assert.ok(reviewedHub.includes("? { covered: true, usedEventsToday: freeFirstEventsToday, visitsLeft: freeFirstVisitsLeft }"));
      continue;
    }
    assert.ok(reviewedHub.includes(delta.after), `reviewed gateway drift for ${delta.id}`);
  }
  for (const delta of FREE_FIRST_EVENT_EVALUATOR_DELTAS) {
    assert.ok(reviewedEvaluator.includes(delta.after), `reviewed evaluator drift for ${delta.id}`);
  }
});

test("the deltas apply and revert on the installed bodies only", { skip: snapshotSkip }, () => {
  const bytes = installedFlowBytes();
  assert.equal(sha256(bytes), FREE_FIRST_EVENT_SOURCE_SHA256, "installed flow drift");
  const flow = JSON.parse(bytes.toString("utf8"));
  const booking = flow.find((node) => node.id === FREE_FIRST_EVENT_BOOKING_ID).func;
  const patchedBooking = patchFreeFirstEventBookingBody(booking);
  assert.equal(sha256(patchedBooking), FREE_FIRST_EVENT_TARGET.patchedBookingFuncSha256);
  let revertedBooking = patchedBooking;
  for (const delta of [...FREE_FIRST_EVENT_BOOKING_DELTAS].reverse()) {
    revertedBooking = revertedBooking.replace(delta.after, () => delta.before);
  }
  assert.equal(revertedBooking, booking);

  const evaluator = flow.find((node) => node.id === FREE_FIRST_EVENT_EVALUATOR_IDS[0]).func;
  const patchedEvaluator = patchFreeFirstEventEvaluatorBody(evaluator);
  assert.equal(sha256(patchedEvaluator), FREE_FIRST_EVENT_TARGET.patchedEvaluatorFuncSha256);
  let revertedEvaluator = patchedEvaluator;
  for (const delta of [...FREE_FIRST_EVENT_EVALUATOR_DELTAS].reverse()) {
    revertedEvaluator = revertedEvaluator.replace(delta.after, () => delta.before);
  }
  assert.equal(revertedEvaluator, evaluator);
});

test("the generation refuses any flow that is not the installed one", () => {
  const flow = [{ id: "x", type: "function", func: "", initialize: "", outputs: 1, wires: [[]] }];
  assert.throws(() => composeFreeFirstEventArtifacts(flow, "probe"), /Live flow preimage drift/);
  if (snapshotSkip) return;
  for (const mutate of [
    (candidate) => { candidate.find((node) => node.id === FREE_FIRST_EVENT_BOOKING_ID).func += "\n// drift"; },
    (candidate) => { candidate.find((node) => node.id === FREE_FIRST_EVENT_EVALUATOR_IDS[0]).func += "\n// drift"; },
  ]) {
    const drifted = JSON.parse(installedFlowBytes().toString("utf8"));
    mutate(drifted);
    assert.throws(() => composeFreeFirstEventArtifacts(Buffer.from(`${JSON.stringify(drifted, null, 2)}\n`), "probe"),
      /Live flow preimage drift/);
  }
});

test("the generation composes exactly three reviewed function bodies", { skip: snapshotSkip }, () => {
  const bytes = installedFlowBytes();
  const built = composeFreeFirstEventArtifacts(bytes, "lk1-free-first-event");
  assert.equal(built.changes.length, 3);
  assert.deepEqual(built.changes.map((row) => row.id),
    [FREE_FIRST_EVENT_BOOKING_ID, ...FREE_FIRST_EVENT_EVALUATOR_IDS]);
  for (const row of built.changes) assert.deepEqual(row.fields, ["func"]);
  assert.equal(built.changes[0].func.afterSha256, FREE_FIRST_EVENT_TARGET.patchedBookingFuncSha256);
  assert.equal(built.changes[1].func.afterSha256, FREE_FIRST_EVENT_TARGET.patchedEvaluatorFuncSha256);
  assert.equal(built.changes[2].func.afterSha256, FREE_FIRST_EVENT_TARGET.patchedEvaluatorFuncSha256);
  assert.equal(built.addedNodeCount, 0);
  assert.equal(built.booking.otherFieldsUnchanged, true);
  assert.equal(built.booking.freeFirstCohortBound, true);
  assert.equal(built.booking.dayBucketProved, true);
  assert.equal(built.booking.checkoutCohortBound, true);
  assert.equal(built.evaluator.otherFieldsUnchanged, true);
  assert.equal(built.evaluator.freeFirstBenefitBound, true);
  assert.equal(built.contract.allowedChanges.length, 3);
  assert.equal((built.contract.allowedAdditions ?? []).length, 0);
  const candidate = JSON.parse(built.candidateBytes.toString("utf8"));
  const live = JSON.parse(bytes.toString("utf8"));
  const differing = candidate.filter((node, index) => JSON.stringify(node) !== JSON.stringify(live[index]));
  assert.deepEqual(differing.map((node) => node.id).sort(),
    [FREE_FIRST_EVENT_BOOKING_ID, ...FREE_FIRST_EVENT_EVALUATOR_IDS].sort());
});

test("gateway and evaluator together grant exactly one free event per day",
  { skip: snapshotSkip }, () => {
    const bytes = installedFlowBytes();
    const built = composeFreeFirstEventArtifacts(bytes, "lk1-free-first-event");
    const bookingBody = built.flow.find((node) => node.id === FREE_FIRST_EVENT_BOOKING_ID).func;
    const evaluatorBody = built.flow.find((node) => node.id === FREE_FIRST_EVENT_EVALUATOR_IDS[0]).func;
    const other = { _id: "fixture-operation", tenantKey: "iSkq6G", actorClientId: ACTOR,
      clientSubscriptionId: SUBSCRIPTION, operationId: "lk-subscription-other",
      exerciseId: "bf703336-e8d2-4630-98ea-654929103814", serviceDate: "2026-09-29",
      category: "group_training", state: "CONFIRMED",
      bookingId: "c8ffcb43-6a2b-4f9d-91bf-aa5c55e88d73",
      lk1: { decision: { eligible: true, subscriptionVisitCount: 0,
        benefit: { finalPriceMinor: 275000 } }, target: { category: "GROUP_TRAINING" } } };

    // РА: the first group training and the first tournament of the day are free with one
    // visit; the second event of the day keeps the discount.
    for (const typeId of [605, 839]) {
      const first = verdict(bookingBody, evaluatorBody, RA_PRODUCT, { typeId });
      assert.deepEqual(first.input.usage.freeFirstEvent, { covered: true, usedEventsToday: 0, visitsLeft: 30 });
      assert.equal(first.decision.eligible, true);
      assert.equal(first.decision.benefit.kind, "FREE_ENTITLEMENT");
      assert.equal(first.decision.benefit.finalPriceMinor, 0);
      assert.equal(first.decision.subscriptionVisitCount, 1);
    }
    const second = verdict(bookingBody, evaluatorBody, RA_PRODUCT, { operations: [other] });
    assert.deepEqual(second.input.usage.freeFirstEvent, { covered: true, usedEventsToday: 1, visitsLeft: 30 });
    assert.equal(second.decision.benefit.kind, "PERCENT_DISCOUNT");
    assert.equal(second.decision.benefit.finalPriceMinor, 275000);
    assert.equal(second.decision.subscriptionVisitCount, 0);

    // An exhausted balance and a released reservation keep the discount / stay unused.
    const exhausted = verdict(bookingBody, evaluatorBody, RA_PRODUCT, { rowChanges: { visitsLeft: 0 } });
    assert.deepEqual(exhausted.input.usage.freeFirstEvent, { covered: true, usedEventsToday: 0, visitsLeft: 0 });
    assert.equal(exhausted.decision.benefit.finalPriceMinor, 275000);
    const released = verdict(bookingBody, evaluatorBody, RA_PRODUCT,
      { operations: [{ ...other, state: "RELEASED" }] });
    assert.equal(released.input.usage.freeFirstEvent.usedEventsToday, 0);
    assert.equal(released.decision.benefit.kind, "FREE_ENTITLEMENT");
    const openGame = verdict(bookingBody, evaluatorBody, RA_PRODUCT,
      { operations: [{ ...other, category: "open_game" }] });
    assert.equal(openGame.input.usage.freeFirstEvent.usedEventsToday, 0);

    // Академия covers group training only; Дружба and the annual HUB keep the discount.
    const academy = verdict(bookingBody, evaluatorBody, ACADEMY_PRODUCT);
    assert.deepEqual(academy.input.usage.freeFirstEvent, { covered: true, usedEventsToday: 0, visitsLeft: 30 });
    assert.equal(academy.decision.benefit.kind, "FREE_ENTITLEMENT");
    const academyTournament = verdict(bookingBody, evaluatorBody, ACADEMY_PRODUCT, { typeId: 839 });
    assert.deepEqual(academyTournament.input.usage.freeFirstEvent, { covered: false });
    assert.equal(academyTournament.decision.benefit.finalPriceMinor, 275000);
    for (const productId of [FRIENDSHIP_PRODUCT, HUB_PRODUCT]) {
      const outside = verdict(bookingBody, evaluatorBody, productId);
      assert.deepEqual(outside.input.usage.freeFirstEvent, { covered: false }, productId);
      assert.equal(outside.decision.benefit.kind, "PERCENT_DISCOUNT", productId);
      assert.equal(outside.decision.subscriptionVisitCount, 0, productId);
    }
  });

test("the deploy wrapper keeps the confirmation gate, the exact allowance and rollback", () => {
  const wrapper = fs.readFileSync(
    path.join(repoRoot, "scripts/deploy_nodered_lk1_free_first_event_hotfix_147.sh"), "utf8");
  assert.ok(wrapper.includes('NODE_RED_LK1_FREE_FIRST_EVENT_DEPLOY:-}" != "CONFIRM_147"'));
  assert.ok(wrapper.includes(`allow_nodes=(${FREE_FIRST_EVENT_BOOKING_ID} ${FREE_FIRST_EVENT_EVALUATOR_IDS.join(" ")})`));
  assert.ok(wrapper.includes(`"${FREE_FIRST_EVENT_BOOKING_ID}:func"`));
  assert.ok(wrapper.includes("expected_changed_nodes=3"));
  assert.ok(wrapper.includes("patch_live_lk1_free_first_event_hotfix.mjs"));
  assert.ok(wrapper.includes("prepare_exact_graph_contract.mjs"));
  assert.equal(wrapper.includes("nodered_reviewed_flow_deploy/prepare_contract.mjs"), false);
  assert.ok(wrapper.includes("value.booking?.freeFirstCohortBound !== true"));
  assert.ok(wrapper.includes("value.booking?.dayBucketProved !== true"));
  assert.ok(wrapper.includes("value.booking?.checkoutCohortBound !== true"));
  assert.ok(wrapper.includes("value.evaluator?.freeFirstBenefitBound !== true"));
  assert.ok(wrapper.includes("rollback --deployment-id"));
  assert.ok(wrapper.includes("sha256sum"));
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(pkg.scripts["nodered:lk1-free-first-event:deploy-147"],
    "bash scripts/deploy_nodered_lk1_free_first_event_hotfix_147.sh");
});
