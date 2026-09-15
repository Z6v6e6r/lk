import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { fixture } from './subscriptionPreviewUsagePatch.test.mjs';
import { extractSubscriptionPricePreviewSource } from '../lib/subscriptionPricePreviewSources.mjs';
import { patchAuditPreview, composeSubscriptionAuditFixes, AUDIT_TARGETS } from '../patch_nodered_subscription_audit_fixes.mjs';
import { normalizeServiceDateMoscow } from '../lib/subscriptionAuditFixes.mjs';
import { buildExactGraphContract, validateReviewedFlowContract } from '../nodered_reviewed_flow_deploy/runtime_contract.mjs';

const date = '2099-09-29';
const rule = { productId: 'db7a5250-7369-4f43-8ac5-9111be24bc74', maxActiveBookings: 4,
  freeGameMinutesPerDay: 60, gameOverageDiscountPercent: 30, groupTrainingDiscountPercent: 50, tournamentDiscountPercent: 50 };
const context = () => ({ step: 'lk1_usage_operations', actorClientId: 'fixture:actor', tenantKey: 'fixture',
  clientSubscriptionId: 'fixture:sub', exerciseId: 'fixture:event', serviceDate: date, managedAction: 'JOIN_GAME',
  operationId: 'fixture:operation', lk1: { rule, target: { category: 'GAME' }, bookings: [], activeBookings: [] } });
const op = extra => ({ actorClientId: 'fixture:actor', tenantKey: 'fixture', clientSubscriptionId: 'fixture:sub',
  exerciseId: 'fixture:event', serviceDate: date, state: 'PENDING_CONFIRMATION', upstreamBookingId: 'fixture:booking',
  lk1: { decision: { benefit: { finalPriceMinor: 0 }, subscriptionVisitCount: 1,
    gameMinutes: { localDate: date, freeMinutes: 60, paidOverageMinutes: 0 } } }, ...extra });
const booking = extra => ({ id: 'fixture:booking', clientId: 'fixture:actor', clientSubscriptionId: 'fixture:sub',
  paymentType: 'SUBSCRIPTION', exerciseId: 'fixture:event', exerciseType: { id: 1613 },
  exercise: { id: 'fixture:event', timeFrom: `${date}T07:00:00+03:00`, timeTo: `${date}T08:00:00+03:00` }, ...extra });
const globals = { structuredClone, console: { log() {}, warn() {}, error() {} } };
const compile = source => vm.compileFunction(source, ['msg', 'node', 'env', 'global'], { parsingContext: vm.createContext(globals) });
const closure = source => compile(`${extractSubscriptionPricePreviewSource({ source, roots: ['canonicalUsage'] }).source}\nreturn canonicalUsage(msg);`);
const livePath = process.env.LK_SUBSCRIPTION_AUDIT_FLOW_FIXTURE;
const bytes = livePath ? fs.readFileSync(livePath) : null;
const packet = bytes ? composeSubscriptionAuditFixes(bytes, 'audit-regression') : null;
// The tracked fixture already uses the new date helper; usage still reproduces the old rules.
const fixedFixture = patchAuditPreview(fixture.replace(/function normalizeServiceDateMoscow\([\s\S]*?\n}\n/, '')
  .replaceAll('normalizeServiceDateMoscow(value)', 'normalizeDate(value)')
  .replaceAll('normalizeServiceDateMoscow(value[key])', 'normalizeDate(value[key])'));
const runners = [['tracked preview', closure(fixedFixture)]];
if (packet) {
  const source = id => packet.candidate.find(row => row.id === id).func;
  runners.push(['exact installed successor gateway', compile(source(AUDIT_TARGETS[0][0]))]);
  runners.push(['exact installed successor preview closure', closure(source(AUDIT_TARGETS[1][0]))]);
}
for (const [label, execute] of runners) {
  const run = (operations, bookings = [], active = bookings) => {
    const ctx = context(); Object.assign(ctx.lk1, { bookings, activeBookings: active });
    const msg = { payload: structuredClone(operations), _subscriptionBooking: ctx };
    execute(msg, { error() {}, warn() {}, status() {} }, { get() { return null; } }, { get() { return null; } });
    return msg;
  };
  const usage = result => result._managedSubscriptionPolicyInput?.usage;
  test(`${label}: F7 exact upstream FREE binding counts once without changing claim`, () => {
    const operation = op(); const before = structuredClone(operation);
    const result = run([operation], [booking()]);
    assert.equal(usage(result)?.usedOrReservedFreeMinutesToday, 60);
    assert.equal(usage(result)?.activeServices, 1);
    assert.deepEqual(operation, before);
  });
  test(`${label}: F7 mismatched or ambiguous binding fails closed`, () => {
    const shortFree = op(); shortFree.lk1.decision.gameMinutes.freeMinutes = 30;
    const variants = [
      [[shortFree], [booking()]],
      [[op({ bookingId: 'other' })], [booking()]],
      [[op()], [booking({ clientId: 'other' })]],
      [[op()], [booking({ subscriptionId: 'other' })]],
      [[op()], [booking({ exerciseId: 'other' })]],
      [[op()], [booking({ exercise: { id: 'fixture:event', timeFrom: '2099-09-28T07:00:00+03:00' } })]],
      [[op()], [booking(), booking()]],
    ];
    for (const [ops, rows] of variants) assert.equal(usage(run(ops, rows)), undefined);
  });
  test(`${label}: absent/mixed provider evidence keeps reservation`, () => {
    assert.equal(usage(run([op()], []))?.usedOrReservedFreeMinutesToday, 60);
    const mixed = op(); mixed.lk1.decision.benefit.finalPriceMinor = 100;
    assert.equal(usage(run([mixed], [booking()]))?.usedOrReservedFreeMinutesToday, 120);
    assert.equal(usage(run([op({ state: 'RELEASED' })], [booking()]))?.usedOrReservedFreeMinutesToday, 60);
  });
  test(`${label}: F1/F2 cross-date paid benefit cap with selected-instance isolation`, () => {
    const rows = Array.from({ length: 4 }, (_, i) => op({ bookingId: `paid:${i}`, upstreamBookingId: null,
      serviceDate: `2099-09-${25 + i}`, lk1: { decision: { gameMinutes: { localDate: `2099-09-${25 + i}`, freeMinutes: 0 } } } }));
    const active = rows.map(row => ({ id: row.bookingId, paymentType: 'ON_PLACE' }));
    const result = run(rows, [], [...active, active[0]]);
    assert.equal(usage(result)?.activeServices, 4);
    assert.equal(usage(result)?.usedOrReservedFreeMinutesToday, 0);
    assert.equal(usage(run(rows.map(row => ({ ...row, clientSubscriptionId: 'another' })), [], active))?.activeServices, 0);
    assert.equal(usage(run(rows.map(row => ({ ...row, actorClientId: 'another' })), [], active)), undefined);
  });
}

