import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import { receiverFunctionSource, buildReceiverCandidate, NODE_IDS } from '../patch_nodered_booked_operation_receiver_flow.mjs';
const fixtureBytes = fs.readFileSync(new URL('./fixtures/managed-join-v2-contract.json', import.meta.url));
const f = JSON.parse(fixtureBytes);
const {privateKey, publicKey} = crypto.generateKeyPairSync('rsa', {modulusLength:2048,
  publicKeyEncoding:{type:'spki',format:'pem'}, privateKeyEncoding:{type:'pkcs8',format:'pem'}});
const hash = text => 'sha256:' + crypto.createHash('sha256').update(text).digest('hex');
const actor = 'synthetic-actor-token-for-v2-only';
const env = { LK1_BOOKED_OPERATION_RECEIVER_ENABLED:'true', BOOKED_OPERATION_EXECUTION_ENABLED:'true',
  LK2_BOOKED_OPERATION_DELEGATION_ISSUER:'https://lk2.example.test', LK2_BOOKED_OPERATION_DELEGATION_AUDIENCE:'lk1-owner',
  LK2_BOOKED_OPERATION_DELEGATION_KEY_ID:'synthetic-key', LK2_BOOKED_OPERATION_DELEGATION_PUBLIC_KEY_PEM:publicKey };
const globals = { subscriptions_managed_enforcement_product_ids:['8bf334ba-3050-4017-b40a-7eef2db1eb16'], subscriptions_runtime_environment:'PROD', subscriptions_runtime_api_base_url:'https://padlhub.su/api',
  subscriptions_runtime_context_integration_token:'synthetic-context-token-'.repeat(3),
  subscriptions_entitlement_integration_token:'synthetic-entitlement-token-'.repeat(3) };
