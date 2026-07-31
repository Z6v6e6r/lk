import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync("src/utils/tournamentSignupApi.ts", "utf8");

test("client subscription products prefer the concrete client subscription id", () => {
  const functionStart = source.indexOf("function normalizeVivaProduct");
  const clientSourceBranch = source.indexOf('source === "client-subscription"', functionStart);
  const clientSubscriptionIdIndex = source.indexOf('"clientSubscriptionId"', clientSourceBranch);
  const genericIdIndex = source.indexOf('"id"', clientSubscriptionIdIndex);

  assert.ok(functionStart >= 0, "Viva product normalizer must exist");
  assert.ok(clientSourceBranch > functionStart, "client subscription id branch must exist");
  assert.ok(clientSubscriptionIdIndex > clientSourceBranch, "concrete client subscription id must be considered");
  assert.ok(genericIdIndex > clientSubscriptionIdIndex, "generic id must come after client subscription id");
});

test("client subscription Viva booking checks category daily bookings before POST /bookings", () => {
  const functionStart = source.indexOf("async function apiCreateTournamentVivaBookingFromSubscription");
  const postBookingsIndex = source.indexOf('`${API_BASE}/end-user/api/v2/${TENANT_KEY}/bookings`', functionStart);
  const fetchBookingsIndex = source.indexOf("apiFetchSubscriptionDailyLimitBookings", functionStart);
  const categoryIndex = source.indexOf("resolveSubscriptionCategoryDailyLimitCategoryFromEvent", functionStart);
  const planIndex = source.indexOf("subscriptionPlanAllowsDailyLimitCategory", functionStart);
  const conflictIndex = source.indexOf("resolveSubscriptionCategoryDailyLimitConflictFromBookings", functionStart);
  const subscriptionIdIndex = source.indexOf(
    "currentClientSubscriptionId: pickSubscriptionLookupId(params.product.raw) || params.product.id",
    functionStart,
  );
  const currentSubscriptionIndex = source.indexOf("currentSubscription: params.product", functionStart);

  assert.ok(functionStart >= 0, "subscription booking function must exist");
  assert.ok(postBookingsIndex > functionStart, "direct booking POST must exist");
  assert.ok(categoryIndex > functionStart, "category resolver must be used");
  assert.ok(planIndex > functionStart, "subscription plan matrix must gate the check");
  assert.ok(fetchBookingsIndex > functionStart, "active and history bookings precheck must exist");
  assert.ok(conflictIndex > functionStart, "daily limit conflict resolver must be used");
  assert.ok(subscriptionIdIndex > functionStart, "selected client subscription id must be checked");
  assert.ok(currentSubscriptionIndex > functionStart, "selected subscription product must be passed to resolver");
  assert.ok(categoryIndex < fetchBookingsIndex, "category must be resolved before loading bookings");
  assert.ok(planIndex < fetchBookingsIndex, "subscription plan matrix must run before loading bookings");
  assert.ok(fetchBookingsIndex < postBookingsIndex, "active bookings precheck must run before POST /bookings");
  assert.ok(conflictIndex < postBookingsIndex, "conflict resolver must run before POST /bookings");
  assert.ok(subscriptionIdIndex < postBookingsIndex, "selected client subscription id must be checked before POST /bookings");
  assert.ok(currentSubscriptionIndex < postBookingsIndex, "selected subscription product must be checked before POST /bookings");
});
