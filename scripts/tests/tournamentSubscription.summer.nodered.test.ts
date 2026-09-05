import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

type NodeRedMsg = Record<string, unknown>;
type GlobalValues = Record<string, unknown>;

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function runNodeRedFunction(file: string, msg: NodeRedMsg, globalValues: GlobalValues = {}) {
  const source = fs.readFileSync(file, "utf8");
  const mergedGlobals = {
    summer_subscription_academy_manual_paid_count: 0,
    summer_subscription_friendship_manual_paid_count: 0,
    summer_subscription_ra_manual_paid_count: 0,
    summer_subscription_sirius_friendship_manual_paid_count: 0,
    summer_subscription_sport_manual_paid_count: 0,
    summer_subscription_ab_leto_20260903_release_enabled: true,
    ...globalValues,
  };
  const globalContext = {
    get(key: string) {
      return Object.prototype.hasOwnProperty.call(mergedGlobals, key)
        ? mergedGlobals[key]
        : undefined;
    },
  };
  const env = {
    get(key: string) {
      return key === "VIVACRM_TOKEN_REQUEST_BODY" ? "test-token-body" : undefined;
    },
  };
  return new Function("msg", "global", "env", source)(msg, globalContext, env);
}

function withFixedNow<T>(nowIso: string, callback: () => T): T {
  const nowTs = Date.parse(nowIso);
  const originalDateNow = Date.now;
  Date.now = () => nowTs;
  try {
    return callback();
  } finally {
    Date.now = originalDateNow;
  }
}

function buildConfirmResolveMessage(overrides: Record<string, unknown> = {}): NodeRedMsg {
  return {
    _summerSubscriptionCtx: {
      action: "confirm",
      step: "resolve_record",
      paymentRef: "payment-ref-1",
    },
    payload: [
      {
        paymentRef: "payment-ref-1",
        campaignKey: "summer_padel_sport_2026",
        planKey: "sport",
        transactionId: "txn-1",
        status: "PAYMENT_PENDING",
        updatedAt: "2026-06-01T07:00:00.000Z",
      },
    ],
    ...overrides,
  };
}

test("summer subscription confirm-resolve takes reservationMinutes from global config", () => {
  const out = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_confirm_resolve.js",
    buildConfirmResolveMessage(),
    {
      summer_subscription_reservation_minutes: 75,
      summer_subscription_http_timeout_ms: 18000,
    },
  ) as unknown[];

  const requestMsg = asRecord(out[0]);
  const requestCtx = asRecord(requestMsg._summerSubscriptionCtx);
  assert.equal(requestMsg.method, "POST");
  assert.equal(requestCtx.step, "token_confirm");
  assert.equal(requestCtx.reservationMinutes, 75);
});

test("summer subscription confirm-resolve keeps default fallbacks when global config is absent or blank", () => {
  for (const globalValues of [
    {},
    {
      summer_subscription_reservation_minutes: "",
      summer_subscription_http_timeout_ms: "",
    },
    {
      summer_subscription_reservation_minutes: "invalid",
      summer_subscription_http_timeout_ms: "invalid",
    },
  ]) {
    const out = runNodeRedFunction(
      "scripts/nodered_games_nodes/fn_tournament_subscription_confirm_resolve.js",
      buildConfirmResolveMessage(),
      globalValues,
    ) as unknown[];

    const requestMsg = asRecord(out[0]);
    const requestCtx = asRecord(requestMsg._summerSubscriptionCtx);
    assert.equal(requestCtx.reservationMinutes, 30);
    assert.equal(requestCtx.httpRequestTimeoutMs, 20000);
    assert.equal(requestMsg.httpRequestTimeout, 20000);
  }
});

test("summer subscription confirm-resolve clamps configured reservation and HTTP timeout", () => {
  const out = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_confirm_resolve.js",
    buildConfirmResolveMessage(),
    {
      summer_subscription_reservation_minutes: 2,
      summer_subscription_http_timeout_ms: 999999,
    },
  ) as unknown[];

  const requestMsg = asRecord(out[0]);
  const requestCtx = asRecord(requestMsg._summerSubscriptionCtx);
  assert.equal(requestCtx.reservationMinutes, 5);
  assert.equal(requestCtx.httpRequestTimeoutMs, 120000);
  assert.equal(requestMsg.httpRequestTimeout, 120000);
});

test("summer subscription confirm-resolve keeps Academy unlimited for legacy pending rows", () => {
  const out = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_confirm_resolve.js",
    {
      _summerSubscriptionCtx: {
        action: "confirm",
        step: "resolve_record",
        counterKey: "academy",
        paymentRef: "academy-payment-ref",
      },
      payload: [
        {
          counterKey: "academy",
          inventoryId: "ab_leto_2026_50_v1",
          paymentRef: "academy-payment-ref",
          productId: "9eb8a7a4-c195-492a-95e4-3fb82899ac10",
          status: "PAYMENT_PENDING",
        },
      ],
    },
  ) as unknown[];

  const requestCtx = asRecord(asRecord(out[1])._summerSubscriptionCtx);
  assert.equal(requestCtx.counterKey, "academy");
  assert.equal(requestCtx.unlimited, true);
});

test("summer subscription confirm-resolve revalidates stale PAID records during reconcile", () => {
  const out = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_confirm_resolve.js",
    {
      _summerSubscriptionCtx: {
        action: "confirm",
        step: "resolve_record",
        reconcile: true,
        paymentRef: "reconcile-payment-ref",
      },
      payload: [
        {
          paymentRef: "reconcile-payment-ref",
          counterKey: "ra",
          inventoryId: "ab_leto_2026_50_v1",
          transactionId: "txn-paid-stale",
          productId: "b91e14d1-fe6e-4d0b-be39-3e45ad86b759",
          status: "PAID",
          updatedAt: "2026-07-05T11:32:41.051Z",
        },
      ],
    },
  ) as unknown[];

  const requestMsg = asRecord(out[0]);
  const requestCtx = asRecord(requestMsg._summerSubscriptionCtx);
  assert.equal(requestCtx.step, "token_confirm");
  assert.equal(requestCtx.transactionId, "txn-paid-stale");
  assert.equal(requestMsg.method, "POST");
  assert.equal(requestMsg.url, "https://kc.vivacrm.ru/realms/prod/protocol/openid-connect/token");
});

test("Piter atomic PAID replay revalidates provider and ledger instead of trusting the sale projection", () => {
  const out = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_confirm_resolve.js",
    {
      _summerSubscriptionCtx: { action: "confirm", step: "resolve_record", paymentRef: "piter-paid" },
      payload: [{
        paymentRef: "piter-paid", counterKey: "piter_friendship",
        inventoryId: "piter_friendship_12m_2026_v1", transactionId: "tx-piter-paid",
        productId: "8bf334ba-3050-4017-b40a-7eef2db1eb16", status: "PAID",
        requestFingerprint: "piter-fingerprint", amountMinor: 1980000,
      }],
    },
  ) as unknown[];
  const request = asRecord(out[0]);
  assert.equal(request.method, "POST");
  assert.equal(asRecord(request._summerSubscriptionCtx).step, "token_confirm");
  assert.equal(out[1], null);
});

test("summer subscription purchase-prepare uses default reservation window without global config", () => {
  const out = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_purchase_prepare.js",
    {
      payload: {
        clientPhone: "79990000000",
        planKey: "sport",
        paymentRef: "payment-ref-purchase",
      },
      req: { query: {} },
    },
  ) as unknown[];

  const dbMsg = asRecord(out[0]);
  const ctx = asRecord(dbMsg._summerSubscriptionCtx);
  assert.equal(ctx.step, "limit_check");
  assert.equal(ctx.reservationMinutes, 30);
});

test("summer subscription purchase attribution accepts only a paired opaque token and visit id", () => {
  const valid = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_purchase_prepare.js",
    {
      payload: {
        clientPhone: "79990000000",
        planKey: "friendship",
        paymentRef: "payment-ref-attributed",
        referralToken: "abcdefghijklmnopqrstuvwx",
        referralVisitId: "visit-12345678",
      },
      req: { query: {} },
    },
  ) as unknown[];
  const validCtx = asRecord(asRecord(valid[0])._summerSubscriptionCtx);
  assert.equal(validCtx.referralToken, "abcdefghijklmnopqrstuvwx");
  assert.equal(validCtx.referralVisitId, "visit-12345678");

  const malformed = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_purchase_prepare.js",
    {
      payload: {
        clientPhone: "79990000000",
        planKey: "friendship",
        paymentRef: "payment-ref-unattributed",
        referralToken: "abcdefghijklmnopqrstuvwx",
        referralVisitId: "bad visit",
      },
      req: { query: {} },
    },
  ) as unknown[];
  const malformedCtx = asRecord(asRecord(malformed[0])._summerSubscriptionCtx);
  assert.equal(malformedCtx.referralToken, null);
  assert.equal(malformedCtx.referralVisitId, null);
});

test("Friendship and RA switch to fresh 150-seat staged inventories on September 3 Moscow time", () => {
  const createPurchaseContext = (nowIso: string, counterKey: string) => withFixedNow(nowIso, () => {
    const out = runNodeRedFunction(
      "scripts/nodered_games_nodes/fn_tournament_subscription_purchase_prepare.js",
      {
        payload: {
          clientPhone: "79990000000",
          counterKey,
          paymentRef: `staged-release-${counterKey}`,
        },
        req: { query: {} },
      },
    ) as unknown[];
    return asRecord(asRecord(out[0])._summerSubscriptionCtx);
  });

  const before = createPurchaseContext("2026-09-02T20:59:59.000Z", "friendship");
  assert.equal(before.stagedRelease, true);
  assert.equal(before.inventoryId, "ab_leto_2026_100_then_7_v1_friendship");
  assert.equal(before.totalLimit, 100);
  assert.equal(before.launchLimit, 100);

  for (const counterKey of ["friendship", "ra"]) {
    const after = createPurchaseContext("2026-09-02T21:00:00.000Z", counterKey);
    assert.equal(after.stagedRelease, true);
    assert.equal(after.totalLimit, 150);
    assert.equal(after.launchLimit, 150);
    assert.equal(after.dailyLimit, counterKey === "ra" ? 10 : 7);
    assert.equal(after.releaseStartDate, "2026-09-03");
    assert.equal(after.inventoryId, `ab_leto_2026_150_v2_${counterKey}`);
  }

  const sport = createPurchaseContext("2026-09-02T21:00:00.000Z", "sport");
  assert.equal(sport.stagedRelease, false);
  assert.equal(sport.totalLimit, 132);
});

test("September 3 release stays on legacy inventories until the server-owned flag is enabled", () => {
  for (const activationValue of [undefined, false, "true", 1]) {
    const disabledGlobals = {
      summer_subscription_ab_leto_20260903_release_enabled: activationValue,
    };
    const purchase = withFixedNow("2026-09-03T12:00:00.000Z", () => runNodeRedFunction(
      "scripts/nodered_games_nodes/fn_tournament_subscription_purchase_prepare.js",
      {
        payload: {
          counterKey: "ra",
          clientPhone: "79990000000",
          successUrl: "/success",
          failUrl: "/fail",
        },
      },
      disabledGlobals,
    )) as unknown[];
    const purchaseCtx = asRecord(asRecord(purchase[0])._summerSubscriptionCtx);
    assert.equal(purchaseCtx.inventoryId, "ab_leto_2026_100_then_7_v1_ra");
    assert.equal(purchaseCtx.launchLimit, 100);
    assert.equal(purchaseCtx.releaseStartDate, "2026-08-01");

    const status = withFixedNow("2026-09-03T12:00:00.000Z", () => runNodeRedFunction(
      "scripts/nodered_games_nodes/fn_tournament_subscription_status_prepare.js",
      { req: { query: { counterKey: "network_friendship" } } },
      { ...NETWORK_PRODUCT_GLOBALS, ...disabledGlobals },
    )) as unknown[];
    const statusCtx = asRecord(asRecord(status[0])._summerSubscriptionCtx);
    const networkCounter = asRecord((statusCtx.counters as Array<Record<string, unknown>>)[0]);
    assert.equal(networkCounter.dailyCapEnabled, false);
    assert.equal(networkCounter.totalLimit, 100);

    const statusResponse = withFixedNow("2026-09-03T12:00:00.000Z", () => runNodeRedFunction(
      "scripts/nodered_games_nodes/fn_tournament_subscription_status_response.js",
      { _summerSubscriptionCtx: statusCtx, payload: [] },
      { ...NETWORK_PRODUCT_GLOBALS, ...disabledGlobals },
    )) as unknown[];
    const statusPayload = asRecord(asRecord(statusResponse[0]).payload);
    assert.equal(statusPayload.dailyCapEnabled, false);
    assert.equal(statusPayload.totalLimit, 100);

    const refresh = withFixedNow("2026-09-03T12:00:00.000Z", () => runNodeRedFunction(
      "scripts/nodered_games_nodes/fn_tournament_subscription_counter_refresh_prepare.js",
      { payload: Date.now() },
      disabledGlobals,
    )) as Record<string, unknown>;
    const refreshCtx = asRecord(asRecord(refresh)._summerSubscriptionCtx);
    const refreshCounters = refreshCtx.counters as Array<Record<string, unknown>>;
    const raCounter = asRecord(refreshCounters.find((counter) => counter.counterKey === "ra"));
    const networkRefreshCounter = asRecord(
      refreshCounters.find((counter) => counter.counterKey === "network_friendship"),
    );
    assert.equal(raCounter.inventoryId, "ab_leto_2026_100_then_7_v1_ra");
    assert.equal(raCounter.launchLimit, 100);
    assert.equal(networkRefreshCounter.dailyCapEnabled, false);
  }
});

test("summer subscription purchase-prepare binds buttons to Leto Padel products", () => {
  const cases = [
    {
      planKey: "friendship",
      campaignKey: "summer_padel_friendship_2026",
      productId: "b2e6a9d4-53b5-4f79-87ec-3fb076381e9b",
      productName: "Лето.Падел.Дружба",
      productCostMinor: 980000,
    },
    {
      planKey: "sport",
      campaignKey: "summer_padel_sport_2026",
      productId: "82caad6f-4d19-4d01-852b-932bdbb0f405",
      productName: "Лето.Падел.Спорт",
      productCostMinor: 1980000,
    },
  ];

  for (const expected of cases) {
    const out = withFixedNow("2026-07-10T06:59:00.000Z", () => runNodeRedFunction(
      "scripts/nodered_games_nodes/fn_tournament_subscription_purchase_prepare.js",
      {
        payload: {
          clientPhone: "79990000000",
          planKey: expected.planKey,
          paymentRef: `payment-ref-${expected.planKey}`,
        },
        req: { query: {} },
      },
    )) as unknown[];

    const dbMsg = asRecord(out[0]);
    const ctx = asRecord(dbMsg._summerSubscriptionCtx);
    assert.equal(ctx.planKey, expected.planKey);
    assert.equal(ctx.campaignKey, expected.campaignKey);
    assert.equal(ctx.productId, expected.productId);
    assert.equal(ctx.productName, expected.productName);
    assert.equal(ctx.productCostMinor, expected.productCostMinor);
    assert.equal(ctx.productAliases, undefined);
    if (expected.planKey === "friendship") {
      assert.match(String(ctx.inventoryId), /^ab_leto_2026_50_v1_friendship_\d{4}-\d{2}-\d{2}$/);
    } else {
      assert.equal(ctx.inventoryId, "ab_leto_2026_50_v1");
    }
  }
});

test("summer subscription purchase-prepare supports all tracked direct-product counters", () => {
  withFixedNow("2026-07-10T06:59:00.000Z", () => {
  const cases = [
    {
      counterKey: "academy",
      productId: "9eb8a7a4-c195-492a-95e4-3fb82899ac10",
      productName: "Лето.Падел.Академия",
      productCostMinor: 2380000,
      unlimited: true,
    },
    {
      counterKey: "ra",
      productId: "b91e14d1-fe6e-4d0b-be39-3e45ad86b759",
      productName: "Лето.Падел.РА",
      productCostMinor: 2380000,
    },
    {
      counterKey: "energy5",
      productId: "dfa72adf-233b-4285-8d69-e5eab4234fbe",
      productName: "Энергия-5",
      productCostMinor: 1980000,
      unlimited: true,
    },
  ];

  for (const expected of cases) {
    const out = runNodeRedFunction(
      "scripts/nodered_games_nodes/fn_tournament_subscription_purchase_prepare.js",
      {
        payload: {
          clientPhone: "79990000000",
          counterKey: expected.counterKey,
          paymentRef: `payment-ref-${expected.counterKey}`,
        },
        req: { query: {} },
      },
    ) as unknown[];

    const dbMsg = asRecord(out[0]);
    const ctx = asRecord(dbMsg._summerSubscriptionCtx);
    assert.equal(ctx.counterKey, expected.counterKey);
    assert.equal(ctx.saleType, "direct_product");
    assert.equal(ctx.planKey, null);
    assert.equal(ctx.productId, expected.productId);
    assert.equal(ctx.productName, expected.productName);
    assert.equal(ctx.productCostMinor, expected.productCostMinor);
    assert.equal(
      ctx.inventoryId,
      expected.counterKey === "ra"
        ? "ab_leto_2026_50_v1_ra_2026-07-09"
        : "ab_leto_2026_50_v1",
    );
    assert.equal(ctx.unlimited, expected.unlimited === true);
  }
  });
});

test("summer subscription purchase-prepare keeps five-seat daily drops for Friendship and RA", () => {
  const cases = [
    { counterKey: "friendship", totalLimit: 5, unlimited: false },
    { counterKey: "sport", totalLimit: 132, unlimited: false },
    { counterKey: "academy", totalLimit: 0, unlimited: true },
    { counterKey: "ra", totalLimit: 5, unlimited: false },
    { counterKey: "energy5", totalLimit: 0, unlimited: true },
  ];

  for (const expected of cases) {
    const out = withFixedNow("2026-07-31T12:00:00.000Z", () => runNodeRedFunction(
        "scripts/nodered_games_nodes/fn_tournament_subscription_purchase_prepare.js",
        {
          payload: {
            clientPhone: "79990000000",
            counterKey: expected.counterKey,
            paymentRef: `payment-ref-limit-${expected.counterKey}`,
          },
          req: { query: {} },
        },
      )) as unknown[];

    const ctx = asRecord(asRecord(out[0])._summerSubscriptionCtx);
    assert.equal(ctx.counterKey, expected.counterKey);
    assert.equal(ctx.totalLimit, expected.totalLimit);
    assert.equal(ctx.unlimited, expected.unlimited);
  }
});