const run = (name,msg,values=globals) => new Function('msg','env','nodeCrypto','global',receiverFunctionSource(name))(msg,{get:key=>env[key]},crypto,{get:key=>values[key]});
const r = f.confirmed.receipt;
const claims = (mode='admit', overrides={}) => {
  const now = Math.floor(Date.now()/1000);
  const read = mode==='read';
  return { iss:env.LK2_BOOKED_OPERATION_DELEGATION_ISSUER,aud:env.LK2_BOOKED_OPERATION_DELEGATION_AUDIENCE,
    sub:f.identity.userId,jti:crypto.randomUUID(),iat:now,nbf:now,exp:now+120,
    contract_version:2,scope:`subscription-runtime.booked-operation.${mode}`,caller:'lk2-api',
    method:read?'GET':'POST',path: mode==='admit'?f.paths.admission:mode==='preflight'?f.paths.preflight:f.paths.read,
    operation_id:f.identity.operationId,tenant_id:f.identity.tenantId,tenant_key:'iSkq6G',
    sid:'77777777-7777-4777-8777-777777777777',provider:'VIVA',provider_client_id:r.providerClientId,
    provider_mapping_id:r.providerMappingId,correlation_id:'managed-join-v2-correlation',
    ...(read?{receipt_version:2}:{request_sha256:mode==='preflight'?f.preflight.requestSha256:f.admission.requestSha256,
      idempotency_key_sha256:f.identity.idempotencyKeySha256,target_id:r.gameId,expected_revision:7,
      target_mapping_id:r.targetMappingId,provider_exercise_id:r.providerExerciseId,target_version:r.targetVersion,
      target_starts_at:new Date(Date.now()+3600000).toISOString(),target_duration_minutes:60,target_capacity:4,target_admissible:true,
      actor_token_sha256:hash(actor),actor_token_expires_at:new Date(Date.now()+300000).toISOString(),
      provider_client_subscription_id:r.providerClientSubscriptionId,...(mode==='admit'?{reservation_id:r.reservationId}:{})}),...overrides };
};
const sign = c => {
  const a=Buffer.from(JSON.stringify({alg:'RS256',typ:'phub-subscription-runtime-actor-delegation+jwt',kid:'synthetic-key'})).toString('base64url');
  const b=Buffer.from(JSON.stringify(c)).toString('base64url');
  return a+'.'+b+'.'+crypto.sign('RSA-SHA256',Buffer.from(a+'.'+b),privateKey).toString('base64url');
};
const message = (mode='admit',override={},body) => {
  const c=claims(mode,override);
  return {req:{method:c.method,url:c.path,originalUrl:c.path,query:{},params:{operationId:f.identity.operationId},headers:{
    'content-type':'application/json','x-correlation-id':c.correlation_id,
    'x-subscription-actor-delegation':sign(c),...(mode==='read'?{}:{'x-subscription-actor-token':actor})}},
    payload:structuredClone(body??(mode==='preflight'?f.preflight.request:f.admission.request))};
};
const accepted = () => run('admission_verify',message())[0];
test('v2 cross-repository fixture canonical hashes and unchanged operation ID',()=>{
  assert.equal(crypto.createHash('sha256').update(fixtureBytes).digest('hex'),'82f7b918275c86fd357283abd67bc7c727427a3680dfe9906b2d560eea3c0171');
  assert.equal(hash('booked-operation-admission:v2\0'+JSON.stringify(f.admission.request)),f.admission.requestSha256);
  assert.equal(hash('booked-operation-preflight:v2\0'+JSON.stringify(f.preflight.request)),f.preflight.requestSha256);
  assert.equal(accepted()._bookedOperation.document.operationId,f.identity.operationId);
  assert.deepEqual(accepted()._bookedOperation.document.managedJoinV2,f.admission.request);
});
test('v2 signed scope/method/version/body/actor bindings fail closed',()=>{
  for(const patch of [{scope:'subscription-runtime.booked-operation.read'},{method:'GET'},
    {contract_version:1},{actor_token_sha256:hash('swapped')},{actor_token_expires_at:undefined},
    {provider_client_subscription_id:undefined},{reservation_id:undefined},{operation_id:crypto.randomUUID()},
    {expected_revision:8},{target_id:crypto.randomUUID()},{path:f.paths.preflight}]) {
    const result=run('admission_verify',message('admit',patch));
    assert.equal(result[0],null,JSON.stringify(patch)); assert.ok(result[1].statusCode>=400);
  }
  for(const body of [null,{}, {...f.admission.request,usageRef:'invented'},
    {...f.admission.request,entitlement:{...f.admission.request.entitlement,usageRef:'invented'}},
    {...f.admission.request,entitlement:{...f.admission.request.entitlement,expectations:{...f.admission.request.entitlement.expectations,policyVersion:4}}}]) {
    const msg=message();msg.payload=body;
    assert.equal(run('admission_verify',msg)[0],null);
  }
  const wrongRoute=message();wrongRoute.req.url=wrongRoute.req.originalUrl='/lk/integrations/v1/booked-operation-admissions';
  assert.equal(run('admission_verify',wrongRoute)[0],null);
  assert.equal(run('read_verify',message('read',{receipt_version:1}))[0],null);
});
const preflightSelected = (values=globals, change={}) => {
  const msg=run('preflight_verify',message('preflight'))[0];
  run('preflight_router',msg,values);
  assert.equal(msg.method,'GET');assert.match(msg.url,/\/profile$/);
  msg.statusCode=200;msg.responseUrl=msg.url;msg.payload={id:r.providerClientId};
  run('preflight_router',msg,values);
  assert.equal(msg.method,'GET');assert.equal(msg.headers['X-Subscriptions-Integration-Token'],undefined);
  const start=msg._bookedOperationPreflight.claims.target_starts_at;
  msg.statusCode=200;msg.responseUrl=msg.url;msg.payload={id:r.providerExerciseId,
    timeFrom:start,timeTo:new Date(Date.parse(start)+3600000).toISOString(),
    direction:{id:4588},type:{id:1613},availableClientSubscriptions:[{clientSubscriptionId:r.providerClientSubscriptionId,
      productId:'8bf334ba-3050-4017-b40a-7eef2db1eb16',purchaseDate:'2026-09-01'}],...change};
  return {msg,result:run('preflight_router',msg,values)};
};
test('v2 preflight reads only exact configured CUP endpoints and emits fixture response',()=>{
  const {msg,result}=preflightSelected();assert.equal(result[0],msg);
  assert.equal(msg.url,'https://padlhub.su/api/internal/subscriptions/runtime-context');
  assert.deepEqual(msg.payload,{clientSubscriptionId:r.providerClientSubscriptionId});
  msg.statusCode=200;msg.responseUrl=msg.url;msg.payload={schemaVersion:1,clientSubscriptionId:r.providerClientSubscriptionId,
    subscriptionInstanceId:f.cupPreflight.request.subscriptionInstanceId,instance:{subscriptionInstanceId:f.cupPreflight.request.subscriptionInstanceId,policyVersion:3},
    policy:{policyVersion:3},policyDigest:f.cupPreflight.response.expectations.policyDigest};
  assert.equal(run('preflight_router',msg)[0],msg);
  assert.deepEqual(msg.payload,f.cupPreflight.request);assert.equal(msg.followRedirects,false);
  msg.statusCode=200;msg.responseUrl=msg.url;msg.payload=structuredClone(f.cupPreflight.response);
  const out=run('preflight_router',msg)[1];assert.equal(out.statusCode,200);assert.deepEqual(out.payload,f.preflight.response);
  assert.equal(out._bookedOperationPreflight,undefined);assert.equal(out.headers.Authorization,undefined);
  assert.equal(run('preflight_router',run('preflight_verify',message('preflight'))[0],{...globals,subscriptions_runtime_api_base_url:'https://evil.invalid'})[0],null);
});
test('v2 preflight refuses wrong-origin, policy/target mismatch and provider identity changes',()=>{
  for(const field of ['origin','policy','target','instance','extra']){
    const msg=run('preflight_verify',message('preflight'))[0];
    msg._bookedOperationPreflight={...msg._bookedOperationPreflight,step:'preflight',expectedUrl:'https://padlhub.su/api/internal/subscriptions/entitlements/preflight',
      instanceId:f.cupPreflight.request.subscriptionInstanceId,policyVersion:3,policyDigest:f.cupPreflight.response.expectations.policyDigest};
    msg.statusCode=200;msg.responseUrl=msg._bookedOperationPreflight.expectedUrl;msg.payload=structuredClone(f.cupPreflight.response);
    if(field==='origin')msg.responseUrl='https://evil.invalid';
    if(field==='policy')msg.payload.expectations.policyVersion=4;
    if(field==='target')msg.payload.target.targetId='foreign-exercise';
    if(field==='instance')msg.payload.subscriptionInstanceId='foreign-instance';
    if(field==='extra')msg.payload.usageRef='fake';
    assert.equal(run('preflight_router',msg)[1].statusCode,503,field);
  }
});
const canonicalRow=()=>({operationId:r.operationId,tenantKey:'iSkq6G',actorClientId:r.providerClientId,exerciseId:r.providerExerciseId,
  clientSubscriptionId:r.providerClientSubscriptionId,state:'CONFIRMED',bookingId:r.bookingId,confirmedAt:r.verifiedAt,activationState:'NOT_REQUIRED',
  managedJoinV2:structuredClone(f.admission.request),managedSubscriptionInstanceId:r.entitlement.subscriptionInstanceId,
  managedEntitlementOperationId:r.entitlement.usageRef.usageRef,managedEntitlementState:'CONFIRMED',managedDecision:{
    decisionKind:'ENTITLEMENT',action:'JOIN_GAME',target:{targetId:r.providerExerciseId},policyVersion:3,
    policyDigest:r.entitlement.policyRef.policyDigest,usageUnits:1,money:{currency:'RUB',finalPriceMinor:0}}});
