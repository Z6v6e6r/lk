import assert from "node:assert/strict";
import test from "node:test";
import { planCompositeResidencyOrder } from "../../src/residency/compositeResidencyOrder.ts";
import { buildGroupScheduleCompositeInput } from "../../src/residency/groupScheduleCompositeOffer.ts";
import { RESIDENCY_PRODUCT_ID } from "../../src/residency/residencyPurchase.ts";

const NOW = Date.parse("2026-11-19T10:00:00Z");
const residency = { id: RESIDENCY_PRODUCT_ID, name: "Резидентство", cost: 79_000, source: "subscription" };
const oneTime = { id: "one-time-1", name: "Разовое посещение", cost: 200_000, source: "one-time" };
const policy = { publicationId: "pub-1", policyVersion: 3, groupTrainingDiscountPercent: 50, tournamentDiscountPercent: 30 };

function checkout(overrides: Partial<Parameters<typeof buildGroupScheduleCompositeInput>[0]["checkout"]> = {}) {
  return { exerciseId: "exercise-7", oneTimes: [oneTime], subscriptions: [residency], clientSubscriptions: [], purchasedProducts: [], ...overrides };
}

test("shows both prices and one total for the selected training once every source is proven", () => {
  const input = buildGroupScheduleCompositeInput({
    isTournament: false, checkout: checkout(), checkoutObservedAtMs: NOW, policy, existingResidency: "NONE", nowMs: NOW + 1_000,
  });
  assert.ok(input);
  assert.equal(input.participation.exerciseId, "exercise-7");
  assert.equal(planCompositeResidencyOrder({ ...input, consentAccepted: false }).ok, false);
  const plan = planCompositeResidencyOrder({ ...input, consentAccepted: true });
  assert.ok(plan.ok);
  assert.deepEqual(plan.breakdown, {
    participationBaseMinor: 200_000, discountPercent: 50, participationDiscountMinor: 100_000,
    participationToPayMinor: 100_000, residencyMinor: 79_000, totalMinor: 179_000,
  });
  assert.equal(plan.lines[0].exerciseId, "exercise-7");
});

test("stays fail closed with today's sources: no CUP policy, no owned-residency read", () => {
  const input = buildGroupScheduleCompositeInput({ isTournament: false, checkout: checkout(), checkoutObservedAtMs: NOW, nowMs: NOW });
  assert.ok(input);
  assert.equal(input.existingResidency, "UNKNOWN");
  assert.equal(input.policy, null);
  assert.deepEqual(planCompositeResidencyOrder({ ...input, consentAccepted: true }), { ok: false, reason: "RESIDENCY_STATE_UNKNOWN" });
});

test("an owned residency in the checkout refuses the sale even if a read says NONE", () => {
  const input = buildGroupScheduleCompositeInput({
    isTournament: false, checkout: checkout({ clientSubscriptions: [{ ...residency, source: "client-subscription" }] }),
    checkoutObservedAtMs: NOW, policy, existingResidency: "NONE", nowMs: NOW,
  });
  assert.equal(input?.existingResidency, "ACTIVE");
  assert.deepEqual(planCompositeResidencyOrder({ ...input!, consentAccepted: true }), { ok: false, reason: "ALREADY_RESIDENT" });
});

test("residency price older than the checkout read window is refused", () => {
  const input = buildGroupScheduleCompositeInput({
    isTournament: false, checkout: checkout(), checkoutObservedAtMs: NOW, policy, existingResidency: "NONE", nowMs: NOW + 61_000,
  });
  assert.deepEqual(planCompositeResidencyOrder({ ...input!, consentAccepted: true }), { ok: false, reason: "RESIDENCY_PRICE_STALE" });
});

test("no offer without a paid one-time participation or without the residency card", () => {
  assert.equal(buildGroupScheduleCompositeInput({
    isTournament: false, checkout: checkout({ oneTimes: [{ ...oneTime, cost: 0 }] }), checkoutObservedAtMs: NOW, nowMs: NOW,
  }), null);
  const input = buildGroupScheduleCompositeInput({
    isTournament: false, checkout: checkout({ subscriptions: [] }), checkoutObservedAtMs: NOW, policy, existingResidency: "NONE", nowMs: NOW,
  });
  assert.deepEqual(planCompositeResidencyOrder({ ...input!, consentAccepted: true }), { ok: false, reason: "RESIDENCY_PRODUCT_INVALID" });
});

test("tournament without a level decision does not become payable", () => {
  const input = buildGroupScheduleCompositeInput({
    isTournament: true, checkout: checkout(), checkoutObservedAtMs: NOW, policy, existingResidency: "NONE", nowMs: NOW,
  });
  assert.deepEqual(planCompositeResidencyOrder({ ...input!, consentAccepted: true }), { ok: false, reason: "LEVEL_DECISION_REQUIRED" });
});
