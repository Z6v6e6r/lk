import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import test from 'node:test';
import {composeResidencyPreview} from '../lib/residencyBookingSources.mjs';
import {RESIDENCY_PRODUCT_ID,residencyTransportConfig,validateResidencyBookingContext,RESIDENCY_BOOKING_COMPATIBILITY,RESIDENCY_TOURNAMENT_COMPATIBILITY} from '../lib/residencyBookingContext.mjs';
import {residencyFixture} from './fixtures/residency-booking-context.mjs';
import {extractSubscriptionPricePreviewSource} from '../lib/subscriptionPricePreviewSources.mjs';
import {patchDailyVisitUsage,patchDailyVisitEvaluator} from '../patch_live_lk1_daily_visit.mjs';
import {assertHubOutputPath} from '../patch_live_lk1_hub.mjs';
import {composeFriendshipSpecialArtifacts,patchFriendshipSpecialCoverage,patchInstalledResidencyPreview,
  FRIENDSHIP_SPECIAL_TARGETS,FRIENDSHIP_SPECIAL_SOURCE_SHA256} from '../patch_live_friendship_special_residency_preview.mjs';

const read = p => fs.readFileSync(new URL(p,import.meta.url),'utf8');
const product='6b98e7e3-5bd3-4e94-9dc3-7723ea52513e';
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const actor=uuid(1),friend=uuid(2),resident=uuid(3),station=uuid(4),room=uuid(5),event=uuid(6);
const rule={productId:product,maxActiveBookings:8,freeGameMinutesPerDay:120,
  gameOverageDiscountPercent:30,groupTrainingDiscountPercent:50,tournamentDiscountPercent:50};
const gateway=patchDailyVisitUsage(read('../nodered_lk1_hub_nodes/gateway.js'));
const base=read('../nodered_subscription_booking_nodes/fn_subscription_booking_router.js');
const roots=['isObj','normalizeId','isInactiveBooking','eventDate','bookingSubscriptionId','bookingId','resolveCategory',
  'eventDurationMinutes','exerciseDirectionId','isValidDateKey'];
const helpers=extractSubscriptionPricePreviewSource({source:base+'\n'+gateway,roots}).source;
const constants=extractSubscriptionPricePreviewSource({source:gateway,
  roots:['lk1Fields','LK1_FREE_FIRST_EVENT_PRODUCTS','LK1_FREE_FIRST_EVENT_DIRECTION_SCOPES','lk1OperationCategory']}).source;
const usageBlock=gateway.slice(gateway.indexOf('if (ctx.step === "lk1_usage_operations") {'),gateway.indexOf('if (ctx.step === "lk1_policy_decision") {'));
const usage=new Function('msg',`${helpers}\n${constants}\nconst ctx=msg._subscriptionBooking;
const OUTPUT_MANAGED_POLICY=6;const emit=()=>msg;
const lk1Stop=(_ctx,code)=>{msg.previewError=code;return msg;};\n${usageBlock}`);
const evaluator=patchDailyVisitEvaluator(read('../nodered_lk1_hub_nodes/evaluator.js'));
const evaluate=msg=>new Function('msg',evaluator)(msg);
const source=composeResidencyPreview(read('../nodered_subscription_price_preview_nodes/router.js'));
const globals={subscriptions_residency_booking_enabled:true,subscriptions_runtime_environment:'PROD',
  subscriptions_runtime_api_base_url:'https://padlhub.su/api',subscriptions_runtime_context_integration_token:'fixture-integration-'.repeat(3)};
const host={get:k=>globals[k]};
const canonical={isObj:v=>v!==null&&typeof v==='object'&&!Array.isArray(v),normalizeId:v=>String(v??'').trim().toLowerCase(),
  identityMoneyOwned:(_ctx,rows)=>rows,identityOwned:(_ctx,rows)=>rows,collectSubscriptionPurchaseDateEvidence:()=>({invalid:false,dates:['2026-11-10']}),
  resolveLk1Rule:()=>({matched:true,rule}),managedExternalEventTypeId:ex=>`viva:direction:${ex.direction.id}:type:${ex.type.id}`,
  lk1LifecycleInstant:(v,end)=>Date.parse(v+(v.length===10?(end?'T23:59:59+03:00':'T00:00:00+03:00'):'')),
  preflightAvailability:{filterSplitEligibleSubscriptions:rows=>rows,resolveSplitSubscriptionLifecycle:()=> 'ACTIVE'}};
