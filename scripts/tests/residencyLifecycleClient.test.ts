import assert from "node:assert/strict";
import test from "node:test";

import {
  RESIDENCY_LIFECYCLE_PRODUCT_ID,
  createResidencyLifecycleClient,
  parseLifecycleCatalog,
  parseLifecycleOrder,
  parseLifecycleStatus,
  type LifecycleTransport,
} from "../../src/residency/residencyLifecycleClient.ts";
import {
  readResidencyLifecycleRoute,
} from "../../src/residency/residencyLifecycleRoute.ts";
import {
  attemptKeyFor,
  clearResidencyLifecycleAttempt,
  readResidencyLifecycleAttempt,
  saveResidencyLifecycleAttempt,
} from "../../src/residency/residencyLifecycleAttempt.ts";
import {
  formatResidencyMoney,
  resolveResidencyLifecycleDecision,
} from "../../src/residency/residencyLifecyclePurchase.ts";

const ORDER_ID = "00000000-0000-4000-8000-000000000001";

const catalog = {
  schemaVersion: 1,
  product: { productId: RESIDENCY_LIFECYCLE_PRODUCT_ID, title: "Резидентство ПадлхАБ", termDays: 30, priceMinor: 79000, currency: "RUB" },
  renewalEligible: false,
  renewal: { eligible: false, reason: "NOT_ACTIVE", eligibleAt: null, currentValidUntil: null },
  checkedAt: "2026-11-18T09:00:00.000Z",
};

const statusNone = {
  schemaVersion: 1, state: "NONE", validFrom: null, validUntil: null,
  source: "VIVA_OWNED_SUBSCRIPTIONS", observedAt: "2026-11-18T09:06:00.000Z", reason: null,
};

function order(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    orderId: ORDER_ID,
    mode: "NEW",
    state: "PENDING_PAYMENT",
    terminal: false,
    terminalReason: null,
    product: { productId: RESIDENCY_LIFECYCLE_PRODUCT_ID, title: "Резидентство ПадлхАБ", termDays: 30, currency: "RUB" },
    pricing: { baseAmountMinor: 79000, discountLines: [], totalMinor: 79000, currency: "RUB" },
    consent: { expectedTotalMinor: 79000, productId: RESIDENCY_LIFECYCLE_PRODUCT_ID, acceptedAt: "2026-11-18T09:00:00.000Z" },
    payment: { status: "PENDING", paymentUrl: "https://bank.example/pay/1", expiresAt: "2026-11-18T09:20:00.000Z", overdue: false, instruction: "Оплатите по ссылке." },
    recovery: { state: "AWAITING_PAYMENT", required: false, reason: null, action: "PAY", retryable: true, since: "2026-11-18T09:00:00.000Z" },
    residency: null,
    createdAt: "2026-11-18T09:00:00.000Z",
    updatedAt: "2026-11-18T09:00:00.000Z",
    revision: 1,
    ...overrides,
  };
}

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
    clear: () => { data.clear(); },
    key: (index: number) => [...data.keys()][index] ?? null,
    get length() { return data.size; },
  } as Storage;
}

test("the pilot route is strict and never matches the old residency routes", () => {
  assert.equal(readResidencyLifecycleRoute("?buyResidency=lifecycle"), "purchase");
  assert.equal(readResidencyLifecycleRoute("?phResidencyLifecycleReturn=1"), "return");
  assert.equal(readResidencyLifecycleRoute("?buyResidency=lifecycle&v=20261118"), "purchase");
  for (const search of [
    "?buyResidency=1", "?buyResidency=1&phCheckoutReturn=residency", "?residency=1",
    "?buyResidency=lifecycle&buyResidency=lifecycle", "?buyResidency=lifecycle&phResidencyLifecycleReturn=1",
    "?buyResidency=lifecycle&phCheckoutReturn=residency", "?phResidencyLifecycleReturn=1&buyResidency=1",
    "?phResidencyLifecycleReturn=1&phResidencyLifecycleReturn=1", "",
  ]) assert.equal(readResidencyLifecycleRoute(search), null, search);
});

