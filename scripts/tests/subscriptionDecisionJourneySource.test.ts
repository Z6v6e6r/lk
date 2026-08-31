import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const gamesSource = readFileSync(
  new URL("../../src/components/games/GamesPage.tsx", import.meta.url),
  "utf8",
);
const joinSource = readFileSync(
  new URL("../../src/components/games/GameJoinPage.tsx", import.meta.url),
  "utf8",
);
const apiSource = readFileSync(
  new URL("../../src/utils/apiClient.ts", import.meta.url),
  "utf8",
);
const finalizeSource = readFileSync(
  new URL(
    "../nodered_subscription_booking_nodes/fn_subscription_booking_finalize.js",
    import.meta.url,
  ),
  "utf8",
);
const devPageSource = readFileSync(
  new URL("../../src/components/subscriptions/ManagedSubscriptionDevPage.tsx", import.meta.url),
  "utf8",
);

test("create journey renders deterministic server decisions and has an imperative duplicate guard", () => {
  assert.match(gamesSource, /resolveSubscriptionDecisionPresentation\(\{[\s\S]*?action: "CREATE_GAME"/);
  assert.match(gamesSource, /pushCabinetFlashNotice\(subscriptionDecisionNotice\)/);
  assert.match(gamesSource, /splitSubscriptionSubmitInFlightRef\.current/);
  assert.match(gamesSource, /finally \{[\s\S]*splitSubscriptionSubmitInFlightRef\.current = false/);
  assert.match(gamesSource, /setLoadingPay\(false\)/);
});

test("join journey renders deterministic server decisions and always clears submission state", () => {
  assert.match(joinSource, /resolveSubscriptionDecisionPresentation\(\{[\s\S]*?action: "JOIN_GAME"/);
  assert.match(joinSource, /decisionSubmissionInFlightRef\.current/);
  assert.match(joinSource, /finally \{[\s\S]*decisionSubmissionInFlightRef\.current = false;[\s\S]*setSubmitting\(null\)/);
  assert.match(joinSource, /pushCabinetFlashNotice\(subscriptionDecisionNotice\)/);
});

test("create and join do not calculate daily subscription eligibility from client booking lists", () => {
  assert.doesNotMatch(gamesSource, /apiFetchSubscriptionDailyLimitBookings/);
  assert.doesNotMatch(joinSource, /apiFetchSubscriptionDailyLimitBookings/);
  assert.doesNotMatch(gamesSource, /resolveSubscriptionCategoryDailyLimitConflictFromBookings/);
  assert.doesNotMatch(joinSource, /resolveSubscriptionCategoryDailyLimitConflictFromBookings/);
});

test("submission paths send the selected instance to the server without client eligibility decisions", () => {
  const createSubmit = gamesSource.slice(
    gamesSource.indexOf("const handleSplitGamePay"),
    gamesSource.indexOf("const submitSplitGamePayment"),
  );
  const detailsJoinSubmit = gamesSource.slice(
    gamesSource.indexOf("const handleSplitJoinCurrentUserFromDetails"),
    gamesSource.indexOf("const handleJoinCurrentUserFromDetails"),
  );
  const dedicatedJoinSubmit = joinSource.slice(
    joinSource.indexOf("const applyDecision"),
    joinSource.indexOf("const submitDecision"),
  );
  for (const source of [createSubmit, detailsJoinSubmit, dedicatedJoinSubmit]) {
    assert.doesNotMatch(source, /filterSplitEligibleSubscriptions/);
    assert.doesNotMatch(source, /resolveSplitSubscriptionUnavailableMessage/);
    assert.doesNotMatch(source, /apiFetchSubscriptionDailyLimitBookings/);
  }
});

test("create and join subscription retries reuse a stable server operation id", () => {
  assert.match(apiSource, /function buildPadelSplitIdempotencyKey/);
  assert.match(apiSource, /`lk-split-\$\{scope\}-\$\{hashPart\(seed\)\}/);
  assert.match(apiSource, /operationId=\$\{encodeURIComponent\(operationId\)\}/);
  const subscriptionRequest = apiSource.slice(
    apiSource.indexOf("function buildPadelSplitRequest"),
    apiSource.indexOf("export async function apiCancelPadelSplitParticipantBookings"),
  );
  assert.match(subscriptionRequest, /retries: 0/);
});

test("API rejects successful-looking subscription responses without a deterministic decision", () => {
  assert.match(apiSource, /hasDeterministicSubscriptionDecision/);
  assert.match(apiSource, /requestPadelSplitPayment/);
  assert.match(apiSource, /PADEL_SPLIT_SUBSCRIPTION_TIMEOUT_MS/);
  assert.match(apiSource, /code: error\.code/);
  assert.equal(
    apiSource.match(/code: "RESPONSE_CONTRACT_INVALID", response: response\.data/g)?.length,
    2,
  );
});

test("server full-price fallback cannot be converted into a subscription booking by the client", () => {
  assert.match(finalizeSource, /payload\.state === "FULL_PRICE_WITHOUT_SUBSCRIPTION"/);
  assert.match(finalizeSource, /splitCtx\.paymentMode = "one_time"/);
  assert.match(finalizeSource, /splitCtx\.selectedPaymentMode = "one_time"/);
  assert.match(finalizeSource, /splitCtx\.bookingPaymentType = "ON_PLACE"/);
});

test("synthetic journey keeps retry ids stable until an explicit state change", () => {
  assert.match(devPageSource, /operationIdFor\(`reserve:\$\{targetId\}`\)/);
  assert.match(devPageSource, /if \(key\.startsWith\("reserve:"\)\) operationIdsRef\.current\.delete\(key\)/);
  assert.match(devPageSource, /operationIdsRef\.current\.clear\(\)/);
});