test('F3 service-day normalization is Moscow and rejects impossible dates/times', () => {
  for (const input of ['2099-09-28T21:00:00Z', '2099-09-28T17:00:00-04:00', '2099-09-29T00:00:00+03:00',
    '2099-09-29', '2099-09-29T00:00:00.123456']) assert.equal(normalizeServiceDateMoscow(input), date);
  assert.equal(normalizeServiceDateMoscow('2099-09-28T20:59:59Z'), '2099-09-28');
  for (const input of ['2099-02-29', '2099-09-29T24:00:00Z', '2099-09-29T00:60:00Z', '', null]) {
    assert.equal(normalizeServiceDateMoscow(input), null);
  }
});

test('F4 invalid lookup never reaches game mutation, valid empty still continues', () => {
  const source = packet?.candidate.find(row => row.id === AUDIT_TARGETS[2][0]).func
    || fs.readFileSync(new URL('../nodered_games_nodes/fn_split_leave_daily_limit_route.js', import.meta.url), 'utf8');
  const run = (payload, error) => compile(source)({ payload, error, _splitLeaveCtx: { operationId: 'fixture:leave' } });
  for (const [payload, error] of [[undefined, {}], [{}, null], [[null], null], [[{}, null], null], [[], {}]]) {
    const outputs = run(payload, error);
    assert.equal(outputs.filter(Boolean).length, 1);
    assert.equal(outputs[3].payload.state, 'RETRY_REQUIRED');
    assert.equal(outputs[3].payload.reason, 'daily_limit_read_unavailable');
  }
  const empty = run([], null);
  assert.equal(empty.filter(Boolean).length, 1);
  assert.equal(empty.find(Boolean)._splitLeaveCtx.dailyLimitReleaseOutcome, 'NOT_APPLICABLE');
});

test('exact full graph custody and inverse; no routes/wires/config/payment code changes', { skip: !packet }, () => {
  const original = JSON.parse(bytes);
  for (const old of original) {
    const after = packet.candidate.find(row => row.id === old.id);
    assert.deepEqual(AUDIT_TARGETS.some(([id]) => id === old.id) ? { ...after, func: old.func } : after, old);
  }
  const inverse = buildExactGraphContract({ liveBytes: packet.candidateBytes, candidateBytes: bytes,
    deploymentId: 'audit-inverse', allowedChanges: AUDIT_TARGETS.map(([id]) => ({ id, fields: ['func'] })) });
  validateReviewedFlowContract({ liveBytes: packet.candidateBytes, candidateBytes: bytes, contract: inverse });
  assert.throws(() => composeSubscriptionAuditFixes(packet.candidateBytes, 'repeat'), /drift/);
  const before = original.find(row => row.id === AUDIT_TARGETS[0][0]).func;
  const after = packet.candidate.find(row => row.id === AUDIT_TARGETS[0][0]).func;
  assert.ok(before.includes('actorClientId: ctx.actorClientId, serviceDate: ctx.serviceDate,\n      "lk1.rule.productId"'));
  assert.ok(after.includes('actorClientId: ctx.actorClientId,\n      "lk1.rule.productId"'));
});

// Reuse only the existing synthetic DTO harness, without its historical composer.
test('full successor preview routes a historical operation to a valid event quote', { skip: !packet }, () => {
  const source = fs.readFileSync(new URL('./groupSubscriptionDiscount.backend.test.mjs', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('const uuid ='), source.indexOf("run('group quote gives"))
    .replace('msg, global: { get:', 'structuredClone, msg, global: { get:');
  const harness = new Function('candidate', 'assert', 'vm', 'options', body + '\nreturn harness(options);');
  const historic = { tenantKey: 'iSkq6G', actorClientId: '00000000-0000-4000-8000-000000000001',
    clientSubscriptionId: '00000000-0000-4000-8000-000000000002', serviceDate: '2099-09-20', state: 'CONFIRMED',
    bookingId: 'fixture:historic', lk1: { rule: { productId: rule.productId }, decision: { gameMinutes: { localDate: '2099-09-20', freeMinutes: 60 } } } };
  const result = harness(packet.candidate, assert, vm, { operations: [historic] });
  assert.equal(result.ctx.error, undefined);
  assert.equal(result.ctx.quotes[0].amountMinor, 275000);
  assert.ok(result.calls.filter(call => call.output === 0).every(call => call.method === 'GET'));
});
