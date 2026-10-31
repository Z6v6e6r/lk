import fs from 'node:fs';
import crypto from 'node:crypto';
import { visitLifecycleRuntimeSource } from './lib/subscriptionVisitRuntimeSource.mjs';
import { buildExactGraphContract, validateReviewedFlowContract } from './nodered_reviewed_flow_deploy/runtime_contract.mjs';

const read = path => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const ids = {
  route: 'lk_split_leave_daily_limit_route_20260811', find: 'lk_split_leave_daily_limit_find_build_20260811',
  claimAck: 'lk_split_leave_operation_claim_ack_20260801',
  owner: 'lk_subscription_booking_router_20260804', ownerFind: 'lk_subscription_booking_find_20260804',
  leaveFind: 'lk_subscription_booking_leave_find_20261031',
  bridge: 'lk_split_leave_managed_compensation_20261031', http: 'lk_split_leave_managed_compensation_http_20261031',
  catch: 'lk_split_leave_managed_compensation_catch_20261031',
};
// Source custody for the approved parent 71db810. These are not production
// preimages or activation permission; unknown live graphs cannot be composed.
const sources = [
  ['lk_split_leave_operation_start_build_20260801', './nodered_games_nodes/fn_split_leave_operation_start.js', '7f81b97d26ff23d13efae73fc4dc6209980089d0698e69110d79814f5da698e3'],
  ['lk_split_leave_operation_route_20260801', './nodered_games_nodes/fn_split_leave_operation_route.js', 'dd75e4604ff22d44f3cb83b2b38b4ff9a2746cf6a3b94199abaa8385782db659'],
  ['lk_split_leave_operation_claim_build_20260801', './nodered_games_nodes/fn_split_leave_operation_claim.js', 'a0f74b5bb2f48a221eadb9bb374f81e847e7790bb3bbef22361dc123fc6f55ea'],
  [ids.claimAck, './nodered_games_nodes/fn_split_leave_operation_claim_ack.js', '2545d0a211f45b93d8bea6d17d5f7fa0a303e637d04eab3b40392098f2bb12ba'],
  [ids.route, './nodered_games_nodes/fn_split_leave_daily_limit_route.js', '65e17216b5515e4cd9938fdf61f01ead302452118935d71536a8acac2433427f'],
  ['lk_subscription_booking_prepare_20260804', './nodered_subscription_booking_nodes/fn_subscription_booking_prepare.js', 'ca70c073b85d8728589e5994ed0b9f871824bc9735908a61caed806f4a02164a'],
  [ids.owner, null, '8bbd4f08ee8f14052f0f4a3d693b9a50bd49e2d94e8fc76187deadcf263231f2'],
];
export function composeManagedSelfLeaveCompensation(liveBytes, deploymentId) {
  const flow = JSON.parse(Buffer.from(liveBytes).toString('utf8'));
  if (!Array.isArray(flow) || flow.some(row => !row || typeof row.id !== 'string')
    || new Set(flow.map(row => row.id)).size !== flow.length) throw new Error('Invalid managed SELF source');
  const get = (id, type) => {
    const node = flow.find(row => row.id === id);
    if (node?.type !== type) throw new Error(`Missing managed SELF prerequisite: ${id}`);
    return node;
  };
  const allowedChanges = [];
  for (const [id, path, before] of sources) {
    const node = get(id, 'function');
    const paidPrefix = id === ids.route ? visitLifecycleRuntimeSource() : '';
    const original = node.func || '';
    const paid = paidPrefix && original.startsWith(paidPrefix);
    if (sha(paid ? original.slice(paidPrefix.length) : original) !== before) throw new Error(`Managed SELF preimage drift: ${id}`);
    node.func = path ? (paid ? paidPrefix : '') + read(path)
      : read('./nodered_subscription_booking_nodes/fn_subscription_booking_owner_contract_probe.js')
        + read('./nodered_subscription_booking_nodes/fn_subscription_booking_router.js');
    new Function('msg', 'global', 'env', node.func);
    allowedChanges.push({ id, fields: ['func', ...(id === ids.route || id === ids.claimAck || id === ids.owner ? ['outputs', 'wires'] : [])] });
  }
  const route = get(ids.route, 'function');
  const owner = get(ids.owner, 'function');
  const ack = get(ids.claimAck, 'function');
  const find = get(ids.ownerFind, 'mongodb4');
  if (route.outputs !== 4 || route.wires?.length !== 4 || owner.outputs !== 7 || owner.wires?.length !== 7
    || ack.outputs !== 2 || ack.wires?.length !== 2 || find.collection !== 'lk_subscription_daily_booking_ops'
    || find.operation !== 'find' || !find.clientNode || !find.z || owner.z !== find.z) throw new Error('Managed SELF topology drift');
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (!same(route.wires, [['lk_split_leave_daily_limit_update_20260811'], ['lk_split_leave_game_update_build_20260801'],
    ['lk_split_leave_operation_done_build_20260801'], ['lk_split_leave_retry_response_20260801']])
    || !same(ack.wires, [['9878400d518ebcbd'], ['35f7c89069fc393a']])
    || !same(owner.wires, [['lk_subscription_booking_http_20260804'], [ids.ownerFind],
      ['lk_subscription_booking_insert_20260804'], ['lk_subscription_booking_update_20260804'],
      ['lk_subscription_booking_finalize_20260804'], ['lk_subscription_booking_debug_20260804'],
      ['lk_subscription_managed_policy_20260820']]) || route.z !== owner.z || ack.z !== route.z) {
    throw new Error('Managed SELF exact topology mismatch');
  }
  get(ids.find, 'function');
  for (const target of [...route.wires.flat(), ...owner.wires.flat(), ...ack.wires.flat()]) {
    if (!flow.some(node => node.id === target)) throw new Error('Managed SELF missing wire target');
  }
  for (const id of [ids.leaveFind, ids.bridge, ids.http, ids.catch]) {
    if (flow.some(node => node.id === id)) throw new Error('Managed SELF node collision');
  }
  route.outputs = 5; route.wires.push([ids.bridge]);
  owner.outputs = 8; owner.wires.push([ids.leaveFind]);
  ack.outputs = 3; ack.wires.push([ids.find]);
  const bridge = { ...structuredClone(route), id: ids.bridge, name: 'Confirm managed SELF compensation',
    func: read('./nodered_games_nodes/fn_split_leave_managed_compensation.js'), outputs: 4,
    wires: [[ids.http], route.wires[1], route.wires[2], route.wires[3]] };
  flow.push(bridge, { ...structuredClone(find), id: ids.leaveFind, name: 'Read exact SELF return authority',
    collection: 'lk_game_leave_operations', wires: [[ids.owner]] },
  { id: ids.http, z: route.z, type: 'http request', name: 'Canonical SELF compensation owner', method: 'use',
    ret: 'obj', paytoqs: 'ignore', url: '', requestTimeout: '10000', senderr: true, persist: false,
    authType: '', insecureHTTPParser: false, wires: [[ids.bridge]] },
  { id: ids.catch, z: route.z, type: 'catch', name: 'Fail closed managed SELF transport/read',
    scope: [ids.http, ids.leaveFind], uncaught: false, wires: [route.wires[3]] });
  new Function('msg', 'env', bridge.func);
  const candidateBytes = Buffer.from(`${JSON.stringify(flow, null, 2)}\n`);
  const contract = buildExactGraphContract({ liveBytes, candidateBytes, deploymentId,
    allowedChanges, allowedAdditionIds: [ids.leaveFind, ids.bridge, ids.http, ids.catch] });
  validateReviewedFlowContract({ liveBytes, candidateBytes, contract });
  return { candidate: flow, candidateBytes, contract };
}