test("summer subscription status exposes Energy-5 as tracked and unlimited", () => {
  const prepareOut = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_status_prepare.js",
    { req: { query: { counterKey: "energy5" } } },
  ) as unknown[];
  const prepared = asRecord(prepareOut[0]);
  const prepareCtx = asRecord(prepared._summerSubscriptionCtx);
  const energyCounter = asRecord((prepareCtx.counters as Array<Record<string, unknown>>)[0]);
  assert.deepEqual(prepared.query, {
    inventoryId: "ab_leto_2026_50_v1",
    counterKey: "energy5",
  });
  assert.equal(energyCounter.totalLimit, 0);
  assert.equal(energyCounter.unlimited, true);

  const responseOut = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_status_response.js",
    {
      _summerSubscriptionCtx: prepareCtx,
      payload: [
        {
          inventoryId: "ab_leto_2026_50_v1",
          counterKey: "energy5",
          productId: "dfa72adf-233b-4285-8d69-e5eab4234fbe",
          status: "PAID",
        },
      ],
    },
  ) as unknown[];
  const payload = asRecord(asRecord(responseOut[0]).payload);
  assert.equal(payload.paidCount, 1);
  assert.equal(payload.remainingCount, 0);
  assert.equal(payload.canPurchase, true);
  assert.equal(payload.unlimited, true);
});

test("summer subscription status exposes Academy as tracked and unlimited", () => {
  const prepareOut = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_status_prepare.js",
    { req: { query: { counterKey: "academy" } } },
  ) as unknown[];
  const prepared = asRecord(prepareOut[0]);
  const prepareCtx = asRecord(prepared._summerSubscriptionCtx);
  const academyCounter = asRecord((prepareCtx.counters as Array<Record<string, unknown>>)[0]);
  assert.equal(academyCounter.totalLimit, 0);
  assert.equal(academyCounter.unlimited, true);

  const responseOut = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_status_response.js",
    {
      _summerSubscriptionCtx: prepareCtx,
      payload: Array.from({ length: 125 }, () => ({
        inventoryId: "ab_leto_2026_50_v1",
        counterKey: "academy",
        productId: "9eb8a7a4-c195-492a-95e4-3fb82899ac10",
        status: "PAID",
      })),
    },
  ) as unknown[];
  const payload = asRecord(asRecord(responseOut[0]).payload);
  assert.equal(payload.paidCount, 125);
  assert.equal(payload.remainingCount, 0);
  assert.equal(payload.canPurchase, true);
  assert.equal(payload.unlimited, true);
});

test("summer subscription status ignores cumulative rows for daily-drop counters", () => {
  const prepareOut = withFixedNow("2026-07-31T12:00:00.000Z", () => runNodeRedFunction(
      "scripts/nodered_games_nodes/fn_tournament_subscription_status_prepare.js",
      { req: { query: {} } },
    )) as unknown[];
  const prepareCtx = asRecord(asRecord(prepareOut[0])._summerSubscriptionCtx);
  const paidRows = [
    ...Array.from({ length: 42 }, () => ({
      inventoryId: "ab_leto_2026_50_v1",
      counterKey: "friendship",
      status: "PAID",
    })),
    ...Array.from({ length: 6 }, () => ({
      inventoryId: "ab_leto_2026_50_v1",
      counterKey: "sport",
      status: "PAID",
    })),
    ...Array.from({ length: 25 }, () => ({
      inventoryId: "ab_leto_2026_50_v1",
      counterKey: "academy",
      status: "PAID",
    })),
    ...Array.from({ length: 82 }, () => ({
      inventoryId: "ab_leto_2026_50_v1",
      counterKey: "ra",
      status: "PAID",
    })),
  ];

  const responseOut = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_status_response.js",
    {
      _summerSubscriptionCtx: prepareCtx,
      payload: paidRows,
    },
  ) as unknown[];

  const payload = asRecord(asRecord(responseOut[0]).payload);
  const plans = payload.plans as Array<Record<string, unknown>>;
  const byCounter = new Map(plans.map((plan) => [plan.counterKey, plan]));

  assert.equal(asRecord(byCounter.get("friendship")).totalLimit, 5);
  assert.equal(asRecord(byCounter.get("friendship")).remainingCount, 5);
  assert.equal(asRecord(byCounter.get("sport")).totalLimit, 132);
  assert.equal(asRecord(byCounter.get("sport")).remainingCount, 126);
  assert.equal(asRecord(byCounter.get("academy")).totalLimit, 0);
  assert.equal(asRecord(byCounter.get("academy")).remainingCount, 0);
  assert.equal(asRecord(byCounter.get("academy")).canPurchase, true);
  assert.equal(asRecord(byCounter.get("academy")).unlimited, true);
  assert.equal(asRecord(byCounter.get("ra")).totalLimit, 5);
  assert.equal(asRecord(byCounter.get("ra")).remainingCount, 5);
});

test("summer subscription status counts only the current Friendship and RA daily drops", () => {
  for (const counterKey of ["friendship", "ra"]) {
    const prepareOut = withFixedNow("2026-07-31T12:00:00.000Z", () => runNodeRedFunction(
        "scripts/nodered_games_nodes/fn_tournament_subscription_status_prepare.js",
        { req: { query: { counterKey } } },
      )) as unknown[];
    const prepareCtx = asRecord(asRecord(prepareOut[0])._summerSubscriptionCtx);

    const counter = (asRecord(prepareCtx).counters as Array<Record<string, unknown>>)
      .find((candidate) => candidate.counterKey === counterKey);
    const currentInventoryId = asRecord(counter).inventoryId;
    const responseOut = runNodeRedFunction(
      "scripts/nodered_games_nodes/fn_tournament_subscription_status_response.js",
      {
        _summerSubscriptionCtx: prepareCtx,
        payload: Array.from({ length: 3 }, () => ({
          inventoryId: currentInventoryId,
          counterKey,
          status: "PAID",
        })),
      },
    ) as unknown[];

    const payload = asRecord(asRecord(responseOut[0]).payload);
    assert.equal(payload.totalLimit, 5);
    assert.equal(payload.paidCount, 3);
    assert.equal(payload.remainingCount, 2);
    assert.equal(payload.canPurchase, true);
  }
});

test("summer subscription daily drops roll over at 10:00 Moscow time", () => {
  const readDailyInventory = (counterKey: "friendship" | "ra") => {
    const out = runNodeRedFunction(
      "scripts/nodered_games_nodes/fn_tournament_subscription_status_prepare.js",
      { req: { query: { counterKey } } },
    ) as unknown[];
    const ctx = asRecord(asRecord(out[0])._summerSubscriptionCtx);
    const counter = (ctx.counters as Array<Record<string, unknown>>)[0];
    return {
      inventoryId: counter.inventoryId,
      totalLimit: counter.totalLimit,
    };
  };

  for (const counterKey of ["friendship", "ra"] as const) {
    const before = withFixedNow("2026-07-10T06:59:00.000Z", () => readDailyInventory(counterKey));
    const after = withFixedNow("2026-07-10T07:00:00.000Z", () => readDailyInventory(counterKey));

    assert.deepEqual(before, {
      inventoryId: `ab_leto_2026_50_v1_${counterKey}_2026-07-09`,
      totalLimit: 5,
    });
    assert.deepEqual(after, {
      inventoryId: `ab_leto_2026_50_v1_${counterKey}_2026-07-10`,
      totalLimit: 5,
    });
  }
});

test("staged launch waits for 150 PAID sales before enabling the daily limit", () => {
  const nowIso = "2026-09-03T12:00:00.000Z";
  const prepare = () => withFixedNow(nowIso, () => runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_purchase_prepare.js",
    {
      payload: {
        clientPhone: "79990000000",
        counterKey: "ra",
        paymentRef: "staged-ra-purchase",
      },
      req: { query: {} },
    },
  )) as unknown[];
  const initialCtx = asRecord(asRecord(prepare()[0])._summerSubscriptionCtx);
  const inventoryId = String(initialCtx.inventoryId);
  const launchPaidRows = Array.from({ length: 149 }, () => ({
    inventoryId,
    counterKey: "ra",
    releasePhase: "launch",
    status: "PAID",
  }));

  const oneLeft = withFixedNow(nowIso, () => runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_purchase_limit.js",
    {
      _summerSubscriptionCtx: { ...initialCtx },
      payload: launchPaidRows,
    },
  )) as unknown[];
  const oneLeftCtx = asRecord(asRecord(oneLeft[0])._summerSubscriptionCtx);
  assert.equal(oneLeftCtx.releasePhase, "launch");
  assert.equal(oneLeftCtx.dailyDropActive, false);
  assert.equal(oneLeftCtx.totalLimit, 150);
  assert.equal(oneLeftCtx.remainingBefore, 1);

  const reservedLastSlot = withFixedNow(nowIso, () => runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_purchase_limit.js",
    {
      _summerSubscriptionCtx: { ...initialCtx },
      payload: [
        ...launchPaidRows,
        {
          inventoryId,
          counterKey: "ra",
          releasePhase: "launch",
          status: "PAYMENT_PENDING",
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
      ],
    },
  )) as unknown[];
  const blockedPayload = asRecord(asRecord(reservedLastSlot[1]).payload);
  const blockedDetails = asRecord(blockedPayload.details);
  assert.equal(asRecord(reservedLastSlot[1]).statusCode, 409);
  assert.equal(blockedDetails.dailyDropActive, false);
  assert.equal(blockedDetails.launchPaidCount, 149);
  assert.equal(blockedDetails.launchReservedCount, 1);
});

test("staged release changes to a seven-seat daily drop after 150 PAID launch sales", () => {
  const nowIso = "2026-09-03T12:00:00.000Z";
  const prepared = withFixedNow(nowIso, () => runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_purchase_prepare.js",
    {
      payload: {
        clientPhone: "79990000000",
        counterKey: "friendship",
        paymentRef: "staged-friendship-daily",
      },
      req: { query: {} },
    },
  )) as unknown[];
  const initialCtx = asRecord(asRecord(prepared[0])._summerSubscriptionCtx);
  const inventoryId = String(initialCtx.inventoryId);
  const dailyDropDate = String(initialCtx.dailyDropDate);
  const launchRows = Array.from({ length: 150 }, () => ({
    inventoryId,
    counterKey: "friendship",
    releasePhase: "launch",
    status: "PAID",
    updatedAt: "2026-09-03T06:00:00.000Z",
  }));
  const currentDailyRows = Array.from({ length: 6 }, () => ({
    inventoryId,
    counterKey: "friendship",
    releasePhase: "daily",
    dailyDropDate,
    status: "PAID",
  }));
  const priorDailyRows = Array.from({ length: 9 }, () => ({
    inventoryId,
    counterKey: "friendship",
    releasePhase: "daily",
    dailyDropDate: "2026-09-02",
    status: "PAID",
  }));

  const allowed = withFixedNow(nowIso, () => runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_purchase_limit.js",
    {
      _summerSubscriptionCtx: { ...initialCtx },
      payload: [...launchRows, ...currentDailyRows, ...priorDailyRows],
    },
  )) as unknown[];
  const allowedCtx = asRecord(asRecord(allowed[0])._summerSubscriptionCtx);
  assert.equal(allowedCtx.releasePhase, "daily");
  assert.equal(allowedCtx.dailyDropActive, true);
  assert.equal(allowedCtx.totalLimit, 7);
  assert.equal(allowedCtx.remainingBefore, 1);

  const blocked = withFixedNow(nowIso, () => runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_purchase_limit.js",
    {
      _summerSubscriptionCtx: { ...initialCtx },
      payload: [
        ...launchRows,
        ...currentDailyRows,
        {
          inventoryId,
          counterKey: "friendship",
          releasePhase: "daily",
          dailyDropDate,
          status: "PAYMENT_PENDING",
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
      ],
    },
  )) as unknown[];
  const blockedDetails = asRecord(asRecord(asRecord(blocked[1]).payload).details);
  assert.equal(asRecord(blocked[1]).statusCode, 409);
  assert.equal(blockedDetails.totalLimit, 7);
  assert.equal(blockedDetails.dailyDropActive, true);
});

test("RA staged release waits for the next 10:00 Moscow window after the launch pool sells out", () => {
  const inventoryId = "ab_leto_2026_150_v2_ra";
  const launchRows = Array.from({ length: 150 }, () => ({
    inventoryId,
    counterKey: "ra",
    releasePhase: "launch",
    status: "PAID",
    updatedAt: "2026-09-03T12:00:00.000Z",
  }));
  const prepareAt = (nowIso: string) => withFixedNow(nowIso, () => runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_purchase_prepare.js",
    {
      payload: {
        clientPhone: "79990000000",
        counterKey: "ra",
        paymentRef: `next-drop-${nowIso}`,
      },
      req: { query: {} },
    },
  )) as unknown[];

  const beforeNextDropIso = "2026-09-03T13:00:00.000Z";
  const beforeCtx = asRecord(asRecord(prepareAt(beforeNextDropIso)[0])._summerSubscriptionCtx);
  const blocked = withFixedNow(beforeNextDropIso, () => runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_purchase_limit.js",
    { _summerSubscriptionCtx: beforeCtx, payload: launchRows },
  )) as unknown[];
  const blockedDetails = asRecord(asRecord(asRecord(blocked[1]).payload).details);
  assert.equal(asRecord(blocked[1]).statusCode, 409);
  assert.equal(blockedDetails.releasePhase, "daily_pending");
  assert.equal(blockedDetails.dailyDropActive, false);
  assert.equal(blockedDetails.launchCompletedAt, "2026-09-03T12:00:00.000Z");
  assert.equal(blockedDetails.dailyDropStartsAt, "2026-09-04T07:00:00.000Z");

  const atNextDropIso = "2026-09-04T07:00:00.000Z";
  const nextCtx = asRecord(asRecord(prepareAt(atNextDropIso)[0])._summerSubscriptionCtx);
  const allowed = withFixedNow(atNextDropIso, () => runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_purchase_limit.js",
    { _summerSubscriptionCtx: nextCtx, payload: launchRows },
  )) as unknown[];
  const allowedCtx = asRecord(asRecord(allowed[0])._summerSubscriptionCtx);
  assert.equal(allowedCtx.releasePhase, "daily");
  assert.equal(allowedCtx.dailyDropActive, true);
  assert.equal(allowedCtx.totalLimit, 10);
  assert.equal(allowedCtx.remainingBefore, 10);
});

test("staged status exposes launch and daily phases independently per product", () => {
  const nowIso = "2026-09-03T12:00:00.000Z";
  const readStatus = (counterKey: "friendship" | "ra", rows: Array<Record<string, unknown>>) => {
    const prepareOut = withFixedNow(nowIso, () => runNodeRedFunction(
      "scripts/nodered_games_nodes/fn_tournament_subscription_status_prepare.js",
      { req: { query: { counterKey } } },
    )) as unknown[];
    const prepareCtx = asRecord(asRecord(prepareOut[0])._summerSubscriptionCtx);
    return withFixedNow(nowIso, () => runNodeRedFunction(
      "scripts/nodered_games_nodes/fn_tournament_subscription_status_response.js",
      { _summerSubscriptionCtx: prepareCtx, payload: rows },
    )) as unknown[];
  };
  const inventoryId = "ab_leto_2026_150_v2_ra";
  const launchRows = Array.from({ length: 149 }, () => ({
    inventoryId,
    counterKey: "ra",
    releasePhase: "launch",
    status: "PAID",
  }));
  const launchOut = readStatus("ra", [
    ...launchRows,
    {
      inventoryId,
      counterKey: "ra",
      releasePhase: "launch",
      status: "PAYMENT_PENDING",
      expiresAt: "2099-01-01T00:00:00.000Z",
    },
  ]);
  const launchPayload = asRecord(asRecord(launchOut[0]).payload);
  assert.equal(launchPayload.releasePhase, "launch");
  assert.equal(launchPayload.dailyDropActive, false);
  assert.equal(launchPayload.totalLimit, 150);
  assert.equal(launchPayload.paidCount, 149);
  assert.equal(launchPayload.remainingCount, 0);
  assert.equal(launchPayload.canPurchase, false);

  const dailyRows = [
    ...Array.from({ length: 150 }, () => ({
      inventoryId,
      counterKey: "ra",
      releasePhase: "launch",
      status: "PAID",
      updatedAt: "2026-09-03T06:00:00.000Z",
    })),
    ...Array.from({ length: 3 }, () => ({
      inventoryId,
      counterKey: "ra",
      releasePhase: "daily",
      dailyDropDate: "2026-09-03",
      status: "PAID",
    })),
    ...Array.from({ length: 4 }, () => ({
      inventoryId,
      counterKey: "ra",
      releasePhase: "daily",
      dailyDropDate: "2026-09-02",
      status: "PAID",
    })),
  ];
  const dailyPayload = asRecord(asRecord(readStatus("ra", dailyRows)[0]).payload);
  assert.equal(dailyPayload.releasePhase, "daily");
  assert.equal(dailyPayload.dailyDropActive, true);
  assert.equal(dailyPayload.totalLimit, 10);
  assert.equal(dailyPayload.paidCount, 3);
  assert.equal(dailyPayload.remainingCount, 7);
});

