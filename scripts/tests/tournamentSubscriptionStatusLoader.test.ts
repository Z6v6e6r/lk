import assert from "node:assert/strict";
import test from "node:test";

import { loadTournamentSubscriptionStatuses } from "../../src/utils/tournamentSubscriptionStatusLoader.ts";

interface StatusStub {
  counterKey: string;
  dailyCapEnabled?: boolean;
  remainingCount: number;
  totalLimit: number;
}

test("default storefront explicitly loads and merges the HAB daily counter", async () => {
  const calls: Array<{ counterKey?: string | null; planType?: string | null } | undefined> = [];
  const aggregateStatuses: StatusStub[] = [
    { counterKey: "friendship", remainingCount: 150, totalLimit: 150 },
    { counterKey: "ra", remainingCount: 150, totalLimit: 150 },
  ];
  const habStatus: StatusStub = {
    counterKey: "network_friendship",
    dailyCapEnabled: true,
    remainingCount: 10,
    totalLimit: 10,
  };

  const result = await loadTournamentSubscriptionStatuses<StatusStub>(
    [
      { counterKey: "friendship", planId: "friendship" },
      { counterKey: "ra" },
      { counterKey: "network_friendship" },
      { counterKey: "network_friendship" },
    ],
    async (params) => {
      calls.push(params);
      if (params?.counterKey === "network_friendship") {
        return { data: [habStatus], error: null };
      }
      return { data: aggregateStatuses, error: null };
    },
  );

  assert.deepEqual(calls, [
    undefined,
    { counterKey: "network_friendship", planType: null },
  ]);
  assert.deepEqual(result.explicitCounterKeys, ["network_friendship"]);
  assert.deepEqual(result.failedExplicitCounterKeys, []);
  assert.deepEqual(result.statuses, [habStatus, ...aggregateStatuses]);
  assert.equal(result.statuses[0]?.dailyCapEnabled, true);
  assert.equal(result.statuses[0]?.remainingCount, 10);
  assert.equal(result.statuses[0]?.totalLimit, 10);
});

test("an unavailable explicit HAB status is reported while aggregate statuses are preserved", async () => {
  const aggregateStatuses: StatusStub[] = [
    { counterKey: "friendship", remainingCount: 150, totalLimit: 150 },
  ];

  const result = await loadTournamentSubscriptionStatuses<StatusStub>(
    [
      { counterKey: "friendship", planId: "friendship" },
      { counterKey: "network_friendship" },
    ],
    async (params) => params?.counterKey === "network_friendship"
      ? { data: null, error: new Error("unavailable") }
      : { data: aggregateStatuses, error: null },
  );

  assert.deepEqual(result.statuses, aggregateStatuses);
  assert.deepEqual(result.failedExplicitCounterKeys, ["network_friendship"]);
});

test("an aggregate failure is preserved while a successful explicit HAB status remains usable", async () => {
  const aggregateError = new Error("aggregate unavailable");
  const habStatus: StatusStub = {
    counterKey: "network_friendship",
    dailyCapEnabled: true,
    remainingCount: 10,
    totalLimit: 10,
  };

  const result = await loadTournamentSubscriptionStatuses<StatusStub, Error | null>(
    [{ counterKey: "network_friendship" }],
    async (params) => params?.counterKey === "network_friendship"
      ? { data: [habStatus], error: null }
      : { data: null, error: aggregateError },
  );

  assert.equal(result.aggregateResult.error, aggregateError);
  assert.deepEqual(result.failedExplicitCounterKeys, []);
  assert.deepEqual(result.statuses, [habStatus]);
});

test("an explicit HAB status stays ahead of a stale aggregate duplicate", async () => {
  const exactHabStatus: StatusStub = {
    counterKey: "network_friendship",
    dailyCapEnabled: true,
    remainingCount: 10,
    totalLimit: 10,
  };
  const staleAggregateStatus: StatusStub = {
    counterKey: "network_friendship",
    remainingCount: 95,
    totalLimit: 100,
  };

  const result = await loadTournamentSubscriptionStatuses<StatusStub>(
    [{ counterKey: "network_friendship" }],
    async (params) => params?.counterKey === "network_friendship"
      ? { data: [exactHabStatus], error: null }
      : { data: [staleAggregateStatus], error: null },
  );

  assert.deepEqual(result.statuses, [exactHabStatus, staleAggregateStatus]);
});
