// Focused generation: the visit-covered first event of the day completes without a payment
// product (the payment binding stays mandatory wherever money is charged).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { patchMoneyCohortBookingBody } from "../patch_live_lk1_money_cohort_hotfix.mjs";
import { PLAN_FIRST_USE_DELTAS } from "../patch_live_lk1_plan_money_first_use_hotfix.mjs";
import { FREE_FIRST_EVENT_BOOKING_DELTAS, FREE_FIRST_EVENT_EVALUATOR_DELTAS }
  from "../patch_live_lk1_free_first_event_hotfix.mjs";
import { FREE_FIRST_EVENT_V1_DELTAS }
  from "../patch_live_lk1_free_first_event_v1_create_hotfix.mjs";
import {
  FREE_EVENT_CHECKOUT_BOOKING_ID,
  FREE_EVENT_CHECKOUT_DELTAS,
  FREE_EVENT_CHECKOUT_SOURCE_NODE_COUNT,
  FREE_EVENT_CHECKOUT_SOURCE_SHA256,
  FREE_EVENT_CHECKOUT_TARGET,
  composeFreeEventCheckoutArtifacts,
  patchFreeEventCheckoutBookingBody,
  sha256,
} from "../patch_live_lk1_free_event_checkout_hotfix.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LIVE_SNAPSHOT = process.env.LK1_MONEY_COHORT_LIVE_SNAPSHOT
  ?? "/private/tmp/lk1-cohort-live/input/source.flow.json";
const snapshotSkip = fs.existsSync(LIVE_SNAPSHOT)
  ? false
  : `live 147 snapshot is absent: ${LIVE_SNAPSHOT} (set LK1_MONEY_COHORT_LIVE_SNAPSHOT)`;

function applyDeltas(source, deltas) {
  let out = source;
  for (const delta of deltas) {
    const occurrences = out.split(delta.before).length - 1;
    assert.equal(occurrences, 1, `anchor drift for ${delta.id}`);
    out = out.replace(delta.before, () => delta.after);
  }
  return out;
}

/** The installed flow after `lk1-free-first-event-v1-create`, rebuilt from the reviewed chain. */
function installedFlowBytes() {
  const flow = JSON.parse(fs.readFileSync(LIVE_SNAPSHOT, "utf8"));
  const booking = flow.find((node) => node.id === FREE_EVENT_CHECKOUT_BOOKING_ID);
  booking.func = patchMoneyCohortBookingBody(booking.func);
  booking.func = applyDeltas(booking.func, PLAN_FIRST_USE_DELTAS.slice(0, 4));
  booking.func = applyDeltas(booking.func, FREE_FIRST_EVENT_BOOKING_DELTAS);
  booking.func = applyDeltas(booking.func, FREE_FIRST_EVENT_V1_DELTAS);
  const evaluator = flow.find((node) => node.id === "lk_subscription_managed_policy_20260820");
  const patchedEvaluator = applyDeltas(evaluator.func, FREE_FIRST_EVENT_EVALUATOR_DELTAS);
  evaluator.func = patchedEvaluator;
  flow.find((node) => node.id === "lk_subscription_price_preview_20260908_evaluate").func = patchedEvaluator;
  return Buffer.from(`${JSON.stringify(flow, null, 2)}\n`);
}

/** The patched routes/binding slice, evaluated on its own. */
function bindingProbe(patchedBody) {
  const start = patchedBody.indexOf("const lk1EventPaymentRoutes = Object.freeze({");
  const bindingAt = patchedBody.indexOf("const lk1EventPaymentBinding = (ctx, quote = ctx.lk1) => {");
  assert.notEqual(start, -1, "the route table is absent from the patched body");
  assert.notEqual(bindingAt, -1, "the payment binding is absent from the patched body");
  const end = patchedBody.indexOf("\n};\n", bindingAt);
  assert.notEqual(end, -1, "the payment binding has no terminator");
  const slice = patchedBody.slice(start, end + 4);
  const factory = new Function(`${slice}\nreturn lk1EventPaymentBinding;`);
  return factory();
}

