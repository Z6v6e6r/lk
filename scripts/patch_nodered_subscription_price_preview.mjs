import fs from 'node:fs';
import { patchPaidBenefitUsage } from './patch_nodered_subscription_paid_join.mjs';
import path from 'node:path';
import crypto from 'node:crypto';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';
import { extractSubscriptionPricePreviewSource } from './lib/subscriptionPricePreviewSources.mjs';
import { buildHubPolicyTransition } from './lib/lk1HubPolicyTransition.mjs';
import * as eventPaymentSources from './lib/eventPaymentSources.mjs';
import { buildExactGraphContract, validateReviewedFlowContract } from './nodered_reviewed_flow_deploy/runtime_contract.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PREFIX = 'lk_subscription_price_preview_20260908_';
export const PATH = '/lk/subscriptions/game-price-preview';
const read = name => fs.readFileSync(path.join(ROOT, 'nodered_subscription_price_preview_nodes', `${name}.js`), 'utf8');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

// Exact installed preimages this composition was reviewed against. The plan-rules
// generation rewrites the booking gateway (`lk1Config` moves to the shared
// resolver) and the evaluator (cap-as-discount), so the release that ships those
// bodies must pass their reviewed sha256 through `previewSources(flow, { pins })`;
// a blind edit of the literals here would drop the review gate.
export const PREVIEW_CANONICAL_SOURCE_SHA256 = Object.freeze({
  booking: '8848722f61f84e1792d2cdd69d8204be61ae66fe35c1af1d2bc7d8774f84636a',
  evaluator: '6f4e7aa5506d7da4123fc0f8c86c5a310f6fc2dc86c9cc23b56ef1deaa001a72',
  pricing: '53c4f6ab309b4287eaded6c6d16a9c0e34f47c8eac625c58bdf423acfb083d42',
  join: '70ec2bdfad08c71a1a1ef2d851c07918906573a3802ce9f41765837494c6f462',
});
// Names the preview router calls through `canonical.*`. The resolver module and
// the HUB policy reader are embedded inside the canonical helper closure, so the
// closure has to publish them.
const PREVIEW_INJECTED_EXPORTS = Object.freeze(['resolveLk1Rule', 'normalizePlanRules', 'lk1PlanRulesGlobal',
  'lk1ReadBoundPolicy', 'lk1PolicyKey', 'lk1DesiredPolicy', 'lk1NormalizePolicy']);
const PREVIEW_INJECTED_FUNCTIONS = Object.freeze(['resolveLk1Rule', 'normalizePlanRules', 'lk1PlanRulesGlobal',
  'lk1ReadBoundPolicy', 'lk1NormalizePolicy']);
// Helpers the event route (group training / tournament quotes) reaches through
// `canonical.*`. They live in the composed booking graph, not in the preview
// node's own sources, so the closure has to declare *and* publish them: the
// router's first guard stops every event quote with `*_DISCOUNT_BACKEND_NOT_READY`
// when `canonical.identityMoneyOwned` is absent (production incident 2026-09-15),
// and `lk1LifecycleInstant`/`managedExternalEventTypeId` are called right after.
const PREVIEW_EVENT_HELPERS = Object.freeze(['identityMoneyOwned', 'lk1LifecycleInstant', 'managedExternalEventTypeId']);
const HUB_POLICY_READER_NAMES = Object.freeze(['lk1PolicyKey', 'lk1DesiredPolicy', 'lk1NormalizePolicy', 'lk1ReadBoundPolicy']);
const RULES_MODULE_PATH = path.join(ROOT, 'lib/lk1PlanRules.mjs');
const normalizeDeclarationText = value => value.replace(/\s+/g, '');
// The reviewed module text has exactly one source: `planRulesSource()` in
// scripts/lib/eventPaymentSources.mjs, the same helper `hubGatewaySource()` uses.
// The local read keeps this branch composable before that helper is merged in.
const planRulesModuleText = () => (typeof eventPaymentSources.planRulesSource === 'function'
  ? eventPaymentSources.planRulesSource()
  : fs.readFileSync(RULES_MODULE_PATH, 'utf8').replace(/^export /gm, ''));
