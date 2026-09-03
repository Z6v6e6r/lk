import test from "node:test";
import assert from "node:assert/strict";
import { subscriptionUsageTestCounterDelta } from "../../src/components/subscriptions/subscriptionUsageTestBooking.ts";

test("subscription booking consumes active and daily subscription counters", () => {
  assert.deepEqual(subscriptionUsageTestCounterDelta({
    allowed: true,
    subscriptionApplied: true,
    pricingMode: "SUBSCRIPTION",
    finalPriceMinor: 0,
    reasonCodes: [],
  }, "CREATE_GAME", 1, true), { activeServices: 1, dailyGameUsage: 1 });
});

test("invalid zero usage cannot bypass the daily subscription counter", () => {
  assert.deepEqual(subscriptionUsageTestCounterDelta({
    allowed: true,
    subscriptionApplied: true,
    pricingMode: "SUBSCRIPTION",
    finalPriceMinor: 0,
    reasonCodes: [],
  }, "CREATE_GAME", 0, true), { activeServices: 1, dailyGameUsage: 1 });
});

test("full-price fallback does not consume subscription counters", () => {
  assert.deepEqual(subscriptionUsageTestCounterDelta({
    allowed: true,
    subscriptionApplied: false,
    pricingMode: "FULL_PRICE_WITHOUT_SUBSCRIPTION",
    finalPriceMinor: 150_000,
    reasonCodes: ["ACTIVE_SERVICES_LIMIT_REACHED"],
  }, "CREATE_GAME", 1, true), { activeServices: 0, dailyGameUsage: 0 });
});

test("non-game subscription booking consumes only the active-service counter", () => {
  assert.deepEqual(subscriptionUsageTestCounterDelta({
    allowed: true,
    subscriptionApplied: true,
    pricingMode: "SUBSCRIPTION",
    finalPriceMinor: 150_000,
    reasonCodes: [],
  }, "BOOK_GROUP_TRAINING", 1, true), { activeServices: 1, dailyGameUsage: 0 });
});

test("full-duration percentage discount preserves the separate free-hour counter", () => {
  assert.deepEqual(subscriptionUsageTestCounterDelta({
    allowed: true,
    subscriptionApplied: true,
    pricingMode: "SUBSCRIPTION",
    finalPriceMinor: 157_500,
    reasonCodes: [],
  }, "CREATE_GAME", 1, false), { activeServices: 1, dailyGameUsage: 0 });
});

test("legacy partial-price benefit still consumes its included free-hour counter", () => {
  assert.deepEqual(subscriptionUsageTestCounterDelta({
    allowed: true,
    subscriptionApplied: true,
    pricingMode: "SUBSCRIPTION",
    finalPriceMinor: 52_500,
    reasonCodes: [],
  }, "JOIN_GAME", 1, true), { activeServices: 1, dailyGameUsage: 1 });
});
