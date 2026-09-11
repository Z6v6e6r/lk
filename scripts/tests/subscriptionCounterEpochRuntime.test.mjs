import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { subscriptionCounterEpoch as epoch } from '../lib/subscriptionCounterEpoch.mjs';
import { buildEmptyCounterEpochOpening } from '../lib/subscriptionCounterEpochOpening.mjs';
import { annualHistory } from '../lib/annualSubscriptionHistory.mjs';

const now = '2026-09-10T09:00:00.000Z';
const stamp = Date.parse(now);
const phone = '7' + '9990000000';
const plain = value => JSON.parse(JSON.stringify(value));
const policy = { productId: annualHistory.products.network_friendship.productId, maxActiveBookings: 4,
  freeGameMinutesPerDay: 60, gameOverageDiscountPercent: 30, groupTrainingDiscountPercent: 50, tournamentDiscountPercent: 50 };
const hubReceipt = { mode: 'LK1_VIVA_PRODUCT_NEXT_DAY_V1', bookingUsageScope: 'SUBSCRIPTION_BENEFIT_ONLY',
  policy, sourceDigest: 'sha256:' + 'a'.repeat(64) };
const globals = (overrides = {}) => ({ subscription_counter_epoch_started_at: now,
  summer_subscription_sales_20260909_enabled: true,
  summer_subscription_ab_leto_20260903_release_enabled: true,
  summer_subscription_hub_lk1_sales_enabled: true,
  summer_subscription_piter_next_day_sales_20260909_enabled: true,
  subscriptions_lk1_product_policy: policy, subscriptions_lk1_hub_sale_runtime: hubReceipt,
  ...overrides });
class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : [stamp])); }
  static now() { return stamp; }
}
function run(name, msg, values = globals()) {
  const file = new URL(`../nodered_games_nodes/fn_tournament_subscription_${name}.js`, import.meta.url);
  const script = new vm.Script(`(function(msg, global, env) {\n${fs.readFileSync(file, 'utf8')}\n})(msg, global, env)`,
    { filename: file.pathname });
  return script.runInNewContext({ msg, Date: FixedDate, URL, URLSearchParams,
    global: { get: key => Object.hasOwn(values, key) ? values[key] : undefined },
    env: { get: key => key === 'VIVACRM_TOKEN_REQUEST_BODY' ? 'synthetic-auth-body' : undefined } }, { timeout: 3000 });
}
const noProviderOutput = output => assert.equal(output[4], null);
const atomicRejected = (output, code) => {
  assert.ok([409, 503].includes(output[3]?.statusCode), JSON.stringify(plain(output)));
  if (code) assert.equal(output[3].payload.details.code, code);
  assert.equal(output[0], null); assert.equal(output[1], null); assert.equal(output[2], null);
  noProviderOutput(output);
};

function annualFixture(counterKey, state = 'PAYMENT_PENDING') {
  const input = { counterKey, startedAt: now, capturedAt: now, now, rows: [], flowSha256: 'a'.repeat(64),
    product: { id: annualHistory.products[counterKey].productId, productType: 'SUBSCRIPTION',
      cost: counterKey === 'network_friendship' ? 9800000 : 5680000, activationDays: 1, validityDays: 365, visits: 365 } };
  const ledger = buildEmptyCounterEpochOpening(input).document;
  ledger.ready = true;
  const reservation = { paymentRef: 'synthetic-epoch-payment', transactionId: 'synthetic-epoch-tx', state,
    requestFingerprint: 'synthetic-request', intentFingerprint: 'synthetic-intent', dispatchGeneration: 1,
    priceMinor: counterKey === 'network_friendship' ? 9800000 : 1980000,
    dailyDate: ledger.dailyDate, createdAt: now, providerAttemptedAt: now,
    saleRecord: { inventoryLedgerSchemaVersion: 3, inventoryId: ledger.inventoryId,
      counterKey, counterEpoch: structuredClone(ledger.epoch) } };
  ledger.reservations.push(reservation);
  Object.assign(ledger, annualHistory.counts(ledger));
  assert.equal(annualHistory.validate(ledger), true);
  const ctx = { action: 'confirm', counterKey, inventoryId: ledger.inventoryId,
    counterEpoch: structuredClone(ledger.epoch), inventoryLedgerSchemaVersion: 3,
    paymentRef: reservation.paymentRef, transactionId: reservation.transactionId,
    requestFingerprint: reservation.requestFingerprint, dispatchGeneration: 1,
    expectedAmountMinor: reservation.priceMinor, totalLimit: counterKey === 'network_friendship' ? 100 : 400,
    dailyLimit: 1, dailyDropDate: ledger.dailyDate, providerAttemptedAt: now,
    confirmResult: { nextStatus: 'PAID', transactionId: reservation.transactionId, paid: true },
    hubLk1Sale: counterKey === 'network_friendship' ? hubReceipt : null };
  return { ledger, reservation, ctx };
}

