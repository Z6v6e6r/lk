import test from "node:test";
import assert from "node:assert/strict";
import { hasGroupTrainingSubscription } from "../../src/utils/groupScheduleSubscriptionOffer.ts";

test("active RA and Academy hide the offer even with no remaining visits", () => {
  for (const name of ["РА", "RA", "Академия", "Лето.Падел.РА", "Лето.Падел.Академия"]) {
    const subscription = { name, status: "ACTIVE", visitsLeft: 0 };
    assert.equal(hasGroupTrainingSubscription([subscription]), true, name);
  }
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
