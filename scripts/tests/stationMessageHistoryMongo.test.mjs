import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {historyReadGraph,historyCommunity,historyMessage,historyLegacy} from './helpers/stationHistoryHarness.mjs';

const ci=process.env.GITHUB_ACTIONS==='true',uri=process.env.COMMUNITY_MONTHLY_TEST_MONGO_URI;
if(ci&&uri!=='mongodb://127.0.0.1:27017')throw Error('STATION_HISTORY_REQUIRES_EXISTING_CI_FIXTURE');
if(!ci&&uri)throw Error('STATION_HISTORY_REFUSES_LOCAL_OR_SHARED_TARGET');
const options={skip:!ci?'Existing CI-owned Mongo8 only; no local provisioning':false};
async function fixture(t) {
  const {MongoClient,ObjectId}=await import('mongodb');
  const clients=[0,1].map(()=>new MongoClient(uri,{serverSelectionTimeoutMS:3000}));
  await Promise.all(clients.map(client=>client.connect()));
  const name='r1_station_history_'+crypto.randomUUID().replaceAll('-','');
  t.after(async()=>{try{await clients[0].db(name).dropDatabase();}finally{await Promise.all(clients.map(client=>client.close()));}});
  const db=clients.map(client=>client.db(name));
  await db[0].collection('lk_communities').insertOne(historyCommunity());
  const read=async(query={historyVersion:'2',limit:'3'},beforeFinal)=>historyReadGraph({
    query,beforeFinal,
    initialFind:args=>db[0].collection('lk_communities').find(...args).toArray(),
    find:(stage,args)=>db[0].collection(stage==='access'?'lk_communities':'lk_community_chat_messages').find(...args).toArray(),
  });
  return {db,read,ObjectId};
}
test('physical mixed equal-time keyset returns every UUID across >2 pages with real sort/limit and permuted inserts',options,async t=>{
  const {db,read,ObjectId}=await fixture(t),collection=db[0].collection('lk_community_chat_messages');
  const canonical=Array.from({length:8},(_,i)=>historyMessage(i+1));
  const legacy=Array.from({length:8},(_,i)=>({...historyLegacy(i+1),_id:new ObjectId(String(i+1).padStart(24,'0'))}));
  const rows=[...canonical,...legacy];
  const walks=[];
  for(const order of [rows,[...rows].reverse()]) {
    await collection.deleteMany({});await collection.insertMany(order);
    await collection.insertMany([{...historyMessage(99),state:'RESERVED',archived:true},{...historyMessage(98),archived:true}]);
    let query={historyVersion:'2',limit:'3'},ids=[];
    for(let page=0;page<10;page++) {
      const response=await read(query);assert.equal(response.statusCode,200);
      const data=response.payload;ids.push(...data.messages.map(row=>row.publicId));
      if(!data.nextBefore){assert.equal(data.hasMore,false);break;}
      query={...query,beforeTs:String(data.nextBefore.createdTs),beforeId:data.nextBefore.publicId};
    }
    assert.equal(ids.length,16);assert.equal(new Set(ids).size,16);walks.push(ids);
  }
  assert.deepEqual(walks[0],walks[1]);
});
test('physical cursor retry and deleted anchor preserve boundary; time-only migration and foreign rows cannot cross it',options,async t=>{
  const {db,read}=await fixture(t),collection=db[0].collection('lk_community_chat_messages');
  await collection.insertMany([historyMessage(1),historyMessage(2),historyMessage(3),historyMessage(4,999),{...historyMessage(9),_id:'foreign',communityId:'other'}]);
  const first=(await read({historyVersion:'2',limit:'2'})).payload;
  const query={historyVersion:'2',limit:'2',beforeTs:String(first.nextBefore.createdTs),beforeId:first.nextBefore.publicId};
  const next=await read(query);await collection.deleteOne({id:first.nextBefore.publicId});
  assert.deepEqual((await read(query)).payload,next.payload);
  assert.deepEqual((await read({historyVersion:'2',limit:'2',beforeTs:'1000'})).payload.messages.map(row=>row.createdTs),[999]);
});
test('physical late BAN/LEFT wins before final disclosure and malformed timestamp/legacy overflow never become partial success',options,async t=>{
  const {db,read}=await fixture(t),communities=db[1].collection('lk_communities'),messages=db[0].collection('lk_community_chat_messages');
  await messages.insertOne(historyMessage(1));
  for(const change of [{members:[]},{bannedMembers:[{id:'actor'}]}]) {
    const denied=await read(undefined,()=>communities.updateOne({id:'community'},{$set:change}));
    assert.equal(denied.statusCode,403);assert.equal(denied.payload.messages,undefined);
    await communities.replaceOne({id:'community'},historyCommunity());
  }
  await messages.insertOne({...historyLegacy(1),createdAt:'invalid'});
  assert.equal((await read()).statusCode,503);await messages.deleteOne({_id:'legacy-1'});
  await messages.insertMany(Array.from({length:2001},(_,i)=>historyLegacy(i)));
  const overflow=await read();assert.equal(overflow.statusCode,503);assert.equal(overflow.payload.messages,undefined);
});
test('physical Mongo projection bounds oversized strings and malformed nested values without successful truncation',options,async t=>{
  const {db,read}=await fixture(t),collection=db[0].collection('lk_community_chat_messages');
  for(const mutation of [{text:'x'.repeat(100_000)},{text:'🙂'.repeat(8001)},{authorName:'n'.repeat(50_000)},{authorId:{private:'x'.repeat(100_000)}},{stationMessageOwner:{private:'x'.repeat(100_000)}}]) {
    await collection.deleteMany({});await collection.insertOne({...historyLegacy(1),...mutation});
    const result=await read();assert.equal(result.statusCode,503);assert.equal(result.payload.messages,undefined);
  }
});
