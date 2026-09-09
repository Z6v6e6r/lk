import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const gamesSource = fs.readFileSync("src/components/games/GamesPage.tsx", "utf8");
const standaloneJoinSource = fs.readFileSync("src/components/games/GameJoinPage.tsx", "utf8");

test("create preserves lifecycle checks and joins delegate balances and lifecycle to the shared server quote", () => {
  assert.match(gamesSource, /filterSplitEligibleSubscriptions,/);
  assert.doesNotMatch(gamesSource, /function\s+filterSplitEligibleSubscriptions\s*\(/);
  assert.doesNotMatch(gamesSource, /function\s+isSplitSubscriptionStatusActive\s*\(/);
  assert.doesNotMatch(
    gamesSource,
    /preferredPaymentMode === "subscription" && !canUseSplitSubscription\s*\?\s*"one_time"/,
  );
  assert.match(gamesSource, /Не удалось определить доступный абонемент\. Обновите список и попробуйте снова\./);
  for (const source of [gamesSource, standaloneJoinSource]) {
    assert.match(source, /const eligible\s*=\s*filterSplitCategoryCompatibleSubscriptions\s*\(/);
    assert.match(source, /createJoinSubscriptionPriceTarget/);
    assert.match(source, /<JoinSubscriptionOptions/);
    assert.match(source, /Сначала проверьте стоимость и лимиты по выбранной подписке/);
  }
});

test("all split join entrypoints require an explicit client subscription selection", () => {
  for (const source of [gamesSource, standaloneJoinSource]) {
    assert.match(
      source,
      /const requestedClientSubscriptionId = String\([^)]*ClientSubscriptionId \|\| ""\)\.trim\(\);/,
    );
    assert.match(source, /Выберите абонемент для списания/);
    assert.match(source, /option\.subscriptionId/);
    assert.match(source, /clientSubscriptionId: resolvedClientSubscriptionId/);
    assert.doesNotMatch(source, /eligibleSubscriptionCandidates\[0\]/);
  }

  assert.match(gamesSource, /resolveSplitSubscriptionSelectionId\s*\(/);
  assert.match(gamesSource, /publicCreateNeedsSplitSubscriptionSelection/);
});
