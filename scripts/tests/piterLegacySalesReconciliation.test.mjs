import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertPiterLegacyReconciliationPostcondition,
  assertPiterLegacyReconciliationPreconditions,
  buildPiterLegacyReconciliationPacket,
  redactPiterLegacyReconciliationPacket,
  validatePiterLegacyReconciliationPacket,
} from "../lib/piterLegacySalesReconciliation.mjs";
import {
  buildPiterAtomicActivationPacket,
  digestPiterLegacyLedgerRows,
  derivePiterLegacyBaseline,
  sha256,
  stableJson,
} from "../lib/piterAtomicActivationContract.mjs";
import {
  parseArgs as parsePrepareArgs,
  prepareReconciliationPacket,
} from "../prepare_piter_legacy_reconciliation_packet.mjs";
import {
  parseArgs as parseManageArgs,
  runPiterLegacyReconciliation,
} from "../manage_piter_legacy_reconciliation.mjs";

const NOW = new Date("2026-09-04T10:00:00.000Z");
const CAPTURED_AT = "2026-09-04T09:59:30.000Z";
const PRODUCT_ID = "8bf334ba-3050-4017-b40a-7eef2db1eb16";
const INVENTORY_ID = "piter_friendship_12m_2026_v1";
const COUNTER_KEY = "piter_friendship";
const FLOW_BYTES = Buffer.from("reviewed candidate flow\n");
const FLOW_SHA = sha256(FLOW_BYTES);
const HOST_SHA = sha256("host-id");
const MONGO_IDENTITY = {
  setName: "lk-prod-rs",
  hosts: ["mongo-a:27017", "mongo-b:27017"],
  me: "mongo-a:27017",
  primary: "mongo-a:27017",
};
const MONGO_SHA = sha256(stableJson(MONGO_IDENTITY));

const client = (suffix) => ({ id: `client-${suffix}`, phone: `7999000000${suffix}` });
const line = () => ({ id: PRODUCT_ID, discount: 3_700_000, cost: 5_680_000, count: 1 });
const transaction = (suffix, overrides = {}) => ({
  id: `tx-${suffix}`,
  status: "PAID",
  toPay: 1_980_000,
  sum: 5_680_000,
  discount: 3_700_000,
  paymentDate: "2026-09-01T08:01:00.000Z",
  client: client(suffix),
  products: [line()],
  ...overrides,
});
const ledgerRow = (suffix, overrides = {}) => ({
  _id: `sale-${suffix}`,
  inventoryId: INVENTORY_ID,
  counterKey: COUNTER_KEY,
  paymentRef: `pay-${suffix}`,
  transactionId: `tx-${suffix}`,
  productId: PRODUCT_ID,
  status: "PAID",
  amountMinor: 1_980_000,
  providerProductCostMinor: 5_680_000,
  discountMinor: 3_700_000,
  clientId: `client-${suffix}`,
  clientPhone: `7999000000${suffix}`,
  createdAt: "2026-09-01T08:00:00.000Z",
  updatedAt: "2026-09-01T08:01:00.000Z",
  ...overrides,
});
const refundedSubscription = (suffix, transactionSuffix = suffix, overrides = {}) => ({
  subscriptionId: `subscription-${suffix}`,
  transactionId: `tx-${transactionSuffix}`,
  status: "REFUNDED",
  product: { id: PRODUCT_ID },
  refundSum: 1_969_000,
  refundedAt: "2026-09-03T12:00:00.000Z",
  visitsLeft: 362,
  bookings: [{ id: "booking-redacted" }],
  ...overrides,
});

