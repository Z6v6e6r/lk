import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import test from "node:test";

const page = fs.readFileSync("src/components/tournament-subscription/TournamentSubscriptionPage.tsx", "utf8");
const apiClient = fs.readFileSync("src/utils/apiClient.ts", "utf8");
const css = fs.readFileSync("src/MyApp.css", "utf8");
const defaultPage = page.slice(page.indexOf("function buildDefaultPageViewConfig()"), page.indexOf("function buildPromoOfferPageViewConfig("));
const preview = fs.readFileSync("scripts/fixtures/ab-leto-preview.html", "utf8");
const catalog = fs.readFileSync("src/utils/tournamentSubscriptionCatalog.ts", "utf8");

const EXPECTED_STOREFRONT_ASSETS = new Map([
  ["summer-subscription-academy.webp", "1b7bdb5cf0c1f03847efac7ddf7cb9b7142187293a0d5a82190c61a79841847a"],
  ["summer-subscription-ra.webp", "5f89f2f44ea1cd1d2fd1e36b8fb39a2cb6dbd9d525380b0f4d588a2139142329"],
  ["summer-subscription-friendship.webp", "1ec1f7fc81cd867b9ce7127ff3b03e7ee33250224bceea7bebde89dc5703ec29"],
  ["summer-subscription-energy5.webp", "773ab011fb41d7d27ca389adfd741cefb9d8a34ac8afbf60beb307d7b514d9ba"],
  ["subscription-rules-gold.webp", "cfa623d31076199d30b2b62149744d9845fb975f3686b681641a461eac8f2358"],
  ["subscription-rules-green.webp", "ab879147110a73dab69a196de9370fff912d009941e59a8a52ce4e89e78e617c"],
  ["subscription-rules-red.webp", "f3a9a3077865eac4cc3fb6a7be1c4f64a174795f9fefa1dfa8341ada5f2e313c"],
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
  assert.doesNotMatch(defaultPage, /termsEffectiveLabel:/);
  assert.match(defaultPage, /counterKey: "network_friendship",[\s\S]*?remainingLabel: "Доступно",[\s\S]*?buttonLabel: "Оформить подписку"/);
  assert.match(page, /isGuardedStorefront && plan\.requiresConsent &&/);
  assert.match(page, /isGuardedStorefront && !plan\.hideAuthState &&/);
  assert.match(page, /requiresConsent: true/);
  assert.match(page, /if \(!isAuthenticated\) \{[\s\S]*?setAuthRequestedDisplayId\(plan\.id\)/);
  assert.match(page, /if \(!profile\?\.phone\)/);
  assert.match(page, /if \(!trackedStatus\.bindingReady\)/);
  assert.match(page, /if \(!trackedStatus\.canPurchase/);
  assert.match(page, /`\$\{status\.batchRemainingCount\} из \$\{status\.batchSize\}`/);
});

test("HUB approval preview shows 10/10 while production UI stays server-driven", () => {
  assert.match(preview, /counterKey: "network_friendship", totalLimit: 10, remainingCount: 10, batchSize: 100, batchRemainingCount: 95/);
  assert.match(preview, /dailyCapEnabled: true, dailyDropActive: true, dailyLimit: 10/);
  assert.doesNotMatch(defaultPage, /remainingValueText: "10 из 10"/);
  assert.match(apiClient, /dailyCapEnabled: toBoolean\(data\.dailyCapEnabled\) \?\? false/);
  assert.match(page, /status\?\.dailyCapEnabled[\s\S]*?`\$\{remainingCount\} из \$\{displayTotalLimit\}`[\s\S]*?: status\?\.batchSize/);
  assert.match(page, /!status && usesTrackedCounter[\s\S]*?"Статус недоступен"/);
  assert.match(page, /failedExplicitCounterKeys\.length > 0/);
  assert.match(catalog, /TOURNAMENT_SUBSCRIPTION_COUNTER_DISPLAY_OVERRIDE_KEYS = \["network_friendship"\]/);
  assert.match(preview, /: statuses\.filter\(\(status\) => status\.counterKey !== "network_friendship"\)/);
  assert.match(preview, /__AB_LETO_PREVIEW_STATUS_REQUESTS__\.push/);
  assert.match(preview, /dataset\.abLetoStatusRequests = JSON\.stringify/);
  assert.match(preview, /Предпросмотр: внешний запрос заблокирован/);
  assert.match(preview, /navigator\.sendBeacon = \(\) => false/);
});

test("ab_leto storefront keeps the approved source artwork bytes", () => {
  for (const [fileName, expectedSha256] of EXPECTED_STOREFRONT_ASSETS) {
    const bytes = fs.readFileSync(`src/assets/${fileName}`);
    assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), expectedSha256, fileName);
  }
});
