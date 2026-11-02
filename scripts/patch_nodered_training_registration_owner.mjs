import fs from 'node:fs';
import crypto from 'node:crypto';
import {
  trainingRegistrationOwnerSource,
  trainingBookingPreludeSource,
  trainingSelectorSourceHash,
} from './lib/trainingRegistrationOwnerSource.mjs';
import {
  buildExactGraphContract,
  validateReviewedFlowContract,
} from './nodered_reviewed_flow_deploy/runtime_contract.mjs';
const read = (name) =>
  fs.readFileSync(
    new URL(
      './nodered_subscription_booking_nodes/fn_subscription_booking_' + name + '.js',
      import.meta.url,
    ),
    'utf8',
  );
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const trainingOwnerBaseCommit = '7abe118bd909b331650dc9bcf76e7492480493a7';
export const trainingOwnerPrerequisites = Object.freeze({
  options: '949efce458f5fbd1ba9cb6178f4db75fddc39a9f4affa21ad2268eca58d5b395',
  mongo_error: '8b5f9205f45ed110e118984360bf39679667379dc241b83e45e4bf28c9f559a3',
  prepare: '002c9752e77e4883861a99fd91517f48fd7765cfbcbb21d8dacae9fe803f2348',
  router: '60d836b6085b5d29903080b02fe918dd7760882fbbb6e9e7e248d2034fcbb405',
  finalize: '1bf14cac741c995bc36b67c05ce87b58146de2dcdd6fe6b3a7ad2a513f8120fc',
});
export const trainingOwnerRouterSource = () =>
  trainingBookingPreludeSource() + read('owner_contract_probe') + read('router');
