import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  composeManagedSelfLeaveOwner,
  canonicalStages,
  ownerNodeIds,
} from '../patch_nodered_managed_self_leave_owner.mjs';
const base = '8d46b9b53a1baa0b06bca6e127950b6845d08d65';
const old = (name) =>
  execFileSync('git', ['show', `${base}:scripts/nodered_games_nodes/fn_split_leave_${name}.js`], {
    encoding: 'utf8',
  });
function fixture(routerOutputs = 5) {
  const flow = canonicalStages.map((s) => ({
    id: s.id,
    type: 'function',
    z: 'fixture-tab',
    name: s.name,
    outputs: s.name === 'router' ? routerOutputs : s.outputs,
    wires: Array.from({ length: s.name === 'router' ? routerOutputs : s.outputs }, () => [
      'fixture-sink',
    ]),
    func: old(s.name),
  }));
  for (const name of ['retry_query', 'retry_select'])
    flow.push({
      id: 'lk_split_leave_' + name + '_20260801',
      type: 'function',
      z: 'fixture-tab',
      outputs: name === 'retry_select' ? 2 : 1,
      wires: name === 'retry_select' ? [['fixture-sink'], ['fixture-sink']] : [['fixture-sink']],
      func: old(name),
    });
  flow.push(
    {
      id: 'lk_split_leave_finalize_20260801',
      type: 'function',
      z: 'fixture-tab',
      outputs: 2,
      wires: [['fixture-sink'], ['fixture-sink']],
      func: old('finalize'),
    },
    { id: 'fixture-tab', type: 'tab', disabled: false },
    { id: 'fixture-sink', type: 'debug', z: 'fixture-tab', wires: [] },
    { id: 'fixture-mongo', type: 'mongodb4-client' },
    {
      id: '35f7c89069fc393a',
      type: 'http response',
      z: 'fixture-tab',
      name: 'Existing response',
      headers: { 'X-Fixture': 'preserved' },
      wires: [],
    },
    {
      id: '7c280001a0c1e014',
      type: 'mongodb4',
      z: 'fixture-tab',
      collection: 'lk_games',
      operation: 'find',
      clientNode: 'fixture-mongo',
      wires: [['fixture-sink']],
    },
    {
      id: 'lk_split_leave_daily_limit_find_20260811',
      type: 'mongodb4',
      z: 'fixture-tab',
      collection: 'lk_subscription_daily_booking_ops',
      operation: 'find',
      clientNode: 'fixture-mongo',
      wires: [['fixture-sink']],
    },
    {
      id: 'lk_split_leave_managed_compensation_20261031',
      type: 'function',
      z: 'fixture-tab',
      func: fs.readFileSync(
        new URL('../nodered_games_nodes/fn_split_leave_managed_compensation.js', import.meta.url),
        'utf8',
      ),
      outputs: 1,
      wires: [['fixture-sink']],
    },
    {
      id: 'lk_subscription_booking_leave_find_20261031',
      type: 'mongodb4',
      z: 'fixture-tab',
      collection: 'lk_game_leave_operations',
      operation: 'find',
      clientNode: 'fixture-mongo',
      wires: [['fixture-sink']],
    },
    {
      id: 'lk_subscription_booking_router_20260804',
      type: 'function',
      z: 'fixture-tab',
      func:
        fs.readFileSync(
          new URL(
            '../nodered_subscription_booking_nodes/fn_subscription_booking_owner_contract_probe.js',
            import.meta.url,
          ),
          'utf8',
        ) +
        fs.readFileSync(
          new URL(
            '../nodered_subscription_booking_nodes/fn_subscription_booking_router.js',
            import.meta.url,
          ),
          'utf8',
        ),
      outputs: 1,
      wires: [['fixture-sink']],
    },
  );
  return flow;
}
test('atomic source packet appends capability while preserving every prior wire and shared ordinary response', () => {
  for (const count of [5, 6]) {
    const before = fixture(count);
    const { candidate, contract } = composeManagedSelfLeaveOwner(
      Buffer.from(JSON.stringify(before)),
      'synthetic-managed-self-owner',
    );
    const node = (id) => candidate.find((n) => n.id === id);
    for (const stage of canonicalStages) {
      const source = before.find((n) => n.id === stage.id);
      assert.deepEqual(node(stage.id).wires.slice(0, source.outputs), source.wires);
      assert.equal(node(stage.id).outputs, stage.name === 'router' ? 7 : stage.outputs + 1);
    }
    assert.deepEqual(node(canonicalStages.at(-1).id).wires[6], [ownerNodeIds.router]);
    assert.equal(contract.allowedAdditions.length, Object.keys(ownerNodeIds).length);
    const response = new Function('msg', node('35f7c89069fc393a').func);
    const ordinary = { payload: { ok: true }, headers: { 'X-Fixture': 'unchanged' } };
    assert.deepEqual(response(ordinary), [null, ordinary]);
    assert.equal(node(ownerNodeIds.response).type, 'http response');
    const managed = { _managedSelfLeave: { step: 'canonical' }, payload: { ok: true } };
    assert.deepEqual(response(managed), [managed, null]);
    assert.equal(node(ownerNodeIds.http).requestTimeout, '10000');
    assert.deepEqual(
      candidate
        .filter((n) => n.type === 'http in')
        .map((n) => n.method)
        .sort(),
      ['get', 'post'],
    );
  }
});
test('mixed source, wrong stores, colliding node and graph target drift refuse candidate', () => {
  for (const mutate of [
    (f) => (f[0].func += '\n// changed'),
    (f) => (f[0].wires[0] = ['missing']),
    (f) => (f.find((n) => n.id === '7c280001a0c1e014').clientNode = 'other'),
    (f) => (f.find((n) => n.id === 'lk_subscription_booking_router_20260804').func = 'return msg;'),
    (f) => f.push({ id: ownerNodeIds.read, type: 'http in' }),
    (f) => (f.find((n) => n.id === 'lk_split_leave_finalize_20260801').func += '\n// drift'),
    (f) => (f[0].outputs = 9),
  ]) {
    const flow = fixture();
    mutate(flow);
    assert.throws(() =>
      composeManagedSelfLeaveOwner(
        Buffer.from(JSON.stringify(flow)),
        'synthetic-managed-self-owner',
      ),
    );
  }
});
