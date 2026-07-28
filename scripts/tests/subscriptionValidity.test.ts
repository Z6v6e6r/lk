import assert from "node:assert/strict";
import test from "node:test";

import {
  formatSubscriptionValidityLabel,
  pickSubscriptionValidityDate,
  resolveSubscriptionUsageDisplay,
} from "../../src/utils/subscriptionValidity.ts";

test("subscription validity helper reads nested Viva client subscription dates", () => {
  const payload = {
    id: "product-ra",
    clientSubscription: {
      dateEnd: "2026-07-31T23:59:59+03:00",
    },
  };

  assert.equal(pickSubscriptionValidityDate(payload), "2026-07-31T23:59:59+03:00");
  assert.equal(
    formatSubscriptionValidityLabel(pickSubscriptionValidityDate(payload), "действует до"),
    "действует до 31.07.2026",
  );
});

test("subscription usage helper shows visits for Energy visit packs only", () => {
  assert.deepEqual(
    resolveSubscriptionUsageDisplay({
      subscriptionName: "Энергия 5",
      visitsLeft: 3,
      validityDate: "2026-07-31",
    }),
    { kind: "visits", label: "3 занятия" },
  );
  assert.deepEqual(
    resolveSubscriptionUsageDisplay({
      subscriptionName: "Энергия-25",
      visitsLeft: 11,
      validityDate: "2026-07-31",
      visitsPrefix: "осталось",
    }),
    { kind: "visits", label: "осталось 11 занятий" },
  );
  assert.deepEqual(
    resolveSubscriptionUsageDisplay({
      subscriptionName: "Лето.Падел.Спорт",
      visitsLeft: 30,
      validityDate: "2026-07-31",
      validityPrefix: "действует до",
    }),
    { kind: "validity", label: "действует до 31.07.2026" },
  );
});