test("catalog, status and order parsers reject wrong product, amount and state", () => {
  assert.equal(parseLifecycleCatalog(catalog)?.product.priceMinor, 79000);
  assert.equal(parseLifecycleCatalog({ ...catalog, product: { ...catalog.product, productId: "other" } }), null);
  assert.equal(parseLifecycleCatalog({ ...catalog, product: { ...catalog.product, priceMinor: 0 } }), null);
  assert.equal(parseLifecycleStatus(statusNone)?.state, "NONE");
  assert.equal(parseLifecycleStatus({ ...statusNone, state: "MAYBE" }), null);
  assert.equal(parseLifecycleOrder(order())?.orderId, ORDER_ID);
  assert.equal(parseLifecycleOrder(order({ state: "UNKNOWN" })), null);
  assert.equal(parseLifecycleOrder(order({ pricing: { baseAmountMinor: 79000, totalMinor: 1, currency: "RUB" } }))?.pricing.totalMinor, 1);
  assert.equal(parseLifecycleOrder(order({ consent: { expectedTotalMinor: 79000, productId: "other", acceptedAt: "2026-11-18T09:00:00.000Z" } })), null);
  assert.equal(parseLifecycleOrder(order({ payment: { status: "DISPATCHING" } })), null);
});

test("the decision is derived from server status and never invents a renewal", () => {
  assert.deepEqual(resolveResidencyLifecycleDecision({ catalog: parseLifecycleCatalog(catalog)!, status: parseLifecycleStatus(statusNone)!,
    unresolved: null, oldCheckoutPending: false }), { kind: "READY", mode: "NEW" });

  const active = parseLifecycleStatus({ ...statusNone, state: "ACTIVE", validFrom: "2026-11-18T09:05:00.000Z", validUntil: "2026-12-18T09:05:00.000Z" })!;
  const early = resolveResidencyLifecycleDecision({ catalog: parseLifecycleCatalog({ ...catalog,
    renewal: { eligible: false, reason: "REMAINING_DAYS_NOT_TRANSFERABLE", eligibleAt: "2026-12-18T09:05:00.000Z", currentValidUntil: "2026-12-18T09:05:00.000Z" } })!,
    status: active, unresolved: null, oldCheckoutPending: false });
  assert.equal(early?.kind, "BLOCKED");
  if (early?.kind === "BLOCKED") assert.equal(early.code, "RESIDENCY_RENEWAL_TOO_EARLY");

  const eligible = resolveResidencyLifecycleDecision({ catalog: parseLifecycleCatalog({ ...catalog,
    renewal: { eligible: true, reason: null, eligibleAt: null, currentValidUntil: "2026-12-18T09:05:00.000Z" } })!,
    status: active, unresolved: null, oldCheckoutPending: false });
  assert.deepEqual(eligible, { kind: "READY", mode: "RENEWAL" });

  const recovery = resolveResidencyLifecycleDecision({ catalog: parseLifecycleCatalog(catalog)!, status: parseLifecycleStatus(statusNone)!,
    unresolved: parseLifecycleOrder(order())!, oldCheckoutPending: false });
  assert.equal(recovery?.kind, "RECOVERY");

  const legacy = resolveResidencyLifecycleDecision({ catalog: parseLifecycleCatalog(catalog)!, status: parseLifecycleStatus(statusNone)!,
    unresolved: null, oldCheckoutPending: true });
  assert.equal(legacy?.kind, "BLOCKED");
  if (legacy?.kind === "BLOCKED") assert.equal(legacy.code, "LEGACY_CHECKOUT_PENDING");

  const unavailable = resolveResidencyLifecycleDecision({ catalog: parseLifecycleCatalog(catalog)!,
    status: parseLifecycleStatus({ ...statusNone, state: "UNAVAILABLE" })!, unresolved: null, oldCheckoutPending: false });
  assert.equal(unavailable?.kind, "BLOCKED");
});

