import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { monthlyFriendshipCustody as c, monthlyFriendshipCustodyRuntimeSource } from '../lib/monthlyFriendshipCustody.mjs';
import { annualHistory } from '../lib/annualSubscriptionHistory.mjs';
const at = '2026-11-02T05:00:00.000Z';
const later = '2026-11-02T05:01:00.000Z';
const phone = '+7' + '9990000000';
const scope = { tenant_id: 'fixture-tenant', counterKey: 'friendship', inventoryId: 'fixture-monthly' };
const request = (patch = {}) => ({ ...scope, paymentRef: 'fixture-payment', clientId: 'fixture-client', clientPhone: phone,
  productId: 'fixture-monthly-product', productName: 'Fixture monthly', campaignKey: 'fixture-campaign',
  amountMinor: 980000, providerProductCostMinor: 980000, discountMinor: 0,
  releasePhase: 'daily', dailyDropDate: '2026-11-02', counterEpoch: null,
  providerPayload: { clientPhone: phone, paymentMethod: 'CARD', deposit: 0, offlineTillId: null,
    products: [{ id: 'fixture-monthly-product', count: 1, type: 'SUBSCRIPTION', customAmount: null, discount: 0 }],
    successUrl: 'https://example.test/return', failUrl: 'https://example.test/return' }, ...patch });
const capacity = l => ({ ledgerRevision: l.revision, inventoryId: l.inventoryId, counterKey: 'friendship', remaining: 1 });
const reserve = (l = c.initial(scope, at), r = request()) => c.reserve(l, r, capacity(l), at).next;
const dispatch = () => c.dispatch(reserve(), request(), later).next;
const pending = () => c.result(dispatch(), request(), { statusCode: 201, transactionId: 'fixture-tx', amountMinor: 980000,
  paymentUrl: 'https://bank.example.test/pay', expiresAt: '2026-11-02T05:30:00.000Z' }, later).next;
const tx = (patch = {}) => ({ id: 'fixture-tx', status: 'PAID', client: { id: 'fixture-client' },
  products: [{ id: 'fixture-monthly-product', count: 1, cost: 980000, discount: 0 }],
  sum: 980000, discount: 0, toPay: 980000, paymentDate: later, ...patch });
const instance = (patch = {}) => ({ id: 'fixture-issued', productId: 'fixture-monthly-product', transactionId: 'fixture-tx', status: 'ACTIVE', ...patch });
const snapshot = (subscriptions = [instance()]) => ({ complete: true, clientId: 'fixture-client', subscriptions, pages: 1, rowCount: subscriptions.length });
const confirm = (l = pending(), transaction = tx(), s = snapshot()) => c.confirm(l, 'fixture-payment', transaction, s, annualHistory.observe, later);

