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
    ...globalValues,
  };
  const globalContext = {
    get(key: string) {
      return Object.prototype.hasOwnProperty.call(mergedGlobals, key)
        ? mergedGlobals[key]
        : undefined;
    },
  };
  return new Function("msg", "global", source)(msg, globalContext);
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

test("Friendship and RA are unlimited only during the Moscow July 30 window", () => {
  const createPurchaseContext = (nowIso: string, counterKey: string) => withFixedNow(nowIso, () => {
    const out = runNodeRedFunction(
      "scripts/nodered_games_nodes/fn_tournament_subscription_purchase_prepare.js",
      {
        payload: {
          clientPhone: "79990000000",
          counterKey,
          paymentRef: `temporary-window-${counterKey}`,
        },
        req: { query: {} },
      },
    ) as unknown[];
    return asRecord(asRecord(out[0])._summerSubscriptionCtx);
  });

  assert.equal(createPurchaseContext("2026-07-29T20:59:59.000Z", "friendship").unlimited, false);
  assert.equal(createPurchaseContext("2026-07-29T21:00:00.000Z", "friendship").unlimited, true);
  assert.equal(createPurchaseContext("2026-07-30T20:59:59.000Z", "ra").unlimited, true);
  assert.equal(createPurchaseContext("2026-07-30T21:00:00.000Z", "friendship").unlimited, false);
  assert.equal(createPurchaseContext("2026-07-30T12:00:00.000Z", "sport").unlimited, false);
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
    const out = runNodeRedFunction(
      "scripts/nodered_games_nodes/fn_tournament_subscription_purchase_prepare.js",
      {
        payload: {
          clientPhone: "79990000000",
          planKey: expected.planKey,
          paymentRef: `payment-ref-${expected.planKey}`,
        },
        req: { query: {} },
      },
    ) as unknown[];

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
    { counterKey: "academy", totalLimit: 125, unlimited: false },
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
  assert.equal(asRecord(byCounter.get("academy")).totalLimit, 125);
  assert.equal(asRecord(byCounter.get("academy")).remainingCount, 100);
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
          totalLimit: 5,
        },
        payload: [
          { status: "PAID" },
          { status: "payment_success" },
          { status: "PAYMENT_PENDING", expiresAt: "2026-06-01T10:10:00.000Z" },
          { status: "PAYMENT_PENDING", expiresAt: "2026-06-01T09:59:00.000Z" },
          { status: "PAYMENT_PENDING" },
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
    assert.equal(debugPayload.takenCount, 4);
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
  assert.equal(requestCtx.remainingBefore, 181);
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
  assert.equal(payload.remainingCount, 4);
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
  const sportUpdate = updates.find((entry) => asRecord(entry.query).counterKey === "sport");
  assert.ok(academyUpdate);
  assert.ok(sportUpdate);

  const academySet = asRecord(asRecord(academyUpdate!.payload).$set);
  const sportSet = asRecord(asRecord(sportUpdate!.payload).$set);

  assert.equal(academySet.paidCount, 1);
  assert.equal(academySet.reservedCount, 1);
  assert.equal(academySet.takenCount, 2);
  assert.equal(academySet.remainingCount, 123);

  assert.equal(sportSet.paidCount, 1);
  assert.equal(sportSet.reservedCount, 0);
  assert.equal(sportSet.takenCount, 1);
  assert.equal(sportSet.remainingCount, 131);
});

test("summer subscription launch counters ignore legacy manual paid baselines", () => {
  const prepareOut = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_counter_refresh_prepare.js",
    { payload: Date.now() },
    {
      summer_subscription_academy_manual_paid_count: 3,
      summer_subscription_ra_manual_paid_count: 27,
      summer_subscription_sport_manual_paid_count: 38,
    },
  ) as Record<string, unknown>;

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
  assert.equal(academySet.remainingCount, 124);
  assert.equal(raSet.paidCount, 1);
  assert.equal(raSet.remainingCount, 4);
  assert.equal(sportSet.paidCount, 0);
  assert.equal(sportSet.remainingCount, 132);
});

test("summer subscription reconciliation selects only live pending payments from the launch inventory", () => {
  const prepared = withFixedNow("2026-07-08T10:00:00.000Z", () => runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_reconcile_query.js",
    { payload: Date.now() },
  )) as Record<string, unknown>;

  assert.deepEqual(prepared.query, {
    inventoryId: { $regex: "^ab_leto_2026_50_v1(?:_(?:friendship|ra)_.*)?$" },
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