// Contract constants the extracted helper closure references but does not own.
// `identityOwned`/`identityMoneyOwned` come from the product identity source,
// which only *references* the HUB product id; once the gateway's `lk1Config`
// moved to the resolver, nothing pulled that declaration into the closure and the
// composed node failed at runtime with a bare ReferenceError.
const PREVIEW_CONTRACT_ROOTS = Object.freeze(['LK1_OVERLAY_HUB_PRODUCT_ID', 'MANAGED_ENFORCEMENT_PURCHASE_FROM']);
// Host globals the Node-RED VM provides that look like contract constants.
const PREVIEW_HOST_CONSTANTS = Object.freeze(['JSON', 'NaN', 'Infinity']);
// Any other undeclared SCREAMING_CASE name in the closure means the composition
// silently dropped a reviewed declaration, so it must stop the release.
const undeclaredContractNames = (source, declared) => {
  const file = ts.createSourceFile('closure.js', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  const referenced = new Set();
  const visit = node => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return;
    if (ts.isIdentifier(node)) {
      const parent = node.parent;
      const isNonReference = (ts.isPropertyAccessExpression(parent) && parent.name === node)
        || (ts.isPropertyAssignment(parent) && parent.name === node)
        || (ts.isPropertyDeclaration(parent) && parent.name === node)
        || (ts.isMethodDeclaration(parent) && parent.name === node)
        || (ts.isFunctionDeclaration(parent) && parent.name === node)
        || (ts.isVariableDeclaration(parent) && parent.name === node)
        || (ts.isParameter(parent) && parent.name === node);
      if (!isNonReference && /^[A-Z][A-Z0-9_]{2,}$/.test(node.text)) referenced.add(node.text);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...referenced].filter(name => !declared.has(name) && !PREVIEW_HOST_CONSTANTS.includes(name));
};

/** The closure must declare every contract constant its members reference. */
const assertNoUndeclaredContractNames = (helperSource, declared, rules, reader, accessor) => {
  const missing = undeclaredContractNames(`${helperSource}\n${rules.injected}\n${reader}\n${accessor}`, declared);
  if (missing.length) {
    throw new Error(`Price preview helper closure references undeclared contract constants: ${missing.join(', ')}. `
      + 'Add them to PREVIEW_CONTRACT_ROOTS when they are reviewed constants, or restore their declaration.');
  }
};

/** Top-level declarations of a Node-RED body, in source order, one name each. */
const topLevelDeclarations = (source, label) => {
  const file = ts.createSourceFile(`${label}.js`, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  if (file.parseDiagnostics.some(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)) {
    throw new Error(`Price preview ${label} source does not parse`);
  }
  const declarations = [];
  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      declarations.push({ name: statement.name.text, text: statement.getText(file).replace(/^export\s+/, '') });
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;
    const keyword = statement.declarationList.flags & ts.NodeFlags.Let ? 'let' : 'const';
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      declarations.push({ name: declaration.name.text, text: `${keyword} ${declaration.getText(file)};` });
    }
  }
  return declarations;
};

/** Normalised top-level declaration texts of a closure, keyed by name. */
const declarationMap = source => new Map(topLevelDeclarations(source, 'closure')
  .map(declaration => [declaration.name, normalizeDeclarationText(declaration.text)]));

/** The installed HUB policy the booking gateway binds in its node initializer. */
const installedHubPolicy = node => {
  const text = typeof node?.initialize === 'string' ? node.initialize : '';
  const matched = /const lk1DesiredPolicy = (\{[^;]*\});/.exec(text);
  if (!matched) return null;
  try { return JSON.parse(matched[1]); } catch { return null; }
};

/**
 * The shared resolver, embedded as generated declarations inside the canonical
 * helper closure so `resolveLk1Rule` can reach `collectSubscriptionPurchaseDateEvidence`,
 * `collectExactProductIds` and `isValidDateKey`. A module declaration the
 * installed body already carries is never declared twice; when it is already
 * there it must match the module text, because a diverging local copy would
 * silently outrank the reviewed one.
 */
