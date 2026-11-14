import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  CANCELLED_HOLD_TARGETS, GUARD_REJECT, USAGE_START, cancelledHoldGuardEdits, patchCancelledHoldBooking,
  patchCancelledHoldPreview, replaceOnce, unpatchCancelledHoldUsage,
} from '../patch_live_cancelled_hold_release.mjs';
import { reconciledRuntimeSource } from '../prepare_reconciled_cancellation_recovery.mjs';
import { patchDailyVisitUsage } from '../patch_live_lk1_daily_visit.mjs';

// Scenarios run against the repository sources by default. With
// CANCELLED_HOLD_CANDIDATE=<private candidate flows.json> they run against the exact
// usage steps of the composed live candidate instead (both routers).
const read = name => fs.readFileSync(new URL(name, import.meta.url), 'utf8');
const candidatePath = process.env.CANCELLED_HOLD_CANDIDATE;
const candidate = candidatePath ? JSON.parse(fs.readFileSync(candidatePath, 'utf8')) : null;
const usageSources = candidate
  ? { booking: candidate.find(n => n.id === CANCELLED_HOLD_TARGETS.booking.id).func,
    preview: candidate.find(n => n.id === CANCELLED_HOLD_TARGETS.preview.id).func }
  // The repository gateway is kept before the daily-visit generation, as in lk1DailyVisit.test.mjs.
  : { booking: patchCancelledHoldPreview(patchDailyVisitUsage(read('../nodered_lk1_hub_nodes/gateway.js'))) };

const product = 'b91e14d1-fe6e-4d0b-be39-3e45ad86b759';
const rule = { productId: product, maxActiveBookings: 8, freeGameMinutesPerDay: 60,
  gameOverageDiscountPercent: 30, groupTrainingDiscountPercent: 50, tournamentDiscountPercent: 50 };
const day = '2026-11-08';
const categoryOf = category => ({ GAME: 'open_game', GROUP_TRAINING: 'group_training', TOURNAMENT: 'tournament' })[category];
const earlier = () => new Date(Date.now() - 30000).toISOString();
const operation = (category, changes = {}) => ({ _id: 'operation-old', operationId: 'old', tenantKey: 'fixture',
  actorClientId: 'actor', clientSubscriptionId: 'subscription-a', serviceDate: day, category: categoryOf(category),
  state: 'CONFIRMED', bookingId: 'booking-old', exerciseId: 'exercise-old', updatedAt: earlier(),
  lk1: { rule, target: { category, directionId: 2680 }, decision: { subscriptionVisitCount: 1,
    benefit: { finalPriceMinor: 0 },
    ...(category === 'GAME' ? { gameMinutes: { localDate: day, freeMinutes: 60 } } : {}) } }, ...changes });
const cancelledRow = (changes = {}) => ({ id: 'booking-old', exerciseId: 'exercise-old', clientSubscriptionId: 'subscription-a',
  date: day, status: 'CANCELLED', isCancelled: true, ...changes });
const snapshot = (rows, observedAt = new Date().toISOString()) => ({ observedAt, active: [], history: rows });

