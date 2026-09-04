import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  PITER_ATOMIC_ACTIVATION,
  buildPiterAtomicActivationPacket,
  buildPiterAtomicSentinel,
  redactPiterAtomicActivationPacket,
  sha256,
  stableJson,
} from "../lib/piterAtomicActivationContract.mjs";
import {
  buildPiterAtomicLedgerPlan,
  deriveLiveLegacyBaseline,
} from "../lib/piterAtomicLedgerOperations.mjs";
import { parseArgs as parsePacketArgs, preparePacket } from "../prepare_piter_atomic_activation_packet.mjs";
import { parseArgs as parseLedgerArgs, runLedgerOperation } from "../manage_piter_atomic_ledger.mjs";

const NOW = new Date("2026-09-04T10:00:00.000Z");
const PRODUCT_ID = "8bf334ba-3050-4017-b40a-7eef2db1eb16";
const FLOW_SHA = "b".repeat(64);
const MONGO_IDENTITY = {
  setName: "lk-prod-rs",
  hosts: ["mongo-a:27017", "mongo-b:27017"],
  me: "mongo-a:27017",
  primary: "mongo-a:27017",
};
const MONGO_IDENTITY_SHA = sha256(stableJson(MONGO_IDENTITY));
const HOST_IDENTITY_SHA = sha256("lk-primary-machine-id");

const pagination = (rows) => ({ complete: true, pages: 1, rowCount: rows.length });
const paidRow = (overrides = {}) => ({
  _id: "legacy-sale-1",
  inventoryId: PITER_ATOMIC_ACTIVATION.inventoryId,
  counterKey: PITER_ATOMIC_ACTIVATION.counterKey,
  paymentRef: "pay-ref-1",
  transactionId: "tx-1",
  productId: PRODUCT_ID,
  status: "PAID",
  amountMinor: 1_980_000,
  providerProductCostMinor: 5_680_000,
  discountMinor: 3_700_000,
  clientId: "client-1",
  clientPhone: "79990000000",
  ...overrides,
});
const providerTransaction = (overrides = {}) => ({
  id: "tx-1",
  status: "PAID",
  toPay: 0,
  sum: 1_980_000,
  clientId: "client-1",
  clientPhone: ["+7", "9990000000"].join(""),
  products: [{ id: PRODUCT_ID, discount: 3_700_000 }],
  ...overrides,
});

const evidence = (rows = [paidRow()], transactions = [providerTransaction()]) => ({
  ledgerEvidence: {
    formatVersion: 1,
    source: "MONGO_LK_TOURNAMENT_SUBSCRIPTION_SALES",
    complete: true,
    capturedAt: "2026-09-04T09:59:30.000Z",
    query: { inventoryId: PITER_ATOMIC_ACTIVATION.inventoryId, counterKey: PITER_ATOMIC_ACTIVATION.counterKey },
    pagination: pagination(rows),
    rows,
  },
  providerEvidence: {
    formatVersion: 1,
    source: "VIVA_TRANSACTIONS",
    complete: true,
    capturedAt: "2026-09-04T09:59:40.000Z",
    query: { productId: PRODUCT_ID },
    pagination: pagination(transactions),
    transactions,
  },
  productEvidence: {
    formatVersion: 1,
    source: "VIVA_PRODUCTS",
    complete: true,
    capturedAt: "2026-09-04T09:59:50.000Z",
    query: { productId: PRODUCT_ID },
    pagination: pagination([{}]),
    products: [{
      id: PRODUCT_ID,
      productType: "SUBSCRIPTION",
      cost: 5_680_000,
      activationDays: 27,
      validityDays: 365,
      visits: 365,
    }],
  },
  bindingEvidence: {
    formatVersion: 1,
    source: "NODE_RED_GLOBAL_CONTEXT",
    complete: true,
    capturedAt: "2026-09-04T09:59:45.000Z",
    query: { key: PITER_ATOMIC_ACTIVATION.productBindingKey },
    pagination: pagination([{}]),
    values: [{ key: PITER_ATOMIC_ACTIVATION.productBindingKey, value: PRODUCT_ID }],
  },
  candidateReport: {
    ok: true,
    deploymentId: PITER_ATOMIC_ACTIVATION.deploymentId,
    sourceSha256: "a".repeat(64),
    candidateSha256: FLOW_SHA,
    sourceNodeCount: 100,
    candidateNodeCount: 107,
    ledgerActivationRequired: true,
    deploymentPerformed: false,
    activationPerformed: false,
  },
  productId: PRODUCT_ID,
  createdAt: NOW.toISOString(),
});

