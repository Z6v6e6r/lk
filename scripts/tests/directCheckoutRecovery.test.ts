import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import ts from 'typescript';
import { parseZeroAttempt } from '../../src/components/subscription-storefront/zeroCheckoutCustody.ts';
const product='6b98e7e3-5bd3-4e94-9dc3-7723ea52513e',transaction='00000000-0000-4000-8000-000000000001',ref='zero-00000000-0000-4000-8000-000000000002';
const phone='+'+'7'+'9000000000',zeroKey='padlhub_zero_checkout_attempt_v1:friendship-two-hours';
function load(file: string, stubs: Record<string, unknown>, globals: Record<string, unknown> = {}) {
  const source=fs.readFileSync(new URL('../../src/'+file,import.meta.url),'utf8').replace(/^import[\s\S]*?from\s+['"][^'"]+['"];\n/gm,'');
  const exports={};vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,...stubs,URL,TextEncoder,Uint8Array,crypto:webcrypto,AbortController,setTimeout,clearTimeout,...globals});
  return exports as Record<string, (...args: any[]) => any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}
const closure=()=>({ok:true,directCheckoutClosure:{version:1,productId:product,transactionId:transaction,state:'PROVIDER_CARD_EXPIRED_UNPAID',operationId:'00000000-0000-4000-8000-000000000003',closed:true,paid:false,verifiedAt:new Date().toISOString()}});
test('fresh server closure must bind exact product/transaction, unpaid state and current observation',async()=>{
 const api=load('components/subscription-storefront/directCheckoutRecovery.ts',{});
 assert.equal(api.isFreshDirectClosure(closure(),product,transaction),true);
 for(const update of [{productId:'foreign'},{transactionId:'foreign'},{paid:true},{closed:false},{version:2},{operationId:'invalid'},{verifiedAt:'2000-01-01T00:00:00Z'},{verifiedAt:'2999-01-01T00:00:00Z'}]){
  const body=closure();Object.assign(body.directCheckoutClosure,update);assert.equal(api.isFreshDirectClosure(body,product,transaction),false);
 }
 assert.equal(api.isFreshDirectClosure(closure(),'foreign',transaction),false);
});
test('closure reads use the exact captured token, no cache/retry; actor drift cannot release',async()=>{
 let token='captured-actor',calls=0,drift=false;
 const api=load('components/subscription-storefront/directCheckoutRecovery.ts',{checkoutSessionToken:()=>token,getServ2Origin:()=> 'https://fixture.invalid',request:async(path: string,options: any)=>{ // eslint-disable-line @typescript-eslint/no-explicit-any
  calls++;assert.equal(path,'/lk/tournaments/summer-subscription/confirm');assert.equal(options.auth,false);assert.equal(options.headers.Authorization,'Bearer captured-actor');assert.equal(options.dedupe,false);assert.equal(options.retries,0);assert.equal(options.cacheTtlMs,0);assert.ok(options.signal);assert.deepEqual(JSON.parse(options.body),{directCheckoutRecoveryVersion:1,transactionId:transaction});if(drift)token='other-actor';return {status:200,error:null,data:closure()};
 }});
 assert.equal(await api.readClosedDirectCheckout(product,transaction,()=>true),true);
 drift=true;assert.equal(await api.readClosedDirectCheckout(product,transaction,()=>true),false);
 assert.equal(await api.readClosedDirectCheckout('foreign',transaction,()=>true),false);assert.equal(calls,2);
});
async function guardFixture() {
 const storage=new Map<string,string>(),active=new Set<string>(),calls={proof:0,create:0};let actor='actor',viva='actor',closed=true;
 let lockMutation=()=>{};
 let mutate=()=>{};
 const window={localStorage:{getItem:(k:string)=>storage.get(k)??null,setItem:(k:string,v:string)=>storage.set(k,v),removeItem:(k:string)=>storage.delete(k)}};
 const navigator={locks:{request:async(k:string,_options:unknown,fn:(lock:object|null)=>unknown)=>{if(active.has(k))return fn(null);active.add(k);try{if(k===zeroKey)lockMutation();return await fn({});}finally{active.delete(k);}}}};
 const api=load('components/subscription-storefront/promoCodeAttempt.ts',{checkoutSessionToken:()=>viva,DIRECT_RECOVERY_PRODUCT:product,parseZeroAttempt,legacyZeroOffersForProduct:()=>['friendship-two-hours'],readAuthToken:()=>actor,readSubscriptionPromoTransactionPaid:async()=>false,apiConfirmTournamentSubscriptionPurchase:async()=>({}),readClosedDirectCheckout:async(p:string,id:string,current:()=>boolean)=>{calls.proof++;assert.equal(p,product);assert.equal(id,transaction);assert.ok(active.has(key));mutate();return closed&&current();}},{window,navigator});
 const key=await api.subscriptionPromoAttemptKey(product,phone);
 const shared={kind:'ordinary',transactionId:transaction,paymentRef:ref};
 const zero={key:'friendship-two-hours',paymentRef:ref,transactionId:transaction,state:'pending'};
 storage.set(key,JSON.stringify(shared));storage.set(zeroKey,JSON.stringify(zero));
 return {storage,active,calls,key,shared,zero,api,setClosed:(x:boolean)=>{closed=x;},setMutation:(fn:()=>void)=>{mutate=fn;},changeActor:()=>{actor='other';},changeViva:()=>{viva='other-viva';},setLockMutation:(fn:()=>void)=>{lockMutation=fn;},buy:()=>api.withSubscriptionPromoLock(product,phone,()=>{calls.create++;assert.equal(storage.get(key),undefined);assert.equal(storage.get(zeroKey),undefined);return 'created';},true)};
}
test('shared-only and exactly represented old attempts clear only under product/offer locks before one new create',async()=>{
 for(const sharedOnly of [true,false]){const f=await guardFixture();if(sharedOnly)f.storage.delete(zeroKey);assert.equal(await f.buy(),'created');assert.equal(f.calls.create,1);assert.equal(f.calls.proof,1);}
 const f=await guardFixture();assert.equal(await f.api.hasSubscriptionPromoAttempt(product,phone),true);assert.equal(f.calls.proof,0);assert.ok(f.storage.has(f.key));
});
test('unknown, mismatched, locally paid and locked attempts never release or create',async()=>{
 for(const mutation of [
  (f: Awaited<ReturnType<typeof guardFixture>>)=>f.storage.set(f.key,JSON.stringify({...f.shared,transactionId:undefined})),
  (f: Awaited<ReturnType<typeof guardFixture>>)=>f.storage.set(zeroKey,JSON.stringify({...f.zero,state:'paid'})),
  (f: Awaited<ReturnType<typeof guardFixture>>)=>f.storage.set(zeroKey,JSON.stringify({...f.zero,transactionId:'00000000-0000-4000-8000-000000000099'})),
  (f: Awaited<ReturnType<typeof guardFixture>>)=>f.storage.set(f.key,'malformed'),
  (f: Awaited<ReturnType<typeof guardFixture>>)=>f.active.add(zeroKey),
  (f: Awaited<ReturnType<typeof guardFixture>>)=>f.setClosed(false),
 ]){const f=await guardFixture();mutation(f);await assert.rejects(f.buy());assert.equal(f.calls.create,0);assert.ok(f.storage.has(f.key));assert.ok(f.storage.has(zeroKey));}
});
test('actor or raw-marker changes during proof cannot clear new state',async()=>{
 for(const mutate of [
  (f: Awaited<ReturnType<typeof guardFixture>>)=>f.changeActor(),
  (f: Awaited<ReturnType<typeof guardFixture>>)=>f.storage.set(f.key,JSON.stringify({...f.shared,transactionId:'replacement'})),
  (f: Awaited<ReturnType<typeof guardFixture>>)=>f.storage.set(zeroKey,JSON.stringify({...f.zero,state:'paid'})),
 ]){const f=await guardFixture();f.setMutation(()=>mutate(f));await assert.rejects(f.buy());assert.equal(f.calls.create,0);assert.ok(f.storage.has(f.key));assert.ok(f.storage.has(zeroKey));}
});

test('Viva-only actor drift during awaited offer lock retains shared and Zero guards', async () => {
 const f = await guardFixture(); f.setLockMutation(() => f.changeViva());
 await assert.rejects(f.buy()); assert.equal(f.calls.proof, 1); assert.equal(f.calls.create, 0);
 assert.ok(f.storage.has(f.key)); assert.ok(f.storage.has(zeroKey));
});
