import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  ORDER_STATES,
  RESIDENCY_PRODUCT_ID,
  RESIDENCY_STATES,
  createResidencyLifecycle,
} from "../../node-red/custom-nodes/residency-lifecycle-api/lib/residency-lifecycle.mjs";
import { createResidencyLifecycleApi } from "../../node-red/custom-nodes/residency-lifecycle-api/lib/residency-lifecycle-http.mjs";
import { createVivaCupResidencyPorts } from "../../node-red/custom-nodes/residency-lifecycle-api/lib/residency-lifecycle-provider.mjs";

const TENANT = "iSkq6G";
const USER = "user-1";
const KEY = "idem-key-0000000001";
const KEY2 = "idem-key-0000000002";
const CLIENT = "00000000-0000-4000-8000-000000000001";
const SUB = "00000000-0000-4000-8000-000000000002";
const TXN = "00000000-0000-4000-8000-000000000003";
const NOW = new Date("2026-11-18T09:00:00.000Z");
const CONFIG = {
  vivaBaseUrl: "https://api.vivacrm.ru",
  cupBaseUrl: "https://cup.example/api",
  tenantKey: TENANT,
  productId: RESIDENCY_PRODUCT_ID,
  cupIntegrationToken: "t".repeat(40),
  successUrl: "https://lk2.padlhub.su/user/api/v1/subscription-payment-return",
  failUrl: "https://lk2.padlhub.su/user/api/v1/subscription-payment-return",
};

function memoryStore() {
  const orders = new Map();
  return {
    orders,
    async findOrderByKey(tenantId, keyHash) {
      return [...orders.values()].find((o) => o.tenantId === tenantId && o.idempotencyKeyHash === keyHash) || null;
    },
    async insertOrder(order) {
      if ([...orders.values()].some((o) => o.orderId === order.orderId || (o.tenantId === order.tenantId && o.idempotencyKeyHash === order.idempotencyKeyHash))) return { ok: false };
      if (order.activeSlot === 1 && [...orders.values()].some((o) => o.tenantId === order.tenantId && o.userId === order.userId && o.activeSlot === 1)) return { ok: false };
      orders.set(order.orderId, structuredClone(order));
      return { ok: true };
    },
    async getOrder(tenantId, userId, orderId) {
      const row = orders.get(orderId);
      return row && row.tenantId === tenantId && row.userId === userId ? structuredClone(row) : null;
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
      return [...orders.values()].filter((o) => o.tenantId === tenantId && o.userId === userId
        && ["PENDING_PAYMENT", "PAID", "PAID_ACTIVATION_PENDING", "ACTIVATION_FAILED", "PAID_REQUIRES_REVIEW"].includes(o.state)).slice(0, limit);
    },
    async listExpiredPending() { return []; },
  };
}

function response(body, status = 200) {
  return { status, headers: { get: () => "application/json" }, async text() { return JSON.stringify(body); } };
}

