import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { lk1ReconciledCandidate, lk1ReconciledReadback } from '../lib/lk1ReconciledCancellation.mjs';
import { reconciledRuntimeSource, reconciledFinalizerEdits, applyReconciledEdits,
  composeReconciledCancellationRecovery, reconciledSha, RECONCILED_IDS } from '../prepare_reconciled_cancellation_recovery.mjs';
import { moneyFixture } from './fixtures/lk1ReconciledCancellationFixtures.mjs';
const read = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const now = '2099-11-12T12:00:00Z';

test('reconciler marker alone is not proof: exact cancelled, closed money and balanced visit reads are all required', () => {
  const f = moneyFixture();
  assert.equal(lk1ReconciledCandidate(f.op), true);
  assert.ok(lk1ReconciledReadback(f.op, f.b, f.tx, f.subscriptions, now));
  const cases = [
    f => { f.op.reconciliation.source = 'other'; }, f => { f.op.reconciliation.observedState = 'PENDING_CONFIRMATION'; },
    f => { f.op.lk1.visitJob = {}; }, f => { f.op.lk1.createAttemptedAt = now; },
    f => { f.op.visitJob = {}; }, f => { f.op.transactionId = 'other'; },
    f => { f.op.activationState = 'PENDING'; }, f => { f.op.managedSubscriptionInstanceId = 'other'; },
    f => { f.op.lk1.checkout.toPayMinor++; }, f => { f.op.lk1.transactionIntent.bookingId = 'other'; },
    f => { f.b.cancelled = false; }, f => { f.b.clientId = 'other'; }, f => { f.b.clientSubscriptionId = 'other'; },
    f => { f.b.visitConfirmed = true; }, f => { f.tx.status = 'PAID'; }, f => { f.tx.paymentDate = now; },
    f => { f.b.paid = true; }, f => { f.b.paidAt = now; }, f => { f.b.paymentDate = now; },
    f => { f.b.amountDue = { paidKopecks: 70000 }; }, f => { f.b.receipts = [{}]; },
    f => { f.b.amountDue = { paidKopecks: 'unknown' }; }, f => { f.b.amountDue = 'unknown'; },
    f => { f.b.paid = 'true'; }, f => { f.tx.receipts = [{}]; }, f => { f.tx.deposit = 1; },
    f => { f.tx.cardPaymentInfo.status = 'NEW'; }, f => { f.tx.cardPaymentInfo.declineOutcome = 'UNKNOWN'; },
    f => { f.tx.toPay++; }, f => { f.tx.products[0].paymentBookingIds = ['other']; },
    f => { f.tx.client.id = 'other'; }, f => { f.tx.possibleDoublePayment = true; },
    f => { f.tx.transactionRefunds = [{}]; }, f => { f.tx.refundSum = 1; },
    f => { f.tx.paymentDueDate = '2099-11-12T12:30:00Z'; },
    f => { f.sub.visitsLeft--; }, f => { f.sub.bookings.push(f.b); f.sub.visitsLeft--; },
    f => { f.sub.bookings[0].clientId = 'other'; }, f => { f.sub.bookings[0].exerciseDate = f.op.lk1.target.startsAt; },
    f => { f.sub.product.id = 'other'; }, f => { f.sub.status = 'EXPIRED'; },
    f => { f.subscriptions.last = false; }, f => { f.subscriptions.totalElements = 2; },
  ];
  for (const mutate of cases) {
    const changed = moneyFixture(); mutate(changed);
    assert.equal(lk1ReconciledReadback(changed.op, changed.b, changed.tx, changed.subscriptions, now), null, mutate.toString());
  }
});