const inputs = (overrides = {}) => {
  const rows = [
    ledgerRow("1"),
    ledgerRow("2", {
      status: "PAYMENT_PENDING",
      paidAt: null,
      expiresAt: "2026-09-03T08:00:00.000Z",
    }),
    ledgerRow("3", { paidAt: "2026-09-01T08:02:00.000Z" }),
  ];
  const transactions = [
    transaction("1"),
    transaction("2", {
      status: "UNPAID",
      toPay: 1_980_000,
      sum: 5_680_000,
      paymentDueDate: "2026-09-03T08:00:00.000Z",
      paymentDate: null,
    }),
    transaction("3", {
      status: "REFUND",
      toPay: 1_980_000,
      sum: 5_680_000,
      refundSum: 1_969_000,
      refundedAt: "2026-09-03T12:00:00.000Z",
    }),
    transaction("4", {
      status: "REFUND",
      toPay: 1_980_000,
      sum: 5_680_000,
      refundSum: 1_969_000,
      refundedAt: "2026-09-03T12:00:00.000Z",
    }),
  ];
  const refundIds = ["tx-3", "tx-4"];
  return {
    ledgerEvidence: {
      formatVersion: 1,
      complete: true,
      source: "MONGO_LK_TOURNAMENT_SUBSCRIPTION_SALES",
      capturedAt: CAPTURED_AT,
      query: { inventoryId: INVENTORY_ID, counterKey: COUNTER_KEY },
      pagination: { complete: true, pages: 1, rowCount: rows.length },
      rows,
    },
    providerEvidence: {
      formatVersion: 1,
      complete: true,
      source: "VIVA_TRANSACTIONS",
      capturedAt: "2026-09-04T09:59:35.000Z",
      query: { productId: PRODUCT_ID },
      pagination: { complete: true, pages: 1, rowCount: transactions.length },
      transactions,
    },
    subscriptionEvidence: {
      formatVersion: 1,
      complete: true,
      source: "VIVA_CLIENT_SUBSCRIPTIONS",
      capturedAt: "2026-09-04T09:59:40.000Z",
      query: { productId: PRODUCT_ID, transactionIds: refundIds, includeFinished: true },
      pagination: { complete: true, pages: 1, rowCount: 2 },
      clients: [
        {
          clientId: "client-3",
          complete: true,
          pagination: { complete: true, pages: 1, rowCount: 1 },
          subscriptions: [refundedSubscription("3")],
        },
        {
          clientId: "client-4",
          complete: true,
          pagination: { complete: true, pages: 1, rowCount: 1 },
          subscriptions: [refundedSubscription("4")],
        },
      ],
    },
    candidateReport: {
      ok: true,
      deploymentId: "piter-atomic-sales-20260903",
      sourceSha256: "a".repeat(64),
      candidateSha256: FLOW_SHA,
      ledgerActivationRequired: true,
      deploymentPerformed: false,
      activationPerformed: false,
    },
    productId: PRODUCT_ID,
    createdAt: NOW.toISOString(),
    ...overrides,
  };
};

const buildPacket = (overrides = {}) => buildPiterLegacyReconciliationPacket(inputs(overrides));
const reconciliationReceipt = (packet) => ({
  operationId: packet.operationId,
  evidenceDigest: packet.evidence.evidenceDigest,
  providerOnlyRefundHashes: packet.providerOnlyRefunds.map((item) => item.transactionHash),
});

test("reconciliation packet plans only expired UNPAID and exact REFUNDED changes", () => {
  const packet = buildPacket();
  assert.equal(packet.expected.changeCount, 2);
  assert.equal(packet.expected.failedCount, 1);
  assert.equal(packet.expected.refundedCount, 1);
  assert.equal(packet.expected.providerOnlyRefundCount, 1);
  assert.equal(packet.expected.paidCountAfter, 1);
  assert.deepEqual(packet.changes.map((item) => item.action).sort(), ["MARK_FAILED", "MARK_REFUNDED"]);
  const report = redactPiterLegacyReconciliationPacket(packet);
  const text = JSON.stringify(report);
  assert.equal(text.includes("tx-2"), false);
  assert.equal(text.includes("pay-2"), false);
  assert.equal(text.includes("client-2"), false);
  assert.equal(text.includes("subscription-3"), false);
});

