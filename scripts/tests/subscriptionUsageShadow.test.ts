import test from "node:test";
import assert from "node:assert/strict";
import {
  appendSubscriptionUsageShadowToSameOriginUrl,
  fetchSubscriptionUsageShadowQuote,
  isSubscriptionUsageShadowHostedDevHost,
  isSubscriptionUsageShadowLoopbackHost,
  isSubscriptionUsageShadowMode,
  presentSubscriptionUsageShadowQuote,
  type SubscriptionUsageShadowFetch,
  type SubscriptionUsageShadowQuote,
} from "../../src/components/subscriptions/subscriptionUsageShadow.ts";

const TOKEN = "a".repeat(32);

function buildQuote(
  overrides: Partial<SubscriptionUsageShadowQuote["bookingOutcome"]> = {},
): SubscriptionUsageShadowQuote {
  return {
    target: {
      targetId: "annual-create-90",
      title: "Создать игру на 90 минут",
      action: "CREATE_GAME",
      participantCount: 4,
      target: {
        category: "GAME",
        durationMinutes: 90,
        startsAt: "2026-08-30T10:00:00+03:00",
        basePriceMinor: 300_000,
      },
    },
    decision: {
      eligible: true,
      policyVersion: 1,
      blockers: [],
      usageUnits: 1,
      activeServices: 0,
      maxActiveServices: 4,
      dailyUsed: 0,
      dailyLimit: 1,
      evaluatedAt: "2026-08-30T07:00:00Z",
      benefit: {
        kind: "PARTIAL_PRICE_PERCENT_DISCOUNT",
        ruleId: "game-90",
        basePriceMinor: 100_000,
        discountMinor: 30_000,
        surchargeMinor: 0,
        finalPriceMinor: 70_000,
        partialPriceCalculation: {
          numerator: 1,
          denominator: 3,
          chargeBeforeDiscountMinor: 100_000,
          percentageDiscountMinor: 30_000,
        },
        currency: "RUB",
      },
    },
    bookingOutcome: {
      allowed: true,
      subscriptionApplied: true,
      pricingMode: "SUBSCRIPTION",
      finalPriceMinor: 70_000,
      reasonCodes: [],
      ...overrides,
    },
  };
}

test("shadow mode is isolated to ordinary lk_dev and cannot replace the hosted test page", () => {
  assert.equal(isSubscriptionUsageShadowMode("/lk_dev", "?subscriptionShadow=1", true), true);
  assert.equal(isSubscriptionUsageShadowMode("/finde_game", "?subscriptionShadow=1", true), true);
  assert.equal(isSubscriptionUsageShadowMode("/game_create", "?subscriptionShadow=1", true), true);
  assert.equal(isSubscriptionUsageShadowMode("/game_join", "?subscriptionShadow=1", true), true);
  assert.equal(
    isSubscriptionUsageShadowMode(
      "/lk_dev",
      "?subscriptionShadow=1&subscriptionTest=1",
      true,
    ),
    false,
  );
  assert.equal(isSubscriptionUsageShadowMode("/lk_new", "?subscriptionShadow=1", true), false);
  assert.equal(isSubscriptionUsageShadowMode("/lk_dev", "?subscriptionShadow=1", false), false);
  assert.equal(isSubscriptionUsageShadowLoopbackHost("127.0.0.1"), true);
  assert.equal(isSubscriptionUsageShadowLoopbackHost("localhost"), true);
  assert.equal(isSubscriptionUsageShadowLoopbackHost("padlhub.ru"), false);
  assert.equal(isSubscriptionUsageShadowHostedDevHost("padlhub.ru"), true);
  assert.equal(isSubscriptionUsageShadowHostedDevHost("www.padlhub.ru"), true);
  assert.equal(isSubscriptionUsageShadowHostedDevHost("padlhub.su"), false);
});

