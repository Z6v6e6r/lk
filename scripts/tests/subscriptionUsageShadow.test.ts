import test from "node:test";
import assert from "node:assert/strict";
import {
  appendSubscriptionUsageShadowToSameOriginUrl,
  fetchSubscriptionUsageShadowQuote,
  isSubscriptionUsageShadowMode,
  presentSubscriptionUsageShadowQuote,
  subscriptionUsageShadowTargetId,
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
        basePriceMinor: 225_000,
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
        basePriceMinor: 75_000,
        discountMinor: 22_500,
        surchargeMinor: 0,
        finalPriceMinor: 52_500,
        partialPriceCalculation: {
          numerator: 1,
          denominator: 4,
          chargeBeforeDiscountMinor: 75_000,
          percentageDiscountMinor: 22_500,
        },
        currency: "RUB",
      },
    },
    bookingOutcome: {
      allowed: true,
      subscriptionApplied: true,
      pricingMode: "SUBSCRIPTION",
      finalPriceMinor: 52_500,
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

test("only supported create and join durations map to fixed server-owned fixtures", () => {
  assert.equal(subscriptionUsageShadowTargetId("CREATE_GAME", 60), "annual-create-60");
  assert.equal(subscriptionUsageShadowTargetId("CREATE_GAME", 90), "annual-create-90");
  assert.equal(subscriptionUsageShadowTargetId("JOIN_GAME", 120), "annual-join-120");
  assert.equal(subscriptionUsageShadowTargetId("JOIN_GAME", 75), null);
  assert.equal(subscriptionUsageShadowTargetId("JOIN_GAME", null), null);
});

test("shadow quote calls only the test endpoint and keeps credentials out of URL and body", async () => {
  let capturedInput = "";
  let capturedInit: RequestInit | null = null;
  const request: SubscriptionUsageShadowFetch = async (input, init) => {
    capturedInput = input;
    capturedInit = init;
    return { ok: true, json: async () => buildQuote() };
  };

  const result = await fetchSubscriptionUsageShadowQuote({
    apiBase: "https://example.test/api",
    credentials: { offerId: "test_offer:browser", token: TOKEN },
    action: "CREATE_GAME",
    durationMinutes: 90,
    activeServices: 9,
    dailyGameUsage: -2,
    request,
  });

  assert.equal(result.target.targetId, "annual-create-90");
  assert.equal(
    capturedInput,
    "https://example.test/api/v1/subscription-test/offers/test_offer%3Abrowser/usage-scenarios/quote",
  );
  assert.equal(capturedInput.includes(TOKEN), false);
  assert.equal(capturedInit?.credentials, "omit");
  assert.equal(capturedInit?.referrerPolicy, "no-referrer");
  assert.equal(capturedInit?.cache, "no-store");
  assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
    targetId: "annual-create-90",
    activeServices: 4,
    dailyGameUsage: 0,
  });
  assert.equal(String(capturedInit?.body).includes(TOKEN), false);
});

test("90 minute subscription presentation uses one-quarter share and discounts only paid time", () => {
  const presentation = presentSubscriptionUsageShadowQuote(buildQuote());
  assert.equal(presentation.tone, "subscription");
  assert.match(presentation.summary, /первые 60 минут бесплатно/i);
  assert.match(presentation.summary, /доплата за 30 минут/i);
  assert.match(presentation.summary, /доля игрока 1\/4/i);
  assert.match(presentation.summary, /скидка 30% на доплату 225/);
  assert.match(presentation.summary, /итого 525/);
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
      apiBase: "https://example.test/api",
      credentials: { offerId: "test_offer:browser", token: TOKEN },
      action: "JOIN_GAME",
      durationMinutes: 60,
      activeServices: 0,
      dailyGameUsage: 0,
      request: async () => ({ ok: true, json: async () => ({ allowed: true }) }),
    }),
    /неизвестного формата/,
  );
});
