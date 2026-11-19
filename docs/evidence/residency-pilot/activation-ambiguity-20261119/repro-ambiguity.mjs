import crypto from "node:crypto";
import { createResidencyLifecycle, ORDER_STATES } from "../../../../node-red/custom-nodes/residency-lifecycle-api/lib/residency-lifecycle.mjs";

const TENANT = "iSkq6G";
const USER = "user-1";
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
      if (orders.has(order.orderId)) return { ok: false };
      if ([...orders.values()].some((o) => o.tenantId === order.tenantId && o.idempotencyKeyHash === order.idempotencyKeyHash)) return { ok: false };
      if (order.activeSlot === 1 && [...orders.values()].some((o) => o.tenantId === order.tenantId && o.userId === order.userId && o.activeSlot === 1)) return { ok: false };
      orders.set(order.orderId, structuredClone(order));
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
    async findUnresolvedOrder() { return null; },
    async listUnresolvedOrders() { return []; },
    async listRecentOrders() { return []; },
    async listExpiredPending() { return []; },
    async findOrdersByTransactionIds() { return []; },
  };
}

function build({ store = memoryStore(), payments, activation, external = { async list() { return { transactions: [] }; } } } = {}) {
  let now = NOW;
  const calls = { create: 0, read: 0, activate: 0, findInstance: 0, quote: 0, catalog: 0, status: 0 };
  const lifecycle = createResidencyLifecycle({
    clock: { now: () => now },
    ids: { orderId: (tenantId, keyHash) => "00000000-0000-4000-8000-" + sha256(tenantId + keyHash).slice(0, 12), eventId: () => "event" },
    sha256,
    store,
    catalog: { async read() { return { productId: "4037a3a3-e551-4f9a-a9db-1410e46b8635", title: "Резидентство ПадлхАБ",
      termDays: 30, priceMinor: 79000, currency: "RUB", benefits: [], renewalEligible: false, checkedAt: new Date(NOW).toISOString() } } },
    payments: payments || { async create() { calls.create += 1; return { status: "PENDING", providerTransactionId: "txn-1",
      paymentUrl: "https://bank.example/pay/1", amountMinor: 79000, expiresAt: "2026-11-18T09:20:00.000Z" }; },
      async read() { calls.read += 1; return { status: "PAID", amountMinor: 79000, paidAt: PAID_AT, providerTransactionId: "txn-1" }; } },
    activation: activation || { async findInstance() { calls.findInstance += 1; return { clientSubscriptionId: "sub-1", purchasedAt: PAID_AT }; },
      async activate() { calls.activate += 1; return { state: "ACTIVE", validFrom: VALID_FROM, validUntil: VALID_UNTIL, source: "CUP", observedAt: PAID_AT }; } },
    discounts: { async quote({ baseAmountMinor }) { return { discountLines: [], totalMinor: baseAmountMinor }; } },
    status: { async read() { return { state: "NONE", source: "CUP", observedAt: PAID_AT }; } },
    ...(external ? { external } : {}),
    config: { externalGuardRequired: true, externalLookbackMs: 30 * 86400000 },
  });
  return { lifecycle, store, calls, setNow(value) { now = value; } };
}

async function createPaidOrder() {
  const creator = build();
  const created = await creator.lifecycle.createOrder({ expectedTotalMinor: 79000, tenantId: TENANT, userId: USER, idempotencyKey: KEY, mode: "NEW" });
  return { store: creator.store, orderId: created.order.orderId };
}

const basePayments = {
  async create() { throw new Error("must not create"); },
  async read() { return { status: "PAID", amountMinor: 79000, paidAt: PAID_AT, providerTransactionId: "txn-1" }; },
};