test("shadow credentials stay in the fragment and move only within the same origin", () => {
  const source = new URL(
    `https://padlhub.ru/lk_dev?subscriptionShadow=1#offerId=test_offer%3Abrowser&token=${TOKEN}`,
  );
  const sameOrigin = appendSubscriptionUsageShadowToSameOriginUrl(
    new URL("https://padlhub.ru/game_create?channel=dev"),
    source,
  );
  assert.equal(sameOrigin.searchParams.get("subscriptionShadow"), "1");
  assert.equal(sameOrigin.search.includes(TOKEN), false);
  assert.equal(sameOrigin.hash.includes(TOKEN), true);

  const differentOrigin = appendSubscriptionUsageShadowToSameOriginUrl(
    new URL("https://padlhub.su/finde_game"),
    source,
  );
  assert.equal(differentOrigin.searchParams.get("subscriptionShadow"), "1");
  assert.equal(differentOrigin.hash, "");
  assert.equal(differentOrigin.toString().includes(TOKEN), false);
});

test("shadow quote sends identifiers only to the loopback server resolver", async () => {
  let capturedInput = "";
  let capturedInit: RequestInit | null = null;
  const request: SubscriptionUsageShadowFetch = async (input, init) => {
    capturedInput = input;
    capturedInit = init;
    return { ok: true, json: async () => buildQuote() };
  };

  const result = await fetchSubscriptionUsageShadowQuote({
    preview: {
      action: "CREATE_GAME",
      target: {
        targetKind: "NEW_GAME",
        slotId: "slot-1",
        stationId: "station-1",
        roomId: "room-1",
        masterServiceId: "master-1",
        subServiceIds: ["sub-1"],
        startsAt: "2026-08-30T10:00:00+03:00",
        durationMinutes: 90,
      },
    },
    activeServices: 9,
    dailyGameUsage: -2,
    request,
  });

  assert.equal(result.target.targetId, "annual-create-90");
  assert.equal(capturedInput, "/__dev/managed-subscriptions/shadow-quote");
  assert.equal(capturedInput.includes(TOKEN), false);
  assert.equal(capturedInit?.credentials, "omit");
  assert.equal(capturedInit?.referrerPolicy, "no-referrer");
  assert.equal(capturedInit?.cache, "no-store");
  assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
    action: "CREATE_GAME",
    target: {
      targetKind: "NEW_GAME",
      slotId: "slot-1",
      stationId: "station-1",
      roomId: "room-1",
      masterServiceId: "master-1",
      subServiceIds: ["sub-1"],
      startsAt: "2026-08-30T10:00:00+03:00",
      durationMinutes: 90,
    },
    activeServices: 4,
    dailyGameUsage: 0,
  });
  assert.doesNotMatch(String(capturedInit?.body), /price|amount|token/i);
});

test("hosted shadow sends token only in a header and identifiers only to the isolated DEV backend", async () => {
  let capturedInput = "";
  let capturedInit: RequestInit | null = null;
  const request: SubscriptionUsageShadowFetch = async (input, init) => {
    capturedInput = input;
    capturedInit = init;
    return { ok: true, json: async () => buildQuote() };
  };
  const preview = {
    action: "CREATE_GAME" as const,
    target: {
      targetKind: "NEW_GAME" as const,
      slotId: "slot-1",
      stationId: "station-1",
      roomId: "room-1",
      masterServiceId: "master-1",
      subServiceIds: ["sub-1"],
      startsAt: "2026-08-30T10:00:00+03:00",
      durationMinutes: 90 as const,
    },
  };

  await fetchSubscriptionUsageShadowQuote({
    preview,
    activeServices: 1,
    dailyGameUsage: 1,
    request,
    runtimeLocation: {
      hostname: "padlhub.ru",
      hash: `#offerId=test_offer%3Abrowser&token=${TOKEN}`,
    },
    hostedApiBase: "https://lk-reserve.89-108-64-209.sslip.io/api",
  });

  assert.equal(
    capturedInput,
    "https://lk-reserve.89-108-64-209.sslip.io/api/v1/subscription-test/offers/test_offer%3Abrowser/usage-scenarios/resolved-quote",
  );
  assert.equal(capturedInput.includes(TOKEN), false);
  const headers = capturedInit?.headers as Record<string, string>;
  assert.equal(headers["X-Subscription-Test-Token"], TOKEN);
  assert.equal(headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
    ...preview,
    activeServices: 1,
    dailyGameUsage: 1,
  });
  assert.doesNotMatch(String(capturedInit?.body), /price|amount|token/i);
  assert.equal(capturedInit?.credentials, "omit");
  assert.equal(capturedInit?.referrerPolicy, "no-referrer");
});

