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
  const created = await lifecycle.createOrder({ tenantId: TENANT, userId: USER, idempotencyKey: KEY, mode: "NEW" });
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
  const created = await creator.lifecycle.createOrder({ tenantId: TENANT, userId: USER, idempotencyKey: KEY, mode: "NEW" });
  const { lifecycle, calls } = build({ store: creator.store, payments });
  const result = await lifecycle.reconcile({ tenantId: TENANT, userId: USER, orderId: created.order.orderId, idempotencyKey: KEY2, eventId: "evt-failed" });
  assert.equal(result.order.state, ORDER_STATES.PAYMENT_FAILED);
  assert.equal(result.order.payment.status, "FAILED");
  assert.equal(calls.activate, 0);
});

test("delayed payment confirmation recovers an already expired order", async () => {
  const payments = {
    async create() { throw new Error("must not create"); },
    async read() { return { status: "PAID", amountMinor: 79000, paidAt: PAID_AT, providerTransactionId: "txn-1" }; },
  };
  const creator = build();
  const created = await creator.lifecycle.createOrder({ tenantId: TENANT, userId: USER, idempotencyKey: KEY, mode: "NEW" });
  creator.setNow(Date.parse("2026-11-18T10:00:00.000Z"));
  const expired = await creator.lifecycle.getOrder({ tenantId: TENANT, userId: USER, orderId: created.order.orderId });
  assert.equal(expired.order.state, ORDER_STATES.EXPIRED);
  const lateLifecycle = build({ store: creator.store, payments });
  lateLifecycle.setNow(Date.parse("2026-11-18T10:00:00.000Z"));
  const late = await lateLifecycle.lifecycle.reconcile({ tenantId: TENANT, userId: USER, orderId: created.order.orderId, idempotencyKey: KEY2, eventId: "evt-late" });
  assert.equal(late.order.state, ORDER_STATES.ACTIVE);
  assert.equal(lateLifecycle.calls.activate, 1);
});

test("duplicate callback is idempotent and does not activate twice", async () => {
  const payments = {
    async create() { throw new Error("must not create"); },
    async read() { return { status: "PAID", amountMinor: 79000, paidAt: PAID_AT, providerTransactionId: "txn-1" }; },
  };
  const creator = build();
  const created = await creator.lifecycle.createOrder({ tenantId: TENANT, userId: USER, idempotencyKey: KEY, mode: "NEW" });
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
  const first = await lifecycle.createOrder({ tenantId: TENANT, userId: USER, idempotencyKey: KEY, mode: "NEW" });
  const second = await lifecycle.createOrder({ tenantId: TENANT, userId: USER, idempotencyKey: KEY, mode: "NEW" });
  assert.equal(second.idempotentReplay, true);
  assert.equal(second.order.orderId, first.order.orderId);
  assert.equal(calls.create, 1);
  assert.equal(store.orders.size, 1);
  await expectCode(lifecycle.createOrder({ tenantId: TENANT, userId: USER, idempotencyKey: KEY, mode: "RENEWAL" }), 409, "RESIDENCY_IDEMPOTENCY_CONFLICT");
});

test("a second unresolved order is refused before a second provider create", async () => {
  const { lifecycle, calls } = build();
  await lifecycle.createOrder({ tenantId: TENANT, userId: USER, idempotencyKey: KEY, mode: "NEW" });
  await expectCode(lifecycle.createOrder({ tenantId: TENANT, userId: USER, idempotencyKey: KEY2, mode: "NEW" }), 409, "RESIDENCY_ORDER_ALREADY_PENDING");
  assert.equal(calls.create, 1);
});