async function caseLostAckThenContextDown() {
  const { store, orderId } = await createPaidOrder();
  let activateCalls = 0;
  let contextReads = 0;
  const activation = {
    async findInstance() { return { clientSubscriptionId: "sub-1", purchasedAt: PAID_AT }; },
    async read() { contextReads += 1; throw new Error("CUP context unavailable"); },
    async activate() { activateCalls += 1; throw new Error("ACK lost"); },
  };
  const probe = build({ store, payments: basePayments, activation });
  const first = await probe.lifecycle.reconcile({ tenantId: TENANT, userId: USER, orderId, idempotencyKey: KEY2, eventId: "e1" });
  const second = await probe.lifecycle.reconcile({ tenantId: TENANT, userId: USER, orderId, idempotencyKey: KEY2, eventId: "e2" });
  const restarted = build({ store, payments: basePayments, activation });
  const third = await restarted.lifecycle.reconcile({ tenantId: TENANT, userId: USER, orderId, idempotencyKey: KEY2, eventId: "e3" });
  return { case: "lost-ack-then-context-down", activateCalls, contextReads,
    states: [first.order.activation.state, second.order.activation.state, third.order.activation.state],
    orderStates: [first.order.state, second.order.state, third.order.state] };
}

async function caseStaleInFlight() {
  const { store, orderId } = await createPaidOrder();
  let activateCalls = 0;
  const firstActivation = {
    async findInstance() { return { clientSubscriptionId: "sub-1", purchasedAt: PAID_AT }; },
    async activate() { activateCalls += 1; return { state: "ACTIVE", validFrom: VALID_FROM, validUntil: VALID_UNTIL, source: "CUP", observedAt: PAID_AT }; },
  };
  const first = build({ store, payments: basePayments, activation: firstActivation });
  const active = await first.lifecycle.reconcile({ tenantId: TENANT, userId: USER, orderId, idempotencyKey: KEY2, eventId: "a1" });
  const row = store.orders.get(orderId);
  store.orders.set(orderId, { ...row, state: ORDER_STATES.ACTIVATION_PENDING, revision: row.revision + 1, residency: null,
    activation: { ...row.activation, state: "IN_FLIGHT", startedAt: "2026-11-18T09:00:00.000Z" } });
  let contextReads = 0;
  const activation = {
    async findInstance() { return { clientSubscriptionId: "sub-1", purchasedAt: PAID_AT }; },
    async read() { contextReads += 1; throw new Error("CUP context unavailable"); },
    async activate() { activateCalls += 1; throw new Error("must not refresh"); },
  };
  const restarted = build({ store, payments: basePayments, activation });
  restarted.setNow(Date.parse("2026-11-18T09:06:00.000Z"));
  const r1 = await restarted.lifecycle.reconcile({ tenantId: TENANT, userId: USER, orderId, idempotencyKey: KEY2, eventId: "b1" });
  const r2 = await restarted.lifecycle.reconcile({ tenantId: TENANT, userId: USER, orderId, idempotencyKey: KEY2, eventId: "b2" });
  const restarted2 = build({ store, payments: basePayments, activation });
  restarted2.setNow(Date.parse("2026-11-18T09:07:00.000Z"));
  const r3 = await restarted2.lifecycle.reconcile({ tenantId: TENANT, userId: USER, orderId, idempotencyKey: KEY2, eventId: "b3" });
  return { case: "successful-refresh-then-lost-active-write", firstState: active.order.state, activateCalls, contextReads,
    states: [r1.order.activation.state, r2.order.activation.state, r3.order.activation.state],
    orderStates: [r1.order.state, r2.order.state, r3.order.state] };
}