test("staged counters recover current daily sales that were persisted as launch", () => {
  const nowIso = "2026-09-05T12:00:00.000Z";
  const inventoryId = "ab_leto_2026_150_v2_ra";
  const launchRows = Array.from({ length: 150 }, (_, index) => ({
    inventoryId,
    counterKey: "ra",
    releasePhase: "launch",
    status: "PAID",
    paidAt: new Date(Date.parse("2026-09-03T16:00:00.000Z") + index * 60_000).toISOString(),
  }));
  const mislabeledPriorDrop = {
    inventoryId,
    counterKey: "ra",
    releasePhase: "launch",
    status: "PAID",
    paidAt: "2026-09-05T06:59:59.000Z",
  };
  const mislabeledCurrentPaid = [
    {
      inventoryId,
      counterKey: "ra",
      releasePhase: "launch",
      status: "PAID",
      createdAt: "2026-09-05T06:59:59.000Z",
      updatedAt: "2026-09-05T07:00:00.000Z",
    },
    {
      inventoryId,
      counterKey: "ra",
      releasePhase: "launch",
      status: "PAID",
      paidAt: "2026-09-05T07:01:00.000Z",
    },
  ];
  const mislabeledCurrentPending = {
    inventoryId,
    counterKey: "ra",
    releasePhase: "launch",
    status: "PAYMENT_PENDING",
    createdAt: "2026-09-05T07:02:00.000Z",
    expiresAt: "2026-09-05T13:00:00.000Z",
  };
  const mislabeledExpiredPending = {
    inventoryId,
    counterKey: "ra",
    releasePhase: "launch",
    status: "PAYMENT_PENDING",
    createdAt: "2026-09-05T07:03:00.000Z",
    expiresAt: "2026-09-05T11:00:00.000Z",
  };
  const rows = [
    ...launchRows,
    mislabeledPriorDrop,
    ...mislabeledCurrentPaid,
    mislabeledCurrentPending,
    mislabeledExpiredPending,
  ];

  const purchasePrepare = withFixedNow(nowIso, () => runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_purchase_prepare.js",
    {
      payload: {
        clientPhone: "79990000000",
        counterKey: "ra",
        paymentRef: "mislabeled-daily-purchase",
      },
      req: { query: {} },
    },
  )) as unknown[];
  const purchaseCtx = asRecord(asRecord(purchasePrepare[0])._summerSubscriptionCtx);
  const purchaseOut = withFixedNow(nowIso, () => runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_purchase_limit.js",
    { _summerSubscriptionCtx: purchaseCtx, payload: rows },
  )) as unknown[];
  const allowedCtx = asRecord(asRecord(purchaseOut[0])._summerSubscriptionCtx);
  assert.equal(allowedCtx.releasePhase, "daily");
  assert.equal(allowedCtx.launchPaidCount, 150);
  assert.equal(allowedCtx.remainingBefore, 7);

  const statusPrepare = withFixedNow(nowIso, () => runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_status_prepare.js",
    { req: { query: { counterKey: "ra" } } },
  )) as unknown[];
  const statusCtx = asRecord(asRecord(statusPrepare[0])._summerSubscriptionCtx);
  const statusOut = withFixedNow(nowIso, () => runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_status_response.js",
    { _summerSubscriptionCtx: statusCtx, payload: rows },
  )) as unknown[];
  const statusPayload = asRecord(asRecord(statusOut[0]).payload);
  assert.equal(statusPayload.releasePhase, "daily");
  assert.equal(statusPayload.launchPaidCount, 150);
  assert.equal(statusPayload.paidCount, 2);
  assert.equal(statusPayload.reservedCount, 1);
  assert.equal(statusPayload.remainingCount, 7);

  const refreshPrepare = withFixedNow(nowIso, () => runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_counter_refresh_prepare.js",
    { payload: Date.now() },
  )) as Record<string, unknown>;
  const refreshCtx = asRecord(asRecord(refreshPrepare)._summerSubscriptionCtx);
  const refreshOut = withFixedNow(nowIso, () => runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_counter_refresh_response.js",
    { _summerSubscriptionCtx: refreshCtx, payload: rows },
  )) as unknown[];
  const updates = refreshOut[0] as Array<Record<string, unknown>>;
  const raUpdate = updates.find((entry) => asRecord(entry.query).counterKey === "ra");
  assert.ok(raUpdate);
  const refreshedState = asRecord(asRecord(raUpdate.payload).$set);
  assert.equal(refreshedState.releasePhase, "daily");
  assert.equal(refreshedState.launchPaidCount, 150);
  assert.equal(refreshedState.paidCount, 2);
  assert.equal(refreshedState.reservedCount, 1);
  assert.equal(refreshedState.remainingCount, 7);

  const nineMislabeledPaid = Array.from({ length: 9 }, (_, index) => ({
    inventoryId,
    counterKey: "ra",
    releasePhase: "launch",
    status: "PAID",
    paidAt: new Date(Date.parse("2026-09-05T07:00:00.000Z") + index * 60_000).toISOString(),
  }));
  const blockedOut = withFixedNow(nowIso, () => runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_purchase_limit.js",
    {
      _summerSubscriptionCtx: { ...purchaseCtx },
      payload: [
        ...launchRows,
        mislabeledPriorDrop,
        ...nineMislabeledPaid,
        mislabeledCurrentPending,
        mislabeledExpiredPending,
      ],
    },
  )) as unknown[];
  const blocked = asRecord(blockedOut[1]);
  const blockedDetails = asRecord(asRecord(blocked.payload).details);
  assert.equal(blocked.statusCode, 409);
  assert.equal(blockedDetails.paidCount, 9);
  assert.equal(blockedDetails.reservedCount, 1);
  assert.equal(blockedDetails.remainingCount, 0);
});

test("summer subscription Energy-5 limit check never blocks on purchase count", () => {
  const out = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_purchase_limit.js",
    {
      _summerSubscriptionCtx: {
        action: "purchase",
        step: "limit_check",
        counterKey: "energy5",
        inventoryId: "ab_leto_2026_50_v1",
        unlimited: true,
        totalLimit: 0,
        paymentRef: "energy-unlimited",
      },
      payload: Array.from({ length: 75 }, () => ({
        inventoryId: "ab_leto_2026_50_v1",
        counterKey: "energy5",
        status: "PAID",
      })),
    },
  ) as unknown[];

  const requestCtx = asRecord(asRecord(out[0])._summerSubscriptionCtx);
  const debugPayload = asRecord(asRecord(out[2]).payload);
  assert.equal(out[1], null);
  assert.equal(requestCtx.step, "token_purchase");
  assert.equal(requestCtx.remainingBefore, null);
  assert.equal(debugPayload.takenCount, 75);
  assert.equal(debugPayload.unlimited, true);
});

test("summer subscription payment router keeps configured Leto product when Viva list misses it", () => {
  const out = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_purchase_router.js",
    {
      statusCode: 200,
      payload: [
        {
          id: "f5cafa55-01dc-4ffa-9ae4-4bff35a10061",
          name: "Энергия 5 🎾 Селигерская Акционная",
          cost: 1280000,
          type: "GROUP",
        },
        {
          id: "d1a5ef07-b900-4154-9bef-76e6efde99d0",
          name: "Прогресс 5 🎾 Акционный Селигерская",
          cost: 980000,
          type: "GROUP",
        },
      ],
      _summerSubscriptionCtx: {
        action: "purchase",
        step: "load_products",
        token: "token-1",
        planKey: "sport",
        campaignKey: "summer_padel_sport_2026",
        paymentRef: "payment-ref-router",
        clientPhone: "79990000000",
        productId: "82caad6f-4d19-4d01-852b-932bdbb0f405",
        productName: "Лето.Падел.Спорт",
        productCostMinor: 1980000,
        reservationMinutes: 30,
      },
    },
  ) as unknown[];

  const requestMsg = asRecord(out[0]);
  const ctx = asRecord(requestMsg._summerSubscriptionCtx);
  const payload = asRecord(requestMsg.payload);
  const products = payload.products as Array<Record<string, unknown>>;

  assert.equal(requestMsg.method, "POST");
  assert.equal(requestMsg.url, "https://api.vivacrm.ru/api/v1/transactions");
  assert.equal(ctx.step, "create_transaction");
  assert.equal(ctx.productId, "82caad6f-4d19-4d01-852b-932bdbb0f405");
  assert.equal(ctx.productName, "Лето.Падел.Спорт");
  assert.equal(ctx.productCostMinor, 1980000);
  assert.equal(products[0].id, "82caad6f-4d19-4d01-852b-932bdbb0f405");
  assert.equal(products[0].type, "SUBSCRIPTION");
});

test("summer subscription payment router persists the selected staged release phase", () => {
  const out = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_purchase_router.js",
    {
      statusCode: 201,
      payload: {
        id: "transaction-staged-1",
        paymentUrl: "https://pay.example.test/staged-1",
        toPay: 980000,
      },
      _summerSubscriptionCtx: {
        action: "purchase",
        step: "create_transaction",
        counterKey: "friendship",
        inventoryId: "ab_leto_2026_150_v2_friendship",
        releasePhase: "daily",
        dailyDropActive: true,
        releaseStartDate: "2026-09-03",
        launchLimit: 150,
        dailyLimit: 7,
        dailyDropDate: "2026-09-04",
        paymentRef: "payment-staged-1",
        clientPhone: "79990000000",
        productId: "b2e6a9d4-53b5-4f79-87ec-3fb076381e9b",
        productName: "Лето.Падел.Дружба",
        productCostMinor: 980000,
        remainingBefore: 4,
      },
    },
  ) as unknown[];

  const dbSet = asRecord(asRecord(asRecord(out[1]).payload).$set);
  const response = asRecord(asRecord(out[2]).payload);
  assert.equal(dbSet.releasePhase, "daily");
  assert.equal(dbSet.releaseStartDate, "2026-09-03");
  assert.equal(dbSet.launchLimit, 150);
  assert.equal(dbSet.dailyLimit, 7);
  assert.equal(dbSet.dailyDropDate, "2026-09-04");
  assert.equal(response.releasePhase, "daily");
  assert.equal(response.dailyDropActive, true);
  assert.equal(response.remainingAfterReservation, 3);
});

test("summer subscription payment router persists referral attribution on the sale record", () => {
  const out = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_purchase_router.js",
    {
      statusCode: 201,
      payload: {
        id: "transaction-referral-1",
        paymentUrl: "https://pay.example.test/referral-1",
        toPay: 980000,
      },
      _summerSubscriptionCtx: {
        action: "purchase",
        step: "create_transaction",
        counterKey: "friendship",
        inventoryId: "ab_leto_2026_150_v2_friendship",
        paymentRef: "payment-ref-attributed",
        clientPhone: "79990000000",
        productId: "b2e6a9d4-53b5-4f79-87ec-3fb076381e9b",
        productName: "Лето.Падел.Дружба",
        productCostMinor: 980000,
        remainingBefore: 4,
        referralToken: "abcdefghijklmnopqrstuvwx",
        referralVisitId: "visit-12345678",
      },
    },
  ) as unknown[];
  const dbSet = asRecord(asRecord(asRecord(out[1]).payload).$set);
  assert.equal(dbSet.referralToken, "abcdefghijklmnopqrstuvwx");
  assert.equal(dbSet.referralVisitId, "visit-12345678");
});

test("summer subscription purchase-limit uses default HTTP timeout without global config", () => {
  const out = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_purchase_limit.js",
    {
      _summerSubscriptionCtx: {
        action: "purchase",
        step: "limit_check",
        planKey: "sport",
        campaignKey: "summer_padel_sport_2026",
        paymentRef: "payment-ref-default-timeout",
        totalLimit: 5,
      },
      payload: [],
    },
  ) as unknown[];

  const requestMsg = asRecord(out[0]);
  const requestCtx = asRecord(requestMsg._summerSubscriptionCtx);
  assert.equal(requestCtx.step, "token_purchase");
  assert.equal(requestCtx.httpRequestTimeoutMs, 20000);
  assert.equal(requestMsg.httpRequestTimeout, 20000);
});

test("summer subscription purchase-limit counts only PAID and active PAYMENT_PENDING", () => {
  withFixedNow("2026-06-01T10:00:00.000Z", () => {
    const out = runNodeRedFunction(
      "scripts/nodered_games_nodes/fn_tournament_subscription_purchase_limit.js",
      {
        _summerSubscriptionCtx: {
          action: "purchase",
          step: "limit_check",
          planKey: "sport",
          campaignKey: "summer_padel_sport_2026",
          paymentRef: "payment-ref-2",
          totalLimit: 7,
          reservationMinutes: 30,
        },
        payload: [
          { status: "PAID" },
          { status: "payment_success" },
          { status: "PAYMENT_PENDING", expiresAt: "2026-06-01T10:10:00.000Z" },
          { status: "PAYMENT_PENDING", expiresAt: "2026-06-01T09:59:00.000Z" },
          { status: "PAYMENT_PENDING", createdAt: "2026-06-01T09:50:00.000Z" },
          { status: "PAYMENT_PENDING", createdAt: "2026-06-01T09:00:00.000Z" },
          { status: "PAYMENT_PENDING", paymentExpiresAt: "2026-06-01T10:20:00.000Z" },
          {
            status: "PAYMENT_PENDING",
            expiresAt: "2026-06-01T09:59:00.000Z",
            paymentExpiresAt: "2026-06-01T10:20:00.000Z",
          },
          { status: "FAILED" },
          { status: "CANCELLED" },
        ],
      },
      {
        summer_subscription_http_timeout_ms: 20000,
      },
    ) as unknown[];

    const requestMsg = asRecord(out[0]);
    const requestCtx = asRecord(requestMsg._summerSubscriptionCtx);
    const debugMsg = asRecord(out[2]);
    const debugPayload = asRecord(debugMsg.payload);

    assert.equal(out[1], null);
    assert.equal(requestCtx.step, "token_purchase");
    assert.equal(requestCtx.remainingBefore, 1);
    assert.equal(debugPayload.takenCount, 6);
    assert.equal(debugPayload.remainingBefore, 1);
  });
});

test("summer subscription purchase-limit ignores records with a different productId under the same campaign", () => {
  withFixedNow("2026-06-01T10:00:00.000Z", () => {
    const out = runNodeRedFunction(
      "scripts/nodered_games_nodes/fn_tournament_subscription_purchase_limit.js",
      {
        _summerSubscriptionCtx: {
          action: "purchase",
          step: "limit_check",
          planKey: "sport",
          campaignKey: "summer_padel_sport_2026",
          paymentRef: "payment-ref-mixed-products",
          totalLimit: 3,
          productId: "82caad6f-4d19-4d01-852b-932bdbb0f405",
        },
        payload: [
          { status: "PAID", productId: "82caad6f-4d19-4d01-852b-932bdbb0f405" },
          { status: "PAYMENT_PENDING", expiresAt: "2026-06-01T10:10:00.000Z", productId: "82caad6f-4d19-4d01-852b-932bdbb0f405" },
          { status: "PAID", productId: "dfa72adf-233b-4285-8d69-e5eab4234fbe" },
          { status: "PAYMENT_PENDING", expiresAt: "2026-06-01T10:10:00.000Z", productId: "dfa72adf-233b-4285-8d69-e5eab4234fbe" },
        ],
      },
    ) as unknown[];

    const requestMsg = asRecord(out[0]);
    const requestCtx = asRecord(requestMsg._summerSubscriptionCtx);
    const debugMsg = asRecord(out[2]);
    const debugPayload = asRecord(debugMsg.payload);

    assert.equal(out[1], null);
    assert.equal(requestCtx.remainingBefore, 1);
    assert.equal(debugPayload.takenCount, 2);
    assert.equal(debugPayload.remainingBefore, 1);
  });
});

test("summer subscription purchase-limit does not treat UNPAID rows as paid", () => {
  const out = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_purchase_limit.js",
    {
      _summerSubscriptionCtx: {
        action: "purchase",
        step: "limit_check",
        counterKey: "ra",
        inventoryId: "ab_leto_2026_50_v1",
        paymentRef: "payment-ref-unpaid-limit",
        totalLimit: 182,
        productId: "b91e14d1-fe6e-4d0b-be39-3e45ad86b759",
      },
      payload: [
        {
          inventoryId: "ab_leto_2026_50_v1",
          counterKey: "ra",
          productId: "b91e14d1-fe6e-4d0b-be39-3e45ad86b759",
          status: "UNPAID",
        },
      ],
    },
  ) as unknown[];

  const requestCtx = asRecord(asRecord(out[0])._summerSubscriptionCtx);
  assert.equal(requestCtx.remainingBefore, 182);
});

test("summer subscription purchase-limit subtracts configured manual paid baseline before creating a new payment", () => {
  const out = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_purchase_limit.js",
    {
      _summerSubscriptionCtx: {
        action: "purchase",
        step: "limit_check",
        counterKey: "sport",
        planKey: "sport",
        campaignKey: "summer_padel_sport_2026",
        paymentRef: "payment-ref-manual-baseline",
        totalLimit: 50,
        productId: "82caad6f-4d19-4d01-852b-932bdbb0f405",
      },
      payload: [],
    },
    {
      summer_subscription_sport_manual_paid_count: 38,
    },
  ) as unknown[];

  const requestMsg = asRecord(out[0]);
  const requestCtx = asRecord(requestMsg._summerSubscriptionCtx);
  const debugMsg = asRecord(out[2]);
  const debugPayload = asRecord(debugMsg.payload);

  assert.equal(requestCtx.remainingBefore, 12);
  assert.equal(debugPayload.takenCount, 38);
  assert.equal(debugPayload.remainingBefore, 12);
});

test("summer subscription launch inventory ignores legacy manual baselines", () => {
  const out = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_purchase_limit.js",
    {
      _summerSubscriptionCtx: {
        action: "purchase",
        step: "limit_check",
        counterKey: "sport",
        inventoryId: "ab_leto_2026_50_v1",
        planKey: "sport",
        campaignKey: "summer_padel_sport_2026",
        paymentRef: "payment-ref-new-inventory",
        totalLimit: 50,
        productId: "82caad6f-4d19-4d01-852b-932bdbb0f405",
      },
      payload: [],
    },
    {
      summer_subscription_sport_manual_paid_count: 38,
    },
  ) as unknown[];

  const requestCtx = asRecord(asRecord(out[0])._summerSubscriptionCtx);
  const debugPayload = asRecord(asRecord(out[2]).payload);
  assert.equal(requestCtx.remainingBefore, 50);
  assert.equal(debugPayload.takenCount, 0);
});

