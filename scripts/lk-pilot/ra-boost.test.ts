import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { pilotOfferSelectionKey, readRaBoostPreview, type RaBoostPreview } from "../../src/lk-pilot/raBoostPreview.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const node = (name: string) => readFileSync(new URL(`../nodered_subscription_price_preview_nodes/${name}.js`, import.meta.url), "utf8");
const termsSource = node("raBoost");

const { readPilotRaBoostPolicy, pilotRaBoostCandidate, pilotRaBoostProviderMatches } =
  new Function(termsSource + "\nreturn { readPilotRaBoostPolicy, pilotRaBoostCandidate, pilotRaBoostProviderMatches };")();
const entry = new Function("msg", "global", node("entry"));
const router = new Function("msg", "global", "env", termsSource + "\n" + node("router"));
const finalize = new Function("msg", "global", node("final"));

const start = (delta = 86_400_000) => new Date(Date.now() + delta + 10800000).toISOString().slice(0, 19) + "+03:00";
const stationId = id(1), masterServiceId = id(2), subscriptionId = id(3), baseProduct = id(4), boostProduct = id(5);
const game = { targetKind: "NEW_GAME" as const, slotId: "preview", stationId, masterServiceId, roomId: id(6),
  subServiceIds: [id(7)], startsAt: start(), shareCount: 4 as const, durationMinutes: 60 as const };
const exerciseId = id(8);
const providerFacts = { activationDays: 0, type: "GROUP", variant: "DAYS", appliesTo: "CLIENT",
  hasStudioLimitation: false, hasDirectionLimitation: false, hasTypeLimitation: false, hasDayLimitation: false,
  hasTimeRangeLimitation: false, hasDayTimeLimitation: false, availableStudios: [], availableTypes: [], availableDirections: [] };
const terms = { providerFacts, tenantKey: "iSkq6G", state: "PUBLISHED", currency: "RUB",
  publicationDigest: "sha256:" + "a".repeat(64), validUntilMs: Date.now() + 120_000,
  productId: boostProduct, productAmountMinor: 880_000, durationDays: 7, baseProducts: { [baseProduct]: "residency" },
  scopes: [
    { targetKind: "NEW_GAME", stationId, scopeId: masterServiceId },
    { targetKind: "EXISTING_GAME", stationId, scopeId: masterServiceId },
    { targetKind: "GROUP_TRAINING", stationId, scopeId: 100 },
    { targetKind: "TOURNAMENT", stationId, scopeId: 200 },
  ],
};

const canonical = {
  isSubscriptionBooking: (booking: { paidBy?: string }) => booking.paidBy === "subscription",
  isInactiveBooking: (booking: { cancelled?: boolean }) => booking.cancelled === true,
  isProTrainingExercise: (exercise: { pro?: boolean }) => exercise?.pro === true,
  eventDate: (booking: { date: string }) => booking.date,
  eventDurationMinutes: (exercise: { durationMinutes: number }) => exercise.durationMinutes,
  resolveCategory: (booking: { category: string }) => booking.category,
  lk1LifecycleInstant: (date?: string) => date ? Date.parse(date) : null,
  normalizeId: (value?: string) => value?.toLowerCase() ?? "",
  bookingId: (booking: { id: string }) => booking.id,
  bookingSubscriptionId: (booking: { clientSubscriptionId: string }) => booking.clientSubscriptionId,
  collectExactProductIds: (subscription: { productIds: string[] }) => subscription.productIds,
  unwrapRecord: (payload: unknown) => payload,
  managedExternalEventTypeId: (exercise: { typeKey?: string; directionId?: number; typeId?: number }) =>
    exercise?.typeKey ?? (exercise?.directionId && exercise.typeId
      ? `viva:direction:${exercise.directionId}:type:${exercise.typeId}` : null),
};
const owned = (productId: string) => ({ status: "ACTIVE", productIds: [productId],
  activationDate: start(-172_800_000), expirationDate: start(30 * 86_400_000) });
