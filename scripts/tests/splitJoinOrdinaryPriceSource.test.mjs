import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

const read = path => fs.readFileSync(path, 'utf8');

const joinPage = read('src/components/games/GameJoinPage.tsx');
const gamesPage = read('src/components/games/GamesPage.tsx');
const resolver = read('src/components/games/resolveSplitOrdinaryPrice.ts');
const pricing = read('src/components/games/splitOrdinaryPricing.ts');

test('the invite join surface prices a nominal record from the exact court price', () => {
  assert.match(joinPage, /import \{ useSplitOrdinaryPrice \} from "\.\/useSplitOrdinaryPrice";/);
  assert.match(joinPage, /const splitOrdinaryPricing = useSplitOrdinaryPrice\(\{/);
  assert.match(joinPage, /const resolvedSplitOrdinaryShareAmount = splitOrdinaryPricing\.price\?\.shareAmount \?\? null;/);
  // The participant payload prefers the campaign price, then the exact court
  // share, and only then the stored value.
  assert.match(
    joinPage,
    /const shareAmount = promoShareAmount\s*\n\s*\?\? resolvedSplitOrdinaryShareAmount\s*\n\s*\?\? getSplitShareAmount\(actualGame\)/,
  );
  // The displayed share never falls back to the nominal 10 000 / share count.
  assert.match(joinPage, /const splitShareAmount = resolveSplitDisplayShareAmount\(\{/);
  assert.doesNotMatch(joinPage, /const splitShareAmount = resolvedSplitPromoShareAmount \?\? getSplitShareAmount\(game\);/);
});

test('the cabinet game details surface uses the same ordinary price resolution', () => {
  assert.match(gamesPage, /import \{ useSplitOrdinaryPrice \} from "\.\/useSplitOrdinaryPrice";/);
  assert.match(gamesPage, /const detailsSplitOrdinaryPricing = useSplitOrdinaryPrice\(\{/);
  assert.match(gamesPage, /const storedIsCanonical = hasCanonicalSplitSharePrice\(detailsSplitPaymentMetadata\);/);
  assert.match(gamesPage, /ordinaryShareAmount: detailsSplitOrdinaryPricing\.price\?\.shareAmount \?\? null,/);
  assert.match(gamesPage, /ordinarySettled: detailsSplitOrdinaryPricing\.settled,/);
});

test('the resolver keeps the server exact-price contract instead of browser amounts', () => {
  assert.match(resolver, /const contract = resolveSplitOrdinaryPriceContract\(params\);/);
  assert.match(resolver, /apiFetchMasterServicePrice\(\{/);
  assert.match(resolver, /masterServiceId: contract\.masterServiceId,/);
  assert.match(resolver, /subServiceIds: contract\.subServiceIds,/);
  assert.match(resolver, /return buildSplitOrdinaryPrice\(result\.data, contract\.shareCount\);/);
  assert.doesNotMatch(resolver, /shareAmount/);
});

test('canonicality requires a server-derived total or a pricing-policy snapshot', () => {
  assert.match(pricing, /if \(toPositiveNumber\(splitPayment\.totalAmount\) !== null\) return true;/);
  assert.match(pricing, /const policy = splitPayment\.pricingPolicy;/);
  assert.match(pricing, /return params\.ordinarySettled \? stored : null;/);
});