function usageSlice(source) {
  const start = source.indexOf(USAGE_START);
  const policyEnd = source.indexOf('if (ctx.step === "lk1_policy_decision") {', start);
  const end = policyEnd >= 0 ? policyEnd : source.indexOf('\n\n  };\n// Dedicated advisory graph.', start);
  return source.slice(start, end);
}
function usage(source, category, operations, cancellationSnapshot, activeBookings = []) {
  const ctx = { step: 'lk1_usage_operations', tenantKey: 'fixture', actorClientId: 'actor',
    clientSubscriptionId: 'subscription-a', serviceDate: day, category: categoryOf(category),
    managedAction: { GAME: 'JOIN_GAME', GROUP_TRAINING: 'BOOK_GROUP_TRAINING', TOURNAMENT: 'BOOK_TOURNAMENT' }[category],
    lk1: { rule, bookings: [], activeBookings, cancellationSnapshot,
      target: { resolutionSource: 'SERVER', category, directionId: 2680, durationMinutes: 60,
        startsAt: '2026-11-08T09:00:00Z', basePriceMinor: 100000, priceSource: 'VIVA_EXISTING_TARIFF', currency: 'RUB' } },
    lk1ProductIdentity: { subscription: { visitsLeft: 20 } } };
  const msg = { payload: operations };
  const helpers = {
    ctx, msg, isObj: value => value !== null && typeof value === 'object' && !Array.isArray(value),
    isValidDateKey: value => /^\d{4}-\d{2}-\d{2}$/.test(value), normalizeId: value => typeof value === 'string' ? value.toLowerCase() : null,
    isInactiveBooking: b => b.cancelled === true || b.isCancelled === true, eventDate: b => b.date, bookingId: b => b.id,
    bookingSubscriptionId: b => b.clientSubscriptionId, eventDurationMinutes: b => b.durationMinutes,
    resolveCategory: b => b.category, exerciseDirectionId: b => b.directionId, lk1OperationCategory: o => o.category,
    lk1FreeFirstEventCovers: () => false,
    LK1_FREE_FIRST_EVENT_PRODUCTS: {}, LK1_FREE_FIRST_EVENT_DIRECTION_SCOPES: {},
    lk1Fields: Object.keys(rule).filter(k => k !== 'productId'),
    lk1Stop: (_ctx, code) => { msg.errorCode = code; }, emit: () => msg, OUTPUT_MANAGED_POLICY: 6,
  };
  new Function(...Object.keys(helpers), usageSlice(source))(...Object.values(helpers));
  assert.equal(msg.errorCode, undefined);
  return { usage: msg._managedSubscriptionPolicyInput.usage, ctx };
}