test("realistic Viva PAID totals and provider-only full-discount issues preserve cash baseline", () => {
  const data = inputs();
  data.providerEvidence.transactions.push(transaction("free", {
    toPay: 0, discount: 5_680_000,
    products: [{ ...line(), discount: 5_680_000 }],
  }));
  data.providerEvidence.pagination.rowCount += 1;
  const packet = buildPiterLegacyReconciliationPacket(data);
  assert.equal(packet.expected.paidCountAfter, 1);
  assert.equal(packet.expected.changeCount, 2);
  assert.equal(packet.expected.providerOnlyFreeIssueCount, 1);
  assert.equal(packet.providerOnlyFreeIssues[0].reason, "FULL_DISCOUNT_ZERO_AMOUNT");
  assert.equal(JSON.stringify(redactPiterLegacyReconciliationPacket(packet)).includes("tx-free"), false);
  assert.doesNotThrow(() => validatePiterLegacyReconciliationPacket(packet, { now: NOW }));
  const rows = structuredClone(data.ledgerEvidence.rows);
  for (const change of packet.changes) Object.assign(rows.find(row => row.transactionId === change.transactionId), change.set);
  const baseline = derivePiterLegacyBaseline({ ledgerRows: rows, providerTransactions: data.providerEvidence.transactions,
    productId: PRODUCT_ID, providerCapturedAt: data.providerEvidence.capturedAt, reconciliationReceipt: reconciliationReceipt(packet) });
  assert.equal(baseline.paidCount, 1);
  assert.deepEqual(baseline.legacyPaymentRefs, ["pay-1"]);
});

test("PAID validation rejects old balance interpretation, inconsistent amounts and ambiguous free issues", () => {
  for (const overrides of [
    { toPay: 0, sum: 1_980_000 }, { toPay: 0 }, { toPay: null }, { toPay: "1980000" },
    { sum: 1_980_000 }, { discount: 0 }, { discount: null },
    { paymentDate: null }, { paymentDate: "invalid" }, { paymentDate: "2026-09-05T00:00:00Z" },
    { refundSum: -1 }, { refundSum: "1980000" },
    { products: [{ ...line(), count: 2 }] }, { products: [{ ...line(), cost: 1_980_000 }] },
    { products: [{ ...line(), refunded: true }] },
    { clientId: "different-client" }, { clientPhone: "79990000009" },
    { products: [{ ...line(), productId: "conflicting-product" }] },
  ]) {
    const data = inputs(); Object.assign(data.providerEvidence.transactions[0], overrides);
    assert.throws(() => buildPiterLegacyReconciliationPacket(data), /financial facts mismatch/, JSON.stringify(overrides));
  }
  const conflict = inputs();
  Object.assign(conflict.providerEvidence.transactions[0], { toPay: 0, discount: 5_680_000, products: [{ ...line(), discount: 5_680_000 }] });
  assert.throws(() => buildPiterLegacyReconciliationPacket(conflict), /free provider issue.*conflicts/);
});

test("reconciliation fails closed on live UNPAID, client drift, or incomplete refund evidence", () => {
  const liveUnpaid = inputs();
  liveUnpaid.providerEvidence.transactions[1].paymentDueDate = "2026-09-04T10:30:00.000Z";
  assert.throws(() => buildPiterLegacyReconciliationPacket(liveUnpaid), /not safely expired/);

  const clientDrift = inputs();
  clientDrift.ledgerEvidence.rows[1].clientId = "different-client";
  assert.throws(() => buildPiterLegacyReconciliationPacket(clientDrift), /client mismatch/);

  const activeRefund = inputs();
  activeRefund.subscriptionEvidence.clients[0].subscriptions[0].status = "ACTIVE";
  assert.throws(() => buildPiterLegacyReconciliationPacket(activeRefund), /not exact/);

  const missingProviderPaid = inputs();
  missingProviderPaid.ledgerEvidence.rows = missingProviderPaid.ledgerEvidence.rows.slice(1);
  missingProviderPaid.ledgerEvidence.pagination.rowCount = 2;
  assert.throws(() => buildPiterLegacyReconciliationPacket(missingProviderPaid), /missing from the ledger/);
});

test("ledger drift invalidates the reviewed packet before any mutation", () => {
  const packet = buildPacket();
  const rows = structuredClone(inputs().ledgerEvidence.rows);
  assert.doesNotThrow(() => assertPiterLegacyReconciliationPreconditions(packet, rows, { now: NOW }));
  rows[1].updatedAt = "2026-09-04T09:59:59.000Z";
  assert.throws(
    () => assertPiterLegacyReconciliationPreconditions(packet, rows, { now: NOW }),
    /preimage drifted/,
  );
});

