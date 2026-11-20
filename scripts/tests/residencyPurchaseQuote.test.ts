import assert from "node:assert/strict";
import test from "node:test";
import {
  isResidencyPurchaseQuoteUsable,
  parseResidencyPurchaseQuote,
  residencyQuoteExerciseIdFor,
} from "../../src/residency/residencyPurchaseQuote.ts";
import { RESIDENCY_PRODUCT_ID } from "../../src/residency/residencyPurchase.ts";

// Shape and amounts of the lk#463 server fixture for exercise 4c9f00aa-… (5 500 − 2 750 + 790 = 3 540 ₽).
const EXERCISE_A = "4c9f00aa-d286-4a48-ad29-98757bd0ca87";
const EXERCISE_B = "10000000-0000-4000-8000-000000000002";
const SERVER_NOW = Date.parse("2026-11-19T08:41:00Z");

function body(overrides: Record<string, unknown> = {}, serverTimeMs = SERVER_NOW) {
  return {
    serverTimeMs,
    residencyPurchaseQuote: {
      schemaVersion: 1, kind: "GROUP_TRAINING_RESIDENCY_PURCHASE_QUOTE", exerciseId: EXERCISE_A,
      startsAt: "2026-11-20T07:00:00.000Z", durationMinutes: 60, currency: "RUB",
      participationProductId: "tariff-1", residencyProductId: RESIDENCY_PRODUCT_ID, existingResidency: "NONE",
      publicationId: "publication:6bc140f3-2f08-42d8-85c1-bfa560b14d74", policyVersion: 2,
      policyDigest: `sha256:${"a".repeat(64)}`,
      participationBaseMinor: 550000, discountPercent: 50, participationDiscountMinor: 275000,
      participationToPayMinor: 275000, residencyMinor: 79000, totalMinor: 354000, expiresAt: serverTimeMs + 30000,
      ...overrides,
    },
  };
}

test("shows the server amounts for the selected training", () => {
  const local = 1_000_000;
  const result = parseResidencyPurchaseQuote(body(), { exerciseId: EXERCISE_A, requestedAtMs: local, nowMs: local + 400 });
  assert.ok(result.ok);
  assert.equal(result.quote.participationBaseMinor, 550000);
  assert.equal(result.quote.participationDiscountMinor, 275000);
  assert.equal(result.quote.residencyMinor, 79000);
  assert.equal(result.quote.totalMinor, 354000);
  // Lifetime is measured on the local clock from the request, whatever the device clock says.
  assert.equal(result.quote.localExpiresAtMs, local + 30000);
});

test("drops an answer for another training (A → B while the request was in flight)", () => {
  const result = parseResidencyPurchaseQuote(body(), { exerciseId: EXERCISE_B, requestedAtMs: 0, nowMs: 1 });
  assert.deepEqual(result, { ok: false, reason: "QUOTE_EXERCISE_MISMATCH" });
  const ok = parseResidencyPurchaseQuote(body(), { exerciseId: EXERCISE_A, requestedAtMs: 0, nowMs: 1 });
  assert.ok(ok.ok);
  assert.equal(isResidencyPurchaseQuoteUsable(ok.quote, EXERCISE_A, 1), true);
  assert.equal(isResidencyPurchaseQuoteUsable(ok.quote, EXERCISE_B, 1), false);
  assert.equal(isResidencyPurchaseQuoteUsable(ok.quote, null, 1), false);
});

test("refuses an expired quote and stops consent at the expiry moment", () => {
  assert.deepEqual(parseResidencyPurchaseQuote(body(), { exerciseId: EXERCISE_A, requestedAtMs: 0, nowMs: 30000 }),
    { ok: false, reason: "QUOTE_EXPIRED" });
  assert.deepEqual(parseResidencyPurchaseQuote(body({ expiresAt: SERVER_NOW }), { exerciseId: EXERCISE_A, requestedAtMs: 0, nowMs: 0 }),
    { ok: false, reason: "QUOTE_EXPIRED" });
  const ok = parseResidencyPurchaseQuote(body(), { exerciseId: EXERCISE_A, requestedAtMs: 0, nowMs: 10 });
  assert.ok(ok.ok);
  assert.equal(isResidencyPurchaseQuoteUsable(ok.quote, EXERCISE_A, 29999), true);
  assert.equal(isResidencyPurchaseQuoteUsable(ok.quote, EXERCISE_A, 30000), false);
});

test("a device clock far ahead of the server does not expire or extend the quote", () => {
  const deviceAhead = SERVER_NOW + 3_600_000;
  const result = parseResidencyPurchaseQuote(body(), { exerciseId: EXERCISE_A, requestedAtMs: deviceAhead, nowMs: deviceAhead + 1000 });
  assert.ok(result.ok);
  assert.equal(result.quote.localExpiresAtMs, deviceAhead + 30000);
});

test("refuses quotes that do not add up or do not describe a first residency purchase", () => {
  const ctx = { exerciseId: EXERCISE_A, requestedAtMs: 0, nowMs: 1 };
  for (const overrides of [
    { totalMinor: 354001 },
    { participationDiscountMinor: 270000 },
    { participationToPayMinor: 280000, totalMinor: 359000 },
    { existingResidency: "ACTIVE" },
    { residencyProductId: "other-product" },
    { participationProductId: RESIDENCY_PRODUCT_ID },
    { discountPercent: 0, participationDiscountMinor: 0, participationToPayMinor: 550000, totalMinor: 629000 },
    { currency: "EUR" },
    { schemaVersion: 2 },
    { policyDigest: "" },
    { residencyMinor: 0, totalMinor: 275000 },
  ]) {
    assert.deepEqual(parseResidencyPurchaseQuote(body(overrides), ctx), { ok: false, reason: "QUOTE_INVALID" }, JSON.stringify(overrides));
  }
  assert.deepEqual(parseResidencyPurchaseQuote({ quotes: [], serverTimeMs: SERVER_NOW }, ctx), { ok: false, reason: "QUOTE_MISSING" });
  assert.deepEqual(parseResidencyPurchaseQuote(null, ctx), { ok: false, reason: "QUOTE_MISSING" });
  assert.deepEqual(parseResidencyPurchaseQuote({ ...body(), serverTimeMs: "now" }, ctx), { ok: false, reason: "QUOTE_INVALID" });
});

test("asks for a first-residency quote only after a confirmed NONE owned-residency read", () => {
  const base = { compositeEligible: true, isTournament: false, selectedExerciseId: EXERCISE_B };
  assert.equal(residencyQuoteExerciseIdFor({ ...base, ownedResidencyState: "NONE" }), EXERCISE_B);
  // In flight, resident, or unknown (failed/partial/stale read): no request, no price, no consent.
  for (const ownedResidencyState of [null, "ACTIVE", "UNKNOWN"] as const) {
    assert.equal(residencyQuoteExerciseIdFor({ ...base, ownedResidencyState }), null, String(ownedResidencyState));
  }
  assert.equal(residencyQuoteExerciseIdFor({ ...base, ownedResidencyState: "NONE", compositeEligible: false }), null);
  assert.equal(residencyQuoteExerciseIdFor({ ...base, ownedResidencyState: "NONE", isTournament: true }), null);
  assert.equal(residencyQuoteExerciseIdFor({ ...base, ownedResidencyState: "NONE", selectedExerciseId: null }), null);
});
