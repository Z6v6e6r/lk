import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PLAN_RULES_CONFIG_FRAGMENT_SHA256,
  PLAN_RULES_DEPLOYMENT_ID,
  PLAN_RULES_EVALUATOR_NODE_ID,
  PLAN_RULES_GATEWAY_DELTAS,
  PLAN_RULES_GATEWAY_NODE_ID,
  PLAN_RULES_INSTALLED_GENERATION,
  PLAN_RULES_MODULE_SHA256,
  PLAN_RULES_PENDING_DELTAS,
  PLAN_RULES_PREVIEW_NODE_ID,
  PLAN_RULES_REVIEWED_EVALUATOR_SHA256,
  PLAN_RULES_SOURCE_NODE_COUNT,
  PLAN_RULES_SOURCE_SHA256,
  PLAN_RULES_TARGETS,
  applyDeltas,
  buildEvaluatorBody,
  buildGatewayBody,
  buildGatewayInitialize,
  composeLk1PlanRulesArtifacts,
  composeLk1PlanRulesPreviewBody,
  extractEmbeddedEvaluatorBody,
  patchLk1PlanRulesEvaluatorBody,
  patchLk1PlanRulesGatewayBody,
  patchLk1PlanRulesGatewayInitialize,
  reviewedConfigFragment,
  reviewedEvaluatorBody,
  reviewedPlanRulesModule,
  sha256,
} from '../patch_live_lk1_plan_rules.mjs';
import {
  LK1_PLAN_RULES_DESIRED,
  LK1_PLAN_RULES_FIELDS,
  LK1_PLAN_RULES_KEY,
  buildPlanRulesTransition,
} from '../lib/lk1PlanRulesTransition.mjs';
import { normalizePlanRules } from '../lib/lk1PlanRules.mjs';
import {
  HUB_POLICY_KEY,
  HUB_POLICY_PRODUCT,
  buildHubPolicyTransition,
} from '../lib/lk1HubPolicyTransition.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LIVE_SNAPSHOT = process.env.LK1_PLAN_RULES_LIVE_SNAPSHOT
  ?? '/private/tmp/lk1-prod-readiness-live/input/source.flow.json';
const snapshotSkip = fs.existsSync(LIVE_SNAPSHOT)
  ? false
  : `live 147 snapshot is absent: ${LIVE_SNAPSHOT} (set LK1_PLAN_RULES_LIVE_SNAPSHOT)`;

let cachedArtifacts = null;
function liveArtifacts() {
  if (cachedArtifacts) return cachedArtifacts;
  const liveBytes = fs.readFileSync(LIVE_SNAPSHOT);
  const built = composeLk1PlanRulesArtifacts(liveBytes);
  const liveFlow = JSON.parse(liveBytes.toString('utf8'));
  const fieldOf = (flow, id, field) => flow.find((node) => node.id === id)[field];
  cachedArtifacts = {
    liveBytes,
    built,
    candidateText: built.candidateBytes.toString('utf8'),
    gateway: fieldOf(built.flow, PLAN_RULES_GATEWAY_NODE_ID, 'func'),
    gatewayInitialize: fieldOf(built.flow, PLAN_RULES_GATEWAY_NODE_ID, 'initialize'),
    evaluator: fieldOf(built.flow, PLAN_RULES_EVALUATOR_NODE_ID, 'func'),
    liveGateway: fieldOf(liveFlow, PLAN_RULES_GATEWAY_NODE_ID, 'func'),
    liveGatewayInitialize: fieldOf(liveFlow, PLAN_RULES_GATEWAY_NODE_ID, 'initialize'),
    liveEvaluator: fieldOf(liveFlow, PLAN_RULES_EVALUATOR_NODE_ID, 'func'),
    preview: fieldOf(built.flow, PLAN_RULES_PREVIEW_NODE_ID, 'func'),
    livePreview: fieldOf(liveFlow, PLAN_RULES_PREVIEW_NODE_ID, 'func'),
  };
  return cachedArtifacts;
}

// The installed allowance block of the booking gateway: the composition reuses it
// verbatim instead of re-applying the paid-join transform.
function installedAllowanceBlock(flow) {
  const start = 'if (ctx.step === "lk1_usage_operations") {';
  const end = 'if (ctx.step === "lk1_policy_decision") {';
  const body = flow.find((node) => node.id === PLAN_RULES_GATEWAY_NODE_ID).func;
  return body.slice(body.indexOf(start), body.indexOf(end));
}

// A stand-in for the Node-RED `global` context: enough to run a setup body.
function globalFixture(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    context: {
      get: (key) => store.get(key),
      set: (key, value) => { store.set(key, value); },
    },
  };
}

const runInitialize = (body, context) => new Function('global', 'env', 'node', 'flow', body)(context);

const count = (text, needle) => text.split(needle).length - 1;

