import test from "node:test";
import assert from "node:assert/strict";
import { createSubscriptionPriceTarget, subscriptionPricePreview, subscriptionPricePreviewsById, subscriptionPriceSelectionKey, type SubscriptionPriceQuote } from "../../src/components/games/subscriptionPricePreview.ts";

const now = Date.parse("2026-09-08T12:00:00Z");
const target = { targetKind: "NEW_GAME" as const, shareCount: 4 as const, slotId: "slot-a", stationId: "station-a", roomId: "room-a",
  masterServiceId: "service-a", subServiceIds: ["b", "a"], startsAt: "2026-09-21T07:00:00+03:00", durationMinutes: 90 as const };
const key = subscriptionPriceSelectionKey(target);
const quote = (subscriptionId = "subscription-a", overrides: Partial<SubscriptionPriceQuote> = {}): SubscriptionPriceQuote => ({
  subscriptionId, selectionKey: key, status: "AVAILABLE", basePriceMinor: 300000, amountMinor: 75000,
  freeMinutes: 60, paidMinutes: 30, reasonCode: "ALLOWED", evaluatedAt: now, expiresAt: now + 30000, ...overrides,
});
const preview = (quotes: SubscriptionPriceQuote[] | null, overrides = {}) => subscriptionPricePreview({
  quotes, subscriptionIds: ["subscription-a"], selectionKey: key, durationMinutes: 90, loading: false, now, ...overrides,
});

test("90 minute game displays the server amount and paid 30 minutes", () => {
  assert.deepEqual(preview([quote()]), {state: "available", label: "По подписке от 750 ₽", detail: "Доплата за 30 мин",
    basePriceMinor: 300000, amountMinor: 75000, discounted: true});
});
test("minimum includes the legacy free subscription without choosing it for checkout", () => {
  const result = preview([quote(), quote("subscription-b", {amountMinor: 0, freeMinutes: 90, paidMinutes: 0})],
    {subscriptionIds: ["subscription-a", "subscription-b"]});
  assert.equal(result.label, "По подписке от 0 ₽"); assert.equal(result.detail, null);
  assert.equal("selectedSubscriptionId" in result, false);
});
test("120 minute overage and fractional rubles remain the server values", () => {
  assert.equal(preview([quote("subscription-a", {paidMinutes: 60, amountMinor: 150050})],
    {durationMinutes: 120}).label, "По подписке от 1 500,5 ₽");
});
test("partial, duplicate, foreign, expired and prior-slot quotes never advertise a discount", () => {
  for (const rows of [null, [], [quote(), quote()], [quote("other")], [quote("subscription-a", {expiresAt: now})],
    [quote("subscription-a", {selectionKey: "old-slot"})], [quote("subscription-a", {amountMinor: -1})],
    [quote("subscription-a", {freeMinutes: 90})]]) {
    assert.equal(preview(rows).state, "unavailable"); assert.equal(preview(rows).discounted, false);
  }
  assert.equal(preview([quote()], {subscriptionIds: ["subscription-a", "subscription-b"]}).state, "unavailable");
});
test("spent limit and pending verification keep ordinary payment visible", () => {
  assert.equal(preview([quote("subscription-a", {status: "LIMIT_USED", amountMinor: null})]).label,
    "Лимит по подписке исчерпан");
  assert.equal(preview([quote()], {loading: true}).label, "Проверяем подписки…");
});
test("price is not crossed out when confirmed subscription amount equals ordinary price", () => {
  assert.equal(preview([quote("subscription-a", {amountMinor: 300000})]).discounted, false);
});
test("every materially selected field invalidates old quotes; subservice order does not", () => {
  for (const changed of [{slotId:"other"},{stationId:"other"},{roomId:"other"},{masterServiceId:"other"},
    {subServiceIds:["other"]},{startsAt:"2026-09-22T07:00:00+03:00"},{durationMinutes:120 as const},{shareCount:2 as const}]) {
    assert.notEqual(subscriptionPriceSelectionKey({...target,...changed}), key);
  }
  assert.equal(subscriptionPriceSelectionKey({...target, subServiceIds:["a","b"]}), key);
});

test("malformed server rows fail closed without throwing", () => {
  for (const row of [null, undefined, 1, "text", {}, { subscriptionId: "subscription-a" }]) {
    assert.equal(preview([row] as SubscriptionPriceQuote[]).state, "unavailable");
  }
});

