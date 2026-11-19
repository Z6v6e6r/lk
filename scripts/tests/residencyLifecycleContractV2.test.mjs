// Contract v2: durable ambiguity, recovery DTOs, price consent and renewal eligibility.
//
// These tests drive the real lifecycle engine and the real HTTP contract. The provider,
// CUP and status ports are synthetic so every external call is controlled and counted.

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

const TENANT = "iSkq6G";
const OTHER_TENANT = "other6G";
const USER = "user-1";
const OTHER_USER = "user-2";
const KEY = "idem-key-0000000001";
const KEY2 = "idem-key-0000000002";
const KEY3 = "idem-key-0000000003";
const NOW = Date.parse("2026-11-18T09:00:00.000Z");
const PAID_AT = "2026-11-18T09:05:00.000Z";
const VALID_FROM = "2026-11-18T09:05:00.000Z";
const VALID_UNTIL = "2026-12-18T09:05:00.000Z";
const CLIENT_ENUM = ["NONE", "PENDING", "PAID", "FAILED", "UNKNOWN"];
const CLIENT_STATES = ["PENDING_PAYMENT", "PAYMENT_FAILED", "EXPIRED", "CANCELLED", "PAID",
  "PAID_ACTIVATION_PENDING", "ACTIVE", "ACTIVATION_FAILED", "PAID_REQUIRES_REVIEW"];

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

