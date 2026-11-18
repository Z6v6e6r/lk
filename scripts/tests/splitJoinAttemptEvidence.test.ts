import assert from "node:assert/strict";
import test from "node:test";
import { classifySplitJoinAttempt, isDefinitiveSplitJoinRefusal } from "../../src/utils/splitJoinAttemptEvidence.ts";

const record = (payments: unknown[]) => ({ metadata: { splitPayment: { payments } } });

test("only the item with the exact paymentRef is evidence", () => {
  const game = record([{ clientId: "c", status: "CANCELLED", paymentRef: "old" }, { clientId: "c", status: "PAID", paymentRef: "other" }]);
  assert.equal(classifySplitJoinAttempt(game, "new"), "absent");
  assert.equal(classifySplitJoinAttempt(game, "old"), "terminal");
  assert.equal(classifySplitJoinAttempt(game, "other"), "paid");
});

test("a pending exact item stays pending regardless of its deadline", () => {
  const expired = record([{ status: "PAYMENT_PENDING", paymentRef: "r", deadlineAt: "2000-01-01T00:00:00Z" }]);
  assert.equal(classifySplitJoinAttempt(expired, "r"), "pending");
  assert.equal(classifySplitJoinAttempt(record([{ status: "", paymentRef: "r" }]), "r"), "pending");
});

test("paid wins over terminal for the same attempt; mixed terminal and pending stays pending", () => {
  assert.equal(classifySplitJoinAttempt(record([{ status: "CANCELLED", paymentRef: "r" }, { status: "PAID", paymentRef: "r" }]), "r"), "paid");
  assert.equal(classifySplitJoinAttempt(record([{ status: "CANCELLED", paymentRef: "r" }, { status: "PAYMENT_PENDING", paymentRef: "r" }]), "r"), "pending");
});

test("malformed records and empty refs are never evidence", () => {
  for (const value of [null, undefined, "x", [], {}, { metadata: null }, { metadata: { splitPayment: { payments: "x" } } }]) {
    assert.equal(classifySplitJoinAttempt(value, "r"), "absent");
  }
  assert.equal(classifySplitJoinAttempt(record([{ status: "PAID", paymentRef: "r" }]), " "), "absent");
});

test("only statuses rejected before the provider are definitive; 409 and in-flight codes are not", () => {
  for (const status of [400, 401, 403, 404, 422]) assert.equal(isDefinitiveSplitJoinRefusal(status), true, String(status));
  for (const status of [null, undefined, 0, 200, 201, 202, 408, 409, 423, 429, 500, 503, Number.NaN]) {
    assert.equal(isDefinitiveSplitJoinRefusal(status), false, String(status));
  }
  assert.equal(isDefinitiveSplitJoinRefusal(400, { code: "SPLIT_JOIN_CHECKOUT_PENDING" }), false);
});

test("deadline-driven and money-ambiguous statuses never end an attempt", () => {
  for (const status of ["EXPIRED", "RELEASED", "ERROR", "REFUNDED", "FAILED_REFUND"]) {
    assert.equal(classifySplitJoinAttempt(record([{ status, paymentRef: "r" }]), "r"), "pending", status);
  }
  for (const status of ["CANCELLED", "DECLINED", "FAILED", "REJECTED", "VOIDED"]) {
    assert.equal(classifySplitJoinAttempt(record([{ status, paymentRef: "r" }]), "r"), "terminal", status);
  }
});
