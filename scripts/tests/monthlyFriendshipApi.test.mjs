import test from 'node:test';
import assert from 'node:assert/strict';
import { monthlyFriendshipApi as api } from '../lib/monthlyFriendshipApi.mjs';
import { message,bodyFor,environment,at,uid,phone,product,harness } from './helpers/monthlyFriendshipApiHarness.mjs';
const get=k=>environment[k];
test('dedicated actor delegation binds exact monthly modes and operation namespace',()=>{
  for(const mode of api.modes){const body=bodyFor(mode,{revision:api.hash('quote'),amountMinor:980000});const v=api.verify(message(mode,body),get,at);assert.equal(v.ok,true);assert.equal(v.mode,mode);}
});
test('foreign purpose/actor/tenant/time/request claims never authorize',()=>{
  const now=Math.floor(at/1000);
  for(const claims of [{iss:'foreign'},{aud:'foreign'},{scope:'subscription-runtime.game-create.prepare'},{tenant_id:uid(8)},
    {tenant_key:'foreign'},{provider:'OTHER'},{sub:'provider-client'},{sid:'invalid'},{provider_mapping_id:'foreign'},
    {caller:'lk1'},{contract:'other'},{operation_id:uid(6)},{request_sha256:api.hash('wrong')},{actor_token_sha256:api.hash('wrong')},
    {actor_token_expires_at:new Date(at).toISOString()},{exp:now},{exp:now+61},{iat:now+1,nbf:now+1},{nbf:now-1},{extra:true}]) {
    assert.equal(api.verify(message('quote',bodyFor('quote'),{claims}),get,at).ok,false,JSON.stringify(claims));
  }
  for(const header of [{typ:'JWT'},{alg:'HS256'},{kid:'other'},{jku:'https://fixture.invalid'}])assert.equal(api.verify(message('quote',bodyFor('quote'),{header}),get,at).ok,false);
});
test('closed body, HTTP and token binding reject client selection/promo/replay',()=>{
  for(const mutate of [m=>m.payload.promoCode='FICTION',m=>m.payload.clientPhone=phone,m=>m.payload.offerId=uid(22),
    m=>m.req.query={mode:'purchase'},m=>m.req.originalUrl+='?x=1',m=>m.req.method='GET',m=>m.req.headers['x-correlation-id']='other',
    m=>m.req.headers['x-subscription-actor-token']='fixture-other-token',m=>m.req.headers['x-subscription-actor-delegation']+='x']) {
    const m=message('quote');mutate(m);assert.equal(api.verify(m,get,at).ok,false);
  }
  for(const k of Object.keys(environment)){const e={...environment};delete e[k];assert.equal(api.verify(message('quote'),key=>e[key],at).ok,false);}
});
test('actor profile and complete product snapshot reject aliases, partial pages and rounded prices',()=>{
  assert.equal(api.profilePhone({id:'fixture-client',phone},'fixture-client'),phone);
  for(const p of [{id:'other',phone},{id:'fixture-client',clientId:'other',phone},{id:'fixture-client',phone,mobile:'+1'+'5550000000'},{id:'fixture-client',phone,disabled:true}])assert.equal(api.profilePhone(p,'fixture-client'),null);
  const page={content:[product],number:0,totalPages:1,totalElements:1,numberOfElements:1,last:true};assert.ok(api.products(page,product.id));
  for(const patch of [{totalPages:2},{totalElements:2},{last:false},{number:1},{content:[product,product]},{content:[{...product,cost:980000.1}]},{content:[{...product,type:'OTHER'}]}])assert.equal(api.products({...page,...patch},product.id),null);
});
test('quote uses real monthly preparation/capacity/product source with zero writes and zero provider POST',()=>{
  const h=harness(),r=h.advance(message('quote'));assert.equal(r.msg.statusCode,200,JSON.stringify(r.msg.payload));
  assert.equal(r.msg.payload.amountMinor,980000);assert.equal(r.msg.payload.offerId,api.offerId);assert.ok(api.digest(r.msg.payload.revision));
  assert.equal(h.writes.length,0);assert.equal(h.requests.length,2);assert.ok(h.requests.every(r=>r.method==='GET'));
  assert.equal(r.msg._monthlyFriendshipApi,undefined);assert.equal(r.msg._summerSubscriptionCtx,undefined);
  assert.equal(r.msg.req.headers['x-subscription-actor-token'],undefined);
});
test('price consent drift rejects before binding/reservation/provider POST',()=>{
  const h=harness(),q=h.advance(message('quote')).msg.payload;
  const r=h.advance(message('purchase',{...bodyFor('purchase',q),amountMinor:q.amountMinor+1}));
  assert.equal(r.msg.statusCode,409,JSON.stringify(r.msg.payload));assert.equal(r.msg.payload.code,'MONTHLY_API_PRICE_CHANGED');assert.equal(h.writes.length,0);
});
test('purchase creates exactly one provider transaction and pure read does not write/repost',()=>{
  const h=harness(),q=h.advance(message('quote')).msg.payload,b=bodyFor('purchase',q),r=h.advance(message('purchase',b));
  assert.equal(r.msg.statusCode,200,JSON.stringify(r.msg.payload));assert.equal(r.msg.payload.state,'PAYMENT_PENDING');
  const writes=h.writes.length,requests=h.requests.length;
  const read=h.advance(message('read'));assert.equal(read.msg.statusCode,200,JSON.stringify(read.msg.payload));assert.equal(read.msg.payload.providerTransactionId,'fixture-transaction');
  assert.equal(h.writes.length,writes);assert.equal(h.requests.length,requests+1);assert.equal(h.requests.filter(r=>r.method==='POST').length,1);
});
test('replay reads original binding before changed catalogue/quota and never creates again',()=>{
  const h=harness(),q=h.advance(message('quote')).msg.payload,b=bodyFor('purchase',q);h.advance(message('purchase',b));
  h.values.summer_subscription_friendship_admission_closed=true;h.values.summer_subscription_friendship_product_id='new-product';
  const r=h.advance(message('read'));assert.equal(r.msg.payload.state,'PAYMENT_PENDING');
  const changed=h.advance(message('purchase',{...b,amountMinor:b.amountMinor+1}));assert.equal(changed.msg.statusCode,409);
  assert.equal(h.requests.filter(r=>r.method==='POST').length,1);
});
test('lost actor binding insert acknowledgement cannot dispatch, even on retry',()=>{
  const h=harness(),q=h.advance(message('quote')).msg.payload,b=bodyFor('purchase',q);
  const edge=h.advance(message('purchase',b),{stop:e=>e.port===2 && e.msg._monthlyFriendshipApi.phase==='insert'});
  h.io(edge);edge.msg.error={code:'ACK_LOST'};edge.msg.payload=null;
  const r=h.advance(edge.msg);assert.equal(r.msg.statusCode,503);
  const retry=h.advance(message('purchase',b));assert.equal(retry.msg.statusCode,503);
  assert.equal(h.requests.filter(r=>r.method==='POST').length,0);
  assert.equal(h.store.filter(r=>r.documentType==='MONTHLY_FRIENDSHIP_ACTOR_BINDING_V1').length,1);
});
test('parallel same-key admission has one insert winner and one provider POST',()=>{
  const h=harness(),q=h.advance(message('quote')).msg.payload,b=bodyFor('purchase',q);
  const stop=e=>e.port===2 && e.msg._monthlyFriendshipApi.phase==='insert';
  const a=h.advance(message('purchase',b),{stop}),second=h.advance(message('purchase',b),{stop});
  h.io(a);h.io(second);
  const first=h.advance(a.msg);assert.equal(first.msg.payload.state,'PAYMENT_PENDING');
  const r=h.advance(second.msg,{respond:m=>m.url.includes('/transactions/')?{id:'fixture-transaction',status:'UNPAID',paymentDueDate:'2026-11-02T13:00:00.000Z',client:{id:'fixture-client'},products:[{id:product.id,count:1,cost:product.cost,discount:0}],sum:product.cost,discount:0,toPay:product.cost}:h.provider(m)});
  assert.equal(r.msg.payload.state,'PAYMENT_PENDING',JSON.stringify(r.msg.payload));assert.equal(h.requests.filter(r=>r.method==='POST').length,1);
});
test('delegation expiry after returned provider response retains observation and original transaction for recovery',()=>{
  const h=harness(),q=h.advance(message('quote')).msg.payload;
  const edge=h.advance(message('purchase',bodyFor('purchase',q)),{stop:e=>e.port===4 && e.msg.method==='POST'});
  edge.msg.payload=h.provider(edge.msg);edge.msg.statusCode=200;edge.msg.responseUrl=edge.msg.url;h.setNow(at+61000);
  const r=h.advance(edge.msg);assert.equal(r.msg.statusCode,401);
  assert.equal(h.store.filter(r=>r.documentType==='MONTHLY_FRIENDSHIP_PROVIDER_OBSERVATION_V1').length,1);
  const read=h.advance(message('read',bodyFor('read'),{nowMs:at+61000}));assert.equal(read.msg.payload.providerTransactionId,'fixture-transaction');
  assert.equal(read.msg.payload.state,'PAYMENT_PENDING');
});
test('foreign actor, provider mapping or profile never reads another original operation',()=>{
  const h=harness(),q=h.advance(message('quote')).msg.payload;h.advance(message('purchase',bodyFor('purchase',q)));
  const mapping=h.advance(message('read',bodyFor('read'),{claims:{provider_mapping_id:uid(99)}}));assert.equal(mapping.msg.statusCode,409);
  const actor=h.advance(message('read',bodyFor('read'),{claims:{sub:uid(99)}}));assert.equal(actor.msg.statusCode,404);
  const profile=h.advance(message('read'),{respond:()=>({id:'different-client',phone})});assert.equal(profile.msg.statusCode,403);
});
test('quote rejects incomplete catalogue and consent binds epoch/lifecycle price',()=>{
  const h=harness();const r=h.advance(message('quote'),{respond:m=>m.url.endsWith('/profile')?h.provider(m):{content:[product],number:0,totalPages:2,totalElements:501,numberOfElements:1,last:false}});
  assert.equal(r.msg.statusCode,503);assert.equal(h.writes.length,0);
  const other=harness(),q=other.advance(message('quote')).msg.payload;
  const changed=other.advance(message('purchase',bodyFor('purchase',q)),{respond:m=>m.url.includes('/products/subscriptions?')?{...other.provider(m),content:[{...product,validityDays:31}]}:other.provider(m)});
  assert.equal(changed.msg.payload.code,'MONTHLY_API_PRICE_CHANGED');assert.equal(other.writes.length,0);
});

