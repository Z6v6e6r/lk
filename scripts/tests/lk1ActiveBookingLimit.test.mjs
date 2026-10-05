import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildActiveBookingLimitTransitions, HUB_POLICY_PRIOR, HUB_POLICY_LIMIT_8,
  PLAN_RULES_LIMIT_8, PLAN_RULES_WITH_PATRIOTS_LIMIT_8 } from '../lib/lk1ActiveBookingLimit.mjs';
import { LK1_PLAN_RULES_WITH_FRIENDSHIP_TWO_HOURS, LK1_PLAN_RULES_WITH_PATRIOTS,
  buildFriendshipTwoHoursPlanRulesTransition } from '../lib/lk1PlanRulesTransition.mjs';
import { buildHubPolicyTransition, HUB_POLICY_KEY } from '../lib/lk1HubPolicyTransition.mjs';
import { readHubLk1Sale, buildHubRuntimeEvidence } from '../lib/hubLk1SaleContract.mjs';
import { patchLimitFlow, composeActiveBookingLimitArtifacts, assertPrivateCandidateOutput,
  LIMIT_NODES } from '../prepare_lk1_active_booking_limit.mjs';

const evaluatorSource = fs.readFileSync(new URL('../nodered_lk1_hub_nodes/evaluator.js', import.meta.url), 'utf8');
const context = entries => {
  const values = new Map(entries);
  return { get: key => values.get(key), set: (key, value) => values.set(key, value), values };
};

test('new generations change only the active limit, preserving historic priors and dormant products', () => {
  for (const [before, after] of [[LK1_PLAN_RULES_WITH_FRIENDSHIP_TWO_HOURS, PLAN_RULES_LIMIT_8],
    [LK1_PLAN_RULES_WITH_PATRIOTS, PLAN_RULES_WITH_PATRIOTS_LIMIT_8]]) {
    assert.deepEqual(after.rules.map(rule => ({ ...rule, maxActiveBookings: before.rules.find(old => old.productId === rule.productId).maxActiveBookings })), before.rules);
    assert.ok(after.rules.every(rule => rule.maxActiveBookings === 8));
  }
  assert.equal(PLAN_RULES_LIMIT_8.rules.length, 9);
  assert.equal(LK1_PLAN_RULES_WITH_FRIENDSHIP_TWO_HOURS.rules[8].maxActiveBookings, 6);
  assert.equal(PLAN_RULES_LIMIT_8.rules[8].freeGameMinutesPerDay, 120);
  assert.deepEqual(HUB_POLICY_LIMIT_8, { ...HUB_POLICY_PRIOR, maxActiveBookings: 8 });
});

test('limit writers support restart, exact prior and repeat; foreign policies refuse without overwriting', () => {
  const { hub, plans } = buildActiveBookingLimitTransitions();
  for (const [transition, key, prior, next] of [[hub, HUB_POLICY_KEY, HUB_POLICY_PRIOR, HUB_POLICY_LIMIT_8],
    [plans, 'subscriptions_lk1_plan_rules', LK1_PLAN_RULES_WITH_FRIENDSHIP_TWO_HOURS, PLAN_RULES_LIMIT_8]]) {
    for (const value of [null, prior, next, JSON.stringify(prior)]) {
      const global = context([[key, value]]);
      new Function('global', transition.initialize)(global);
      new Function('global', transition.initialize)(global);
      assert.deepEqual(global.get(key), next);
    }
    const foreign = key === HUB_POLICY_KEY ? { ...prior, maxActiveBookings: 5 }
      : { ...prior, rules: prior.rules.map(rule => ({ ...rule, maxActiveBookings: 5 })) };
    const global = context([[key, foreign]]);
    assert.throws(() => new Function('global', transition.initialize)(global), /prior mismatch/);
    assert.deepEqual(global.get(key), foreign);
  }
  const reader = new Function('global', hub.reader + 'return lk1ReadBoundPolicy();');
  assert.throws(() => reader(context([[HUB_POLICY_KEY, HUB_POLICY_PRIOR]])), /source policy mismatch/);
  assert.deepEqual(reader(context([[HUB_POLICY_KEY, HUB_POLICY_LIMIT_8]])), HUB_POLICY_LIMIT_8);
});

