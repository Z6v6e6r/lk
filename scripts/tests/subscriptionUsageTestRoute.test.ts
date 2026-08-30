import test from "node:test";
import assert from "node:assert/strict";
import {
  isHostedSubscriptionUsageTestRoute,
  readSubscriptionUsageTestCredentials,
  subscriptionUsageTestApiPath,
} from "../../src/components/subscriptions/subscriptionUsageTestRoute.ts";

test("hosted subscription test route is enabled only for the dev release channel", () => {
  assert.equal(isHostedSubscriptionUsageTestRoute("/lk_dev", "?subscriptionTest=1", true), true);
  assert.equal(isHostedSubscriptionUsageTestRoute("/lk_dev", "?subscriptionTest=1", false), false);
  assert.equal(isHostedSubscriptionUsageTestRoute("/lk_new", "?subscriptionTest=1", true), false);
  assert.equal(isHostedSubscriptionUsageTestRoute("/lk_dev", "", true), false);
});

test("credentials are accepted only from the URL fragment", () => {
  const token = "a".repeat(32);
  assert.deepEqual(readSubscriptionUsageTestCredentials(`#offerId=test_offer%3A1&token=${token}`), {
    offerId: "test_offer:1",
    token,
  });
  assert.equal(readSubscriptionUsageTestCredentials("#offerId=test_offer:1&token=short"), null);
  assert.equal(readSubscriptionUsageTestCredentials(""), null);
});

test("API path encodes the offer id and never contains the token", () => {
  assert.equal(
    subscriptionUsageTestApiPath("test_offer:1/unsafe", "quote"),
    "/v1/subscription-test/offers/test_offer%3A1%2Funsafe/usage-scenarios/quote",
  );
  assert.equal(
    subscriptionUsageTestApiPath("test_offer:1/unsafe", "resolved-quote"),
    "/v1/subscription-test/offers/test_offer%3A1%2Funsafe/usage-scenarios/resolved-quote",
  );
});