test('closed identifiers and actor headers reject terminal newline aliases',()=>{
 assert.equal(api.uuid(uid(1)+'\n'),false);assert.equal(api.id('fixture-client\n'),false);assert.equal(api.digest(api.hash('x')+'\n'),false);
 assert.equal(api.verify(message('quote',bodyFor('quote'),{token:'fixture-actor-token\n'}),get,at).ok,false);
});

test('Unicode terminal line separators cannot alias IDs or credentials',()=>{
 for(const end of ['\u2028','\u2029']){
  assert.equal(api.id('fixture-client'+end),false);
  assert.equal(api.verify(message('quote',bodyFor('quote'),{token:'fixture-actor-token'+end}),get,at).ok,false);
  const h=harness({globals:{vivacrm_access_token:'fixture-service-token'+end}});
  assert.equal(h.advance(message('quote')).msg.statusCode,503);assert.equal(h.writes.length,0);
 }
});

test('bank return uses the actual LK2 API ingress, with only the original reference appended',()=>{
 const h=harness(),q=h.advance(message('quote')).msg.payload;
 const e=h.advance(message('purchase',bodyFor('purchase',q)),{stop:e=>e.port===4 && e.msg.method==='POST'});
 for(const k of ['successUrl','failUrl']){
  const u=new URL(e.msg.payload[k]);assert.equal(u.origin,'https://lk2.padlhub.su');assert.equal(u.pathname,'/user/api/v1/subscription-payment-return');
  assert.deepEqual([...u.searchParams.keys()],['summerPaymentRef']);assert.equal(u.searchParams.get('summerPaymentRef'),q.operationId);
 }
});
