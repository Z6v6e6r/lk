import crypto from 'node:crypto';
import { monthlyFriendshipSource } from './lib/monthlyFriendshipSource.mjs';
import { buildExactGraphContract, validateReviewedFlowContract } from './nodered_reviewed_flow_deploy/runtime_contract.mjs';
export const monthlyFriendshipIds = Object.freeze({
  status_response: 'c165e43eba668c25', purchase_limit: 'f8679e53edadc39b', confirm_resolve: 'ca022fd14027a5b0',
  purchase_router: '566ae4b886c37ae5', atomic: 'piter_atomic_router_20260903',
  find: 'piter_ledger_find_20260903', update: 'piter_ledger_update_20260903', projection: 'piter_sale_update_20260903',
  http: 'fdc3f25f39199546', response: '10fe94a32b8adc35',
});
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
// Exact source preimages from LK owner integration 046f29b6; refresh only after review.
export const monthlyFriendshipPrerequisites = Object.freeze({
  status_response: '82f691e6d2ca2d2af77ad7a372f67a2b1e5789a0143f4d34407c655cabffc9f7',
  purchase_limit: '0c3256af3a27ab76d0e5743b7c8dd9fc329793bf7cd0e9f5e792331521fe332e',
  confirm_resolve: '56acebba4d0b9dd5fc98467172ab96155316b7466170f44830648d6215873626',
  purchase_router: '917dd30375dab1602a311d61be3d6d024d4925d8ab21e642cce166f9a6983e91',
  atomic: '399e95cd6864c0d865a977be18773bef24b140d74c12b661682e01181769bb39',
});
// Pure exact-preimage composition. Does not import flows, create indexes, enable a
// binding, access Mongo or invoke any provider. Activation is a separate operation.
export function composeMonthlyFriendshipCustody(liveBytes, deploymentId) {
  const flow = JSON.parse(Buffer.from(liveBytes).toString('utf8')), ids = monthlyFriendshipIds;
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (!Array.isArray(flow) || flow.some(n => !n || typeof n.id !== 'string' || !n.id)
    || new Set(flow.map(n => n.id)).size !== flow.length) throw Error('MONTHLY_GRAPH_INVALID');
  const get = (id, type) => { const n = flow.find(n => n.id === id); if (n?.type !== type) throw Error('MONTHLY_GRAPH_PREREQUISITE:' + id); return n; };
  const atomic = get(ids.atomic, 'function'), z = atomic.z;
  const exact = (node, expected) => { if (node.z !== z || !Object.entries(expected).every(([k,v]) => same(node[k],v))) throw Error('MONTHLY_TOPOLOGY_DRIFT:' + node.id); };
  const http = get(ids.http, 'http request');
  exact(http, { method: 'use', ret: 'obj', url: '', senderr: true, authType: '', insecureHTTPParser: false, wires: [[ids.purchase_router]] });
  const find = get(ids.find, 'mongodb4');
  for (const [key, operation] of [['find','find'],['update','updateOne'],['projection','updateOne']]) {
    exact(get(ids[key], 'mongodb4'), { clientNode: find.clientNode, collection: 'lk_tournament_subscription_sales', operation,
      output: 'toArray', handleDocId: false, wires: [[ids.atomic]] });
  }
  if (!find.clientNode) throw Error('MONTHLY_STORAGE_BINDING_MISSING');
  exact(atomic, { outputs: 5, wires: [[ids.find],[ids.update],[ids.projection],[ids.response],[ids.http]] });
  const router = get(ids.purchase_router, 'function');
  if (router.outputs !== 5 || !same(router.wires?.[0], [ids.http]) || !same(router.wires?.[4], [ids.atomic])) throw Error('MONTHLY_ROUTER_TOPOLOGY_DRIFT');
  const confirm = get(ids.confirm_resolve, 'function');
  if (confirm.outputs !== 5 || !same(confirm.wires?.[0], [ids.http]) || !same(confirm.wires?.[3], [ids.atomic]) || !same(confirm.wires?.[4], ['subscription_poll_admit_20260914'])) throw Error('MONTHLY_CONFIRM_TOPOLOGY_DRIFT');
  get(ids.response, 'http response');
  get('subscription_poll_admit_20260914', 'function');
  const changes = [];
  for (const [name, expected] of Object.entries(monthlyFriendshipPrerequisites)) {
    const node = get(ids[name], 'function');
    if (node.z !== z || hash(node.func) !== expected) throw Error('MONTHLY_SOURCE_PREIMAGE_DRIFT:' + name);
    node.func = monthlyFriendshipSource(name); new Function('msg','env','global','node',node.func);
    changes.push({ id: node.id, fields: ['func'] });
  }
  const candidateBytes = Buffer.from(JSON.stringify(flow, null, 2) + '\n');
  const contract = buildExactGraphContract({ liveBytes, candidateBytes, deploymentId, allowedChanges: changes, allowedAdditionIds: [] });
  validateReviewedFlowContract({ liveBytes, candidateBytes, contract });
  return { candidate: flow, candidateBytes, contract };
}