test('monthly request freezes ordinary price and explicit promo; annual product/tier mutation is absent', () => {
  const l = reserve(); assert.deepEqual(l.operations[0].request, request());
  const promo = request({ amountMinor: 833000, discountMinor: 147000 });
  promo.providerPayload.promoCode = 'FIXTURE15'; delete promo.providerPayload.products[0].discount;
  assert.deepEqual(reserve(undefined, promo).operations[0].request, promo);
  assert.throws(() => reserve(undefined, request({ amountMinor: 1980000 })), /REQUEST_INVALID/);
  assert.throws(() => reserve(undefined, request({ counterKey: 'network_friendship' })), /REQUEST_INVALID/);
});
test('exact CAS serializes two last-slot consumers; one winner and one fresh read required', () => {
  let database = c.initial(scope, at);
  const a = c.reserve(database, request(), capacity(database), at);
  const b = c.reserve(database, request({ paymentRef: 'fixture-other', clientId: 'fixture-other-client' }), capacity(database), at);
  const apply = m => { if (c.stable(database) !== c.stable(m.query)) return false; database = m.next; return true; };
  assert.equal(apply(a), true); assert.equal(apply(b), false);
  assert.throws(() => c.reserve(database, request({ paymentRef: 'fixture-other', clientId: 'fixture-other-client' }),
    { ...capacity(database), remaining: 0 }, at), /CAPACITY_UNAVAILABLE/);
  assert.throws(() => c.reserve(database, request({ paymentRef: 'fixture-other', clientId: 'fixture-other-client' }), capacity(b.query), at), /CAPACITY_UNAVAILABLE/);
});
test('original key replays saved intent; changing account, amount or payload conflicts', () => {
  const l = reserve(); assert.equal(c.reserve(l, request(), capacity(l), at).existing.state, 'CLAIMED');
  for (const patch of [{ clientId: 'another' }, { clientPhone: 'other' }, { productName: 'other' }, { campaignKey: 'other' }]) {
    assert.throws(() => c.reserve(l, request(patch), capacity(l), at), /CONFLICT|INVALID/);
  }
  assert.throws(() => c.reserve(l, request({ paymentRef: 'new-key' }), capacity(l), later), /CLIENT_PURCHASE_PENDING/);
});
test('only acknowledged one-row dispatch CAS authorizes POST; lost ACK and retry never do', () => {
  const mutation = c.dispatch(reserve(), request(), later);
  assert.equal(c.acknowledgedDispatch(mutation, { acknowledged: true, matchedCount: 1, modifiedCount: 1 }), true);
  for (const ack of [undefined, {}, { acknowledged: false, matchedCount: 1, modifiedCount: 1 },
    { acknowledged: true, matchedCount: 0, modifiedCount: 0 }, { acknowledged: true, matchedCount: 2, modifiedCount: 2 }]) assert.equal(c.acknowledgedDispatch(mutation, ack), false);
  const retried = c.dispatch(mutation.next, request(), later);
  assert.equal(retried.existing.state, 'DISPATCHING'); assert.equal(c.acknowledgedDispatch(retried, { acknowledged: true, matchedCount: 1, modifiedCount: 1 }), false);
  assert.deepEqual(c.dispatch(JSON.parse(JSON.stringify(mutation.next)), request(), later), retried);
});
test('provider failure, malformed/changed amount or unsafe URL remain UNKNOWN and cannot redispatch', () => {
  const credentialUrl = new URL('https://bank.example.test');
  credentialUrl.username = 'fixture-user'; credentialUrl.password = 'fixture-password';
  const response = { statusCode: 201, transactionId: 'fixture-tx', amountMinor: 980000,
    paymentUrl: 'https://bank.example.test/pay', expiresAt: '2026-11-02T05:30:00.000Z' };
  for (const patch of [{ statusCode: 500 }, { transactionId: null }, { amountMinor: 980001 }, { amountMinor: '980000' },
    { paymentUrl: 'http://bank.example.test' }, { paymentUrl: credentialUrl.href },
    { paymentUrl: 'https://127.0.0.1/pay' }, { paymentUrl: 'https://[::1]/pay' },
    { paymentUrl: 'https://localhost/pay' }, { paymentUrl: 'https://bank.example.test/\r\n' },
    { expiresAt: '2026-11-02T04:00:00.000Z' }]) {
    const l = c.result(dispatch(), request(), { ...response, ...patch }, later).next;
    assert.equal(l.operations[0].state, 'PROVIDER_UNKNOWN');
    assert.equal(c.dispatch(l, request(), later).existing.state, 'PROVIDER_UNKNOWN');
    assert.throws(() => c.reserve(l, request({ paymentRef: 'bypass' }), capacity(l), '2027-01-01T00:00:00.000Z'), /CLIENT_PURCHASE_PENDING/);
  }
});
test('durable holds survive TTL and replace their projections exactly once', () => {
  const l = dispatch(), projection = { ...request(), status: 'PAYMENT_PENDING', monthlyCustody: { ledgerId: l._id } };
  const rows = c.countingRows([l, projection, { _id: 'legacy', status: 'PAID' }], scope);
  assert.equal(rows.length, 2); assert.equal(rows.filter(x => x.monthlyCustodyHold).length, 1);
  assert.equal(rows.find(x => x.monthlyCustodyHold).status, 'PAYMENT_PENDING');
  assert.throws(() => c.countingRows([l, { ...projection, paymentRef: 'orphan' }], scope), /ORPHAN/);
  assert.throws(() => c.countingRows([l, l], scope), /LEDGER_UNAVAILABLE/);
});
test('PAID is issued only for exact client/product/amount and unique transaction-linked subscription', () => {
  const mutation = confirm(); assert.equal(mutation.next.operations[0].state, 'PAID');
  assert.equal(mutation.next.operations[0].subscriptionId, 'fixture-issued');
  assert.equal(confirm(mutation.next).existing.state, 'PAID');
  for (const transaction of [tx({ client: { id: 'other-client' } }), tx({ id: 'other-tx' }),
    tx({ sum: 1 }), tx({ toPay: 1 }), tx({ paymentDate: null }), tx({ refundSum: 1 }),
    tx({ products: [{ id: 'annual-product', count: 1, cost: 980000, discount: 0 }] })]) assert.throws(() => confirm(pending(), transaction));
  for (const subscriptions of [[], [instance(), instance({ id: 'second' })], [instance({ transactionId: 'other-tx' })],
    [instance({ productId: 'other-product' })], [instance({ clientId: 'other-client' })],
    [instance({ status: 'REFUNDED' })], [instance({ transactionUuid: 'conflicting-tx' })]]) assert.throws(() => confirm(pending(), tx(), snapshot(subscriptions)));
});
test('partial or unbounded issued-instance snapshot cannot grant entitlement', () => {
  for (const patch of [{ complete: false }, { clientId: 'other' }, { rowCount: 2 }, { pages: 0 }, { pages: 51 }]) {
    assert.throws(() => confirm(pending(), tx(), { ...snapshot(), ...patch }), /INCOMPLETE/);
  }
});
test('ledger corruption, duplicate keys or transaction aliases fail closed', () => {
  for (const mutate of [l => { l.revision = -1; }, l => { l.operations.push(l.operations[0]); },
    l => { l.operations[0].generation = 2; }, l => { l.operations[0].request.tenant_id = 'other'; }]) {
    const l = pending(); mutate(l); assert.equal(c.validate(l), false); assert.throws(() => c.lookup(l, 'fixture-payment'), /LEDGER_INVALID/);
  }
});
test('embedded Node-RED factory has the same contract without imports or ambient credentials', () => {
  const embedded = vm.runInNewContext(monthlyFriendshipCustodyRuntimeSource() + '\nmonthlyFriendshipCustody;', { URL });
  assert.equal(embedded.stable(embedded.reserve(embedded.initial(scope, at), request(), capacity(c.initial(scope, at)), at).next), c.stable(reserve()));
});