function harness(engineConfig, createPolicy = () => ({ allowed: true })) {
  const state = { paid: false, failed: false, subscription: null, createCalls: 0, activationCalls: 0, cupCalls: 0,
    now: NOW.getTime(), lastCreateBody: null };
  const fetchImpl = async (url) => {
    if (url.endsWith("/profile")) return response({ id: CLIENT, phone: "+15550000000" });
    if (url.includes("/products/subscriptions/")) return response({ id: RESIDENCY_PRODUCT_ID, title: "Резидентство ПадлхАБ",
      cost: 79000, discountPrice: 79000, validityDays: 30, visits: 30, activationDays: 0, type: "GROUP", variant: "BY_VISITS",
      appliesTo: "BOOKING", hasStudioLimitation: false, hasDirectionLimitation: false, hasTypeLimitation: true,
      availableTypes: [{ id: 2572 }], hasDayLimitation: false, hasTimeRangeLimitation: false, hasDayTimeLimitation: false });
    if (url.endsWith("/transactions") && !url.includes("/api/v1/transactions/")) {
      state.createCalls += 1;
      state.lastCreateBody = JSON.parse(arguments[1]?.body || "null");
      return response({ id: TXN, paymentUrl: "https://bank.example/pay/1", toPay: 79000, paymentDueDate: "2026-11-18T09:20:00.000Z" });
    }
    if (url.includes("/api/v1/transactions/")) {
      return response({ id: TXN, status: state.failed ? "CANCELLED" : state.paid ? "PAID" : "UNPAID", toPay: 79000,
        paymentDate: "2026-11-18T09:05:00.000Z", client: { id: CLIENT },
        products: [{ id: RESIDENCY_PRODUCT_ID, type: "SUBSCRIPTION", count: 1 }],
        refundSum: 0, transactionRefunds: [], cardPaymentInfo: { paymentUrl: "https://bank.example/pay/1" },
        paymentDueDate: "2026-11-18T09:20:00.000Z" });
    }
    if (url.includes("/subscriptions?")) return response(state.subscription ? [state.subscription] : []);
    if (url.includes("/residency-booking-refresh") || url.includes("/residency-booking-context")) {
      state.cupCalls += 1;
      if (url.includes("refresh")) state.activationCalls += 1;
      return response({ providerProductId: RESIDENCY_PRODUCT_ID, purchasedAt: "2026-11-18T09:05:00.000Z",
        observedAt: "2026-11-18T09:06:00.000Z",
        context: { instance: { state: "ACTIVE", activeFrom: "2026-11-18T09:05:00.000Z", activeTo: "2026-12-18T09:05:00.000Z" } } });
    }
    return response({ code: "UNEXPECTED" }, 404);
  };
  const store = memoryStore();
  const createLifecycle = (actor) => {
    const ports = createVivaCupResidencyPorts({ fetch: fetchImpl, config: CONFIG, clock: { now: () => state.now },
      actorToken: actor.actorToken, getAdminToken: () => "s".repeat(32), now: () => new Date(state.now) });
    return createResidencyLifecycle({
      clock: { now: () => state.now },
      config: engineConfig,
      ids: { orderId: (tenantId, keyHash) => "00000000-0000-4000-8000-" + crypto.createHash("sha256").update(tenantId + keyHash).digest("hex").slice(0, 12), eventId: () => "event" },
      sha256: (value) => crypto.createHash("sha256").update(value).digest("hex"),
      store,
      catalog: ports.catalog,
      payments: ports.payments,
      activation: ports.activation,
      status: ports.status,
      discounts: { async quote({ baseAmountMinor }) { return { discountLines: [], totalMinor: baseAmountMinor }; } },
    });
  };
  const api = createResidencyLifecycleApi({ createLifecycle, createPolicy });
  return { api, state, store };
}

const actor = { tenantId: TENANT, userId: USER, actorToken: "u".repeat(32) };
const req = (method, path, body, headers = {}, who = actor) => ({ method, path, body, actor: who, headers });

test("auth, routing, idempotency and body limits are closed", async () => {
  const { api } = harness();
  assert.equal((await api.handle({ method: "OPTIONS", path: "/lk/residency/orders" })).statusCode, 204);
  assert.equal((await api.handle(req("GET", "/lk/residency/catalog", undefined, {}, null))).statusCode, 401);
  assert.equal((await api.handle(req("GET", "/lk/residency/unknown"))).statusCode, 404);
  const noKey = await api.handle(req("POST", "/lk/residency/orders", {}, {}));
  assert.equal(noKey.statusCode, 400);
  assert.equal(noKey.body.code, "RESIDENCY_IDEMPOTENCY_KEY_REQUIRED");
  const badField = await api.handle(req("POST", "/lk/residency/orders", { extra: 1 }, { "Idempotency-Key": KEY }));
  assert.equal(badField.statusCode, 400);
  const tooLarge = await api.handle(req("POST", "/lk/residency/orders", "x".repeat(17 * 1024), { "Idempotency-Key": KEY, "Content-Type": "application/json" }));
  assert.equal(tooLarge.statusCode, 413);
  const wrongType = await api.handle(req("POST", "/lk/residency/orders", "{}", { "Idempotency-Key": KEY, "Content-Type": "text/plain" }));
  assert.equal(wrongType.statusCode, 415);
});