test('the reviewed sources are exactly the pinned generation inputs', () => {
  assert.equal(sha256(reviewedPlanRulesModule()), PLAN_RULES_MODULE_SHA256);
  assert.equal(sha256(reviewedConfigFragment()), PLAN_RULES_CONFIG_FRAGMENT_SHA256);
  assert.equal(sha256(reviewedEvaluatorBody()), PLAN_RULES_REVIEWED_EVALUATOR_SHA256);
  // The module keeps its resolver API once the `export` keyword is dropped.
  const module = reviewedPlanRulesModule();
  assert.equal(module.includes('export '), false);
  for (const symbol of ['const LK1_PLAN_RULES_GLOBAL =', 'const LK1_HUB_PRODUCT_ID =',
    'const LK1_STATION_EXCLUSIONS_GLOBAL =', 'function normalizePlanRules(',
    'function normalizeStationExclusions(', 'function resolveLk1Rule(',
    'function lk1ReadPlanRules(', 'function lk1ReadStationExclusions(']) {
    assert.ok(module.includes(symbol), symbol);
  }
  // The released config resolves the rule instead of hardcoding one product id, and it
  // hands the resolver both reviewed readers: the plan rules and the station exclusions.
  const config = reviewedConfigFragment();
  assert.ok(config.includes('resolveLk1Rule({ owned, planRules: lk1ReadPlanRules(), stationId,'));
  assert.ok(config.includes('stationExclusions: lk1ReadStationExclusions() });'));
  assert.equal(config.includes('LK1_OVERLAY_HUB_PRODUCT_ID'), false);
  // Generation pins: live and patched bodies must differ for every changed field.
  assert.equal(PLAN_RULES_TARGETS.gateway.id, PLAN_RULES_GATEWAY_NODE_ID);
  assert.equal(PLAN_RULES_TARGETS.evaluator.id, PLAN_RULES_EVALUATOR_NODE_ID);
  assert.equal(PLAN_RULES_TARGETS.preview.id, PLAN_RULES_PREVIEW_NODE_ID);
  assert.notEqual(PLAN_RULES_TARGETS.gateway.liveFuncSha256, PLAN_RULES_TARGETS.gateway.patchedFuncSha256);
  assert.notEqual(PLAN_RULES_TARGETS.gateway.liveInitializeSha256,
    PLAN_RULES_TARGETS.gateway.patchedInitializeSha256);
  assert.notEqual(PLAN_RULES_TARGETS.evaluator.liveFuncSha256, PLAN_RULES_TARGETS.evaluator.patchedFuncSha256);
  assert.notEqual(PLAN_RULES_TARGETS.preview.liveFuncSha256, PLAN_RULES_TARGETS.preview.patchedFuncSha256);
  assert.equal(new Set(PLAN_RULES_GATEWAY_DELTAS.map((delta) => delta.id)).size,
    PLAN_RULES_GATEWAY_DELTAS.length);
});

test('the frozen plan-rules payload is exactly the reviewed product decision', () => {
  const ruleNumbers = {
    maxActiveBookings: 4,
    freeGameMinutesPerDay: 60,
    gameOverageDiscountPercent: 30,
    groupTrainingDiscountPercent: 50,
    tournamentDiscountPercent: 50,
  };
  assert.equal(LK1_PLAN_RULES_KEY, 'subscriptions_lk1_plan_rules');
  assert.deepEqual(LK1_PLAN_RULES_FIELDS, Object.keys(ruleNumbers));
  assert.deepEqual(LK1_PLAN_RULES_DESIRED, {
    formatVersion: 1,
    rules: [
      ['b91e14d1-fe6e-4d0b-be39-3e45ad86b759', 'ra'],
      ['b2e6a9d4-53b5-4f79-87ec-3fb076381e9b', 'friendship'],
      ['9eb8a7a4-c195-492a-95e4-3fb82899ac10', 'academy'],
      ['82caad6f-4d19-4d01-852b-932bdbb0f405', 'sport'],
      ['6bda152b-0a9c-4308-82d0-3cd4e6aa680d', 'promo_academy'],
      ['c079dc82-c716-4f0e-b9ad-6aab62fb789e', 'promo_friendship'],
      ['3b4806f1-6f9a-46df-a7d7-45075b4e7274', 'promo_ra'],
    ].map(([productId, planKey]) => ({
      productId, planKey, enforceFrom: '2026-09-01', ...ruleNumbers,
    })),
  });
  // The embedded resolver (the single source of truth of the gateway) accepts it.
  const normalized = normalizePlanRules(LK1_PLAN_RULES_DESIRED);
  assert.equal(normalized.ok, true);
  assert.equal(normalized.rules.size, 7);
  for (const { productId, planKey } of LK1_PLAN_RULES_DESIRED.rules) {
    assert.equal(normalized.rules.get(productId).planKey, planKey);
    assert.equal(normalized.rules.get(productId).enforceFrom, '2026-09-01');
    assert.equal(normalized.rules.get(productId).maxActiveBookings, 4);
  }
});

