import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash,generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {Readable} from 'node:stream';
import {EventEmitter} from 'node:events';
import test from 'node:test';
import {admissionOperationId,admissionRequestSha256,createBookedOperationAdmissionHandler,createBookedOperationAdmissionOwner,createBookedOperationAdmissionVerifier,BOOKED_OPERATION_ADMISSION_PATH,parseAdmissionRequest} from '../lib/bookedOperationAdmission.mjs';
import {composeBookedOperationAdmissionSource} from '../lib/bookedOperationAdmissionSource.mjs';
import {projectBookedOperation} from '../lib/bookedOperationRead.mjs';
import {PLAN_RULES_LIMIT_8,HUB_POLICY_LIMIT_8} from '../lib/lk1ActiveBookingLimit.mjs';

const keys=generateKeyPairSync('rsa',{modulusLength:2048});
function fixture() {
  const body={action:'JOIN_GAME',target:{id:randomUUID(),expectedRevision:1},paymentIntent:'USE_SUBSCRIPTION'};
  const now=Math.floor(Date.now()/1000),tenantId=randomUUID(),userId=randomUUID();
  const keyHash='sha256:'+createHash('sha256').update(randomUUID()).digest('hex');
  const startsAt=new Date(Date.now()+86400000*10).toISOString().slice(0,10)+'T09:00:00.000Z';
  const claims={contract_version:1,scope:'subscription-runtime.booked-operation.admit',caller:'lk2-api',method:'POST',path:BOOKED_OPERATION_ADMISSION_PATH,
    operation_id:admissionOperationId(tenantId,userId,keyHash),iss:'https://lk2.example.test',aud:'admission-owner',sub:userId,tenant_id:tenantId,tenant_key:'b1-synthetic',sid:randomUUID(),provider:'VIVA',provider_client_id:randomUUID(),provider_mapping_id:randomUUID(),
    correlation_id:'b1-synthetic-correlation',iat:now,nbf:now,exp:now+30,jti:randomUUID(),request_sha256:admissionRequestSha256(body),idempotency_key_sha256:keyHash,target_id:body.target.id,expected_revision:1,target_mapping_id:randomUUID(),provider_exercise_id:randomUUID(),target_version:'fixture-v1',target_starts_at:startsAt,target_duration_minutes:60,target_capacity:4,target_admissible:true};
  const token=(patch={},headerPatch={})=>{const enc=v=>Buffer.from(JSON.stringify(v)).toString('base64url');const raw=enc({alg:'RS256',typ:'phub-subscription-runtime-actor-delegation+jwt',kid:'b1-key',...headerPatch})+'.'+enc({...claims,...patch});return raw+'.'+sign('RSA-SHA256',Buffer.from(raw),keys.privateKey).toString('base64url');};
  const verify=createBookedOperationAdmissionVerifier({keys:{'b1-key':keys.publicKey.export({type:'spki',format:'pem'})},issuer:claims.iss,audience:claims.aud,tenantBindings:{[claims.tenant_key]:tenantId}});
  const owned={id:randomUUID(),clientId:claims.provider_client_id,productId:'db7a5250-7369-4f43-8ac5-9111be24bc74',status:'ACTIVE',name:'Synthetic HUB',purchaseDate:'2026-09-05',activationDate:'2026-09-05',expirationDate:'2099-12-31',visitsLeft:10,variant:'BY_VISITS'};
  owned.clientSubscriptionId=owned.subscriptionId=owned.id;
  const exercise={id:claims.provider_exercise_id,typeId:1613,directionId:4588,studioId:'0d5504f6-ea6f-44bb-a9e4-947faf0273ab',roomId:randomUUID(),timeFrom:startsAt.replace('09:00:00.000Z','12:00:00+03:00'),timeTo:startsAt.replace('09:00:00.000Z','13:00:00+03:00'),durationMinutes:60,maxClientsCount:4,availableClientSubscriptions:[owned]};
  const rows=new Map();let providerCalls=0,inserts=0;let failAck=false,omitInsert=false;
  const owner=createBookedOperationAdmissionOwner({
    collection:{find(query,options){assert.equal(options.readConcern.level,'majority');return {toArray:async()=>query._id&&rows.has(query._id)?[rows.get(query._id)]:[]};},async insertOne(row,options){assert.equal(options.writeConcern.w,'majority');assert.equal(options.writeConcern.j,true);inserts++;if(!omitInsert)rows.set(row._id,structuredClone(row));if(failAck||omitInsert)throw Error('Synthetic lost ACK');return {acknowledged:true,insertedId:row._id};}},
    globalContext:{get:key=>key==='subscriptions_lk1_plan_rules'?PLAN_RULES_LIMIT_8:key==='subscriptions_lk1_product_policy'?HUB_POLICY_LIMIT_8:undefined},resolveProviderAuthorization:async()=> 'Bearer synthetic-provider',
    async providerRead(path){providerCalls++;let response;
      if(path.endsWith('/profile'))response={id:claims.provider_client_id,phone:'0000000000'};
      else if(path.endsWith('/exercises/'+claims.provider_exercise_id))response=exercise;
      else if(path.includes('/subscriptions?'))response={content:[owned],totalElements:1,number:0,totalPages:1,last:true};
      else if(path.includes('/bookings'))response={content:[],totalElements:0,number:0,totalPages:0,last:true};
      else if(path.includes('/price?'))response={total:12000};
      else throw Error('Unexpected source request');return {status:200,body:structuredClone(response)};
    },
  });
  return {body,claims,token,verify,owner,rows,owned,exercise,counts:()=>({providerCalls,inserts}),loseAck:()=>{failAck=true;},omitInsert:()=>{omitInsert=true;}};
}
const verified=f=>f.verify({token:f.token(),operationId:f.claims.operation_id,path:BOOKED_OPERATION_ADMISSION_PATH,correlationId:f.claims.correlation_id,body:f.body});
async function invoke(f,patch={}) {
  const request=Readable.from([JSON.stringify(patch.body??f.body)]);request.method=patch.method??'POST';request.url=patch.url??BOOKED_OPERATION_ADMISSION_PATH;request.headers={'x-subscription-actor-delegation':patch.token??f.token(),'x-correlation-id':f.claims.correlation_id};
  const response=new EventEmitter();let status,body;response.setHeader=()=>{};response.writeHead=value=>{status=value;};response.end=value=>{body=JSON.parse(value);};
  await createBookedOperationAdmissionHandler({verifyDelegation:f.verify,admit:f.owner,...patch.options})(request,response);return {status,body};
}
test('strict command and signed actor/request/target authority, with no public context injection',()=>{
  const f=fixture();assert.ok(verified(f));
  for(const patch of [{scope:'subscription-runtime.booked-operation.read'},{caller:'foreign-service'},{method:'GET'},{path:'/other'},{correlation_id:'other-correlation'},{request_sha256:'sha256:'+'0'.repeat(64)},{target_id:randomUUID()},{expected_revision:2},{operation_id:randomUUID()},{tenant_id:randomUUID()},{target_admissible:'true'},{sid:null}])assert.equal(f.verify({token:f.token(patch),operationId:f.claims.operation_id,path:BOOKED_OPERATION_ADMISSION_PATH,correlationId:f.claims.correlation_id,body:f.body}),null);
  for(const patch of [{actorClientId:'guessed'},{operationId:randomUUID()},{target:{...f.body.target,providerId:'guessed'}},{paymentIntent:'PAY'},{action:'CREATE_GAME'}])assert.throws(()=>parseAdmissionRequest({...f.body,...patch}));
});
test('actual owning source inserts before business continuation; replay ignores session and mutable admission conditions',async()=>{
  const f=fixture();f.loseAck();const result=await f.owner(verified(f));assert.equal(result.status,202);assert.equal(f.rows.size,1);
  const row=[...f.rows.values()][0];assert.equal(row.lk1.target.basePriceMinor,300000);assert.equal(row.attempts,0);assert.equal(row.state,'PREPARED');assert.equal(row.padlHubAdmission.sessionId,undefined);assert.equal(row.padlHubAdmissionAudit.correlationId,f.claims.correlation_id);assert.match(row.padlHubAdmissionAudit.sourceSha256,/^[a-f0-9]{64}$/);
  assert.deepEqual(projectBookedOperation(row,f.claims),result.body);
  const counts=f.counts();assert.deepEqual(await f.owner({...verified(f),sid:randomUUID(),correlation_id:'rotated-correlation',target_admissible:false,target_starts_at:'2020-01-01T00:00:00.000Z',target_capacity:2}),result);assert.deepEqual(f.counts(),counts);
  assert.equal((await f.owner({...verified(f),provider_mapping_id:randomUUID()})).status,409);
});
test('missing committed ACK never succeeds, and initial target rejection reaches no provider or insert',async()=>{
  const f=fixture();f.omitInsert();assert.equal((await f.owner(verified(f))).status,503);assert.equal(f.rows.size,0);
  const rejected=fixture();assert.equal((await rejected.owner({...verified(rejected),target_admissible:false})).status,409);assert.deepEqual(rejected.counts(),{providerCalls:0,inserts:0});
});
test('all accepted subscription aliases and nested owners must agree in both raw provider pages',async()=>{
  for(const patch of [{clientSubId:randomUUID()},{uuid:randomUUID()},{clientSubscription:{id:randomUUID()}},{clientSub:{id:randomUUID()}},{clientSubscription:{clientId:randomUUID()}}]) {
    const f=fixture();Object.assign(f.owned,patch);const result=await f.owner(verified(f));assert.equal(result.status,409,JSON.stringify(patch));assert.equal(f.rows.size,0);
  }
  const f=fixture();f.exercise.availableClientSubscriptions.push(structuredClone(f.owned));assert.equal((await f.owner(verified(f))).status,409);
});
test('corrupt receipts cannot be admitted as readable pending results',async()=>{
  const f=fixture();assert.equal((await f.owner(verified(f))).status,202);const key=[...f.rows.keys()][0],original=structuredClone(f.rows.get(key));
  for(const patch of [{padlHubOperation:{...original.padlHubOperation,userId:randomUUID()}},{updatedAt:null},{createdAt:'2099-01-01T00:00:00.000Z'},{category:'tournament'},{clientSubscriptionId:'invalid id'},{lk1:{...original.lk1,fingerprint:'bad'}},{lk1:{...original.lk1,transactionAttemptedAt:new Date().toISOString()}},{padlHubAdmissionTarget:{...original.padlHubAdmissionTarget,capacity:3}}]) {
    f.rows.set(key,{...structuredClone(original),...patch});assert.equal((await f.owner(verified(f))).status,409);
  }
});
test('owner rejects legacy/public ingress and malformed input before any write',async()=>{
  const f=fixture();for(const patch of [{body:{...f.body,actorClientId:'injected'}},{token:'service-token'},{method:'GET'},{url:BOOKED_OPERATION_ADMISSION_PATH+'?actor=guessed'}])assert.equal((await invoke(f,patch)).status,patch.method?405:patch.url?404:patch.body?400:401);
  assert.deepEqual(f.counts(),{providerCalls:0,inserts:0});
});
test('hard deadline aborts a dependency even when it ignores cancellation',async()=>{
  const f=fixture();let signal;const start=Date.now();const result=await invoke(f,{options:{timeoutMs:100,admit:(_claims,options)=>{signal=options.signal;return new Promise(()=>{});}}});assert.equal(result.status,503);assert.equal(signal.aborted,true);assert.ok(Date.now()-start<1000);
});
test('one-byte router dependency drift fails before executable owner creation',()=>{
  assert.match(composeBookedOperationAdmissionSource().sha256,/^[a-f0-9]{64}$/);
  assert.throws(()=>composeBookedOperationAdmissionSource(url=>fs.readFileSync(url,'utf8')+'\n'),/executable source drift/);
});
