import fs from 'node:fs';
import { gameCreateServiceTable } from './lib/gameCreatePreparationSource.mjs';
import { parseVivaTimestamp } from './lib/vivaHistoricalEvidence.mjs';
import {
  buildExactGraphContract,
  validateReviewedFlowContract,
} from './nodered_reviewed_flow_deploy/runtime_contract.mjs';

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const prefix = '/lk/integrations/v1/whole-court-checkout';
const collection = 'lk_whole_court_checkout_ops';
const storeAnchorId = 'lk_subscription_booking_find_20260804';
const ids = Object.fromEntries(
  [
    'tab',
    'reserve',
    'confirm',
    'verify',
    'router',
    'http',
    'find',
    'update',
    'catch',
    'response',
  ].map((key) => [key, 'lk_whole_court_checkout_' + key + '_20261122']),
);
const libs = [
  { var: 'nodeCrypto', module: 'crypto' },
  { var: 'nodeUrl', module: 'url' },
];

export function wholeCourtCheckoutSource(name) {
  if (!['verify', 'router'].includes(name)) throw new Error('WHOLE_COURT_NODE_UNKNOWN');
  return [
    read('./nodered_booked_operation_receiver_nodes/_booked_operation_delegation_prelude.js'),
    read('./nodered_game_create_preparation_nodes/_game_create_preparation_contract.js'),
    'const lk1CourtMasterServices = ' + JSON.stringify(gameCreateServiceTable) + ';',
    parseVivaTimestamp.toString(),
    read('./nodered_whole_court_checkout_nodes/contract.js'),
    read('./nodered_whole_court_checkout_nodes/' + name + '.js'),
  ].join('\n');
}

export function composeWholeCourtCheckout(liveBytes, deploymentId) {
  const source = JSON.parse(Buffer.from(liveBytes).toString('utf8'));
  const reserved = new Set(Object.values(ids));
  if (
    !Array.isArray(source) ||
    source.some(
      (node) =>
        !node ||
        typeof node.id !== 'string' ||
        !node.id ||
        reserved.has(node.id) ||
        reserved.has(node.z),
    ) ||
    new Set(source.map((node) => node.id)).size !== source.length
  )
    throw new Error('WHOLE_COURT_GRAPH_IDENTITY_INVALID');

  const routes = [prefix + '/reserve', prefix + '/confirm'];
  const overlaps = (url) => {
    const path = url.split(/[(:*?]/, 1)[0].replace(/\/+$/, '');
    return routes.some(
      (route) =>
        route === path ||
        route.startsWith(path + '/') ||
        path.startsWith(prefix + '/') ||
        path === prefix,
    );
  };
  if (
    source.some(
      (node) =>
        (node.type === 'http in' &&
          typeof node.url === 'string' &&
          (node.method === 'post' || node.method === 'all') &&
          overlaps(node.url)) ||
        node.collection === collection ||
        [node.wires, node.scope, node.links].some(
          (value) => Array.isArray(value) && value.flat().some((id) => reserved.has(id)),
        ),
    )
  )
    throw new Error('WHOLE_COURT_GRAPH_OVERLAP');

  const anchor = source.find((node) => node.id === storeAnchorId);
  if (
    anchor?.type !== 'mongodb4' ||
    anchor.collection !== 'lk_subscription_daily_booking_ops' ||
    anchor.operation !== 'find' ||
    !source.some((node) => node.id === anchor.clientNode && node.type === 'mongodb4-client')
  )
    throw new Error('WHOLE_COURT_STORE_ANCHOR_MISSING');

  const node = (key, type, properties) => ({
    id: ids[key],
    z: ids.tab,
    type,
    name: 'LK1 whole-court checkout ' + key,
    ...properties,
  });
  const fn = (key, targets) => {
    const func = wholeCourtCheckoutSource(key);
    new Function('msg', 'env', 'global', 'nodeCrypto', 'nodeUrl', func);
    return node(key, 'function', {
      func,
      initialize: '',
      finalize: '',
      libs,
      outputs: targets.length,
      wires: targets.map((target) => [ids[target]]),
    });
  };
  const mongo = (key, operation) =>
    node(key, 'mongodb4', {
      clientNode: anchor.clientNode,
      collection,
      mode: 'collection',
      operation,
      handleDocId: false,
      output: 'toArray',
      maxTimeMS: '5000',
      wires: [[ids.router]],
    });
  const added = [
    { id: ids.tab, type: 'tab', label: 'LK1 private whole-court checkout' },
    ...['reserve', 'confirm'].map((key, index) =>
      node(key, 'http in', {
        method: 'post',
        url: routes[index],
        upload: false,
        wires: [[ids.verify]],
      }),
    ),
    fn('verify', ['router', 'response']),
    fn('router', ['find', 'update', 'http', 'response']),
    mongo('find', 'find'),
    mongo('update', 'updateOne'),
    node('http', 'http request', {
      method: 'use',
      url: '',
      ret: 'obj',
      paytoqs: 'ignore',
      persist: false,
      authType: '',
      requestTimeout: '10000',
      insecureHTTPParser: false,
      senderr: true,
      wires: [[ids.router]],
    }),
    node('catch', 'catch', {
      scope: [ids.find, ids.update, ids.http],
      uncaught: false,
      wires: [[ids.router]],
    }),
    node('response', 'http response', { headers: {}, statusCode: '', wires: [] }),
  ];
  const candidate = [...source, ...added];
  const candidateBytes = Buffer.from(JSON.stringify(candidate, null, 2) + '\n');
  const contract = buildExactGraphContract({
    liveBytes,
    candidateBytes,
    deploymentId,
    allowedChanges: [],
    allowedAdditionIds: added.map((entry) => entry.id),
  });
  validateReviewedFlowContract({ liveBytes, candidateBytes, contract });
  return { candidate, candidateBytes, contract };
}
