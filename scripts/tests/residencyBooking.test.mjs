import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {RESIDENCY_PRODUCT_ID,validateResidencyBookingContext,residencyTransportConfig} from '../lib/residencyBookingContext.mjs';
import {composeResidencyEvaluator,composeResidencyGateway,composeResidencyPreview} from '../lib/residencyBookingSources.mjs';
import {extractSubscriptionPricePreviewSource} from '../lib/subscriptionPricePreviewSources.mjs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {composeResidencyFlow,RESIDENCY_TARGETS,assertResidencyOutputPath} from '../patch_nodered_residency_booking.mjs';
import {residencyFixture} from './fixtures/residency-booking-context.mjs';
const evaluator=composeResidencyEvaluator(fs.readFileSync(new URL('../nodered_lk1_hub_nodes/evaluator.js',import.meta.url),'utf8'));
function input(category='GAME',durationMinutes=60,basePriceMinor=100000) {
  const now=Date.now(),evidence=residencyFixture({now});
  const target={resolutionSource:'SERVER',category,stationId:'station:fixture',externalEventTypeId:category==='GAME'?'viva:direction:4588:type:1613':'viva:direction:6307:type:2349',
    durationMinutes,startsAt:evidence.startsAt,basePriceMinor,currency:'RUB',priceSource:'VIVA_EXISTING_TARIFF'};
  const action=category==='GAME'?'JOIN_GAME':'BOOK_GROUP_TRAINING';
  const rule=validateResidencyBookingContext(evidence,'instance:fixture',now,target,action).rule;
  delete evidence.startsAt;
  return {evaluatedAt:new Date(now).toISOString(),action,target,residencyContext:evidence,
    lk1Policy:Object.fromEntries(Object.entries(rule).filter(([k])=>k!=='productId')),
    lk1ProductBinding:{policyProductId:RESIDENCY_PRODUCT_ID,ownedProductId:RESIDENCY_PRODUCT_ID,clientSubscriptionId:'instance:fixture'},
    usage:{activeServiceScope:'SUBSCRIPTION_BENEFIT_ONLY',activeServices:0,usedOrReservedFreeMinutesToday:0,dailyBucketLocalDate:new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(target.startsAt)),freeFirstEvent:{covered:false}}};
}
const decide=i=>{const msg={_managedSubscriptionPolicyInput:i};new Function('msg',evaluator)(msg);return msg._managedSubscriptionPolicyDecision;};
test('residency prices all supported durations without a visit, including rounded minor amounts',()=>{
  for(const category of ['GAME','GROUP_TRAINING']) for(const minutes of [60,90,120]) for(const price of [100000,12345]) {
    const i=input(category,minutes,price),r=decide(i);
    assert.equal(r.eligible,true,JSON.stringify(r.blockers));assert.equal(r.subscriptionVisitCount,0);
    assert.equal(r.benefit.finalPriceMinor,price-Math.floor(price*(category==='GAME'?30:50)/100));
    if(category==='GAME') assert.equal(r.gameMinutes.freeMinutes,0);
  }
});
test('residency cannot be granted by the local plan table or by a forged free-first snapshot',()=>{
  const i=input();delete i.residencyContext;assert.equal(decide(i).eligible,false);
  const j=input();j.usage.freeFirstEvent={covered:true,usedEventsToday:0,visitsLeft:100};assert.equal(decide(j).eligible,false);
});
test('all stations includes stations absent from any historic dictionary snapshot',()=>{const i=input();i.target.stationId='station:newly-added';assert.equal(decide(i).eligible,true);});
test('invalid, expired, foreign or changed policy evidence always refuses',()=>{
  for(const mutate of [
    v=>{v.providerProductId='other-product';},v=>{v.context.clientSubscriptionId='other-instance';},
    v=>{v.runtimeCompatibility.capabilityDigest='sha256:'+'b'.repeat(64);},v=>{v.validUntil=new Date(Date.now()-1).toISOString();},
    v=>{v.context.instance.state='FROZEN';},v=>{v.context.instance.activeTo=new Date(Date.now()).toISOString();},
    v=>{v.context.policy.benefitRules[0].kind='FREE_ENTITLEMENT';},v=>{v.context.policy.benefitRules[1].percentage=60;},
    v=>{v.context.policy.status='DRAFT';},v=>{v.context.policy.lifecycle.validityDays=365;},
    v=>{v.context.policy.benefitRules[0].allStations=false;},v=>{v.context.policy.benefitRules[0].externalEventTypeIds=[];}
  ]) {const i=input();mutate(i.residencyContext);assert.equal(decide(i).eligible,false);}
  for(const change of [{stationId:''},{externalEventTypeId:'other:event'},{startsAt:'invalid'}]) {
    const i=input();Object.assign(i.target,change);assert.equal(decide(i).eligible,false);
  }
});
test('transport is default-off and cannot redirect the integration credential to another origin',()=>{
  assert.equal(residencyTransportConfig(()=>undefined),null);
  const config={subscriptions_residency_booking_enabled:true,subscriptions_runtime_environment:'PROD',subscriptions_runtime_api_base_url:'https://padlhub.su/api',subscriptions_runtime_context_integration_token:'fixture-token-'.repeat(4)};
  assert.ok(residencyTransportConfig(k=>config[k]));
  for(const url of ['https://evil.example/api','https://padlhub.su/api?x=1','http://padlhub.su/api']) assert.equal(residencyTransportConfig(k=>k==='subscriptions_runtime_api_base_url'?url:config[k]),null);
});
test('private candidate output refuses this and other Git worktrees before writing',()=>{
  const external=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'residency-output-test-'));
  try {
    const other=path.join(external,'other-checkout');
    fs.mkdirSync(other);
    execFileSync('git',['init','--quiet',other]);
    for(const parent of [process.cwd(),other,path.join(other,'.git')]) {
      assert.throws(()=>assertResidencyOutputPath(path.join(parent,'residency-private-should-not-exist')),/outside every Git/);
    }
    assert.equal(assertResidencyOutputPath(path.join(external,'private-candidate')),path.join(external,'private-candidate'));
  } finally {fs.rmSync(external,{recursive:true,force:true});}
});
test('candidate rejects unreviewed function preimages before composing anything',()=>{
  assert.throws(()=>composeResidencyFlow([]),/PREIMAGE_DRIFT/);
});
const live=process.env.RESIDENCY_LIVE_FIXTURE;
test('private live snapshot composes only four function bodies, preserving graph and configuration',{skip:!live},()=>{
  const flow=JSON.parse(fs.readFileSync(live));const packet=composeResidencyFlow(flow);
  assert.equal(packet.candidate.length,flow.length);
  const changed=[];for(let n=0;n<flow.length;n++) {
    const before=flow[n],after=packet.candidate[n];
    if(JSON.stringify(before)!==JSON.stringify(after)) {changed.push(before.id);assert.deepEqual({...after,func:before.func},before);}
  }
  assert.deepEqual(changed.sort(),RESIDENCY_TARGETS.map(t=>t.id).sort());
  for(const compose of [composeResidencyGateway,composeResidencyPreview]) assert.throws(()=>compose('unrelated body'),/anchor drift/);
});

