import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { composeGameCreateOwner, gameCreateOwnerBaseCommit, gameCreateOwnerIds } from '../patch_nodered_game_create_owner.mjs';
import { trainingBookingPreludeSource } from '../lib/trainingRegistrationOwnerSource.mjs';
import { OwnerHarness } from './helpers/gameCreateOwnerHarness.mjs';
const base = path => execFileSync('git', ['show', gameCreateOwnerBaseCommit + ':scripts/' + path], { encoding: 'utf8' });
const booking = n => base('nodered_subscription_booking_nodes/fn_subscription_booking_' + n + '.js');
const id = n => 'lk_subscription_booking_' + n + '_20260804';
const split = '8f7bd5b482fe9763', splitPrepare = 'f3f9a60354d394da', splitHttp = 'ee7ba8cdd68bdf74';
function graph() {
  const fn = (key, func, outputs, wires) => ({ id: key, type: 'function', z: 'fixture-tab', func, outputs, wires, libs: [] });
  const http = (key, next) => ({ id: key, type: 'http request', z: 'fixture-tab', method: 'use', ret: 'obj', url: '', authType: '', senderr: true, insecureHTTPParser: false, wires: [[next]] });
  return [
    { id: 'fixture-tab', type: 'tab', label: 'Fixture LK' }, { id: 'fixture-db', type: 'mongodb4-client' },
    fn(id('prepare'), booking('prepare'), 3, [[id('http')], [id('finalize')], [id('router')]]),
    fn(id('router'), trainingBookingPreludeSource() + booking('owner_contract_probe') + booking('router'), 8,
      [[id('http')], [id('find')], [id('insert')], [id('update')], [id('finalize')], [id('debug')], [id('policy')], [id('leave_find')]]),
    fn(id('finalize'), booking('finalize'), 2, [[split], [id('response')]]),
    fn(id('mongo_error'), booking('mongo_error'), 1, [[id('finalize')]]),
    fn(id('options'), booking('options'), 3, [[id('response')], [id('router')], [id('prepare')]]),
    fn(split, base('nodered_games_nodes/fn_split_router.js'), 5, [[splitHttp], ['split-response'], [], [id('http')], []]),
    fn(splitPrepare, base('nodered_games_nodes/fn_split_create_prepare.js'), 4, [[splitHttp], ['split-response'], [], [split]]),
    http(id('http'), id('router')), http(splitHttp, split),
    ...[['find', 'find'], ['insert', 'insertOne'], ['update', 'updateOne'], ['leave_find', 'find']].map(([name, operation]) => ({
      id: id(name), type: 'mongodb4', z: 'fixture-tab', collection: name === 'leave_find' ? 'lk_game_leave_operations' : 'lk_subscription_daily_booking_ops',
      clientNode: 'fixture-db', operation, wires: [[id('router')]],
    })),
    { id: id('post'), type: 'http in', z: 'fixture-tab', method: 'post', url: '/lk/subscription-bookings', wires: [[id('prepare')]] },
    { id: 'lk_subscription_booking_owner_probe_get_20261023', type: 'http in', z: 'fixture-tab', method: 'get', url: '/lk/subscription-bookings', wires: [[id('options')]] },
    { id: id('catch'), type: 'catch', z: 'fixture-tab', uncaught: false, scope: ['find', 'insert', 'update', 'leave_find'].map(id), wires: [[id('mongo_error')]] },
    ...[id('response'), 'split-response'].map(key => ({ id: key, type: 'http response', z: 'fixture-tab', wires: [] })),
    ...['debug', 'policy'].map(n => fn(id(n), 'return null;', 1, [[]])),
  ];
}
test('source-only atomic graph keeps ordinary fourth edge and replaces only exact reviewed canonical stages', () => {
  const original = graph(); const result = composeGameCreateOwner(Buffer.from(JSON.stringify(original)), 'fixture-quarter-create');
  assert.equal(result.candidate.length, original.length + Object.keys(gameCreateOwnerIds).length);
  const bridge = result.candidate.find(n => n.id === gameCreateOwnerIds.bridge);
  assert.deepEqual(bridge.wires, [[id('http')], [id('router')], [id('prepare')]]);
  const h = new OwnerHarness(), message = { payload: { ordinary: true } };
  assert.deepEqual(h.invokeOwner('bridge', message), [message, null, null]);
  assert.deepEqual(result.candidate.find(n => n.id === id('post')), original.find(n => n.id === id('post')));
});
for (const mutate of [
  f => f.find(n => n.id === id('find')).wires[0].push(id('debug')),
  f => f.find(n => n.id === id('post')).wires = [[id('router')]],
  f => f.find(n => n.id === id('update')).collection = 'foreign_collection',
  f => f.find(n => n.id === id('finalize')).func += '\n// drift',
  f => f.find(n => n.id === split).wires[3] = [id('router')],
  f => f.find(n => n.id === id('catch')).scope = [id('find')],
  f => f.push({ id: 'foreign', type: 'function', wires: [[gameCreateOwnerIds.router]] }),
]) test('unknown source/topology cannot certify CREATE graph: ' + mutate.toString(), () => {
  const f = graph(); mutate(f); assert.throws(() => composeGameCreateOwner(Buffer.from(JSON.stringify(f)), 'fixture-quarter-create'));
});
for (const [node, source] of [['gatewayPrepare', booking('prepare')], ['finalize', booking('finalize')],
  ['splitPrepare', base('nodered_games_nodes/fn_split_create_prepare.js')], ['split', base('nodered_games_nodes/fn_split_router.js')]]) {
  test('actual mixed old stage ' + node + ' fails before reserve or provider mutation', () => {
    const h = new OwnerHarness(); h.ownerFns[node] = new Function('msg', 'env', 'global', 'nodeCrypto', 'Date', source);
    const r = h.execute();
    assert.notEqual(r.payload.operation?.status, 'CONFIRMED');
    assert.equal(h.reserveCalls, 0); assert.equal(h.providerCreates, 0); assert.equal(h.bookingCreates, 0);
  });
}
