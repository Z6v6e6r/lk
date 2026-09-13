import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { nextSubscriptionRejoinId } from '../../src/utils/subscriptionRejoin.ts';

const source = fs.readFileSync(new URL('../nodered_lk1_hub_nodes/gateway.js', import.meta.url), 'utf8');
const prefix = `
const isObj = value => value && typeof value === 'object' && !Array.isArray(value);
const managedActionForTarget = ctx => ctx.managedAction;
const OUTPUT_FINAL=4, OUTPUT_MONGO_FIND=1, OUTPUT_MONGO_INSERT=2;
const emit = output => ({output, msg});
const finishPending = (ctx, message, details) => ({output:4, status:202, state:'PENDING_CONFIRMATION', details});
const finishError = (ctx, status, message, details) => ({output:4, status, message, details});
const finishConfirmed = () => {};
const PREPARED_LEASE_MS = 30000;
const ctx = msg._subscriptionBooking;
`;
const run = new Function('msg', prefix + source + '\nreturn {fresh:ctx.step === "lk1_profile_continue", msg};');
// Helpers are evaluated in the same Node-RED function scope, with no I/O.
const helperValues = new Function('msg', prefix + source.split('// HUB_STEPS')[0] + '\nreturn {lk1Fingerprint,lk1RejoinNextId,lk1FenceOperationUpdate};')({ _subscriptionBooking: {} });
const base = 'lk-split-join-fixture';
function fixture(operationId = base) {
  const ctx = { caller:'split', managedAction:'JOIN_GAME', tenantKey:'fixture', actorClientId:'fixture-client',
    operationId, clientSubscriptionId:'fixture-sub', exerciseId:'fixture-exercise', step:'lk1_ingress_operation_find', lk1IngressReplay:true };
  const quote = { rule:{productId:'db7a5250-7369-4f43-8ac5-9111be24bc74'}, purchaseDate:'2026-09-01',
    target:{eventId:ctx.exerciseId}, decision:{eligible:true, subscriptionVisitCount:0, benefit:{finalPriceMinor:280000}} };
  quote.fingerprint = helperValues.lk1Fingerprint(ctx, quote);
  const record = { _id:`lk1-product:${JSON.stringify([ctx.tenantKey,ctx.actorClientId,operationId])}`,
    tenantKey:ctx.tenantKey,actorClientId:ctx.actorClientId,clientSubscriptionId:ctx.clientSubscriptionId,
    operationId,exerciseId:ctx.exerciseId,category:'open_game',state:'RELEASED',lk1:quote,
    upstreamBookingId:'fixture-booking',releaseBookingId:'fixture-booking',releaseOperationId:'fixture-leave',
    releaseSource:'GAME_LEAVE',releasedAt:'2026-09-11T12:00:00.000Z',releasedBookingIds:['fixture-booking'] };
  return {ctx,record};
}
test('released ingress returns terminal successor without altering the old operation or making a write', () => {
  const {ctx,record} = fixture(); const before=structuredClone(record);
  const out=run({_subscriptionBooking:ctx,payload:[record]});
  assert.equal(out.output,4); assert.equal(out.status,409);
  assert.equal(out.details.code,'SUBSCRIPTION_BOOKING_RELEASED');
  assert.equal(out.details.nextOperationId,`${base}:rejoin:1`);
  assert.deepEqual(record,before);
});
test('new successor requires exact predecessor lookup then fresh validation, never reclaims history', () => {
  const {record}=fixture(); const {ctx}=fixture(`${base}:rejoin:1`);
  const out=run({_subscriptionBooking:ctx,payload:[]});
  assert.equal(out.output,1); assert.equal(out.msg._subscriptionBooking.step,'lk1_rejoin_predecessor_find');
  assert.deepEqual(out.msg.payload,{_id:record._id});
  const before=structuredClone(record);
  const next=run({...out.msg,payload:[record]});
  assert.equal(next.fresh,true); assert.equal(next.msg._subscriptionBooking.lk1IngressReplay,undefined);
  assert.equal(next.msg._subscriptionBooking.operationId,`${base}:rejoin:1`);
  assert.equal(next.msg._subscriptionBooking.lk1Rejoin.operationId,base);
  assert.deepEqual(record,before);
});
test('failed, pending, unproven releases and unsettled money never allow a new booking', () => {
  const mutations = [
    r=>{r.state='PENDING_CONFIRMATION';},r=>{r.state='FAILED';},r=>{delete r.releaseSource;},
    r=>{r.releaseSource='UNKNOWN';},r=>{delete r.releasedAt;},r=>{r.releasedAt='invalid';},
    r=>{delete r.releaseOperationId;},r=>{r.releaseBookingId='other';},r=>{r.releasedBookingIds=[];},
    r=>{r.bookingId='conflicting';},r=>{delete r.upstreamBookingId;},r=>{r.lk1.visitJob={};},
    ...['transactionAttemptedAt','transactionId','transactionIntent','checkout'].map(key=>r=>{r.lk1[key]={};}),
    r=>{r.actorClientId='other';},r=>{r.tenantKey='other';},r=>{r.clientSubscriptionId='other';},
    r=>{r.exerciseId='other';},r=>{r.operationId='other';},r=>{r.lk1.fingerprint='forged';},
  ];
  for (const mutate of mutations) {
    const {ctx}=fixture(`${base}:rejoin:1`);ctx.step='lk1_rejoin_predecessor_find';
    const {record}=fixture();mutate(record);
    const out=run({_subscriptionBooking:ctx,payload:[record]});
    assert.equal(out.output,4);assert.equal(out.state,'PENDING_CONFIRMATION');
    assert.equal(ctx.lk1Rejoin,undefined);
  }
});
test('missing or ambiguous predecessors, skipped generations and wrong action are blocked', () => {
  for (const payload of [[],[fixture().record,fixture().record],null]) {
    const {ctx}=fixture(`${base}:rejoin:1`);ctx.step='lk1_rejoin_predecessor_find';
    assert.equal(run({_subscriptionBooking:ctx,payload}).output,4);
  }
  const {ctx}=fixture(`${base}:rejoin:2`);ctx.step='lk1_rejoin_predecessor_find';
  assert.equal(run({_subscriptionBooking:ctx,payload:[fixture().record]}).output,4);
  for (const id of [`${base}:rejoin:01`,`${base}:rejoin:1001`]) {
    assert.equal(run({_subscriptionBooking:fixture(id).ctx,payload:[]}).status,409);
  }
  const create=fixture(`${base}:rejoin:1`).ctx;create.managedAction='CREATE_GAME';
  assert.equal(run({_subscriptionBooking:create,payload:[]}).status,409);
});
test('pending child keeps its identity; released child offers exactly one next generation', () => {
  const {ctx,record}=fixture(`${base}:rejoin:1`);record.state='PENDING_CONFIRMATION';
  assert.equal(run({_subscriptionBooking:ctx,payload:[record]}).state,'PENDING_CONFIRMATION');
  record.state='RELEASED';
  assert.equal(run({_subscriptionBooking:ctx,payload:[record]}).details.nextOperationId,`${base}:rejoin:2`);
  for (const id of [base,`${base}:rejoin:1`,`${base}:rejoin:999`,`${base}:rejoin:1000`,'invalid']) {
    assert.equal(helperValues.lk1RejoinNextId(id),nextSubscriptionRejoinId(id));
  }
});
test('late accept, confirm and failure cannot resurrect or replace a released LK1 operation', () => {
  const {ctx,record}=fixture();ctx.lk1=record.lk1;ctx.confirmedBookingId=record.upstreamBookingId;
  for(const step of ['operation_accept','operation_confirm','operation_fail']) {
    const query=helperValues.lk1FenceOperationUpdate(ctx,step,{_id:record._id,operationId:base});
    assert.ok(typeof query.state==='string' ? query.state!==record.state : !query.state.$in.includes(record.state));
    assert.ok(typeof query.state==='string' ? query.state==='PENDING_CONFIRMATION' : query.state.$in.includes('PENDING_CONFIRMATION'));
    if(step==='operation_confirm') {
      assert.deepEqual(query.upstreamBookingId.$in,['fixture-booking',null,'']);
      assert.ok(!query.upstreamBookingId.$in.includes('unrelated-booking'));
    }
  }
  const query={_id:'legacy'};
  assert.equal(helperValues.lk1FenceOperationUpdate({},'operation_confirm',query),query);
});
