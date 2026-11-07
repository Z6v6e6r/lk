import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  composeJoinV2Live,
  JOIN_V2_ADDITION_IDS,
  JOIN_V2_RECEIVER_BASE_COMMIT,
  JOIN_V2_RECEIVER_LIVE_FUNC_SHA256,
  OWNER_ROUTER_ID,
  OWNER_PREPARE_ID,
  OWNER_V2_GUARDS,
  PROBE_INSTALLED,
  PROBE_JOIN_V2,
} from '../prepare_booked_operation_join_v2_live.mjs';
import { buildReceiverNodes, receiverFunctionSource, NODE_IDS, TAB_ID, COLLECTION, ROUTES }
  from '../patch_nodered_booked_operation_receiver_flow.mjs';
import { validateReviewedFlowContract } from '../nodered_reviewed_flow_deploy/runtime_contract.mjs';
import * as H from './helpers/ownerLiveRebaseCharacterization.mjs';

const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const CLIENT = 'mongo_client_synthetic';
const bytesOf = (flow) => Buffer.from(JSON.stringify(flow, null, 2) + '\n');

// Synthetic installed graph: owner router with the A1 probe text, one Mongo client, and the old
// receiver tab (main node set minus the v2 additions, with stand-in old function sources).
function syntheticInstalled() {
  const old = buildReceiverNodes({ mongoClientNodeId: CLIENT })
    .filter((n) => !JOIN_V2_ADDITION_IDS.includes(n.id))
    .map((n) => {
      const copy = structuredClone(n);
      if (copy.id in JOIN_V2_RECEIVER_LIVE_FUNC_SHA256) copy.func = 'return [null, msg]; // old ' + copy.id;
      if (copy.id === NODE_IDS.router) copy.libs = [];
      if (copy.id === NODE_IDS.catch) copy.scope = copy.scope.filter((id) => !JOIN_V2_ADDITION_IDS.includes(id));
      return copy;
    });
  return [
    { id: 'owner_tab', type: 'tab', label: 'Owner' },
    { id: CLIENT, type: 'mongodb4-client', name: 'synthetic' },
    { id: OWNER_ROUTER_ID, type: 'function', z: 'owner_tab', outputs: 1, wires: [[]],
      func: 'const ownerProbeVersion = "1";\nconst ok = ' + PROBE_INSTALLED + ';\n/*\n'
        + OWNER_V2_GUARDS[OWNER_ROUTER_ID].join('\n') + '\n*/\nreturn ok ? msg : null;' },
    { id: OWNER_PREPARE_ID, type: 'function', z: 'owner_tab', outputs: 1, wires: [[]],
      func: '/*\n' + OWNER_V2_GUARDS[OWNER_PREPARE_ID].join('\n') + '\n*/\nreturn msg;' },
    { id: 'owner_find', type: 'mongodb4', z: 'owner_tab', collection: COLLECTION, operation: 'find', clientNode: CLIENT, wires: [[]] },
    { id: TAB_ID, type: 'tab', label: 'LK Booked Operation Receiver', disabled: false, info: '' },
    ...old,
  ];
}
const pinsFor = (flow) => ({
  sourceSha256: sha(bytesOf(flow)),
  receiverFuncSha256: Object.fromEntries(Object.keys(JOIN_V2_RECEIVER_LIVE_FUNC_SHA256)
    .map((id) => [id, sha(flow.find((n) => n.id === id).func)])),
  ownerRouterFuncSha256: sha(flow.find((n) => n.id === OWNER_ROUTER_ID).func),
  mongoClientId: CLIENT,
});
const compose = (flow, pins = pinsFor(flow)) => composeJoinV2Live(bytesOf(flow), 'synthetic-join-v2', pins);