test("summer subscription status-response ignores mixed productIds under the same sport campaign", () => {
  withFixedNow("2026-06-01T10:00:00.000Z", () => {
    const out = runNodeRedFunction(
      "scripts/nodered_games_nodes/fn_tournament_subscription_status_response.js",
      {
        _summerSubscriptionCtx: {
          action: "status",
          singleCounter: true,
          selectedCounterKey: "sport",
          selectedPlanKey: "sport",
          selectedCampaignKey: "summer_padel_sport_2026",
          counters: [
            {
              counterKey: "sport",
              saleType: "summer_campaign",
              planKey: "sport",
              campaignKey: "summer_padel_sport_2026",
              productId: "82caad6f-4d19-4d01-852b-932bdbb0f405",
              productName: "Лето.Падел.Спорт",
              totalLimit: 5,
            },
          ],
        },
        payload: [
          {
            campaignKey: "summer_padel_sport_2026",
            status: "PAID",
            productId: "82caad6f-4d19-4d01-852b-932bdbb0f405",
            productName: "Лето.Падел.Спорт",
            updatedAt: "2026-06-01T09:00:00.000Z",
          },
          {
            campaignKey: "summer_padel_sport_2026",
            status: "PAYMENT_PENDING",
            expiresAt: "2026-06-01T10:10:00.000Z",
            productId: "82caad6f-4d19-4d01-852b-932bdbb0f405",
            productName: "Лето.Падел.Спорт",
            updatedAt: "2026-06-01T09:05:00.000Z",
          },
          {
            campaignKey: "summer_padel_sport_2026",
            status: "PAID",
            productId: "dfa72adf-233b-4285-8d69-e5eab4234fbe",
            productName: "Энергия 5 🎾",
            updatedAt: "2026-06-01T09:10:00.000Z",
          },
        ],
      },
    ) as unknown[];

    const responseMsg = asRecord(out[0]);
    const payload = asRecord(responseMsg.payload);

    assert.equal(payload.productId, "82caad6f-4d19-4d01-852b-932bdbb0f405");
    assert.equal(payload.productName, "Лето.Падел.Спорт");
    assert.equal(payload.paidCount, 1);
    assert.equal(payload.reservedCount, 1);
    assert.equal(payload.takenCount, 2);
    assert.equal(payload.remainingCount, 3);
    assert.equal(payload.canPurchase, true);
  });
});

test("summer subscription status-response applies configured manual paid baselines on top of tracked sales", () => {
  withFixedNow("2026-06-01T10:00:00.000Z", () => {
    const out = runNodeRedFunction(
      "scripts/nodered_games_nodes/fn_tournament_subscription_status_response.js",
      {
        _summerSubscriptionCtx: {
          action: "status",
          singleCounter: false,
          counters: [
            {
              counterKey: "sport",
              saleType: "summer_campaign",
              planKey: "sport",
              campaignKey: "summer_padel_sport_2026",
              productId: "82caad6f-4d19-4d01-852b-932bdbb0f405",
              productName: "Лето.Падел.Спорт",
              totalLimit: 50,
              manualPaidCount: 38,
            },
            {
              counterKey: "academy",
              saleType: "direct_product",
              planKey: null,
              campaignKey: null,
              productId: "9eb8a7a4-c195-492a-95e4-3fb82899ac10",
              productName: "Лето.Падел.Академия",
              totalLimit: 50,
              manualPaidCount: 3,
            },
            {
              counterKey: "ra",
              saleType: "direct_product",
              planKey: null,
              campaignKey: null,
              productId: "b91e14d1-fe6e-4d0b-be39-3e45ad86b759",
              productName: "Лето.Падел.РА",
              totalLimit: 50,
              manualPaidCount: 27,
            },
          ],
        },
        payload: [
          {
            counterKey: "academy",
            productId: "9eb8a7a4-c195-492a-95e4-3fb82899ac10",
            status: "PAID",
          },
          {
            counterKey: "academy",
            productId: "9eb8a7a4-c195-492a-95e4-3fb82899ac10",
            status: "PAID",
          },
          {
            counterKey: "ra",
            productId: "b91e14d1-fe6e-4d0b-be39-3e45ad86b759",
            status: "PAID",
          },
          {
            counterKey: "ra",
            productId: "b91e14d1-fe6e-4d0b-be39-3e45ad86b759",
            status: "PAID",
          },
          {
            counterKey: "ra",
            productId: "b91e14d1-fe6e-4d0b-be39-3e45ad86b759",
            status: "PAYMENT_PENDING",
            expiresAt: "2026-06-01T10:10:00.000Z",
          },
        ],
      },
    ) as unknown[];

    const responseMsg = asRecord(out[0]);
    const payload = asRecord(responseMsg.payload);
    const plans = payload.plans as Array<Record<string, unknown>>;
    const sportPlan = asRecord(plans.find((plan) => plan.counterKey === "sport"));
    const academyPlan = asRecord(plans.find((plan) => plan.counterKey === "academy"));
    const raPlan = asRecord(plans.find((plan) => plan.counterKey === "ra"));

    assert.equal(sportPlan.remainingCount, 12);
    assert.equal(sportPlan.canPurchase, true);
    assert.equal(academyPlan.paidCount, 5);
    assert.equal(academyPlan.remainingCount, 45);
    assert.equal(raPlan.paidCount, 29);
    assert.equal(raPlan.reservedCount, 1);
    assert.equal(raPlan.remainingCount, 20);
  });
});

test("summer subscription status-response does not treat UNPAID rows as paid", () => {
  const out = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_status_response.js",
    {
      _summerSubscriptionCtx: {
        action: "status",
        singleCounter: true,
        selectedCounterKey: "ra",
        counters: [
          {
            counterKey: "ra",
            saleType: "direct_product",
            planKey: null,
            campaignKey: null,
            productId: "b91e14d1-fe6e-4d0b-be39-3e45ad86b759",
            productName: "Лето.Падел.РА",
            totalLimit: 5,
            manualPaidCount: 0,
          },
        ],
      },
      payload: [
        {
          inventoryId: "ab_leto_2026_50_v1",
          counterKey: "ra",
          productId: "b91e14d1-fe6e-4d0b-be39-3e45ad86b759",
          status: "UNPAID",
        },
      ],
    },
  ) as unknown[];

  const payload = asRecord(asRecord(out[0]).payload);
  assert.equal(payload.paidCount, 0);
  assert.equal(payload.reservedCount, 0);
  assert.equal(payload.remainingCount, 5);
});

test("summer subscription purchase-prepare supports dedicated Sirius friendship campaign with limit 100", () => {
  const out = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_purchase_prepare.js",
    {
      payload: {
        clientPhone: "79990000000",
        planKey: "friendship",
        campaignKey: "summer_padel_sirius_friendship_2026",
        paymentRef: "payment-ref-sirius-friendship",
      },
      req: { query: {} },
    },
    {
      summer_subscription_sirius_friendship_limit: 100,
    },
  ) as unknown[];

  const dbMsg = asRecord(out[0]);
  const ctx = asRecord(dbMsg._summerSubscriptionCtx);

  assert.equal(ctx.planKey, "friendship");
  assert.equal(ctx.campaignKey, "summer_padel_sirius_friendship_2026");
  assert.equal(ctx.totalLimit, 100);
});

test("summer subscription status-prepare returns single Sirius friendship campaign with limit 100", () => {
  const out = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_status_prepare.js",
    {
      req: {
        query: {
          campaignKey: "summer_padel_sirius_friendship_2026",
        },
      },
    },
    {
      summer_subscription_sirius_friendship_limit: 100,
    },
  ) as unknown[];

  const dbMsg = asRecord(out[0]);
  const ctx = asRecord(dbMsg._summerSubscriptionCtx);
  const plans = ctx.plans as Array<Record<string, unknown>>;

  assert.equal(asRecord(dbMsg.query).campaignKey, "summer_padel_sirius_friendship_2026");
  assert.equal(ctx.singleCounter, true);
  assert.equal(plans.length, 1);
  assert.equal(plans[0].planKey, "friendship");
  assert.equal(plans[0].totalLimit, 100);
});

test("summer subscription confirm-prepare keeps Sirius friendship campaign for explicit friendship plan", () => {
  const out = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_confirm_prepare.js",
    {
      payload: {
        paymentRef: "payment-ref-sirius-confirm",
        planKey: "friendship",
        campaignKey: "summer_padel_sirius_friendship_2026",
      },
      req: { query: {} },
    },
  ) as unknown[];

  const dbMsg = asRecord(out[0]);
  const ctx = asRecord(dbMsg._summerSubscriptionCtx);

  assert.equal(asRecord(dbMsg.query).paymentRef, "payment-ref-sirius-confirm");
  assert.equal(ctx.counterKey, "sirius_friendship");
  assert.equal(ctx.planKey, "friendship");
  assert.equal(ctx.campaignKey, "summer_padel_sirius_friendship_2026");
});

test("summer subscription counter refresh builds materialized counter updates", () => {
  const prepareOut = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_counter_refresh_prepare.js",
    { payload: Date.now() },
  ) as Record<string, unknown>;

  const preparedMsg = asRecord(prepareOut);
  const refreshCtx = asRecord(preparedMsg._summerSubscriptionCtx);
  const refreshCounters = refreshCtx.counters as Array<Record<string, unknown>>;
  assert.ok(refreshCounters.length >= 5);
  assert.deepEqual(preparedMsg.payload, preparedMsg.query);
  assert.notEqual(typeof preparedMsg.payload, "number");

  const buildOut = withFixedNow("2026-06-01T10:00:00.000Z", () => runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_counter_refresh_response.js",
    {
      _summerSubscriptionCtx: refreshCtx,
      payload: [
        {
          counterKey: "academy",
          inventoryId: "ab_leto_2026_50_v1",
          productId: "9eb8a7a4-c195-492a-95e4-3fb82899ac10",
          status: "PAID",
          updatedAt: "2026-06-01T09:40:00.000Z",
        },
        {
          counterKey: "academy",
          inventoryId: "ab_leto_2026_50_v1",
          productId: "9eb8a7a4-c195-492a-95e4-3fb82899ac10",
          status: "PAYMENT_PENDING",
          expiresAt: "2026-06-01T10:20:00.000Z",
          updatedAt: "2026-06-01T09:45:00.000Z",
        },
        {
          counterKey: "sport",
          inventoryId: "ab_leto_2026_50_v1",
          campaignKey: "summer_padel_sport_2026",
          productId: "82caad6f-4d19-4d01-852b-932bdbb0f405",
          productName: "Лето.Падел.Спорт",
          status: "PAID",
          updatedAt: "2026-06-01T09:30:00.000Z",
        },
        {
          campaignKey: "summer_padel_sport_2026",
          productId: "dfa72adf-233b-4285-8d69-e5eab4234fbe",
          productName: "Энергия 5 🎾",
          status: "PAID",
          updatedAt: "2026-06-01T09:35:00.000Z",
        },
      ],
    },
  )) as unknown[];

  const updates = buildOut[0] as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(updates));

  const academyUpdate = updates.find((entry) => asRecord(entry.query).counterKey === "academy");
  const kotelnikiUpdate = updates.find((entry) => asRecord(entry.query).counterKey === "kotelniki_friendship");
  const networkUpdate = updates.find((entry) => asRecord(entry.query).counterKey === "network_friendship");
  const piterUpdate = updates.find((entry) => asRecord(entry.query).counterKey === "piter_friendship");
  const sportUpdate = updates.find((entry) => asRecord(entry.query).counterKey === "sport");
  assert.ok(academyUpdate);
  assert.ok(kotelnikiUpdate);
  assert.ok(networkUpdate);
  assert.ok(piterUpdate);
  assert.ok(sportUpdate);

  const academySet = asRecord(asRecord(academyUpdate!.payload).$set);
  const sportSet = asRecord(asRecord(sportUpdate!.payload).$set);

  assert.equal(academySet.paidCount, 1);
  assert.equal(academySet.reservedCount, 1);
  assert.equal(academySet.takenCount, 2);
  assert.equal(academySet.remainingCount, 0);
  assert.equal(academySet.canPurchase, true);
  assert.equal(academySet.unlimited, true);

  assert.equal(sportSet.paidCount, 1);
  assert.equal(sportSet.reservedCount, 0);
  assert.equal(sportSet.takenCount, 1);
  assert.equal(sportSet.remainingCount, 131);

  const kotelnikiSet = asRecord(asRecord(kotelnikiUpdate!.payload).$set);
  const networkSet = asRecord(asRecord(networkUpdate!.payload).$set);
  const piterSet = asRecord(asRecord(piterUpdate!.payload).$set);
  assert.equal(kotelnikiSet.totalLimit, 200);
  assert.equal(kotelnikiSet.batchSize, 50);
  assert.equal(kotelnikiSet.remainingCount, 200);
  assert.equal(kotelnikiSet.bindingReady, false);
  assert.equal(kotelnikiSet.canPurchase, false);
  assert.equal(networkSet.totalLimit, 10);
  assert.equal(networkSet.batchSize, 10);
  assert.equal(networkSet.remainingCount, 10);
  assert.equal(networkSet.dailyDropActive, true);
  assert.equal(networkSet.dailyLimit, 10);
  assert.equal(networkSet.inventoryTotalLimit, 100);
  assert.equal(networkSet.inventoryRemainingCount, 100);
  assert.equal(networkSet.bindingReady, true);
  assert.equal(networkSet.managedSaleReady, false);
  assert.equal(networkSet.managedSaleError, "MANAGED_SUBSCRIPTION_SALE_READINESS_UNAVAILABLE");
  assert.equal(networkSet.canPurchase, false);
  assert.equal(piterSet.totalLimit, 400);
  assert.equal(piterSet.batchSize, 100);
  assert.equal(piterSet.remainingCount, 400);
  assert.equal(piterSet.bindingReady, true);
  assert.equal(piterSet.managedSaleReady, false);
  assert.equal(piterSet.canPurchase, false);
});

test("materialized HAB counter expires undated reservations and honors paymentExpiresAt", () => {
  const nowIso = "2026-09-03T12:00:00.000Z";
  const prepareOut = withFixedNow(nowIso, () => runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_counter_refresh_prepare.js",
    { payload: Date.now() },
  )) as Record<string, unknown>;
  const refreshCtx = asRecord(asRecord(prepareOut)._summerSubscriptionCtx);
  const rows = [
    {
      counterKey: "network_friendship",
      inventoryId: "network_friendship_12m_2026_v1",
      status: "PAYMENT_PENDING",
      createdAt: "2026-09-03T08:00:00.000Z",
    },
    {
      counterKey: "network_friendship",
      inventoryId: "network_friendship_12m_2026_v1",
      status: "PAYMENT_PENDING",
      createdAt: "2026-09-03T08:20:00.000Z",
      paymentExpiresAt: "2026-09-03T13:00:00.000Z",
    },
    {
      counterKey: "network_friendship",
      inventoryId: "network_friendship_12m_2026_v1",
      status: "PAYMENT_PENDING",
      createdAt: "2026-09-03T08:30:00.000Z",
      expiresAt: "2026-09-03T11:59:00.000Z",
      paymentExpiresAt: "2026-09-03T13:00:00.000Z",
    },
  ];
  const buildOut = withFixedNow(nowIso, () => runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_counter_refresh_response.js",
    { _summerSubscriptionCtx: refreshCtx, payload: rows },
  )) as unknown[];
  const updates = buildOut[0] as Array<Record<string, unknown>>;
  const networkUpdate = updates.find((entry) => asRecord(entry.query).counterKey === "network_friendship");
  assert.ok(networkUpdate);
  const networkSet = asRecord(asRecord(networkUpdate.payload).$set);
  assert.equal(networkSet.reservedCount, 2);
  assert.equal(networkSet.remainingCount, 8);
  assert.equal(networkSet.inventoryReservedCount, 2);
  assert.equal(networkSet.inventoryRemainingCount, 98);
});

test("summer subscription materialized counters ignore legacy manual paid baselines", () => {
  const prepareOut = withFixedNow("2026-06-01T10:00:00.000Z", () => runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_counter_refresh_prepare.js",
    { payload: Date.now() },
    {
      summer_subscription_academy_manual_paid_count: 3,
      summer_subscription_ra_manual_paid_count: 27,
      summer_subscription_sport_manual_paid_count: 38,
    },
  )) as Record<string, unknown>;

  const preparedMsg = asRecord(prepareOut);
  const refreshCtx = asRecord(preparedMsg._summerSubscriptionCtx);

  const buildOut = withFixedNow("2026-06-01T10:00:00.000Z", () => runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_counter_refresh_response.js",
    {
      _summerSubscriptionCtx: refreshCtx,
      payload: [
        {
          counterKey: "academy",
          inventoryId: "ab_leto_2026_50_v1",
          productId: "9eb8a7a4-c195-492a-95e4-3fb82899ac10",
          status: "PAID",
        },
        {
          counterKey: "ra",
          inventoryId: asRecord(refreshCtx.counters.find((counter) => counter.counterKey === "ra")).inventoryId,
          productId: "b91e14d1-fe6e-4d0b-be39-3e45ad86b759",
          status: "PAID",
        },
      ],
    },
  )) as unknown[];

  const updates = buildOut[0] as Array<Record<string, unknown>>;
  const academyUpdate = updates.find((entry) => asRecord(entry.query).counterKey === "academy");
  const raUpdate = updates.find((entry) => asRecord(entry.query).counterKey === "ra");
  const sportUpdate = updates.find((entry) => asRecord(entry.query).counterKey === "sport");
  assert.ok(academyUpdate);
  assert.ok(raUpdate);
  assert.ok(sportUpdate);

  const academySet = asRecord(asRecord(academyUpdate!.payload).$set);
  const raSet = asRecord(asRecord(raUpdate!.payload).$set);
  const sportSet = asRecord(asRecord(sportUpdate!.payload).$set);

  assert.equal(academySet.paidCount, 1);
  assert.equal(academySet.remainingCount, 0);
  assert.equal(academySet.canPurchase, true);
  assert.equal(academySet.unlimited, true);
  assert.equal(raSet.paidCount, 1);
  assert.equal(raSet.remainingCount, 4);
  assert.equal(sportSet.paidCount, 0);
  assert.equal(sportSet.remainingCount, 132);
});

test("summer subscription counter refresh materializes the staged daily phase", () => {
  const nowIso = "2026-09-04T12:00:00.000Z";
  const prepareOut = withFixedNow(nowIso, () => runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_counter_refresh_prepare.js",
    { payload: Date.now() },
  )) as Record<string, unknown>;
  const refreshCtx = asRecord(asRecord(prepareOut)._summerSubscriptionCtx);
  const raCounter = asRecord(
    (refreshCtx.counters as Array<Record<string, unknown>>)
      .find((counter) => counter.counterKey === "ra"),
  );
  const inventoryId = String(raCounter.inventoryId);
  const dailyDropDate = String(raCounter.dailyDropDate);
  const rows = [
    ...Array.from({ length: 150 }, () => ({
      counterKey: "ra",
      inventoryId,
      releasePhase: "launch",
      status: "PAID",
      updatedAt: "2026-09-03T06:00:00.000Z",
    })),
    ...Array.from({ length: 2 }, () => ({
      counterKey: "ra",
      inventoryId,
      releasePhase: "daily",
      dailyDropDate,
      status: "PAID",
    })),
  ];
  const buildOut = withFixedNow(nowIso, () => runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_counter_refresh_response.js",
    { _summerSubscriptionCtx: refreshCtx, payload: rows },
  )) as unknown[];
  const updates = buildOut[0] as Array<Record<string, unknown>>;
  const raUpdate = updates.find((entry) => asRecord(entry.query).counterKey === "ra");
  assert.ok(raUpdate);
  const state = asRecord(asRecord(raUpdate.payload).$set);
  assert.equal(state.releasePhase, "daily");
  assert.equal(state.dailyDropActive, true);
  assert.equal(state.launchPaidCount, 150);
  assert.equal(state.totalLimit, 10);
  assert.equal(state.paidCount, 2);
  assert.equal(state.remainingCount, 8);
});