test("renewal of an active residency is allowed and preserves the current order", async () => {
  const { lifecycle, store } = build();
  const first = await lifecycle.createOrder({ tenantId: TENANT, userId: USER, idempotencyKey: KEY, mode: "NEW" });
  // Confirm + activate the first order.
  const payments = {
    async create() { throw new Error("must not create"); },
    async read() { return { status: "PAID", amountMinor: 79000, paidAt: PAID_AT, providerTransactionId: "txn-1" }; },
  };
  const activation = {
    async findInstance() { return { clientSubscriptionId: "sub-1" }; },
    async activate() { return { state: "ACTIVE", validFrom: VALID_FROM, validUntil: VALID_UNTIL, source: "CUP", observedAt: PAID_AT }; },
  };
  const active = build({ store, payments, activation, statusValue: { state: RESIDENCY_STATES.ACTIVE, validFrom: VALID_FROM, validUntil: VALID_UNTIL, source: "CUP", observedAt: PAID_AT } });
  await active.lifecycle.reconcile({ tenantId: TENANT, userId: USER, orderId: first.order.orderId, idempotencyKey: KEY2, eventId: "evt-paid" });
  const renewed = await active.lifecycle.createOrder({ tenantId: TENANT, userId: USER, idempotencyKey: KEY2 + "x", mode: "RENEWAL" });
  assert.equal(renewed.order.mode, "RENEWAL");
  assert.equal(renewed.order.state, ORDER_STATES.PENDING_PAYMENT);
  assert.equal(store.orders.size, 2);
  // The existing active order is untouched.
  assert.equal(store.orders.get(first.order.orderId).state, ORDER_STATES.ACTIVE);
});

test("renewal without an active residency is refused and NEW while active is refused", async () => {
  const none = build();
  await expectCode(none.lifecycle.createOrder({ tenantId: TENANT, userId: USER, idempotencyKey: KEY, mode: "RENEWAL" }), 409, "RESIDENCY_RENEWAL_NOT_ELIGIBLE");
  const active = build({ statusValue: { state: RESIDENCY_STATES.ACTIVE, validFrom: VALID_FROM, validUntil: VALID_UNTIL, source: "CUP", observedAt: PAID_AT } });
  await expectCode(active.lifecycle.createOrder({ tenantId: TENANT, userId: USER, idempotencyKey: KEY, mode: "NEW" }), 409, "RESIDENCY_RENEWAL_REQUIRED");
});

test("expiry closes an unpaid order without touching a provider payment", async () => {
  const { lifecycle, setNow, calls } = build();
  const created = await lifecycle.createOrder({ tenantId: TENANT, userId: USER, idempotencyKey: KEY, mode: "NEW" });
  setNow(Date.parse("2026-11-18T09:20:00.000Z"));
  const result = await lifecycle.getOrder({ tenantId: TENANT, userId: USER, orderId: created.order.orderId });
  assert.equal(result.order.state, ORDER_STATES.EXPIRED);
  assert.equal(result.order.payment.paymentUrl, null);
  assert.equal(calls.activate, 0);
  const replacement = await lifecycle.createOrder({ tenantId: TENANT, userId: USER, idempotencyKey: KEY2, mode: "NEW" });
  assert.equal(replacement.order.state, ORDER_STATES.PENDING_PAYMENT);
  assert.notEqual(replacement.order.orderId, created.order.orderId);
  assert.equal(calls.create, 2);
});

test("no discount is applied when the CUP entitlement is absent", async () => {
  const { lifecycle } = build();
  const created = await lifecycle.createOrder({ tenantId: TENANT, userId: USER, idempotencyKey: KEY, mode: "NEW" });
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
  const { lifecycle } = build({
    discounts, payments,
    statusValue: { state: RESIDENCY_STATES.ACTIVE, validFrom: VALID_FROM, validUntil: VALID_UNTIL, source: "CUP", observedAt: PAID_AT },
  });
  const created = await lifecycle.createOrder({ tenantId: TENANT, userId: USER, idempotencyKey: KEY, mode: "RENEWAL" });
  assert.deepEqual(created.order.pricing.discountLines.map((line) => line.code), ["resident-renewal"]);
  assert.equal(created.order.pricing.totalMinor, 71100);
});

