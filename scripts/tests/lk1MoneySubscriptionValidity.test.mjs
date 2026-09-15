// The annual-HUB money mandate on the event route: the gateway re-reads the client's
// subscriptions, proves exactly one selected instance is valid for the event window, and
// only then lets the managed quote price the discount. A refusal used to be a bare
// `LK1_MONEY_SUBSCRIPTION_VALIDITY_UNPROVEN`; it now names the failing condition, and
// these tests pin both the verdict and the names.
//
// The harness composes the reviewed gateway body with stubbed channels, exactly like
// scripts/tests/groupEventPayment.test.mjs, so it runs without production fixtures.
import assert from "node:assert/strict";
import test from "node:test";
import { hubGatewaySource } from "../lib/eventPaymentSources.mjs";

const source = hubGatewaySource();
const actor = "1f0d5a3e-0000-4000-8000-000000000001";
const subscriptionId = "1f0d5a3e-0000-4000-8000-000000000002";
const exerciseId = "1f0d5a3e-0000-4000-8000-000000000003";
const otherId = "1f0d5a3e-0000-4000-8000-000000000004";
const HUB_PRODUCT = "db7a5250-7369-4f43-8ac5-9111be24bc74";
const EVENT_START = "2099-09-21T08:00:00+03:00";

const hubExercise = () => ({
  id: exerciseId, typeId: 1613, directionId: 4588, studioId: "studio-1", roomId: "room-1",
  timeFrom: EVENT_START, timeTo: "2099-09-21T09:00:00+03:00",
  availableClientSubscriptions: [],
});

function instance(overrides = {}) {
  return {
    subscriptionId, clientSubscriptionId: subscriptionId, clientId: actor,
    productId: HUB_PRODUCT, status: "ACTIVE",
    purchaseDate: "2026-09-05", purchaseAt: "2026-09-05",
    activationDate: "2026-08-01", expirationDate: "2099-12-31",
    ...overrides,
  };
}