for (const counterKey of ['ra', 'friendship']) {
  test(`${counterKey}: real prepare → limit → provider result → confirm preserves epoch without annual schema/fingerprint`, () => {
    const prepared = run('purchase_prepare', { payload: { counterKey, paymentRef: `synthetic-${counterKey}`,
      clientPhone: phone, clientId: 'synthetic-client' } });
    assert.ok(prepared[0], JSON.stringify(plain(prepared)));
    const preparedCtx = prepared[0]._summerSubscriptionCtx;
    assert.equal(preparedCtx.inventoryId, epoch.inventories[counterKey]);
    assert.deepEqual(plain(preparedCtx.counterEpoch), epoch.descriptor(now));
    assert.ok(plain(prepared[0].payload).$or.some(q => q.paymentRef === preparedCtx.paymentRef));
    assert.equal(preparedCtx.dailyLimit, counterKey === 'ra' ? 10 : 7);
    const limit = run('purchase_limit', { ...prepared[0], payload: [] });
    assert.ok(limit[0], JSON.stringify(plain(limit)));
    const token = run('purchase_router', { ...limit[0], statusCode: 200, payload: { access_token: 'synthetic-token' } });
    assert.equal(token[0]._summerSubscriptionCtx.step, 'load_products');
    const ctx = token[0]._summerSubscriptionCtx;
    const products = run('purchase_router', { ...token[0], statusCode: 200, payload: [{ id: ctx.productId,
      name: ctx.productName, cost: ctx.productCostMinor, type: 'SUBSCRIPTION' }] });
    assert.ok(products[0], JSON.stringify(plain(products)));
    assert.equal(products[0].method, 'POST');
    assert.equal(products[0]._summerSubscriptionCtx.step, 'create_transaction');
    const created = run('purchase_router', { ...products[0], statusCode: 201,
      payload: { id: `synthetic-${counterKey}-tx`, paymentUrl: 'https://fixture.invalid/pay',
        toPay: products[0]._summerSubscriptionCtx.priceMinor, paymentDueDate: '2026-09-10T12:30:00+03:00' } });
    assert.ok(created[1], JSON.stringify(plain(created)));
    const row = { ...plain(created[1].payload.$setOnInsert), ...plain(created[1].payload.$set), _id: 'synthetic-row' };
    assert.deepEqual(row.counterEpoch, epoch.descriptor(now));
    assert.equal(row.inventoryId, epoch.inventories[counterKey]);
    assert.equal(row.requestFingerprint, undefined);
    assert.equal(row.inventoryLedgerSchemaVersion, undefined);
    const stopped = globals({ summer_subscription_sales_20260909_enabled: false });
    const resolved = run('confirm_resolve', { payload: [row], _summerSubscriptionCtx: {
      action: 'confirm', step: 'resolve_record', counterKey, paymentRef: row.paymentRef } }, stopped);
    assert.ok(resolved[0], JSON.stringify(plain(resolved)));
    assert.deepEqual(plain(resolved[0]._summerSubscriptionCtx.counterEpoch), epoch.descriptor(now));
    assert.equal(resolved[0]._summerSubscriptionCtx.inventoryId, row.inventoryId);
    const confirmToken = run('purchase_router', { ...resolved[0], statusCode: 200, payload: { access_token: 'synthetic-token' } }, stopped);
    assert.equal(confirmToken[0].method, 'GET');
    const paid = run('purchase_router', { ...confirmToken[0], statusCode: 200,
      payload: { id: row.transactionId, status: 'PAID', toPay: 0, paymentDate: now } }, stopped);
    assert.equal(paid[1].payload.$set.status, 'PAID');
    assert.equal(paid[2].payload.paid, true);
    assert.equal(paid[1].query.inventoryId, row.inventoryId);
  });

  test(`${counterKey}: old paymentRef is rejected before any provider request`, () => {
    const prepared = run('purchase_prepare', { payload: { counterKey, paymentRef: 'synthetic-reused-ref', clientPhone: phone } });
    const result = run('purchase_limit', { ...prepared[0], payload: [{ paymentRef: 'synthetic-reused-ref',
      inventoryId: `old-${counterKey}`, counterKey, status: 'PAYMENT_PENDING' }] });
    assert.equal(result[0], null);
    assert.equal(result[1].statusCode, 409);
    assert.equal(result[1].payload.details.code, 'COUNTER_EPOCH_PAYMENT_REF_CONFLICT');
  });
}

