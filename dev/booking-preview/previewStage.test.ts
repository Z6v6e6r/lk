import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readPreviewStage } from './previewStage.ts';
import { readMatrixSettings, buildBookingPaymentOptions } from './paymentMatrix.ts';

test('the default shared preview starts before Boost; legacy Boost links remain full scenarios', () => {
  assert.equal(readPreviewStage(new URLSearchParams()), 'current');
  assert.equal(readPreviewStage(new URLSearchParams('boost=1')), 'full');
  assert.equal(readPreviewStage(new URLSearchParams('stage=full')), 'full');
});

test('current stage disables Boost even in hand-edited frame URLs for every service', () => {
  const params = new URLSearchParams('stage=current&subscription=1&residency=1&boost=1&subscriptionPlan=friendship');
  const current = readMatrixSettings(params);
  assert.equal(current.boost, false);
  for (const service of ['game', 'training', 'tournament'] as const) {
    const options = buildBookingPaymentOptions(service, current.profile, current.applicability, current, service === 'game' ? 'quarter' : undefined, 6000);
    assert.ok(!options.some(option => option.kind === 'boost' && option.mode === 'book'));
  }
  params.set('stage', 'full');
  const full = readMatrixSettings(params);
  assert.equal(full.boost, true);
  assert.ok(buildBookingPaymentOptions('game', full.profile, full.applicability, { ...full, durationMinutes: 90 }, 'quarter', 6000)
    .some(option => option.kind === 'boost' && option.amount === 0));
});
