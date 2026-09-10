import assert from 'node:assert/strict';
import test from 'node:test';
import { subscriptionCounterEpoch as epoch } from '../lib/subscriptionCounterEpoch.mjs';
import { buildEmptyCounterEpochOpening } from '../lib/subscriptionCounterEpochOpening.mjs';
import { annualHistory } from '../lib/annualSubscriptionHistory.mjs';
import { loadSubscriptionSalesConfiguration } from '../lib/subscriptionSalesConfiguration.mjs';

const startedAt = '2026-09-10T09:00:00.000Z';
const clock = Date.parse(startedAt);
const commonKey = 'summer_subscription_sales_20260909_enabled';
const context = (initial = {}) => {
  const values = new Map(Object.entries(initial));
  return { get: key => values.get(key), set: (key, value) => values.set(key, value) };
};
const config = (overrides = {}) => ({ kind: 'SUBSCRIPTION_SALES_CONFIGURATION_V2', revision: 2,
  common: false, hub: false, piter: false, raClosed: false, friendshipClosed: false,
  epochStartedAt: startedAt, ...overrides });
const openingInput = (counterKey = 'network_friendship') => ({
  counterKey, startedAt, capturedAt: startedAt, now: startedAt, rows: [], flowSha256: 'a'.repeat(64),
  product: { id: annualHistory.products[counterKey].productId, productType: 'SUBSCRIPTION',
    cost: counterKey === 'network_friendship' ? 9800000 : 5680000,
    activationDays: 1, validityDays: 365, visits: 365 },
});

test('epoch selection stays on the new inventory through OFF/ON/OFF; admission closes on OFF', () => {
  const globals = context();
  loadSubscriptionSalesConfiguration(JSON.stringify(config()), globals);
  for (const counterKey of Object.keys(epoch.inventories)) {
    const fallback = `old-fixture-${counterKey}`;
    const ctx = { counterKey, inventoryId: epoch.inventories[counterKey] };
    assert.equal(epoch.activeInventory(counterKey, fallback, globals), ctx.inventoryId);
    assert.equal(epoch.admission(ctx, globals, clock), false);
    loadSubscriptionSalesConfiguration(JSON.stringify(config({ common: true })), globals);
    assert.equal(epoch.admission(ctx, globals, clock), true);
    assert.equal(epoch.admission({ ...ctx, inventoryId: fallback }, globals, clock), false);
    loadSubscriptionSalesConfiguration(JSON.stringify(config()), globals);
    assert.equal(epoch.activeInventory(counterKey, fallback, globals), ctx.inventoryId);
    assert.equal(epoch.admission(ctx, globals, clock + 1000), false);
  }
});

test('new epoch cannot admit before its exact cutoff or without explicit boolean enablement', () => {
  const globals = context({ [epoch.cutoffKey]: startedAt, [commonKey]: true });
  for (const counterKey of Object.keys(epoch.inventories)) {
    const ctx = { counterKey, inventoryId: epoch.inventories[counterKey] };
    assert.equal(epoch.admission(ctx, globals, clock - 1), false);
    assert.equal(epoch.admission(ctx, globals, clock), true);
    assert.equal(epoch.admission(ctx, globals, clock + 86400000), true);
    for (const value of ['true', 1, false, undefined]) {
      globals.set(commonKey, value);
      assert.equal(epoch.admission(ctx, globals, clock), false);
    }
    globals.set(commonKey, true);
  }
});

test('missing/malformed cutoff cannot select or admit a new epoch; unknown inventories are rejected', () => {
  for (const cutoff of [undefined, null, '', '2026-02-30T09:00:00.000Z', '2026-09-10T12:00:00+03:00']) {
    const globals = context({ [epoch.cutoffKey]: cutoff, [commonKey]: true });
    for (const counterKey of Object.keys(epoch.inventories)) {
      assert.equal(epoch.startedAt(globals), null);
      assert.equal(epoch.activeInventory(counterKey, 'old-fixture', globals), 'old-fixture');
      assert.equal(epoch.admission({ counterKey, inventoryId: epoch.inventories[counterKey] }, globals, clock), false);
    }
  }
  const globals = context({ [epoch.cutoffKey]: startedAt, [commonKey]: true });
  for (const counterKey of Object.keys(epoch.inventories)) {
    assert.equal(epoch.isNew(counterKey, 'unknown-inventory'), false);
    assert.equal(epoch.admission({ counterKey, inventoryId: 'unknown-inventory' }, globals, clock), false);
  }
  for (const counterKey of ['unrelated-counter', '__proto__', 'constructor', 'toString']) {
    assert.equal(epoch.activeInventory(counterKey, 'unchanged', globals), 'unchanged');
    assert.equal(epoch.isNew(counterKey, 'unknown-inventory'), false);
  }
});

