import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  ORDER_STATES,
  RESIDENCY_PRODUCT_ID,
  RESIDENCY_STATES,
  ResidencyLifecycleError,
  createResidencyLifecycle,
} from "../../node-red/custom-nodes/residency-lifecycle-api/lib/residency-lifecycle.mjs";

const TENANT = "iSkq6G";
const USER = "user-1";
const OTHER_USER = "user-2";
const KEY = "idem-key-0000000001";
const KEY2 = "idem-key-0000000002";
const NOW = Date.parse("2026-11-18T09:00:00.000Z");
const PAID_AT = "2026-11-18T09:05:00.000Z";
const VALID_FROM = "2026-11-18T09:05:00.000Z";
const VALID_UNTIL = "2026-12-18T09:05:00.000Z";

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

function memoryStore() {
  const orders = new Map();
  return {
    orders,
    async findOrderByKey(tenantId, keyHash) {
      return [...orders.values()].find((o) => o.tenantId === tenantId && o.idempotencyKeyHash === keyHash) || null;
    },
    async insertOrder(order) {
      const id = order.orderId;
      if (orders.has(id)) return { ok: false };
      if ([...orders.values()].some((o) => o.tenantId === order.tenantId && o.idempotencyKeyHash === order.idempotencyKeyHash)) return { ok: false };
      if (order.activeSlot === 1 && [...orders.values()].some((o) => o.tenantId === order.tenantId && o.userId === order.userId && o.activeSlot === 1)) return { ok: false };
      orders.set(id, structuredClone(order));
      return { ok: true };
    },
    async getOrder(tenantId, userId, orderId) {
      const row = orders.get(orderId);
      if (!row || row.tenantId !== tenantId || row.userId !== userId) return null;
      return structuredClone(row);
    },
    async updateOrder(tenantId, orderId, expectedRevision, next) {
      const row = orders.get(orderId);
      if (!row || row.tenantId !== tenantId || row.revision !== expectedRevision) return { ok: false };
      orders.set(orderId, structuredClone(next));
      return { ok: true };
    },
    async findUnresolvedOrder(tenantId, userId) {
      return [...orders.values()].find((o) => o.tenantId === tenantId && o.userId === userId
        && ["PENDING_PAYMENT", "PAID", "PAID_ACTIVATION_PENDING", "ACTIVATION_FAILED", "PAID_REQUIRES_REVIEW"].includes(o.state)) || null;
    },
    async listUnresolvedOrders(tenantId, userId, limit) {
      return [...orders.values()]
        .filter((o) => o.tenantId === tenantId && o.userId === userId
          && ["PENDING_PAYMENT", "PAID", "PAID_ACTIVATION_PENDING", "ACTIVATION_FAILED", "PAID_REQUIRES_REVIEW"].includes(o.state))
        .sort((left, right) => (left.createdAt < right.createdAt ? 1 : -1))
        .slice(0, limit)
        .map((o) => structuredClone(o));
    },
    async listExpiredPending(tenantId, nowIso) {
      return [...orders.values()].filter((o) => o.tenantId === tenantId && o.state === "PENDING_PAYMENT"
        && o.payment.expiresAt && o.payment.expiresAt <= nowIso).map((o) => structuredClone(o));
    },
  };
}

function build(overrides = {}) {
  let now = NOW;
  const store = overrides.store || memoryStore();
  const calls = { create: 0, read: 0, activate: 0, findInstance: 0, quote: 0, catalog: 0, status: 0 };
  const payments = overrides.payments || {
    async create() {
      calls.create += 1;
      return {
        status: "PENDING",
        providerTransactionId: "txn-1",
        paymentUrl: "https://bank.example/pay/1",
        amountMinor: 79000,
        expiresAt: "2026-11-18T09:20:00.000Z",
      };
    },
    async read() {
      calls.read += 1;
      return { status: "PENDING", amountMinor: 79000, paymentUrl: "https://bank.example/pay/1", expiresAt: "2026-11-18T09:20:00.000Z" };
    },
  };
  const activation = overrides.activation || {
    async findInstance() {
      calls.findInstance += 1;
      return { clientSubscriptionId: "sub-1", status: "ACTIVE" };
    },
    async activate() {
      calls.activate += 1;
      return { state: "ACTIVE", validFrom: VALID_FROM, validUntil: VALID_UNTIL, source: "CUP_RESIDENCY_POLICY", observedAt: PAID_AT };
    },
  };
  const discounts = overrides.discounts || {
    async quote({ baseAmountMinor }) {
      calls.quote += 1;
      return { discountLines: [], totalMinor: baseAmountMinor };
    },
  };
  let statusValue = overrides.statusValue || { state: RESIDENCY_STATES.NONE, source: "CUP", observedAt: PAID_AT };
  const status = overrides.status || {
    async read() {
      calls.status += 1;
      return statusValue;
    },
  };
  const catalog = overrides.catalog || {
    async read() {
      calls.catalog += 1;
      return {
        productId: RESIDENCY_PRODUCT_ID,
        title: "Резидентство ПадлхАБ",
        termDays: 30,
        priceMinor: 79000,
        currency: "RUB",
        benefits: [{ code: "GAME", percent: 30 }, { code: "GROUP_TRAINING", percent: 50 }],
        renewalEligible: statusValue.state === RESIDENCY_STATES.ACTIVE,
        checkedAt: "2026-11-18T08:59:00.000Z",
      };
    },
  };
  let orderSeq = 0;
  const lifecycle = createResidencyLifecycle({
    clock: { now: () => now },
    ids: {
      orderId: (tenantId, keyHash) => "00000000-0000-4000-8000-" + sha256(tenantId + keyHash).slice(0, 12),
      eventId: () => "event-" + (++orderSeq),
    },
    sha256,
    store,
    catalog,
    payments,
    activation,
    discounts,
    status,
  });
  return {
    lifecycle, store, calls,
    setNow(value) { now = value; },
    setStatus(value) { statusValue = value; },
  };
}

async function expectCode(promise, statusCode, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof ResidencyLifecycleError, String(error));
    assert.equal(error.statusCode, statusCode);
    assert.equal(error.code, code);
    return true;
  });
}

test("catalog returns the exact product and its published benefits", async () => {
  const { lifecycle, calls } = build();
  const result = await lifecycle.catalog();
  assert.equal(calls.catalog, 1);
  assert.equal(result.product.productId, RESIDENCY_PRODUCT_ID);
  assert.equal(result.product.priceMinor, 79000);
  assert.equal(result.product.termDays, 30);
  assert.equal(result.product.currency, "RUB");
  assert.deepEqual(result.product.benefits, [{ code: "GAME", percent: 30 }, { code: "GROUP_TRAINING", percent: 50 }]);
});

test("successful checkout creates one pending order and activates only after a paid read", async () => {
  const { lifecycle, store, calls } = build();
  const created = await lifecycle.createOrder({ expectedTotalMinor: 79000, tenantId: TENANT, userId: USER, idempotencyKey: KEY, mode: "NEW" });
  assert.equal(created.order.state, ORDER_STATES.PENDING_PAYMENT);
  assert.equal(created.order.payment.status, "PENDING");
  assert.equal(created.order.payment.paymentUrl, "https://bank.example/pay/1");
  assert.equal(created.order.pricing.totalMinor, 79000);
  assert.equal(calls.create, 1);
  assert.equal(calls.activate, 0);

  // The bank has not confirmed yet: a reconcile of PENDING must not activate.
  const pending = await lifecycle.reconcile({ tenantId: TENANT, userId: USER, orderId: created.order.orderId, idempotencyKey: KEY2, eventId: "evt-pending" });
  assert.equal(pending.order.state, ORDER_STATES.PENDING_PAYMENT);
  assert.equal(calls.activate, 0);

  // Payment confirmation is read from the provider; activation is confirmed by CUP.
  const payments = {
    async create() { throw new Error("must not create"); },
    async read() {
      return { status: "PAID", amountMinor: 79000, paidAt: PAID_AT, providerTransactionId: "txn-1" };
    },
  };
  const second = build({ store, payments });
  const paid = await second.lifecycle.reconcile({ tenantId: TENANT, userId: USER, orderId: created.order.orderId, idempotencyKey: KEY2, eventId: "evt-paid" });
  assert.equal(paid.order.state, ORDER_STATES.ACTIVE);
  assert.equal(paid.order.residency.state, RESIDENCY_STATES.ACTIVE);
  assert.equal(paid.order.residency.validFrom, VALID_FROM);
  assert.equal(paid.order.residency.validUntil, VALID_UNTIL);
  assert.equal(second.calls.activate, 1);
  assert.equal(store.orders.size, 1);
});

test("failed payment is terminal and never activates", async () => {
  const payments = {
    async create() { throw new Error("must not create"); },
    async read() { return { status: "FAILED", amountMinor: 79000, providerTransactionId: "txn-1" }; },
  };
  const creator = build();
  const created = await creator.lifecycle.createOrder({ expectedTotalMinor: 79000, tenantId: TENANT, userId: USER, idempotencyKey: KEY, mode: "NEW" });
  const { lifecycle, calls } = build({ store: creator.store, payments });
  const result = await lifecycle.reconcile({ tenantId: TENANT, userId: USER, orderId: created.order.orderId, idempotencyKey: KEY2, eventId: "evt-failed" });
  assert.equal(result.order.state, ORDER_STATES.PAYMENT_FAILED);
  assert.equal(result.order.payment.status, "FAILED");
  assert.equal(calls.activate, 0);
});