function memoryStore() {
  const orders = new Map();
  return {
    orders,
    async findOrderByKey(tenantId, keyHash) {
      return structuredClone([...orders.values()].find((o) => o.tenantId === tenantId && o.idempotencyKeyHash === keyHash) || null);
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
    async findUnresolvedOrder(tenantId, userId) {
      return structuredClone([...orders.values()].find((o) => o.tenantId === tenantId && o.userId === userId
        && ["PENDING_PAYMENT", "PAID", "PAID_ACTIVATION_PENDING", "ACTIVATION_FAILED", "PAID_REQUIRES_REVIEW"].includes(o.state)) || null);
    },
    async listUnresolvedOrders(tenantId, userId, limit) {
      return [...orders.values()]
        .filter((o) => o.tenantId === tenantId && o.userId === userId
          && ["PENDING_PAYMENT", "PAID", "PAID_ACTIVATION_PENDING", "ACTIVATION_FAILED", "PAID_REQUIRES_REVIEW"].includes(o.state))
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .slice(0, limit)
        .map((o) => structuredClone(o));
    },
    async listRecentOrders(tenantId, userId, sinceIso, limit) {
      return [...orders.values()].filter((o) => o.tenantId === tenantId && o.userId === userId
        && o.updatedAt >= sinceIso)
        .sort((left, right) => (left.updatedAt < right.updatedAt ? 1 : -1))
        .slice(0, limit)
        .map((o) => structuredClone(o));
    },
    async listExpiredPending(tenantId, nowIso) {
      return [...orders.values()].filter((o) => o.tenantId === tenantId && o.state === "PENDING_PAYMENT"
        && o.payment.expiresAt && o.payment.expiresAt <= nowIso).map((o) => structuredClone(o));
    },
  };
}

function harness(overrides = {}) {
  const state = { now: NOW, createCalls: 0, readCalls: 0, activateCalls: 0, findInstanceCalls: 0,
    statusValue: { state: RESIDENCY_STATES.NONE, source: "CUP", observedAt: PAID_AT },
    createQueue: [], readStatus: "PENDING", readFails: false, instance: null, activation: null, readTransactionId: "txn-1",
    lastCreate: null, returnTargets: { widget: { successUrl: "https://lk.online/return", failUrl: "https://lk.online/fail" },
      lk2: { successUrl: "https://lk2.padlhub.su/residency", failUrl: "https://lk2.padlhub.su/residency?failed=1" } } };
  const store = overrides.store || memoryStore();
  const calls = { create: () => state.createCalls, read: () => state.readCalls, activate: () => state.activateCalls,
    findInstance: () => state.findInstanceCalls };
  const payments = {
    async create(command) {
      state.createCalls += 1;
      state.lastCreate = command;
      const next = state.createQueue.shift();
      if (next === "THROW") throw new Error("socket hang up");
      if (next === "REJECT") throw Object.assign(new Error("VALIDATION"), { code: "VALIDATION", outcome: "REJECTED" });
      if (next) return next;
      return { status: "PENDING", providerTransactionId: "txn-1", paymentUrl: "https://bank.example/pay/1",
        amountMinor: 79000, expiresAt: "2026-11-18T09:20:00.000Z" };
    },
    async read() {
      state.readCalls += 1;
      if (state.readFails) throw new Error("provider down");
      if (state.readStatus === "PAID") {
        return { status: "PAID", amountMinor: 79000, paidAt: PAID_AT, providerTransactionId: state.readTransactionId };
      }
      if (state.readStatus === "FAILED") return { status: "FAILED", amountMinor: 79000, providerTransactionId: state.readTransactionId };
      if (state.readStatus === "UNKNOWN") return { status: "UNKNOWN" };
      return { status: "PENDING", amountMinor: 79000, paymentUrl: "https://bank.example/pay/1",
        expiresAt: "2026-11-18T09:20:00.000Z" };
    },
  };
  const activation = {
    async findInstance() {
      state.findInstanceCalls += 1;
      if (state.instance === "THROW") throw new Error("CUP down");
      return state.instance;
    },
    async activate() {
      state.activateCalls += 1;
      if (state.activation === "THROW") throw new Error("CUP down");
      return state.activation || { state: "ACTIVE", validFrom: VALID_FROM, validUntil: VALID_UNTIL,
        source: "CUP_RESIDENCY_POLICY", observedAt: PAID_AT };
    },
  };
  const buildLifecycle = () => createResidencyLifecycle({
    clock: { now: () => state.now },
    ids: { orderId: (tenantId, keyHash) => "00000000-0000-4000-8000-" + sha256(tenantId + keyHash).slice(0, 12), eventId: () => "event-1" },
    sha256,
    store,
    catalog: { async read() {
      return { productId: RESIDENCY_PRODUCT_ID, title: "Резидентство ПадлхАБ", termDays: 30, priceMinor: 79000,
        currency: "RUB", benefits: [], checkedAt: "2026-11-18T08:59:00.000Z" };
    } },
    payments,
    activation,
    discounts: { async quote({ baseAmountMinor }) { return { discountLines: [], totalMinor: baseAmountMinor }; } },
    status: { async read() { return state.statusValue; } },
    config: { returnTargets: state.returnTargets, defaultReturnTarget: "widget", dispatchLeaseMs: 120000 },
  });
  let lifecycle = buildLifecycle();
  const api = createResidencyLifecycleApi({ createLifecycle: () => lifecycle, createPolicy: () => ({ allowed: true }) });
  const actor = { tenantId: TENANT, userId: USER, actorToken: "u".repeat(32) };
  const request = (method, path, body, headers = {}, who = actor) => ({ method, path, body, actor: who, headers });
  return {
    api, state, store, calls, actor, request,
    lifecycle: () => lifecycle,
    restart() { lifecycle = buildLifecycle(); },
  };
}

const createBody = (mode = "NEW", extra = {}) => ({ mode, expectedTotalMinor: 79000, ...extra });
const H = (key, extra = {}) => ({ "Idempotency-Key": key, ...extra });

test("price consent is mandatory and bound to the durable order", async () => {
  const h = harness();
  const missing = await h.api.handle(h.request("POST", "/lk/residency/orders", { mode: "NEW" }, H(KEY)));
  assert.equal(missing.statusCode, 400);
  assert.equal(missing.body.code, "RESIDENCY_PRICE_CONSENT_REQUIRED");
  assert.equal(h.state.createCalls, 0);

  const created = await h.api.handle(h.request("POST", "/lk/residency/orders", createBody("NEW", { expectedTotalMinor: 79000 }), H(KEY)));
  assert.equal(created.statusCode, 200);
  assert.equal(created.body.order.consent.expectedTotalMinor, 79000);
  assert.equal(created.body.order.consent.productId, RESIDENCY_PRODUCT_ID);
  assert.equal(created.body.order.pricing.totalMinor, 79000);
  // The same key with a different confirmed amount is a conflict, not a second order.
  const conflict = await h.api.handle(h.request("POST", "/lk/residency/orders", createBody("NEW", { expectedTotalMinor: 70000 }), H(KEY)));
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.body.code, "RESIDENCY_IDEMPOTENCY_CONFLICT");
  // Consent is exact: both a lower and a higher confirmed amount are a change. Neither
  // creates an order or reaches the provider.
  for (const expectedTotalMinor of [100, 80000]) {
    const fresh = harness();
    const changed = await fresh.api.handle(
      fresh.request("POST", "/lk/residency/orders", createBody("NEW", { expectedTotalMinor }), H(KEY)),
    );
    assert.equal(changed.statusCode, 409);
    assert.equal(changed.body.code, "RESIDENCY_PRICE_CHANGED");
    assert.equal(changed.body.details.expectedTotalMinor, expectedTotalMinor);
    assert.equal(changed.body.details.totalMinor, 79000);
    assert.equal(fresh.state.createCalls, 0);
    assert.equal(fresh.store.orders.size, 0);
  }
});

