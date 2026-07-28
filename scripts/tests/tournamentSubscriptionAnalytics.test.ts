import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const entrySource = fs.readFileSync("src/tournament-subscription.tsx", "utf8");
const analyticsSource = fs.readFileSync("src/utils/analytics.ts", "utf8");

test("ab_leto emits one dedicated page-open analytics event", () => {
  assert.match(entrySource, /subscriptionPageOpenTracked/);
  assert.match(entrySource, /trackAnalyticsEvent\("subscription_page_opened"/);
  assert.match(entrySource, /storefront: "ab_leto"/);
});

test("page-open event is persisted even when general analytics is errors-only", () => {
  assert.match(
    analyticsSource,
    /ANALYTICS_EVENT_ALLOWLIST = new Set\(\["client_error", "subscription_page_opened"\]\)/,
  );
  assert.match(analyticsSource, /ANALYTICS_EVENT_ALLOWLIST\.has\(eventName\)/);
});