test("a live payment past the local window stays payable and a late PAID is recovered", async () => {
  const payments = {
    async create() { throw new Error("must not create"); },
    async read() { return { status: "PAID", amountMinor: 79000, paidAt: PAID_AT, providerTransactionId: "txn-1" }; },
  };
  const creator = build();
  const created = await creator.lifecycle.createOrder({ expectedTotalMinor: 79000, tenantId: TENANT, userId: USER, idempotencyKey: KEY, mode: "NEW" });
  creator.setNow(Date.parse("2026-11-18T10:00:00.000Z"));
  // The default provider still reports PENDING: the order must not expire.
  const stillPending = await creator.lifecycle.getOrder({ tenantId: TENANT, userId: USER, orderId: created.order.orderId });
  assert.equal(stillPending.order.state, ORDER_STATES.PENDING_PAYMENT);
  assert.equal(stillPending.order.payment.status, "PENDING");
  assert.equal(stillPending.order.payment.overdue, true);
  assert.equal(stillPending.order.recovery.state, "AWAITING_CONFIRMATION");

  const lateLifecycle = build({ store: creator.store, payments });
  lateLifecycle.setNow(Date.parse("2026-11-18T10:00:00.000Z"));
  const late = await lateLifecycle.lifecycle.reconcile({ tenantId: TENANT, userId: USER, orderId: created.order.orderId, idempotencyKey: KEY2, eventId: "evt-late" });
  assert.equal(late.order.state, ORDER_STATES.ACTIVE);
  assert.equal(lateLifecycle.calls.activate, 1);
  assert.equal(late.order.residency.validUntil, VALID_UNTIL);
});

test("a legacy EXPIRED row is still recovered by a late PAID read", async () => {
  const creator = build();
  const created = await creator.lifecycle.createOrder({ expectedTotalMinor: 79000, tenantId: TENANT, userId: USER, idempotencyKey: KEY, mode: "NEW" });
  const row = creator.store.orders.get(created.order.orderId);
  row.state = ORDER_STATES.EXPIRED;
  row.activeSlot = null;
  creator.store.orders.set(created.order.orderId, row);
  const lateLifecycle = build({ store: creator.store, payments: {
    async create() { throw new Error("must not create"); },
    async read() { return { status: "PAID", amountMinor: 79000, paidAt: PAID_AT, providerTransactionId: "txn-1" }; },
  } });
  const late = await lateLifecycle.lifecycle.reconcile({ tenantId: TENANT, userId: USER, orderId: created.order.orderId, idempotencyKey: KEY2, eventId: "evt-late-expired" });
  assert.equal(late.order.state, ORDER_STATES.ACTIVE);
  assert.equal(lateLifecycle.calls.activate, 1);
});

test("duplicate callback is idempotent and does not activate twice", async () => {
  const payments = {
    async create() { throw new Error("must not create"); },
    async read() { return { status: "PAID", amountMinor: 79000, paidAt: PAID_AT, providerTransactionId: "txn-1" }; },
  };
  const creator = build();
  const created = await creator.lifecycle.createOrder({ expectedTotalMinor: 79000, tenantId: TENANT, userId: USER, idempotencyKey: KEY, mode: "NEW" });
  const { lifecycle, calls } = build({ store: creator.store, payments });
  const first = await lifecycle.reconcile({ tenantId: TENANT, userId: USER, orderId: created.order.orderId, idempotencyKey: KEY2, eventId: "evt-same" });
  assert.equal(first.order.state, ORDER_STATES.ACTIVE);
  assert.equal(first.idempotentReplay, false);
  const second = await lifecycle.reconcile({ tenantId: TENANT, userId: USER, orderId: created.order.orderId, idempotencyKey: KEY2, eventId: "evt-same" });
  assert.equal(second.order.state, ORDER_STATES.ACTIVE);
  assert.equal(second.idempotentReplay, true);
  assert.equal(calls.activate, 1);
});

test("repeat checkout with the same key returns the same order and one payment", async () => {
  const { lifecycle, calls, store } = build();
  const first = await lifecycle.createOrder({ expectedTotalMinor: 79000, tenantId: TENANT, userId: USER, idempotencyKey: KEY, mode: "NEW" });
  const second = await lifecycle.createOrder({ expectedTotalMinor: 79000, tenantId: TENANT, userId: USER, idempotencyKey: KEY, mode: "NEW" });
  assert.equal(second.idempotentReplay, true);
  assert.equal(second.order.orderId, first.order.orderId);
  assert.equal(calls.create, 1);
  assert.equal(store.orders.size, 1);
  await expectCode(lifecycle.createOrder({ expectedTotalMinor: 79000, tenantId: TENANT, userId: USER, idempotencyKey: KEY, mode: "RENEWAL" }), 409, "RESIDENCY_IDEMPOTENCY_CONFLICT");
});

test("a second unresolved order is refused before a second provider create", async () => {
  const { lifecycle, calls } = build();
  await lifecycle.createOrder({ expectedTotalMinor: 79000, tenantId: TENANT, userId: USER, idempotencyKey: KEY, mode: "NEW" });
  await expectCode(lifecycle.createOrder({ expectedTotalMinor: 79000, tenantId: TENANT, userId: USER, idempotencyKey: KEY2, mode: "NEW" }), 409, "RESIDENCY_ORDER_ALREADY_PENDING");
  assert.equal(calls.create, 1);
});

test("renewal of an active residency is allowed once its window has ended", async () => {
  const { lifecycle, store } = build();
  const first = await lifecycle.createOrder({ expectedTotalMinor: 79000, tenantId: TENANT, userId: USER, idempotencyKey: KEY, mode: "NEW" });
  // Confirm + activate the first order.
  const payments = {
    async create() { return { status: "PENDING", providerTransactionId: "txn-2", paymentUrl: "https://bank.example/pay/2",
      amountMinor: 79000, expiresAt: "2026-11-18T09:20:00.000Z" }; },
    async read() { return { status: "PAID", amountMinor: 79000, paidAt: PAID_AT, providerTransactionId: "txn-1" }; },
  };
  const activation = {
    async findInstance() { return { clientSubscriptionId: "sub-1" }; },
    async activate() { return { state: "ACTIVE", validFrom: VALID_FROM, validUntil: VALID_UNTIL, source: "CUP", observedAt: PAID_AT }; },
  };
  const active = build({ store, payments, activation, statusValue: { state: RESIDENCY_STATES.ACTIVE, validFrom: VALID_FROM, validUntil: VALID_UNTIL, source: "CUP", observedAt: PAID_AT } });
  await active.lifecycle.reconcile({ tenantId: TENANT, userId: USER, orderId: first.order.orderId, idempotencyKey: KEY2, eventId: "evt-paid" });
  active.setNow(Date.parse(VALID_UNTIL));
  const renewed = await active.lifecycle.createOrder({ expectedTotalMinor: 79000, tenantId: TENANT, userId: USER, idempotencyKey: KEY2 + "x", mode: "RENEWAL" });
  assert.equal(renewed.order.mode, "RENEWAL");
  assert.equal(renewed.order.state, ORDER_STATES.PENDING_PAYMENT);
  assert.equal(store.orders.size, 2);
  // The existing active order is untouched.
  assert.equal(store.orders.get(first.order.orderId).state, ORDER_STATES.ACTIVE);
});

test("renewal without an active residency is refused and NEW while active is refused", async () => {
  const none = build();
  await expectCode(none.lifecycle.createOrder({ expectedTotalMinor: 79000, tenantId: TENANT, userId: USER, idempotencyKey: KEY, mode: "RENEWAL" }), 409, "RESIDENCY_RENEWAL_NOT_ELIGIBLE");
  const active = build({ statusValue: { state: RESIDENCY_STATES.ACTIVE, validFrom: VALID_FROM, validUntil: VALID_UNTIL, source: "CUP", observedAt: PAID_AT } });
  await expectCode(active.lifecycle.createOrder({ expectedTotalMinor: 79000, tenantId: TENANT, userId: USER, idempotencyKey: KEY, mode: "NEW" }), 409, "RESIDENCY_RENEWAL_REQUIRED");
});

test("the end of the local window does not free the slot while the provider still reports PENDING", async () => {
  const { lifecycle, setNow, calls, store } = build();
  const created = await lifecycle.createOrder({ expectedTotalMinor: 79000, tenantId: TENANT, userId: USER, idempotencyKey: KEY, mode: "NEW" });
  setNow(Date.parse("2026-11-18T09:25:00.000Z"));
  const result = await lifecycle.getOrder({ tenantId: TENANT, userId: USER, orderId: created.order.orderId });
  assert.equal(result.order.state, ORDER_STATES.PENDING_PAYMENT);
  assert.equal(result.order.payment.status, "PENDING");
  assert.equal(result.order.payment.overdue, true);
  assert.equal(result.order.recovery.required, true);
  assert.equal(calls.activate, 0);
  // A new key cannot start a second checkout while the first one may still be payable.
  await expectCode(lifecycle.createOrder({ expectedTotalMinor: 79000, tenantId: TENANT, userId: USER, idempotencyKey: KEY2, mode: "NEW" }),
    409, "RESIDENCY_ORDER_ALREADY_PENDING");
  assert.equal(calls.create, 1);
  assert.equal(store.orders.size, 1);
});