const planRulesEmbedding = declared => {
  const moduleSource = planRulesModuleText();
  const globalName = /const LK1_PLAN_RULES_GLOBAL = "([A-Za-z0-9_]+)"/.exec(moduleSource);
  if (!globalName) throw new Error('Price preview plan rules module has no LK1_PLAN_RULES_GLOBAL constant');
  const moduleDeclarations = topLevelDeclarations(moduleSource, 'lk1PlanRules');
  const injected = moduleDeclarations.filter(declaration => !declared.has(declaration.name))
    .map(declaration => declaration.text).join('\n');
  for (const declaration of moduleDeclarations) {
    const text = normalizeDeclarationText(declaration.text);
    const present = declared.get(declaration.name);
    if (present !== undefined && !present.includes(text)) {
      throw new Error(`Price preview plan rules declaration ${declaration.name} differs from the installed body`);
    }
    declared.set(declaration.name, text);
  }
  return { injected, globalName: globalName[1] };
};
const replaceEventTariffBlock = source => {
  const start = 'if (ctx.step === "lk1_event_tariff") {';
  const end = 'if (ctx.step === "lk1_operation_find") {';
  const desired = fs.readFileSync(path.join(ROOT, 'nodered_lk1_hub_nodes/gateway.js'), 'utf8');
  for (const text of [source, desired]) {
    if (text.split(start).length !== 2 || text.split(end).length !== 2
      || text.indexOf(start) >= text.indexOf(end)) throw new Error('Group tariff boundary drift');
  }
  return source.slice(0, source.indexOf(start))
    + desired.slice(desired.indexOf(start), desired.indexOf(end)) + source.slice(source.indexOf(end));
};
const node = (z, name, outputs, wires, source = null) => ({ id: `${PREFIX}${name}`, type: 'function', z, name: `Subscription price preview ${name}`, func: source ?? read(name), outputs, timeout: 0, noerr: 0, initialize: '', finalize: '', libs: [], x: 680, y: 1000, wires });

/** Names a router body reaches through `canonical.*`, in first-use order. */
export function canonicalReferences(body) {
  return [...new Set([...String(body).matchAll(/\bcanonical\.([A-Za-z_$][\w$]*)/g)].map(match => match[1]))];
}

/**
 * The generated helper closure has to publish every `canonical.<name>` the router
 * body reaches. This is a build-time gate on the exact generated text: a helper
 * that the composition forgets to export fails the release instead of failing the
 * first production request (2026-09-15: the event-route guard 503'd every group
 * training and tournament quote because three installed-only helpers were dropped).
 */
export function assertCanonicalExports(body, exported, label = 'Price preview') {
  const missing = canonicalReferences(body).filter(name => !exported.includes(name));
  if (missing.length) {
    throw new Error(`${label} canonical closure is missing referenced helpers: ${missing.join(', ')}`);
  }
}

