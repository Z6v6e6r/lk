import assert from "node:assert/strict";
import test from "node:test";
import {
  buildUniqueGameLookup,
  resolveUniqueGameForKeys,
} from "../../src/components/cabinet/gameBookingLinkResolver.ts";

type Game = { id: string; bookingIds: string[] };

test("unique booking key resolves one game", () => {
  const game: Game = { id: "game-1", bookingIds: ["booking-1"] };
  const lookup = buildUniqueGameLookup([game], (item) => item.bookingIds);
  assert.deepEqual(resolveUniqueGameForKeys(lookup, ["booking-1"]), {
    matched: true,
    value: game,
  });
});

test("duplicate key across games is retained as a fail-closed collision", () => {
  const lookup = buildUniqueGameLookup<Game>([
    { id: "game-1", bookingIds: ["booking-1"] },
    { id: "game-2", bookingIds: ["booking-1"] },
  ], (item) => item.bookingIds);

  assert.equal(lookup.has("booking-1"), true);
  assert.deepEqual(resolveUniqueGameForKeys(lookup, ["booking-1"]), {
    matched: true,
    value: null,
  });
});

test("several booking keys pointing to different games are ambiguous", () => {
  const lookup = buildUniqueGameLookup<Game>([
    { id: "game-1", bookingIds: ["booking-1"] },
    { id: "game-2", bookingIds: ["booking-2"] },
  ], (item) => item.bookingIds);

  assert.deepEqual(resolveUniqueGameForKeys(lookup, ["booking-1", "booking-2"]), {
    matched: true,
    value: null,
  });
});

test("repeated copies of the same game do not create a false collision", () => {
  const original: Game = { id: "game-1", bookingIds: ["booking-1"] };
  const refreshed: Game = { id: "game-1", bookingIds: ["booking-1"] };
  const lookup = buildUniqueGameLookup([original, refreshed], (item) => item.bookingIds);
  assert.equal(resolveUniqueGameForKeys(lookup, ["booking-1"]).value?.id, "game-1");
});

test("missing keys are distinguishable from collisions", () => {
  const lookup = buildUniqueGameLookup<Game>([], (item) => item.bookingIds);
  assert.deepEqual(resolveUniqueGameForKeys(lookup, ["booking-missing"]), {
    matched: false,
    value: null,
  });
});
