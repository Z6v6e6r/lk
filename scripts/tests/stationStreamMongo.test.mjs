import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {stationStreamAdoptionPlan} from '../lib/stationMessageStream.mjs';
import {beginStationMessage,runStationMessage,recoverStationMessageOutbox,beginStationMessageStatus} from '../lib/stationMessageOwner.mjs';
import {beginStationRead,runStationRead} from '../lib/stationMessageRead.mjs';
import {smFence,smTransition} from '../lib/stationMembershipLifetime.mjs';
import {streamHistoryRequest,streamHistorySnapshot,streamHistoryBind,streamHistoryFindArguments,streamHistoryPage,streamUnreadArguments,streamUnreadCounts,streamSnapshotUnchanged} from '../lib/stationStreamHistory.mjs';
const ci=process.env.GITHUB_ACTIONS==='true',uri=process.env.COMMUNITY_MONTHLY_TEST_MONGO_URI;
if(ci&&uri!=='mongodb://127.0.0.1:27017')throw Error('STATION_STREAM_REQUIRES_EXISTING_CI_FIXTURE');
if(!ci&&uri)throw Error('STATION_STREAM_REFUSES_LOCAL_OR_SHARED_TARGET');
const options={skip:!ci?'Existing CI-owned Mongo8 only; no local provisioning':false};
const actor={id:'actor'},communityId='community';
async function fixture(t){
 const {MongoClient}=await import('mongodb');const clients=Array.from({length:3},()=>new MongoClient(uri,{serverSelectionTimeoutMS:3000}));await Promise.all(clients.map(c=>c.connect()));
 const name='r1_station_stream_'+crypto.randomUUID().replaceAll('-','');t.after(async()=>{try{await clients[0].db(name).dropDatabase();}finally{await Promise.all(clients.map(c=>c.close()));}});
 const db=clients.map(c=>c.db(name)),collection=db[0].collection('lk_communities');
 await collection.insertOne({id:communityId,communityType:'STATION',typeSettingsRevision:1,members:[actor,{id:'other'}],bannedMembers:[]});
 const c=await collection.findOne({id:communityId}),plan=stationStreamAdoptionPlan(c,crypto.randomUUID());assert.equal((await collection.updateOne(plan.filter,plan.update,plan.options)).matchedCount,1);
 return db;
}
const input=(requestId=crypto.randomUUID(),who=actor)=>({communityId,actor:who,requestId,text:'Synthetic stream message',requiredContract:true});
const send=(db,i,h)=>runStationMessage(db,beginStationMessage(i),h);
async function readInput(db,throughSequence){const c=await db.collection('lk_communities').findOne({id:communityId});return {communityId,actor,body:{requestId:crypto.randomUUID(),streamId:c.communityMessageOutbox.streamId,membershipEpoch:c.stationMembershipLifetime.players.find(p=>p.playerId===actor.id).epoch,throughSequence}};}
async function leave(db){const c=await db.collection('lk_communities').findOne({id:communityId});const result=await db.collection('lk_communities').updateOne({_id:c._id,...smFence(c)},{$set:{members:c.members.filter(m=>m.id!==actor.id),stationMembershipLifetime:smTransition(c,actor.id,'LEFT')}});assert.equal(result.matchedCount,1);}
test('physical separate clients allocate consecutive CAS slots; delayed projection cannot hide behind later publication',options,async t=>{
 const db=await fixture(t),a=input(),b=input();
 assert.equal((await send(db[0],a,{before(op){if(op.ctx.step==='message_write')return {skip:true,error:true};}})).response.body.outcome,'UNKNOWN');
 assert.equal((await send(db[1],b)).response.body.outcome,'UNKNOWN');
 let c=await db[2].collection('lk_communities').findOne({id:communityId});assert.equal(c.communityMessageOutbox.publishedSequence,0);assert.equal(c.communityMessageOutbox.acceptedSequence,2);
 await recoverStationMessageOutbox(db[2],{dryRun:false});c=await db[0].collection('lk_communities').findOne({id:communityId});assert.equal(c.communityMessageOutbox.publishedSequence,2);assert.deepEqual(c.communityMessageOutbox.intents,[]);
 assert.equal((await runStationMessage(db[1],beginStationMessageStatus({...a}))).response.body.outcome,'CONFIRMED');
 assert.equal(await db[0].collection('lk_community_chat_messages').countDocuments({recordType:'MESSAGE'}),2);assert.equal(await db[0].collection('lk_community_events').countDocuments(),2);
 const same=input();await Promise.all(db.map(d=>send(d,same)));assert.equal(await db[0].collection('lk_community_chat_messages').countDocuments({requestId:same.requestId}),1);
});
test('physical READ lost ACK/LEFT recovery and leave-first CAS isolate original epoch without new events',options,async t=>{
 const db=await fixture(t);await send(db[0],input());const request=await readInput(db[0],1);
 const pending=await runStationRead(db[0],beginStationRead(request),{before(op){if(op.ctx.step==='project_write')return {skip:true,error:true};},after(op){if(op.ctx.step==='accept_write')return {error:true};}});assert.equal(pending.response.body.outcome,'UNKNOWN');
 await leave(db[1]);await recoverStationMessageOutbox(db[2],{dryRun:false});
 const receipt=await db[0].collection('lk_community_chat_messages').findOne({requestId:request.body.requestId});assert.equal(receipt.state,'COMMITTED');assert.equal(receipt.receipt.readThroughSequence,1);assert.equal(receipt.archived,true);assert.equal(receipt.sequence,undefined);
 assert.equal((await runStationRead(db[1],beginStationRead({communityId,actor,requestId:request.body.requestId,statusOnly:true}))).response.status,403);
 let c=await db[0].collection('lk_communities').findOne({id:communityId});await db[0].collection('lk_communities').updateOne({_id:c._id,...smFence(c)},{$set:{members:[...c.members,actor],stationMembershipLifetime:smTransition(c,actor.id,'ACTIVE')}});
 const next=await readInput(db[0],1);let once=false;const denied=await runStationRead(db[0],beginStationRead(next),{async before(op){if(op.ctx.step==='accept_write'&&!once){once=true;await leave(db[1]);}}});assert.equal(denied.response.status,403);
 assert.equal(await db[0].collection('lk_community_events').countDocuments(),1);assert.equal((await db[0].collection('lk_community_chat_messages').findOne({requestId:next.body.requestId})).state,'RESERVED');
});
test('physical count excludes own, fixed snapshot pages recover all sequences and drift cannot claim unread zero',options,async t=>{
 const db=await fixture(t);for(let n=0;n<6;n++)await send(db[n%3],input(crypto.randomUUID(),n%2?actor:{id:'other'}));
 const c=await db[0].collection('lk_communities').findOne({id:communityId}),snapshot=streamHistorySnapshot(c,actor),collection=db[0].collection('lk_community_chat_messages');
 const counts=streamUnreadCounts([snapshot],await collection.aggregate(...streamUnreadArguments([snapshot],actor.id)).toArray());assert.equal(counts.get(communityId),3);
 let after=0;const seen=[];do{const request=streamHistoryBind(streamHistoryRequest(communityId,{historyVersion:'3',limit:'2',streamId:snapshot.streamId,membershipEpoch:String(snapshot.membershipEpoch),afterSequence:String(after),throughSequence:'6'}),snapshot);const rows=await collection.find(...streamHistoryFindArguments(request)).toArray();const page=streamHistoryPage(request,snapshot,rows,[],3);seen.push(...page.messages.map(m=>m.sequence));after=page.nextAfterSequence;}while(after!==null);assert.deepEqual(seen,[1,2,3,4,5,6]);
 const request=await readInput(db[0],4),accepted=await runStationRead(db[1],beginStationRead(request));assert.equal(accepted.response.body.outcome,'CONFIRMED');
 const current=await db[0].collection('lk_communities').findOne({id:communityId});assert.equal(streamSnapshotUnchanged(snapshot,current,actor),false);
 const fresh=streamHistorySnapshot(current,actor);assert.equal(streamUnreadCounts([fresh],await collection.aggregate(...streamUnreadArguments([fresh],actor.id)).toArray()).get(communityId),1);
 const before=await collection.countDocuments();await runStationRead(db[2],beginStationRead({communityId,actor,requestId:request.body.requestId,statusOnly:true}));assert.equal(await collection.countDocuments(),before);
});