test('actual composed gateway uses owned discount-only residency before a split-game decision',{skip:!live},()=>{
  const flow=JSON.parse(fs.readFileSync(live));
  const body=composeResidencyGateway(flow.find(n=>n.id===RESIDENCY_TARGETS[0].id).func);
  const run=new Function('msg','node','env','global',body);
  const evaluatorBody=composeResidencyEvaluator(flow.find(n=>n.id===RESIDENCY_TARGETS[2].id).func);
  const globals={vivacrm_access_token:'fixture-admin',vivacrm_token_expires_at:Date.now()+60000,subscriptions_residency_booking_enabled:true,subscriptions_runtime_environment:'PROD',
    subscriptions_runtime_api_base_url:'https://padlhub.su/api',subscriptions_runtime_context_integration_token:'fixture-token-'.repeat(4)};
  const host={get:k=>globals[k]};
  const now=Date.now(),station='00000000-0000-4000-8000-000000000002',room='00000000-0000-4000-8000-000000000003';
  const evidence=residencyFixture({now,stationId:station});
  const exercise={id:'exercise:fixture',studio:{id:station},room:{id:room},direction:{id:4588},type:{id:1613},
    timeFrom:evidence.startsAt,timeTo:new Date(Date.parse(evidence.startsAt)+3600000).toISOString(),availableClientSubscriptions:[]};
  const owned={subscriptionId:'instance:fixture',clientId:'client:fixture',productId:RESIDENCY_PRODUCT_ID,product:{id:RESIDENCY_PRODUCT_ID},
    status:'ACTIVE',purchaseDate:evidence.purchasedAt,activationDate:evidence.context.instance.activeFrom,expirationDate:evidence.context.instance.activeTo,visitsLeft:0};
  delete evidence.startsAt;
  const ctx={step:'exercise',caller:'split',action:'book',managedAction:'JOIN_GAME',tenantKey:'iSkq6G',actorClientId:'client:fixture',clientSubscriptionId:'instance:fixture',
    operationId:'operation:residency-fixture',exerciseId:exercise.id,authHeader:'Bearer fixture-token',
    lk1ProductIdentity:{tenantKey:'iSkq6G',actorClientId:'client:fixture',subscriptionId:'instance:fixture',productId:RESIDENCY_PRODUCT_ID,name:'Резидентство',purchaseDate:owned.purchaseDate,subscription:owned},
    lk1TariffProof:{source:'VIVA_EXISTING_TARIFF',amountMinor:100000,stationId:station,roomId:room,durationMinutes:60,startsAt:exercise.timeFrom,observedAt:now}};
  let msg={_subscriptionBooking:ctx,payload:exercise,statusCode:200};
  let reads=0;const trace=[];
  for(let hop=0;hop<35;hop++) {
    const outputs=run(msg,{warn(){},error(){}},{get(){}},host);
    const index=outputs.findIndex(Boolean);trace.push([ctx.step,index,ctx.lk1MoneyReadbackPhase]);assert.ok(index>=0);
    msg=outputs[index];
    if(index===4) assert.fail('Gateway stopped: '+JSON.stringify(msg.payload)+' trace='+JSON.stringify(trace));
    if(ctx.step==='lk1_policy_decision' && msg._managedSubscriptionPolicyInput) {
      new Function('msg',evaluatorBody)(msg);
      assert.equal(msg._managedSubscriptionPolicyDecision.eligible,true,JSON.stringify(msg._managedSubscriptionPolicyDecision.blockers));
      assert.equal(msg._managedSubscriptionPolicyDecision.subscriptionVisitCount,0);
      assert.equal(msg._managedSubscriptionPolicyDecision.benefit.finalPriceMinor,70000);
      assert.ok(reads>=1);
      // Let the real router persist its PREPARED intent (mocked Mongo output only).
      const prepared=run(msg,{warn(){},error(){}},{get(){}},host).find(Boolean);
      assert.equal(prepared._subscriptionBooking.lk1.decision.subscriptionVisitCount,0);
      const saved=structuredClone(prepared._subscriptionBooking);
      const extracted=extractSubscriptionPricePreviewSource({source:body,label:'residency replay',roots:['lk1Fingerprint','lk1ReplayIdentityMatches']});
      const replay=new Function(extracted.source+';return {lk1Fingerprint,lk1ReplayIdentityMatches};')();
      const retry={tenantKey:ctx.tenantKey,actorClientId:ctx.actorClientId,clientSubscriptionId:ctx.clientSubscriptionId,
        operationId:ctx.operationId,managedAction:'JOIN_GAME',caller:'split',exerciseId:ctx.exerciseId};
      const operation={_id:ctx.operationKey,tenantKey:ctx.tenantKey,actorClientId:ctx.actorClientId,
        operationId:ctx.operationId,clientSubscriptionId:ctx.clientSubscriptionId,exerciseId:ctx.exerciseId,category:'open_game',lk1:saved.lk1};
      for(const state of ['CONFIRMED','PENDING_CONFIRMATION']) {
        operation.state=state;
        globals.subscriptions_residency_booking_enabled=false;
        assert.equal(replay.lk1ReplayIdentityMatches(retry,operation),true);
        globals.subscriptions_residency_booking_enabled=true;
        const expired=structuredClone(evidence);expired.validUntil=new Date(Date.now()-60000).toISOString();
        assert.equal(replay.lk1ReplayIdentityMatches({...retry,residencyContext:expired},operation),true);
      }
      assert.equal(replay.lk1ReplayIdentityMatches(retry,{...operation,lk1:{...operation.lk1,residencyBinding:undefined}}),false);

      function recheck(change) {
        const state=structuredClone(saved);state.step='exercise_recheck';
        let current={_subscriptionBooking:state,payload:exercise,statusCode:200};
        const proof=structuredClone(evidence);if(change) change(proof,state);
        for(let n=0;n<20;n++) {
          const out=run(current,{warn(){},error(){}},{get(){}},host);const port=out.findIndex(Boolean);current=out[port];
          if(port===4 || (state.step==='booking_create' && current.method==='POST')) return {port,message:current};
          if(state.step==='residency_context') current={...current,payload:proof,statusCode:200,responseUrl:current.url};
          else if(['lk1_money_owned_subscriptions','product_owned_recheck'].includes(state.step)) current={...current,payload:{content:[owned],totalElements:1},statusCode:200,responseUrl:current.url};
          else assert.fail('Unexpected prewrite step: '+state.step+'/'+JSON.stringify(current.payload));
        }
        assert.fail('Prewrite did not terminate');
      }
      const allowed=recheck();
      assert.equal(allowed.message._subscriptionBooking.step,'booking_create',JSON.stringify(allowed.message.payload));
      assert.equal(allowed.message.payload.paymentType,'ON_PLACE');
      assert.equal(allowed.message.payload.clientSubscriptionId,undefined);
      for(const change of [
        proof=>{proof.context.policyDigest='sha256:'+'b'.repeat(64);},
        proof=>{proof.validUntil=new Date(Date.now()-1).toISOString();},
        (_proof,state)=>{state.lk1TariffProof.amountMinor=100001;}
      ]) assert.equal(recheck(change).port,4);
      return;
    }
    if(ctx.step==='residency_context') {reads++;msg={...msg,payload:structuredClone(evidence),statusCode:200,responseUrl:msg.url};}
    else if(ctx.step==='lk1_money_owned_subscriptions') msg={...msg,payload:{content:[owned],totalElements:1},statusCode:200,responseUrl:msg.url};
    else if(ctx.step==='lk1_operation_find' || ctx.step==='lk1_usage_operations') msg={...msg,payload:[]};
    else if(['active_bookings','history_bookings'].includes(ctx.step)) msg={...msg,payload:{content:[],totalElements:0},statusCode:200,responseUrl:msg.url};
    else assert.fail('Unexpected gateway step/output: '+ctx.step+'/'+index+'/'+JSON.stringify(msg.payload));
  }
  assert.fail('Gateway did not reach its decision: '+JSON.stringify(trace));
});
