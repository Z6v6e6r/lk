import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPOSITE_RESIDENCY_PRICE_MAX_AGE_MS,
  planCompositeResidencyOrder,
  previewCompositeResidencyOffer,
  residencyDiscountedPrice,
  type CompositeResidencyInput,
} from "../../src/residency/compositeResidencyOrder.ts";

const NOW = Date.parse("2026-11-18T09:00:00.000Z");
const RES = "4037a3a3-e551-4f9a-a9db-1410e46b8635";
const input = (over: Partial<CompositeResidencyInput> = {}): CompositeResidencyInput => ({
  category: "GROUP_TRAINING",
  participation: { productId: "service-group", name: "Групповая тренировка", exerciseId: "exercise-1", basePriceMinor: 160000 },
  residencyProduct: { id: RES, name: "Резидентство", costMinor: 79000, observedAtMs: NOW - 1000 },
  policy: { publicationId: "publication-1", policyVersion: 2, groupTrainingDiscountPercent: 50, tournamentDiscountPercent: 50 },
  existingResidency: "NONE",
  levelDecision: null,
  consentAccepted: true,
  nowMs: NOW,
  ...over,
});

test("one payment: discounted participation plus the fresh residency price", () => {
  const plan = planCompositeResidencyOrder(input());
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.deepEqual(plan.breakdown, { participationBaseMinor: 160000, discountPercent: 50, participationDiscountMinor: 80000,
    participationToPayMinor: 80000, residencyMinor: 79000, totalMinor: 159000 });
  assert.deepEqual(plan.lines.map(l => [l.role, l.productId, l.costMinor, l.discountMinor, l.toPayMinor]), [
    ["PARTICIPATION", "service-group", 160000, 80000, 80000], ["RESIDENCY", RES, 79000, 0, 79000]]);
  assert.equal(plan.lines[0].exerciseId, "exercise-1");
  assert.equal(plan.snapshot.level, null);
});

test("rounding matches the residency booking preview", () => {
  assert.equal(residencyDiscountedPrice(99999, 50), 50000);
  assert.equal(residencyDiscountedPrice(1, 50), 1);
  assert.equal(residencyDiscountedPrice(160000, 0), 160000);
  const odd = planCompositeResidencyOrder(input({ participation: { ...input().participation, basePriceMinor: 99999 } }));
  assert.ok(odd.ok && odd.breakdown.totalMinor === 50000 + 79000);
});

test("price comes from the residency product read, never a constant", () => {
  const plan = planCompositeResidencyOrder(input({ residencyProduct: { id: RES, name: "Резидентство", costMinor: 99000, observedAtMs: NOW } }));
  assert.ok(plan.ok && plan.breakdown.residencyMinor === 99000 && plan.breakdown.totalMinor === 179000);
});

test("RES-004: no consent, no payable plan; preview still shows amounts", () => {
  assert.deepEqual(planCompositeResidencyOrder(input({ consentAccepted: false })), { ok: false, reason: "CONSENT_REQUIRED" });
  const preview = previewCompositeResidencyOffer(input({ consentAccepted: false }));
  assert.ok(preview.ok && preview.breakdown.totalMinor === 159000);
});

test("RES-006: active or unknown residency refuses the sale", () => {
  assert.deepEqual(planCompositeResidencyOrder(input({ existingResidency: "ACTIVE" })), { ok: false, reason: "ALREADY_RESIDENT" });
  assert.deepEqual(planCompositeResidencyOrder(input({ existingResidency: "UNKNOWN" })), { ok: false, reason: "RESIDENCY_STATE_UNKNOWN" });
  assert.deepEqual(planCompositeResidencyOrder(input({ existingResidency: undefined as never })), { ok: false, reason: "RESIDENCY_STATE_UNKNOWN" });
});

test("RES-005: stale, future or foreign residency price refuses", () => {
  for (const [observedAtMs, reason] of [[NOW - COMPOSITE_RESIDENCY_PRICE_MAX_AGE_MS - 1, "RESIDENCY_PRICE_STALE"],
    [NOW + 1, "RESIDENCY_PRICE_STALE"], [Number.NaN, "RESIDENCY_PRICE_STALE"]] as const) {
    assert.deepEqual(planCompositeResidencyOrder(input({ residencyProduct: { ...input().residencyProduct!, observedAtMs } })), { ok: false, reason });
  }
  for (const residencyProduct of [null, { ...input().residencyProduct!, id: "other" }, { ...input().residencyProduct!, costMinor: 0 },
    { ...input().residencyProduct!, costMinor: 790.5 }, { ...input().residencyProduct!, name: "" }]) {
    assert.deepEqual(planCompositeResidencyOrder(input({ residencyProduct })), { ok: false, reason: "RESIDENCY_PRODUCT_INVALID" });
  }
});

test("discount percent only from the published policy", () => {
  for (const policy of [null, { ...input().policy!, groupTrainingDiscountPercent: 101 }, { ...input().policy!, groupTrainingDiscountPercent: 12.5 },
    { ...input().policy!, publicationId: "" }]) {
    assert.deepEqual(planCompositeResidencyOrder(input({ policy })), { ok: false, reason: "RESIDENCY_POLICY_UNAVAILABLE" });
  }
});

test("tournament: level decision is required before payment and kept in the snapshot", () => {
  const t = (levelDecision: CompositeResidencyInput["levelDecision"]) => planCompositeResidencyOrder(input({ category: "TOURNAMENT", levelDecision,
    policy: { ...input().policy!, groupTrainingDiscountPercent: 0, tournamentDiscountPercent: 50 } }));
  assert.deepEqual(t(null), { ok: false, reason: "LEVEL_DECISION_REQUIRED" });
  assert.deepEqual(t({ enforced: true, allowed: false, ruleVersion: "v3", evaluatedAt: "2026-11-18T08:59:00Z" }), { ok: false, reason: "LEVEL_DENIED" });
  assert.deepEqual(t({ enforced: true, allowed: true, ruleVersion: "", evaluatedAt: "2026-11-18T08:59:00Z" }), { ok: false, reason: "LEVEL_DECISION_REQUIRED" });
  const allowed = t({ enforced: true, allowed: true, ruleVersion: "v3", evaluatedAt: "2026-11-18T08:59:00Z" });
  assert.ok(allowed.ok);
  if (!allowed.ok) return;
  assert.equal(allowed.breakdown.discountPercent, 50);
  assert.deepEqual(allowed.snapshot.level, { enforced: true, allowed: true, ruleVersion: "v3", evaluatedAt: "2026-11-18T08:59:00Z" });
  // Observe mode never blocks, but the decision is still recorded.
  const observed = t({ enforced: false, allowed: false, ruleVersion: "v3", evaluatedAt: "2026-11-18T08:59:00Z" });
  assert.ok(observed.ok && observed.snapshot.level?.allowed === false);
});

test("games and unknown categories are not sold through the composite order", () => {
  for (const category of ["GAME", "OPEN_GAME", "", "group_training"]) {
    assert.deepEqual(planCompositeResidencyOrder(input({ category })), { ok: false, reason: "CATEGORY_UNSUPPORTED" });
  }
});

test("participation must be a real paid service, never the residency product itself", () => {
  for (const participation of [{ ...input().participation, basePriceMinor: 0 }, { ...input().participation, exerciseId: "" },
    { ...input().participation, productId: RES.toUpperCase() }, { ...input().participation, basePriceMinor: -1 }]) {
    assert.deepEqual(planCompositeResidencyOrder(input({ participation })), { ok: false, reason: "PARTICIPATION_INVALID" });
  }
});
