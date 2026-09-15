// Preview == booking: the advisory preview resolves the plan rule with the same
// shared resolver the booking gateway embeds (scripts/lib/lk1PlanRules.mjs) and
// hands the evaluator exactly the policy input the write path would hand it.
// Node-RED function bodies cannot import, so the release builder embeds the
// resolver into the router's sandbox scope; this harness reproduces that embed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import vm from 'node:vm';
import { extractSubscriptionPricePreviewSource } from '../lib/subscriptionPricePreviewSources.mjs';
import { buildHubPolicyTransition } from '../lib/lk1HubPolicyTransition.mjs';

const read = relative => fs.readFileSync(new URL(relative, import.meta.url), 'utf8');
// Line A owns scripts/lib/lk1PlanRules.mjs. Until that module lands in this
// branch the test reads the resolver from the sibling worktree (or from
// LK1_PLAN_RULES_MODULE) and skips rather than pretending to verify parity.
const resolverCandidates = [process.env.LK1_PLAN_RULES_MODULE].filter(Boolean)
  .concat(['../lib/lk1PlanRules.mjs', '/private/tmp/lk1-rules-a-hub/scripts/lib/lk1PlanRules.mjs']);
const resolverPath = resolverCandidates.find(candidate => {
  try {
    fs.accessSync(candidate.startsWith('/') ? candidate : new URL(candidate, import.meta.url));
    return true;
  } catch { return false; }
});
const requiresResolver = { skip: resolverPath ? false : 'Line A module scripts/lib/lk1PlanRules.mjs is not available in this worktree' };
const library = resolverPath ? fs.readFileSync(resolverPath.startsWith('/') ? resolverPath
  : new URL(resolverPath, import.meta.url), 'utf8') : '';
const router = read('../nodered_subscription_price_preview_nodes/router.js');
// Line B owns scripts/nodered_lk1_hub_nodes/evaluator.js and lands the
// cap-as-discount decision. Until it reaches this branch the parity half of the
// suite is graded against that sibling worktree revision (or LK1_EVALUATOR_MODULE).
const evaluatorCandidates = [process.env.LK1_EVALUATOR_MODULE].filter(Boolean)
  .concat(['../nodered_lk1_hub_nodes/evaluator.js',
    '/private/tmp/lk1-rules-b-evaluator/scripts/nodered_lk1_hub_nodes/evaluator.js']);
const evaluatorPath = evaluatorCandidates.find(candidate => {
  try {
    const text = fs.readFileSync(candidate.startsWith('/') ? candidate : new URL(candidate, import.meta.url), 'utf8');
    return text.includes('aboveActiveLimit');
  } catch { return false; }
});
const evaluator = evaluatorPath ? fs.readFileSync(evaluatorPath.startsWith('/') ? evaluatorPath
  : new URL(evaluatorPath, import.meta.url), 'utf8') : fs.readFileSync(new URL('../nodered_lk1_hub_nodes/evaluator.js', import.meta.url), 'utf8');
const sources = {
  booking: read('../nodered_subscription_booking_nodes/fn_subscription_booking_router.js'),
  gateway: read('../nodered_lk1_hub_nodes/gateway.js'),
  hooks: read('../nodered_lk1_hub_nodes/gateway_hooks.js'),
  product: read('../nodered_subscription_product_nodes/gateway.js'),
  split: read('../nodered_games_nodes/fn_split_router.js'),
};
const constant = name => {
  const matched = new RegExp(`(?:export )?const ${name} = ("[^"]*")`).exec(library);
  assert.ok(matched, `Resolver constant ${name} must stay a literal in scripts/lib/lk1PlanRules.mjs`);
  return JSON.parse(matched[1]);
};
const RULE_FIELDS = JSON.parse(/const LK1_PLAN_RULE_FIELDS = (\[[^\]]*\])/.exec(library)[1]);
const HUB_PRODUCT_ID = constant('LK1_HUB_PRODUCT_ID');
const PLAN_FROM = constant('LK1_PLAN_RULES_FROM');
const PLAN_RULES_GLOBAL = constant('LK1_PLAN_RULES_GLOBAL');
const policy = { productId: HUB_PRODUCT_ID };
for (const field of RULE_FIELDS) policy[field] = { maxActiveBookings: 4, freeGameMinutesPerDay: 60,
  gameOverageDiscountPercent: 30, groupTrainingDiscountPercent: 50, tournamentDiscountPercent: 50 }[field];
