import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import ts from "typescript";
import { isGroupSubscriptionDiscountQuote, matchGroupSubscriptionDiscount } from "../../src/utils/groupSubscriptionDiscount.ts";
import {
  buildTournamentSubscriptionDiscountProduct,
  isTournamentSubscriptionDiscountQuote,
  matchTournamentSubscriptionDiscount,
  type TournamentSubscriptionDiscountQuote,
} from "../../src/utils/tournamentSubscriptionDiscount.ts";
import { pollSubscriptionBookingConfirmation } from "../../src/utils/subscriptionBookingConfirmation.ts";

const now = Date.now();
const quote: TournamentSubscriptionDiscountQuote = {
  kind: "TOURNAMENT_SUBSCRIPTION_DISCOUNT_V1", exerciseId: "fixture:tournament", actorClientId: "fixture:actor",
  subscriptionId: "fixture:subscription", subscriptionName: "Fixture subscription", productId: "fixture:event-service",
  status: "AVAILABLE", discountPercent: 33, basePriceMinor: 700001, amountMinor: 469001,
  startsAt: new Date(now + 36 * 3600_000).toISOString(), durationMinutes: 120,
  evaluatedAt: now, expiresAt: now + 30_000,
};
const groupQuote = { ...quote, kind: "GROUP_TRAINING_SUBSCRIPTION_DISCOUNT_V1" as const };
const oneTime = { id: quote.productId, cost: quote.basePriceMinor, source: "one-time" };
const params = {
  exerciseId: quote.exerciseId, clientId: quote.actorClientId,
  exercise: { category: "tournament", timeFrom: quote.startsAt },
  product: buildTournamentSubscriptionDiscountProduct(quote),
};

function loadFunction(name: string, dependencies: Record<string, unknown> = {}) {
  const source = ts.createSourceFile("api.ts", fs.readFileSync("src/utils/tournamentSignupApi.ts", "utf8"), ts.ScriptTarget.Latest, true);
  const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration, name);
  const compiled = ts.transpileModule(declaration.getText(source).replace(/^export /, ""), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function(...Object.keys(dependencies), `const LK1_MONEY_DISCOUNT_CHECKOUT_ENABLED = false; ${compiled}; return ${name};`)(...Object.values(dependencies));
}

const identityDependencies = {
  isTournamentSubscriptionDiscountQuote,
  isGroupSubscriptionDiscountQuote,
  pickSubscriptionLookupId: (value: { clientSubscriptionId: string }) => value.clientSubscriptionId,
  resolveSubscriptionCategoryDailyLimitCategoryFromEvent: (value: { category: string }) => value?.category,
};

test("tournament quote uses its configured percentage and exact kopecks; group kinds are isolated", () => {
  assert.ok(isTournamentSubscriptionDiscountQuote(quote, quote.exerciseId, quote.actorClientId, now));
  assert.equal(isTournamentSubscriptionDiscountQuote(groupQuote, quote.exerciseId, quote.actorClientId, now), false);
  assert.equal(isGroupSubscriptionDiscountQuote(quote, quote.exerciseId, quote.actorClientId, now), false);
  assert.equal(matchTournamentSubscriptionDiscount([quote], oneTime), quote);
  assert.equal(matchTournamentSubscriptionDiscount([groupQuote as unknown as TournamentSubscriptionDiscountQuote], oneTime), null);
  assert.equal(matchGroupSubscriptionDiscount([quote as unknown as typeof groupQuote], oneTime), null);
  for (const product of [{ ...oneTime, id: "other" }, { ...oneTime, cost: 700000 }, { ...oneTime, source: "subscription" }]) {
    assert.equal(matchTournamentSubscriptionDiscount([quote], product), null);
  }
  for (const [discountPercent, amountMinor] of [[0, 700001], [50, 350001], [100, 0]]) {
    assert.ok(isTournamentSubscriptionDiscountQuote({ ...quote, discountPercent, amountMinor }, quote.exerciseId, quote.actorClientId, now));
  }
});