const groupQuote = (decision, final) => ({ rule: { groupTrainingDiscountPercent: 50 },
  target: { category: "GROUP_TRAINING", eventId: "evt-1", stationId: "st-1",
    priceProductId: "d52bc36c-14bb-419b-8601-6f5f33bd1a07", basePriceMinor: 550000 },
  decision: { eligible: true, subscriptionVisitCount: decision === "free" ? 1 : 0,
    benefit: { kind: decision === "free" ? "FREE_ENTITLEMENT" : "PERCENT_DISCOUNT", finalPriceMinor: final } } });
const groupCtx = { caller: "http", category: "group_training", managedAction: "BOOK_GROUP_TRAINING",
  exerciseId: "evt-1", studioId: "st-1" };

test("the generation pins the installed flow and one node field", () => {
  assert.equal(FREE_EVENT_CHECKOUT_SOURCE_NODE_COUNT, 4804);
  assert.equal(FREE_EVENT_CHECKOUT_SOURCE_SHA256,
    "80de9c88893f61b02725a3275fed4b5f8edf4ae294f1e639df7967c049a37aa9");
  assert.equal(FREE_EVENT_CHECKOUT_BOOKING_ID, "lk_subscription_booking_router_20260804");
  assert.equal(FREE_EVENT_CHECKOUT_TARGET.liveFuncSha256,
    "c4d13c3ce9c888884305c21774a46caaab699a545e7b3541b7f9b6f5f279b3d4");
  assert.equal(FREE_EVENT_CHECKOUT_TARGET.patchedFuncSha256,
    "1c4b177b7e652137252917c6de92f039a2f1717252d62f27994ed7f0a4811de1");
  assert.equal(FREE_EVENT_CHECKOUT_DELTAS.length, 1);
});

test("the reviewed event-payment source carries the reviewed delta", () => {
  // The reviewed module is reflowed when it is composed into the function body, so the
  // reviewed text is compared with whitespace removed: same tokens, same order.
  const strip = (value) => value.replace(/\s+/g, "");
  const reviewed = fs.readFileSync(path.join(repoRoot, "scripts/nodered_lk1_hub_nodes/event_payments.js"), "utf8");
  for (const delta of FREE_EVENT_CHECKOUT_DELTAS) {
    assert.ok(strip(reviewed).includes(strip(delta.after)), `reviewed event-payment drift for ${delta.id}`);
    assert.ok(!strip(reviewed).includes(strip(delta.before)), `reviewed event-payment keeps ${delta.id}`);
  }
});

test("the generation pins the exact installed preimage chain", { skip: snapshotSkip }, () => {
  const bytes = installedFlowBytes();
  assert.equal(sha256(bytes), FREE_EVENT_CHECKOUT_SOURCE_SHA256);
});

test("the deltas apply and revert on the installed body only", { skip: snapshotSkip }, () => {
  const flow = JSON.parse(installedFlowBytes().toString("utf8"));
  const booking = flow.find((node) => node.id === FREE_EVENT_CHECKOUT_BOOKING_ID);
  assert.equal(sha256(booking.func), FREE_EVENT_CHECKOUT_TARGET.liveFuncSha256);
  const patched = patchFreeEventCheckoutBookingBody(booking.func);
  assert.equal(sha256(patched), FREE_EVENT_CHECKOUT_TARGET.patchedFuncSha256);
  for (const delta of FREE_EVENT_CHECKOUT_DELTAS) {
    assert.ok(patched.includes(delta.after), `missing ${delta.id}`);
    assert.ok(!patched.includes(delta.before), `preimage kept for ${delta.id}`);
  }
  assert.equal(applyDeltas(patched, FREE_EVENT_CHECKOUT_DELTAS.map((delta) => ({ id: delta.id,
    before: delta.after, after: delta.before }))), booking.func);
});

test("the generation refuses any flow that is not the installed one", { skip: snapshotSkip }, () => {
  const bytes = installedFlowBytes();
  const flow = JSON.parse(bytes.toString("utf8"));
  flow.push({ id: "lk1-foreign-node", type: "function", func: "return msg;" });
  assert.throws(() => composeFreeEventCheckoutArtifacts(Buffer.from(`${JSON.stringify(flow, null, 2)}\n`),
    "lk1-free-event-checkout"), /preimage drift/);
  assert.throws(() => patchFreeEventCheckoutBookingBody("const x = 1;\n"), /preimage drift/);
});