for (const counterKey of ['network_friendship', 'piter_friendship']) {
  test(`${counterKey}: frozen annual confirm_validate remains available after common OFF`, () => {
    const f = annualFixture(counterKey);
    const result = run('piter_atomic_router', { payload: [f.ledger], _summerSubscriptionCtx: { ...f.ctx, step: 'piter_confirm_validate' } },
      globals({ summer_subscription_sales_20260909_enabled: false }));
    assert.ok(result[1], JSON.stringify(plain(result)));
    assert.equal(result[1].payload[0]._id, f.ledger._id);
    assert.equal(result[1].payload[1].$inc.paidCount, 1);
    assert.equal(result[1].payload[1].$inc.reservedCount, -1);
    noProviderOutput(result);
  });

  test(`${counterKey}: frozen dispatch repair remains available after common OFF`, () => {
    const f = annualFixture(counterKey, 'DISPATCHING');
    const result = run('piter_atomic_router', { payload: [f.ledger], _summerSubscriptionCtx: { ...f.ctx, step: 'piter_dispatch_repair_quota_find' } },
      globals({ summer_subscription_sales_20260909_enabled: false }));
    assert.ok(result[1], JSON.stringify(plain(result)));
    assert.equal(result[1].payload[0]._id, f.ledger._id);
    assert.equal(result[1].payload[1].$set['reservations.$.state'], 'CLAIMED');
    noProviderOutput(result);
  });

  test(`${counterKey}: mismatched frozen epoch rejects confirm and repair without mutation`, () => {
    for (const step of ['piter_confirm_validate', 'piter_dispatch_repair_quota_find']) {
      const f = annualFixture(counterKey, step.includes('repair') ? 'DISPATCHING' : 'PAYMENT_PENDING');
      f.ctx.counterEpoch.startedAt = '2026-09-10T08:59:59.999Z';
      const result = run('piter_atomic_router', { payload: [f.ledger], _summerSubscriptionCtx: { ...f.ctx, step } },
        globals({ summer_subscription_sales_20260909_enabled: false }));
      atomicRejected(result, 'COUNTER_EPOCH_FROZEN_SALE_INVALID');
    }
  });

  test(`${counterKey}: dispatch ownership callback rechecks product OFF even while common remains true`, () => {
    const f = annualFixture(counterKey);
    const makeMsg = () => ({ payload: [{ paymentRef: f.ctx.paymentRef, inventoryId: f.ctx.inventoryId }],
      _summerSubscriptionCtx: { ...structuredClone(f.ctx), step: 'epoch_dispatch_ownership',
        epochDispatchReturnStep: 'create_transaction', providerMethod: 'POST',
        providerUrl: 'https://api.vivacrm.ru/api/v1/transactions', providerHeaders: {},
        providerPayload: { synthetic: true } } });
    const key = counterKey === 'network_friendship' ? 'summer_subscription_hub_lk1_sales_enabled'
      : 'summer_subscription_piter_next_day_sales_20260909_enabled';
    const denied = run('piter_atomic_router', makeMsg(), globals({ [key]: false }));
    atomicRejected(denied, counterKey === 'network_friendship' ? 'HUB_NEW_SALES_RELEASE_DISABLED' : 'PITER_NEW_SALES_RELEASE_DISABLED');
    const allowed = run('piter_atomic_router', makeMsg());
    assert.equal(allowed[4]?.method, 'POST');
    assert.equal(allowed[4]?.url, 'https://api.vivacrm.ru/api/v1/transactions');
  });

  test(`${counterKey}: both initial ownership lookup and final dispatch reject a cross-epoch paymentRef`, () => {
    for (const step of ['epoch_payment_ref_lookup', 'epoch_dispatch_ownership']) {
      const f = annualFixture(counterKey);
      const result = run('piter_atomic_router', { payload: [{ inventoryId: epoch.previous[counterKey], paymentRef: f.ctx.paymentRef }],
        _summerSubscriptionCtx: { ...f.ctx, step, providerMethod: 'POST', providerUrl: 'https://api.vivacrm.ru/api/v1/transactions' } });
      atomicRejected(result, 'COUNTER_EPOCH_PAYMENT_REF_CONFLICT');
    }
  });
}

