import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { patchPaidBenefitUsage } from '../patch_nodered_subscription_paid_join.mjs';
import { extractSubscriptionPricePreviewSource } from '../lib/subscriptionPricePreviewSources.mjs';
import { composeSubscriptionPreviewUsageArtifacts, patchSubscriptionPreviewUsage, PREVIEW_ROUTER_ID } from '../patch_nodered_subscription_preview_usage.mjs';
import { buildExactGraphContract, validateReviewedFlowContract } from '../nodered_reviewed_flow_deploy/runtime_contract.mjs';

const read = file => fs.readFileSync(new URL(file, import.meta.url), 'utf8');
const gateway = read('../nodered_lk1_hub_nodes/gateway.js');
const base = read('../nodered_subscription_booking_nodes/fn_subscription_booking_router.js');
const roots = ['isObj', 'unwrapRecord', 'isValidDateKey', 'normalizeId', 'isInactiveBooking', 'eventDate',
  'bookingSubscriptionId', 'bookingId', 'resolveCategory', 'eventDurationMinutes'];
const helpers = extractSubscriptionPricePreviewSource({ source: base, roots }).source;
const fields = extractSubscriptionPricePreviewSource({ source: gateway, roots: ['lk1Fields'] }).source;
const start = gateway.indexOf('if (ctx.step === "lk1_usage_operations") {');
const end = gateway.indexOf('if (ctx.step === "lk1_policy_decision") {');
assert.ok(start >= 0 && end > start);
const currentUsage = gateway.slice(start, end);
// Recreate the historical guard from tracked source; no customer flow enters Git.
export const oldUsage = currentUsage.replace(/ {4}\/\/ AUDIT_BINDING_START[\s\S]*? {4}\/\/ AUDIT_BINDING_END\n/, '')
  .replace('if (coveredId) benefitBookings.add(coveredId);', 'if (operation.bookingId) benefitBookings.add(normalizeId(operation.bookingId));')
  .replace('if (coveredId) coveredBookings.add(coveredId);', 'if (operation.bookingId) coveredBookings.add(normalizeId(operation.bookingId));')
  .replace('activeServices: new Set(active.map(booking => normalizeId(bookingId(booking)))).size,', 'activeServices: active.length,')
  .replace('\n  const benefitBookings = new Set();', '')
  .replace('!isValidDateKey(operation.serviceDate)', 'operation.serviceDate !== ctx.serviceDate')
  .replace('    if (operation.bookingId) benefitBookings.add(normalizeId(operation.bookingId));\n', '')
  .replace('    if (operation.serviceDate !== ctx.serviceDate) continue;\n', '')
  .replace('\n    || benefitBookings.has(normalizeId(bookingId(booking)))', '');
const exports = roots.filter(name => name !== 'isValidDateKey');
export const fixture = `const canonical = (() => { ${helpers}\n${fields}\nreturn {${exports.join(',')},lk1Fields}; })();
const canonicalUsage = msg => {
  const ctx = msg._subscriptionBooking;
  const { isObj, normalizeId, isInactiveBooking, eventDate, bookingSubscriptionId, bookingId, resolveCategory, eventDurationMinutes, lk1Fields } = canonical;
  const OUTPUT_MANAGED_POLICY = 6;
  const emit = () => msg;
  const lk1Stop = (_ctx, code) => { msg.previewError = code; return msg; };
  ${oldUsage}
};`;
const fixturePath = process.env.LK_PREVIEW_USAGE_FLOW_FIXTURE;
const liveBytes = fixturePath ? fs.readFileSync(fixturePath) : null;
const packet = liveBytes ? composeSubscriptionPreviewUsageArtifacts(liveBytes, 'preview-usage-test') : null;
const oldLiveSource = liveBytes ? JSON.parse(liveBytes).find(row => row.id === PREVIEW_ROUTER_ID).func : null;
const sources = [['tracked fixture', fixture]];
if (oldLiveSource) sources.push(['exact private live closure', oldLiveSource]);
const date = '2099-09-29', otherDate = '2099-09-28';
const rule = { productId: 'db7a5250-7369-4f43-8ac5-9111be24bc74', maxActiveBookings: 4,
  freeGameMinutesPerDay: 60, gameOverageDiscountPercent: 30, groupTrainingDiscountPercent: 50, tournamentDiscountPercent: 50 };