const packet = () => buildPiterAtomicActivationPacket(evidence());

const createSeedApplyHarness = ({ alreadyApplied = false, ambiguousWrite = false, now } = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piter-ledger-harness-"));
  const flowBytes = Buffer.from("exact reviewed flow\n");
  const input = evidence();
  input.candidateReport.candidateSha256 = sha256(flowBytes);
  const built = buildPiterAtomicActivationPacket(input);
  const packetFile = path.join(root, "activation.packet.json");
  const activeFlowFile = path.join(root, "flows.json");
  fs.writeFileSync(packetFile, JSON.stringify(built));
  fs.writeFileSync(activeFlowFile, flowBytes, { mode: 0o600 });
  fs.chmodSync(activeFlowFile, 0o600);
  let documents = [paidRow()];
  if (alreadyApplied) documents.push(buildPiterAtomicSentinel(built, NOW.toISOString()));
  let writeCalls = 0;
  const collection = {
    find() { return { toArray: async () => documents }; },
    async insertOne(document) {
      writeCalls += 1;
      documents = [...documents, document];
      if (ambiguousWrite) throw new Error("simulated network timeout after commit");
      return { acknowledged: true, insertedId: document._id };
    },
  };
  const client = { db: (name) => {
    if (name === "admin") return { command: async () => MONGO_IDENTITY };
    return { collection: () => collection };
  } };
  return {
    built,
    get writeCalls() { return writeCalls; },
    options: {
      action: "seed", apply: true, packetFile, activeFlowFile, expectedRevision: 0,
      expectedContractDigest: built.contractDigest, backupDir: path.join(root, "backup"),
    },
    dependencies: {
      client,
      now: now || (() => NOW),
      liveFlowPath: activeFlowFile,
      expectedUid: process.getuid(),
      getUid: () => process.getuid(),
      ejsonStringify: (value) => JSON.stringify(value, null, 2),
      readDeploymentLease: () => ({
        formatVersion: 2,
        deploymentId: "piter-atomic-sales-20260903",
        token: "test-lease-token",
        sourceSha256: built.deployment.sourceSha256,
        candidateSha256: built.deployment.candidateSha256,
        phase: "soaking",
        acquiredAtMs: NOW.getTime() - 60_000,
        expiresAtMs: NOW.getTime() + 60_000,
      }),
      env: {
        PADLHUB_REVIEWED_FLOW_LOCK_HELD: "1",
        LK_PITER_ATOMIC_TARGET: "lk-primary-147",
        LK_PITER_ATOMIC_LEDGER_ACTION: "SEED_147",
        LK_PITER_ATOMIC_MONGO_URI: "mongodb://not-used.example.test/games",
        LK_PITER_ATOMIC_EXPECTED_HOST_IDENTITY_SHA256: HOST_IDENTITY_SHA,
        LK_PITER_ATOMIC_EXPECTED_MONGO_IDENTITY_SHA256: MONGO_IDENTITY_SHA,
      },
      readHostIdentitySha256: () => HOST_IDENTITY_SHA,
    },
  };
};

test("activation packet reconciles exact paid rows and keeps raw identities private", () => {
  const built = packet();
  assert.equal(built.baseline.paidCount, 1);
  assert.equal(built.baseline.takenCount, 1);
  assert.equal(built.product.costMinor, 5_680_000);
  const redacted = redactPiterAtomicActivationPacket(built);
  assert.equal(redacted.productIdHash.length, 12);
  assert.equal(JSON.stringify(redacted).includes("tx-1"), false);
  assert.equal(JSON.stringify(redacted).includes("pay-ref-1"), false);
});