test("a previous-format mode-only order is not replayed but stays recoverable", async () => {
  const h = harness();
  const created = await h.api.handle(h.request("POST", "/lk/residency/orders", createBody(), H(KEY)));
  assert.equal(created.statusCode, 200);
  const orderId = created.body.order.orderId;
  // Shape of an order written by adc9c644: no consent block and an old request hash.
  const legacy = h.store.orders.get(orderId);
  assert.ok(legacy);
  delete legacy.consent;
  legacy.requestHash = "legacy-mode-only-request-hash";
  h.store.orders.set(orderId, legacy);

  // A mode-only retry is refused before the idempotency lookup: it cannot prove absence.
  const modeOnly = await h.api.handle(h.request("POST", "/lk/residency/orders", { mode: "NEW" }, H(KEY)));
  assert.equal(modeOnly.statusCode, 400);
  assert.equal(modeOnly.body.code, "RESIDENCY_PRICE_CONSENT_REQUIRED");
  assert.equal(h.state.createCalls, 1);
  assert.equal(h.store.orders.size, 1);

  // The new-format retry with the same key finds the old order but cannot replay it.
  const replay = await h.api.handle(h.request("POST", "/lk/residency/orders", createBody(), H(KEY)));
  assert.equal(replay.statusCode, 409);
  assert.equal(replay.body.code, "RESIDENCY_IDEMPOTENCY_CONFLICT");
  assert.equal(h.state.createCalls, 1);

  // The durable order is still the authorized recovery path.
  const unresolved = await h.api.handle(h.request("GET", "/lk/residency/orders?state=unresolved", undefined, H(KEY2)));
  assert.equal(unresolved.statusCode, 200);
  assert.equal(unresolved.body.count, 1);
  assert.equal(unresolved.body.orders[0].orderId, orderId);
  assert.equal(unresolved.body.orders[0].consent, null);

  // A late provider result still activates the previous-format order.
  h.state.readStatus = "PAID";
  h.state.readTransactionId = "txn-1";
  h.state.instance = { clientSubscriptionId: "sub-legacy", purchasedAt: PAID_AT };
  const reconciled = await h.api.handle(
    h.request("POST", "/lk/residency/orders/" + orderId + "/reconcile", {}, H(KEY3)),
  );
  assert.equal(reconciled.statusCode, 200);
  assert.equal(reconciled.body.order.state, ORDER_STATES.ACTIVE);
});

test("the return target is a configured key, never a caller-supplied redirect", async () => {
  const h = harness();
  const unknown = await h.api.handle(h.request("POST", "/lk/residency/orders", createBody(),
    H(KEY, { "X-Residency-Return-Target": "https://evil.example/return" })));
  assert.equal(unknown.statusCode, 400);
  assert.equal(unknown.body.code, "RESIDENCY_RETURN_TARGET_INVALID");
  assert.equal(h.state.createCalls, 0);

  const widget = await h.api.handle(h.request("POST", "/lk/residency/orders", createBody(), H(KEY)));
  assert.equal(widget.statusCode, 200);
  assert.equal(h.state.lastCreate.successUrl, "https://lk.online/return");

  const lk2Harness = harness();
  const lk2 = await lk2Harness.api.handle(lk2Harness.request("POST", "/lk/residency/orders", createBody(),
    H(KEY, { "X-Residency-Return-Target": "lk2" })));
  assert.equal(lk2.statusCode, 200);
  assert.equal(lk2Harness.state.lastCreate.successUrl, "https://lk2.padlhub.su/residency");
  assert.equal(lk2Harness.state.lastCreate.failUrl, "https://lk2.padlhub.su/residency?failed=1");
});

