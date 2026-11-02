import fs from 'node:fs';
import crypto from 'node:crypto';
import { gameCreateOwnerSource, quarterCreateGatewaySource, quarterCreateSplitSource } from './lib/gameCreateOwnerSource.mjs';
import { buildExactGraphContract, validateReviewedFlowContract } from './nodered_reviewed_flow_deploy/runtime_contract.mjs';
export const gameCreateOwnerBaseCommit = '62e32f7b963f8ab04d7a7eabcde37a66a51b77f9';
export const gameCreateOwnerPrerequisites = Object.freeze({
  prepare: 'a768ffb571d08bf5a1f2982d904a4d500ed9ee1779147e07ec2b7984d2876fc4',
  finalize: '09b9f823ea4890472875089c72d80b254f7a4e1910c935cacaf8b1e260faeead',
  mongo_error: '1d15fec3c9974e079867ad5d6fa512c5d767cc173bccd4fda25d0435a656e36d',
  options: '32c664ca2301b096ce807bc27f8a2e4ea70127530fee2e7e2c4bb0edab21369f',
  router: 'c98d2cfacf4d54296e1ed4b2d64a58d486895cba543eaf36e3a2e6963310e952',
  split_create_prepare: '258c865544f4150ece7e0fc47af455cb97ff2288d81a382841985777604178ef',
  split_router: '70833cc326bc19246f8e0e4ecad28917ab274838c89911994211f5b8d7db58e8',
});
export const gameCreateOwnerIds = Object.freeze(Object.fromEntries([
  'admitIn', 'readIn', 'verify', 'router', 'find', 'update', 'http', 'observe', 'observeHttp',
  'sanitize', 'response', 'catch', 'observeCatch', 'bridge', 'canonicalReturn', 'splitReturn',
].map(k => [k, 'lk_game_create_owner_' + k + '_20261101'])));
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const read = n => fs.readFileSync(new URL('./nodered_subscription_booking_nodes/fn_subscription_booking_' + n + '.js', import.meta.url), 'utf8');
// Source-only, exact reviewed preimage. Does not install/import or change runtime configuration.
export function composeGameCreateOwner(liveBytes, deploymentId) {
  const flow = JSON.parse(Buffer.from(liveBytes).toString('utf8')), ids = gameCreateOwnerIds;
  if (!Array.isArray(flow) || flow.some(n => !n || typeof n.id !== 'string' || !n.id)
    || new Set(flow.map(n => n.id)).size !== flow.length) throw Error('CREATE_OWNER_GRAPH_INVALID');
  const get = (id, type) => { const n = flow.find(n => n.id === id); if (n?.type !== type) throw Error('CREATE_OWNER_PREREQUISITE:' + id); return n; };
  const id = n => 'lk_subscription_booking_' + n + '_20260804';
  const router = get(id('router'), 'function'), prepare = get(id('prepare'), 'function'),
    finalize = get(id('finalize'), 'function'), error = get(id('mongo_error'), 'function'),
    options = get(id('options'), 'function'), find = get(id('find'), 'mongodb4'),
    http = get(id('http'), 'http request'), split = get('8f7bd5b482fe9763', 'function'),
    splitPrepare = get('f3f9a60354d394da', 'function'), splitHttp = get('ee7ba8cdd68bdf74', 'http request');
  const z = router.z;
  const same = nodes => nodes.every(n => n.z === z);
  const httpOkay = (n, next) => n.method === 'use' && n.ret === 'obj' && n.url === '' && n.authType === ''
    && equal(n.wires, [[next]]) && n.senderr === true && n.insecureHTTPParser === false;
  const canonicalResponse = get(id('response'), 'http response');
  const splitResponseId = split.wires?.[1]?.length === 1 ? split.wires[1][0] : null;
  const splitResponse = get(splitResponseId, 'http response');
  const storeCatch = get(id('catch'), 'catch');
  if (!same([prepare, finalize, error, options, find, http, split, splitPrepare, splitHttp, canonicalResponse, splitResponse, storeCatch])
    || !find.clientNode || find.collection !== 'lk_subscription_daily_booking_ops' || find.operation !== 'find'
    || !equal(find.wires, [[router.id]]) || !httpOkay(http, router.id) || !httpOkay(splitHttp, split.id)
    || prepare.outputs !== 3 || !equal(prepare.wires, [[http.id], [finalize.id], [router.id]])
    || router.outputs !== 8 || !equal(router.wires?.slice(0, 5), [[http.id], [find.id], [id('insert')], [id('update')], [finalize.id]])
    || finalize.outputs !== 2 || !equal(finalize.wires, [[split.id], [canonicalResponse.id]])
    || error.outputs !== 1 || !equal(error.wires, [[finalize.id]])
    || storeCatch.uncaught !== false || !equal(storeCatch.wires, [[error.id]])
    || !['find', 'insert', 'update'].every(k => storeCatch.scope?.includes(id(k)))
    || options.outputs !== 3 || !equal(options.wires?.slice(1), [[router.id], [prepare.id]])
    || split.outputs !== 5 || !equal(split.wires[0], [splitHttp.id]) || !equal(split.wires[3], [http.id])
    || splitPrepare.outputs !== 4 || !equal(splitPrepare.wires, [[splitHttp.id], [splitResponse.id], splitPrepare.wires[2], [split.id]])) {
    throw Error('CREATE_OWNER_TOPOLOGY_DRIFT');
  }
  for (const [name, op] of [['insert', 'insertOne'], ['update', 'updateOne']]) {
    const n = get(id(name), 'mongodb4');
    if (!same([n]) || n.clientNode !== find.clientNode || n.collection !== find.collection
      || n.operation !== op || !equal(n.wires, [[router.id]])) throw Error('CREATE_OWNER_STORE_DRIFT');
  }
  for (const [nodeId, method, next] of [[id('post'), 'post', prepare.id], ['lk_subscription_booking_owner_probe_get_20261023', 'get', options.id]]) {
    const n = get(nodeId, 'http in');
    if (!same([n]) || n.method !== method || n.url !== '/lk/subscription-bookings' || !equal(n.wires, [[next]])) throw Error('CREATE_OWNER_INGRESS_DRIFT');
  }
  const changed = [['prepare', prepare, read('prepare')], ['router', router, quarterCreateGatewaySource()],
    ['finalize', finalize, read('finalize')], ['mongo_error', error, read('mongo_error')],
    ['split_create_prepare', splitPrepare, quarterCreateSplitSource('create_prepare')], ['split_router', split, quarterCreateSplitSource('router')]];
  if (sha(options.func) !== gameCreateOwnerPrerequisites.options) throw Error('CREATE_OWNER_OPTIONS_SOURCE_DRIFT');
  for (const [name, n] of changed) if (sha(n.func) !== gameCreateOwnerPrerequisites[name]) throw Error('CREATE_OWNER_SOURCE_DRIFT:' + name);
  const routes = ['/lk/integrations/v1/game-create-operations/admissions', '/lk/integrations/v1/game-create-operations/:operationId/read'];
  const reserved = new Set(Object.values(ids));
  if (flow.some(n => reserved.has(n.id) || reserved.has(n.z) || routes.includes(n.url)
    || [n.wires, n.links, n.scope].some(v => Array.isArray(v) && v.flat().some(x => reserved.has(x))))) throw Error('CREATE_OWNER_ROUTE_COLLISION');
  const allowedChanges = [];
  for (const [name, n, source] of changed) {
    if ((n.libs || []).some(x => x.var === 'nodeCrypto' && x.module !== 'crypto')) throw Error('CREATE_OWNER_CRYPTO_CONFLICT');
    n.func = source; n.libs = [...(n.libs || []).filter(x => x.var !== 'nodeCrypto'), { var: 'nodeCrypto', module: 'crypto' }];
    allowedChanges.push({ id: n.id, fields: ['func', 'libs', ...(['finalize', 'split_create_prepare', 'split_router'].includes(name) ? ['wires'] : [])] });
  }
  finalize.wires[1] = [ids.canonicalReturn]; split.wires[1] = [ids.splitReturn]; split.wires[3] = [ids.bridge]; splitPrepare.wires[1] = [ids.splitReturn];
  const fn = (key, source, outputs, wires) => ({ id: ids[key], type: 'function', z, name: 'Quarter CREATE ' + key,
    func: source, outputs, wires, libs: [{ var: 'nodeCrypto', module: 'crypto' }], initialize: '', finalize: '' });
  const httpNode = (key, next) => ({ id: ids[key], type: 'http request', z, name: 'Quarter CREATE bounded transport',
    method: 'use', ret: 'obj', url: '', paytoqs: 'ignore', requestTimeout: '10000', senderr: true, persist: false,
    authType: '', insecureHTTPParser: false, wires: [[ids[next]]] });
  const returnSource = 'return msg._gameCreateOwner || msg._quarterCreateCapability ? [msg,null] : [null,msg];';
  flow.push(
    ...routes.map((url, i) => ({ id: ids[i ? 'readIn' : 'admitIn'], type: 'http in', z, name: 'Private quarter CREATE', url, method: 'post', upload: false, wires: [[ids.verify]] })),
    fn('verify', gameCreateOwnerSource('verify'), 2, [[ids.router], [ids.sanitize]]),
    fn('router', gameCreateOwnerSource('router'), 6, [[ids.find], [ids.update], [ids.http], [ids.observe], [splitPrepare.id], [ids.sanitize]]),
    ...[['find', 'find'], ['update', 'updateOne']].map(([key, operation]) => ({ ...structuredClone(find), id: ids[key], name: ids[key], operation, wires: [[ids.router]] })),
    httpNode('http', 'router'), httpNode('observeHttp', 'observe'),
    fn('observe', gameCreateOwnerSource('observe'), 2, [[ids.observeHttp], [ids.router]]),
    fn('bridge', gameCreateOwnerSource('bridge'), 3, [[http.id], [router.id], [prepare.id]]),
    fn('canonicalReturn', returnSource, 2, [[ids.router], [canonicalResponse.id]]),
    fn('splitReturn', returnSource, 2, [[ids.router], [splitResponse.id]]),
    fn('sanitize', gameCreateOwnerSource('response'), 1, [[ids.response]]),
    { id: ids.response, type: 'http response', z, name: 'Quarter CREATE private receipt', statusCode: '', headers: {}, wires: [] },
    { id: ids.catch, type: 'catch', z, name: 'Quarter CREATE storage/transport uncertainty', uncaught: false, scope: [ids.find, ids.update, ids.http], wires: [[ids.router]] },
    { id: ids.observeCatch, type: 'catch', z, name: 'Quarter CREATE observation uncertainty', uncaught: false, scope: [ids.observeHttp], wires: [[ids.observe]] },
  );
  for (const n of flow.filter(n => n.type === 'function' && (reserved.has(n.id) || changed.some(x => x[1].id === n.id)))) new Function('msg', 'env', 'global', 'nodeCrypto', n.func);
  const candidateBytes = Buffer.from(JSON.stringify(flow, null, 2) + '\n');
  const contract = buildExactGraphContract({ liveBytes, candidateBytes, deploymentId, allowedChanges, allowedAdditionIds: Object.values(ids) });
  validateReviewedFlowContract({ liveBytes, candidateBytes, contract });
  return { candidate: flow, candidateBytes, contract };
}