test("baseline digest is stable across source ordering", () => {
  const rows = [paidRow(), paidRow({ _id: "legacy-sale-2", paymentRef: "pay-ref-2", transactionId: "tx-2" })];
  const transactions = [providerTransaction(), providerTransaction({ id: "tx-2" })];
  const left = buildPiterAtomicActivationPacket(evidence(rows, transactions));
  const right = buildPiterAtomicActivationPacket(evidence([...rows].reverse(), [...transactions].reverse()));
  assert.equal(left.baseline.digest, right.baseline.digest);
});

test("activation packet fails closed on incomplete, stale, unresolved, refund, or pricing evidence", () => {
  const cases = [
    () => ({ ...evidence(), ledgerEvidence: { ...evidence().ledgerEvidence, complete: false } }),
    () => ({ ...evidence(), providerEvidence: { ...evidence().providerEvidence, capturedAt: "2026-09-04T09:54:00.000Z" } }),
    () => evidence([paidRow({ status: "PAYMENT_PENDING" })], [providerTransaction({ status: "WAITING", toPay: 1_980_000 })]),
    () => evidence([paidRow()], [providerTransaction({ refundSum: 1 })]),
    () => evidence([paidRow({ discountMinor: 1 })], [providerTransaction()]),
    () => evidence([paidRow()], [providerTransaction({ sum: 2_380_000 })]),
    () => evidence([paidRow()], [providerTransaction({ clientId: "other-client" })]),
    () => evidence([paidRow()], [providerTransaction({
      products: [{ id: PRODUCT_ID, discount: 3_700_000 }, { id: "unexpected-product", discount: 0 }],
    })]),
  ];
  for (const build of cases) {
    assert.throws(() => buildPiterAtomicActivationPacket(build()), /activation contract failed/);
  }
});

test("activation packet requires exact source, pagination, product cost, and activation window", () => {
  assert.throws(() => buildPiterAtomicActivationPacket({
    ...evidence(),
    providerEvidence: { ...evidence().providerEvidence, source: "UNKNOWN" },
  }), /source mismatch/);
  assert.throws(() => buildPiterAtomicActivationPacket({
    ...evidence(),
    productEvidence: {
      ...evidence().productEvidence,
      products: [{ ...evidence().productEvidence.products[0], cost: 5_679_999 }],
    },
  }), /product cost mismatch/);
  assert.throws(() => buildPiterAtomicActivationPacket({
    ...evidence(),
    productEvidence: {
      ...evidence().productEvidence,
      products: [{ ...evidence().productEvidence.products[0], activationDays: 26 }],
    },
  }), /activate before/);
  assert.throws(() => buildPiterAtomicActivationPacket({
    ...evidence(),
    bindingEvidence: {
      ...evidence().bindingEvidence,
      values: [{ key: PITER_ATOMIC_ACTIVATION.productBindingKey, value: "different-product" }],
    },
  }), /product binding mismatch/);
});