test("a paid create with a failed Admin read keeps the transaction id and recovers after restart", async () => {
  const h = harness();
  h.state.createQueue.push({ status: "UNCONFIRMED", providerTransactionId: "txn-9", amountMinor: 79000,
    paymentUrl: null, reason: "RESIDENCY_UPSTREAM_TIMEOUT" });
  const created = await h.api.handle(h.request("POST", "/lk/residency/orders", createBody(), H(KEY)));
  assert.equal(created.statusCode, 200);
  assert.equal(created.body.order.state, ORDER_STATES.PENDING_PAYMENT);
  assert.equal(created.body.order.payment.status, "UNKNOWN");
  assert.equal(created.body.order.recovery.state, "UNKNOWN_OUTCOME");
  assert.equal(created.body.order.recovery.reason, "RESIDENCY_UPSTREAM_TIMEOUT");
  assert.equal(created.body.recoveryRequired, true);
  const stored = h.store.orders.get(created.body.order.orderId);
  assert.equal(stored.payment.providerTransactionId, "txn-9");
  assert.equal(stored.activeSlot, 1);
  assert.equal("providerTransactionId" in created.body.order.payment, false);

  // Same key: same order, no second POST.
  const replay = await h.api.handle(h.request("POST", "/lk/residency/orders", createBody(), H(KEY)));
  assert.equal(replay.body.idempotentReplay, true);
  assert.equal(h.state.createCalls, 1);
  // Different key: refused while the operation is unresolved.
  const second = await h.api.handle(h.request("POST", "/lk/residency/orders", createBody(), H(KEY2)));
  assert.equal(second.statusCode, 409);
  assert.equal(second.body.code, "RESIDENCY_ORDER_ALREADY_PENDING");
  assert.equal(h.state.createCalls, 1);

  // Restart the process and let the provider confirm the late result.
  h.restart();
  h.state.readStatus = "PAID";
  h.state.readTransactionId = "txn-9";
  h.state.instance = { clientSubscriptionId: "sub-9", purchasedAt: PAID_AT };
  const reconciled = await h.api.handle(h.request("POST", "/lk/residency/orders/" + created.body.order.orderId + "/reconcile",
    { eventId: "evt-late" }, H(KEY3)));
  assert.equal(reconciled.statusCode, 200);
  assert.equal(reconciled.body.order.state, ORDER_STATES.ACTIVE);
  assert.equal(reconciled.body.order.residency.validUntil, VALID_UNTIL);
  assert.equal(reconciled.body.order.recovery.state, "NONE");
  assert.equal(h.calls.activate(), 1);
});

test("a provider request that never reached the owner keeps the slot and needs support", async () => {
  const h = harness();
  h.state.createQueue.push("THROW");
  const created = await h.api.handle(h.request("POST", "/lk/residency/orders", createBody(), H(KEY)));
  assert.equal(created.body.order.state, ORDER_STATES.PENDING_PAYMENT);
  assert.equal(created.body.order.recovery.state, "UNKNOWN_OUTCOME");
  assert.equal(created.body.order.recovery.action, "RETRY_RECONCILE");
  // Another device cannot start a second checkout either.
  const other = await h.api.handle(h.request("POST", "/lk/residency/orders", createBody(), H(KEY2)));
  assert.equal(other.statusCode, 409);
  assert.equal(h.state.createCalls, 1);
  // A cancellation needs a confirmed basis: unknown stays unknown.
  const cancelled = await h.api.handle(h.request("POST", "/lk/residency/orders/" + created.body.order.orderId + "/cancel", {}, H(KEY3)));
  assert.equal(cancelled.statusCode, 409);
  assert.equal(cancelled.body.code, "RESIDENCY_PAYMENT_STATUS_UNKNOWN");
  // Time alone does not change that.
  h.state.now = NOW + 24 * 3600 * 1000;
  const later = await h.api.handle(h.request("GET", "/lk/residency/orders/" + created.body.order.orderId));
  assert.equal(later.body.state, ORDER_STATES.PENDING_PAYMENT);
  assert.equal(later.body.recovery.required, true);
  assert.equal(h.store.orders.get(created.body.order.orderId).activeSlot, 1);
});

