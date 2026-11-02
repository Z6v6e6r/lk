import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { monthlyFriendshipSource, monthlyCapacitySource } from '../lib/monthlyFriendshipSource.mjs';
import { monthlyFriendshipCustody as c } from '../lib/monthlyFriendshipCustody.mjs';
const at = '2026-11-02T12:00:00.000Z';
const phone = '+7' + '9990000000';
class Clock extends Date { constructor(...args) { super(...(args.length ? args : [at])); } static now() { return Date.parse(at); } }
const scope = { tenant_id: 'fixture-tenant', counterKey: 'friendship', inventoryId: 'fixture-monthly' };
const fixtureContext = (patch = {}) => ({ action: 'purchase', step: 'piter_reserve_start', ...scope,
  paymentRef: 'fixture-payment', clientId: 'fixture-client', clientPhone: phone, productId: 'fixture-monthly-product', productName: 'Monthly fixture',
  campaignKey: 'fixture-campaign', priceMinor: 980000, productCostMinor: 980000, providerProductCostMinor: 980000,
  discountMinor: 0, releasePhase: null, dailyDropDate: null, totalLimit: 1, stagedRelease: false,
  transactionPayload: { clientPhone: phone, paymentMethod: 'CARD', deposit: 0, offlineTillId: null,
    products: [{ id: 'fixture-monthly-product', type: 'SUBSCRIPTION', count: 1, customAmount: null, discount: 0 }],
    successUrl: 'https://example.test/return', failUrl: 'https://example.test/return' }, token: 'fixture-service-token', ...patch });
const compile = name => vm.runInNewContext('(function(msg,global,env,node){' + monthlyFriendshipSource(name) + '\n})', { URL, Date: Clock, Intl, Buffer });
const atomic = compile('atomic'), purchase = compile('purchase_router');
const clone = x => JSON.parse(JSON.stringify(x));
const stable = c.stable;
const path = (row, key) => key.split('.').reduce((value, k) => value?.[k], row);
function matches(row, query) {
  return Object.entries(query).every(([key, value]) => {
    if (key === '$or') return value.some(part => matches(row, part));
    const current = path(row, key);
    if (value && !Array.isArray(value) && typeof value === 'object' && Object.hasOwn(value, '$exists')) return (current !== undefined) === value.$exists;
    if (value && !Array.isArray(value) && typeof value === 'object' && Object.hasOwn(value, '$lte')) return current <= value.$lte;
    return stable(current) === stable(value);
  });
}
function harness({ enabled = true, rows = [] } = {}) {
  const values = new Map([['monthly_friendship_custody_binding', { version: 1, enabled, tenantId: scope.tenant_id, inventoryId: scope.inventoryId }]]);
  const globals = { get: key => values.get(key) }, store = clone(rows), posts = [];
  const run = msg => {
    const output = atomic(msg, globals, { get: () => undefined }, { warn: () => undefined });
    const port = output.findIndex(x => x !== null); assert.ok(port >= 0); return { port, msg: output[port] };
  };
  const io = edge => {
    const { port, msg } = edge; const payload = msg.payload;
    if (port === 0) { msg.payload = clone(store.filter(row => matches(row, payload))); return msg; }
    if (port === 1 || port === 2) {
      const [query, update, options] = payload; let row = store.find(r => matches(r, query));
      if (!row && options.upsert && store.some(r => r._id === query._id)) { msg.error = { code: 11000 }; msg.payload = null; return msg; }
      if (!row && options.upsert) {
        row = clone(update.$setOnInsert || update.$set); store.push(row);
        msg.payload = { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 1 }; return msg;
      }
      if (!row) { msg.payload = { acknowledged: true, matchedCount: 0, modifiedCount: 0 }; return msg; }
      const before = stable(row); Object.assign(row, clone(update.$set || {}));
      msg.payload = { acknowledged: true, matchedCount: 1, modifiedCount: before === stable(row) ? 0 : 1 }; return msg;
    }
    throw Error('unexpected I/O');
  };
  const advance = (msg, { stop, provider, max = 60 } = {}) => {
    for (let n = 0; n < max; n++) {
      const edge = run(msg);
      if (stop?.(edge)) return edge;
      if (edge.port === 3) return edge;
      if (edge.port === 4) {
        if (msg.method === 'POST') posts.push(clone({ url: msg.url, payload: msg.payload }));
        if (!provider && !msg.url.includes('/clients?')) return edge;
        const response = msg.url.includes('/clients?') ? { statusCode: 200, body: { number: 0, totalPages: 1, totalElements: 1, last: true, numberOfElements: 1, content: [{ id: msg._summerSubscriptionCtx.clientId || 'fixture-client', phone }] } } : provider(msg); msg.payload = response.body; msg.statusCode = response.statusCode;
        msg.responseUrl = msg.url;
        const routed = purchase(msg, globals, { get: () => undefined }, { warn: () => undefined });
        assert.equal(routed[4], msg);
      } else io(edge);
    }
    throw Error('step bound exceeded');
  };
  return { run, io, advance, globals, values, store, posts };
}
const creation = () => ({ statusCode: 201, body: { id: 'fixture-tx', toPay: 980000,
  paymentUrl: 'https://bank.example.test/pay', paymentDueDate: '2026-11-02T12:30:00.000Z' } });