function evaluate(rule, activeServices, source = evaluatorSource) {
  const productId = rule.productId;
  const msg = { _managedSubscriptionPolicyInput: {
    evaluatedAt: '2026-10-05T09:00:00.000Z', action: 'JOIN_GAME', lk1Policy: rule,
    lk1ProductBinding: { policyProductId: productId, ownedProductId: productId, clientSubscriptionId: 'fixture:limit8' },
    target: { resolutionSource: 'SERVER', stationId: 'fixture-station', category: 'GAME',
      externalEventTypeId: productId === '37ab3713-4431-4815-96ba-d7ece76a9241' ? 'viva:direction:6181:type:2349' : 'viva:direction:4588:type:1613',
      durationMinutes: rule.freeGameMinutesPerDay, startsAt: '2026-10-06T08:00:00.000Z',
      basePriceMinor: 100000, currency: 'RUB', priceSource: 'VIVA_EXISTING_TARIFF' },
    usage: { activeServiceScope: 'SUBSCRIPTION_BENEFIT_ONLY', activeServices,
      dailyBucketLocalDate: '2026-10-06', usedOrReservedFreeMinutesToday: 0, freeFirstEvent: { covered: false } },
  } };
  const output = new Function('msg', source)(msg);
  return (output[0] || output[1])._managedSubscriptionPolicyDecision;
}

test('all plan products and HUB retain free minutes at 4 and 7, cross the threshold at 8 and 9', () => {
  for (const rule of [...PLAN_RULES_WITH_PATRIOTS_LIMIT_8.rules, HUB_POLICY_LIMIT_8]) {
    for (const active of [0, 4, 7, 8, 9]) {
      const decision = evaluate(rule, active);
      assert.equal(decision.eligible, true, `${rule.planKey || 'hub'}/${active}`);
      assert.equal(decision.maxActiveServices, 8);
      assert.equal(decision.aboveActiveLimit, active >= 8);
      assert.equal(decision.subscriptionVisitCount, active < 8 ? 1 : 0);
      assert.equal(decision.gameMinutes.freeMinutes, active < 8 ? rule.freeGameMinutesPerDay : 0);
      assert.equal(decision.benefit.finalPriceMinor, active < 8 ? 0 : 70000);
    }
  }
});

function fixtureFlow() {
  const hub = buildHubPolicyTransition({ expectedPrior: null, desired: HUB_POLICY_PRIOR });
  const plans = buildFriendshipTwoHoursPlanRulesTransition();
  const flow = [
    { id: LIMIT_NODES.gateway, type: 'function', func: hub.reader + '\n// activeServiceScope: "SUBSCRIPTION_BENEFIT_ONLY"', initialize: hub.initialize + plans.initialize, wires: [] },
    { id: LIMIT_NODES.preview, type: 'function', func: hub.reader, initialize: '', wires: [] },
    { id: '8f7bd5b482fe9763', type: 'function', func: '', wires: [] },
    { id: 'lk_subscription_booking_finalize_20260804', type: 'function', func: '', wires: [] },
    { id: 'lk_subscription_managed_policy_20260820', type: 'function', func: '// usage.activeServiceScope !== "SUBSCRIPTION_BENEFIT_ONLY"', wires: [] },
    { id: 'lk_subscription_product_router_20260907', type: 'function', func: '', wires: [] },
  ];
  const receipt = buildHubRuntimeEvidence(flow, { initializerSuffix: plans.initialize }).receipt;
  flow.push({ id: LIMIT_NODES.receipt, type: 'function', func: '', initialize: `const hubSaleRuntimeReceipt = ${JSON.stringify(receipt)};\nglobal.set("subscriptions_lk1_hub_sale_runtime", hubSaleRuntimeReceipt);\n`, wires: [] });
  return { flow, hub, plans };
}