test("full user journey: catalog -> checkout -> payment -> CUP activation -> status -> renewal", async () => {
  const { api, state } = harness();
  const catalog = await api.handle(req("GET", "/lk/residency/catalog"));
  assert.equal(catalog.statusCode, 200);
  assert.equal(catalog.body.product.priceMinor, 79000);

  const none = await api.handle(req("GET", "/lk/residency/status"));
  assert.equal(none.body.state, RESIDENCY_STATES.NONE);

  const created = await api.handle(req("POST", "/lk/residency/orders", { mode: "NEW", expectedTotalMinor: 79000 }, { "Idempotency-Key": KEY, "X-Correlation-ID": "corr-12345678" }));
  assert.equal(created.statusCode, 200);
  assert.equal(created.body.order.state, ORDER_STATES.PENDING_PAYMENT);
  assert.equal(created.body.order.payment.paymentUrl, "https://bank.example/pay/1");
  assert.equal(created.headers["X-Correlation-ID"], "corr-12345678");

  const replay = await api.handle(req("POST", "/lk/residency/orders", { mode: "NEW", expectedTotalMinor: 79000 }, { "Idempotency-Key": KEY }));
  assert.equal(replay.body.idempotentReplay, true);
  assert.equal(state.createCalls, 1);

  const pending = await api.handle(req("POST", "/lk/residency/orders/" + created.body.order.orderId + "/reconcile", { eventId: "evt-1" }, { "Idempotency-Key": KEY2 }));
  assert.equal(pending.body.order.state, ORDER_STATES.PENDING_PAYMENT);
  assert.equal(state.activationCalls, 0);

  state.paid = true;
  state.subscription = { subscriptionId: SUB, productId: RESIDENCY_PRODUCT_ID, clientId: CLIENT, status: "ACTIVE",
    purchaseDate: "2026-11-18T09:05:00.000Z", activationDate: "2026-11-18T09:05:00.000Z" };
  const paid = await api.handle(req("POST", "/lk/residency/orders/" + created.body.order.orderId + "/reconcile", { eventId: "evt-2" }, { "Idempotency-Key": KEY2 }));
  assert.equal(paid.statusCode, 200);
  assert.equal(paid.body.order.state, ORDER_STATES.ACTIVE);
  assert.equal(paid.body.order.residency.validUntil, "2026-12-18T09:05:00.000Z");
  assert.equal(state.activationCalls, 1);

  const duplicate = await api.handle(req("POST", "/lk/residency/orders/" + created.body.order.orderId + "/reconcile", { eventId: "evt-2" }, { "Idempotency-Key": KEY2 }));
  assert.equal(duplicate.body.idempotentReplay, true);
  assert.equal(duplicate.body.order.state, ORDER_STATES.ACTIVE);
  assert.equal(state.activationCalls, 1);

  const status = await api.handle(req("GET", "/lk/residency/status"));
  assert.equal(status.body.state, RESIDENCY_STATES.ACTIVE);
  assert.equal(status.body.validUntil, "2026-12-18T09:05:00.000Z");

  // CUP restarts the window at the new paymentDate, so an early renewal is refused
  // before any provider POST and the catalog explains when it becomes available.
  const tooEarly = await api.handle(req("POST", "/lk/residency/orders", { mode: "RENEWAL", expectedTotalMinor: 79000 }, { "Idempotency-Key": KEY2 + "e" }));
  assert.equal(tooEarly.statusCode, 409);
  assert.equal(tooEarly.body.code, "RESIDENCY_RENEWAL_TOO_EARLY");
  assert.equal(tooEarly.body.details.eligibleAt, "2026-12-18T09:05:00.000Z");
  assert.equal(state.createCalls, 1);
  const catalogBeforePayment = await api.handle(req("GET", "/lk/residency/catalog"));
  assert.equal(catalogBeforePayment.body.renewal.eligible, false);
  assert.equal(catalogBeforePayment.body.renewal.reason, "REMAINING_DAYS_NOT_TRANSFERABLE");
  assert.equal(catalogBeforePayment.body.renewal.eligibleAt, "2026-12-18T09:05:00.000Z");

  state.now = Date.parse("2026-12-18T09:05:00.000Z");
  const renewed = await api.handle(req("POST", "/lk/residency/orders", { mode: "RENEWAL", expectedTotalMinor: 79000 }, { "Idempotency-Key": KEY2 + "r" }));
  assert.equal(renewed.statusCode, 200);
  assert.equal(renewed.body.order.mode, "RENEWAL");
  assert.equal(renewed.body.order.state, ORDER_STATES.PENDING_PAYMENT);
  assert.equal(renewed.body.order.renewal.baseValidUntil, "2026-12-18T09:05:00.000Z");
});

