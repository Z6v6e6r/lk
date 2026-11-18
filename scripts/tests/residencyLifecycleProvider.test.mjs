import assert from "node:assert/strict";
import test from "node:test";

import { RESIDENCY_PRODUCT_ID } from "../../node-red/custom-nodes/residency-lifecycle-api/lib/residency-lifecycle.mjs";
import { createVivaCupResidencyPorts } from "../../node-red/custom-nodes/residency-lifecycle-api/lib/residency-lifecycle-provider.mjs";

const NOW = new Date("2026-11-18T09:00:00.000Z");
const ACTOR = "u".repeat(32);
const ADMIN = "s".repeat(32);
const CLIENT = "00000000-0000-4000-8000-000000000001";
const SUB = "00000000-0000-4000-8000-000000000002";
const TXN = "00000000-0000-4000-8000-000000000003";
const CONFIG = {
  vivaBaseUrl: "https://api.vivacrm.ru",
  cupBaseUrl: "https://cup.example/api",
  tenantKey: "iSkq6G",
  productId: RESIDENCY_PRODUCT_ID,
  cupIntegrationToken: "t".repeat(40),
  successUrl: "https://lk2.padlhub.su/user/api/v1/subscription-payment-return",
  failUrl: "https://lk2.padlhub.su/user/api/v1/subscription-payment-return",
};

function response(body, status = 200) {
  return {
    status,
    headers: { get: (name) => (String(name).toLowerCase() === "content-type" ? "application/json; charset=utf-8" : null) },
    async text() { return typeof body === "string" ? body : JSON.stringify(body); },
  };
}

function product(overrides = {}) {
  return {
    id: RESIDENCY_PRODUCT_ID, title: "Резидентство ПадлхАБ", cost: 79000, discountPrice: 79000,
    validityDays: 30, visits: 30, activationDays: 0, type: "GROUP", variant: "BY_VISITS", appliesTo: "BOOKING",
    hasStudioLimitation: false, hasDirectionLimitation: false, hasTypeLimitation: true,
    availableTypes: [{ id: 2572 }], hasDayLimitation: false, hasTimeRangeLimitation: false, hasDayTimeLimitation: false,
    ...overrides,
  };
}

function profile(overrides = {}) {
  return { id: CLIENT, phone: "+79000000000", ...overrides };
}

function txn(overrides = {}) {
  return {
    id: TXN, status: "PAID", toPay: 79000, paymentDate: "2026-11-18T09:05:00.000Z",
    client: { id: CLIENT }, products: [{ id: RESIDENCY_PRODUCT_ID, type: "SUBSCRIPTION", count: 1 }],
    refundSum: 0, transactionRefunds: [], cardPaymentInfo: { paymentUrl: "https://pay.vivacrm.ru/x" },
    paymentDueDate: "2026-11-18T09:20:00.000Z", ...overrides,
  };
}

function subscription(overrides = {}) {
  return { subscriptionId: SUB, productId: RESIDENCY_PRODUCT_ID, clientId: CLIENT, status: "ACTIVE",
    purchaseDate: "2026-11-18T09:05:00.000Z", activationDate: "2026-11-18T09:05:00.000Z", ...overrides };
}

function build(overrides = {}) {
  const calls = [];
  const routes = overrides.routes || {};
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    for (const [pattern, handler] of Object.entries(routes)) {
      if (url.includes(pattern)) return handler(url, options);
    }
    if (url.endsWith("/profile")) return response(profile());
    if (url.includes("/products/subscriptions/")) return response(product());
    if (url.includes("/subscriptions?")) return response([subscription()]);
    if (url.includes("/api/v1/transactions/")) return response(txn());
    if (url.endsWith("/transactions")) return response({ paymentUrl: "https://bank.example/pay/1", toPay: 79000, id: TXN, paymentDueDate: "2026-11-18T09:20:00.000Z" });
    if (url.includes("/residency-booking-refresh") || url.includes("/residency-booking-context")) {
      return response({ providerProductId: RESIDENCY_PRODUCT_ID, purchasedAt: "2026-11-18T09:05:00.000Z",
        observedAt: "2026-11-18T09:06:00.000Z",
        context: { instance: { state: "ACTIVE", activeFrom: "2026-11-18T09:05:00.000Z", activeTo: "2026-12-18T09:05:00.000Z" } } });
    }
    return response({ code: "UNEXPECTED" }, 404);
  };
  const ports = createVivaCupResidencyPorts({
    fetch: fetchImpl, config: CONFIG, clock: { now: () => NOW.getTime() }, actorToken: ACTOR,
    getAdminToken: () => ADMIN, now: () => NOW,
  });
  return { ports, calls };
}