test('descriptor binds the precise allocation scope, date and timezone', () => {
  const original = epoch.descriptor(startedAt);
  assert.equal(epoch.validDescriptor(original), true);
  for (const patch of [{ id: 'unknown' }, { startedAt: '2026-02-30T09:00:00.000Z' },
    { timeZone: 'UTC' }, { membership: 'ALL_PROVIDER_PAID' }, { extra: true }]) {
    assert.equal(Boolean(epoch.validDescriptor({ ...original, ...patch })), false);
  }
});

test('V2 configuration preserves cutoff while OFF and enables the common flag only after a valid load', () => {
  const globals = context();
  const result = loadSubscriptionSalesConfiguration(JSON.stringify(config()), globals);
  assert.equal(result.valid, true);
  assert.equal(globals.get(epoch.cutoffKey), startedAt);
  assert.equal(globals.get(commonKey), false);
  assert.deepEqual(result.configuration, config());
  const on = loadSubscriptionSalesConfiguration(JSON.stringify(config({ common: true, hub: true, piter: true })), globals);
  assert.equal(on.valid, true);
  assert.equal(globals.get(commonKey), true);
  assert.equal(globals.get(epoch.cutoffKey), startedAt);
});

test('invalid V2 clears stale enablement and fails closed for annual, RA and Friendship', () => {
  const missingCutoff = config(); delete missingCutoff.epochStartedAt;
  for (const invalid of [missingCutoff, config({ epochStartedAt: null }), config({ epochStartedAt: '' }),
    config({ epochStartedAt: '2026-02-30T09:00:00.000Z' }), config({ epochStartedAt: '2026-09-10T09:00:00Z' }),
    config({ revision: 0 }), config({ common: 'true' }), { ...config(), unexpected: true }]) {
    const globals = context({ [commonKey]: true, [epoch.cutoffKey]: startedAt });
    const result = loadSubscriptionSalesConfiguration(JSON.stringify(invalid), globals);
    assert.equal(result.valid, false);
    assert.equal(globals.get(epoch.cutoffKey), null);
    for (const key of [commonKey, 'summer_subscription_hub_lk1_sales_enabled', 'summer_subscription_piter_next_day_sales_20260909_enabled']) {
      assert.equal(globals.get(key), false);
    }
    assert.equal(globals.get('summer_subscription_ra_admission_closed'), true);
    assert.equal(globals.get('summer_subscription_friendship_admission_closed'), true);
  }
});

test('V1 compatibility preserves old fields and never manufactures an epoch cutoff', () => {
  const legacy = config({ kind: 'SUBSCRIPTION_SALES_CONFIGURATION_V1', revision: 1, common: true });
  delete legacy.epochStartedAt;
  const globals = context({ [epoch.cutoffKey]: startedAt });
  const result = loadSubscriptionSalesConfiguration(JSON.stringify(legacy), globals);
  assert.equal(result.valid, true);
  assert.deepEqual(result.configuration, legacy);
  assert.equal(globals.get(commonKey), true);
  assert.equal(globals.get(epoch.cutoffKey), null);
  assert.equal(loadSubscriptionSalesConfiguration(JSON.stringify({ ...legacy, epochStartedAt: startedAt }), globals).valid, false);
});

for (const counterKey of ['network_friendship', 'piter_friendship']) {
  test(`${counterKey}: empty opening has no inherited purchases and an exact inactive activation CAS`, () => {
    const plan = buildEmptyCounterEpochOpening(openingInput(counterKey));
    const ledger = plan.document;
    assert.equal(plan.executionAuthorized, false);
    assert.equal(ledger.inventoryId, epoch.inventories[counterKey]);
    assert.equal(ledger._id, `inventory:${ledger.inventoryId}`);
    assert.equal(ledger.ready, false);
    assert.equal(annualHistory.validate(ledger), true);
    assert.equal(ledger.history.accountingScope, 'NEW_EPOCH_RESERVATIONS_ONLY');
    assert.equal(ledger.history.openingPaidCount, 0);
    assert.deepEqual(ledger.history.entries, []);
    assert.deepEqual(ledger.history.settlements, []);
    assert.deepEqual(ledger.legacyPaymentRefs, []);
    assert.deepEqual(ledger.reservations, []);
    assert.equal(ledger.paidCount, 0);
    assert.equal(ledger.reservedCount, 0);
    assert.equal(ledger.takenCount, 0);
    assert.equal(ledger.quotaAdjustment, counterKey === 'piter_friendship' ? 52 : 0);
    if (counterKey === 'network_friendship') {
      assert.equal(ledger.dailyPaidCount, 0);
      assert.equal(ledger.dailyReservedCount, 0);
      assert.equal(ledger.dailyBaselinePaidCount, 0);
      assert.equal(Math.max(0, 1 - ledger.dailyPaidCount - ledger.dailyReservedCount), 1);
    } else assert.equal(100 - ledger.takenCount - ledger.quotaAdjustment, 48);
    assert.deepEqual(plan.activate.filter, { _id: ledger._id, $expr: { $eq: ['$$ROOT', { $literal: ledger }] } });
    assert.equal(plan.activate.options.upsert, false);
    assert.equal(plan.activate.update.$set.ready, true);
  });
}