const quoteContext = (kind: string = game.targetKind, basePlan = "residency") => {
  const event = kind === "GROUP_TRAINING" || kind === "TOURNAMENT";
  const target = { ...game, targetKind: kind, ...(event ? { exerciseId, durationMinutes: 90 } : {}) };
  return {
    target, selectionKey: event ? JSON.stringify([kind, exerciseId]) : pilotOfferSelectionKey(game),
    exercise: { pro: false }, directionId: kind === "GROUP_TRAINING" ? 100 : 200,
    pilotRaBoostPolicy: { ...terms, baseProducts: { [baseProduct]: basePlan } },
    pilotRaBoostSubscriptions: [owned(baseProduct)],
    subscriptions: { [subscriptionId]: owned(baseProduct) }, metadata: { [subscriptionId]: { productId: baseProduct } },
    instanceErrors: {}, basePriceMinor: 100_000,
    quotes: [{ status: "AVAILABLE", amountMinor: 70_000, subscriptionId, expiresAt: Date.now() + 30_000 }],
    bookings: [] as Array<Record<string, unknown>>, activeBookings: [] as Array<Record<string, unknown>>,
    operations: [] as Array<Record<string, unknown>>,
  };
};

test("all four price targets can return a 0 RUB participation price with a separate paid product", () => {
  for (const [kind, service] of [
    ["NEW_GAME", "open_game"], ["EXISTING_GAME", "open_game"],
    ["GROUP_TRAINING", "group_training"], ["TOURNAMENT", "tournament"],
  ]) {
    const ctx = quoteContext(kind);
    const candidate = pilotRaBoostCandidate(ctx, canonical, service, Date.now());
    assert.deepEqual(candidate, {
      kind: "RA_BOOST", mode: "offer", selectionKey: ctx.selectionKey, productId: boostProduct, durationDays: 7,
      participationAmountMinor: 0, productAmountMinor: 880_000, basePriceMinor: 100_000,
      baseAmountMinor: 70_000, basePlan: "residency", baseSubscriptionId: subscriptionId, expiresAt: ctx.quotes[0].expiresAt,
    }, kind);
  }
});

test("owned Boost replaces purchase, 90 minutes charges the uncovered part and full court gets no offer", () => {
  const ctx = quoteContext();
  ctx.pilotRaBoostSubscriptions.push(owned(boostProduct));
  const included = pilotRaBoostCandidate(ctx, canonical, "open_game", Date.now());
  assert.equal(included.mode, "included");
  assert.equal(included.productAmountMinor, 0);
  const longer = { ...ctx, target: { ...ctx.target, durationMinutes: 90 } };
  assert.equal(pilotRaBoostCandidate(longer, canonical, "open_game", Date.now()).participationAmountMinor, 23_334);
  assert.equal(pilotRaBoostCandidate({ ...ctx, target: { ...ctx.target, shareCount: 2 } }, canonical, "open_game", Date.now()), null);
});

test("legacy ownership requires an actor-bound product mapping when Viva omits the product alias", () => {
  const ctx = quoteContext();
  const row = { ...owned(baseProduct), subscriptionId, productIds: [] };
  ctx.pilotRaBoostSubscriptions = [row];
  ctx.subscriptions = { [subscriptionId]: row };
  assert.equal(pilotRaBoostCandidate(ctx, canonical, "open_game", Date.now()).participationAmountMinor, 0);
  assert.equal(pilotRaBoostCandidate({ ...ctx, metadata: {} }, canonical, "open_game", Date.now()), null);
  assert.equal(pilotRaBoostCandidate({
    ...ctx, pilotRaBoostSubscriptions: [{ ...row, productIds: [boostProduct] }],
  }, canonical, "open_game", Date.now()), null);
  assert.equal(pilotRaBoostCandidate({
    ...ctx, pilotRaBoostSubscriptions: [row, { ...row, subscriptionId: id(99), status: "NEW" }],
  }, canonical, "open_game", Date.now()), null);
});

test("new-game Boost uses the server's open-game type for RA provider restrictions", () => {
  const ctx = quoteContext();
  const facts = { ...providerFacts, hasDirectionLimitation: true, availableDirections: [4588],
    hasTypeLimitation: true, availableTypes: [1613] };
  const configured = { ...ctx, exercise: undefined, pilotRaBoostPolicy: { ...ctx.pilotRaBoostPolicy, providerFacts: facts } };
  assert.equal(pilotRaBoostCandidate(configured, canonical, "open_game", Date.now()).participationAmountMinor, 0);
  assert.equal(pilotRaBoostCandidate({
    ...configured, pilotRaBoostPolicy: { ...ctx.pilotRaBoostPolicy, providerFacts: { ...facts, availableTypes: [2572] } },
  }, canonical, "open_game", Date.now()), null);
  assert.equal(pilotRaBoostCandidate({
    ...configured, target: { ...ctx.target, targetKind: "EXISTING_GAME" },
    exercise: { typeKey: "viva:direction:7291:type:2572" },
  }, canonical, "open_game", Date.now()), null);
});

