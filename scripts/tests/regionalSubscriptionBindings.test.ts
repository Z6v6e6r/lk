import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const bindings = JSON.parse(fs.readFileSync(
  "architecture-workspace/evidence/subscriptions/REGIONAL_SUBSCRIPTION_BINDINGS.draft.json",
  "utf8",
)) as {
  status: string;
  salesEnabled: boolean;
  usageEnabled: boolean;
  storefronts: Array<{
    counterKey: string;
    inventoryId: string;
    batchSize: number;
    tierPricesMinor: number[];
    providerProductIds: Array<string | null>;
    subscriptionTypeId: string | null;
    stationSelector: { kind: string; stationIds: string[] };
  }>;
  policyDraft: {
    dailyUsageLimit: number;
    createGame: { durationsMinutes: number[] };
    joinGame: { durationsMinutes: number[] };
    createGameAddOnRules: unknown;
    groupTrainingBenefitRules: unknown;
    tournamentBenefitRules: unknown;
    failClosedWhenRuleMissing: boolean;
  };
};

const byCounterKey = new Map(bindings.storefronts.map((row) => [row.counterKey, row]));

test("regional binding draft stays fail closed until Viva products and policy types exist", () => {
  assert.equal(bindings.status, "DRAFT_ONLY");
  assert.equal(bindings.salesEnabled, false);
  assert.equal(bindings.usageEnabled, false);
  assert.deepEqual([...byCounterKey.keys()].sort(), [
    "kotelniki_friendship",
    "network_friendship",
    "piter_friendship",
  ]);
  for (const storefront of bindings.storefronts) {
    assert.equal(storefront.subscriptionTypeId, null);
    assert.equal(storefront.providerProductIds.length, storefront.tierPricesMinor.length);
    assert.equal(storefront.providerProductIds.every((productId) => productId === null), true);
  }
});

test("regional station selectors use verified Viva station IDs", () => {
  assert.deepEqual(byCounterKey.get("piter_friendship")?.stationSelector, {
    kind: "STATION_LIST",
    stationIds: ["1ea77cbf-bc36-49a1-96d6-f35c216a409b"],
  });
  assert.deepEqual(byCounterKey.get("kotelniki_friendship")?.stationSelector, {
    kind: "STATION_LIST",
    stationIds: ["3b52e87f-33bb-436b-a1e3-19a3b62b4ed2"],
  });
  assert.deepEqual(byCounterKey.get("network_friendship")?.stationSelector, {
    kind: "ALL_STATIONS",
    stationIds: [],
  });
});

test("regional DRAFT preserves requested rules without inventing discounts", () => {
  assert.equal(bindings.policyDraft.dailyUsageLimit, 1);
  assert.deepEqual(bindings.policyDraft.createGame.durationsMinutes, [60]);
  assert.deepEqual(bindings.policyDraft.joinGame.durationsMinutes, [60, 90, 120]);
  assert.equal(bindings.policyDraft.createGameAddOnRules, null);
  assert.equal(bindings.policyDraft.groupTrainingBenefitRules, null);
  assert.equal(bindings.policyDraft.tournamentBenefitRules, null);
  assert.equal(bindings.policyDraft.failClosedWhenRuleMissing, true);
});