test('gateway, preview, writer and refreshed sale receipt agree; bad reader and stale receipt refuse', () => {
  const { flow, hub, plans } = fixtureFlow();
  const next = buildActiveBookingLimitTransitions();
  const options = { beforeHub: hub, beforePlans: plans, afterHub: next.hub, afterPlans: next.plans };
  const built = patchLimitFlow(flow, options);
  const global = context([['summer_subscription_hub_lk1_sales_enabled', true], ['summer_subscription_sales_20260909_enabled', true]]);
  new Function('global', built.flow.find(n => n.id === LIMIT_NODES.gateway).initialize)(global);
  new Function('global', built.flow.find(n => n.id === LIMIT_NODES.receipt).initialize)(global);
  assert.equal(readHubLk1Sale(global).policy.maxActiveBookings, 8);
  assert.notEqual(built.evidence.receipt.sourceDigest, /sourceDigest/.test(flow[6].initialize) ? JSON.parse(flow[6].initialize.split(' = ')[1].split(';\n')[0]).sourceDigest : null);
  for (const id of [LIMIT_NODES.gateway, LIMIT_NODES.preview]) {
    assert.deepEqual(new Function('global', built.flow.find(n => n.id === id).func + '\nreturn lk1ReadBoundPolicy();')(global), HUB_POLICY_LIMIT_8);
  }
  new Function('global', flow.find(n => n.id === LIMIT_NODES.receipt).initialize)(global);
  assert.equal(readHubLk1Sale(global), null);
  const bad = structuredClone(flow); bad[1].func = '';
  assert.throws(() => patchLimitFlow(bad, options), /preimage drift/);
  assert.throws(() => composeActiveBookingLimitArtifacts(Buffer.from(JSON.stringify(flow))), /preimage drift/);
});

const privateFlow = process.env.LK1_ACTIVE_LIMIT_LIVE_FLOW;
test('fresh reviewed live snapshot changes only three nodes; rollback restores limits and receipt; evaluators remain identical',
  { skip: !privateFlow }, () => {
    const bytes = fs.readFileSync(privateFlow);
    const built = composeActiveBookingLimitArtifacts(bytes);
    const source = JSON.parse(bytes), candidate = JSON.parse(built.candidateBytes), rollback = JSON.parse(built.rollbackBytes);
    assert.deepEqual(candidate.filter((n, i) => !isEqual(n, source[i])).map(n => n.id).sort(), Object.values(LIMIT_NODES).sort());
    for (const flow of [candidate, rollback]) {
      const global = context([['summer_subscription_hub_lk1_sales_enabled', true], ['summer_subscription_sales_20260909_enabled', true]]);
      // Station exclusion initializer needs no provider and receives the real installed values.
      new Function('global', flow.find(n => n.id === LIMIT_NODES.gateway).initialize)(global);
      new Function('global', 'env', flow.find(n => n.id === LIMIT_NODES.receipt).initialize)(global, { get: () => '' });
      global.set('summer_subscription_hub_lk1_sales_enabled', true);
      global.set('summer_subscription_sales_20260909_enabled', true);
      const limit = flow === candidate ? 8 : 4;
      assert.equal(readHubLk1Sale(global).policy.maxActiveBookings, limit);
      assert.deepEqual(global.get('subscriptions_lk1_plan_rules'), flow === candidate ? PLAN_RULES_LIMIT_8 : LK1_PLAN_RULES_WITH_FRIENDSHIP_TWO_HOURS);
    }
    for (const id of ['lk_subscription_managed_policy_20260820', 'lk_subscription_price_preview_20260908_evaluate']) {
      const body = candidate.find(n => n.id === id).func;
      assert.equal(body, source.find(n => n.id === id).func);
      for (const rule of [...PLAN_RULES_LIMIT_8.rules, HUB_POLICY_LIMIT_8]) {
        for (const active of [7, 8, 9]) assert.deepEqual(evaluate(rule, active, body), evaluate(rule, active, candidate.find(n => n.id === 'lk_subscription_price_preview_20260908_evaluate').func));
      }
    }
    assert.throws(() => composeActiveBookingLimitArtifacts(built.candidateBytes), /preimage drift/);
  });
function isEqual(left, right) { return JSON.stringify(left) === JSON.stringify(right); }

test('raw-flow output refuses primary, sibling and nested Git checkouts before creating files', () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'lk-limit8-output-'));
  try {
    for (const kind of ['file', 'directory']) {
      const repo = `${root}/${kind}`;
      fs.mkdirSync(repo);
      if (kind === 'file') fs.writeFileSync(`${repo}/.git`, 'gitdir: synthetic');
      else fs.mkdirSync(`${repo}/.git`);
      fs.mkdirSync(`${repo}/nested`);
      assert.throws(() => assertPrivateCandidateOutput(`${repo}/nested/output`), /outside every Git checkout/);
      assert.equal(fs.existsSync(`${repo}/nested/output`), false);
    }
    assert.doesNotThrow(() => assertPrivateCandidateOutput(`${root}/private-candidate`));
    assert.throws(() => assertPrivateCandidateOutput('relative-output'), /absolute/);
  } finally { fs.rmSync(root, { recursive: true }); }
});
