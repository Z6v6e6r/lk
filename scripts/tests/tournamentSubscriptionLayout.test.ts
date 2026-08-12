import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const page = fs.readFileSync("src/components/tournament-subscription/TournamentSubscriptionPage.tsx", "utf8");
const css = fs.readFileSync("src/MyApp.css", "utf8");

test("ab_leto storefront keeps its four cards in the desktop two-column grid", () => {
  assert.match(css, /\.tournament-subscription-plans\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(page, /id: "energy5",[\s\S]*?cardClassName: "tournament-subscription-plan--image"/);
  assert.doesNotMatch(page, /id: "energy5",[\s\S]*?tournament-subscription-plan--showcase-featured/);
});