test('the transition initialize guards the prior, writes once and reads back', () => {
  const transition = buildPlanRulesTransition({ expectedPrior: null, desired: LK1_PLAN_RULES_DESIRED });
  assert.equal(transition.expectedPrior, null);
  assert.deepEqual(transition.desired, LK1_PLAN_RULES_DESIRED);
  const { initialize } = transition;
  new Function('global', 'env', 'node', 'flow', initialize);
  for (const marker of [
    `const lk1PlanRulesKey = ${JSON.stringify(LK1_PLAN_RULES_KEY)};`,
    `const lk1DesiredPlanRules = ${JSON.stringify(LK1_PLAN_RULES_DESIRED)};`,
    'const lk1PlanRulesExpectedPrior = null;',
    'if (JSON.stringify(lk1PlanRulesCurrent) !== JSON.stringify(lk1DesiredPlanRules)) {',
    'if (JSON.stringify(lk1PlanRulesCurrent) !== JSON.stringify(lk1PlanRulesExpectedPrior)) '
      + 'throw new Error("plan rules prior mismatch; no overwrite");',
    'global.set(lk1PlanRulesKey, lk1DesiredPlanRules);',
    'throw new Error("plan rules readback mismatch");',
  ]) {
    assert.ok(initialize.includes(marker), marker);
  }

  // First activation on an empty context writes the reviewed payload.
  const empty = globalFixture();
  runInitialize(initialize, empty.context);
  assert.deepEqual(empty.store.get(LK1_PLAN_RULES_KEY), LK1_PLAN_RULES_DESIRED);

  // Re-running the same generation is idempotent: nothing is rewritten.
  let writes = 0;
  const already = globalFixture({ [LK1_PLAN_RULES_KEY]: structuredClone(LK1_PLAN_RULES_DESIRED) });
  runInitialize(initialize, { get: already.context.get, set: (key, value) => {
    writes += 1;
    already.context.set(key, value);
  } });
  assert.equal(writes, 0);

  // A foreign prior is refused instead of overwritten.
  const foreign = globalFixture({
    [LK1_PLAN_RULES_KEY]: { formatVersion: 1, rules: [] },
  });
  assert.throws(() => runInitialize(initialize, foreign.context), /prior mismatch; no overwrite/);
  assert.deepEqual(foreign.store.get(LK1_PLAN_RULES_KEY), { formatVersion: 1, rules: [] });

  // A malformed prior is refused by the inlined shape normalizer.
  const malformed = globalFixture({ [LK1_PLAN_RULES_KEY]: { formatVersion: 2, rules: [] } });
  assert.throws(() => runInitialize(initialize, malformed.context), /shape mismatch/);
  for (const bad of [
    { formatVersion: 1, rules: [], surplus: true },
    { formatVersion: 1, rules: [{ productId: 'not-a-uuid', planKey: 'ra', enforceFrom: null,
      maxActiveBookings: 4, freeGameMinutesPerDay: 60, gameOverageDiscountPercent: 30,
      groupTrainingDiscountPercent: 50, tournamentDiscountPercent: 50 }] },
    { formatVersion: 1, rules: [{ productId: 'b91e14d1-fe6e-4d0b-be39-3e45ad86b759', planKey: '',
      enforceFrom: null, maxActiveBookings: 4, freeGameMinutesPerDay: 60,
      gameOverageDiscountPercent: 30, groupTrainingDiscountPercent: 50,
      tournamentDiscountPercent: 50 }] },
    { formatVersion: 1, rules: [{ productId: 'b91e14d1-fe6e-4d0b-be39-3e45ad86b759', planKey: 'ra',
      enforceFrom: '2026-9-1', maxActiveBookings: 4, freeGameMinutesPerDay: 60,
      gameOverageDiscountPercent: 30, groupTrainingDiscountPercent: 50,
      tournamentDiscountPercent: 50 }] },
    { formatVersion: 1, rules: [{ productId: 'b91e14d1-fe6e-4d0b-be39-3e45ad86b759', planKey: 'ra',
      enforceFrom: null, maxActiveBookings: 0, freeGameMinutesPerDay: 60,
      gameOverageDiscountPercent: 30, groupTrainingDiscountPercent: 50,
      tournamentDiscountPercent: 50 }] },
    { formatVersion: 1, rules: [{ productId: 'b91e14d1-fe6e-4d0b-be39-3e45ad86b759', planKey: 'ra',
      enforceFrom: null, maxActiveBookings: 4, freeGameMinutesPerDay: 60,
      gameOverageDiscountPercent: 101, groupTrainingDiscountPercent: 50,
      tournamentDiscountPercent: 50 }] },
    { formatVersion: 1, rules: [
      { productId: 'b91e14d1-fe6e-4d0b-be39-3e45ad86b759', planKey: 'ra', enforceFrom: null,
        maxActiveBookings: 4, freeGameMinutesPerDay: 60, gameOverageDiscountPercent: 30,
        groupTrainingDiscountPercent: 50, tournamentDiscountPercent: 50 },
      { productId: 'b91e14d1-fe6e-4d0b-be39-3e45ad86b759', planKey: 'ra', enforceFrom: null,
        maxActiveBookings: 4, freeGameMinutesPerDay: 60, gameOverageDiscountPercent: 30,
        groupTrainingDiscountPercent: 50, tournamentDiscountPercent: 50 },
    ] },
  ]) {
    const fixture = globalFixture({ [LK1_PLAN_RULES_KEY]: bad });
    assert.throws(() => runInitialize(initialize, fixture.context), /shape mismatch/);
  }

  // Missing options cannot silently become a transition.
  assert.throws(() => buildPlanRulesTransition({ desired: LK1_PLAN_RULES_DESIRED }),
    /Explicit plan-rules prior and desired global required/);
  assert.throws(() => buildPlanRulesTransition({ expectedPrior: null }),
    /Explicit plan-rules prior and desired global required/);
  // A later rule change must name its exact prior: declared, it applies; blind, it
  // is refused at runtime with `expectedPrior: null`.
  const changed = structuredClone(LK1_PLAN_RULES_DESIRED);
  changed.rules[0] = { ...changed.rules[0], maxActiveBookings: 5 };
  const declared = buildPlanRulesTransition({
    expectedPrior: LK1_PLAN_RULES_DESIRED, desired: changed,
  });
  assert.deepEqual(declared.expectedPrior, LK1_PLAN_RULES_DESIRED);
  const upgrade = globalFixture({ [LK1_PLAN_RULES_KEY]: structuredClone(LK1_PLAN_RULES_DESIRED) });
  runInitialize(declared.initialize, upgrade.context);
  assert.equal(upgrade.store.get(LK1_PLAN_RULES_KEY).rules[0].maxActiveBookings, 5);
  // The frozen generation run against a foreign value refuses instead of rewriting.
  const blind = globalFixture({ [LK1_PLAN_RULES_KEY]: structuredClone(changed) });
  assert.throws(() => runInitialize(initialize, blind.context), /prior mismatch; no overwrite/);
  assert.equal(blind.store.get(LK1_PLAN_RULES_KEY).rules[0].maxActiveBookings, 5);
});

test('the preview delta pins the installed generation and leaves no pending delta', () => {
  // The preview amendment is applied, so nothing is deferred for this generation.
  assert.deepEqual(PLAN_RULES_PENDING_DELTAS, []);
  // Line C's reviewed defaults are the pre-split-nominal-share preimages, so the
  // release names the installed postimages explicitly instead of rewriting them.
  const installed = PLAN_RULES_INSTALLED_GENERATION;
  for (const [key, value] of Object.entries(installed)) {
    assert.match(value, /^[0-9a-f]{64}$/, key);
  }
  assert.notEqual(installed.reviewedSplitPinSha256, installed.splitFuncSha256);
  assert.notEqual(installed.reviewedJoinPinSha256, installed.joinFuncSha256);
  // The preview delta is a composition, not one of the literal gateway string deltas.
  assert.ok(!PLAN_RULES_GATEWAY_DELTAS.some((delta) => delta.id.includes('preview')));
});