test("order, unresolved and payment GETs are read-only and never activate", async () => {
  const { api, state, store } = harness();
  const created = await api.handle(req("POST", "/lk/residency/orders", { expectedTotalMinor: 79000 }, { "Idempotency-Key": KEY }));
  const orderId = created.body.order.orderId;
  const before = structuredClone(store.orders.get(orderId));
  state.paid = true;
  state.subscription = { subscriptionId: SUB, productId: RESIDENCY_PRODUCT_ID, clientId: CLIENT, status: "ACTIVE",
    purchaseDate: "2026-11-18T09:05:00.000Z", activationDate: "2026-11-18T09:05:00.000Z" };
  state.now = Date.parse("2026-11-18T09:30:00.000Z");

  const read = await api.handle(req("GET", "/lk/residency/orders/" + orderId));
  const listed = await api.handle(req("GET", "/lk/residency/orders?state=unresolved"));
  const payment = await api.handle(req("GET", "/lk/residency/orders/" + orderId + "/payment"));

  assert.deepEqual(store.orders.get(orderId), before);
  assert.equal(read.body.state, ORDER_STATES.PENDING_PAYMENT);
  assert.equal(read.body.payment.status, "PENDING");
  assert.equal(listed.body.count, 1);
  assert.equal(listed.body.orders[0].state, ORDER_STATES.PENDING_PAYMENT);
  assert.equal(payment.body.state, ORDER_STATES.PENDING_PAYMENT);
  assert.equal(payment.body.paymentStatus, "PENDING");
  assert.equal(payment.body.paymentUrl, "https://bank.example/pay/1");
  assert.equal(state.activationCalls, 0);
  assert.equal(state.cupCalls, 0);
});

test("personal pilot gate denies creation before any order, provider call or idempotency lookup", async () => {
  const denied = harness(undefined, ({ tenantId, userId }) => tenantId === TENANT && userId === "pilot-user"
    ? { allowed: true } : { allowed: false, statusCode: 403, code: "RESIDENCY_CREATE_NOT_ALLOWED", message: "not allowed" });
  const refused = await denied.api.handle(req("POST", "/lk/residency/orders", { mode: "NEW", expectedTotalMinor: 79000 },
    { "Idempotency-Key": KEY }, { tenantId: TENANT, userId: "ordinary-user", actorToken: "u".repeat(32) }));
  assert.equal(refused.statusCode, 403);
  assert.equal(refused.body.code, "RESIDENCY_CREATE_NOT_ALLOWED");
  assert.equal(denied.state.createCalls, 0);

  // A body/query/localStorage-style switch is not an identity: the denied actor gets the
  // gate before parsing, and even an allowed actor cannot make "test" a create parameter.
  const bodySwitchDenied = await denied.api.handle(req("POST", "/lk/residency/orders",
    { mode: "NEW", expectedTotalMinor: 79000, test: true }, { "Idempotency-Key": KEY },
    { tenantId: TENANT, userId: "ordinary-user", actorToken: "u".repeat(32) }));
  assert.equal(bodySwitchDenied.statusCode, 403);
  const bodySwitchAllowed = await denied.api.handle(req("POST", "/lk/residency/orders",
    { mode: "NEW", expectedTotalMinor: 79000, test: true }, { "Idempotency-Key": KEY },
    { tenantId: TENANT, userId: "pilot-user", actorToken: "u".repeat(32) }));
  assert.equal(bodySwitchAllowed.statusCode, 400);
  assert.equal(bodySwitchAllowed.body.code, "RESIDENCY_REQUEST_INVALID");

  const allowed = await denied.api.handle(req("POST", "/lk/residency/orders", { mode: "NEW", expectedTotalMinor: 79000 },
    { "Idempotency-Key": KEY }, { tenantId: TENANT, userId: "pilot-user", actorToken: "u".repeat(32) }));
  assert.equal(allowed.statusCode, 200);
  assert.equal(denied.state.createCalls, 1);
});