test("ledger plan seeds inactive, activates by exact CAS, and deactivates without deleting attempts", () => {
  const built = packet();
  const legacy = [paidRow()];
  const seed = buildPiterAtomicLedgerPlan({
    action: "seed", packet: built, documents: legacy, activeFlowSha256: FLOW_SHA,
    expectedRevision: 0, now: NOW,
  });
  assert.equal(seed.mutation.document.ready, false);
  assert.equal(seed.mutation.document.paidCount, 1);
  const sentinel = buildPiterAtomicSentinel(built, NOW.toISOString());
  const activate = buildPiterAtomicLedgerPlan({
    action: "activate", packet: built, documents: [...legacy, sentinel], activeFlowSha256: FLOW_SHA,
    expectedRevision: 0, now: NOW,
  });
  assert.deepEqual(activate.mutation.update.$set.ready, true);
  assert.equal(activate.mutation.update.$set.activationBaseRevision, 0);
  assert.equal(activate.mutation.update.$set.activationDeploymentId, "piter-atomic-sales-20260903");
  assert.deepEqual(activate.mutation.filter.reservations, { $size: 0 });
  const active = {
    ...sentinel,
    ready: true,
    revision: 8,
    reservedCount: 1,
    takenCount: 2,
    reservations: [{ paymentRef: "atomic-1", state: "PAYMENT_PENDING", intentFingerprint: "intent-1" }],
  };
  const deactivate = buildPiterAtomicLedgerPlan({
    action: "deactivate", packet: built, documents: [active], activeFlowSha256: null,
    expectedRevision: 8, now: new Date("2026-09-05T10:00:00.000Z"), reason: "manual safety stop",
  });
  assert.equal(deactivate.mutation.update.$set.ready, false);
  assert.equal(deactivate.mutation.update.$set.deactivationBaseRevision, 8);
  assert.equal(deactivate.mutation.update.$unset, undefined);
  assert.equal(deactivate.activeReservationCount, 1);
  const settledAfterStop = {
    ...active,
    ready: false,
    revision: 10,
    paidCount: 2,
    reservedCount: 0,
    takenCount: 2,
    deactivatedAt: NOW.toISOString(),
    deactivationReason: "manual safety stop",
    deactivationBaseRevision: 8,
    reservations: [{
      paymentRef: "atomic-1", state: "PAID", intentFingerprint: "intent-1", transactionId: "tx-atomic-1",
    }],
  };
  const repeatedDeactivate = buildPiterAtomicLedgerPlan({
    action: "deactivate", packet: built, documents: [settledAfterStop], activeFlowSha256: null,
    expectedRevision: 8, now: new Date("2026-09-05T10:00:00.000Z"), reason: "manual safety stop",
  });
  assert.equal(repeatedDeactivate.outcome, "ALREADY_APPLIED");
  assert.equal(repeatedDeactivate.mutation, null);
});

test("rollback check reports only a non-authorizing offline precondition", () => {
  const built = packet();
  const empty = buildPiterAtomicSentinel(built, NOW.toISOString());
  const safe = buildPiterAtomicLedgerPlan({
    action: "rollback-check", packet: built, documents: [empty], now: new Date("2026-09-05T10:00:00.000Z"),
  });
  assert.equal(safe.outcome, "OFFLINE_FLOW_ROLLBACK_PRECONDITION_SATISFIED");
  assert.equal(safe.authorizesRollback, false);
  const blocked = buildPiterAtomicLedgerPlan({
    action: "rollback-check", packet: built,
    documents: [empty, { _id: `piter-sale:${PITER_ATOMIC_ACTIVATION.inventoryId}:one` }],
    now: new Date("2026-09-05T10:00:00.000Z"),
  });
  assert.equal(blocked.outcome, "OFFLINE_FLOW_ROLLBACK_PRECONDITION_FAILED");
  assert.equal(blocked.authorizesRollback, false);
});

test("operator parsers keep packet preparation offline and live mutation explicitly gated", () => {
  assert.throws(() => parsePacketArgs(["--apply"]), /unsupported/);
  assert.throws(() => parseLedgerArgs([
    "--action", "activate", "--packet", "/tmp/p.json", "--ledger-file", "/tmp/l.json",
  ]), /expected-revision/);
  assert.throws(() => parseLedgerArgs([
    "--action", "rollback-check", "--packet", "/tmp/p.json", "--ledger-file", "/tmp/l.json", "--apply",
  ]), /forbidden with --apply|read-only/);
});