const readReceipt = row => {
  const stored=accepted()._bookedOperation.document;
  const read=run('read_verify',message('read'))[0];
  read._bookedOperation={...read._bookedOperation,step:'owner_receipt',stored};read.payload=[row];
  return run('router',read)[1];
};
test('v2 receipt derives policy/usage from canonical CUP-confirmed booking, never admission alone',()=>{
  assert.deepEqual(readReceipt(canonicalRow()).payload,f.confirmed);
  for(const alter of [row=>row.state='RELEASED',row=>row.managedEntitlementState='RESERVED',row=>delete row.managedEntitlementOperationId,
    row=>row.activationState='PENDING',row=>row.managedDecision.policyVersion=4,row=>row.managedDecision.money.finalPriceMinor=1,
    row=>row.managedDecision.usageUnits=0,row=>row.managedSubscriptionInstanceId='other-instance',row=>row.actorClientId='foreign-client',
    row=>row.managedJoinV2.entitlement.expectations.targetSnapshot.revision++,row=>row.managedDecision.target.targetId='foreign-exercise']){
    const row=canonicalRow();alter(row);const out=readReceipt(row);assert.equal(out.payload.status,'UNKNOWN');assert.equal(out.payload.receipt,undefined);
  }
});
test('same key changed version or expectations cannot replace persisted admission',()=>{
  const msg=accepted();const stored=structuredClone(msg._bookedOperation.document);stored.contractVersion=1;
  msg.payload=[stored];assert.equal(run('router',msg)[1].statusCode,409);
  const next=accepted();const old=structuredClone(next._bookedOperation.document);old.delegationBindingSha256=hash('different original tuple');
  next.payload=[old];assert.equal(run('router',next)[1].statusCode,409);
});
test('preflight graph has no path to Mongo or execution and all five routes are separate',()=>{
  const candidate=buildReceiverCandidate([{id:'synthetic-mongo',type:'mongodb4-client'}]).candidate;
  const map=new Map(candidate.map(n=>[n.id,n]));const seen=new Set();const visit=id=>{
    if(seen.has(id))return;seen.add(id);const node=map.get(id);assert.ok(node);
    assert.notEqual(node.type,'mongodb4');assert.notEqual(id,NODE_IDS.executor);
    for(const row of node.wires??[])for(const next of row)visit(next);
  };visit(NODE_IDS.preflightIn);
});

