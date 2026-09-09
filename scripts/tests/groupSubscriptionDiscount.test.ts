import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";
import { isGroupSubscriptionDiscountQuote, matchGroupSubscriptionDiscount, type GroupSubscriptionDiscountQuote } from "../../src/utils/groupSubscriptionDiscount.ts";
const now = Date.now();
const quote: GroupSubscriptionDiscountQuote = { kind: "GROUP_TRAINING_SUBSCRIPTION_DISCOUNT_V1", exerciseId: "group", actorClientId: "actor",
  subscriptionId: "subscription", subscriptionName: "Падел.Дружба.ХАБ", productId: "one-time", status: "AVAILABLE", discountPercent: 50,
  basePriceMinor: 550000, amountMinor: 275000, startsAt: new Date(now + 3600_000).toISOString(), durationMinutes: 60,
  evaluatedAt: now, expiresAt: now + 30_000 };
test("discount requires exact actor, event, tariff, supported percentage and fresh quote", () => {
  assert.ok(isGroupSubscriptionDiscountQuote(quote, "group", "actor", now));
  for (const delta of [{ actorClientId: "other" }, { exerciseId: "other" }, { kind: "GAME" }, { amountMinor: 1 },
    { basePriceMinor: null }, { discountPercent: 100 }, { expiresAt: now - 1 }, { status: "LIMIT_USED" },
    { subscriptionName: "" }, { evaluatedAt: now + 6000 }, { durationMinutes: 0 }]) {
    assert.equal(isGroupSubscriptionDiscountQuote({ ...quote, ...delta }, "group", "actor", now), false);
  }
  assert.equal(matchGroupSubscriptionDiscount([quote], { id: "one-time", cost: 550000, source: "one-time" }), quote);
  for (const product of [{ id: "other", cost: 550000, source: "one-time" }, { id: "one-time", cost: 500000, source: "one-time" },
    { id: "one-time", cost: 550000, source: "subscription" }]) assert.equal(matchGroupSubscriptionDiscount([quote], product), null);
});
function checkout(dependencies: Record<string, unknown>) {
  const source = ts.createSourceFile("api.ts", fs.readFileSync("src/utils/tournamentSignupApi.ts", "utf8"), ts.ScriptTarget.Latest, true);
  const node = source.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === "apiCreateTournamentVivaTransaction")!;
  const code = ts.transpileModule(node.getText(source).replace(/^export /, ""), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(dependencies), `const LK1_MONEY_DISCOUNT_CHECKOUT_ENABLED = false; ${code}; return apiCreateTournamentVivaTransaction;`)(...Object.values(dependencies));
}
test("discount dispatch uses existing idempotent subscription gateway, never one-time charge or promo stacking", async () => {
  let count = 0;
  const create = checkout({ isGroupSubscriptionDiscountQuote,
    pickSubscriptionLookupId: (v: { clientSubscriptionId: string }) => v.clientSubscriptionId,
    resolveSubscriptionCategoryDailyLimitCategoryFromEvent: (v: { category: string }) => v?.category,
    apiCreateTournamentVivaBookingFromSubscription: async () => { count++; return { data: { bookingId: "booking" }, error: null }; },
  });
  const params = { exerciseId: "group", clientId: "actor", exercise: { category: "group_training", timeFrom: quote.startsAt },
    product: { id: "subscription", source: "client-subscription", raw: { clientSubscriptionId: "subscription" }, lk1MoneyDiscountCandidate: true, groupDiscountQuote: quote } };
  assert.equal((await create(params)).error, null);
  // The repeated click must reach the gateway's replay even after quote TTL elapsed.
  const expired = { ...quote, evaluatedAt: now - 60_000, expiresAt: now - 30_000 };
  assert.equal((await create({ ...params, product: { ...params.product, groupDiscountQuote: expired } })).error, null);
  assert.equal(count, 2);
  for (const change of [{ promoCode: "PROMO" }, { clientId: "other" }, { exerciseId: "other" },
    { exercise: { category: "tournament", timeFrom: quote.startsAt } },
    { product: { ...params.product, source: "one-time" } }, { product: { ...params.product, raw: { clientSubscriptionId: "other" } } }]) {
    assert.equal((await create({ ...params, ...change })).status, 409);
  }
  assert.equal(count, 2);
});