test('anchor handling fails closed on ambiguous or composed deltas', () => {
  assert.throws(() => applyDeltas('const a = 1;\nconst a = 1;\n',
    [{ id: 'duplicate', before: 'const a = 1;\n', after: 'const a = 2;\n' }], 'Synthetic'),
  /anchor drift for duplicate: 2 occurrences/);
  assert.throws(() => applyDeltas('const b = 1;\n',
    [{ id: 'missing', before: 'const a = 1;\n', after: 'const a = 2;\n' }], 'Synthetic'),
  /anchor drift for missing: 0 occurrences/);
  // The reviewed module must not be embeddable into a body that already declares it.
  assert.throws(() => buildGatewayBody(reviewedPlanRulesModule()),
    /already declares the embedded plan-rules symbol/);
});

test('the patcher applies to the live 147 snapshot as exactly three changed nodes',
  { skip: snapshotSkip }, () => {
    const { built, candidateText, gateway, gatewayInitialize, evaluator, preview,
      liveGateway, liveGatewayInitialize, liveEvaluator, livePreview } = liveArtifacts();
    assert.equal(built.changes.length, 3);
    assert.equal(built.addedNodeCount, 0);
    assert.equal(built.flow.length, PLAN_RULES_SOURCE_NODE_COUNT);
    assert.deepEqual(built.changes.map((change) => change.id).sort(),
      [PLAN_RULES_EVALUATOR_NODE_ID, PLAN_RULES_GATEWAY_NODE_ID, PLAN_RULES_PREVIEW_NODE_ID].sort());
    const gatewayChange = built.changes.find((change) => change.id === PLAN_RULES_GATEWAY_NODE_ID);
    const evaluatorChange = built.changes.find((change) => change.id === PLAN_RULES_EVALUATOR_NODE_ID);
    const previewChange = built.changes.find((change) => change.id === PLAN_RULES_PREVIEW_NODE_ID);
    assert.deepEqual(gatewayChange.fields, ['func', 'initialize']);
    assert.deepEqual(evaluatorChange.fields, ['func']);
    assert.deepEqual(previewChange.fields, ['func']);
    assert.notEqual(gatewayChange.func.beforeSha256, gatewayChange.func.afterSha256);
    assert.notEqual(gatewayChange.initialize.beforeSha256, gatewayChange.initialize.afterSha256);
    assert.equal(evaluatorChange.initialize, undefined);
    assert.equal(previewChange.initialize, undefined);
    // The candidate is the live flow with exactly those fields rewritten.
    assert.equal(candidateText, `${JSON.stringify(built.flow, null, 2)}\n`);
    assert.equal(sha256(liveGateway), PLAN_RULES_TARGETS.gateway.liveFuncSha256);
    assert.equal(sha256(gateway), PLAN_RULES_TARGETS.gateway.patchedFuncSha256);
    assert.equal(sha256(liveGatewayInitialize), PLAN_RULES_TARGETS.gateway.liveInitializeSha256);
    assert.equal(sha256(gatewayInitialize), PLAN_RULES_TARGETS.gateway.patchedInitializeSha256);
    assert.equal(sha256(liveEvaluator), PLAN_RULES_TARGETS.evaluator.liveFuncSha256);
    assert.equal(sha256(evaluator), PLAN_RULES_TARGETS.evaluator.patchedFuncSha256);
    assert.equal(sha256(livePreview), PLAN_RULES_TARGETS.preview.liveFuncSha256);
    assert.equal(sha256(preview), PLAN_RULES_TARGETS.preview.patchedFuncSha256);

    // A Node-RED function body must stay parseable with the Node-RED arguments.
    new Function('msg', 'node', 'env', 'global', gateway);
    new Function('msg', 'node', 'env', 'global', evaluator);
    new Function('msg', 'node', 'env', 'global', preview);
    new Function('global', 'env', 'node', 'flow', gatewayInitialize);

    // Gateway: the resolver module is embedded once, the reviewed config replaced the
    // single-product config, and every legacy gate now reads the resolver verdict.
    assert.equal(count(gateway, 'const LK1_PLAN_RULES_GLOBAL = "subscriptions_lk1_plan_rules";'), 1);
    assert.equal(count(gateway, 'resolveLk1Rule({ owned, planRules: lk1ReadPlanRules() })'), 1);
    assert.equal(count(gateway, 'if (configured.legacy) return { legacy: true };'), 1);
    assert.equal(count(gateway, 'const enforced = configured.matched && !configured.legacy;'), 1);
    assert.equal(count(gateway, 'const enforcedRule = selectedRule.matched && !selectedRule.legacy;'), 1);
    assert.equal(count(gateway, 'if (productRule.matched && !productRule.legacy) {'), 1);
    assert.equal(count(gateway, 'const selectedOwned = findOwnedSubscriptions(exercise, ctx.clientSubscriptionId);'), 1);
    // The pre-rollout gates are gone from the live body.
    assert.equal(count(gateway, '&& dates.dates[0] < MANAGED_ENFORCEMENT_PURCHASE_FROM'), 0);
    assert.equal(count(gateway, 'if (productRule.matched) {'), 0);
    assert.equal(count(gateway, 'const visitOwned = findOwnedSubscriptions'), 0);
    assert.equal(count(gateway, 'if (!ids.includes(LK1_OVERLAY_HUB_PRODUCT_ID)) return { matched: false };'), 0);
    // Unrelated host helpers the resolver relies on are still present exactly once.
    assert.equal(count(gateway, 'const collectExactProductIds ='), 1);
    assert.equal(count(gateway, 'const lk1ReadBoundPolicy ='), 1);

    // Evaluator: the reviewed body replaced the embedded base copy, the product is
    // validated instead of hardcoded, and the active-bookings blocker is now a verdict.
    assert.equal(count(evaluator, reviewedEvaluatorBody()), 1);
    assert.equal(count(evaluator, 'aboveActiveLimit: false,'), 1);
    assert.equal(count(evaluator, 'decision.aboveActiveLimit = activeCount >= rule.maxActiveBookings;'), 1);
    assert.equal(count(evaluator, 'binding.policyProductId !== "db7a5250-7369-4f43-8ac5-9111be24bc74"'), 0);
    assert.equal(count(evaluator, 'const UUID_PATTERN ='), 1);
    // The only remaining occurrence belongs to the untouched managed/CUP path.
    assert.equal(count(evaluator, '"ACTIVE_SERVICES_LIMIT_REACHED"'), 1);
    assert.ok(evaluator.includes('"Достигнут лимит активных услуг по подписке"'));

    // Preview: the reviewed composition reaches the shared resolver, embeds the
    // installed allowance block verbatim, and touches nothing but `func`.
    assert.equal(count(preview, 'canonical.resolveLk1Rule'), 2,
      'the reviewed preview body checks and then calls the shared resolver');
    assert.equal(count(preview, 'const canonical = (() => {'), 1);
    const installedBlock = installedAllowanceBlock(built.flow);
    assert.ok(preview.includes(installedBlock),
      'the preview must embed the installed allowance block byte for byte');
    assert.equal(installedBlock, installedAllowanceBlock(JSON.parse(fs.readFileSync(LIVE_SNAPSHOT).toString('utf8'))));
    assert.equal(sha256(installedBlock), PLAN_RULES_INSTALLED_GENERATION.allowanceBlockSha256);
    assert.equal(built.previewNode.id, PLAN_RULES_PREVIEW_NODE_ID);
    assert.deepEqual(built.previewNode.fields, ['func']);
    assert.equal(built.previewNode.initializeUnchanged, true);
    assert.equal(built.previewNode.otherFieldsUnchanged, true);
    assert.equal(built.previewNode.resolverReachable, true);
    assert.ok(Number.isInteger(built.previewNode.helperCount) && built.previewNode.helperCount > 0);
    assert.ok(Number.isInteger(built.previewNode.pricingNameCount) && built.previewNode.pricingNameCount > 0);
    // The composed preview must still carry the resolved config helper exactly once.
    assert.equal(count(preview, 'canonical.lk1Config'), 1);
  });