test("an invalid discount that exceeds the base amount fails closed", async () => {
  const discounts = { async quote() { return { discountLines: [{ code: "bad", amountMinor: 80000 }], totalMinor: -1000 }; } };
  const { lifecycle, calls } = build({ discounts });
  await expectCode(lifecycle.createOrder({ tenantId: TENANT, userId: USER, idempotencyKey: KEY, mode: "NEW" }), 503, "RESIDENCY_PRICING_INVALID");
  assert.equal(calls.create, 0);
});

test("Viva create failure persists an UNKNOWN order and a retry reads it back without a second charge", async () => {
  let createCalls = 0;
  const payments = {
    async create() { createCalls += 1; throw new Error("socket hang up"); },
    async read() { return { status: "PENDING", amountMinor: 79000, paymentUrl: "https://bank.example/pay/recovered", expiresAt: "2026-11-18T09:20:00.000Z", providerTransactionId: "txn-1" }; },
  };
  const { lifecycle } = build({ payments });
  const first = await lifecycle.createOrder({ tenantId: TENANT, userId: USER, idempotencyKey: KEY, mode: "NEW" });
  assert.equal(first.recoveryRequired, true);
  assert.equal(first.order.payment.status, "UNKNOWN");
  assert.equal(createCalls, 1);
  const replay = await lifecycle.createOrder({ tenantId: TENANT, userId: USER, idempotencyKey: KEY, mode: "NEW" });
  assert.equal(replay.idempotentReplay, true);
  assert.equal(createCalls, 1);
  const payment = await lifecycle.getPayment({ tenantId: TENANT, userId: USER, orderId: first.order.orderId });
  assert.equal(payment.paymentUrl, "https://bank.example/pay/recovered");
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
  const created = await creator.lifecycle.createOrder({ tenantId: TENANT, userId: USER, idempotencyKey: KEY, mode: "NEW" });
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
  const created = await creator.lifecycle.createOrder({ tenantId: TENANT, userId: USER, idempotencyKey: KEY, mode: "NEW" });
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
  const created = await creator.lifecycle.createOrder({ tenantId: TENANT, userId: USER, idempotencyKey: KEY, mode: "NEW" });
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
  await expectCode(lifecycle.createOrder({ tenantId: TENANT, userId: USER, idempotencyKey: KEY, mode: "NEW" }), 503, "RESIDENCY_STATUS_UNAVAILABLE");
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
  const created = await lifecycle.createOrder({ tenantId: TENANT, userId: USER, idempotencyKey: KEY, mode: "NEW" });
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
  const created = await lifecycle.createOrder({ tenantId: TENANT, userId: USER, idempotencyKey: KEY, mode: "NEW" });
  assert.equal(created.order.state, ORDER_STATES.ACTIVE);
  assert.equal(created.order.residency.state, RESIDENCY_STATES.ACTIVE);
  assert.equal(calls.activate, 1);
});

test("cancelling a pending order checks the original transaction first", async () => {
  const creator = build();
  const created = await creator.lifecycle.createOrder({ tenantId: TENANT, userId: USER, idempotencyKey: KEY, mode: "NEW" });
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
  await second.lifecycle.createOrder({ tenantId: TENANT, userId: USER, idempotencyKey: KEY, mode: "NEW" });
  assert.ok(observed, "the order must be durable before POST");
  assert.equal(observed.payment.status, "DISPATCHING");
  assert.equal(observed.activeSlot, 1);
  await expectCode(second.lifecycle.createOrder({ tenantId: TENANT, userId: USER, idempotencyKey: KEY2, mode: "NEW" }), 409, "RESIDENCY_ORDER_ALREADY_PENDING");
  assert.equal(createCalls, 1);
});

test("public order never exposes the Viva transaction id", async () => {
  const { lifecycle } = build();
  const created = await lifecycle.createOrder({ tenantId: TENANT, userId: USER, idempotencyKey: KEY, mode: "NEW" });
  assert.equal("providerTransactionId" in created.order.payment, false);
  assert.equal(created.order.payment.paymentUrl, "https://bank.example/pay/1");
});

