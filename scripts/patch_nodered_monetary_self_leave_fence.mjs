import fs from 'node:fs';
import crypto from 'node:crypto';
import { isDeepStrictEqual as equal } from 'node:util';
import {
  buildExactGraphContract,
  validateReviewedFlowContract,
} from './nodered_reviewed_flow_deploy/runtime_contract.mjs';
const hash = (x) => crypto.createHash('sha256').update(x).digest('hex');
// Exact #270 source custody; never a production preimage or activation permission.
export const stages = [
  {
    name: 'operation_start',
    id: 'lk_split_leave_operation_start_build_20260801',
    before: 'd9d3ed6fff1bbb9cc1f2da9e0d69e6dead3f5a0521437e12de2a45dd21c80379',
  },
  {
    name: 'operation_route',
    id: 'lk_split_leave_operation_route_20260801',
    before: '0c9b86c7d604b5de8a4b5950c5fcf3a08ed2aa9510a3e927f1da90f480656d25',
  },
  {
    name: 'operation_claim',
    id: 'lk_split_leave_operation_claim_build_20260801',
    before: 'bb798ff9488b8879893fb204dfdff48e4747be14d71ab41a4bf24bdd0ca38a34',
  },
  {
    name: 'operation_claim_ack',
    id: 'lk_split_leave_operation_claim_ack_20260801',
    before: 'b2d6ac10f23da4d421d788e65d2139f256dd5769dfd13809441995146969a2a2',
  },
  {
    name: 'operation_viva_confirmed',
    id: 'lk_split_leave_operation_viva_build_20260801',
    before: '13334154370b0fd1934d0b4943c3e90446c7700ee2ac8f42f393e9ca8718a8cd',
  },
  {
    name: 'router',
    id: '9878400d518ebcbd',
    before: '9db07d0a7e10d8040e4b63c364356192a4d6fb08adf55f90beca470d931a4dd2',
  },
];
export const gates = [
  {
    name: 'find',
    before: '17bb2f134e2da5262d70aec6236ce2e2a3ad2640a7f59b12114a3e62065261a5',
  },
  {
    name: 'build',
    before: '4e294ab209e10c3beb8ddb5657b195a9992cce2dcbe6ca61c2bbedee79cb5648',
  },
  {
    name: 'ack',
    before: 'a19e4759024d715f58b3adbe227ccabd6496405efe3066f322d8bcb9adbe31b9',
  },
];
const prefix = 'organizer_handoff_20260913_provider';
export function composeMonetarySelfLeaveFence(liveBytes, deploymentId) {
  const flow = JSON.parse(Buffer.from(liveBytes).toString('utf8'));
  if (
    !Array.isArray(flow) ||
    flow.some((n) => !n || typeof n.id !== 'string') ||
    new Set(flow.map((n) => n.id)).size !== flow.length
  )
    throw Error('Invalid monetary SELF graph');
  const get = (id, type) => {
    const n = flow.find((n) => n.id === id);
    if (!n || n.type !== type) throw Error('Missing node ' + id);
    return n;
  };
  const edge = (id, port, targets) => {
    if (!equal(flow.find((n) => n.id === id)?.wires?.[port], targets))
      throw Error('Unsafe edge ' + id);
  };
  const router = get(stages[5].id, 'function');
  const claim = stages[2].id,
    ack = stages[3].id;
  const mongo = get('lk_split_leave_operation_claim_update_20260801', 'mongodb4');
  const startMongo = get('lk_split_leave_operation_start_update_20260801', 'mongodb4');
  const http = get('52af61191cdbe9ef', 'http request');
  if (
    router.outputs !== 7 ||
    http.method !== 'use' ||
    http.url !== '' ||
    http.authType ||
    http.ret !== 'obj' ||
    http.tls ||
    http.proxy ||
    http.headers?.length ||
    Object.keys(http.credentials || {}).length
  )
    throw Error('Unsafe HTTP configuration');
  // No injected auth/digest retry, URL override, redirects via dynamic header, or fanout.
  get(mongo.clientNode, 'mongodb4-client');
  edge(router.id, 3, [stages[4].id]);
  edge(router.id, 4, [stages[0].id]);
  edge(stages[0].id, 0, [startMongo.id]);
  edge(router.id, 0, [http.id]);
  edge(http.id, 0, [router.id]);
  edge(claim, 0, [mongo.id]);
  edge(mongo.id, 0, [ack]);
  edge(ack, 0, [prefix]);
  edge(stages[1].id, 0, [prefix]);
  edge(stages[1].id, 3, [claim]);
  edge(prefix, 0, [prefix + '_find']);
  edge(prefix, 1, [router.id]);
  edge(prefix + '_find', 0, [prefix + '_build']);
  edge(prefix + '_build', 0, [prefix + '_update']);
  edge(prefix + '_build', 1, ['35f7c89069fc393a']);
  edge(prefix + '_build', 2, [router.id]);
  edge(prefix + '_update', 0, [prefix + '_ack']);
  edge(prefix + '_ack', 0, [router.id]);
  edge(prefix + '_ack', 1, ['35f7c89069fc393a']);
  for (const n of [mongo, startMongo])
    if (
      n.collection !== 'lk_game_leave_operations' ||
      n.operation !== 'updateOne' ||
      !n.clientNode ||
      n.clientNode !== mongo.clientNode
    )
      throw Error('Wrong operation store');
  for (const [id, operation] of [
    [prefix + '_find', 'find'],
    [prefix + '_update', 'updateOne'],
  ]) {
    const n = get(id, 'mongodb4');
    if (
      n.collection !== 'lk_games' ||
      n.operation !== operation ||
      n.clientNode !== mongo.clientNode
    )
      throw Error('Wrong membership store');
  }
  for (const g of gates) {
    const id = g.name === 'find' ? prefix : prefix + '_' + g.name;
    if (hash(get(id, 'function').func) !== g.before) throw Error('Membership gate drift');
  }
  const authorize = get('7c280001a0c1e015', 'function');
  const retryHydrate = get('lk_split_leave_retry_hydrate_20260801', 'function');
  if (
    hash(authorize.func) !== '442577a39521fc733dc0591086b24fd3e886e816cf40934fe8be5d4753ec4c1b' ||
    hash(retryHydrate.func) !==
      'f19c46440124ec92f65b53b12143f84b7c6f0d95ba6bbdd82890b9b63b818f20' ||
    authorize.z !== router.z ||
    retryHydrate.z !== router.z
  )
    throw Error('Dispatch ingress source drift');
  const incoming = new Map([
    [
      router.id,
      [
        [http.id, 0],
        [authorize.id, 3],
        [claim, 2],
        [prefix, 1],
        [prefix + '_build', 2],
        [prefix + '_ack', 0],
      ],
    ],
    [
      claim,
      [
        [stages[1].id, 3],
        [stages[1].id, 5],
      ],
    ],
    [mongo.id, [[claim, 0]]],
    [ack, [[mongo.id, 0]]],
    [http.id, [[router.id, 0]]],
    [
      prefix,
      [
        [stages[1].id, 0],
        [ack, 0],
        [retryHydrate.id, 1],
      ],
    ],
    [prefix + '_find', [[prefix, 0]]],
    [prefix + '_build', [[prefix + '_find', 0]]],
    [prefix + '_update', [[prefix + '_build', 0]]],
    [prefix + '_ack', [[prefix + '_update', 0]]],
  ]);
  // A full-flow hash alone does not authorize a second producer of a successful ACK.
  // Every incoming edge of the dispatch path must be the exact known producer/port.
  for (const [target, expected] of incoming) {
    const actual = flow.flatMap((n) =>
      (n.wires || []).flatMap((ports, port) =>
        ports.filter((id) => id === target).map(() => [n.id, port]),
      ),
    );
    const ordered = (pairs) => pairs.map((pair) => JSON.stringify(pair)).sort();
    if (!equal(ordered(actual), ordered(expected)))
      throw Error('Unauthorized dispatch incoming edge: ' + target);
  }
  const protectedIds = new Set([...incoming.keys(), stages[1].id, authorize.id, retryHydrate.id]);
  const byId = new Map(flow.map((n) => [n.id, n]));
  const reachesProtected = (start, seen = new Set()) => {
    if (protectedIds.has(start)) return true;
    if (seen.has(start)) return false;
    seen.add(start);
    const node = byId.get(start);
    return Boolean(
      node &&
      [...(node.wires || []).flat(), ...(Array.isArray(node.links) ? node.links : [])].some((id) =>
        reachesProtected(id, seen),
      ),
    );
  };
  for (const node of flow) {
    if (['complete', 'catch'].includes(node.type)) {
      if (
        !Array.isArray(node.scope) ||
        !node.scope.length ||
        node.scope.some((id) => !byId.has(id) || protectedIds.has(id)) ||
        (node.wires || []).flat().some((id) => reachesProtected(id))
      )
        throw Error('Unsafe dispatch observer');
    }
    if (['link in', 'link out', 'link call'].includes(node.type)) {
      if (
        !Array.isArray(node.links) ||
        !node.links.length ||
        node.linkType === 'dynamic' ||
        node.links.some(
          (id) =>
            !byId.has(id) || !['link in', 'link out', 'link call'].includes(byId.get(id).type),
        ) ||
        reachesProtected(node.id)
      )
        throw Error('Unsafe dispatch link');
    }
  }
  for (const n of flow) {
    if (
      n.z &&
      [
        router.id,
        claim,
        ack,
        http.id,
        mongo.id,
        startMongo.id,
        prefix,
        prefix + '_find',
        prefix + '_build',
        prefix + '_update',
        prefix + '_ack',
      ].includes(n.id) &&
      n.z !== router.z
    )
      throw Error('Cross-tab graph');
    if (n.type === 'function' && n.wires && n.outputs !== n.wires.length)
      throw Error('Output mismatch');
    for (const target of (n.wires || []).flat())
      if (!flow.some((x) => x.id === target)) throw Error('Dangling edge');
  }
  const changes = [];
  for (const s of stages) {
    const n = get(s.id, 'function');
    if (
      hash(n.func) !== s.before ||
      n.z !== router.z ||
      n.outputs !==
        {
          operation_start: 3,
          operation_route: 6,
          operation_claim: 3,
          operation_claim_ack: 3,
          operation_viva_confirmed: 2,
          router: 7,
        }[s.name]
    )
      throw Error('Source drift ' + s.name);
    n.func = fs.readFileSync(
      new URL('./nodered_games_nodes/fn_split_leave_' + s.name + '.js', import.meta.url),
      'utf8',
    );
    new Function('msg', 'global', 'flow', n.func);
    changes.push({
      id: n.id,
      fields: s.name === 'router' ? ['func', 'outputs', 'wires'] : ['func'],
    });
  }
  router.outputs = 8;
  router.wires.push([claim]);
  const candidateBytes = Buffer.from(JSON.stringify(flow, null, 2) + '\n');
  const contract = buildExactGraphContract({
    liveBytes,
    candidateBytes,
    deploymentId,
    allowedChanges: changes,
    allowedAdditionIds: [],
  });
  validateReviewedFlowContract({ liveBytes, candidateBytes, contract });
  return { candidate: flow, candidateBytes, contract };
}