test("no discount is applied when the CUP entitlement is absent", async () => {
  const { lifecycle } = build();
  const created = await lifecycle.createOrder({ expectedTotalMinor: 79000, tenantId: TENANT, userId: USER, idempotencyKey: KEY, mode: "NEW" });
  assert.deepEqual(created.order.pricing.discountLines, []);
  assert.equal(created.order.pricing.totalMinor, 79000);
});

test("a CUP-confirmed discount is applied exactly once and changes the provider amount", async () => {
  const discounts = {
    async quote({ baseAmountMinor, residencyState }) {
      if (residencyState !== RESIDENCY_STATES.ACTIVE) return { discountLines: [], totalMinor: baseAmountMinor };
      return { discountLines: [{ code: "resident-renewal", title: "Скидка резидента", amountMinor: 7900, source: "CUP_PUBLICATION" }], totalMinor: baseAmountMinor - 7900 };
    },
  };
  const payments = {
    async create() {
      return { status: "PENDING", providerTransactionId: "txn-2", paymentUrl: "https://bank.example/pay/2", amountMinor: 71100, expiresAt: "2026-11-18T09:20:00.000Z" };
    },
    async read() { throw new Error("unused"); },
  };
  const built = build({
    discounts, payments,
    statusValue: { state: RESIDENCY_STATES.ACTIVE, validFrom: VALID_FROM, validUntil: VALID_UNTIL, source: "CUP", observedAt: PAID_AT },
  });
  built.setNow(Date.parse(VALID_UNTIL));
  // Consent is the exact displayed total. A discount learned only at quote time must be
  // shown to the user and confirmed, not applied silently under a higher consent.
  await expectCode(
    built.lifecycle.createOrder({ expectedTotalMinor: 79000, tenantId: TENANT, userId: USER, idempotencyKey: KEY, mode: "RENEWAL" }),
    409,
    "RESIDENCY_PRICE_CHANGED",
  );
  const created = await built.lifecycle.createOrder({ expectedTotalMinor: 71100, tenantId: TENANT, userId: USER, idempotencyKey: KEY, mode: "RENEWAL" });
  assert.deepEqual(created.order.pricing.discountLines.map((line) => line.code), ["resident-renewal"]);
  assert.equal(created.order.pricing.totalMinor, 71100);
});

test("an invalid discount that exceeds the base amount fails closed", async () => {
  const discounts = { async quote() { return { discountLines: [{ code: "bad", amountMinor: 80000 }], totalMinor: -1000 }; } };
  const { lifecycle, calls } = build({ discounts });
  await expectCode(lifecycle.createOrder({ expectedTotalMinor: 79000, tenantId: TENANT, userId: USER, idempotencyKey: KEY, mode: "NEW" }), 503, "RESIDENCY_PRICING_INVALID");
  assert.equal(calls.create, 0);
});

test("an unknown create outcome keeps the attempt unresolved and blocks a new key", async () => {
  let createCalls = 0;
  const payments = {
    async create() {
      createCalls += 1;
      throw new Error("socket hang up");
    },
    async read() { return { status: "UNKNOWN" }; },
  };
  const { lifecycle, store } = build({ payments });
  const first = await lifecycle.createOrder({ expectedTotalMinor: 79000, tenantId: TENANT, userId: USER, idempotencyKey: KEY, mode: "NEW" });
  assert.equal(first.recoveryRequired, true);
  assert.equal(first.order.state, ORDER_STATES.PENDING_PAYMENT);
  assert.equal(first.order.terminal, false);
  assert.equal(first.order.payment.status, "UNKNOWN");
  assert.equal(first.order.payment.paymentUrl, null);
  assert.equal(first.order.recovery.state, "UNKNOWN_OUTCOME");
  assert.equal(first.order.recovery.required, true);
  assert.equal(store.orders.get(first.order.orderId).activeSlot, 1);
  assert.equal(createCalls, 1);
  const replay = await lifecycle.createOrder({ expectedTotalMinor: 79000, tenantId: TENANT, userId: USER, idempotencyKey: KEY, mode: "NEW" });
  assert.equal(replay.idempotentReplay, true);
  assert.equal(createCalls, 1);
  // A new key is not a way around the unresolved operation.
  await expectCode(lifecycle.createOrder({ expectedTotalMinor: 79000, tenantId: TENANT, userId: USER, idempotencyKey: KEY2, mode: "NEW" }),
    409, "RESIDENCY_ORDER_ALREADY_PENDING");
  assert.equal(createCalls, 1);
});

test("an explicit provider rejection is a confirmed basis for a terminal failure", async () => {
  let createCalls = 0;
  const payments = {
    async create() {
      createCalls += 1;
      if (createCalls === 1) throw Object.assign(new Error("VALIDATION"), { code: "VALIDATION", outcome: "REJECTED" });
      return { status: "PENDING", providerTransactionId: "txn-2", paymentUrl: "https://bank.example/pay/2",
        amountMinor: 79000, expiresAt: "2026-11-18T09:20:00.000Z" };
    },
    async read() { throw new Error("unused"); },
  };
  const { lifecycle, store } = build({ payments });
  const failed = await lifecycle.createOrder({ expectedTotalMinor: 79000, tenantId: TENANT, userId: USER, idempotencyKey: KEY, mode: "NEW" });
  assert.equal(failed.order.state, ORDER_STATES.PAYMENT_FAILED);
  assert.equal(failed.order.terminal, true);
  assert.equal(failed.order.terminalReason, "VALIDATION");
  assert.equal(store.orders.get(failed.order.orderId).activeSlot, null);
  const replacement = await lifecycle.createOrder({ expectedTotalMinor: 79000, tenantId: TENANT, userId: USER, idempotencyKey: KEY2, mode: "NEW" });
  assert.equal(replacement.order.state, ORDER_STATES.PENDING_PAYMENT);
  assert.equal(createCalls, 2);
  assert.notEqual(replacement.order.orderId, failed.order.orderId);
});

test("CUP activation failure keeps the order PAID_ACTIVATION_PENDING and recovers on the next reconcile", async () => {
  let activateCalls = 0;
  const activation = {
    async findInstance() { return { clientSubscriptionId: "sub-1" }; },
    async activate() {
      activateCalls += 1;
      if (activateCalls === 1) throw new Error("CUP timeout");
      return { state: "ACTIVE", validFrom: VALID_FROM, validUntil: VALID_UNTIL, source: "CUP", observedAt: PAID_AT };
    },
  };
  const payments = {
    async create() { throw new Error("must not create"); },
    async read() { return { status: "PAID", amountMinor: 79000, paidAt: PAID_AT, providerTransactionId: "txn-1" }; },
  };
  const creator = build();
  const created = await creator.lifecycle.createOrder({ expectedTotalMinor: 79000, tenantId: TENANT, userId: USER, idempotencyKey: KEY, mode: "NEW" });
  const { lifecycle } = build({ store: creator.store, payments, activation });
  const first = await lifecycle.reconcile({ tenantId: TENANT, userId: USER, orderId: created.order.orderId, idempotencyKey: KEY2, eventId: "evt-1" });
  assert.equal(first.order.state, ORDER_STATES.ACTIVATION_PENDING);
  assert.equal(first.order.activation.lastErrorCode, "ACTIVATION_UNAVAILABLE");
  const second = await lifecycle.reconcile({ tenantId: TENANT, userId: USER, orderId: created.order.orderId, idempotencyKey: KEY2, eventId: "evt-2" });
  assert.equal(second.order.state, ORDER_STATES.ACTIVE);
  assert.equal(activateCalls, 2);
});

test("a cancelled order never activates a late payment and is flagged for review", async () => {
  const payments = {
    async create() { throw new Error("must not create"); },
    async read() { return { status: "PAID", amountMinor: 79000, paidAt: PAID_AT, providerTransactionId: "txn-1" }; },
  };
  const creator = build();
  const created = await creator.lifecycle.createOrder({ expectedTotalMinor: 79000, tenantId: TENANT, userId: USER, idempotencyKey: KEY, mode: "NEW" });
  const failedLifecycle = build({ store: creator.store, payments: {
    async create() { throw new Error("must not create"); },
    async read() { return { status: "FAILED", amountMinor: 79000, providerTransactionId: "txn-1" }; },
  } });
  const failed = await failedLifecycle.lifecycle.reconcile({ tenantId: TENANT, userId: USER, orderId: created.order.orderId, idempotencyKey: KEY2, eventId: "evt-failed" });
  assert.equal(failed.order.state, ORDER_STATES.PAYMENT_FAILED);
  const cancelled = await failedLifecycle.lifecycle.cancel({ tenantId: TENANT, userId: USER, orderId: created.order.orderId, idempotencyKey: KEY2 });
  assert.equal(cancelled.order.state, ORDER_STATES.CANCELLED);
  const lateLifecycle = build({ store: creator.store, payments });
  const late = await lateLifecycle.lifecycle.reconcile({ tenantId: TENANT, userId: USER, orderId: created.order.orderId, idempotencyKey: KEY2, eventId: "evt-late" });
  assert.equal(late.order.state, ORDER_STATES.CANCELLED);
  assert.equal(late.reviewRequired, true);
  assert.equal(lateLifecycle.calls.activate, 0);
});

