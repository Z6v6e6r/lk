import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";
import { isTrialGroupTraining } from "../../src/utils/trialGroupTraining.ts";
import { isGroupSubscriptionDiscountQuote, isPartialSubscriptionEventDiscountQuote, matchGroupSubscriptionDiscount, subscriptionEventQuoteAmountMinor, isSubscriptionEventDiscountQuote, courtHourlyCoPayAmountMinor, type GroupSubscriptionDiscountQuote, type GroupTrainingCourtCoPayQuote } from "../../src/utils/groupSubscriptionDiscount.ts";
import { getGroupScheduleOwnedPacks, getGroupScheduleOwnedSubscriptions } from "../../src/utils/groupScheduleOwnedPacks.ts";
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
test("a plan outside the money contour keeps its own booking option", () => {
  const legacyRa: TournamentVivaProduct = { id: "legacy-ra", name: "РА", source: "client-subscription", type: "SUBSCRIPTION", cost: null, visitsTotal: null, raw: { clientSubscriptionId: "legacy-ra", expirationDate: "2026-09-19", visitsLeft: 22 } };
  const managed = { ...legacyRa, id: "managed-academy", name: "Академия" };
  const energy = { ...legacyRa, id: "energy-five", name: "Энергия 5 🎾", raw: { clientSubscriptionId: "energy-five", visitsLeft: 3 } };
  const zeroDiscount: GroupSubscriptionDiscountQuote = { ...quote, subscriptionId: "legacy-ra", subscriptionName: "РА", discountPercent: 0, amountMinor: 550000 };
  const managedDiscount: GroupSubscriptionDiscountQuote = { ...quote, subscriptionId: "managed-academy", subscriptionName: "Академия" };
  const products = [legacyRa, managed, energy];
  // The zero-percent quote is the preview's own "no managed benefit" answer: booking has to
  // stay possible, and it must not be hidden by a discount that prices nothing.
  assert.deepEqual(getGroupScheduleOwnedSubscriptions(products, [zeroDiscount, managedDiscount]), [energy, legacyRa]);
  // While the price check runs only visit packs are shown, so a managed plan is never
  // offered as an unpriced second option even for one render.
  assert.deepEqual(getGroupScheduleOwnedSubscriptions(products, null), [energy]);
  assert.deepEqual(getGroupScheduleOwnedSubscriptions(products, [managedDiscount]), [energy, legacyRa]);
  assert.deepEqual(getGroupScheduleOwnedSubscriptions(products, []), [energy, legacyRa, managed]);
  // A zero balance has nothing to book with, and an owned pack is never re-priced.
  assert.deepEqual(getGroupScheduleOwnedSubscriptions([{ ...legacyRa, raw: { clientSubscriptionId: "legacy-ra", visitsLeft: 0 } }], []), []);
  assert.deepEqual(getGroupScheduleOwnedSubscriptions([{ ...legacyRa, lk1MoneyDiscountCandidate: true }], []), []);
  assert.deepEqual(getGroupScheduleOwnedSubscriptions([], []), []);
  assert.equal(getGroupScheduleOwnedSubscriptions(products, [])[1], legacyRa, "selection must preserve the original owned product for booking");
});
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
  dependencies = { isTrialGroupTraining, TRIAL_GROUP_CHECKOUT_ENABLED: false, ...dependencies };
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

test("a club training co-pay is quoted as the paid share above the free hour", () => {
  // «Дружба Топократы», direction 6233: a 4 000 ₽ two-hour training spends the free hour and
  // charges a quarter of the court price for the second one — 500 ₽, not the flat 50 %.
  const partial: GroupSubscriptionDiscountQuote = { ...quote, subscriptionName: "Дружба Топократы",
    discountPercent: 75, basePriceMinor: 400000, amountMinor: 50000, durationMinutes: 120,
    freeMinutes: 60, paidMinutes: 60 };
  assert.ok(isGroupSubscriptionDiscountQuote(partial, "group", "actor", now));
  assert.equal(isPartialSubscriptionEventDiscountQuote(partial), true);
  assert.equal(subscriptionEventQuoteAmountMinor(partial), 50000);
  // The paid share must add up to the event, and its amount is not the flat one.
  for (const delta of [{ amountMinor: 100000 }, { freeMinutes: 0 }, { paidMinutes: 0 },
    { freeMinutes: 60, paidMinutes: 30 }, { freeMinutes: 200, paidMinutes: 60 },
    { freeMinutes: 60.5 }, { paidMinutes: null }]) {
    assert.equal(isGroupSubscriptionDiscountQuote({ ...partial, ...delta }, "group", "actor", now), false,
      JSON.stringify(delta));
  }
  // Minutes that do not cover the event are never a co-pay: a quote that happens to be
  // arithmetically flat is accepted as flat, and the label follows the same predicate.
  const misaligned = { ...partial, paidMinutes: 30, amountMinor: 100000 };
  assert.equal(isPartialSubscriptionEventDiscountQuote(misaligned), false);
  assert.ok(isGroupSubscriptionDiscountQuote(misaligned, "group", "actor", now));
  // A fully covered hour and an ordinary discounted event keep the flat formula.
  assert.ok(isGroupSubscriptionDiscountQuote({ ...partial, discountPercent: 100, amountMinor: 0,
    freeMinutes: 0, paidMinutes: 120 }, "group", "actor", now));
  assert.ok(isGroupSubscriptionDiscountQuote({ ...quote, freeMinutes: 0, paidMinutes: 60 }, "group", "actor", now));
});

