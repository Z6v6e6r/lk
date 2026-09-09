import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { extractSubscriptionPricePreviewSource } from '../lib/subscriptionPricePreviewSources.mjs';
import { scopeSubscriptionUsage, scopeSubscriptionEvaluator } from '../lib/subscriptionInstanceLimitSources.mjs';
import { composeSubscriptionInstanceLimitsArtifacts } from '../patch_nodered_subscription_instance_limits.mjs';
import { previewSources } from '../patch_nodered_subscription_price_preview.mjs';

const read = path => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const gateway = read('../nodered_lk1_hub_nodes/gateway.js');
const evaluator = read('../nodered_lk1_hub_nodes/evaluator.js');
const bookingSource = read('../nodered_subscription_booking_nodes/fn_subscription_booking_router.js');
const roots = ['isObj', 'isValidDateKey', 'normalizeId', 'isInactiveBooking', 'eventDate', 'bookingSubscriptionId', 'bookingId', 'resolveCategory', 'eventDurationMinutes'];
const helpers = extractSubscriptionPricePreviewSource({ source: bookingSource, label: 'booking', roots }).source;
const usageBlock = source => source.slice(source.indexOf('if (ctx.step === "lk1_usage_operations") {'), source.indexOf('if (ctx.step === "lk1_policy_decision") {'));
const runUsage = new Function('msg', `${helpers}\nconst ctx=msg._subscriptionBooking;
const lk1Fields=['maxActiveBookings','freeGameMinutesPerDay','gameOverageDiscountPercent','groupTrainingDiscountPercent','tournamentDiscountPercent'];
const OUTPUT_MANAGED_POLICY=6; const emit=()=>msg;
const lk1Stop=(_ctx,code)=>{msg.errorCode=code;return msg;};
${usageBlock(gateway)}`);
const product='db7a5250-7369-4f43-8ac5-9111be24bc74';
const rule={productId:product,maxActiveBookings:4,freeGameMinutesPerDay:60,gameOverageDiscountPercent:30,groupTrainingDiscountPercent:50,tournamentDiscountPercent:50};
const booking=(id,sub='sub-A',extra={})=>({id,clientSubscriptionId:sub,paymentType:sub?'SUBSCRIPTION':'CARD',timeFrom:'2099-09-22T07:00:00+03:00',timeTo:'2099-09-22T08:00:00+03:00',exerciseDate:'2099-09-22T07:00:00+03:00',exerciseDateTo:'2099-09-22T08:00:00+03:00',exerciseType:{id:1613},exerciseDirection:{id:4588},...extra});
const operation=(sub='sub-A',extra={})=>({tenantKey:'fixture',actorClientId:'fixture-actor',clientSubscriptionId:sub,serviceDate:'2099-09-22',state:'CONFIRMED',lk1:{decision:{gameMinutes:{localDate:'2099-09-22',freeMinutes:60}}},...extra});
function calculate(selected, {active=[],history=[],operations=[]}={}) {
  const msg={payload:structuredClone(operations),_subscriptionBooking:{step:'lk1_usage_operations',tenantKey:'fixture',actorClientId:'fixture-actor',clientSubscriptionId:selected,serviceDate:'2099-09-22',managedAction:'CREATE_GAME',lk1:{rule,bookings:structuredClone([...active,...history]),activeBookings:structuredClone(active),target:{resolutionSource:'SERVER',category:'GAME',currency:'RUB',priceSource:'VIVA_EXISTING_TARIFF',basePriceMinor:200000,startsAt:'2099-09-22T07:00:00+03:00',durationMinutes:60}}}};
  runUsage(msg);
  if(msg.errorCode) return msg;
  const input=msg._managedSubscriptionPolicyInput;
  new Function('msg',evaluator)(msg);
  return {input,decision:msg._managedSubscriptionPolicyDecision};
}
test('active limit and consumed minutes on A leave B and C available',()=>{
  const active=[1,2,3,4].map(n=>booking(`a-${n}`,'sub-A',{exerciseDate:'2099-09-23'}));
  const options={active,operations:[operation()]};
  const a=calculate('sub-A',options);
  assert.deepEqual(a.decision.blockers.map(b=>b.code),['ACTIVE_SERVICES_LIMIT_REACHED']);
  for(const id of ['sub-B','sub-C']){
    const b=calculate(id,options);
    assert.equal(b.input.usage.activeServices,0);
    assert.equal(b.input.usage.usedOrReservedFreeMinutesToday,0);
    assert.equal(b.decision.eligible,true);
    assert.equal(b.decision.gameMinutes.freeMinutes,60);
    assert.equal(b.decision.benefit.finalPriceMinor,0);
  }
});
test('selected subscription still pays discounted overage after its own free hour',()=>{
  const a=calculate('sub-A',{operations:[operation()]});
  assert.equal(a.decision.eligible,true);
  assert.equal(a.decision.gameMinutes.freeMinutes,0);
  assert.equal(a.decision.benefit.finalPriceMinor,140000);
});
test('card and other subscription bookings cannot consume the selected active limit',()=>{
  const r=calculate('sub-B',{active:[booking('b','sub-B'),booking('a'),...Array.from({length:5},(_,n)=>booking(`card-${n}`,null))]});
  assert.equal(r.input.usage.activeServices,1);
  assert.equal(r.decision.eligible,true);
});
test('provider history matches instance, cancellation and covered bookings count once',()=>{
  const result=calculate('sub-B',{history:[booking('b','sub-B'),booking('a'),booking('cancel','sub-B',{isCancelled:true})],operations:[operation('sub-B',{bookingId:'b'}),operation('sub-A')]});
  assert.equal(result.input.usage.usedOrReservedFreeMinutesToday,60);
  assert.equal(result.input.usage.activeServices,0);
  assert.equal(calculate('sub-C',{history:[booking('a'),booking('b','sub-B')]}).input.usage.usedOrReservedFreeMinutesToday,0);
});
test('released/failed operations do not consume minutes; pending reservations do',()=>{
  assert.equal(calculate('sub-B',{operations:[operation('sub-B',{state:'RELEASED'}),operation('sub-B',{state:'FAILED'})]}).input.usage.usedOrReservedFreeMinutesToday,0);
  assert.equal(calculate('sub-B',{operations:[operation('sub-B',{state:'PREPARED'})]}).input.usage.usedOrReservedFreeMinutesToday,60);
});
test('missing instance, foreign tenant/actor and invalid date fail closed',()=>{
  for(const extra of [{clientSubscriptionId:null},{tenantKey:'foreign'},{actorClientId:'foreign'},{serviceDate:'invalid'}]){
    assert.equal(calculate('sub-B',{operations:[operation('sub-B',extra)]}).errorCode,'LK1_ALLOWANCE_RECORD_INVALID');
  }
});
test('evaluator rejects the previous actor-wide usage scope',()=>{
  const {input}=calculate('sub-B');
  input.usage.activeServiceScope='ALL_BOOKINGS';
  const msg={_managedSubscriptionPolicyInput:input};new Function('msg',evaluator)(msg);
  assert.equal(msg._managedSubscriptionPolicyDecision.eligible,false);
  assert.ok(msg._managedSubscriptionPolicyDecision.blockers.some(b=>b.code==='USAGE_SNAPSHOT_INVALID'));
});
test('source transformations stop on drift or repeated application',()=>{
  for(const [fn,source] of [[scopeSubscriptionUsage,gateway],[scopeSubscriptionEvaluator,evaluator]]) assert.throws(()=>fn(source),/source drift/);
});
const fixture=process.env.LK_INSTANCE_LIMITS_FLOW_FIXTURE;
test('exact installed gateway and preview patch together; graph and other functions remain unchanged',{skip:!fixture},()=>{
  const bytes=fs.readFileSync(fixture);const original=JSON.parse(bytes);
  const {candidate,contract}=composeSubscriptionInstanceLimitsArtifacts(bytes,'fixture-instance-limits');
  const changed=original.filter((n,i)=>JSON.stringify(n)!==JSON.stringify(candidate[i]));
  assert.equal(changed.length,4);assert.equal(contract.allowedChanges.length,4);
  const get=(flow,id)=>flow.find(n=>n.id===id).func;
  const booking=get(candidate,'lk_subscription_booking_router_20260804');
  assert.equal(usageBlock(booking),usageBlock(gateway));
  const preview=get(candidate,'lk_subscription_price_preview_20260908_router');
  assert.ok(preview.includes(usageBlock(gateway)));
  assert.equal(previewSources(candidate).router,preview);
  assert.equal(previewSources(candidate).evaluator,get(candidate,'lk_subscription_managed_policy_20260820'));
  for(const node of changed){const bad=structuredClone(original);bad.find(n=>n.id===node.id).func+='\n// drift';assert.throws(()=>composeSubscriptionInstanceLimitsArtifacts(Buffer.from(JSON.stringify(bad)),'fixture-drift'),/preimage drift/);}
  assert.throws(()=>composeSubscriptionInstanceLimitsArtifacts(Buffer.from(JSON.stringify(candidate)),'fixture-repeat'),/preimage drift/);
});