test("dry-run ledger operation requires a fresh complete snapshot with exact scope", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piter-ledger-dry-test-"));
  const built = packet();
  const packetFile = path.join(root, "packet.json");
  const ledgerFile = path.join(root, "ledger.json");
  fs.writeFileSync(packetFile, JSON.stringify(built));
  const snapshot = {
    formatVersion: 1,
    source: "MONGO_LK_TOURNAMENT_SUBSCRIPTION_SALES",
    complete: true,
    capturedAt: "2026-09-04T09:59:50.000Z",
    query: {
      inventoryId: PITER_ATOMIC_ACTIVATION.inventoryId,
      counterKey: PITER_ATOMIC_ACTIVATION.counterKey,
      includeSentinel: true,
      includeAtomicSales: true,
    },
    pagination: pagination([]),
    rows: [],
  };
  fs.writeFileSync(ledgerFile, JSON.stringify(snapshot));
  const report = await runLedgerOperation({
    action: "rollback-check", apply: false, packetFile, ledgerFile, expectedRevision: 0,
  }, { now: () => NOW });
  assert.equal(report.outcome, "OFFLINE_FLOW_ROLLBACK_PRECONDITION_SATISFIED");
  fs.writeFileSync(ledgerFile, JSON.stringify({ ...snapshot, capturedAt: "2026-09-04T09:54:00.000Z" }));
  await assert.rejects(() => runLedgerOperation({
    action: "rollback-check", apply: false, packetFile, ledgerFile, expectedRevision: 0,
  }, { now: () => NOW }), /complete exact Mongo v1 snapshot/);
});

test("packet writer creates 0700 directory and 0600 private and redacted files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piter-packet-test-"));
  const input = evidence();
  const files = {
    ledgerFile: "ledgerEvidence",
    providerFile: "providerEvidence",
    productFile: "productEvidence",
    bindingFile: "bindingEvidence",
    candidateReport: "candidateReport",
  };
  const options = { productId: PRODUCT_ID, outputDir: path.join(root, "private") };
  for (const [option, key] of Object.entries(files)) {
    const target = path.join(root, `${option}.json`);
    fs.writeFileSync(target, JSON.stringify(input[key]));
    options[option] = target;
  }
  const report = preparePacket(options, { now: () => NOW });
  assert.equal(report.mutationPerformed, false);
  assert.equal(fs.statSync(options.outputDir).mode & 0o777, 0o700);
  for (const name of ["activation.packet.json", "activation.report.json"]) {
    assert.equal(fs.statSync(path.join(options.outputDir, name)).mode & 0o777, 0o600);
  }
  assert.equal(fs.readFileSync(path.join(options.outputDir, "activation.report.json"), "utf8").includes("tx-1"), false);
});

test("live baseline refuses nonterminal rows and duplicate transaction identities", () => {
  assert.throws(() => deriveLiveLegacyBaseline([paidRow({ status: "WAITING" })], PRODUCT_ID), /nonterminal/);
  assert.throws(() => deriveLiveLegacyBaseline([
    paidRow(), paidRow({ _id: "two", paymentRef: "pay-ref-2" }),
  ], PRODUCT_ID), /duplicate/);
});