test("the local attempt keeps one key for one confirmed operation and is namespaced", () => {
  const originalWindow = (globalThis as { window?: unknown }).window;
  const localStorage = memoryStorage();
  (globalThis as { window?: unknown }).window = { localStorage };
  try {
    clearResidencyLifecycleAttempt();
    const first = attemptKeyFor("NEW", 79000, 1000);
    assert.equal(first.length >= 16, true);
    saveResidencyLifecycleAttempt({ idempotencyKey: first, mode: "NEW", expectedTotalMinor: 79000, orderId: null, reconcileKey: null, startedAt: 1000 });
    assert.equal(readResidencyLifecycleAttempt(2000)?.idempotencyKey, first);
    assert.equal(attemptKeyFor("NEW", 79000, 3000), first);
    assert.notEqual(attemptKeyFor("NEW", 80000, 3000), first);
    assert.notEqual(attemptKeyFor("RENEWAL", 79000, 3000), first);
    assert.equal(readResidencyLifecycleAttempt(1000 + 25 * 60 * 60 * 1000), null);
  } finally {
    (globalThis as { window?: unknown }).window = originalWindow;
  }
});

test("pilot access accepts only the explicit capability from the server", async () => {
  const signal = new AbortController().signal;
  for (const data of [{ schemaVersion: 1, canCreate: false }, { schemaVersion: 1, canCreate: "false" }]) {
    const client = createResidencyLifecycleClient(async (request) => {
      assert.equal(request.path, "/lk/residency/pilot-access");
      assert.equal(request.method, "GET");
      assert.equal(request.signal, signal);
      return { status: 200, data, networkError: false };
    });
    const result = await client.readPilotAccess(signal);
    if (data.canCreate === false) assert.deepEqual(result, { ok: true, value: { canCreate: false } });
    else assert.equal(result.ok, false);
  }
});

test("the client sends the exact confirmed total and reuses the idempotency key", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const transport: LifecycleTransport = async (request) => {
    calls.push(request as unknown as Record<string, unknown>);
    if (request.path === "/lk/residency/orders" && request.method === "POST") {
      return { status: 200, data: { schemaVersion: 1, order: order(), idempotentReplay: false, recoveryRequired: false }, networkError: false };
    }
    return { status: 404, data: { code: "RESIDENCY_NOT_FOUND" }, networkError: false };
  };
  const client = createResidencyLifecycleClient(transport);
  const result = await client.createOrder({ mode: "NEW", expectedTotalMinor: 79000, expectedProductId: RESIDENCY_LIFECYCLE_PRODUCT_ID,
    idempotencyKey: "idem-key-0000000001", returnTarget: "lk1pilot" });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/lk/residency/orders");
  assert.equal(calls[0].idempotencyKey, "idem-key-0000000001");
  assert.equal(calls[0].returnTarget, "lk1pilot");
  assert.deepEqual(calls[0].body, { mode: "NEW", expectedTotalMinor: 79000, expectedProductId: RESIDENCY_LIFECYCLE_PRODUCT_ID });
});

test("the client surfaces the server refusal instead of treating it as success", async () => {
  const client = createResidencyLifecycleClient(async () => ({
    status: 403, data: { code: "RESIDENCY_CREATE_NOT_ALLOWED", message: "no" }, networkError: false,
  }));
  const result = await client.createOrder({ mode: "NEW", expectedTotalMinor: 79000, expectedProductId: RESIDENCY_LIFECYCLE_PRODUCT_ID,
    idempotencyKey: "idem-key-0000000001" });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.failure.code, "RESIDENCY_CREATE_NOT_ALLOWED");
    assert.equal(result.failure.status, 403);
    assert.equal(result.failure.retryable, false);
  }

  const disabled = createResidencyLifecycleClient(async () => ({
    status: 503, data: { code: "RESIDENCY_ORDERS_DISABLED" }, networkError: false,
  }));
  const stopped = await disabled.createOrder({ mode: "NEW", expectedTotalMinor: 79000, expectedProductId: RESIDENCY_LIFECYCLE_PRODUCT_ID,
    idempotencyKey: "idem-key-0000000001" });
  assert.equal(stopped.ok, false);
  if (!stopped.ok) assert.equal(stopped.failure.retryable, true);
});

