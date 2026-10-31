import fs from 'node:fs';
import crypto from 'node:crypto';
import { managedSelfLeaveOwnerSource } from './lib/managedSelfLeaveOwnerSource.mjs';
import {
  buildExactGraphContract,
  validateReviewedFlowContract,
} from './nodered_reviewed_flow_deploy/runtime_contract.mjs';
const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
// Exact approved parent #269; source custody is not a production preimage.
export const canonicalStages = [
  {
    name: 'prepare',
    id: '016d6797a530ed0a',
    outputs: 3,
    before: '7cae69a101cd4810d7b8f7d487f3ef6e2dfd42ea7e2df3343b6a70cbcb49bc6b',
  },
  {
    name: 'authorize',
    id: '7c280001a0c1e015',
    outputs: 5,
    before: 'ea9d1877528e2d1592fd04f1f5788aa910ecca4bb633d685f9ff2e516083346e',
  },
  {
    name: 'operation_start',
    id: 'lk_split_leave_operation_start_build_20260801',
    outputs: 2,
    before: 'd17d3472a31629fea729858934d7407101dee535f4981d611ddea31b2f7ab934',
  },
  {
    name: 'operation_route',
    id: 'lk_split_leave_operation_route_20260801',
    outputs: 5,
    before: 'f240f7a221fef55921c786fef0e94d683b7900c03f26263b89c636324f273ef5',
  },
  {
    name: 'operation_claim',
    id: 'lk_split_leave_operation_claim_build_20260801',
    outputs: 2,
    before: 'acdce2de1537a78b53a89d47fc07a4d2b46f2b541b9122ed4b3a648c19ed7f09',
  },
  {
    name: 'router',
    id: '9878400d518ebcbd',
    outputs: 5,
    before: '62ef198d99d4233462756b934c573084c8ea6775bf444546ffb87e7bb38d5250',
  },
];
export const ownerNodeIds = Object.freeze({
  admit: 'lk_managed_self_leave_admit_20261031',
  read: 'lk_managed_self_leave_read_20261031',
  verify: 'lk_managed_self_leave_verify_20261031',
  router: 'lk_managed_self_leave_router_20261031',
  dailyFind: 'lk_managed_self_leave_daily_find_20261031',
  dailyInsert: 'lk_managed_self_leave_daily_insert_20261031',
  dailyUpdate: 'lk_managed_self_leave_daily_update_20261031',
  leaveFind: 'lk_managed_self_leave_leave_find_20261031',
  gameFind: 'lk_managed_self_leave_game_find_20261031',
  http: 'lk_managed_self_leave_http_20261031',
  response: 'lk_managed_self_leave_response_20261031',
  catch: 'lk_managed_self_leave_catch_20261031',
});
export function composeManagedSelfLeaveOwner(liveBytes, deploymentId) {
  const flow = JSON.parse(Buffer.from(liveBytes).toString('utf8'));
  if (
    !Array.isArray(flow) ||
    flow.some((n) => !n || typeof n.id !== 'string') ||
    new Set(flow.map((n) => n.id)).size !== flow.length
  )
    throw new Error('Invalid SELF owner graph');
  const get = (id, type) => {
    const n = flow.find((n) => n.id === id);
    if (n?.type !== type) throw new Error('Missing SELF owner prerequisite: ' + id);
    return n;
  };
  const originalResponse = get('35f7c89069fc393a', 'http response');
  const gameTemplate = get('7c280001a0c1e014', 'mongodb4');
  const dailyTemplate = get('lk_split_leave_daily_limit_find_20260811', 'mongodb4');
  const z = canonicalStages.map((stage) => get(stage.id, 'function').z);
  if (
    new Set([...z, originalResponse.z, gameTemplate.z, dailyTemplate.z]).size !== 1 ||
    gameTemplate.collection !== 'lk_games' ||
    gameTemplate.operation !== 'find' ||
    dailyTemplate.collection !== 'lk_subscription_daily_booking_ops' ||
    dailyTemplate.operation !== 'find' ||
    !gameTemplate.clientNode ||
    gameTemplate.clientNode !== dailyTemplate.clientNode
  )
    throw new Error('SELF owner store identity mismatch');
  // #269 compensation reader, exact capability and bridge must already be in the packet.
  const bridge = get('lk_split_leave_managed_compensation_20261031', 'function');
  if (
    bridge.func !== read('./nodered_games_nodes/fn_split_leave_managed_compensation.js') ||
    get('lk_subscription_booking_leave_find_20261031', 'mongodb4').collection !==
      'lk_game_leave_operations' ||
    get('lk_subscription_booking_router_20260804', 'function').func !==
      read('./nodered_subscription_booking_nodes/fn_subscription_booking_owner_contract_probe.js') +
        read('./nodered_subscription_booking_nodes/fn_subscription_booking_router.js')
  )
    throw new Error('Missing canonical compensation packet');
  for (const id of Object.values(ownerNodeIds))
    if (flow.some((n) => n.id === id)) throw new Error('SELF owner node collision');
  const changes = [];
  canonicalStages.forEach((stage, index) => {
    const n = get(stage.id, 'function');
    if (
      sha(n.func) !== stage.before ||
      !(stage.name === 'router' ? [5, 6] : [stage.outputs]).includes(n.outputs) ||
      n.wires?.length !== n.outputs
    )
      throw new Error('SELF canonical stage drift: ' + stage.name);
    for (const target of n.wires.flat())
      if (!flow.some((row) => row.id === target)) throw new Error('SELF canonical target missing');
    n.func = read('./nodered_games_nodes/fn_split_leave_' + stage.name + '.js');
    new Function('msg', 'global', 'env', n.func);
    if (stage.name === 'router' && n.outputs === 5) n.wires.push([]);
    n.outputs = stage.name === 'router' ? 7 : n.outputs + 1;
    n.wires.push([canonicalStages[index + 1]?.id || ownerNodeIds.router]);
    changes.push({ id: n.id, fields: ['func', 'outputs', 'wires'] });
  });
  {
    const node = get('lk_split_leave_retry_query_20260801', 'function');
    if (
      sha(node.func) !== 'e044fcc3512c87c14347e85d007d152a0ec58ae093abb26e53302aa783c35df7' ||
      node.z !== z[0]
    )
      throw new Error('SELF background retry_query drift');
    node.func = read('./nodered_games_nodes/fn_split_leave_retry_query.js');
    changes.push({ id: node.id, fields: ['func'] });
  }
  {
    const node = get('lk_split_leave_retry_select_20260801', 'function');
    if (
      sha(node.func) !== 'a799dfbe533666f2d36879b78db884e1c5c9ed6e931bf5fc95f771562188e3c4' ||
      node.z !== z[0]
    )
      throw new Error('SELF background retry_select drift');
    node.func = read('./nodered_games_nodes/fn_split_leave_retry_select.js');
    changes.push({ id: node.id, fields: ['func'] });
  }
  const finalize = get('lk_split_leave_finalize_20260801', 'function');
  if (
    sha(finalize.func) !== '5af1a19c125c1094b911da0a62458237c0c50473351f197b611935c20bed8b19' ||
    finalize.z !== z[0]
  )
    throw new Error('SELF finalizer source drift');
  finalize.func = read('./nodered_games_nodes/fn_split_leave_finalize.js');
  changes.push({ id: finalize.id, fields: ['func'] });
  const responseCopy = { ...structuredClone(originalResponse), id: ownerNodeIds.response };
  Object.assign(originalResponse, {
    type: 'function',
    name: 'Read durable managed SELF completion',
    func: read('./nodered_managed_self_leave_nodes/fn_managed_self_leave_response.js'),
    outputs: 2,
    wires: [[ownerNodeIds.router], [ownerNodeIds.response]],
  });
  changes.push({ id: originalResponse.id, fields: ['type', 'name', 'func', 'outputs', 'wires'] });
  const functionNode = (id, name, outputs, wires) => ({
    id,
    type: 'function',
    z: z[0],
    name,
    func: managedSelfLeaveOwnerSource(name),
    outputs,
    wires,
    libs: [{ var: 'nodeCrypto', module: 'crypto' }],
  });
  const mongo = (id, template, collection, operation) => ({
    ...structuredClone(template),
    id,
    name: id,
    collection,
    operation,
    wires: [[ownerNodeIds.router]],
  });
  flow.push(
    responseCopy,
    {
      id: ownerNodeIds.admit,
      type: 'http in',
      z: z[0],
      name: 'Managed SELF admission',
      method: 'post',
      url: '/lk/integrations/v1/managed-self-leave-admissions',
      upload: false,
      wires: [[ownerNodeIds.verify]],
    },
    {
      id: ownerNodeIds.read,
      type: 'http in',
      z: z[0],
      name: 'Managed SELF receipt',
      method: 'get',
      url: '/lk/integrations/v1/managed-self-leaves/:operationId',
      upload: false,
      wires: [[ownerNodeIds.verify]],
    },
    functionNode(ownerNodeIds.verify, 'verify', 2, [
      [ownerNodeIds.dailyFind],
      [ownerNodeIds.response],
    ]),
    functionNode(ownerNodeIds.router, 'router', 8, [
      [ownerNodeIds.dailyFind],
      [ownerNodeIds.dailyInsert],
      [ownerNodeIds.dailyUpdate],
      [ownerNodeIds.leaveFind],
      [ownerNodeIds.gameFind],
      [ownerNodeIds.http],
      [canonicalStages[0].id],
      [ownerNodeIds.response],
    ]),
    mongo(ownerNodeIds.dailyFind, dailyTemplate, 'lk_subscription_daily_booking_ops', 'find'),
    mongo(
      ownerNodeIds.dailyInsert,
      dailyTemplate,
      'lk_subscription_daily_booking_ops',
      'updateOne',
    ),
    mongo(
      ownerNodeIds.dailyUpdate,
      dailyTemplate,
      'lk_subscription_daily_booking_ops',
      'updateOne',
    ),
    mongo(ownerNodeIds.leaveFind, dailyTemplate, 'lk_game_leave_operations', 'find'),
    mongo(ownerNodeIds.gameFind, gameTemplate, 'lk_games', 'find'),
    {
      id: ownerNodeIds.http,
      type: 'http request',
      z: z[0],
      name: 'Managed SELF read-only provider proof',
      method: 'use',
      ret: 'obj',
      paytoqs: 'ignore',
      url: '',
      requestTimeout: '10000',
      senderr: true,
      persist: false,
      authType: '',
      insecureHTTPParser: false,
      wires: [[ownerNodeIds.router]],
    },
    {
      id: ownerNodeIds.catch,
      type: 'catch',
      z: z[0],
      name: 'Fail closed managed SELF transport/store',
      uncaught: false,
      scope: [
        ownerNodeIds.dailyFind,
        ownerNodeIds.dailyInsert,
        ownerNodeIds.dailyUpdate,
        ownerNodeIds.leaveFind,
        ownerNodeIds.gameFind,
        ownerNodeIds.http,
      ],
      wires: [[ownerNodeIds.router]],
    },
  );
  const candidateBytes = Buffer.from(JSON.stringify(flow, null, 2) + '\n');
  const contract = buildExactGraphContract({
    liveBytes,
    candidateBytes,
    deploymentId,
    allowedChanges: changes,
    allowedAdditionIds: Object.values(ownerNodeIds),
  });
  validateReviewedFlowContract({ liveBytes, candidateBytes, contract });
  return { candidate: flow, candidateBytes, contract };
}
