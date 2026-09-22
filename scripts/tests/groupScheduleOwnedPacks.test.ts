import assert from "node:assert/strict";
import test from "node:test";

import { getGroupScheduleOwnedPacks } from "../../src/utils/groupScheduleOwnedPacks.ts";

const product = (overrides: Record<string, unknown> = {}) => ({
  id: "client-subscription",
  name: "Продукт Viva",
  type: "SUBSCRIPTION" as const,
  cost: null,
  visitsTotal: 5,
  source: "client-subscription" as const,
  raw: {},
  ...overrides,
});

test("PRO booking exposes owned Energy packs with station and promo suffixes", () => {
  const owned = getGroupScheduleOwnedPacks([
    product({ id: "owned-five", name: "Энергия 5 🎾 Селигерская Акционная", raw: { productId: "dfa72adf-233b-4285-8d69-e5eab4234fbe" } }),
    product({ id: "client-energy-25", name: "Неизвестное имя", raw: { productId: "9fb759fd-f70c-4395-84e7-57716df97e14" } }),
    product({ id: "client-ra", name: "Лето.Падел.РА" }),
  ]);

  assert.deepEqual(owned.map(item => item.id), [
    "owned-five",
    "client-energy-25",
  ]);
});

test("PRO booking does not expose exhausted Energy packs", () => {
  const owned = getGroupScheduleOwnedPacks([
    product({ id: "dfa72adf-233b-4285-8d69-e5eab4234fbe", name: "Энергия 5", raw: { visitsLeft: 0 } }),
  ]);

  assert.equal(owned.length, 0);
});

// The UI must never offer a PRO option the server's catalog guard refuses.
// @ts-expect-error Server source is JavaScript and is intentionally imported for parity.
import { isProTrainingEnergyPack } from "../lib/proTrainingExclusion.mjs";

test("Energy catalog identity stays compatible with the server guard", () => {
  const energyId = "dfa72adf-233b-4285-8d69-e5eab4234fbe";
  const rows = [
    { name: "Энергия 5", visitsLeft: 2 },
    { name: "Energy 25", visitsLeft: 2 },
    { name: "Энергия 5 Селигерская Акционная", visitsLeft: 2 },
    { name: "Энергия 5", productId: "other-product", visitsLeft: 2 },
    { name: "Продукт Viva", product: { id: energyId }, visitsLeft: 2 },
    { name: "Продукт Viva", subscriptionProductId: energyId, visitsLeft: 2 },
    { name: "Продукт Viva", templateId: energyId, visitsLeft: 2 },
    { name: "Продукт Viva", subscription: { productId: energyId }, visitsLeft: 2 },
    { name: "Продукт Viva", id: energyId, visitsLeft: 2 },
    { name: "Энергия 5", productId: energyId, product: { id: "other-product" }, visitsLeft: 2 },
    { name: "Энергия 50", visitsLeft: 2 },
    { name: "РА", visitsLeft: 2 },
    { name: "Энергия 5", visitsLeft: 0 },
  ];
  for (const raw of rows) {
    assert.equal(getGroupScheduleOwnedPacks([product({ name: raw.name, raw })]).length > 0,
      isProTrainingEnergyPack(raw), JSON.stringify(raw));
  }
});