test("an unreadable provider readback never frees the checkout", async () => {
  const h = harness();
  const created = await h.api.handle(h.request("POST", "/lk/residency/orders", createBody(), H(KEY)));
  h.state.now = NOW + 21 * 60 * 1000;
  h.state.readFails = true;
  const order = await h.api.handle(h.request("GET", "/lk/residency/orders/" + created.body.order.orderId));
  assert.equal(order.body.state, ORDER_STATES.PENDING_PAYMENT);
  assert.equal(order.body.payment.overdue, true);
  assert.equal(order.body.recovery.state, "AWAITING_CONFIRMATION");
  const next = await h.api.handle(h.request("POST", "/lk/residency/orders", createBody(), H(KEY2)));
  assert.equal(next.statusCode, 409);
  assert.equal(h.state.createCalls, 1);

  // The GET stays read-only even when the provider later proves a terminal failure.
  h.state.readFails = false;
  h.state.readStatus = "FAILED";
  const projected = await h.api.handle(h.request("GET", "/lk/residency/orders/" + created.body.order.orderId));
  assert.equal(projected.body.state, ORDER_STATES.PENDING_PAYMENT);
  assert.equal(projected.body.terminal, false);
  assert.equal(h.store.orders.get(created.body.order.orderId).activeSlot, 1);
  // Only reconcile closes the order and frees the slot.
  const closed = await h.api.handle(h.request("POST", "/lk/residency/orders/" + created.body.order.orderId + "/reconcile", {}, H(KEY3)));
  assert.equal(closed.body.order.state, ORDER_STATES.PAYMENT_FAILED);
  assert.equal(closed.body.order.terminal, true);
  const replacement = await h.api.handle(h.request("POST", "/lk/residency/orders", createBody(), H(KEY2)));
  assert.equal(replacement.statusCode, 200);
  assert.notEqual(replacement.body.order.orderId, created.body.order.orderId);
  assert.equal(h.state.createCalls, 2);
});

test("a PENDING read after the local TTL never becomes EXPIRED or a second checkout", async () => {
  const h = harness();
  const created = await h.api.handle(h.request("POST", "/lk/residency/orders", createBody(), H(KEY)));
  h.state.now = NOW + 21 * 60 * 1000;
  const order = await h.api.handle(h.request("GET", "/lk/residency/orders/" + created.body.order.orderId));
  assert.equal(order.body.state, ORDER_STATES.PENDING_PAYMENT);
  assert.equal(order.body.payment.status, "PENDING");
  assert.equal(order.body.payment.paymentUrl, "https://bank.example/pay/1");
  assert.equal(order.body.recovery.reason, "LOCAL_PAYMENT_WINDOW_ELAPSED");
  const next = await h.api.handle(h.request("POST", "/lk/residency/orders", createBody(), H(KEY2)));
  assert.equal(next.statusCode, 409);
  // The late PAID result is still accepted after the TTL.
  h.state.readStatus = "PAID";
  h.state.instance = { clientSubscriptionId: "sub-1", purchasedAt: PAID_AT };
  const paid = await h.api.handle(h.request("POST", "/lk/residency/orders/" + created.body.order.orderId + "/reconcile",
    { eventId: "evt-paid" }, H(KEY3)));
  assert.equal(paid.body.order.state, ORDER_STATES.ACTIVE);
});

test("payment DTO and order DTO never expose an internal dispatch state", async () => {
  const h = harness();
  const created = await h.api.handle(h.request("POST", "/lk/residency/orders", createBody(), H(KEY)));
  const orderId = created.body.order.orderId;
  const raw = h.store.orders.get(orderId);
  raw.payment.status = "DISPATCHING";
  raw.payment.paymentUrl = null;
  raw.payment.providerTransactionId = null;
  h.store.orders.set(orderId, raw);
  const order = await h.api.handle(h.request("GET", "/lk/residency/orders/" + orderId));
  assert.equal(order.body.payment.status, "UNKNOWN");
  assert.ok(CLIENT_ENUM.includes(order.body.payment.status));
  assert.equal(order.body.recovery.state, "UNKNOWN_OUTCOME");
  const payment = await h.api.handle(h.request("GET", "/lk/residency/orders/" + orderId + "/payment"));
  assert.equal(payment.statusCode, 200);
  assert.equal(payment.body.paymentStatus, "UNKNOWN");
  assert.ok(CLIENT_ENUM.includes(payment.body.paymentStatus));
  assert.equal(payment.body.recovery.state, "UNKNOWN_OUTCOME");
  assert.equal(payment.body.terminal, false);
  assert.equal(typeof payment.body.instruction, "string");
  assert.ok(CLIENT_STATES.includes(payment.body.state));
  assert.equal(JSON.stringify(payment.body).includes("txn-"), false);
  assert.equal(JSON.stringify(order.body).includes("txn-"), false);
});