let run=new Function('msg','canonical','canonicalUsage','node','global','env',source);
function context(order=[friend,resident],category='TOURNAMENT') {
  const subscriptions={},metadata={};
  for(const id of order){subscriptions[id]={subscriptionId:id,status:'ACTIVE',purchaseDate:'2026-11-10',
    activationDate:'2026-11-10',expirationDate:'2100-11-10',visitsLeft:25};
    metadata[id]={productId:id===friend?product:RESIDENCY_PRODUCT_ID};}
  const startsAt='2099-11-13T19:30:00+03:00';
  return {step:'next',startedAt:Date.now(),tenantKey:'iSkq6G',actorClientId:actor,eventCategory:category,
    exerciseId:event,selectionKey:'fixture:selection',target:{stationId:station,roomId:room,startsAt,durationMinutes:90},
    exercise:{id:event,studio:{id:station},room:{id:room},timeFrom:startsAt,timeTo:'2099-11-13T21:00:00+03:00',
      direction:{id:category==='TOURNAMENT'?5280:6307},type:{id:category==='TOURNAMENT'?1013:2349}},
    subscriptions,metadata,catalog:{[product]:'Дружба 2.0',[RESIDENCY_PRODUCT_ID]:'Резидентство'},
    requestedIds:[...order],pending:[...order],quotes:[],basePriceMinor:400000,priceProductId:uuid(7),
    ruleProductIds:[product],activeBookings:[],bookings:[],operations:[]};
}
function execute(ctx,response={}) {
  let msg={_subscriptionPricePreview:ctx,...response};const ports=[];
  for(let hop=0;hop<10;hop++){
    const out=run(msg,canonical,usage,{warn(){},error(){}},host,{get(){}});
    const port=out.findIndex(Boolean);ports.push(port);msg=out[port];
    if(port===3){evaluate(msg);continue;}
    return {msg,port,ports};
  }
  assert.fail('Preview did not terminate');
}
for(const order of [[friend,resident],[resident,friend]]) test(`tournament residency401 preserves free Friendship: ${order[0]===friend?'friend first':'resident first'}`,()=>{
  const ctx=context(order);const request=execute(ctx);assert.equal(request.port,0);
  const result=execute(ctx,{...request.msg,statusCode:401,payload:{}});
  assert.equal(result.port,4);assert.equal(ctx.statusCode,200,ctx.error);
  assert.equal(ctx.quotes.length,2);
  const q=ctx.quotes.find(q=>q.subscriptionId===friend);assert.equal(q.status,'AVAILABLE');assert.equal(q.amountMinor,0);assert.equal(q.discountPercent,100);
  const r=ctx.quotes.find(q=>q.subscriptionId===resident);assert.equal(r.status,'UNAVAILABLE');assert.equal(r.reasonCode,'RESIDENCY_BOOKING_CONTEXT_UNAVAILABLE');
});
function pendingContext() {
  const ctx=context([resident],'GROUP_TRAINING');ctx.pending=[];ctx.step='residency_context';
  ctx.quotes=[{subscriptionId:friend,status:'AVAILABLE',amountMinor:0}];
  ctx.residencyPending={id:resident,target:{resolutionSource:'SERVER',category:'GROUP_TRAINING',stationId:station,
    externalEventTypeId:'viva:direction:6307:type:2349',startsAt:new Date(ctx.target.startsAt).toISOString(),durationMinutes:90},action:'BOOK_GROUP_TRAINING'};
  return ctx;
}
for(const response of [{statusCode:401},{statusCode:403},{statusCode:500},{error:{code:'ETIMEDOUT'}},
  {statusCode:200,method:'GET'},{statusCode:200,responseUrl:'https://other.invalid'},
  {statusCode:200,payload:{}}, {statusCode:200,payload:{context:{clientSubscriptionId:uuid(90)}}}]) {
  test(`residency failure isolates one instance: ${JSON.stringify(response)}`,()=>{
    const ctx=pendingContext(),before=structuredClone(ctx.quotes[0]);
    const url=residencyTransportConfig(k=>globals[k],'preview').url;
    const {port,msg}=execute(ctx,{method:'POST',url,responseUrl:url,...response});
    assert.equal(port,4);assert.equal(ctx.statusCode,200);assert.deepEqual(ctx.quotes[0],before);
    assert.equal(ctx.quotes.length,2);assert.equal(ctx.quotes[1].subscriptionId,resident);
    assert.equal(ctx.quotes[1].status,'UNAVAILABLE');assert.equal(ctx.quotes[1].amountMinor,null);
    assert.equal(ctx.residencyPending,undefined);assert.equal(msg.error,undefined);assert.equal(msg.headers,undefined);
  });
}
test('foreign inconsistent residency proof stays unavailable',()=>{
  const ctx=pendingContext();const evidence=residencyFixture({now:Date.now()});
  evidence.context.clientSubscriptionId=resident;evidence.context.instance.activeTo=new Date(Date.now()+30*86400000).toISOString();
  // A foreign or otherwise invalid proof cannot become AVAILABLE: the real validator remains authoritative.
  const url=residencyTransportConfig(k=>globals[k],'preview').url;
  execute(ctx,{method:'POST',url,responseUrl:url,statusCode:200,payload:evidence});
  assert.equal(ctx.quotes.find(q=>q.subscriptionId===resident).status,'UNAVAILABLE');
});
test('valid supported residency response preserves the established discount without a free visit',()=>{
  const ctx=pendingContext();const evidence=residencyFixture({clientSubscriptionId:resident});
  ctx.target.startsAt=evidence.startsAt;ctx.residencyPending.target.startsAt=evidence.startsAt;
  const url=residencyTransportConfig(k=>globals[k],'preview').url;
  const {port}=execute(ctx,{method:'POST',url,responseUrl:url,statusCode:200,payload:evidence});
  assert.equal(port,4);assert.equal(ctx.statusCode,200,ctx.error);
  assert.equal(ctx.quotes.length,2);assert.equal(ctx.quotes[1].status,'AVAILABLE');
  assert.equal(ctx.quotes[1].amountMinor,200000);assert.equal(ctx.quotes[1].freeMinutes,0);
});
for(const order of [[friend,resident],[resident,friend]]) test('supported mixed batch survives residency401: '+order.join(','),()=>{
  const ctx=context(order,'GROUP_TRAINING');const first=execute(ctx);assert.equal(first.port,0,ctx.error);
  const final=execute(ctx,{...first.msg,statusCode:401,payload:{}});assert.equal(final.port,4);assert.equal(ctx.statusCode,200,ctx.error);
  assert.equal(ctx.quotes.length,2);assert.equal(new Set(ctx.quotes.map(q=>q.subscriptionId)).size,2);
  assert.equal(ctx.quotes.find(q=>q.subscriptionId===friend).status,'AVAILABLE');
  assert.equal(ctx.quotes.find(q=>q.subscriptionId===friend).amountMinor,200000);
  assert.equal(ctx.quotes.find(q=>q.subscriptionId===resident).status,'UNAVAILABLE');
});
test('two residency instances cannot retry one another or erase another benefit',()=>{
  const second=uuid(8),ctx=context([resident,second],'GROUP_TRAINING');
  ctx.quotes=[{subscriptionId:friend,status:'AVAILABLE',amountMinor:0}];let result=execute(ctx);let reads=0;
  while(result.port===0){assert.ok(++reads<=2);result=execute(ctx,{...result.msg,statusCode:500,payload:{}});}
  assert.equal(reads,2);assert.equal(ctx.statusCode,200,ctx.error);assert.equal(ctx.quotes.length,3);
  assert.deepEqual(ctx.quotes.map(q=>q.status),['AVAILABLE','UNAVAILABLE','UNAVAILABLE']);
});
function assertTournamentDiscount(order=[resident]) {
  const evidence=residencyFixture({clientSubscriptionId:resident,tournaments:true});
  const ctx=context(order);for(const id of order)ctx.subscriptions[id].productId=ctx.metadata[id].productId;
  ctx.target.startsAt=evidence.startsAt;ctx.exercise.timeFrom=evidence.startsAt;
  ctx.exercise.timeTo=new Date(Date.parse(evidence.startsAt)+90*60000).toISOString();
  const request=execute(ctx);assert.equal(request.port,0,ctx.error);
  const result=execute(ctx,{...request.msg,statusCode:200,responseUrl:request.msg.url,payload:evidence});
  assert.equal(result.port,4);assert.equal(ctx.statusCode,200,ctx.error);
  const q=ctx.quotes.find(q=>q.subscriptionId===resident);
  assert.equal(q.status,'AVAILABLE');assert.equal(q.discountPercent,50);
  assert.equal(q.amountMinor,200000);assert.equal(q.freeMinutes,0);
  if(order.includes(friend))assert.equal(ctx.quotes.find(q=>q.subscriptionId===friend).amountMinor,0);
}
for(const order of [[resident],[friend,resident],[resident,friend]]) test('V2 tournament50 and Friendship0: '+order.join(','),()=>assertTournamentDiscount(order));
test('legacy and V2 residency proofs cannot exchange capability digests or widen event scope',()=>{
  for(const tournaments of [false,true]){
    const evidence=residencyFixture({clientSubscriptionId:resident,tournaments});
    const target={resolutionSource:'SERVER',category:'TOURNAMENT',stationId:station,
      externalEventTypeId:'viva:direction:5280:type:1013',startsAt:evidence.startsAt,durationMinutes:90};
    if(!tournaments)assert.throws(()=>validateResidencyBookingContext(evidence,resident,Date.now(),target,'BOOK_TOURNAMENT'));
    else assert.equal(validateResidencyBookingContext(evidence,resident,Date.now(),target,'BOOK_TOURNAMENT').rule.tournamentDiscountPercent,50);
    evidence.runtimeCompatibility={...(tournaments?RESIDENCY_BOOKING_COMPATIBILITY:RESIDENCY_TOURNAMENT_COMPATIBILITY)};
    assert.throws(()=>validateResidencyBookingContext(evidence,resident,Date.now()));
  }
  for(const mutate of [p=>p.benefitRules[2].percentage=100,p=>p.benefitRules[2].actions=['BOOK_GROUP_TRAINING'],
    p=>p.benefitRules[2].stationIds=[station],p=>p.benefitRules.push({...p.benefitRules[2]})]){
    const e=residencyFixture({clientSubscriptionId:resident,tournaments:true});mutate(e.context.policy);
    assert.throws(()=>validateResidencyBookingContext(e,resident,Date.now()));
  }
  const evidence=residencyFixture({clientSubscriptionId:resident,tournaments:true});
  assert.throws(()=>validateResidencyBookingContext(evidence,resident,Date.now(),{resolutionSource:'SERVER',category:'TOURNAMENT',stationId:station,
    externalEventTypeId:'viva:direction:9999:type:1013',startsAt:evidence.startsAt,durationMinutes:90},'BOOK_TOURNAMENT'));
});
test('residency-only failure returns one UNAVAILABLE quote',()=>{
  const ctx=pendingContext();ctx.quotes=[];execute(ctx,{statusCode:401});
  assert.equal(ctx.statusCode,200);assert.equal(ctx.quotes.length,1);assert.equal(ctx.quotes[0].status,'UNAVAILABLE');
});
test('unknown residency pending identity and other transport failures stay fail closed',()=>{
  for(const mutate of [ctx=>delete ctx.residencyPending,ctx=>{ctx.residencyPending.id=uuid(90);},
    ctx=>{ctx.metadata[resident].productId=product;},ctx=>{ctx.pending.push(resident);}]){
    const ctx=pendingContext();mutate(ctx);execute(ctx,{error:{code:'ETIMEDOUT'}});assert.equal(ctx.statusCode,503);
  }
  for(const step of ['profile','groupTariff','metadata','activeBookings']){
    const ctx=context();ctx.step=step;execute(ctx,{error:{code:'ETIMEDOUT'}});assert.equal(ctx.error,'PRICE_PREVIEW_READ_FAILED');
  }
  const ctx=pendingContext();ctx.startedAt=Date.now()-30000;execute(ctx,{statusCode:401});assert.equal(ctx.error,'PRICE_PREVIEW_TIMEOUT');
});
for(const direction of [5278,5280,5281]) test(`coverage is exact, direction ${direction}`,()=>{
  const ctx=context([friend]);ctx.exercise.direction.id=direction;
  execute(ctx);assert.equal(ctx.error,undefined,ctx.error);const q=ctx.quotes[0];assert.equal(q.amountMinor,direction===5281?200000:0);
});
test('free event still requires balance and fewer than eight active bookings',()=>{
  for(const count of [0,7,8])for(const balance of [0,1]){
    const ctx=context([friend]);ctx.subscriptions[friend].visitsLeft=balance;
    ctx.activeBookings=Array.from({length:count},(_,i)=>({id:uuid(100+i),clientSubscriptionId:friend,exerciseDate:'2099-11-14T10:00:00+03:00'}));
    execute(ctx);assert.equal(ctx.error,undefined,ctx.error);assert.equal(ctx.quotes[0].amountMinor,count<8&&balance>0?0:200000,JSON.stringify({count,balance}));
  }
});
function priorVisit(category,direction,state='CONFIRMED') {
  return {tenantKey:'iSkq6G',actorClientId:actor,clientSubscriptionId:friend,operationId:'fixture:previous',
    exerciseId:uuid(30),bookingId:uuid(31),serviceDate:'2099-11-13',category,state,
    lk1:{rule,target:{directionId:direction},decision:{subscriptionVisitCount:1,
      ...(category==='open_game'?{gameMinutes:{localDate:'2099-11-13',freeMinutes:90,paidOverageMinutes:0}}:{})}}};
}
for(const [priorCategory,priorDirection,nextCategory,nextDirection] of [
  ['open_game',4588,'tournament',5280],['tournament',5278,'tournament',5280],
  ['tournament',5280,'open_game',4588],['tournament',5280,'tournament',5278]
]) test(`one visit per day across ${priorDirection} -> ${nextDirection}`,()=>{
  const target={resolutionSource:'SERVER',eventId:event,category:nextCategory==='open_game'?'GAME':'TOURNAMENT',
    stationId:station,roomId:room,directionId:nextDirection,externalEventTypeId:`viva:direction:${nextDirection}:type:${nextCategory==='open_game'?1613:1013}`,
    basePriceMinor:400000,currency:'RUB',priceSource:'VIVA_EXISTING_TARIFF',startsAt:'2099-11-13T19:30:00+03:00',durationMinutes:90};
  const msg={payload:[priorVisit(priorCategory,priorDirection)],_subscriptionBooking:{tenantKey:'iSkq6G',actorClientId:actor,
    clientSubscriptionId:friend,serviceDate:'2099-11-13',managedAction:nextCategory==='open_game'?'JOIN_GAME':'BOOK_TOURNAMENT',
    category:nextCategory,step:'lk1_usage_operations',lk1ProductIdentity:{subscription:{visitsLeft:25}},
    lk1:{rule,target,bookings:[],activeBookings:[]}}};
  usage(msg);assert.equal(msg.previewError,undefined,msg.previewError);evaluate(msg);
  assert.equal(msg._managedSubscriptionPolicyDecision.eligible,true,JSON.stringify(msg._managedSubscriptionPolicyDecision.blockers));
  assert.equal(msg._managedSubscriptionPolicyDecision.subscriptionVisitCount,0);
  assert.equal(msg._managedSubscriptionPolicyDecision.benefit.finalPriceMinor,nextCategory==='open_game'?280000:200000);
});
for(const state of ['FAILED','RELEASED']) test('terminal '+state+' cannot consume the new5280 benefit',()=>{
  const ctx=context([friend]);ctx.operations=[priorVisit('tournament',5278,state)];
  execute(ctx);assert.equal(ctx.error,undefined,ctx.error);assert.equal(ctx.quotes[0].amountMinor,0);
});
const fixture=process.env.FRIENDSHIP_SPECIAL_LIVE_FLOW;
test('installed candidate isolates residency401 in both subscription orders and quotes5280 free', {skip:!fixture},()=>{
  const packet=composeFriendshipSpecialArtifacts(fs.readFileSync(fixture));
  const body=JSON.parse(packet.candidateBytes).find(n=>n.id===FRIENDSHIP_SPECIAL_TARGETS.preview.id).func;
  const installed=new Function('msg','node','global','env',body), priorRun=run;
  globals.subscriptions_lk1_plan_rules={formatVersion:1,rules:[{...rule,planKey:'friendship_two_hours',enforceFrom:'2026-09-01'}]};
  try{
    run=(msg,_canonical,_usage,node,global,env)=>installed(msg,node,global,env);
    for(const order of [[friend,resident],[resident,friend]]){
      const ctx=context(order);for(const id of order)ctx.subscriptions[id].productId=ctx.metadata[id].productId;
      const request=execute(ctx);assert.equal(request.port,0);
      const result=execute(ctx,{...request.msg,statusCode:401,payload:{}});assert.equal(result.port,4);assert.equal(ctx.statusCode,200,ctx.error);
      assert.equal(ctx.quotes.find(q=>q.subscriptionId===friend).amountMinor,0);
      assert.equal(ctx.quotes.find(q=>q.subscriptionId===resident).status,'UNAVAILABLE');
      assertTournamentDiscount(order);
    }
  }finally{run=priorRun;delete globals.subscriptions_lk1_plan_rules;}
});
test('exact live candidate changes only four func fields and keeps all historical pins', {skip:!fixture},()=>{
  const bytes=fs.readFileSync(fixture),before=JSON.parse(bytes);const packet=composeFriendshipSpecialArtifacts(bytes);
  const after=JSON.parse(packet.candidateBytes);assert.equal(after.length,before.length);
  const changed=[];
  for(let i=0;i<before.length;i++)if(JSON.stringify(before[i])!==JSON.stringify(after[i])){
    changed.push(before[i].id);assert.deepEqual({...after[i],func:before[i].func},before[i]);
  }
  assert.deepEqual(new Set(changed),new Set(Object.values(FRIENDSHIP_SPECIAL_TARGETS).map(t=>t.id)));
  const preview=after.find(n=>n.id===FRIENDSHIP_SPECIAL_TARGETS.preview.id).func;
  const prior=before.find(n=>n.id===FRIENDSHIP_SPECIAL_TARGETS.preview.id).func;
  assert.deepEqual(preview.match(/(?:booking|pricing|evaluator|join):\s*['"][a-f0-9]{64}['"]/g),prior.match(/(?:booking|pricing|evaluator|join):\s*['"][a-f0-9]{64}['"]/g));
  assert.throws(()=>composeFriendshipSpecialArtifacts(Buffer.from(JSON.stringify([...before,{id:'foreign'}]))),/preimage drift/);
  assert.throws(()=>composeFriendshipSpecialArtifacts(packet.candidateBytes),/preimage drift/);
  assert.throws(()=>patchInstalledResidencyPreview(preview),/anchor drift/);
});
test('focused patch refuses absent, duplicate and already expanded direction table',()=>{
  assert.throws(()=>patchFriendshipSpecialCoverage(gateway),/anchor drift/);
  assert.throws(()=>patchFriendshipSpecialCoverage('return msg;'),/anchor drift/);
  const old=gateway.replace('Object.freeze([5278, 5280])','Object.freeze([5278])');
  assert.ok(patchFriendshipSpecialCoverage(old).includes('Object.freeze([5278, 5280])'));
  assert.throws(()=>patchFriendshipSpecialCoverage(old+old),/anchor drift/);
  assert.match(FRIENDSHIP_SPECIAL_SOURCE_SHA256,/^[a-f0-9]{64}$/);
});
test('private candidate destination rejects other Git worktrees before writing',()=>{
  const temp=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'friendship-output-'));
  try{execFileSync('git',['init','--quiet',temp]);fs.chmodSync(temp,0o700);
    assert.throws(()=>assertHubOutputPath(path.join(temp,'private-candidate')),/outside every Git/);
  }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