/** Drive the `lk1_money_owned_subscriptions` phase with one row. */
function runMoneyPhase(row, overrides = {}) {
  const ctx = {
    caller: "http", tenantKey: "fixture", actorClientId: actor, clientSubscriptionId: subscriptionId,
    operationId: "fixture-operation", exerciseId, managedAction: "BOOK_GROUP_TRAINING",
    step: "lk1_money_owned_subscriptions",
    lk1MoneyExercise: hubExercise(),
    lk1MoneyReturnStep: "lk1_money_owned_continue",
    ...overrides,
  };
  const msg = { payload: { content: [row], totalElements: 1, number: 0, last: true }, statusCode: 200 };
  const stops = [];
  const deps = {
    msg, ctx, isObj: (value) => value !== null && typeof value === "object" && !Array.isArray(value),
    VIVA_API_BASE: "https://api.vivacrm.ru", OUTPUT_FINAL: 4, OUTPUT_HTTP: 0,
    isHttpOk: (status) => status >= 200 && status < 300,
    hasCompleteBookingList: (payload) => Array.isArray(payload) || (Array.isArray(payload?.content) && payload.last === true),
    extractItems: (payload) => (Array.isArray(payload) ? payload : payload.content),
    unwrapRecord: (value) => value,
    normalizeId: (value) => String(value || "").trim().toLowerCase(),
    isValidDateKey: (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || "").slice(0, 10)),
    finiteDate: (value) => { const ms = Date.parse(String(value || "")); return Number.isFinite(ms) ? new Date(ms) : null; },
    normalizePhone: (value) => value,
    collectExactProductIds: (value) => [value.productId],
    collectSubscriptionPurchaseDateEvidence: (value) => {
      const rows = Array.isArray(value) ? value : [value];
      const dates = [...new Set(rows.map((row) => String(row.purchaseDate || "").slice(0, 10)).filter(Boolean))];
      return { invalid: dates.length !== 1, dates };
    },
    MANAGED_ENFORCEMENT_PURCHASE_FROM: "2026-09-01",
    lk1ReadBoundPolicy: () => ({ productId: HUB_PRODUCT, maxActiveBookings: 4, freeGameMinutesPerDay: 60,
      gameOverageDiscountPercent: 30, groupTrainingDiscountPercent: 50, tournamentDiscountPercent: 50 }),
    lk1ReadPlanRules: () => ({ formatVersion: 1, rules: [
      { productId: HUB_PRODUCT, planKey: "hub", enforceFrom: "2026-09-01", maxActiveBookings: 4,
        freeGameMinutesPerDay: 60, gameOverageDiscountPercent: 30, groupTrainingDiscountPercent: 50,
        tournamentDiscountPercent: 50 },
    ] }),
    lk1MongoMatched: (result) => result?.matchedCount,
    readGlobal: () => "fixture-service-token",
    lk1NeedsVisitJob: () => false,
    prepareHttp: () => null, prepareUserGet: () => null, prepareAdminGet: () => null,
    prepareMongoUpdate: () => null, prepareOperationFind: () => null,
    finishPending: (_ctx, message, details) => {
      stops.push({ message, details });
      return { kind: "stop", code: details?.code, details };
    },
    finishError: (_ctx, statusCode, message, details) => {
      stops.push({ statusCode, message, details });
      return { kind: "error", statusCode, code: details?.code };
    },
    finishConfirmed: () => null,
    emit: (output) => ({ kind: "emit", output, payload: msg.payload, step: ctx.step }),
    managedActionForTarget: () => ctx.managedAction,
    managedExternalEventTypeId: () => "viva:direction:4588:type:1613",
    eventDurationMinutes: () => 60,
    eventStartsAt: () => EVENT_START,
    exerciseRoomId: () => "room-1",
    resolveCategory: () => "group_training",
    resolveLk1Rule: (options) => {
      const record = (Array.isArray(options?.owned) ? options.owned[0] : options?.owned) || {};
      const rules = (options?.planRules?.rules || []).filter((rule) => rule.productId === record.productId);
      if (!rules.length) return { matched: false };
      const purchaseDate = String(record.purchaseDate || "").slice(0, 10);
      const legacy = purchaseDate < rules[0].enforceFrom;
      return legacy ? { matched: true, legacy: true, productId: rules[0].productId, rule: rules[0] }
        : { matched: true, legacy: false, productId: rules[0].productId, rule: rules[0] };
    },
    managedTargetCategory: () => "GROUP_TRAINING",
    findOwnedSubscriptions: (exercise, id) => (exercise?.availableClientSubscriptions || [])
      .filter((row) => [row.clientSubscriptionId, row.subscriptionId, row.clientSubId, row.id, row.uuid]
        .some((value) => value !== undefined && value !== null
          && String(value).trim().toLowerCase() === String(id).trim().toLowerCase())),
  };
  const result = new Function(...Object.keys(deps), source)(...Object.values(deps));
  return { result, ctx, stops };
}

test("a valid annual instance is proven and the phase continues", () => {
  const run = runMoneyPhase(instance());
  assert.equal(run.stops.length, 0, JSON.stringify(run.stops));
  assert.equal(run.ctx.lk1MoneyOwnership.subscription.subscriptionId, subscriptionId);
  assert.equal(run.ctx.lk1MoneyReadbackPhase, "lk1_money_owned_continue");
  assert.equal(run.ctx.step, "lk1_money_owned_continue");
});

test("every refused condition is named in the response", () => {
  const cases = [
    { name: "expired", row: instance({ expirationDate: "2026-09-01" }), expect: "expired" },
    { name: "expires before the event ends", row: instance({ expirationDate: "2099-09-21T08:30:00+03:00" }),
      expect: "expiry_before_target_end" },
    { name: "activates after the event starts", row: instance({ activationDate: "2099-09-21T08:30:00+03:00" }),
      expect: "activation_after_target_start" },
    { name: "activates in the future", row: instance({ activationDate: "2099-09-20T08:00:00+03:00" }),
      expect: "activation_in_future" },
    { name: "not active", row: instance({ status: "FROZEN" }), expect: "status_frozen" },
    { name: "instance id mismatch", row: instance({ clientSubscriptionId: otherId }),
      expect: "instance_id_mismatch" },
    { name: "owner mismatch", row: instance({ clientId: otherId }), expect: "owner_mismatch" },
    { name: "hold", row: instance({ holdUntil: "2099-01-01" }), expect: "hold" },
    { name: "frozen", row: instance({ isFrozen: true }), expect: "frozen" },
    { name: "activation unparsed", row: instance({ activationDate: "не дата" }), expect: "activation_unparsed" },
  ];
  for (const item of cases) {
    const run = runMoneyPhase(item.row);
    assert.equal(run.stops.length, 1, item.name);
    const stop = run.stops[0];
    assert.equal(stop.details.code, "LK1_MONEY_SUBSCRIPTION_VALIDITY_UNPROVEN", item.name);
    assert.equal(stop.details.observed.stage, "money_validity", item.name);
    assert.ok(stop.details.observed.violations.includes(item.expect),
      `${item.name}: ${JSON.stringify(stop.details.observed.violations)}`);
    assert.equal(run.ctx.lk1MoneyOwnership, undefined, item.name);
  }
});