test("catalog validates the exact residency product and reads its current price", async () => {
  const { ports, calls } = build();
  const result = await ports.catalog.read({ productId: RESIDENCY_PRODUCT_ID });
  assert.equal(result.productId, RESIDENCY_PRODUCT_ID);
  assert.equal(result.priceMinor, 79000);
  assert.equal(result.termDays, 30);
  assert.equal(result.currency, "RUB");
  assert.equal(result.checkedAt, NOW.toISOString());
  assert.equal(calls[0].options.headers.Authorization, "Bearer " + ACTOR);
});

test("catalog fails closed on any changed product term", async () => {
  for (const change of [{ validityDays: 7 }, { visits: 1 }, { activationDays: 1 }, { type: "SINGLE" },
    { variant: "BY_TIME" }, { appliesTo: "CLASS" }, { hasStudioLimitation: true }, { hasTypeLimitation: false },
    { availableTypes: [{ id: 2572 }, { id: 1 }] }, { availableTypes: [{ id: 1 }] }, { cost: 0 },
    { discountPrice: 80000 }]) {
    const { ports } = build({ routes: { "/products/subscriptions/": () => response(product(change)) } });
    await assert.rejects(ports.catalog.read({ productId: RESIDENCY_PRODUCT_ID }), /RESIDENCY_PRODUCT_TERMS_MISMATCH/);
  }
});

test("create sends one exact subscription line and returns a payable link", async () => {
  const { ports, calls } = build();
  const result = await ports.payments.create({ amountMinor: 79000 });
  assert.equal(result.status, "PENDING");
  assert.equal(result.providerTransactionId, TXN);
  assert.equal(result.paymentUrl, "https://bank.example/pay/1");
  assert.equal(result.amountMinor, 79000);
  const body = JSON.parse(calls.find((call) => call.url.endsWith("/transactions")).options.body);
  assert.deepEqual(body.products, [{ id: RESIDENCY_PRODUCT_ID, type: "SUBSCRIPTION", count: 1 }]);
  assert.equal(body.clientPhone, "+79000000000");
  assert.equal(body.paymentMethod, "WIDGET");
});

test("create rejects a changed amount or a non-https payment URL", async () => {
  const mismatch = build({ routes: { "/transactions": () => response({ paymentUrl: "https://bank.example/pay/1", toPay: 1, id: TXN }) } });
  await assert.rejects(mismatch.ports.payments.create({ amountMinor: 79000 }), /RESIDENCY_PAYMENT_INVALID/);
  const insecure = build({ routes: { "/transactions": () => response({ paymentUrl: "http://bank.example/pay/1", toPay: 79000, id: TXN }) } });
  await assert.rejects(insecure.ports.payments.create({ amountMinor: 79000 }), /RESIDENCY_PAYMENT_INVALID/);
});

test("payment read maps PAID only from an owned exact-product transaction with the confirmed amount", async () => {
  const { ports } = build();
  const result = await ports.payments.read({ amountMinor: 79000, providerTransactionId: TXN });
  assert.equal(result.status, "PAID");
  assert.equal(result.paidAt, "2026-11-18T09:05:00.000Z");
  for (const change of [{ id: "other" }, { client: { id: "other" } },
    { products: [{ id: "other", type: "SUBSCRIPTION", count: 1 }] },
    { products: [{ id: RESIDENCY_PRODUCT_ID, type: "SUBSCRIPTION", count: 2 }] },
    { toPay: 1 }]) {
    const { ports: changed } = build({ routes: { "/api/v1/transactions/": () => response(txn(change)) } });
    await assert.rejects(changed.payments.read({ amountMinor: 79000, providerTransactionId: TXN }));
  }
  for (const refund of [{ refundSum: 1 }, { transactionRefunds: [{}] }]) {
    const { ports: refunded } = build({ routes: { "/api/v1/transactions/": () => response(txn(refund)) } });
    assert.equal((await refunded.payments.read({ amountMinor: 79000, providerTransactionId: TXN })).status, "FAILED");
  }
});