test("summer subscription reconciliation selects only live pending payments from supported inventories", () => {
  const prepared = withFixedNow("2026-07-08T10:00:00.000Z", () => runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_reconcile_query.js",
    { payload: Date.now() },
  )) as Record<string, unknown>;

  assert.deepEqual(prepared.query, {
    inventoryId: { $regex: "^(?:ab_leto_2026_50_v1(?:_(?:friendship|ra)_.*)?|ab_leto_2026_100_then_7_v1_(?:friendship|ra)|ab_leto_2026_150_v2_(?:friendship|ra)|kotelniki_friendship_12m_2026_v1|network_friendship_12m_2026_v1|piter_friendship_12m_2026_v1)$" },
    status: "PAYMENT_PENDING",
    transactionId: { $nin: [null, ""] },
    $or: [
      { expiresAt: { $gt: "2026-07-08T10:00:00.000Z" } },
      { paymentExpiresAt: { $gt: "2026-07-08T10:00:00.000Z" } },
      {
        $and: [
          {
            $or: [
              { expiresAt: { $exists: false } },
              { expiresAt: null },
              { expiresAt: "" },
            ],
          },
          {
            $or: [
              { paymentExpiresAt: { $exists: false } },
              { paymentExpiresAt: null },
              { paymentExpiresAt: "" },
            ],
          },
          { createdAt: { $gt: "2026-07-08T09:30:00.000Z" } },
        ],
      },
    ],
  });
  assert.deepEqual(prepared.payload, prepared.query);
  assert.equal(prepared.limit, 200);

  const reconcileMeta = asRecord(prepared._summerSubscriptionReconcile);
  assert.equal(reconcileMeta.requestedAt, "2026-07-08T10:00:00.000Z");
  assert.equal(reconcileMeta.reservationMinutes, 30);
  assert.equal(reconcileMeta.createdAtCutoff, "2026-07-08T09:30:00.000Z");
  assert.deepEqual(reconcileMeta.regionalInventoryIds, [
    "kotelniki_friendship_12m_2026_v1",
    "network_friendship_12m_2026_v1",
    "piter_friendship_12m_2026_v1",
  ]);
});

test("summer subscription reconciliation keeps regional inventory overrides exact and escaped", () => {
  const prepared = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_reconcile_query.js",
    { payload: Date.now() },
    {
      summer_subscription_piter_friendship_inventory_id: "piter.special[1]",
    },
  ) as Record<string, unknown>;

  const inventoryFilter = asRecord(asRecord(prepared.query).inventoryId);
  const pattern = new RegExp(String(inventoryFilter.$regex));
  assert.equal(pattern.test("piter_friendship_12m_2026_v1"), true);
  assert.equal(pattern.test("network_friendship_12m_2026_v1"), true);
  assert.equal(pattern.test("kotelniki_friendship_12m_2026_v1"), true);
  assert.equal(pattern.test("piter.special[1]"), true);
  assert.equal(pattern.test("piterXspecial1"), false);
  assert.equal(pattern.test("piter.special[1]-unexpected"), false);

  const reconcileMeta = asRecord(prepared._summerSubscriptionReconcile);
  assert.deepEqual(reconcileMeta.regionalInventoryIds, [
    "kotelniki_friendship_12m_2026_v1",
    "network_friendship_12m_2026_v1",
    "piter_friendship_12m_2026_v1",
    "piter.special[1]",
  ]);
});

test("summer subscription reconciliation converts a pending sale into confirm context", () => {
  const prepared = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_reconcile_record.js",
    {
      payload: {
        inventoryId: "ab_leto_2026_50_v1",
        counterKey: "academy",
        paymentRef: "reconcile-payment-ref",
        transactionId: "reconcile-transaction-id",
        status: "PAYMENT_PENDING",
      },
    },
  ) as Record<string, unknown>;

  const ctx = asRecord(prepared._summerSubscriptionCtx);
  assert.equal(ctx.action, "confirm");
  assert.equal(ctx.step, "resolve_record");
  assert.equal(ctx.reconcile, true);
  assert.equal(ctx.paymentRef, "reconcile-payment-ref");
  assert.equal((prepared.payload as unknown[]).length, 1);
});

test("scheduled subscription reconciliation persists PAID without writing an HTTP response", () => {
  const out = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_purchase_router.js",
    {
      statusCode: 200,
      payload: { status: "PAID", toPay: 0 },
      _summerSubscriptionCtx: {
        action: "confirm",
        step: "confirm_lookup",
        reconcile: true,
        inventoryId: "ab_leto_2026_50_v1",
        counterKey: "academy",
        paymentRef: "reconcile-payment-ref",
        transactionId: "reconcile-transaction-id",
        toPayMinor: 2380000,
      },
    },
  ) as unknown[];

  const dbPayload = asRecord(asRecord(out[1]).payload);
  const dbSet = asRecord(dbPayload.$set);
  assert.equal(dbSet.status, "PAID");
  assert.equal(out[2], null);
  assert.equal(asRecord(asRecord(out[3]).payload).status, "PAID");
});

test("summer subscription confirm lookup does not treat UNPAID Viva transactions as paid", () => {
  const out = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_purchase_router.js",
    {
      statusCode: 200,
      payload: {
        status: "UNPAID",
        toPay: 2380000,
        expiresAt: "2026-07-06T12:30:00.000Z",
      },
      _summerSubscriptionCtx: {
        action: "confirm",
        step: "confirm_lookup",
        inventoryId: "ab_leto_2026_50_v1",
        counterKey: "ra",
        paymentRef: "ra-summer-unpaid",
        transactionId: "txn-unpaid",
        toPayMinor: 2380000,
      },
    },
  ) as unknown[];

  const dbSet = asRecord(asRecord(asRecord(out[1]).payload).$set);
  const responsePayload = asRecord(asRecord(out[2]).payload);
  assert.equal(dbSet.status, "PAYMENT_PENDING");
  assert.equal(dbSet.paidAt, null);
  assert.equal(responsePayload.status, "PAYMENT_PENDING");
  assert.equal(responsePayload.paid, false);
  assert.equal(responsePayload.failed, false);
});

const PITER_PRODUCT_GLOBALS = {
  summer_subscription_piter_friendship_product_id: "8bf334ba-3050-4017-b40a-7eef2db1eb16",
};

function buildPiterRows(count: number) {
  return [{
    _id: "inventory:piter_friendship_12m_2026_v1",
    inventoryId: "piter_friendship_12m_2026_v1",
    counterKey: "piter_friendship",
    ready: true,
    schemaVersion: 1,
    revision: 7,
    baselineDigest: "a".repeat(64),
    baselineCapturedAt: "2026-09-03T12:00:00.000Z",
    paidCount: count,
    reservedCount: 0,
    takenCount: count,
    legacyPaymentRefs: Array.from({ length: count }, (_, index) => `legacy-paid-${index + 1}`),
    reservations: [],
  }, ...Array.from({ length: count }, () => ({
    inventoryId: "piter_friendship_12m_2026_v1",
    counterKey: "piter_friendship",
    productId: "8bf334ba-3050-4017-b40a-7eef2db1eb16",
    status: "PAID",
  }))];
}

function quotaLedger(newPaid = 0) {
  return { ...buildPiterRows(41)[0], schemaVersion: 2, quotaAdjustment: 9,
    paidCount: 41 + newPaid, takenCount: 41 + newPaid,
    reservations: Array.from({ length: newPaid }, (_, i) => ({
      paymentRef: `quota-paid-${i}`, transactionId: `quota-tx-${i}`, state: "PAID",
    })) };
}

function quotaPurchaseContext() {
  const productId = PITER_PRODUCT_GLOBALS.summer_subscription_piter_friendship_product_id;
  return { step: "piter_ledger_find", counterKey: "piter_friendship", inventoryId: "piter_friendship_12m_2026_v1",
    paymentRef: "quota-new", clientPhone: "79990000000", clientId: null, totalLimit: 400, batchSize: 100,
    providerProductCostMinor: 5680000, providerPayload: { products: [{ id: productId, discount: 3700000 }] },
    tiers: [1980000, 2380000, 3680000, 5680000].map(priceMinor => ({ productId, productName: "Питер", priceMinor, providerProductCostMinor: 5680000 })) };
}

test("Piter V2 quota starts at 50/100 with 41 real payments and advances tiers consistently", () => {
  const prepared = runNodeRedFunction("scripts/nodered_games_nodes/fn_tournament_subscription_status_prepare.js",
    { req: { query: { counterKey: "piter_friendship" } } }, PITER_PRODUCT_GLOBALS) as unknown[];
  for (const [newPaid, remaining, batch, price] of [[0, 50, 1, 1980000], [1, 49, 1, 1980000], [49, 1, 1, 1980000], [50, 100, 2, 2380000], [349, 1, 4, 5680000]]) {
    const ledger = quotaLedger(newPaid);
    const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_tournament_subscription_status_response.js",
      { _summerSubscriptionCtx: structuredClone(asRecord(prepared[0])._summerSubscriptionCtx), payload: [ledger] }, PITER_PRODUCT_GLOBALS) as unknown[];
    const status = asRecord(asRecord(out[0]).payload);
    assert.equal(status.paidCount, 41 + newPaid);
    assert.equal(status.quotaAdjustment, 9);
    assert.equal(status.batchRemainingCount, remaining);
    assert.equal(status.batchIndex, batch);
    assert.equal(status.priceMinor, price);
    assert.equal(status.canPurchase, true);
    const reserve = runNodeRedFunction("scripts/nodered_games_nodes/fn_tournament_subscription_piter_atomic_router.js",
      { _summerSubscriptionCtx: quotaPurchaseContext(), payload: [ledger] }) as unknown[];
    const ctx = asRecord(asRecord(reserve[1])._summerSubscriptionCtx);
    assert.equal(ctx.batchRemainingBefore, remaining);
    assert.equal(ctx.batchIndex, batch);
    assert.equal(ctx.priceMinor, price);
    const args = asRecord(reserve[1]).payload as unknown[];
    assert.equal(asRecord(args[0]).schemaVersion, 2);
    assert.equal(asRecord(args[0]).quotaAdjustment, 9);
    assert.equal(asRecord(asRecord(args[1]).$inc).takenCount, 1);
  }
});

test("Piter V2 rejects quota tampering and overselling; final-slot CAS still binds revision", () => {
  for (const ledger of [quotaLedger(350), { ...quotaLedger(), quotaAdjustment: 8 },
    { ...quotaLedger(), quotaAdjustment: "9" }, { ...quotaLedger(), schemaVersion: 1 }]) {
    const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_tournament_subscription_piter_atomic_router.js",
      { _summerSubscriptionCtx: quotaPurchaseContext(), payload: [ledger] }) as unknown[];
    assert.equal(out[1], null); assert.equal(out[4], null); assert.ok(out[3]);
  }
  const last = quotaLedger(349);
  const outputs = ["quota-a", "quota-b"].map(paymentRef => runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_piter_atomic_router.js",
    { _summerSubscriptionCtx: { ...quotaPurchaseContext(), paymentRef }, payload: [last] }) as unknown[]);
  for (const out of outputs) {
    const filter = asRecord((asRecord(out[1]).payload as unknown[])[0]);
    assert.equal(filter.revision, last.revision); assert.equal(filter.takenCount, 390);
    assert.equal(filter.quotaAdjustment, 9);
  }
});

test("Piter V2 carries exact quota custody through dispatch and provider-result writes", () => {
  const reserved = runNodeRedFunction("scripts/nodered_games_nodes/fn_tournament_subscription_piter_atomic_router.js",
    { _summerSubscriptionCtx: quotaPurchaseContext(), payload: [quotaLedger()] }) as unknown[];
  const captured = asRecord(asRecord(reserved[1])._summerSubscriptionCtx);
  assert.equal(captured.ledgerSchemaVersion, 2);
  assert.equal(captured.ledgerQuotaAdjustment, 9);
  for (const step of ["piter_dispatch_claim", "piter_provider_result"]) {
    for (const v2 of [false, true]) {
      const context = { ...quotaPurchaseContext(), step,
        ...(v2 ? { ledgerSchemaVersion: 2, ledgerQuotaAdjustment: 9 } : {}) };
      const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_tournament_subscription_piter_atomic_router.js",
        { _summerSubscriptionCtx: context }) as unknown[];
      const filter = asRecord((asRecord(out[1]).payload as unknown[])[0]);
      assert.equal(filter.schemaVersion, v2 ? 2 : 1);
      assert.deepEqual(filter.quotaAdjustment, v2 ? 9 : { $exists: false });
      const failed = runNodeRedFunction("scripts/nodered_games_nodes/fn_tournament_subscription_piter_atomic_router.js",
        { _summerSubscriptionCtx: asRecord(out[1])._summerSubscriptionCtx,
          payload: { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0, upsertedId: null } }) as unknown[];
      assert.equal(failed[4], null);
      assert.ok(failed[3]);
    }
    const invalid = runNodeRedFunction("scripts/nodered_games_nodes/fn_tournament_subscription_piter_atomic_router.js",
      { _summerSubscriptionCtx: { ...quotaPurchaseContext(), step, ledgerSchemaVersion: 2 } }) as unknown[];
    assert.equal(invalid[1], null); assert.equal(invalid[4], null); assert.ok(invalid[3]);
  }
});

test("Piter V2 failed confirmation releases a reservation without changing the quota adjustment", () => {
  const ledger = { ...quotaLedger(), reservedCount: 1, takenCount: 42,
    reservations: [{ paymentRef: "quota-new", requestFingerprint: "quota-fp", intentFingerprint: "quota-intent",
      transactionId: "quota-tx", state: "PAYMENT_PENDING", priceMinor: 1980000 }] };
  for (const nextStatus of ["FAILED", "PAID"]) {
    const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_tournament_subscription_piter_atomic_router.js",
      { payload: [ledger], _summerSubscriptionCtx: { ...quotaPurchaseContext(), step: "piter_confirm_validate",
        requestFingerprint: "quota-fp", transactionId: "quota-tx", expectedAmountMinor: 1980000,
        confirmResult: { nextStatus, paid: nextStatus === "PAID", transactionId: "quota-tx" } } }) as unknown[];
    const args = asRecord(out[1]).payload as unknown[];
    assert.equal(asRecord(args[0]).schemaVersion, 2);
    assert.equal(asRecord(args[0]).quotaAdjustment, 9);
    const inc = asRecord(asRecord(args[1]).$inc);
    assert.equal(inc.reservedCount, -1);
    assert.equal(inc.quotaAdjustment, undefined);
    assert.equal(inc.takenCount, nextStatus === "FAILED" ? -1 : undefined);
  }
});

test("Piter status uses a dedicated 400-unit inventory and server-side batches of 100", () => {
  const prepared = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_status_prepare.js",
    { req: { query: { counterKey: "piter_friendship" } } },
    PITER_PRODUCT_GLOBALS,
  ) as unknown[];

  const dbMsg = asRecord(prepared[0]);
  const ctx = asRecord(dbMsg._summerSubscriptionCtx);
  const counter = asRecord((ctx.counters as Array<Record<string, unknown>>)[0]);
  assert.deepEqual(dbMsg.query, {
    inventoryId: "piter_friendship_12m_2026_v1",
    counterKey: "piter_friendship",
  });
  assert.equal(counter.totalLimit, 400);
  assert.equal(counter.batchSize, 100);
  assert.equal((counter.tiers as unknown[]).length, 4);

  const firstBatch = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_status_response.js",
    { _summerSubscriptionCtx: ctx, payload: buildPiterRows(99) },
    PITER_PRODUCT_GLOBALS,
  ) as unknown[];
  const firstPayload = asRecord(asRecord(firstBatch[0]).payload);
  assert.equal(firstPayload.batchIndex, 1);
  assert.equal(firstPayload.batchRemainingCount, 1);
  assert.equal(firstPayload.priceMinor, 1980000);
  assert.equal(firstPayload.productId, "8bf334ba-3050-4017-b40a-7eef2db1eb16");
  assert.equal(firstPayload.providerProductCostMinor, 5680000);
  assert.equal(firstPayload.discountMinor, 3700000);
  assert.equal(firstPayload.bindingReady, true);
  assert.equal(firstPayload.managedSaleReady, true);
  assert.equal(firstPayload.managedSaleError, null);
  assert.equal(firstPayload.canPurchase, true);

  const currentProductionShape = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_status_response.js",
    { _summerSubscriptionCtx: ctx, payload: buildPiterRows(42) },
    PITER_PRODUCT_GLOBALS,
  ) as unknown[];
  const currentPayload = asRecord(asRecord(currentProductionShape[0]).payload);
  assert.equal(currentPayload.batchIndex, 1);
  assert.equal(currentPayload.batchRemainingCount, 58);
  assert.equal(currentPayload.remainingCount, 358);
  assert.equal(currentPayload.canPurchase, true);

  const secondBatch = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_status_response.js",
    { _summerSubscriptionCtx: ctx, payload: buildPiterRows(100) },
    PITER_PRODUCT_GLOBALS,
  ) as unknown[];
  const secondPayload = asRecord(asRecord(secondBatch[0]).payload);
  assert.equal(secondPayload.batchIndex, 2);
  assert.equal(secondPayload.batchRemainingCount, 100);
  assert.equal(secondPayload.priceMinor, 2380000);
  assert.equal(secondPayload.productId, "8bf334ba-3050-4017-b40a-7eef2db1eb16");
  assert.equal(secondPayload.discountMinor, 3300000);
});

test("Piter purchase uses the server-bound legacy sale lifecycle while managed usage stays disabled", () => {
  const prepared = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_purchase_prepare.js",
    {
      payload: {
        clientPhone: "79990000000",
        counterKey: "piter_friendship",
        productId: "forged-browser-product",
        paymentRef: "piter-payment-ref",
      },
      req: { query: {} },
    },
    PITER_PRODUCT_GLOBALS,
  ) as unknown[];
  assert.ok(prepared[0]);
  assert.equal(prepared[1], null);
  const ctx = asRecord(asRecord(prepared[0])._summerSubscriptionCtx);
  assert.equal(ctx.counterKey, "piter_friendship");
  assert.equal(ctx.productId, null);
  assert.equal(ctx.saleType, "tiered_direct_product");
});

