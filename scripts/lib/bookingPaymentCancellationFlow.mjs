import { createBookingPaymentCancellationProtocol } from './bookingPaymentCancellation.mjs';
import { splitAttemptTransaction } from './splitBookingPaymentAttempt.mjs';
import { bookingPaymentAttemptSource } from './eventPaymentSources.mjs';
export const BOOKING_PAYMENT_CANCEL_PATH = '/lk/games/payment-attempts/cancel';
export const BOOKING_PAYMENT_CANCEL_IDS = Object.fromEntries(['post', 'get', 'options', 'handler', 'profile',
  'find', 'update', 'games', 'catch', 'response'].map(k => [k, 'booking_payment_cancel_' + k + '_20261116']));
export function bookingPaymentCancellationNode(msg, global, env, protocol) {
  const reply = (status, body) => {
    msg.statusCode = status; msg.headers = { 'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST,GET,OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization,Content-Type', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
    msg.payload = body;
    for (const k of ['_bookingPaymentCancel', 'error', 'url', 'method', 'responseUrl', 'requestTimeout']) delete msg[k];
    return [null, null, null, null, null, msg];
  };
  let ctx = msg._bookingPaymentCancel, next;
  if (!ctx) {
    if (msg.req?.method === 'OPTIONS') return reply(204, '');
    if (!['POST', 'GET'].includes(msg.req?.method)
      || (msg.req.originalUrl || msg.req.url || '').split('?')[0] !== '/lk/games/payment-attempts/cancel') return reply(405, { code: 'PAYMENT_CANCEL_METHOD_INVALID' });
    const authorization = msg.req.headers?.authorization;
    if (typeof authorization !== 'string' || !/^Bearer [^\s]+$/.test(authorization) || authorization.length > 16384) {
      return reply(401, { code: 'PAYMENT_CANCEL_AUTH_REQUIRED' });
    }
    const tenantKey = env.get('PADLHUB_PLATFORM_TENANT_KEY');
    const enabled = env.get('LK1_UNPAID_CANCEL_MODE') === 'ENFORCE_NEW';
    const cohortFrom = env.get('LK1_UNPAID_CANCEL_COHORT_FROM');
    next = protocol.begin(msg.req.method === 'GET' ? msg.req.query : msg.payload,
      { tenantKey, enabled, cohortFrom, method: msg.req.method }, Date.now());
    ctx = { authorization, state: next.state }; msg._bookingPaymentCancel = ctx;
  } else {
    const provenanceInvalid = ctx.httpUrl && (msg.method !== 'GET' || msg.url !== ctx.httpUrl
      || msg.responseUrl !== ctx.httpUrl);
    next = protocol.step(ctx.state, { body: msg.payload, status: Number(msg.statusCode),
      error: !!msg.error || !!provenanceInvalid }, Date.now());
    delete ctx.httpUrl;
  }
  const e = next.effect; ctx.state = next.state; delete msg.error; delete msg.statusCode;
  if (e.kind === 'reply') return reply(e.status, e.body);
  if (e.kind === 'http') {
    const service = e.auth === 'service';
    if (e.method !== 'GET' || (service
      ? e.path !== '/api/v1/transactions/' + encodeURIComponent(ctx.state.binding.transactionId)
      : !e.path.startsWith('/end-user/api/v1/'))) return reply(503, { code: 'PAYMENT_CANCEL_EFFECT_INVALID' });
    let authorization = ctx.authorization;
    if (service) {
      const token = global.get('vivacrm_access_token'), expires = Number(global.get('vivacrm_token_expires_at'));
      if (typeof token !== 'string' || !token || /\s/.test(token) || !Number.isFinite(expires) || expires <= Date.now() + 5000) {
        const failed = protocol.step(ctx.state, { error: true }, Date.now());
        return reply(failed.effect.status, failed.effect.body);
      }
      authorization = 'Bearer ' + token;
    }
    msg.method = 'GET'; msg.url = 'https://api.vivacrm.ru' + e.path; ctx.httpUrl = msg.url;
    msg.headers = { Authorization: authorization, Accept: 'application/json', 'Cache-Control': 'no-store' };
    msg.payload = undefined; msg.requestTimeout = 4000; msg.followRedirects = false; msg.maxRedirects = 0;
    return [msg, null, null, null, null, null];
  }
  delete msg.headers; delete msg.url; delete msg.method; delete msg.responseUrl;
  if (e.kind === 'find') {
    msg.payload = [e.query, e.options];
    return e.collection === 'games' ? [null, null, null, msg, null, null] : [null, msg, null, null, null, null];
  }
  if (e.kind === 'update') { msg.payload = [e.query, e.change, e.options]; return [null, null, msg, null, null, null]; }
  if (e.kind === 'cleanup') {
    msg.payload = [e.game]; msg._splitCleanupRequest = e.request;
    delete msg._bookingPaymentCancel; delete msg.requestTimeout;
    return [null, null, null, null, msg, null];
  }
  return reply(503, { code: 'PAYMENT_CANCEL_EFFECT_INVALID' });
}
export function bookingPaymentCancellationSource() {
  return bookingPaymentAttemptSource() + '\nconst protocol = (' + createBookingPaymentCancellationProtocol.toString()
    + ')(Object.assign({}, bookingPaymentLifecycle, {ordinaryTransaction: ' + splitAttemptTransaction.toString() + '}));\nreturn (' + bookingPaymentCancellationNode.toString() + ')(msg, global, env, protocol);\n';
}
export function buildBookingPaymentCancellationNodes(tab, clientNode, cleanupPrepare) {
  const i = BOOKING_PAYMENT_CANCEL_IDS;
  const nodes = [
    ...['post', 'get', 'options'].map(method => ({ id: i[method], type: 'http in', z: tab,
      name: method.toUpperCase() + ' cancel booking payment', url: BOOKING_PAYMENT_CANCEL_PATH,
      method, upload: false, swaggerDoc: '', wires: [[i.handler]] })),
    { id: i.handler, type: 'function', z: tab, name: 'Request or read exact booking payment cancellation',
      func: bookingPaymentCancellationSource(), outputs: 6, timeout: 0, noerr: 0, initialize: '', finalize: '', libs: [],
      wires: [[i.profile], [i.find], [i.update], [i.games], [cleanupPrepare], [i.response]] },
    { id: i.profile, type: 'http request', z: tab, name: 'Verify cancelling actor', method: 'use', ret: 'obj',
      url: '', tls: '', persist: false, proxy: '', insecureHTTPParser: false, authType: '', senderr: true,
      headers: [], wires: [[i.handler]] },
    ...[['find', 'find', 'lk_subscription_daily_booking_ops'], ['update', 'updateOne', 'lk_subscription_daily_booking_ops'],
      ['games', 'find', 'lk_games']].map(([key, operation, collection]) => ({ id: i[key], type: 'mongodb4', z: tab,
      name: 'Cancel booking payment ' + key, operation, collection, clientNode, mode: 'collection', output: 'toArray',
      maxTimeMS: '2000', handleDocId: false, wires: [[i.handler]] })),
    { id: i.catch, type: 'catch', z: tab, name: 'Catch booking payment cancellation transport',
      scope: [i.profile, i.find, i.update, i.games], uncaught: false, wires: [[i.handler]] },
    { id: i.response, type: 'http response', z: tab, name: 'Booking payment cancellation result', statusCode: '', headers: {}, wires: [] },
  ];
  return nodes.map((n, index) => ({ ...n, x: 300 + index % 3 * 280, y: 5800 + Math.floor(index / 3) * 80 }));
}