test("activation baseline accepts only marked reconciled terminal rows", () => {
  const packet = buildPacket();
  const rows = structuredClone(inputs().ledgerEvidence.rows);
  for (const change of packet.changes) {
    const row = rows.find((item) => item.transactionId === change.transactionId);
    Object.assign(row, change.set);
  }
  const baseline = derivePiterLegacyBaseline({
    ledgerRows: rows,
    providerTransactions: inputs().providerEvidence.transactions,
    productId: PRODUCT_ID,
    providerCapturedAt: inputs().providerEvidence.capturedAt,
    reconciliationReceipt: reconciliationReceipt(packet),
  });
  assert.equal(baseline.paidCount, 1);
  assert.equal(baseline.takenCount, 1);

  delete rows[1].piterLegacyReconciliation;
  assert.throws(() => derivePiterLegacyBaseline({
    ledgerRows: rows,
    providerTransactions: inputs().providerEvidence.transactions,
    productId: PRODUCT_ID,
    providerCapturedAt: inputs().providerEvidence.capturedAt,
    reconciliationReceipt: reconciliationReceipt(packet),
  }), /marker mismatch/);
});

test("refund evidence rejects nested accidental IDs and inconsistent provider amounts", () => {
  const nestedOnly = inputs();
  const subscription = nestedOnly.subscriptionEvidence.clients[0].subscriptions[0];
  delete subscription.transactionId;
  delete subscription.product;
  subscription.history = [{ transactionId: "tx-3", productId: PRODUCT_ID }];
  assert.throws(() => buildPiterLegacyReconciliationPacket(nestedOnly), /not exact/);

  const wrongAmount = inputs();
  wrongAmount.providerEvidence.transactions[2].toPay = 1_970_000;
  assert.throws(() => buildPiterLegacyReconciliationPacket(wrongAmount), /refunded provider amount mismatch/);
});

test("packet validator rejects a self-digested extended evidence window", () => {
  const packet = buildPacket();
  packet.expiresAt = "2026-09-04T11:00:00.000Z";
  delete packet.planDigest;
  const unsigned = packet;
  packet.planDigest = sha256(stableJson(unsigned));
  assert.throws(() => validatePiterLegacyReconciliationPacket(packet, { now: NOW }), /expired or future-dated/);
});

test("packet rebuild is idempotent only for rows with exact reconciliation markers", () => {
  const firstPacket = buildPacket();
  const reconciled = inputs();
  for (const change of firstPacket.changes) {
    const row = reconciled.ledgerEvidence.rows.find((item) => item.transactionId === change.transactionId);
    Object.assign(row, change.set);
  }
  const secondPacket = buildPiterLegacyReconciliationPacket(reconciled);
  assert.equal(secondPacket.expected.changeCount, 0);
  assert.deepEqual(secondPacket.expected.unchanged, { paid: 1, failed: 1, refunded: 1 });

  delete reconciled.ledgerEvidence.rows[1].piterLegacyReconciliation;
  assert.throws(
    () => buildPiterLegacyReconciliationPacket(reconciled),
    /existing reconciliation marker mismatch/,
  );
});