test("preview rejects wrong actors, events, malformed amounts and expired quotes", () => {
  for (const delta of [{ actorClientId: "other" }, { exerciseId: "other" }, { amountMinor: 469000 },
    { basePriceMinor: 0 }, { basePriceMinor: 1_000_001 }, { amountMinor: "469001" }, { discountPercent: 50.5 },
    { expiresAt: now - 1 }, { expiresAt: now + 60_001 }, { evaluatedAt: now + 6000 },
    { subscriptionId: "" }, { productId: "" }, { subscriptionName: "" }, { durationMinutes: 0 },
    { startsAt: "invalid" }, { startsAt: new Date(now - 1).toISOString() }, { status: "LIMIT_USED" }]) {
    assert.equal(isTournamentSubscriptionDiscountQuote({ ...quote, ...delta }, quote.exerciseId, quote.actorClientId, now), false, JSON.stringify(delta));
  }
});

test("monetary product preserves the event quote and does not represent visit debit", () => {
  assert.equal(params.product.cost, 469001);
  assert.equal(params.product.id, quote.subscriptionId);
  assert.equal(params.product.visitsTotal, null);
  assert.equal(params.product.lk1MoneyDiscountCandidate, true);
  assert.equal(params.product.tournamentDiscountQuote, quote);
  assert.equal(params.product.groupDiscountQuote, undefined);
});

test("tournament preview requests only the tournament event target with authenticated zero retries", async () => {
  const controller = new AbortController();
  const fetchQuotes = loadFunction("apiFetchTournamentSubscriptionDiscounts", {
    isRecord: (value: unknown) => Boolean(value) && typeof value === "object" && !Array.isArray(value),
    getServ2Origin: () => "https://fixture.invalid",
    request: async (url: string, options: RequestInit & { auth: boolean; retries: number }) => {
      assert.equal(url, "/lk/subscriptions/game-price-preview");
      assert.equal(options.method, "POST");
      assert.equal(options.auth, true);
      assert.equal(options.retries, 0);
      assert.equal(options.signal, controller.signal);
      assert.deepEqual(JSON.parse(String(options.body)), {
        target: { targetKind: "TOURNAMENT", exerciseId: quote.exerciseId }, subscriptionIds: [quote.subscriptionId],
      });
      return { data: { quotes: [quote] }, error: null, status: 200 };
    },
  });
  assert.equal((await fetchQuotes(quote.exerciseId, controller.signal, quote.subscriptionId)).data.quotes[0], quote);
});

const previewDependencies = (request: () => Promise<unknown>) => ({
  isRecord: (value: unknown) => Boolean(value) && typeof value === "object" && !Array.isArray(value),
  getServ2Origin: () => "https://fixture.invalid",
  request,
});

test("a tournament-contour refusal keeps the ordinary tariff bookable instead of blocking payment", async () => {
  // Live case: a custom tournament published over a Viva game (exercise type 840,
  // direction «Игра юр лицо») is classified `open_game` by the preview node's own
  // resolver, so a TOURNAMENT target is refused with this code. The category has no
  // tournament contour, so the signup has to price the ordinary tariff.
  const raw = { error: { code: "TOURNAMENT_DISCOUNT_TARGET_UNRESOLVED" } };
  const fetchQuotes = loadFunction("apiFetchTournamentSubscriptionDiscounts",
    previewDependencies(async () => ({ data: null, error: { status: 503, message: "Ошибка запроса (503)", raw }, status: 503 })));
  const result = await fetchQuotes(quote.exerciseId);
  assert.equal(result.error, null, "an out-of-contour refusal must not reach the payment gate");
  assert.deepEqual(result.data, { quotes: [] });
  assert.equal(result.status, 503);
});