test('unresolved subscription membership fails before excluding active/history rows',()=>{
  for(const extra of [{clientSubscriptionId:null},{subscriptionId:'sub-B'},{subscription:{id:'sub-B'}},{clientSubscription:{uuid:'sub-B'}},{clientSubscriptionId:{id:'sub-A'}}]){
    const row=booking('uncertain','sub-A',extra);
    for(const list of ['active','history']) assert.equal(calculate('sub-C',{[list]:[row]}).errorCode,'LK1_BOOKING_SUBSCRIPTION_ID_UNRESOLVED');
  }
});
test('matching supported aliases, cancelled and other-day history remain safe',()=>{
  const row=booking('b','sub-B',{subscriptionId:'sub-B',subscription:{id:'sub-B'},clientSubscription:{uuid:'sub-B'}});
  assert.equal(calculate('sub-B',{active:[row]}).input.usage.activeServices,1);
  const unknown=booking('unknown',null,{paymentType:'SUBSCRIPTION'});
  assert.equal(calculate('sub-C',{history:[{...unknown,isCancelled:true},{...unknown,exerciseDate:'2099-09-23'}]}).decision.eligible,true);
});

test('existing mixed-case instance IDs share the same reservations and active limit',()=>{
  const r=calculate('SUB-a',{active:[booking('a','sUb-A',{exerciseDate:'2099-09-23'})],operations:[operation('sub-A')]});
  assert.equal(r.input.usage.activeServices,1);
  assert.equal(r.input.usage.usedOrReservedFreeMinutesToday,60);
  assert.equal(r.decision.benefit.finalPriceMinor,140000);
  const hooks=read('../nodered_lk1_hub_nodes/gateway_hooks.js');
  const history=hooks.slice(hooks.indexOf('// HUB_HISTORY'),hooks.indexOf('// HUB_CONFIRMATION'));
  assert.doesNotMatch(history,/clientSubscriptionId:\s*ctx.clientSubscriptionId/);
});

test('selected-instance missing date or category cannot grant an extra free hour',()=>{
  const missingDate=booking('date','sub-A',{exerciseDate:null,timeFrom:null});
  const missingCategory=booking('category','sub-A',{exerciseType:null,exerciseDirection:null});
  for(const list of ['active','history']){
    assert.equal(calculate('sub-A',{[list]:[missingDate]}).errorCode,'LK1_BOOKING_DATE_UNRESOLVED');
    assert.equal(calculate('sub-A',{[list]:[missingCategory]}).errorCode,'LK1_BOOKING_CATEGORY_UNRESOLVED');
  }
});
