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
  salesRuntimeVerifiedAt: string;
  storefronts: Array<{
    counterKey: string;
    inventoryId: string;
    batchSize: number;
    tierPricesMinor: number[];
    providerProductIds: Array<string | null>;
    salesBindingReady: boolean;
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

test("regional binding draft does not activate runtime while live sales bindings are explicit", () => {
  assert.equal(bindings.status, "DRAFT_ONLY");
  assert.equal(bindings.salesEnabled, false);
  assert.equal(bindings.usageEnabled, false);
  assert.equal(bindings.salesRuntimeVerifiedAt, "2026-08-20");
  assert.deepEqual([...byCounterKey.keys()].sort(), [
    "kotelniki_friendship",
    "network_friendship",
    "piter_friendship",
  ]);
  for (const storefront of bindings.storefronts) {
    assert.equal(storefront.subscriptionTypeId, null);
    assert.equal(storefront.providerProductIds.length, storefront.tierPricesMinor.length);
  }

  assert.deepEqual(byCounterKey.get("piter_friendship")?.providerProductIds, Array(4).fill(
    "8bf334ba-3050-4017-b40a-7eef2db1eb16",
  ));
  assert.equal(byCounterKey.get("piter_friendship")?.salesBindingReady, true);
  assert.equal(byCounterKey.get("piter_friendship")?.batchSize, 100);

  assert.deepEqual(byCounterKey.get("network_friendship")?.providerProductIds, [
    "db7a5250-7369-4f43-8ac5-9111be24bc74",
  ]);
  assert.equal(byCounterKey.get("network_friendship")?.salesBindingReady, true);
  assert.equal(byCounterKey.get("network_friendship")?.batchSize, 100);

  assert.deepEqual(byCounterKey.get("kotelniki_friendship")?.providerProductIds, [
    null,
    null,
    null,
    null,
  ]);
  assert.equal(byCounterKey.get("kotelniki_friendship")?.salesBindingReady, false);
  assert.equal(byCounterKey.get("kotelniki_friendship")?.batchSize, 50);
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
