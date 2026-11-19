import assert from "node:assert/strict";
import test from "node:test";
import { createCompositeResidencyCheckout } from "../lib/compositeResidencyCheckout.mjs";
const NOW = Date.parse("2026-11-19T08:00:00.000Z");
const RESIDENCY = "4037a3a3-e551-4f9a-a9db-1410e46b8635";
const ACTOR = { tenantId: "tenant-test", clientId: "player-test", authorization: "Bearer fixture" };
const EXERCISE = "exercise-quote-example";
const OPERATION = "operation-quote-example";
const DIGEST = "sha256:" + "a".repeat(64);
const QUOTE = {
  schemaVersion: 1, kind: "GROUP_TRAINING_RESIDENCY_PURCHASE_QUOTE", exerciseId: EXERCISE,
  startsAt: new Date(NOW + 86400_000).toISOString(), durationMinutes: 90, currency: "RUB",
  participationProductId: "group-product-test", residencyProductId: RESIDENCY,
  existingResidency: "NONE", publicationId: "publication-test", policyVersion: 2, policyDigest: DIGEST,
  participationBaseMinor: 550000, discountPercent: 50, participationDiscountMinor: 275000,
  participationToPayMinor: 275000, residencyMinor: 79000, totalMinor: 354000,
  expiresAt: NOW + 30_000,
};

function fakeCollection() {
  const orders = new Map();
  return {
    orders,
    async findOne({ _id }, options) {
      assert.equal(options.readConcern.level, "majority");
      return structuredClone(orders.get(_id) ?? null);
    },
    async insertOne(order, options) {
      assert.equal(options.writeConcern.w, "majority");
      if (orders.has(order._id)) throw Object.assign(new Error("duplicate"), { code: 11000 });
      orders.set(order._id, structuredClone(order));
      return { acknowledged: true };
    },
    async updateOne({ _id, state }, { $set }, options) {
      assert.equal(options.writeConcern.w, "majority");
      const current = orders.get(_id);
      if (current?.state !== state) return { acknowledged: true, matchedCount: 0 };
      Object.assign(current, structuredClone($set));
      return { acknowledged: true, matchedCount: 1 };
    },
  };
}

function fixture({ collection = fakeCollection(), quote = QUOTE, now = () => NOW } = {}) {
  let loads = 0;
  const readQuote = async (actor, exerciseId) => {
    assert.equal(actor.clientId, ACTOR.clientId);
    assert.equal(exerciseId, EXERCISE);
    loads++;
    return { residencyPurchaseQuote: structuredClone(quote), serverTimeMs: now() };
  };
  const engine = (provider = null, source = readQuote) =>
    createCompositeResidencyCheckout({ collection, readQuote: source, provider, now });
  return { engine, collection, loads: () => loads };
}

async function requestFor(engine) {
  const acceptedQuote = JSON.parse(JSON.stringify(await engine.quote(ACTOR, EXERCISE)));
  return { exerciseId: EXERCISE, operationId: OPERATION, acceptedQuote, consentAccepted: true };
}

test("selected group exercise uses published CUP discount and exact Viva prices, without enabling Viva writes", async () => {
  const { engine, collection } = fixture();
  const checkout = engine();
  const request = await requestFor(checkout);
  assert.equal(request.acceptedQuote.exerciseId, EXERCISE);
  assert.equal(request.acceptedQuote.policyDigest, DIGEST);
  assert.deepEqual(request.acceptedQuote, QUOTE);
  await assert.rejects(checkout.checkout(ACTOR, request), { code: "VIVA_COMPOSITE_FORMAT_UNAVAILABLE" });
  assert.equal(collection.orders.size, 0);
});

