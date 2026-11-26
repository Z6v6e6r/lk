import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gameBookingOptions, eventBookingOptions } from "../../src/lk-pilot/bookingOptionPresentation.ts";
import { subscriptionPricePreviewsById, type SubscriptionPricePreview } from "../../src/components/games/subscriptionPricePreview.ts";
import type { SubscriptionEventDiscountQuote } from "../../src/utils/groupSubscriptionDiscount.ts";
import { SUBSCRIPTION_CATEGORY_LIMIT_PRODUCT_IDS } from "../../src/utils/subscriptionCategoryDailyLimit.ts";
import { sanitizeSubscriptionSnapshot } from "../../src/utils/subscriptionSnapshotData.ts";
import { isolateBookingPilot } from "./vite.config.ts";

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
  assert.doesNotMatch(transformed, /className="team-card game-create-payment-method-card"/);
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
  assert.deepEqual(result.options.map(({ id, benefit }) => [id, benefit]), [
    ["tariff:event-ticket", undefined], ["quote:active:event-ticket", "Скидка 50% на запись"],
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
    id: "owned", name: "по Подписке Дружба2.0", amountMinor: 280_000, basePriceMinor: 400_000,
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
    ["по Подписке Дружба2.0", 280_000],
    ["По подписке", 280_000],
    ["Другая подписка", 280_000],
  ]);
});

test("a free game entry shows Friendship 2.0 from the confirmed quote even with a generic provider label", () => {
  const price = {
    selectionKey: "current-game", status: "AVAILABLE" as const, basePriceMinor: 400_000, amountMinor: 0,
    freeMinutes: 120, paidMinutes: 0, reasonCode: "ALLOWED", evaluatedAt: 100, expiresAt: 200,
  };
  const productIds = SUBSCRIPTION_CATEGORY_LIMIT_PRODUCT_IDS;
  const previews = subscriptionPricePreviewsById({
    selectionKey: price.selectionKey, durationMinutes: 120, subscriptionIds: ["v2", "other", "unknown"],
    quotes: [
      { ...price, subscriptionId: "v2", subscriptionProductId: productIds.friendship_two_hours.toUpperCase() },
      { ...price, subscriptionId: "other", subscriptionProductId: productIds.friendship },
      { ...price, subscriptionId: "unknown" },
    ],
    loading: false, now: 150,
  });
  const owned = [{ subscriptionId: "other", name: "Дружба 2 часа" }];
  const result = gameBookingOptions([
    { subscriptionId: "v2", name: "Абонемент" },
    { subscriptionId: "other", name: "Другая подписка" },
    { subscriptionId: "unknown", name: "Абонемент" },
  ], previews, 120, owned);
  assert.deepEqual(result.options, [
    { id: "v2", name: "по Подписке Дружба2.0", amountMinor: 0, basePriceMinor: 400_000, benefit: "Участие по подписке без доплаты" },
    { id: "other", name: "Другая подписка", amountMinor: 0, basePriceMinor: 400_000, benefit: "Участие по подписке без доплаты" },
    { id: "unknown", name: "По подписке", amountMinor: 0, basePriceMinor: 400_000, benefit: "Участие по подписке без доплаты" },
  ]);
});
