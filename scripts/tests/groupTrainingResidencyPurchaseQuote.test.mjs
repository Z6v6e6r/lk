import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { extractSubscriptionPricePreviewSource } from '../lib/subscriptionPricePreviewSources.mjs';

const read = path => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const preview = name => read('../nodered_subscription_price_preview_nodes/' + name + '.js');
const entry = new Function('msg', 'global', 'Date', preview('entry'));
const router = new Function('msg', 'canonical', 'global', 'Date', preview('router'));
const final = new Function('msg', 'global', 'Date', preview('final'));
const roots = ['isObj', 'unwrapRecord', 'resolveCategory', 'eventStartsAt', 'eventDurationMinutes',
  'exerciseRoomId', 'managedExternalEventTypeId', 'collectExactProductIds', 'hasCompleteBookingList', 'extractItems'];
const { source } = extractSubscriptionPricePreviewSource({
  source: read('../nodered_subscription_booking_nodes/fn_subscription_booking_router.js'), roots
});
const canonical = new Function(source + ';return {' + roots.join(',') + '};')();
Object.assign(canonical, {
  identityMoneyOwned: () => assert.fail('first purchase cannot use the existing-owned booking path'),
  isProTrainingExercise: () => false,
  isSpanishTrainingExercise: () => false
});
const now = Date.parse('2026-11-19T08:41:20.984Z');
class Clock extends Date { static now() { return now; } }
const productId = '4037a3a3-e551-4f9a-a9db-1410e46b8635';
const exerciseId = '4c9f00aa-d286-4a48-ad29-98757bd0ca87';
const tariffId = 'd52bc36c-14bb-419b-8601-6f5f33bd1a07';
const actorId = 'b53b03f3-99e0-44d1-9341-1c0766c4b7c2';
const stationId = '588b6151-f4f5-47d9-9449-80edf8cbc748';
const startsAt = '2026-11-20T05:00:00.000Z';
const authorization = 'Bearer fixture-player';
const integrationToken = 'fixture-only-integration-'.repeat(2);
const cupUrl = 'https://padlhub.su/api/internal/subscriptions/residency-purchase-policy';
const settings = {
  subscriptions_residency_purchase_quote_enabled: true,
  subscriptions_runtime_environment: 'PROD',
  subscriptions_runtime_api_base_url: 'https://padlhub.su/api',
  subscriptions_runtime_context_integration_token: integrationToken
};
const target = { targetKind: 'GROUP_TRAINING_RESIDENCY_PURCHASE', exerciseId };
const targetFromViva = {
  exerciseId, stationId, externalEventTypeId: 'viva:direction:3685:type:605', startsAt, durationMinutes: 60
};
const publication = { publicationId: 'publication:fixture', policyVersion: 2, policyDigest: 'sha256:' + 'e'.repeat(64) };
const residencyProduct = {
  id: productId, cost: 79000, type: 'GROUP', variant: 'BY_VISITS', appliesTo: 'BOOKING',
  validityDays: 30, visits: 30, activationDays: 0, hasStudioLimitation: false, hasDirectionLimitation: false,
  hasDayLimitation: false, hasTimeRangeLimitation: false, hasDayTimeLimitation: false,
  hasTypeLimitation: true, availableTypes: [{ id: 2572 }]
};

function previewQuote(changes = {}) {
  const globals = { get: key => ({ ...settings, ...changes.settings })[key] };
  const msg = entry({ req: { headers: { authorization } }, payload: changes.body ?? { target } }, globals, Clock);
  const seen = [];
  for (let step = 0; step < 7; step += 1) {
    const result = router(msg, canonical, globals, Clock);
    if (result[4]) {
      final(msg, globals, Clock);
      assert(!Object.hasOwn(msg.headers, 'X-Subscriptions-Integration-Token'));
      assert(!Object.hasOwn(msg, '_subscriptionPricePreview'));
      return { status: msg.statusCode, body: msg.payload, seen };
    }
    assert.equal(result[0], msg, 'only the existing HTTP read output is used');
    assert.equal(result.filter(Boolean).length, 1);
    const route = new URL(msg.url);
    const readingPolicy = route.origin === 'https://padlhub.su';
    assert.equal(msg.followRedirects, false);
    assert.equal(msg.headers.Authorization, authorization);
    assert.equal(msg.method, readingPolicy ? 'POST' : 'GET');
    assert.equal(msg.headers['X-Subscriptions-Integration-Token'], readingPolicy ? integrationToken : undefined);
    seen.push(route.pathname.split('/').at(-1));
    msg.statusCode = 200;
    msg.responseUrl = msg.url;
    if (readingPolicy) {
      assert.equal(msg.url, cupUrl);
      assert.deepEqual(msg.payload, targetFromViva);
      msg.statusCode = changes.policyStatus ?? 200;
      msg.responseUrl = changes.policyResponseUrl ?? msg.url;
      msg.payload = { schemaVersion: 1, ...targetFromViva, providerProductId: productId, ...publication,
        groupTrainingDiscountPercent: 50, observedAt: new Date(now).toISOString(),
        validUntil: new Date(now + 30000).toISOString(), ...changes.policy };
    } else {
      assert.equal(route.origin, 'https://api.vivacrm.ru');
      if (route.pathname.endsWith('/profile')) msg.payload = changes.profile ?? { id: actorId };
      else if (route.pathname.endsWith(exerciseId)) {
        msg.payload = { id: exerciseId, studioId: stationId, roomId: stationId, directionId: 3685, typeId: 605,
          timeFrom: '2026-11-20T08:00:00+03:00', timeTo: '2026-11-20T09:00:00+03:00', ...changes.exercise };
      } else if (route.pathname.endsWith('/subscriptions')) {
        assert.equal(route.searchParams.get('includeFinished'), 'true');
        if (target.targetKind === (changes.body?.target ?? target).targetKind) assert.equal(route.searchParams.get('page'), '0');
        msg.payload = changes.subscriptions ?? { content: [], number: 0, totalElements: 0, totalPages: 0 };
      } else if (route.pathname.endsWith('/one-times')) {
        assert.equal(route.searchParams.get('exerciseId'), exerciseId);
        msg.payload = changes.tariffs ?? [{ id: tariffId, cost: 550000, productType: 'SERVICE' }];
      } else if (route.pathname.endsWith('/subscriptions/' + productId)) {
        msg.payload = { ...residencyProduct, ...changes.residency };
      } else assert.fail('unexpected Viva read: ' + route.pathname);
    }
  }
  assert.fail('preview did not finish within the bounded read sequence');
}