test('physical worker cleanup and newer cursor cannot poison original READ acceptance after lost ACK',options,async t=>{
 const db=await fixture(t);await send(db[0],input());await send(db[1],input());
 const original=await readInput(db[0],1),newer=await readInput(db[1],2);let injected=false;
 const result=await runStationRead(db[0],beginStationRead(original),{async before(op){if(op.ctx.step==='accept_readback'&&!injected){injected=true;await recoverStationMessageOutbox(db[1],{dryRun:false});assert.equal((await runStationRead(db[2],beginStationRead(newer))).response.body.readThroughSequence,2);}},after(op){if(op.ctx.step==='accept_write')return {error:true};}});
 assert.equal(result.response.body.outcome,'CONFIRMED');assert.equal(result.response.body.readThroughSequence,1);
 const current=await db[2].collection('lk_communities').findOne({id:communityId});assert.equal(current.stationMembershipLifetime.players.find(p=>p.playerId===actor.id).readPosition.readThroughSequence,2);assert.deepEqual(current.communityMessageOutbox.intents,[]);
 assert.equal((await runStationRead(db[1],beginStationRead({communityId,actor,requestId:original.body.requestId,statusOnly:true}))).response.body.readThroughSequence,1);
 assert.equal(await db[0].collection('lk_community_chat_messages').countDocuments({requestId:original.body.requestId}),1);assert.equal(await db[0].collection('lk_community_events').countDocuments(),2);
});
