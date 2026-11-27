import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gameBookingOptions, eventBookingOptions, pilotGamePricePreview } from "../../src/lk-pilot/bookingOptionPresentation.ts";
import type { SubscriptionPricePreview } from "../../src/components/games/subscriptionPricePreview.ts";
import type { SubscriptionEventDiscountQuote } from "../../src/utils/groupSubscriptionDiscount.ts";
import { SUBSCRIPTION_CATEGORY_LIMIT_PRODUCT_IDS } from "../../src/utils/subscriptionCategoryDailyLimit.ts";
import { sanitizeSubscriptionSnapshot } from "../../src/utils/subscriptionSnapshotData.ts";
import { isolateBookingPilot } from "./vite.config.ts";
import { addPilotGameResidencyCandidates } from "../../src/lk-pilot/gameResidencyCandidates.ts";
import { filterSplitCategoryCompatibleSubscriptions, filterSplitEligibleSubscriptions } from "../../src/components/games/splitSubscriptionAvailability.ts";
import { RESIDENCY_LIFECYCLE_PRODUCT_ID } from "../../src/residency/residencyLifecycleClient.ts";

test("pilot game creation keeps one payment selector and keeps game join separate", async () => {
  const path = fileURLToPath(new URL("../../src/components/games/GamesPage.tsx", import.meta.url));
  const source = await readFile(path, "utf8");
  const hook = isolateBookingPilot().transform;
  assert.equal(typeof hook, "function");
  const transformed = Reflect.apply(hook as CallableFunction, undefined, [source, path]);
  assert.equal(typeof transformed, "string");
  assert.equal([...transformed.matchAll(/<BookingOptions\b/g)].length, 2);
  assert.equal([...transformed.matchAll(/<BookingOptions category="game" title="Создание игры"/g)].length, 1);
  assert.match(transformed, /<BookingOptions category="game" title="Запись на игру"/);
  assert.match(transformed, /gameBookingOptions\(detailsSplitSubscriptionOptions,[^)]*,\s*detailsSplitSubscriptions\)/);
  assert.match(transformed, /gameBookingOptions\(splitSubscriptionPaymentOptions,[^)]*,\s*splitSubscriptions\)/);
  assert.match(transformed, /preview=\{pilotGamePricePreview\(publicSplitPricePreview, splitSubscriptionPaymentOptions, splitSubscriptions\)\}/);
  assert.doesNotMatch(transformed, /className="team-card game-create-payment-method-card"/);
  assert.match(transformed, /addPilotGameResidencyCandidates\(filterSplitEligibleSubscriptions\(/);
  assert.match(transformed, /addPilotGameResidencyCandidates\(filterSplitCategoryCompatibleSubscriptions\(/);
});

test("training and tournament details use the shared event presentation", async () => {
  const hook = isolateBookingPilot().transform as CallableFunction;
  for (const [directory, filename, category] of [
    ["group-schedule", "GroupSchedulePage.tsx", "training"],
    ["tournament-signup", "TournamentSignupPage.tsx", "tournament"],
  ]) {
    const path = fileURLToPath(new URL(`../../src/components/${directory}/${filename}`, import.meta.url));
    const transformed = Reflect.apply(hook, undefined, [await readFile(path, "utf8"), path]);
    assert.equal([...transformed.matchAll(/<BookingOptions\b/g)].length, 1);
    assert.ok(transformed.includes(`<BookingOptions category="${category}"`));
    assert.match(transformed, /eventBookingOptions\(checkout\?\.oneTimes/);
  }
});

test("the pilot forwards an active residency with Viva's tournament-only product type to the game quote", () => {
  const owned = sanitizeSubscriptionSnapshot({content: [
    { subscriptionId: "10000000-0000-4000-8000-000000000001", productId: RESIDENCY_LIFECYCLE_PRODUCT_ID, status: "ACTIVE", name: 12,
      expirationDate: "2026-12-10", visitsLeft: 0, hasTypeLimitation: true, availableTypes: [{ id: 839 }] },
    { subscriptionId: "10000000-0000-4000-8000-000000000002", status: "ACTIVE",
      expirationDate: "2026-12-10", visitsLeft: 0, hasTypeLimitation: true, availableTypes: [{ id: "839" }] },
    { subscriptionId: "10000000-0000-4000-8000-000000000003", productId: "different-product", status: "ACTIVE",
      expirationDate: "2026-12-10", visitsLeft: 0, hasTypeLimitation: true, availableTypes: [{ id: 839 }] },
    { subscriptionId: "10000000-0000-4000-8000-000000000004", productId: RESIDENCY_LIFECYCLE_PRODUCT_ID,
      expirationDate: "2026-11-25", status: "ACTIVE" },
    { subscriptionId: "10000000-0000-4000-8000-000000000005", productId: RESIDENCY_LIFECYCLE_PRODUCT_ID,
      expirationDate: "2026-12-10", status: "ACTIVE", holdUntil: "2026-12-01" },
    { subscriptionId: "10000000-0000-4000-8000-000000000006", productId: 1, status: "ACTIVE",
      expirationDate: "2026-12-10", hasTypeLimitation: true, availableTypes: [{ id: 839 }] },
    { subscriptionId: "10000000-0000-4000-8000-000000000007", status: "ACTIVE",
      subscription: { product: { uuid: "10000000-0000-4000-8000-000000000099" } },
      expirationDate: "2026-12-10", hasTypeLimitation: true, availableTypes: [{ id: 839 }] },
  ] });
  assert.ok(owned);
  const day = "2026-11-27";
  const time = Date.parse("2026-11-26T16:00:00+03:00");
  const types = new Set(["1613"]), directions = new Set(["4588"]);
  const { content } = owned;
  const create = filterSplitEligibleSubscriptions(content, types, directions, null, 1, 60, day);
  const join = filterSplitCategoryCompatibleSubscriptions(content, types, directions, null);
  assert.deepEqual([create, join], [[], []]);
  for (const selected of [create, join]) {
    const candidates = addPilotGameResidencyCandidates(selected, content, day, time);
    assert.deepEqual(candidates.map(row => row.subscriptionId), [content[0].subscriptionId]);
  }
  const [verified] = addPilotGameResidencyCandidates([], content, day, time);
  assert.equal(verified.name, "Резидентство ПадлхАБ");
  const [expired, legacy] = addPilotGameResidencyCandidates([content[3]], content.slice(1), day, time);
  assert.equal(expired, content[3]);
  assert.equal(legacy.name, undefined);
  assert.equal(legacy, content[1]);
  const competingLegacy = { ...content[1], subscriptionId: "10000000-0000-4000-8000-000000000008" };
  assert.deepEqual(addPilotGameResidencyCandidates([], [content[1], competingLegacy], day, time), []);
  assert.deepEqual(addPilotGameResidencyCandidates([verified], [legacy], day, time), [verified]);
  const full = Array.from({length: 20}, (_, index) => ({
    ...content[3], subscriptionId: `10000000-0000-4000-8000-${String(20 + index).padStart(12, "0")}`,
  }));
  assert.equal(addPilotGameResidencyCandidates(full, [verified, legacy], day, time), full);
});

test("both game selectors name a verified residency, even when Viva sends a generic name", () => {
  const subscriptionId = "residency";
  const subscriptions = [{ subscriptionId, name: "Абонемент" }];
  const price: SubscriptionPricePreview = {
    state: "available", label: "По подписке от 2 100 ₽", detail: "Доплата за 90 мин",
    amountMinor: 210_000, basePriceMinor: 300_000, paidMinutes: 90, discounted: true,
    confirmedSubscriptionId: subscriptionId,
  };
  const cases = [
    { quote: { ...price, appliedSubscriptionProductId: RESIDENCY_LIFECYCLE_PRODUCT_ID }, owned: [] },
    { quote: price, owned: [{ subscriptionId, product: { id: RESIDENCY_LIFECYCLE_PRODUCT_ID } }] },
  ];
  for (const { quote, owned } of cases) {
    assert.deepEqual(gameBookingOptions(subscriptions, { [subscriptionId]: quote }, 90, owned).options, [{
      id: subscriptionId, name: "Резидентство ПадлхАБ", amountMinor: 210_000, basePriceMinor: 300_000,
      benefit: "Скидка 30% на запись",
    }]);
    const firstStep = pilotGamePricePreview(quote, subscriptions, owned);
    assert.match(firstStep.label, /^Резидентство ПадлхАБ · от 2\s100,00\s₽$/u);
    assert.equal(firstStep.detail, null);
  }
  // The same amount or the presence of a different residency on the account is not product evidence.
  const otherResidency = [{ subscriptionId: "other", productId: RESIDENCY_LIFECYCLE_PRODUCT_ID }];
  assert.equal(gameBookingOptions(subscriptions, { [subscriptionId]: price }, 90, otherResidency).options[0].name, "По подписке");
  assert.equal(pilotGamePricePreview(price, subscriptions, otherResidency), price);
  const ambiguousName = [{ subscriptionId, name: "Резидентство" }];
  const foreignProduct = [{ subscriptionId, productId: "other-product" }];
  assert.equal(gameBookingOptions(ambiguousName, { [subscriptionId]: price }, 90, foreignProduct).options[0].name, "По подписке");
  const denied = { ...price, state: "unavailable" as const, amountMinor: null };
  assert.deepEqual(gameBookingOptions(subscriptions, { [subscriptionId]: denied }, 90).options, []);
});

test("game methods show named, confirmed subscriptions and explain the free time, co-pay and limit", () => {
  const quote: SubscriptionPricePreview = {
    state: "available", label: "По подписке", detail: null,
    amountMinor: 0, basePriceMinor: 200_000, paidMinutes: 0, discounted: true,
  };
  const result = gameBookingOptions([
    { subscriptionId: "included", name: "Подписка с бесплатной записью" },
    { subscriptionId: "copay", name: "Подписка с доплатой" },
    { subscriptionId: "limited", name: "Подписка с лимитом" },
    { subscriptionId: "unquoted", name: "Без котировки" },
  ], {
    included: quote,
    copay: { ...quote, amountMinor: 50_000, paidMinutes: 30 },
    limited: { ...quote, state: "limit-used", amountMinor: null, label: "Лимит по подписке исчерпан" },
  }, 90);
  assert.deepEqual(result.options.map(({ name, benefit, basePriceMinor }) => [name, benefit, basePriceMinor]), [
    ["Подписка с бесплатной записью", "Участие по подписке без доплаты", 200_000],
    ["Подписка с доплатой", "60 мин бесплатно · доплата за 30 мин", 200_000],
  ]);
  assert.deepEqual(result.explanations, ["Подписка с лимитом · Лимит по подписке исчерпан"]);
});

test("event methods use the server's discount and suppress expired quotes", () => {
  const quote: SubscriptionEventDiscountQuote = {
    kind: "TOURNAMENT_SUBSCRIPTION_DISCOUNT_V1", exerciseId: "event", actorClientId: "synthetic",
    subscriptionId: "active", subscriptionName: "Резидентство", productId: "event-ticket",
    status: "AVAILABLE", basePriceMinor: 200_000, amountMinor: 100_000, discountPercent: 50,
    startsAt: "2026-11-25T20:00:00+03:00", durationMinutes: 90, evaluatedAt: 100, expiresAt: 200,
  };
  const result = eventBookingOptions([
    { id: "event-ticket", name: "Разовая запись", source: "one-time", cost: 200_000 },
  ], [quote, { ...quote, subscriptionId: "old", expiresAt: 150 }, {
    ...quote, subscriptionId: "limited", subscriptionName: "Подписка с лимитом",
    status: "LIMIT_USED", amountMinor: null,
  }], 150);
  assert.deepEqual(result.options.map(({ id, name, benefit }) => [id, name, benefit]), [
    ["tariff:event-ticket", "Разовая", undefined],
    ["quote:active:event-ticket", "Резидентство ПадлхАБ", "Скидка 50% на запись"],
  ]);
  assert.deepEqual(result.explanations, ["Подписка с лимитом · Лимит исчерпан"]);
});

test("training shows the one-time tariff and only the subscription that actually discounts the event", () => {
  const tariff = { id: "training-ticket", name: "Разовая🎾", source: "one-time", cost: 550_000 };
  const residency: SubscriptionEventDiscountQuote = {
    kind: "GROUP_TRAINING_SUBSCRIPTION_DISCOUNT_V1", exerciseId: "training", actorClientId: "synthetic",
    subscriptionId: "residency", subscriptionName: "Резидентство ПадлхАБ", productId: tariff.id,
    status: "AVAILABLE", basePriceMinor: 550_000, amountMinor: 275_000, discountPercent: 50,
    startsAt: "2026-11-26T15:00:00+03:00", durationMinutes: 60, evaluatedAt: 100, expiresAt: 200,
  };
  const kids = { ...residency, subscriptionId: "kids", subscriptionName: "Падл.Дети", amountMinor: 550_000, discountPercent: 0 };
  const friendship = { ...residency, subscriptionId: "friendship", subscriptionName: "Падел.Дружба 2.0" };
  const methods = (quotes: SubscriptionEventDiscountQuote[]) => eventBookingOptions([tariff], quotes, 150)
    .options.map(({ name, amountMinor }) => [name, amountMinor]);

  assert.deepEqual(methods([kids, residency, friendship]), [["Разовая", 550_000], ["Падел.Дружба 2.0", 275_000]]);
  assert.deepEqual(eventBookingOptions([tariff], [residency, friendship], 150, true).options
    .map(({ name, amountMinor }) => [name, amountMinor]), [["Разовая", 550_000], ["Падел.Дружба 2.0", 275_000]]);
  assert.deepEqual(eventBookingOptions([tariff], [residency], 150, true).options
    .map(({ name, amountMinor }) => [name, amountMinor]), [["Разовая", 550_000]]);
  for (const unusable of [
    kids,
    { ...friendship, expiresAt: 150 },
    { ...friendship, status: "LIMIT_USED" as const, amountMinor: null },
    { ...friendship, productId: "other-ticket" },
    { ...friendship, basePriceMinor: 450_000 },
  ]) {
    assert.deepEqual(methods([residency, unusable]), [["Разовая", 550_000], ["Резидентство ПадлхАБ", 275_000]]);
  }
  assert.deepEqual(methods([]), [["Разовая", 550_000]]);

  const otherTariff = { id: "premium", name: "Премиум", source: "one-time", cost: 650_000 };
  const otherResidency = { ...residency, productId: otherTariff.id, basePriceMinor: 650_000, amountMinor: 325_000 };
  const result = eventBookingOptions([tariff, otherTariff], [residency, friendship, otherResidency], 150);
  assert.deepEqual(result.options.map(option => [option.name, option.amountMinor]), [
    ["Разовая", 550_000], ["Премиум", 650_000], ["Падел.Дружба 2.0", 275_000], ["Резидентство ПадлхАБ", 325_000],
  ]);
});

test("second game with a confirmed discounted quarter shows 30% and 2,800 rubles", () => {
  const quote: SubscriptionPricePreview = {
    state: "available", label: "По подписке", detail: "Доплата за 120 мин",
    amountMinor: 280_000, basePriceMinor: 400_000, paidMinutes: 120, discounted: true,
  };
  const result = gameBookingOptions([{ subscriptionId: "owned", name: "Дружба 2.0" }], { owned: quote }, 120);
  assert.deepEqual(result.options, [{
    id: "owned", name: "По подписке Дружба2.0", amountMinor: 280_000, basePriceMinor: 400_000,
    benefit: "Скидка 30% на запись",
  }]);
  const ambiguous = gameBookingOptions([{ subscriptionId: "owned", name: "Дружба 2.0" }],
    { owned: { ...quote, amountMinor: 280_001 } }, 120);
  assert.equal(ambiguous.options[0]?.benefit, "Применена скидка подписки");
});

test("the pilot labels the owned Friendship 2.0 product even when Viva omits its name", () => {
  const quote: SubscriptionPricePreview = {
    state: "available", label: "По подписке", detail: "Доплата за 120 мин",
    amountMinor: 280_000, basePriceMinor: 400_000, paidMinutes: 120, discounted: true,
  };
  const owned = sanitizeSubscriptionSnapshot({ content: [
    { subscriptionId: "v2", product: { id: SUBSCRIPTION_CATEGORY_LIMIT_PRODUCT_IDS.friendship_two_hours } },
    { subscriptionId: "legacy", productId: SUBSCRIPTION_CATEGORY_LIMIT_PRODUCT_IDS.friendship },
    { subscriptionId: "other", name: "Другая подписка" },
  ] });
  assert.ok(owned);
  const result = gameBookingOptions([
    { subscriptionId: "v2", name: "Абонемент" },
    { subscriptionId: "legacy", name: "Абонемент" },
    { subscriptionId: "other", name: "Другая подписка" },
  ], { v2: quote, legacy: quote, other: quote }, 120, owned.content);
  assert.deepEqual(result.options.map(({ name, amountMinor }) => [name, amountMinor]), [
    ["По подписке Дружба2.0", 280_000],
    ["По подписке", 280_000],
    ["Другая подписка", 280_000],
  ]);
});