test("atomic activation links the exact applied reconciliation and provider-only refund proof", () => {
  const source = inputs();
  const reconciliationPacket = buildPiterLegacyReconciliationPacket(source);
  const rows = structuredClone(source.ledgerEvidence.rows);
  for (const change of reconciliationPacket.changes) {
    Object.assign(rows.find((row) => row.transactionId === change.transactionId), change.set);
  }
  const receiptUnsigned = {
    formatVersion: 1,
    kind: "PADLHUB_PITER_LEGACY_SALES_RECONCILIATION_APPLY_RECEIPT_V1",
    appliedAt: NOW.toISOString(),
    mutationPerformed: true,
    operationId: reconciliationPacket.operationId,
    planDigest: reconciliationPacket.planDigest,
    evidenceDigest: reconciliationPacket.evidence.evidenceDigest,
    deployment: reconciliationPacket.deployment,
    target: reconciliationPacket.target,
    legacyLedgerDigest: digestPiterLegacyLedgerRows(rows),
    exactPostimageDigest: "c".repeat(64),
    forensicSnapshotSha256: "d".repeat(64),
    hostIdentitySha256: HOST_SHA,
    mongoIdentitySha256: MONGO_SHA,
    canonicalFlowSha256: FLOW_SHA,
    changeCount: reconciliationPacket.changes.length,
    providerOnlyRefundHashes: reconciliationPacket.providerOnlyRefunds.map((item) => item.transactionHash).sort(),
  };
  const reconciliationApplyReceipt = {
    ...receiptUnsigned,
    receiptDigest: sha256(stableJson(receiptUnsigned)),
  };
  const activation = {
    ledgerEvidence: { ...source.ledgerEvidence, rows },
    providerEvidence: source.providerEvidence,
    productEvidence: {
      formatVersion: 1,
      source: "VIVA_PRODUCTS",
      complete: true,
      capturedAt: "2026-09-04T09:59:45.000Z",
      query: { productId: PRODUCT_ID },
      pagination: { complete: true, pages: 1, rowCount: 1 },
      products: [{
        id: PRODUCT_ID, productType: "SUBSCRIPTION", cost: 5_680_000,
        activationDays: 27, validityDays: 365, visits: 365,
      }],
    },
    bindingEvidence: {
      formatVersion: 1,
      source: "NODE_RED_GLOBAL_CONTEXT",
      complete: true,
      capturedAt: "2026-09-04T09:59:45.000Z",
      query: { key: "summer_subscription_piter_friendship_product_id" },
      pagination: { complete: true, pages: 1, rowCount: 1 },
      values: [{ key: "summer_subscription_piter_friendship_product_id", value: PRODUCT_ID }],
    },
    candidateReport: {
      ...source.candidateReport,
      sourceNodeCount: 100,
      candidateNodeCount: 107,
    },
    reconciliationPacket,
    reconciliationApplyReceipt,
    productId: PRODUCT_ID,
    createdAt: NOW.toISOString(),
  };
  const packet = buildPiterAtomicActivationPacket(activation);
  assert.equal(packet.reconciliation.planDigest, reconciliationPacket.planDigest);
  assert.equal(packet.reconciliation.providerOnlyRefundHashes.length, 1);

  const laterActivation = structuredClone(activation);
  laterActivation.createdAt = "2026-09-04T11:00:00.000Z";
  laterActivation.ledgerEvidence.capturedAt = "2026-09-04T10:59:30.000Z";
  laterActivation.providerEvidence.capturedAt = "2026-09-04T10:59:35.000Z";
  laterActivation.productEvidence.capturedAt = "2026-09-04T10:59:40.000Z";
  laterActivation.productEvidence.products[0].capturedAt = undefined;
  laterActivation.bindingEvidence.capturedAt = "2026-09-04T10:59:45.000Z";
  assert.doesNotThrow(() => buildPiterAtomicActivationPacket(laterActivation));

  assert.throws(
    () => buildPiterAtomicActivationPacket({ ...activation, reconciliationPacket: null }),
    /reconciliation packet is required/,
  );
  assert.throws(
    () => buildPiterAtomicActivationPacket({ ...activation, reconciliationApplyReceipt: null }),
    /apply receipt is required/,
  );
  const wrongTerminal = structuredClone(activation);
  wrongTerminal.providerEvidence.transactions[2].status = "FAILED";
  assert.throws(() => buildPiterAtomicActivationPacket(wrongTerminal), /reconciliation packet scope mismatch/);
});