for (const [kind, source] of Object.entries(usageSources)) {
  test(`${kind}: a visit held by a provider-cancelled booking is free again`, () => {
    for (const category of ['GROUP_TRAINING', 'TOURNAMENT', 'GAME']) {
      const op = operation(category);
      const { usage: result, ctx } = usage(source, category, [op], snapshot([cancelledRow()]));
      assert.equal(result.usedOrReservedVisitsToday, 0, category);
      assert.equal(result.usedOrReservedFreeMinutesToday, 0, category);
      assert.equal(ctx.lk1CancelledHolds[op._id].owner, JSON.stringify(op));
    }
  });

  test(`${kind}: a same-day booking of another subscription or another day does not keep the hold`, () => {
    for (const row of [{ id: 'booking-x', clientSubscriptionId: 'subscription-b', date: day },
      { id: 'booking-y', clientSubscriptionId: 'subscription-a', date: '2026-11-09' }]) {
      const op = operation('GROUP_TRAINING');
      const { usage: result } = usage(source, 'GROUP_TRAINING', [op], snapshot([cancelledRow()]), [row]);
      assert.equal(result.usedOrReservedVisitsToday, 0, row.id);
    }
  });

  test(`${kind}: the takeover proof carries the receipt time, not the step time`, () => {
    const observedAt = new Date(Date.now() - 20000).toISOString();
    const op = operation('GROUP_TRAINING', { updatedAt: new Date(Date.now() - 30000).toISOString() });
    const { ctx } = usage(source, 'GROUP_TRAINING', [op], snapshot([cancelledRow()], observedAt));
    assert.equal(ctx.lk1CancelledHolds[op._id].observedAt, Date.parse(observedAt));
  });

  test(`${kind}: anything short of a fresh exact cancellation keeps the hold`, () => {
    const cases = [
      ['active row', operation('GROUP_TRAINING'), snapshot([cancelledRow({ status: 'ACTIVE', isCancelled: false })])],
      ['contradicting flag', operation('GROUP_TRAINING'), snapshot([cancelledRow({ isCancelled: false })])],
      ['stale receipt', operation('GROUP_TRAINING'), snapshot([cancelledRow()], new Date(Date.now() - 120000).toISOString())],
      ['no receipt', operation('GROUP_TRAINING'), undefined],
      ['row missing', operation('GROUP_TRAINING'), snapshot([])],
      ['other subscription', operation('GROUP_TRAINING'), snapshot([cancelledRow({ clientSubscriptionId: 'subscription-b' })])],
      ['other exercise', operation('GROUP_TRAINING'), snapshot([cancelledRow({ exerciseId: 'exercise-b' })])],
      ['other date', operation('GROUP_TRAINING'), snapshot([cancelledRow({ date: '2026-11-09' })])],
      ['written after receipt', operation('GROUP_TRAINING', { updatedAt: new Date(Date.now() + 1000).toISOString() }), snapshot([cancelledRow()])],
      ['transaction', operation('GROUP_TRAINING', { transactionId: 'tx' }), snapshot([cancelledRow()])],
      ['visit job', operation('GROUP_TRAINING', { lk1: { ...operation('GROUP_TRAINING').lk1, visitJob: {} } }), snapshot([cancelledRow()])],
      ['checkout', operation('GROUP_TRAINING', { lk1: { ...operation('GROUP_TRAINING').lk1, checkout: {} } }), snapshot([cancelledRow()])],
      ['paid price', operation('GROUP_TRAINING', { lk1: { ...operation('GROUP_TRAINING').lk1,
        decision: { subscriptionVisitCount: 1, benefit: { finalPriceMinor: 100 } } } }), snapshot([cancelledRow()])],
      ['managed', operation('GROUP_TRAINING', { managedSubscriptionInstanceId: 'm' }), snapshot([cancelledRow()])],
      ['pending', operation('GROUP_TRAINING', { state: 'PENDING_CONFIRMATION' }), snapshot([cancelledRow()])],
      ['price unknown', operation('GROUP_TRAINING', { lk1: { ...operation('GROUP_TRAINING').lk1,
        decision: { subscriptionVisitCount: 1 } } }), snapshot([cancelledRow()])],
      ['paid overage', operation('GAME', { lk1: { ...operation('GAME').lk1, decision: { subscriptionVisitCount: 1,
        benefit: { finalPriceMinor: 0 }, gameMinutes: { localDate: day, freeMinutes: 60, paidOverageMinutes: 30 } } } }),
      snapshot([cancelledRow()])],
      // Moved by an administrator: a same-day Viva booking no LK operation owns.
      ['replacement booking', operation('GROUP_TRAINING'), snapshot([cancelledRow()]),
        [{ id: 'booking-new', exerciseId: 'exercise-b', clientSubscriptionId: 'subscription-a', date: day }]],
      ['replacement booking, subscription unknown', operation('GROUP_TRAINING'), snapshot([cancelledRow()]),
        [{ id: 'booking-new', exerciseId: 'exercise-b', date: day }]],
    ];
    for (const [name, op, receipt, active = []] of cases) {
      const { usage: result, ctx } = usage(source, 'GROUP_TRAINING', [op], receipt, active);
      assert.equal(result.usedOrReservedVisitsToday, 1, name);
      assert.equal(ctx.lk1CancelledHolds?.[op._id], undefined, name);
    }
  });
}

