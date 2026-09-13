import assert from "node:assert/strict";
import test from "node:test";
import { canCreateGameAfterLookup } from "../../src/components/cabinet/bookingGameCreationGuard.ts";

const confirmedMissing = {
  gamesLoaded: true,
  loading: false,
  error: null,
  exactLinkState: "none" as const,
  hasLinkedGame: false,
};

test("allows an empty successful lookup only after the games list has loaded", () => {
  assert.equal(canCreateGameAfterLookup({ ...confirmedMissing, gamesLoaded: false }), false);
  assert.equal(canCreateGameAfterLookup(confirmedMissing), true);
});

test("blocks initial, in-flight, failed and ambiguous exact booking lookups", () => {
  for (const exactLinkState of [undefined, "loading", "error", "unique", "ambiguous"] as const) {
    assert.equal(canCreateGameAfterLookup({ ...confirmedMissing, exactLinkState }), false, exactLinkState);
  }
});

test("a missing exact match cannot override a game matched by exercise or time slot", () => {
  assert.equal(canCreateGameAfterLookup({ ...confirmedMissing, hasLinkedGame: true }), false);
});

test("refresh and list failures keep creation closed even with an older empty lookup", () => {
  assert.equal(canCreateGameAfterLookup({ ...confirmedMissing, loading: true }), false);
  assert.equal(canCreateGameAfterLookup({ ...confirmedMissing, error: "Games unavailable" }), false);
  assert.equal(canCreateGameAfterLookup({ ...confirmedMissing, gamesLoaded: false }), false);
  assert.equal(canCreateGameAfterLookup(confirmedMissing), true);
});
