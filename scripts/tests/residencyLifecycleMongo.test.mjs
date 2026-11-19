// Real Mongo verification for the residency lifecycle store.
//
// The unit suites use an in-memory Map, which cannot prove a unique partial index, an
// acknowledged journaled insert or a revision CAS. This suite runs only against a
// disposable database supplied through LK_TEST_MONGO_URI and skips otherwise.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import {
  RESIDENCY_LIFECYCLE_INDEXES,
  createMongoResidencyLifecycleStore,
  indexSpecMatches,
} from "../../node-red/custom-nodes/residency-lifecycle-api/lib/residency-lifecycle-store.mjs";
import { createResidencyLifecycle, RESIDENCY_PRODUCT_ID } from "../../node-red/custom-nodes/residency-lifecycle-api/lib/residency-lifecycle.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const packageRoot = path.join(repoRoot, "node-red/custom-nodes/residency-lifecycle-api");
const require = createRequire(path.join(packageRoot, "package.json"));
const { MongoClient } = require("mongodb");
const nodeModule = require(path.join(packageRoot, "residency-lifecycle-node.cjs"));

const URI = process.env.LK_TEST_MONGO_URI;
// The mandatory LK1 CI job sets LK_TEST_MONGO_REQUIRED=1. A missing disposable database
// must then fail the job instead of turning the real-Mongo scenarios into a silent skip.
const REQUIRED = process.env.LK_TEST_MONGO_REQUIRED === "1";
if (REQUIRED && !URI) {
  throw new Error("LK_TEST_MONGO_REQUIRED=1 but LK_TEST_MONGO_URI is unset: "
    + "the residency lifecycle scenarios must run on a disposable database");
}
const skip = URI ? false : "LK_TEST_MONGO_URI is not set: real Mongo verification is skipped";
const NOW = Date.parse("2026-11-18T09:00:00.000Z");
const TENANT = "iSkq6G";
const USER = "user-1";
const KEY = "idem-key-0000000001";

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

function orderDocument(overrides = {}) {
  const now = new Date(NOW).toISOString();
  return {
    schemaVersion: 1,
    orderId: overrides.orderId || crypto.randomUUID(),
    tenantId: TENANT,
    userId: USER,
    idempotencyKeyHash: overrides.idempotencyKeyHash || sha256(crypto.randomUUID()),
    requestHash: "request-hash",
    mode: "NEW",
    state: "PENDING_PAYMENT",
    product: { productId: RESIDENCY_PRODUCT_ID, title: "Резидентство ПадлхАБ", termDays: 30, currency: "RUB" },
    pricing: { baseAmountMinor: 79000, discountLines: [], totalMinor: 79000, currency: "RUB" },
    consent: { expectedTotalMinor: 79000, productId: RESIDENCY_PRODUCT_ID, acceptedAt: now },
    payment: { status: "PENDING", providerTransactionId: "txn-1", paymentUrl: "https://bank.example/pay/1",
      expiresAt: "2026-11-18T09:20:00.000Z", paidAt: null, lastCheckedAt: now, lastErrorCode: null },
    activation: { state: "NOT_STARTED", attempts: 0, lastErrorCode: null, clientSubscriptionId: null, startedAt: null },
    residency: null,
    events: [],
    activeSlot: 1,
    renewalBaseValidUntil: null,
    createdAt: now,
    updatedAt: now,
    revision: 1,
    ...overrides,
  };
}

async function withDatabase(run) {
  const client = new MongoClient(URI, nodeModule.MONGO_CLIENT_OPTIONS);
  await client.connect();
  const database = client.db("lk_residency_test_" + crypto.randomBytes(6).toString("hex"));
  const collection = database.collection("lk_residency_lifecycle_orders");
  try {
    for (const spec of RESIDENCY_LIFECYCLE_INDEXES) await collection.createIndex(spec.keys, spec.options);
    await run({ client, database, collection });
  } finally {
    await database.dropDatabase().catch(() => {});
    await client.close();
  }
}