test("a Skolkovo court-hourly co-pay is accepted as its own kind, never as a percentage", () => {
  // Owner decision 2026-10-05: the Skolkovo court costs 6 000 ₽/hour, so a 4 000 ₽ two-hour club
  // training with a free visit pays one quarter of that hour — 1 500 ₽ — and consumes one visit.
  // The co-pay is the court's money, not a share of the event tariff, so it carries its own kind.
  const courtCoPay: GroupTrainingCourtCoPayQuote = { ...quote, kind: "GROUP_TRAINING_COURT_COPAY_V1",
    subscriptionName: "Дружба Топократы", discountPercent: 0, basePriceMinor: 400000, amountMinor: 150000,
    durationMinutes: 120, freeMinutes: 60, paidMinutes: 60,
    chargeableHours: 1, hourlyCourtPriceMinor: 600000, perHourMinor: 150000 };
  assert.ok(isGroupSubscriptionDiscountQuote(courtCoPay, "group", "actor", now));
  assert.equal(courtHourlyCoPayAmountMinor(courtCoPay), 150000);
  // Three hours: two started hours above the free one charge 2 × 1 500 = 3 000 ₽.
  assert.ok(isGroupSubscriptionDiscountQuote({ ...courtCoPay, amountMinor: 300000,
    durationMinutes: 180, paidMinutes: 120, chargeableHours: 2 }, "group", "actor", now));
  // The co-pay never exceeds the event's own base price.
  assert.ok(isGroupSubscriptionDiscountQuote({ ...courtCoPay, amountMinor: 400000, durationMinutes: 300,
    paidMinutes: 240, chargeableHours: 4 }, "group", "actor", now));
  // The club subscription becomes an offered price for the one-time tariff, and the cheapest offer
  // still wins across both group kinds.
  const oneTime = { id: "one-time", cost: 400000, source: "one-time" };
  assert.equal(matchGroupSubscriptionDiscount([courtCoPay], oneTime)?.amountMinor, 150000);
  const flatHalf = { ...quote, basePriceMinor: 400000, amountMinor: 200000, discountPercent: 50 };
  assert.equal(matchGroupSubscriptionDiscount([flatHalf, courtCoPay], oneTime)?.amountMinor, 150000);
  assert.equal(subscriptionEventQuoteAmountMinor(flatHalf), 200000);
  assert.equal(isSubscriptionEventDiscountQuote(courtCoPay, "TOURNAMENT_SUBSCRIPTION_DISCOUNT_V1",
    "group", "actor", now), false);
  // Identity and freshness stay enforced for the new kind too.
  for (const delta of [{ actorClientId: "other" }, { exerciseId: "other" }, { expiresAt: now - 1 },
    { evaluatedAt: now + 6000 }, { subscriptionName: "" }, { productId: "" }, { status: "LIMIT_USED" },
    { durationMinutes: 0 }, { basePriceMinor: 0 }]) {
    assert.equal(isGroupSubscriptionDiscountQuote({ ...courtCoPay, ...delta }, "group", "actor", now), false,
      JSON.stringify(delta));
  }
  // Tampered variants: a wrong amount, a missing or non-positive court number, a fractional or zero
  // hour count, minutes that do not add up with the event, and a percentage the kind cannot carry.
  for (const delta of [
    { amountMinor: 200000 }, { amountMinor: 600000 },
    { chargeableHours: undefined }, { chargeableHours: 0 }, { chargeableHours: 1.5 },
    { hourlyCourtPriceMinor: undefined }, { hourlyCourtPriceMinor: 0 }, { hourlyCourtPriceMinor: 600000.5 },
    { perHourMinor: undefined }, { perHourMinor: 0 }, { perHourMinor: 200000 },
    { freeMinutes: undefined }, { paidMinutes: undefined }, { freeMinutes: 0 }, { paidMinutes: 30 },
    { paidMinutes: 90 },
    { discountPercent: 50 },
  ]) {
    assert.equal(isGroupSubscriptionDiscountQuote({ ...courtCoPay, ...delta }, "group", "actor", now), false,
      JSON.stringify(delta));
  }
  // The same numbers under the percentage kind are refused: the flat formula wants 200 000.
  assert.equal(isGroupSubscriptionDiscountQuote({ ...courtCoPay, kind: "GROUP_TRAINING_SUBSCRIPTION_DISCOUNT_V1" },
    "group", "actor", now), false);
});


test("equal automatic group prices have stable instance selection and ignore unavailable quotes", () => {
  const product = { id: quote.productId, cost: quote.basePriceMinor, source: "one-time" };
  const tie = { ...quote, subscriptionId: "000-first" };
  const unavailable = { ...quote, subscriptionId: "bad", status: "UNAVAILABLE" as const, amountMinor: null };
  assert.equal(matchGroupSubscriptionDiscount([quote, tie, unavailable], product), tie);
  assert.equal(matchGroupSubscriptionDiscount([unavailable, tie, quote], product), tie);
});
