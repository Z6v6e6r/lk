import {createHash} from 'node:crypto';
import {createBookedOperationDelegationVerifier} from './bookedOperationRead.mjs';
import {composeBookedOperationAdmissionSource} from './bookedOperationAdmissionSource.mjs';

export const BOOKED_OPERATION_ADMISSION_PATH='/lk/integrations/v1/booked-operation-admissions';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const opaque=/^[A-Za-z0-9][A-Za-z0-9._:-]{2,199}$/;
const digest=/^sha256:[a-f0-9]{64}$/;
export function parseAdmissionRequest(value) {
  const target=value?.target;
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join()!=='action,paymentIntent,target'
    ||value.action!=='JOIN_GAME'||value.paymentIntent!=='USE_SUBSCRIPTION'||!target||typeof target!=='object'||Array.isArray(target)
    ||Object.keys(target).sort().join()!=='expectedRevision,id'||!uuid.test(target.id)
    ||!Number.isSafeInteger(target.expectedRevision)||target.expectedRevision<1) throw Error('Invalid admission request');
  return {action:'JOIN_GAME',target:{id:target.id,expectedRevision:target.expectedRevision},paymentIntent:'USE_SUBSCRIPTION'};
}
export function admissionRequestSha256(value) { return 'sha256:'+createHash('sha256').update('booked-operation-admission:v1\0'+JSON.stringify(parseAdmissionRequest(value))).digest('hex'); }
export function admissionOperationId(tenantId,userId,keyHash) {
  if(!uuid.test(tenantId)||!uuid.test(userId)||!digest.test(keyHash)) throw Error('Invalid admission identity');
  const c=createHash('sha256').update(`booked-operation-admission:v1\0lk2-api\0${tenantId}\0${userId}\0${keyHash}`).digest('hex').slice(0,32).split('');
  c[12]='8';c[16]=((parseInt(c[16],16)&3)|8).toString(16);const h=c.join('');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
export function createBookedOperationAdmissionVerifier(options) {
  const verify=createBookedOperationDelegationVerifier({...options,admission:true});
  return input=>{
    const c=verify(input);if(!c)return null;
    try {
      const r=parseAdmissionRequest(input.body);
      if(c.request_sha256!==admissionRequestSha256(r)||!digest.test(c.idempotency_key_sha256)
        ||c.operation_id!==admissionOperationId(c.tenant_id,c.sub,c.idempotency_key_sha256)
        ||c.target_id!==r.target.id||c.expected_revision!==r.target.expectedRevision
        ||!uuid.test(c.target_mapping_id)||!opaque.test(c.provider_exercise_id)
        ||typeof c.target_version!=='string'||!/^[A-Za-z0-9._:-]{1,128}$/.test(c.target_version)
        ||!Number.isSafeInteger(c.target_duration_minutes)||c.target_duration_minutes<1||c.target_duration_minutes>1440
        ||!Number.isInteger(c.target_capacity)||(c.target_capacity<1||c.target_capacity>1000)
        ||typeof c.target_admissible!=='boolean'
        ||typeof c.target_starts_at!=='string'||!Number.isFinite(Date.parse(c.target_starts_at))
        ||new Date(c.target_starts_at).toISOString()!==c.target_starts_at) return null;
      return c;
    } catch {return null;}
  };
}
function binding(c) {
  return {contractVersion:1,operationId:c.operation_id,tenantId:c.tenant_id,userId:c.sub,providerMappingId:c.provider_mapping_id,
    providerClientId:c.provider_client_id,issuer:c.iss,caller:c.caller,requestSha256:c.request_sha256,keySha256:c.idempotency_key_sha256,
    targetId:c.target_id,expectedRevision:c.expected_revision,targetMappingId:c.target_mapping_id,providerExerciseId:c.provider_exercise_id,targetVersion:c.target_version};
}
// One concrete owner path. Source is assembled from current owning gateway/router/evaluator
// files; transports return raw provider responses, never prebuilt policy or booking context.
export function createBookedOperationAdmissionOwner({collection,providerRead,resolveProviderAuthorization,globalContext,onMetric}) {
  const source=composeBookedOperationAdmissionSource();
  const gateway=new Function('msg','node','env','global',source.gateway);
  const evaluator=new Function('msg',source.evaluator);
  return async (claims,{signal}={})=>{
    const b=binding(claims);
    const ctx={caller:'split',action:'book',managedAction:'JOIN_GAME',step:'admission_start',tenantKey:claims.tenant_key,operationId:claims.operation_id,
      operationKey:`lk1-product-v2:${JSON.stringify([b.tenantId,b.userId,b.operationId])}`,exerciseId:b.providerExerciseId,padlHubAdmission:b,
      padlHubAdmissionTarget:{startsAt:claims.target_starts_at,durationMinutes:claims.target_duration_minutes,capacity:claims.target_capacity,admissible:claims.target_admissible},
      padlHubAdmissionAudit:{correlationId:claims.correlation_id,admittedAt:new Date().toISOString(),sourceSha256:source.sha256}};
    const msg={_subscriptionBooking:ctx};
    let bearer;
    for(let step=0;step<32;step++) {
      if(signal?.aborted)throw Error('Admission deadline');
      try {onMetric?.({phase:ctx.step});} catch { /* metrics cannot alter authority */ }
      const outputs=gateway(msg,{warn(){},error(){}},{get(){}},globalContext);
      const active=outputs?.flatMap((v,i)=>v?[i]:[])||[];
      if(active.length!==1)throw Error('Admission source output unavailable');
      const index=active[0];
      if(index===4) return {status:Number(msg.statusCode),body:msg.payload,sourceSha256:source.sha256};
      if(index===5)continue; // internal source phase, never a debug/log sink
      if(index===6) {
        const result=evaluator(msg);
        if(!result?.[0]||msg._managedSubscriptionPolicyDecision?.eligible!==true) return {status:409,body:{code:'BOOKED_OPERATION_ADMISSION_CONFLICT'}};
        continue;
      }
      if(index===0) {
        const url=new URL(msg.url);
        if(msg.method!=='GET'||url.origin!=='https://api.vivacrm.ru'||url.username||url.password)throw Error('Admission provider write forbidden');
        bearer??=await resolveProviderAuthorization(claims,{signal});
        if(typeof bearer!=='string'||!/^Bearer [!-~]{1,4096}$/.test(bearer))throw Error('Provider authority unavailable');
        ctx.authHeader=bearer;
        const result=await providerRead(url.pathname+url.search,{authorization:bearer,signal});
        msg.payload=result.body;msg.statusCode=result.status;delete msg.error;continue;
      }
      if(index===1) {
        if(!['admission_lookup','lk1_operation_find','lk1_usage_operations'].includes(ctx.step))throw Error('Admission Mongo read scope');
        const rows=await collection.find(msg.payload,{limit:1001,maxTimeMS:1000,timeoutMS:1500,signal,readConcern:{level:'majority'}}).toArray();
        if(rows.length>1000)throw Error('Admission owner read bound');
        msg.payload=rows;delete msg.error;continue;
      }
      if(index===2) {
        const [record,options]=msg.payload;
        if(ctx.step!=='operation_insert'||record.admissionOnly!==true||record._id!==ctx.operationKey
          ||record.state!=='PREPARED'||record.operationId!==ctx.operationId||JSON.stringify(record.padlHubAdmission)!==JSON.stringify(b)
          ||!record.lk1?.fingerprint||record.lk1?.decision?.eligible!==true||options?.writeConcern?.w!=='majority'||options?.writeConcern?.j!==true)throw Error('Admission owner insert scope');
        try { msg.payload=await collection.insertOne(record,{...options,timeoutMS:1500,signal});delete msg.error; }
        catch {msg.payload=null;msg.error=true;} // ambiguous ACK recovered by source exact majority read
        continue;
      }
      throw Error('Admission business continuation forbidden'); // no CAS, booking, payment or entitlement output
    }
    throw Error('Admission source step bound');
  };
}
export function createBookedOperationAdmissionHandler({verifyDelegation,admit,timeoutMs=3500}={}) {
  if(!Number.isInteger(timeoutMs)||timeoutMs<100||timeoutMs>4000)throw Error('Admission deadline configuration');
  return async(request,response)=>{
    response.setHeader('Cache-Control','no-store');response.setHeader('Content-Type','application/json');
    const send=(status,body)=>{if(!response.destroyed&&!response.writableEnded){response.writeHead(status);response.end(JSON.stringify(body));}};
    if(request.method!=='POST')return send(405,{code:'BOOKED_OPERATION_ADMISSION_METHOD_INVALID'});
    if(request.url!==BOOKED_OPERATION_ADMISSION_PATH)return send(404,{code:'BOOKED_OPERATION_ADMISSION_NOT_FOUND'});
    if(!verifyDelegation||!admit)return send(503,{code:'BOOKED_OPERATION_ADMISSION_DISABLED'});
    const controller=new AbortController();let timer;
    const close=()=>controller.abort();response.once('close',close);
    const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('Admission deadline'));},timeoutMs);});
    const run=async()=>{
      let body;
      try {
        let raw='';for await(const chunk of request){if(controller.signal.aborted)throw Error('Request cancelled');raw+=chunk;if(Buffer.byteLength(raw)>2048)throw Error('Request bound');}
        body=parseAdmissionRequest(JSON.parse(raw));
      }catch{if(controller.signal.aborted)throw Error('Request cancelled');return {status:400,body:{code:'BOOKED_OPERATION_ADMISSION_REQUEST_INVALID'}};}
      const token=request.headers['x-subscription-actor-delegation'];
      let operationId;
      // Decode only the expected identifier; the verifier supplies all authority.
      try {operationId=typeof token==='string'?JSON.parse(Buffer.from(token.split('.')[1]||'','base64url').toString()).operation_id:null;}catch{return {status:401,body:{code:'BOOKED_OPERATION_DELEGATION_REJECTED'}};}
      const claims=verifyDelegation({token,operationId,path:request.url,correlationId:request.headers['x-correlation-id'],body});
      if(!claims)return {status:401,body:{code:'BOOKED_OPERATION_DELEGATION_REJECTED'}};
      if(controller.signal.aborted)throw Error('Request cancelled');
      const result=await admit(claims,{signal:controller.signal});
      if(controller.signal.aborted)throw Error('Request cancelled');
      if(result.status===202 && result.body?.status==='PENDING'&&result.body.operationId===claims.operation_id)return result;
      return {status:result.status===409?409:503,body:{code:result.status===409?'BOOKED_OPERATION_ADMISSION_CONFLICT':'BOOKED_OPERATION_ADMISSION_UNAVAILABLE'}};
    };
    try {const result=await Promise.race([run(),deadline]);return send(result.status,result.body);}
    catch{return send(503,{code:'BOOKED_OPERATION_ADMISSION_UNAVAILABLE'});}
    finally{controller.abort();clearTimeout(timer);response.removeListener('close',close);}
  };
}