test("the installed indexes carry the reviewed keys, uniqueness and partial predicate", { skip }, async () => {
  await withDatabase(async ({ collection }) => {
    const installed = await collection.indexes();
    for (const spec of RESIDENCY_LIFECYCLE_INDEXES) {
      const index = installed.find((entry) => entry.name === spec.options.name);
      assert.ok(index, "missing index " + spec.options.name);
      assert.equal(indexSpecMatches(index, spec), true, "index contract mismatch for " + spec.options.name);
    }
    const activeSlot = installed.find((entry) => entry.name === "residency_order_active_slot");
    assert.equal(activeSlot.unique, true);
    assert.deepEqual(activeSlot.key, { tenantId: 1, userId: 1, activeSlot: 1 });
    assert.deepEqual(activeSlot.partialFilterExpression, { activeSlot: 1 });
    // A same-named index without the predicate is not the reviewed guard.
    assert.equal(indexSpecMatches(activeSlot, { ...RESIDENCY_LIFECYCLE_INDEXES[2],
      options: { ...RESIDENCY_LIFECYCLE_INDEXES[2].options, partialFilterExpression: undefined } }), false);
    assert.equal(indexSpecMatches({ ...activeSlot, unique: false }, RESIDENCY_LIFECYCLE_INDEXES[2]), false);
  });
});

test("the writes use the journaled majority write concern", { skip }, async () => {
  await withDatabase(async ({ collection }) => {
    const concern = collection.writeConcern || {};
    assert.equal(concern.w, "majority");
    assert.equal(concern.j, true);
    assert.equal(nodeModule.MONGO_CLIENT_OPTIONS.writeConcern.w, "majority");
    assert.equal(nodeModule.MONGO_CLIENT_OPTIONS.writeConcern.j, true);
  });
});

test("the active-slot partial unique index allows exactly one unresolved order", { skip }, async () => {
  await withDatabase(async ({ collection }) => {
    const store = createMongoResidencyLifecycleStore({ collection });
    const first = orderDocument({ orderId: crypto.randomUUID(), activeSlot: 1 });
    assert.deepEqual(await store.insertOrder(first), { ok: true });
    const second = orderDocument({ orderId: crypto.randomUUID(), activeSlot: 1 });
    assert.deepEqual(await store.insertOrder(second), { ok: false });
    // A resolved row may omit the slot; the partial predicate then does not index it.
    const resolved = orderDocument({ orderId: crypto.randomUUID(), activeSlot: null, state: "CANCELLED" });
    assert.deepEqual(await store.insertOrder(resolved), { ok: true });
    // Releasing the first slot allows a replacement order.
    const row = await store.getOrder(TENANT, USER, first.orderId);
    assert.equal(row.activeSlot, 1);
    const released = await store.updateOrder(TENANT, first.orderId, row.revision, { ...row, activeSlot: null, state: "CANCELLED" });
    assert.deepEqual(released, { ok: true });
    const third = orderDocument({ orderId: crypto.randomUUID(), activeSlot: 1 });
    assert.deepEqual(await store.insertOrder(third), { ok: true });
    assert.equal(await collection.countDocuments({ tenantId: TENANT, userId: USER, activeSlot: 1 }), 1);
  });
});

test("concurrent inserts of two different keys keep exactly one winner", { skip }, async () => {
  await withDatabase(async ({ collection }) => {
    const store = createMongoResidencyLifecycleStore({ collection });
    const left = orderDocument({ orderId: crypto.randomUUID() });
    const right = orderDocument({ orderId: crypto.randomUUID() });
    const results = await Promise.all([store.insertOrder(left), store.insertOrder(right)]);
    assert.equal(results.filter((result) => result.ok === true).length, 1);
    assert.equal(results.filter((result) => result.ok === false).length, 1);
    assert.equal(await collection.countDocuments({ tenantId: TENANT, userId: USER, activeSlot: 1 }), 1);
  });
});

test("the idempotency index makes a repeated key one-winner", { skip }, async () => {
  await withDatabase(async ({ collection }) => {
    const store = createMongoResidencyLifecycleStore({ collection });
    const keyHash = sha256("tenant\nuser\nkey");
    assert.deepEqual(await store.insertOrder(orderDocument({ idempotencyKeyHash: keyHash })), { ok: true });
    assert.deepEqual(await store.insertOrder(orderDocument({ idempotencyKeyHash: keyHash })), { ok: false });
    const found = await store.findOrderByKey(TENANT, keyHash);
    assert.ok(found);
    assert.equal("_id" in found, false);
    assert.equal(found.idempotencyKeyHash, keyHash);
  });
});

