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

test("all split join entrypoints require an explicit client subscription selection", () => {
  for (const source of [gamesSource, standaloneJoinSource]) {
    assert.match(source, /findExplicitSplitSubscriptionById\s*\(/);
    assert.match(source, /Выберите абонемент для списания/);
    assert.match(source, /option\.subscriptionId/);
    assert.doesNotMatch(source, /eligibleSubscriptionCandidates\[0\]/);
  }

  assert.match(gamesSource, /resolveSplitSubscriptionSelectionId\s*\(/);
  assert.match(gamesSource, /publicCreateNeedsSplitSubscriptionSelection/);
});