test("purchase is hidden if already free, identity/terms are unresolved, limits used or outside policy", () => {
  const ctx = quoteContext();
  const today = game.startsAt.slice(0, 10);
  const use = { paidBy: "subscription", date: today, category: "open_game", durationMinutes: 60 };
  for (const alternative of [
    { quotes: [{ ...ctx.quotes[0], amountMinor: 0 }] },
    { quotes: [{ ...ctx.quotes[0], amountMinor: 100_000 }] },
    { quotes: [{ ...ctx.quotes[0], expiresAt: Date.now() - 1 }] },
    { bookings: [use] },
    { bookings: [{ ...use, date: undefined }] },
    { bookings: [{ ...use, category: "unknown" }] },
    { activeBookings: Array(9).fill(use) },
    { operations: [{ serviceDate: today }] },
    { pilotRaBoostSubscriptions: [owned(baseProduct), { ...owned(boostProduct), isFrozen: true }] },
    { pilotRaBoostSubscriptions: [{ ...owned(baseProduct), productIds: [baseProduct, boostProduct] }] },
    { instanceErrors: { [subscriptionId]: "UNCONFIRMED" } },
    { target: { ...ctx.target, stationId: id(99) } },
    { pilotRaBoostPolicy: { ...terms, providerFacts: { ...providerFacts, hasStudioLimitation: true, availableStudios: [id(99)] } } },
    { target: { ...ctx.target, startsAt: start(8 * 86_400_000) } },
  ]) assert.equal(pilotRaBoostCandidate({ ...ctx, ...alternative }, canonical, "open_game", Date.now()), null);
  assert.ok(pilotRaBoostCandidate({ ...ctx, bookings: [{ ...use, cancelled: true }] }, canonical, "open_game", Date.now()));
});

test("PRO and Friendship 2.0 use the policy's shared event allowance", () => {
  const ctx = quoteContext("GROUP_TRAINING", "friendship-2");
  ctx.exercise.pro = true;
  assert.ok(pilotRaBoostCandidate(ctx, canonical, "group_training", Date.now()));
  const used = { paidBy: "subscription", date: game.startsAt.slice(0, 10), category: "tournament", pro: true };
  assert.equal(pilotRaBoostCandidate({ ...ctx, bookings: [used] }, canonical, "group_training", Date.now()), null);
  const residency = quoteContext("GROUP_TRAINING");
  residency.exercise.pro = true;
  assert.equal(pilotRaBoostCandidate(residency, canonical, "group_training", Date.now()), null);
});

test("confirmed bookings already present in Viva count only once; pending operations refuse the offer", () => {
  const ctx = quoteContext("GROUP_TRAINING", "friendship-2");
  const date = game.startsAt.slice(0, 10);
  const booking = { id: id(20), clientSubscriptionId: subscriptionId, paidBy: "subscription", date,
    category: "open_game", durationMinutes: 60 };
  const operation = { bookingId: booking.id, clientSubscriptionId: subscriptionId, serviceDate: date, state: "CONFIRMED" };
  assert.ok(pilotRaBoostCandidate({ ...ctx, bookings: [booking], operations: [operation] }, canonical, "group_training", Date.now()));
  assert.ok(pilotRaBoostCandidate({ ...ctx, operations: [{ ...operation, state: "RELEASED" }] }, canonical, "group_training", Date.now()));
  assert.equal(pilotRaBoostCandidate({ ...ctx, operations: [operation] }, canonical, "group_training", Date.now()), null);
  assert.equal(pilotRaBoostCandidate({ ...ctx, bookings: [booking], operations: [{ ...operation, state: "PENDING" }] },
    canonical, "group_training", Date.now()), null);
});

