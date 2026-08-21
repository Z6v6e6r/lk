import assert from "node:assert/strict";
import test from "node:test";

import {
  getAppliedGroupSchedulePromoPreview,
  isGroupSchedulePromoPreviewApplicable,
  isGroupSchedulePromoProduct,
  normalizeGroupSchedulePromoCode,
  type AppliedGroupSchedulePromo,
} from "../../src/utils/groupSchedulePromo.ts";
import type {
  TournamentVivaProduct,
  TournamentVivaTransactionPreview,
} from "../../src/utils/tournamentSignupApi.ts";

function product(
  source: TournamentVivaProduct["source"],
  id = "one-time-1",
): TournamentVivaProduct {
  return {
    id,
    name: "Разовая",
    type: source === "subscription" ? "SUBSCRIPTION" : "SERVICE",
    cost: 550_000,
    visitsTotal: null,
    source,
    raw: {},
  };
}

function preview(overrides: Partial<TournamentVivaTransactionPreview> = {}): TournamentVivaTransactionPreview {
  return {
    sumMinor: 550_000,
    discountMinor: 451_000,
    toPayMinor: 99_000,
    raw: {},
    ...overrides,
  };
}

test("normalizes a promo code without changing its internal spelling", () => {
  assert.equal(normalizeGroupSchedulePromoCode("  pik-padelhub  "), "PIK-PADELHUB");
  assert.equal(normalizeGroupSchedulePromoCode(""), "");
});

test("limits group promo to purchasable one-time products", () => {
  assert.equal(isGroupSchedulePromoProduct(product("one-time")), true);
  assert.equal(isGroupSchedulePromoProduct(product("client-one-time")), false);
  assert.equal(isGroupSchedulePromoProduct(product("subscription")), false);
  assert.equal(isGroupSchedulePromoProduct(product("client-subscription")), false);
});

test("accepts only a provider preview with a real discount", () => {
  assert.equal(isGroupSchedulePromoPreviewApplicable(preview()), true);
  assert.equal(isGroupSchedulePromoPreviewApplicable(preview({ discountMinor: 0 })), false);
  assert.equal(isGroupSchedulePromoPreviewApplicable(preview({ toPayMinor: 550_000 })), false);
});

test("binds an applied promo quote to the exact Viva product", () => {
  const quote = preview();
  const promo: AppliedGroupSchedulePromo = {
    code: "PIK-PADELHUB",
    previewsByProductId: { "one-time-1": quote },
  };

  assert.equal(getAppliedGroupSchedulePromoPreview(promo, product("one-time")), quote);
  assert.equal(getAppliedGroupSchedulePromoPreview(promo, product("one-time", "one-time-2")), null);
  assert.equal(getAppliedGroupSchedulePromoPreview(promo, product("subscription")), null);
  assert.equal(getAppliedGroupSchedulePromoPreview(null, product("one-time")), null);
});
