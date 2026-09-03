import test from "node:test";
import assert from "node:assert/strict";
import { SplitPaymentAmbiguityGuard } from "../../src/utils/splitPaymentAmbiguityGuard.ts";

test("an ambiguous split write allows only the same intent until it settles", () => {
  const guard = new SplitPaymentAmbiguityGuard();
  const scope = "join|game-1|client-1|slot-1";
  const firstIntent = "subscription|operation-1";

  assert.equal(guard.canStart(scope, firstIntent), true);
  guard.markAmbiguous(scope, firstIntent);
  assert.equal(guard.canStart(scope, firstIntent), true);
  assert.equal(guard.canStart(scope, "subscription|operation-2"), false);
  assert.equal(guard.canStart(scope, "one_time"), false);

  guard.markSettled(scope, "subscription|operation-2");
  assert.equal(guard.canStart(scope, "one_time"), false);
  guard.markSettled(scope, firstIntent);
  assert.equal(guard.canStart(scope, "one_time"), true);
});

test("an ambiguity lock survives a new guard instance and observes cross-tab updates", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
  const first = new SplitPaymentAmbiguityGuard(storage);
  const second = new SplitPaymentAmbiguityGuard(storage);

  first.markAmbiguous("actor|exercise", "subscription|slot-2");
  assert.equal(second.canStart("actor|exercise", "one_time|slot-2"), false);
  assert.equal(second.canStart("actor|exercise", "subscription|slot-2"), true);

  second.markSettled("actor|exercise", "subscription|slot-2");
  assert.equal(first.canStart("actor|exercise", "one_time|slot-2"), true);
});
