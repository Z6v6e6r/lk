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
  return { id: CLIENT, phone: "+15550000000", ...overrides };
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
    getAdminToken: overrides.getAdminToken || (() => ADMIN), now: () => NOW,
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
  assert.equal(body.clientPhone, "+15550000000");
  assert.equal(body.paymentMethod, "WIDGET");
});

test("an already paid create is PAID without inventing a URL", async () => {
  const { ports } = build({ routes: { "/transactions": (url) => url.endsWith("/transactions")
    ? response({ paid: true, toPay: 79000, id: TXN })
    : response(txn()) } });
  const result = await ports.payments.create({ amountMinor: 79000 });
  assert.equal(result.status, "PAID");
  assert.equal(result.paymentUrl, null);
  assert.equal(result.paidAt, "2026-11-18T09:05:00.000Z");
  const changed = build({ routes: { "/transactions": (url) => url.endsWith("/transactions")
    ? response({ paid: true, toPay: 1, id: TXN })
    : response(txn()) } });
  const unconfirmed = await changed.ports.payments.create({ amountMinor: 79000 });
  // A contradictory paid response is never trusted and never discarded: the transaction
  // id is returned so the owner can persist it and recover the real result later.
  assert.equal(unconfirmed.status, "UNCONFIRMED");
  assert.equal(unconfirmed.providerTransactionId, TXN);
});

test("an unverifiable create is UNCONFIRMED with its transaction id, not an exception", async () => {
  const mismatch = build({ routes: { "/transactions": () => response({ paymentUrl: "https://bank.example/pay/1", toPay: 1, id: TXN }) } });
  const unconfirmed = await mismatch.ports.payments.create({ amountMinor: 79000 });
  assert.equal(unconfirmed.status, "UNCONFIRMED");
  assert.equal(unconfirmed.providerTransactionId, TXN);
  const insecure = build({ routes: { "/transactions": () => response({ paymentUrl: "http://bank.example/pay/1", toPay: 79000, id: TXN }) } });
  const insecureResult = await insecure.ports.payments.create({ amountMinor: 79000 });
  assert.equal(insecureResult.status, "UNCONFIRMED");
  assert.equal(insecureResult.providerTransactionId, TXN);
});

test("paid create whose Admin verification fails keeps the transaction id", async () => {
  const { ports } = build({ routes: {
    "/transactions": (url) => url.endsWith("/transactions")
      ? response({ paid: true, toPay: 79000, id: TXN })
      : response({ code: "RESIDENCY_UPSTREAM_UNAVAILABLE" }, 503),
  } });
  const result = await ports.payments.create({ amountMinor: 79000 });
  assert.equal(result.status, "UNCONFIRMED");
  assert.equal(result.providerTransactionId, TXN);
  assert.equal(result.paymentUrl, null);
  assert.equal(result.reason, "RESIDENCY_UPSTREAM_UNAVAILABLE");
});

test("only an explicit provider refusal proves that no transaction was created", async () => {
  const rejected = build({ routes: { "/transactions": () => response({ code: "VALIDATION" }, 422) } });
  await assert.rejects(rejected.ports.payments.create({ amountMinor: 79000 }), (error) => {
    assert.equal(error.outcome, "REJECTED");
    return true;
  });
  const ambiguous = build({ routes: { "/transactions": () => response({ code: "INTERNAL" }, 500) } });
  await assert.rejects(ambiguous.ports.payments.create({ amountMinor: 79000 }), (error) => {
    assert.equal(error.outcome, "UNKNOWN");
    return true;
  });
});