test('synthetic installed receiver upgrades to the main receiver with exactly the reviewed fields', () => {
  const flow = syntheticInstalled();
  const r = compose(flow);
  assert.deepEqual(r.candidate.slice(flow.length).map((n) => n.id), JOIN_V2_ADDITION_IDS);
  assert.deepEqual(r.allowedChanges.map((c) => c.id + ':' + c.fields.join('+')), [
    NODE_IDS.admissionVerify + ':func', NODE_IDS.readVerify + ':func', NODE_IDS.router + ':func+libs',
    NODE_IDS.executor + ':func', NODE_IDS.respond + ':func', NODE_IDS.catch + ':scope', OWNER_ROUTER_ID + ':func',
  ]);
  for (const [id, name] of [[NODE_IDS.admissionVerify, 'admission_verify'], [NODE_IDS.readVerify, 'read_verify'],
    [NODE_IDS.router, 'router'], [NODE_IDS.executor, 'executor'], [NODE_IDS.respond, 'response'],
    [NODE_IDS.preflightVerify, 'preflight_verify'], [NODE_IDS.preflightRouter, 'preflight_router']]) {
    assert.equal(r.candidate.find((n) => n.id === id).func, receiverFunctionSource(name), id);
  }
  const owner = r.candidate.find((n) => n.id === OWNER_ROUTER_ID).func;
  assert.ok(owner.includes(PROBE_JOIN_V2) && !owner.includes(PROBE_INSTALLED));
  validateReviewedFlowContract({ liveBytes: bytesOf(flow), candidateBytes: r.candidateBytes, contract: r.contract });
  // Untouched nodes keep identity, position and every field.
  const changed = new Set(r.allowedChanges.map((c) => c.id));
  r.candidate.slice(0, flow.length).forEach((n, i) => {
    assert.equal(n.id, flow[i].id);
    if (!changed.has(n.id)) assert.deepEqual(n, flow[i], n.id);
    else assert.deepEqual([n.x, n.y], [flow[i].x, flow[i].y], n.id);
  });
});

test('preimage, receiver source and owner probe drift refuse', () => {
  const flow = syntheticInstalled();
  assert.throws(() => composeJoinV2Live(bytesOf(flow), 'synthetic-join-v2'), /JOIN_V2_LIVE_PREIMAGE_DRIFT/);
  const drift = syntheticInstalled();
  drift.find((n) => n.id === NODE_IDS.executor).func += '\n// live hotfix';
  assert.throws(() => compose(drift, { ...pinsFor(drift), receiverFuncSha256: pinsFor(flow).receiverFuncSha256 }),
    /JOIN_V2_RECEIVER_SOURCE_DRIFT/);
  for (const func of ['return msg;', 'const a = ' + PROBE_INSTALLED + ';\nconst b = ' + PROBE_INSTALLED + ';']) {
    const probe = syntheticInstalled();
    probe.find((n) => n.id === OWNER_ROUTER_ID).func = func;
    assert.throws(() => compose(probe), /JOIN_V2_OWNER_PROBE_DRIFT/);
  }
});

test('unexpected installed field drift, store drift, foreign edges and re-install refuse', () => {
  const wires = syntheticInstalled();
  wires.find((n) => n.id === NODE_IDS.admissionVerify).wires = [[NODE_IDS.router], [NODE_IDS.respond]];
  assert.throws(() => compose(wires), /JOIN_V2_RECEIVER_FIELD_DRIFT/);
  const store = syntheticInstalled();
  store.push({ id: 'other_client', type: 'mongodb4-client' });
  store.find((n) => n.id === NODE_IDS.mongoFind).clientNode = 'other_client';
  assert.throws(() => compose(store), /JOIN_V2_RECEIVER_STORE_DRIFT/);
  const edge = syntheticInstalled();
  edge.push({ id: 'outside', type: 'function', z: 'owner_tab', func: 'return msg;', wires: [[NODE_IDS.router]] });
  assert.throws(() => compose(edge), /JOIN_V2_FOREIGN_EDGE/);
  const again = syntheticInstalled();
  again.push({ id: NODE_IDS.preflightIn, type: 'http in', z: TAB_ID, url: ROUTES.preflightV2, method: 'post', wires: [[]] });
  assert.throws(() => compose(again), /JOIN_V2_ALREADY_INSTALLED/);
});

test('probe 2 is not advertised unless the installed owner carries every MANAGED_JOIN_V2 guard', () => {
  for (const [id, guards] of Object.entries(OWNER_V2_GUARDS)) {
    for (const guard of guards) {
      const flow = syntheticInstalled();
      const node = flow.find((n) => n.id === id);
      node.func = node.func.replace(guard, '');
      assert.throws(() => compose(flow), /JOIN_V2_OWNER_GUARD_MISSING/, guard);
    }
  }
});

