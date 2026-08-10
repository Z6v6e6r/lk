import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  isTournamentSubscriptionStorefrontPlanRetired,
  resolveTournamentSubscriptionCounterDisplayText,
  resolveTournamentSubscriptionCounterDisplayTotalLimit,
  TOURNAMENT_SUBSCRIPTION_DIRECT_PRODUCT_IDS,
  TOURNAMENT_SUBSCRIPTION_PROMO_OFFERS,
  resolveTournamentSubscriptionDirectProductId,
  resolveTournamentSubscriptionPromoOffer,
} from "../../src/utils/tournamentSubscriptionCatalog.ts";

test("academy and ra resolve to direct Viva subscription ids", () => {
  assert.equal(
    resolveTournamentSubscriptionDirectProductId("academy"),
    TOURNAMENT_SUBSCRIPTION_DIRECT_PRODUCT_IDS.academy,
  );
  assert.equal(
    resolveTournamentSubscriptionDirectProductId("ra"),
    TOURNAMENT_SUBSCRIPTION_DIRECT_PRODUCT_IDS.ra,
  );
  assert.equal(
    resolveTournamentSubscriptionDirectProductId("energy5"),
    TOURNAMENT_SUBSCRIPTION_DIRECT_PRODUCT_IDS.energy5,
  );
  assert.equal(resolveTournamentSubscriptionDirectProductId("sport"), null);
  assert.equal(resolveTournamentSubscriptionDirectProductId(""), null);
});

test("tournament subscription catalog exposes only direct-product bindings", () => {
  assert.deepEqual(
    Object.keys(TOURNAMENT_SUBSCRIPTION_DIRECT_PRODUCT_IDS).sort(),
    ["academy", "energy5", "ra"],
  );
});

test("promo links resolve only active allowlisted Viva subscriptions", () => {
  assert.deepEqual(Object.keys(TOURNAMENT_SUBSCRIPTION_PROMO_OFFERS).sort(), [
    "academy-promo",
    "friendship-promo",
    "ra-promo",
  ]);
  assert.equal(resolveTournamentSubscriptionPromoOffer("academy-promo")?.priceLabel, "11 900 ₽");
  assert.equal(resolveTournamentSubscriptionPromoOffer("friendship-promo")?.priceLabel, "4 900 ₽");
  assert.equal(resolveTournamentSubscriptionPromoOffer("sport-promo"), null);
  assert.equal(resolveTournamentSubscriptionPromoOffer("ra-promo")?.priceLabel, "11 900 ₽");
  assert.equal(resolveTournamentSubscriptionPromoOffer(" ACADEMY-PROMO ")?.productName, "Лето.Падел.Академия Акция");
  assert.equal(resolveTournamentSubscriptionPromoOffer("unknown"), null);
  assert.equal(resolveTournamentSubscriptionPromoOffer(""), null);
});

test("tournament subscription catalog does not override live remaining values", () => {
  assert.equal(resolveTournamentSubscriptionCounterDisplayText("academy"), null);
  assert.equal(resolveTournamentSubscriptionCounterDisplayText("sport"), null);
  assert.equal(resolveTournamentSubscriptionCounterDisplayText("ra"), null);
  assert.equal(resolveTournamentSubscriptionCounterDisplayText("friendship"), null);
});

test("tournament subscription catalog leaves counters on live API totals", () => {
  assert.equal(resolveTournamentSubscriptionCounterDisplayTotalLimit("academy"), null);
  assert.equal(resolveTournamentSubscriptionCounterDisplayTotalLimit("ra"), null);
  assert.equal(resolveTournamentSubscriptionCounterDisplayTotalLimit("friendship"), null);
  assert.equal(resolveTournamentSubscriptionCounterDisplayTotalLimit("sport"), null);
  assert.equal(resolveTournamentSubscriptionCounterDisplayTotalLimit("energy5"), null);
});

test("sport is retired from every ab_leto sales entry point", () => {
  assert.equal(isTournamentSubscriptionStorefrontPlanRetired("sport"), true);
  assert.equal(isTournamentSubscriptionStorefrontPlanRetired(" SPORT "), true);
  assert.equal(isTournamentSubscriptionStorefrontPlanRetired("friendship"), false);

  const sourceText = fs.readFileSync(
    new URL("../../src/components/tournament-subscription/TournamentSubscriptionPage.tsx", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(sourceText, /id: "sport"[\s\S]*?counterKey: "sport"/);
  assert.match(sourceText, /isTournamentSubscriptionStorefrontPlanRetired\(explicitPlanId\)/);
  assert.match(sourceText, /isTournamentSubscriptionStorefrontPlanRetired\(artworkKey\)/);
});

test("storefront availability relies on live unlimited and daily-drop state", () => {
  const sourceText = fs.readFileSync(
    new URL("../../src/components/tournament-subscription/TournamentSubscriptionPage.tsx", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(sourceText, /buttonDisabled: artworkKey === "ra" \|\| artworkKey === "sport"/);
  assert.match(sourceText, /resolveTournamentSubscriptionCounterDisplayTotalLimit\(plan\.counterKey\)/);
  const academyPlanSource = sourceText.match(/id: "academy",[\s\S]*?\n\s*},\n\s*{\n\s*id: "ra"/)?.[0];
  assert.ok(academyPlanSource);
  assert.match(academyPlanSource, /hideRemainingBlock: true/);
  assert.match(sourceText, /isOutOfStock[\s\S]*?"Лимит исчерпан"/);
  assert.doesNotMatch(sourceText, /!plan\.hideRemainingBlock && trackedStatus/);
  assert.doesNotMatch(sourceText, /usesTrackedCounter\s*&&\s*!plan\.hideRemainingBlock/);
  assert.match(sourceText, /trackedStatus && !trackedStatus\.unlimited/);
  assert.match(sourceText, /status && !status\.unlimited/);
  assert.match(sourceText, /targetStatus && !targetStatus\.unlimited/);
  assert.match(sourceText, /status\?\.unlimited !== false/);
  assert.match(sourceText, /!plan\.hideRemainingBlock && !hideTemporaryUnlimitedCounter/);
});
