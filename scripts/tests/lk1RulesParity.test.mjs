import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { composeRulesParityArtifacts, patchCourtDecisionRefusal, NODES, CHANGES, SOURCE_SHA256,
  POSTIMAGES, sha256 } from '../prepare_lk1_rules_parity_20261006.mjs';
import { composeLk1TrainG1Artifacts } from '../patch_live_lk1_train_g1_20261005.mjs';
import { composeLk1TrainG2Artifacts } from '../patch_live_lk1_train_g2_20261005.mjs';
import { validateReviewedFlowContract } from '../nodered_reviewed_flow_deploy/runtime_contract.mjs';
import { readHubLk1Sale } from '../lib/hubLk1SaleContract.mjs';
import { PLAN_RULES_LIMIT_8 } from '../lib/lk1ActiveBookingLimit.mjs';

const read = file => fs.readFileSync(new URL(file, import.meta.url), 'utf8');
const hooks = read('../nodered_lk1_hub_nodes/gateway_hooks.js');
const preview = read('../nodered_subscription_price_preview_nodes/router.js');
function totalReader(source, canonical = false) {
  const start = source.indexOf('const lk1CourtWindowTotal =');
  const end = source.indexOf('\n};', start) + 3;
  assert.ok(start >= 0 && end > start);
  const body = source.slice(start, end);
  const isObj = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  return new Function(canonical ? 'canonical' : 'isObj', body + '\nreturn lk1CourtWindowTotal;')(
    canonical ? { isObj } : isObj);
}

function refusalMessage() {
  const productId = '14692232-12be-4218-9fa1-2d5b79b62035';
  const msg = { _subscriptionBooking: { caller: 'http', lk1: {} }, _managedSubscriptionPolicyInput: {
    evaluatedAt: '2026-08-14T08:00:00.000Z', action: 'BOOK_GROUP_TRAINING',
    lk1Policy: PLAN_RULES_LIMIT_8.rules.find(r => r.productId === productId),
    lk1ProductBinding: { policyProductId: productId, ownedProductId: productId, clientSubscriptionId: 'fixture:club-sub' },
    target: { resolutionSource: 'SERVER', stationId: 'station-club', category: 'GROUP_TRAINING',
      externalEventTypeId: 'viva:direction:6233:type:2349', durationMinutes: 120,
      startsAt: '2026-08-15T07:00:00.000Z', basePriceMinor: 100000, currency: 'RUB',
      priceSource: 'VIVA_EXISTING_TARIFF', directionId: 6233, hourlyCourtPriceMinor: 600000 },
    usage: { activeServiceScope: 'SUBSCRIPTION_BENEFIT_ONLY', dailyBucketLocalDate: '2026-08-15',
      activeServices: 0, usedOrReservedFreeMinutesToday: 0 },
  } };
  return msg;
}

test('booking and preview convert the existing ruble total exactly once, including kopecks', () => {
  for (const reader of [totalReader(hooks), totalReader(preview, true)]) {
    for (const [amount, minor] of [[12000, 1200000], ['12000.50', 1200050], [0.29, 29], [100000, 10000000]]) {
      assert.equal(reader({ total: amount }), minor);
    }
    for (const amount of [true, null, '', ' ', '1e3', '1.000', 12000.001, 0, -1, 100000.01, Infinity, NaN]) {
      assert.equal(reader({ total: amount }), null, String(amount));
    }
    assert.equal(reader({ from: 12000 }), null);
  }
});

test('booking and preview propagate the identical explicit refusal before a payment/visit continuation', () => {
  const decision = { eligible: false, blockers: [{ code: 'LK1_COURT_COPAY_UNREPRESENTABLE' }] };
  const anchor = 'if (ctx.step === "lk1_policy_decision") {\n  const decision = msg._managedSubscriptionPolicyDecision;\n';
  const body = patchCourtDecisionRefusal(anchor + '  throw Error("unsafe continuation");\n}\n');
  const booking = new Function('ctx', 'msg', 'isObj', 'lk1Stop', body)(
    { step: 'lk1_policy_decision' }, { _managedSubscriptionPolicyDecision: decision },
    value => value && typeof value === 'object', (_ctx, code) => ({ code }));
  assert.equal(booking.code, decision.blockers[0].code);
  const msg = { _subscriptionPricePreview: { step: 'evaluate' }, _managedSubscriptionPolicyDecision: decision };
  const outputs = new Function('msg', 'canonical', 'global', preview)(msg,
    { isObj: value => value && typeof value === 'object' }, { get: () => null });
  assert.equal(outputs[4], msg);
  assert.equal(msg._subscriptionPricePreview.error, booking.code);
  assert.equal(msg._subscriptionPricePreview.statusCode, 503);
  assert.throws(() => patchCourtDecisionRefusal(''), /anchor drift/);
});