function syntheticRouter() {
  const native = read('../lib/lk1FreeCancellation.mjs').replace(/^export /gm, '');
  const guard = read('../nodered_lk1_hub_nodes/daily_visit_guard.js');
  return `const ctx=msg._subscriptionBooking;
const normalizeId=x=>x.toLowerCase(), isValidDateKey=()=>true, OUTPUT_MONGO_UPDATE=3, VIVA_API_BASE='https://fixture.invalid';
const emit=type=>({type,msg}), lk1Stop=(_ctx,code)=>({type:'stop',code});
const lk1Find=(_ctx,step,query)=>{ctx.step=step;return {type:'find',query}};
const lk1MongoMatched=p=>p?.acknowledged===true?p.matchedCount:null;
const prepareMongoUpdate=(_ctx,step,query,update)=>{ctx.step=step;return {type:'update',query,update}};
const preparePreaccept=()=>({type:'preaccept'}), prepareBookingCreate=()=>({type:'booking'});
const lk1ReplayIdentityMatches=()=>true, finishError=(_ctx,status,error,details)=>({type:'error',status,error,details});
const lk1FreeServiceToken=()=>'fixture-token';
const prepareHttp=(_ctx,step,method,url)=>{ctx.step=step;Object.assign(msg,{method,url});return {type:'http',method,url}};
${native}\n${reconciledRuntimeSource()}\n${guard}\nreturn {type:'unhandled'};`;
}
const router = new Function('msg', syntheticRouter());
function start() {
  const f = moneyFixture(), ctx = { ...f.op, caller: 'split', managedAction: 'JOIN_GAME', operationId: 'new-op',
    operationKey: 'new-key', exerciseId: 'new-exercise', step: 'lk1_daily_visit_owner',
    lk1: { ...f.op.lk1, dailyVisitPolicyVersion: 1 }, lk1DailyVisitPrevious: { _id: 'guard',
      kind: 'LK1_DAILY_VISIT_V1', ownerOperationKey: f.op._id, ownerOperationId: f.op.operationId } };
  const msg = { _subscriptionBooking: ctx, payload: [f.op] };
  const run = p => { msg.payload = p; return router(msg); };
  const http = p => { msg.statusCode = 200; msg.responseUrl = msg.url; return run(p); };
  return { f, ctx, msg, run, http, first: router(msg) };
}
test('fresh request reads three provider resources and exact owner before ordinary majority CAS', () => {
  const s = start(); assert.equal(s.first.type, 'http');
  assert.equal(s.http(s.f.b).type, 'http');
  // Fixture future clock is used only for transaction deadline evaluation.
  s.f.tx.createDate='2020-01-01T09:00:00Z'; s.f.tx.paymentDueDate='2020-01-01T09:25:00Z';
  assert.equal(s.http(s.f.tx).type, 'http'); assert.equal(s.http(s.f.subscriptions).type, 'find');
  const out = s.run([structuredClone(s.f.op)]);
  assert.equal(out.type, 3); assert.equal(s.ctx.step, 'lk1_daily_visit_takeover');
  assert.deepEqual(out.msg.payload[0], { _id: 'guard', kind: 'LK1_DAILY_VISIT_V1', ownerOperationKey: s.f.op._id, ownerOperationId: s.f.op.operationId });
  assert.deepEqual(out.msg.payload[2], { writeConcern: { w: 'majority', j: true } });
  assert.equal(s.ctx.lk1DailyVisitOwned, undefined);
  assert.equal(s.run({ acknowledged: true, matchedCount: 0, modifiedCount: 0 }).type, 'find');
});
test('stale reads, redirects, unbalanced visits, owner drift and foreign request never allow a takeover', () => {
  for (const mutate of [s=>{s.msg.statusCode=503},s=>{s.msg.responseUrl='https://other.invalid'},
    s=>{s.ctx.lk1ReconciledRecovery.startedAt-=31000},s=>{s.ctx.actorClientId='other'}]) {
    const s=start();s.msg.statusCode=200;s.msg.responseUrl=s.msg.url;mutate(s);
    assert.equal(s.run(s.f.b).type,'stop');
  }
  const s=start();s.http(s.f.b);s.f.tx.createDate='2020-01-01T09:00:00Z';s.f.tx.paymentDueDate='2020-01-01T09:25:00Z';s.http(s.f.tx);
  s.f.sub.visitsLeft--; assert.equal(s.http(s.f.subscriptions).type,'stop');
});
function reads(s) {
  s.http(s.f.b);
  s.f.tx.createDate='2020-01-01T09:00:00Z';s.f.tx.paymentDueDate='2020-01-01T09:25:00Z';
  s.http(s.f.tx);
  assert.equal(s.http(s.f.subscriptions).type,'find');
}
test('owner reread rejects changed money state even if updatedAt did not change', () => {
  const s=start();reads(s);
  const changed=structuredClone(s.f.op);changed.lk1.transactionId='other';
  assert.deepEqual(s.run([changed]),{type:'stop',code:'LK1_RECONCILED_CANCEL_OWNER_CHANGED'});
  assert.equal(s.ctx.lk1DailyVisitOwned,undefined);
});
test('takeover ACK alone enables the fresh continuation; lost ACK always reads ownership', () => {
  for(const continuation of [undefined,'booking']) {
    const s=start();s.ctx.lk1DailyVisitContinuation=continuation;reads(s);
    assert.equal(s.run([structuredClone(s.f.op)]).type,3);
    assert.equal(s.run({acknowledged:true,matchedCount:1,modifiedCount:1}).type,continuation?'booking':'preaccept');
    assert.equal(s.ctx.lk1DailyVisitOwned,true);
  }
  const s=start();reads(s);s.run([structuredClone(s.f.op)]);
  assert.equal(s.run({acknowledged:false}).type,'find');
  assert.equal(s.ctx.lk1DailyVisitOwned,undefined);
  const competitor={_id:'lk1-daily-visit:'+JSON.stringify([s.ctx.tenantKey,s.ctx.clientSubscriptionId,s.ctx.serviceDate]),kind:'LK1_DAILY_VISIT_V1',tenantKey:s.ctx.tenantKey,
    clientSubscriptionId:s.ctx.clientSubscriptionId,serviceDate:s.ctx.serviceDate,
    ownerOperationKey:'competitor-key',ownerOperationId:'competitor-op'};
  assert.equal(s.run([competitor]).type,'find');
  assert.equal(s.run([{...s.f.op,_id:'competitor-key',operationId:'competitor-op',state:'CONFIRMED'}]).type,'update');
  assert.equal(s.ctx.step,'lk1_daily_visit_conflict_saved');
  assert.equal(s.ctx.lk1DailyVisitOwned,undefined);
});

