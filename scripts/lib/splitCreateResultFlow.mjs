import { createHash } from 'node:crypto';
import { createSplitCreateResultProtocol } from './splitCreateResult.mjs';
import { instrumentSplitCreateTimings } from './splitCreateTiming.mjs';
import { buildExactGraphContract, validateReviewedFlowContract } from '../nodered_reviewed_flow_deploy/runtime_contract.mjs';

export const SPLIT_CREATE_RESULT_PATH = '/lk/games/split/create-result';
export const SPLIT_CREATE_RESULT_IDS = Object.fromEntries(['get', 'handler', 'http', 'find', 'catch', 'response']
  .map(name => [name, `lk_split_create_result_${name}_20261113`]));
export function splitCreateResultNode(msg, global, protocol) {
  const response = (status, body) => {
    msg.statusCode = status;
    msg.headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Referrer-Policy': 'no-referrer' };
    msg.payload = body;
    for (const key of ['_splitCreateResult', 'error', 'url', 'method', 'responseUrl', 'requestTimeout']) delete msg[key];
    return [null, null, msg];
  };
  const ctx = msg._splitCreateResult;
  let next;
  if (!ctx) {
    if (msg.req?.method === 'OPTIONS') return response(204, '');
    if (msg.req?.method !== 'GET' || (msg.req.originalUrl || msg.req.url || '').split('?')[0] !== '/lk/games/split/create-result') {
      return response(405, { code: 'SPLIT_CREATE_RESULT_METHOD_INVALID' });
    }
    const auth = msg.req.headers?.authorization;
    if (typeof auth !== 'string' || !/^Bearer [^\s]+$/.test(auth) || auth.length > 16384) {
      return response(401, { code: 'SPLIT_CREATE_RESULT_AUTH_REQUIRED' });
    }
    next = protocol.begin(msg.req.query, Date.now());
    msg._splitCreateResult = { actorAuth: auth, state: next.state };
  } else next = protocol.step(ctx.state, { body: msg.payload, status: Number(msg.statusCode), error: !!msg.error }, Date.now());
  if (next.effect.kind === 'reply') return response(next.effect.status, next.effect.body);
  msg._splitCreateResult.state = next.state;
  delete msg.error;
  delete msg.statusCode;
  if (next.effect.kind === 'find') {
    msg.payload = [next.effect.query, next.effect.options];
    return [null, msg, null];
  }
  if (next.effect.kind !== 'http' || next.effect.method !== 'GET') return response(503, { code: 'SPLIT_CREATE_RESULT_EFFECT_INVALID' });
  let auth = msg._splitCreateResult.actorAuth;
  if (next.effect.auth === 'service') {
    const token = global.get('vivacrm_access_token');
    const expires = global.get('vivacrm_token_expires_at');
    if (typeof token !== 'string' || !token || /\s/.test(token) || !Number.isFinite(Number(expires)) || Number(expires) <= Date.now() + 5000) {
      return response(202, { schemaVersion: 1, recovery: 'SPLIT_CREATE_RESULT_V1', state: 'PENDING_CONFIRMATION',
        operationId: next.state.binding.operationId, code: 'SPLIT_CREATE_RESULT_SERVICE_UNAVAILABLE' });
    }
    auth = `Bearer ${token}`;
  }
  msg.method = 'GET';
  msg.url = `https://api.vivacrm.ru${next.effect.path}`;
  msg.headers = { Authorization: auth, Accept: 'application/json', 'Cache-Control': 'no-store' };
  msg.payload = undefined;
  msg.requestTimeout = Math.min(4000, Math.max(1, next.state.deadline - Date.now()));
  msg.followRedirects = false;
  msg.maxRedirects = 0;
  return [msg, null, null];
}
export const splitCreateResultFunctionSource = () => `const protocol = (${createSplitCreateResultProtocol.toString()})();\nreturn (${splitCreateResultNode.toString()})(msg, global, protocol);\n`;

export function buildSplitCreateResultNodes(tab, clientNode) {
  const i = SPLIT_CREATE_RESULT_IDS;
  return [
    ...['get'].map(method => ({ id: i[method], type: 'http in', z: tab, name: `${method.toUpperCase()} split create result`,
      url: SPLIT_CREATE_RESULT_PATH, method, upload: false, swaggerDoc: '', x: 200, y: method === 'get' ? 5400 : 5440, wires: [[i.handler]] })),
    { id: i.handler, type: 'function', z: tab, name: 'Read split create result', func: splitCreateResultFunctionSource(),
      outputs: 3, timeout: 0, noerr: 0, initialize: '', finalize: '', libs: [], x: 550, y: 5400, wires: [[i.http], [i.find], [i.response]] },
    { id: i.http, type: 'http request', z: tab, name: 'GET split create result evidence', method: 'use', ret: 'obj', paytoqs: 'ignore',
      url: '', tls: '', persist: false, proxy: '', insecureHTTPParser: false, authType: '', senderr: true,
      headers: [], x: 900, y: 5360, wires: [[i.handler]] },
    { id: i.find, type: 'mongodb4', z: tab, name: 'Read exact split create operation', collection: 'lk_subscription_daily_booking_ops',
      operation: 'find', clientNode, mode: 'collection', output: 'toArray', maxTimeMS: '2000', handleDocId: false,
      x: 900, y: 5420, wires: [[i.handler]] },
    { id: i.catch, type: 'catch', z: tab, name: 'Catch split create result reads', scope: [i.http, i.find], uncaught: false,
      x: 550, y: 5500, wires: [[i.handler]] },
    { id: i.response, type: 'http response', z: tab, name: 'Split create result', statusCode: '', headers: {}, x: 1250, y: 5460, wires: [] },
  ];
}

const sha = value => createHash('sha256').update(value).digest('hex');
export function composeSplitCreateResultFlow(liveBytes, expectedSha256) {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256) || sha(liveBytes) !== expectedSha256) throw Error('Split result flow preimage mismatch');
  const flow = JSON.parse(liveBytes), ids = new Set(flow.map(n => n.id));
  if (ids.size !== flow.length || Object.values(SPLIT_CREATE_RESULT_IDS).some(id => ids.has(id))
    || flow.some(n => n.type === 'http in' && n.url === SPLIT_CREATE_RESULT_PATH)) throw Error('Split result graph collision');
  const route = flow.filter(n => n.type === 'http in' && n.method === 'post' && n.url === '/lk/games/split/create');
  const mongo = flow.find(n => n.id === 'lk_subscription_booking_find_20260804');
  if (route.length !== 1 || !flow.some(n => n.id === route[0].z && n.type === 'tab' && !n.disabled)
    || mongo?.type !== 'mongodb4' || !mongo.clientNode) throw Error('Split result owning graph unavailable');
  const nodes = buildSplitCreateResultNodes(route[0].z, mongo.clientNode);
  const allowedChanges = instrumentSplitCreateTimings(flow);
  const candidateBytes = Buffer.from(`${JSON.stringify([...flow, ...nodes], null, 2)}\n`);
  const contract = buildExactGraphContract({ liveBytes, candidateBytes, deploymentId: 'split-create-result-20261113',
    allowedChanges, allowedAdditionIds: nodes.map(n => n.id) });
  validateReviewedFlowContract({ liveBytes, candidateBytes, contract });
  return { candidateBytes, contract, nodes };
}