test('the released gateway initialize keeps the HUB writer and adds the plan-rules writer',
  { skip: snapshotSkip }, () => {
    const { gatewayInitialize, liveGatewayInitialize } = liveArtifacts();
    // The live setup body is exactly the reviewed HUB policy transition, byte for byte.
    const hubTransition = buildHubPolicyTransition({
      expectedPrior: null,
      desired: {
        productId: HUB_POLICY_PRODUCT,
        maxActiveBookings: 4,
        freeGameMinutesPerDay: 60,
        gameOverageDiscountPercent: 30,
        groupTrainingDiscountPercent: 50,
        tournamentDiscountPercent: 50,
      },
    });
    assert.equal(HUB_POLICY_KEY, 'subscriptions_lk1_product_policy');
    assert.equal(liveGatewayInitialize, hubTransition.initialize);
    assert.equal(sha256(hubTransition.initialize), PLAN_RULES_TARGETS.gateway.liveInitializeSha256);
    // The live setup body is exactly the HUB policy writer.
    for (const marker of [
      'const lk1PolicyKey = "subscriptions_lk1_product_policy";',
      'const lk1DesiredPolicy = {"productId":"db7a5250-7369-4f43-8ac5-9111be24bc74",'
        + '"maxActiveBookings":4,"freeGameMinutesPerDay":60,"gameOverageDiscountPercent":30,'
        + '"groupTrainingDiscountPercent":50,"tournamentDiscountPercent":50};',
      'global.set(lk1PolicyKey, lk1DesiredPolicy);',
      '"HUB policy prior mismatch; no overwrite"',
      '"HUB policy readback mismatch"',
    ]) {
      assert.ok(liveGatewayInitialize.includes(marker), marker);
      assert.ok(gatewayInitialize.includes(marker), `released: ${marker}`);
    }
    // The HUB writer block is byte-identical: the released setup is the live one plus
    // the plan-rules activation appended at the end.
    assert.ok(gatewayInitialize.startsWith(liveGatewayInitialize));
    assert.equal(count(gatewayInitialize, 'const lk1PolicyKey ='), 1);
    assert.equal(count(gatewayInitialize, 'const lk1PlanRulesKey ='), 1);

    // Running the released setup writes the HUB policy first and the plan-rules
    // global second, in one pass.
    const fixture = globalFixture();
    runInitialize(gatewayInitialize, fixture.context);
    assert.deepEqual(fixture.store.get('subscriptions_lk1_product_policy'), {
      productId: 'db7a5250-7369-4f43-8ac5-9111be24bc74',
      maxActiveBookings: 4,
      freeGameMinutesPerDay: 60,
      gameOverageDiscountPercent: 30,
      groupTrainingDiscountPercent: 50,
      tournamentDiscountPercent: 50,
    });
    assert.deepEqual(fixture.store.get(LK1_PLAN_RULES_KEY), LK1_PLAN_RULES_DESIRED);
    // Re-running the released setup over its own result is idempotent.
    runInitialize(gatewayInitialize, fixture.context);

    // A changed plan-rules global fails the setup closed instead of overwriting.
    const drifted = globalFixture({ [LK1_PLAN_RULES_KEY]: { formatVersion: 1, rules: [] } });
    assert.throws(() => runInitialize(gatewayInitialize, drifted.context),
      /prior mismatch; no overwrite/);
  });