test("stopping the pilot keeps existing order reads, reconcile and activation available", async () => {
  let createEnabled = true;
  const policy = ({ tenantId, userId }) => !createEnabled
    ? { allowed: false, statusCode: 503, code: "RESIDENCY_ORDERS_DISABLED", message: "disabled" }
    : tenantId === TENANT && userId === "pilot-user"
      ? { allowed: true }
      : { allowed: false, statusCode: 403, code: "RESIDENCY_CREATE_NOT_ALLOWED", message: "not allowed" };
  const { api, state } = harness(undefined, policy);
  const pilotActor = { tenantId: TENANT, userId: "pilot-user", actorToken: "u".repeat(32) };
  const created = await api.handle(req("POST", "/lk/residency/orders", { mode: "NEW", expectedTotalMinor: 79000 },
    { "Idempotency-Key": KEY }, pilotActor));
  assert.equal(created.statusCode, 200);
  const orderId = created.body.order.orderId;

  createEnabled = false;
  const replay = await api.handle(req("POST", "/lk/residency/orders", { mode: "NEW", expectedTotalMinor: 79000 },
    { "Idempotency-Key": KEY }, pilotActor));
  assert.equal(replay.statusCode, 503);
  assert.equal(replay.body.code, "RESIDENCY_ORDERS_DISABLED");
  assert.equal(state.createCalls, 1);

  // The started order keeps its identity and handler: unresolved lookup, payment link,
  // reconcile and later activation are not blocked by the stopped create switch.
  const unresolved = await api.handle(req("GET", "/lk/residency/orders?state=unresolved", undefined, {}, pilotActor));
  assert.equal(unresolved.statusCode, 200);
  assert.equal(unresolved.body.count, 1);
  assert.equal(unresolved.body.orders[0].orderId, orderId);
  const payment = await api.handle(req("GET", "/lk/residency/orders/" + orderId + "/payment", undefined, {}, pilotActor));
  assert.equal(payment.statusCode, 200);
  assert.equal(payment.body.paymentUrl, "https://bank.example/pay/1");

  state.paid = true;
  state.subscription = { subscriptionId: SUB, productId: RESIDENCY_PRODUCT_ID, clientId: CLIENT, status: "ACTIVE",
    purchaseDate: "2026-11-18T09:05:00.000Z", activationDate: "2026-11-18T09:05:00.000Z" };
  const activated = await api.handle(req("POST", "/lk/residency/orders/" + orderId + "/reconcile", { eventId: "evt-after-stop" },
    { "Idempotency-Key": KEY2 }, pilotActor));
  assert.equal(activated.statusCode, 200);
  assert.equal(activated.body.order.state, ORDER_STATES.ACTIVE);
  assert.equal(state.activationCalls, 1);
});

test("missing create policy is a closed gate, not an implicit allow", async () => {
  const api = createResidencyLifecycleApi({ createLifecycle: () => ({ async catalog() { return {}; } }) });
  const result = await api.handle(req("POST", "/lk/residency/orders", { expectedTotalMinor: 79000 }, { "Idempotency-Key": KEY }));
  assert.equal(result.statusCode, 503);
  assert.equal(result.body.code, "RESIDENCY_CREATE_POLICY_INVALID");
});

test("provider errors keep their stable status and code without leaking a body", async () => {
  const api = createResidencyLifecycleApi({ createPolicy: () => ({ allowed: true }), createLifecycle: () => ({ async catalog() {
    const error = new Error("upstream text with private data");
    error.code = "RESIDENCY_UPSTREAM_TIMEOUT";
    error.statusCode = 504;
    throw error;
  } }) });
  const result = await api.handle(req("GET", "/lk/residency/catalog"));
  assert.equal(result.statusCode, 504);
  assert.equal(result.body.code, "RESIDENCY_UPSTREAM_TIMEOUT");
  assert.ok(!JSON.stringify(result.body).includes("private data"));
});

test("a failed provider payment is terminal and visible through the order endpoint", async () => {
  const { api, state } = harness();
  const created = await api.handle(req("POST", "/lk/residency/orders", { expectedTotalMinor: 79000 }, { "Idempotency-Key": KEY }));
  state.failed = true;
  const result = await api.handle(req("POST", "/lk/residency/orders/" + created.body.order.orderId + "/reconcile", { eventId: "evt-failed" }, { "Idempotency-Key": KEY2 }));
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.order.state, ORDER_STATES.PAYMENT_FAILED);
  assert.equal(state.activationCalls, 0);
  const read = await api.handle(req("GET", "/lk/residency/orders/" + created.body.order.orderId));
  assert.equal(read.body.state, ORDER_STATES.PAYMENT_FAILED);
  assert.equal(read.body.payment.paymentUrl, null);
});