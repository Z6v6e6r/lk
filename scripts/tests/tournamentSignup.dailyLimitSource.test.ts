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

test("client subscription Viva booking keeps the UX precheck and delegates the debit to the atomic server gateway", () => {
  const functionStart = source.indexOf("async function apiCreateTournamentVivaBookingFromSubscription");
  const functionEnd = source.indexOf("function buildTournamentVivaTransactionPayload", functionStart);
  const functionSource = source.slice(functionStart, functionEnd);
  const gatewayIndex = functionSource.indexOf("/lk/subscription-bookings?operationId=");
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
  assert.ok(functionEnd > functionStart, "subscription booking function must have a bounded source block");
  assert.ok(gatewayIndex > 0, "atomic subscription booking gateway call must exist");
  assert.doesNotMatch(functionSource, /end-user\/api\/v2\/[^\n]+\/bookings/);
  assert.match(functionSource, /operationId=\$\{encodeURIComponent\(idempotencyKey\)\}/);
  assert.doesNotMatch(functionSource, /Idempotency-Key/);
  assert.match(functionSource, /clientSubscriptionId/);
  assert.ok(categoryIndex > functionStart, "category resolver must be used");
  assert.ok(planIndex > functionStart, "subscription plan matrix must gate the check");
  assert.ok(fetchBookingsIndex > functionStart, "active and history bookings precheck must exist");
  assert.ok(conflictIndex > functionStart, "daily limit conflict resolver must be used");
  assert.ok(subscriptionIdIndex > functionStart, "selected client subscription id must be checked");
  assert.ok(currentSubscriptionIndex > functionStart, "selected subscription product must be passed to resolver");
  assert.ok(categoryIndex < fetchBookingsIndex, "category must be resolved before loading bookings");
  assert.ok(planIndex < fetchBookingsIndex, "subscription plan matrix must run before loading bookings");
  assert.ok(fetchBookingsIndex - functionStart < gatewayIndex, "active bookings UX precheck must run before the gateway");
  assert.ok(conflictIndex - functionStart < gatewayIndex, "UX conflict resolver must run before the gateway");
  assert.ok(subscriptionIdIndex - functionStart < gatewayIndex, "selected client subscription id must be checked before the gateway");
  assert.ok(currentSubscriptionIndex - functionStart < gatewayIndex, "selected subscription product must be checked before the gateway");
});
