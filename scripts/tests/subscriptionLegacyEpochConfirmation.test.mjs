import assert from 'node:assert/strict';
import test from 'node:test';
import { ObjectId } from 'mongodb';
import { runLegacyEpochConfirmation } from '../lib/subscriptionLegacyEpochConfirmation.mjs';
import { annualHistory } from '../lib/annualSubscriptionHistory.mjs';
import { subscriptionCounterEpoch as epoch } from '../lib/subscriptionCounterEpoch.mjs';

const phone = '+7' + '9990000000';
function fixture(counterKey = 'network_friendship') {
  const productId = annualHistory.products[counterKey].productId;
  const row = { _id: new ObjectId('000000000000000000000001'), counterKey,
    inventoryId: epoch.previous[counterKey], productId, paymentRef: 'synthetic-legacy-ref',
    transactionId: 'synthetic-legacy-tx', clientId: 'synthetic-client', clientPhone: phone,
    status: 'PAYMENT_PENDING', amountMinor: 1980000, providerProductCostMinor: 5680000,
    discountMinor: 3700000, expiresAt: '2026-08-22T16:55:56.889956319+03:00',
    createdAt: new Date('2026-08-22T12:00:00.000Z'), opaque: { keep: true } };
  const transaction = { id: row.transactionId, client: { id: row.clientId, phone }, status: 'PAID',
    products: [{ id: productId, cost: 5680000, discount: 3700000, count: 1 }],
    sum: 5680000, discount: 3700000, toPay: 1980000, refundSum: 0, refundedAt: null,
    paymentDate: '2026-09-10T14:00:00+03:00', paymentDueDate: '2026-08-22T16:55:56.889956+03:00' };
  const subscription = { subscriptionId: 'synthetic-instance', transactionId: row.transactionId,
    clientId: row.clientId, product: { id: productId }, status: 'ACTIVE', refundSum: 0, refundedAt: null };
  return { row, transaction, subscription };
}