test("every other preview failure still fails closed for the tournament payment section", async () => {
  const failures: Array<{ status: number | null; raw: unknown }> = [
    { status: 503, raw: { error: { code: "PRICE_PREVIEW_READ_FAILED" } } },
    { status: 503, raw: { error: { code: "TOURNAMENT_DISCOUNT_BACKEND_NOT_READY" } } },
    { status: 503, raw: { error: { code: "SUBSCRIPTION_PRODUCT_CURRENT_STATE_UNAVAILABLE" } } },
    { status: 500, raw: { message: "upstream failure" } },
    { status: null, raw: null },
  ];
  for (const failure of failures) {
    const fetchQuotes = loadFunction("apiFetchTournamentSubscriptionDiscounts",
      previewDependencies(async () => ({ data: null, error: { status: failure.status, message: "failure", raw: failure.raw }, status: failure.status })));
    const result = await fetchQuotes(quote.exerciseId);
    assert.ok(result.error, JSON.stringify(failure));
    assert.equal(result.data, null, JSON.stringify(failure));
  }
});

test("tournament dispatch rejects category mixing, changed binding, promo stacking and price mutation", async () => {
  let calls = 0;
  const create = loadFunction("apiCreateTournamentVivaTransaction", { ...identityDependencies,
    apiCreateTournamentVivaBookingFromSubscription: async () => { calls++; return { data: {}, error: null, status: 201 }; },
  });
  assert.equal((await create(params)).error, null);
  const productChanges = [
    { source: "one-time" }, { id: "other" }, { raw: { clientSubscriptionId: "other" } }, { cost: quote.basePriceMinor },
    { isCustomTournamentEnergy: true }, { lk1MoneyDiscountCandidate: false },
    { tournamentDiscountQuote: groupQuote }, { groupDiscountQuote: groupQuote },
    { tournamentDiscountQuote: { ...quote, amountMinor: 1 } },
  ];
  const changes = [
    { clientId: "other" }, { exerciseId: "other" }, { promoCode: "PROMO" },
    { exercise: { ...params.exercise, category: "group_training" } },
    { exercise: { ...params.exercise, category: "open_game" } },
    { exercise: { ...params.exercise, timeFrom: new Date(now + 7200_000).toISOString() } },
    ...productChanges.map(change => ({ product: { ...params.product, ...change } })),
  ];
  for (const change of changes) assert.equal((await create({ ...params, ...change })).status, 409, JSON.stringify(change));
  assert.equal(calls, 1);
  const groupProduct = { ...params.product, tournamentDiscountQuote: undefined, groupDiscountQuote: groupQuote };
  assert.equal((await create({ ...params, product: groupProduct })).status, 409);
  assert.equal((await create({ ...params, exercise: { ...params.exercise, category: "group_training" }, product: groupProduct })).error, null);
  assert.equal(calls, 2, "existing group route remains valid only with a group category and group quote");
});

test("a structurally valid displayed quote reaches stable-operation replay after its TTL", async () => {
  const expired = { ...quote, evaluatedAt: now - 60_000, expiresAt: now - 30_000 };
  assert.equal(isTournamentSubscriptionDiscountQuote(expired, quote.exerciseId, quote.actorClientId, now), false);
  let replayed = 0;
  const create = loadFunction("apiCreateTournamentVivaTransaction", { ...identityDependencies,
    apiCreateTournamentVivaBookingFromSubscription: async () => { replayed++; return { data: {}, error: null }; },
  });
  assert.equal((await create({ ...params, product: buildTournamentSubscriptionDiscountProduct(expired) })).error, null);
  assert.equal(replayed, 1);
});