export function previewSources(flow, options = {}) {
  const pins = { ...PREVIEW_CANONICAL_SOURCE_SHA256, ...(options.pins || {}) };
  const pin = (label, actual, expected) => {
    if (actual === expected) return;
    throw new Error(`Price preview canonical ${label} source changed: actual ${actual}, expected ${expected}. `
      + `Re-review that installed generation and pass its sha256 through previewSources(flow, { pins: { ${label}: "<sha256>" } }).`);
  };
  const nodeOf = id => {
    const matches = flow.filter(row => row.id === id && row.type === 'function');
    if (matches.length !== 1) throw new Error('Price preview canonical source missing');
    return matches[0];
  };
  const bookingNode = nodeOf('lk_subscription_booking_router_20260804');
  const booking = bookingNode.func;
  const split = nodeOf('8f7bd5b482fe9763').func;
  pin('booking', sha(booking), pins.booking);
  pin('pricing', sha(split), pins.pricing);
  const roots = ['isObj', 'isValidDateKey', 'unwrapRecord', 'extractItems', 'hasCompleteBookingList', 'bookingId', 'bookingClientId',
    'normalizeId', 'collectExactProductIds', 'collectSubscriptionPurchaseDateEvidence', 'identityOwned', 'lk1Config', 'lk1Fields',
    ...PREVIEW_EVENT_HELPERS, 'preflightAvailability',
    ...PREVIEW_CONTRACT_ROOTS,
    'mergeBookings', 'isInactiveBooking', 'isSubscriptionBooking', 'bookingSubscriptionId', 'eventDate',
    'eventDurationMinutes', 'eventStartsAt', 'exerciseRoomId', 'resolveCategory', 'resolvePlanKey', 'compatibilityPlanKey', 'PLAN_CATEGORIES', 'resolveLimitMode'];
  const joinSource = nodeOf('e92e68bf3f08a70c').func;
  pin('join', sha(joinSource), pins.join);
  const join = extractSubscriptionPricePreviewSource({ source: joinSource, label: 'join', roots: ['resolveIsSinglesGame'] });
  const joinPricing = `const joinPricing = (() => {\n${join.source}\nreturn { resolveIsSinglesGame }; })();`;
  const helper = extractSubscriptionPricePreviewSource({ source: booking, label: 'booking', roots });
  const prices = extractSubscriptionPricePreviewSource({ source: split, label: 'pricing', roots: ['extractExactCourtPrice', 'extractList'] });
  // No emitter/transport/state machine may enter the extracted helper closure.
  if ([...helper.names, ...prices.names].some(name => ['ctx', 'emit', 'prepareHttp', 'prepareOperationFind', 'prepareBookingCreate'].includes(name))) {
    throw new Error('Price preview helper closure escaped pure calculations');
  }
  // The resolver and the HUB policy reader are generated declarations of the
  // canonical closure itself: the resolver needs the closure's date/product
  // helpers, and the reader is what HUB quotes fail closed on.
  const declared = declarationMap(helper.source);
  const rules = planRulesEmbedding(declared);
  const missingReader = HUB_POLICY_READER_NAMES.filter(name => !declared.has(name));
  let reader = '';
  if (missingReader.length === HUB_POLICY_READER_NAMES.length) {
    const desired = installedHubPolicy(bookingNode);
    if (!desired) throw new Error('Price preview cannot embed the HUB policy reader: the installed booking node has no lk1DesiredPolicy initializer');
    reader = buildHubPolicyTransition({ expectedPrior: null, desired }).reader;
    for (const name of HUB_POLICY_READER_NAMES) declared.set(name, 'generated');
  } else if (missingReader.length) {
    throw new Error(`Price preview HUB policy reader is partially installed: ${missingReader.join(', ')}`);
  }
  const accessor = declared.has('lk1PlanRulesGlobal') ? ''
    : `const lk1PlanRulesGlobal = () => global.get(${JSON.stringify(rules.globalName)});`;
  if (accessor) declared.set('lk1PlanRulesGlobal', 'generated');
  const exported = [...roots, ...PREVIEW_INJECTED_EXPORTS.filter(name => declared.has(name))];
  assertNoUndeclaredContractNames(helper.source, declared, rules, reader, accessor);
  const usageStart = 'if (ctx.step === "lk1_usage_operations") {';
  const usageEnd = 'if (ctx.step === "lk1_policy_decision") {';
  if (booking.split(usageStart).length !== 2 || booking.split(usageEnd).length !== 2) throw new Error('Price preview allowance source drift');
  // The installed generation already carries the paid-visit recompute *and* the
  // AUDIT_BINDING guard, so `patchPaidBenefitUsage` cannot be re-applied to it (its
  // reviewed preimages are the pre-paid-join shape). When the caller pins the exact
  // installed block sha, reuse it verbatim: the review gate moves from
  // "preimage + transform" to "installed block sha", and the preview allowance stays
  // byte-identical to the booking gateway block by construction.
  const installedUsage = booking.slice(booking.indexOf(usageStart), booking.indexOf(usageEnd));
  const usage = options.installedUsageSha256 === undefined ? patchPaidBenefitUsage(installedUsage)
    : sha(installedUsage) === options.installedUsageSha256 ? installedUsage
      : (() => { throw new Error(`Price preview installed allowance block changed: actual ${sha(installedUsage)}, expected ${options.installedUsageSha256}`); })();
  const canonical = `const canonical = (() => {\n${helper.source}\n${rules.injected}\n${reader}\n${accessor}\nreturn {${exported.join(',')}}; })();`;
  const pricing = `const pricing = (() => {\n${prices.source}\nreturn { extractExactCourtPrice, extractList }; })();`;
  const usageFunction = `const canonicalUsage = msg => { const ctx = msg._subscriptionBooking;
    const { isObj, isValidDateKey, normalizeId, isInactiveBooking, eventDate, bookingSubscriptionId, bookingId, resolveCategory, eventDurationMinutes, lk1Fields } = canonical;
    const OUTPUT_MANAGED_POLICY = 6;
    const emit = () => msg;
    const lk1Stop = (_context, code) => { msg.previewError = code; return msg; };
    ${usage}
  };`;
  const evaluator = nodeOf('lk_subscription_managed_policy_20260820').func;
  pin('evaluator', sha(evaluator), pins.evaluator);
  const router = `${canonical}\n${pricing}\n${joinPricing}\n${usageFunction}\n${read('router')}`;
  // Compose-time proof that the generated node is executable and that the router
  // can really reach the resolver the way it calls it. The same proof covers every
  // other `canonical.*` helper the router reaches, not only the injected ones.
  new Function('msg', 'node', 'env', 'global', router);
  const scope = new Function('global', `${router.slice(0, router.indexOf('\nconst pricing'))}\nreturn canonical;`)({ get: () => null });
  for (const name of [...PREVIEW_INJECTED_FUNCTIONS, ...PREVIEW_EVENT_HELPERS]) {
    if (typeof scope[name] !== 'function') throw new Error(`Price preview canonical export is missing: ${name}`);
  }
  assertCanonicalExports(read('router'), exported);
  return { router, evaluator, helperNames: helper.names, pricingNames: prices.names, exportedNames: [...exported] };
}

