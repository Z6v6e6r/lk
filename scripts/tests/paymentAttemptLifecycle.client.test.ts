import { hasDeterministicSubscriptionDecision } from "../../src/utils/subscriptionDecisionContract.ts";
import { resolveSubscriptionDecisionPresentation } from "../../src/utils/subscriptionDecisionUi.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { isSettledPaymentAttempt, canOpenPaymentAttempt, paymentAttemptDeadline, paymentAttemptFields, PAYMENT_ATTEMPT_TTL_MS } from "../../src/utils/paymentAttemptLifecycle.ts";
import { SubscriptionRejoinTracker } from "../../src/utils/subscriptionRejoin.ts";
import { recoverSplitCreateResult, SplitCreateAttempts } from "../../src/utils/splitCreateRecovery.ts";
const start = Date.parse("2026-11-16T12:00:00Z");
const url = "https://pay.example.com/attempt";
const attempt = { paymentUrl: url, createdAt: new Date(start).toISOString() };
test("original creation anchors fifteen minutes; reopening cannot extend the deadline", () => {
  assert.equal(paymentAttemptDeadline(attempt), start + PAYMENT_ATTEMPT_TTL_MS);
  assert.equal(canOpenPaymentAttempt(attempt, start + PAYMENT_ATTEMPT_TTL_MS - 1), true);
  assert.equal(canOpenPaymentAttempt(attempt, start + PAYMENT_ATTEMPT_TTL_MS), false);
  assert.equal(paymentAttemptDeadline({ ...attempt, expiresAt: new Date(start + 30 * 60_000).toISOString() }), start + PAYMENT_ATTEMPT_TTL_MS);
});
test("earlier provider deadline wins and explicit server deadline survives a restored response", () => {
  const deadline = new Date(start + 5 * 60_000).toISOString();
  assert.equal(paymentAttemptDeadline({ ...attempt, paymentExpiresAt: deadline }), start + 5 * 60_000);
  assert.deepEqual(paymentAttemptFields({ paymentUrl: url, paymentExpiresAt: deadline, paymentAttemptState: " payment_required " }),
    { paymentExpiresAt: deadline, paymentAttemptState: "PAYMENT_REQUIRED" });
  assert.equal(canOpenPaymentAttempt({ paymentUrl: url, paymentExpiresAt: deadline }, start + 6 * 60_000), false);
});
test("no anchor and invalid deadlines cannot invent a new payment window", () => {
  for (const value of [{ paymentUrl: url }, { paymentUrl: url, expiresAt: "bad" }, { paymentUrl: url, createdAt: "bad" }]) {
    assert.equal(paymentAttemptDeadline(value), null);
    assert.equal(canOpenPaymentAttempt(value, start), false);
  }
});
test("paid and closing attempts block old URL, including case and nested raw evidence", () => {
  for (const state of ["PAID", "paid", " closing ", " expired ", "cancelled", "RELEASED", "future_unknown_state"]) {
    assert.equal(canOpenPaymentAttempt({ ...attempt, paymentAttemptState: state }, start + 1), false);
    assert.equal(canOpenPaymentAttempt({ ...attempt, raw: { paymentAttemptState: state } }, start + 1), false);
  }
  assert.equal(canOpenPaymentAttempt({ ...attempt, paid: true }, start + 1), false);
  assert.equal(canOpenPaymentAttempt({ ...attempt, paymentUrl: "javascript:alert(1)" }, start + 1), false);
  assert.equal(canOpenPaymentAttempt({ ...attempt, paymentUrl: "https://user:pass" + "@" + "example.com" }, start + 1), false);
});
test("server-proved create successor is selected only by later submission, never expiry", () => {
  const tracker = new SubscriptionRejoinTracker(null), base = "lk-split-create-fixture";
  const raw = { details: { code: "SUBSCRIPTION_BOOKING_RELEASED", operationId: base, nextOperationId: base + ":rejoin:1" } };
  assert.equal(tracker.resolve(base), base);
  assert.equal(tracker.rememberReleased(base, 202, raw), false);
  assert.equal(tracker.rememberReleased(base, 409, raw), true);
  assert.equal(tracker.resolve(base), base + ":rejoin:1");
});
test("create recovery remains read-only and returns released successor instead of reposting", async () => {
  const base = "lk-split-create-fixture", attempts = new SplitCreateAttempts(null);
  attempts.begin(base, "payment-ref-original");
  assert.equal(attempts.begin(base, "payment-ref-new").recoveryOnly, true);
  const released = { status: 409, data: null, error: { status: 409, message: "released", raw: { details: {
    code: "SUBSCRIPTION_BOOKING_RELEASED", operationId: base, nextOperationId: base + ":rejoin:1" } } } };
  let reads = 0;
  const result = await recoverSplitCreateResult({ operationId: base, paymentRef: "payment-ref-original", clientSubscriptionId: "sub",
    studioId: "studio", roomId: "room", fromTime: "2026-11-16T19:00:00+03:00", toTime: "2026-11-16T20:00:00+03:00" },
  async () => { reads++; return released; }, { session: () => "session", delaysMs: [0, 0], wait: async () => {} });
  assert.equal(result, released);
  assert.equal(reads, 1);
  assert.equal(attempts.has(base), true); // Only caller handling proved release completes this journal.
});

