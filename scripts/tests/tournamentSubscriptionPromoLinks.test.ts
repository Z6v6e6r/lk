import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const entrypointSource = fs.readFileSync(
  new URL("../../src/tournament-subscription.tsx", import.meta.url),
  "utf8",
);
const pageSource = fs.readFileSync(
  new URL("../../src/components/tournament-subscription/TournamentSubscriptionPage.tsx", import.meta.url),
  "utf8",
);
const loaderSource = fs.readFileSync(
  new URL("../../docs/tilda-tournament-subscription.html", import.meta.url),
  "utf8",
);

test("public promo links default to automatic purchase and can disable it on bank return", () => {
  assert.match(entrypointSource, /searchParams\.get\("offer"\)/);
  assert.match(entrypointSource, /autoPurchaseRaw[\s\S]*Boolean\(offerKey\)/);
  assert.match(pageSource, /setPendingPurchaseRequest\(\{ displayId: targetPlan\.id \}\)/);
  assert.match(pageSource, /loadingProfile \|\| !profileLoaded/);
  assert.match(pageSource, /searchParams\.set\("autoPurchase", "0"\)/);
});

test("Tilda loader forwards promo link state without accepting arbitrary product ids", () => {
  assert.match(loaderSource, /searchParams\.get\("offer"\)/);
  assert.match(loaderSource, /autoPurchase: autoPurchase/);
  assert.match(loaderSource, /offerKey: offerKey \|\| undefined/);
  assert.doesNotMatch(loaderSource, /searchParams\.get\(["']productId["']\)/);
  assert.doesNotMatch(entrypointSource, /searchParams\.get\(["']productId["']\)/);
});

test("promo purchase return URL disables automatic second transaction", () => {
  assert.match(
    pageSource,
    /buildReturnUrl\(\{ disableAutoPurchase: Boolean\(pageConfig\?\.offerKey\) \}\)/,
  );
});