test("Piter purchase-limit accepts the server-bound legacy context", () => {
  const prepared = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_purchase_prepare.js",
    {
      payload: {
        clientPhone: "79990000000",
        counterKey: "piter_friendship",
        paymentRef: "piter-limit-context",
      },
      req: { query: {} },
    },
    PITER_PRODUCT_GLOBALS,
  ) as unknown[];
  const preparedCtx = asRecord(asRecord(prepared[0])._summerSubscriptionCtx);
  const limited = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_purchase_limit.js",
    {
      _summerSubscriptionCtx: preparedCtx,
      payload: buildPiterRows(42),
    },
    PITER_PRODUCT_GLOBALS,
  ) as unknown[];
  assert.ok(limited[0]);
  assert.equal(limited[1], null);
  const ctx = asRecord(asRecord(limited[0])._summerSubscriptionCtx);
  assert.equal(ctx.counterKey, "piter_friendship");
  assert.equal(ctx.batchIndex, 1);
  assert.equal(ctx.batchRemainingBefore, 58);
  assert.equal(ctx.priceMinor, 1980000);
});

test("Piter atomic ledger CAS reserves before provider and replays the same paymentRef", () => {
  const ctx = {
    action: "purchase",
    step: "piter_ledger_find",
    counterKey: "piter_friendship",
    inventoryId: "piter_friendship_12m_2026_v1",
    paymentRef: "piter-atomic-1",
    clientPhone: "79990000000",
    clientId: null,
    batchIndex: 1,
    batchSize: 100,
    priceMinor: 1980000,
    productId: "8bf334ba-3050-4017-b40a-7eef2db1eb16",
    productName: "Падел.Дружба.Питер — годовая",
    totalLimit: 400,
    providerProductCostMinor: 5680000,
    providerPayload: {
      products: [{ id: "8bf334ba-3050-4017-b40a-7eef2db1eb16", discount: 3700000 }],
    },
    tiers: [
      { productId: "8bf334ba-3050-4017-b40a-7eef2db1eb16", productName: "Питер", priceMinor: 1980000, providerProductCostMinor: 5680000 },
      { productId: "8bf334ba-3050-4017-b40a-7eef2db1eb16", productName: "Питер", priceMinor: 2380000, providerProductCostMinor: 5680000 },
      { productId: "8bf334ba-3050-4017-b40a-7eef2db1eb16", productName: "Питер", priceMinor: 3680000, providerProductCostMinor: 5680000 },
      { productId: "8bf334ba-3050-4017-b40a-7eef2db1eb16", productName: "Питер", priceMinor: 5680000, providerProductCostMinor: 5680000 },
    ],
  };
  const reserved = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_piter_atomic_router.js",
    { _summerSubscriptionCtx: ctx, payload: buildPiterRows(399).slice(0, 1) },
  ) as unknown[];
  assert.ok(reserved[1]);
  const args = asRecord(reserved[1]).payload as unknown[];
  const filter = asRecord(args[0]);
  const update = asRecord(args[1]);
  assert.equal(filter.takenCount, 399);
  assert.equal(asRecord(update.$inc).takenCount, 1);
  assert.equal(asRecord(update.$inc).reservedCount, 1);
  const pushed = asRecord(asRecord(update.$push).reservations);
  assert.equal(pushed.state, "CLAIMED");

  const requestFingerprint = String(pushed.requestFingerprint);
  const replayed = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_piter_atomic_router.js",
    {
      _summerSubscriptionCtx: { ...ctx, step: "piter_ledger_find" },
      payload: [{
        ...buildPiterRows(399)[0],
        reservedCount: 1,
        takenCount: 400,
        reservations: [{
          paymentRef: ctx.paymentRef,
          requestFingerprint,
          intentFingerprint: [ctx.inventoryId, ctx.counterKey, ctx.clientPhone, ""].join("\n"),
          state: "PAYMENT_PENDING",
          transactionId: "tx-1",
          paymentUrl: "https://pay.example.test/tx-1",
          clientPhone: ctx.clientPhone,
          batchIndex: 4,
          batchSize: 100,
          priceMinor: 5680000,
          productId: ctx.productId,
          productName: ctx.productName,
          providerProductCostMinor: 5680000,
          discountMinor: 0,
          toPayMinor: 5680000,
        }],
      }],
    },
  ) as unknown[];
  assert.ok(replayed[2]);
  assert.equal(replayed[4], null);
  const healed = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_piter_atomic_router.js",
    {
      _summerSubscriptionCtx: asRecord(replayed[2])._summerSubscriptionCtx,
      payload: { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 1, upsertedId: "sale-1" },
    },
  ) as unknown[];
  assert.equal(asRecord(healed[3]).statusCode, 200);
  assert.equal(asRecord(asRecord(healed[3]).payload).replayed, true);
  assert.equal(healed[4], null);
});

test("Piter atomic router rejects non-flat or partial Mongo ACK before Viva POST", () => {
  for (const payload of [
    [{ acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedCount: 0, upsertedId: null }],
    { acknowledged: true, matchedCount: 1, modifiedCount: 1 },
    { acknowledged: "true", matchedCount: 1, modifiedCount: 1, upsertedCount: 0, upsertedId: null },
  ]) {
    const out = runNodeRedFunction(
      "scripts/nodered_games_nodes/fn_tournament_subscription_piter_atomic_router.js",
      {
        _summerSubscriptionCtx: {
          step: "piter_dispatch_ack",
          counterKey: "piter_friendship",
          inventoryId: "piter_friendship_12m_2026_v1",
        },
        payload,
      },
    ) as unknown[];
    assert.equal(out[4], null);
    assert.equal(asRecord(out[3]).statusCode, 409);
  }
});

test("Piter CLAIMED replay keeps the originally reserved tier before the only Viva POST", () => {
  const paymentRef = "piter-claimed-replay";
  const clientPhone = "79990000000";
  const requestFingerprint = [
    "piter_friendship_12m_2026_v1", "piter_friendship", paymentRef, clientPhone, "",
  ].join("\n");
  const ctx = {
    step: "piter_ledger_find",
    counterKey: "piter_friendship",
    inventoryId: "piter_friendship_12m_2026_v1",
    paymentRef,
    clientPhone,
    clientId: null,
    totalLimit: 400,
    providerProductCostMinor: 5680000,
    providerPayload: {
      products: [{ id: "8bf334ba-3050-4017-b40a-7eef2db1eb16", discount: 3300000 }],
    },
  };
  const ledger = {
    ...buildPiterRows(99)[0],
    reservedCount: 1,
    takenCount: 100,
    reservations: [{
      paymentRef,
      requestFingerprint,
      intentFingerprint: ["piter_friendship_12m_2026_v1", "piter_friendship", clientPhone, ""].join("\n"),
      state: "CLAIMED",
      clientPhone,
      clientId: null,
      batchIndex: 1,
      batchSize: 100,
      priceMinor: 1980000,
      productId: "8bf334ba-3050-4017-b40a-7eef2db1eb16",
      productName: "Питер",
      providerProductCostMinor: 5680000,
      discountMinor: 3700000,
    }],
  };
  const claimed = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_piter_atomic_router.js",
    { _summerSubscriptionCtx: ctx, payload: [ledger] },
  ) as unknown[];
  assert.ok(claimed[1]);
  const claimedCtx = asRecord(asRecord(claimed[1])._summerSubscriptionCtx);
  assert.equal(claimedCtx.priceMinor, 1980000);
  assert.equal(asRecord((asRecord(claimedCtx.providerPayload).products as unknown[])[0]).discount, 3700000);

  const dispatched = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_piter_atomic_router.js",
    {
      _summerSubscriptionCtx: claimedCtx,
      payload: { acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedCount: 0, upsertedId: null },
    },
  ) as unknown[];
  assert.ok(dispatched[4]);
  const providerLine = asRecord((asRecord(asRecord(dispatched[4]).payload).products as unknown[])[0]);
  assert.equal(providerLine.discount, 3700000);
});

test("Piter CLAIMED replay fails closed when the live provider product no longer matches", () => {
  const paymentRef = "piter-claimed-drift";
  const clientPhone = "79990000000";
  const requestFingerprint = [
    "piter_friendship_12m_2026_v1", "piter_friendship", paymentRef, clientPhone, "",
  ].join("\n");
  const out = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_piter_atomic_router.js",
    {
      _summerSubscriptionCtx: {
        step: "piter_ledger_find", counterKey: "piter_friendship",
        inventoryId: "piter_friendship_12m_2026_v1", paymentRef, clientPhone,
        clientId: null, totalLimit: 400, providerProductCostMinor: 5700000,
        providerPayload: { products: [{ id: "8bf334ba-3050-4017-b40a-7eef2db1eb16", discount: 0 }] },
      },
      payload: [{
        ...buildPiterRows(99)[0], reservedCount: 1, takenCount: 100,
        reservations: [{ paymentRef, requestFingerprint,
          intentFingerprint: ["piter_friendship_12m_2026_v1", "piter_friendship", clientPhone, ""].join("\n"),
          state: "CLAIMED", clientPhone,
          priceMinor: 1980000, productId: "8bf334ba-3050-4017-b40a-7eef2db1eb16",
          providerProductCostMinor: 5680000, discountMinor: 3700000 }],
      }],
    },
  ) as unknown[];
  assert.equal(out[4], null);
  assert.equal(asRecord(asRecord(asRecord(out[3]).payload).details).code, "PITER_CLAIMED_TIER_DRIFT");
});

test("Piter confirm accepts only explicit PAID with the exact transaction identity and zero balance", () => {
  const providerFacts = {
    sum: 1980000,
    clientId: "client-piter-1",
    clientPhone: ["+7", "9990000000"].join(""),
    products: [{ id: "8bf334ba-3050-4017-b40a-7eef2db1eb16", discount: 3700000 }],
  };
  const baseCtx = {
    action: "confirm", step: "confirm_lookup", counterKey: "piter_friendship",
    inventoryId: "piter_friendship_12m_2026_v1", paymentRef: "piter-confirm-1",
    transactionId: "tx-piter-1", expectedAmountMinor: 1980000,
    requestFingerprint: "fingerprint-1", toPayMinor: 1980000,
    clientId: "client-piter-1", clientPhone: "79990000000",
    productId: "8bf334ba-3050-4017-b40a-7eef2db1eb16",
    saleRecord: { providerProductCostMinor: 5680000, discountMinor: 3700000 },
  };
  for (const payload of [
    { id: "tx-piter-1", status: "UNPAID", toPay: 0 },
    { id: "different-id", status: "PAID", toPay: 0 },
    { id: "tx-piter-1", status: "PAID", toPay: 1980000 },
    { id: "tx-piter-1", status: "PAID", toPay: 0, sum: 2380000 },
    { id: "tx-piter-1", status: "PAID", toPay: 0, clientId: "other-client" },
    { id: "tx-piter-1", status: "PAID", toPay: 0, products: [{ id: "other-product", discount: 3700000 }] },
    { id: "tx-piter-1", status: "PAID", toPay: 0, products: [
      { id: "8bf334ba-3050-4017-b40a-7eef2db1eb16", discount: 3700000 },
      { id: "unexpected-product", discount: 0 },
    ] },
  ]) {
    const out = runNodeRedFunction(
      "scripts/nodered_games_nodes/fn_tournament_subscription_purchase_router.js",
      { statusCode: 200, payload: { ...providerFacts, ...payload }, _summerSubscriptionCtx: { ...baseCtx } },
    ) as unknown[];
    assert.equal(out[4], undefined);
    assert.equal(asRecord(asRecord(asRecord(out[2]).payload).details).code, "PITER_CONFIRM_PROVIDER_MISMATCH");
  }
  const accepted = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_purchase_router.js",
    {
      statusCode: 200,
      payload: { ...providerFacts, id: "tx-piter-1", status: "PAID", toPay: 0 },
      _summerSubscriptionCtx: { ...baseCtx },
    },
  ) as unknown[];
  const acceptedCtx = asRecord(asRecord(accepted[4])._summerSubscriptionCtx);
  assert.equal(asRecord(acceptedCtx.confirmResult).nextStatus, "PAID");
  assert.equal(asRecord(acceptedCtx.confirmResult).transactionId, "tx-piter-1");

  const cancellationPending = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_purchase_router.js",
    {
      statusCode: 200,
      payload: { ...providerFacts, id: "tx-piter-1", status: "CANCELLATION_PENDING", toPay: 1980000 },
      _summerSubscriptionCtx: { ...baseCtx },
    },
  ) as unknown[];
  assert.equal(asRecord(asRecord(asRecord(cancellationPending[4])._summerSubscriptionCtx).confirmResult).nextStatus,
    "PAYMENT_PENDING");
});

test("Piter confirm releases only expired exact UNPAID and evidenced REFUND attempts", () => {
  const providerFacts = {
    id: "tx-piter-terminal",
    toPay: 1980000,
    sum: 1980000,
    clientId: "client-piter-terminal",
    clientPhone: ["+7", "9990000001"].join(""),
    products: [{ id: "8bf334ba-3050-4017-b40a-7eef2db1eb16", discount: 3700000 }],
  };
  const baseCtx = {
    action: "confirm", step: "confirm_lookup", counterKey: "piter_friendship",
    inventoryId: "piter_friendship_12m_2026_v1", paymentRef: "piter-terminal-1",
    transactionId: "tx-piter-terminal", expectedAmountMinor: 1980000,
    requestFingerprint: "fingerprint-terminal", toPayMinor: 1980000,
    clientId: "client-piter-terminal", clientPhone: "79990000001",
    productId: "8bf334ba-3050-4017-b40a-7eef2db1eb16",
    saleRecord: { providerProductCostMinor: 5680000, discountMinor: 3700000 },
  };
  const futureUnpaid = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_purchase_router.js",
    {
      statusCode: 200,
      payload: { ...providerFacts, status: "UNPAID", paymentDueDate: "2999-09-04T10:00:00.000Z" },
      _summerSubscriptionCtx: { ...baseCtx },
    },
  ) as unknown[];
  assert.equal(asRecord(asRecord(asRecord(futureUnpaid[4])._summerSubscriptionCtx).confirmResult).nextStatus,
    "PAYMENT_PENDING");

  const expiredUnpaid = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_purchase_router.js",
    {
      statusCode: 200,
      payload: { ...providerFacts, status: "UNPAID", paymentDueDate: "2020-09-04T10:00:00.000Z" },
      _summerSubscriptionCtx: { ...baseCtx },
    },
  ) as unknown[];
  assert.equal(asRecord(asRecord(asRecord(expiredUnpaid[4])._summerSubscriptionCtx).confirmResult).nextStatus,
    "FAILED");

  const ambiguousZeroBalanceUnpaid = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_purchase_router.js",
    {
      statusCode: 200,
      payload: {
        ...providerFacts,
        status: "UNPAID",
        toPay: 0,
        paymentDueDate: "2020-09-04T10:00:00.000Z",
      },
      _summerSubscriptionCtx: { ...baseCtx },
    },
  ) as unknown[];
  assert.equal(ambiguousZeroBalanceUnpaid[4], undefined);
  assert.equal(
    asRecord(asRecord(asRecord(ambiguousZeroBalanceUnpaid[2]).payload).details).code,
    "PITER_CONFIRM_PROVIDER_MISMATCH",
  );

  const refunded = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_purchase_router.js",
    {
      statusCode: 200,
      payload: {
        ...providerFacts,
        status: "REFUND",
        refundSum: 1969000,
        refundedAt: "2026-09-03T12:00:00.000Z",
      },
      _summerSubscriptionCtx: { ...baseCtx },
    },
  ) as unknown[];
  assert.equal(asRecord(asRecord(asRecord(refunded[4])._summerSubscriptionCtx).confirmResult).nextStatus,
    "FAILED");

  const unevidencedRefund = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_purchase_router.js",
    {
      statusCode: 200,
      payload: { ...providerFacts, status: "REFUND", refundSum: 0 },
      _summerSubscriptionCtx: { ...baseCtx },
    },
  ) as unknown[];
  assert.equal(asRecord(asRecord(asRecord(unevidencedRefund[4])._summerSubscriptionCtx).confirmResult).nextStatus,
    "PAYMENT_PENDING");
});

test("Piter legacy confirm without an atomic fingerprint always requires offline reconciliation", () => {
  const out = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_purchase_router.js",
    {
      statusCode: 200,
      payload: {
        id: "tx-piter-legacy", status: "PAID", toPay: 0, sum: 1980000,
        clientId: "client-legacy", clientPhone: ["+7", "9990000000"].join(""),
        products: [{ id: "8bf334ba-3050-4017-b40a-7eef2db1eb16", discount: 3700000 }],
      },
      _summerSubscriptionCtx: {
        action: "confirm", step: "confirm_lookup", counterKey: "piter_friendship",
        inventoryId: "piter_friendship_12m_2026_v1", paymentRef: "piter-legacy-confirm",
        transactionId: "tx-piter-legacy", expectedAmountMinor: 1980000, toPayMinor: 1980000,
        clientId: "client-legacy", clientPhone: "79990000000",
        productId: "8bf334ba-3050-4017-b40a-7eef2db1eb16",
        saleRecord: { providerProductCostMinor: 5680000, discountMinor: 3700000 },
      },
    },
  ) as unknown[];
  assert.ok(out[4]);
  const blocked = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_piter_atomic_router.js",
    { _summerSubscriptionCtx: asRecord(out[4])._summerSubscriptionCtx, payload: null },
  ) as unknown[];
  assert.equal(blocked[0], null);
  assert.equal(blocked[2], null);
  assert.equal(asRecord(asRecord(asRecord(blocked[3]).payload).details).code,
    "PITER_LEGACY_CONFIRM_REQUIRES_RECONCILIATION");

  const scheduled = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_piter_atomic_router.js",
    {
      _summerSubscriptionCtx: {
        ...asRecord(out[4])._summerSubscriptionCtx,
        confirmResult: {
          ...asRecord(asRecord(out[4])._summerSubscriptionCtx).confirmResult,
          reconcile: true,
        },
      },
      payload: null,
    },
  ) as unknown[];
  assert.deepEqual(scheduled, [null, null, null, null, null]);
});

