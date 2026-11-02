import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {beginStationMessage,runStationMessage,recoverStationMessageOutbox,beginStationMessageStatus} from '../lib/stationMessageOwner.mjs';
import {smTransition,smFence} from '../lib/stationMembershipLifetime.mjs';
const ci=process.env.GITHUB_ACTIONS==='true',uri=process.env.COMMUNITY_MONTHLY_TEST_MONGO_URI;
if(ci&&uri!=='mongodb://127.0.0.1:27017')throw Error('STATION_MESSAGE_REQUIRES_EXISTING_CI_FIXTURE');
if(!ci&&uri)throw Error('STATION_MESSAGE_REFUSES_LOCAL_OR_SHARED_TARGET');
const options={skip:!ci?'Existing CI-owned Mongo8 only; no local provisioning':false};
async function fixture(t){
 const {MongoClient}=await import('mongodb');const clients=Array.from({length:3},()=>new MongoClient(uri,{serverSelectionTimeoutMS:3000}));
 await Promise.all(clients.map(c=>c.connect()));const name='r1_station_message_'+crypto.randomUUID().replaceAll('-','');
 t.after(async()=>{try{await clients[0].db(name).dropDatabase();}finally{await Promise.all(clients.map(c=>c.close()));}});
 const dbs=clients.map(c=>c.db(name));await dbs[0].collection('lk_communities').insertOne({id:'community',communityType:'STATION',typeSettingsRevision:1,members:[{id:'actor',role:'MEMBER'}],bannedMembers:[]});return dbs;
}
const input=()=>({communityId:'community',actor:{id:'actor'},requestId:crypto.randomUUID(),text:'Synthetic fixture'});
const send=(db,i,h)=>runStationMessage(db,beginStationMessage(i),h);
async function leave(db,state='LEFT'){
 const c=await db.collection('lk_communities').findOne({id:'community'});
 const result=await db.collection('lk_communities').updateOne({_id:c._id,...smFence(c)},{$set:{members:[],stationMembershipLifetime:smTransition(c,'actor',state)}});assert.equal(result.matchedCount,1);
}
test('physical concurrent same-key custody and lost ACK yield one public message/event',options,async t=>{
 const db=await fixture(t),i=input();await Promise.all(db.map(d=>send(d,i,{after(op){if(op.method==='updateOne')return {error:true};}})));
 const retry=await send(db[0],i);assert.equal(retry.response.status,200);
 assert.equal(await db[0].collection('lk_community_chat_messages').countDocuments(),1);assert.equal(await db[0].collection('lk_community_events').countDocuments(),1);
 assert.equal((await send(db[1],{...i,text:'changed'})).response.status,409);
});
test('physical LEFT/BAN between preimage and CAS denies; no candidate becomes readable',options,async t=>{
 for(const state of ['LEFT','BANNED']){
  const db=await fixture(t),i=input();const result=await send(db[0],i,{async before(op){if(op.ctx.step==='accept_write')await leave(db[1],state);}});
  assert.equal(result.response.status,503);assert.equal((await send(db[2],i)).response.status,403);
  assert.equal(await db[0].collection('lk_community_chat_messages').countDocuments({archived:{$ne:true}}),0);
  assert.equal(await db[0].collection('lk_community_events').countDocuments(),0);
 }
});
test('physical accepted intent survives ACK loss/leave/archive; retained deletion CAS cannot erase it',options,async t=>{
 const db=await fixture(t),i=input(),before=await db[1].collection('lk_communities').findOne({id:'community'});
 const result=await send(db[0],i,{async after(op){if(op.ctx.step==='accept_write'){await leave(db[1]);return {error:true};}},before(op){if(op.ctx.step==='message_write')return {skip:true,error:true};}});
 assert.equal(result.response.status,503);
 const removed=await db[1].collection('lk_communities').deleteOne({_id:before._id,stationMembershipLifetime:{$exists:false},$or:[{communityMessageOutbox:{$exists:false}},{communityMessageOutbox:{$size:0}}]});assert.equal(removed.deletedCount,0);
 await db[1].collection('lk_communities').updateOne({_id:before._id},{$set:{archived:true,communityType:'FRIENDS'}});
 assert.equal((await recoverStationMessageOutbox(db[2],{dryRun:false})).recovered,1);
 assert.equal(await db[0].collection('lk_community_chat_messages').countDocuments({state:'COMMITTED'}),1);assert.equal(await db[0].collection('lk_community_events').countDocuments(),1);
 assert.deepEqual((await db[0].collection('lk_communities').findOne({_id:before._id})).communityMessageOutbox,[]);
});

test('physical original-request GET proves only committed receipt and never repairs or creates custody',options,async t=>{
 const db=await fixture(t),i=input();
 const readonly=async(args=i,after)=>{
  let writes=0;
  const proxy={collection(name){const collection=db[1].collection(name);return {find:(...args)=>collection.find(...args),updateOne(){writes++;throw Error('STATUS_WRITE_FORBIDDEN');}};}};
  const result=await runStationMessage(proxy,beginStationMessageStatus(args),{before(op){assert.equal(op.method,'find');},after});assert.equal(writes,0);return result;
 };
 assert.equal((await readonly()).response.body.outcome,'UNKNOWN');assert.equal(await db[0].collection('lk_community_chat_messages').countDocuments(),0);
 await send(db[0],{...i,requiredContract:true},{before(op){if(op.ctx.step==='event_write')return {skip:true,error:true};}});
 assert.equal((await readonly()).response.body.outcome,'UNKNOWN');assert.equal(await db[0].collection('lk_community_events').countDocuments(),0);
 assert.equal((await recoverStationMessageOutbox(db[2],{dryRun:false})).recovered,1);
 assert.equal((await readonly()).response.body.outcome,'CONFIRMED');
 const denied=await readonly(i,async op=>{if(op.ctx.step==='status_event')await leave(db[2],'BANNED');});assert.equal(denied.response.status,403);assert.equal(denied.response.body.message,undefined);
 const current=await db[0].collection('lk_communities').findOne({id:'community'});assert.equal(current.stationMembershipLifetime.players[0].state,'BANNED');
});