test('the current composer refuses unknown full-flow bytes; old train generations stay refused', () => {
  assert.throws(() => composeRulesParityArtifacts(Buffer.from('[]')), /preimage drift/);
  assert.throws(() => composeLk1TrainG1Artifacts(Buffer.from('[]')), /preimage drift/);
  assert.throws(() => composeLk1TrainG2Artifacts(Buffer.from('[]')), /postimage drift/);
});

test('the source denied graph preserves pending/code and never opens payment on repeated refusal', () => {
  const evaluator = new Function('msg', read('../nodered_lk1_hub_nodes/evaluator.js'));
  const blocked = new Function('msg', read('../nodered_subscription_booking_nodes/fn_managed_subscription_policy_blocked.js'));
  const finalize = new Function('msg', 'const ctx = msg._subscriptionBooking;\n'
    + 'const payload = msg.payload;\nconst responseStatus = Number(msg.statusCode) || 0;\n'
    + read('../nodered_lk1_hub_nodes/finalize.js'));
  for (let attempt = 0; attempt < 2; attempt++) {
    const msg = refusalMessage();
    msg._subscriptionBooking.operationId = 'fixture-court-refusal';
    const outputs = evaluator(msg);
    assert.equal(outputs[0], null, 'no admission output on initial or repeated command');
    assert.equal(outputs[1]._managedSubscriptionPolicyDecision.eligible, false);
    const response = finalize(blocked(outputs[1]));
    assert.equal(response[0], null, 'no create/payment continuation');
    assert.equal(response[1].statusCode, 202);
    assert.equal(response[1].payload.state, 'PENDING_CONFIRMATION');
    assert.equal(response[1].payload.operationId, 'fixture-court-refusal');
    assert.equal(response[1].payload.details.code, 'LK1_COURT_COPAY_UNREPRESENTABLE');
    for (const field of ['paymentUrl', 'transactionId', 'bookingId']) assert.equal(response[1].payload[field], undefined);
  }
});

