import test from "node:test";
import assert from "node:assert/strict";

import { createLocalMembershipId } from "../../src/components/games/localMembershipGeneration.ts";

test("local membership ids are opaque and unique for every join generation", () => {
  const ids = new Set(Array.from({ length: 100 }, () => createLocalMembershipId()));

  assert.equal(ids.size, 100);
  for (const id of ids) {
    assert.match(id, /^local:[a-z0-9:-]+$/i);
  }
});
