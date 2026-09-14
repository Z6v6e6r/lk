import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { composeEventPaymentRoutes } from '../prepare_event_payment_routes_upgrade.mjs';
const fixture=process.env.LK_EVENT_ROUTES_LIVE_FIXTURE;
test('entire pinned gateway: owner-less game confirmation and separate group/tournament payment selection', {skip:!fixture},()=>{
  const {candidate}=composeEventPaymentRoutes(fs.readFileSync(fixture),'event-full-offline');
  const source=candidate.find(n=>n.id==='lk_subscription_booking_router_20260804').func;
  const script=new vm.Script('(function(msg,node,env,global){\n'+source+'\n})(msg,node,env,global)');
  const run=msg=>script.runInNewContext({msg,global:{get(){return undefined;}},env:{get(){return undefined;}},node:{warn(){},error(){throw new Error('node.error');}}},{timeout:3000});
  const ctx={step:'confirmation_bookings',caller:'split',managedAction:'JOIN_GAME',action:'book',tenantKey:'fixture',
    authHeader:'Bearer fixture',actorClientId:'fixture-actor',actorPhone:'70000000000',operationId:'fixture-op',operationKey:'fixture-key',
    exerciseId:'fixture-event',studioId:'fixture-studio',clientSubscriptionId:'fixture-subscription',immediateBookingId:'fixture-booking',
    lk1:{fingerprint:'fixture-fingerprint',decision:{eligible:true,subscriptionVisitCount:1,benefit:{finalPriceMinor:140000}},
      target:{eventId:'fixture-event',category:'GAME',stationId:'fixture-studio',basePriceMinor:400000,durationMinutes:120}}};
  const url='https://api.vivacrm.ru/end-user/api/v2/fixture/bookings?size=1000';
  const booking={id:'fixture-booking',paymentType:'SUBSCRIPTION',clientSubscriptionId:'fixture-subscription',exercise:{id:'fixture-event'},services:[]};
  for(const [row,proof,expected]of [[booking,true,'operation_confirm'],[{...booking,clientId:'other'},true,'LK1_BOOKING_OUTCOME_UNRESOLVED'],[booking,false,'LK1_BOOKING_READBACK_UNVERIFIED']]){
    const c=structuredClone(ctx);
    if(proof)c.lk1ConfirmationRead={url,actorClientId:c.actorClientId,operationId:c.operationId,operationKey:c.operationKey,authHeader:c.authHeader};
    const msg={_subscriptionBooking:c,statusCode:200,method:'GET',url,followRedirects:false,maxRedirects:0,payload:{content:[row],totalElements:1,totalPages:1,number:0,last:true}};
    const out=run(msg);assert.equal(out[0],null);assert.equal(out[2],null);
    assert.equal(out[3]?._subscriptionBooking.step || out[4]?.payload.details?.code,expected);
  }
  for(const [action,category,targetCategory,step]of [['BOOK_GROUP_TRAINING','group_training','GROUP_TRAINING','lk1_group_payment_products'],['BOOK_TOURNAMENT','tournament','TOURNAMENT','lk1_tournament_payment_products']]){
    const c=structuredClone(ctx);Object.assign(c,{caller:'http',managedAction:action,category,step,confirmedBookingId:'fixture-booking'});
    c.lk1.target={...c.lk1.target,category:targetCategory,basePriceMinor:550000,priceProductId:'fixture-service'};
    c.lk1.rule={groupTrainingDiscountPercent:50,tournamentDiscountPercent:20};
    c.lk1.decision={eligible:true,subscriptionVisitCount:0,benefit:{kind:'PERCENT_DISCOUNT',finalPriceMinor:action==='BOOK_TOURNAMENT'?440000:275000}};
    const msg={_subscriptionBooking:c,statusCode:200,payload:[{id:'fixture-service',productType:'SERVICE',cost:550000},{id:'fixture-pass',productType:'SUBSCRIPTION',cost:1980000}]};
    const out=run(msg);assert.equal(out[0]?.method,'GET');assert.match(out[0]?.url,/\/profile$/);
    assert.equal(c.step,action==='BOOK_TOURNAMENT'?'lk1_tournament_payment_profile':'lk1_group_payment_profile');
    assert.equal(msg._splitCtx,undefined);
    assert.equal(c.lk1EventPayment.transactionPayload.products[0].discount,action==='BOOK_TOURNAMENT'?110000:275000);
    assert.equal(c.lk1.transactionAttemptedAt,undefined);
  }
});
