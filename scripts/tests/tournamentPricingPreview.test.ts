import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTournamentPromoOnlyOfferFromProducts,
  buildTournamentPricingPreviewFromProducts,
  hasPromoOnlyTournamentProducts,
  normalizeTournamentPricingPreviewSnapshot,
  normalizeTournamentPromoOnlyOfferSnapshot,
} from "../../src/utils/tournamentPricingPreview.ts";

test("builds full trigger label for multi-visit energy product", () => {
  const preview = buildTournamentPricingPreviewFromProducts([
    {
      id: "energy-25",
      name: "Энергия 25",
      type: "SUBSCRIPTION",
      cost: 9700000,
      visitsTotal: 25,
      source: "subscription",
      raw: {},
    },
  ]);

  assert.equal(preview?.triggerLabel, "97 000 ₽");
  assert.deepEqual(preview?.rows, [
    {
      id: "subscription-energy-25",
      label: "Энергия 25",
      value: "97 000 ₽ / 25 посещ.",
    },
  ]);
});

test("filters promo-only summer subscription from public tournament preview and keeps minimum full price label", () => {
  const preview = buildTournamentPricingPreviewFromProducts([
    {
      id: "promo-sport",
      name: "Лето.Падел.Спорт",
      type: "SUBSCRIPTION",
      cost: 0,
      visitsTotal: 30,
      source: "subscription",
      raw: {},
    },
    {
      id: "energy-one-time",
      name: "Энергия 🎾",
      type: "SERVICE",
      cost: 550000,
      visitsTotal: null,
      source: "one-time",
      raw: {},
    },
  ]);

  assert.equal(preview?.triggerLabel, "5 500 ₽");
  assert.deepEqual(preview?.rows, [
    {
      id: "one-time-energy-one-time",
      label: "Энергия 🎾",
      value: "5 500 ₽ / 1 посещение",
    },
  ]);
});

test("uses custom tournament price label for full trigger", () => {
  const preview = buildTournamentPricingPreviewFromProducts([
    {
      id: "custom-energy",
      name: "Энергия турниры",
      type: "SUBSCRIPTION",
      cost: 490000,
      visitsTotal: null,
      source: "custom-tournament-energy",
      raw: {},
      priceLabel: "4 900 ₽",
      targetAmount: 4900,
      isCustomTournamentEnergy: true,
    },
  ]);

  assert.equal(preview?.triggerLabel, "4 900 ₽");
  assert.deepEqual(preview?.rows, [
    {
      id: "custom-tournament-energy-custom-energy",
      label: "Энергия турниры",
      value: "4 900 ₽",
    },
  ]);
});

test("detects promo-only summer subscription products for tournament friendly tag", () => {
  assert.equal(hasPromoOnlyTournamentProducts([
    {
      id: "promo-sport",
      name: "Лето.Падел.Спорт",
      type: "SUBSCRIPTION",
      cost: 0,
      visitsTotal: 30,
      source: "subscription",
      raw: {},
    },
  ]), true);

  assert.equal(hasPromoOnlyTournamentProducts([
    {
      id: "energy-5",
      name: "Энергия 5",
      type: "SUBSCRIPTION",
      cost: 1980000,
      visitsTotal: 5,
      source: "subscription",
      raw: {},
    },
  ]), false);
});

test("builds promo-only summer subscription offer for tournament popover CTA", () => {
  const offer = buildTournamentPromoOnlyOfferFromProducts([
    {
      id: "promo-sport",
      name: "Лето.Падел.Спорт",
      type: "SUBSCRIPTION",
      cost: 1980000,
      visitsTotal: 30,
      source: "subscription",
      raw: {},
    },
    {
      id: "energy-5",
      name: "Энергия 5",
      type: "SUBSCRIPTION",
      cost: 1980000,
      visitsTotal: 5,
      source: "subscription",
      raw: {},
    },
  ]);

  assert.deepEqual(offer, {
    id: "subscription-promo-sport",
    label: "Лето.Падел.Спорт",
    value: "19 800 ₽",
  });
});

test("normalizes stored tournament pricing preview snapshot from backend record", () => {
  const preview = normalizeTournamentPricingPreviewSnapshot({
    triggerLabel: "5 500 ₽",
    rows: [
      {
        id: "energy-one-time",
        label: "Энергия 🎾",
        value: "5 500 ₽ / 1 посещение",
      },
    ],
  });

  assert.deepEqual(preview, {
    triggerLabel: "5 500 ₽",
    rows: [
      {
        id: "energy-one-time",
        label: "Энергия 🎾",
        value: "5 500 ₽ / 1 посещение",
      },
    ],
  });
});

test("normalizes stored promo-only offer snapshot from backend record", () => {
  const offer = normalizeTournamentPromoOnlyOfferSnapshot({
    id: "summer-sport",
    label: "Лето.Падел.Спорт",
    value: "19 800 ₽",
  });

  assert.deepEqual(offer, {
    id: "summer-sport",
    label: "Лето.Падел.Спорт",
    value: "19 800 ₽",
  });
});