const HUB_POLICY_GLOBAL = 'subscriptions_lk1_product_policy';
// Plan products named by the rollout contract (docs/LK1_ENFORCEMENT_ROLLOUT_COORDINATION.md §1).
const RA = 'b91e14d1-fe6e-4d0b-be39-3e45ad86b759';
const FRIENDSHIP = 'b2e6a9d4-53b5-4f79-87ec-3fb076381e9b';
const PROMO = '6bda152b-0a9c-4308-82d0-3cd4e6aa680d';
const UNKNOWN = '5a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d';

// Canonical helper closure: the roots the release builder extracts for the
// preview node, resolved across the node sources that compose the booking graph.
const ROOTS = ['isObj', 'unwrapRecord', 'isValidDateKey', 'hasCompleteBookingList', 'bookingId', 'bookingClientId',
  'normalizeId', 'collectExactProductIds', 'collectSubscriptionPurchaseDateEvidence', 'normalizePurchaseDateMoscow',
  'mergeBookings', 'isInactiveBooking', 'isSubscriptionBooking', 'bookingSubscriptionId', 'eventDate',
  'eventDurationMinutes', 'eventStartsAt', 'exerciseRoomId', 'resolveCategory', 'resolvePlanKey',
  'compatibilityPlanKey', 'PLAN_CATEGORIES', 'resolveLimitMode', 'extractItems', 'managedExternalEventTypeId',
  'identitySelected', 'identityOwned', 'identityMoneyOwned', 'lk1LifecycleInstant', 'lk1Fields', 'lk1Config'];
const declared = new Set();
const parts = [];
for (const root of ROOTS) {
  let extracted = null;
  for (const source of Object.values(sources)) {
    try { extracted = extractSubscriptionPricePreviewSource({ source, label: root, roots: [root] }); break; } catch { /* next source */ }
  }
  assert.ok(extracted, `Cannot extract canonical helper ${root}`);
  // The extractor returns dependencies first, so shared helpers are declared
  // once and each later root contributes only what is still missing.
  const file = ts.createSourceFile(`${root}.js`, extracted.source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      if (declared.has(statement.name.text)) continue;
      declared.add(statement.name.text);
      parts.push(statement.getText(file));
      continue;
    }
    // A variable statement may carry several declarations; only the ones that
    // are still missing may enter, never a shared dependency that is already in.
    const fresh = statement.declarationList.declarations.filter(declaration => ts.isIdentifier(declaration.name)
      && !declared.has(declaration.name.text));
    for (const declaration of fresh) declared.add(declaration.name.text);
    if (!fresh.length) continue;
    const keyword = statement.declarationList.flags & ts.NodeFlags.Let ? 'let' : 'const';
    parts.push(`${keyword} ${fresh.map(declaration => declaration.getText(file)).join(', ')};`);
  }
}
const helperSource = parts.join('\n');
// The court tariff extractor is the same canonical helper the release builds in.
const priceSource = extractSubscriptionPricePreviewSource({ source: sources.split, label: 'pricing',
  roots: ['extractExactCourtPrice', 'extractList'] }).source;
