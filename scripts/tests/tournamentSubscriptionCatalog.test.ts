import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
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

test("promo links resolve only the four allowlisted Viva subscriptions", () => {
  assert.deepEqual(Object.keys(TOURNAMENT_SUBSCRIPTION_PROMO_OFFERS).sort(), [
    "academy-promo",
    "friendship-promo",
    "ra-promo",
    "sport-promo",
  ]);
  assert.equal(resolveTournamentSubscriptionPromoOffer("academy-promo")?.priceLabel, "11 900 ₽");
  assert.equal(resolveTournamentSubscriptionPromoOffer("friendship-promo")?.priceLabel, "4 900 ₽");
  assert.equal(resolveTournamentSubscriptionPromoOffer("sport-promo")?.priceLabel, "9 900 ₽");
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

test("tournament subscription catalog displays new drop sizes as counter totals", () => {
  assert.equal(resolveTournamentSubscriptionCounterDisplayTotalLimit("academy"), 100);
  assert.equal(resolveTournamentSubscriptionCounterDisplayTotalLimit("ra"), 5);
  assert.equal(resolveTournamentSubscriptionCounterDisplayTotalLimit("friendship"), 5);
  assert.equal(resolveTournamentSubscriptionCounterDisplayTotalLimit("sport"), 126);
  assert.equal(resolveTournamentSubscriptionCounterDisplayTotalLimit("energy5"), null);
});

test("limited storefront buttons rely on live availability instead of hardcoded disable flags", () => {
  const sourceText = fs.readFileSync(
    new URL("../../src/components/tournament-subscription/TournamentSubscriptionPage.tsx", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(sourceText, /id: "sport"[\s\S]*?buttonDisabled: true/);
  assert.doesNotMatch(sourceText, /buttonDisabled: artworkKey === "ra" \|\| artworkKey === "sport"/);
  assert.match(sourceText, /resolveTournamentSubscriptionCounterDisplayTotalLimit\(plan\.counterKey\)/);
  assert.match(sourceText, /id: "academy"[\s\S]*?hideRemainingBlock: true/);
  assert.match(sourceText, /id: "sport"[\s\S]*?hideRemainingBlock: true/);
  assert.doesNotMatch(sourceText, /!plan\.hideRemainingBlock && trackedStatus/);
  assert.doesNotMatch(sourceText, /usesTrackedCounter\s*&&\s*!plan\.hideRemainingBlock/);
  assert.match(sourceText, /trackedStatus && !trackedStatus\.unlimited/);
  assert.match(sourceText, /status && !status\.unlimited/);
});
