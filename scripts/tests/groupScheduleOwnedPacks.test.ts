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
    product({ id: "dfa72adf-233b-4285-8d69-e5eab4234fbe", name: "Энергия 5 🎾 Селигерская Акционная" }),
    product({ id: "client-energy-25", name: "Неизвестное имя", raw: { productId: "9fb759fd-f70c-4395-84e7-57716df97e14" } }),
    product({ id: "client-ra", name: "Лето.Падел.РА" }),
  ]);

  assert.deepEqual(owned.map(item => item.id), [
    "dfa72adf-233b-4285-8d69-e5eab4234fbe",
    "client-energy-25",
  ]);
});

test("PRO booking does not expose exhausted Energy packs", () => {
  const owned = getGroupScheduleOwnedPacks([
    product({ id: "dfa72adf-233b-4285-8d69-e5eab4234fbe", name: "Энергия 5", raw: { visitsLeft: 0 } }),
  ]);

  assert.equal(owned.length, 0);
});
