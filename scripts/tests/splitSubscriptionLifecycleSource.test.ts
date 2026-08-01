import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const gamesSource = fs.readFileSync("src/components/games/GamesPage.tsx", "utf8");
const standaloneJoinSource = fs.readFileSync("src/components/games/GameJoinPage.tsx", "utf8");

test("split create and join entrypoints share the subscription lifecycle filter", () => {
  assert.match(gamesSource, /filterSplitEligibleSubscriptions,/);
  assert.doesNotMatch(gamesSource, /function\s+filterSplitEligibleSubscriptions\s*\(/);
  assert.doesNotMatch(gamesSource, /function\s+isSplitSubscriptionStatusActive\s*\(/);
  assert.doesNotMatch(
    gamesSource,
    /preferredPaymentMode === "subscription" && !canUseSplitSubscription\s*\?\s*"one_time"/,
  );
  assert.match(gamesSource, /Выбранный абонемент больше недоступен\. Обновите список и попробуйте снова\./);
  assert.match(standaloneJoinSource, /eligibleSubscriptionCandidates\s*=\s*filterSplitEligibleSubscriptions\s*\(/);
});