test("amount mismatch on a paid read is held for review and never activated", async () => {
  const payments = {
    async create() { throw new Error("must not create"); },
    async read() { return { status: "PAID", amountMinor: 1, paidAt: PAID_AT, providerTransactionId: "txn-1" }; },
  };
  const creator = build();
  const created = await creator.lifecycle.createOrder({ expectedTotalMinor: 79000, tenantId: TENANT, userId: USER, idempotencyKey: KEY, mode: "NEW" });
  const { lifecycle, calls } = build({ store: creator.store, payments });
  const result = await lifecycle.reconcile({ tenantId: TENANT, userId: USER, orderId: created.order.orderId, idempotencyKey: KEY2, eventId: "evt-mismatch" });
  assert.equal(result.order.state, ORDER_STATES.PAID_REQUIRES_REVIEW);
  assert.equal(result.order.activation.lastErrorCode, "AMOUNT_MISMATCH");
  assert.equal(calls.activate, 0);
});

test("residency status UNAVAILABLE fails closed instead of offering a purchase", async () => {
  const { lifecycle, calls } = build({ statusValue: { state: RESIDENCY_STATES.UNAVAILABLE, reason: "SOURCE_TIMEOUT" } });
  const status = await lifecycle.status({ tenantId: TENANT, userId: USER });
  assert.equal(status.state, RESIDENCY_STATES.UNAVAILABLE);
  assert.equal(status.reason, "SOURCE_TIMEOUT");
  await expectCode(lifecycle.createOrder({ expectedTotalMinor: 79000, tenantId: TENANT, userId: USER, idempotencyKey: KEY, mode: "NEW" }), 503, "RESIDENCY_STATUS_UNAVAILABLE");
  await expectCode(lifecycle.createOrder({ expectedTotalMinor: 79000, tenantId: TENANT, userId: USER, idempotencyKey: KEY, mode: "RENEWAL" }), 503, "RESIDENCY_STATUS_UNAVAILABLE");
  assert.equal(calls.create, 0);
});

test("expired residency is reported as EXPIRED with its window", async () => {
  const { lifecycle } = build({ statusValue: { state: RESIDENCY_STATES.EXPIRED, validFrom: "2026-10-01T00:00:00.000Z", validUntil: "2026-10-31T00:00:00.000Z", source: "CUP", observedAt: PAID_AT } });
  const status = await lifecycle.status({ tenantId: TENANT, userId: USER });
  assert.equal(status.state, RESIDENCY_STATES.EXPIRED);
  assert.equal(status.validUntil, "2026-10-31T00:00:00.000Z");
});

test("one user cannot read another user's order", async () => {
  const { lifecycle } = build();
  const created = await lifecycle.createOrder({ expectedTotalMinor: 79000, tenantId: TENANT, userId: USER, idempotencyKey: KEY, mode: "NEW" });
  await expectCode(lifecycle.getOrder({ tenantId: TENANT, userId: OTHER_USER, orderId: created.order.orderId }), 404, "RESIDENCY_ORDER_NOT_FOUND");
});

test("a create that is immediately PAID activates before the response", async () => {
  const payments = {
    async create() {
      return { status: "PAID", providerTransactionId: "txn-1", paymentUrl: null, amountMinor: 79000, paidAt: PAID_AT };
    },
    async read() { throw new Error("unused"); },
  };
  const { lifecycle, calls } = build({ payments });
  const created = await lifecycle.createOrder({ expectedTotalMinor: 79000, tenantId: TENANT, userId: USER, idempotencyKey: KEY, mode: "NEW" });
  assert.equal(created.order.state, ORDER_STATES.ACTIVE);
  assert.equal(created.order.residency.state, RESIDENCY_STATES.ACTIVE);
  assert.equal(calls.activate, 1);
});

test("cancelling a pending order checks the original transaction first", async () => {
  const creator = build();
  const created = await creator.lifecycle.createOrder({ expectedTotalMinor: 79000, tenantId: TENANT, userId: USER, idempotencyKey: KEY, mode: "NEW" });
  const paidLifecycle = build({ store: creator.store, payments: {
    async create() { throw new Error("must not create"); },
    async read() { return { status: "PAID", amountMinor: 79000, paidAt: PAID_AT, providerTransactionId: "txn-1" }; },
  } });
  await expectCode(paidLifecycle.lifecycle.cancel({ tenantId: TENANT, userId: USER, orderId: created.order.orderId, idempotencyKey: KEY2 }), 409, "RESIDENCY_ORDER_PAID");
  assert.equal(creator.store.orders.get(created.order.orderId).state, ORDER_STATES.PENDING_PAYMENT);

  const unavailable = build({ store: creator.store, payments: {
    async create() { throw new Error("must not create"); },
    async read() { throw new Error("provider down"); },
  } });
  await expectCode(unavailable.lifecycle.cancel({ tenantId: TENANT, userId: USER, orderId: created.order.orderId, idempotencyKey: KEY2 }), 503, "RESIDENCY_PAYMENT_STATUS_UNAVAILABLE");
  assert.equal(creator.store.orders.get(created.order.orderId).state, ORDER_STATES.PENDING_PAYMENT);

  const pending = build({ store: creator.store });
  await expectCode(pending.lifecycle.cancel({ tenantId: TENANT, userId: USER, orderId: created.order.orderId, idempotencyKey: KEY2 }), 409, "RESIDENCY_PAYMENT_STATUS_UNKNOWN");
  assert.equal(creator.store.orders.get(created.order.orderId).state, ORDER_STATES.PENDING_PAYMENT);
});

test("the durable attempt exists before the Viva POST and no second order can start", async () => {
  let observed = null;
  let createCalls = 0;
  const creator = build();
  const payments = {
    async create() {
      createCalls += 1;
      observed = [...creator.store.orders.values()][0];
      return { status: "PENDING", providerTransactionId: "txn-1", paymentUrl: "https://bank.example/pay/1",
        amountMinor: 79000, expiresAt: "2026-11-18T09:20:00.000Z" };
    },
    async read() { throw new Error("unused"); },
  };
  const second = build({ store: creator.store, payments });
  await second.lifecycle.createOrder({ expectedTotalMinor: 79000, tenantId: TENANT, userId: USER, idempotencyKey: KEY, mode: "NEW" });
  assert.ok(observed, "the order must be durable before POST");
  assert.equal(observed.payment.status, "DISPATCHING");
  assert.equal(observed.activeSlot, 1);
  await expectCode(second.lifecycle.createOrder({ expectedTotalMinor: 79000, tenantId: TENANT, userId: USER, idempotencyKey: KEY2, mode: "NEW" }), 409, "RESIDENCY_ORDER_ALREADY_PENDING");
  assert.equal(createCalls, 1);
});

test("public order never exposes the Viva transaction id", async () => {
  const { lifecycle } = build();
  const created = await lifecycle.createOrder({ expectedTotalMinor: 79000, tenantId: TENANT, userId: USER, idempotencyKey: KEY, mode: "NEW" });
  assert.equal("providerTransactionId" in created.order.payment, false);
  assert.equal(created.order.payment.paymentUrl, "https://bank.example/pay/1");
});

test("a confirmed terminal provider read closes the order and frees the slot", async () => {
  const creator = build();
  const created = await creator.lifecycle.createOrder({ expectedTotalMinor: 79000, tenantId: TENANT, userId: USER, idempotencyKey: KEY, mode: "NEW" });
  creator.setNow(Date.parse("2026-11-18T09:20:00.000Z"));
  const closed = build({ store: creator.store, payments: {
    async create() { throw new Error("must not create"); },
    async read() { return { status: "FAILED", amountMinor: 79000, providerTransactionId: "txn-1" }; },
  } });
  closed.setNow(Date.parse("2026-11-18T09:20:00.000Z"));
  const order = await closed.lifecycle.getOrder({ tenantId: TENANT, userId: USER, orderId: created.order.orderId });
  assert.equal(order.order.state, ORDER_STATES.PAYMENT_FAILED);
  assert.equal(order.order.terminal, true);
  assert.equal(order.order.payment.paymentUrl, null);
  const payment = await closed.lifecycle.getPayment({ tenantId: TENANT, userId: USER, orderId: created.order.orderId });
  assert.equal(payment.paymentUrl, null);
  assert.equal(payment.terminal, true);
  assert.equal(creator.store.orders.get(created.order.orderId).activeSlot, null);
});