test('owner selection returns explicit legacy only from complete authoritative negative evidence',()=>{
  const legacy=preflightSelected({...globals,subscriptions_managed_enforcement_product_ids:[]}).result[1];
  assert.equal(legacy.statusCode,200);assert.deepEqual(legacy.payload,{contractVersion:2,nonBinding:true,
    operationId:f.identity.operationId,action:'JOIN_GAME',target:f.preflight.request.target,management:'LEGACY'});
  for(const configured of [undefined,null,'','not-json',{},[null]]) {
    const out=preflightSelected({...globals,subscriptions_managed_enforcement_product_ids:configured}).result;
    assert.equal(out[0],null);assert.notEqual(out[1].statusCode,200);
  }
  for(const change of [{availableClientSubscriptions:[]},{availableClientSubscriptions:[{clientSubscriptionId:r.providerClientSubscriptionId}]},
    {id:'foreign-exercise'},{timeFrom:'invalid'},
    {availableClientSubscriptions:[{clientSubscriptionId:r.providerClientSubscriptionId,productId:'8bf334ba-3050-4017-b40a-7eef2db1eb16'}]}]) {
    const out=preflightSelected(globals,change).result;assert.equal(out[0],null);assert.notEqual(out[1].statusCode,200);
  }
});

const ack = (count=1) => ({acknowledged:true,matchedCount:count,modifiedCount:count,upsertedCount:0,upsertedId:null});
const gateway = (name,msg,values) => new Function('msg','global',fs.readFileSync(`scripts/nodered_subscription_booking_nodes/fn_subscription_booking_${name}.js`,'utf8'))(msg,{get:key=>values[key]});
const recoveryGlobals = {...globals, subscriptions_owner_evidence_enabled:true,
  subscriptions_owner_evidence_secret:'synthetic-owner-evidence-key-'.repeat(2),crypto};
