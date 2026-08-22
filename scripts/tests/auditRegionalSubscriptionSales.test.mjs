import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRegionalSubscriptionSalesAudit,
  classifyProviderTransaction,
  parseCliArgs,
} from "../audit_regional_subscription_sales.mjs";

const PRODUCT_ID = "piter-product-raw-id";
const INVENTORY_ID = "piter_friendship_12m_2026_v1";

const providerTransaction = (id, overrides = {}) => ({
  id,
  status: "PAID",
  toPay: 1980000,
  client: { id: `client-${id}`, phone: "+79990000000" },
  products: [{ id: PRODUCT_ID }],
  ...overrides,
});

test("regional sales audit reports five provider sales versus two ledger rows without leaking raw ids", () => {
  const providerIds = ["provider-tx-1", "provider-tx-2", "provider-tx-3", "provider-tx-4", "provider-tx-5"];
  const clientIds = providerIds.map((id) => `client-${id}`);
  const providerPayload = {
    content: [
      ...providerIds.map((id) => providerTransaction(id)),
      providerTransaction("provider-tx-1"),
      providerTransaction("refunded-tx", { refundSum: 100 }),
      providerTransaction("pending-tx", { status: "PENDING" }),
      providerTransaction("wrong-product-tx", { products: [{ id: "another-product" }] }),
      { status: "PAID", products: [{ id: PRODUCT_ID }] },
    ],
  };
  const ledgerPayload = [
    {
      id: "local-row-id-1",
      transactionId: "provider-tx-1",
      status: "PAID",
      inventoryId: INVENTORY_ID,
    },
    { transactionId: "provider-tx-2", status: "PAID", inventoryId: INVENTORY_ID },
    { transactionId: "ignored-cancelled", status: "CANCELLED", inventoryId: INVENTORY_ID },
    { transactionId: "ignored-other-inventory", status: "PAID", inventoryId: "other" },
  ];

  const report = buildRegionalSubscriptionSalesAudit({
    providerPayload,
    ledgerPayload,
    counterKey: "piter_friendship",
    productId: PRODUCT_ID,
    inventoryId: INVENTORY_ID,
    batchSize: 100,
    totalLimit: 400,
    createdAt: "2026-08-22T15:00:00.000Z",
  });

  assert.equal(report.mode, "READ_ONLY_DRY_RUN");
  assert.equal(report.provider.uniquePaidTransactions, 5);
  assert.equal(report.provider.duplicates, 1);
  assert.equal(report.provider.refunded, 1);
  assert.equal(report.provider.statusNotPaid, 1);
  assert.equal(report.provider.productMismatch, 1);
  assert.equal(report.provider.missingTransactionId, 1);
  assert.equal(report.ledger.uniquePaidTransactions, 2);
  assert.equal(report.drift.detected, true);
  assert.equal(report.drift.missingInLedgerCount, 3);
  assert.equal(report.drift.extraInLedgerCount, 0);
  assert.deepEqual(report.counters.providerTruth, {
    soldCount: 5,
    remainingCount: 395,
    batchIndex: 1,
    batchRemaining: 95,
  });
  assert.deepEqual(report.counters.ledgerView, {
    soldCount: 2,
    remainingCount: 398,
    batchIndex: 1,
    batchRemaining: 98,
  });
  assert.equal(report.mutation.supported, false);
  assert.equal(report.mutation.applied, false);

  const serialized = JSON.stringify(report);
  for (const rawId of [...providerIds, ...clientIds, PRODUCT_ID]) {
    assert.equal(serialized.includes(rawId), false, `must not leak ${rawId}`);
  }
});

test("regional sales audit detects an extra paid ledger transaction", () => {
  const report = buildRegionalSubscriptionSalesAudit({
    providerPayload: [providerTransaction("provider-tx-1")],
    ledgerPayload: [
      { transactionId: "provider-tx-1", status: "PAID", inventoryId: INVENTORY_ID },
      { transactionId: "ledger-only-tx", status: "PAID", inventoryId: INVENTORY_ID },
    ],
    counterKey: "piter_friendship",
    productId: PRODUCT_ID,
    inventoryId: INVENTORY_ID,
    batchSize: 100,
    totalLimit: 400,
  });

  assert.equal(report.drift.missingInLedgerCount, 0);
  assert.equal(report.drift.extraInLedgerCount, 1);
});

test("provider classification excludes zero-value and non-paid transactions", () => {
  assert.equal(classifyProviderTransaction(providerTransaction("paid"), PRODUCT_ID), "billable");
  assert.equal(
    classifyProviderTransaction(providerTransaction("zero", { toPay: 0 }), PRODUCT_ID),
    "zero_to_pay",
  );
  assert.equal(
    classifyProviderTransaction(providerTransaction("pending", { paymentStatus: "PENDING", status: undefined }), PRODUCT_ID),
    "status_not_paid",
  );
});

test("regional sales audit permanently rejects apply mode and unknown options", () => {
  assert.throws(
    () => parseCliArgs(["--apply"]),
    /permanently read-only/,
  );
  assert.throws(
    () => parseCliArgs(["--mongo-uri", "mongodb://example"]),
    /Unsupported option/,
  );
});