test("a paid order is never downgraded by a later PENDING read", async () => {
  const paidPayments = { async create() { throw new Error("must not create"); },
    async read() { return { status: "PAID", amountMinor: 79000, paidAt: PAID_AT, providerTransactionId: "txn-1" }; } };
  const failedActivation = { async findInstance() { return { clientSubscriptionId: "sub-1", purchasedAt: PAID_AT }; },
    async activate() { throw new Error("CUP down"); } };
  const creator = build();
  const created = await creator.lifecycle.createOrder({ expectedTotalMinor: 79000, tenantId: TENANT, userId: USER, idempotencyKey: KEY, mode: "NEW" });
  const paidLifecycle = build({ store: creator.store, payments: paidPayments, activation: failedActivation });
  const paid = await paidLifecycle.lifecycle.reconcile({ tenantId: TENANT, userId: USER, orderId: created.order.orderId, idempotencyKey: KEY2, eventId: "evt-paid" });
  assert.equal(paid.order.state, ORDER_STATES.ACTIVATION_PENDING);
  assert.equal(paid.order.payment.status, "PAID");

  const pendingLifecycle = build({ store: creator.store, payments: {
    async create() { throw new Error("must not create"); },
    async read() { return { status: "PENDING", amountMinor: 79000, paymentUrl: "https://bank.example/again", expiresAt: "2026-11-18T09:20:00.000Z" }; },
  } });
  const after = await pendingLifecycle.lifecycle.reconcile({ tenantId: TENANT, userId: USER, orderId: created.order.orderId, idempotencyKey: KEY2, eventId: "evt-pending" });
  assert.equal(after.order.state, ORDER_STATES.ACTIVATION_PENDING);
  assert.equal(after.order.payment.status, "PAID");
  assert.equal(after.order.payment.paymentUrl, null);
});

test("a paid order with a later FAILED read goes to review, not to PAYMENT_FAILED", async () => {
  const payments = { async create() { throw new Error("must not create"); },
    async read() { return { status: "PAID", amountMinor: 79000, paidAt: PAID_AT, providerTransactionId: "txn-1" }; } };
  const activation = { async findInstance() { return { clientSubscriptionId: "sub-1", purchasedAt: PAID_AT }; },
    async activate() { throw new Error("CUP down"); } };
  const creator = build();
  const created = await creator.lifecycle.createOrder({ expectedTotalMinor: 79000, tenantId: TENANT, userId: USER, idempotencyKey: KEY, mode: "NEW" });
  const paidLifecycle = build({ store: creator.store, payments, activation });
  await paidLifecycle.lifecycle.reconcile({ tenantId: TENANT, userId: USER, orderId: created.order.orderId, idempotencyKey: KEY2, eventId: "evt-paid" });
  const failedLifecycle = build({ store: creator.store, payments: {
    async create() { throw new Error("must not create"); },
    async read() { return { status: "FAILED", amountMinor: 79000, providerTransactionId: "txn-1" }; },
  } });
  const result = await failedLifecycle.lifecycle.reconcile({ tenantId: TENANT, userId: USER, orderId: created.order.orderId, idempotencyKey: KEY2, eventId: "evt-failed" });
  assert.equal(result.order.state, ORDER_STATES.PAID_REQUIRES_REVIEW);
  assert.equal(result.order.activation.lastErrorCode, "PAYMENT_CONTRADICTION");
});

test("a failed payment that later reads PAID is held for review, not activated", async () => {
  const creator = build();
  const created = await creator.lifecycle.createOrder({ expectedTotalMinor: 79000, tenantId: TENANT, userId: USER, idempotencyKey: KEY, mode: "NEW" });
  const failed = build({ store: creator.store, payments: {
    async create() { throw new Error("must not create"); },
    async read() { return { status: "FAILED", amountMinor: 79000, providerTransactionId: "txn-1" }; },
  } });
  await failed.lifecycle.reconcile({ tenantId: TENANT, userId: USER, orderId: created.order.orderId, idempotencyKey: KEY2, eventId: "evt-failed" });
  const paid = build({ store: creator.store, payments: {
    async create() { throw new Error("must not create"); },
    async read() { return { status: "PAID", amountMinor: 79000, paidAt: PAID_AT, providerTransactionId: "txn-1" }; },
  } });
  const result = await paid.lifecycle.reconcile({ tenantId: TENANT, userId: USER, orderId: created.order.orderId, idempotencyKey: KEY2, eventId: "evt-paid" });
  assert.equal(result.order.state, ORDER_STATES.PAID_REQUIRES_REVIEW);
  assert.equal(result.order.activation.lastErrorCode, "PAYMENT_AFTER_FAILURE");
  assert.equal(paid.calls.activate, 0);
});

test("a renewal cannot bind an instance purchased before the order", async () => {
  const creator = build({ statusValue: { state: RESIDENCY_STATES.ACTIVE, validFrom: VALID_FROM, validUntil: VALID_UNTIL, source: "CUP", observedAt: PAID_AT } });
  creator.setNow(Date.parse(VALID_UNTIL));
  const renewed = await creator.lifecycle.createOrder({ expectedTotalMinor: 79000, tenantId: TENANT, userId: USER, idempotencyKey: KEY, mode: "RENEWAL" });
  const payments = { async create() { throw new Error("must not create"); },
    async read() { return { status: "PAID", amountMinor: 79000, paidAt: PAID_AT, providerTransactionId: "txn-1" }; } };
  const activation = { async findInstance() { return { clientSubscriptionId: "sub-old", purchasedAt: "2026-11-01T00:00:00.000Z" }; },
    async activate() { throw new Error("must not activate an old instance"); } };
  const lifecycle = build({ store: creator.store, payments, activation, statusValue: { state: RESIDENCY_STATES.ACTIVE, validFrom: VALID_FROM, validUntil: VALID_UNTIL, source: "CUP", observedAt: PAID_AT } });
  const result = await lifecycle.lifecycle.reconcile({ tenantId: TENANT, userId: USER, orderId: renewed.order.orderId, idempotencyKey: KEY2, eventId: "evt-renew" });
  assert.equal(result.order.state, ORDER_STATES.ACTIVATION_PENDING);
  assert.equal(result.order.activation.lastErrorCode, "INSTANCE_BEFORE_ORDER");
  assert.equal(lifecycle.calls.activate, 0);
});

test("a provider window that contradicts the pinned term is an activation anomaly", async () => {
  const creator = build({ statusValue: { state: RESIDENCY_STATES.ACTIVE, validFrom: VALID_FROM, validUntil: VALID_UNTIL, source: "CUP", observedAt: PAID_AT } });
  creator.setNow(Date.parse(VALID_UNTIL));
  const renewed = await creator.lifecycle.createOrder({ expectedTotalMinor: 79000, tenantId: TENANT, userId: USER, idempotencyKey: KEY, mode: "RENEWAL" });
  const payments = { async create() { throw new Error("must not create"); },
    async read() { return { status: "PAID", amountMinor: 79000, paidAt: VALID_UNTIL, providerTransactionId: "txn-1" }; } };
  const activation = { async findInstance() { return { clientSubscriptionId: "sub-new", purchasedAt: VALID_UNTIL }; },
    async activate() { return { state: "ACTIVE", validFrom: VALID_UNTIL,
      validUntil: new Date(Date.parse(VALID_UNTIL) + 13 * 86400000).toISOString(), source: "CUP", observedAt: VALID_UNTIL }; } };
  const lifecycle = build({ store: creator.store, payments, activation,
    statusValue: { state: RESIDENCY_STATES.ACTIVE, validFrom: VALID_FROM, validUntil: VALID_UNTIL, source: "CUP", observedAt: PAID_AT } });
  lifecycle.setNow(Date.parse(VALID_UNTIL));
  const result = await lifecycle.lifecycle.reconcile({ tenantId: TENANT, userId: USER, orderId: renewed.order.orderId, idempotencyKey: KEY2, eventId: "evt-renew" });
  assert.equal(result.order.state, ORDER_STATES.ACTIVATION_FAILED);
  assert.equal(result.order.activation.lastErrorCode, "ACTIVATION_WINDOW_TERM_MISMATCH");
  assert.equal(result.order.recovery.state, "REVIEW_REQUIRED");
});

test("two concurrent callbacks do not call CUP activation twice", async () => {
  let activationCalls = 0;
  const creator = build();
  const created = await creator.lifecycle.createOrder({ expectedTotalMinor: 79000, tenantId: TENANT, userId: USER, idempotencyKey: KEY, mode: "NEW" });
  const payments = { async create() { throw new Error("must not create"); },
    async read() { return { status: "PAID", amountMinor: 79000, paidAt: PAID_AT, providerTransactionId: "txn-1" }; } };
  const activation = {
    async findInstance() { return { clientSubscriptionId: "sub-1", purchasedAt: PAID_AT }; },
    async activate() {
      activationCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { state: "ACTIVE", validFrom: VALID_FROM, validUntil: VALID_UNTIL, source: "CUP", observedAt: PAID_AT };
    },
  };
  const first = build({ store: creator.store, payments, activation });
  const second = build({ store: creator.store, payments, activation });
  const [left, right] = await Promise.all([
    first.lifecycle.reconcile({ tenantId: TENANT, userId: USER, orderId: created.order.orderId, idempotencyKey: KEY2, eventId: "evt-a" }),
    second.lifecycle.reconcile({ tenantId: TENANT, userId: USER, orderId: created.order.orderId, idempotencyKey: KEY2 + "b", eventId: "evt-b" }),
  ]);
  assert.equal(activationCalls, 1);
  assert.ok([left.order.state, right.order.state].includes(ORDER_STATES.ACTIVE));
});