async function caseExplicitNotActiveThenRetrySucceeds() {
  const { store, orderId } = await createPaidOrder();
  let activateCalls = 0;
  let contextReads = 0;
  const activation = {
    async findInstance() { return { clientSubscriptionId: "sub-1", purchasedAt: PAID_AT }; },
    async read() { contextReads += 1; return { state: "NOT_ACTIVE", observedAt: PAID_AT }; },
    async activate() {
      activateCalls += 1;
      if (activateCalls === 1) throw new Error("connection refused before CUP applied the command");
      return { state: "ACTIVE", validFrom: VALID_FROM, validUntil: VALID_UNTIL, source: "CUP", observedAt: PAID_AT };
    },
  };
  const probe = build({ store, payments: basePayments, activation });
  probe.setNow(Date.parse("2026-11-18T09:06:00.000Z"));
  const r1 = await probe.lifecycle.reconcile({ tenantId: TENANT, userId: USER, orderId, idempotencyKey: KEY2, eventId: "c1" });
  const r2 = await probe.lifecycle.reconcile({ tenantId: TENANT, userId: USER, orderId, idempotencyKey: KEY2, eventId: "c2" });
  const r3 = await probe.lifecycle.reconcile({ tenantId: TENANT, userId: USER, orderId, idempotencyKey: KEY2, eventId: "c3" });
  return { case: "lost-ack-then-explicit-not-active-retry-succeeds", activateCalls, contextReads,
    states: [r1.order.activation.state, r2.order.activation.state, r3.order.activation.state],
    orderStates: [r1.order.state, r2.order.state, r3.order.state] };
}

async function caseNotActiveRetryStaysPending() {
  const { store, orderId } = await createPaidOrder();
  let activateCalls = 0;
  let contextReads = 0;
  const activation = {
    async findInstance() { return { clientSubscriptionId: "sub-1", purchasedAt: PAID_AT }; },
    async read() { contextReads += 1; return { state: "NOT_ACTIVE", observedAt: PAID_AT }; },
    async activate() {
      activateCalls += 1;
      if (activateCalls === 1) throw new Error("connection refused");
      if (activateCalls === 2) return { state: "PENDING" };
      return { state: "ACTIVE", validFrom: VALID_FROM, validUntil: VALID_UNTIL, source: "CUP", observedAt: PAID_AT };
    },
  };
  const probe = build({ store, payments: basePayments, activation });
  probe.setNow(Date.parse("2026-11-18T09:06:00.000Z"));
  const r1 = await probe.lifecycle.reconcile({ tenantId: TENANT, userId: USER, orderId, idempotencyKey: KEY2, eventId: "d1" });
  const r2 = await probe.lifecycle.reconcile({ tenantId: TENANT, userId: USER, orderId, idempotencyKey: KEY2, eventId: "d2" });
  const r3 = await probe.lifecycle.reconcile({ tenantId: TENANT, userId: USER, orderId, idempotencyKey: KEY2, eventId: "d3" });
  return { case: "not-active-retry-stays-pending", activateCalls, contextReads,
    states: [r1.order.activation.state, r2.order.activation.state, r3.order.activation.state],
    orderStates: [r1.order.state, r2.order.state, r3.order.state] };
}

async function caseActivationFailedIsNotRetried() {
  const { store, orderId } = await createPaidOrder();
  let activateCalls = 0;
  const activation = {
    async findInstance() { return { clientSubscriptionId: "sub-1", purchasedAt: PAID_AT }; },
    async activate() {
      activateCalls += 1;
      return { state: "REJECTED", reason: "NO_ELIGIBLE_POLICY" };
    },
  };
  const probe = build({ store, payments: basePayments, activation });
  probe.setNow(Date.parse("2026-11-18T09:06:00.000Z"));
  const r1 = await probe.lifecycle.reconcile({ tenantId: TENANT, userId: USER, orderId, idempotencyKey: KEY2, eventId: "e1" });
  const r2 = await probe.lifecycle.reconcile({ tenantId: TENANT, userId: USER, orderId, idempotencyKey: KEY2, eventId: "e2" });
  return { case: "activation-failed-is-not-retried", activateCalls,
    states: [r1.order.activation.state, r2.order.activation.state],
    orderStates: [r1.order.state, r2.order.state] };
}

const result = { generatedAt: new Date().toISOString(), sourceHead: process.env.SOURCE_HEAD || "unknown",
  cases: [await caseLostAckThenContextDown(), await caseStaleInFlight(),
    await caseExplicitNotActiveThenRetrySucceeds(), await caseNotActiveRetryStaysPending(),
    await caseActivationFailedIsNotRetried()] };
console.log(JSON.stringify(result, null, 2));
