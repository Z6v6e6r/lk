import crypto from 'node:crypto';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { monthlyFriendshipApi as api } from '../../lib/monthlyFriendshipApi.mjs';
import { monthlyFriendshipApiSource } from '../../lib/monthlyFriendshipApiSource.mjs';
const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
export const uid = n => `10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
export const at = Date.parse('2026-11-02T12:00:00.000Z');
export const phone = '+7' + '9990000000';
export const inventory = 'ab_leto_20260910_epoch_friendship';
export const product = { id: 'fixture-monthly-product', name: 'Monthly', type: 'SUBSCRIPTION', cost: 980000, validityDays: 30 };
export const actorToken = 'fixture-actor-token-never-live';
export const environment = { LK_MONTHLY_FRIENDSHIP_API_ENABLED: 'true', LK_MONTHLY_FRIENDSHIP_API_ISSUER: 'https://fixture.invalid',
  LK_MONTHLY_FRIENDSHIP_API_AUDIENCE: 'monthly-owner', LK_MONTHLY_FRIENDSHIP_API_KEY_ID: 'fixture-monthly',
  LK_MONTHLY_FRIENDSHIP_API_PUBLIC_KEY_PEM: keys.publicKey.export({ type:'spki',format:'pem' }), LK_MONTHLY_FRIENDSHIP_API_TENANT_ID: uid(1) };
export const bodyFor = (mode, q) => mode === 'purchase' ? { contract: api.version, offerId: api.offerId, expectedRevision: q.revision, amountMinor: q.amountMinor, currency: 'RUB' }
  : { contract: api.version, offerId: api.offerId };
export function message(mode, body=bodyFor(mode), { claims={}, header={}, nowMs=at, token=actorToken }={}) {
  const now=Math.floor(nowMs/1000), c = { iss:environment.LK_MONTHLY_FRIENDSHIP_API_ISSUER,aud:environment.LK_MONTHLY_FRIENDSHIP_API_AUDIENCE,
    sub:uid(2),sid:uid(3),jti:uid(4),iat:now,nbf:now,exp:now+60,contract:api.version,caller:'lk2-api',
    scope:'subscription-runtime.monthly-friendship.'+mode,method:'POST',path:api.prefix+mode,tenant_id:uid(1),tenant_key:'iSkq6G',provider:'VIVA',
    provider_client_id:'fixture-client',provider_mapping_id:uid(5),idempotency_key_sha256:api.hash('fixture-original-key'),
    request_sha256:api.requestHash(mode,body),correlation_id:'fixture-correlation',actor_token_sha256:api.hash(token),
    actor_token_expires_at:new Date(nowMs+120000).toISOString(),...claims };
  c.operation_id = Object.hasOwn(claims,'operation_id') ? claims.operation_id : api.operationId(c);
  const h = { alg:'RS256',kid:environment.LK_MONTHLY_FRIENDSHIP_API_KEY_ID,typ:'phub-monthly-friendship-actor+jwt',...header };
  const data = [h,c].map(x=>Buffer.from(api.stable(x)).toString('base64url')).join('.');
  return { req:{method:'POST',originalUrl:api.prefix+mode,query:{},headers:{'content-type':'application/json',
    'x-correlation-id':c.correlation_id,'x-subscription-actor-token':token,
    'x-subscription-actor-delegation':data+'.'+crypto.sign('RSA-SHA256',Buffer.from(data),keys.privateKey).toString('base64url')}},payload:structuredClone(body) };
}
const clone = x => JSON.parse(JSON.stringify(x));
const path = (row,key) => key.split('.').reduce((v,k)=>v?.[k],row);
export function matches(row, query) {
  return Object.entries(query).every(([k,v])=>{
    if(k==='$or')return v.some(q=>matches(row,q));
    const current=path(row,k);
    if(v && typeof v==='object' && !Array.isArray(v)) {
      if(Object.hasOwn(v,'$exists'))return (current!==undefined)===v.$exists;
      if(Object.hasOwn(v,'$lte'))return current<=v.$lte;
    }
    return api.stable(current)===api.stable(v);
  });
}
export function harness({ rows=[], globals={} }={}) {
  let nowMs=at;
  class Clock extends Date { constructor(...args) { super(...(args.length?args:[nowMs])); } static now(){return nowMs;} }
  const runFunction=vm.runInNewContext('(function(msg,env,global,node,nodeCrypto){'+monthlyFriendshipApiSource()+'\n})',{Buffer,URL,Date:Clock,Intl});
  const settings={...environment},values={ monthly_friendship_custody_binding:{version:1,enabled:true,tenantId:uid(1),inventoryId:inventory},
    subscription_counter_epoch_started_at:'2026-09-10T07:00:00.000Z',summer_subscription_sales_20260909_enabled:true,
    summer_subscription_friendship_product_id:product.id,summer_subscription_friendship_product_name:product.name,
    vivacrm_access_token:'fixture-service-token-never-live',...globals };
  const store=clone(rows),requests=[],writes=[];
  const run=msg=>{ const result=runFunction(msg,{get:k=>settings[k]},{get:k=>values[k]},{warn:()=>undefined},crypto);
    assert.equal(result.filter(Boolean).length,1);const port=result.findIndex(Boolean);return {port,msg:result[port]}; };
  const io=edge=>{
    const {port,msg}=edge;
    if(port===0){msg.payload=clone(store.filter(row=>matches(row,msg.payload)));return msg;}
    if(port===1||port===2){
      const [query,update,options]=msg.payload;writes.push(clone({query,update,options}));let row=store.find(r=>matches(r,query));
      if(!row && options.upsert && store.some(r=>r._id===query._id)){msg.error={code:11000};msg.payload=null;return msg;}
      if(!row && options.upsert){row=clone(update.$setOnInsert||update.$set);store.push(row);msg.payload={acknowledged:true,matchedCount:0,modifiedCount:0,upsertedCount:1};return msg;}
      if(!row){msg.payload={acknowledged:true,matchedCount:0,modifiedCount:0};return msg;}
      const before=api.stable(row);Object.assign(row,clone(update.$set||{}));msg.payload={acknowledged:true,matchedCount:1,modifiedCount:before===api.stable(row)?0:1,upsertedCount:0};return msg;
    }
    throw Error('unexpected I/O');
  };
  const provider=msg=>{
    if(msg.url.endsWith('/profile'))return {id:'fixture-client',phone};
    if(msg.url.includes('/products/subscriptions?'))return {content:[product],number:0,totalPages:1,totalElements:1,numberOfElements:1,last:true};
    if(msg.url.includes('/clients?'))return {content:[{id:'fixture-client',phone}],number:0,totalPages:1,totalElements:1,numberOfElements:1,last:true};
    if(msg.method==='POST' && msg.url.endsWith('/transactions'))return {id:'fixture-transaction',toPay:product.cost,paymentUrl:'https://bank.example.test/pay',paymentDueDate:'2026-11-02T13:00:00.000Z'};
    throw Error('unexpected provider URL '+msg.url);
  };
  const advance=(msg,{stop,respond=provider,max=80}={})=>{
    for(let i=0;i<max;i++){
      const edge=run(msg);msg=edge.msg;
      if(stop?.(edge)||edge.port===3)return edge;
      if(edge.port===4){requests.push({method:msg.method,url:msg.url});const p=respond(msg);msg.payload=clone(p);msg.statusCode=200;msg.responseUrl=msg.url;}
      else io(edge);
    }
    throw Error('too many steps');
  };
  return {run,io,advance,store,requests,writes,provider,values,settings,setNow:n=>{nowMs=n;}};
}