test("a crashed DISPATCHING attempt recovers through CUP evidence before its lease expires", async () => {
  const creator = build();
  const created = await creator.lifecycle.createOrder({ expectedTotalMinor: 79000, tenantId: TENANT, userId: USER, idempotencyKey: KEY, mode: "NEW" });
  const row = creator.store.orders.get(created.order.orderId);
  row.payment.status = "DISPATCHING";
  row.payment.providerTransactionId = null;
  row.payment.paymentUrl = null;
  creator.store.orders.set(created.order.orderId, row);
  const recovered = build({ store: creator.store, activation: {
    async findInstance() { return { clientSubscriptionId: "sub-1", purchasedAt: PAID_AT }; },
    async activate() { return { state: "ACTIVE", validFrom: VALID_FROM, validUntil: VALID_UNTIL, source: "CUP", observedAt: PAID_AT }; },
  } });
  const result = await recovered.lifecycle.reconcile({ tenantId: TENANT, userId: USER, orderId: created.order.orderId, idempotencyKey: KEY2, eventId: "evt-cup" });
  assert.equal(result.order.state, ORDER_STATES.ACTIVE);
  assert.equal(result.order.payment.status, "PAID");
  assert.equal(result.order.residency.validUntil, VALID_UNTIL);
});

test("an expired dispatch lease keeps the slot and blocks a second checkout", async () => {
  const creator = build();
  const created = await creator.lifecycle.createOrder({ expectedTotalMinor: 79000, tenantId: TENANT, userId: USER, idempotencyKey: KEY, mode: "NEW" });
  const row = creator.store.orders.get(created.order.orderId);
  row.payment.status = "DISPATCHING";
  row.payment.providerTransactionId = null;
  row.payment.paymentUrl = null;
  creator.store.orders.set(created.order.orderId, row);
  creator.setNow(Date.parse("2026-11-18T09:03:00.000Z"));
  const unresolved = await creator.lifecycle.getOrder({ tenantId: TENANT, userId: USER, orderId: created.order.orderId });
  assert.equal(unresolved.order.state, ORDER_STATES.PENDING_PAYMENT);
  assert.equal(unresolved.order.recovery.state, "UNKNOWN_OUTCOME");
  assert.equal(unresolved.order.recovery.reason, "DISPATCH_LEASE_EXPIRED");
  assert.equal(creator.store.orders.get(created.order.orderId).activeSlot, 1);
  await expectCode(creator.lifecycle.createOrder({ expectedTotalMinor: 79000, tenantId: TENANT, userId: USER, idempotencyKey: KEY2, mode: "NEW" }),
    409, "RESIDENCY_ORDER_ALREADY_PENDING");
});

test("an early renewal is refused with zero provider POSTs", async () => {
  // CUP restarts the paid window at the new paymentDate and never carries remaining days.
  // Buying on 2026-11-18 with a window until 2026-11-23 would burn five days, so the
  // owner must refuse it before the durable order and therefore before the provider.
  const baseUntil = "2026-11-23T09:05:00.000Z";
  const { lifecycle, calls, store } = build({
    statusValue: { state: RESIDENCY_STATES.ACTIVE, validFrom: VALID_FROM, validUntil: baseUntil, source: "CUP", observedAt: PAID_AT },
  });
  await assert.rejects(
    lifecycle.createOrder({ expectedTotalMinor: 79000, tenantId: TENANT, userId: USER, idempotencyKey: KEY, mode: "RENEWAL" }),
    (error) => {
      assert.equal(error.code, "RESIDENCY_RENEWAL_TOO_EARLY");
      assert.equal(error.statusCode, 409);
      assert.equal(error.details.eligibleAt, baseUntil);
      assert.equal(error.details.reason, "REMAINING_DAYS_NOT_TRANSFERABLE");
      assert.equal(error.details.currentValidUntil, baseUntil);
      assert.equal(error.details.expected.termDays, 30);
      return true;
    });
  assert.equal(calls.create, 0);
  assert.equal(store.orders.size, 0);
  // The catalog exposes the same reason and the earliest eligible instant before payment.
  const catalog = await lifecycle.catalog({ tenantId: TENANT, userId: USER });
  assert.equal(catalog.renewal.eligible, false);
  assert.equal(catalog.renewal.reason, "REMAINING_DAYS_NOT_TRANSFERABLE");
  assert.equal(catalog.renewal.eligibleAt, baseUntil);
  assert.equal(catalog.renewalEligible, false);
  // At the end of the paid window the renewal becomes eligible.
  const atEnd = build({ statusValue: { state: RESIDENCY_STATES.ACTIVE, validFrom: VALID_FROM, validUntil: baseUntil, source: "CUP", observedAt: PAID_AT } });
  atEnd.setNow(Date.parse(baseUntil));
  const catalogAtEnd = await atEnd.lifecycle.catalog({ tenantId: TENANT, userId: USER });
  assert.equal(catalogAtEnd.renewal.eligible, true);
  const renewed = await atEnd.lifecycle.createOrder({ expectedTotalMinor: 79000, tenantId: TENANT, userId: USER, idempotencyKey: KEY, mode: "RENEWAL" });
  assert.equal(renewed.order.renewal.baseValidUntil, baseUntil);
  assert.equal(renewed.order.renewal.minimumValidUntil, "2026-12-23T09:05:00.000Z");
});

/**
 * Holds the single provider create POST at a barrier so a concurrent reconcile can win
 * the revision CAS first. That is the reproduced P1: one POST, a durable attempt, and a
 * late provider answer whose revision is already stale.
 */
function heldCreate(outcome) {
  let open;
  let entered;
  const gate = new Promise((resolve) => { open = resolve; });
  const reached = new Promise((resolve) => { entered = resolve; });
  let calls = 0;
  return {
    payments: {
      async create() {
        calls += 1;
        entered();
        await gate;
        if (outcome instanceof Error) throw outcome;
        return structuredClone(outcome);
      },
      async read() { throw new Error("a late create never re-reads the provider"); },
    },
    release() { open(); },
    reached,
    count: () => calls,
  };
}

const LATE_PENDING = { status: "PENDING", providerTransactionId: "txn-late",
  paymentUrl: "https://bank.example/pay/late", amountMinor: 79000, expiresAt: "2026-11-18T09:20:00.000Z" };

/** The in-memory row is the durable state; a stale writer must never be the only record. */
function durable(store, orderId) {
  return store.orders.get(orderId);
}

test("a late create response survives a lost CAS and stays durable after restart", async () => {
  const store = memoryStore();
  const held = heldCreate(LATE_PENDING);
  const creator = build({ store, payments: held.payments });
  const pendingCreate = creator.lifecycle.createOrder({ expectedTotalMinor: 79000, tenantId: TENANT,
    userId: USER, idempotencyKey: KEY, mode: "NEW" });
  await held.reached;
  const orderId = [...store.orders.keys()][0];
  assert.equal(durable(store, orderId).state, ORDER_STATES.PENDING_PAYMENT);
  assert.equal(durable(store, orderId).payment.status, "DISPATCHING");

  // A concurrent reconcile without any transaction id reaches CUP evidence and activates.
  const concurrent = build({ store });
  const reconciled = await concurrent.lifecycle.reconcile({ tenantId: TENANT, userId: USER, orderId,
    idempotencyKey: KEY2, eventId: "evt-cup" });
  assert.equal(reconciled.order.state, ORDER_STATES.ACTIVE);
  const wonRevision = durable(store, orderId).revision;
  assert.ok(wonRevision > 1);

  held.release();
  const created = await pendingCreate;
  // ACTIVE is monotonic: the late link never reopens the payment, but its reference is kept.
  assert.equal(created.order.state, ORDER_STATES.ACTIVE);
  assert.equal(created.order.payment.status, "PAID");
  assert.equal(created.order.payment.paymentUrl, null);
  assert.equal(created.order.recovery.state, "NONE");
  const row = durable(store, orderId);
  assert.equal(row.payment.providerTransactionId, "txn-late");
  assert.equal(row.payment.paymentUrl, null);
  assert.ok(row.revision > wonRevision);
  assert.equal(held.count(), 1);

  // The provider evidence is on disk, so a new process reads the same id and the same state.
  const restarted = build({ store });
  const afterRestart = await restarted.lifecycle.getOrder({ tenantId: TENANT, userId: USER, orderId });
  assert.equal(afterRestart.order.state, ORDER_STATES.ACTIVE);
  assert.equal(afterRestart.order.recovery.state, "NONE");
  assert.equal(durable(store, orderId).payment.providerTransactionId, "txn-late");
  assert.equal(held.count(), 1);
});