export const trainingOwnerIds = Object.freeze(
  Object.fromEntries(
    [
      'prepareIn',
      'admitIn',
      'readIn',
      'prepareVerify',
      'admitVerify',
      'readVerify',
      'router',
      'find',
      'insert',
      'update',
      'http',
      'response',
      'catch',
    ].map((k) => [k, 'lk_training_registration_' + k + '_20261031']),
  ),
);
// Pure source composition only. This accepts one reviewed graph generation; it
// never replaces unknown installed LK1 wrappers or grants deployment authority.
export function composeTrainingRegistrationOwner(liveBytes, deploymentId) {
  const flow = JSON.parse(Buffer.from(liveBytes).toString('utf8'));
  if (
    !Array.isArray(flow) ||
    flow.some((n) => !n || typeof n.id !== 'string') ||
    new Set(flow.map((n) => n.id)).size !== flow.length
  )
    throw new Error('Invalid training graph');
  const get = (id, type) => {
    const n = flow.find((n) => n.id === id);
    if (n?.type !== type) throw new Error('Missing training prerequisite ' + id);
    return n;
  };
  const prefix = 'lk_subscription_booking_',
    suffix = '_20260804';
  const prepare = get(prefix + 'prepare' + suffix, 'function'),
    router = get(prefix + 'router' + suffix, 'function'),
    finalize = get(prefix + 'finalize' + suffix, 'function');
  const mongo = get(prefix + 'find' + suffix, 'mongodb4'),
    http = get(prefix + 'http' + suffix, 'http request');
  const options = get(prefix + 'options' + suffix, 'function');
  const mongoError = get(prefix + 'mongo_error' + suffix, 'function');
  const storeCatch = get(prefix + 'catch' + suffix, 'catch');
  const z = router.z;
  for (const [nodeId, method, next] of [
    [prefix + 'post' + suffix, 'post', prepare.id],
    ['lk_subscription_booking_owner_probe_get_20261023', 'get', options.id],
  ]) {
    const ingress = get(nodeId, 'http in');
    if (
      ingress.z !== z ||
      ingress.method !== method ||
      ingress.url !== '/lk/subscription-bookings' ||
      JSON.stringify(ingress.wires) !== JSON.stringify([[next]])
    )
      throw new Error('Training canonical ingress drift');
  }
  if (
    mongoError.z !== z ||
    mongoError.outputs !== 1 ||
    JSON.stringify(mongoError.wires) !== JSON.stringify([[finalize.id]]) ||
    storeCatch.z !== z ||
    storeCatch.uncaught !== false ||
    JSON.stringify(storeCatch.wires) !== JSON.stringify([[mongoError.id]]) ||
    !Array.isArray(storeCatch.scope) ||
    !['find', 'insert', 'update'].every((name) => storeCatch.scope.includes(prefix + name + suffix))
  ) {
    throw new Error('Training canonical persistence error topology drift');
  }
  if (
    [prepare, finalize, mongo, http, options].some((n) => n.z !== z) ||
    mongo.collection !== 'lk_subscription_daily_booking_ops' ||
    mongo.operation !== 'find' ||
    JSON.stringify(mongo.wires) !== JSON.stringify([[router.id]]) ||
    !mongo.clientNode ||
    sha(options.func) !== trainingOwnerPrerequisites.options ||
    options.outputs !== 2 ||
    prepare.outputs !== 2 ||
    JSON.stringify(options.wires?.[1]) !== JSON.stringify([router.id]) ||
    http.method !== 'use' ||
    http.ret !== 'obj' ||
    http.url !== '' ||
    http.authType !== '' ||
    JSON.stringify(http.wires) !== JSON.stringify([[router.id]]) ||
    JSON.stringify(prepare.wires) !== JSON.stringify([[http.id], [finalize.id]]) ||
    router.outputs !== 8 ||
    JSON.stringify(router.wires?.slice(0, 5)) !==
      JSON.stringify([
        [http.id],
        [mongo.id],
        [prefix + 'insert' + suffix],
        [prefix + 'update' + suffix],
        [finalize.id],
      ]) ||
    JSON.stringify(finalize.wires?.[1]) !== JSON.stringify([prefix + 'response' + suffix])
  )
    throw new Error('Training canonical topology drift');
  get(prefix + 'response' + suffix, 'http response');
  for (const [name, op] of [
    ['insert', 'insertOne'],
    ['update', 'updateOne'],
  ]) {
    const n = get(prefix + name + suffix, 'mongodb4');
    if (
      n.collection !== mongo.collection ||
      n.clientNode !== mongo.clientNode ||
      n.operation !== op ||
      n.z !== z ||
      JSON.stringify(n.wires) !== JSON.stringify([[router.id]])
    )
      throw new Error('Training store identity drift');
  }
  const routes = [
    'training-registration-preparations',
    'training-registration-admissions',
    'training-registrations/:operationId',
  ].map((x) => '/lk/integrations/v1/' + x);
  if (flow.some((n) => Object.values(trainingOwnerIds).includes(n.id) || routes.includes(n.url)))
    throw new Error('Training route collision');
  const changes = [];
  for (const [name, n] of [
    ['prepare', prepare],
    ['router', router],
    ['finalize', finalize],
    ['mongo_error', mongoError],
    ['options', options],
  ]) {
    if (sha(n.func) !== trainingOwnerPrerequisites[name])
      throw new Error('Training exact owner source drift: ' + name);
    n.func = name === 'router' ? trainingOwnerRouterSource() : read(name);
    new Function('msg', 'env', 'global', 'nodeCrypto', n.func);
    changes.push({
      id: n.id,
      fields: [
        'func',
        ...(name === 'router' ? ['libs'] : []),
        ...(['options', 'prepare'].includes(name) ? ['outputs', 'wires'] : []),
      ],
    });
    if (['options', 'prepare'].includes(name)) {
      n.outputs = 3;
      n.wires.push([name === 'options' ? prepare.id : router.id]);
    }
    if (name === 'router') {
      if ((n.libs || []).some((x) => x.var === 'nodeCrypto' && x.module !== 'crypto'))
        throw new Error('Training crypto binding conflict');
      n.libs = [
        ...(n.libs || []).filter((x) => x.var !== 'nodeCrypto'),
        { var: 'nodeCrypto', module: 'crypto' },
      ];
    }
  }
  const ids = trainingOwnerIds;
  const fn = (id, func, outputs, wires) => ({
    id,
    type: 'function',
    z,
    name: id,
    func,
    outputs,
    wires,
    libs: [{ var: 'nodeCrypto', module: 'crypto' }],
    initialize: '',
    finalize: '',
  });
  const store = (key, operation) => ({
    ...structuredClone(mongo),
    id: ids[key],
    name: ids[key],
    operation,
    wires: [[ids.router]],
  });
  flow.push(
    ...['prepare', 'admit', 'read'].flatMap((mode, i) => [
      {
        id: ids[mode + 'In'],
        type: 'http in',
        z,
        name: 'Training ' + mode,
        url: routes[i],
        method: mode === 'read' ? 'get' : 'post',
        upload: false,
        wires: [[ids[mode + 'Verify']]],
      },
      fn(ids[mode + 'Verify'], trainingRegistrationOwnerSource('verify', mode), 2, [
        [ids.router],
        [ids.response],
      ]),
    ]),
    fn(ids.router, trainingRegistrationOwnerSource('router'), 5, [
      [ids.find],
      [ids.insert],
      [ids.update],
      [ids.http],
      [ids.response],
    ]),
    store('find', 'find'),
    store('insert', 'insertOne'),
    store('update', 'updateOne'),
    {
      id: ids.http,
      type: 'http request',
      z,
      name: 'Training bounded actor read and canonical owner',
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
    {
      id: ids.response,
      type: 'http response',
      z,
      name: 'Training receipt',
      statusCode: '',
      headers: {},
      wires: [],
    },
    {
      id: ids.catch,
      type: 'catch',
      z,
      name: 'Training ambiguous store or transport',
      uncaught: false,
      scope: [ids.find, ids.insert, ids.update, ids.http],
      wires: [[ids.router]],
    },
  );
  const candidateBytes = Buffer.from(JSON.stringify(flow, null, 2) + '\n');
  const contract = buildExactGraphContract({
    liveBytes,
    candidateBytes,
    deploymentId,
    allowedChanges: changes,
    allowedAdditionIds: Object.values(ids),
  });
  validateReviewedFlowContract({ liveBytes, candidateBytes, contract });
  return {
    candidate: flow,
    candidateBytes,
    contract,
    selectorSourceSha256: trainingSelectorSourceHash,
  };
}