const snapshot = process.env.LK1_RULES_PARITY_SNAPSHOT;
const skip = !snapshot || !fs.existsSync(snapshot) ? 'private reviewed snapshot not supplied' : false;
test('one current graph composes money parity, keeps dormant cap8 policies and refreshes matching receipt', { skip }, () => {
  const source = fs.readFileSync(snapshot);
  assert.equal(sha256(source), SOURCE_SHA256);
  const before = JSON.parse(source);
  const built = composeRulesParityArtifacts(source);
  assert.equal(built.candidateSha256, POSTIMAGES.flow);
  assert.equal(built.flow.length, before.length);
  assert.deepEqual(built.contract.allowedChanges.map(({ id, fields }) => ({ id, fields })), CHANGES);
  assert.equal(built.contract.allowedAdditions.length, 0);
  const node = (flow, key) => flow.find(n => n.id === NODES[key]);
  assert.equal(node(built.flow, 'gateway').initialize, node(before, 'gateway').initialize);
  assert.equal(node(built.flow, 'evaluator').func, node(built.flow, 'previewEvaluate').func);
  assert.ok(node(built.flow, 'evaluator').func.includes('LK1_COURT_COPAY_UNREPRESENTABLE'));
  const gateway = node(built.flow, 'gateway').func;
  assert.equal(gateway.includes('patriotsMoneyOnlyIdentity'), false);
  assert.ok(gateway.indexOf('const proTrainingIsRecord') < gateway.indexOf('if (ctx.step === "exercise")'));
  assert.ok(gateway.indexOf('if (ctx.step === "lk1_court_window")') < gateway.indexOf('if (ctx.step === "exercise")'));
  assert.ok(gateway.includes('ctx.step = "exercise";\n  msg.payload = exercise;'));
  // Exercise the installed denied-output graph as well as the defensive gateway guard above.
  const msg = refusalMessage();
  const requestInput = structuredClone(msg._managedSubscriptionPolicyInput);
  const evaluate = new Function('msg', node(built.flow, 'evaluator').func);
  const outputs = evaluate(msg);
  assert.equal(outputs[0], null, 'no admission continuation');
  assert.equal(outputs[1], msg);
  const deniedId = node(built.flow, 'evaluator').wires[1][0];
  const denied = built.flow.find(n => n.id === deniedId);
  const rejected = new Function('msg', denied.func)(msg);
  const finalizer = built.flow.find(n => n.id === denied.wires[0][0]);
  const finalized = new Function('msg', finalizer.func)(rejected);
  assert.equal(finalized[0], null, 'no split/provider continuation');
  assert.equal(finalized[1].statusCode, 202, 'existing LK1 finalize keeps pending semantics');
  assert.equal(finalized[1].payload.state, 'PENDING_CONFIRMATION');
  assert.equal(finalized[1].payload.details.code, 'LK1_COURT_COPAY_UNREPRESENTABLE');
  assert.equal(finalized[1].payload.paymentUrl, undefined);
  assert.equal(finalized[1].payload.transactionId, undefined);
  assert.equal(finalized[1].payload.bookingId, undefined);
  // Pending is the existing response envelope, not authority for a fresh purchase. The same
  // definite refusal on a repeated command still cannot reach admission/create/payment output.
  const repeat = { _subscriptionBooking: { caller: 'http', lk1: {} },
    _managedSubscriptionPolicyInput: requestInput };
  const repeatOutputs = evaluate(repeat);
  assert.equal(repeatOutputs[0], null);
  assert.equal(repeatOutputs[1]._managedSubscriptionPolicyDecision.eligible, false);
  const repeated = new Function('msg', finalizer.func)(new Function('msg', denied.func)(repeatOutputs[1]));
  assert.equal(repeated[0], null);
  assert.equal(repeated[1].statusCode, 202);
  assert.equal(repeated[1].payload.state, 'PENDING_CONFIRMATION');
  assert.equal(repeated[1].payload.details.code, 'LK1_COURT_COPAY_UNREPRESENTABLE');
  for (const field of ['paymentUrl', 'transactionId', 'bookingId']) assert.equal(repeated[1].payload[field], undefined);
  assert.throws(() => composeRulesParityArtifacts(built.candidateBytes), /preimage drift/);
  assert.throws(() => composeLk1TrainG1Artifacts(source), /preimage drift/);
  assert.throws(() => composeLk1TrainG2Artifacts(source), /postimage drift/);
  const values = new Map();
  const global = { get: key => values.get(key), set: (key, value) => values.set(key, value) };
  const env = { get: () => '' };
  new Function('global', 'env', node(built.flow, 'gateway').initialize)(global, env);
  assert.deepEqual(values.get('subscriptions_lk1_plan_rules'), PLAN_RULES_LIMIT_8);
  assert.equal(values.get('subscriptions_lk1_product_policy').maxActiveBookings, 8);
  new Function('global', 'env', node(built.flow, 'receipt').initialize)(global, env);
  assert.equal(readHubLk1Sale(global), null, 'initializer does not authorize sales');
  for (const flag of ['summer_subscription_hub_lk1_sales_enabled', 'summer_subscription_sales_20260909_enabled']) values.set(flag, true);
  assert.deepEqual(readHubLk1Sale(global), built.receipt);
  const oldReceiptDigest = /"sourceDigest":"([^"]+)"/.exec(node(before, 'receipt').initialize)[1];
  assert.notEqual(built.receipt.sourceDigest, oldReceiptDigest);
  assert.equal(sha256(built.rollbackBytes), SOURCE_SHA256);
  validateReviewedFlowContract({ liveBytes: built.candidateBytes, candidateBytes: built.rollbackBytes,
    contract: built.rollbackContract });
  const drift = structuredClone(built.flow);
  drift.find(n => n.type === 'http in').url += '-foreign';
  assert.throws(() => validateReviewedFlowContract({ liveBytes: source,
    candidateBytes: Buffer.from(JSON.stringify(drift, null, 2) + '\n'), contract: built.contract }));
});
