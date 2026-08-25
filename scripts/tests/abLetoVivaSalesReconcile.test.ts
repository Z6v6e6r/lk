import assert from "node:assert/strict";
import test from "node:test";
import {
  AB_LETO_PLAN_CONFIGS,
  buildVivaServiceTokenRequestBody,
  buildSaleRecordFromVivaTransaction,
  classifyVivaTransaction,
  isConflictingExistingRecord,
  isBillableVivaTransaction,
  parseMoscowBoundary,
} from "../reconcile_ab_leto_viva_sales.mjs";

const friendship = AB_LETO_PLAN_CONFIGS.friendship;
const academy = AB_LETO_PLAN_CONFIGS.academy;
const ra = AB_LETO_PLAN_CONFIGS.ra;

test("ab leto Viva reconciliation resolves service authorization without reading flow credentials", () => {
  assert.equal(
    buildVivaServiceTokenRequestBody({
      VIVACRM_TOKEN_REQUEST_BODY: "configured-token-body",
      VIVA_SERVICE_USERNAME: "ignored-user",
      VIVA_SERVICE_PASSWORD: "ignored-password",
    }),
    "configured-token-body",
  );
  const perField = new URLSearchParams(buildVivaServiceTokenRequestBody({
    VIVA_SERVICE_USERNAME: "service-user",
    VIVA_SERVICE_PASSWORD: "service-password",
    VIVA_SERVICE_CLIENT_ID: "service-client",
  }));
  assert.equal(perField.get("username"), "service-user");
  assert.equal(perField.get("password"), "service-password");
  assert.equal(perField.get("client_id"), "service-client");
  assert.equal(buildVivaServiceTokenRequestBody({}), null);
});

test("ab leto Viva reconciliation treats paid toPay rows as billable", () => {
  const transaction = {
    id: "tx-paid-friendship",
    status: "PAID",
    toPay: 980000,
    sum: 980000,
    paymentDate: "2026-06-24T10:00:00+03:00",
    products: [{ id: friendship.productId, name: friendship.productName }],
  };

  assert.equal(classifyVivaTransaction(transaction, friendship), "billable");
  assert.equal(isBillableVivaTransaction(transaction, friendship), true);
});

test("ab leto Viva reconciliation excludes zero toPay rows by default", () => {
  const transaction = {
    id: "tx-zero-friendship",
    status: "PAID",
    toPay: 0,
    sum: 980000,
    paymentDate: "2026-06-24T10:00:00+03:00",
    products: [{ id: friendship.productId, name: friendship.productName }],
  };

  assert.equal(classifyVivaTransaction(transaction, friendship), "zero_to_pay");
  assert.equal(isBillableVivaTransaction(transaction, friendship), false);
  assert.equal(isBillableVivaTransaction(transaction, friendship, { includeZeroToPay: true }), true);
});

test("ab leto Viva reconciliation does not classify UNPAID rows as billable", () => {
  const transaction = {
    id: "tx-unpaid-friendship",
    status: "UNPAID",
    toPay: 980000,
    sum: 980000,
    paymentDate: "2026-06-24T10:00:00+03:00",
    products: [{ id: friendship.productId, name: friendship.productName }],
  };

  assert.equal(classifyVivaTransaction(transaction, friendship), "status_not_paid");
  assert.equal(isBillableVivaTransaction(transaction, friendship), false);
});

test("ab leto Viva reconciliation builds canonical local sale fields", () => {
  const transaction = {
    id: "tx-paid-friendship",
    status: "PAID",
    toPay: 980000,
    sum: 980000,
    paymentDate: "2026-06-24T10:00:00+03:00",
    createDate: "2026-06-24T09:58:00+03:00",
    client: { id: "client-1", phone: "+7 (999) 111-22-33" },
    products: [{ id: friendship.productId, name: friendship.productName }],
  };

  const record = buildSaleRecordFromVivaTransaction({
    transaction,
    config: friendship,
    nowIso: "2026-06-26T10:00:00.000Z",
    studio: { id: "studio-1", name: "Братиславская" },
  });

  assert.equal(record.inventoryId, "ab_leto_2026_50_v1");
  assert.equal(record.counterKey, "friendship");
  assert.equal(record.saleType, "summer_campaign");
  assert.equal(record.campaignKey, "summer_padel_friendship_2026");
  assert.equal(record.productId, friendship.productId);
  assert.equal(record.status, "PAID");
  assert.equal(record.toPayMinor, 980000);
  assert.equal(record.amountMinor, 980000);
  assert.equal(record.clientPhone, "79991112233");
  assert.equal(record.paymentRef, "ab_leto_reconcile_friendship_tx-paid-friendship");
});

test("ab leto Viva reconciliation parses Moscow date-only boundaries", () => {
  assert.equal(parseMoscowBoundary("2026-06-22").iso, "2026-06-21T21:00:00.000Z");
  assert.equal(parseMoscowBoundary("2026-06-26", true).iso, "2026-06-26T20:59:59.999Z");
});

test("ab leto Viva reconciliation skips conflicting Sirius friendship records", () => {
  const transaction = {
    id: "tx-paid-friendship",
    status: "PAID",
    toPay: 980000,
    sum: 980000,
    paymentDate: "2026-06-26T14:21:10+03:00",
    products: [{ id: friendship.productId, name: friendship.productName }],
  };
  const saleRecord = buildSaleRecordFromVivaTransaction({
    transaction,
    config: friendship,
    nowIso: "2026-06-28T10:00:00.000Z",
  });

  assert.equal(
    isConflictingExistingRecord(
      {
        inventoryId: null,
        counterKey: "sirius_friendship",
        campaignKey: "summer_padel_sirius_friendship_2026",
        productId: friendship.productId,
        status: "PAYMENT_PENDING",
      },
      saleRecord,
    ),
    true,
  );
  assert.equal(
    isConflictingExistingRecord(
      {
        inventoryId: "ab_leto_2026_50_v1",
        counterKey: "friendship",
        campaignKey: "summer_padel_friendship_2026",
        productId: friendship.productId,
        status: "PAYMENT_PENDING",
      },
      saleRecord,
    ),
    false,
  );
});

test("ab leto Viva reconciliation exposes direct-product configs for academy and ra", () => {
  assert.equal(academy.counterKey, "academy");
  assert.equal(academy.saleType, "direct_product");
  assert.equal(academy.planKey, null);
  assert.equal(academy.productId, "9eb8a7a4-c195-492a-95e4-3fb82899ac10");

  assert.equal(ra.counterKey, "ra");
  assert.equal(ra.saleType, "direct_product");
  assert.equal(ra.planKey, null);
  assert.equal(ra.productId, "b91e14d1-fe6e-4d0b-be39-3e45ad86b759");
});
