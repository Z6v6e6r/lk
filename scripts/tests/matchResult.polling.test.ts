import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const gamesPageSource = fs.readFileSync("src/components/games/GamesPage.tsx", "utf8");

test("rating result polling is bounded, visibility-aware, and stops using a 4 second interval", () => {
  assert.match(gamesPageSource, /MATCH_RESULT_RATING_POLL_MS\s*=\s*12_000/);
  assert.match(gamesPageSource, /MATCH_RESULT_RATING_RETRYABLE_POLL_MS\s*=\s*30_000/);
  assert.match(gamesPageSource, /document\.hidden/);
  assert.match(gamesPageSource, /addEventListener\("visibilitychange", handleVisibilityChange\)/);
  assert.match(gamesPageSource, /removeEventListener\("visibilitychange", handleVisibilityChange\)/);
  assert.match(gamesPageSource, /window\.setTimeout\(runPoll, pollDelayMs\)/);
  assert.doesNotMatch(
    gamesPageSource,
    /ratingWorkStatus === "RETRYABLE" \? 10_000 : 4_000/,
    "legacy four-second result polling must not return",
  );
});
test("closing result details resets the one-time state fetch guard", () => {
  assert.match(
    gamesPageSource,
    /if \(step === "details" && gameRecordId && canCurrentUserFetchResultState\) return;\s*resultStateFetchKeyRef\.current = null;/,
  );
});