test('existing routes that would match the new v2 paths first refuse', () => {
  for (const url of ['/lk/integrations/v2/:x', '/lk/integrations/*', 'lk/integrations/v2/booked-operations/:id',
    ROUTES.admissionV2.toUpperCase() + '/']) {
    const flow = syntheticInstalled();
    flow.push({ id: 'shadow', type: 'http in', z: 'owner_tab', url, method: 'post', wires: [[]] });
    assert.throws(() => compose(flow), /JOIN_V2_ROUTE_SHADOWED/, url);
  }
});

// ---- Installed graph fixture (private copy outside Git; never committed) ----
const fixture = process.env.LK1_JOIN_V2_LIVE_FLOW_FIXTURE;
const live = fixture ? fs.readFileSync(fixture) : null;
const liveTest = (name, fn) => test(name, { skip: live ? false : 'LK1_JOIN_V2_LIVE_FLOW_FIXTURE not set' }, fn);
const load = () => ({ liveFlow: JSON.parse(live.toString('utf8')), ...composeJoinV2Live(live, 'join-v2-live-test') });

liveTest('LIVE: installed receiver functions are the receiver build at the base commit', (t) => {
  const show = (file) => execFileSync('git', ['show', JOIN_V2_RECEIVER_BASE_COMMIT + ':scripts/nodered_booked_operation_receiver_nodes/' + file],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  let prelude, viva;
  try { prelude = show('_booked_operation_delegation_prelude.js'); viva = show('_booked_operation_viva_contract.js'); }
  catch { return t.skip('base commit not in local history'); }
  const built = {
    [NODE_IDS.admissionVerify]: prelude + '\n' + show('fn_booked_operation_admission_verify.js'),
    [NODE_IDS.readVerify]: prelude + '\n' + show('fn_booked_operation_read_verify.js'),
    [NODE_IDS.router]: show('fn_booked_operation_router.js'),
    [NODE_IDS.executor]: viva + '\n' + show('fn_booked_operation_executor.js'),
    [NODE_IDS.respond]: show('fn_booked_operation_response.js'),
  };
  for (const [id, func] of Object.entries(built)) assert.equal(sha(func), JOIN_V2_RECEIVER_LIVE_FUNC_SHA256[id], id);
});

liveTest('LIVE: only the reviewed receiver/owner fields change and six v2 nodes are appended', () => {
  const { liveFlow, candidate, candidateBytes, contract, allowedChanges } = load();
  validateReviewedFlowContract({ liveBytes: live, candidateBytes, contract });
  assert.equal(candidate.length, liveFlow.length + 6);
  const changed = new Set(allowedChanges.map((c) => c.id));
  liveFlow.forEach((n, i) => { if (!changed.has(n.id)) assert.deepEqual(candidate[i], n, n.id); });
  const routes = (f) => f.filter((n) => n.type === 'http in').map((n) => n.method + ' ' + n.url).sort();
  assert.deepEqual(routes(candidate), [...routes(liveFlow), 'post ' + ROUTES.preflightV2, 'post ' + ROUTES.admissionV2,
    'get ' + ROUTES.readPrefixV2 + ':operationId'].sort());
});

liveTest('LIVE: owner probe advertises contracts 1 and 2 only; everything else is unchanged', () => {
  const { liveFlow, candidate } = load();
  const responseOf = (trace) => trace.filter((row) => row.response).at(-1)?.response;
  const probe = (flow, headers) => responseOf(H.simulate(flow, 'lk_subscription_booking_owner_probe_get_20261023',
    { _msgid: 'msg-1', payload: {}, req: { method: 'GET', url: '/lk/subscription-bookings', originalUrl: '/lk/subscription-bookings', headers, query: {} } },
    { viva: H.fakeViva(H.world({})), store: new H.FakeStore() }));
  const v = (version) => ({ 'x-booked-operation-owner-contract': version });
  assert.deepEqual(probe(candidate, v('2')).payload,
    { contractVersion: 2, owner: 'LK1_SUBSCRIPTION_BOOKING_OWNER', policy: 'MANAGED_JOIN_V2' });
  assert.equal(probe(candidate, v('2')).statusCode, 200);
  assert.equal(probe(liveFlow, v('2')).statusCode, 404);
  for (const headers of [v('1'), v('3'), v('4'), {}, { 'x-training-registration-owner-contract': '1' }]) {
    assert.deepEqual(probe(candidate, headers), probe(liveFlow, headers), JSON.stringify(headers));
  }
});

// Receiver nodes run with Node-RED's function signature plus the configured LK2 delegation.
const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const ENV = { LK1_BOOKED_OPERATION_RECEIVER_ENABLED: 'true', BOOKED_OPERATION_EXECUTION_ENABLED: 'true',
  LK2_BOOKED_OPERATION_DELEGATION_ISSUER: 'https://lk2.example.test', LK2_BOOKED_OPERATION_DELEGATION_AUDIENCE: 'padlhub-lk1-booked-operation',
  LK2_BOOKED_OPERATION_DELEGATION_KEY_ID: 'synthetic-key', LK2_BOOKED_OPERATION_DELEGATION_PUBLIC_KEY_PEM: keys.publicKey.export({ type: 'spki', format: 'pem' }) };
const run = (node, msg, env = ENV, globals = {}) => new Function('msg', 'env', 'global', 'nodeCrypto', 'node', node.func)(
  msg, { get: (k) => env[k] }, { get: (k) => globals[k] }, crypto, { warn() {}, error() {}, send() {} });

liveTest('LIVE: unsigned and closed-config v2 requests stop in the verify node without store or provider', () => {
  const { candidate } = load();
  const node = (id) => candidate.find((n) => n.id === id);
  const request = (method, url, headers = {}) => ({ req: { method, url, originalUrl: url, headers, query: {}, params: { operationId: url.split('/').pop() } }, payload: {} });
  const cases = [[NODE_IDS.preflightVerify, request('POST', ROUTES.preflightV2)],
    [NODE_IDS.admissionVerify, request('POST', ROUTES.admissionV2)],
    [NODE_IDS.readVerify, request('GET', ROUTES.readPrefixV2 + '00000000-0000-4000-8000-000000000000')],
    [NODE_IDS.admissionVerify, request('POST', ROUTES.admission, { 'x-subscription-actor-delegation': 'a.b.c' })]];
  for (const [id, msg] of cases) {
    const out = run(node(id), structuredClone(msg));
    assert.equal(out[0], null, id);
    assert.equal(out[1].statusCode, 401, id + ' ' + JSON.stringify(out[1].payload));
  }
  for (const [id, msg] of cases) {
    const out = run(node(id), structuredClone(msg), { ...ENV, LK1_BOOKED_OPERATION_RECEIVER_ENABLED: 'false' });
    assert.equal(out[0], null, id);
    assert.equal(out[1].statusCode, 503, id);
  }
});

liveTest('LIVE: preflight router fails closed before any request while the CUP runtime binding is absent', () => {
  const { candidate } = load();
  const router = candidate.find((n) => n.id === NODE_IDS.preflightRouter);
  const verify = candidate.find((n) => n.id === NODE_IDS.preflightVerify);
  assert.deepEqual(verify.wires, [[NODE_IDS.preflightRouter], [NODE_IDS.respond]]);
  // A message as verify emits it, with a valid request but no PROD base URL/integration token in globals.
  const contract = JSON.parse(fs.readFileSync(new URL('./fixtures/managed-join-v2-contract.json', import.meta.url), 'utf8'));
  const body = contract.preflight.request;
  assert.ok(body);
  const message = () => ({ _bookedOperationPreflight: { step: 'start', body: structuredClone(body), actorToken: 'actor-token',
    claims: { exp: 4102444800, actor_token_expires_at: '2100-01-01T00:00:00.000Z', target_admissible: true,
      correlation_id: 'corr', tenant_key: 'iSkq6G', provider_client_id: 'client' } } });
  // Installed LK1 today: no CUP runtime binding in globals.
  const out = run(router, message(), ENV, {});
  assert.equal(out[0], null);
  assert.equal(out[1].statusCode, 503);
  assert.equal(out[1].payload.code, 'BOOKED_OPERATION_PREFLIGHT_UNAVAILABLE');
  // Only the binding is missing: with it, the same message proceeds to the actor's profile GET.
  const bound = run(router, message(), ENV, { subscriptions_runtime_environment: 'PROD',
    subscriptions_runtime_api_base_url: 'https://padlhub.su/api', subscriptions_entitlement_integration_token: 'synthetic' });
  assert.equal(bound[1], null);
  assert.equal(bound[0].method, 'GET');
  assert.equal(bound[0].url, 'https://api.vivacrm.ru/end-user/api/v1/iSkq6G/profile');
});