test("hosted shadow fails closed without credentials or with a non-isolated API base", async () => {
  const preview = {
    action: "JOIN_GAME" as const,
    target: { targetKind: "GAME_AGGREGATE" as const, gameId: "game-1" },
  };
  await assert.rejects(
    () => fetchSubscriptionUsageShadowQuote({
      preview,
      activeServices: 0,
      dailyGameUsage: 0,
      runtimeLocation: { hostname: "padlhub.ru", hash: "" },
      hostedApiBase: "https://lk-reserve.89-108-64-209.sslip.io/api",
      request: async () => assert.fail("request must not be sent"),
    }),
    /не хватает offerId или тестового токена/,
  );
  await assert.rejects(
    () => fetchSubscriptionUsageShadowQuote({
      preview,
      activeServices: 0,
      dailyGameUsage: 0,
      runtimeLocation: {
        hostname: "padlhub.ru",
        hash: `#offerId=test_offer%3Abrowser&token=${TOKEN}`,
      },
      hostedApiBase: "https://padlhub.su/api",
      request: async () => assert.fail("request must not be sent"),
    }),
    /не относится к изолированному DEV backend/,
  );
});

test("90 minute subscription presentation uses one-quarter share and discounts only paid time", () => {
  const presentation = presentSubscriptionUsageShadowQuote(buildQuote());
  assert.equal(presentation.tone, "subscription");
  assert.match(presentation.summary, /первые 60 минут бесплатно/i);
  assert.match(presentation.summary, /доплата за 30 минут/i);
  assert.match(presentation.summary, /доля игрока 1\/4/i);
  assert.match(presentation.summary, /скидка 30% на доплату 300/);
  assert.match(presentation.summary, /итого 700/);
});

test("shadow presentation preserves kopecks for an exact server-resolved slot price", () => {
  const quote = buildQuote();
  if (quote.decision.benefit?.kind !== "PARTIAL_PRICE_PERCENT_DISCOUNT"
    || !quote.decision.benefit.partialPriceCalculation) {
    assert.fail("partial price fixture is missing");
  }
  quote.decision.benefit.partialPriceCalculation.chargeBeforeDiscountMinor = 37_500;
  quote.decision.benefit.partialPriceCalculation.percentageDiscountMinor = 11_250;
  quote.decision.benefit.finalPriceMinor = 26_250;
  quote.bookingOutcome.finalPriceMinor = 26_250;
  const presentation = presentSubscriptionUsageShadowQuote(quote);
  assert.match(presentation.summary, /скидка 30% на доплату 112,50/);
  assert.match(presentation.summary, /итого 262,50/);
});

test("active-service limit produces an allowed full-price path without subscription", () => {
  const quote = buildQuote({
    allowed: true,
    subscriptionApplied: false,
    pricingMode: "FULL_PRICE_WITHOUT_SUBSCRIPTION",
    finalPriceMinor: 150_000,
    reasonCodes: ["ACTIVE_SERVICES_LIMIT_REACHED"],
  });
  quote.decision.eligible = false;
  quote.decision.blockers = [{
    code: "ACTIVE_SERVICES_LIMIT_REACHED",
    message: "Достигнут лимит активных услуг",
    details: null,
  }];
  quote.decision.benefit = null;

  const presentation = presentSubscriptionUsageShadowQuote(quote);
  assert.equal(presentation.tone, "full-price");
  assert.match(presentation.summary, /доля игрока 1\/4/i);
  assert.match(presentation.summary, /без скидки/i);
  assert.match(presentation.summary, /итого 1\s*500/);
});

test("malformed responses fail closed before they reach the ordinary LK UI", async () => {
  await assert.rejects(
    () => fetchSubscriptionUsageShadowQuote({
      preview: {
        action: "JOIN_GAME",
        target: { targetKind: "GAME_AGGREGATE", gameId: "game-1" },
      },
      activeServices: 0,
      dailyGameUsage: 0,
      request: async () => ({ ok: true, json: async () => ({ allowed: true }) }),
    }),
    /неизвестного формата/,
  );
});
