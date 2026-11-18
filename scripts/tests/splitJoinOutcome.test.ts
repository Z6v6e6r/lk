import assert from "node:assert/strict";
import test from "node:test";
import { canClearSplitJoinUnknown, isAmbiguousCreateStatus, isSplitJoinBlocked } from "../../src/components/games/splitJoinOutcome.ts";

test("network failure, timeout, 5xx and unusable 2xx are ambiguous; 4xx refusals are not", () => {
  for (const status of [null, undefined, Number.NaN, 0, 200, 202, 408, 500, 502, 503, 504]) assert.equal(isAmbiguousCreateStatus(status), true, String(status));
  for (const status of [400, 401, 403, 404, 409, 422, 429]) assert.equal(isAmbiguousCreateStatus(status), false, String(status));
});

test("the block applies only to the game it was raised for and only inside the payment window", () => {
  const unknown = { gameId: "A", since: 1_000_000 };
  assert.equal(isSplitJoinBlocked(unknown, "A", 1_000_000 + 9 * 60_000, 10), true);
  assert.equal(isSplitJoinBlocked(unknown, "B", 1_000_000, 10), false, "another game is not blocked");
  assert.equal(isSplitJoinBlocked(unknown, "A", 1_000_000 + 10 * 60_000, 10), false, "the window has passed");
  assert.equal(isSplitJoinBlocked(null, "A", 0, 10), false);
});

test("a successful read without this user's payment item does not clear the block", () => {
  const unknown = { gameId: "A", since: 1_000_000 };
  assert.equal(canClearSplitJoinUnknown({ recordShowsUserPayment: false, unknown, gameId: "A", nowTs: 1_000_000 + 60_000, deadlineMinutes: 10 }), false);
  assert.equal(canClearSplitJoinUnknown({ recordShowsUserPayment: true, unknown, gameId: "A", nowTs: 1_000_000 + 60_000, deadlineMinutes: 10 }), true);
  assert.equal(canClearSplitJoinUnknown({ recordShowsUserPayment: false, unknown, gameId: "A", nowTs: 1_000_000 + 11 * 60_000, deadlineMinutes: 10 }), true);
});
