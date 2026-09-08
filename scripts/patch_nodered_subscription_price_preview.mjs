import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { extractSubscriptionPricePreviewSource } from './lib/subscriptionPricePreviewSources.mjs';
import { buildExactGraphContract, validateReviewedFlowContract } from './nodered_reviewed_flow_deploy/runtime_contract.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PREFIX = 'lk_subscription_price_preview_20260908_';
export const PATH = '/lk/subscriptions/game-price-preview';
const read = name => fs.readFileSync(path.join(ROOT, 'nodered_subscription_price_preview_nodes', `${name}.js`), 'utf8');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const node = (z, name, outputs, wires, source = null) => ({ id: `${PREFIX}${name}`, type: 'function', z, name: `Subscription price preview ${name}`, func: source ?? read(name), outputs, timeout: 0, noerr: 0, initialize: '', finalize: '', libs: [], x: 680, y: 1000, wires });

export function previewSources(flow) {
  const sourceOf = id => {
    const matches = flow.filter(row => row.id === id && row.type === 'function');
    if (matches.length !== 1) throw new Error('Price preview canonical source missing');
    return matches[0].func;
  };
  const booking = sourceOf('lk_subscription_booking_router_20260804');
  const split = sourceOf('8f7bd5b482fe9763');
  if (sha(booking) !== '0d505c16e83f88b238d7a9d26a47d01fa6ab32be5b7a7f0d604474b2f3123f37'
    || sha(split) !== '53c4f6ab309b4287eaded6c6d16a9c0e34f47c8eac625c58bdf423acfb083d42') {
    throw new Error('Price preview canonical booking/pricing source changed');
  }
  const roots = ['isObj', 'unwrapRecord', 'extractItems', 'hasCompleteBookingList', 'bookingId', 'bookingClientId',
    'normalizeId', 'collectExactProductIds', 'collectSubscriptionPurchaseDateEvidence', 'identityOwned', 'lk1Config', 'lk1Fields', 'preflightAvailability',
    'mergeBookings', 'isInactiveBooking', 'isSubscriptionBooking', 'bookingSubscriptionId', 'eventDate',
    'eventDurationMinutes', 'resolveCategory', 'resolvePlanKey', 'compatibilityPlanKey', 'PLAN_CATEGORIES', 'resolveLimitMode'];
  const helper = extractSubscriptionPricePreviewSource({ source: booking, label: 'booking', roots });
  const prices = extractSubscriptionPricePreviewSource({ source: split, label: 'pricing', roots: ['extractExactCourtPrice', 'extractList'] });
  // No emitter/transport/state machine may enter the extracted helper closure.
  if ([...helper.names, ...prices.names].some(name => ['ctx', 'emit', 'prepareHttp', 'prepareOperationFind', 'prepareBookingCreate'].includes(name))) {
    throw new Error('Price preview helper closure escaped pure calculations');
  }
  const usageStart = 'if (ctx.step === "lk1_usage_operations") {';
  const usageEnd = 'if (ctx.step === "lk1_policy_decision") {';
  if (booking.split(usageStart).length !== 2 || booking.split(usageEnd).length !== 2) throw new Error('Price preview allowance source drift');
  const usage = booking.slice(booking.indexOf(usageStart), booking.indexOf(usageEnd));
  const canonical = `const canonical = (() => {\n${helper.source}\nreturn {${roots.join(',')}}; })();`;
  const pricing = `const pricing = (() => {\n${prices.source}\nreturn { extractExactCourtPrice, extractList }; })();`;
  const usageFunction = `const canonicalUsage = msg => { const ctx = msg._subscriptionBooking;
    const { isObj, normalizeId, isInactiveBooking, eventDate, bookingSubscriptionId, bookingId, resolveCategory, eventDurationMinutes, lk1Fields } = canonical;
    const OUTPUT_MANAGED_POLICY = 6;
    const emit = () => msg;
    const lk1Stop = (_context, code) => { msg.previewError = code; return msg; };
    ${usage}
  };`;
  const evaluator = sourceOf('lk_subscription_managed_policy_20260820');
  if (sha(evaluator) !== '2ae3a02b1dfc1129883a72dda404d13cfb9b43e67e634d654f81fb01a5ca620c') throw new Error('Price preview canonical evaluator changed');
  return { router: `${canonical}\n${pricing}\n${usageFunction}\n${read('router')}`, evaluator,
    helperNames: helper.names, pricingNames: prices.names };
}