function bookingGateway(response: unknown, requests: { url: string; body: unknown }[], pendingFirst = false) {
  return loadFunction("apiCreateTournamentVivaBookingFromSubscription", {
    ...identityDependencies,
    resolveSubscriptionCategoryDailyLimitDateFromEvent: () => "2026-09-20",
    getServ2Origin: () => "https://fixture.invalid",
    isRecord: (value: unknown) => Boolean(value) && typeof value === "object" && !Array.isArray(value),
    pickString: (value: Record<string, unknown>, keys: string[]) => keys.map(key => value[key]).find(item => typeof item === "string") || null,
    normalizeConfirmedSubscriptionBookingPayment: loadFunction("normalizeConfirmedSubscriptionBookingPayment"),
    pollSubscriptionBookingConfirmation: (request: () => Promise<never>) => pollSubscriptionBookingConfirmation(request, { delaysMs: [0], wait: async () => {} }),
    request: async (url: string, options: { retries: number; body: string }) => {
      assert.equal(options.retries, 0);
      requests.push({ url, body: JSON.parse(options.body) });
      return pendingFirst && requests.length === 1
        ? { data: { state: "PENDING_CONFIRMATION" }, error: null, status: 202 }
        : { data: response, error: null, status: 201 };
    },
  });
}

const confirmation = { state: "CONFIRMED", bookingId: "fixture:booking", transactionId: "fixture:transaction",
  toPayMinor: quote.amountMinor, toPay: quote.amountMinor! / 100, paid: false, paymentUrl: "https://checkout.invalid/fixture" };

test("booking sends expectedTournamentDiscount and polls exactly the same operation before returning payment URL", async () => {
  const requests: { url: string; body: unknown }[] = [];
  const book = bookingGateway(confirmation, requests, true);
  const result = await book(params);
  assert.equal(result.error, null);
  assert.equal(result.data.paymentUrl, confirmation.paymentUrl);
  assert.equal(result.data.toPay, quote.amountMinor);
  assert.equal(result.data.paid, false);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, requests[1].url);
  assert.match(requests[0].url, /^\/lk\/subscription-bookings\?operationId=lk-subscription-/);
  assert.deepEqual(requests[0].body, { exerciseId: quote.exerciseId, clientSubscriptionId: quote.subscriptionId,
    expectedTournamentDiscount: { basePriceMinor: quote.basePriceMinor, amountMinor: quote.amountMinor, productId: quote.productId,
      startsAt: quote.startsAt, durationMinutes: quote.durationMinutes, discountPercent: quote.discountPercent } });
});

test("mismatched server amount or legacy booking-only confirmation never opens discounted checkout", async () => {
  for (const response of [{ state: "CONFIRMED", bookingId: "fixture:booking" },
    { ...confirmation, toPayMinor: 700001, toPay: 7000.01 },
    { ...confirmation, paymentUrl: null }, { ...confirmation, paid: true }]) {
    const result = await bookingGateway(response, [])(params);
    assert.equal(result.status, 202);
    assert.equal(result.data, null);
  }
  const legacy = await bookingGateway({ state: "CONFIRMED", bookingId: "fixture:booking" }, [])({
    ...params, product: { ...params.product, lk1MoneyDiscountCandidate: false, tournamentDiscountQuote: undefined }, exercise: {},
  });
  assert.equal(legacy.data.paid, true, "legacy subscription-only confirmation remains valid");
});

test("tournament UI binds asynchronous checkout and quotes to actor/event and displays quoted minor units", () => {
  const page = fs.readFileSync("src/components/tournament-signup/TournamentSignupPage.tsx", "utf8");
  assert.match(page, /checkoutResolvedFor === checkoutContextKey \? checkoutSnapshot : null/);
  assert.match(page, /checkoutRequestIdRef\.current !== requestId\) return/);
  assert.match(page, /controller\.signal\.aborted\) return/);
  assert.match(page, /currentDiscountQuotes\.includes\(product\.tournamentDiscountQuote\)/);
  assert.match(page, /role="status">Проверяем скидку по подписке/);
  assert.match(page, /Обновить варианты записи/);
  assert.match(page, /formatMoneyMinor\(discount\.amountMinor\)/);
  assert.match(page, /discount\.discountPercent/);
  assert.match(page, /product\.source === "one-time" && \(discountPending \|\| Boolean\(discountError\)\)/);
  assert.match(page, /completeVivaRegistration\(checkout, discount \? buildTournamentSubscriptionDiscountProduct\(discount\) : matchedProduct\)/);
});