test('the embedded evaluator preimage is the base generation source of commit e2e5e1e5',
  { skip: snapshotSkip }, () => {
    const { liveEvaluator } = liveArtifacts();
    let baseSource;
    try {
      baseSource = execFileSync('git',
        ['show', 'e2e5e1e5:scripts/nodered_lk1_hub_nodes/evaluator.js'],
        { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    } catch {
      return; // The base commit is unavailable (shallow checkout); the sha pin still holds.
    }
    const { embedded } = extractEmbeddedEvaluatorBody(liveEvaluator);
    assert.equal(sha256(embedded), PLAN_RULES_TARGETS.evaluator.liveEmbeddedSha256);
    assert.equal(sha256(embedded), sha256(baseSource));
  });

test('the preview delta is refused on a second run and on any drift',
  { skip: snapshotSkip }, () => {
    const { built, livePreview } = liveArtifacts();
    // The already patched candidate: the resolver marker is present.
    const patchedFlow = () => structuredClone(built.flow);
    // The same generation with the live preview body: gateway/evaluator are patched, so
    // only the preview composition gate is exercised.
    const freshFlow = () => {
      const flow = structuredClone(built.flow);
      flow.find((node) => node.id === PLAN_RULES_PREVIEW_NODE_ID).func = livePreview;
      return flow;
    };

    // Re-running the preview composition over its own result is refused.
    assert.throws(() => composeLk1PlanRulesPreviewBody(patchedFlow()), /already patched/);
    // A single extra byte in the live preview body is refused by the preimage pin.
    const drifted = freshFlow();
    drifted.find((node) => node.id === PLAN_RULES_PREVIEW_NODE_ID).func = `${livePreview} `;
    assert.throws(() => composeLk1PlanRulesPreviewBody(drifted),
      /Preview live preimage drift \(func\)/);

    // The installed-generation pins are the review gate: a wrong split/join/allowance
    // pin must fail closed instead of composing a preview from an unreviewed body.
    assert.throws(() => composeLk1PlanRulesPreviewBody(freshFlow(),
      { installedUsageSha256: '0'.repeat(64) }),
    /Price preview installed allowance block changed/);
    assert.throws(() => composeLk1PlanRulesPreviewBody(freshFlow(), { pricingSha256: '0'.repeat(64) }),
      /Price preview canonical pricing source changed/);
    assert.throws(() => composeLk1PlanRulesPreviewBody(freshFlow(), { joinSha256: '0'.repeat(64) }),
      /Price preview canonical join source changed/);
    // booking/evaluator are fixed pins too: a flow that does not carry the reviewed
    // patched bodies is refused before any pin of line C's composition is consulted.
    const brokenGateway = freshFlow();
    brokenGateway.find((node) => node.id === PLAN_RULES_GATEWAY_NODE_ID).func += '\n';
    assert.throws(() => composeLk1PlanRulesPreviewBody(brokenGateway),
      /Preview booking pin mismatch/);
    const brokenEvaluator = freshFlow();
    brokenEvaluator.find((node) => node.id === PLAN_RULES_EVALUATOR_NODE_ID).func += '\n';
    assert.throws(() => composeLk1PlanRulesPreviewBody(brokenEvaluator),
      /Preview evaluator pin mismatch/);

    // A preview node that is missing required fields is refused before composing.
    const brokenPreview = freshFlow();
    brokenPreview.find((node) => node.id === PLAN_RULES_PREVIEW_NODE_ID).outputs = 0;
    assert.throws(() => composeLk1PlanRulesPreviewBody(brokenPreview), /Node contract mismatch/);
  });

test('a second run and any drift are refused', { skip: snapshotSkip }, () => {
  const { gateway, gatewayInitialize, evaluator, built,
    liveGateway, liveGatewayInitialize, liveEvaluator } = liveArtifacts();
  assert.throws(() => patchLk1PlanRulesGatewayBody(gateway), /already patched/);
  assert.throws(() => patchLk1PlanRulesEvaluatorBody(evaluator), /already patched/);
  assert.throws(() => patchLk1PlanRulesGatewayInitialize(gatewayInitialize), /already patched/);
  assert.throws(() => buildGatewayBody(gateway), /already patched/);
  assert.throws(() => buildEvaluatorBody(evaluator), /already patched/);
  assert.throws(() => buildGatewayInitialize(gatewayInitialize), /already patched/);
  // Re-running the whole generation over its own candidate fails closed.
  assert.throws(() => composeLk1PlanRulesArtifacts(built.candidateBytes), /preimage drift/);

  // Node-level drift: a single extra byte in any live body is refused.
  assert.throws(() => patchLk1PlanRulesGatewayBody(`${liveGateway} `), /live preimage drift/);
  assert.throws(() => patchLk1PlanRulesEvaluatorBody(`${liveEvaluator} `), /live preimage drift/);
  assert.throws(() => patchLk1PlanRulesGatewayInitialize(`${liveGatewayInitialize} `),
    /live preimage drift/);
  // A live setup body that lost the HUB writer is refused even with a matching hash:
  // the HUB writer marker check is independent of the pin.
  assert.throws(() => buildGatewayInitialize(liveGatewayInitialize.replace(
    'global.set(lk1PolicyKey, lk1DesiredPolicy);', '// hub writer removed')),
  /missing the HUB writer anchor/);
  // A live body with the right node hash but a broken anchor cannot exist; a body
  // that fails the flow-level pin is refused before any node is touched.
  const driftedFlow = JSON.parse(fs.readFileSync(LIVE_SNAPSHOT).toString('utf8'));
  driftedFlow[0].name = `${driftedFlow[0].name ?? ''} drifted`;
  const driftedBytes = Buffer.from(`${JSON.stringify(driftedFlow, null, 2)}\n`);
  assert.throws(() => composeLk1PlanRulesArtifacts(driftedBytes), /Live flow preimage drift/);

  // Node-count drift is refused even when the flow-level hash is supplied.
  const tiny = Buffer.from(`${JSON.stringify([
    { id: PLAN_RULES_GATEWAY_NODE_ID, type: 'function', outputs: 1, wires: [[]], func: 'const a = 1;\n' }], null, 2)}\n`);
  assert.throws(() => composeLk1PlanRulesArtifacts(tiny, { expectedSourceSha256: sha256(tiny) }),
    /node count drift/);
});

test('compose refuses a malformed flow and an absent preview node',
  { skip: snapshotSkip }, () => {
    const empty = Buffer.from('{}');
    assert.throws(() => composeLk1PlanRulesArtifacts(empty,
      { expectedSourceSha256: sha256(empty) }), /Invalid flow identity/);
    // A full-size flow whose preview node was renamed away cannot be composed: the
    // preview is contract-checked because its reviewed delta must land before it ships.
    const flow = JSON.parse(fs.readFileSync(LIVE_SNAPSHOT).toString('utf8'));
    const preview = flow.find((node) => node.id === PLAN_RULES_PREVIEW_NODE_ID);
    assert.ok(preview, 'live snapshot carries the preview node');
    preview.id = 'lk_subscription_price_preview_renamed';
    const bytes = Buffer.from(`${JSON.stringify(flow, null, 2)}\n`);
    assert.throws(() => composeLk1PlanRulesArtifacts(bytes, { expectedSourceSha256: sha256(bytes) }),
      /is absent/);
  });

test('prepare_exact_graph_contract allows initialize and keeps exactly three nodes',
  { skip: snapshotSkip }, () => {
    const { liveBytes, built, candidateText } = liveArtifacts();
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'lk1-plan-rules-test-'));
    const livePath = path.join(temp, 'source.flow.json');
    const candidatePath = path.join(temp, 'candidate.flow.json');
    const contractPath = path.join(temp, 'contract.json');
    fs.writeFileSync(livePath, liveBytes, { mode: 0o600 });
    fs.writeFileSync(candidatePath, candidateText, { mode: 0o600 });
    const stdout = execFileSync('node', [
      path.join(repoRoot, 'scripts/nodered_reviewed_flow_deploy/prepare_exact_graph_contract.mjs'),
      '--live', livePath,
      '--candidate', candidatePath,
      '--output', contractPath,
      '--deployment-id', PLAN_RULES_DEPLOYMENT_ID,
      '--allow-change', `${PLAN_RULES_GATEWAY_NODE_ID}:func,initialize`,
      '--allow-change', `${PLAN_RULES_EVALUATOR_NODE_ID}:func`,
      '--allow-change', `${PLAN_RULES_PREVIEW_NODE_ID}:func`,
    ], { cwd: repoRoot, encoding: 'utf8' });
    const receipt = JSON.parse(stdout);
    assert.equal(receipt.deploymentId, PLAN_RULES_DEPLOYMENT_ID);
    assert.equal(receipt.changedNodeCount, 3);
    assert.equal(receipt.addedNodeCount, 0);
    assert.equal(receipt.sourceSha256, PLAN_RULES_SOURCE_SHA256);
    assert.equal(receipt.candidateSha256, sha256(candidateText));
    assert.equal(receipt.sourceNodeCount, PLAN_RULES_SOURCE_NODE_COUNT);
    assert.equal(receipt.candidateNodeCount, PLAN_RULES_SOURCE_NODE_COUNT);

    const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
    assert.equal(contract.formatVersion, 2);
    assert.equal(contract.contractKind, 'exact-graph');
    assert.equal(contract.deploymentId, PLAN_RULES_DEPLOYMENT_ID);
    assert.equal(contract.sourceSha256, sha256(liveBytes));
    assert.equal(contract.candidateSha256, sha256(candidateText));
    assert.equal(contract.allowedChanges.length, 3);
    assert.equal(contract.allowedAdditions.length, 0);
    const byId = new Map(contract.allowedChanges.map((change) => [change.id, change]));
    assert.deepEqual([...byId.keys()].sort(),
      [PLAN_RULES_EVALUATOR_NODE_ID, PLAN_RULES_GATEWAY_NODE_ID, PLAN_RULES_PREVIEW_NODE_ID].sort());
    // The gateway allowance must explicitly permit the setup body; the preview is a
    // `func`-only rewrite of an existing node.
    assert.deepEqual(byId.get(PLAN_RULES_GATEWAY_NODE_ID).fields, ['func', 'initialize']);
    assert.deepEqual(byId.get(PLAN_RULES_EVALUATOR_NODE_ID).fields, ['func']);
    assert.deepEqual(byId.get(PLAN_RULES_PREVIEW_NODE_ID).fields, ['func']);
    // Per-node digests must match the patcher report for the same fields.
    const jsonSha = (value) => sha256(Buffer.from(JSON.stringify(value), 'utf8'));
    const liveFlow = JSON.parse(liveBytes.toString('utf8'));
    const candidateFlow = JSON.parse(candidateText);
    const nodeOf = (flow, id) => flow.find((node) => node.id === id);
    for (const change of contract.allowedChanges) {
      assert.equal(change.sourceNodeSha256, jsonSha(nodeOf(liveFlow, change.id)));
      assert.equal(change.candidateNodeSha256, jsonSha(nodeOf(candidateFlow, change.id)));
    }
    const reported = built.changes.find((item) => item.id === PLAN_RULES_GATEWAY_NODE_ID);
    assert.equal(reported.func.beforeSha256,
      sha256(nodeOf(liveFlow, PLAN_RULES_GATEWAY_NODE_ID).func));
    assert.equal(reported.initialize.beforeSha256,
      sha256(nodeOf(liveFlow, PLAN_RULES_GATEWAY_NODE_ID).initialize));
    assert.equal(reported.initialize.afterSha256,
      sha256(nodeOf(candidateFlow, PLAN_RULES_GATEWAY_NODE_ID).initialize));
    const reportedPreview = built.changes.find((item) => item.id === PLAN_RULES_PREVIEW_NODE_ID);
    assert.equal(reportedPreview.func.beforeSha256,
      sha256(nodeOf(liveFlow, PLAN_RULES_PREVIEW_NODE_ID).func));
    assert.equal(reportedPreview.func.afterSha256,
      sha256(nodeOf(candidateFlow, PLAN_RULES_PREVIEW_NODE_ID).func));
    // The preview keeps every field but `func` in the candidate.
    const previewLive = { ...nodeOf(liveFlow, PLAN_RULES_PREVIEW_NODE_ID), func: null };
    const previewCandidate = { ...nodeOf(candidateFlow, PLAN_RULES_PREVIEW_NODE_ID), func: null };
    assert.deepEqual(previewCandidate, previewLive);

    // The function-only contract cannot express this generation: `initialize` is not
    // a permitted function-only field, which is exactly why the wrapper uses the
    // exact-graph contract.
    let functionOnlyError = null;
    try {
      execFileSync('node', [
        path.join(repoRoot, 'scripts/nodered_reviewed_flow_deploy/prepare_contract.mjs'),
        '--live', livePath,
        '--candidate', candidatePath,
        '--output', path.join(temp, 'contract-function-only.json'),
        '--deployment-id', PLAN_RULES_DEPLOYMENT_ID,
        '--allow-node', PLAN_RULES_GATEWAY_NODE_ID,
        '--allow-node', PLAN_RULES_EVALUATOR_NODE_ID,
        '--allow-node', PLAN_RULES_PREVIEW_NODE_ID,
      ], { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' });
    } catch (error) {
      functionOnlyError = error;
    }
    assert.ok(functionOnlyError, 'the function-only contract must reject this candidate');
    assert.match(String(functionOnlyError.stderr),
      /Function-only candidate changed forbidden fields for .*: func,initialize/);
    fs.rmSync(temp, { recursive: true, force: true });
  });

test('the deploy wrapper keeps the confirmation gate, the exact allowance and rollback', () => {
  const wrapper = fs.readFileSync(
    path.join(repoRoot, 'scripts/deploy_nodered_lk1_plan_rules_147.sh'), 'utf8');
  assert.ok(wrapper.includes('NODE_RED_LK1_PLAN_RULES_DEPLOY:-}" != "CONFIRM_147"'));
  assert.ok(wrapper.includes('clean main checkout'));
  assert.ok(wrapper.includes(`allow_nodes=(${PLAN_RULES_GATEWAY_NODE_ID} ${PLAN_RULES_EVALUATOR_NODE_ID} ${PLAN_RULES_PREVIEW_NODE_ID})`));
  assert.ok(wrapper.includes(`"${PLAN_RULES_GATEWAY_NODE_ID}:func,initialize"`));
  assert.ok(wrapper.includes(`"${PLAN_RULES_EVALUATOR_NODE_ID}:func"`));
  assert.ok(wrapper.includes(`"${PLAN_RULES_PREVIEW_NODE_ID}:func"`));
  // expected_changed_nodes is the node count (3), not the field count.
  assert.ok(wrapper.includes('expected_changed_nodes=3'));
  assert.ok(wrapper.includes('prepare_exact_graph_contract.mjs'));
  assert.equal(wrapper.includes('nodered_reviewed_flow_deploy/prepare_contract.mjs'), false);
  assert.ok(wrapper.includes('patch_live_lk1_plan_rules.mjs'));
  assert.ok(wrapper.includes('rollback --deployment-id'));
  assert.ok(wrapper.includes('sha256sum'));
  assert.ok(wrapper.includes('deploy_reviewed_flow_147_remote.mjs'));
  // The preview delta must be part of the reviewed allowance.
  assert.ok(wrapper.includes(PLAN_RULES_PREVIEW_NODE_ID));
  // The patcher report gate requires the preview node to keep every other field.
  assert.ok(wrapper.includes('value.previewNode?.otherFieldsUnchanged !== true'));
  // Read-only smoke: HTTP 200 plus the RUB price payload.
  assert.ok(wrapper.includes('smoke_url="https://padlhub.su/lk/advertising/split-payment-promo"'));
  assert.ok(wrapper.includes("value.currency !== \"RUB\""));
  assert.ok(wrapper.includes('%{http_code}'));
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['nodered:lk1-plan-rules:deploy-147'],
    'bash scripts/deploy_nodered_lk1_plan_rules_147.sh');
});

test('the wrapper stage and backup paths satisfy the reviewed remote contract', () => {
  const helper = fs.readFileSync(
    path.join(repoRoot, 'scripts/nodered_reviewed_flow_deploy/deploy_reviewed_flow_147_remote.mjs'), 'utf8');
  const stageParent = /const STAGE_PARENT = "([^"]+)";/.exec(helper)?.[1];
  const patternLiteral = /const STAGE_PATTERN = \/(.+)\/;/.exec(helper)?.[1];
  const backupDir = /const BACKUP_DIRECTORY = "([^"]+)";/.exec(helper)?.[1];
  assert.ok(stageParent && patternLiteral && backupDir, 'remote stage/backup constants');
  const stagePattern = new RegExp(patternLiteral);
  const wrapper = fs.readFileSync(
    path.join(repoRoot, 'scripts/deploy_nodered_lk1_plan_rules_147.sh'), 'utf8');
  const stageLine = /^remote_stage="([^"]*)"$/m.exec(wrapper)?.[1];
  assert.ok(stageLine, 'remote_stage assignment');
  const rendered = stageLine
    .replace('$remote_stamp', '20260915T164214+0300')
    .replace(/\$\$/g, '76648');
  assert.equal(rendered.slice(0, rendered.lastIndexOf('/')), stageParent);
  assert.ok(stagePattern.test(rendered.slice(rendered.lastIndexOf('/') + 1)), rendered);
  assert.ok(wrapper.includes('remote_candidate="$remote_stage/candidate.flow.json"'));
  assert.ok(wrapper.includes('remote_contract="$remote_stage/contract.json"'));
  assert.ok(wrapper.includes(`remote_backup_dir="${backupDir}"`));
  assert.ok(wrapper.includes('remote_flow_backup="$remote_backup_dir/flows-pre-$deployment_id-$remote_stamp.json"'));
  assert.ok(wrapper.includes('remote_contract_backup="$remote_backup_dir/contract-$deployment_id-$remote_stamp.json"'));
});