const start = patch => ({ _summerSubscriptionCtx: fixtureContext(patch) });

test('composed monthly graph persists intent and dispatch before exactly one POST, then reads back result', () => {
  const h = harness(); const result = h.advance(start(), { provider: creation });
  assert.equal(result.port, 3); assert.equal(result.msg.payload.status, 'PAYMENT_PENDING');
  assert.equal(h.posts.length, 1);
  const ledger = h.store.find(r => r.documentType === c.kind); assert.equal(c.validate(ledger), true);
  assert.equal(ledger.operations[0].generation, 1); assert.equal(h.store.filter(r => r.monthlyCustody).length, 1);
  const repeat = h.advance(start()); assert.equal(repeat.msg.payload.status, 'PAYMENT_PENDING'); assert.equal(h.posts.length, 1);
});
test('two concurrent web/native contenders for last slot commit only one reservation and POST', () => {
  const h = harness({ rows: [c.initial(scope, at)] }); const a = start(), b = start({ clientId: 'other', paymentRef: 'other-ref' });
  h.io(h.advance(a, { stop: e => e.port === 0 })); h.io(h.advance(b, { stop: e => e.port === 0 })); // Same inventory snapshot.
  const reserveA = h.run(a), reserveB = h.run(b); assert.equal(reserveA.port, 1); assert.equal(reserveB.port, 1);
  h.io(reserveA); h.io(reserveB);
  assert.equal(h.advance(a, { provider: creation }).msg.payload.status, 'PAYMENT_PENDING');
  const rejected = h.advance(b); assert.equal(rejected.msg.statusCode, 409); assert.equal(h.posts.length, 1);
});
test('committed dispatch with lost ACK never sends or repairs POST and blocks fresh key after TTL', () => {
  const h = harness();
  const edge = h.advance(start(), { stop: e => e.port === 1 && e.msg._summerSubscriptionCtx.step === 'monthly_dispatch_ack' });
  h.io(edge); edge.msg.error = { code: 'ACK_LOST' }; edge.msg.payload = null;
  assert.equal(h.advance(edge.msg).msg.payload.status, 'PROVIDER_UNKNOWN'); assert.equal(h.posts.length, 0);
  assert.equal(h.advance(start()).msg.payload.status, 'PROVIDER_UNKNOWN'); assert.equal(h.posts.length, 0);
  const bypass = h.advance(start({ paymentRef: 'new-ref' })); assert.notEqual(bypass.msg.payload.status, 'PAYMENT_PENDING'); assert.equal(h.posts.length, 0);
});
test('transport timeout never triggers legacy payment-method fallback or a second POST', () => {
  const h = harness(); const result = h.advance(start(), { provider: () => ({ statusCode: 500, body: { message: 'payment method not implemented' } }) });
  assert.equal(result.msg.payload.status, 'PROVIDER_UNKNOWN'); assert.equal(h.posts.length, 1);
  assert.equal(h.advance(start()).msg.payload.status, 'PROVIDER_UNKNOWN'); assert.equal(h.posts.length, 1);
});
test('disabled binding and wrong day fail closed before provider invocation', () => {
  const disabled = harness({ enabled: false }); assert.equal(disabled.advance(start()).msg.statusCode, 503); assert.equal(disabled.posts.length, 0);
  const day = harness(); assert.equal(day.advance(start({ releasePhase: 'daily', dailyDropDate: '2026-11-01' })).msg.statusCode, 503); assert.equal(day.posts.length, 0);
});
test('strict readback requires exact transaction and complete unique linked instance; no payment command', () => {
  const h = harness(); h.advance(start(), { provider: creation });
  const paid = { id: 'fixture-tx', status: 'PAID', client: { id: 'fixture-client' },
    products: [{ id: 'fixture-monthly-product', count: 1, cost: 980000, discount: 0 }], sum: 980000, discount: 0, toPay: 980000, paymentDate: at };
  const instance = { id: 'fixture-issued', transactionId: 'fixture-tx', productId: 'fixture-monthly-product', status: 'ACTIVE' };
  const response = h.advance(start({ step: 'monthly_confirm_start', monthlyScope: scope }), { provider: msg => ({ statusCode: 200,
    body: msg.url.includes('/transactions/') ? paid : { number: 0, totalPages: 1, totalElements: 1, last: true, numberOfElements: 1, content: [instance] } }) });
  assert.equal(response.msg.payload.status, 'PAID'); assert.equal(response.msg.payload.clientSubscriptionId, 'fixture-issued'); assert.equal(h.posts.length, 1);
});
test('partial instance pages do not expose PAID or release the hold', () => {
  const h = harness(); h.advance(start(), { provider: creation });
  const response = h.advance(start({ step: 'monthly_confirm_start', monthlyScope: scope }), { provider: msg => ({ statusCode: 200,
    body: msg.url.includes('/transactions/') ? { id: 'fixture-tx', status: 'PAID', client: { id: 'fixture-client' },
      products: [{ id: 'fixture-monthly-product', count: 1, cost: 980000, discount: 0 }], sum: 980000, discount: 0, toPay: 980000, paymentDate: at }
      : { number: 0, totalPages: 1, totalElements: 1, last: true, numberOfElements: 1, content: [] } }) });
  assert.equal(response.msg.payload.status, 'PROVIDER_UNKNOWN');
  assert.equal(h.store.find(r => r.documentType === c.kind).operations[0].state, 'PAYMENT_PENDING'); assert.equal(h.posts.length, 1);
});
test('capacity probe reuses launch/daily calendar and does not expire new custody holds', () => {
  const probe = vm.runInNewContext(monthlyCapacitySource() + '\nmonthlyCapacityProbe;', { Date: Clock, Intl });
  const ctx = fixtureContext();
  const pending = { ...scope, productId: ctx.productId, status: 'PAYMENT_PENDING', createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-01T01:00:00.000Z' };
  assert.equal(probe({ _summerSubscriptionCtx: clone(ctx), payload: [pending] }, { get: () => undefined }).ok, true);
  const held = probe({ _summerSubscriptionCtx: clone(ctx), payload: [{ ...pending, monthlyCustodyHold: true }] }, { get: () => undefined });
  assert.equal(held[1].statusCode, 409);
});
test('legacy monthly storefront without clientId resolves exact provider client before reservation', () => {
  const h = harness(); const result = h.advance(start({ clientId: null }), { provider: creation });
  assert.equal(result.msg.payload.status, 'PAYMENT_PENDING'); assert.equal(h.posts.length, 1);
  assert.equal(h.store.find(r => r.documentType === c.kind).operations[0].request.clientId, 'fixture-client');
});
test('unattributed UNKNOWN uses non-success HTTP so legacy storefront cannot interpret absent amount as free settlement', () => {
  const h = harness(); const msg = start({ step: 'monthly_dispatch_ack' });
  msg.error = { code: 'lost' }; const result = h.advance(msg);
  assert.equal(result.msg.statusCode, 503); assert.equal(result.msg.payload.ok, false); assert.equal(h.posts.length, 0);
});
test('daily date changes exactly at Moscow 10:00 and forced daily start preserves existing capacity rules', () => {
  const source = monthlyCapacitySource();
  function probeAt(now, ctx, rows) {
    class At extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return Date.parse(now); } }
    const probe = vm.runInNewContext(source + '\nmonthlyCapacityProbe;', { Date: At, Intl });
    return probe({ _summerSubscriptionCtx: clone(ctx), payload: rows }, { get: () => undefined });
  }
  const ctx = fixtureContext({ stagedRelease: true, launchLimit: 3, dailyLimit: 1, dailyDropDate: '2026-11-02',
    forcedDailyDropStartsAt: '2026-11-02T07:00:00.000Z' });
  const launch = probeAt('2026-11-02T06:59:59.999Z', ctx, []);
  assert.equal(launch.context.releasePhase, 'launch'); assert.equal(launch.context.remainingBefore, 3);
  const daily = probeAt('2026-11-02T07:00:00.000Z', ctx, []);
  assert.equal(daily.context.releasePhase, 'daily'); assert.equal(daily.context.remainingBefore, 1);
  const hold = { ...scope, productId: ctx.productId, status: 'PAYMENT_PENDING', releasePhase: 'launch',
    monthlyCustodyHold: true, createdAt: '2026-10-31T12:00:00.000Z' };
  assert.equal(probeAt('2026-11-02T07:00:00.000Z', ctx, [hold])[1].statusCode, 409);
});
test('actual confirmation resolver and token response enter strict monthly readback', () => {
  const h = harness(); h.advance(start(), { provider: creation });
  const record = clone(h.store.find(r => r.monthlyCustody));
  const msg = { _summerSubscriptionCtx: { action: 'confirm', step: 'resolve_record', counterKey: 'friendship',
    inventoryId: scope.inventoryId, paymentRef: 'fixture-payment' }, payload: [record], _paymentPollingAdmitted: true };
  const resolver = compile('confirm_resolve');
  const token = resolver(msg, h.globals, { get: key => key === 'VIVACRM_TOKEN_REQUEST_BODY' ? 'grant_type=fixture' : undefined }, { warn: () => undefined });
  assert.equal(token[0], msg); assert.equal(msg._summerSubscriptionCtx.monthlyAfterToken, true);
  assert.deepEqual(clone(msg._summerSubscriptionCtx.monthlyScope), scope);
  msg.statusCode = 200; msg.payload = { access_token: 'fixture-service-token' };
  const routed = purchase(msg, h.globals, { get: () => undefined }, { warn: () => undefined });
  assert.equal(routed[4], msg); assert.equal(msg._summerSubscriptionCtx.step, 'monthly_confirm_start');
  const edge = h.advance(msg); assert.equal(edge.port, 4); assert.match(edge.msg.url, /\/transactions\/fixture-tx$/); assert.equal(edge.msg.method, 'GET');
});
test('duplicate unrelated subscription IDs make the paginated snapshot incomplete', () => {
  const h = harness(); h.advance(start(), { provider: creation });
  const unrelated = { id: 'unrelated', productId: 'other', transactionId: 'other-tx', status: 'ACTIVE' };
  const response = h.advance(start({ step: 'monthly_confirm_start', monthlyScope: scope }), { provider: msg => ({ statusCode: 200,
    body: msg.url.includes('/transactions/') ? { id: 'fixture-tx', status: 'PAID', client: { id: 'fixture-client' },
      products: [{ id: 'fixture-monthly-product', count: 1, cost: 980000, discount: 0 }], sum: 980000, discount: 0, toPay: 980000, paymentDate: at }
      : { number: 0, totalPages: 1, totalElements: 3, last: true, numberOfElements: 3, content: [unrelated, unrelated,
        { id: 'fixture-issued', productId: 'fixture-monthly-product', transactionId: 'fixture-tx', status: 'ACTIVE' }] } }) });
  assert.equal(response.msg.payload.status, 'PROVIDER_UNKNOWN'); assert.equal(h.posts.length, 1);
});
const receiveCreation = (msg, id = 'fixture-tx') => {
  msg.statusCode = 201; msg.responseUrl = msg.url; msg.payload = { ...creation().body, id }; return msg;
};
test('another buyer changing the aggregate while A response CAS waits cannot lose A transaction', () => {
  const h = harness();
  const a = h.advance(start({ totalLimit: 2 })); assert.equal(a.port, 4); receiveCreation(a.msg);
  const resultCas = h.advance(a.msg, { stop: e => e.port === 1 && e.msg._summerSubscriptionCtx.step === 'monthly_result_ack' });
  const b = h.advance(start({ totalLimit: 2, clientId: 'fixture-second', paymentRef: 'fixture-second-payment' })); assert.equal(b.port, 4);
  h.io(resultCas); assert.equal(resultCas.msg.payload.matchedCount, 0);
  const recovered = h.advance(resultCas.msg); assert.equal(recovered.msg.payload.transactionId, 'fixture-tx');
  assert.equal(recovered.msg.payload.status, 'PAYMENT_PENDING'); assert.equal(h.posts.length, 2);
  const l = h.store.find(r => r.documentType === c.kind); assert.equal(l.operations.length, 2);
  assert.equal(l.operations.find(o => o.request.paymentRef === 'fixture-payment').transactionId, 'fixture-tx');
  assert.equal(l.operations.find(o => o.request.paymentRef === 'fixture-second-payment').state, 'DISPATCHING');
});
test('restart after immutable provider observation recovers the exact response without another POST', () => {
  const h = harness(); const sent = h.advance(start()); receiveCreation(sent.msg);
  const boundary = h.advance(sent.msg, { stop: e => e.port === 0 && e.msg._summerSubscriptionCtx.step === 'monthly_result_readback' });
  assert.equal(boundary.port, 0); assert.equal(h.store.find(r => r.documentType === c.kind).operations[0].state, 'DISPATCHING');
  const observation = h.store.find(r => r.documentType === 'MONTHLY_FRIENDSHIP_PROVIDER_OBSERVATION_V1');
  assert.equal(observation.response.transactionId, 'fixture-tx'); assert.equal(JSON.stringify(observation).includes('fixture-service-token'), false);
  assert.equal(observation.paymentRef, undefined); assert.equal(observation.inventoryId, undefined);
  const recovery = h.advance(start()); assert.equal(recovery.msg.payload.transactionId, 'fixture-tx');
  assert.equal(recovery.msg.payload.status, 'PAYMENT_PENDING'); assert.equal(h.posts.length, 1);
});
test('old transaction already owned by a legacy purchase cannot bind a fresh paymentRef', () => {
  const h = harness({ rows: [{ _id: 'legacy-old-sale', inventoryId: 'previous-inventory', counterKey: 'friendship',
    paymentRef: 'legacy-ref', transactionId: 'fixture-tx', status: 'PAID', clientSubscriptionId: 'legacy-issued' }] });
  const result = h.advance(start(), { provider: creation });
  assert.equal(result.msg.statusCode, 409); assert.equal(result.msg.payload.code, 'MONTHLY_FRIENDSHIP_IDENTITY_ALREADY_OWNED');
  assert.equal(h.store.find(r => r.documentType === c.kind).operations[0].transactionId, null); assert.equal(h.posts.length, 1);
});
test('contradictory provider page metadata cannot prove client uniqueness or issuance', () => {
  for (const patch of [{ last: false }, { numberOfElements: 2 }]) {
    const h = harness(); const first = h.run(start()); assert.equal(first.port, 4);
    first.msg.statusCode = 200; first.msg.responseUrl = first.msg.url;
    first.msg.payload = { number: 0, totalPages: 1, totalElements: 1, numberOfElements: 1, last: true,
      content: [{ id: 'fixture-client', phone }], ...patch };
    assert.equal(h.advance(first.msg).msg.payload.code, 'MONTHLY_FRIENDSHIP_CLIENT_LOOKUP_INCOMPLETE'); assert.equal(h.posts.length, 0);
    const paid = harness(); paid.advance(start(), { provider: creation });
    const outcome = paid.advance(start({ step: 'monthly_confirm_start', monthlyScope: scope }), { provider: msg => ({ statusCode: 200,
      body: msg.url.includes('/transactions/') ? { id: 'fixture-tx', status: 'PAID', client: { id: 'fixture-client' },
        products: [{ id: 'fixture-monthly-product', count: 1, cost: 980000, discount: 0 }], sum: 980000, discount: 0, toPay: 980000, paymentDate: at }
      : { number: 0, totalPages: 1, totalElements: 1, numberOfElements: 1, last: true,
        content: [{ id: 'fixture-issued', productId: 'fixture-monthly-product', transactionId: 'fixture-tx', status: 'ACTIVE' }], ...patch } }) });
    assert.equal(outcome.msg.payload.code, 'MONTHLY_FRIENDSHIP_INSTANCE_SNAPSHOT_INCOMPLETE'); assert.equal(paid.posts.length, 1);
  }
});
test('failed response ID never claims transaction ownership; valid 2xx without URL retains its identity', () => {
  const failed = harness(); failed.advance(start(), { provider: () => ({ statusCode: 500, body: { id: 'not-attributable', toPay: 980000 } }) });
  const observation = failed.store.find(r => r.documentType === 'MONTHLY_FRIENDSHIP_PROVIDER_OBSERVATION_V1');
  assert.equal(observation.response.transactionId, null);
  assert.equal(failed.store.some(r => r.documentType === 'MONTHLY_FRIENDSHIP_IDENTITY_V1'), false);
  const attributable = harness(); attributable.advance(start(), { provider: () => ({ statusCode: 201, body: { id: 'attributable', toPay: 980000 } }) });
  assert.equal(attributable.store.find(r => r.documentType === c.kind).operations[0].transactionId, 'attributable');
  assert.equal(attributable.store.find(r => r.documentType === 'MONTHLY_FRIENDSHIP_IDENTITY_V1').identityValue, 'attributable');
});
