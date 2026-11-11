import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { patchCancelledAllowanceBooking, patchCancelledAllowancePreview,
  composeCancelledAllowanceArtifacts, CANCELLED_ALLOWANCE_TARGETS } from '../patch_live_cancelled_day_allowance.mjs';
import { hubGatewaySource } from '../lib/eventPaymentSources.mjs';
import { SubscriptionRejoinTracker } from '../../src/utils/subscriptionRejoin.ts';

const read = name => fs.readFileSync(new URL(`../nodered_lk1_hub_nodes/${name}.js`, import.meta.url), 'utf8');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const normalizeId = value => String(value ?? '').trim().toLowerCase();
const isObj = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const eventDate = row => row.exercise?.timeFrom?.slice(0, 10) || row.serviceDate;
const cancelled = new Function('ctx', 'operation', 'normalizeId', 'isObj', 'eventDate',
  `${read('cancelled_allowance')}\nreturn lk1CancelledZeroVisitOperation(operation);`);
function fixture() {
  const op = { state:'CONFIRMED', category:'tournament', bookingId:'booking', exerciseId:'exercise',
    serviceDate:'2099-11-13', clientSubscriptionId:'subscription', updatedAt:new Date(Date.now()-1000).toISOString(),
    lk1:{decision:{subscriptionVisitCount:0}} };
  const row = {id:'booking',clientId:'actor',exercise:{id:'exercise',timeFrom:'2099-11-13T18:00:00+03:00'},isCancelled:true};
  const ctx = {actorClientId:'actor',lk1:{cancellationSnapshot:{observedAt:new Date().toISOString(),active:[],history:[row]}}};
  return {op,row,ctx};
}
test('exact cancelled zero-visit booking releases counting without changing stored money or visits', () => {
  const {op,ctx}=fixture(),before=structuredClone(op);
  assert.equal(cancelled(ctx,op,normalizeId,isObj,eventDate),true);
  assert.deepEqual(op,before);
});
test('absence, payment/exercise failure, contradictory raw lists, stale or unknown reservations stay counted', () => {
  const changes=[f=>{f.ctx.lk1.cancellationSnapshot.history=[];},f=>{delete f.row.isCancelled;f.row.paymentStatus='REJECTED';},
    f=>{delete f.row.isCancelled;f.row.exerciseCancelled=true;},f=>{delete f.row.isCancelled;f.row.cancellationDate='2099-01-01';},
    f=>{f.row.status='ACTIVE';},f=>{f.row.cancelled=false;},f=>{f.row.clientId='other';},
    f=>{f.row.exercise.id='other';},f=>{f.row.exercise.timeFrom='2099-11-12T18:00:00+03:00';},
    f=>{f.row.clientSubscriptionId='other';},f=>{f.row.bookingId='other';},
    f=>{f.ctx.lk1.cancellationSnapshot.active=[{...f.row,isCancelled:false}];},
    f=>{f.ctx.lk1.cancellationSnapshot.observedAt=new Date(Date.now()-61000).toISOString();},
    f=>{f.ctx.lk1.cancellationSnapshot.observedAt=new Date(Date.now()+10000).toISOString();},
    f=>{f.op.updatedAt=new Date(Date.now()+1000).toISOString();},f=>{f.op.state='PENDING';},
    f=>{delete f.op.bookingId;},f=>{f.op.lk1.decision.subscriptionVisitCount=1;},
    f=>{f.op.lk1.visitJob={};},f=>{f.op.lk1.decision.gameMinutes={freeMinutes:60};}];
  for(const change of changes){const f=fixture();change(f);assert.equal(cancelled(f.ctx,f.op,normalizeId,isObj,eventDate),false);}
});