test("Piter deactivation blocks new reservations but keeps provider result durable", () => {
  const blocked = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_piter_atomic_router.js",
    {
      _summerSubscriptionCtx: {
        step: "piter_ledger_find", counterKey: "piter_friendship",
        inventoryId: "piter_friendship_12m_2026_v1", paymentRef: "after-stop",
        clientPhone: "79990000000", clientId: null, totalLimit: 400,
      },
      payload: [{ ...buildPiterRows(42)[0], ready: false }],
    },
  ) as unknown[];
  assert.equal(blocked[4], null);
  assert.equal(asRecord(asRecord(asRecord(blocked[3]).payload).details).code, "PITER_ATOMIC_LEDGER_NOT_READY");

  const durable = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_piter_atomic_router.js",
    {
      _summerSubscriptionCtx: {
        step: "piter_provider_result", counterKey: "piter_friendship",
        inventoryId: "piter_friendship_12m_2026_v1", paymentRef: "in-flight",
        requestFingerprint: "fingerprint", providerResult: {
          ok: true, transactionId: "tx-in-flight", paymentUrl: "https://pay.example.test/in-flight",
          toPayMinor: 1980000, response: { ok: true },
        },
      },
      payload: null,
    },
  ) as unknown[];
  const filter = asRecord((asRecord(durable[1]).payload as unknown[])[0]);
  assert.equal(Object.hasOwn(filter, "ready"), false);

  const paymentRef = "inactive-replay";
  const clientPhone = "79990000000";
  const requestFingerprint = [
    "piter_friendship_12m_2026_v1", "piter_friendship", paymentRef, clientPhone, "",
  ].join("\n");
  const replay = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_piter_atomic_router.js",
    {
      _summerSubscriptionCtx: {
        step: "piter_ledger_find", counterKey: "piter_friendship",
        inventoryId: "piter_friendship_12m_2026_v1", paymentRef,
        clientPhone, clientId: null, totalLimit: 400,
      },
      payload: [{
        ...buildPiterRows(42)[0], ready: false, reservedCount: 1, takenCount: 43,
        reservations: [{
          paymentRef, requestFingerprint,
          intentFingerprint: ["piter_friendship_12m_2026_v1", "piter_friendship", clientPhone, ""].join("\n"),
          state: "PAYMENT_PENDING", transactionId: "tx-inactive-replay",
          paymentUrl: "https://pay.example.test/inactive-replay", clientPhone,
          priceMinor: 1980000, providerProductCostMinor: 5680000, discountMinor: 3700000,
          productId: "8bf334ba-3050-4017-b40a-7eef2db1eb16",
        }],
      }],
    },
  ) as unknown[];
  assert.ok(replay[2]);
  assert.equal(replay[4], null);
});

test("Piter confirm finalizes an in-flight payment while the ledger is deactivated", () => {
  const ledger = {
    ...buildPiterRows(42)[0],
    ready: false,
    reservedCount: 1,
    takenCount: 43,
    reservations: [{
      paymentRef: "in-flight-confirm", requestFingerprint: "fingerprint-confirm-disabled",
      intentFingerprint: "intent-confirm-disabled", transactionId: "tx-confirm-disabled",
      state: "PAYMENT_PENDING", priceMinor: 1980000,
    }],
  };
  const out = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_piter_atomic_router.js",
    {
      _summerSubscriptionCtx: {
        step: "piter_confirm_validate", counterKey: "piter_friendship",
        inventoryId: "piter_friendship_12m_2026_v1", paymentRef: "in-flight-confirm",
        requestFingerprint: "fingerprint-confirm-disabled", transactionId: "tx-confirm-disabled",
        expectedAmountMinor: 1980000, totalLimit: 400,
        confirmResult: { nextStatus: "PAID", paid: true, transactionId: "tx-confirm-disabled", toPayMinor: 0 },
      },
      payload: [ledger],
    },
  ) as unknown[];
  const filter = asRecord((asRecord(out[1]).payload as unknown[])[0]);
  assert.equal(filter.ready, false);
  assert.equal(asRecord(asRecord((asRecord(out[1]).payload as unknown[])[1]).$inc).paidCount, 1);
});

test("Piter status rejects a ready ledger whose count invariant is inconsistent", () => {
  const prepared = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_status_prepare.js",
    { req: { query: { counterKey: "piter_friendship" } } },
    PITER_PRODUCT_GLOBALS,
  ) as unknown[];
  const ctx = asRecord(asRecord(prepared[0])._summerSubscriptionCtx);
  const invalidLedger = { ...buildPiterRows(42)[0], reservedCount: 1, takenCount: 42 };
  const out = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_status_response.js",
    { _summerSubscriptionCtx: ctx, payload: [invalidLedger] },
    PITER_PRODUCT_GLOBALS,
  ) as unknown[];
  const payload = asRecord(asRecord(out[0]).payload);
  assert.equal(payload.managedSaleReady, false);
  assert.equal(payload.canPurchase, false);
});

test("Piter payment URL is returned after a lost sale ACK only when readback proves the projection", () => {
  const ctx = {
    step: "piter_provider_sale_ack", counterKey: "piter_friendship",
    inventoryId: "piter_friendship_12m_2026_v1", paymentRef: "piter-sale-ack",
    requestFingerprint: "fingerprint-ack", priceMinor: 1980000,
    providerResult: { ok: true, transactionId: "tx-ack", paymentUrl: "https://pay.example.test/tx-ack",
      response: { ok: true, status: "PAYMENT_PENDING", paymentUrl: "https://pay.example.test/tx-ack" } },
  };
  const read = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_piter_atomic_router.js",
    { _summerSubscriptionCtx: ctx, payload: null },
  ) as unknown[];
  assert.ok(read[0]);
  assert.equal(read[3], null);
  const record = {
    _id: "piter-sale:piter_friendship_12m_2026_v1:piter-sale-ack",
    requestFingerprint: "fingerprint-ack", status: "PAYMENT_PENDING", amountMinor: 1980000,
    transactionId: "tx-ack", paymentUrl: "https://pay.example.test/tx-ack",
  };
  const accepted = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_piter_atomic_router.js",
    { _summerSubscriptionCtx: asRecord(read[0])._summerSubscriptionCtx, payload: [record] },
  ) as unknown[];
  assert.equal(asRecord(accepted[3]).statusCode, 201);
  const rejected = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_piter_atomic_router.js",
    {
      _summerSubscriptionCtx: { ...ctx, step: "piter_provider_sale_readback" },
      payload: [{ ...record, amountMinor: 1 }],
    },
  ) as unknown[];
  assert.equal(asRecord(rejected[3]).statusCode, 503);
});

test("Piter lost confirm ACK heals sale from the terminal ledger without incrementing counts twice", () => {
  const ctx = {
    step: "piter_confirm_result", counterKey: "piter_friendship",
    inventoryId: "piter_friendship_12m_2026_v1", paymentRef: "piter-confirm-ack",
    requestFingerprint: "fingerprint-confirm", transactionId: "tx-confirm",
    expectedAmountMinor: 1980000, totalLimit: 400,
    confirmResult: { nextStatus: "PAID", paid: true, transactionId: "tx-confirm",
      toPayMinor: 0, paymentUrl: null, response: { ok: true, status: "PAID" } },
  };
  const validationRead = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_piter_atomic_router.js",
    { _summerSubscriptionCtx: ctx, payload: null },
  ) as unknown[];
  assert.ok(validationRead[0]);
  const transition = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_piter_atomic_router.js",
    {
      _summerSubscriptionCtx: asRecord(validationRead[0])._summerSubscriptionCtx,
      payload: [{ ...buildPiterRows(42)[0], reservedCount: 1, takenCount: 43, reservations: [{
        paymentRef: "piter-confirm-ack", requestFingerprint: "fingerprint-confirm",
        intentFingerprint: "intent-confirm", transactionId: "tx-confirm",
        state: "PAYMENT_PENDING", priceMinor: 1980000,
      }] }],
    },
  ) as unknown[];
  const args = asRecord(transition[1]).payload as unknown[];
  assert.equal(asRecord(asRecord(asRecord(args[0]).reservations).$elemMatch).priceMinor, 1980000);
  assert.equal(asRecord(asRecord(args[1]).$inc).paidCount, 1);
  const read = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_piter_atomic_router.js",
    { _summerSubscriptionCtx: asRecord(transition[1])._summerSubscriptionCtx, payload: null },
  ) as unknown[];
  assert.ok(read[0]);
  assert.equal(read[3], null);
  const heal = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_piter_atomic_router.js",
    {
      _summerSubscriptionCtx: asRecord(read[0])._summerSubscriptionCtx,
      payload: [{ ...buildPiterRows(42)[0], paidCount: 43, takenCount: 43, reservations: [{
        paymentRef: "piter-confirm-ack", requestFingerprint: "fingerprint-confirm",
        transactionId: "tx-confirm", state: "PAID", priceMinor: 1980000,
        paidAt: "2026-09-03T13:00:00.000Z", clientPhone: "79990000000",
      }] }],
    },
  ) as unknown[];
  assert.equal(heal[1], null);
  assert.ok(heal[2]);
  const saleArgs = asRecord(heal[2]).payload as unknown[];
  assert.equal(asRecord(asRecord(saleArgs[1]).$set).paidAt, "2026-09-03T13:00:00.000Z");
  const done = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_piter_atomic_router.js",
    {
      _summerSubscriptionCtx: asRecord(heal[2])._summerSubscriptionCtx,
      payload: { acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedCount: 0, upsertedId: null },
    },
  ) as unknown[];
  assert.equal(asRecord(done[3]).statusCode, 200);
  assert.equal(asRecord(asRecord(done[3]).payload).status, "PAID");
});

test("Piter confirm never mutates a ledger with broken durable invariants", () => {
  const out = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_piter_atomic_router.js",
    {
      _summerSubscriptionCtx: {
        step: "piter_confirm_validate", counterKey: "piter_friendship",
        inventoryId: "piter_friendship_12m_2026_v1", paymentRef: "piter-bad-ledger",
        requestFingerprint: "fingerprint-bad", transactionId: "tx-bad",
        expectedAmountMinor: 1980000, totalLimit: 400,
        confirmResult: { nextStatus: "PAID", paid: true, transactionId: "tx-bad", toPayMinor: 0 },
      },
      payload: [{ ...buildPiterRows(42)[0], reservedCount: 1, takenCount: 42, reservations: [{
        paymentRef: "piter-bad-ledger", requestFingerprint: "fingerprint-bad",
        transactionId: "tx-bad", state: "PAYMENT_PENDING", priceMinor: 1980000,
      }] }],
    },
  ) as unknown[];
  assert.equal(out[1], null);
  assert.equal(asRecord(asRecord(asRecord(out[3]).payload).details).code, "PITER_CONFIRM_LEDGER_INVALID");
});

test("Piter cutover tombstones block replay of every legacy paid paymentRef", () => {
  const ledger = buildPiterRows(42)[0];
  const out = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_piter_atomic_router.js",
    {
      _summerSubscriptionCtx: {
        step: "piter_ledger_find", counterKey: "piter_friendship",
        inventoryId: "piter_friendship_12m_2026_v1", paymentRef: "legacy-paid-1",
        clientPhone: "79990000000", clientId: null, totalLimit: 400,
      },
      payload: [ledger],
    },
  ) as unknown[];
  assert.equal(out[4], null);
  assert.equal(asRecord(asRecord(asRecord(out[3]).payload).details).code,
    "PITER_LEGACY_PAYMENT_REF_ALREADY_USED");
});

test("Piter blocks a fresh browser paymentRef while the same purchaser has an unresolved attempt", () => {
  const intentFingerprint = [
    "piter_friendship_12m_2026_v1", "piter_friendship", "79990000000", "",
  ].join("\n");
  const out = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_piter_atomic_router.js",
    {
      _summerSubscriptionCtx: {
        step: "piter_ledger_find", counterKey: "piter_friendship",
        inventoryId: "piter_friendship_12m_2026_v1", paymentRef: "fresh-browser-ref",
        clientPhone: "79990000000", clientId: null, totalLimit: 400,
      },
      payload: [{ ...buildPiterRows(42)[0], reservedCount: 1, takenCount: 43, reservations: [{
        paymentRef: "original-ref", requestFingerprint: "original-fingerprint", intentFingerprint,
        transactionId: null, state: "PROVIDER_UNKNOWN", priceMinor: 1980000,
      }] }],
    },
  ) as unknown[];
  assert.equal(out[4], null);
  assert.equal(asRecord(out[3]).statusCode, 503);
  assert.equal(asRecord(asRecord(asRecord(out[3]).payload).details).code,
    "PITER_ACTIVE_PURCHASE_UNRESOLVED");
});

test("Piter rejects duplicate provider transaction identity before durable result projection", () => {
  const invalidLedger = {
    ...buildPiterRows(42)[0], reservedCount: 2, takenCount: 44,
    reservations: [
      { paymentRef: "first", transactionId: "shared-tx", state: "PAYMENT_PENDING" },
      { paymentRef: "second", transactionId: "shared-tx", state: "PAYMENT_PENDING" },
    ],
  };
  const invalid = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_piter_atomic_router.js",
    {
      _summerSubscriptionCtx: {
        step: "piter_ledger_find", counterKey: "piter_friendship",
        inventoryId: "piter_friendship_12m_2026_v1", paymentRef: "new-ref",
        clientPhone: "79990000000", clientId: null, totalLimit: 400,
      },
      payload: [invalidLedger],
    },
  ) as unknown[];
  assert.equal(invalid[1], null);
  assert.equal(asRecord(asRecord(asRecord(invalid[3]).payload).details).code,
    "PITER_ATOMIC_LEDGER_NOT_READY");

  const guarded = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_piter_atomic_router.js",
    {
      _summerSubscriptionCtx: {
        step: "piter_provider_result", counterKey: "piter_friendship",
        inventoryId: "piter_friendship_12m_2026_v1", paymentRef: "second",
        requestFingerprint: "fingerprint-second",
        providerResult: { ok: true, transactionId: "shared-tx", paymentUrl: "https://pay.example.test/shared" },
      },
      payload: null,
    },
  ) as unknown[];
  const filter = asRecord((asRecord(guarded[1]).payload as unknown[])[0]);
  assert.equal((filter.$and as unknown[]).length, 2);
  assert.equal(JSON.stringify(filter).includes("shared-tx"), true);
});

test("Piter atomic ledger stays fail closed until its separately seeded sentinel is ready", () => {
  const out = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_piter_atomic_router.js",
    {
      _summerSubscriptionCtx: {
        step: "piter_ledger_find",
        counterKey: "piter_friendship",
        inventoryId: "piter_friendship_12m_2026_v1",
      },
      payload: [],
    },
  ) as unknown[];
  assert.equal(asRecord(out[3]).statusCode, 503);
  assert.equal(asRecord(asRecord(asRecord(out[3]).payload).details).code, "PITER_ATOMIC_LEDGER_NOT_READY");
  assert.equal(out[4], null);
});

test("Piter temporary sale still stops at the 400-subscription inventory limit", () => {
  const prepared = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_purchase_prepare.js",
    {
      payload: {
        clientPhone: "79990000000",
        counterKey: "piter_friendship",
        paymentRef: "piter-sold-out",
      },
      req: { query: {} },
    },
    PITER_PRODUCT_GLOBALS,
  ) as unknown[];
  const limited = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_purchase_limit.js",
    {
      _summerSubscriptionCtx: asRecord(asRecord(prepared[0])._summerSubscriptionCtx),
      payload: buildPiterRows(400),
    },
    PITER_PRODUCT_GLOBALS,
  ) as unknown[];
  assert.equal(limited[0], null);
  const error = asRecord(limited[1]);
  assert.equal(error.statusCode, 409);
  assert.equal(asRecord(asRecord(error.payload).details).remainingCount, 0);
});

test("HUB annual sale remains fail closed while only Piter is temporarily reopened", () => {
  const prepared = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_purchase_prepare.js",
    {
      payload: {
        clientPhone: "79990000000",
        counterKey: "network_friendship",
        paymentRef: "hub-stays-closed",
      },
      req: { query: {} },
    },
  ) as unknown[];
  assert.equal(prepared[0], null);
  const error = asRecord(prepared[1]);
  assert.equal(error.statusCode, 503);
  assert.equal(asRecord(asRecord(error.payload).details).code,
    "MANAGED_SUBSCRIPTION_SALE_READINESS_UNAVAILABLE");
});

test("classic summer purchase remains available while managed annual sale is closed", () => {
  const prepared = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_purchase_prepare.js",
    {
      payload: {
        clientPhone: "79990000000",
        counterKey: "sport",
        paymentRef: "sport-control-transaction",
      },
      req: { query: {} },
    },
  ) as unknown[];
  assert.ok(prepared[0]);
  assert.equal(asRecord(asRecord(prepared[0])._summerSubscriptionCtx).counterKey, "sport");
  assert.equal(prepared[1], null);
});

test("regional annual checkout blocks Viva activation before 1 October", () => {
  for (const candidate of [
    {
      counterKey: "piter_friendship",
      productId: "8bf334ba-3050-4017-b40a-7eef2db1eb16",
      productName: "Падел.Дружба.Питер — годовая",
      priceMinor: 1980000,
    },
    {
      counterKey: "network_friendship",
      productId: "db7a5250-7369-4f43-8ac5-9111be24bc74",
      productName: "Падел.Дружба.ХАБ — годовая",
      priceMinor: 5680000,
    },
  ]) {
    const out = withFixedNow("2026-08-21T09:00:00.000Z", () => runNodeRedFunction(
      "scripts/nodered_games_nodes/fn_tournament_subscription_purchase_router.js",
      {
        statusCode: 200,
        payload: [{
          id: candidate.productId,
          name: candidate.productName,
          cost: 5680000,
          productType: "SUBSCRIPTION",
          activationDays: 0,
          validityDays: 365,
          visits: 365,
        }],
        _summerSubscriptionCtx: {
          action: "purchase",
          step: "load_products",
          token: "token-1",
          saleType: "tiered_direct_product",
          counterKey: candidate.counterKey,
          clientPhone: "79990000000",
          productId: candidate.productId,
          productName: candidate.productName,
          productCostMinor: 5680000,
          priceMinor: candidate.priceMinor,
          batchIndex: 1,
        },
      },
    )) as unknown[];

    assert.equal(out[0], null, `${candidate.counterKey} must not create a transaction`);
    const error = asRecord(out[2]);
    const details = asRecord(asRecord(error.payload).details);
    assert.equal(error.statusCode, 503);
    assert.equal(details.code, "REGIONAL_SUBSCRIPTION_PROVIDER_LIFECYCLE_INCOMPATIBLE");
    assert.equal(details.counterKey, candidate.counterKey);
    assert.equal(details.purchaseDate, "2026-08-21");
    assert.equal(details.projectedAutoActivationDate, "2026-08-21");
    assert.equal(details.activationNotBeforeDate, "2026-10-01");
  }
});