test("guarded seed writes only after exact authorization, majority ACK, backup, and readback", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piter-ledger-apply-test-"));
  const flowBytes = Buffer.from("exact reviewed flow\n");
  const input = evidence();
  input.candidateReport.candidateSha256 = sha256(flowBytes);
  const built = buildPiterAtomicActivationPacket(input);
  const packetFile = path.join(root, "activation.packet.json");
  const activeFlowFile = path.join(root, "flows.json");
  fs.writeFileSync(packetFile, JSON.stringify(built));
  fs.writeFileSync(activeFlowFile, flowBytes);
  fs.chmodSync(activeFlowFile, 0o600);
  let documents = [paidRow()];
  let writeOptions = null;
  const collection = {
    find(_query, options) {
      assert.deepEqual(options, { readConcern: { level: "majority" }, maxTimeMS: 5_000 });
      return { toArray: async () => documents };
    },
    async insertOne(document, options) {
      writeOptions = options;
      documents = [...documents, document];
      return { acknowledged: true, insertedId: document._id };
    },
  };
  const client = { db: (name) => {
    if (name === "admin") return {
      command: async (command, options) => {
        assert.deepEqual(command, { hello: 1 });
        assert.deepEqual(options, { maxTimeMS: 5_000 });
        return MONGO_IDENTITY;
      },
    };
    assert.equal(name, "games");
    return { collection: (collectionName) => {
      assert.equal(collectionName, built.target.collection);
      return collection;
    } };
  } };
  const result = await runLedgerOperation({
    action: "seed",
    apply: true,
    packetFile,
    activeFlowFile,
    expectedRevision: 0,
    expectedContractDigest: built.contractDigest,
    backupDir: path.join(root, "backup"),
  }, {
    client,
    now: () => NOW,
    liveFlowPath: activeFlowFile,
    expectedUid: process.getuid(),
    getUid: () => process.getuid(),
    ejsonStringify: (value) => JSON.stringify(value, null, 2),
    readDeploymentLease: () => ({
      formatVersion: 2,
      deploymentId: "piter-atomic-sales-20260903",
      token: "test-lease-token",
      sourceSha256: built.deployment.sourceSha256,
      candidateSha256: built.deployment.candidateSha256,
      phase: "soaking",
      acquiredAtMs: NOW.getTime() - 60_000,
      expiresAtMs: NOW.getTime() + 60_000,
    }),
    env: {
      PADLHUB_REVIEWED_FLOW_LOCK_HELD: "1",
      LK_PITER_ATOMIC_TARGET: "lk-primary-147",
      LK_PITER_ATOMIC_LEDGER_ACTION: "SEED_147",
      LK_PITER_ATOMIC_MONGO_URI: "mongodb://not-used.example.test/games",
      LK_PITER_ATOMIC_EXPECTED_HOST_IDENTITY_SHA256: HOST_IDENTITY_SHA,
      LK_PITER_ATOMIC_EXPECTED_MONGO_IDENTITY_SHA256: MONGO_IDENTITY_SHA,
    },
    readHostIdentitySha256: () => HOST_IDENTITY_SHA,
  });
  assert.equal(result.mutationPerformed, true);
  assert.equal(result.postReady, false);
  assert.deepEqual(writeOptions, { writeConcern: { w: "majority", j: true }, maxTimeMS: 5_000 });
  assert.equal(fs.statSync(path.join(root, "backup", "piter-atomic-ledger.preimage.ejson")).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(root, "backup", "manifest.json")).mode & 0o777, 0o600);
  assert.equal(result.restoreRehearsed, false);
});

test("guarded seed recovers an ambiguous ACK only from the exact majority readback", async () => {
  const harness = createSeedApplyHarness({ ambiguousWrite: true });
  const result = await runLedgerOperation(harness.options, harness.dependencies);
  assert.equal(result.mutationPerformed, true);
  assert.equal(result.ambiguousWriteRecovered, true);
  assert.equal(result.postReady, false);
  assert.equal(harness.writeCalls, 1);
});

