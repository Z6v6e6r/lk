import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { beginStationNotificationFeed, runStationNotificationFeed, nfIndexProposal, stationNotificationReadiness } from '../lib/stationNotificationFeed.mjs';
import { beginStationMessage, runStationMessage, recoverStationMessageOutbox } from '../lib/stationMessageOwner.mjs';
import { beginStationRead, runStationRead } from '../lib/stationMessageRead.mjs';
import { smFence, smRosterTransition } from '../lib/stationMembershipLifetime.mjs';
import { notificationFixture, publications, recipients, eligibility } from './helpers/stationNotificationHarness.mjs';
const ci=process.env.GITHUB_ACTIONS==='true',uri=process.env.COMMUNITY_MONTHLY_TEST_MONGO_URI;
if(ci&&uri!=='mongodb://127.0.0.1:27017')throw Error('STATION_NOTIFICATION_REQUIRES_EXISTING_CI_MONGO');
if(!ci&&uri)throw Error('STATION_NOTIFICATION_REFUSES_LOCAL_OR_SHARED_MONGO');
const options={skip:!ci?'Existing CI-owned Mongo8 fixture only; no local provisioning':false};
async function fixture(t,members=4){
 const {MongoClient}=await import('mongodb'),clients=[0,1].map(()=>new MongoClient(uri,{serverSelectionTimeoutMS:3000,monitorCommands:true})),name='r1_station_notification_'+crypto.randomUUID().replaceAll('-','');
 t.after(async()=>{try{if(clients[0].topology?.isConnected())await clients[0].db(name).dropDatabase();}finally{await Promise.all(clients.map(c=>c.close()));}});
 await Promise.all(clients.map(c=>c.connect()));const db=clients.map(c=>c.db(name)),seed=await notificationFixture({members,messages:0});
 await db[0].collection('lk_communities').insertOne(seed.c);
 const {key,...indexOptions}=nfIndexProposal;await db[0].collection('lk_community_chat_messages').createIndex(key,indexOptions);
 return {db,clients,communityId:seed.c.id};
}
const community=f=>f.db[0].collection('lk_communities').findOne({id:f.communityId});
async function send(f,client=0,hooks){return runStationMessage(f.db[client],beginStationMessage({communityId:f.communityId,actor:{id:'player-a'},requestId:crypto.randomUUID(),text:'Synthetic identical text',requiredContract:true}),hooks);}
const feed=(f,mode,body,hooks)=>runStationNotificationFeed(f.db[0],beginStationNotificationFeed(mode,body,{expiresAtMs:Date.now()+30000}),hooks);
const records=f=>f.db[0].collection('lk_community_chat_messages').find({recordType:'MESSAGE'}).sort({sequence:1}).toArray();
async function transition(f,id,action,actor='admin'){
 const c=await f.db[1].collection('lk_communities').findOne({id:f.communityId}),restoring=['APPROVE','UNBAN'].includes(action),members=c.members.filter(m=>m.id!==id);if(restoring)members.push({id});
 const r=await f.db[1].collection('lk_communities').updateOne({_id:c._id,...smFence(c)},{$set:{members,stationMembershipLifetime:smRosterTransition(c,members,action,id,actor),bannedMembers:action==='BAN'?[{id}]:c.bannedMembers.filter(m=>m.id!==id)}});assert.equal(r.matchedCount,1);
}
test('physical published frontier holds delayed gap and recovery exports exact facts across three pages',options,async t=>{
 const f=await fixture(t);
 await send(f,0,{before(o){if(o.ctx.step==='message_write')return {skip:true,error:true};}});await send(f,1);
 assert.deepEqual((await feed(f,'publications',publications(await community(f)))).response.body.items,[]);
 await recoverStationMessageOutbox(f.db[1],{dryRun:false});for(let i=0;i<5;i++)await send(f,i%2);
 const c=await community(f),seen=[];let after=0;
 do{const result=await feed(f,'publications',{...publications(c),limit:2,throughSequence:7,afterSequence:after});assert.equal(result.response.status,200);seen.push(...result.response.body.items);after=result.response.body.nextAfterSequence;}while(after!==null);
 assert.deepEqual(seen.map(x=>x.sequence),[1,2,3,4,5,6,7]);assert.equal(new Set(seen.map(x=>x.messageId)).size,7);
 assert.equal(stationNotificationReadiness(c,await f.db[0].collection('lk_community_chat_messages').listIndexes().toArray()).observedPublishedSequence,7);
});
test('physical >100-recipient pagination excludes author, never truncates and does not restart on lower-key new epoch',options,async t=>{
 const f=await fixture(t,125);await send(f);const c=await community(f),d=(await records(f))[0];let after=null,seen=[],pages=0;
 do{const result=await feed(f,'recipients',recipients(c,d,after,50));assert.equal(result.response.status,200);seen.push(...result.response.body.items.map(x=>x.playerId));after=result.response.body.nextAfterPlayerId;pages++;if(pages===1)await transition(f,'new-before-cursor','APPROVE');}while(after!==null);
 assert.equal(pages,3);assert.equal(seen.length,124);assert.equal(new Set(seen).size,124);assert.equal(seen.includes('new-before-cursor'),false);assert.equal(seen.includes('player-a'),false);
});
test('physical second-client LEFT/BAN before final read denies, lower READ progress allows and covering READ denies',options,async t=>{
 const f=await fixture(t);for(let i=0;i<3;i++)await send(f);let c=await community(f),d=(await records(f))[2],body=eligibility(c,d);
 const read=through=>runStationRead(f.db[1],beginStationRead({communityId:c.id,actor:{id:'recipient-001'},body:{requestId:crypto.randomUUID(),streamId:c.communityMessageOutbox.streamId,membershipEpoch:0,throughSequence:through}}));
 assert.equal((await read(1)).response.status,200);assert.equal((await feed(f,'eligibility',body)).response.body.outcome,'ALLOW');assert.equal((await read(3)).response.status,200);assert.equal((await feed(f,'eligibility',body)).response.body.outcome,'DENY');
 for(const [id,action,actor]of [['recipient-002','REMOVE','recipient-002'],['recipient-003','BAN','admin']]){c=await community(f);body=eligibility(c,d,id);const result=await feed(f,'eligibility',body,{async before(o){if(o.ctx.step==='final')await transition(f,id,action,actor);}});assert.equal(result.response.body.outcome,'DENY');await transition(f,id,action==='BAN'?'UNBAN':'APPROVE');assert.equal((await feed(f,'eligibility',body)).response.body.outcome,'DENY');}
});
test('physical missing event/duplicate sequence/oversize/candidate cannot become a feed success',options,async t=>{
 const f=await fixture(t);await send(f);const c=await community(f),body=publications(c),d=(await records(f))[0],events=f.db[0].collection('lk_community_events'),messages=f.db[0].collection('lk_community_chat_messages');
 await events.deleteOne({_id:d.stationMessageEvent._id});assert.equal((await feed(f,'publications',body)).response.status,503);await events.insertOne(d.stationMessageEvent);
 await messages.insertOne({...d,_id:'synthetic-duplicate'});assert.equal((await feed(f,'publications',body)).response.status,503);await messages.deleteOne({_id:'synthetic-duplicate'});
 await messages.updateOne({_id:d._id},{$set:{unused:'x'.repeat(70000)}});assert.equal((await feed(f,'publications',body)).response.status,503);await messages.updateOne({_id:d._id},{$unset:{unused:''},$set:{state:'RESERVED',archived:true}});assert.equal((await feed(f,'publications',body)).response.status,503);
});
test('physical missing index and recreated/archived/type-changed identity fail closed, no silent floor reset',options,async t=>{
 const f=await fixture(t);await send(f);const c=await community(f),body=publications(c),store=f.db[0].collection('lk_communities');
 await f.db[0].collection('lk_community_chat_messages').dropIndex(nfIndexProposal.name);assert.equal((await feed(f,'publications',body)).response.status,503);
 const {key,...options}=nfIndexProposal;await f.db[0].collection('lk_community_chat_messages').createIndex(key,options);
 for(const replacement of [{...c,_id:'synthetic-recreated'},{...c,archived:true},{...c,communityType:'FRIENDS'}]){await store.deleteMany({});await store.insertOne(replacement);assert.equal((await feed(f,'publications',body)).response.status,503);}
});
test('physical actual descriptors are aggregate-only, READ_COMMAND excluded, concurrent publication preserves old snapshot',options,async t=>{
 const f=await fixture(t);await send(f);const c=await community(f),body=publications(c),commands=[];
 await runStationRead(f.db[1],beginStationRead({communityId:c.id,actor:{id:'recipient-001'},body:{requestId:crypto.randomUUID(),streamId:c.communityMessageOutbox.streamId,membershipEpoch:0,throughSequence:1}}));
 f.clients[0].on('commandStarted',e=>commands.push(e));const result=await feed(f,'publications',body,{async before(o){if(o.ctx.step==='final')await send(f,1);}});assert.equal(result.response.status,200);assert.equal(result.response.body.items.length,1);assert.equal(result.response.body.throughSequence,1);
 assert.equal(commands.filter(e=>!['aggregate','getMore','killCursors'].includes(e.commandName)).length,0);
 assert.ok(commands.filter(e=>e.commandName==='aggregate').every(e=>e.command.readConcern?.level==='majority'&&e.command.maxTimeMS===3000&&e.command.allowDiskUse===false));
 assert.equal(commands.some(e=>JSON.stringify(e.command.pipeline).includes('$merge')||JSON.stringify(e.command.pipeline).includes('$out')),false);
});
