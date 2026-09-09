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
  if (sha(booking) !== '8848722f61f84e1792d2cdd69d8204be61ae66fe35c1af1d2bc7d8774f84636a'
    || sha(split) !== '53c4f6ab309b4287eaded6c6d16a9c0e34f47c8eac625c58bdf423acfb083d42') {
    throw new Error('Price preview canonical booking/pricing source changed');
  }
  const roots = ['isObj', 'unwrapRecord', 'extractItems', 'hasCompleteBookingList', 'bookingId', 'bookingClientId',
    'normalizeId', 'collectExactProductIds', 'collectSubscriptionPurchaseDateEvidence', 'identityOwned', 'lk1Config', 'lk1Fields', 'preflightAvailability',
    'mergeBookings', 'isInactiveBooking', 'isSubscriptionBooking', 'bookingSubscriptionId', 'eventDate',
    'eventDurationMinutes', 'eventStartsAt', 'exerciseRoomId', 'resolveCategory', 'resolvePlanKey', 'compatibilityPlanKey', 'PLAN_CATEGORIES', 'resolveLimitMode'];
  const joinSource = sourceOf('e92e68bf3f08a70c');
  if (sha(joinSource) !== '70ec2bdfad08c71a1a1ef2d851c07918906573a3802ce9f41765837494c6f462') throw new Error('Price preview canonical join source changed');
  const join = extractSubscriptionPricePreviewSource({ source: joinSource, label: 'join', roots: ['resolveIsSinglesGame'] });
  const joinPricing = `const joinPricing = (() => {\n${join.source}\nreturn { resolveIsSinglesGame }; })();`;
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
  if (sha(evaluator) !== '6f4e7aa5506d7da4123fc0f8c86c5a310f6fc2dc86c9cc23b56ef1deaa001a72') throw new Error('Price preview canonical evaluator changed');
  return { router: `${canonical}\n${pricing}\n${joinPricing}\n${usageFunction}\n${read('router')}`, evaluator,
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
    { ...node(z, 'router', 6, [[id('http')], [id('metadata')], [id('operations')], [id('evaluate')], [id('final')], [id('games')]]), func: sources.router },
    node(z, 'evaluate', 2, [[id('router')], [id('router')]], sources.evaluator),
    node(z, 'final', 1, [[id('response')]]),
    { id: id('http'), type: 'http request', z, name: 'Subscription price preview Viva reads only', method: 'GET', ret: 'obj', paytoqs: 'ignore', url: '', tls: '', persist: false, proxy: '', insecureHTTPParser: false, authType: '', senderr: true, headers: [], requestTimeout: '10000', x: 970, y: 960, wires: [[id('router')]] },
    mongo('metadata', 'lk_subscription_product_identity'),
    mongo('operations', 'lk_subscription_daily_booking_ops'),
    mongo('games', 'lk_games'),
    { id: id('catch'), type: 'catch', z, name: 'Subscription price preview I/O failure', scope: [id('entry'), id('router'), id('evaluate'), id('http'), id('metadata'), id('operations'), id('games')], uncaught: false, x: 950, y: 1100, wires: [[id('error')]] },
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

/** Upgrade an existing preview without replacing routes, shared gateways or policy state. */
export function composeSubscriptionJoinPricePreviewArtifacts(liveBytes, deploymentId) {
  const flow = JSON.parse(Buffer.from(liveBytes).toString('utf8'));
  const expected = {
    entry: 'e7419f0463bc30d4d198f3ab262e0401bfe762ef879ae05515428a379d2c3f7f',
    router: '7e561aa1e10432ec02631684d1f01a805c8336d8f7fa26fe565b25da7f505f19',
  };
  if (!Array.isArray(flow) || new Set(flow.map(row => row?.id)).size !== flow.length) throw new Error('Invalid preview source');
  const current = name => flow.find(row => row.id === PREFIX + name);
  for (const [name, digest] of Object.entries(expected)) {
    if (current(name)?.type !== 'function' || sha(current(name).func || '') !== digest) throw new Error(`Join preview preimage drift: ${name}`);
  }
  if (current('router').outputs !== 5 || JSON.stringify(current('router').wires) !== JSON.stringify(
    ['http', 'metadata', 'operations', 'evaluate', 'final'].map(name => [PREFIX + name]))) throw new Error('Join preview router wiring drift');
  const existing = flow.filter(row => row.id.startsWith(PREFIX));
  const base = flow.filter(row => !row.id.startsWith(PREFIX));
  // Source binding requires the same reviewed instance-scoped policy/usage as CREATE.
  const composed = composeSubscriptionPricePreviewFlow(base);
  const desired = name => composed.find(row => row.id === PREFIX + name);
  if (!current('catch') || current('catch').type !== 'catch'
    || JSON.stringify(current('catch').scope) !== JSON.stringify(['entry', 'router', 'evaluate', 'http', 'metadata', 'operations'].map(name => PREFIX + name))
    || current('games') || existing.length !== 13) throw new Error('Join preview graph drift');
  const candidate = structuredClone(flow);
  for (const name of ['entry', 'router']) candidate.find(row => row.id === PREFIX + name).func = desired(name).func;
  const router = candidate.find(row => row.id === PREFIX + 'router');
  router.outputs = 6; router.wires.push([PREFIX + 'games']);
  candidate.find(row => row.id === PREFIX + 'catch').scope.push(PREFIX + 'games');
  candidate.push(desired('games'));
  const candidateBytes = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`);
  const contract = buildExactGraphContract({ liveBytes, candidateBytes, deploymentId,
    allowedChanges: [{id: PREFIX + 'entry', fields: ['func']}, {id: PREFIX + 'router', fields: ['func', 'outputs', 'wires']},
      {id: PREFIX + 'catch', fields: ['scope']}], allowedAdditionIds: [PREFIX + 'games'] });
  validateReviewedFlowContract({ liveBytes, candidateBytes, contract });
  return { candidate, candidateBytes, contract };
}

/** Group quote capability is bound to the same reviewed money gateway and evaluator. */
export function composeGroupSubscriptionPricePreviewArtifacts(liveBytes, deploymentId) {
  const flow = JSON.parse(Buffer.from(liveBytes).toString('utf8'));
  const expected = {
    entry: '793d08896655392f15c13a8ef172e75651944ab84d2765204ebb5790bfb290c4',
    router: 'b66401e010790cb6b9a016f603f9867123920f5ef93806536f606ef622a39472',
  };
  if (!Array.isArray(flow) || new Set(flow.map(row => row?.id)).size !== flow.length) throw new Error('Invalid preview source');
  for (const [name, digest] of Object.entries(expected)) {
    const current = flow.find(row => row.id === PREFIX + name);
    if (current?.type !== 'function' || sha(current.func || '') !== digest) throw new Error(`Group preview preimage drift: ${name}`);
  }
  const booking = flow.find(row => row.id === 'lk_subscription_booking_router_20260804');
  const evaluator = flow.find(row => row.id === PREFIX + 'evaluate');
  const checkoutEvaluator = flow.find(row => row.id === 'lk_subscription_managed_policy_20260820');
  if (checkoutEvaluator?.func !== evaluator?.func) throw new Error('Group checkout evaluator mismatch');
  if (sha(booking?.func || '') !== '8848722f61f84e1792d2cdd69d8204be61ae66fe35c1af1d2bc7d8774f84636a'
    || sha(evaluator?.func || '') !== '6f4e7aa5506d7da4123fc0f8c86c5a310f6fc2dc86c9cc23b56ef1deaa001a72') throw new Error('Group preview money source changed');
  const identitySource = fs.readFileSync(path.join(ROOT, 'nodered_subscription_product_nodes/gateway.js'), 'utf8');
  const originalIdentity = identitySource.slice(0, identitySource.indexOf('// Monetary group discounts'))
    + identitySource.slice(identitySource.indexOf('const identityOwned ='))
      .replace(/\n {2}if \(ctx.caller === 'http' && ctx.step === 'lk1_money_owned_subscriptions'\n {4}&& resolveCategory\(exercise\) === 'group_training'\) return identityMoneyOwned\(ctx, rows\);/, '');
  // Compare exact function text before replacing the visit/money boundary.
  const oldIdentity = originalIdentity.trim();
  if (booking.func.split(oldIdentity).length !== 2) throw new Error('Group identity helper preimage drift');
  const oldMoneyRead = 'const selected = findOwnedSubscriptions({ availableClientSubscriptions: rows }, ctx.clientSubscriptionId);';
  if (booking.func.split(oldMoneyRead).length !== 2) throw new Error('Group money ownership read preimage drift');
  let moneyGateway = booking.func.replace(oldIdentity, identitySource + '\n')
    .replace(oldMoneyRead, 'const selected = findOwnedSubscriptions({ ...exercise, availableClientSubscriptions: rows }, ctx.clientSubscriptionId);');
  const gatewaySource = fs.readFileSync(path.join(ROOT, 'nodered_lk1_hub_nodes/gateway.js'), 'utf8');
  const guardStart = gatewaySource.indexOf('  // An existing operation is replayed earlier.');
  const guardEnd = gatewaySource.indexOf('  ctx.lk1.decision = JSON.parse(JSON.stringify(decision));', guardStart);
  if (guardStart < 0 || guardEnd < 0) throw new Error('Group quote guard source missing');
  const decisionMarker = '  ctx.lk1.decision = JSON.parse(JSON.stringify(decision));';
  if (moneyGateway.split(decisionMarker).length !== 2) throw new Error('Group quote decision preimage drift');
  moneyGateway = moneyGateway.replace(decisionMarker, gatewaySource.slice(guardStart, guardEnd) + decisionMarker);
  const prepareId = 'lk_subscription_booking_prepare_20260804';
  const prepare = flow.find(row => row.id === prepareId);
  const prepareSource = fs.readFileSync(path.join(ROOT, 'nodered_subscription_booking_nodes/fn_subscription_booking_prepare.js'), 'utf8');
  const expectedCopy = '  ...(body.expectedGroupDiscount !== undefined ? { expectedGroupDiscount: body.expectedGroupDiscount } : {}),\n';
  if (sha(prepare?.func || '') !== '51c7b349a18ea04300fcc8649d87601e98c3952e6c57c6cb52ae35e2cf689e15'
    || !prepareSource.includes(expectedCopy) || prepare.func.split('  caller: "http",\n').length !== 2) throw new Error('Group quote prepare preimage drift');
  const extraRoots = ['identityMoneyOwned', 'lk1LifecycleInstant', 'managedExternalEventTypeId'];
  const extra = extractSubscriptionPricePreviewSource({ source: moneyGateway, label: 'group lifecycle', roots: extraRoots });
  const existingRouter = flow.find(row => row.id === PREFIX + 'router').func;
  const marker = '// Dedicated advisory graph.';
  if (existingRouter.split(marker).length !== 2) throw new Error('Group preview boundary drift');
  // Preserve the installed GAME helper/price/usage closure byte for byte.
  const router = existingRouter.slice(0, existingRouter.indexOf(marker))
    + `Object.assign(canonical, (() => {\n${extra.source}\nreturn {${extraRoots.join(',')}}; })());\n` + read('router');
  const candidate = structuredClone(flow);
  candidate.find(row => row.id === prepareId).func = prepare.func.replace('  caller: "http",\n', '  caller: "http",\n' + expectedCopy);
  candidate.find(row => row.id === 'lk_subscription_booking_router_20260804').func = moneyGateway;
  candidate.find(row => row.id === PREFIX + 'entry').func = read('entry');
  candidate.find(row => row.id === PREFIX + 'router').func = router;
  const candidateBytes = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`);
  const contract = buildExactGraphContract({ liveBytes, candidateBytes, deploymentId,
    allowedChanges: [...['entry', 'router'].map(name => ({id: PREFIX + name, fields: ['func']})),
      { id: 'lk_subscription_booking_router_20260804', fields: ['func'] },
      { id: prepareId, fields: ['func'] }], allowedAdditionIds: [] });
  validateReviewedFlowContract({ liveBytes, candidateBytes, contract });
  return { candidate, candidateBytes, contract };
}