const prefix = `const isObj=value=>value&&typeof value==='object'&&!Array.isArray(value);
const managedActionForTarget=ctx=>ctx.category==='group_training'?'BOOK_GROUP_TRAINING':'BOOK_TOURNAMENT';
const OUTPUT_FINAL=4,OUTPUT_MONGO_FIND=1,OUTPUT_MONGO_INSERT=2;
const emit=output=>({output,msg});
const finishPending=(ctx,message,details)=>({output:4,status:202,details});
const finishError=(ctx,status,message,details)=>({output:4,status,message,details});
const finishConfirmed=()=>{};const PREPARED_LEASE_MS=30000;const ctx=msg._subscriptionBooking;`;
const gateway=hubGatewaySource();
const run=new Function('msg',prefix+gateway+'\nreturn {fresh:ctx.step==="lk1_profile_continue",msg};');
const helpers=new Function('msg',prefix+gateway.split('// HUB_STEPS')[0]+'\nreturn {lk1Fingerprint};')({_subscriptionBooking:{}});
const base='lk-subscription-fixture';
function releasedFixture() {
  const ctx={caller:'http',action:'book',tenantKey:'fixture',actorClientId:'actor',clientSubscriptionId:'subscription',
    exerciseId:'exercise',category:'tournament',operationId:base,step:'lk1_ingress_operation_find',lk1IngressReplay:true};
  const at='2099-11-11T12:00:00.000Z';
  const lk1={rule:{productId:'product'},purchaseDate:'2099-11-01',target:{eventId:'exercise',startsAt:'2099-11-13T18:00:00+03:00'},
    decision:{eligible:true,subscriptionVisitCount:0,benefit:{finalPriceMinor:200000}},
    transactionId:'transaction',transactionIntent:{bookingId:'booking',actorClientId:'actor',chargeMinor:200000},
    checkout:{transactionId:'transaction',toPayMinor:200000,paymentUrl:'https://pay.example.test/old'},
    cancelledAllowanceRelease:{schemaVersion:1,proofId:base,bookingId:'booking',transactionId:'transaction',
      amountMinor:200000,bookingState:'CANCELLED',transactionState:'UNPAID_EXPIRED',verifiedAt:at}};
  lk1.fingerprint=helpers.lk1Fingerprint({...ctx,managedAction:'BOOK_TOURNAMENT'},lk1);
  const record={_id:`lk1-product:${JSON.stringify(['fixture','actor',base])}`,tenantKey:'fixture',actorClientId:'actor',
    clientSubscriptionId:'subscription',exerciseId:'exercise',serviceDate:'2099-11-13',category:'tournament',
    operationId:base,state:'RELEASED',releaseReason:'CANCELLED_UNPAID_BOOKING',releasedAt:at,bookingId:'booking',lk1};
  return {ctx,record};
}
test('old HTTP ID returns only terminal409; successor reads exact parent then fresh validation', () => {
  const {ctx,record}=releasedFixture(),before=structuredClone(record);
  const old=run({_subscriptionBooking:ctx,payload:[record]});
  assert.equal(old.status,409);assert.equal(old.details.nextOperationId,base+':rejoin:1');
  assert.equal(ctx.lk1IngressReplay,true);assert.deepEqual(record,before);
  const nextCtx={...ctx,operationId:base+':rejoin:1'};
  const lookup=run({_subscriptionBooking:nextCtx,payload:[]});
  assert.equal(lookup.output,1);assert.deepEqual(lookup.msg.payload,{_id:record._id});
  assert.equal(nextCtx.step,'lk1_http_rejoin_predecessor_find');
  const fresh=run({_subscriptionBooking:nextCtx,payload:[record]});
  assert.equal(fresh.fresh,true);assert.equal(nextCtx.lk1IngressReplay,undefined);
  assert.equal(nextCtx.lk1Rejoin.rootOperationId,base);assert.equal(nextCtx.lk1Rejoin.operationId,base);
  assert.equal(nextCtx.lk1,undefined,'old price/checkout is never copied');assert.deepEqual(record,before);
});
test('unproven, paid/unknown, wrong or skipped predecessor cannot create a successor', () => {
  const changes=[f=>{f.record.state='CONFIRMED';},f=>{f.record.lk1.decision.subscriptionVisitCount=1;},
    f=>{delete f.record.lk1.cancelledAllowanceRelease;},f=>{f.record.lk1.cancelledAllowanceRelease.transactionState='PAID';},
    f=>{f.record.lk1.cancelledAllowanceRelease.bookingId='other';},f=>{f.record.lk1.checkout.toPayMinor=1;},
    f=>{f.record.lk1.visitJob={};},f=>{f.record.lk1.unpaidCancellation={phase:'REVIEW'};},
    f=>{f.record.actorClientId='other';},f=>{f.record.clientSubscriptionId='other';},f=>{f.record.exerciseId='other';},
    f=>{f.ctx.operationId=base+':rejoin:2';},f=>{f.ctx.operationId='lk-subscription-other:rejoin:1';}];
  for(const change of changes){const f=releasedFixture();f.ctx.operationId=base+':rejoin:1';
    f.ctx.step='lk1_http_rejoin_predecessor_find';change(f);
    const out=run({_subscriptionBooking:f.ctx,payload:[f.record]});
    assert.notEqual(out.fresh,true);assert.equal(out.output,4);assert.equal(f.ctx.lk1Rejoin,undefined);}
});
test('automatic unpaid cancellation uses the same exact proof; unfinished recovery stays blocked', () => {
  const f=releasedFixture();f.record.releaseReason='LK1_UNPAID_CHECKOUT_EXPIRED';
  f.record.lk1.unpaidCancellation={phase:'CANCELLED',verifiedAt:f.record.releasedAt};
  assert.equal(run({_subscriptionBooking:{...f.ctx},payload:[f.record]}).status,409);
  f.ctx.operationId=base+':rejoin:1';f.ctx.step='lk1_http_rejoin_predecessor_find';
  assert.equal(run({_subscriptionBooking:{...f.ctx},payload:[f.record]}).fresh,true);
  for(const phase of ['INTENT','REVIEW']){
    f.record.lk1.unpaidCancellation.phase=phase;
    assert.notEqual(run({_subscriptionBooking:{...f.ctx},payload:[f.record]}).fresh,true);
  }
});
test('HTTP tracker remembers only the next click and rejects forged generations', () => {
  const tracker=new SubscriptionRejoinTracker(null),submitted=tracker.resolve(base);
  assert.equal(tracker.rememberReleased(submitted,409,{details:{code:'SUBSCRIPTION_BOOKING_RELEASED',operationId:base,nextOperationId:base+':rejoin:1'}}),true);
  assert.equal(submitted,base);assert.equal(tracker.resolve(base),base+':rejoin:1');
  assert.equal(tracker.rememberReleased(base,409,{details:{code:'SUBSCRIPTION_BOOKING_RELEASED',operationId:base,nextOperationId:base+':rejoin:2'}}),false);
});

