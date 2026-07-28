import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const gamesSource = fs.readFileSync("src/components/games/GamesPage.tsx", "utf8");
const gameJoinSource = fs.readFileSync("src/components/games/GameJoinPage.tsx", "utf8");

test("split game create enriches client subscription before category daily limit check", () => {
  const helperIndex = gamesSource.indexOf("async function resolveSplitSubscriptionDailyLimitCandidate");
  const helperNameLookupIndex = gamesSource.indexOf("apiFetchSubscriptioName", helperIndex);
  const helperEnrichIndex = gamesSource.indexOf("withSubscriptionCategoryDailyLimitResolvedName", helperIndex);
  const functionStart = gamesSource.indexOf("const handleSplitGamePay = useCallback");
  const paymentIndex = gamesSource.indexOf("apiCreatePadelSplitGamePayment", functionStart);
  const candidateIndex = gamesSource.indexOf("resolveSplitSubscriptionDailyLimitCandidate", functionStart);
  const planIndex = gamesSource.indexOf("subscriptionPlanAllowsDailyLimitCategory", functionStart);
  const currentSubscriptionIndex = gamesSource.indexOf("currentSubscription: dailyLimitSubscriptionCandidate", functionStart);

  assert.ok(helperIndex >= 0, "daily limit subscription enrichment helper must exist");
  assert.ok(helperNameLookupIndex > helperIndex, "helper must look up SERV2 subscription name");
  assert.ok(helperEnrichIndex > helperIndex, "helper must attach resolved name for plan detection");
  assert.ok(functionStart >= 0, "split create handler must exist");
  assert.ok(paymentIndex > functionStart, "split create payment call must exist");
  assert.ok(candidateIndex > functionStart, "split create must resolve daily limit candidate");
  assert.ok(planIndex > candidateIndex, "plan matrix must use enriched candidate");
  assert.ok(currentSubscriptionIndex > candidateIndex, "conflict resolver must receive enriched candidate");
  assert.ok(candidateIndex < paymentIndex, "enrichment must run before creating Viva booking/payment");
  assert.ok(planIndex < paymentIndex, "daily limit plan check must run before creating Viva booking/payment");
  assert.ok(currentSubscriptionIndex < paymentIndex, "conflict resolver must run before creating Viva booking/payment");
});

test("standalone game join enriches client subscription before category daily limit check", () => {
  const helperIndex = gameJoinSource.indexOf("async function resolveSubscriptionDailyLimitCandidate");
  const helperNameLookupIndex = gameJoinSource.indexOf("apiFetchSubscriptioName", helperIndex);
  const helperEnrichIndex = gameJoinSource.indexOf("withSubscriptionCategoryDailyLimitResolvedName", helperIndex);
  const functionStart = gameJoinSource.indexOf("const applyDecision = useCallback");
  const paymentIndex = gameJoinSource.indexOf("apiCreatePadelSplitParticipantPayment", functionStart);
  const candidateIndex = gameJoinSource.indexOf("resolveSubscriptionDailyLimitCandidate", functionStart);
  const planIndex = gameJoinSource.indexOf("subscriptionPlanAllowsDailyLimitCategory", functionStart);
  const currentSubscriptionIndex = gameJoinSource.indexOf("currentSubscription: dailyLimitSubscriptionCandidate", functionStart);

  assert.ok(helperIndex >= 0, "standalone join enrichment helper must exist");
  assert.ok(helperNameLookupIndex > helperIndex, "standalone join helper must look up SERV2 subscription name");
  assert.ok(helperEnrichIndex > helperIndex, "standalone join helper must attach resolved name");
  assert.ok(functionStart >= 0, "standalone join handler must exist");
  assert.ok(paymentIndex > functionStart, "standalone join payment call must exist");
  assert.ok(candidateIndex > functionStart, "standalone join must resolve daily limit candidate");
  assert.ok(planIndex > candidateIndex, "standalone join plan matrix must use enriched candidate");
  assert.ok(currentSubscriptionIndex > candidateIndex, "standalone join conflict resolver must receive enriched candidate");
  assert.ok(candidateIndex < paymentIndex, "standalone join enrichment must run before creating Viva booking/payment");
  assert.ok(planIndex < paymentIndex, "standalone join plan check must run before creating Viva booking/payment");
  assert.ok(currentSubscriptionIndex < paymentIndex, "standalone join conflict resolver must run before creating Viva booking/payment");
});