test("the revision CAS refuses a stale writer and never regresses the row", { skip }, async () => {
  await withDatabase(async ({ collection }) => {
    const store = createMongoResidencyLifecycleStore({ collection });
    const order = orderDocument();
    await store.insertOrder(order);
    const current = await store.getOrder(TENANT, USER, order.orderId);
    assert.equal(current.revision, 1);
    const winner = await store.updateOrder(TENANT, order.orderId, 1, { ...current, state: "PAID", revision: 2 });
    assert.deepEqual(winner, { ok: true });
    const stale = await store.updateOrder(TENANT, order.orderId, 1, { ...current, state: "CANCELLED", revision: 2 });
    assert.deepEqual(stale, { ok: false });
    const after = await store.getOrder(TENANT, USER, order.orderId);
    assert.equal(after.state, "PAID");
    assert.equal(after.revision, 2);
    assert.equal("_id" in after, false);
  });
});

test("the unresolved and expiry queries work on real Mongo operators", { skip }, async () => {
  await withDatabase(async ({ collection }) => {
    const store = createMongoResidencyLifecycleStore({ collection });
    const pending = orderDocument({ orderId: crypto.randomUUID(), activeSlot: 1 });
    await store.insertOrder(pending);
    const paid = orderDocument({ orderId: crypto.randomUUID(), activeSlot: null, state: "PAID" });
    await store.insertOrder(paid);
    const unresolved = await store.listUnresolvedOrders(TENANT, USER, 20);
    assert.deepEqual(unresolved.map((row) => row.orderId).sort(), [paid.orderId, pending.orderId].sort());
    const expired = await store.listExpiredPending(TENANT, "2026-11-18T09:30:00.000Z");
    assert.equal(expired.length, 1);
    assert.equal(expired[0].orderId, pending.orderId);
    const future = await store.listExpiredPending(TENANT, "2026-11-18T09:00:00.000Z");
    assert.equal(future.length, 0);
  });
});

test("the lifecycle persists an unresolved attempt and restarts from disk", { skip }, async () => {
  await withDatabase(async ({ collection }) => {
    const store = createMongoResidencyLifecycleStore({ collection });
    let now = NOW;
    let createCalls = 0;
    const build = (overrides = {}) => createResidencyLifecycle({
      clock: { now: () => now },
      ids: {
        orderId: (tenantId, keyHash) => "00000000-0000-4000-8000-" + sha256(tenantId + keyHash).slice(0, 12),
        eventId: () => "event-1",
      },
      sha256,
      store,
      catalog: { async read() {
        return { productId: RESIDENCY_PRODUCT_ID, title: "Резидентство ПадлхАБ", termDays: 30, priceMinor: 79000,
          currency: "RUB", benefits: [], checkedAt: new Date(NOW).toISOString() };
      } },
      payments: overrides.payments || {
        async create() { createCalls += 1; throw new Error("socket hang up"); },
        async read() { return { status: "UNKNOWN" }; },
      },
      activation: { async findInstance() { return null; }, async activate() { throw new Error("unused"); } },
      discounts: { async quote({ baseAmountMinor }) { return { discountLines: [], totalMinor: baseAmountMinor }; } },
      status: { async read() { return { state: "NONE", source: "CUP", observedAt: new Date(NOW).toISOString() }; } },
    });
    const first = await build().createOrder({ tenantId: TENANT, userId: USER, idempotencyKey: KEY,
      expectedTotalMinor: 79000, mode: "NEW" });
    assert.equal(first.order.recovery.state, "UNKNOWN_OUTCOME");
    assert.equal(createCalls, 1);

    // A fresh process over the same collection replays the same key and refuses a new one.
    const restarted = build();
    const replay = await restarted.createOrder({ tenantId: TENANT, userId: USER, idempotencyKey: KEY,
      expectedTotalMinor: 79000, mode: "NEW" });
    assert.equal(replay.idempotentReplay, true);
    assert.equal(replay.order.orderId, first.order.orderId);
    assert.equal(createCalls, 1);
    await assert.rejects(restarted.createOrder({ tenantId: TENANT, userId: USER, idempotencyKey: KEY + "-b",
      expectedTotalMinor: 79000, mode: "NEW" }), (error) => error.code === "RESIDENCY_ORDER_ALREADY_PENDING");
    const listed = await restarted.listOrders({ tenantId: TENANT, userId: USER, state: "unresolved" });
    assert.equal(listed.count, 1);
    assert.equal(listed.orders[0].orderId, first.order.orderId);
    // The durable attempt also survives the lease without releasing the slot.
    now = NOW + 24 * 3600 * 1000;
    const afterLease = await restarted.getOrder({ tenantId: TENANT, userId: USER, orderId: first.order.orderId });
    assert.equal(afterLease.order.state, "PENDING_PAYMENT");
    assert.equal(afterLease.order.recovery.state, "UNKNOWN_OUTCOME");
    assert.equal(afterLease.order.recovery.required, true);
    const row = await store.getOrder(TENANT, USER, first.order.orderId);
    assert.equal(row.activeSlot, 1);
    await assert.rejects(restarted.createOrder({ tenantId: TENANT, userId: USER, idempotencyKey: KEY + "-c",
      expectedTotalMinor: 79000, mode: "NEW" }), (error) => error.code === "RESIDENCY_ORDER_ALREADY_PENDING");
    // A crash that persisted no error code surfaces the lease itself.
    await store.updateOrder(TENANT, first.order.orderId, row.revision,
      { ...row, payment: { ...row.payment, lastErrorCode: null },
        activation: { ...row.activation, lastErrorCode: null } });
    const crash = await restarted.getOrder({ tenantId: TENANT, userId: USER, orderId: first.order.orderId });
    assert.equal(crash.order.recovery.reason, "DISPATCH_LEASE_EXPIRED");
  });
});