test('server resolves the selected group training and returns the first-purchase amounts', () => {
  const result = previewQuote();
  assert.equal(result.status, 200);
  assert.deepEqual(result.seen, ['profile', exerciseId, 'subscriptions', 'one-times', productId, 'residency-purchase-policy']);
  assert.deepEqual(result.body, { serverTimeMs: now, residencyPurchaseQuote: {
    schemaVersion: 1, kind: 'GROUP_TRAINING_RESIDENCY_PURCHASE_QUOTE', exerciseId,
    startsAt, durationMinutes: 60, currency: 'RUB', participationProductId: tariffId,
    residencyProductId: productId, existingResidency: 'NONE', ...publication,
    participationBaseMinor: 550000, discountPercent: 50, participationDiscountMinor: 275000,
    participationToPayMinor: 275000, residencyMinor: 79000, totalMinor: 354000, expiresAt: now + 30000
  } });
});

test('ordinary subscription preview keeps its response shape for a player with no subscriptions', () => {
  const result = previewQuote({ body: { target: { targetKind: 'GROUP_TRAINING', exerciseId } } });
  assert.deepEqual(result, { status: 200, body: { quotes: [], serverTimeMs: now }, seen: ['profile', exerciseId, 'subscriptions'] });
});

test('fails closed before reads if the mode is disabled, misconfigured or supplied with client prices', () => {
  for (const changes of [
    { settings: { subscriptions_residency_purchase_quote_enabled: false } },
    { settings: { subscriptions_runtime_api_base_url: 'https://untrusted.example/api' } },
    { body: { target: { ...target, priceMinor: 1 } } },
    { body: { target, subscriptionIds: [actorId] } }
  ]) {
    const result = previewQuote(changes);
    assert.deepEqual(result.seen, []);
    assert(result.status >= 400);
  }
});

test('incomplete, contradictory or previously owned residency data never becomes NONE', () => {
  for (const subscriptions of [
    { content: [], totalElements: 1 },
    [{ productId: tariffId }],
    { content: [{}], totalElements: 1 },
    { content: [{ productId: tariffId, templateId: productId }], totalElements: 1 },
    { content: [{ productId, status: 'FINISHED' }], totalElements: 1 }
  ]) {
    const result = previewQuote({ subscriptions });
    assert(result.status >= 400);
    assert.deepEqual(result.seen, ['profile', exerciseId, 'subscriptions']);
  }
  assert.equal(previewQuote({ subscriptions: { content: [{ productId: tariffId }], totalElements: 1 } }).status, 200);
});

test('refuses an invalid exercise, tariff or residency card before requesting the CUP rule', () => {
  for (const changes of [
    { profile: { id: actorId, clientId: stationId } },
    { exercise: { id: stationId } },
    { exercise: { directionId: 6233 } },
    { tariffs: [] },
    { tariffs: [{ id: tariffId, cost: 0, productType: 'SERVICE' }] },
    { residency: { id: stationId } },
    { residency: { discountPrice: 80000 } },
    { residency: { hasDayLimitation: true } }
  ]) {
    const result = previewQuote(changes);
    assert(result.status >= 400);
    assert(!result.seen.includes('residency-purchase-policy'));
  }
});

test('fails closed on denied, foreign, stale, future-dated or unbound CUP responses', () => {
  for (const [changes, status] of [
    [{ policyStatus: 422 }, 422],
    [{ policyStatus: 503 }, 503],
    [{ policyResponseUrl: cupUrl + '/other' }, 503],
    [{ policy: { exerciseId: stationId } }, 503],
    [{ policy: { externalEventTypeId: 'viva:direction:5507:type:605' } }, 503],
    [{ policy: { policyDigest: 'missing' } }, 503],
    [{ policy: { observedAt: new Date(now + 1).toISOString() } }, 503],
    [{ policy: { validUntil: new Date(now).toISOString() } }, 503],
    [{ policy: { groupTrainingDiscountPercent: '50' } }, 503]
  ]) {
    const result = previewQuote(changes);
    assert.equal(result.status, status);
    assert(!Object.hasOwn(result.body, 'residencyPurchaseQuote'));
  }
});

test('uses the returned percentage and rounds the event discount down in kopecks', () => {
  const quote = previewQuote({ tariffs: [{ id: tariffId, cost: 550001, productType: 'SERVICE' }],
    policy: { groupTrainingDiscountPercent: 25 } }).body.residencyPurchaseQuote;
  assert.equal(quote.participationDiscountMinor, 137500);
  assert.equal(quote.totalMinor, 491501);
});
