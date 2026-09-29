import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import {
  INDEX_KEY,
  INDEX_NAME,
  appendReport,
  buildApplyReceipt,
  classifyIndex,
  planDigest,
  protectedReceipt,
  publicDateStationQuery,
  syncJournalDirectory,
  validateApplyReceipt,
} from "../manage_lk_games_public_index.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const querySource = fs.readFileSync(
  path.resolve(testDirectory, "../nodered_games_nodes/fn_list_query.js"), "utf8",
);

test("public date/station index matches the exact live query fields", () => {
  const timestamp = Date.parse("2026-10-01T12:00:00Z");
  const message = {
    req: { query: {
      public: "true", available: "true", limit: "50",
      date: "2026-10-02", stationId: "station-fixture",
    } },
  };
  const FakeDate = class extends Date { static now() { return timestamp; } };
  const result = vm.runInNewContext(`(function () { ${querySource}\n })()`, {
    msg: message,
    Date: FakeDate,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(result[0].payload)),
    publicDateStationQuery("2026-10-02", "station-fixture", timestamp));
  assert.deepEqual(INDEX_KEY, { "booking.date": 1, "booking.studioId": 1 });
  assert.equal(INDEX_NAME, "lk_games_public_date_station_v1");
});

test("managed index classification rejects foreign or changed indexes", () => {
  const baseline = [{ name: "_id_", key: { _id: 1 } }];
  assert.equal(classifyIndex(baseline), "missing");
  assert.equal(classifyIndex([...baseline, { name: INDEX_NAME, key: INDEX_KEY }]), "matching");
  assert.equal(classifyIndex([...baseline, { name: INDEX_NAME, key: { "booking.date": 1 } }]), "name-conflict");
  assert.equal(classifyIndex([...baseline, { name: INDEX_NAME, key: {
    "booking.studioId": 1, "booking.date": 1,
  } }]), "name-conflict");
  assert.equal(classifyIndex([...baseline, { name: INDEX_NAME, key: INDEX_KEY, hidden: true }]), "name-conflict");
  assert.equal(classifyIndex([...baseline, { name: "foreign", key: INDEX_KEY }]), "equivalent-other-name");
});

test("plan digest changes with catalog, target and source binding", () => {
  const baseline = {
    binding: { queryFunctionSha256: "source" },
    targetFingerprint: "target",
    indexes: [{ name: "_id_", key: { _id: 1 } }],
  };
  const digest = planDigest(baseline);
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.notEqual(planDigest({ ...baseline, targetFingerprint: "other" }), digest);
  assert.notEqual(planDigest({ ...baseline, binding: { queryFunctionSha256: "changed" } }), digest);
  assert.notEqual(planDigest({ ...baseline, indexes: [
    ...baseline.indexes, { name: INDEX_NAME, key: INDEX_KEY },
  ] }), digest);
  assert.notEqual(planDigest({ ...baseline, indexes: [
    ...baseline.indexes, { name: INDEX_NAME, key: {
      "booking.studioId": 1, "booking.date": 1,
    } },
  ] }), planDigest({ ...baseline, indexes: [
    ...baseline.indexes, { name: INDEX_NAME, key: INDEX_KEY },
  ] }));
});

test("rollback requires a verified receipt for the exact catalog and target", () => {
  const current = { planDigest: "catalog-a", targetFingerprint: "target-a" };
  const receipt = buildApplyReceipt("operation-a", current);
  const report = { mode: "APPLY", outcome: "SUCCEEDED", applyReceipt: receipt };
  assert.deepEqual(validateApplyReceipt(report, current), receipt);
  assert.deepEqual(validateApplyReceipt({ ...report, outcome: "CATALOG_VERIFIED" }, current), receipt);
  assert.deepEqual(validateApplyReceipt({ ...report, outcome: "POSTCHECK_FAILED_INDEX_PRESENT" }, current), receipt);
  assert.throws(() => validateApplyReceipt({ ...report, outcome: "FAILED" }, current));
  assert.throws(() => validateApplyReceipt({ ...report, outcome: "UNKNOWN_RECONCILIATION_REQUIRED" }, current));
  assert.throws(() => validateApplyReceipt(report, { ...current, planDigest: "catalog-b" }));
  assert.throws(() => validateApplyReceipt(report, { ...current, targetFingerprint: "target-b" }));
  assert.throws(() => validateApplyReceipt({
    ...report,
    applyReceipt: { ...receipt, indexName: "foreign" },
  }, current));
});

test("durable journal keeps mutation-pending evidence when final append fails", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lk-public-index-report-"));
  const reportPath = path.join(directory, "report.jsonl");
  const descriptor = fs.openSync(reportPath, "wx", 0o600);
  const pending = { mode: "APPLY", outcome: "UNKNOWN_RECONCILIATION_REQUIRED" };
  try {
    appendReport(descriptor, pending);
    syncJournalDirectory(reportPath);
    fs.closeSync(descriptor);
    assert.throws(() => appendReport(descriptor, { outcome: "SUCCEEDED" }));
    assert.deepEqual(JSON.parse(fs.readFileSync(reportPath, "utf8").trim()), pending);
  } finally {
    try { fs.closeSync(descriptor); } catch { /* already closed */ }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("rollback reads the last complete receipt despite an interrupted journal tail", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lk-public-index-receipt-"));
  const reportPath = path.join(directory, "report.jsonl");
  const current = { planDigest: "catalog-a", targetFingerprint: "target-a" };
  const verified = {
    mode: "APPLY", outcome: "CATALOG_VERIFIED",
    applyReceipt: buildApplyReceipt("operation-a", current),
  };
  try {
    fs.writeFileSync(reportPath, `${JSON.stringify(verified)}\n{"mode":"APPLY"`, { mode: 0o600 });
    assert.deepEqual(validateApplyReceipt(protectedReceipt(reportPath), current), verified.applyReceipt);
    fs.writeFileSync(reportPath, `${JSON.stringify(verified)}\n{broken}\n`, { mode: 0o600 });
    assert.throws(() => protectedReceipt(reportPath), SyntaxError);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