export function composeSubscriptionPricePreviewFlow(flow) {
  if (!Array.isArray(flow) || flow.some(row => !row || typeof row.id !== 'string') || new Set(flow.map(row => row.id)).size !== flow.length) throw new Error('Invalid Node-RED source flow');
  if (flow.some(row => row.id.startsWith(PREFIX) || (row.type === 'http in' && row.url === PATH))) throw new Error('Price preview route already exists');
  const bookingFind = flow.find(row => row.id === 'lk_subscription_booking_find_20260804');
  if (!bookingFind || bookingFind.type !== 'mongodb4' || bookingFind.operation !== 'find' || bookingFind.collection !== 'lk_subscription_daily_booking_ops' || !flow.some(row => row.id === bookingFind.clientNode && row.type === 'mongodb4-client')) throw new Error('Price preview Mongo dependency drift');
  const sources = previewSources(flow);
  const z = bookingFind.z;
  const id = name => `${PREFIX}${name}`;
  const mongo = (name, collection) => ({ id: id(name), type: 'mongodb4', z, name: `Subscription price preview ${name}`, clientNode: bookingFind.clientNode, mode: 'collection', collection, operation: 'find', output: 'toArray', maxTimeMS: '5000', handleDocId: false, x: 970, y: 1000, wires: [[id('router')]] });
  return flow.concat([
    { id: id('post'), type: 'http in', z, name: 'LK subscription game price preview', url: PATH, method: 'post', upload: false, swaggerDoc: '', x: 300, y: 1000, wires: [[id('entry')]] },
    node(z, 'entry', 1, [[id('router')]]),
    { ...node(z, 'router', 5, [[id('http')], [id('metadata')], [id('operations')], [id('evaluate')], [id('final')]]), func: sources.router },
    node(z, 'evaluate', 2, [[id('router')], [id('router')]], sources.evaluator),
    node(z, 'final', 1, [[id('response')]]),
    { id: id('http'), type: 'http request', z, name: 'Subscription price preview Viva reads only', method: 'GET', ret: 'obj', paytoqs: 'ignore', url: '', tls: '', persist: false, proxy: '', insecureHTTPParser: false, authType: '', senderr: true, headers: [], requestTimeout: '10000', x: 970, y: 960, wires: [[id('router')]] },
    mongo('metadata', 'lk_subscription_product_identity'),
    mongo('operations', 'lk_subscription_daily_booking_ops'),
    { id: id('catch'), type: 'catch', z, name: 'Subscription price preview I/O failure', scope: [id('entry'), id('router'), id('evaluate'), id('http'), id('metadata'), id('operations')], uncaught: false, x: 950, y: 1100, wires: [[id('error')]] },
    node(z, 'error', 1, [[id('final')]], "msg._subscriptionPricePreview = { done: true, statusCode: 503, error: 'PRICE_PREVIEW_UNAVAILABLE' }; return msg;"),
    { id: id('response'), type: 'http response', z, name: '', statusCode: '', headers: {}, x: 1250, y: 1000, wires: [] },
    { id: id('options-in'), type: 'http in', z, name: 'OPTIONS subscription game price preview', url: PATH, method: 'options', upload: false, swaggerDoc: '', x: 300, y: 1180, wires: [[id('options')]] },
    node(z, 'options', 1, [[id('response')]]),
  ]);
}

export function composeSubscriptionPricePreviewArtifacts(liveBytes, deploymentId) {
  const candidate = composeSubscriptionPricePreviewFlow(JSON.parse(Buffer.from(liveBytes).toString('utf8')));
  const candidateBytes = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`);
  const allowedAdditionIds = candidate.filter(row => row.id.startsWith(PREFIX)).map(row => row.id);
  const contract = buildExactGraphContract({ liveBytes, candidateBytes, deploymentId, allowedChanges: [], allowedAdditionIds });
  validateReviewedFlowContract({ liveBytes, candidateBytes, contract });
  return { candidate, candidateBytes, contract, sourceSha256: sha(liveBytes) };
}