test("a second matching instance refuses with instance_count", () => {
  const ctx = {
    caller: "http", tenantKey: "fixture", actorClientId: actor, clientSubscriptionId: subscriptionId,
    operationId: "fixture-operation", exerciseId, managedAction: "BOOK_GROUP_TRAINING",
    step: "lk1_money_owned_subscriptions", lk1MoneyExercise: { ...hubExercise(),
      availableClientSubscriptions: [instance(), instance()] },
    lk1MoneyReturnStep: "lk1_money_owned_continue",
  };
  const msg = { payload: { content: [instance(), instance({ id: otherId })], totalElements: 2, number: 0, last: true },
    statusCode: 200 };
  const stops = [];
  const deps = {
    msg, ctx, isObj: (value) => value !== null && typeof value === "object" && !Array.isArray(value),
    VIVA_API_BASE: "https://api.vivacrm.ru", OUTPUT_FINAL: 4, OUTPUT_HTTP: 0,
    isHttpOk: () => true,
    hasCompleteBookingList: (payload) => Array.isArray(payload?.content) && payload.last === true,
    extractItems: (payload) => payload.content,
    unwrapRecord: (value) => value,
    normalizeId: (value) => String(value || "").trim().toLowerCase(),
    isValidDateKey: (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || "").slice(0, 10)),
    finiteDate: (value) => { const ms = Date.parse(String(value || "")); return Number.isFinite(ms) ? new Date(ms) : null; },
    collectExactProductIds: (value) => [value.productId],
    collectSubscriptionPurchaseDateEvidence: () => ({ invalid: false, dates: ["2026-09-05"] }),
    MANAGED_ENFORCEMENT_PURCHASE_FROM: "2026-09-01",
    lk1ReadBoundPolicy: () => ({ productId: HUB_PRODUCT, maxActiveBookings: 4, freeGameMinutesPerDay: 60,
      gameOverageDiscountPercent: 30, groupTrainingDiscountPercent: 50, tournamentDiscountPercent: 50 }),
    lk1ReadPlanRules: () => ({ formatVersion: 1, rules: [{ productId: HUB_PRODUCT, planKey: "hub",
      enforceFrom: "2026-09-01", maxActiveBookings: 4, freeGameMinutesPerDay: 60,
      gameOverageDiscountPercent: 30, groupTrainingDiscountPercent: 50, tournamentDiscountPercent: 50 }] }),
    readGlobal: () => "fixture-service-token", lk1NeedsVisitJob: () => false,
    prepareHttp: () => null, prepareUserGet: () => null, prepareAdminGet: () => null,
    prepareMongoUpdate: () => null, prepareOperationFind: () => null,
    finishPending: (_ctx, message, details) => { stops.push({ message, details }); return { kind: "stop", details }; },
    finishError: () => null, finishConfirmed: () => null,
    emit: () => ({ kind: "emit" }),
    managedActionForTarget: () => ctx.managedAction,
    managedExternalEventTypeId: () => "viva:direction:4588:type:1613",
    eventDurationMinutes: () => 60, eventStartsAt: () => EVENT_START, exerciseRoomId: () => "room-1",
    resolveCategory: () => "group_training",
    resolveLk1Rule: () => ({ matched: true, legacy: false, productId: HUB_PRODUCT,
      rule: { productId: HUB_PRODUCT, planKey: "hub", enforceFrom: "2026-09-01", maxActiveBookings: 4,
        freeGameMinutesPerDay: 60, gameOverageDiscountPercent: 30, groupTrainingDiscountPercent: 50,
        tournamentDiscountPercent: 50 } }),
    managedTargetCategory: () => "GROUP_TRAINING",
    findOwnedSubscriptions: (exercise, id) => (exercise?.availableClientSubscriptions || [])
      .filter((row) => [row.clientSubscriptionId, row.subscriptionId, row.clientSubId, row.id, row.uuid]
        .some((value) => value !== undefined && value !== null
          && String(value).trim().toLowerCase() === String(id).trim().toLowerCase())),
  };
  new Function(...Object.keys(deps), source)(...Object.values(deps));
  assert.equal(stops.length, 1, JSON.stringify(stops));
  assert.equal(stops[0].details.observed.violations.includes("instance_count"), true,
    JSON.stringify(stops[0].details.observed.violations));
});

