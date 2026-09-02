import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import test from "node:test";

const page = fs.readFileSync("src/components/tournament-subscription/TournamentSubscriptionPage.tsx", "utf8");
const css = fs.readFileSync("src/MyApp.css", "utf8");
const defaultPage = page.slice(page.indexOf("function buildDefaultPageViewConfig()"), page.indexOf("function buildPromoOfferPageViewConfig("));
const preview = fs.readFileSync("scripts/fixtures/ab-leto-preview.html", "utf8");

const EXPECTED_STOREFRONT_ASSETS = new Map([
  ["summer-subscription-academy.webp", "1b7bdb5cf0c1f03847efac7ddf7cb9b7142187293a0d5a82190c61a79841847a"],
  ["summer-subscription-ra.webp", "5f89f2f44ea1cd1d2fd1e36b8fb39a2cb6dbd9d525380b0f4d588a2139142329"],
  ["summer-subscription-friendship.webp", "1ec1f7fc81cd867b9ce7127ff3b03e7ee33250224bceea7bebde89dc5703ec29"],
  ["summer-subscription-energy5.webp", "773ab011fb41d7d27ca389adfd741cefb9d8a34ac8afbf60beb307d7b514d9ba"],
  ["subscription-rules-gold.webp", "cfa623d31076199d30b2b62149744d9845fb975f3686b681641a461eac8f2358"],
  ["subscription-rules-green.webp", "ab879147110a73dab69a196de9370fff912d009941e59a8a52ce4e89e78e617c"],
  ["subscription-rules-red.webp", "f3a9a3077865eac4cc3fb6a7be1c4f64a174795f9fefa1dfa8341ada5f2e313c"],
  ["piter-subscription-tier-2.webp", "5463d78487db30a0b24a69eb01007e2e37ccdd297b3d4e43e6625f934069afbe"],
  ["piter-subscription-tier-3.webp", "74eae501698f857780ca7050c0872304615fcfc8df1efb6e6116e0b8d607a5c6"],
  ["piter-subscription-tier-4.webp", "1e1b5711a7b890d68349182a8386d78681011de6193380b2cb80edc5464f3eb2"],
  ["kotelniki-subscription-tier-1.webp", "ce2c38442b8101d41fb0b87d3f2c2db38e738d21bd352a93226cac1b73f0f989"],
  ["kotelniki-subscription-tier-2.webp", "f47100c440c3cb1e9e6e3a514400a22f2b51a2f16b525243e6e2893daef14261"],
  ["kotelniki-subscription-tier-3.webp", "e5cc7d9924b70aaf15e38a39e3df1f01c408e0b9d84b2627a62a2f9c2f98a463"],
  ["kotelniki-subscription-tier-4.webp", "e678bfeb98937ec58769dca3ff659eaff9ce14ac0ba125280ec013b7bc02c20f"],
  ["network-subscription.webp", "83a8f2ccf39908a6cbe7b5692598fdd1624a9d0a03784cb8a6815fd69b276ef6"],
]);

test("ab_leto storefront groups four short plans and only the HUB annual plan", () => {
  assert.match(css, /\.tournament-subscription-plans\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.tournament-subscription-section-title\s*\{[\s\S]*?grid-column:\s*1\s*\/\s*-1/);
  assert.match(page, /sectionLabel: "Подписки на 30 дней"/);
  assert.match(page, /sectionLabel: "Годовые подписки"/);
  assert.match(page, /id: "energy5",[\s\S]*?cardClassName: "tournament-subscription-plan--image"/);
  assert.doesNotMatch(page, /id: "energy5",[\s\S]*?tournament-subscription-plan--showcase-featured/);
  assert.match(defaultPage, /counterKey: "network_friendship"/);
  for (const counterKey of ["piter_friendship", "kotelniki_friendship"]) {
    assert.doesNotMatch(defaultPage, new RegExp(`counterKey: "${counterKey}"`));
    assert.match(page, new RegExp(`variant === "${counterKey}"`));
  }
  assert.match(page, /subscriptionRulesGreenImage/);
  assert.match(page, /subscriptionRulesGoldImage/);
  assert.match(page, /subscriptionRulesRedImage/);
  assert.match(page, /aria-label=\{isArtworkFlipped \? `Вернуться к карточке/);
  assert.match(page, /aria-hidden=\{!isArtworkFlipped\}/);
});

test("only ab_leto HUB omits consent and auth captions while purchase guards remain", () => {
  assert.match(defaultPage, /requiresConsent: false/);
  assert.match(defaultPage, /hideAuthState: true/);
  assert.match(defaultPage, /counterKey: "network_friendship",[\s\S]*?remainingLabel: "Доступно"/);
  assert.match(page, /isGuardedStorefront && plan\.requiresConsent &&/);
  assert.match(page, /isGuardedStorefront && !plan\.hideAuthState &&/);
  assert.match(page, /requiresConsent: true/);
  assert.match(page, /if \(!isAuthenticated\) \{[\s\S]*?setAuthRequestedDisplayId\(plan\.id\)/);
  assert.match(page, /if \(!profile\?\.phone\)/);
  assert.match(page, /if \(!trackedStatus\.bindingReady\)/);
  assert.match(page, /if \(!trackedStatus\.canPurchase/);
  assert.match(page, /`\$\{status\.batchRemainingCount\} из \$\{status\.batchSize\}`/);
});

test("HUB ten-per-day approval state lives only in the local preview fixture", () => {
  assert.match(preview, /counterKey: "network_friendship", totalLimit: 10, remainingCount: 10, batchSize: 10, batchRemainingCount: 10/);
  assert.match(preview, /dailyDropActive: true, dailyLimit: 10/);
  assert.doesNotMatch(defaultPage, /remainingValueText: "10 из 10"/);
  assert.match(preview, /Предпросмотр: внешний запрос заблокирован/);
  assert.match(preview, /navigator\.sendBeacon = \(\) => false/);
});

test("ab_leto storefront keeps the approved source artwork bytes", () => {
  for (const [fileName, expectedSha256] of EXPECTED_STOREFRONT_ASSETS) {
    const bytes = fs.readFileSync(`src/assets/${fileName}`);
    assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), expectedSha256, fileName);
  }
});