test("expiry clears the live payment link from both order and payment endpoints", async () => {
  const { lifecycle, setNow } = build();
  const created = await lifecycle.createOrder({ tenantId: TENANT, userId: USER, idempotencyKey: KEY, mode: "NEW" });
  setNow(Date.parse("2026-11-18T09:20:00.000Z"));
  const order = await lifecycle.getOrder({ tenantId: TENANT, userId: USER, orderId: created.order.orderId });
  assert.equal(order.order.state, ORDER_STATES.EXPIRED);
  assert.equal(order.order.payment.paymentUrl, null);
  const payment = await lifecycle.getPayment({ tenantId: TENANT, userId: USER, orderId: created.order.orderId });
  assert.equal(payment.paymentUrl, null);
});

test("a paid order is never downgraded by a later PENDING read", async () => {
  const paidPayments = { async create() { throw new Error("must not create"); },
    async read() { return { status: "PAID", amountMinor: 79000, paidAt: PAID_AT, providerTransactionId: "txn-1" }; } };
  const failedActivation = { async findInstance() { return { clientSubscriptionId: "sub-1", purchasedAt: PAID_AT }; },
    async activate() { throw new Error("CUP down"); } };
  const creator = build();
  const created = await creator.lifecycle.createOrder({ tenantId: TENANT, userId: USER, idempotencyKey: KEY, mode: "NEW" });
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
  const created = await creator.lifecycle.createOrder({ tenantId: TENANT, userId: USER, idempotencyKey: KEY, mode: "NEW" });
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
  const created = await creator.lifecycle.createOrder({ tenantId: TENANT, userId: USER, idempotencyKey: KEY, mode: "NEW" });
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
  const renewed = await creator.lifecycle.createOrder({ tenantId: TENANT, userId: USER, idempotencyKey: KEY, mode: "RENEWAL" });
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

test("a renewal that does not extend the current window is rejected", async () => {
  const creator = build({ statusValue: { state: RESIDENCY_STATES.ACTIVE, validFrom: VALID_FROM, validUntil: VALID_UNTIL, source: "CUP", observedAt: PAID_AT } });
  const renewed = await creator.lifecycle.createOrder({ tenantId: TENANT, userId: USER, idempotencyKey: KEY, mode: "RENEWAL" });
  const payments = { async create() { throw new Error("must not create"); },
    async read() { return { status: "PAID", amountMinor: 79000, paidAt: PAID_AT, providerTransactionId: "txn-1" }; } };
  const activation = { async findInstance() { return { clientSubscriptionId: "sub-new", purchasedAt: PAID_AT }; },
    async activate() { return { state: "ACTIVE", validFrom: VALID_FROM, validUntil: "2026-12-01T00:00:00.000Z", source: "CUP", observedAt: PAID_AT }; } };
  const lifecycle = build({ store: creator.store, payments, activation, statusValue: { state: RESIDENCY_STATES.ACTIVE, validFrom: VALID_FROM, validUntil: VALID_UNTIL, source: "CUP", observedAt: PAID_AT } });
  const result = await lifecycle.lifecycle.reconcile({ tenantId: TENANT, userId: USER, orderId: renewed.order.orderId, idempotencyKey: KEY2, eventId: "evt-renew" });
  assert.equal(result.order.state, ORDER_STATES.ACTIVATION_FAILED);
  assert.equal(result.order.activation.lastErrorCode, "RENEWAL_WINDOW_NOT_EXTENDED");
});

test("two concurrent callbacks do not call CUP activation twice", async () => {
  let activationCalls = 0;
  const creator = build();
  const created = await creator.lifecycle.createOrder({ tenantId: TENANT, userId: USER, idempotencyKey: KEY, mode: "NEW" });
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