test("recovery DTOs separate unknown, awaiting confirmation, activation and club review", async () => {
  const h = harness();
  const created = await h.api.handle(h.request("POST", "/lk/residency/orders", createBody(), H(KEY)));
  const orderId = created.body.order.orderId;

  const awaiting = await h.api.handle(h.request("GET", "/lk/residency/orders/" + orderId + "/payment"));
  assert.equal(awaiting.body.recovery.state, "AWAITING_PAYMENT");
  assert.equal(awaiting.body.recovery.required, false);

  h.state.readStatus = "UNKNOWN";
  const unknown = await h.api.handle(h.request("POST", "/lk/residency/orders/" + orderId + "/reconcile", {}, H(KEY2)));
  assert.equal(unknown.body.order.recovery.state, "UNKNOWN_OUTCOME");
  assert.equal(unknown.body.order.recovery.retryable, true);

  h.state.readStatus = "PAID";
  h.state.instance = { clientSubscriptionId: "sub-1", purchasedAt: PAID_AT };
  h.state.activation = "THROW";
  const activating = await h.api.handle(h.request("POST", "/lk/residency/orders/" + orderId + "/reconcile", {}, H(KEY3)));
  assert.equal(activating.body.order.state, ORDER_STATES.ACTIVATION_PENDING);
  assert.equal(activating.body.order.recovery.state, "ACTIVATION_PENDING");
  assert.equal(activating.body.order.recovery.action, "RETRY_RECONCILE");

  h.state.activation = { state: "REJECTED", reason: "RENEWAL_WINDOW_OVERLAP" };
  const review = await h.api.handle(h.request("POST", "/lk/residency/orders/" + orderId + "/reconcile", {}, H("idem-key-0000000004")));
  assert.equal(review.body.order.state, ORDER_STATES.ACTIVATION_FAILED);
  assert.equal(review.body.order.recovery.state, "REVIEW_REQUIRED");
  assert.equal(review.body.order.recovery.action, "CONTACT_SUPPORT");
  assert.equal(review.body.reviewRequired, true);
  // The same state is visible through a plain order read: no mutation flag is needed.
  const read = await h.api.handle(h.request("GET", "/lk/residency/orders/" + orderId));
  assert.equal(read.body.recovery.state, "REVIEW_REQUIRED");
  assert.equal(read.body.terminal, false);

  const cancelled = await h.api.handle(h.request("POST", "/lk/residency/orders/" + orderId + "/cancel", {}, H("idem-key-0000000005")));
  assert.equal(cancelled.statusCode, 409);
  assert.equal(cancelled.body.code, "RESIDENCY_ORDER_NOT_CANCELLABLE");
});

test("a confirmed terminal cancellation is visible as a final refusal", async () => {
  const h = harness();
  const created = await h.api.handle(h.request("POST", "/lk/residency/orders", createBody(), H(KEY)));
  const orderId = created.body.order.orderId;
  h.state.readStatus = "FAILED";
  const cancelled = await h.api.handle(h.request("POST", "/lk/residency/orders/" + orderId + "/cancel", {}, H(KEY2)));
  assert.equal(cancelled.statusCode, 200);
  assert.equal(cancelled.body.order.state, ORDER_STATES.CANCELLED);
  assert.equal(cancelled.body.order.terminal, true);
  assert.equal(cancelled.body.order.recovery.state, "TERMINAL");
  assert.equal(cancelled.body.order.recovery.action, "START_NEW_ORDER");
  assert.equal(h.store.orders.get(orderId).activeSlot, null);
});