// The guard step: repository guard source with its takeover condition in the exact
// live form, the reconciled runtime it depends on, and this patch's guard edits.
function guardRouter() {
  const native = read('../lib/lk1FreeCancellation.mjs').replace(/^export /gm, '');
  const repoGuard = read('../nodered_lk1_hub_nodes/daily_visit_guard.js');
  const liveGuard = replaceOnce(repoGuard,
    '  if (!released && !(typeof lk1ReconciledVerified === "function" && lk1ReconciledVerified(ctx, owner))) {\n'
    + '    return lk1DailyVisitReject(ctx);\n  }', GUARD_REJECT);
  const patched = cancelledHoldGuardEdits().reduce((value, [before, after]) => replaceOnce(value, before, after), liveGuard);
  return new Function('msg', `const ctx=msg._subscriptionBooking;
const normalizeId=x=>x.toLowerCase(), isValidDateKey=()=>true, OUTPUT_MONGO_UPDATE=3, VIVA_API_BASE='https://fixture.invalid';
const emit=type=>({type,msg}), lk1Stop=(_ctx,code)=>({type:'stop',code});
const lk1Find=(_ctx,step,query)=>{ctx.step=step;return {type:'find',query}};
const lk1MongoMatched=p=>p?.acknowledged===true?p.matchedCount:null;
const prepareMongoUpdate=(_ctx,step,query,update)=>{ctx.step=step;return {type:'update',step,query,update}};
const preparePreaccept=()=>({type:'preaccept'}), prepareBookingCreate=()=>({type:'booking'});
const lk1ReplayIdentityMatches=()=>true, finishError=(_ctx,status,error,details)=>({type:'error',status,error,details});
const lk1FreeServiceToken=()=>'fixture-token';
const prepareHttp=(_ctx,step,method,url)=>{ctx.step=step;Object.assign(msg,{method,url});return {type:'http',method,url}};
${native}\n${reconciledRuntimeSource()}\n${patched}\nreturn {type:'unhandled'};`);
}
const router = guardRouter();
function takeover(owner, proof) {
  const ctx = { tenantKey: 'fixture', clientSubscriptionId: 'subscription-a', serviceDate: day, caller: 'http',
    operationKey: 'operation-new', operationId: 'new', step: 'lk1_daily_visit_owner', lk1: { dailyVisitPolicyVersion: 1 },
    lk1DailyVisitPrevious: { _id: 'guard', kind: 'LK1_DAILY_VISIT_V1', ownerOperationKey: owner._id, ownerOperationId: owner.operationId },
    ...(proof ? { lk1CancelledHolds: { [owner._id]: proof } } : {}) };
  const out = router({ _subscriptionBooking: ctx, payload: [owner] });
  if (out.type === 'update' && out.step === 'lk1_daily_visit_conflict_saved') return 'REJECTED';
  if (out.type === 'emit' || out.msg?.payload?.[1]?.$set?.ownerOperationKey === 'operation-new') return 'TAKEOVER';
  return out.type;
}

test('the guard passes to a new operation only for the exact owner this request proved cancelled', () => {
  const owner = operation('GROUP_TRAINING');
  const proof = (changes = {}) => ({ owner: JSON.stringify(owner), observedAt: Date.now(), ...changes });
  assert.equal(takeover(owner, proof()), 'TAKEOVER');
  assert.equal(takeover(owner, null), 'REJECTED');
  assert.equal(takeover({ ...owner, updatedAt: new Date().toISOString() }, proof()), 'REJECTED');
  assert.equal(takeover(owner, proof({ observedAt: Date.now() - 61000 })), 'REJECTED');
  assert.equal(takeover(owner, proof({ observedAt: Date.now() + 5000 })), 'REJECTED');
  assert.equal(takeover({ ...owner, state: 'RELEASED' }, { owner: JSON.stringify({ ...owner, state: 'RELEASED' }), observedAt: Date.now() }), 'REJECTED');
});

test('usage patch is exactly invertible and the booking patch adds the guard edits', () => {
  const gateway = read('../nodered_lk1_hub_nodes/gateway.js');
  assert.equal(unpatchCancelledHoldUsage(patchCancelledHoldPreview(gateway)), gateway);
  assert.throws(() => patchCancelledHoldBooking(gateway), /anchor drift/);
  if (candidate) {
    const booking = candidate.find(n => n.id === CANCELLED_HOLD_TARGETS.booking.id).func;
    assert.equal(booking.split('lk1CancelledHoldVerified(ctx, owner)').length, 2);
    assert.equal(booking.split('lk1CancelledProviderHold(operation)').length, 2);
  }
});