test("positive paid amount needs typed settled identity and never reopens its old URL", () => {
  const paid = { paymentAttemptState: "PAID", paid: true, paymentUrl: null, transactionId: "transaction",
    exerciseId: "exercise", bookingId: "booking", toPayMinor: 100000 };
  assert.equal(isSettledPaymentAttempt(paid), true);
  assert.equal(canOpenPaymentAttempt({ ...attempt, ...paid }, start + 1), false);
  for (const delta of [{ paymentAttemptState: undefined }, { transactionId: "" }, { exerciseId: undefined },
    { bookingId: undefined }, { paid: false }, { paymentUrl: url }]) assert.equal(isSettledPaymentAttempt({ ...paid, ...delta }), false);
});

test("a settled positive-price game is confirmed rather than asking for the same copay again", () => {
  const raw = { state: "CONFIRMED", paymentAttemptState: "PAID", paid: true, paymentUrl: null,
    transactionId: "transaction", exerciseId: "exercise", bookingId: "booking", toPay: 1000, toPayMinor: 100000 };
  const result = { ...raw, selectedPaymentMode: "subscription", raw };
  const presentation = resolveSubscriptionDecisionPresentation({ action: "JOIN_GAME", requestedPaymentMode: "subscription", result });
  assert.equal(presentation.kind, "SUBSCRIPTION_ALLOWED");
  assert.equal(presentation.reasonCode, "SUBSCRIPTION_PAYMENT_CONFIRMED");
});

test("settled ordinary split keeps all original request bindings and requires typed paid proof", () => {
  const raw = { state: "FULL_PRICE_WITHOUT_SUBSCRIPTION", mode: "join", paymentAttemptState: "PAID", paid: true,
    paymentUrl: null, paymentRef: "reference", operationId: "operation", transactionId: "transaction",
    exerciseId: "exercise", bookingId: "booking", gameId: "game", settlementState: "CONFIRMED", toPay: 1000, toPayMinor: 100000 };
  const result = { ...raw, selectedPaymentMode: "one_time", raw };
  const expected = { action: "join" as const, paymentRef: "reference", operationId: "operation", exerciseId: "exercise", gameId: "game" };
  assert.equal(hasDeterministicSubscriptionDecision(result, "one_time", expected), true);
  assert.equal(hasDeterministicSubscriptionDecision(result, "one_time", { ...expected, gameId: "other" }), false);
  assert.equal(hasDeterministicSubscriptionDecision({ ...result, raw: { ...raw, transactionId: "foreign" } }, "one_time", expected), false);
  assert.equal(hasDeterministicSubscriptionDecision({ ...result, paymentAttemptState: undefined, raw: { ...raw, paymentAttemptState: undefined } }, "one_time", expected), false);
});

test("ordinary split head and original creation survive normalization without extending expiry", () => {
  const fields = paymentAttemptFields({ paymentAttemptHeadKey: "head:opaque", paymentAttemptCreatedAt: new Date(start).toISOString(),
    paymentExpiresAt: new Date(start + 30 * 60_000).toISOString(), paymentAttemptState: "PAYMENT_REQUIRED" });
  assert.equal(fields.paymentAttemptHeadKey, "head:opaque");
  assert.equal(fields.paymentAttemptCreatedAt, new Date(start).toISOString());
  assert.equal(Date.parse(fields.paymentExpiresAt!), start + PAYMENT_ATTEMPT_TTL_MS);
  assert.equal(canOpenPaymentAttempt({ ...fields, paymentUrl: url }, start + 16 * 60_000), false);
});
