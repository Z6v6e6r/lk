import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

const read = path => fs.readFileSync(path, 'utf8');

const joinPage = read('src/components/games/GameJoinPage.tsx');
const gamesPage = read('src/components/games/GamesPage.tsx');
const resolver = read('src/components/games/resolveSplitOrdinaryPrice.ts');
const pricing = read('src/components/games/splitOrdinaryPricing.ts');
const workflow = read('.github/workflows/lk1-subscription-enforcement.yml');

test('the invite join surface prices a nominal record from the exact court price', () => {
  assert.match(joinPage, /import \{ useSplitOrdinaryPrice \} from "\.\/useSplitOrdinaryPrice";/);
  assert.match(joinPage, /const splitOrdinaryPricing = useSplitOrdinaryPrice\(\{/);
  assert.match(joinPage, /const resolvedSplitOrdinaryShareAmount = splitOrdinaryPricing\.price\?\.shareAmount \?\? null;/);
  assert.match(joinPage, /const shareAmount = resolveSplitDisplayShareAmount\(\{/);
  assert.match(joinPage, /ordinaryStatus: splitOrdinaryPricing\.status,/);
  assert.match(joinPage, /const splitShareAmount = resolveSplitDisplayShareAmount\(\{/);
  assert.doesNotMatch(joinPage, /const splitShareAmount = resolvedSplitPromoShareAmount \?\? getSplitShareAmount\(game\);/);
});

test('the invite join surface divides by the same share count the server charges', () => {
  assert.match(joinPage, /resolveSplitJoinShareCount\(getSplitShareCount\(game\), game \? resolveMaxPlayers\(game\) : 0\)/);
  assert.match(joinPage, /const shareCount = resolveSplitJoinShareCount\(\s*\n\s*getSplitShareCount\(actualGame\),\s*\n\s*resolveMaxPlayers\(actualGame\),\s*\n\s*\);/);
  assert.doesNotMatch(joinPage, /getSplitShareCount\(game\)\s*\n\s*\?\? \(!game \|\| resolveMaxPlayers\(game\) <= DEFAULT_SINGLES_MAX_PLAYERS/);
});

test('a subscription-organized game keeps its campaign/CUP price on both surfaces', () => {
  assert.match(joinPage, /const splitOrganizerUsedSubscription = useMemo\(/);
  assert.match(joinPage, /enabled: Boolean\(game && splitPricingGameId\) && !splitOrganizerUsedSubscription,/);
  assert.match(gamesPage, /const detailsSplitOrganizerUsedSubscription = useMemo\(/);
  assert.match(gamesPage, /enabled: isDetailsSplitPaymentGame && !detailsSplitOrganizerUsedSubscription,/);
});

test('the cabinet game details surface uses the same ordinary price resolution', () => {
  assert.match(gamesPage, /import \{ useSplitOrdinaryPrice \} from "\.\/useSplitOrdinaryPrice";/);
  assert.match(gamesPage, /const detailsSplitOrdinaryPricing = useSplitOrdinaryPrice\(\{/);
  assert.match(gamesPage, /resolveSplitJoinShareCount\(detailsSplitPaymentMetadata\?\.shareCount, detailsMaxPlayers\)/);
  assert.match(gamesPage, /const storedIsCanonical = hasCanonicalSplitSharePrice\(detailsSplitPaymentMetadata\);/);
  assert.match(gamesPage, /ordinaryShareAmount: detailsSplitOrdinaryPricing\.price\?\.shareAmount \?\? null,/);
  assert.match(gamesPage, /ordinaryStatus: detailsSplitOrdinaryPricing\.status,/);
  assert.equal((gamesPage.match(/detailsSplitOrdinaryPricing\.status === "failed"/g) || []).length, 1);
});

test('a browser amount is never persisted as the stored participant share', () => {
  assert.equal(
    (joinPage.match(/shareAmount: toFiniteNumber\(paymentResult\.data\.shareAmount\) \?\? shareAmount,/g) || []).length,
    1,
  );
  assert.equal(
    (gamesPage.match(/shareAmount: toFiniteNumber\(paymentResult\.data\.shareAmount\) \?\? shareAmount,/g) || []).length,
    2,
  );
});

test('the resolver keeps the server exact-price contract instead of browser amounts', () => {
  assert.match(resolver, /const contract = resolveSplitOrdinaryPriceContract\(params\);/);
  assert.match(resolver, /if \(!contract\) return \{ status: "unavailable" \};/);
  assert.match(resolver, /apiFetchMasterServicePrice\(\{/);
  assert.match(resolver, /masterServiceId: contract\.masterServiceId,/);
  assert.match(resolver, /subServiceIds: contract\.subServiceIds,/);
  assert.match(resolver, /const price = buildSplitOrdinaryPrice\(result\.data, contract\.shareCount\);/);
  assert.match(resolver, /return price \? \{ status: "resolved", price \} : \{ status: "failed" \};/);
  // A missing session or an explicit refusal is not a price and must not unlock the fallback.
  assert.match(resolver, /if \(status === 401 \|\| status === 403\) return \{ status: "unavailable" \};/);
  assert.doesNotMatch(resolver, /shareAmount/);
});

test('canonicality requires a server-derived total or a valid pricing-policy snapshot', () => {
  assert.match(pricing, /if \(toPositiveNumber\(splitPayment\.totalAmount\) !== null\) return true;/);
  assert.match(pricing, /return isPricingPolicySnapshot\(splitPayment\.pricingPolicy\);/);
  assert.match(pricing, /mode === "PER_PARTICIPANT_HOUR"/);
  // Only a real, executed lookup may fail open to the legacy stored share.
  assert.match(pricing, /return params\.ordinaryStatus === "failed" \? stored : null;/);
});

test('the new pricing regressions run in the required CI matrix', () => {
  for (const file of [
    'scripts/tests/splitOrdinaryPricing.test.ts',
    'scripts/tests/splitOrdinaryPriceHook.test.mjs',
    'scripts/tests/splitJoinOrdinaryPriceSource.test.mjs',
  ]) {
    assert.ok(workflow.includes(file), `${file} missing from the required CI matrix`);
  }
});
