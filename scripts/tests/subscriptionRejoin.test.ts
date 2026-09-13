import test from "node:test";
import assert from "node:assert/strict";
import { SubscriptionRejoinTracker, nextSubscriptionRejoinId } from "../../src/utils/subscriptionRejoin.ts";
import { resolveSubscriptionDecisionPresentation } from "../../src/utils/subscriptionDecisionUi.ts";

const base = "lk-split-join-fixture";
const next = `${base}:rejoin:1`;
const released = (operationId = base) => ({ details: {
  code: "SUBSCRIPTION_BOOKING_RELEASED", operationId, nextOperationId: nextSubscriptionRejoinId(operationId),
} });
function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) || null, setItem: (key: string, value: string) => { values.set(key, value); } };
}
test("released result only changes the next explicit submission and survives reload", () => {
  const store = storage(), tracker = new SubscriptionRejoinTracker(store);
  const submitted = tracker.resolve(base);
  assert.equal(submitted, base);
  assert.equal(tracker.rememberReleased(submitted, 409, released()), true);
  assert.equal(submitted, base, "in-flight poll keeps its original identity");
  assert.equal(tracker.resolve(base), next);
  assert.equal(new SubscriptionRejoinTracker(store).resolve(base), next);
  assert.equal(tracker.resolve("lk-split-join-other"), "lk-split-join-other");
});
test("unproven or conflicting release responses never select another operation", () => {
  for (const [status, raw] of [
    [202, released()], [500, released()], [409, { details: { code: "PENDING_CONFIRMATION" } }],
    [409, released("lk-split-join-other")],
    [409, { details: { ...released().details, nextOperationId: `${base}:rejoin:2` } }],
    [409, { details: { ...released().details, nextOperationId: "lk-split-join-forged" } }],
  ] as const) {
    const tracker = new SubscriptionRejoinTracker(null);
    assert.equal(tracker.rememberReleased(base, status, raw), false);
    assert.equal(tracker.resolve(base), base);
  }
});
test("stale concurrent responses cannot rewind a later generation", () => {
  const store = storage(), a = new SubscriptionRejoinTracker(store), b = new SubscriptionRejoinTracker(store);
  a.rememberReleased(base, 409, released());
  b.rememberReleased(next, 409, released(next));
  a.rememberReleased(base, 409, released());
  assert.equal(a.resolve(base), `${base}:rejoin:2`);
  assert.equal(new SubscriptionRejoinTracker(store).resolve(base), `${base}:rejoin:2`);
});
test("corrupt storage is ignored, unavailable storage keeps a deterministic in-memory hint", () => {
  const store = storage(); store.setItem(`lk:subscription-rejoin:${base}`, "lk-split-join-other:rejoin:20");
  assert.equal(new SubscriptionRejoinTracker(store).resolve(base), base);
  const tracker = new SubscriptionRejoinTracker({ getItem() { throw Error("denied"); }, setItem() { throw Error("denied"); } });
  tracker.rememberReleased(base, 409, released());
  assert.equal(tracker.resolve(base), next);
  for (const invalid of ["random", `${base}:rejoin:0`, `${base}:rejoin:01`, `${base}:rejoin:1001`, `${base}:rejoin:1000`]) {
    assert.equal(nextSubscriptionRejoinId(invalid), null);
  }
});
test("released booking and unresolved result have distinct truthful presentations", () => {
  const input = { action: "JOIN_GAME" as const, requestedPaymentMode: "subscription" as const };
  const done = resolveSubscriptionDecisionPresentation({ ...input, error: { status: 409, message: "released", raw: released() } });
  assert.equal(done.kind, "BOOKING_RELEASED");
  assert.match(done.message, /Присоединиться снова/);
  const pending = resolveSubscriptionDecisionPresentation({ ...input, error: { status: 202, message: "pending", raw: { state: "PENDING_CONFIRMATION" } } });
  assert.equal(pending.kind, "PENDING_CONFIRMATION");
  assert.doesNotMatch(pending.message, /Запрос принят|льгота не спишется/);
});