test("a late create for an unresolved dispatch keeps the link, the slot and one POST", async () => {
  const store = memoryStore();
  const held = heldCreate(LATE_PENDING);
  const noInstance = {
    async findInstance() { return null; },
    async activate() { throw new Error("must not activate"); },
  };
  const creator = build({ store, payments: held.payments, activation: noInstance });
  const pendingCreate = creator.lifecycle.createOrder({ expectedTotalMinor: 79000, tenantId: TENANT,
    userId: USER, idempotencyKey: KEY, mode: "NEW" });
  await held.reached;
  const orderId = [...store.orders.keys()][0];

  // The concurrent reconcile finds no instance: the outcome stays unresolved.
  const concurrent = build({ store, activation: noInstance });
  const reconciled = await concurrent.lifecycle.reconcile({ tenantId: TENANT, userId: USER, orderId,
    idempotencyKey: KEY2, eventId: "evt-none" });
  assert.equal(reconciled.order.state, ORDER_STATES.PENDING_PAYMENT);
  assert.equal(reconciled.order.payment.status, "UNKNOWN");
  const wonRevision = durable(store, orderId).revision;

  held.release();
  const created = await pendingCreate;
  assert.equal(created.order.state, ORDER_STATES.PENDING_PAYMENT);
  assert.equal(created.order.payment.status, "PENDING");
  assert.equal(created.order.payment.paymentUrl, "https://bank.example/pay/late");
  assert.equal(created.order.recovery.action, "PAY");
  const row = durable(store, orderId);
  assert.equal(row.payment.providerTransactionId, "txn-late");
  assert.equal(row.payment.paymentUrl, "https://bank.example/pay/late");
  assert.equal(row.payment.status, "PENDING");
  assert.equal(row.activeSlot, 1);
  assert.ok(row.revision > wonRevision);
  assert.equal(held.count(), 1);

  // The slot stays occupied: a second key is not a way around the durable attempt.
  await expectCode(creator.lifecycle.createOrder({ expectedTotalMinor: 79000, tenantId: TENANT,
    userId: USER, idempotencyKey: "idem-key-0000000003", mode: "NEW" }), 409, "RESIDENCY_ORDER_ALREADY_PENDING");
  assert.equal(held.count(), 1);

  // The stored id is what makes the late confirmation readable without a second POST.
  const paid = build({ store, payments: {
    async create() { throw new Error("must not create"); },
    async read() { return { status: "PAID", amountMinor: 79000, paidAt: PAID_AT, providerTransactionId: "txn-late" }; },
  } });
  const activated = await paid.lifecycle.reconcile({ tenantId: TENANT, userId: USER, orderId,
    idempotencyKey: KEY2, eventId: "evt-paid" });
  assert.equal(activated.order.state, ORDER_STATES.ACTIVE);
  assert.equal(held.count(), 1);
});

test("an UNCONFIRMED late create keeps its known transaction id through a lost CAS", async () => {
  const store = memoryStore();
  const held = heldCreate({ status: "UNCONFIRMED", providerTransactionId: "txn-unconfirmed",
    amountMinor: 79000, paymentUrl: null, reason: "RESIDENCY_UPSTREAM_TIMEOUT" });
  const noInstance = {
    async findInstance() { return null; },
    async activate() { throw new Error("must not activate"); },
  };
  const creator = build({ store, payments: held.payments, activation: noInstance });
  const pendingCreate = creator.lifecycle.createOrder({ expectedTotalMinor: 79000, tenantId: TENANT,
    userId: USER, idempotencyKey: KEY, mode: "NEW" });
  await held.reached;
  const orderId = [...store.orders.keys()][0];
  const concurrent = build({ store, activation: noInstance });
  await concurrent.lifecycle.reconcile({ tenantId: TENANT, userId: USER, orderId,
    idempotencyKey: KEY2, eventId: "evt-none" });

  held.release();
  const created = await pendingCreate;
  assert.equal(created.order.state, ORDER_STATES.PENDING_PAYMENT);
  assert.equal(created.order.payment.status, "UNKNOWN");
  assert.equal(created.order.payment.paymentUrl, null);
  assert.equal(created.order.recovery.state, "UNKNOWN_OUTCOME");
  assert.equal(created.recoveryRequired, true);
  const row = durable(store, orderId);
  assert.equal(row.payment.providerTransactionId, "txn-unconfirmed");
  assert.equal(row.payment.status, "UNKNOWN");
  assert.equal(row.payment.lastErrorCode, "RESIDENCY_UPSTREAM_TIMEOUT");
  assert.equal(row.activeSlot, 1);
  assert.equal(held.count(), 1);

  // The known id survives the restart and the next reconcile can confirm it.
  const restarted = build({ store });
  const afterRestart = await restarted.lifecycle.getOrder({ tenantId: TENANT, userId: USER, orderId });
  assert.equal(afterRestart.order.recovery.state, "UNKNOWN_OUTCOME");
  assert.equal(durable(store, orderId).payment.providerTransactionId, "txn-unconfirmed");
});

test("a late create never downgrades an order that is already confirmed paid or active", async () => {
  for (const seeded of [
    { state: ORDER_STATES.PAID, activeSlot: 1 },
    { state: ORDER_STATES.ACTIVATION_PENDING, activeSlot: 1 },
    { state: ORDER_STATES.ACTIVE, activeSlot: null },
  ]) {
    const store = memoryStore();
    const held = heldCreate(LATE_PENDING);
    const creator = build({ store, payments: held.payments });
    const pendingCreate = creator.lifecycle.createOrder({ expectedTotalMinor: 79000, tenantId: TENANT,
      userId: USER, idempotencyKey: KEY, mode: "NEW" });
    await held.reached;
    const orderId = [...store.orders.keys()][0];
    // A concurrent worker confirmed the payment through provider/CUP evidence: paid, but
    // without a provider reference on this row yet.
    const current = durable(store, orderId);
    store.orders.set(orderId, {
      ...current, state: seeded.state, activeSlot: seeded.activeSlot, revision: current.revision + 1,
      payment: { ...current.payment, status: "PAID", paymentUrl: null, paidAt: PAID_AT,
        providerTransactionId: null, lastCheckedAt: PAID_AT },
      activation: { ...current.activation, state: seeded.state === ORDER_STATES.ACTIVE ? "ACTIVE" : "PENDING" },
    });

    held.release();
    const created = await pendingCreate;
    assert.equal(created.order.state, seeded.state);
    assert.equal(created.order.payment.status, "PAID");
    assert.equal(created.order.payment.paymentUrl, null);
    assert.equal(created.order.recovery.state,
      seeded.state === ORDER_STATES.ACTIVE ? "NONE" : "ACTIVATION_PENDING");
    const row = durable(store, orderId);
    assert.equal(row.state, seeded.state);
    assert.equal(row.payment.status, "PAID");
    assert.equal(row.payment.providerTransactionId, "txn-late");
    assert.equal(held.count(), 1);
  }
});

test("a contradicting transaction id is never silently overwritten", async () => {
  const store = memoryStore();
  const held = heldCreate(LATE_PENDING);
  const creator = build({ store, payments: held.payments });
  const pendingCreate = creator.lifecycle.createOrder({ expectedTotalMinor: 79000, tenantId: TENANT,
    userId: USER, idempotencyKey: KEY, mode: "NEW" });
  await held.reached;
  const orderId = [...store.orders.keys()][0];
  const current = durable(store, orderId);
  store.orders.set(orderId, { ...current, revision: current.revision + 1,
    payment: { ...current.payment, status: "PENDING", providerTransactionId: "txn-existing" } });

  held.release();
  const created = await pendingCreate;
  assert.equal(created.order.state, ORDER_STATES.PAID_REQUIRES_REVIEW);
  assert.equal(created.order.recovery.state, "REVIEW_REQUIRED");
  assert.equal(created.order.recovery.action, "CONTACT_SUPPORT");
  const row = durable(store, orderId);
  assert.equal(row.payment.providerTransactionId, "txn-existing");
  assert.equal(row.payment.lastErrorCode, "TRANSACTION_MISMATCH");
  assert.equal(row.activation.lastErrorCode, "TRANSACTION_MISMATCH");
  assert.ok(row.events.some((event) => event.type === "LATE_CREATE_EVIDENCE"));
  assert.equal(held.count(), 1);

  // An already ACTIVE residency is not reopened by the contradiction, but it is recorded.
  const activeStore = memoryStore();
  const activeHeld = heldCreate(LATE_PENDING);
  const activeCreator = build({ store: activeStore, payments: activeHeld.payments });
  const activeCreate = activeCreator.lifecycle.createOrder({ expectedTotalMinor: 79000, tenantId: TENANT,
    userId: USER, idempotencyKey: KEY, mode: "NEW" });
  await activeHeld.reached;
  const activeOrderId = [...activeStore.orders.keys()][0];
  const activeRow = durable(activeStore, activeOrderId);
  activeStore.orders.set(activeOrderId, { ...activeRow, state: ORDER_STATES.ACTIVE, activeSlot: null,
    revision: activeRow.revision + 1,
    payment: { ...activeRow.payment, status: "PAID", providerTransactionId: "txn-existing" },
    residency: { state: RESIDENCY_STATES.ACTIVE, validFrom: VALID_FROM, validUntil: VALID_UNTIL,
      source: "CUP_RESIDENCY_POLICY", observedAt: PAID_AT } });
  activeHeld.release();
  const activeCreated = await activeCreate;
  assert.equal(activeCreated.order.state, ORDER_STATES.ACTIVE);
  assert.equal(activeCreated.order.residency.validUntil, VALID_UNTIL);
  const activeDurable = durable(activeStore, activeOrderId);
  assert.equal(activeDurable.payment.providerTransactionId, "txn-existing");
  assert.equal(activeDurable.payment.lastErrorCode, "TRANSACTION_MISMATCH");
  assert.equal(activeHeld.count(), 1);
});

