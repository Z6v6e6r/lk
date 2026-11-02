import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { message,bodyFor,harness,at } from './helpers/monthlyFriendshipApiHarness.mjs';
const ci=process.env.GITHUB_ACTIONS==='true',uri=process.env.COMMUNITY_MONTHLY_TEST_MONGO_URI;
if(ci && uri!=='mongodb://127.0.0.1:27017')throw Error('Monthly API requires existing CI loopback Mongo fixture');
if(!ci && uri)throw Error('Monthly API refuses local/shared Mongo');
const options={skip:!ci?'CI-only existing Mongo; no local provisioning':false};
async function fixture(t){
  const {MongoClient}=await import('mongodb');const clients=Array.from({length:4},()=>new MongoClient(uri,{directConnection:true,serverSelectionTimeoutMS:5000}));
  const name='r1_monthly_api_'+crypto.randomUUID().replaceAll('-','');assert.match(name,/^r1_monthly_api_[a-f0-9]{32}$/);
  t.after(async()=>{try{await clients[0].db(name).dropDatabase();}finally{await Promise.all(clients.map(c=>c.close()));}});
  await Promise.all(clients.map(c=>c.connect()));return clients.map(c=>c.db(name).collection('lk_tournament_subscription_sales'));
}
async function drive(h,db,msg,{lostBindingAck=false,expireAfterPost=false,posts=[]}={}){
  for(let n=0;n<100;n++){
    const e=h.run(msg);msg=e.msg;if(e.port===3)return msg;
    if(e.port===0){msg.payload=await db.find(msg.payload).toArray();continue;}
    if(e.port===1||e.port===2){
      const binding=msg._monthlyFriendshipApi.phase==='insert';
      try {msg.payload=await db.updateOne(...msg.payload);}catch(error){msg.error={code:error.code};msg.payload=null;}
      if(binding && lostBindingAck){msg.error={code:'ACK_LOST'};msg.payload=null;}continue;
    }
    assert.equal(e.port,4);if(msg.method==='POST')posts.push(msg.url);
    msg.payload=h.provider(msg);msg.statusCode=200;msg.responseUrl=msg.url;
    if(msg.method==='POST' && expireAfterPost)h.setNow(at+61000);
  }
  throw Error('bounded monthly API exceeded steps');
}
test('physical Mongo private API concurrent same-key callers create one binding and at most one provider transaction',options,async t=>{
  const db=await fixture(t),hs=db.map(()=>harness()),posts=[];
  const q=await drive(hs[0],db[0],message('quote'));assert.equal(q.statusCode,200);
  const results=await Promise.all(hs.map((h,i)=>drive(h,db[i],message('purchase',bodyFor('purchase',q.payload)),{posts})));
  assert.equal(posts.length,1);assert.equal(await db[0].countDocuments({documentType:'MONTHLY_FRIENDSHIP_ACTOR_BINDING_V1'}),1);
  assert.ok(results.some(r=>r.payload.state==='PAYMENT_PENDING'));
  for(let i=0;i<hs.length;i++){const r=await drive(hs[i],db[i],message('read'));assert.equal(r.payload.state,'PAYMENT_PENDING');}
});
test('physical Mongo lost private insert ACK survives restart without creating a payment',options,async t=>{
  const db=await fixture(t),h=harness(),posts=[],q=await drive(h,db[0],message('quote')),b=bodyFor('purchase',q.payload);
  const first=await drive(h,db[0],message('purchase',b),{lostBindingAck:true,posts});assert.equal(first.statusCode,503);
  const retry=await drive(harness(),db[1],message('purchase',b),{posts});assert.equal(retry.statusCode,503);
  assert.equal(posts.length,0);assert.equal(await db[1].countDocuments({documentType:'MONTHLY_FRIENDSHIP_ACTOR_BINDING_V1'}),1);
});
test('physical Mongo expired response authority preserves known provider result for fresh authenticated read',options,async t=>{
  const db=await fixture(t),h=harness(),posts=[],q=await drive(h,db[0],message('quote'));
  const first=await drive(h,db[0],message('purchase',bodyFor('purchase',q.payload)),{expireAfterPost:true,posts});assert.equal(first.statusCode,401);
  assert.equal(await db[1].countDocuments({documentType:'MONTHLY_FRIENDSHIP_PROVIDER_OBSERVATION_V1'}),1);
  const restarted=harness();restarted.setNow(at+61000);
  const r=await drive(restarted,db[1],message('read',bodyFor('read'),{nowMs:at+61000}),{posts});
  assert.equal(r.payload.providerTransactionId,'fixture-transaction');assert.equal(r.payload.state,'PAYMENT_PENDING');assert.equal(posts.length,1);
});