test("regional annual checkout accepts a provider activation window extending beyond 1 October", () => {
  for (const candidate of [
    {
      counterKey: "piter_friendship",
      productId: "8bf334ba-3050-4017-b40a-7eef2db1eb16",
      productName: "Падел.Дружба.Питер — годовая",
      priceMinor: 1980000,
    },
    {
      counterKey: "network_friendship",
      productId: "db7a5250-7369-4f43-8ac5-9111be24bc74",
      productName: "Падел.Дружба.ХАБ — годовая",
      priceMinor: 5680000,
    },
  ]) {
    const out = withFixedNow("2026-08-23T09:00:00.000Z", () => runNodeRedFunction(
      "scripts/nodered_games_nodes/fn_tournament_subscription_purchase_router.js",
      {
        statusCode: 200,
        payload: [{
          id: candidate.productId,
          name: candidate.productName,
          cost: 5680000,
          productType: "SUBSCRIPTION",
          activationDays: 365,
          validityDays: 365,
          visits: 365,
        }],
        _summerSubscriptionCtx: {
          action: "purchase",
          step: "load_products",
          token: "token-1",
          saleType: "tiered_direct_product",
          counterKey: candidate.counterKey,
          clientPhone: "79990000000",
          productId: candidate.productId,
          productName: candidate.productName,
          productCostMinor: 5680000,
          priceMinor: candidate.priceMinor,
          batchIndex: 1,
        },
      },
    )) as unknown[];

    const transaction = asRecord(candidate.counterKey === "piter_friendship" ? out[4] : out[0]);
    const transactionCtx = asRecord(transaction._summerSubscriptionCtx);
    assert.equal(transaction.method, "POST");
    assert.match(String(transaction.url), /\/transactions$/);
    assert.equal(transactionCtx.providerActivationDays, 365);
    assert.equal(transactionCtx.providerAutoActivationDate, "2027-08-23");
    assert.equal(transactionCtx.activationNotBeforeDate, "2026-10-01");
  }
});

test("regional annual checkout blocks new sales after the fixed fallback date", () => {
  const out = withFixedNow("2026-10-02T09:00:00.000Z", () => runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_purchase_router.js",
    {
      statusCode: 200,
      payload: [{
        id: "8bf334ba-3050-4017-b40a-7eef2db1eb16",
        name: "Падел.Дружба.Питер — годовая",
        cost: 5680000,
        productType: "SUBSCRIPTION",
        activationDays: 365,
        validityDays: 365,
        visits: 365,
      }],
      _summerSubscriptionCtx: {
        action: "purchase",
        step: "load_products",
        token: "token-1",
        saleType: "tiered_direct_product",
        counterKey: "piter_friendship",
        clientPhone: "79990000000",
        productId: "8bf334ba-3050-4017-b40a-7eef2db1eb16",
        productName: "Падел.Дружба.Питер — годовая",
        productCostMinor: 5680000,
        priceMinor: 1980000,
        batchIndex: 1,
      },
    },
  )) as unknown[];

  assert.equal(out[0], null);
  const error = asRecord(out[2]);
  const details = asRecord(asRecord(error.payload).details);
  assert.equal(error.statusCode, 503);
  assert.equal(details.code, "REGIONAL_SUBSCRIPTION_PROVIDER_LIFECYCLE_INCOMPATIBLE");
  assert.equal(details.purchaseDate, "2026-10-02");
  assert.equal(details.activationNotBeforeDate, "2026-10-01");
});

test("regional annual checkout rejects missing or coerced provider lifecycle fields", () => {
  for (const product of [
    {
      productType: "SUBSCRIPTION",
      validityDays: 365,
      visits: 365,
    },
    {
      productType: "SUBSCRIPTION",
      activationDays: "365",
      validityDays: 365,
      visits: 365,
    },
    {
      productType: "SUBSCRIPTION",
      activationDays: 365,
      validityDays: "365",
      visits: 365,
    },
    {
      productType: "INDIVIDUAL",
      activationDays: 365,
      validityDays: 365,
      visits: 365,
    },
    {
      productType: "SUBSCRIPTION",
      activationDays: 365,
      validityDays: 365,
      visits: 364,
    },
  ]) {
    const out = withFixedNow("2026-08-21T09:00:00.000Z", () => runNodeRedFunction(
      "scripts/nodered_games_nodes/fn_tournament_subscription_purchase_router.js",
      {
        statusCode: 200,
        payload: [{
          id: "8bf334ba-3050-4017-b40a-7eef2db1eb16",
          name: "Падел.Дружба.Питер — годовая",
          cost: 5680000,
          ...product,
        }],
        _summerSubscriptionCtx: {
          action: "purchase",
          step: "load_products",
          token: "token-1",
          saleType: "tiered_direct_product",
          counterKey: "piter_friendship",
          clientPhone: "79990000000",
          productId: "8bf334ba-3050-4017-b40a-7eef2db1eb16",
          productName: "Падел.Дружба.Питер — годовая",
          productCostMinor: 5680000,
          priceMinor: 1980000,
          batchIndex: 1,
        },
      },
    )) as unknown[];

    assert.equal(out[0], null);
    assert.equal(asRecord(out[2]).statusCode, 503);
  }
});

test("HUB transaction accepts an exact compatible annual lifecycle", () => {
  const out = withFixedNow("2026-08-21T09:00:00.000Z", () => runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_purchase_router.js",
    {
      statusCode: 200,
      payload: [{
        id: "db7a5250-7369-4f43-8ac5-9111be24bc74",
        name: "Падел.Дружба.ХАБ — годовая",
        cost: 5680000,
        productType: "SUBSCRIPTION",
        activationDays: 41,
        validityDays: 365,
        visits: 365,
      }],
      _summerSubscriptionCtx: {
        action: "purchase",
        step: "load_products",
        token: "token-1",
        saleType: "tiered_direct_product",
        counterKey: "network_friendship",
        clientPhone: "79990000000",
        productId: "db7a5250-7369-4f43-8ac5-9111be24bc74",
        productName: "Падел.Дружба.ХАБ — годовая",
        productCostMinor: 5680000,
        priceMinor: 5680000,
        batchIndex: 1,
      },
    },
  )) as unknown[];

  const transaction = asRecord(out[0]);
  const transactionCtx = asRecord(transaction._summerSubscriptionCtx);
  assert.equal(transaction.method, "POST");
  assert.match(String(transaction.url), /\/transactions$/);
  assert.equal(transactionCtx.providerAutoActivationDate, "2026-10-01");
  assert.equal(transactionCtx.providerActivationDays, 41);
  assert.equal(transactionCtx.providerValidityDays, 365);
  assert.equal(transactionCtx.providerVisits, 365);
});

test("regional atomic sales candidate pins the lifecycle guard source and graph builder", () => {
  const router = fs.readFileSync(
    "scripts/nodered_games_nodes/fn_tournament_subscription_purchase_router.js",
    "utf8",
  );
  const candidateBuilder = fs.readFileSync(
    "scripts/prepare_piter_atomic_sales_candidate.mjs",
    "utf8",
  );
  assert.match(router, /REGIONAL_SUBSCRIPTION_PROVIDER_LIFECYCLE_INCOMPATIBLE/);
  assert.match(candidateBuilder, /fn_tournament_subscription_purchase_router\.js/);
  assert.match(candidateBuilder, /piter_atomic_router_20260903/);
});

test("Piter transaction fails closed when Viva returns a different amount", () => {
  const out = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_purchase_router.js",
    {
      statusCode: 201,
      payload: {
        id: "piter-wrong-amount-transaction",
        paymentUrl: "https://pay.example.test/piter-wrong-amount",
        toPay: 5680000,
      },
      _summerSubscriptionCtx: {
        action: "purchase",
        step: "create_transaction",
        saleType: "tiered_direct_product",
        counterKey: "piter_friendship",
        batchIndex: 2,
        priceMinor: 2380000,
        productId: "8bf334ba-3050-4017-b40a-7eef2db1eb16",
      },
    },
  ) as unknown[];
  assert.equal(out[0], null);
  assert.equal(out[1], null);
  assert.equal(out[2], null);
  assert.equal(out[3], null);
  const atomicCtx = asRecord(asRecord(out[4])._summerSubscriptionCtx);
  assert.equal(atomicCtx.step, "piter_provider_result");
  assert.equal(asRecord(atomicCtx.providerResult).ok, false);
  assert.equal(asRecord(asRecord(atomicCtx.providerResult).response).status, "PROVIDER_UNKNOWN");
});

test("Piter transaction without a provider transaction id never returns a checkout URL", () => {
  const out = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_purchase_router.js",
    {
      statusCode: 201,
      payload: { paymentUrl: "https://pay.example.test/no-id", toPay: 1980000 },
      _summerSubscriptionCtx: {
        action: "purchase", step: "create_transaction", saleType: "tiered_direct_product",
        counterKey: "piter_friendship", paymentRef: "piter-no-id", batchIndex: 1,
        priceMinor: 1980000, productId: "8bf334ba-3050-4017-b40a-7eef2db1eb16",
      },
    },
  ) as unknown[];
  assert.equal(out[3], null);
  const atomicCtx = asRecord(asRecord(out[4])._summerSubscriptionCtx);
  assert.equal(asRecord(atomicCtx.providerResult).ok, false);
  assert.equal(asRecord(asRecord(atomicCtx.providerResult).response).status, "PROVIDER_UNKNOWN");
  assert.equal(asRecord(asRecord(atomicCtx.providerResult).response).paymentUrl, undefined);
});

const KOTELNIKI_PRODUCT_GLOBALS = {};
const NETWORK_PRODUCT_GLOBALS = {
  summer_subscription_network_friendship_product_id: "db7a5250-7369-4f43-8ac5-9111be24bc74",
};

function buildRegionalRows(counterKey: string, inventoryId: string, batchSize: number, count: number) {
  return Array.from({ length: count }, (_, index) => ({
    inventoryId,
    counterKey,
    productId: `${counterKey}-product-tier-${Math.floor(index / batchSize) + 1}`,
    status: "PAID",
  }));
}

test("Kotelniki status uses four server-side batches of 50", () => {
  const prepared = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_status_prepare.js",
    { req: { query: { counterKey: "kotelniki_friendship" } } },
    KOTELNIKI_PRODUCT_GLOBALS,
  ) as unknown[];
  const dbMsg = asRecord(prepared[0]);
  const ctx = asRecord(dbMsg._summerSubscriptionCtx);
  const counter = asRecord((ctx.counters as Array<Record<string, unknown>>)[0]);
  assert.deepEqual(dbMsg.query, {
    inventoryId: "kotelniki_friendship_12m_2026_v1",
    counterKey: "kotelniki_friendship",
  });
  assert.equal(counter.totalLimit, 200);
  assert.equal(counter.batchSize, 50);
  assert.equal((counter.tiers as unknown[]).length, 4);

  const status = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_status_response.js",
    {
      _summerSubscriptionCtx: ctx,
      payload: buildRegionalRows(
        "kotelniki_friendship",
        "kotelniki_friendship_12m_2026_v1",
        50,
        50,
      ),
    },
    KOTELNIKI_PRODUCT_GLOBALS,
  ) as unknown[];
  const payload = asRecord(asRecord(status[0]).payload);
  assert.equal(payload.batchIndex, 2);
  assert.equal(payload.batchRemainingCount, 50);
  assert.equal(payload.priceMinor, 2380000);
  assert.equal(payload.productId, null);
  assert.equal(payload.bindingReady, false);
  assert.equal(payload.canPurchase, false);
});

test("network status caps the existing 100-seat inventory at 10 sales per Moscow day", () => {
  const prepared = withFixedNow("2026-09-03T12:00:00.000Z", () => runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_status_prepare.js",
    { req: { query: { counterKey: "network_friendship" } } },
    NETWORK_PRODUCT_GLOBALS,
  )) as unknown[];
  const dbMsg = asRecord(prepared[0]);
  const ctx = asRecord(dbMsg._summerSubscriptionCtx);
  const counter = asRecord((ctx.counters as Array<Record<string, unknown>>)[0]);
  assert.deepEqual(dbMsg.query, {
    inventoryId: "network_friendship_12m_2026_v1",
    counterKey: "network_friendship",
  });
  assert.equal(counter.totalLimit, 100);
  assert.equal(counter.batchSize, 100);
  assert.equal(counter.dailyCapEnabled, true);
  assert.equal(counter.dailyLimit, 10);
  assert.equal(counter.dailyDropDate, "2026-09-03");
  assert.equal((counter.tiers as unknown[]).length, 1);

  const historicalRows = Array.from({ length: 5 }, () => ({
    inventoryId: "network_friendship_12m_2026_v1",
    counterKey: "network_friendship",
    status: "PAID",
    paidAt: "2026-09-02T18:00:00.000Z",
  }));
  const currentRows = Array.from({ length: 3 }, () => ({
    inventoryId: "network_friendship_12m_2026_v1",
    counterKey: "network_friendship",
    status: "PAID",
    paidAt: "2026-09-03T08:00:00.000Z",
  }));
  const status = withFixedNow("2026-09-03T12:00:00.000Z", () => runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_status_response.js",
    {
      _summerSubscriptionCtx: ctx,
      payload: [
        ...historicalRows,
        ...currentRows,
        {
          inventoryId: "network_friendship_12m_2026_v1",
          counterKey: "network_friendship",
          status: "PAYMENT_PENDING",
          createdAt: "2026-09-03T08:10:00.000Z",
          expiresAt: "2026-09-03T13:00:00.000Z",
        },
        {
          inventoryId: "network_friendship_12m_2026_v1",
          counterKey: "network_friendship",
          status: "PAYMENT_PENDING",
          createdAt: "2026-09-03T08:20:00.000Z",
          paymentExpiresAt: "2026-09-03T13:00:00.000Z",
        },
        {
          inventoryId: "network_friendship_12m_2026_v1",
          counterKey: "network_friendship",
          status: "PAYMENT_PENDING",
          createdAt: "2026-09-03T08:00:00.000Z",
        },
        {
          inventoryId: "network_friendship_12m_2026_v1",
          counterKey: "network_friendship",
          status: "PAYMENT_PENDING",
          createdAt: "2026-09-03T08:30:00.000Z",
          expiresAt: "2026-09-03T11:59:00.000Z",
          paymentExpiresAt: "2026-09-03T13:00:00.000Z",
        },
      ],
    },
    NETWORK_PRODUCT_GLOBALS,
  )) as unknown[];
  const payload = asRecord(asRecord(status[0]).payload);
  assert.equal(payload.batchIndex, 1);
  assert.equal(payload.batchSize, 10);
  assert.equal(payload.batchRemainingCount, 4);
  assert.equal(payload.totalLimit, 10);
  assert.equal(payload.paidCount, 3);
  assert.equal(payload.reservedCount, 3);
  assert.equal(payload.remainingCount, 4);
  assert.equal(payload.dailyDropActive, true);
  assert.equal(payload.dailyDropDate, "2026-09-03");
  assert.equal(payload.inventoryTotalLimit, 100);
  assert.equal(payload.inventoryPaidCount, 8);
  assert.equal(payload.inventoryReservedCount, 3);
  assert.equal(payload.inventoryRemainingCount, 89);
  assert.equal(payload.priceMinor, 5680000);
  assert.equal(payload.productId, "db7a5250-7369-4f43-8ac5-9111be24bc74");
  assert.equal(payload.providerProductCostMinor, 5680000);
  assert.equal(payload.discountMinor, 0);
  assert.equal(payload.bindingReady, true);
  assert.equal(payload.managedSaleReady, false);
  assert.equal(payload.managedSaleError,
    "MANAGED_SUBSCRIPTION_SALE_READINESS_UNAVAILABLE");
  assert.equal(payload.canPurchase, false);
});

test("network daily cap rolls over at Moscow midnight and never exceeds the global remainder", () => {
  const prepared = withFixedNow("2026-09-03T12:00:00.000Z", () => runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_status_prepare.js",
    { req: { query: { counterKey: "network_friendship" } } },
    NETWORK_PRODUCT_GLOBALS,
  )) as unknown[];
  const ctx = asRecord(asRecord(prepared[0])._summerSubscriptionCtx);
  const historicalRows = Array.from({ length: 98 }, () => ({
    inventoryId: "network_friendship_12m_2026_v1",
    counterKey: "network_friendship",
    status: "PAID",
    paidAt: "2026-09-02T20:59:59.000Z",
  }));
  const status = withFixedNow("2026-09-03T12:00:00.000Z", () => runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_status_response.js",
    {
      _summerSubscriptionCtx: ctx,
      payload: [
        ...historicalRows,
        {
          inventoryId: "network_friendship_12m_2026_v1",
          counterKey: "network_friendship",
          status: "PAID",
          paidAt: "2026-09-02T21:00:00.000Z",
        },
      ],
    },
    NETWORK_PRODUCT_GLOBALS,
  )) as unknown[];
  const payload = asRecord(asRecord(status[0]).payload);
  assert.equal(payload.paidCount, 1);
  assert.equal(payload.remainingCount, 1);
  assert.equal(payload.batchRemainingCount, 1);
  assert.equal(payload.inventoryPaidCount, 99);
  assert.equal(payload.inventoryRemainingCount, 1);
});

test("regional purchase ignores browser productId and fails before any provider or inventory write", () => {
  const prepared = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_purchase_prepare.js",
    {
      payload: {
        clientPhone: "79990000000",
        counterKey: "kotelniki_friendship",
        productId: "forged-browser-product",
        paymentRef: "kotelniki-payment-ref",
      },
      req: { query: {} },
    },
    {},
  ) as unknown[];
  const error = asRecord(prepared[1]);
  assert.equal(prepared[0], null);
  assert.equal(error.statusCode, 503);
  const details = asRecord(asRecord(error.payload).details);
  assert.equal(details.code, "MANAGED_SUBSCRIPTION_SALE_READINESS_UNAVAILABLE");
  assert.equal(details.counterKey, "kotelniki_friendship");
});