function harness(f = fixture(), overrides = {}) {
  const ctx = { step: 'legacy_epoch_begin', legacyEpochCandidate: true, token: 'synthetic-token',
    counterKey: f.row.counterKey, inventoryId: f.row.inventoryId, productId: f.row.productId,
    transactionId: f.row.transactionId, paymentRef: f.row.paymentRef, httpRequestTimeoutMs: 5000,
    ...overrides };
  const msg = { _summerSubscriptionCtx: ctx };
  const writes = [], providerReads = [], mongoReads = [];
  const invoke = (payload, statusCode = 200) => {
    msg.payload = payload; msg.statusCode = statusCode;
    const result = runLegacyEpochConfirmation({ msg, ctx, annualHistory, epoch,
      saleUpdate: (context, filter, update, options) => {
        assert.equal(options.upsert, false, 'legacy projection must never upsert');
        assert.deepEqual(Object.keys(update), ['$set']);
        assert.ok(!Object.keys(update.$set).some(key => /^(paidCount|reservedCount|takenCount|reservations|history|inventoryId)$/.test(key)));
        writes.push({ context, filter, update, options });
        return [null, null, { payload: [filter, update, options] }, null, null];
      },
      response: (status, body) => [null, null, null, { statusCode: status, payload: body }, null],
      fail: (status, _message, code) => [null, null, null, { statusCode: status, payload: { code } }, null],
    });
    if (result) {
      assert.equal(result[1], null, 'ledger update output must never be used');
      if (result[0]) {
        const query = result[0].payload;
        assert.deepEqual(query, { inventoryId: ctx.inventoryId, paymentRef: ctx.paymentRef, transactionId: ctx.transactionId });
        mongoReads.push({ ...query });
      }
      if (result[4]) {
        assert.equal(result[4].method, 'GET', 'legacy route must never POST provider operations');
        assert.match(result[4].url, /^https:\/\/api\.vivacrm\.ru\/api\/v1\/(transactions|clients)\//);
        providerReads.push({ method: result[4].method, url: result[4].url });
      }
    }
    return result;
  };
  const toCompare = ({ transaction = f.transaction, subscription = f.subscription } = {}) => {
    invoke(); assert.equal(ctx.step, 'legacy_epoch_row');
    invoke([f.row]); assert.equal(ctx.step, 'legacy_epoch_transaction');
    invoke(transaction);
    if (transaction.status !== 'UNPAID') {
      assert.equal(ctx.step, 'legacy_epoch_instances');
      invoke({ content: [subscription], number: 0, totalPages: 1, totalElements: 1, numberOfElements: 1, last: true });
    }
    assert.equal(ctx.step, 'legacy_epoch_compare');
  };
  return { f, ctx, invoke, toCompare, writes, providerReads, mongoReads };
}
const rejected = result => {
  assert.equal(result[3].statusCode, 503);
  assert.match(result[3].payload.code, /^LEGACY_EPOCH_/);
};

for (const counterKey of ['network_friendship', 'piter_friendship']) {
  test(`${counterKey}: late PAID updates only the exact native ObjectId row and succeeds after readback`, () => {
    const f = fixture(counterKey), h = harness(f);
    const originalOpaque = f.row.opaque, originalId = f.row._id;
    h.toCompare();
    h.invoke([f.row]);
    assert.equal(h.writes.length, 1);
    const mutation = h.writes[0];
    assert.ok(mutation.filter._id instanceof ObjectId);
    assert.strictEqual(mutation.filter._id, originalId);
    assert.strictEqual(mutation.filter.$expr.$eq[1].$literal, f.row);
    assert.strictEqual(mutation.filter.$expr.$eq[1].$literal.opaque, originalOpaque);
    assert.ok(mutation.filter.$expr.$eq[1].$literal.createdAt instanceof Date);
    assert.deepEqual(mutation.filter.$expr.$eq[0], '$$ROOT');
    assert.equal(mutation.update.$set.status, 'PAID');
    assert.equal(mutation.update.$set.clientSubscriptionId, f.subscription.subscriptionId);
    assert.equal(f.row.status, 'PAYMENT_PENDING', 'input preimage must not be mutated');
    const readbackRequest = h.invoke({ acknowledged: true, matchedCount: 1, modifiedCount: 1 });
    assert.ok(readbackRequest[0]);
    const saved = { ...f.row, ...mutation.update.$set, _id: new ObjectId(originalId.toHexString()) };
    const result = h.invoke([saved]);
    assert.equal(result[3].statusCode, 200);
    assert.equal(result[3].payload.status, 'PAID');
    assert.equal(h.writes.length, 1);
    assert.equal(h.providerReads.length, 2);
  });
}

test('restart/replay of an already projected canonical payment performs zero writes', () => {
  const f = fixture();
  Object.assign(f.row, { status: 'PAID', paidAt: f.transaction.paymentDate, clientSubscriptionId: f.subscription.subscriptionId });
  const h = harness(f); h.toCompare();
  const result = h.invoke([f.row]);
  assert.equal(result[3].payload.status, 'PAID');
  assert.equal(h.writes.length, 0);
});

test('lost or negative write ACK is resolved by readback, never by repeating the write', () => {
  for (const ack of [undefined, { acknowledged: false }, { matchedCount: 0, modifiedCount: 0 }]) {
    const h = harness(); h.toCompare(); h.invoke([h.f.row]);
    const saved = { ...h.f.row, ...h.writes[0].update.$set };
    h.invoke(ack);
    assert.equal(h.invoke([saved])[3].payload.status, 'PAID');
    assert.equal(h.writes.length, 1);
  }
});

test('CAS miss with an unchanged row fails closed and never overwrites or retries', () => {
  const h = harness(); h.toCompare(); h.invoke([h.f.row]);
  h.invoke({ acknowledged: true, matchedCount: 0, modifiedCount: 0 });
  const result = h.invoke([h.f.row]);
  rejected(result);
  assert.equal(result[3].payload.code, 'LEGACY_EPOCH_CAS_NOT_CONFIRMED');
  assert.equal(h.writes.length, 1);
  assert.equal(h.f.row.status, 'PAYMENT_PENDING');
});

test('concurrent REFUNDED row rejects a stale PAID observation without a write', () => {
  const h = harness(); h.toCompare();
  const result = h.invoke([{ ...h.f.row, status: 'REFUNDED' }]);
  rejected(result);
  assert.equal(result[3].payload.code, 'LEGACY_EPOCH_STALE_PROVIDER_STATE');
  assert.equal(h.writes.length, 0);
});

test('expired UNPAID remains pending with zero writes and no fabricated failure', () => {
  const h = harness();
  h.toCompare({ transaction: { ...h.f.transaction, status: 'UNPAID', paymentDate: null } });
  const result = h.invoke([h.f.row]);
  assert.equal(result[3].payload.status, 'PAYMENT_PENDING');
  assert.equal(h.writes.length, 0);
  assert.equal(h.providerReads.length, 1);
});

test('complete multi-page instances are read before the matching subscription is confirmed', () => {
  const h = harness(); h.invoke(); h.invoke([h.f.row]); h.invoke(h.f.transaction);
  const noise = Array.from({ length: 200 }, (_, index) => ({ subscriptionId: `synthetic-other-${index}`,
    transactionId: `synthetic-other-tx-${index}` }));
  const next = h.invoke({ content: noise, number: 0, totalPages: 2, totalElements: 201, numberOfElements: 200, last: false });
  assert.match(next[4].url, /page=1$/);
  assert.equal(h.writes.length, 0);
  h.invoke({ content: [h.f.subscription], number: 1, totalPages: 2, totalElements: 201, numberOfElements: 1, last: true });
  assert.equal(h.ctx.step, 'legacy_epoch_compare');
  h.invoke([h.f.row]);
  assert.equal(h.writes[0].update.$set.clientSubscriptionId, h.f.subscription.subscriptionId);
});

test('wrong epoch, identity, duplicate rows, fingerprint and native-ID type changes fail closed', () => {
  const scope = harness(fixture(), { inventoryId: epoch.inventories.network_friendship });
  rejected(scope.invoke()); assert.equal(scope.writes.length, 0);
  for (const alter of [
    row => ({ ...row, inventoryId: epoch.inventories.network_friendship }),
    row => ({ ...row, requestFingerprint: 'synthetic-atomic-fingerprint' }),
    row => ({ ...row, paymentRef: 'synthetic-foreign-ref' }),
    row => ({ ...row, productId: annualHistory.products.piter_friendship.productId }),
    row => ({ ...row, transactionId: 'synthetic-foreign-tx' }),
  ]) {
    const h = harness(); h.invoke(); rejected(h.invoke([alter(h.f.row)]));
    assert.equal(h.providerReads.length, 0); assert.equal(h.writes.length, 0);
  }
  const duplicate = harness(); duplicate.invoke(); rejected(duplicate.invoke([duplicate.f.row, duplicate.f.row]));
  const changedId = harness(); changedId.toCompare();
  rejected(changedId.invoke([{ ...changedId.f.row, _id: changedId.f.row._id.toHexString() }]));
  assert.equal(changedId.writes.length, 0);
});

test('financial and client mismatches, ambiguous instances and deadline drift cannot update the row', () => {
  for (const mutate of [
    f => { f.transaction.toPay = 0; },
    f => { f.transaction.sum = 1980000; },
    f => { f.transaction.client.id = 'synthetic-foreign-client'; },
    f => { f.subscription.transactionId = 'synthetic-foreign-transaction'; },
    f => { f.subscription.product.id = annualHistory.products.piter_friendship.productId; },
    f => { f.transaction.refundSum = 1; },
  ]) {
    const f = fixture(); mutate(f); const h = harness(f); h.toCompare();
    rejected(h.invoke([f.row])); assert.equal(h.writes.length, 0);
  }
  const h = harness(); h.toCompare({ transaction: { ...h.f.transaction, status: 'UNPAID', paymentDate: null,
    paymentDueDate: '2026-08-22T16:55:57.889956+03:00' } });
  rejected(h.invoke([h.f.row])); assert.equal(h.writes.length, 0);
});

test('partial, inconsistent and duplicate pagination fails before CAS', () => {
  for (const page of [
    { content: [], number: 0, totalPages: 1, totalElements: 1, numberOfElements: 0, last: true },
    { content: [], number: 1, totalPages: 0, totalElements: 0, numberOfElements: 0, last: true },
    { content: [], number: 0, totalPages: 2, totalElements: 201, numberOfElements: 0, last: false },
  ]) {
    const h = harness(); h.invoke(); h.invoke([h.f.row]); h.invoke(h.f.transaction);
    rejected(h.invoke(page)); assert.equal(h.writes.length, 0);
  }
  const h = harness(); h.invoke(); h.invoke([h.f.row]); h.invoke(h.f.transaction);
  rejected(h.invoke({ content: [h.f.subscription, h.f.subscription], number: 0, totalPages: 1,
    totalElements: 2, numberOfElements: 2, last: true }));
  assert.equal(h.writes.length, 0);
});

test('provider errors and foreign prefixes never reach a mutation or provider POST', () => {
  const h = harness(); h.invoke(); h.invoke([h.f.row]);
  rejected(h.invoke(h.f.transaction, 503)); assert.equal(h.writes.length, 0);
  for (const step of ['annual_history_begin', 'piter_claim', 'token_purchase', '']) {
    const other = harness(fixture(), { step });
    assert.equal(other.invoke(), undefined);
    assert.equal(other.writes.length, 0); assert.equal(other.providerReads.length, 0);
  }
});

test('successful reconciliation is silent after proof and does not create ledger state', () => {
  const h = harness(fixture(), { reconcile: true });
  h.toCompare(); h.invoke([h.f.row]);
  const saved = { ...h.f.row, ...h.writes[0].update.$set };
  h.invoke({ acknowledged: true });
  assert.deepEqual(h.invoke([saved]), [null, null, null, null, null]);
  assert.equal(h.writes.length, 1);
});
