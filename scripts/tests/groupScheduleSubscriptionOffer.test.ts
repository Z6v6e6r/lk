import test from "node:test";
import assert from "node:assert/strict";
import { hasGroupTrainingSubscription, hasGroupTrainingSubscriptionEvidence } from "../../src/utils/groupScheduleSubscriptionOffer.ts";
import type { GroupSubscriptionDiscountQuote } from "../../src/utils/groupSubscriptionDiscount.ts";
import type { TournamentVivaProduct } from "../../src/utils/tournamentSignupApi.ts";

test("active RA and Academy hide the offer even with no remaining visits", () => {
  for (const name of ["РА", "RA", "Академия", "Лето.Падел.РА", "Лето.Падел.Академия"]) {
    const subscription = { name, status: "ACTIVE", visitsLeft: 0 };
    assert.equal(hasGroupTrainingSubscription([subscription]), true, name);
  }
});

test("confirmed RA or Academy quotes hide the offer when the profile list omits the plan", () => {
  for (const subscriptionName of ["РА", "Академия"]) {
    for (const discountPercent of [50, 100]) {
      const quote = { subscriptionName, status: "AVAILABLE", discountPercent } as GroupSubscriptionDiscountQuote;
      assert.equal(hasGroupTrainingSubscriptionEvidence([], [quote]), true);
    }
  }
  assert.equal(hasGroupTrainingSubscriptionEvidence([], []), false);
  assert.equal(hasGroupTrainingSubscriptionEvidence([], [{ subscriptionName: "Дружба", status: "AVAILABLE" } as GroupSubscriptionDiscountQuote]), false);
});

test("an available owned plan also hides the offer when monetary quotes are unavailable", () => {
  const product = { name: "РА", source: "client-subscription" } as TournamentVivaProduct;
  assert.equal(hasGroupTrainingSubscriptionEvidence([product], []), true);
  assert.equal(hasGroupTrainingSubscriptionEvidence([{ ...product, name: "Энергия 5" }], []), false);
  assert.equal(hasGroupTrainingSubscriptionEvidence([{ ...product, source: "subscription" }], []), false);
});

test("Energy, other plans, expired subscriptions and an empty list keep the offer available", () => {
  assert.equal(hasGroupTrainingSubscription([]), false);
  for (const name of ["Энергия 5", "Энергия 25", "Дружба", "Спорт", null]) {
    assert.equal(hasGroupTrainingSubscription([{ name, status: "ACTIVE" }]), false);
  }
  for (const status of ["EXPIRED", "FINISHED", "INACTIVE"]) {
    assert.equal(hasGroupTrainingSubscription([{ name: "РА", status }, { name: "Академия", status }]), false);
  }
});
