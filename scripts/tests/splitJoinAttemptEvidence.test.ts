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

test("an HTTP status alone never proves a pre-provider refusal", () => {
  for (const status of [null, undefined, 0, 200, 201, 202, 400, 401, 403, 404, 408, 409, 422, 423, 429, 500, 503, Number.NaN]) {
    assert.equal(isDefinitiveSplitJoinRefusal(status), false, String(status));
    assert.equal(isDefinitiveSplitJoinRefusal(status, { error: "Viva request failed", details: { message: "x" } }), false, String(status));
  }
});

test("only an exact pre-write status + code pair is definitive, in the real Node-RED shape too", () => {
  const nodeRed = (code: string) => ({ error: "refused", details: { code } });
  assert.equal(isDefinitiveSplitJoinRefusal(400, nodeRed("SPLIT_GAME_LOCATION_INCOMPLETE")), true);
  assert.equal(isDefinitiveSplitJoinRefusal(401, nodeRed("SPLIT_JOIN_AUTH_REQUIRED")), true);
  assert.equal(isDefinitiveSplitJoinRefusal(403, nodeRed("SPLIT_JOIN_ACTOR_MISMATCH")), true);
  assert.equal(isDefinitiveSplitJoinRefusal(403, { code: "SPLIT_JOIN_ACTOR_MISMATCH" }), true, "top-level code shape");
  // Right code, wrong status: the pair is the evidence.
  assert.equal(isDefinitiveSplitJoinRefusal(404, nodeRed("SPLIT_JOIN_AUTH_REQUIRED")), false);
  assert.equal(isDefinitiveSplitJoinRefusal(409, nodeRed("SPLIT_GAME_LOCATION_INCOMPLETE")), false);
});

test("in-flight, provider and unknown codes keep the hold wherever they appear", () => {
  for (const status of [400, 401, 403, 404, 422]) {
    assert.equal(isDefinitiveSplitJoinRefusal(status, { error: "x", details: { code: "SPLIT_JOIN_CHECKOUT_PENDING" } }), false, `${status} nested`);
    assert.equal(isDefinitiveSplitJoinRefusal(status, { code: "SPLIT_JOIN_CHECKOUT_PENDING" }), false, `${status} top`);
    assert.equal(isDefinitiveSplitJoinRefusal(status, { error: "x", details: { code: "UNAUTHORIZED" } }), false, `${status} provider`);
    assert.equal(isDefinitiveSplitJoinRefusal(status, { error: "x", details: { code: "SPLIT_PROVIDER_TRANSACTION_MISMATCH" } }), false);
  }
  assert.equal(isDefinitiveSplitJoinRefusal(401, { code: "SPLIT_JOIN_AUTH_REQUIRED", details: { code: "UNAUTHORIZED" } }), false,
    "a provider code next to ours is not a pre-write refusal");
});

test("deadline-driven and money-ambiguous statuses never end an attempt", () => {
  for (const status of ["EXPIRED", "RELEASED", "ERROR", "REFUNDED", "FAILED_REFUND", "CANCELLING", "CANCEL_REQUESTED",
    "PENDING_CANCEL", "VOID_PENDING", "CANCELLED_EXPIRED", "DECLINE_PENDING"]) {
    assert.equal(classifySplitJoinAttempt(record([{ status, paymentRef: "r" }]), "r"), "pending", status);
  }
  for (const status of ["CANCELLED", "DECLINED", "FAILED", "REJECTED", "VOIDED"]) {
    assert.equal(classifySplitJoinAttempt(record([{ status, paymentRef: "r" }]), "r"), "terminal", status);
  }
});