test("provider commits then response is lost; a fresh checkout instance opens exactly the same order", async () => {
  const { engine, collection, loads } = fixture();
  let creates = 0;
  let lookups = 0;
  const providerOrders = new Map();
  const provider = {
    async create(payload) {
      assert.equal(collection.orders.size, 1);
      const persisted = collection.orders.get(payload.reference);
      assert.equal(persisted.operationId, OPERATION);
      assert.equal(persisted.exerciseId, EXERCISE);
      assert.equal(persisted.quote.totalMinor, 354000);
      assert.equal(persisted.authorization, undefined);
      creates++;
      providerOrders.set(payload.reference, { ...payload, providerOrderId: "provider-original" });
      throw new Error("connection lost after provider commit");
    },
    async lookup({ reference }) {
      lookups++;
      return providerOrders.get(reference);
    },
  };
  const first = engine(provider);
  const request = await requestFor(first);
  assert.equal((await first.checkout(ACTOR, request)).state, "PENDING_CONFIRMATION");

  const restarted = engine(provider, () => assert.fail("a repeat repriced the accepted order"));
  const recovered = await restarted.checkout(ACTOR, request);
  assert.deepEqual(recovered, {
    operationId: OPERATION, state: "CREATED", providerOrderId: "provider-original", quote: request.acceptedQuote,
  });
  assert.deepEqual(await restarted.getOrder(ACTOR, OPERATION), recovered);
  assert.deepEqual(await restarted.checkout(ACTOR, request), recovered);
  assert.equal(await restarted.getOrder({ ...ACTOR, clientId: "other-player" }, OPERATION), null);
  assert.equal(await restarted.getOrder({ ...ACTOR, tenantId: "other-tenant" }, OPERATION), null);
  assert.equal(creates, 1);
  assert.equal(lookups, 1);
  assert.equal(loads(), 2);
  assert.equal(providerOrders.size, 1);
  assert.equal(collection.orders.size, 1);

  await assert.rejects(restarted.checkout(ACTOR, { ...request, exerciseId: "another-exercise" }),
    { code: "COMPOSITE_OPERATION_CONFLICT" });
  await assert.rejects(restarted.checkout(ACTOR, { ...request, acceptedQuote: { ...request.acceptedQuote, policyVersion: 3 } }),
    { code: "COMPOSITE_OPERATION_CONFLICT" });
});

test("concurrent same-key callers dispatch once; absent or foreign readback leaves the operation pending", async () => {
  const { engine, collection } = fixture();
  let dispatched;
  let release;
  const started = new Promise(resolve => { dispatched = resolve; });
  const paused = new Promise(resolve => { release = resolve; });
  let creates = 0;
  let receipt;
  const service = engine({
    async create(payload) {
      creates++;
      dispatched();
      await paused;
      receipt = { ...payload, providerOrderId: "provider-one" };
      return receipt;
    },
    async lookup() {
      return receipt ? { ...receipt, totalMinor: receipt.totalMinor + 1 } : null;
    },
  });
  const request = await requestFor(service);
  const first = service.checkout(ACTOR, request);
  await started;
  try {
    const responses = await Promise.all(Array.from({ length: 4 }, () => service.checkout(ACTOR, request)));
    assert.ok(responses.every(order => order.state === "PENDING_CONFIRMATION"));
    assert.equal((await service.getOrder(ACTOR, OPERATION)).state, "PENDING_CONFIRMATION");
  } finally {
    release();
  }
  assert.equal((await first).providerOrderId, "provider-one");
  assert.equal(creates, 1);
  assert.equal(collection.orders.size, 1);
});

test("ambiguous errors and provider receipts with mutated binding never authorize another create", async () => {
  const { engine } = fixture();
  let payload;
  let readback;
  let creates = 0;
  const checkout = engine({
    async create(request) {
      creates++;
      payload = request;
      return { ...request, providerOrderId: "foreign", exerciseId: "foreign-exercise" };
    },
    async lookup() {
      return readback;
    },
  });
  const request = await requestFor(checkout);
  assert.equal((await checkout.checkout(ACTOR, request)).state, "PENDING_CONFIRMATION");
  readback = { ...payload, providerOrderId: "foreign", totalMinor: payload.totalMinor + 1 };
  assert.equal((await checkout.checkout(ACTOR, request)).providerOrderId, null);
  readback = { ...payload, providerOrderId: "foreign", lines: [...payload.lines].reverse() };
  assert.equal((await checkout.getOrder(ACTOR, OPERATION)).providerOrderId, null);
  assert.equal(creates, 1);
});