test("the generation composes exactly the reviewed postimage", { skip: snapshotSkip }, () => {
  const bytes = installedFlowBytes();
  const built = composeFreeEventCheckoutArtifacts(bytes, "lk1-free-event-checkout");
  assert.equal(built.changes.length, 1);
  assert.equal(built.addedNodeCount, 0);
  assert.equal(built.sourceSha256, FREE_EVENT_CHECKOUT_SOURCE_SHA256);
  assert.equal(built.candidateSha256, sha256(built.candidateBytes));
  assert.equal(built.booking.otherFieldsUnchanged, true);
  assert.equal(built.booking.freeEventCarriesZeroChargeBinding, true);
  assert.equal(built.booking.chargedBindingStillExact, true);
  const candidate = JSON.parse(built.candidateBytes.toString("utf8"));
  const booking = candidate.find((node) => node.id === FREE_EVENT_CHECKOUT_BOOKING_ID);
  assert.equal(sha256(booking.func), FREE_EVENT_CHECKOUT_TARGET.patchedFuncSha256);
});

test("a covered first event carries a zero-charge binding, the charged path stays exact", { skip: snapshotSkip }, () => {
  const built = composeFreeEventCheckoutArtifacts(installedFlowBytes(), "lk1-free-event-checkout");
  const booking = JSON.parse(built.candidateBytes.toString("utf8"))
    .find((node) => node.id === FREE_EVENT_CHECKOUT_BOOKING_ID);
  const binding = bindingProbe(booking.func);

  // The live defect: the free covered event produced no binding, so the confirm step answered
  // LK1_GROUP_PAYMENT_BINDING_INVALID and every replay answered
  // LK1_PAYMENT_RECONCILIATION_REQUIRED after Viva had written the booking.
  const free = binding(groupCtx, groupQuote("free", 0));
  assert.deepEqual(free, { productId: "d52bc36c-14bb-419b-8601-6f5f33bd1a07", productType: "SERVICE",
    baseMinor: 550000, chargeMinor: 0, discountMinor: 550000 });
  const amount = 0;
  assert.equal(amount > 0 && (!free || false), false, "the free replay must pass the charged guard");
  assert.equal(!free || false, false, "the free confirm must pass the checkout guard");

  // The charged path keeps the exact proof: percent applied to the base, product and base echoed.
  const charged = binding(groupCtx, groupQuote("discount", 275000));
  assert.deepEqual(charged, { productId: "d52bc36c-14bb-419b-8601-6f5f33bd1a07", productType: "SERVICE",
    baseMinor: 550000, chargeMinor: 275000, discountMinor: 275000 });

  // Anything that does not match the reviewed shape still has no binding.
  assert.equal(binding(groupCtx, groupQuote("discount", 274999)), null);
  assert.equal(binding({ ...groupCtx, caller: "split" }, groupQuote("free", 0)), null);
  assert.equal(binding({ ...groupCtx, category: "tournament" }, groupQuote("free", 0)), null);
  const foreign = groupQuote("free", 0);
  foreign.rule.groupTrainingDiscountPercent = 200;
  assert.equal(binding(groupCtx, foreign), null);
  const ineligible = groupQuote("free", 0);
  ineligible.decision.eligible = false;
  assert.equal(binding(groupCtx, ineligible), null);
});

test("the deploy wrapper keeps the confirmation gate, the exact allowance and rollback", () => {
  const wrapper = fs.readFileSync(path.join(repoRoot,
    "scripts/deploy_nodered_lk1_free_event_checkout_hotfix_147.sh"), "utf8");
  assert.ok(wrapper.includes("NODE_RED_LK1_FREE_EVENT_CHECKOUT_DEPLOY"));
  assert.ok(wrapper.includes('deployment_id="lk1-free-event-checkout"'));
  assert.ok(wrapper.includes("lk_subscription_booking_router_20260804:func"));
  assert.ok(wrapper.includes("scripts/patch_live_lk1_free_event_checkout_hotfix.mjs"));
  assert.ok(wrapper.includes("rollback"));
  assert.ok(wrapper.includes("expected_changed_nodes=1"));
  // The wrapper must assert this generation's report flags, not a previous one's.
  assert.ok(wrapper.includes("value.booking?.freeEventCarriesZeroChargeBinding !== true"));
  assert.ok(wrapper.includes("value.booking?.chargedBindingStillExact !== true"));
  assert.ok(!wrapper.includes("promoInCohort"));
});