Object.assign(env,{LK1_BOOKED_OPERATION_OWNER_BASE_URL:'http://127.0.0.1:1880',LK1_BOOKED_OPERATION_OWNER_TENANT_KEY:'iSkq6G'});
function recoveryOuter(state='UNKNOWN') {
  const admitted=run('admission_verify',message('admit',{recovery_only:true}))[0];
  const stored={...structuredClone(admitted._bookedOperation.document),state};
  admitted.payload=[stored];
  const forwarded=run('router',admitted)[3];assert.ok(forwarded);
  let out=run('executor',forwarded);assert.equal(out[0].method,'GET');
  assert.equal(out[0].headers['X-Booked-Operation-Owner-Contract'],'2');
  out[0].statusCode=200;out[0].responseUrl=out[0].url;out[0].headers={'content-type':'application/json'};
  out[0].payload={contractVersion:2,owner:'LK1_SUBSCRIPTION_BOOKING_OWNER',policy:'MANAGED_JOIN_V2'};
  out=run('executor',out[0]);assert.equal(out[0].method,'GET');
  out[0].statusCode=200;out[0].payload={id:r.providerClientId,phone:'79990000001'};
  out=run('executor',out[0]);assert.ok(out[1]);
  assert.equal(out[1].payload[0].state,state);
  return {claim:out[1],stored};
}
function canonicalRecoveryRow() {
  const startsAt=new Date(Date.now()+3600000).toISOString();
  const serviceDate=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(startsAt));
  const target={eventId:r.providerExerciseId,stationId:'station-v2',category:'GAME',externalEventTypeId:'viva:direction:4588:type:1613',
    productTypeId:null,durationMinutes:60,startsAt,resolutionSource:'SERVER'};
  const binding=f.admission.request.entitlement;
  const runtime={subscriptionInstanceId:binding.subscriptionInstanceId,policyDigest:binding.expectations.policyDigest,
    policy:{policyVersion:binding.expectations.policyVersion},instance:{subscriptionInstanceId:binding.subscriptionInstanceId,policyVersion:binding.expectations.policyVersion},
    evidence:{instanceRevision:1}};
  const decision={decisionKind:'ENTITLEMENT',action:'JOIN_GAME',policyVersion:3,policyDigest:runtime.policyDigest,
    target:{targetId:r.providerExerciseId,stationId:target.stationId,eventTypeId:target.externalEventTypeId,productTypeId:null,durationMinutes:60,startsAt},
    usageUnits:1,money:{basePriceMinor:100,discountMinor:100,surchargeMinor:0,finalPriceMinor:0,currency:'RUB'}};
  return {_id:'canonical:managed-join',operationId:f.identity.operationId,tenantKey:'iSkq6G',actorClientId:r.providerClientId,
    exerciseId:r.providerExerciseId,clientSubscriptionId:r.providerClientSubscriptionId,serviceDate,planKey:'piter_friendship',
    state:'PENDING_CONFIRMATION',activationState:'NOT_REQUIRED',managedJoinV2:structuredClone(f.admission.request),managedDecision:decision,
    managedSubscriptionInstanceId:binding.subscriptionInstanceId,managedEntitlementOperationId:r.entitlement.usageRef.usageRef,managedEntitlementState:'RESERVED',
    managedJoinV2Recovery:{schemaVersion:1,runtime,target,enforcement:{enabled:true,environment:'PROD',exactProductId:'8bf334ba-3050-4017-b40a-7eef2db1eb16'},
      activationRequired:false,activationExpectedRevision:1,freePolicyDigest:runtime.policyDigest}};
}
function canonicalRecoveryStart(post,rows) {
  const prepared=gateway('prepare',{payload:post.payload,req:{headers:{authorization:post.headers.Authorization,'idempotency-key':post.headers['Idempotency-Key']}}},recoveryGlobals)[0];
  const found=gateway('router',{...prepared,statusCode:200,payload:{id:r.providerClientId,phone:'79990000001'}},recoveryGlobals)[1];
  assert.equal(found._subscriptionBooking.step,'managed_join_owner_recovery_find');
  return gateway('router',{...found,payload:rows},recoveryGlobals);
}
test('v2 signed recovery-only reaches original canonical pending operation and same CUP confirm without reserve or booking POST',()=>{
  const {claim,stored}=recoveryOuter();
  claim.payload=ack();const post=run('executor',claim)[0];
  assert.equal(post.payload.managedJoinV2RecoveryOnly,true);assert.deepEqual(post.payload.managedJoinV2,f.admission.request);
  const row=canonicalRecoveryRow();const read=canonicalRecoveryStart(post,[row])[0];
  assert.equal(read.method,'GET');assert.match(read.url,/\/bookings\?size=1000$/);
  const booking={id:r.bookingId,clientId:r.providerClientId,exerciseId:r.providerExerciseId,clientSubscriptionId:r.providerClientSubscriptionId,
    exerciseDate:row.serviceDate,status:'CONFIRMED',paymentType:'SUBSCRIPTION'};
  const local=gateway('router',{...read,statusCode:200,responseUrl:read.url,payload:{content:[booking]}},recoveryGlobals)[3];assert.ok(local);
  Object.assign(row,local.payload[1].$set);
  const cup=gateway('router',{...local,payload:ack()},recoveryGlobals)[0];
  assert.equal(cup.url,'https://padlhub.su/api/internal/subscriptions/entitlements/confirm');
  assert.equal(cup.payload.operationId,row.managedEntitlementOperationId);
  const link=gateway('router',{...cup,statusCode:200,responseUrl:cup.url,payload:{schemaVersion:1,outcome:'CONFIRMED',operationState:'CONFIRMED',
    operationId:row.managedEntitlementOperationId,subscriptionInstanceId:row.managedSubscriptionInstanceId,aggregateRevision:4}},recoveryGlobals)[3];
  Object.assign(row,link.payload[1].$set);
  const result=gateway('router',{...link,payload:ack()},recoveryGlobals)[4];assert.equal(result.payload.state,'CONFIRMED');
  post.statusCode=200;post.payload=result.payload;
  const final=run('executor',post)[2];assert.ok(final.payload[0]['recovery.attemptId']);
  const confirmedStored={...stored,...final.payload[1].$set};final.payload=ack();assert.equal(run('executor',final)[3].payload.status,'UNKNOWN');
  const readMsg=run('read_verify',message('read'))[0];readMsg.payload=[confirmedStored];
  const receiptRead=run('router',readMsg)[2];receiptRead.payload=[row];
  const receipt=run('router',receiptRead)[1];assert.equal(receipt.payload.status,'CONFIRMED');
  assert.deepEqual(receipt.payload.receipt.entitlement,r.entitlement);
});
test('recovery-only absent rows, changed tuples and concurrent lost claims never create or reserve',()=>{
  for(const bad of [false,0,'true',null])assert.equal(run('admission_verify',message('admit',{recovery_only:bad}))[0],null);
  assert.equal(run('preflight_verify',message('preflight',{recovery_only:true}))[0],null);
  const absent=run('admission_verify',message('admit',{recovery_only:true}))[0];absent.payload=[];
  const absentResult=run('router',absent);assert.equal(absentResult[0],null);assert.equal(absentResult[3],null);assert.equal(absentResult[1].statusCode,404);
  const a=recoveryOuter('ATTEMPTING');const b=recoveryOuter('ATTEMPTING');
  assert.notEqual(a.claim.payload[1].$set.recovery.attemptId,b.claim.payload[1].$set.recovery.attemptId);
  b.claim.payload=ack(0);const lost=run('executor',b.claim);assert.equal(lost[0],null);assert.ok(lost[4]);
  a.claim.payload=ack();const post=run('executor',a.claim)[0];
  const missing=canonicalRecoveryStart(post,[]);assert.equal(missing[0],null);assert.equal(missing[4].payload.state,'PENDING_CONFIRMATION');
  const foreign=canonicalRecoveryRow();foreign.managedJoinV2.entitlement.expectations.policyVersion=99;
  const denied=canonicalRecoveryStart(post,[foreign]);assert.equal(denied[0],null);assert.equal(denied[4].statusCode,409);
  const active=run('admission_verify',message('admit',{recovery_only:true}))[0];
  active.payload=[{...a.stored,recovery:{leaseUntil:new Date(Date.now()+120000).toISOString()}}];assert.equal(run('router',active)[3],null);
});