test('reserve/result/confirm ACK cannot authorize dispatch and changed CAS payload is rejected', () => {
  for (const mutation of [c.reserve(c.initial(scope, at), request(), capacity(c.initial(scope, at)), at),
    c.result(dispatch(), request(), {}, later), confirm()]) {
    assert.equal(c.acknowledgedDispatch(mutation, { acknowledged: true, matchedCount: 1, modifiedCount: 1 }), false);
  }
  const mutation = c.dispatch(reserve(), request(), later); mutation.update.$set.operations = [];
  assert.equal(c.acknowledgedDispatch(mutation, { acknowledged: true, matchedCount: 1, modifiedCount: 1 }), false);
});
test('attributable transaction without a usable checkout URL can settle through strict issuance readback', () => {
  const l = c.result(dispatch(), request(), { statusCode: 201, transactionId: 'fixture-tx', amountMinor: 980000 }, later).next;
  assert.equal(l.operations[0].state, 'PROVIDER_UNKNOWN'); assert.equal(l.operations[0].transactionId, 'fixture-tx');
  assert.equal(confirm(l).next.operations[0].state, 'PAID');
  assert.throws(() => confirm(l, tx({ id: 'unrelated' })));
  const missing = c.result(dispatch(), request(), { statusCode: 0 }, later).next;
  assert.throws(() => confirm(missing), /TRANSACTION_UNKNOWN/);
});
test('conflicting or duplicate compatibility projections cannot hide another capacity hold', () => {
  const l = pending(), row = { ...request(), status: 'PAYMENT_PENDING', transactionId: 'fixture-tx', monthlyCustody: { ledgerId: l._id } };
  for (const patch of [{ clientId: 'other' }, { productId: 'other' }, { transactionId: 'other' }, { status: 'PAID' }]) {
    assert.throws(() => c.countingRows([l, { ...row, ...patch }], scope), /PROJECTION_CONFLICT/);
  }
  assert.throws(() => c.countingRows([l, row, row], scope), /DUPLICATE_PROJECTION/);
});

test('stored malformed checkout values and extra financial/credential fields fail validation', () => {
  for (const patch of [{ paymentUrl: 'javascript:alert(1)' }, { paymentUrl: {} }, { expiresAt: null }, { expiresAt: 'bad' },
    { expiresAt: '2020-01-01T00:00:00.000Z' }]) {
    const l = pending(); Object.assign(l.operations[0], patch); assert.equal(c.validate(l), false);
  }
  for (const mutate of [r => { r.token = 'fixture'; }, r => { r.providerPayload.products[0].cost = 1; },
    r => { r.providerPayload.Authorization = 'fixture'; }]) {
    const r = request(); mutate(r); assert.throws(() => reserve(undefined, r), /REQUEST_INVALID/);
  }
});
test('provider payment predating original dispatch cannot settle a fresh purchase; provider paidAt is retained', () => {
  assert.throws(() => confirm(pending(), tx({ paymentDate: '2026-11-01T00:00:00.000Z' })), /ISSUANCE_MISMATCH/);
  const settled = confirm().next;
  assert.equal(settled.operations[0].paidAt, later);
  assert.equal(c.countingRows([settled], scope)[0].paidAt, later);
});
