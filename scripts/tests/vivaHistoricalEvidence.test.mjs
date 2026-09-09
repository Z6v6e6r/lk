import assert from "node:assert/strict";
import test from "node:test";
import { assertVivaRefundProof, buildVivaRefundProof, matchesVivaPaymentDeadline, parseVivaTimestamp } from "../lib/vivaHistoricalEvidence.mjs";

test("Viva deadline accepts only identical instants or creation ns to GET us serialization", () => {
  assert.equal(matchesVivaPaymentDeadline("2026-08-22T16:55:56.889956319+03:00", "2026-08-22T16:55:56.889956+03:00"), true);
  assert.equal(matchesVivaPaymentDeadline("2026-08-22T16:55:56.889956319+03:00", "2026-08-22T13:55:56.889956Z"), true);
  assert.equal(matchesVivaPaymentDeadline("2026-08-22T16:55:56.889956000+03:00", "2026-08-22T13:55:56.889956Z"), true);
  assert.equal(matchesVivaPaymentDeadline("2026-08-22T16:55:56+03:00", "2026-08-22T13:55:56.000Z"), true);
  const local = "2026-08-22T16:55:56.889956319+03:00";
  for (const other of [
    "2026-08-22T16:55:56.889955+03:00", "2026-08-22T16:55:56.889957+03:00",
    "2026-08-22T16:55:56.889956318+03:00", "2026-08-22T16:55:56.889956320+03:00",
    "2026-08-22T16:55:56.889+03:00", "2026-08-22T16:55:56.889956", "2026-08-22T16:55:56.889956Z",
  ]) assert.equal(matchesVivaPaymentDeadline(local, other), false, other);
  assert.equal(matchesVivaPaymentDeadline("2026-08-22T16:55:56.889956+03:00", local), false);
  assert.equal(matchesVivaPaymentDeadline("1969-12-31T23:59:59.889956319Z", "1969-12-31T23:59:59.889956Z"), true);
  assert.equal(matchesVivaPaymentDeadline("1969-12-31T23:59:59.889956319Z", "1969-12-31T23:59:59.889957Z"), false);
});

test("timestamp parser rejects invalid calendar values and never assigns a zone", () => {
  for (const value of [null, "", "2026-02-30T10:00:00Z", "2026-01-01T24:00:00Z", "2026-01-01T10:60:00Z",
    "2026-01-01T10:00:60Z", "2026-01-01T10:00:00+24:00", "2026-01-01T10:00:00+03:60",
    "2026-01-01", "2026-01-01T10:00:00.1234567890Z", " 2026-01-01T10:00:00Z"]) {
    assert.equal(parseVivaTimestamp(value), null, String(value));
  }
  assert.equal(parseVivaTimestamp("2024-02-29T10:00:00").nanoseconds, null);
  assert.equal(parseVivaTimestamp("2024-02-29T10:00:00", { requireZone: true }), null);
});

test("refund proof preserves distinct raw entity times and checks amounts and timestamps", () => {
  const transaction = { refundSum: 1980000, refundedAt: "2026-09-07T21:06:51.262235+03:00" };
  const subscription = { refundSum: 1980000, refundedAt: "2026-09-07T18:06:51.257991" };
  const proof = buildVivaRefundProof(transaction, subscription);
  assert.equal(proof.transactionRefundedAt, transaction.refundedAt);
  assert.equal(proof.subscriptionRefundedAt, subscription.refundedAt);
  assert.throws(() => buildVivaRefundProof(transaction, { ...subscription, refundSum: 1 }), /amount mismatch/);
  assert.throws(() => assertVivaRefundProof(proof, { refundSumMinor: 1 }), /proof mismatch/);
  assert.throws(() => assertVivaRefundProof(proof, { transactionRefundedAt: subscription.refundedAt }), /proof mismatch/);
  for (const value of [null, "", "2026-02-30T10:00:00", "invalid"]) {
    assert.throws(() => buildVivaRefundProof(transaction, { ...subscription, refundedAt: value }), /proof mismatch/);
  }
  assert.throws(() => buildVivaRefundProof({ ...transaction, refundedAt: subscription.refundedAt }, subscription), /proof mismatch/);
  assert.throws(() => buildVivaRefundProof({ ...transaction, refundSum: 0 }, { ...subscription, refundSum: 0 }), /proof mismatch/);
});
