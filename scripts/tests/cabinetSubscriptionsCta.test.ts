import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("cabinet subscription CTA opens the summer subscription storefront", () => {
  const source = fs.readFileSync("src/components/cabinet/SubscriptionsContainer.tsx", "utf8");

  assert.match(source, /const SUMMER_SUBSCRIPTION_URL = "https:\/\/padlhub\.ru\/ab_leto";/);
  assert.match(source, /<a className="buy-btn" href=\{SUMMER_SUBSCRIPTION_URL\}>\s*Абонементы и подписки\s*<\/a>/);
  assert.doesNotMatch(source, /Приобрести абонемент/);
  assert.doesNotMatch(source, /onClick=\{openBuy\}/);
});

test("cabinet subscriptions block no longer wires the legacy buy popup CTA", () => {
  const source = fs.readFileSync("src/components/cabinet/Cabinet.tsx", "utf8");

  assert.doesNotMatch(source, /openBuy=\{\(\) => setOpenBuySub\(true\)\}/);
  assert.doesNotMatch(source, /isOpenBuySub/);
  assert.doesNotMatch(source, /<BuySupscription/);
});

test("cabinet subscription CTA keeps white text in anchor states", () => {
  const source = fs.readFileSync("src/MyApp.css", "utf8");

  assert.match(source, /\.buy-btn\s*\{[\s\S]*color:\s*var\(--white\)\s*!important;[\s\S]*-webkit-text-fill-color:\s*var\(--white\);/);
  assert.match(source, /\.buy-btn:link,\s*\.buy-btn:visited,\s*\.buy-btn:hover,\s*\.buy-btn:focus\s*\{[\s\S]*color:\s*var\(--white\)\s*!important;[\s\S]*-webkit-text-fill-color:\s*var\(--white\);/);
});
