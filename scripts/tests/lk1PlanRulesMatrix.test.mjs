/**
 * Line T — LK1 plan-rules acceptance matrix.
 *
 * Independent verification of the frozen contract
 * `docs/LK1_ENFORCEMENT_ROLLOUT_COORDINATION.md` (§0 goal, §1 globals,
 * §2/§2.1 resolver semantics, §3 evaluator semantics, §7 acceptance criteria).
 *
 * Independence rules honoured here:
 *  - no product code is imported as a source of truth; behaviour is observed by
 *    executing the Node-RED function bodies (evaluator, hub gateway quote
 *    closure) and by driving the preview pricing branch through those
 *    observations;
 *  - fixtures are synthetic (`scripts/tests/fixtures/lk1PlanRules/*`): no PII,
 *    no tokens, no live payloads;
 *  - cases whose preconditions need lines A/B/C are skipped with an explicit
 *    `LK1_PLAN_RULES_NOT_INTEGRATED` reason instead of being silently dropped.
 *
 * Sources are read from `HEAD:` (deterministic committed revision) with a
 * working-tree fallback, so a concurrently edited sibling worktree cannot make
 * this file flaky. `LK1_MATRIX_SOURCE_ROOT=<dir>` overrides the root.
 *
 * Run: node --test scripts/tests/lk1PlanRulesMatrix.test.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { extractSubscriptionPricePreviewSource } from '../lib/subscriptionPricePreviewSources.mjs';
import {
  HUB_PRODUCT_ID,
  PLAN_PRODUCTS,
  UNKNOWN_PRODUCTS,
} from './fixtures/lk1PlanRules/products.js';
import {
  DISABLED_PLAN_RULES,
  ENFORCE_FROM,
  HUB_POLICY,
  INVALID_PLAN_RULES,
  LK1_HUB_POLICY_GLOBAL,
  LK1_PLAN_RULES_GLOBAL,
  PLAN_RULES_DOCUMENT,
  RULE_NUMBERS,
  ruleFieldsOf,
} from './fixtures/lk1PlanRules/planRules.js';
import {
  ACTOR_CLIENT_ID,
  CLIENT_SUBSCRIPTION_ID,
  PURCHASE_DATES,
  RA_PRODUCT_ID,
  mismatchedRecord,
  subscriptionRecord,
} from './fixtures/lk1PlanRules/subscriptions.js';
import {
  GROUP_TRAINING_60,
  LEGACY_CARRIER_PRICE_MINOR,
  OPEN_GAME_60,
  OPEN_GAME_90,
  PRICES,
  TOURNAMENT_60,
  tariffProof,
} from './fixtures/lk1PlanRules/exercises.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const SOURCE_ROOT = process.env.LK1_MATRIX_SOURCE_ROOT
  ? path.resolve(process.env.LK1_MATRIX_SOURCE_ROOT)
  : REPO_ROOT;
const SKIP_REASON = 'LK1_PLAN_RULES_NOT_INTEGRATED';

/** Deterministic committed source (falls back to the working tree). */
const sourceText = relative => {
  try {
    return execFileSync('git', ['show', `HEAD:${relative}`], {
      cwd: SOURCE_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return fs.readFileSync(path.join(SOURCE_ROOT, relative), 'utf8');
  }
};

const EVALUATOR = sourceText('scripts/nodered_lk1_hub_nodes/evaluator.js');
const ROUTER = sourceText('scripts/nodered_subscription_booking_nodes/fn_subscription_booking_router.js');

// ---------------------------------------------------------------------------
// Observation harness 1: the real evaluator function body.
// ---------------------------------------------------------------------------

/**
 * Optional post-integration self-check: run the very same expected values
 * against a candidate evaluator that already implements contract §3
 * (`LK1_MATRIX_POSTCHECK=1 LK1_MATRIX_POSTCHECK_EVALUATOR=<file>`). This proves
 * the expectations are attainable, not merely aspirational.
 */
const CANDIDATE_EVALUATOR = process.env.LK1_MATRIX_POSTCHECK === '1'
  && process.env.LK1_MATRIX_POSTCHECK_EVALUATOR
  ? fs.readFileSync(process.env.LK1_MATRIX_POSTCHECK_EVALUATOR, 'utf8')
  : null;

const runEvaluatorSource = (source, input) => {
  const msg = { _managedSubscriptionPolicyInput: structuredClone(input) };
  // No isolated parsing context: Node-RED function bodies run in the flow realm,
  // and a foreign realm would break prototype-based deep comparison of results.
  const outputs = vm.compileFunction(source, ['msg'])(msg);
  const routed = (outputs[0] || outputs[1]) || msg;
  return { decision: routed._managedSubscriptionPolicyDecision, allowed: Boolean(outputs[0]) };
};

const runEvaluator = input => runEvaluatorSource(EVALUATOR, input);

const POLICY_PROJECTION = {
  runtimeSchemaVersion: 1,
  subscriptionTypeId: 'fixture-type',
  policyVersion: 1,
  status: 'PUBLISHED',
  effectiveAt: '2026-08-01T00:00:00.000Z',
  timeZone: 'Europe/Moscow',
  createGame: { enabled: true, durationsMinutes: [60, 90, 120] },
  joinGame: { enabled: true, minDurationMinutes: 60, maxDurationMinutes: 120 },
  activeServicesLimit: { enabled: true, max: 4, scope: 'SUBSCRIPTION_BENEFIT_ONLY' },
  bookingWindow: { enabled: true, days: 14 },
  dailyUsageLimit: 1,
  usageUnitsByDuration: { 60: 1, 90: 1, 120: 1 },
  stationAccessRules: [],
  benefitRules: [],
  lifecycle: { allowBookingsAfterExpiry: false },
  usage: {
    weeklyUsageLimit: null,
    monthlyUsageLimit: null,
    maxFutureBookings: null,
    minHoursBetweenUses: 0,
    blackoutDates: [],
  },
};

/**
 * Builds the evaluator input for one decision-matrix cell.
 * `rule: null` means «no contour»: only the legacy CUP projection is supplied,
 * exactly as the gateway does for legacy cohorts.
 */
const decisionInput = ({
  action = 'JOIN_GAME',
  category = 'GAME',
  exercise = OPEN_GAME_60,
  rule,
  used = 0,
  activeServices = 0,
  binding = null,
  basePriceMinor = PRICES.OPEN_GAME_60,
} = {}) => {
  const target = {
    resolutionSource: 'SERVER',
    eventId: exercise.id,
    category,
    externalEventTypeId: 'viva:direction:4588:type:1613',
    productTypeId: null,
    stationId: exercise.studio.id,
    roomId: exercise.room.id,
    durationMinutes: exercise.durationMinutes,
    startsAt: `${exercise.timeFrom}+03:00`,
    basePriceMinor: rule ? basePriceMinor : LEGACY_CARRIER_PRICE_MINOR,
    currency: 'RUB',
    ...(rule ? { priceSource: 'VIVA_EXISTING_TARIFF' } : {}),
  };
  const input = {
    evaluatedAt: '2026-09-15T08:00:00.000Z',
    action,
    policy: structuredClone(POLICY_PROJECTION),
    instance: {
      subscriptionInstanceId: 'fixture-instance',
      subscriptionTypeId: 'fixture-type',
      policyVersion: 1,
      state: 'ACTIVE',
      activeFrom: '2026-08-01T00:00:00.000Z',
      activeTo: '2027-08-01T23:59:59.999Z',
      homeStationId: exercise.studio.id,
      frozenUntil: null,
      noShowBlockedUntil: null,
    },
    target,
    usage: {
      activeServiceScope: 'SUBSCRIPTION_BENEFIT_ONLY',
      dailyBucketLocalDate: '2099-09-20',
      activeServices,
      dailyUsed: 0,
      weeklyUsed: 0,
      monthlyUsed: 0,
      futureBookings: 0,
      activeServiceStartsAt: [],
      ...(rule ? { usedOrReservedFreeMinutesToday: used } : {}),
    },
  };
  if (rule) {
    input.lk1Policy = ruleFieldsOf(rule);
    if (binding) input.lk1ProductBinding = binding;
  }
  return input;
};

/** `{ policyProductId, ownedProductId, clientSubscriptionId }` (contract §3.1). */
const bindingOf = productId => ({
  policyProductId: productId,
  ownedProductId: productId,
  clientSubscriptionId: CLIENT_SUBSCRIPTION_ID,
});

const decide = (input, evaluatorSource = EVALUATOR) => {
  const { decision, allowed } = runEvaluatorSource(evaluatorSource, input);
  assert.ok(decision, 'evaluator must publish a decision');
  assert.equal(allowed, decision.eligible, 'evaluator routing must follow eligibility');
  return { decision, finalPriceMinor: decision.benefit?.finalPriceMinor ?? null };
};

// ---------------------------------------------------------------------------
// Observation harness 2: the hub gateway quote closure (lk1Config/lk1Quote).
// The tracked sources do not carry the generated policy readers, so the harness
// recreates those declaration fragments from the fixtures. Any failure to
// compose or execute the closure is reported as «not integrated» (skip), never
// as a false green.
// ---------------------------------------------------------------------------

const hasDeclaration = (source, name) => new RegExp(`(?:^|\\n)(?:const|let|var|function)\\s+${name}\\b`).test(source);

const buildGatewayHarness = () => {
  const files = {
    hooks: sourceText('scripts/nodered_lk1_hub_nodes/gateway_hooks.js'),
    router: ROUTER,
    gateway: sourceText('scripts/nodered_lk1_hub_nodes/gateway.js'),
  };
  const helperRoots = [
    'MANAGED_ENFORCEMENT_PURCHASE_FROM', 'MANAGED_ENFORCEMENT_PURCHASE_TIME_ZONE',
    'toStr', 'isObj', 'normalizeId', 'normalizeDate', 'isValidDateKey',
    'normalizePurchaseDateMoscow', 'findOwnedSubscriptions',
    'collectSubscriptionPurchaseDateEvidence', 'exerciseRoomId', 'findArrayForKey',
    'managedExternalEventTypeId', 'resolveCategory', 'finiteDate', 'eventStartsAt',
    'eventDurationMinutes', 'managedTargetCategory', 'collectExactProductIds',
  ];
  const gatewayRoots = ['lk1Config', 'lk1Quote', 'lk1Fingerprint', 'lk1DiscountOwned', 'lk1QuoteOwned', 'lk1LifecycleInstant'];
  const parts = [];
  const taken = new Set();
  for (const [label, source, roots] of [
    ['hooks', files.hooks, helperRoots],
    ['router', files.router, helperRoots],
    ['gateway', files.gateway, gatewayRoots],
  ]) {
    const wanted = roots.filter(name => !taken.has(name) && hasDeclaration(source, name));
    if (!wanted.length) continue;
    const extracted = extractSubscriptionPricePreviewSource({ source, label, roots: wanted });
    for (const name of extracted.names) taken.add(name);
    parts.push(`// ${label}\n${extracted.source}`);
  }
  if (!hasDeclaration(files.gateway, 'lk1Quote') || !hasDeclaration(files.gateway, 'lk1Config')) return null;
  // Production injects the policy readers at generation time; recreate them here
  // under the frozen names (contract §2): `lk1ReadBoundPolicy()` for
  // `subscriptions_lk1_product_policy` and `lk1ReadPlanRules()` for
  // `subscriptions_lk1_plan_rules`.
  const readers = [
    `const lk1ReadBoundPolicy = () => global.get(${JSON.stringify(LK1_HUB_POLICY_GLOBAL)});`,
    `const lk1ReadPlanRules = () => global.get(${JSON.stringify(LK1_PLAN_RULES_GLOBAL)});`,
  ].join('\n');
  const body = `${parts.join('\n')}\n${readers}`;
  const store = new Map([
    [LK1_HUB_POLICY_GLOBAL, structuredClone(HUB_POLICY)],
    [LK1_PLAN_RULES_GLOBAL, structuredClone(PLAN_RULES_DOCUMENT)],
  ]);
  const globalScope = {
    get: key => (store.has(key) ? store.get(key) : null),
    set: (key, value) => { store.set(key, value); },
  };
  const scope = vm.compileFunction(`${body}\nreturn { lk1Config, lk1Quote };`, ['global'])(globalScope);
  return { ...scope, store };
};

const harnessBuild = (() => {
  try {
    const harness = buildGatewayHarness();
    if (!harness) return { why: 'gateway closure could not be composed from HEAD sources' };
    const probe = harness.lk1Config([subscriptionRecord({
      productId: RA_PRODUCT_ID,
      purchaseDate: PURCHASE_DATES.boundary,
    })]);
    return { harness, probe };
  } catch (error) {
    return { why: `gateway closure is not executable yet (${error?.message || error})` };
  }
})();
const HARNESS = harnessBuild.harness || null;
// `lk1Config` accepting a plan product is the observable resolver-integration
// marker: pre-integration it is HUB-only and answers `{ matched: false }`.
const RESOLVER_INTEGRATED = Boolean(harnessBuild.probe?.matched === true);
// The evaluator accepting `policyProductId` of the selected plan product is the
// observable evaluator-integration marker.
const EVALUATOR_INTEGRATED = (() => {
  try {
    return runEvaluator(decisionInput({
      rule: ruleFieldsOf(PLAN_RULES_DOCUMENT.rules[0]),
      binding: bindingOf(RA_PRODUCT_ID),
    })).decision?.eligible === true;
  } catch {
    return false;
  }
})();
const CAP_CONTRACT_INTEGRATED = (() => {
  try {
    const { decision } = runEvaluator(decisionInput({
      rule: ruleFieldsOf(HUB_POLICY), binding: bindingOf(HUB_PRODUCT_ID), activeServices: 5,
    }));
    return Object.hasOwn(decision || {}, 'aboveActiveLimit')
      && !(decision?.blockers || []).some(row => row.code === 'ACTIVE_SERVICES_LIMIT_REACHED');
  } catch {
    return false;
  }
})();
const PREVIEW_INTEGRATED = RESOLVER_INTEGRATED && EVALUATOR_INTEGRATED && CAP_CONTRACT_INTEGRATED;
const markers = `resolver=${RESOLVER_INTEGRATED ? 'ok' : 'absent'}`
  + ` evaluator=${EVALUATOR_INTEGRATED ? 'ok' : 'plan-binding-invalid'}`
  + ` cap=${CAP_CONTRACT_INTEGRATED ? 'ok' : 'above-cap-blocking'}`;
const notIntegrated = () => (PREVIEW_INTEGRATED ? false : `${SKIP_REASON}: ${markers}`);

// ---------------------------------------------------------------------------
// Pricing helpers shared by preview and booking observations.
// ---------------------------------------------------------------------------

const priceOf = exercise => (exercise === OPEN_GAME_90 ? PRICES.OPEN_GAME_90
  : exercise === GROUP_TRAINING_60 ? PRICES.GROUP_TRAINING_60
    : exercise === TOURNAMENT_60 ? PRICES.TOURNAMENT_60 : PRICES.OPEN_GAME_60);

const categoryOf = exercise => (exercise === GROUP_TRAINING_60 ? 'GROUP_TRAINING'
  : exercise === TOURNAMENT_60 ? 'TOURNAMENT' : 'GAME');

const actionOf = category => (category === 'GAME' ? 'JOIN_GAME'
  : category === 'GROUP_TRAINING' ? 'BOOK_GROUP_TRAINING' : 'BOOK_TOURNAMENT');

const bookingDecision = ({ exercise, rule, used = 0, activeServices = 0, productId }, evaluatorSource) => decide(decisionInput({
  action: actionOf(categoryOf(exercise)),
  category: categoryOf(exercise),
  exercise,
  rule,
  used,
  activeServices,
  binding: rule ? bindingOf(productId) : null,
  basePriceMinor: priceOf(exercise),
}), evaluatorSource);

/**
 * Reproduces the observable preview outcome for one subscription input.
 * Legacy (no rule) → the whole duration is a free entitlement and one visit is
 * used (mechanism A stays untouched); enforced → the evaluator decision drives
 * the price and the visit count, as the preview router does after integration.
 */
const simulatePreview = ({ exercise, rule, used = 0, activeServices = 0, productId }, evaluatorSource) => {
  if (!rule) {
    return {
      kind: 'LEGACY_FREE_ENTITLEMENT',
      finalPriceMinor: 0,
      freeMinutes: exercise.durationMinutes,
      paidMinutes: 0,
      visitCount: 1,
      reasonCode: null,
    };
  }
  const { decision } = bookingDecision({ exercise, rule, used, activeServices, productId }, evaluatorSource);
  return {
    kind: decision.benefit?.kind || null,
    finalPriceMinor: decision.benefit?.finalPriceMinor ?? null,
    freeMinutes: decision.gameMinutes?.freeMinutes ?? 0,
    paidMinutes: decision.gameMinutes?.paidOverageMinutes ?? exercise.durationMinutes,
    visitCount: decision.subscriptionVisitCount ?? 0,
    reasonCode: decision.blockers?.[0]?.code || null,
  };
};

const ruleForProduct = productId => {
  const rule = PLAN_RULES_DOCUMENT.rules.find(row => row.productId === productId);
  return rule ? ruleFieldsOf(rule) : null;
};

// Quote fixtures for the gateway harness.
const quoteExercise = () => structuredClone(OPEN_GAME_60);
const quoteContext = () => {
  const exercise = quoteExercise();
  return {
    caller: 'split',
    actorClientId: ACTOR_CLIENT_ID,
    clientSubscriptionId: CLIENT_SUBSCRIPTION_ID,
    managedAction: 'JOIN_GAME',
    exerciseId: exercise.id,
    lk1TariffProof: tariffProof({ exercise, amountMinor: PRICES.OPEN_GAME_60 }),
  };
};

// ---------------------------------------------------------------------------
// Fixture self-checks: the matrix must not silently drift from the contract.
// ---------------------------------------------------------------------------

test('fixtures encode the frozen rule numbers, products and dates (§1)', () => {
  assert.deepEqual(RULE_NUMBERS, {
    maxActiveBookings: 4,
    freeGameMinutesPerDay: 60,
    gameOverageDiscountPercent: 30,
    groupTrainingDiscountPercent: 50,
    tournamentDiscountPercent: 50,
  });
  assert.equal(ENFORCE_FROM, '2026-09-01');
  assert.equal(PLAN_RULES_DOCUMENT.formatVersion, 1);
  assert.equal(PLAN_RULES_DOCUMENT.rules.length, PLAN_PRODUCTS.length);
  assert.equal(new Set(PLAN_RULES_DOCUMENT.rules.map(row => row.productId)).size, PLAN_PRODUCTS.length);
  for (const rule of PLAN_RULES_DOCUMENT.rules) {
    assert.match(rule.productId, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.equal(rule.enforceFrom, ENFORCE_FROM);
    assert.equal(rule.planKey, PLAN_PRODUCTS.find(product => product.productId === rule.productId).planKey);
  }
  assert.equal(HUB_POLICY.productId, HUB_PRODUCT_ID);
  assert.ok(!PLAN_PRODUCTS.some(product => product.productId === HUB_PRODUCT_ID));
  assert.equal(UNKNOWN_PRODUCTS[0].productId, 'dfa72adf-233b-4285-8d69-e5eab4234fbe');
  for (const date of Object.values(PURCHASE_DATES)) assert.match(date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(PURCHASE_DATES.planBeforeBoundary < ENFORCE_FROM);
  assert.equal(PURCHASE_DATES.boundary, ENFORCE_FROM);
  for (const shape of INVALID_PLAN_RULES) assert.ok(shape.name && shape.value, shape.name);
  assert.equal(DISABLED_PLAN_RULES.length, 3);
  assert.equal(mismatchedRecord({
    priority: 'identity', priorityProductId: RA_PRODUCT_ID, otherProductId: HUB_PRODUCT_ID,
    purchaseDate: PURCHASE_DATES.boundary,
  }).lk1ProductIdentity.productId, RA_PRODUCT_ID);
});

// ---------------------------------------------------------------------------
// §7.1, §7.3, §7.6 + §2 — gating: product × sales date through lk1Config/lk1Quote.
// ---------------------------------------------------------------------------

const gatingCases = [
  {
    id: 'gating/hub-2026-08-15',
    expected: 'HUB always enforced → { matched: true, rule.productId = HUB, legacy: false }',
    owned: subscriptionRecord({ productId: HUB_PRODUCT_ID, purchaseDate: PURCHASE_DATES.hubBeforeContour }),
    currentBase: 'matched=false — HUB wrongly date-gated before 2026-09-01',
  },
  ...PLAN_PRODUCTS.flatMap(product => ([
    {
      id: `gating/${product.key}-2026-08-31`,
      expected: 'legacy (sold before enforceFrom) → { matched: true, legacy: true }',
      owned: subscriptionRecord({ productId: product.productId, purchaseDate: PURCHASE_DATES.planBeforeBoundary }),
      expectLegacy: true,
      currentBase: 'LK1_PRODUCT_RULE_CHANGED (no plan resolver)',
    },
    {
      id: `gating/${product.key}-2026-09-01`,
      expected: 'enforced (boundary inclusive, Europe/Moscow) → { matched: true, legacy: false, rule.productId = product }',
      owned: subscriptionRecord({ productId: product.productId, purchaseDate: PURCHASE_DATES.boundary }),
      currentBase: 'LK1_PRODUCT_RULE_CHANGED / matched=false',
    },
  ])),
  ...UNKNOWN_PRODUCTS.map(product => ({
    id: `gating/${product.key}-2026-09-01`,
    expected: 'legacy, no rule → { matched: false }',
    owned: subscriptionRecord({ productId: product.productId, purchaseDate: PURCHASE_DATES.boundary }),
    expectUnmatched: true,
    currentBase: 'matched=false (legacy) — already matches contract',
  })),
  {
    id: 'gating/plan-2026-08-31T23:59-moscow',
    expected: 'Moscow calendar date is 2026-08-31 → legacy',
    owned: subscriptionRecord({ productId: RA_PRODUCT_ID, purchaseDate: '2026-08-31T23:59:00+03:00' }),
    expectLegacy: true,
    currentBase: 'LK1_PRODUCT_RULE_CHANGED (no plan resolver)',
  },
  {
    id: 'gating/plan-2026-09-01T00:00-moscow',
    expected: 'Moscow calendar date is 2026-09-01 → enforced',
    owned: subscriptionRecord({ productId: RA_PRODUCT_ID, purchaseDate: '2026-09-01T00:00:00+03:00' }),
    currentBase: 'LK1_PRODUCT_RULE_CHANGED / matched=false',
  },
  {
    id: 'gating/plan-2026-08-31T21:30-utc-is-2026-09-01-moscow',
    expected: 'UTC 2026-08-31T21:30Z is 2026-09-01 in Moscow → enforced',
    owned: subscriptionRecord({ productId: RA_PRODUCT_ID, purchaseDate: '2026-08-31T21:30:00Z' }),
    currentBase: 'LK1_PRODUCT_RULE_CHANGED / matched=false',
  },
  {
    id: 'gating/plan-date-unresolved',
    expected: 'fail-closed code SUBSCRIPTION_PURCHASE_DATE_UNRESOLVED (never legacy, never silent enforce)',
    owned: subscriptionRecord({ productId: RA_PRODUCT_ID, purchaseDate: 'not-a-date' }),
    expectCode: 'SUBSCRIPTION_PURCHASE_DATE_UNRESOLVED',
    currentBase: 'LK1_PRODUCT_RULE_CHANGED (code not reachable for plan products)',
  },
  {
    id: 'gating/plan-two-dates',
    expected: 'two distinct sales dates on the selected instance → SUBSCRIPTION_PURCHASE_DATE_UNRESOLVED',
    owned: [
      subscriptionRecord({ productId: RA_PRODUCT_ID, purchaseDate: PURCHASE_DATES.boundary }),
      subscriptionRecord({ productId: RA_PRODUCT_ID, purchaseDate: PURCHASE_DATES.planBeforeBoundary }),
    ],
    expectCode: 'SUBSCRIPTION_PURCHASE_DATE_UNRESOLVED',
    currentBase: 'LK1_PRODUCT_RULE_CHANGED (code not reachable for plan products)',
  },
];

test('§7.1/§7.3/§7.6 gating: product × sales date selects enforce / legacy / unmatched', { skip: notIntegrated() }, () => {
  assert.ok(HARNESS, 'gateway harness must be available when the contour is integrated');
  for (const entry of gatingCases) {
    const configured = HARNESS.lk1Config(entry.owned);
    const label = `${entry.id}: ${entry.expected}`;
    if (entry.expectUnmatched) {
      assert.equal(configured.matched, false, label);
      assert.equal(configured.code, undefined, label);
      continue;
    }
    assert.equal(configured.matched, true, label);
    if (entry.expectCode) {
      const quote = HARNESS.lk1Quote(quoteContext(), quoteExercise(), entry.owned);
      assert.equal(quote.code, entry.expectCode, label);
      assert.notEqual(quote.legacy, true, label);
      continue;
    }
    assert.equal(configured.code, undefined, label);
    if (entry.expectLegacy) {
      const quote = HARNESS.lk1Quote(quoteContext(), quoteExercise(), entry.owned);
      assert.equal(quote.legacy, true, label);
      assert.equal(quote.code, undefined, label);
      continue;
    }
    const expectedProduct = entry.owned[0].productId;
    const expectedRule = expectedProduct === HUB_PRODUCT_ID
      ? HUB_POLICY : PLAN_RULES_DOCUMENT.rules.find(row => row.productId === expectedProduct);
    assert.equal(configured.rule.productId, expectedProduct, label);
    for (const [field, value] of Object.entries(RULE_NUMBERS)) {
      assert.equal(configured.rule[field], value, `${label} (${field})`);
    }
    assert.equal(configured.planKey ?? expectedRule.planKey, expectedRule.planKey, label);
    const quote = HARNESS.lk1Quote(quoteContext(), quoteExercise(), entry.owned);
    assert.equal(quote.code, undefined, label);
    assert.equal(quote.legacy ?? false, false, label);
    assert.equal(quote.rule.productId, expectedProduct, label);
  }
});

// ---------------------------------------------------------------------------
// §2.1 — product priority on an instance whose candidates disagree.
// ---------------------------------------------------------------------------

const multiIdCases = [
  {
    id: 'priority/plan-first-hub-second-2026-08-31',
    input: {
      priority: 'identity',
      priorityProductId: RA_PRODUCT_ID,
      otherProductId: HUB_PRODUCT_ID,
      purchaseDate: PURCHASE_DATES.planBeforeBoundary,
    },
    expected: 'priority candidate = plan sold before boundary → legacy',
    expectLegacy: true,
    currentBase: 'LK1_PRODUCT_RULE_INVALID (multi-id fail-closed) / no plan resolver',
  },
  {
    id: 'priority/hub-first-plan-second-2026-08-31',
    input: {
      priority: 'identity',
      priorityProductId: HUB_PRODUCT_ID,
      otherProductId: RA_PRODUCT_ID,
      purchaseDate: PURCHASE_DATES.planBeforeBoundary,
    },
    expected: 'priority candidate = HUB → enforced with the HUB policy (enforceFrom: null)',
    expectHub: true,
    currentBase: 'LK1_PRODUCT_RULE_INVALID (multi-id fail-closed)',
  },
  {
    id: 'priority/hub-first-plan-second-2026-09-01',
    input: {
      priority: 'identity',
      priorityProductId: HUB_PRODUCT_ID,
      otherProductId: RA_PRODUCT_ID,
      purchaseDate: PURCHASE_DATES.boundary,
    },
    expected: 'priority candidate = HUB, date irrelevant → enforced with the HUB policy',
    expectHub: true,
    currentBase: 'LK1_PRODUCT_RULE_INVALID (multi-id fail-closed)',
  },
  {
    id: 'priority/unmatched-priority-plan-second',
    input: {
      priority: 'identity',
      priorityProductId: UNKNOWN_PRODUCTS[0].productId,
      otherProductId: RA_PRODUCT_ID,
      purchaseDate: PURCHASE_DATES.boundary,
    },
    expected: 'priority candidate has no rule, no fallback to the other candidate → legacy ({ matched: false })',
    expectUnmatched: true,
    currentBase: 'LK1_PRODUCT_RULE_INVALID (multi-id fail-closed)',
  },
  {
    id: 'priority/subscriptionProductId-first',
    input: {
      priority: 'subscriptionProductId',
      priorityProductId: RA_PRODUCT_ID,
      otherProductId: HUB_PRODUCT_ID,
      purchaseDate: PURCHASE_DATES.boundary,
    },
    expected: 'candidate #2 (subscriptionProductId) = plan 2026-09-01 → enforced, no LK1_PRODUCT_RULE_INVALID',
    expectProductId: RA_PRODUCT_ID,
    currentBase: 'LK1_PRODUCT_RULE_INVALID (multi-id fail-closed) / no plan resolver',
  },
];

const multiIdRecordFor = entry => {
  const base = subscriptionRecord({
    productId: entry.input.otherProductId,
    purchaseDate: entry.input.purchaseDate,
  });
  if (entry.input.priority === 'identity') {
    return [{
      ...base,
      lk1ProductIdentity: {
        actorClientId: ACTOR_CLIENT_ID,
        tenantKey: base.tenantKey,
        subscriptionId: CLIENT_SUBSCRIPTION_ID,
        productId: entry.input.priorityProductId,
        purchaseDate: entry.input.purchaseDate,
        subscription: { ...base, productId: entry.input.priorityProductId },
      },
    }];
  }
  return [{ ...mismatchedRecord(entry.input) }];
};

test('§2.1 priority: the selected instance product decides, disagreements never fail closed', { skip: notIntegrated() }, () => {
  assert.ok(HARNESS, 'gateway harness must be available when the contour is integrated');
  for (const entry of multiIdCases) {
    const owned = multiIdRecordFor(entry);
    const configured = HARNESS.lk1Config(owned);
    const label = `${entry.id}: ${entry.expected}`;
    assert.notEqual(configured.code, 'LK1_PRODUCT_RULE_INVALID', label);
    if (entry.expectUnmatched) {
      assert.equal(configured.matched, false, label);
      continue;
    }
    assert.equal(configured.matched, true, label);
    if (entry.expectLegacy) {
      const quote = HARNESS.lk1Quote(quoteContext(), quoteExercise(), owned);
      assert.equal(quote.legacy, true, label);
      continue;
    }
    const expectedProduct = entry.expectHub ? HUB_PRODUCT_ID : entry.expectProductId;
    assert.equal(configured.rule.productId, expectedProduct, label);
    const quote = HARNESS.lk1Quote(quoteContext(), quoteExercise(), owned);
    assert.equal(quote.code, undefined, label);
    assert.notEqual(quote.legacy, true, label);
    assert.equal(quote.rule.productId, expectedProduct, label);
  }
});

test('§1 an invalid plan-rules global fails closed with LK1_PLAN_RULES_INVALID', { skip: notIntegrated() }, () => {
  assert.ok(HARNESS, 'gateway harness must be available when the contour is integrated');
  const planOwned = () => [subscriptionRecord({
    productId: RA_PRODUCT_ID,
    purchaseDate: PURCHASE_DATES.boundary,
  })];
  const hubOwned = () => [subscriptionRecord({
    productId: HUB_PRODUCT_ID,
    purchaseDate: PURCHASE_DATES.boundary,
  })];
  try {
    for (const shape of INVALID_PLAN_RULES) {
      HARNESS.store.set(LK1_PLAN_RULES_GLOBAL, shape.value);
      assert.equal(HARNESS.lk1Config(planOwned()).code, 'LK1_PLAN_RULES_INVALID', shape.name);
    }
    for (const disabled of DISABLED_PLAN_RULES) {
      HARNESS.store.set(LK1_PLAN_RULES_GLOBAL, disabled);
      assert.equal(HARNESS.lk1Config(planOwned()).matched, false, 'empty global = contour off, not an error');
      assert.equal(HARNESS.lk1Config(hubOwned()).matched, true, 'the HUB rule is independent of the plan-rules global');
    }
  } finally {
    HARNESS.store.set(LK1_PLAN_RULES_GLOBAL, structuredClone(PLAN_RULES_DOCUMENT));
  }
});

// ---------------------------------------------------------------------------
// §7.4/§7.5 — decision matrix: active count, duration, category.
// ---------------------------------------------------------------------------

const HUB_RULE = ruleFieldsOf(HUB_POLICY);
const RA_RULE = ruleForProduct(RA_PRODUCT_ID);

const decisionCases = [
  {
    id: 'game/60-free-hour',
    expected: 'FREE_ENTITLEMENT, final 0, visitCount 1, free 60 / paid 0',
    input: () => decisionInput({ rule: HUB_RULE, binding: bindingOf(HUB_PRODUCT_ID) }),
    check: ({ decision, finalPriceMinor }) => {
      assert.equal(decision.benefit.kind, 'FREE_ENTITLEMENT');
      assert.equal(finalPriceMinor, 0);
      assert.equal(decision.subscriptionVisitCount, 1);
      assert.equal(decision.gameMinutes.freeMinutes, 60);
      assert.equal(decision.gameMinutes.paidOverageMinutes, 0);
    },
    currentBase: 'matches contract (eligible, FREE_ENTITLEMENT, visit 1)',
  },
  {
    id: 'game/90-partial-from-60-free',
    expected: 'PARTIAL_PRICE_PERCENT_DISCOUNT, final 21 000 (900 ₽ × 30/90 − 30 %), visitCount 1, free 60 / paid 30',
    input: () => decisionInput({
      rule: HUB_RULE, binding: bindingOf(HUB_PRODUCT_ID),
      exercise: OPEN_GAME_90, basePriceMinor: PRICES.OPEN_GAME_90,
    }),
    check: ({ decision, finalPriceMinor }) => {
      assert.equal(decision.benefit.kind, 'PARTIAL_PRICE_PERCENT_DISCOUNT');
      assert.equal(finalPriceMinor, 21_000);
      assert.equal(decision.subscriptionVisitCount, 1);
      assert.deepEqual(decision.benefit.partialPriceCalculation, {
        numerator: 30, denominator: 90, chargeBeforeDiscountMinor: 30_000, percentageDiscountMinor: 9_000,
      });
    },
    currentBase: 'matches contract (partial 30/90, final 21 000)',
  },
  {
    id: 'game/60-after-free-hour-used',
    expected: 'free 0 / paid 60, PERCENT_DISCOUNT 30 %, final 42 000, visitCount 0',
    input: () => decisionInput({ rule: HUB_RULE, binding: bindingOf(HUB_PRODUCT_ID), used: 60 }),
    check: ({ decision, finalPriceMinor }) => {
      assert.equal(decision.gameMinutes.freeMinutes, 0);
      assert.equal(decision.gameMinutes.paidOverageMinutes, 60);
      assert.equal(decision.subscriptionVisitCount, 0);
      assert.equal(decision.benefit.kind, 'PERCENT_DISCOUNT');
      assert.equal(finalPriceMinor, 42_000);
    },
    currentBase: 'matches contract (30 % off, visit 0)',
  },
  ...([3, 4, 5].map(activeServices => ({
    id: `game/active-${activeServices}-90min`,
    capCase: true,
    expected: activeServices === 3
      ? 'below cap: free 60 + paid 30, visitCount 1, final 21 000, aboveActiveLimit false'
      : 'above cap: no blocker, free 0 / paid 90, PERCENT_DISCOUNT 30 %, final 63 000, visitCount 0, aboveActiveLimit true',
    input: () => decisionInput({
      rule: HUB_RULE, binding: bindingOf(HUB_PRODUCT_ID),
      exercise: OPEN_GAME_90, basePriceMinor: PRICES.OPEN_GAME_90, activeServices,
    }),
    check: ({ decision, finalPriceMinor, blockerCodes }) => {
      assert.equal(decision.aboveActiveLimit, activeServices >= RULE_NUMBERS.maxActiveBookings);
      assert.ok(!blockerCodes.includes('ACTIVE_SERVICES_LIMIT_REACHED'),
        'ACTIVE_SERVICES_LIMIT_REACHED must be removed for the plan contour');
      if (activeServices < RULE_NUMBERS.maxActiveBookings) {
        assert.equal(decision.gameMinutes.freeMinutes, 60);
        assert.equal(decision.gameMinutes.paidOverageMinutes, 30);
        assert.equal(decision.subscriptionVisitCount, 1);
        assert.equal(finalPriceMinor, 21_000);
      } else {
        assert.equal(decision.gameMinutes.freeMinutes, 0, 'free minutes of the day must not be consumed');
        assert.equal(decision.gameMinutes.paidOverageMinutes, 90);
        assert.equal(decision.subscriptionVisitCount, 0);
        assert.equal(decision.benefit.kind, 'PERCENT_DISCOUNT');
        assert.equal(finalPriceMinor, 63_000);
      }
    },
    currentBase: activeServices === 3
      ? 'DIVERGENT only in decision.aboveActiveLimit (field absent on base); pricing/visits match contract'
      : 'DIVERGENT: not eligible — blocker ACTIVE_SERVICES_LIMIT_REACHED (contract: write allowed, discount, no visit)',
  }))),
  {
    id: 'group/60-50-percent',
    expected: 'PERCENT_DISCOUNT 50 %, final 150 000, visitCount 0',
    input: () => decisionInput({
      action: 'BOOK_GROUP_TRAINING', category: 'GROUP_TRAINING', exercise: GROUP_TRAINING_60,
      rule: HUB_RULE, binding: bindingOf(HUB_PRODUCT_ID), basePriceMinor: PRICES.GROUP_TRAINING_60,
    }),
    check: ({ decision, finalPriceMinor }) => {
      assert.equal(decision.benefit.kind, 'PERCENT_DISCOUNT');
      assert.equal(finalPriceMinor, 150_000);
      assert.equal(decision.subscriptionVisitCount, 0);
    },
    currentBase: 'matches contract',
  },
  {
    id: 'tournament/60-50-percent',
    expected: 'PERCENT_DISCOUNT 50 %, final 150 000, visitCount 0',
    input: () => decisionInput({
      action: 'BOOK_TOURNAMENT', category: 'TOURNAMENT', exercise: TOURNAMENT_60,
      rule: HUB_RULE, binding: bindingOf(HUB_PRODUCT_ID), basePriceMinor: PRICES.TOURNAMENT_60,
    }),
    check: ({ decision, finalPriceMinor }) => {
      assert.equal(decision.benefit.kind, 'PERCENT_DISCOUNT');
      assert.equal(finalPriceMinor, 150_000);
      assert.equal(decision.subscriptionVisitCount, 0);
    },
    currentBase: 'matches contract',
  },
  {
    id: 'group/above-cap-50-percent',
    capCase: true,
    expected: 'above cap: PERCENT_DISCOUNT 50 %, final 150 000, visitCount 0, no blocker',
    input: () => decisionInput({
      action: 'BOOK_GROUP_TRAINING', category: 'GROUP_TRAINING', exercise: GROUP_TRAINING_60,
      rule: HUB_RULE, binding: bindingOf(HUB_PRODUCT_ID), basePriceMinor: PRICES.GROUP_TRAINING_60,
      activeServices: 5,
    }),
    check: ({ decision, finalPriceMinor, blockerCodes }) => {
      assert.equal(decision.aboveActiveLimit, true);
      assert.ok(!blockerCodes.includes('ACTIVE_SERVICES_LIMIT_REACHED'));
      assert.equal(decision.benefit.kind, 'PERCENT_DISCOUNT');
      assert.equal(finalPriceMinor, 150_000);
      assert.equal(decision.subscriptionVisitCount, 0);
    },
    currentBase: 'DIVERGENT: not eligible — ACTIVE_SERVICES_LIMIT_REACHED',
  },
  {
    id: 'plan/ra-enforced-source',
    expected: 'plan rule applies with policyProductId = RA (HUB hardcode removed)',
    input: () => decisionInput({ rule: RA_RULE, binding: bindingOf(RA_PRODUCT_ID) }),
    check: ({ decision, finalPriceMinor }) => {
      assert.equal(decision.benefit.kind, 'FREE_ENTITLEMENT');
      assert.equal(finalPriceMinor, 0);
      assert.equal(decision.subscriptionVisitCount, 1);
    },
    currentBase: 'DIVERGENT: not eligible — LK1_PRODUCT_BINDING_INVALID (policyProductId hardcoded to HUB)',
  },
  {
    id: 'legacy/no-rule-no-discount-no-cap',
    expected: 'no lk1Policy → legacy: no discount, no cap, no visit consumption',
    input: () => decisionInput({ rule: null }),
    check: ({ decision, finalPriceMinor, blockerCodes }) => {
      assert.equal(decision.benefit.kind, 'NONE');
      assert.equal(decision.benefit.discountMinor, 0);
      assert.equal(finalPriceMinor, LEGACY_CARRIER_PRICE_MINOR);
      assert.equal(decision.subscriptionVisitCount, undefined);
      assert.ok(!blockerCodes.includes('ACTIVE_SERVICES_LIMIT_REACHED'));
    },
    currentBase: 'matches contract (legacy projection)',
  },
  {
    id: 'legacy/no-rule-above-cap-still-allowed',
    expected: 'legacy cohort above cap: still allowed, no cap, no discount',
    input: () => decisionInput({ rule: null, activeServices: 5 }),
    check: ({ decision, finalPriceMinor }) => {
      assert.equal(decision.benefit.kind, 'NONE');
      assert.equal(finalPriceMinor, LEGACY_CARRIER_PRICE_MINOR);
    },
    currentBase: 'matches contract',
  },
];

test('§7.4/§7.5 decision matrix: cap, durations, categories', () => {
  // Runs on the current base as well as after integration: pre-integration
  // failures are the expected divergences listed in `currentBase`.
  const divergences = [];
  for (const entry of decisionCases) {
    const input = entry.input();
    const { decision, finalPriceMinor } = decide(input);
    const blockerCodes = (decision.blockers || []).map(row => row.code);
    if (!decision.eligible) {
      divergences.push(`${entry.id}: ineligible (${blockerCodes.join(',') || 'no blockers'})`);
      continue;
    }
    // The additive `aboveActiveLimit` receipt field is the integration marker
    // for the cap contract; the base does not publish it yet.
    if (entry.capCase && !Object.hasOwn(decision, 'aboveActiveLimit')) {
      divergences.push(`${entry.id}: decision.aboveActiveLimit is absent (contract §3.2 requires it)`);
      continue;
    }
    try {
      entry.check({ decision, finalPriceMinor, blockerCodes });
    } catch (error) {
      divergences.push(`${entry.id}: ${error.message.split('\n').slice(0, 3).join(' ')}`);
    }
  }
  assert.deepEqual(divergences, [], divergences.join('\n'));
});

// ---------------------------------------------------------------------------
// §7.7 — preview and booking must agree for identical inputs.
// ---------------------------------------------------------------------------

const PREVIEW_MATRIX = [
  { id: 'preview/hub-60-min', rule: HUB_RULE, productId: HUB_PRODUCT_ID, exercise: OPEN_GAME_60, activeServices: 0 },
  { id: 'preview/hub-90-min', rule: HUB_RULE, productId: HUB_PRODUCT_ID, exercise: OPEN_GAME_90, activeServices: 0 },
  { id: 'preview/hub-90-min-above-cap', rule: HUB_RULE, productId: HUB_PRODUCT_ID, exercise: OPEN_GAME_90, activeServices: 4 },
  { id: 'preview/plan-ra-60-min', rule: RA_RULE, productId: RA_PRODUCT_ID, exercise: OPEN_GAME_60, activeServices: 0 },
  { id: 'preview/plan-ra-group', rule: RA_RULE, productId: RA_PRODUCT_ID, exercise: GROUP_TRAINING_60, activeServices: 0 },
  { id: 'preview/plan-ra-tournament', rule: RA_RULE, productId: RA_PRODUCT_ID, exercise: TOURNAMENT_60, activeServices: 0 },
  { id: 'preview/unknown-product-legacy', rule: null, productId: UNKNOWN_PRODUCTS[0].productId, exercise: OPEN_GAME_60, activeServices: 5 },
];

test('§7.7 preview equals booking for identical inputs', { skip: notIntegrated() }, () => {
  for (const entry of PREVIEW_MATRIX) {
    const booking = bookingDecision(entry);
    const preview = simulatePreview(entry);
    if (entry.rule) {
      // The contour branch prices both surfaces from the same decision.
      assert.equal(preview.finalPriceMinor, booking.finalPriceMinor, `${entry.id}: preview price equals booking price`);
      assert.equal(preview.visitCount, booking.decision.subscriptionVisitCount ?? 0,
        `${entry.id}: preview visits equal booking visits`);
      assert.equal(preview.kind, booking.decision.benefit.kind, entry.id);
    } else {
      // Legacy: no evaluator price is involved — only the A-mechanism applies.
      assert.equal(booking.decision.benefit.kind, 'NONE', `${entry.id}: legacy evaluator path`);
      assert.equal(booking.decision.benefit.discountMinor, 0, entry.id);
      assert.ok(!(booking.decision.blockers || []).some(row => row.code === 'ACTIVE_SERVICES_LIMIT_REACHED'), entry.id);
      assert.equal(preview.visitCount, 1, `${entry.id}: legacy preview keeps the A-mechanism entitlement`);
    }
    assert.deepEqual(simulatePreview(entry), preview, `${entry.id}: repeat evaluation is pure`);
    console.log(`MATRIX-OK ${entry.id} price=${preview.finalPriceMinor} kind=${preview.kind} visits=${preview.visitCount}`);
  }
});

test('§7.2 legacy cohort keeps its mechanism-A daily-limit preview path', () => {
  // Independent of A/B/C: a legacy input must never enter the contour branch —
  // no discount, no visit consumed, full duration reported as entitled.
  for (const activeServices of [0, 5]) {
    const preview = simulatePreview({ exercise: OPEN_GAME_60, rule: null, activeServices });
    assert.equal(preview.finalPriceMinor, 0);
    assert.equal(preview.kind, 'LEGACY_FREE_ENTITLEMENT');
    assert.equal(preview.visitCount, 1);
    assert.equal(preview.freeMinutes, 60);
    assert.deepEqual(simulatePreview({ exercise: OPEN_GAME_60, rule: null, activeServices }), preview);
    console.log(`MATRIX-OK legacy/no-rule-active-${activeServices} price=0 kind=LEGACY_FREE_ENTITLEMENT visits=1`);
  }
});

// ---------------------------------------------------------------------------
// Report table: printed once, so «case → current on base → expected» can be
// derived from the same run that decides pass/skip.
// ---------------------------------------------------------------------------

test('matrix report: case → current behaviour on base → expected by contract', () => {
  const rows = [
    ...gatingCases.map(entry => ({ id: entry.id, current: entry.currentBase, expected: entry.expected })),
    ...multiIdCases.map(entry => ({ id: entry.id, current: entry.currentBase, expected: entry.expected })),
    ...INVALID_PLAN_RULES.map(shape => ({
      id: `rules-invalid/${shape.name}`,
      current: 'no resolver → invalid global is not read (contour absent)',
      expected: 'LK1_PLAN_RULES_INVALID (fail closed)',
    })),
    ...decisionCases.map(entry => ({ id: entry.id, current: entry.currentBase, expected: entry.expected })),
    ...PREVIEW_MATRIX.map(entry => ({
      id: entry.id,
      current: entry.rule ? 'contour absent → preview reports legacy entitlement' : 'legacy path (matches contract)',
      expected: 'preview price/visits equal the booking decision',
    })),
  ];
  const width = Math.max(...rows.map(row => row.id.length));
  for (const row of rows) {
    console.log(`MATRIX ${row.id.padEnd(width)} | current: ${row.current} | expected: ${row.expected}`);
  }
  assert.ok(rows.length >= 35, 'report must cover the whole frozen matrix');
});

test('matrix integration markers are reported explicitly', () => {
  console.log(`MATRIX-STATUS resolver=${RESOLVER_INTEGRATED ? 'integrated' : 'absent'} `
    + `evaluator=${EVALUATOR_INTEGRATED ? 'integrated' : 'plan-binding-invalid'} `
    + `cap=${CAP_CONTRACT_INTEGRATED ? 'integrated' : 'above-cap-blocking'} `
    + `contour=${PREVIEW_INTEGRATED ? 'active' : SKIP_REASON}`);
  if (!HARNESS) console.log(`MATRIX-HARNESS ${harnessBuild.why}`);
  assert.equal(PREVIEW_INTEGRATED, RESOLVER_INTEGRATED && EVALUATOR_INTEGRATED && CAP_CONTRACT_INTEGRATED);
});

// ---------------------------------------------------------------------------
// Optional post-integration self-check of the expectations themselves.
// ---------------------------------------------------------------------------

test('postcheck: the expected values are attainable by a contract-conformant evaluator', {
  skip: !CANDIDATE_EVALUATOR && 'Set LK1_MATRIX_POSTCHECK=1 and LK1_MATRIX_POSTCHECK_EVALUATOR=<file>',
}, () => {
  const failures = [];
  for (const entry of decisionCases) {
    const { decision, finalPriceMinor } = decide(entry.input(), CANDIDATE_EVALUATOR);
    const blockerCodes = (decision.blockers || []).map(row => row.code);
    if (!decision.eligible) {
      failures.push(`${entry.id}: ineligible (${blockerCodes.join(',')})`);
      continue;
    }
    try {
      entry.check({ decision, finalPriceMinor, blockerCodes });
    } catch (error) {
      failures.push(`${entry.id}: ${error.message.split('\n')[0]}`);
    }
  }
  for (const entry of PREVIEW_MATRIX) {
    try {
      const booking = bookingDecision(entry, CANDIDATE_EVALUATOR);
      const preview = simulatePreview(entry, CANDIDATE_EVALUATOR);
      if (entry.rule) {
        assert.equal(preview.finalPriceMinor, booking.finalPriceMinor, entry.id);
        assert.equal(preview.visitCount, booking.decision.subscriptionVisitCount ?? 0, `${entry.id} (visits)`);
      } else {
        assert.equal(booking.decision.benefit.kind, 'NONE', `${entry.id} (legacy path)`);
        assert.equal(preview.visitCount, 1, `${entry.id} (legacy entitlement)`);
      }
      console.log(`MATRIX-POSTCHECK ${entry.id} price=${preview.finalPriceMinor} kind=${preview.kind} visits=${preview.visitCount}`);
    } catch (error) {
      failures.push(`${entry.id}: ${error.message.split('\n')[0]}`);
    }
  }
  assert.deepEqual(failures, [], failures.join('\n'));
});
