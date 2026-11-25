import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gameBookingOptions, eventBookingOptions } from "../../src/lk-pilot/bookingOptionPresentation.ts";
import type { SubscriptionPricePreview } from "../../src/components/games/subscriptionPricePreview.ts";
import type { SubscriptionEventDiscountQuote } from "../../src/utils/groupSubscriptionDiscount.ts";
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

test("second game with a confirmed discounted quarter shows 30% and 2,800 rubles", () => {
  const quote: SubscriptionPricePreview = {
    state: "available", label: "По подписке", detail: "Доплата за 120 мин",
    amountMinor: 280_000, basePriceMinor: 400_000, paidMinutes: 120, discounted: true,
  };
  const result = gameBookingOptions([{ subscriptionId: "owned", name: "Дружба 2.0" }], { owned: quote }, 120);
  assert.deepEqual(result.options, [{
    id: "owned", name: "Дружба 2.0", amountMinor: 280_000, basePriceMinor: 400_000,
    benefit: "Скидка 30% на запись",
  }]);
  const ambiguous = gameBookingOptions([{ subscriptionId: "owned", name: "Дружба 2.0" }],
    { owned: { ...quote, amountMinor: 280_001 } }, 120);
  assert.equal(ambiguous.options[0]?.benefit, "Применена скидка подписки");
});