// Structural fixtures contain no production flow or credentials. They exercise
// the exact focused anchors, graph preservation and syntax checks in CI.
function patchFixtures() {
  const usage=`if (ctx.step === "lk1_usage_operations") {\n  let used = 0;\n  for (const operation of msg.payload) {\n    // AUDIT_BINDING_END\n  }\n  delete ctx.lk1.bookings;\n}\n`;
  const booking=`const ctx=msg.ctx;\nif (ctx.step === "lk1_ingress_operation_find") {\n const operation=msg.payload[0];\n  if (!operation && msg.payload.length === 0) {}\n    if (operation.state === "RELEASED" && ctx.caller === "split" && ctx.managedAction === "JOIN_GAME") {}\n}\n${usage}if (ctx.step === "lk1_policy_decision") {}\nif(false){\n    ctx.lk1.bookings = bookings;\n}`;
  const preview=`const canonicalUsage=()=>{const ctx=msg.ctx;${usage}\n\n  };\n// Dedicated advisory graph.\nconst ctx=msg.ctx;\nif(false){\n    ctx.activePayload = msg.payload;\n  ctx.bookings = canonical.mergeBookings(ctx.activePayload, msg.payload);\n}\nconst value={lk1: { rule: configured.rule, bookings: ctx.bookings, activeBookings: ctx.activeBookings,}};`;
  return {booking,preview};
}
test('focused candidate changes only two function bodies and preserves prior graph/policy', () => {
  const bodies=patchFixtures(),targets=structuredClone(CANCELLED_ALLOWANCE_TARGETS);
  const flow=Object.entries(targets).map(([name,t])=>{t.sha256=hash(bodies[name]);return {id:t.id,type:'function',outputs:t.outputs,wires:Array.from({length:t.outputs},()=>[]),func:bodies[name],name:'fixture'};});
  const bytes=Buffer.from(JSON.stringify(flow)),built=composeCancelledAllowanceArtifacts(bytes,{expectedSourceSha256:hash(bytes),targets});
  const result=JSON.parse(built.candidateBytes);
  for(let i=0;i<flow.length;i++)assert.deepEqual({...result[i],func:flow[i].func},flow[i]);
  assert.equal(built.changedNodeCount,2);assert.equal(built.addedNodeCount,0);
  assert.throws(()=>composeCancelledAllowanceArtifacts(bytes),/preimage drift/);
  assert.throws(()=>patchCancelledAllowanceBooking(bodies.booking+bodies.booking),/anchor drift/);
  assert.ok(patchCancelledAllowancePreview(bodies.preview).includes('cancellationSnapshot: ctx.cancellationSnapshot'));
});
