import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { composeSubscriptionRejoinArtifacts, patchSubscriptionRejoinGateway, REJOIN_GATEWAY_ID } from '../patch_nodered_subscription_rejoin.mjs';
import { isNodeRedHttpsCheckout } from '../patch_nodered_subscription_paid_join.mjs';

const oldIngress = fs.readFileSync(new URL('./fixtures/subscriptionRejoinIngress.txt', import.meta.url), 'utf8');
const fixtureBody = `
const lk1Checkout = (ctx) => {};
const prepareMongoUpdate = (ctx, step, query, update) => {
  msg.payload = [query, update, ctx.lk1 ? { writeConcern: { w: "majority", j: true } } : {}];
};
const ctx = {};
${oldIngress}
if (ctx.step === "lk1_money_owned_subscriptions") {}
delete ctx.lk1IngressReplay;
const split = msg._splitCtx;
const record = {
    state: "PREPARED", attempts: 0, lk1: JSON.parse(JSON.stringify(ctx.lk1)),
};
`;
test('focused patch changes only the permitted function body and rejects drift or reapplication', () => {
  const source = [{ id:REJOIN_GATEWAY_ID,type:'function',func:fixtureBody,wires:[[],[],[],[],[]],outputs:5 },
    {id:'fixture-foreign',type:'comment',name:'preserve'}];
  const bytes=Buffer.from(JSON.stringify(source));
  const result=composeSubscriptionRejoinArtifacts(bytes,'fixture-rejoin');
  assert.deepEqual(result.candidate[1],source[1]);
  assert.deepEqual({...result.candidate[0],func:fixtureBody},source[0]);
  assert.equal(result.contract.allowedChanges.length,1);
  assert.deepEqual(result.contract.allowedChanges[0].fields,['func']);
  assert.throws(()=>patchSubscriptionRejoinGateway(result.candidate[0].func),/preimage drift/);
  assert.throws(()=>patchSubscriptionRejoinGateway(fixtureBody.replace('operation.state !== "CONFIRMED"','operation.state !== "OTHER"')),/preimage drift/);
  assert.throws(()=>composeSubscriptionRejoinArtifacts(Buffer.from(JSON.stringify([...source,source[0]])),'fixture-rejoin'),/identity/);
  assert.match(result.candidate[0].func,/rejoinPredecessor: ctx.lk1Rejoin/);
  assert.match(result.candidate[0].func,/delete ctx.lk1Rejoin/);
});
test('checkout validation works without URL in a Node-RED sandbox and rejects unsafe targets', () => {
  const sandbox=vm.createContext({});
  assert.equal(vm.runInContext('typeof URL',sandbox),'undefined');
  const validate=vm.runInContext(`(${isNodeRedHttpsCheckout.toString()})`,sandbox);
  assert.equal(validate('https://pay.example.test/checkout/fixture'),true);
  for(const url of ['http://pay.example.test',['https://user:secret','example.test'].join('@'),'javascript:alert(1)',
    'https://example.test:444/pay','https://example.test\\@evil.test','https://example.test/\n',null,'']) {
    assert.equal(validate(url),false);
  }
});
test('live fixture preserves installed recovery and validates the exact one-node contract', {
  skip:!process.env.LK1_REJOIN_LIVE_FIXTURE,
}, () => {
  const bytes=fs.readFileSync(process.env.LK1_REJOIN_LIVE_FIXTURE);
  const before=JSON.parse(bytes).find(n=>n.id===REJOIN_GATEWAY_ID).func;
  const result=composeSubscriptionRejoinArtifacts(bytes,'fixture-live-rejoin');
  const after=result.candidate.find(n=>n.id===REJOIN_GATEWAY_ID).func;
  const recoveryStart='if (ctx.step === LK1_EXPIRED_PENDING_RECONCILE)';
  const recoveryEnd='if (ctx.step === "lk1_money_owned_subscriptions")';
  const originalRecovery=before.slice(before.indexOf(recoveryStart),before.indexOf(recoveryEnd));
  assert.ok(originalRecovery.length>100);
  assert.ok(after.includes(originalRecovery.trimEnd()));
  assert.doesNotMatch(after,/new URL\((?:paymentUrl|checkout\?\.paymentUrl)/);
  // Execute the composed function with fixture-only messages. All I/O is returned
  // as Node-RED outputs; there are no HTTP clients, DB connections or live tokens.
  const values={vivacrm_access_token:'fixture-service'};
  const global={get:key=>values[key],set:(key,value)=>{values[key]=value;}};
  const node={warn(){},error(){}};const env={get(){}};
  const compiled=new vm.Script(`(function(msg,global,node,env){${after}\n})`);
  const runtime=compiled.runInNewContext({}); // deliberately no URL global
  const run=msg=>runtime(structuredClone(msg),global,node,env);
  const prefix=after.slice(0,after.indexOf('const ctx = isObj(msg._subscriptionBooking)'));
  const exposed=new Function('msg','global','node','env',prefix+'\nreturn {lk1Fingerprint,prepareConfirmedUpdate};')({},global,node,env);
  const ctx={caller:'split',managedAction:'JOIN_GAME',tenantKey:'fixture',actorClientId:'fixture-client',
    clientSubscriptionId:'fixture-sub',exerciseId:'fixture-exercise',operationId:'lk-split-join-fixture',
    step:'lk1_ingress_operation_find',lk1IngressReplay:true,authHeader:'Bearer fixture-user',serviceDate:'2099-01-01'};
  const quote={rule:{productId:'db7a5250-7369-4f43-8ac5-9111be24bc74'},purchaseDate:'2026-09-01',
    target:{eventId:ctx.exerciseId,stationId:'fixture-station'},decision:{eligible:true,subscriptionVisitCount:0,benefit:{finalPriceMinor:280000}}};
  quote.fingerprint=exposed.lk1Fingerprint(ctx,quote);
  const old={_id:`lk1-product:${JSON.stringify([ctx.tenantKey,ctx.actorClientId,ctx.operationId])}`,
    ...ctx,lk1:quote,state:'RELEASED',upstreamBookingId:'fixture-booking',releaseBookingId:'fixture-booking',
    releasedAt:'2026-09-11T12:00:00.000Z',releaseOperationId:'fixture-leave',releaseSource:'GAME_LEAVE',releasedBookingIds:['fixture-booking']};
  const terminal=run({_subscriptionBooking:ctx,payload:[old]});
  assert.equal(terminal[4].statusCode,409);
  const childCtx={...ctx,operationId:terminal[4].payload.details.nextOperationId};
  const lookup=run({_subscriptionBooking:childCtx,payload:[]})[1];
  assert.deepEqual(JSON.parse(JSON.stringify(lookup.payload)),{_id:old._id});
  const fresh=run({...lookup,payload:[old]});
  assert.equal(fresh[7]._subscriptionBooking.step,'lk1_product_identity');
  assert.equal(fresh[7]._subscriptionBooking.lk1Rejoin.operationId,ctx.operationId);
  assert.ok(fresh.slice(0,7).every(value=>value===null),'fresh product identity must be verified before any write');

  // Drive the real durable insert / CAS continuation after fresh policy validation.
  const child={...childCtx,lk1:structuredClone(quote),step:'operation_insert',
    operationKey:`lk1-product:${JSON.stringify([ctx.tenantKey,ctx.actorClientId,childCtx.operationId])}`};
  const inserted=run({_subscriptionBooking:child,payload:{acknowledged:true,insertedId:child.operationKey}});
  assert.equal(inserted[3].payload[0].state,'PREPARED');
  const losingInsert=run({_subscriptionBooking:child,payload:null,error:{code:11000}});
  assert.ok(losingInsert.slice(0,4).every(value=>value===null));
  const ack=count=>({acknowledged:true,matchedCount:count,modifiedCount:count,upsertedCount:0,upsertedId:null});
  const winner=run({...inserted[3],payload:ack(1)});
  assert.equal(winner[0].method,'GET'); // recheck exercise before POST
  const loser=run({...inserted[3],payload:ack(0)});
  assert.ok(loser.slice(0,4).every(value=>value===null));

  const delayed={...ctx,lk1:quote,operationKey:old._id,immediateBookingId:old.upstreamBookingId};
  const confirming=exposed.prepareConfirmedUpdate(delayed,{id:old.upstreamBookingId});
  assert.equal(confirming[3].payload[0].state,'PENDING_CONFIRMATION');
  assert.notEqual(confirming[3].payload[0].state,old.state,'released predecessor cannot match confirmation CAS');
  const refused=run({...confirming[3],payload:ack(0)});
  assert.ok(refused.slice(0,4).every(value=>value===null),'zero-match confirmation cannot start checkout');

  // Saved checkout is returned under the exact successor identity, without URL global.
  const complete={...old,_id:child.operationKey,operationId:child.operationId,state:'CONFIRMED',bookingId:'fixture-booking',
    lk1:{...quote,transactionId:'fixture-transaction',transactionAttemptedAt:'2026-09-13T12:00:00Z',
      transactionIntent:{bookingId:'fixture-booking',actorClientId:ctx.actorClientId,studioId:'fixture-station',chargeMinor:280000},
      checkout:{transactionId:'fixture-transaction',paymentUrl:'https://pay.example.test/fixture',toPayMinor:280000}}};
  const paid=run({_subscriptionBooking:childCtx,payload:[complete]});
  assert.equal(paid[4].payload.paymentUrl,'https://pay.example.test/fixture');
  assert.equal(paid[4].payload.operationId,child.operationId);
  assert.ok(paid.slice(0,4).every(value=>value===null));
});
