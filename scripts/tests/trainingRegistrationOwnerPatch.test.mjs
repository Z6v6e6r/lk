import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  composeTrainingRegistrationOwner,
  trainingOwnerBaseCommit,
  trainingOwnerRouterSource,
  trainingOwnerIds,
} from '../patch_nodered_training_registration_owner.mjs';
import { trainingSelectorSourceHash } from '../lib/trainingRegistrationOwnerSource.mjs';
import { Harness, fixture } from './helpers/trainingRegistrationOwnerHarness.mjs';
const read = (name) =>
  fs.readFileSync(
    new URL(
      '../nodered_subscription_booking_nodes/fn_subscription_booking_' + name + '.js',
      import.meta.url,
    ),
    'utf8',
  );
const base = (name) =>
  execFileSync(
    'git',
    [
      'show',
      trainingOwnerBaseCommit +
        ':scripts/nodered_subscription_booking_nodes/fn_subscription_booking_' +
        name +
        '.js',
    ],
    { encoding: 'utf8' },
  );
const id = (name) => 'lk_subscription_booking_' + name + '_20260804';
function graph() {
  const fn = (name, func, outputs, wires) => ({
    id: id(name),
    type: 'function',
    z: 'training-fixture-tab',
    name,
    func,
    outputs,
    wires,
    libs: [],
  });
  return [
    { id: 'training-fixture-tab', type: 'tab', label: 'Synthetic LK' },
    { id: 'synthetic-mongo', type: 'mongodb4-client', name: 'Synthetic client' },
    fn('prepare', base('prepare'), 2, [[id('http')], [id('finalize')]]),
    fn('router', base('owner_contract_probe') + base('router'), 8, [
      [id('http')],
      [id('find')],
      [id('insert')],
      [id('update')],
      [id('finalize')],
      [id('debug')],
      [id('policy')],
      [id('leave_find')],
    ]),
    fn('finalize', base('finalize'), 2, [[id('split')], [id('response')]]),
    fn('options', base('options'), 2, [[id('response')], [id('router')]]),
    {
      id: id('post'),
      type: 'http in',
      z: 'training-fixture-tab',
      method: 'post',
      url: '/lk/subscription-bookings',
      wires: [[id('prepare')]],
    },
    {
      id: 'lk_subscription_booking_owner_probe_get_20261023',
      type: 'http in',
      z: 'training-fixture-tab',
      method: 'get',
      url: '/lk/subscription-bookings',
      wires: [[id('options')]],
    },
    fn('mongo_error', base('mongo_error'), 1, [[id('finalize')]]),
    {
      id: id('catch'),
      type: 'catch',
      z: 'training-fixture-tab',
      uncaught: false,
      scope: [id('find'), id('insert'), id('update')],
      wires: [[id('mongo_error')]],
    },
    ...['debug', 'policy', 'split'].map((name) => fn(name, 'return null;', 1, [[]])),
    ...[
      ['find', 'find'],
      ['insert', 'insertOne'],
      ['update', 'updateOne'],
      ['leave_find', 'find'],
    ].map(([name, operation]) => ({
      id: id(name),
      type: 'mongodb4',
      z: 'training-fixture-tab',
      collection:
        name === 'leave_find' ? 'lk_game_leave_operations' : 'lk_subscription_daily_booking_ops',
      clientNode: 'synthetic-mongo',
      operation,
      mode: 'collection',
      output: 'toArray',
      wires: [[id('router')]],
    })),
    {
      id: id('http'),
      type: 'http request',
      z: 'training-fixture-tab',
      method: 'use',
      ret: 'obj',
      url: '',
      authType: '',
      wires: [[id('router')]],
    },
    { id: id('response'), type: 'http response', z: 'training-fixture-tab', wires: [] },
  ];
}
test('exact source-only packet composes gate, probe, scrub and isolated routes atomically', () => {
  const before = graph(),
    bytes = Buffer.from(JSON.stringify(before));
  const result = composeTrainingRegistrationOwner(bytes, 'fixture-training-owner');
  assert.equal(result.selectorSourceSha256, trainingSelectorSourceHash);
  assert.equal(
    trainingSelectorSourceHash,
    '47dbfc40631d9dfd6b33122562518c41504c1095de479b211b340d950a3c1e5b',
  );
  assert.equal(result.candidate.length, before.length + Object.keys(trainingOwnerIds).length);
  for (const n of before) {
    if (['prepare', 'router', 'finalize', 'mongo_error', 'options'].some((k) => id(k) === n.id))
      continue;
    assert.deepEqual(
      result.candidate.find((x) => x.id === n.id),
      n,
      'ordinary node unchanged ' + n.id,
    );
  }
  const router = result.candidate.find((n) => n.id === id('router'));
  assert.equal(router.func, trainingOwnerRouterSource());
  assert.ok(router.func.includes('resolveLk1Rule'));
  assert.ok(router.func.includes('isProTrainingExercise'));
  assert.ok(router.func.includes('trainingOutput'));
  for (const n of result.candidate.filter((n) => n.type === 'function'))
    new Function('msg', 'env', 'global', 'nodeCrypto', n.func);
});
test('unknown installed wrapper, changed store or mixed graph is rejected rather than overwritten', () => {
  for (const mutate of [
    (g) => {
      g.find((n) => n.id === id('find')).wires = [[id('router'), 'unreviewed-diagnostic']];
    },
    (g) => {
      g.find((n) => n.id === id('find')).wires = [['wrong-only']];
    },
    (g) => {
      g.find((n) => n.id === id('router')).func += '\n// unknown installed wrapper';
    },
    (g) => {
      g.find((n) => n.id === id('finalize')).func = 'return msg;';
    },
    (g) => {
      g.find((n) => n.id === id('update')).clientNode = 'other';
    },
    (g) => {
      g.find((n) => n.id === id('prepare')).wires[0] = [id('router')];
    },
  ]) {
    const g = graph();
    mutate(g);
    assert.throws(() =>
      composeTrainingRegistrationOwner(Buffer.from(JSON.stringify(g)), 'fixture-training-owner'),
    );
  }
});
test('raw or old probe cannot advertise training; complete source does and old probes stay exact', () => {
  const h = new Harness();
  const request = () => ({
    _subscriptionBooking: { step: 'booked_operation_contract_probe' },
    req: {
      method: 'GET',
      originalUrl: '/lk/subscription-bookings',
      query: {},
      headers: { 'x-training-registration-owner-contract': '1' },
    },
  });
  assert.equal(h.compile(read('owner_contract_probe'))(request())[4].statusCode, 404);
  assert.equal(h.capability().payload.policy, 'TRAINING_LEGACY_V1');
  for (const version of ['1', '2', '3']) {
    const msg = {
      _subscriptionBooking: { step: 'booked_operation_contract_probe' },
      req: { method: 'GET', headers: { 'x-booked-operation-owner-contract': version } },
    };
    assert.deepEqual(
      h.compile(read('owner_contract_probe'))(structuredClone(msg)),
      h.compile(base('owner_contract_probe'))(structuredClone(msg)),
    );
  }
});
test('actual old prepare/new router, new prepare/old router and old finalizer all fail before provider dispatch', () => {
  for (const name of ['prepare', 'options', 'canonical', 'finalize']) {
    const h = new Harness();
    const source =
      name === 'canonical' ? base('owner_contract_probe') + base('router') : base(name);
    h.options.mixedCapability = { [name]: h.compile(source) };
    assert.notEqual(
      h.capability(h.options.mixedCapability).payload.policy,
      'TRAINING_LEGACY_V1',
      name,
    );
    assert.equal(h.run().statusCode, 503, name);
    assert.equal(h.calls.filter((c) => c.method === 'POST').length, 0, name);
    assert.equal(h.rows.size, 0, name);
  }
});
test('new router refuses training body erased by old prepare on direct canonical POST', () => {
  const h = new Harness();
  h.functions.prepare = h.compile(base('prepare'));
  const body = structuredClone(fixture.canonicalOwner.request);
  const result = h.canonical({
    req: {
      headers: { authorization: 'Bearer ' + 'synthetic-training-actor-credential' },
      body: structuredClone(body),
    },
    payload: body,
  });
  assert.equal(result.payload.state, 'UNKNOWN');
  assert.equal(h.calls.filter((c) => c.method === 'POST').length, 0);
  assert.equal(h.rows.size, 0);
});
test('canonical inbound method/path/wiring and persistence error leg are part of exact graph custody', () => {
  for (const mutate of [
    (g) => {
      g.find((n) => n.id === id('post')).wires = [[id('router')]];
    },
    (g) => {
      g.find((n) => n.id === 'lk_subscription_booking_owner_probe_get_20261023').method = 'post';
    },
    (g) => {
      g.find((n) => n.id === id('mongo_error')).func += '\n// old error handler';
    },
  ]) {
    const g = graph();
    mutate(g);
    assert.throws(() =>
      composeTrainingRegistrationOwner(Buffer.from(JSON.stringify(g)), 'fixture-training-owner'),
    );
  }
});
test('ordinary canonical prepare/finalize remain equivalent without restrictive training context', () => {
  const h = new Harness();
  const message = {
    payload: {
      operationId: fixture.ids.operationId,
      exerciseId: 'synthetic-exercise',
      clientSubscriptionId: 'synthetic-subscription',
    },
    req: { headers: { authorization: 'Bearer ' + 'synthetic-user-credential' } },
  };
  assert.deepEqual(
    h.compile(read('prepare'))(structuredClone(message)),
    h.compile(base('prepare'))(structuredClone(message)),
  );
  const final = {
    _subscriptionBooking: { caller: 'http' },
    payload: { ok: true, state: 'CONFIRMED', bookingId: 'synthetic-booking' },
    statusCode: 201,
  };
  assert.deepEqual(
    h.compile(read('finalize'))(structuredClone(final)),
    h.compile(base('finalize'))(structuredClone(final)),
  );
});
test('canonical Mongo catch never exposes training credentials to diagnostics and reaches scrub', () => {
  let observations = 0;
  const h = new Harness({
    globals: {
      lkDiagnostics: {
        observe() {
          observations++;
        },
      },
    },
  });
  const msg = {
    _subscriptionBooking: {
      trainingRegistration: fixture.canonicalOwner.request.trainingRegistration,
      operationId: fixture.ids.operationId,
      step: 'operation_accept',
      authHeader: 'Bearer ' + 'synthetic-private-actor',
    },
    headers: { Authorization: 'Bearer ' + 'synthetic-private-service' },
    error: { message: 'synthetic-private-provider-error' },
    payload: { raw: 'synthetic-private' },
  };
  const errorResult = h.compile(read('mongo_error'))(msg);
  const result = h.compile(read('finalize'))(errorResult)[1];
  assert.equal(observations, 0);
  assert.equal(result.payload.state, 'UNKNOWN');
  assert.equal(JSON.stringify(result).includes('synthetic-private'), false);
  const ordinary = {
    _subscriptionBooking: {
      caller: 'http',
      step: 'operation_accept',
      operationId: 'synthetic-operation',
    },
  };
  assert.deepEqual(
    h.compile(read('mongo_error'))(structuredClone(ordinary)),
    h.compile(base('mongo_error'))(structuredClone(ordinary)),
  );
});