// The allowance recompute the preview embeds: the booking gateway's own
// instance-scoped block, so the free-minute ledger cannot drift between them.
const usageStart = 'if (ctx.step === "lk1_usage_operations") {';
const usageEnd = 'if (ctx.step === "lk1_policy_decision") {';
assert.equal(sources.gateway.split(usageStart).length, 2, 'Booking gateway allowance block must exist');
assert.equal(sources.gateway.split(usageEnd).length, 2);
const usageBody = sources.gateway.slice(sources.gateway.indexOf(usageStart), sources.gateway.indexOf(usageEnd));
const usageSource = `const canonicalUsage = msg => { const ctx = msg._subscriptionBooking;
  const { isObj, isValidDateKey, normalizeId, isInactiveBooking, eventDate, bookingSubscriptionId, bookingId, resolveCategory, eventDurationMinutes, lk1Fields } = canonical;
  const OUTPUT_MANAGED_POLICY = 6;
  const emit = () => msg;
  const lk1Stop = (_context, code) => { msg.previewError = code; return msg; };
${usageBody}
};`;
// `resolveSplitSubscriptionLifecycle`/`filterSplitEligibleSubscriptions` reach the
// node as the transpiled availability helper, exactly like the release build.
const availability = ts.transpileModule(read('../../src/components/games/splitSubscriptionAvailability.ts'), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText;
assert.doesNotMatch(availability, /\brequire\s*\(/);
// Only the resolver module's own declarations are embedded: the node scope
// already owns `isValidDateKey` (canonical), so re-declaring it would collide.
const libraryDeclarations = (() => {
  const file = ts.createSourceFile('lk1PlanRules.mjs', library, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  return file.statements.filter(statement => ts.isFunctionDeclaration(statement)
    || ts.isVariableStatement(statement)).map(statement => statement.getText(file)
      .replace(/^export\s+/, '')).join('\n');
})();
// One composed scope per request: a factory keeps the resolver, the canonical
// helper closure and the router body in the same sandbox scope, exactly like
// the release builder's embedded node body.
const entrySource = read('../nodered_subscription_price_preview_nodes/entry.js');
const finalSource = read('../nodered_subscription_price_preview_nodes/final.js');
// A stop in the preview is a hard refusal of the whole batch; the driver turns
// the recorded code into an explicit failure instead of a silent empty quote.
const tracedRouter = router
  .replace("const stop = (code, status = 503) => {",
    "const stop = (code, status = 503) => { if (typeof lk1PlanTrace === 'function') lk1PlanTrace('STOP ' + code);");
// The resolver and the HUB policy reader live inside the canonical helper
// closure: the resolver's transitive dependencies are const declarations of that
// closure and are not visible at node scope, and the reader is the same
// generated declaration the live gateway calls through `lk1Config`.
const hubReader = buildHubPolicyTransition({ expectedPrior: null, desired: policy }).reader;
const routerFactorySource = `const canonical = (() => {\n${hubReader}\n${helperSource}\n${libraryDeclarations}\nconst lk1PlanRulesGlobal = () => global.get(${JSON.stringify(PLAN_RULES_GLOBAL)});\nreturn {${ROOTS.join(',')}, resolveLk1Rule, normalizePlanRules, lk1PlanRulesGlobal}; })();
const preflightAvailability = (() => { const exports = {}; \n${availability}\n return exports; })();
Object.assign(canonical, { preflightAvailability });
${usageSource}
const pricing = (() => {\n${priceSource}\nreturn { extractExactCourtPrice, extractList }; })();
const joinPricing = { resolveIsSinglesGame: () => false };
const lk1PlanTrace = (code, stepName) => { if (global.__trace) global.__trace.push([code, stepName]); };
const __router = (msg, global, node) => {
${tracedRouter}
};
const __entry = (msg, global, node) => {
${entrySource}
};
const __final = (msg, global, node) => {
${finalSource}
};
return { canonical, entry: __entry, router: __router, final: __final };`;
const createScope = vm.compileFunction(routerFactorySource, ['global', 'node'], { parsingContext: vm.createContext({}) });
/** One composed sandbox scope with the rule globals the preview reads. */
const previewScope = (options = {}) => {
  const globals = { [HUB_POLICY_GLOBAL]: options.hubPolicy === undefined ? policy : options.hubPolicy,
    [PLAN_RULES_GLOBAL]: options.planRules === undefined ? planRulesGlobal(options.planRows || []) : options.planRules };
  const host = { get: key => globals[key], __trace: [] };
  return { host, scope: createScope(host, { warn() {} }) };
};
const routerOutputs = (scope, host, msg) => {
  const outputs = scope.router(msg, host, { warn() {} });
  const index = Array.isArray(outputs) ? outputs.findIndex(Boolean) : -1;
  assert.ok(index >= 0, 'Every preview step must terminate on a wired output');
  const refusals = (host.__trace || []).filter(entry => String(entry[0]).startsWith('STOP '));
  host.__trace = [];
  if (refusals.length) throw new Error('stop: ' + JSON.stringify(refusals));
  return outputs[index];
};

const EVALUATOR = vm.compileFunction(evaluator, ['msg'], { parsingContext: vm.createContext({}) });

const planRule = (productId, planKey, enforceFrom = PLAN_FROM) => ({ productId, planKey, enforceFrom,
  maxActiveBookings: policy.maxActiveBookings, freeGameMinutesPerDay: policy.freeGameMinutesPerDay,
  gameOverageDiscountPercent: policy.gameOverageDiscountPercent,
  groupTrainingDiscountPercent: policy.groupTrainingDiscountPercent,
  tournamentDiscountPercent: policy.tournamentDiscountPercent });
const planRulesGlobal = rows => ({ formatVersion: 1, rules: rows.map(({ productId, planKey, enforceFrom }) =>
  planRule(productId, planKey, enforceFrom === undefined ? PLAN_FROM : enforceFrom)) });
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const actor = uuid(1), station = uuid(2), room = uuid(3), master = uuid(4), service = uuid(5);
const startsAt = '2099-09-21T07:00:00+03:00';
const target = { targetKind: 'NEW_GAME', slotId: 'slot:fixture', stationId: station, roomId: room,
  masterServiceId: master, subServiceIds: [service], startsAt, durationMinutes: 90, shareCount: 4 };
const subscription = (productId, extra = {}) => ({ subscriptionId: uuid(20), status: 'ACTIVE',
  purchaseDate: `${PLAN_FROM}T06:40:26`, activationDate: '2026-09-02T12:22:12', expirationDate: '2100-09-07',
  visitsLeft: 40, hasStudioLimitation: false, hasTypeLimitation: true, availableTypes: [{ id: 1613 }],
  hasDirectionLimitation: true, availableDirections: [{ id: 4588 }],
  product: { id: productId, name: 'Fixture plan' }, ...extra });
// The evaluator keeps its {"ineligible", "eligible"} project/enforce wiring; the
// decision is attached to whichever port the node emits on.
const evaluation = input => {
  const outputs = EVALUATOR({ _managedSubscriptionPolicyInput: input });
  const emitted = outputs[0] || outputs[1];
  return emitted ? emitted._managedSubscriptionPolicyDecision : null;
};

/** Drive the real preview state machine with stubbed provider reads. */
function preview(options = {}) {
  const subscriptions = options.subscriptions || [subscription(HUB_PRODUCT_ID)];
  const planRows = (options.planProducts || []).map((productId, index) =>
    ({ productId, planKey: index === 0 ? 'ra' : 'promo_academy' }));
  const globals = { [HUB_POLICY_GLOBAL]: options.hubPolicy === undefined ? policy : options.hubPolicy,
    [PLAN_RULES_GLOBAL]: options.planRules === undefined ? planRulesGlobal(planRows) : options.planRules,
    // The game router reads the room/studio tariff through the admin service token.
    vivacrm_access_token: 'fixture-admin', vivacrm_token_expires_at: Date.now() + 60000 };
  const host = { get: key => globals[key], __trace: [] };
  const scope = createScope(host, { warn() {} });
  const instanceKey = id => JSON.stringify(['instance', 'iSkq6G', actor, id]);
  const instances = options.instances || subscriptions.map(row => ({ _id: instanceKey(row.subscriptionId),
    kind: 'instance', tenantKey: 'iSkq6G', actorClientId: actor, subscriptionId: row.subscriptionId,
    productId: row.product.id }));
  const catalog = [...new Set(subscriptions.map(row => row.product.id))].map(productId =>
    ({ _id: JSON.stringify(['product', 'iSkq6G', productId]), kind: 'product', tenantKey: 'iSkq6G',
      productId, name: 'Fixture plan' }));
  const provider = {
    subscriptions: { content: subscriptions, totalElements: subscriptions.length },
    activeBookings: { content: options.active || [], totalElements: (options.active || []).length },
    historyBookings: { content: options.history || [], totalElements: (options.history || []).length },
    metadata: instances, catalog, operations: options.operations || [],
    room: { id: room }, studios: [{ id: station }], subservices: [{ id: service }],
    // Viva scopes the exact tariff by sub-service id; the canonical extractor
    // reads that envelope (major units) and the router converts to minor ones.
    price: options.price || { [service]: { calculation: { fixture: { basePrice: { valueFrom: 2800 }, impacts: [] } } } },
  };
  const findings = [];
  const request = { req: { headers: { authorization: 'Bearer fixture-user' } },
    payload: { target: { ...target, ...options.target },
      subscriptionIds: options.ids || subscriptions.map(row => row.subscriptionId) } };
  // entry/final return `msg`; the router returns one message per output port.
  let message = scope.entry(request, host, { warn() {} });
  for (let hop = 0; hop < 200; hop++) {
    const ctx = message._subscriptionPricePreview;
    assert.ok(ctx, `Preview lost its state machine at hop ${hop}`);
    if (ctx.step === 'profile') message = { ...message, statusCode: 200, payload: { id: actor } };
    else if (ctx.step === 'evaluate') {
      const decided = evaluation(message._managedSubscriptionPolicyInput);
      findings.push({ input: message._managedSubscriptionPolicyInput, decision: decided });
      message = { ...message, _managedSubscriptionPolicyDecision: decided };
    } else if (provider[ctx.step]) {
      // Mongo reads carry no HTTP status; provider reads must look successful.
      const database = ['metadata', 'catalog', 'operations'].includes(ctx.step);
      message = { ...message, payload: provider[ctx.step], ...(database ? {} : { statusCode: 200 }) };
    }
    const next = routerOutputs(scope, host, message);
    if (next === undefined) return finish(scope.final(message, host, { warn() {} }), findings, scope);
    // The quote loop marks the batch complete (`done` without `error`) and only
    // then emits the collected quotes; `final` is what strips the preview state.
    if (next._subscriptionPricePreview.done && !next._subscriptionPricePreview.error) {
      return finish(scope.final({ ...next, _subscriptionPricePreview: { ...next._subscriptionPricePreview, step: 'complete' } },
        host, { warn() {} }), findings, scope);
    }
    message = next;
  }
  throw new Error('Preview state machine did not terminate');
}
const finish = (message, findings, scope) => ({ statusCode: message.statusCode,
  quotes: message.payload?.quotes || [], error: message.payload?.error?.code, findings, scope });
const soleQuote = result => {
  assert.equal(result.error, undefined, `Preview failed: ${result.error}`);
  assert.equal(result.quotes.length, 1);
  return result.quotes[0];
};

test('the preview node scope is bound to the shared resolver, not a local rule copy', requiresResolver, () => {
  assert.match(router, /canonical\.resolveLk1Rule\(/);
  assert.match(router, /owned, planRules/);
  assert.doesNotMatch(router, /lk1PolicyKey|lk1DesiredPolicy/);
  // The only local rule knowledge left is the guarded HUB-only legacy fallback.
  assert.equal((router.match(/canonical\.lk1Config\(owned\)/g) || []).length, 1);
  // The node scope receives the resolver as a generated declaration, not as a
  // `canonical.*` property copy, and it is the resolver the contract names.
  const scope = preview({ subscriptions: [subscription(RA)], planProducts: [RA] }).scope;
  assert.equal(typeof scope.canonical.resolveLk1Rule, 'function');
  const hub = scope.canonical.resolveLk1Rule({ owned: [{ productId: HUB_PRODUCT_ID }] });
  assert.equal(hub.matched, true);
  assert.equal(hub.legacy, false);
  assert.equal(hub.source, 'HUB');
  assert.equal(hub.rule.productId, HUB_PRODUCT_ID);
  const plan = scope.canonical.resolveLk1Rule({ owned: [{ productId: RA, purchaseDate: `${PLAN_FROM}T00:00:00` }],
    planRules: planRulesGlobal([{ productId: RA, planKey: 'ra' }]) });
  assert.equal(plan.source, 'PLAN');
  assert.equal(plan.productId, RA);
  assert.equal(plan.enforceFrom, PLAN_FROM);
  assert.equal(plan.legacy, false);
});

test('plan product sold on the boundary is quoted from the plan rule', requiresResolver, () => {
  const quote = soleQuote(preview({ subscriptions: [subscription(RA)], planProducts: [RA] }));
  assert.equal(quote.status, 'AVAILABLE');
  assert.deepEqual([quote.freeMinutes, quote.paidMinutes], [60, 30]);
  assert.equal(quote.reasonCode, null);
});

test('plan product sold before the boundary keeps legacy behaviour', requiresResolver, () => {
  const quote = soleQuote(preview({ subscriptions: [subscription(RA, { purchaseDate: '2026-08-31T20:00:00' })],
    planProducts: [RA] }));
  assert.equal(quote.amountMinor, 0);
  assert.equal(quote.freeMinutes, 90);
  assert.equal(quote.reasonCode, null);
});

test('a product without a rule is never discounted and never stopped', requiresResolver, () => {
  // The resolver decides the contour, so an unrecognised product must come back
  // as an untouched legacy subscription rather than an error.
  const { scope } = previewScope({ planRows: [{ productId: RA, planKey: 'ra' }] });
  const configured = scope.canonical.resolveLk1Rule({ owned: [{ productId: UNKNOWN, purchaseDate: `${PLAN_FROM}T00:00:00` }],
    planRules: planRulesGlobal([{ productId: RA, planKey: 'ra' }]) });
  assert.equal(configured.matched, false);
  assert.equal(configured.code, undefined);
  // A subscription the provider cannot serve is quoted as legacy/unavailable
  // without consulting the managed evaluator at all.
  const legacy = preview({ subscriptions: [subscription(HUB_PRODUCT_ID, { expirationDate: '2026-01-01' })],
    planProducts: [RA] });
  assert.equal(soleQuote(legacy).status, 'UNAVAILABLE');
  assert.equal(soleQuote(legacy).amountMinor, null);
  assert.equal(legacy.findings.length, 0);
  assert.equal(legacy.statusCode, 200);
});

test('the plan discount is the rule number, not a hardcoded half', requiresResolver, () => {
  const rows = planRulesGlobal([{ productId: RA, planKey: 'ra' }]);
  rows.rules[0].gameOverageDiscountPercent = 45;
  const [finding] = preview({ subscriptions: [subscription(RA)], planProducts: [RA], planRules: rows }).findings;
  assert.equal(finding.input.lk1Policy.gameOverageDiscountPercent, 45);
  assert.equal(finding.input.lk1ProductBinding.policyProductId, RA);
  assert.equal(finding.input.lk1ProductBinding.ownedProductId, RA);
});

test('the quote equals the evaluator decision the write path commits', requiresResolver, () => {
  const result = preview({ subscriptions: [subscription(RA)], planProducts: [RA] });
  const quote = soleQuote(result);
  const [finding] = result.findings;
  assert.equal(finding.decision.eligible, true);
  assert.equal(quote.amountMinor, finding.decision.benefit.finalPriceMinor);
  assert.equal(quote.freeMinutes, finding.decision.gameMinutes.freeMinutes);
  assert.equal(quote.paidMinutes, finding.decision.gameMinutes.paidOverageMinutes);
  assert.equal(finding.decision.subscriptionVisitCount, 1);
  assert.equal(finding.decision.benefit.kind, 'PARTIAL_PRICE_PERCENT_DISCOUNT');
  assert.equal(finding.decision.benefit.partialPriceCalculation.percentageDiscountMinor,
    Math.floor(Math.floor(70000 * 30 / 90) * policy.gameOverageDiscountPercent / 100));
});

test('four and five active bookings stay bookable at the discount, without a visit', requiresResolver, () => {
  for (const count of [4, 5]) {
    const active = Array.from({ length: count }, (_, index) => ({ id: uuid(100 + index),
      clientSubscriptionId: uuid(20), paymentType: 'SUBSCRIPTION',
      exerciseDate: '2099-09-22T07:00:00+03:00', timeFrom: '2099-09-22T07:00:00+03:00',
      timeTo: '2099-09-22T08:00:00+03:00', exerciseId: uuid(200 + index),
      exerciseType: { id: 1613 }, exerciseDirection: { id: 4588 } }));
    const result = preview({ subscriptions: [subscription(RA)], planProducts: [RA], active });
    const quote = soleQuote(result);
    const [finding] = result.findings;
    assert.equal(quote.status, 'AVAILABLE');
    assert.equal(quote.amountMinor, finding.decision.benefit.finalPriceMinor);
    assert.deepEqual([quote.freeMinutes, quote.paidMinutes], [0, 90]);
    assert.equal(finding.decision.aboveActiveLimit, true);
    assert.equal(finding.decision.subscriptionVisitCount, 0);
    assert.equal(finding.decision.benefit.kind, 'PERCENT_DISCOUNT');
    assert.equal(finding.decision.gameMinutes.freeMinutes, 0);
    assert.equal(finding.decision.gameMinutes.paidOverageMinutes, 90);
    assert.equal(finding.input.usage.activeServices, count);
  }
});

test('three active bookings still receive the free hour and consume one visit', requiresResolver, () => {
  const active = Array.from({ length: 3 }, (_, index) => ({ id: uuid(120 + index),
    clientSubscriptionId: uuid(20), paymentType: 'SUBSCRIPTION',
    exerciseDate: '2099-09-22T07:00:00+03:00', timeFrom: '2099-09-22T07:00:00+03:00',
    timeTo: '2099-09-22T08:00:00+03:00', exerciseId: uuid(220 + index),
    exerciseType: { id: 1613 }, exerciseDirection: { id: 4588 } }));
  const result = preview({ subscriptions: [subscription(RA)], planProducts: [RA], active });
  const quote = soleQuote(result);
  const [finding] = result.findings;
  assert.equal(finding.decision.aboveActiveLimit, false);
  assert.equal(finding.decision.subscriptionVisitCount, 1);
  assert.equal(quote.amountMinor, finding.decision.benefit.finalPriceMinor);
  assert.deepEqual([quote.freeMinutes, quote.paidMinutes],
    [finding.decision.gameMinutes.freeMinutes, finding.decision.gameMinutes.paidOverageMinutes]);
});

test('the HUB product stays on without a sale-date gate', requiresResolver, () => {
  const result = preview({ subscriptions: [subscription(HUB_PRODUCT_ID, { purchaseDate: '2026-08-15T09:00:00' })] });
  const quote = soleQuote(result);
  assert.equal(quote.status, 'AVAILABLE');
  assert.equal(quote.amountMinor, result.findings[0].decision.benefit.finalPriceMinor);
  assert.equal(result.findings[0].decision.benefit.kind, 'PARTIAL_PRICE_PERCENT_DISCOUNT');
  assert.equal(result.findings[0].decision.aboveActiveLimit, false);
});

test('fail-closed: an unprovable sale date stops the whole batch', requiresResolver, () => {
  for (const extra of [{ purchaseDate: undefined }, { purchaseDate: 'not-a-date' },
    { purchaseDate: '2026-09-05T10:00:00', purchaseAt: '2026-08-31T10:00:00' }]) {
    // The sale date is proven while the selected product is resolved, so the
    // refusal happens before any quote can be advertised.
    assert.throws(() => preview({ subscriptions: [subscription(RA, extra)], planProducts: [RA] }),
      /SUBSCRIPTION_PURCHASE_DATE_UNRESOLVED/);
  }
});

test('fail-closed: a malformed plan-rules global is an invalid-rule stop', requiresResolver, () => {
  const malformed = { formatVersion: 1, rules: [{ ...planRule(RA, 'ra'), surplus: 1 }] };
  assert.throws(() => preview({ subscriptions: [subscription(RA)], planProducts: [RA], planRules: malformed }),
    /LK1_PLAN_RULES_INVALID/);
});

test('an absent plan-rules global leaves plan products legacy, without an error', requiresResolver, () => {
  for (const planRules of [null, '']) {
    const result = preview({ subscriptions: [subscription(RA)], planProducts: [RA], planRules });
    const quote = soleQuote(result);
    assert.equal(quote.amountMinor, 0);
    assert.equal(quote.reasonCode, null);
  }
});

test('promo products follow the same Viva sale date rule', requiresResolver, () => {
  // D2: a promo pass uses purchaseDate/purchaseAt exactly like the other plan
  // products, so a sale on the boundary is managed and an earlier one is not.
  const current = preview({ subscriptions: [subscription(PROMO)], planProducts: [PROMO] });
  assert.equal(soleQuote(current).status, 'AVAILABLE');
  assert.equal(current.findings.length, 1);
  // A pre-boundary promo sale is not managed. The preview's legacy branch still
  // needs the legacy plan-name resolver to advertise a place; that limitation is
  // reported as NEEDS_DECISION, because the resolver contour itself is correct.
  const { scope } = previewScope({ planRows: [{ productId: PROMO, planKey: 'promo_academy' }] });
  const beforeBoundary = scope.canonical.resolveLk1Rule({ owned: [subscription(PROMO, { purchaseDate: '2026-08-31T23:30:00' })],
    planRules: planRulesGlobal([{ productId: PROMO, planKey: 'promo_academy' }]) });
  assert.equal(beforeBoundary.matched, true);
  assert.equal(beforeBoundary.legacy, true);
  assert.equal(beforeBoundary.rule, undefined);
});

test('the resolver accepts the JSON-encoded global and prioritises the plan product', requiresResolver, () => {
  const encoded = JSON.stringify(planRulesGlobal([{ productId: FRIENDSHIP, planKey: 'friendship' }]));
  const result = preview({ subscriptions: [subscription(FRIENDSHIP)], planProducts: [FRIENDSHIP], planRules: encoded });
  assert.equal(soleQuote(result).status, 'AVAILABLE');
});

test('the preview keeps the evaluator binding and usage scope the write path uses', requiresResolver, () => {
  const result = preview({ subscriptions: [subscription(RA)], planProducts: [RA] });
  const [finding] = result.findings;
  assert.deepEqual({ ...finding.input.lk1ProductBinding }, { policyProductId: RA, ownedProductId: RA,
    clientSubscriptionId: uuid(20) });
  assert.equal(finding.input.usage.activeServiceScope, 'SUBSCRIPTION_BENEFIT_ONLY');
  assert.equal(finding.input.usage.dailyBucketLocalDate, startsAt.slice(0, 10));
  assert.equal(finding.input.target.resolutionSource, 'SERVER');
  assert.equal(finding.input.target.category, 'GAME');
  assert.equal(finding.input.action, 'CREATE_GAME');
  for (const field of RULE_FIELDS) {
    assert.equal(finding.input.lk1Policy[field], policy[field]);
    assert.equal(Object.keys(finding.input.lk1Policy).includes('productId'), false);
  }
});

test('every preview transport step is a read', requiresResolver, () => {
  assert.doesNotMatch(router, /insertOne|updateOne|\/split\/create|global\.set/);
  assert.match(router, /\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}/);
});
