import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const page = fs.readFileSync("src/components/tournament-subscription/TournamentSubscriptionPage.tsx", "utf8");
const entry = fs.readFileSync("src/tournament-subscription.tsx", "utf8");
const css = fs.readFileSync("src/MyApp.css", "utf8");
const loader = fs.readFileSync("docs/tilda-piter-subscription.html", "utf8");

test("Piter page is a dedicated storefront with its own counter and four 100-unit artworks", () => {
  assert.match(page, /variant === "piter_friendship"/);
  assert.match(page, /counterKey: "piter_friendship"/);
  assert.match(page, /PITER_FRIENDSHIP_BATCH_SIZE = 100/);
  assert.match(page, /PITER_FRIENDSHIP_ARTWORKS\.length/);
  for (const tier of [1, 2, 3, 4]) {
    assert.match(page, new RegExp(`piter-subscription-tier-${tier}\\.webp`));
    assert.ok(fs.statSync(`src/assets/piter-subscription-tier-${tier}.webp`).size > 0);
  }
  assert.match(entry, /storefront: options\.data\?\.variant === "piter_friendship"/);
  assert.match(loader, /variant:\s*"piter_friendship"/);
});

test("Piter page exposes the requested terms through an accessible flip control", () => {
  for (const phrase of [
    "Одна игра в день: создание или присоединение.",
    "По подписке можно создать только игру длительностью 60 минут.",
    "Присоединиться по подписке можно к игре длительностью 60, 90 или 120 минут.",
    "дополнительные 30 или 60 минут оплачиваются отдельно со скидкой",
    "Групповые тренировки доступны на специальных условиях",
    "Турниры доступны на специальных условиях",
  ]) {
    assert.ok(page.includes(phrase), `missing term: ${phrase}`);
  }
  assert.match(page, /Узнать условия подписки/);
  assert.match(page, /aria-pressed=/);
  assert.match(css, /\.piter-subscription-flip--flipped[\s\S]*?rotateY\(180deg\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});

test("Piter checkout requires consent and leaves product and price selection to the server", () => {
  assert.match(page, /requiresConsent: true/);
  assert.match(page, /Подтвердите согласие с условиями подписки/);
  assert.match(page, /Я ознакомился\(ась\) и согласен\(на\) с условиями подписки/);
  const tieredBranch = page.match(/if \(plan\.purchaseMode === "tiered_counter"\)[\s\S]*?if \(plan\.purchaseMode === "catalog_subscription"\)/)?.[0];
  assert.ok(tieredBranch);
  assert.match(tieredBranch, /apiCreateTournamentSubscriptionPurchase\(\{[\s\S]*?counterKey,/);
  assert.doesNotMatch(tieredBranch, /productId\s*:/);
  assert.match(tieredBranch, /!trackedStatus\.bindingReady/);
});