test("deactivate recovery accepts a valid in-flight confirmation after the stop CAS", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piter-deactivate-race-"));
  const flowBytes = Buffer.from("deactivate reviewed flow\n");
  const input = evidence();
  input.candidateReport.candidateSha256 = sha256(flowBytes);
  const built = buildPiterAtomicActivationPacket(input);
  const packetFile = path.join(root, "activation.packet.json");
  const activeFlowFile = path.join(root, "flows.json");
  fs.writeFileSync(packetFile, JSON.stringify(built));
  fs.writeFileSync(activeFlowFile, flowBytes, { mode: 0o600 });
  const seed = buildPiterAtomicSentinel(built, NOW.toISOString());
  let documents = [{
    ...seed,
    ready: true,
    revision: 8,
    reservedCount: 1,
    takenCount: 2,
    reservations: [{
      paymentRef: "atomic-1", state: "PAYMENT_PENDING", intentFingerprint: "intent-1",
      transactionId: "tx-atomic-1",
    }],
  }];
  const collection = {
    find() { return { toArray: async () => documents }; },
    async updateOne(_filter, update) {
      const stopped = {
        ...documents[0],
        ...update.$set,
        revision: documents[0].revision + 1,
      };
      documents = [{
        ...stopped,
        revision: stopped.revision + 1,
        paidCount: 2,
        reservedCount: 0,
        takenCount: 2,
        reservations: [{
          ...stopped.reservations[0], state: "PAID",
        }],
      }];
      throw new Error("simulated timeout after deactivation and confirm");
    },
  };
  const client = { db: (name) => name === "admin"
    ? { command: async () => MONGO_IDENTITY }
    : { collection: () => collection } };
  const result = await runLedgerOperation({
    action: "deactivate", apply: true, packetFile, activeFlowFile, expectedRevision: 8,
    expectedContractDigest: built.contractDigest, backupDir: path.join(root, "backup"),
    reason: "manual safety stop",
  }, {
    client,
    now: () => NOW,
    liveFlowPath: activeFlowFile,
    expectedUid: process.getuid(),
    getUid: () => process.getuid(),
    readHostIdentitySha256: () => HOST_IDENTITY_SHA,
    ejsonStringify: (value) => JSON.stringify(value, null, 2),
    env: {
      PADLHUB_REVIEWED_FLOW_LOCK_HELD: "1",
      LK_PITER_ATOMIC_TARGET: "lk-primary-147",
      LK_PITER_ATOMIC_LEDGER_ACTION: "DEACTIVATE_147",
      LK_PITER_ATOMIC_MONGO_URI: "mongodb://not-used.example.test/games",
      LK_PITER_ATOMIC_EXPECTED_HOST_IDENTITY_SHA256: HOST_IDENTITY_SHA,
      LK_PITER_ATOMIC_EXPECTED_MONGO_IDENTITY_SHA256: MONGO_IDENTITY_SHA,
    },
  });
  assert.equal(result.ambiguousWriteRecovered, true);
  assert.equal(result.postReady, false);
  assert.equal(result.postRevision, 10);
});

test("activate recovery accepts a valid first reservation after the activation CAS", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piter-activate-race-"));
  const flowBytes = Buffer.from("activate reviewed flow\n");
  const input = evidence();
  input.candidateReport.candidateSha256 = sha256(flowBytes);
  const built = buildPiterAtomicActivationPacket(input);
  const packetFile = path.join(root, "activation.packet.json");
  const activeFlowFile = path.join(root, "flows.json");
  fs.writeFileSync(packetFile, JSON.stringify(built));
  fs.writeFileSync(activeFlowFile, flowBytes, { mode: 0o600 });
  let documents = [paidRow(), buildPiterAtomicSentinel(built, NOW.toISOString())];
  const collection = {
    find() { return { toArray: async () => documents }; },
    async updateOne(_filter, update) {
      const active = {
        ...documents[1],
        ...update.$set,
        revision: documents[1].revision + 1,
      };
      documents = [documents[0], {
        ...active,
        revision: active.revision + 1,
        reservedCount: 1,
        takenCount: 2,
        reservations: [{ paymentRef: "first-sale", state: "CLAIMED", intentFingerprint: "intent-first" }],
      }];
      throw new Error("simulated timeout after activation and first reserve");
    },
  };
  const client = { db: (name) => name === "admin"
    ? { command: async () => MONGO_IDENTITY }
    : { collection: () => collection } };
  const result = await runLedgerOperation({
    action: "activate", apply: true, packetFile, activeFlowFile, expectedRevision: 0,
    expectedContractDigest: built.contractDigest, backupDir: path.join(root, "backup"),
  }, {
    client,
    now: () => NOW,
    liveFlowPath: activeFlowFile,
    expectedUid: process.getuid(),
    getUid: () => process.getuid(),
    readHostIdentitySha256: () => HOST_IDENTITY_SHA,
    ejsonStringify: (value) => JSON.stringify(value, null, 2),
    readDeploymentLease: () => ({
      formatVersion: 2,
      deploymentId: "piter-atomic-sales-20260903",
      token: "test-lease-token",
      sourceSha256: built.deployment.sourceSha256,
      candidateSha256: built.deployment.candidateSha256,
      phase: "soaking",
      acquiredAtMs: NOW.getTime() - 60_000,
      expiresAtMs: NOW.getTime() + 60_000,
    }),
    env: {
      PADLHUB_REVIEWED_FLOW_LOCK_HELD: "1",
      LK_PITER_ATOMIC_TARGET: "lk-primary-147",
      LK_PITER_ATOMIC_LEDGER_ACTION: "ACTIVATE_147",
      LK_PITER_ATOMIC_MONGO_URI: "mongodb://not-used.example.test/games",
      LK_PITER_ATOMIC_EXPECTED_HOST_IDENTITY_SHA256: HOST_IDENTITY_SHA,
      LK_PITER_ATOMIC_EXPECTED_MONGO_IDENTITY_SHA256: MONGO_IDENTITY_SHA,
    },
  });
  assert.equal(result.ambiguousWriteRecovered, true);
  assert.equal(result.postReady, true);
  assert.equal(result.postRevision, 2);
});

