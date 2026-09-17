import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";
import { isGroupSubscriptionDiscountQuote, matchGroupSubscriptionDiscount, type GroupSubscriptionDiscountQuote } from "../../src/utils/groupSubscriptionDiscount.ts";
import { getGroupScheduleOwnedPacks } from "../../src/utils/groupScheduleOwnedPacks.ts";
import type { TournamentVivaProduct } from "../../src/utils/tournamentSignupApi.ts";

test("owned Energy buttons retain eligible visit-pack instances only", () => {
  const energy5: TournamentVivaProduct = { id: "owned-energy-five", name: "Энергия 5 🎾", source: "client-subscription", type: "SUBSCRIPTION", cost: null, visitsTotal: 5, raw: { clientSubscriptionId: "owned-energy-five", visitsLeft: 3 } };
  const energy25 = { ...energy5, id: "owned-energy-twenty-five", name: "Энергия 25", raw: { visitsRemaining: 20 } };
  const unknownBalance = { ...energy5, id: "unknown-balance", raw: {} };
  const selected = getGroupScheduleOwnedPacks([
    energy5, energy25, unknownBalance,
    { ...energy5, name: "РА" }, { ...energy5, name: "Академия" },
    { ...energy5, name: "Энергия 50" },
    { ...energy5, source: "subscription" },
    { ...energy5, lk1MoneyDiscountCandidate: true },
    { ...energy5, raw: { visitsLeft: 0 } },
    { ...energy5, raw: { subscription: { remainingVisits: 0 } } },
    { ...energy5, raw: { visitsRemaining: -1 } },
  ]);
  assert.deepEqual(selected, [energy5, energy25, unknownBalance]);
  assert.equal(selected[0], energy5, "selection must preserve the original owned product for booking");
  assert.deepEqual(getGroupScheduleOwnedPacks([]), []);
});
const now = Date.now();
const quote: GroupSubscriptionDiscountQuote = { kind: "GROUP_TRAINING_SUBSCRIPTION_DISCOUNT_V1", exerciseId: "group", actorClientId: "actor",
  subscriptionId: "subscription", subscriptionName: "Падел.Дружба.ХАБ", productId: "one-time", status: "AVAILABLE", discountPercent: 50,
  basePriceMinor: 550000, amountMinor: 275000, startsAt: new Date(now + 3600_000).toISOString(), durationMinutes: 60,
  evaluatedAt: now, expiresAt: now + 30_000 };
test("one-time signup picks the best confirmed subscription price independent of plan order", () => {
  const product = { id: "one-time", cost: 550000, source: "one-time" };
  const free = { ...quote, subscriptionId: "free-subscription", discountPercent: 100, amountMinor: 0 };
  assert.equal(matchGroupSubscriptionDiscount([quote, free], product), free);
  assert.equal(matchGroupSubscriptionDiscount([free, quote], product), free);
  assert.equal(matchGroupSubscriptionDiscount([quote], product)?.amountMinor, 275000);
  assert.equal(matchGroupSubscriptionDiscount([], product), null);
  assert.equal(matchGroupSubscriptionDiscount([{ ...free, status: "LIMIT_USED" }, quote], product), quote);
  assert.equal(matchGroupSubscriptionDiscount([{ ...free, amountMinor: null }], product), null);
});
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
test("owned Energy signup sends the original product through subscription booking without a transaction", async () => {
  const calls: unknown[] = [];
  const create = checkout({
    apiCreateTournamentVivaBookingFromSubscription: async (params: unknown) => { calls.push(params); return { data: { bookingId: "fixture-booking" }, error: null }; },
  });
  for (const name of ["Энергия 5", "Энергия 25"]) {
    const params = { exerciseId: "fixture-training", product: { id: "owned-pack", name, source: "client-subscription", raw: { clientSubscriptionId: "owned-pack", visitsLeft: 2 } } };
    assert.equal((await create(params)).error, null);
    assert.equal(calls.at(-1), params);
  }
  assert.equal(calls.length, 2);
});
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

test("discount percentage comes from quote and uses canonical kopeck rounding", () => {
  for (const [discountPercent, basePriceMinor, amountMinor] of [
    [50, 550000, 275000], [10, 550000, 495000], [33, 550001, 368501],
    [0, 550000, 550000], [100, 550000, 0],
  ]) {
    assert.ok(isGroupSubscriptionDiscountQuote({ ...quote, discountPercent, basePriceMinor, amountMinor }, "group", "actor", now));
  }
  for (const discountPercent of [-1, 101, 50.5, NaN, "50"]) {
    assert.equal(isGroupSubscriptionDiscountQuote({ ...quote, discountPercent }, "group", "actor", now), false);
  }
  assert.equal(isGroupSubscriptionDiscountQuote({ ...quote, discountPercent: 33, basePriceMinor: 550001, amountMinor: 368500 }, "group", "actor", now), false);
});