test('opening refuses existing rows, unsupported product/counter, stale evidence and malformed binding', () => {
  const variants = [
    input => { input.rows = [{ _id: 'synthetic-old-row', inventoryId: epoch.inventories.network_friendship }]; },
    input => { input.counterKey = 'ra'; },
    input => { input.counterKey = 'unknown'; },
    input => { input.product.id = annualHistory.products.piter_friendship.productId; },
    input => { input.product.cost = 5680000; },
    input => { input.product.activationDays = 0; },
    input => { input.product.validityDays = 364; },
    input => { input.product.visits = 1; },
    input => { input.product.productType = 'MEMBERSHIP'; },
    input => { input.capturedAt = '2026-09-10T08:54:59.000Z'; },
    input => { input.capturedAt = '2026-09-10T09:00:01.000Z'; },
    input => { input.startedAt = '2026-02-30T09:00:00.000Z'; },
    input => { input.startedAt = '2026-09-10T09:00:00.001Z'; },
    input => { input.flowSha256 = 'unknown'; },
  ];
  for (const mutate of variants) {
    const input = openingInput(); mutate(input);
    assert.throws(() => buildEmptyCounterEpochOpening(input));
  }
});

test('only reservations created within the exact epoch can enter its ledger', () => {
  const ledger = buildEmptyCounterEpochOpening(openingInput()).document;
  ledger.reservations.push({ paymentRef: 'synthetic-new-ref', state: 'CLAIMED',
    createdAt: startedAt, dailyDate: ledger.dailyDate, intentFingerprint: 'synthetic-new-intent',
    saleRecord: { inventoryLedgerSchemaVersion: 3, inventoryId: ledger.inventoryId,
      counterKey: ledger.counterKey, counterEpoch: structuredClone(ledger.epoch) } });
  Object.assign(ledger, annualHistory.counts(ledger));
  assert.equal(annualHistory.validate(ledger), true);
  assert.equal(ledger.reservedCount, 1);
  assert.equal(ledger.dailyReservedCount, 1);
  for (const mutate of [
    value => { value.reservations[0].createdAt = '2026-09-10T08:59:59.999Z'; },
    value => { delete value.reservations[0].createdAt; },
    value => { value.reservations[0].saleRecord.inventoryId = epoch.previous.network_friendship; },
    value => { value.reservations[0].saleRecord.counterEpoch.startedAt = '2026-09-10T08:59:59.999Z'; },
    value => { value.reservations[0].saleRecord.counterKey = 'piter_friendship'; },
  ]) {
    const altered = structuredClone(ledger); mutate(altered);
    assert.equal(annualHistory.validate(altered), false);
  }
});

test('epoch ledger validation rejects old history, wrong scope and unknown or cross-product inventory IDs', () => {
  const ledger = buildEmptyCounterEpochOpening(openingInput()).document;
  for (const mutate of [
    value => { value.history.accountingScope = 'ALL_PROVIDER_PAID'; },
    value => { value.history.entries.push({ transactionId: 'synthetic-old-payment' }); },
    value => { value.history.settlements.push({ id: 'synthetic-old-settlement' }); },
    value => { value.legacyPaymentRefs.push('synthetic-old-ref'); },
    value => { value.history.openingPaidCount = 1; },
    value => { value.inventoryId = 'unknown'; value._id = 'inventory:unknown'; },
    value => { value.inventoryId = epoch.inventories.piter_friendship; value._id = `inventory:${value.inventoryId}`; },
    value => { value.epoch.membership = 'ALL_PROVIDER_PAID'; },
  ]) {
    const altered = structuredClone(ledger); mutate(altered);
    assert.equal(annualHistory.validate(altered), false);
  }
});