test("guarded seed retry is an explicit no-op when the exact state already exists", async () => {
  const harness = createSeedApplyHarness({ alreadyApplied: true });
  const result = await runLedgerOperation(harness.options, harness.dependencies);
  assert.equal(result.mutationPerformed, false);
  assert.equal(result.alreadyApplied, true);
  assert.equal(harness.writeCalls, 0);
  assert.equal(fs.existsSync(harness.options.backupDir), false);
});

test("live mutation rejects a missing shared lock and an expired packet at the final gate", async () => {
  const unlocked = createSeedApplyHarness();
  delete unlocked.dependencies.env.PADLHUB_REVIEWED_FLOW_LOCK_HELD;
  await assert.rejects(() => runLedgerOperation(unlocked.options, unlocked.dependencies), /lock is not held/);

  const wrongHost = createSeedApplyHarness();
  wrongHost.dependencies.readHostIdentitySha256 = () => sha256("different-machine-id");
  await assert.rejects(() => runLedgerOperation(wrongHost.options, wrongHost.dependencies), /host identity/);

  const wrongLease = createSeedApplyHarness();
  wrongLease.dependencies.readDeploymentLease = () => ({
    formatVersion: 2,
    deploymentId: "different-deployment",
    token: "test-lease-token",
    sourceSha256: wrongLease.built.deployment.sourceSha256,
    candidateSha256: wrongLease.built.deployment.candidateSha256,
    phase: "soaking",
    acquiredAtMs: NOW.getTime() - 60_000,
    expiresAtMs: NOW.getTime() + 60_000,
  });
  await assert.rejects(() => runLedgerOperation(wrongLease.options, wrongLease.dependencies), /soaking lease/);

  const lateLease = createSeedApplyHarness();
  lateLease.dependencies.readDeploymentLease = () => ({
    formatVersion: 2,
    deploymentId: "piter-atomic-sales-20260903",
    token: "test-lease-token",
    sourceSha256: lateLease.built.deployment.sourceSha256,
    candidateSha256: lateLease.built.deployment.candidateSha256,
    phase: "soaking",
    acquiredAtMs: NOW.getTime() - 10_000,
    expiresAtMs: NOW.getTime() + 60_000,
  });
  await assert.rejects(() => runLedgerOperation(lateLease.options, lateLease.dependencies), /soaking lease/);

  let calls = 0;
  const expiring = createSeedApplyHarness({
    now: () => {
      calls += 1;
      return calls === 1 ? NOW : new Date("2026-09-04T10:10:00.000Z");
    },
  });
  await assert.rejects(() => runLedgerOperation(expiring.options, expiring.dependencies), /expired/);
  assert.equal(expiring.writeCalls, 0);
});