const ctx = () => ({ step: 'lk1_usage_operations', actorClientId: 'fixture:actor', tenantKey: 'fixture',
  clientSubscriptionId: 'fixture:subscription', serviceDate: date, managedAction: 'CREATE_GAME',
  lk1: { rule, target: { category: 'GAME', resolutionSource: 'SERVER', currency: 'RUB',
    priceSource: 'VIVA_EXISTING_TARIFF', basePriceMinor: 75000, durationMinutes: 60, startsAt: `${date}T07:00:00+03:00` },
  bookings: [], activeBookings: [] } });
const operation = (extra = {}) => ({ actorClientId: 'fixture:actor', tenantKey: 'fixture',
  clientSubscriptionId: 'fixture:subscription', serviceDate: otherDate, state: 'CONFIRMED', bookingId: 'fixture:booking',
  lk1: { decision: { gameMinutes: { localDate: otherDate, freeMinutes: 60 } } }, ...extra });
const paidBooking = id => ({ id, paymentType: 'ON_PLACE' });
const compile = source => {
  const pure = extractSubscriptionPricePreviewSource({ source, roots: ['canonicalUsage'] }).source;
  return vm.compileFunction(`${pure}\nreturn canonicalUsage(msg);`, ['msg'], { parsingContext: vm.createContext({}) });
};
const policy = msg => {
  const outputs = vm.compileFunction(read('../nodered_lk1_hub_nodes/evaluator.js'), ['msg'],
    { parsingContext: vm.createContext({}) })(msg);
  return (outputs[0] || outputs[1])._managedSubscriptionPolicyDecision;
};

for (const [label, source] of sources) {
  const fixed = patchSubscriptionPreviewUsage(source);
  const execute = compile(fixed);
  const run = (operations, extra = {}) => {
    const context = ctx(); Object.assign(context.lk1, extra);
    return execute({ payload: operations, _subscriptionBooking: context });
  };
  test(`${label}: reproduces old cross-date failure and fixes daily allowance`, () => {
    assert.equal(compile(source)({ payload: [operation()], _subscriptionBooking: ctx() }).previewError, 'LK1_ALLOWANCE_RECORD_INVALID');
    const result = run([operation()]);
    assert.equal(result.previewError, undefined);
    assert.equal(result._managedSubscriptionPolicyInput.usage.usedOrReservedFreeMinutesToday, 0);
    assert.equal(policy(result).eligible, true);
    assert.ok(fixed.includes(patchPaidBenefitUsage(oldUsage).trim()), 'Matches existing booking gateway usage rules');
  });
  test(`${label}: four cross-date paid-benefit bookings block, three remain eligible`, () => {
    for (const count of [3, 4]) {
      const ops = Array.from({ length: count }, (_, i) => operation({ bookingId: `fixture:${i}` }));
      const result = run(ops, { activeBookings: ops.map(row => paidBooking(row.bookingId)) });
      assert.equal(result._managedSubscriptionPolicyInput.usage.activeServices, count);
      const decision = policy(result);
      assert.equal(decision.eligible, count === 3);
      assert.equal(decision.blockers.some(row => row.code === 'ACTIVE_SERVICES_LIMIT_REACHED'), count === 4);
    }
  });
  test(`${label}: unrelated, released and absent provider bookings do not increase cap`, () => {
    const ops = [operation({ state: 'RELEASED', bookingId: 'released' }),
      operation({ state: 'FAILED', bookingId: 'failed' }),
      operation({ clientSubscriptionId: 'fixture:other', bookingId: 'other' }),
      operation({ bookingId: 'not-active' })];
    const result = run(ops, { activeBookings: ['released', 'failed', 'other'].map(paidBooking) });
    assert.equal(result._managedSubscriptionPolicyInput.usage.activeServices, 0);
  });
  test(`${label}: invalid rows fail closed even on other dates or subscriptions`, () => {
    const invalid = [null, [], operation({ actorClientId: 'foreign' }), operation({ tenantKey: 'foreign' }),
      operation({ serviceDate: '2099-02-29' }), operation({ serviceDate: 'bad' }), operation({ serviceDate: null }),
      operation({ clientSubscriptionId: '' }), operation({ lk1: {} }),
      operation({ clientSubscriptionId: 'fixture:other', lk1: {} }),
      operation({ state: 'RELEASED', serviceDate: 'invalid' })];
    for (const row of invalid) assert.equal(run([row]).previewError, 'LK1_ALLOWANCE_RECORD_INVALID');
    assert.equal(run(null).previewError, 'LK1_ALLOWANCE_READ_FAILED');
  });
  test(`${label}: same-day minutes are counted once and malformed minutes rejected`, () => {
    const op = operation({ serviceDate: date, lk1: { decision: { gameMinutes: { localDate: date, freeMinutes: 60 } } } });
    const booking = { id: op.bookingId, paymentType: 'SUBSCRIPTION', clientSubscriptionId: op.clientSubscriptionId,
      exerciseDate: `${date}T07:00:00+03:00`, exerciseType: { id: 1613 } };
    const result = run([op], { bookings: [booking], activeBookings: [booking] });
    assert.equal(result.previewError, undefined);
    assert.equal(result._managedSubscriptionPolicyInput.usage.usedOrReservedFreeMinutesToday, 60);
    assert.equal(result._managedSubscriptionPolicyInput.usage.activeServices, 1);
    for (const minutes of [{ localDate: otherDate, freeMinutes: 60 }, { localDate: date, freeMinutes: -1 },
      { localDate: date, freeMinutes: 0.5 }, { localDate: date, freeMinutes: '60' }]) {
      assert.equal(run([{ ...op, lk1: { decision: { gameMinutes: minutes } } }]).previewError, 'LK1_ALLOWANCE_RECORD_INVALID');
    }
    assert.equal(run([op], { bookings: [{ ...booking, clientSubscriptionId: undefined }] }).previewError,
      'LK1_BOOKING_SUBSCRIPTION_ID_UNRESOLVED');
  });
  test(`${label}: transform refuses repeat or missing helper export`, () => {
    assert.throws(() => patchSubscriptionPreviewUsage(fixed), /drift/);
    assert.throws(() => patchSubscriptionPreviewUsage(source.replace('return {isObj,unwrapRecord,', 'return {unwrapRecord,isObj,')), /drift/);
  });
}

