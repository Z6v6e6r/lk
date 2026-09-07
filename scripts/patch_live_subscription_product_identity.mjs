import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { buildExactGraphContract, validateReviewedFlowContract } from './nodered_reviewed_flow_deploy/runtime_contract.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const source = name => fs.readFileSync(path.join(dir, 'nodered_subscription_product_nodes', name + '.js'), 'utf8');
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
export const GATEWAY_ID = 'lk_subscription_booking_router_20260804';
export const GATEWAY_SHA256 = 'c26c158e3d8c4eaa5548f571a2668c2259780bbe5ae3008a5bc1f9ab8da52394';
export const PRODUCT_PATH = '/lk/subscriptions/product';
export const COLLECTION = 'lk_subscription_product_identity';
export const id = name => 'lk_subscription_product_' + name + '_20260907';
const priorWires = ['http', 'find', 'insert', 'update', 'finalize', 'debug'].map(name =>
  ['lk_subscription_booking_' + name + '_20260804']).concat([['lk_subscription_managed_policy_20260820']]);
const replace = (text, before, after) => {
  if (text.split(before).length !== 2) throw new Error('Product identity source anchor drift: ' + before.slice(0, 70));
  return text.replace(before, after);
};
export function patchProductGateway(text) {
  if (hash(text) !== GATEWAY_SHA256) throw new Error('Product identity gateway preimage drift');
  text = replace(text, 'const ctx = isObj(msg._subscriptionBooking)', source('gateway') + '\nconst ctx = isObj(msg._subscriptionBooking)');
  text = replace(text, '\ndelete ctx.lk1IngressReplay;\nconst split =', '\ndelete ctx.lk1ProductIdentity;\ndelete ctx.lk1IngressReplay;\nconst split =');
  text = replace(text, 'if (ctx.step === "lk1_profile_continue") {', source('gateway_start')
    + '\nif (ctx.step === "lk1_profile_continue") {\n' + source('gateway_lookup'));
  // Both singular and plural readers use the same verified projection.
  const start = text.indexOf('const findOwnedSubscription =');
  const end = text.indexOf('\nconst pickName =', start);
  if (start < 0 || end < 0) throw new Error('Product identity ownership anchor drift');
  text = text.slice(0, start) + 'const findOwnedSubscription = (exercise, clientSubscriptionId) =>\n'
    + '  findOwnedSubscriptions(exercise, clientSubscriptionId)[0] || null;\n' + text.slice(end);
  text = replace(text, 'const findOwnedSubscriptions = (exercise, clientSubscriptionId) => {',
    'const findOwnedSubscriptions = (exercise, clientSubscriptionId) => identityOwned(ctx, rawOwnedSubscriptions(exercise, clientSubscriptionId), exercise);\n'
    + 'const rawOwnedSubscriptions = (exercise, clientSubscriptionId) => {');
  text = replace(text, 'if (ctx.step === "exercise_recheck") {', source('gateway_recheck') + '\nif (ctx.step === "exercise_recheck") {\n  delete ctx.productRecheckReady;');
  for (const step of ['prospective_subscriptions', 'lk1_money_owned_subscriptions']) {
    text = replace(text, 'if (ctx.step === "' + step + '") {', 'if (ctx.step === "' + step + '") {\n'
      + '  const freshIdentityRow = identitySelected(msg.payload, ctx);\n'
      + '  if (!isHttpOk(msg.statusCode) || !freshIdentityRow || !identityBound(ctx)) return finishError(ctx, 503, "Не удалось проверить состояние абонемента", { code: "SUBSCRIPTION_PRODUCT_CURRENT_STATE_UNAVAILABLE" });\n'
      + '  ctx.lk1ProductIdentity.subscription = freshIdentityRow;\n'
      + '  ctx.lk1ProductIdentity.purchaseDate = freshIdentityRow.purchaseDate;');
  }
  text = replace(text, '    const activation = lk1LifecycleInstant(subscription?.activationDate);',
    '    const firstUse = preflightAvailability.resolveSplitSubscriptionLifecycle(subscription, eventDate(exercise)) === "NEW_FIRST_USE_CANDIDATE";\n    const activation = lk1LifecycleInstant(subscription?.activationDate);');
  text = replace(text, '      || subscription.status !== "ACTIVE" || activation === null || expiry === null',
    '      || (!firstUse && (subscription.status !== "ACTIVE" || activation === null || expiry === null))');
  text = replace(text, '      || activation > now || activation > targetStart || expiry < now || expiry < targetEnd',
    '      || (!firstUse && (activation > now || activation > targetStart || expiry < now || expiry < targetEnd))');
  // Identity/name already came from the authenticated resolver. Preserve the
  // existing untracked-plan behavior without another phone-based admin lookup.
  const fallbackStart = text.indexOf('  const nameMarker = normalizeMarker(ctx.subscriptionName);');
  const fallbackEnd = text.indexOf('  ctx.limitMode = resolveLimitMode(ctx.planKey, ctx.serviceDate);', fallbackStart);
  if (fallbackStart < 0 || fallbackEnd < 0) throw new Error('Legacy product fallback anchor drift');
  text = text.slice(0, fallbackStart) + text.slice(fallbackEnd);
  return text;
}
export function composeSubscriptionProductIdentityFlow(flow) {
  if (!Array.isArray(flow) || flow.some(n => !n || typeof n.id !== 'string')
    || new Set(flow.map(n => n.id)).size !== flow.length) throw new Error('Invalid or duplicate flow identities');
  const gateway = flow.find(n => n.id === GATEWAY_ID);
  const mongo = flow.find(n => n.id === 'lk_subscription_booking_find_20260804');
  if (gateway?.type !== 'function' || gateway.outputs !== 7 || !isDeepStrictEqual(gateway.wires, priorWires)
    || mongo?.type !== 'mongodb4' || mongo.operation !== 'find'
    || mongo.collection !== 'lk_subscription_daily_booking_ops'
    || !flow.some(n => n.id === mongo.clientNode && n.type === 'mongodb4-client')) throw new Error('Product identity dependency graph drift');
  if (flow.some(n => n.id.startsWith('lk_subscription_product_')
    || (n.type === 'http in' && n.url === PRODUCT_PATH))) throw new Error('Product identity route or node already exists');
  const z = gateway.z;
  const fn = (name, outputs, wires) => ({ id: id(name), type: 'function', z, name: 'Subscription product ' + name,
    func: source(name), outputs, timeout: 0, noerr: 0, initialize: '', finalize: '', libs: [], x: 900, y: 1000, wires });
  const additions = [
    { id: id('get'), type: 'http in', z, name: 'Authenticated subscription product name', url: PRODUCT_PATH,
      method: 'get', upload: false, swaggerDoc: '', x: 500, y: 1000, wires: [[id('entry')]] },
    fn('entry', 1, [[id('router')]]),
    fn('router', 5, [[id('http')], [id('find')], [id('update')], [id('finish')], [id('wait')]]),
    fn('finish', 3, [[GATEWAY_ID], [id('response')], [id('debug')]]),
    { id: id('http'), type: 'http request', z, name: 'Viva product reads only', method: 'use', ret: 'obj',
      paytoqs: 'ignore', url: '', tls: '', persist: false, proxy: '', insecureHTTPParser: false, authType: '',
      senderr: true, headers: [], requestTimeout: '10000', x: 1200, y: 1000, wires: [[id('router')]] },
    ...['find', 'update'].map(name => ({ id: id(name), type: 'mongodb4', z,
      name: 'Subscription product ' + name, clientNode: mongo.clientNode, mode: 'collection',
      collection: COLLECTION, operation: name === 'find' ? 'find' : 'updateOne', output: 'toArray',
      maxTimeMS: '5000', handleDocId: false, x: 1200, y: name === 'find' ? 1040 : 1080, wires: [[id('router')]] })),
    { id: id('wait'), type: 'delay', z, name: 'Bounded product lookup wait', pauseType: 'delay', timeout: '500',
      timeoutUnits: 'milliseconds', rate: '1', nbRateUnits: '1', rateUnits: 'second', drop: false,
      allowrate: false, x: 1200, y: 1120, wires: [[id('router')]] },
    { id: id('catch'), type: 'catch', z, name: 'Product I/O failure', scope: [id('http'), id('find'), id('update')],
      uncaught: false, x: 1200, y: 1160, wires: [[id('error')]] },
    { id: id('error'), type: 'function', z, name: 'Redact product I/O failure', func:
      "msg.error = { code: Number(msg.error?.code) === 11000 || /E11000/.test(String(msg.error?.message || '')) ? 11000 : 0 }; delete msg.headers; msg.payload = null; return msg;",
      outputs: 1, timeout: 0, noerr: 0, initialize: '', finalize: '', libs: [], x: 900, y: 1160, wires: [[id('router')]] },
    { id: id('response'), type: 'http response', z, name: '', statusCode: '', headers: {}, x: 1500, y: 1000, wires: [] },
    { id: id('options'), type: 'http in', z, name: 'Product CORS', url: PRODUCT_PATH, method: 'options',
      upload: false, swaggerDoc: '', x: 500, y: 1200, wires: [[id('cors')]] },
    { id: id('cors'), type: 'function', z, name: 'Product CORS', func:
      "msg.statusCode = 204; msg.headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '600', 'Cache-Control': 'no-store' }; msg.payload = ''; return msg;",
      outputs: 1, timeout: 0, noerr: 0, initialize: '', finalize: '', libs: [], x: 900, y: 1200, wires: [[id('response')]] },
    { id: id('inject'), type: 'inject', z, name: 'Refresh ONE cached product: enter productId',
      props: [{ p: 'payload' }], payload: '', payloadType: 'str', repeat: '', crontab: '', once: false, onceDelay: 0.1,
      x: 500, y: 1260, wires: [[id('refresh')]] },
    fn('refresh', 1, [[id('router')]]),
    { id: id('debug'), type: 'debug', z, name: 'Product refresh result (redacted)', active: true,
      tosidebar: true, console: false, tostatus: false, complete: 'payload', targetType: 'msg',
      x: 1500, y: 1260, wires: [] },
  ];
  const candidate = structuredClone(flow);
  const changed = candidate.find(n => n.id === GATEWAY_ID);
  changed.func = patchProductGateway(gateway.func);
  changed.outputs = 8; changed.wires.push([id('router')]);
  return candidate.concat(additions);
}
// Pure preparation: caller supplies a privately retained preimage. No network,
// file publication, runtime import, DB writes or activation happen here.
export function composeSubscriptionProductIdentityArtifacts(liveBytes, deploymentId) {
  const candidate = composeSubscriptionProductIdentityFlow(JSON.parse(liveBytes.toString()));
  const candidateBytes = Buffer.from(JSON.stringify(candidate, null, 2) + '\n');
  const contract = buildExactGraphContract({ liveBytes, candidateBytes, deploymentId,
    allowedChanges: [{ id: GATEWAY_ID, fields: ['func', 'outputs', 'wires'] }],
    allowedAdditionIds: candidate.filter(n => n.id.startsWith('lk_subscription_product_')).map(n => n.id) });
  validateReviewedFlowContract({ liveBytes, candidateBytes, contract });
  return { candidate, candidateBytes, contract };
}