test("an unknown payment is never reported as received when CUP finds no instance", async () => {
  const creator = build({ payments: {
    async create() { throw new Error("socket hang up"); },
    async read() { return { status: "UNKNOWN" }; },
  } });
  const created = await creator.lifecycle.createOrder({ expectedTotalMinor: 79000, tenantId: TENANT,
    userId: USER, idempotencyKey: KEY, mode: "NEW" });
  assert.equal(created.order.payment.status, "UNKNOWN");
  let cupWrites = 0;
  const probe = build({ store: creator.store, activation: {
    async findInstance() { return null; },
    async activate() { cupWrites += 1; throw new Error("must not activate"); },
  } });
  const reconciled = await probe.lifecycle.reconcile({ tenantId: TENANT, userId: USER,
    orderId: created.order.orderId, idempotencyKey: KEY2, eventId: "evt-none" });
  assert.equal(reconciled.order.state, ORDER_STATES.PENDING_PAYMENT);
  assert.equal(reconciled.order.payment.status, "UNKNOWN");
  assert.equal(reconciled.order.terminal, false);
  assert.equal(reconciled.order.recovery.state, "UNKNOWN_OUTCOME");
  assert.equal(reconciled.order.recovery.action, "RETRY_RECONCILE");
  assert.equal(reconciled.retryable, true);
  assert.equal(cupWrites, 0);
  assert.ok(!reconciled.order.payment.instruction.includes("Оплата получена"));
  assert.match(reconciled.order.payment.instruction, /не подтверждён/);

  // A plain read, the payment endpoint and the unresolved lookup tell the same story.
  const read = await probe.lifecycle.getOrder({ tenantId: TENANT, userId: USER, orderId: created.order.orderId });
  assert.equal(read.order.state, ORDER_STATES.PENDING_PAYMENT);
  assert.equal(read.order.payment.status, "UNKNOWN");
  assert.equal(read.order.recovery.state, "UNKNOWN_OUTCOME");
  assert.equal(read.order.payment.instruction, reconciled.order.payment.instruction);
  const payment = await probe.lifecycle.getPayment({ tenantId: TENANT, userId: USER, orderId: created.order.orderId });
  assert.equal(payment.state, ORDER_STATES.PENDING_PAYMENT);
  assert.equal(payment.paymentStatus, "UNKNOWN");
  assert.equal(payment.paymentUrl, null);
  assert.equal(payment.terminal, false);
  assert.equal(payment.recovery.state, "UNKNOWN_OUTCOME");
  assert.ok(!payment.instruction.includes("Оплата получена"));
  const listed = await probe.lifecycle.listOrders({ tenantId: TENANT, userId: USER, state: "unresolved" });
  assert.equal(listed.count, 1);
  assert.equal(listed.orders[0].state, ORDER_STATES.PENDING_PAYMENT);
  assert.equal(listed.orders[0].recovery.state, "UNKNOWN_OUTCOME");

  // The slot is held: no second checkout is offered or accepted.
  assert.equal(creator.store.orders.get(created.order.orderId).activeSlot, 1);
  await expectCode(probe.lifecycle.createOrder({ expectedTotalMinor: 79000, tenantId: TENANT,
    userId: USER, idempotencyKey: "idem-key-0000000003", mode: "NEW" }), 409, "RESIDENCY_ORDER_ALREADY_PENDING");

  // A restarted process projects the same uncertainty from durable fields only.
  const restarted = build({ store: creator.store });
  const afterRestart = await restarted.lifecycle.getOrder({ tenantId: TENANT, userId: USER,
    orderId: created.order.orderId });
  assert.equal(afterRestart.order.state, ORDER_STATES.PENDING_PAYMENT);
  assert.equal(afterRestart.order.payment.status, "UNKNOWN");
  assert.equal(afterRestart.order.recovery.state, "UNKNOWN_OUTCOME");
  assert.ok(!afterRestart.order.payment.instruction.includes("Оплата получена"));
  const durableRow = creator.store.orders.get(created.order.orderId);
  assert.equal(durableRow.state, ORDER_STATES.PENDING_PAYMENT);
  assert.equal(durableRow.payment.status, "UNKNOWN");
  assert.equal(durableRow.activation.state, "PENDING");
  assert.equal(durableRow.activation.lastErrorCode, "INSTANCE_NOT_FOUND");
  assert.equal(durableRow.payment.providerTransactionId, null);
});

test("a failed or non-ACTIVE CUP answer never promotes an unconfirmed dispatch", async () => {
  const cases = [
    { name: "lookup outage", activation: {
      async findInstance() { throw new Error("CUP timeout"); },
      async activate() { throw new Error("must not activate"); },
    }, code: "INSTANCE_LOOKUP_UNAVAILABLE" },
    { name: "closed refusal", activation: {
      async findInstance() { return { clientSubscriptionId: "sub-1" }; },
      async activate() { return { state: "REJECTED", reason: "NO_ELIGIBLE_POLICY" }; },
    }, code: "NO_ELIGIBLE_POLICY" },
    { name: "inconclusive answer", activation: {
      async findInstance() { return { clientSubscriptionId: "sub-1" }; },
      async activate() { return { state: "PENDING" }; },
    }, code: "ACTIVATION_UNAVAILABLE" },
  ];
  for (const item of cases) {
    const creator = build({ payments: {
      async create() { throw new Error("socket hang up"); },
      async read() { return { status: "UNKNOWN" }; },
    } });
    const created = await creator.lifecycle.createOrder({ expectedTotalMinor: 79000, tenantId: TENANT,
      userId: USER, idempotencyKey: KEY, mode: "NEW" });
    const probe = build({ store: creator.store, activation: item.activation });
    const reconciled = await probe.lifecycle.reconcile({ tenantId: TENANT, userId: USER,
      orderId: created.order.orderId, idempotencyKey: KEY2, eventId: "evt-" + item.name });
    assert.equal(reconciled.order.state, ORDER_STATES.PENDING_PAYMENT, item.name);
    assert.equal(reconciled.order.payment.status, "UNKNOWN", item.name);
    assert.equal(reconciled.order.recovery.state, "UNKNOWN_OUTCOME", item.name);
    assert.ok(!reconciled.order.payment.instruction.includes("Оплата получена"), item.name);
    const row = creator.store.orders.get(created.order.orderId);
    assert.equal(row.state, ORDER_STATES.PENDING_PAYMENT, item.name);
    assert.equal(row.activation.lastErrorCode, item.code, item.name);
    assert.equal(row.activeSlot, 1, item.name);
  }
});

test("a durable paid phase without a confirmed payment still reads as unknown", async () => {
  // The reported shape: PAID_ACTIVATION_PENDING with payment.status=UNKNOWN must not be
  // presented as a received payment, even when the row was written by an older build.
  const creator = build();
  const created = await creator.lifecycle.createOrder({ expectedTotalMinor: 79000, tenantId: TENANT,
    userId: USER, idempotencyKey: KEY, mode: "NEW" });
  const row = creator.store.orders.get(created.order.orderId);
  creator.store.orders.set(created.order.orderId, { ...row, state: ORDER_STATES.ACTIVATION_PENDING,
    revision: row.revision + 1,
    payment: { ...row.payment, status: "UNKNOWN", paymentUrl: null,
      lastErrorCode: "DISPATCH_OUTCOME_UNKNOWN", lastCheckedAt: PAID_AT },
    activation: { ...row.activation, state: "PENDING", lastErrorCode: "INSTANCE_NOT_FOUND" } });
  const legacy = build({ store: creator.store });
  const read = await legacy.lifecycle.getOrder({ tenantId: TENANT, userId: USER, orderId: created.order.orderId });
  assert.equal(read.order.state, ORDER_STATES.ACTIVATION_PENDING);
  assert.equal(read.order.payment.status, "UNKNOWN");
  assert.equal(read.order.recovery.state, "UNKNOWN_OUTCOME");
  assert.equal(read.order.recovery.retryable, true);
  assert.ok(!read.order.payment.instruction.includes("Оплата получена"));
  const payment = await legacy.lifecycle.getPayment({ tenantId: TENANT, userId: USER, orderId: created.order.orderId });
  assert.equal(payment.paymentStatus, "UNKNOWN");
  assert.equal(payment.recovery.state, "UNKNOWN_OUTCOME");
  assert.ok(!payment.instruction.includes("Оплата получена"));
  assert.equal(creator.store.orders.get(created.order.orderId).activeSlot, 1);
});