test("an unusable return target is refused before the provider POST", async () => {
  const { ports, calls } = build();
  await assert.rejects(ports.payments.create({ amountMinor: 79000, successUrl: "http://insecure.example" }),
    /RESIDENCY_RETURN_TARGET_INVALID/);
  assert.equal(calls.some((call) => call.options?.method === "POST"), false);
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

test("CUP context read is non-refresh and exposes the same window", async () => {
  const { ports, calls } = build();
  const result = await ports.activation.read({ clientSubscriptionId: SUB });
  assert.equal(result.state, "ACTIVE");
  assert.equal(result.validFrom, "2026-11-18T09:05:00.000Z");
  assert.equal(result.validUntil, "2026-12-18T09:05:00.000Z");
  const context = calls.filter((call) => call.url.includes("residency-booking-context"));
  assert.equal(context.length, 1);
  assert.equal(calls.some((call) => call.url.includes("residency-booking-refresh")), false);
  assert.deepEqual(JSON.parse(context[0].options.body), { clientSubscriptionId: SUB });
});

test("CUP context read distinguishes explicit NOT_ACTIVE from a malformed context", async () => {
  const inactive = build({ routes: { "residency-booking-context": () => response({
    providerProductId: RESIDENCY_PRODUCT_ID, observedAt: "2026-11-18T09:06:00.000Z",
    context: { instance: { state: "PENDING" } } }) } });
  const inactiveResult = await inactive.ports.activation.read({ clientSubscriptionId: SUB });
  assert.equal(inactiveResult.state, "NOT_ACTIVE");
  assert.equal(inactiveResult.observedAt, "2026-11-18T09:06:00.000Z");

  const absent = build({ routes: { "residency-booking-context": () => response({
    providerProductId: RESIDENCY_PRODUCT_ID, observedAt: "2026-11-18T09:06:00.000Z", context: {} }) } });
  assert.equal((await absent.ports.activation.read({ clientSubscriptionId: SUB })).state, "NOT_ACTIVE");

  const malformedWindow = build({ routes: { "residency-booking-context": () => response({
    providerProductId: RESIDENCY_PRODUCT_ID, observedAt: "2026-11-18T09:06:00.000Z",
    context: { instance: { state: "ACTIVE", activeFrom: "2026-11-18T09:05:00.000Z" } } }) } });
  await assert.rejects(malformedWindow.ports.activation.read({ clientSubscriptionId: SUB }), /RESIDENCY_EVIDENCE_INVALID/);

  const noContext = build({ routes: { "residency-booking-context": () => response({
    providerProductId: RESIDENCY_PRODUCT_ID, observedAt: "2026-11-18T09:06:00.000Z" }) } });
  await assert.rejects(noContext.ports.activation.read({ clientSubscriptionId: SUB }), /RESIDENCY_EVIDENCE_INVALID/);

  const malformedInstance = build({ routes: { "residency-booking-context": () => response({
    providerProductId: RESIDENCY_PRODUCT_ID, observedAt: "2026-11-18T09:06:00.000Z",
    context: { instance: "garbage" } }) } });
  await assert.rejects(malformedInstance.ports.activation.read({ clientSubscriptionId: SUB }), /RESIDENCY_EVIDENCE_INVALID/);

  // A refresh is not a read-only answer: a non-ACTIVE response keeps the command
  // ambiguous instead of authorizing a retry from the same response.
  const refreshInactive = build({ routes: { "residency-booking-refresh": () => response({
    providerProductId: RESIDENCY_PRODUCT_ID, observedAt: "2026-11-18T09:06:00.000Z",
    context: { instance: { state: "PENDING" } } }) } });
  await assert.rejects(refreshInactive.ports.activation.activate({ clientSubscriptionId: SUB }), /RESIDENCY_EVIDENCE_INVALID/);
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

test("a PAID zero-payment transaction is accepted without forcing the card amount", async () => {
  const { ports } = build({ routes: { "/api/v1/transactions/": () => response(txn({ toPay: 0 })) } });
  const result = await ports.payments.read({ amountMinor: 79000, providerTransactionId: TXN });
  assert.equal(result.status, "PAID");
});

test("a Viva subscriptions 404 is UNAVAILABLE, never NONE", async () => {
  const { ports } = build({ routes: { "/subscriptions?": () => response({ code: "NOT_FOUND" }, 404) } });
  const result = await ports.status.read();
  assert.equal(result.state, "UNAVAILABLE");
  assert.equal(result.reason, "NOT_FOUND");
});

test("the owned subscription read pages to completeness and fails partial reads", async () => {
  const rows = Array.from({ length: 200 }, (_, index) => subscription({
    subscriptionId: "00000000-0000-4000-8000-" + String(1000 + index).padStart(12, "0"),
    productId: "other", purchaseDate: "2026-01-01T00:00:00.000Z",
  }));
  const newest = subscription({ subscriptionId: SUB, purchaseDate: "2026-11-18T09:05:00.000Z" });
  const paged = build({ routes: { "/subscriptions?": (url) => url.includes("page=0") ? response(rows) : response([newest]) } });
  assert.equal((await paged.ports.activation.findInstance({ productId: RESIDENCY_PRODUCT_ID })).clientSubscriptionId, SUB);
  const partial = build({ routes: { "/subscriptions?": (url) => url.includes("page=0")
    ? response({ items: rows, total: 201 }) : response({ items: [], total: 201 }) } });
  await assert.rejects(partial.ports.activation.findInstance({ productId: RESIDENCY_PRODUCT_ID }), /RESIDENCY_SUBSCRIPTIONS_PARTIAL/);
});

test("a duplicate subscription id across pages fails closed", async () => {
  const row = subscription({ productId: "other" });
  const rows = Array.from({ length: 199 }, (_, index) => subscription({
    subscriptionId: "00000000-0000-4000-8000-" + String(index + 2).padStart(12, "0"), productId: "other",
  }));
  const { ports } = build({ routes: { "/subscriptions?": (url) => url.includes("page=0") ? response([row, ...rows]) : response([row]) } });
  await assert.rejects(ports.activation.findInstance({ productId: RESIDENCY_PRODUCT_ID }), /RESIDENCY_SUBSCRIPTIONS_INVALID/);
});

function transactionPage(rows, overrides = {}) {
  return { content: rows, number: 0, totalPages: rows.length ? 1 : 0, totalElements: rows.length,
    numberOfElements: rows.length, last: true, ...overrides };
}

function externalRow(overrides = {}) {
  return { id: TXN, clientId: CLIENT, productId: RESIDENCY_PRODUCT_ID, status: "UNPAID",
    createDate: "2026-11-18T08:50:00.000Z", ...overrides };
}

test("the external list reads the exact client, product and Moscow calendar window", async () => {
  const { ports, calls } = build({ routes: { "/api/v1/transactions?": () => response(transactionPage([externalRow()])) } });
  const result = await ports.external.list({ sinceIso: "2026-10-19T09:00:00.000Z", untilIso: "2026-11-18T09:00:00.000Z" });
  assert.deepEqual(result.transactions, [{ transactionId: TXN, status: "UNPAID", state: "OPEN",
    createdAt: "2026-11-18T08:50:00.000Z" }]);
  const listCall = calls.find((call) => call.url.includes("/api/v1/transactions?"));
  const url = listCall.url;
  const query = new URL(url).searchParams;
  assert.equal(query.get("clientIds"), CLIENT);
  assert.equal(query.get("productIds"), RESIDENCY_PRODUCT_ID);
  assert.equal(query.get("dateFrom"), "2026-10-19");
  assert.equal(query.get("dateTo"), "2026-11-18");
  assert.equal(query.get("size"), "100");
  assert.equal(listCall.options.headers.Authorization, "Bearer " + ADMIN);
  assert.equal(calls[0].url.endsWith("/profile"), true);
  assert.equal(calls[0].options.headers.Authorization, "Bearer " + ACTOR);
});

test("the external list fails closed without an admin token", async () => {
  const { ports } = build({ getAdminToken: () => "" });
  await assert.rejects(ports.external.list({ sinceIso: "2026-10-19T09:00:00.000Z", untilIso: "2026-11-18T09:00:00.000Z" }),
    /RESIDENCY_ADMIN_TOKEN_UNAVAILABLE/);
});

test("the external list refuses a transaction of another client", async () => {
  const { ports } = build({ routes: { "/api/v1/transactions?": () => response(transactionPage([
    externalRow({ clientId: "00000000-0000-4000-8000-000000000099" })])) } });
  await assert.rejects(ports.external.list({ sinceIso: "2026-10-19T09:00:00.000Z", untilIso: "2026-11-18T09:00:00.000Z" }),
    /RESIDENCY_EXTERNAL_OWNERSHIP_CONFLICT/);
});

test("the external list refuses a partial or ambiguous page", async () => {
  const partial = build({ routes: { "/api/v1/transactions?": () => response(transactionPage([externalRow()], {
    totalPages: 2, last: false })) } });
  await assert.rejects(partial.ports.external.list({ sinceIso: "2026-10-19T09:00:00.000Z", untilIso: "2026-11-18T09:00:00.000Z" }),
    /RESIDENCY_EXTERNAL_ATTEMPTS_PARTIAL/);
  const ambiguous = build({ routes: { "/api/v1/transactions?": () => response(transactionPage([
    externalRow({ transactionId: TXN, id: "00000000-0000-4000-8000-000000000098" })])) } });
  await assert.rejects(ambiguous.ports.external.list({ sinceIso: "2026-10-19T09:00:00.000Z", untilIso: "2026-11-18T09:00:00.000Z" }),
    /RESIDENCY_EXTERNAL_ATTEMPTS_INVALID/);
});

test("an unknown provider status is surfaced as UNKNOWN, never as settled", async () => {
  const { ports } = build({ routes: { "/api/v1/transactions?": () => response(transactionPage([
    externalRow({ status: "SOMETHING_NEW" })])) } });
  const result = await ports.external.list({ sinceIso: "2026-10-19T09:00:00.000Z", untilIso: "2026-11-18T09:00:00.000Z" });
  assert.equal(result.transactions[0].state, "UNKNOWN");
});