function emptyAnnualLedgers() {
  return ['network_friendship', 'piter_friendship'].map(counterKey => {
    const { ledger } = annualFixture(counterKey);
    ledger.reservations = [];
    Object.assign(ledger, annualHistory.counts(ledger));
    assert.equal(annualHistory.validate(ledger), true);
    return ledger;
  });
}
function status(counterKey, rows, values = globals()) {
  const prepared = run('status_prepare', { req: { query: { counterKey } } }, values);
  assert.ok(prepared[0], JSON.stringify(plain(prepared)));
  const result = run('status_response', { ...prepared[0], payload: rows }, values);
  assert.ok(result[0], JSON.stringify(plain(result)));
  assert.equal(result[0].statusCode, 200);
  assert.equal(result[2], null, 'status must not dispatch readiness/provider HTTP for the fixture');
  return plain(result[0].payload);
}
function refresh(rows, values = globals()) {
  const prepared = run('counter_refresh_prepare', {}, values);
  assert.equal(prepared._summerSubscriptionCtx.action, 'refresh_counters');
  const result = run('counter_refresh_response', { ...prepared, payload: rows }, values);
  assert.ok(Array.isArray(result[0]));
  return Object.fromEntries(result[0].map(message => {
    const state = plain(message.payload.$set);
    if (state.inventoryId != null) assert.equal(message.query.inventoryId, state.inventoryId);
    return [state.counterKey, state];
  }));
}
const quotaView = state => Object.fromEntries(['inventoryId', 'totalLimit', 'paidCount', 'reservedCount',
  'takenCount', 'remainingCount', 'inventoryPaidCount', 'inventoryReservedCount', 'inventoryRemainingCount',
  'batchRemainingCount'].map(key => [key, state[key]]));

test('status and refresh agree on empty RA10/F7/HAB1 at98000/Piter48 first batch with zero paid history', () => {
  const rows = emptyAnnualLedgers();
  const refreshed = refresh(rows);
  for (const counterKey of ['ra', 'friendship', 'network_friendship', 'piter_friendship']) {
    const live = status(counterKey, rows), cached = refreshed[counterKey];
    assert.equal(live.inventoryId, epoch.inventories[counterKey]);
    assert.equal(cached.inventoryId, live.inventoryId);
    assert.equal(live.paidCount, 0);
    assert.equal(live.reservedCount, 0);
    assert.equal(live.canPurchase, true, counterKey);
    assert.equal(cached.canPurchase, true, counterKey);
    assert.deepEqual(quotaView(cached), quotaView(live), counterKey);
    // A new epoch starts with no sale rows, so status must publish the configured
    // price instead of falling back to the latest paid/pending document amount.
    const expectedPriceMinor = { ra: 2380000, friendship: 980000, network_friendship: 9800000,
      piter_friendship: 1980000 }[counterKey];
    assert.equal(live.priceMinor, expectedPriceMinor, `${counterKey} status price with zero paid history`);
    assert.equal(live.price, expectedPriceMinor / 100, `${counterKey} status price with zero paid history`);
    assert.equal(cached.priceMinor, expectedPriceMinor, `${counterKey} refresh price with zero paid history`);
    if (counterKey === 'piter_friendship') {
      assert.equal(live.quotaAdjustment, 52);
      assert.equal(cached.quotaAdjustment, 52);
      assert.equal(live.batchRemainingCount, 48);
      assert.equal(live.batchSize, 100);
      assert.equal(live.inventoryRemainingCount, 348);
    } else {
      const expected = counterKey === 'ra' ? 10 : counterKey === 'friendship' ? 7 : 1;
      assert.equal(live.totalLimit, expected);
      assert.equal(live.remainingCount, expected);
    }
  }
});

test('common OFF preserves selected epoch and all reported quotas/prices while closing every admission', () => {
  const rows = emptyAnnualLedgers();
  const on = globals(), off = globals({ summer_subscription_sales_20260909_enabled: false });
  const cacheOn = refresh(rows, on), cacheOff = refresh(rows, off);
  for (const counterKey of ['ra', 'friendship', 'network_friendship', 'piter_friendship']) {
    const liveOn = status(counterKey, rows, on), liveOff = status(counterKey, rows, off);
    assert.equal(liveOff.canPurchase, false, counterKey);
    assert.equal(cacheOff[counterKey].canPurchase, false, counterKey);
    assert.deepEqual(quotaView(liveOff), quotaView(liveOn), counterKey);
    assert.deepEqual(quotaView(cacheOff[counterKey]), quotaView(cacheOn[counterKey]), counterKey);
    assert.deepEqual(quotaView(cacheOff[counterKey]), quotaView(liveOff), counterKey);
    if (counterKey === 'piter_friendship') {
      assert.equal(liveOff.quotaAdjustment, 52);
      assert.equal(cacheOff[counterKey].quotaAdjustment, 52);
    }
  }
});

