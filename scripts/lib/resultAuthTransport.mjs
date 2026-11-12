import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

export const RESULT_AUTH_IDS = Object.freeze({
  tab: '4b91e2a2413688db',
  prepare: 'result_actor_auth_prepare_001',
  request: 'result_actor_auth_profile_request_001',
  resolve: 'result_actor_auth_profile_001',
  response: 'da59c50f0f6e6908',
  budget: 'result_actor_auth_request_budget_001',
  catch: 'result_actor_auth_transport_catch_001',
  failure: 'result_actor_auth_transport_error_001',
});
export const RESULT_AUTH_ROUTES = Object.freeze([
  ['get', '/lk/games/:gameId/result/state'],
  ['post', '/lk/games/:gameId/result/submit'],
  ['post', '/lk/games/:gameId/result/confirm'],
  ['post', '/lk/games/:gameId/result/dispute'],
  ['post', '/lk/games/:gameId/result/revert'],
  ['post', '/lk/games/:gameId/result/accept-correction'],
  ['post', '/lk/games/:gameId/result/expire'],
  ['post', '/lk/games/:gameId/result/session/open'],
  ['patch', '/lk/games/:gameId/result/session/:sessionId'],
]);
// Reviewed incident auth subgraph. Unrelated live changes are retained, while
// any change to these complete nodes requires a new review/preimage contract.
const NODE_PREIMAGES = Object.freeze({
  [RESULT_AUTH_IDS.prepare]: '2df43615aa2df534d901dd8cfcdba1f160b3c2d2a98f96595a7982837499d026',
  [RESULT_AUTH_IDS.request]: 'cf56be7b11dbb4b98bfbfec73213ce83b5385adec596f67bfa7fae9c63b499db',
  [RESULT_AUTH_IDS.resolve]: '7df879a59d92a6005f2ccd6bfe6ded139592e6460249de74249e0bcb8e93dbac',
  [RESULT_AUTH_IDS.response]: 'ff0584a58897bc2fe6a5638a89249561ceeaf2ea8a983adb4a6cefc96a087f71',
});
export const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const hashNode = (node) => sha256(JSON.stringify(node));
const fail = (message) => { throw new Error(message); };

export function createResultAuthTransportNodes({ tab, request, response, budgetSource, failureSource }) {
  for (const source of [budgetSource, failureSource]) {
    if (typeof source !== 'string' || !source.trim()) fail('Missing transport function source');
    new Function('msg', source);
  }
  const fn = (id, name, func, wires, x) => ({
    id, type: 'function', z: tab, name, func, outputs: 1, timeout: '', noerr: 0,
    initialize: '', finalize: '', libs: [], x, y: 3500, wires,
  });
  return [
    fn(RESULT_AUTH_IDS.budget, 'Bound result profile request', budgetSource, [[request]], 600),
    {
      id: RESULT_AUTH_IDS.catch, type: 'catch', z: tab,
      name: 'Catch result profile transport failure', scope: [request],
      uncaught: false, x: 760, y: 3440, wires: [[RESULT_AUTH_IDS.failure]],
    },
    fn(RESULT_AUTH_IDS.failure, 'Close result profile transport failure', failureSource, [[response]], 1070),
  ];
}

function assertTopology(flow) {
  if (!Array.isArray(flow)) fail('Flow must be an array');
  const ids = new Set();
  for (const n of flow) {
    if (!n?.id || ids.has(n.id)) fail('Missing or duplicate flow node ID');
    ids.add(n.id);
  }
  for (const n of flow) {
    for (const target of [...(n.wires || []).flat(), ...(n.links || []), ...(Array.isArray(n.scope) ? n.scope : [])]) {
      if (!ids.has(target)) fail('Broken flow wire/link/scope');
    }
  }
}

export function patchResultAuthTransport(input, sources) {
  assertTopology(input);
  const ids = RESULT_AUTH_IDS;
  const byId = new Map(input.map((n) => [n.id, n]));
  const tab = byId.get(ids.tab);
  if (tab?.type !== 'tab' || tab.label !== 'LK Games' || tab.disabled !== false) fail('Result auth tab drift');
  for (const [id, digest] of Object.entries(NODE_PREIMAGES)) {
    if (hashNode(byId.get(id)) !== digest) fail(`Result auth node preimage drift: ${id}`);
  }
  for (const id of [ids.budget, ids.catch, ids.failure]) {
    if (byId.has(id)) fail('Transport guard ID collision/already patched');
  }
  // An existing explicit or tab-wide Catch could double-respond or change its
  // previous handling when a scoped Catch takes precedence. Never hide it.
  for (const n of input.filter((n) => n.type === 'catch')) {
    if ((Array.isArray(n.scope) && n.scope.includes(ids.request))
      || (n.z === ids.tab && !Array.isArray(n.scope))) fail('Overlapping profile Catch requires review');
  }
  const routes = [];
  for (const [method, url] of RESULT_AUTH_ROUTES) {
    const matches = input.filter((n) => n.type === 'http in' && n.z === ids.tab && n.method === method && n.url === url);
    if (matches.length !== 1 || matches[0].d || !isDeepStrictEqual(matches[0].wires, [[ids.prepare]])) fail('Result auth route drift');
    routes.push(matches[0].id);
  }
  const incoming = (id) => input.filter((n) => (n.wires || []).flat().includes(id)).map((n) => n.id).sort();
  if (!isDeepStrictEqual(incoming(ids.prepare), routes.sort())
    || !isDeepStrictEqual(incoming(ids.request), [ids.prepare])) fail('Unexpected auth predecessor');
  const flow = structuredClone(input);
  flow.find((n) => n.id === ids.prepare).wires[0] = [ids.budget];
  flow.push(...createResultAuthTransportNodes({ ...ids, ...sources }));
  assertTopology(flow);
  for (const n of flow.slice(0, input.length)) {
    const expected = structuredClone(byId.get(n.id));
    if (n.id === ids.prepare) expected.wires[0] = [ids.budget];
    if (!isDeepStrictEqual(n, expected)) fail('Unrelated candidate node change');
  }
  return flow;
}