test("packet writer is offline, private, and rejects apply", () => {
  assert.throws(() => parsePrepareArgs(["--apply"]), /permanently offline/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piter-reconcile-packet-"));
  const source = inputs();
  const keys = {
    ledgerFile: "ledgerEvidence",
    providerFile: "providerEvidence",
    subscriptionFile: "subscriptionEvidence",
    candidateReport: "candidateReport",
  };
  const options = { productId: PRODUCT_ID, outputDir: path.join(root, "private") };
  for (const [option, key] of Object.entries(keys)) {
    const file = path.join(root, `${option}.json`);
    fs.writeFileSync(file, JSON.stringify(source[key]));
    options[option] = file;
  }
  const report = prepareReconciliationPacket(options, { now: () => NOW });
  assert.equal(report.mutationPerformed, false);
  assert.equal(fs.statSync(options.outputDir).mode & 0o777, 0o700);
  for (const name of ["reconciliation.packet.json", "reconciliation.report.json"]) {
    assert.equal(fs.statSync(path.join(options.outputDir, name)).mode & 0o777, 0o600);
  }
  assert.equal(fs.readFileSync(path.join(options.outputDir, "reconciliation.report.json"), "utf8").includes("tx-2"), false);
});

test("operator CLI requires an explicit live confirmation phrase", () => {
  assert.throws(() => parseManageArgs(["--packet", "/tmp/packet.json", "--apply"]), /requires --active-flow/);
  assert.throws(() => parseManageArgs([
    "--packet", "/tmp/packet.json",
    "--active-flow", "/root/.node-red/flows.json",
    "--expected-plan-digest", "a".repeat(64),
    "--backup-dir", "/root/private/new",
    "--confirm", "wrong",
    "--apply",
  ]), /requires --confirm/);
});

const applyHarness = ({
  ambiguousCommit = false,
  casFailure = false,
  transactionalDrift = false,
  postCommitDrift = false,
  receiptWriteFailure = false,
  leaseRemainingMs = 60_000,
} = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piter-reconcile-apply-"));
  fs.chmodSync(root, 0o700);
  const packet = buildPacket();
  const packetFile = path.join(root, "packet.json");
  const activeFlowFile = path.join(root, "flows.json");
  fs.writeFileSync(packetFile, JSON.stringify(packet));
  fs.writeFileSync(activeFlowFile, FLOW_BYTES, { mode: 0o600 });
  let documents = structuredClone(inputs().ledgerEvidence.rows);
  let transactionalDocuments = null;
  let updateCount = 0;
  let failReceiptWrite = receiptWriteFailure;
  const fsImpl = new Proxy(fs, {
    get(target, property) {
      if (property === "openSync") {
        return (targetPath, ...args) => {
          if (failReceiptWrite && String(targetPath).includes("/.apply-receipt.json.")) {
            failReceiptWrite = false;
            throw new Error("simulated receipt fsync boundary failure");
          }
          return target.openSync(targetPath, ...args);
        };
      }
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const matches = (row, filter) => Object.entries(filter).every(([key, expected]) => {
    if (expected && typeof expected === "object" && expected.$exists === false) return row[key] === undefined;
    return row[key] === expected;
  });
  const collection = {
    find(_query, options) {
      assert.equal(options.maxTimeMS, 5_000);
      const source = options.session ? transactionalDocuments : documents;
      return { toArray: async () => structuredClone(source) };
    },
    async updateOne(filter, update, options) {
      assert.equal(options.upsert, false);
      assert.equal(options.maxTimeMS, 5_000);
      updateCount += 1;
      if (casFailure && updateCount === 2) {
        return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0, upsertedId: null };
      }
      const index = transactionalDocuments.findIndex((row) => matches(row, filter));
      if (index < 0) return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0, upsertedId: null };
      transactionalDocuments[index] = { ...transactionalDocuments[index], ...structuredClone(update.$set) };
      return { acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedCount: 0, upsertedId: null };
    },
  };
  const session = {
    async withTransaction(callback, options) {
      assert.deepEqual(options, {
        readConcern: { level: "snapshot" },
        writeConcern: { w: "majority", j: true },
        maxCommitTimeMS: 5_000,
        timeoutMS: leaseRemainingMs - 1_000,
      });
      transactionalDocuments = structuredClone(documents);
      if (transactionalDrift) transactionalDocuments[1].unrelatedAuditField = "DRIFT_AFTER_BACKUP";
      try {
        await callback();
        documents = transactionalDocuments;
        if (postCommitDrift) documents[0].amountMinor = 1;
        if (ambiguousCommit) throw new Error("simulated lost commit response");
      } catch (error) {
        if (!ambiguousCommit) transactionalDocuments = null;
        throw error;
      }
    },
    async endSession() {},
  };
  const client = {
    db(name) {
      if (name === "admin") return { command: async () => MONGO_IDENTITY };
      assert.equal(name, "games");
      return { collection: (collectionName) => {
        assert.equal(collectionName, "lk_tournament_subscription_sales");
        return collection;
      } };
    },
    startSession: () => session,
  };
  const options = {
    apply: true,
    packetFile,
    activeFlowFile,
    expectedPlanDigest: packet.planDigest,
    backupDir: path.join(root, "backup"),
    confirm: "APPLY_PITER_LEGACY_RECONCILIATION_147",
  };
  const dependencies = {
    client,
    now: () => NOW,
    liveFlowPath: activeFlowFile,
    expectedUid: process.getuid(),
    getUid: () => process.getuid(),
    verifyDeploymentLock: () => true,
    readHostIdentitySha256: () => HOST_SHA,
    readDeploymentLease: () => ({
      formatVersion: 2,
      deploymentId: "piter-atomic-sales-20260903",
      token: "lease-token",
      sourceSha256: packet.deployment.sourceSha256,
      candidateSha256: packet.deployment.candidateSha256,
      phase: "soaking",
      acquiredAtMs: NOW.getTime() - 60_000,
      expiresAtMs: NOW.getTime() + leaseRemainingMs,
    }),
    ejsonStringify: (value) => JSON.stringify(value, null, 2),
    ejsonParse: (value) => JSON.parse(value),
    fsImpl,
    env: {
      PADLHUB_REVIEWED_FLOW_LOCK_HELD: "1",
      LK_PITER_RECONCILIATION_TARGET: "lk-primary-147",
      LK_PITER_RECONCILIATION_ACTION: "APPLY_PITER_LEGACY_RECONCILIATION_147",
      LK_PITER_RECONCILIATION_MONGO_URI: "mongodb://not-used.example.test/games",
      LK_PITER_RECONCILIATION_EXPECTED_HOST_IDENTITY_SHA256: HOST_SHA,
      LK_PITER_RECONCILIATION_EXPECTED_MONGO_IDENTITY_SHA256: MONGO_SHA,
    },
  };
  return { root, packet, options, dependencies, get documents() { return documents; } };
};

test("reconciliation rejects a spoofed lock env before backup or Mongo access", async () => {
  const harness = applyHarness();
  const before = structuredClone(harness.documents);
  harness.dependencies.verifyDeploymentLock = () => false;
  harness.dependencies.client = new Proxy({}, {
    get() { throw new Error("Mongo must not be accessed without the deployment lock"); },
  });
  await assert.rejects(
    () => runPiterLegacyReconciliation(harness.options, harness.dependencies),
    /deployment lock is not held by this process/,
  );
  assert.deepEqual(harness.documents, before);
  assert.equal(fs.existsSync(harness.options.backupDir), false);
});

test("guarded apply uses one Mongo transaction, exact CAS, backup, and postcheck", async () => {
  const harness = applyHarness();
  const result = await runPiterLegacyReconciliation(harness.options, harness.dependencies);
  assert.equal(result.mutationPerformed, true);
  assert.equal(result.ambiguousCommitRecovered, false);
  assert.deepEqual(result.postcondition, { paidCount: 1, pendingCount: 0, changedCount: 2 });
  assert.equal(fs.statSync(path.join(harness.root, "backup", "piter-legacy-sales.preimage.ejson")).mode & 0o777, 0o600);
  const applyReceipt = JSON.parse(fs.readFileSync(path.join(harness.root, "backup", "apply-receipt.json"), "utf8"));
  assert.equal(applyReceipt.receiptDigest, result.applyReceiptDigest);
  assert.equal(applyReceipt.mutationPerformed, true);
  assert.equal(
    fs.statSync(path.join(harness.root, "backup", "reviewed-reconciliation.packet.json")).mode & 0o777,
    0o600,
  );
  assert.doesNotThrow(() => assertPiterLegacyReconciliationPostcondition(harness.packet, harness.documents));
});

test("lock loss before either mutation or commit aborts the whole reconciliation", async () => {
  for (const denyAt of [2, 3, 4]) {
    const harness = applyHarness();
    const before = structuredClone(harness.documents);
    let checks = 0;
    harness.dependencies.verifyDeploymentLock = () => ++checks < denyAt;
    await assert.rejects(
      () => runPiterLegacyReconciliation(harness.options, harness.dependencies),
      /deployment lock is not held by this process/,
    );
    assert.equal(checks, denyAt);
    assert.deepEqual(harness.documents, before);
    assert.equal(fs.existsSync(path.join(harness.options.backupDir, "apply-receipt.json")), false);
  }
});

test("a CAS failure aborts the transaction without a partial reconciliation", async () => {
  const harness = applyHarness({ casFailure: true });
  const before = structuredClone(harness.documents);
  await assert.rejects(
    () => runPiterLegacyReconciliation(harness.options, harness.dependencies),
    /exact CAS acknowledgement missing/,
  );
  assert.deepEqual(harness.documents, before);
});

test("a lost commit response is recovered only from the exact postcondition", async () => {
  const harness = applyHarness({ ambiguousCommit: true });
  const result = await runPiterLegacyReconciliation(harness.options, harness.dependencies);
  assert.equal(result.mutationPerformed, true);
  assert.equal(result.ambiguousCommitRecovered, true);
  assert.equal(result.postcondition.pendingCount, 0);
});

test("exact postcondition rejects partial metadata and duplicate rows", () => {
  const packet = buildPacket();
  const rows = structuredClone(inputs().ledgerEvidence.rows);
  for (const change of packet.changes) {
    const row = rows.find((item) => item.transactionId === change.transactionId);
    Object.assign(row, change.set);
  }
  rows.find((row) => row.transactionId === "tx-3").refundSumMinor = 1;
  assert.throws(() => assertPiterLegacyReconciliationPostcondition(packet, rows), /post-write ledger row mismatch/);
  rows.find((row) => row.transactionId === "tx-3").refundSumMinor = 1_969_000;
  const expectedRows = structuredClone(rows);
  rows[0].amountMinor = 1;
  assert.throws(() => assertPiterLegacyReconciliationPostcondition(packet, rows, {
    expectedRows,
    serialize: stableJson,
  }), /exact post-write ledger image mismatch/);
  rows[0].amountMinor = 1_980_000;
  rows.push(structuredClone(rows[0]));
  assert.throws(() => assertPiterLegacyReconciliationPostcondition(packet, rows), /scope mismatch/);
});

test("apply rejects transaction preimage drift after backup and a near-expiry lease", async () => {
  const drifted = applyHarness({ transactionalDrift: true });
  await assert.rejects(
    () => runPiterLegacyReconciliation(drifted.options, drifted.dependencies),
    /preimage differs from the forensic backup/,
  );
  const expiring = applyHarness({ leaseRemainingMs: 5_000 });
  await assert.rejects(
    () => runPiterLegacyReconciliation(expiring.options, expiring.dependencies),
    /soaking lease is required/,
  );
  const changedAfterCommit = applyHarness({ ambiguousCommit: true, postCommitDrift: true });
  await assert.rejects(
    () => runPiterLegacyReconciliation(changedAfterCommit.options, changedAfterCommit.dependencies),
    /simulated lost commit response/,
  );
});

test("an expired retry reconstructs a missing receipt only from backup and the exact full postimage", async () => {
  const harness = applyHarness({ receiptWriteFailure: true });
  await assert.rejects(
    () => runPiterLegacyReconciliation(harness.options, harness.dependencies),
    /simulated receipt fsync boundary failure/,
  );
  fs.writeFileSync(path.join(harness.root, "backup", "apply-receipt.json"), "{partial", { mode: 0o600 });
  harness.dependencies.now = () => new Date("2026-09-04T10:10:00.000Z");
  const recovered = await runPiterLegacyReconciliation(harness.options, harness.dependencies);
  assert.equal(recovered.mutationPerformed, false);
  assert.equal(recovered.reconciliationPreviouslyApplied, true);
  assert.equal(recovered.receiptRecoveryPerformed, true);
  assert.equal(
    fs.existsSync(path.join(harness.root, "backup", "apply-receipt.json")),
    true,
  );
  assert.equal(
    fs.readdirSync(path.join(harness.root, "backup")).some((name) => name.startsWith("apply-receipt.invalid.")),
    true,
  );
});