export function composeSubscriptionPricePreviewFlow(flow, options = {}) {
  if (!Array.isArray(flow) || flow.some(row => !row || typeof row.id !== 'string') || new Set(flow.map(row => row.id)).size !== flow.length) throw new Error('Invalid Node-RED source flow');
  if (flow.some(row => row.id.startsWith(PREFIX) || (row.type === 'http in' && row.url === PATH))) throw new Error('Price preview route already exists');
  const bookingFind = flow.find(row => row.id === 'lk_subscription_booking_find_20260804');
  if (!bookingFind || bookingFind.type !== 'mongodb4' || bookingFind.operation !== 'find' || bookingFind.collection !== 'lk_subscription_daily_booking_ops' || !flow.some(row => row.id === bookingFind.clientNode && row.type === 'mongodb4-client')) throw new Error('Price preview Mongo dependency drift');
  const sources = previewSources(flow, options);
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

export function composeSubscriptionPricePreviewArtifacts(liveBytes, deploymentId, options = {}) {
  const candidate = composeSubscriptionPricePreviewFlow(JSON.parse(Buffer.from(liveBytes).toString('utf8')), options);
  const candidateBytes = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`);
  const allowedAdditionIds = candidate.filter(row => row.id.startsWith(PREFIX)).map(row => row.id);
  const contract = buildExactGraphContract({ liveBytes, candidateBytes, deploymentId, allowedChanges: [], allowedAdditionIds });
  validateReviewedFlowContract({ liveBytes, candidateBytes, contract });
  return { candidate, candidateBytes, contract, sourceSha256: sha(liveBytes) };
}

/** Upgrade an existing preview without replacing routes, shared gateways or policy state. */
export function composeSubscriptionJoinPricePreviewArtifacts(liveBytes, deploymentId, options = {}) {
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
  const composed = composeSubscriptionPricePreviewFlow(base, options);
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
export function composeGroupSubscriptionPricePreviewArtifacts(liveBytes, deploymentId, options = {}) {
  const pins = { ...PREVIEW_CANONICAL_SOURCE_SHA256, ...(options.pins || {}) };
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
  if (sha(booking?.func || '') !== pins.booking
    || sha(evaluator?.func || '') !== pins.evaluator) throw new Error('Group preview money source changed');
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
  moneyGateway = replaceEventTariffBlock(moneyGateway);
  const prepareId = 'lk_subscription_booking_prepare_20260804';
  const prepare = flow.find(row => row.id === prepareId);
  // Keep the generic frozen DEV prepare source intact. This field belongs only
  // to the exact group-capable graph, alongside its expected-price guard.
  const expectedCopy = '  ...(body.expectedGroupDiscount !== undefined ? { expectedGroupDiscount: body.expectedGroupDiscount } : {}),\n';
  if (sha(prepare?.func || '') !== '51c7b349a18ea04300fcc8649d87601e98c3952e6c57c6cb52ae35e2cf689e15'
    || prepare.func.split('  caller: "http",\n').length !== 2) throw new Error('Group quote prepare preimage drift');
  // The same event-route helpers the paid composition publishes inside the closure;
  // this historical packet keeps publishing them through the installed overlay.
  const extraRoots = [...PREVIEW_EVENT_HELPERS];
  const extra = extractSubscriptionPricePreviewSource({ source: moneyGateway, label: 'group lifecycle', roots: extraRoots });
  const existingRouter = flow.find(row => row.id === PREFIX + 'router').func;
  const marker = '// Dedicated advisory graph.';
  if (existingRouter.split(marker).length !== 2) throw new Error('Group preview boundary drift');
  // This historical exact-preimage packet retains the installed daily-only
  // gateway/usage pair. Do not mix it with the current paid preview's all-date
  // operation query; the combined paid release needs its own fresh contract.
  const currentOperations = "return find('operations', { tenantKey: ctx.tenantKey, actorClientId: ctx.actorClientId,\n    'lk1.rule.productId':";
  const routerBody = read('router');
  if (routerBody.split(currentOperations).length !== 2) throw new Error('Group daily operation query anchor drift');
  const legacyRouterBody = routerBody.replace(currentOperations,
    "return find('operations', { tenantKey: ctx.tenantKey, actorClientId: ctx.actorClientId,\n    serviceDate: ctx.target.startsAt.slice(0, 10), 'lk1.rule.productId':");
  // Preserve the installed GAME helper/price/usage closure byte for byte.
  const router = existingRouter.slice(0, existingRouter.indexOf(marker))
    + `Object.assign(canonical, (() => {\n${extra.source}\nreturn {${extraRoots.join(',')}}; })());\n` + legacyRouterBody;
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

/** Repair the installed group capability without rebuilding its shared graph. */
export function composeGroupSubscriptionTariffFixArtifacts(liveBytes, deploymentId, options = {}) {
  const pins = { ...PREVIEW_CANONICAL_SOURCE_SHA256, ...(options.pins || {}) };
  const flow = JSON.parse(Buffer.from(liveBytes).toString('utf8'));
  if (!Array.isArray(flow) || new Set(flow.map(row => row?.id)).size !== flow.length) throw new Error('Invalid tariff source');
  const expected = {
    lk_subscription_booking_router_20260804: 'f7bf647210421212ae447c4778e391347c3533eba35b0616c463f444df8b6782',
    [PREFIX + 'router']: 'c09e6756640aafd11de9d96412ecd5a09fc5a6a102729afc05ccca84424005e0',
  };
  for (const [id, digest] of Object.entries(expected)) {
    const current = flow.find(row => row.id === id);
    if (current?.type !== 'function' || sha(current.func || '') !== digest) throw new Error(`Group tariff preimage drift: ${id}`);
  }
  for (const id of [PREFIX + 'evaluate', 'lk_subscription_managed_policy_20260820']) {
    if (sha(flow.find(row => row.id === id)?.func || '') !== pins.evaluator) {
      throw new Error('Group tariff evaluator drift');
    }
  }
  const candidate = structuredClone(flow);
  const booking = candidate.find(row => row.id === 'lk_subscription_booking_router_20260804');
  booking.func = replaceEventTariffBlock(booking.func);
  const router = candidate.find(row => row.id === PREFIX + 'router');
  const start = "if (ctx.step === 'groupTariff') {";
  const end = "if (ctx.step === 'evaluate') {";
  const desired = read('router');
  for (const source of [router.func, desired]) {
    if (source.split(start).length !== 2 || source.split(end).length !== 2
      || source.indexOf(start) >= source.indexOf(end)) throw new Error('Group tariff preview boundary drift');
  }
  // The installed daily usage/query contract must survive newer paid-visit sources.
  router.func = router.func.slice(0, router.func.indexOf(start))
    + desired.slice(desired.indexOf(start), desired.indexOf(end)) + router.func.slice(router.func.indexOf(end));
  const candidateBytes = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`);
  const contract = buildExactGraphContract({ liveBytes, candidateBytes, deploymentId,
    allowedChanges: Object.keys(expected).map(id => ({ id, fields: ['func'] })), allowedAdditionIds: [] });
  validateReviewedFlowContract({ liveBytes, candidateBytes, contract });
  return { candidate, candidateBytes, contract };
}