test("payment read distinguishes pending, failed and unknown provider states", async () => {
  for (const [status, expected] of [["UNPAID", "PENDING"], ["WAITING", "PENDING"], ["REFUND", "FAILED"], ["CANCELLED", "FAILED"], ["SOMETHING_NEW", "UNKNOWN"]]) {
    const { ports } = build({ routes: { "/api/v1/transactions/": () => response(txn({ status })) } });
    const result = await ports.payments.read({ amountMinor: 79000, providerTransactionId: TXN });
    assert.equal(result.status, expected, status);
  }
});

test("subscription lookup accepts only the exact product and owner and returns the newest instance", async () => {
  const rows = [subscription({ subscriptionId: SUB, purchaseDate: "2026-11-18T09:05:00.000Z" }),
    subscription({ subscriptionId: "00000000-0000-4000-8000-000000000004", purchaseDate: "2026-12-18T09:05:00.000Z" })];
  const { ports } = build({ routes: { "/subscriptions?": () => response(rows) } });
  const result = await ports.activation.findInstance({ productId: RESIDENCY_PRODUCT_ID });
  assert.equal(result.clientSubscriptionId, "00000000-0000-4000-8000-000000000004");
  const foreign = build({ routes: { "/subscriptions?": () => response([subscription({ clientId: "other" })]) } });
  await assert.rejects(foreign.ports.activation.findInstance({ productId: RESIDENCY_PRODUCT_ID }), /RESIDENCY_SUBSCRIPTION_OWNERSHIP_CONFLICT/);
  const absent = build({ routes: { "/subscriptions?": () => response([subscription({ productId: "other" })]) } });
  assert.equal(await absent.ports.activation.findInstance({ productId: RESIDENCY_PRODUCT_ID }), null);
});

test("CUP context is the only activation authority and exposes the exact window", async () => {
  const { ports, calls } = build();
  const result = await ports.activation.activate({ clientSubscriptionId: SUB });
  assert.deepEqual(result, { state: "ACTIVE", validFrom: "2026-11-18T09:05:00.000Z",
    validUntil: "2026-12-18T09:05:00.000Z", source: "CUP_RESIDENCY_POLICY", observedAt: "2026-11-18T09:06:00.000Z" });
  const cup = calls.find((call) => call.url.includes("residency-booking-refresh"));
  assert.equal(cup.options.headers["X-Subscriptions-Integration-Token"], CONFIG.cupIntegrationToken);
  assert.equal(cup.options.headers.Authorization, "Bearer " + ACTOR);
  assert.deepEqual(JSON.parse(cup.options.body), { clientSubscriptionId: SUB });
});

test("CUP rejection is a closed activation denial, while a CUP outage is retryable", async () => {
  const rejected = build({ routes: { "residency-booking-refresh": () => response({ code: "RESIDENCY_SYNC_SUBSCRIPTION_NOT_ACTIVE" }, 403) } });
  assert.deepEqual(await rejected.ports.activation.activate({ clientSubscriptionId: SUB }),
    { state: "REJECTED", reason: "RESIDENCY_SYNC_SUBSCRIPTION_NOT_ACTIVE" });
  const outage = build({ routes: { "residency-booking-refresh": () => response({ code: "RESIDENCY_SYNC_DEADLINE" }, 503) } });
  await assert.rejects(outage.ports.activation.activate({ clientSubscriptionId: SUB }), /RESIDENCY_SYNC_DEADLINE/);
});

test("status is NONE only after a complete owned read; source failure is UNAVAILABLE", async () => {
  const none = build({ routes: { "/subscriptions?": () => response([]) } });
  assert.equal((await none.ports.status.read()).state, "NONE");
  const active = build();
  assert.equal((await active.ports.status.read()).state, "ACTIVE");
  const down = build({ routes: { "/subscriptions?": () => response({ code: "DOWN" }, 503) } });
  assert.equal((await down.ports.status.read()).state, "UNAVAILABLE");
});

test("no residency price discount is invented", async () => {
  const { ports } = build();
  assert.deepEqual(await ports.discounts.quote({ baseAmountMinor: 79000 }), { discountLines: [], totalMinor: 79000 });
});