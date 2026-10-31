import {
  gameCreatePreparationSource,
  gameCreateSelectorSha256,
} from './lib/gameCreatePreparationSource.mjs';
import {
  buildExactGraphContract,
  validateReviewedFlowContract,
} from './nodered_reviewed_flow_deploy/runtime_contract.mjs';
export const gameCreatePreparationIds = Object.freeze(
  Object.fromEntries(
    ['tab', 'in', 'verify', 'router', 'http', 'sanitize', 'response', 'catch'].map((k) => [
      k,
      'lk_game_create_preparation_' + k + '_20261031',
    ]),
  ),
);
// Pure additive candidate construction. Never installs, enables flags or changes existing owner wires.
export function composeGameCreatePreparation(liveBytes, deploymentId) {
  const flow = JSON.parse(Buffer.from(liveBytes).toString('utf8')),
    ids = gameCreatePreparationIds;
  if (
    !Array.isArray(flow) ||
    flow.some((n) => !n || typeof n.id !== 'string' || !n.id) ||
    new Set(flow.map((n) => n.id)).size !== flow.length
  )
    throw new Error('CREATE_GRAPH_INVALID');
  if (
    flow.some(
      (n) =>
        Object.values(ids).includes(n.id) ||
        n.url === '/lk/integrations/v1/game-create-preparations',
    )
  )
    throw new Error('CREATE_ROUTE_COLLISION');
  // A formerly dangling edge must not become an unauthenticated route into new nodes.
  const reserved = new Set(Object.values(ids));
  if (
    flow.some(
      (n) =>
        reserved.has(n.z) ||
        [n.wires, n.links, n.scope].some(
          (value) => Array.isArray(value) && value.flat().some((id) => reserved.has(id)),
        ),
    )
  )
    throw new Error('CREATE_FOREIGN_EDGE_COLLISION');
  const fn = (id, name, outputs, wires) => ({
    id,
    type: 'function',
    z: ids.tab,
    name: 'CREATE preparation ' + name,
    func: gameCreatePreparationSource(name),
    outputs,
    wires,
    libs: [{ var: 'nodeCrypto', module: 'crypto' }],
    initialize: '',
    finalize: '',
  });
  const additions = [
    {
      id: ids.tab,
      type: 'tab',
      label: 'CREATE fixed-quarter preparation (nonbinding)',
      disabled: false,
      info: 'Private authenticated GET-only provider observation; no reservation or booking authority.',
    },
    {
      id: ids.in,
      type: 'http in',
      z: ids.tab,
      name: 'Private CREATE preparation',
      url: '/lk/integrations/v1/game-create-preparations',
      method: 'post',
      upload: false,
      wires: [[ids.verify]],
    },
    fn(ids.verify, 'verify', 2, [[ids.router], [ids.sanitize]]),
    fn(ids.router, 'router', 2, [[ids.http], [ids.sanitize]]),
    {
      id: ids.http,
      type: 'http request',
      z: ids.tab,
      name: 'CREATE exact bounded reads',
      method: 'use',
      ret: 'obj',
      url: '',
      paytoqs: 'ignore',
      requestTimeout: '10000',
      senderr: true,
      persist: false,
      authType: '',
      insecureHTTPParser: false,
      wires: [[ids.router]],
    },
    fn(ids.sanitize, 'response', 1, [[ids.response]]),
    {
      id: ids.response,
      type: 'http response',
      z: ids.tab,
      name: 'Nonbinding preparation',
      statusCode: '',
      headers: {},
      wires: [],
    },
    {
      id: ids.catch,
      type: 'catch',
      z: ids.tab,
      name: 'CREATE transport refusal',
      uncaught: false,
      scope: [ids.http],
      wires: [[ids.router]],
    },
  ];
  for (const n of additions.filter((n) => n.type === 'function'))
    new Function('msg', 'env', 'global', 'nodeCrypto', n.func);
  const candidate = [...flow, ...additions],
    candidateBytes = Buffer.from(JSON.stringify(candidate, null, 2) + '\n');
  const contract = buildExactGraphContract({
    liveBytes,
    candidateBytes,
    deploymentId,
    allowedChanges: [],
    allowedAdditionIds: Object.values(ids),
  });
  validateReviewedFlowContract({ liveBytes, candidateBytes, contract });
  return { candidate, candidateBytes, contract, selectorRevision: gameCreateSelectorSha256 };
}