test("a refusal without a named observation keeps the previous body", () => {
  // Every other gateway stop must stay `{ code }` only: the observation is additive.
  const stops = [];
  const ctx = {
    caller: "http", tenantKey: "fixture", actorClientId: actor, clientSubscriptionId: subscriptionId,
    operationId: "fixture-operation", exerciseId, managedAction: "BOOK_GROUP_TRAINING",
    step: "lk1_money_owned_subscriptions", lk1MoneyExercise: hubExercise(),
    lk1MoneyReturnStep: "lk1_money_owned_continue",
  };
  const msg = { payload: null, statusCode: 200 };
  const deps = {
    msg, ctx, isObj: (value) => value !== null && typeof value === "object" && !Array.isArray(value),
    VIVA_API_BASE: "https://api.vivacrm.ru", OUTPUT_FINAL: 4, OUTPUT_HTTP: 0,
    isHttpOk: () => true,
    hasCompleteBookingList: () => false,
    extractItems: () => [], unwrapRecord: (value) => value,
    normalizeId: (value) => String(value || "").trim().toLowerCase(),
    isValidDateKey: (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || "").slice(0, 10)),
    finiteDate: (value) => { const ms = Date.parse(String(value || "")); return Number.isFinite(ms) ? new Date(ms) : null; },
    collectExactProductIds: () => [], collectSubscriptionPurchaseDateEvidence: () => ({ invalid: false, dates: [] }),
    MANAGED_ENFORCEMENT_PURCHASE_FROM: "2026-09-01",
    lk1ReadBoundPolicy: () => ({ productId: HUB_PRODUCT, maxActiveBookings: 4, freeGameMinutesPerDay: 60,
      gameOverageDiscountPercent: 30, groupTrainingDiscountPercent: 50, tournamentDiscountPercent: 50 }), lk1ReadPlanRules: () => undefined,
    readGlobal: () => "fixture-service-token", lk1NeedsVisitJob: () => false,
    prepareHttp: () => null, prepareUserGet: () => null, prepareAdminGet: () => null,
    prepareMongoUpdate: () => null, prepareOperationFind: () => null,
    finishPending: (_ctx, message, details) => { stops.push({ message, details }); return { kind: "stop", details }; },
    finishError: () => null, finishConfirmed: () => null, emit: () => ({ kind: "emit" }),
    managedActionForTarget: () => ctx.managedAction, managedExternalEventTypeId: () => null,
    eventDurationMinutes: () => 60, eventStartsAt: () => EVENT_START, exerciseRoomId: () => "room-1",
    resolveCategory: () => "group_training", resolveLk1Rule: () => ({ matched: false }),
    managedTargetCategory: () => "GROUP_TRAINING", findOwnedSubscriptions: () => [],
  };
  new Function(...Object.keys(deps), source)(...Object.values(deps));
  assert.equal(stops.length, 1);
  assert.equal(stops[0].details.code, "LK1_MONEY_OWNERSHIP_UNAVAILABLE");
  assert.equal(stops[0].details.observed, undefined);
  assert.deepEqual(Object.keys(stops[0].details), ["code"]);
});