test("the existing route defaults off and the opt-in cannot accept client prices or subscription IDs", () => {
  const globals = { get: () => null };
  const request = (payload: object, query: object = {}) => entry({ req: { query, headers: { authorization: "Bearer fixture" } }, payload }, globals);
  const ordinary = request({ target: game, subscriptionIds: [subscriptionId] });
  assert.equal(ordinary._subscriptionPricePreview.pilotRaBoost, undefined);
  for (const bad of [
    request({ target: game }),
    request({ target: game, participationAmountMinor: 0 }, { pilotOffer: "ra-boost" }),
    request({ target: game, subscriptionIds: [subscriptionId] }, { pilotOffer: "ra-boost" }),
    request({ target: game }, { pilotOffer: ["ra-boost", "ra-boost"] }),
  ]) assert.equal(bad._subscriptionPricePreview.statusCode, 400);
  const optIn = request({ target: game }, { pilotOffer: "ra-boost" });
  const out = router(optIn, globals, { get: () => undefined });
  assert.ok(out[4]);
  assert.equal(finalize(out[4], globals).payload.pilotOffer, undefined);
  assert.equal(out[0], null);
});

test("the Node-RED finalize path reads the exact product from Viva and declines a changed price or URL", () => {
  const globals = { get: () => null };
  const env = { get: () => undefined };
  assert.equal(readPilotRaBoostPolicy(JSON.stringify({ ...terms, state: "DRAFT" }), terms.tenantKey, Date.now()), null);
  assert.ok(readPilotRaBoostPolicy(JSON.stringify(terms), terms.tenantKey, Date.now()));
  const product = { ...providerFacts, id: boostProduct, name: "РАбуста", cost: 880_000, validityDays: 7 };
  assert.equal(pilotRaBoostProviderMatches({ ...product, onlyInternalSale: true }, terms), false);
  assert.equal(pilotRaBoostProviderMatches({ ...product, activationDays: 10 }, terms), false);
  assert.equal(pilotRaBoostProviderMatches({ ...product, hasDirectionLimitation: true, availableDirections: [200] }, terms), false);
  for (const [responseUrl, payload, expected] of [
    [`https://api.vivacrm.ru/end-user/api/v1/iSkq6G/products/subscriptions/${boostProduct}`, product, true],
    [`https://api.vivacrm.ru/end-user/api/v1/iSkq6G/products/subscriptions/${boostProduct}`, { ...product, cost: 1 }, false],
    ["https://other.invalid/", product, false],
  ] as const) {
    const ctx = { ...quoteContext(), pending: [], step: "next", startedAt: Date.now(), auth: "Bearer fixture", tenantKey: terms.tenantKey,
      pilotRaBoost: true };
    const baseExpiresAt = Date.now() + 8_000;
    ctx.quotes[0].expiresAt = baseExpiresAt;
    const dispatch = new Function("msg", "global", "env", "canonical", termsSource + "\n" + node("router"));
    const out = dispatch({ _subscriptionPricePreview: ctx }, globals, env, canonical);
    assert.equal(out[0].method, "GET");
    assert.equal(out[0].url.endsWith(`/products/subscriptions/${boostProduct}`), true);
    const result = dispatch({ ...out[0], responseUrl, payload, statusCode: 200 }, globals, env, canonical);
    const reply = finalize(result[4], globals).payload;
    assert.equal(Boolean(reply.pilotOffer), expected);
    if (expected) assert.equal(reply.pilotOffer.expiresAt, baseExpiresAt);
    assert.deepEqual(reply.quotes, []);
  }
});

test("client does not trust stale or cross-target prices and retains the separate product amount", () => {
  const serverTimeMs = 1_000_000;
  const selectionKey = pilotOfferSelectionKey(game);
  const pilotOffer: RaBoostPreview = {
    kind: "RA_BOOST", mode: "offer", selectionKey, productId: boostProduct, basePriceMinor: 100_000,
    baseAmountMinor: 70_000, basePlan: "residency", baseSubscriptionId: subscriptionId, durationDays: 7, participationAmountMinor: 0,
    productAmountMinor: 880_000, expiresAt: serverTimeMs + 20_000,
  };
  const data = { pilotOffer, serverTimeMs };
  assert.equal(readRaBoostPreview(data, selectionKey, 150)?.productAmountMinor, 880_000);
  assert.equal(readRaBoostPreview(data, "another selected slot", 150), null);
  assert.equal(readRaBoostPreview(data, selectionKey, 22_000), null);
  assert.equal(readRaBoostPreview({ ...data, pilotOffer: { ...pilotOffer, productAmountMinor: 0 } }, selectionKey, 150), null);
});
