import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { composeMonthlyFriendshipCustody, monthlyFriendshipIds as ids } from '../compose_monthly_friendship_custody.mjs';
import { monthlyFriendshipSource } from '../lib/monthlyFriendshipSource.mjs';
const read = name => fs.readFileSync(new URL('../nodered_games_nodes/fn_tournament_subscription_' + name + '.js', import.meta.url), 'utf8');
// The source-only composer retains its reviewed preimage. Current annual-runtime
// successors must not silently widen this independent monthly release contract.
const frozenAtomic = execFileSync('git', ['show', '45a287a63c595ba86cf19a999e177f4780f80f49:scripts/nodered_games_nodes/fn_tournament_subscription_piter_atomic_router.js'], { encoding: 'utf8' });
const fixture = () => {
  const z = 'fixture-subscriptions', fn = (name, outputs, wires) => ({ id: ids[name], type: 'function', z, outputs, wires,
    func: name === 'atomic' ? frozenAtomic : read(name), name: 'fixture-' + name });
  return [
    { id: z, type: 'tab', label: 'Fixture subscriptions' },
    fn('status_response', 3, [[ids.response],[],[]]), fn('purchase_limit', 3, [[ids.http],[ids.response],[]]),
    fn('confirm_resolve', 5, [[ids.http],[ids.response],[],[ids.atomic],['subscription_poll_admit_20260914']]),
    fn('purchase_router', 5, [[ids.http],[],[ids.response],[],[ids.atomic]]),
    fn('atomic', 5, [[ids.find],[ids.update],[ids.projection],[ids.response],[ids.http]]),
    ...[['find','find'],['update','updateOne'],['projection','updateOne']].map(([name, operation]) => ({ id: ids[name], type: 'mongodb4', z,
      clientNode: 'fixture-mongo', collection: 'lk_tournament_subscription_sales', operation, output: 'toArray', handleDocId: false, wires: [[ids.atomic]] })),
    { id: 'subscription_poll_admit_20260914', type: 'function', z, outputs: 3, wires: [[],[],[]], func: 'return null;' },
    { id: 'fixture-mongo', type: 'mongodb4-client', name: 'Synthetic fixture, never connected' },
    { id: ids.http, type: 'http request', z, method: 'use', ret: 'obj', url: '', senderr: true, authType: '', insecureHTTPParser: false, wires: [[ids.purchase_router]] },
    { id: ids.response, type: 'http response', z, wires: [] },
  ];
};
const compose = flow => composeMonthlyFriendshipCustody(Buffer.from(JSON.stringify(flow)), 'monthly-friendship-fixture');
test('source-only composer changes exactly five function bodies and preserves every graph edge', () => {
  const source = fixture(), result = compose(source);
  assert.equal(result.candidate.length, source.length);
  const changed = result.candidate.filter((n,i) => JSON.stringify(n) !== JSON.stringify(source[i])); assert.equal(changed.length, 5);
  for (const n of changed) { const original = source.find(x => x.id === n.id); assert.deepEqual({ ...n, func: original.func }, original); }
  assert.ok(result.contract.candidateSha256);
});
test('composer rejects stale function, wrong storage/HTTP wiring and duplicate identities', () => {
  for (const mutate of [f => { f.find(n => n.id === ids.atomic).func += '\n// drift'; },
    f => { f.find(n => n.id === ids.update).collection = 'other'; },
    f => { f.find(n => n.id === ids.http).wires = [[ids.response]]; },
    f => { f.find(n => n.id === ids.purchase_router).wires[4] = [ids.http]; }, f => { f.push(f[1]); }]) {
    const flow = fixture(); mutate(flow); assert.throws(() => compose(flow), /MONTHLY_/);
  }
});
test('both actual monthly transaction creation branches enter custody; unconfigured annual source behavior preserved', () => {
  const fn = vm.runInNewContext('(function(msg,global){' + monthlyFriendshipSource('purchase_router') + '\n})', { URL, Buffer });
  const phone = '+7' + '9990000000';
  const base = { action: 'purchase', step: 'load_products', counterKey: 'friendship', inventoryId: 'fixture-monthly',
    clientId: 'fixture-client', clientPhone: phone, productId: 'fixture-product', productName: 'Monthly', token: 'fixture-token',
    successUrl: 'https://example.test/return', failUrl: 'https://example.test/return', productCostMinor: 980000 };
  const values = new Map([['monthly_friendship_custody_binding', { version: 1, enabled: false }], ['summer_subscription_friendship_promo_enabled', true]]);
  const globals = { get: key => values.get(key) };
  const msg = { _summerSubscriptionCtx: structuredClone(base), statusCode: 200, payload: { content: [{ id: 'fixture-product', name: 'Monthly', cost: 980000, type: 'SUBSCRIPTION' }] } };
  const plain = fn(msg, globals); assert.equal(plain[0], null); assert.equal(plain[4]._summerSubscriptionCtx.step, 'piter_reserve_start');
  const promo = { _summerSubscriptionCtx: { ...base, step: 'preview_promo', promoCode: 'FIXTURE15',
    expectedPromoQuote: { sumMinor: 980000, discountMinor: 147000, toPayMinor: 833000 }, transactionPayload: { products: [] } },
    statusCode: 200, payload: { sumKopecks: 980000, discountKopecks: 147000, toPayKopecks: 833000 } };
  const discounted = fn(promo, globals); assert.equal(discounted[0], null); assert.equal(discounted[4]._summerSubscriptionCtx.step, 'piter_reserve_start');
});
test('installing monthly custody preserves old non-custody PAID confirmation output', () => {
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : ['2026-11-02T12:00:00.000Z'])); } static now() { return Date.parse('2026-11-02T12:00:00.000Z'); } }
  const compile = source => vm.runInNewContext('(function(msg,global){' + source + '\n})', { URL, Buffer, Date: Clock });
  const original = compile(read('purchase_router')), composed = compile(monthlyFriendshipSource('purchase_router'));
  const input = { statusCode: 200, payload: { id: 'legacy-tx', status: 'PAID', toPay: 0 },
    _summerSubscriptionCtx: { action: 'confirm', step: 'confirm_lookup', counterKey: 'friendship', inventoryId: 'fixture-old',
      paymentRef: 'legacy-payment', transactionId: 'legacy-tx', productId: 'legacy-product', clientId: 'legacy-client',
      clientPhone: '+7' + '9990000000', expectedAmountMinor: 980000, reservationMinutes: 30 } };
  const global = { get: key => key === 'monthly_friendship_custody_binding' ? { version: 1, enabled: true } : undefined };
  const before = original(structuredClone(input), global), after = composed(structuredClone(input), global);
  assert.equal(after[4], undefined); assert.ok(after[1]); assert.equal(after[2].payload.status, 'PAID');
  assert.equal(JSON.stringify(after), JSON.stringify(before));
});


test('frozen monthly custody composer refuses the new annual release successor', () => {
  const flow = fixture();
  flow.find(n => n.id === ids.atomic).func = read('piter_atomic_router');
  const before = structuredClone(flow);
  assert.throws(() => compose(flow), /MONTHLY_SOURCE_PREIMAGE_DRIFT:atomic/);
  assert.deepEqual(flow, before);
});