test("complete production selection builds preview independently of DEV demo mode", () => {
  const input = {slotId: "slot-a", stationId: "station-a", roomId: "room-a", masterServiceId: "service-a",
    subServiceIds: ["b", "a"], date: "2026-09-21", fromTime: "07:00", durationMinutes: 90, shareCount: 4};
  assert.deepEqual(createSubscriptionPriceTarget(input), target);
  for (const change of [{slotId:null},{roomId:null},{masterServiceId:null},{subServiceIds:[]},{date:null},{fromTime:null}]) {
    assert.equal(createSubscriptionPriceTarget({...input,...change}), null);
  }
});

test("positive-balance candidate filter keeps NEW and ACTIVE one-visit subscriptions for server evaluation", async () => {
  const { filterSplitEligibleSubscriptions } = await import("../../src/components/games/splitSubscriptionAvailability.ts");
  for (const duration of [90, 120]) for (const status of ["ACTIVE", "NEW"]) {
    const candidate = {subscriptionId:"one-visit", name:null, status, visitsLeft:1, availableMinutes:0,
      activationDate: status === "NEW" ? null : "2026-09-07", expirationDate: status === "NEW" ? null : "2027-09-07",
      purchaseDate:"2026-09-05", hasStudioLimitation:false,availableStudios:[],hasTypeLimitation:true,
      availableTypes:[{id:1613,name:"Открытая игра"}],hasDirectionLimitation:false,availableDirections:[]};
    const filter = (items: typeof candidate[], visits: number) => filterSplitEligibleSubscriptions(items,
      new Set(["1613"]),new Set(["4588"]),"studio",visits,duration,"2026-09-21");
    assert.deepEqual(filter([candidate],1).map(row=>row.subscriptionId),["one-visit"]);
    assert.deepEqual(filter([candidate],2),[]);
    assert.deepEqual(filter([{...candidate,visitsLeft:0}],1),[]);
  }
});


test("each subscription keeps its own price even when the overall minimum is free", () => {
  const input = {quotes: [quote("legacy", {amountMinor: 0, freeMinutes: 90, paidMinutes: 0}),
    quote("annual", {amountMinor: 70000}), quote("used", {status: "LIMIT_USED", amountMinor: null})],
    subscriptionIds: ["annual", "used", "legacy"], selectionKey: key, durationMinutes: 90, loading: false, now};
  const rows = subscriptionPricePreviewsById(input);
  assert.equal(rows.annual.amountMinor, 70000);
  assert.equal(rows.annual.detail, "Доплата за 30 мин");
  assert.equal(rows.legacy.amountMinor, 0);
  assert.equal(rows.legacy.detail, null);
  assert.equal(rows.used.state, "limit-used");
  assert.equal(rows.used.amountMinor, null);
});
test("individual prices reject the whole incomplete, inconsistent or expired batch", () => {
  const input = {quotes: [quote("a"), quote("b")], subscriptionIds: ["a", "b"],
    selectionKey: key, durationMinutes: 90, loading: false, now};
  for (const quotes of [[quote("a")], [quote("a"), quote("b", {basePriceMinor: 200000})],
    [quote("a"), quote("b", {expiresAt: now})], [quote("a"), quote("b", {selectionKey: "old"})]]) {
    const rows = subscriptionPricePreviewsById({...input, quotes});
    assert.equal(rows.a.amountMinor, null); assert.equal(rows.b.amountMinor, null);
  }
  assert.equal(subscriptionPricePreviewsById({...input, loading: true}).a.state, "checking");
});


test("existing game quote identity excludes client prices and invalidates on target changes", async () => {
  const {createJoinSubscriptionPriceTarget} = await import("../../src/components/games/subscriptionPricePreview.ts");
  const input={gameId:"pay_game-a",date:"2099-09-23",fromTime:"07:00",durationMinutes:90};
  const selected=createJoinSubscriptionPriceTarget(input)!;
  assert.deepEqual(selected,{targetKind:"EXISTING_GAME",gameId:"pay_game-a",startsAt:"2099-09-23T07:00:00+03:00",durationMinutes:90});
  for (const change of [{gameId:"pay_game-b"},{date:"2099-09-24"},{fromTime:"08:00"},{durationMinutes:120}]) {
    assert.notEqual(subscriptionPriceSelectionKey(createJoinSubscriptionPriceTarget({...input,...change})!),subscriptionPriceSelectionKey(selected));
  }
  assert.equal(createJoinSubscriptionPriceTarget({...input,gameId:null}),null);
});