test("a held create response that loses the CAS is persisted through the real store", { skip }, async () => {
  await withDatabase(async ({ collection }) => {
    const store = createMongoResidencyLifecycleStore({ collection });
    const now = NOW;
    const isoNow = new Date(now).toISOString();
    let createCalls = 0;
    let openCreate;
    let createEntered;
    const gate = new Promise((resolve) => { openCreate = resolve; });
    const entered = new Promise((resolve) => { createEntered = resolve; });
    const noInstance = {
      async findInstance() { return null; },
      async activate() { throw new Error("must not activate"); },
    };
    const build = (payments, activation) => createResidencyLifecycle({
      clock: { now: () => now },
      ids: {
        orderId: (tenantId, keyHash) => "00000000-0000-4000-8000-" + sha256(tenantId + keyHash).slice(0, 12),
        eventId: () => "event-" + createCalls,
      },
      sha256,
      store,
      catalog: { async read() {
        return { productId: RESIDENCY_PRODUCT_ID, title: "Резидентство ПадлхАБ", termDays: 30, priceMinor: 79000,
          currency: "RUB", benefits: [], checkedAt: isoNow };
      } },
      payments,
      activation,
      discounts: { async quote({ baseAmountMinor }) { return { discountLines: [], totalMinor: baseAmountMinor }; } },
      status: { async read() { return { state: "NONE", source: "CUP", observedAt: isoNow }; } },
    });

    // The create POST is the single provider operation; it is held while a second worker
    // reconciles the same order without a transaction id.
    const writer = build({
      async create() {
        createCalls += 1;
        createEntered();
        await gate;
        return { status: "PENDING", providerTransactionId: "txn-late",
          paymentUrl: "https://bank.example/pay/late", amountMinor: 79000,
          expiresAt: "2026-11-18T09:20:00.000Z" };
      },
      async read() { throw new Error("a late create never re-reads the provider"); },
    }, noInstance);
    const pending = writer.createOrder({ tenantId: TENANT, userId: USER, idempotencyKey: KEY,
      expectedTotalMinor: 79000, mode: "NEW" });
    await entered;
    const attempt = await collection.findOne({ tenantId: TENANT, userId: USER, state: "PENDING_PAYMENT" });
    assert.ok(attempt);
    assert.equal(attempt.payment.status, "DISPATCHING");
    assert.equal(attempt.revision, 1);

    const reconciler = build({
      async create() { throw new Error("must not create"); },
      async read() { throw new Error("a reconcile without a transaction id never reads the provider"); },
    }, noInstance);
    const reconciled = await reconciler.reconcile({ tenantId: TENANT, userId: USER, orderId: attempt.orderId,
      idempotencyKey: KEY + "-reconcile", eventId: "evt-none" });
    assert.equal(reconciled.order.state, "PENDING_PAYMENT");
    assert.equal(reconciled.order.payment.status, "UNKNOWN");
    assert.equal(reconciled.order.recovery.state, "UNKNOWN_OUTCOME");
    const wonRevision = (await store.getOrder(TENANT, USER, attempt.orderId)).revision;
    assert.ok(wonRevision > 1);

    openCreate();
    const created = await pending;
    assert.equal(created.order.state, "PENDING_PAYMENT");
    assert.equal(created.order.payment.status, "PENDING");
    assert.equal(created.order.payment.paymentUrl, "https://bank.example/pay/late");
    assert.equal(createCalls, 1);

    // The durable row really holds the late provider evidence.
    const persisted = await store.getOrder(TENANT, USER, attempt.orderId);
    assert.equal(persisted.payment.providerTransactionId, "txn-late");
    assert.equal(persisted.payment.paymentUrl, "https://bank.example/pay/late");
    assert.equal(persisted.payment.status, "PENDING");
    assert.equal(persisted.activeSlot, 1);
    assert.ok(persisted.revision > wonRevision);

    // A new process over the same collection reads the id and can confirm the payment.
    const restartedStore = createMongoResidencyLifecycleStore({ collection });
    const restarted = createResidencyLifecycle({
      clock: { now: () => now },
      ids: { orderId: (tenantId, keyHash) => "00000000-0000-4000-8000-" + sha256(tenantId + keyHash).slice(0, 12),
        eventId: () => "event-restart" },
      sha256,
      store: restartedStore,
      catalog: { async read() { throw new Error("unused"); } },
      payments: {
        async create() { throw new Error("must not create"); },
        async read() { return { status: "PAID", amountMinor: 79000, paidAt: isoNow,
          providerTransactionId: "txn-late" }; },
      },
      activation: {
        async findInstance() { return { clientSubscriptionId: "sub-1", purchasedAt: isoNow }; },
        async activate() { return { state: "ACTIVE", validFrom: isoNow,
          validUntil: new Date(now + 30 * 86400000).toISOString(), source: "CUP", observedAt: isoNow }; },
      },
      discounts: { async quote() { throw new Error("unused"); } },
      status: { async read() { throw new Error("unused"); } },
    });
    const readBack = await restarted.getOrder({ tenantId: TENANT, userId: USER, orderId: attempt.orderId });
    assert.equal(readBack.order.payment.status, "PENDING");
    assert.equal(readBack.order.payment.paymentUrl, "https://bank.example/pay/late");
    const confirmed = await restarted.reconcile({ tenantId: TENANT, userId: USER, orderId: attempt.orderId,
      idempotencyKey: KEY + "-paid", eventId: "evt-paid" });
    assert.equal(confirmed.order.state, "ACTIVE");
    assert.equal(confirmed.order.recovery.state, "NONE");
    const finalRow = await store.getOrder(TENANT, USER, attempt.orderId);
    assert.equal(finalRow.payment.status, "PAID");
    assert.equal(finalRow.payment.providerTransactionId, "txn-late");
    assert.equal(finalRow.activeSlot, null);
    assert.equal(createCalls, 1);
  });
});


test("orders are looked up by their provider transaction for the cross-path guard", { skip }, async () => {
  await withDatabase(async ({ collection }) => {
    const store = createMongoResidencyLifecycleStore({ collection });
    const mine = orderDocument({ orderId: crypto.randomUUID(), activeSlot: 1 });
    assert.deepEqual(await store.insertOrder(mine), { ok: true });
    const other = orderDocument({ orderId: crypto.randomUUID(), userId: "user-2", activeSlot: 1,
      payment: { ...mine.payment, providerTransactionId: "txn-2" } });
    assert.deepEqual(await store.insertOrder(other), { ok: true });
    const found = await store.findOrdersByTransactionIds(TENANT, USER, ["txn-1", "txn-2"]);
    assert.equal(found.length, 1);
    assert.equal(found[0].orderId, mine.orderId);
    assert.equal(found[0].payment.providerTransactionId, "txn-1");
    assert.deepEqual(await store.findOrdersByTransactionIds(TENANT, USER, []), []);
  });
});
