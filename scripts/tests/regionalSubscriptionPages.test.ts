import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const page = fs.readFileSync("src/components/tournament-subscription/TournamentSubscriptionPage.tsx", "utf8");
const entry = fs.readFileSync("src/tournament-subscription.tsx", "utf8");
const deployDocs = fs.readFileSync("docs/README_DEPLOY.md", "utf8");
const kotelnikiLoader = fs.readFileSync("docs/tilda-kotelniki-subscription.html", "utf8");
const networkLoader = fs.readFileSync("docs/tilda-network-subscription.html", "utf8");

function assertOptimizedWebp(path: string) {
  const file = fs.readFileSync(path);
  assert.equal(file.subarray(0, 4).toString("ascii"), "RIFF", `${path} must be RIFF WebP`);
  assert.equal(file.subarray(8, 12).toString("ascii"), "WEBP", `${path} must be WebP`);
  assert.ok(file.length > 0 && file.length < 200_000, `${path} should be a non-empty optimized asset`);
}

test("Kotelniki is a dedicated four-tier 4 x 50 guarded storefront", () => {
  assert.match(page, /variant === "kotelniki_friendship"/);
  assert.match(page, /counterKey: "kotelniki_friendship"/);
  assert.match(page, /KOTELNIKI_FRIENDSHIP_BATCH_SIZE = 50/);
  assert.match(page, /options\.batchSize \* options\.artworks\.length/);
  assert.match(page, /kicker: "Падел\.Дружба\.Котельники"/);

  for (const tier of [1, 2, 3, 4]) {
    const path = `src/assets/kotelniki-subscription-tier-${tier}.webp`;
    assert.match(page, new RegExp(`kotelniki-subscription-tier-${tier}\\.webp`));
    assertOptimizedWebp(path);
  }

  assert.match(kotelnikiLoader, /variant: "kotelniki_friendship"/);
  assert.match(kotelnikiLoader, /tournament-subscription-dev\.js/);
  assert.match(kotelnikiLoader, /tournament-subscription\.js/);
  assert.match(deployDocs, /четыре ценовые партии по 50 подписок/);
  assert.match(deployDocs, /fallback-лимит 200/);
});

test("network is a dedicated one-tier 50-unit guarded storefront", () => {
  assert.match(page, /variant === "network_friendship"/);
  assert.match(page, /counterKey: "network_friendship"/);
  assert.match(page, /NETWORK_FRIENDSHIP_BATCH_SIZE = 50/);
  assert.match(page, /NETWORK_FRIENDSHIP_ARTWORKS = \[networkSubscriptionImage\]/);
  assert.match(page, /remainingLabel: "До повышения цены осталось"/);
  assert.match(page, /kicker: "Падел\.Дружба\.Хаб"/);
  assert.match(page, /network-subscription\.webp/);
  assertOptimizedWebp("src/assets/network-subscription.webp");
  assert.match(page, /hasGuardedTieredStorefront = useMemo/);
  assert.match(page, /statusError && \(!hasGuardedTieredStorefront \|\| statusError !== "Unsupported counterKey"\)/);

  assert.match(networkLoader, /variant: "network_friendship"/);
  assert.match(networkLoader, /tournament-subscription-dev\.js/);
  assert.match(networkLoader, /tournament-subscription\.js/);
  assert.match(deployDocs, /одна партия из 50 подписок/);
  assert.match(deployDocs, /56 800 ₽ вместо зачёркнутой 98 800 ₽/);
});

test("regional pages share Piter terms, consent, auth and fail-closed tiered checkout", () => {
  assert.match(page, /purchaseMode: "tiered_counter"/);
  assert.match(page, /terms: \[\.\.\.PITER_FRIENDSHIP_TERMS\]/);
  assert.match(page, /requiresConsent: true/);
  assert.match(page, /const isGuardedStorefront = plan\.purchaseMode === "tiered_counter"/);
  assert.match(page, /const isBindingUnavailable = isGuardedStorefront && \(!status \|\| !status\.bindingReady\)/);
  assert.match(page, /Подтвердите согласие с условиями подписки/);
  assert.match(page, /После подтверждения условий потребуется вход/);
  assert.match(page, /Узнать условия подписки/);
  assert.doesNotMatch(kotelnikiLoader, /productId/i);
  assert.doesNotMatch(networkLoader, /productId/i);
});

test("page-open analytics distinguishes all regional storefronts", () => {
  for (const storefront of ["piter_friendship", "kotelniki_friendship", "network_friendship"]) {
    assert.ok(entry.includes(`? "${storefront}"`) || entry.includes(`=== "${storefront}"`), `missing ${storefront} analytics branch`);
  }
  assert.match(entry, /: "ab_leto"/);
});
