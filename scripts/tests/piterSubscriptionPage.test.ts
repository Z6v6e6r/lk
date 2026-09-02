import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import test from "node:test";

const page = fs.readFileSync("src/components/tournament-subscription/TournamentSubscriptionPage.tsx", "utf8");
const entry = fs.readFileSync("src/tournament-subscription.tsx", "utf8");
const css = fs.readFileSync("src/MyApp.css", "utf8");
const loader = fs.readFileSync("docs/tilda-piter-subscription.html", "utf8");
const router = fs.readFileSync(
  "scripts/nodered_subscription_booking_nodes/fn_subscription_booking_router.js",
  "utf8",
);

function sha256(path: string) {
  return crypto.createHash("sha256").update(fs.readFileSync(path)).digest("hex");
}

test("Piter page is a dedicated storefront with its own counter and four 100-unit artworks", () => {
  assert.match(page, /variant === "piter_friendship"/);
  assert.match(page, /counterKey: "piter_friendship"/);
  assert.match(page, /PITER_FRIENDSHIP_BATCH_SIZE = 100/);
  assert.match(page, /PITER_FRIENDSHIP_ARTWORKS\.length/);
  assert.match(page, /fallbackBatchSize: options\.batchSize/);
  assert.match(page, /`\$\{fallbackBatchSize\} из \$\{fallbackBatchSize\}`/);
  for (const tier of [1, 2, 3, 4]) {
    assert.match(page, new RegExp(`piter-subscription-tier-${tier}\\.webp`));
    assert.ok(fs.statSync(`src/assets/piter-subscription-tier-${tier}.webp`).size > 0);
  }
  assert.equal(
    sha256("src/assets/piter-subscription-tier-1.webp"),
    "57550ea171f847a528cb82c6b4b8a5fe4723acc56ffd1dc0eda75740cca1cf4f",
  );
  assert.match(entry, /storefront: options\.data\?\.variant === "piter_friendship"/);
  assert.match(loader, /variant:\s*"piter_friendship"/);
});

test("Piter page exposes the requested terms through an accessible flip control", () => {
  for (const phrase of [
    "Один час игры в день бесплатно: создание или присоединение.",
    "Игры длительностью 90 или 120 минут можно создать или присоединиться к ним со скидкой 30%.",
    "Скидка 50% действует на игру с тренером, групповые тренировки и формат «Время на друзей».",
    "По подписке можно сделать до 4 активных записей на 2 недели вперёд.",
  ]) {
    assert.ok(page.includes(phrase), `missing term: ${phrase}`);
  }
  const rulesArtwork = "src/assets/piter-subscription-rules-from-20260901.webp";
  assert.ok(fs.statSync(rulesArtwork).size > 0 && fs.statSync(rulesArtwork).size < 200_000);
  assert.equal(
    sha256(rulesArtwork),
    "3e5ad8e71c42c8e46ea6cc9bfb6f0539dd09181f940c022a8956b35172ff9c12",
  );
  assert.match(page, /piter-subscription-rules-from-20260901\.webp/);
  assert.match(page, /проданных с 01\.09\.2026 по московскому времени/);
  assert.match(router, /MANAGED_ENFORCEMENT_PURCHASE_FROM = "2026-09-01"/);
  assert.match(page, /Узнать условия подписки/);
  assert.match(page, /aria-pressed=/);
  assert.match(page, /className=\{`piter-subscription-flip piter-subscription-flip-trigger/);
  assert.match(page, /onClick=\{\(\) => setFlippedDisplayId/);
  assert.match(css, /\.piter-subscription-flip--flipped[\s\S]*?rotateY\(180deg\)/);
  assert.match(css, /\.piter-subscription-flip-trigger:focus-visible/);
  assert.match(css, /\.piter-subscription-face--rules-artwork/);
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