test('managed v2 capability refuses old/missing/redirected owner before profile or mutation',()=>{
  for(const recoveryOnly of [false,true])for(const scenario of ['old','missing','redirect','unavailable','foreignOrigin']) {
    const msg=run('admission_verify',message('admit',recoveryOnly?{recovery_only:true}:{}))[0];
    msg.payload=[{...msg._bookedOperation.document,state:recoveryOnly?'UNKNOWN':'PENDING'}];
    const execution=run('router',msg)[3];assert.ok(execution);
    const probe=run('executor',execution)[0];assert.equal(probe.method,'GET');
    assert.equal(probe.headers['X-Booked-Operation-Owner-Contract'],'2');
    probe.statusCode=scenario==='redirect'?302:scenario==='unavailable'?503:200;
    probe.responseUrl=scenario==='foreignOrigin'?'http://127.0.0.1:9999/lk/subscription-bookings':probe.url;
    probe.headers={'content-type':'application/json'};
    probe.payload=scenario==='old'?{contractVersion:1,owner:'LK1_SUBSCRIPTION_BOOKING_OWNER',policy:'ATOMIC_MANAGED_V1'}
      :scenario==='missing'?{}:{contractVersion:2,owner:'LK1_SUBSCRIPTION_BOOKING_OWNER',policy:'MANAGED_JOIN_V2'};
    const refused=run('executor',probe);assert.equal(refused[3].statusCode,503);
    assert.equal(refused.filter(Boolean).length,1);assert.equal(refused[0],null);
  }
});