const finalizer = new Function('msg','global', `const ctx=msg._subscriptionBooking,payload=msg.payload,responseStatus=msg.statusCode;\n${read('../nodered_lk1_hub_nodes/daily_visit_refusal.js')}\n${read('../nodered_lk1_hub_nodes/finalize.js')}\nreturn [null,msg];`);
function refusal(caller='split') {
  const ctx={caller,managedAction:'JOIN_GAME',step:'lk1_daily_visit_conflict_saved',tenantKey:'fixture',operationKey:'new-key',operationId:'new-op',actorClientId:'actor',exerciseId:'exercise',clientSubscriptionId:'subscription',lk1:{fingerprint:'fingerprint'}};
  if(caller==='http')ctx.action='book';
  ctx.lk1DailyVisitRefusal=JSON.stringify([ctx.operationKey,ctx.operationId,ctx.actorClientId,ctx.clientSubscriptionId,ctx.exerciseId,ctx.lk1.fingerprint]);
  return {_subscriptionBooking:ctx,_splitCtx:{action:'join',operationId:ctx.operationId,clientId:ctx.actorClientId,exerciseId:ctx.exerciseId,clientSubscriptionId:ctx.clientSubscriptionId},statusCode:409,
    payload:{error:'Дневное посещение уже занято. Обновите стоимость записи.',details:{code:'LK1_DAILY_VISIT_CHANGED'}}};
}
test('durable split JOIN refusal stays409 including the actual ingress with no action field', () => {
  for(const caller of ['http','split'])assert.equal(finalizer(refusal(caller),{})[1].statusCode,409);
  const cases=[m=>{delete m._subscriptionBooking.lk1DailyVisitRefusal},m=>{m._subscriptionBooking.step='unknown'},
    m=>{m._splitCtx.action='create'},m=>{m._splitCtx.ownsExercise=true},m=>{m._splitCtx.operationId='other'},
    m=>{m._splitCtx.clientId='other'},m=>{m._splitCtx.exerciseId='other'},m=>{m._splitCtx.clientSubscriptionId='other'},
    ...['transactionAttemptedAt','transactionId','transactionIntent','checkout','visitJob','createAttemptedAt','bookingAttemptedAt'].map(k=>m=>{m._subscriptionBooking.lk1[k]='present'}),
    ...['upstreamAttemptedAt','confirmedBookingId','immediateBookingId','precreatedEntitlementReserved','managedEntitlementOperationId'].map(k=>m=>{m._subscriptionBooking[k]='present'})];
  for(const mutate of cases){const m=refusal();mutate(m);assert.equal(finalizer(m,{})[1].statusCode,202,mutate.toString())}
});
test('two-function composition rejects drift/reapply and preserves complete graph/order/inverse', () => {
  const [before, after]=reconciledFinalizerEdits()[0];
  assert.ok(after.includes('lk1SplitVisitRefusal')); assert.ok(!before.includes('lk1SplitVisitRefusal'));
  const source=[{id:'tab',type:'tab'},...RECONCILED_IDS.map((id,i)=>({id,type:'function',z:'tab',outputs:i?2:8,wires:Array.from({length:i?2:8},()=>[]),func:i?'const ctx=msg._subscriptionBooking,payload=msg.payload,responseStatus=msg.statusCode;\n'+before:'const ctx=msg._subscriptionBooking;\nconst lk1DailyVisitKey = 1;\nfunction guard(){let released=false,owner={};\n  if (!released) return lk1DailyVisitReject(ctx);\n}\nreturn msg;'})),{id:'unrelated',type:'function',z:'tab',func:'return msg;',outputs:1,wires:[[]]}];
  // Synthetic router is only a topology/preimage fixture, with native helpers
  // supplied as declarations so the added protocol can be syntax checked.
  const bytes=Buffer.from(JSON.stringify(source)),opts={expectedSourceSha256:reconciledSha(bytes),pins:source.slice(1,3).map(n=>reconciledSha(n.func))};
  const built=composeReconciledCancellationRecovery(bytes,opts),out=JSON.parse(built.candidateBytes);
  assert.deepEqual(out[3],source[3]); assert.equal(out.length,source.length);
  assert.equal(built.contract.allowedAdditions.length,0);
  assert.equal(applyReconciledEdits(before,[[before,after]]),after);
  assert.throws(()=>composeReconciledCancellationRecovery(bytes,{...opts,expectedSourceSha256:'0'.repeat(64)}));
  assert.throws(()=>composeReconciledCancellationRecovery(built.candidateBytes,{...opts,expectedSourceSha256:reconciledSha(built.candidateBytes)}));
});
