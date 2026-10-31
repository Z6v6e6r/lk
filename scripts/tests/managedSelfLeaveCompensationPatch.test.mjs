import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { composeManagedSelfLeaveCompensation } from '../patch_nodered_managed_self_leave_compensation.mjs';
const old = path => execFileSync('git', ['show', `71db810308ae56c228b62f3adbad9e8c7b3415da:scripts/${path}`], { encoding: 'utf8' });
function fixture() {
  const nodes = [
    ['lk_split_leave_operation_start_build_20260801', 'nodered_games_nodes/fn_split_leave_operation_start.js'],
    ['lk_split_leave_operation_route_20260801', 'nodered_games_nodes/fn_split_leave_operation_route.js'],
    ['lk_split_leave_operation_claim_build_20260801', 'nodered_games_nodes/fn_split_leave_operation_claim.js'],
    ['lk_split_leave_operation_claim_ack_20260801', 'nodered_games_nodes/fn_split_leave_operation_claim_ack.js'],
    ['lk_split_leave_daily_limit_route_20260811', 'nodered_games_nodes/fn_split_leave_daily_limit_route.js'],
    ['lk_subscription_booking_prepare_20260804', 'nodered_subscription_booking_nodes/fn_subscription_booking_prepare.js'],
    ['lk_subscription_booking_router_20260804', null],
  ].map(([id, path]) => ({ id, type: 'function', z: 'fixture-tab', outputs: 1, wires: [[]], func: path ? old(path)
    : old('nodered_subscription_booking_nodes/fn_subscription_booking_owner_contract_probe.js') + old('nodered_subscription_booking_nodes/fn_subscription_booking_router.js') }));
  const node = id => nodes.find(n => n.id === id);
  Object.assign(node('lk_split_leave_daily_limit_route_20260811'), { outputs: 4, wires: [
    ['lk_split_leave_daily_limit_update_20260811'], ['lk_split_leave_game_update_build_20260801'],
    ['lk_split_leave_operation_done_build_20260801'], ['lk_split_leave_retry_response_20260801']] });
  Object.assign(node('lk_split_leave_operation_claim_ack_20260801'), { outputs: 2, wires: [['9878400d518ebcbd'], ['35f7c89069fc393a']] });
  Object.assign(node('lk_subscription_booking_router_20260804'), { outputs: 7, wires: [
    ['lk_subscription_booking_http_20260804'], ['lk_subscription_booking_find_20260804'], ['lk_subscription_booking_insert_20260804'],
    ['lk_subscription_booking_update_20260804'], ['lk_subscription_booking_finalize_20260804'], ['lk_subscription_booking_debug_20260804'],
    ['lk_subscription_managed_policy_20260820']] });
  for (const id of [...new Set(nodes.flatMap(n => n.wires.flat()))]) if (!node(id)) nodes.push({ id, type: 'function', z: 'fixture-tab', func: 'return msg;', outputs: 1, wires: [[]] });
  nodes.push({ id: 'lk_split_leave_daily_limit_find_build_20260811', type: 'function', z: 'fixture-tab', func: 'return msg;', wires: [[]] });
  Object.assign(node('lk_subscription_booking_find_20260804'), { type: 'mongodb4', collection: 'lk_subscription_daily_booking_ops', operation: 'find', clientNode: 'fixture-mongo' });
  nodes.push({ id: 'fixture-tab', type: 'tab', disabled: false });
  return nodes;
}
test('SELF compensation packet contains bridge, exact owner capability, durable authority reader and reclaim wiring together', () => {
  const flow = fixture(); const { candidate, contract } = composeManagedSelfLeaveCompensation(Buffer.from(JSON.stringify(flow)), 'fixture-managed-self-leave');
  const node = id => candidate.find(n => n.id === id);
  assert.equal(node('lk_subscription_booking_router_20260804').outputs, 8);
  assert.deepEqual(node('lk_subscription_booking_router_20260804').wires.slice(0, 7), flow.find(n => n.id === 'lk_subscription_booking_router_20260804').wires);
  assert.match(node('lk_subscription_booking_router_20260804').func, /MANAGED_SELF_LEAVE_V1/);
  assert.equal(node('lk_subscription_booking_leave_find_20261031').collection, 'lk_game_leave_operations');
  assert.deepEqual(node('lk_split_leave_operation_claim_ack_20260801').wires[2], ['lk_split_leave_daily_limit_find_build_20260811']);
  assert.equal(contract.allowedAdditions.length, 4);
  assert.equal(candidate.filter(n => n.type === 'http in').length, 0, 'no new public endpoint');
});
test('unknown function, wrong graph, already installed packet and wrong Mongo source fail before artifact output', () => {
  for (const mutate of [f => { f[0].func += '\n// drift'; },
    f => { f.find(n => n.id === 'lk_split_leave_daily_limit_route_20260811').wires[1] = ['35f7c89069fc393a']; },
    f => { f.find(n => n.type === 'mongodb4').collection = 'foreign'; },
    f => { f.push({ id: 'lk_split_leave_managed_compensation_20261031', type: 'function' }); }]) {
    const f = fixture(); mutate(f);
    assert.throws(() => composeManagedSelfLeaveCompensation(Buffer.from(JSON.stringify(f)), 'fixture-managed-self-leave'));
  }
});
