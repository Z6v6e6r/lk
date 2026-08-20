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

test("Friendship and RA switch to their staged daily limits on August 1 Moscow time", () => {
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

  const before = createPurchaseContext("2026-07-31T20:59:59.000Z", "friendship");
  assert.equal(before.stagedRelease, false);
  assert.equal(before.totalLimit, 5);

  for (const counterKey of ["friendship", "ra"]) {
    const after = createPurchaseContext("2026-07-31T21:00:00.000Z", counterKey);
    assert.equal(after.stagedRelease, true);
    assert.equal(after.totalLimit, 100);
    assert.equal(after.launchLimit, 100);
    assert.equal(after.dailyLimit, counterKey === "ra" ? 10 : 7);
    assert.equal(after.releaseStartDate, "2026-08-01");
    assert.equal(after.inventoryId, `ab_leto_2026_100_then_7_v1_${counterKey}`);
  }

  const sport = createPurchaseContext("2026-07-31T21:00:00.000Z", "sport");
  assert.equal(sport.stagedRelease, false);
  assert.equal(sport.totalLimit, 132);
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

test("staged launch waits for 100 PAID sales before enabling the daily limit", () => {
  const nowIso = "2026-08-01T12:00:00.000Z";
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
  const launchPaidRows = Array.from({ length: 99 }, () => ({
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
  assert.equal(oneLeftCtx.totalLimit, 100);
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
  assert.equal(blockedDetails.launchPaidCount, 99);
  assert.equal(blockedDetails.launchReservedCount, 1);
});

test("staged release changes to a seven-seat daily drop after 100 PAID launch sales", () => {
  const nowIso = "2026-08-01T12:00:00.000Z";
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
  const launchRows = Array.from({ length: 100 }, () => ({
    inventoryId,
    counterKey: "friendship",
    releasePhase: "launch",
    status: "PAID",
    updatedAt: "2026-08-01T06:00:00.000Z",
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
    dailyDropDate: "2026-07-31",
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
  const inventoryId = "ab_leto_2026_100_then_7_v1_ra";
  const launchRows = Array.from({ length: 100 }, () => ({
    inventoryId,
    counterKey: "ra",
    releasePhase: "launch",
    status: "PAID",
    updatedAt: "2026-08-01T12:00:00.000Z",
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

  const beforeNextDropIso = "2026-08-01T13:00:00.000Z";
  const beforeCtx = asRecord(asRecord(prepareAt(beforeNextDropIso)[0])._summerSubscriptionCtx);
  const blocked = withFixedNow(beforeNextDropIso, () => runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_purchase_limit.js",
    { _summerSubscriptionCtx: beforeCtx, payload: launchRows },
  )) as unknown[];
  const blockedDetails = asRecord(asRecord(asRecord(blocked[1]).payload).details);
  assert.equal(asRecord(blocked[1]).statusCode, 409);
  assert.equal(blockedDetails.releasePhase, "daily_pending");
  assert.equal(blockedDetails.dailyDropActive, false);
  assert.equal(blockedDetails.launchCompletedAt, "2026-08-01T12:00:00.000Z");
  assert.equal(blockedDetails.dailyDropStartsAt, "2026-08-02T07:00:00.000Z");

  const atNextDropIso = "2026-08-02T07:00:00.000Z";
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
  const nowIso = "2026-08-01T12:00:00.000Z";
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
  const inventoryId = "ab_leto_2026_100_then_7_v1_ra";
  const launchRows = Array.from({ length: 99 }, () => ({
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
  assert.equal(launchPayload.totalLimit, 100);
  assert.equal(launchPayload.paidCount, 99);
  assert.equal(launchPayload.remainingCount, 0);
  assert.equal(launchPayload.canPurchase, false);

  const dailyRows = [
    ...Array.from({ length: 100 }, () => ({
      inventoryId,
      counterKey: "ra",
      releasePhase: "launch",
      status: "PAID",
      updatedAt: "2026-08-01T06:00:00.000Z",
    })),
    ...Array.from({ length: 3 }, () => ({
      inventoryId,
      counterKey: "ra",
      releasePhase: "daily",
      dailyDropDate: "2026-08-01",
      status: "PAID",
    })),
    ...Array.from({ length: 4 }, () => ({
      inventoryId,
      counterKey: "ra",
      releasePhase: "daily",
      dailyDropDate: "2026-07-31",
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
  const nowIso = "2026-08-10T12:00:00.000Z";
  const inventoryId = "ab_leto_2026_100_then_7_v1_ra";
  const launchRows = Array.from({ length: 100 }, (_, index) => ({
    inventoryId,
    counterKey: "ra",
    releasePhase: "launch",
    status: "PAID",
    paidAt: new Date(Date.parse("2026-08-08T16:00:00.000Z") + index * 60_000).toISOString(),
  }));
  const mislabeledPriorDrop = {
    inventoryId,
    counterKey: "ra",
    releasePhase: "launch",
    status: "PAID",
    paidAt: "2026-08-10T06:59:59.000Z",
  };
  const mislabeledCurrentPaid = [
    {
      inventoryId,
      counterKey: "ra",
      releasePhase: "launch",
      status: "PAID",
      createdAt: "2026-08-10T06:59:59.000Z",
      updatedAt: "2026-08-10T07:00:00.000Z",
    },
    {
      inventoryId,
      counterKey: "ra",
      releasePhase: "launch",
      status: "PAID",
      paidAt: "2026-08-10T07:01:00.000Z",
    },
  ];
  const mislabeledCurrentPending = {
    inventoryId,
    counterKey: "ra",
    releasePhase: "launch",
    status: "PAYMENT_PENDING",
    createdAt: "2026-08-10T07:02:00.000Z",
    expiresAt: "2026-08-10T13:00:00.000Z",
  };
  const mislabeledExpiredPending = {
    inventoryId,
    counterKey: "ra",
    releasePhase: "launch",
    status: "PAYMENT_PENDING",
    createdAt: "2026-08-10T07:03:00.000Z",
    expiresAt: "2026-08-10T11:00:00.000Z",
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
  assert.equal(allowedCtx.launchPaidCount, 100);
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
  assert.equal(statusPayload.launchPaidCount, 100);
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
  assert.equal(refreshedState.launchPaidCount, 100);
  assert.equal(refreshedState.paidCount, 2);
  assert.equal(refreshedState.reservedCount, 1);
  assert.equal(refreshedState.remainingCount, 7);

  const nineMislabeledPaid = Array.from({ length: 9 }, (_, index) => ({
    inventoryId,
    counterKey: "ra",
    releasePhase: "launch",
    status: "PAID",
    paidAt: new Date(Date.parse("2026-08-10T07:00:00.000Z") + index * 60_000).toISOString(),
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
        inventoryId: "ab_leto_2026_100_then_7_v1_friendship",
        releasePhase: "daily",
        dailyDropActive: true,
        releaseStartDate: "2026-08-01",
        launchLimit: 100,
        dailyLimit: 7,
        dailyDropDate: "2026-08-02",
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
  assert.equal(dbSet.releaseStartDate, "2026-08-01");
  assert.equal(dbSet.launchLimit, 100);
  assert.equal(dbSet.dailyLimit, 7);
  assert.equal(dbSet.dailyDropDate, "2026-08-02");
  assert.equal(response.releasePhase, "daily");
  assert.equal(response.dailyDropActive, true);
  assert.equal(response.remainingAfterReservation, 3);
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
  assert.equal(networkSet.totalLimit, 50);
  assert.equal(networkSet.batchSize, 50);
  assert.equal(networkSet.remainingCount, 50);
  assert.equal(networkSet.bindingReady, true);
  assert.equal(networkSet.canPurchase, true);
  assert.equal(piterSet.totalLimit, 400);
  assert.equal(piterSet.batchSize, 100);
  assert.equal(piterSet.remainingCount, 400);
  assert.equal(piterSet.bindingReady, true);
  assert.equal(piterSet.canPurchase, true);
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
  const nowIso = "2026-08-02T12:00:00.000Z";
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
    ...Array.from({ length: 100 }, () => ({
      counterKey: "ra",
      inventoryId,
      releasePhase: "launch",
      status: "PAID",
      updatedAt: "2026-08-02T06:00:00.000Z",
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
  assert.equal(state.launchPaidCount, 100);
  assert.equal(state.totalLimit, 10);
  assert.equal(state.paidCount, 2);
  assert.equal(state.remainingCount, 8);
});

test("summer subscription reconciliation selects only live pending payments from the launch inventory", () => {
  const prepared = withFixedNow("2026-07-08T10:00:00.000Z", () => runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_reconcile_query.js",
    { payload: Date.now() },
  )) as Record<string, unknown>;

  assert.deepEqual(prepared.query, {
    inventoryId: { $regex: "^(?:ab_leto_2026_50_v1(?:_(?:friendship|ra)_.*)?|ab_leto_2026_100_then_7_v1_(?:friendship|ra))$" },
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

const PITER_PRODUCT_GLOBALS = {
  summer_subscription_piter_friendship_product_id: "8bf334ba-3050-4017-b40a-7eef2db1eb16",
};

function buildPiterRows(count: number) {
  return Array.from({ length: count }, () => ({
    inventoryId: "piter_friendship_12m_2026_v1",
    counterKey: "piter_friendship",
    productId: "8bf334ba-3050-4017-b40a-7eef2db1eb16",
    status: "PAID",
  }));
}

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
  assert.equal(firstPayload.canPurchase, true);

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

test("Piter purchase ignores a browser productId and selects the current server tier", () => {
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
  const preparedCtx = asRecord(asRecord(prepared[0])._summerSubscriptionCtx);
  assert.equal(preparedCtx.productId, null);
  assert.equal(preparedCtx.totalLimit, 400);

  const limited = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_purchase_limit.js",
    { _summerSubscriptionCtx: preparedCtx, payload: buildPiterRows(100) },
    PITER_PRODUCT_GLOBALS,
  ) as unknown[];
  const selectedCtx = asRecord(asRecord(limited[0])._summerSubscriptionCtx);
  assert.equal(selectedCtx.batchIndex, 2);
  assert.equal(selectedCtx.batchRemainingBefore, 100);
  assert.equal(selectedCtx.productId, "8bf334ba-3050-4017-b40a-7eef2db1eb16");
  assert.equal(selectedCtx.productCostMinor, 5680000);
  assert.equal(selectedCtx.priceMinor, 2380000);
  assert.equal(selectedCtx.discountMinor, 3300000);
});

test("Piter transaction uses the active tier discount and persists the advertised amount", () => {
  const prepared = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_purchase_prepare.js",
    {
      payload: {
        clientPhone: "79990000000",
        counterKey: "piter_friendship",
        productId: "forged-browser-product",
        paymentRef: "piter-tier-two-transaction",
      },
      req: { query: {} },
    },
    PITER_PRODUCT_GLOBALS,
  ) as unknown[];
  const limited = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_purchase_limit.js",
    {
      _summerSubscriptionCtx: asRecord(asRecord(prepared[0])._summerSubscriptionCtx),
      payload: buildPiterRows(100),
    },
    PITER_PRODUCT_GLOBALS,
  ) as unknown[];
  const selectedCtx = asRecord(asRecord(limited[0])._summerSubscriptionCtx);
  selectedCtx.step = "load_products";
  selectedCtx.token = "token-1";

  const routed = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_purchase_router.js",
    {
      statusCode: 200,
      payload: [{
        id: "8bf334ba-3050-4017-b40a-7eef2db1eb16",
        name: "Падел.Дружба.Питер — годовая",
        cost: 5680000,
        type: "SUBSCRIPTION",
      }],
      _summerSubscriptionCtx: selectedCtx,
    },
  ) as unknown[];
  const transactionRequest = asRecord(routed[0]);
  const transactionCtx = asRecord(transactionRequest._summerSubscriptionCtx);
  const transactionProduct = asRecord((asRecord(transactionRequest.payload).products as unknown[])[0]);
  assert.equal(transactionProduct.id, "8bf334ba-3050-4017-b40a-7eef2db1eb16");
  assert.equal(transactionProduct.customAmount, null);
  assert.equal(transactionProduct.discount, 3300000);
  assert.equal(transactionCtx.priceMinor, 2380000);
  assert.equal(transactionCtx.providerProductCostMinor, 5680000);

  const persisted = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_purchase_router.js",
    {
      statusCode: 201,
      payload: {
        id: "piter-tier-two-viva-transaction",
        paymentUrl: "https://pay.example.test/piter-tier-two",
        toPay: 2380000,
      },
      _summerSubscriptionCtx: transactionCtx,
    },
  ) as unknown[];
  const dbSet = asRecord(asRecord(asRecord(persisted[1]).payload).$set);
  const response = asRecord(asRecord(persisted[2]).payload);
  assert.equal(dbSet.amountMinor, 2380000);
  assert.equal(dbSet.providerProductCostMinor, 5680000);
  assert.equal(dbSet.discountMinor, 3300000);
  assert.equal(response.priceMinor, 2380000);
  assert.equal(response.discountMinor, 3300000);
  assert.equal(response.toPayMinor, 2380000);
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
  assert.equal(asRecord(out[2]).statusCode, 502);
  assert.match(String(asRecord(asRecord(out[2]).payload).error), /неверную сумму/i);
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

test("network status uses one server-side batch of 50 at 56 800 RUB", () => {
  const prepared = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_status_prepare.js",
    { req: { query: { counterKey: "network_friendship" } } },
    NETWORK_PRODUCT_GLOBALS,
  ) as unknown[];
  const dbMsg = asRecord(prepared[0]);
  const ctx = asRecord(dbMsg._summerSubscriptionCtx);
  const counter = asRecord((ctx.counters as Array<Record<string, unknown>>)[0]);
  assert.deepEqual(dbMsg.query, {
    inventoryId: "network_friendship_12m_2026_v1",
    counterKey: "network_friendship",
  });
  assert.equal(counter.totalLimit, 50);
  assert.equal(counter.batchSize, 50);
  assert.equal((counter.tiers as unknown[]).length, 1);

  const status = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_status_response.js",
    { _summerSubscriptionCtx: ctx, payload: [] },
    NETWORK_PRODUCT_GLOBALS,
  ) as unknown[];
  const payload = asRecord(asRecord(status[0]).payload);
  assert.equal(payload.batchIndex, 1);
  assert.equal(payload.batchRemainingCount, 50);
  assert.equal(payload.priceMinor, 5680000);
  assert.equal(payload.productId, "db7a5250-7369-4f43-8ac5-9111be24bc74");
  assert.equal(payload.providerProductCostMinor, 5680000);
  assert.equal(payload.discountMinor, 0);
  assert.equal(payload.bindingReady, true);
  assert.equal(payload.canPurchase, true);
});

test("regional purchase ignores browser productId and fails closed without the active Viva product", () => {
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
  const ctx = asRecord(asRecord(prepared[0])._summerSubscriptionCtx);
  assert.equal(ctx.productId, null);
  assert.equal(ctx.totalLimit, 200);

  const limited = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_subscription_purchase_limit.js",
    { _summerSubscriptionCtx: ctx, payload: [] },
    {},
  ) as unknown[];
  const error = asRecord(limited[1]);
  assert.equal(limited[0], null);
  assert.equal(error.statusCode, 503);
  assert.equal(asRecord(asRecord(error.payload).details).counterKey, "kotelniki_friendship");
  assert.equal(asRecord(asRecord(error.payload).details).bindingReady, false);
});
