import assert from "node:assert/strict";
import test from "node:test";
import { planCompositeResidencyOrder } from "../../src/residency/compositeResidencyOrder.ts";
import { buildGroupScheduleCompositeInput } from "../../src/residency/groupScheduleCompositeOffer.ts";
import { classifyOwnedResidency, OWNED_RESIDENCY_READ_MAX_AGE_MS } from "../../src/residency/ownedResidencyRead.ts";
import { RESIDENCY_PRODUCT_ID } from "../../src/residency/residencyPurchase.ts";

const NOW = Date.parse("2026-11-19T10:00:00Z");
const ACTOR = "client-1";
const friendship = { subscriptionId: "sub-f", productId: "db7a5250-7369-4f43-8ac5-9111be24bc74", clientId: ACTOR,
  status: "ACTIVE", activationDate: "2026-11-01", expirationDate: "2026-12-01" };
const resident = { subscriptionId: "sub-r", productId: RESIDENCY_PRODUCT_ID, clientId: ACTOR, status: "ACTIVE",
  activationDate: "2026-11-10T09:00:00+03:00", expirationDate: "2026-12-10" };
const page = (content: unknown[], extra: Record<string, unknown> = {}) =>
  ({ content, last: true, totalElements: content.length, ...extra });
const read = (payload: unknown, extra: Partial<Parameters<typeof classifyOwnedResidency>[0]> = {}) =>
  classifyOwnedResidency({ payload, readFailed: false, actorId: ACTOR, observedAtMs: NOW, nowMs: NOW + 1_000, ...extra });

const policy = { publicationId: "pub-1", policyVersion: 3, groupTrainingDiscountPercent: 50, tournamentDiscountPercent: 30 };
const checkout = { exerciseId: "4c9f00aa-d286-4a48-ad29-98757bd0ca87",
  oneTimes: [{ id: "one-time-1", name: "Разовое посещение", cost: 200_000, source: "one-time" }],
  subscriptions: [{ id: RESIDENCY_PRODUCT_ID, name: "Резидентство", cost: 79_000, source: "subscription" }],
  clientSubscriptions: [], purchasedProducts: [] };
function plan(existingResidency: "ACTIVE" | "NONE" | "UNKNOWN") {
  const input = buildGroupScheduleCompositeInput({ isTournament: false, checkout, checkoutObservedAtMs: NOW,
    policy, existingResidency, nowMs: NOW + 1_000 });
  assert.ok(input);
  return planCompositeResidencyOrder({ ...input, consentAccepted: true });
}

test("case 1 — residency present: an owned ACTIVE in-term residency refuses a second sale", () => {
  const result = read(page([friendship, { ...resident, productId: RESIDENCY_PRODUCT_ID.toUpperCase() }]));
  assert.deepEqual(result, { state: "ACTIVE", reason: null, clientSubscriptionId: "sub-r", observedAtMs: NOW });
  assert.deepEqual(plan(result.state), { ok: false, reason: "ALREADY_RESIDENT" });
  // ACTIVE refuses however old the read is.
  assert.equal(read(page([resident]), { nowMs: NOW + 10 * OWNED_RESIDENCY_READ_MAX_AGE_MS }).state, "ACTIVE");
  // Identity under the nested product card counts the same.
  assert.equal(read(page([{ ...resident, productId: undefined, product: { id: RESIDENCY_PRODUCT_ID } }])).state, "ACTIVE");
});

test("case 2 — confirmed absence: complete fresh read without a live residency is NONE and sells", () => {
  for (const payload of [
    page([]),
    page([friendship]),
    [friendship],
    page([friendship, { ...resident, status: "FINISHED" }, { ...resident, subscriptionId: "sub-old", expirationDate: "2026-11-18" }]),
  ]) {
    assert.deepEqual(read(payload), { state: "NONE", reason: null, clientSubscriptionId: null, observedAtMs: NOW });
  }
  const result = plan(read(page([friendship])).state);
  assert.ok(result.ok);
  assert.equal(result.breakdown.totalMinor, 179_000);
  assert.equal(result.lines[0].exerciseId, checkout.exerciseId);
});

test("case 3 — unknown status: every unproven read stays UNKNOWN and refuses the sale", () => {
  const cases: Array<[unknown, Partial<Parameters<typeof classifyOwnedResidency>[0]>, string]> = [
    [null, { readFailed: true }, "READ_FAILED"],
    [page([friendship]), { actorId: null }, "READ_FAILED"],
    [{ error: "x" }, {}, "READ_FAILED"],
    [page([friendship], { last: false }), {}, "READ_INCOMPLETE"],
    [page([friendship], { totalElements: 2 }), {}, "READ_INCOMPLETE"],
    [page([friendship]), { nowMs: NOW + OWNED_RESIDENCY_READ_MAX_AGE_MS + 1 }, "READ_STALE"],
    [page([friendship]), { nowMs: NOW - 1 }, "READ_STALE"],
    // A row the read cannot identify might be the residency; its name proves nothing.
    [page([{ ...friendship, productId: undefined, name: "Абонемент" }]), {}, "ROW_IDENTITY_MISSING"],
    [page([{ ...friendship, productId: " " }]), {}, "ROW_IDENTITY_MISSING"],
    [page([{ ...resident, product: { id: "other-product" } }]), {}, "ROW_IDENTITY_CONFLICT"],
    [page([{ ...resident, clientId: "someone-else" }]), {}, "OWNER_MISMATCH"],
    [page([{ ...resident, holdUntil: "2026-11-25" }]), {}, "RESIDENCY_FROZEN"],
    [page([{ ...resident, isFrozen: true }]), {}, "RESIDENCY_FROZEN"],
    [page([{ ...resident, status: "NOT_ACTIVATED", activationDate: null }]), {}, "RESIDENCY_PENDING"],
    [page([{ ...resident, activationDate: "2026-11-21" }]), {}, "RESIDENCY_PENDING"],
    [page([{ ...resident, status: "SOMETHING_NEW" }]), {}, "RESIDENCY_STATUS_UNKNOWN"],
    [page([{ ...resident, expirationDate: null }]), {}, "RESIDENCY_STATUS_UNKNOWN"],
  ];
  for (const [payload, extra, reason] of cases) {
    const result = read(payload, extra);
    assert.equal(result.state, "UNKNOWN", reason);
    assert.equal(result.reason, reason);
  }
  assert.deepEqual(plan("UNKNOWN"), { ok: false, reason: "RESIDENCY_STATE_UNKNOWN" });
});

test("a checkout-owned residency still wins over a NONE read", () => {
  const input = buildGroupScheduleCompositeInput({ isTournament: false, checkoutObservedAtMs: NOW, policy,
    checkout: { ...checkout, clientSubscriptions: [{ id: RESIDENCY_PRODUCT_ID, name: "Резидентство", cost: null, source: "client-subscription" }] },
    existingResidency: read(page([friendship])).state, nowMs: NOW + 1_000 });
  assert.ok(input);
  assert.equal(input.existingResidency, "ACTIVE");
});