test('old inventory paid and pending rows cannot change any new status or refresh counter', () => {
  const current = emptyAnnualLedgers();
  const old = Object.keys(epoch.inventories).flatMap(counterKey => ['PAID', 'PAYMENT_PENDING'].map((state, index) => ({
    _id: `synthetic-old-${counterKey}-${index}`, counterKey,
    inventoryId: epoch.previous[counterKey] || (counterKey === 'ra' ? 'ab_leto_20260909_daily_v3_ra' : 'ab_leto_2026_150_v2_friendship'),
    productId: annualHistory.products[counterKey]?.productId, status: state,
    paymentRef: `synthetic-old-ref-${counterKey}-${index}`, transactionId: `synthetic-old-tx-${counterKey}-${index}`,
    createdAt: now, updatedAt: now, paidAt: state === 'PAID' ? now : null,
    expiresAt: '2026-09-10T10:00:00.000Z', releasePhase: 'daily', dailyDropDate: '2026-09-10',
  })));
  const before = refresh(current), after = refresh([...current, ...old]);
  for (const counterKey of Object.keys(epoch.inventories)) {
    assert.deepEqual(quotaView(status(counterKey, [...current, ...old])), quotaView(status(counterKey, current)), counterKey);
    assert.deepEqual(quotaView(after[counterKey]), quotaView(before[counterKey]), counterKey);
    assert.equal(after[counterKey].canPurchase, before[counterKey].canPurchase);
  }
});

for (const counterKey of ['network_friendship', 'piter_friendship']) {
  test(`${counterKey}: missing sentinel or missing/foreign ledger cutoff closes status and refresh`, () => {
    const own = emptyAnnualLedgers().find(ledger => ledger.counterKey === counterKey);
    const missingDescriptor = structuredClone(own); delete missingDescriptor.epoch;
    const foreignCutoff = structuredClone(own); foreignCutoff.epoch.startedAt = '2026-09-10T08:59:59.000Z';
    for (const rows of [[], [missingDescriptor], [foreignCutoff]]) {
      assert.equal(status(counterKey, rows).canPurchase, false);
      assert.equal(refresh(rows)[counterKey].canPurchase, false);
    }
    const missingGlobals = globals({ subscription_counter_epoch_started_at: undefined });
    assert.equal(status(counterKey, [own], missingGlobals).canPurchase, false);
    assert.equal(refresh([own], missingGlobals)[counterKey].canPurchase, false);
  });

  for (const state of ['PAYMENT_PENDING', 'PAID']) {
    test(`${counterKey}: canonical ${state} reservation is counted once despite its sale projection`, () => {
      const { ledger, reservation } = annualFixture(counterKey, state);
      const projection = { _id: `synthetic-projection-${counterKey}`, inventoryId: ledger.inventoryId, counterKey,
        inventoryLedgerSchemaVersion: 3, counterEpoch: structuredClone(ledger.epoch),
        productId: annualHistory.products[counterKey].productId, requestFingerprint: reservation.requestFingerprint,
        paymentRef: reservation.paymentRef, transactionId: reservation.transactionId, status: state,
        createdAt: now, updatedAt: now, paidAt: state === 'PAID' ? now : null,
        expiresAt: '2026-09-10T10:00:00.000Z', dailyDropDate: ledger.dailyDate, releasePhase: 'daily' };
      const rows = [ledger, projection];
      const live = status(counterKey, rows), cached = refresh(rows)[counterKey];
      assert.deepEqual(quotaView(live), quotaView(status(counterKey, [ledger])));
      assert.deepEqual(quotaView(cached), quotaView(refresh([ledger])[counterKey]));
      assert.equal(live.paidCount, state === 'PAID' ? 1 : 0);
      assert.equal(live.reservedCount, state === 'PAYMENT_PENDING' ? 1 : 0);
      assert.deepEqual(quotaView(cached), quotaView(live));
      if (counterKey === 'network_friendship') {
        assert.equal(live.remainingCount, 0);
        assert.equal(live.canPurchase, false);
      } else {
        assert.equal(live.batchRemainingCount, 47);
        assert.equal(live.quotaAdjustment, 52);
      }
    });
  }
}