test("the unresolved order is discoverable from another device and stays user-scoped", async () => {
  const h = harness();
  const created = await h.api.handle(h.request("POST", "/lk/residency/orders", createBody(), H(KEY)));
  const orderId = created.body.order.orderId;

  const mine = await h.api.handle(h.request("GET", "/lk/residency/orders?state=unresolved"));
  assert.equal(mine.statusCode, 200);
  assert.equal(mine.body.count, 1);
  assert.equal(mine.body.orders[0].orderId, orderId);
  assert.equal(mine.body.orders[0].recovery.required, false);

  const other = await h.api.handle(h.request("GET", "/lk/residency/orders?state=unresolved", undefined, {},
    { tenantId: TENANT, userId: OTHER_USER, actorToken: "u".repeat(32) }));
  assert.equal(other.body.count, 0);

  const badState = await h.api.handle(h.request("GET", "/lk/residency/orders?state=paid"));
  assert.equal(badState.statusCode, 400);
  const badQuery = await h.api.handle(h.request("GET", "/lk/residency/orders?state=unresolved&tenantId=x"));
  assert.equal(badQuery.statusCode, 400);

  h.state.readStatus = "PAID";
  h.state.instance = { clientSubscriptionId: "sub-1", purchasedAt: PAID_AT };
  await h.api.handle(h.request("POST", "/lk/residency/orders/" + orderId + "/reconcile", {}, H(KEY2)));
  const after = await h.api.handle(h.request("GET", "/lk/residency/orders?state=unresolved"));
  assert.equal(after.body.count, 0);

  // Cross-tenant and cross-user reads are 404, never another user's order.
  const crossTenant = await h.api.handle(h.request("GET", "/lk/residency/orders/" + orderId, undefined, {},
    { tenantId: OTHER_TENANT, userId: USER, actorToken: "u".repeat(32) }));
  assert.equal(crossTenant.statusCode, 404);
  const crossUser = await h.api.handle(h.request("GET", "/lk/residency/orders/" + orderId, undefined, {},
    { tenantId: TENANT, userId: OTHER_USER, actorToken: "u".repeat(32) }));
  assert.equal(crossUser.statusCode, 404);
});

test("an unsupported early renewal never reaches the provider", async () => {
  const h = harness();
  h.state.statusValue = { state: RESIDENCY_STATES.ACTIVE, validFrom: VALID_FROM, validUntil: "2026-11-23T09:05:00.000Z",
    source: "CUP", observedAt: PAID_AT };
  const before = h.state.createCalls;
  const refused = await h.api.handle(h.request("POST", "/lk/residency/orders", createBody("RENEWAL"), H(KEY)));
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.body.code, "RESIDENCY_RENEWAL_TOO_EARLY");
  assert.equal(refused.body.details.eligibleAt, "2026-11-23T09:05:00.000Z");
  assert.equal(h.state.createCalls, before);
  assert.equal(h.store.orders.size, 0);
  const catalog = await h.api.handle(h.request("GET", "/lk/residency/catalog"));
  assert.equal(catalog.body.renewal.eligible, false);
  assert.equal(catalog.body.renewal.reason, "REMAINING_DAYS_NOT_TRANSFERABLE");
  assert.equal(catalog.body.renewal.expected.termDays, 30);
  assert.equal(catalog.body.renewal.currentValidUntil, "2026-11-23T09:05:00.000Z");
});

test("two concurrent keys produce exactly one durable order and one provider call", async () => {
  const h = harness();
  const [left, right] = await Promise.all([
    h.api.handle(h.request("POST", "/lk/residency/orders", createBody(), H(KEY))),
    h.api.handle(h.request("POST", "/lk/residency/orders", createBody(), H(KEY2))),
  ]);
  const statuses = [left.statusCode, right.statusCode].sort();
  assert.deepEqual(statuses, [200, 409]);
  assert.equal(h.state.createCalls, 1);
  assert.equal(h.store.orders.size, 1);
});

test("a repeated callback after a restart does not create or activate twice", async () => {
  const h = harness();
  const created = await h.api.handle(h.request("POST", "/lk/residency/orders", createBody(), H(KEY)));
  const orderId = created.body.order.orderId;
  h.state.readStatus = "PAID";
  h.state.instance = { clientSubscriptionId: "sub-1", purchasedAt: PAID_AT };
  const first = await h.api.handle(h.request("POST", "/lk/residency/orders/" + orderId + "/reconcile", { eventId: "evt-1" }, H(KEY2)));
  assert.equal(first.body.order.state, ORDER_STATES.ACTIVE);
  h.restart();
  const replay = await h.api.handle(h.request("POST", "/lk/residency/orders/" + orderId + "/reconcile", { eventId: "evt-1" }, H(KEY3)));
  assert.equal(replay.body.idempotentReplay, true);
  assert.equal(replay.body.order.state, ORDER_STATES.ACTIVE);
  assert.equal(h.calls.activate(), 1);
  assert.equal(h.state.createCalls, 1);
});