test("changed amount, missing consent, and already/unknown resident refuse before reserving an operation", async () => {
  const provider = { create: () => assert.fail("provider write"), lookup: () => assert.fail("provider read") };
  const checkout = fixture().engine(provider);
  const request = await requestFor(checkout);
  const changed = fixture({ quote: { ...QUOTE, residencyMinor: 80000, totalMinor: 355000 } });
  await assert.rejects(changed.engine(provider).checkout(ACTOR, request), { code: "COMPOSITE_QUOTE_CHANGED" });
  assert.equal(changed.collection.orders.size, 0);
  await assert.rejects(checkout.checkout(ACTOR, { ...request, consentAccepted: false }), { code: "CONSENT_REQUIRED" });
  for (const existingResidency of ["ACTIVE", "UNKNOWN"]) {
    const subject = fixture({ quote: { ...QUOTE, existingResidency } });
    await assert.rejects(subject.engine(provider).checkout(ACTOR, request), { code: "COMPOSITE_QUOTE_INVALID" });
    assert.equal(subject.collection.orders.size, 0);
  }
});

test("checkout refuses a malformed or stale server quote and never trusts the client copy", async () => {
  for (const changed of [
    { exerciseId: "foreign-exercise" }, { durationMinutes: 45 }, { residencyProductId: "another-product" },
    { expiresAt: NOW }, { expiresAt: NOW + 30_001 }, { startsAt: new Date(NOW).toISOString() },
    { startsAt: [QUOTE.startsAt] }, { policyDigest: [DIGEST] }, { policyDigest: "unproven" }, { discountPercent: 0 }, { participationToPayMinor: 274999 }, { totalMinor: 353999 },
  ]) {
    await assert.rejects(fixture({ quote: { ...QUOTE, ...changed } }).engine().quote(ACTOR, EXERCISE),
      { code: "COMPOSITE_QUOTE_INVALID" });
  }
});

test("a quote expiring while Mongo confirms the reservation stops dispatch", async () => {
  let clock = NOW;
  const collection = fakeCollection();
  const insert = collection.insertOne;
  collection.insertOne = async (...args) => {
    const result = await insert(...args);
    clock = NOW + 30_001;
    return result;
  };
  const provider = { create: () => assert.fail("expired dispatch"), lookup: () => assert.fail("expired lookup") };
  const checkout = fixture({ collection, now: () => clock }).engine(provider);
  const request = await requestFor(checkout);
  const expired = await checkout.checkout(ACTOR, request);
  assert.equal(expired.state, "EXPIRED_BEFORE_DISPATCH");
  assert.deepEqual(await checkout.checkout(ACTOR, request), expired);
});

test("a lost Mongo insert acknowledgment cannot dispatch or be mistaken for a fresh request", async () => {
  const collection = fakeCollection();
  const insert = collection.insertOne;
  collection.insertOne = async (...args) => {
    await insert(...args);
    throw new Error("connection lost after Mongo insert");
  };
  let lookedUp = 0;
  const provider = { create: () => assert.fail("dispatch without acknowledgment"), lookup: async () => { lookedUp++; } };
  const checkout = fixture({ collection }).engine(provider);
  const request = await requestFor(checkout);
  await assert.rejects(checkout.checkout(ACTOR, request), /connection lost after Mongo insert/);
  assert.equal((await checkout.checkout(ACTOR, request)).state, "PENDING_CONFIRMATION");
  assert.equal(lookedUp, 1);
});