test('composer rejects malformed graphs and unknown router bodies', () => {
  for (const flow of [{}, [null], [{ id: 'same' }, { id: 'same' }], [],
    [{ id: PREVIEW_ROUTER_ID, type: 'function', func: fixture }]]) {
    assert.throws(() => composeSubscriptionPreviewUsageArtifacts(Buffer.from(JSON.stringify(flow)), 'negative'), /Invalid|drift/);
  }
});
test('private exact graph changes one function, preserves reads and supports exact inverse contract', {
  skip: !packet && 'Requires private exact flow; customer data never copied into Git',
}, () => {
  const before = JSON.parse(liveBytes);
  assert.equal(packet.candidate.length, before.length);
  assert.deepEqual(packet.contract.allowedChanges.map(({ id, fields }) => ({ id, fields })),
    [{ id: PREVIEW_ROUTER_ID, fields: ['func'] }]);
  for (const row of before) {
    const after = packet.candidate.find(node => node.id === row.id);
    assert.deepEqual(row.id === PREVIEW_ROUTER_ID ? { ...after, func: row.func } : after, row);
  }
  const query = "return find('operations', { tenantKey: ctx.tenantKey, actorClientId: ctx.actorClientId,\n"
    + "    'lk1.rule.productId': 'db7a5250-7369-4f43-8ac5-9111be24bc74' }, 2);";
  const changed = packet.candidate.find(row => row.id === PREVIEW_ROUTER_ID).func;
  assert.ok(changed.includes(query));
  assert.ok(oldLiveSource.includes(query));
  const reverse = buildExactGraphContract({ liveBytes: packet.candidateBytes, candidateBytes: liveBytes,
    deploymentId: 'inverse-test', allowedChanges: [{ id: PREVIEW_ROUTER_ID, fields: ['func'] }] });
  validateReviewedFlowContract({ liveBytes: packet.candidateBytes, candidateBytes: liveBytes, contract: reverse });
  assert.throws(() => composeSubscriptionPreviewUsageArtifacts(packet.candidateBytes, 'repeat'), /preimage drift/);
  const drift = structuredClone(before); drift.find(row => row.id === PREVIEW_ROUTER_ID).func += '\n// drift';
  assert.throws(() => composeSubscriptionPreviewUsageArtifacts(Buffer.from(JSON.stringify(drift)), 'drift'), /preimage drift/);
});