test("reconcile is a POST with its own key and an invalid payload is not accepted", async () => {
  let captured: Record<string, unknown> | null = null;
  const client = createResidencyLifecycleClient(async (request) => {
    captured = request as unknown as Record<string, unknown>;
    return { status: 200, data: { schemaVersion: 1, order: order(), idempotentReplay: true, retryable: false, reviewRequired: false }, networkError: false };
  });
  const result = await client.reconcile(ORDER_ID, { idempotencyKey: "idem-key-0000000002", eventId: "evt-1" });
  assert.equal(result.ok, true);
  assert.equal(captured?.path, "/lk/residency/orders/" + ORDER_ID + "/reconcile");
  assert.equal(captured?.method, "POST");
  assert.equal(captured?.idempotencyKey, "idem-key-0000000002");
  assert.deepEqual(captured?.body, { eventId: "evt-1" });

  const invalid = createResidencyLifecycleClient(async () => ({ status: 200, data: { schemaVersion: 1 }, networkError: false }));
  const bad = await invalid.getOrder(ORDER_ID);
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.failure.code, "RESIDENCY_CLIENT_UPSTREAM_INVALID");
});

test("money formatting is stable for the published 790 RUB price", () => {
  assert.equal(formatResidencyMoney(79000), "790 ₽");
});


test("a server-detected external checkout blocks the new screen and wins over the local marker", () => {
  const blocked = resolveResidencyLifecycleDecision({ catalog: parseLifecycleCatalog(catalog)!, status: parseLifecycleStatus(statusNone)!,
    unresolved: null, oldCheckoutPending: false, externalReview: true });
  assert.equal(blocked?.kind, "BLOCKED");
  if (blocked?.kind === "BLOCKED") assert.equal(blocked.code, "EXTERNAL_CHECKOUT_PENDING");
  // An unresolved lifecycle order stays the first recovery target.
  const recovery = resolveResidencyLifecycleDecision({ catalog: parseLifecycleCatalog(catalog)!, status: parseLifecycleStatus(statusNone)!,
    unresolved: parseLifecycleOrder(order())!, oldCheckoutPending: false, externalReview: true });
  assert.equal(recovery?.kind, "RECOVERY");
});

test("the unresolved read carries the server external check and stays backward compatible", async () => {
  const externalCheck = { state: "OK", openCount: 1, paidAfterOrderCount: 0, requiresReview: true, reason: null, retryable: false };
  const detailed = createResidencyLifecycleClient(async () => ({
    status: 200, networkError: false,
    data: { schemaVersion: 1, orders: [order()], count: 1, externalCheck },
  }));
  const read = await detailed.listUnresolvedDetailed();
  assert.equal(read.ok, true);
  if (read.ok) {
    assert.equal(read.value.orders.length, 1);
    assert.equal(read.value.externalCheck?.requiresReview, true);
    assert.equal(read.value.externalCheck?.openCount, 1);
  }
  const legacyList = await detailed.listUnresolved();
  assert.equal(legacyList.ok, true);
  if (legacyList.ok) assert.equal(legacyList.value[0]?.orderId, ORDER_ID);

  const oldServer = createResidencyLifecycleClient(async () => ({
    status: 200, networkError: false, data: { schemaVersion: 1, orders: [], count: 0 },
  }));
  const oldRead = await oldServer.listUnresolvedDetailed();
  assert.equal(oldRead.ok, true);
  if (oldRead.ok) assert.equal(oldRead.value.externalCheck, null);

  const broken = createResidencyLifecycleClient(async () => ({
    status: 200, networkError: false,
    data: { schemaVersion: 1, orders: [], count: 0, externalCheck: { state: "MAYBE" } },
  }));
  const invalid = await broken.listUnresolvedDetailed();
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.failure.code, "RESIDENCY_CLIENT_UPSTREAM_INVALID");
});

test("the external purchase refusal is a non-retryable conflict with its own message", async () => {
  const client = createResidencyLifecycleClient(async () => ({
    status: 409, networkError: false,
    data: { code: "RESIDENCY_EXTERNAL_PURCHASE_PENDING", message: "open legacy checkout" },
  }));
  const result = await client.createOrder({ mode: "NEW", expectedTotalMinor: 79000,
    expectedProductId: RESIDENCY_LIFECYCLE_PRODUCT_ID, idempotencyKey: "idem-key-0000000001" });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.failure.code, "RESIDENCY_EXTERNAL_PURCHASE_PENDING");
    assert.equal(result.failure.retryable, false);
  }
});
