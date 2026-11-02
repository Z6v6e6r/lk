import test from 'node:test';
import assert from 'node:assert/strict';
import {messageDb,uid} from './helpers/stationMessageHarness.mjs';
import {stationStreamAdoptionPlan,stationStreamEnvelope} from '../lib/stationMessageStream.mjs';
import {beginStationMessage,runStationMessage,recoverStationMessageOutbox,beginStationMessageStatus} from '../lib/stationMessageOwner.mjs';
import {smTransition,smLifetime,smFence} from '../lib/stationMembershipLifetime.mjs';
import {beginStationRead,runStationRead} from '../lib/stationMessageRead.mjs';
import {streamHistoryRequest,streamHistorySnapshot,streamHistoryBind,streamHistoryPage,streamUnreadCounts,streamSnapshotUnchanged,streamSummaryClassification} from '../lib/stationStreamHistory.mjs';
const actor={id:'player-a'},communityId='station-community';
const adopted=()=>{const db=messageDb(),c=db.tables.get('lk_communities')[0];Object.assign(c,stationStreamAdoptionPlan(c,uid(90)).update.$set);return db;};
const send=(db,n,hooks)=>runStationMessage(db,beginStationMessage({communityId,actor,requestId:uid(n),text:'Synthetic '+n,requiredContract:true}),hooks);
const read=(db,n,throughSequence,hooks)=>runStationRead(db,beginStationRead({communityId,actor,body:{requestId:uid(n),streamId:uid(90),membershipEpoch:0,throughSequence}}),hooks);
test('adoption is an explicit exact whole-preimage plan and paired rollback floor',()=>{
 const db=adopted(),c=db.tables.get('lk_communities')[0];assert.equal(smLifetime(c).version,2);assert.equal(stationStreamEnvelope(c).publishedSequence,0);
 assert.deepEqual(smLifetime(c).players[0].readPosition,{streamId:uid(90),baselineSequence:0,readThroughSequence:0});
 assert.equal(smFence(c)['stationMembershipLifetime.version'],2);assert.deepEqual(smFence(c).communityMessageOutbox,c.communityMessageOutbox);
 for(const mutate of [x=>delete x.stationMembershipLifetime.players[0].readPosition,x=>x.stationMembershipLifetime.version=1,x=>x.communityMessageOutbox=[]]){const x=structuredClone(c);mutate(x);assert.throws(()=>smLifetime(x));}
 assert.throws(()=>stationStreamAdoptionPlan(c,uid(91)));
});
test('late first publication holds contiguous frontier and second receipt; recovery publishes both once',async()=>{
 const db=adopted(),c=db.tables.get('lk_communities')[0];
 const first=await send(db,1,{before(op){if(op.ctx.step==='message_write')return {skip:true,error:true};}});assert.equal(first.response.body.outcome,'UNKNOWN');
 const second=await send(db,2);assert.equal(second.response.body.outcome,'UNKNOWN');assert.equal(c.communityMessageOutbox.acceptedSequence,2);assert.equal(c.communityMessageOutbox.publishedSequence,0);assert.equal(c.communityMessageOutbox.intents.length,2);
 await recoverStationMessageOutbox(db,{dryRun:false});assert.equal(c.communityMessageOutbox.publishedSequence,2);assert.equal(c.communityMessageOutbox.intents.length,0);
 const result=await runStationMessage(db,beginStationMessageStatus({communityId,actor,requestId:uid(2)}));assert.equal(result.response.body.outcome,'CONFIRMED');
 assert.deepEqual(db.tables.get('lk_community_chat_messages').map(m=>m.sequence),[1,2]);assert.equal(db.tables.get('lk_community_events').length,2);
});
test('read acceptance is durable, original result immutable and GET cannot mutate',async()=>{
 const db=adopted(),c=db.tables.get('lk_communities')[0];await send(db,1);await send(db,2);
 const a=await read(db,11,1,{after(op){if(op.method==='updateOne')return {error:true};}});assert.equal(a.response.body.outcome,'CONFIRMED');assert.equal(a.response.body.readThroughSequence,1);
 await read(db,12,2);assert.deepEqual((await read(db,11,1)).response,a.response);assert.equal(smLifetime(c).players[0].readPosition.readThroughSequence,2);
 const before=JSON.stringify([...db.tables]);const status=await runStationRead(db,beginStationRead({communityId,actor,requestId:uid(11),statusOnly:true}),{before(op){assert.equal(op.method,'find');}});assert.deepEqual(status.response,a.response);assert.equal(JSON.stringify([...db.tables]),before);
 assert.equal((await read(db,11,2)).response.status,409);assert.equal(db.tables.get('lk_community_events').length,2);
 assert.equal(db.tables.get('lk_community_chat_messages').filter(m=>m.recordType==='READ_COMMAND').every(m=>m.archived===true&&m.sequence===undefined),true);
});
test('accepted READ projection survives LEFT but old epoch status cannot advance or disclose new membership',async()=>{
 const db=adopted(),c=db.tables.get('lk_communities')[0];await send(db,1);
 const pending=await read(db,11,1,{before(op){if(op.ctx.step==='project_write')return {skip:true,error:true};}});assert.equal(pending.response.body.outcome,'UNKNOWN');
 c.stationMembershipLifetime=smTransition(c,actor.id,'LEFT');c.members=[];
 await recoverStationMessageOutbox(db,{dryRun:false});assert.equal(c.communityMessageOutbox.intents.length,0);
 c.stationMembershipLifetime=smTransition(c,actor.id,'ACTIVE');c.members=[actor];
 assert.equal(smLifetime(c).players[0].readPosition.baselineSequence,1);
 const status=await runStationRead(db,beginStationRead({communityId,actor,requestId:uid(11),statusOnly:true}));assert.equal(status.response.status,403);
 assert.equal((await read(db,12,1)).response.status,403);
});
test('fixed windows are contiguous, bounded, epoch-bound and recover more than one page',async()=>{
 const db=adopted(),c=db.tables.get('lk_communities')[0];for(let n=1;n<=5;n++)assert.equal((await send(db,n)).response.body.outcome,'CONFIRMED');
 const snapshot=streamHistorySnapshot(c,actor),initial=streamHistoryBind(streamHistoryRequest(communityId,{historyVersion:'3',limit:'2'}),snapshot);assert.equal(initial.afterSequence,3);assert.equal(initial.throughSequence,5);
 const rows=db.tables.get('lk_community_chat_messages');const latest=streamHistoryPage(initial,snapshot,rows.slice(3),[],0);assert.deepEqual(latest.messages.map(m=>m.sequence),[4,5]);
 let after=0;const received=[];do{const request=streamHistoryBind(streamHistoryRequest(communityId,{historyVersion:'3',limit:'2',streamId:uid(90),membershipEpoch:'0',afterSequence:String(after),throughSequence:'5'}),snapshot);const page=streamHistoryPage(request,snapshot,rows.slice(after,after+2),[],0);received.push(...page.messages.map(m=>m.sequence));after=page.nextAfterSequence;}while(after!==null);assert.deepEqual(received,[1,2,3,4,5]);
 assert.throws(()=>streamHistoryRequest(communityId,{historyVersion:'3',afterSequence:'0'}));assert.throws(()=>streamHistoryPage(initial,snapshot,rows.slice(2,4),[],0),/GAP/);
 const before=structuredClone(snapshot);await read(db,20,5);assert.equal(streamSnapshotUnchanged(before,c,actor),false);
 const newer=streamHistorySnapshot(c,actor),older=streamHistoryBind(streamHistoryRequest(communityId,{historyVersion:'3',limit:'2',streamId:uid(90),membershipEpoch:'0',afterSequence:'0',throughSequence:'2'}),newer);assert.equal(streamHistoryPage(older,newer,rows.slice(0,2),[],0).throughSequence,2);
 assert.deepEqual([...streamUnreadCounts([newer],[])],[[communityId,0]]);assert.equal(streamSummaryClassification(c,actor,true).availability,'AVAILABLE');
});

test('actual pre-adoption LK binary parser rejects lifetime v2 and cannot remove baseline',async()=>{
 const old=await import('./fixtures/station-stream/oldLifetime.mjs');const c=adopted().tables.get('lk_communities')[0];
 assert.throws(()=>old.smLifetime(c),/STATION_LIFETIME_INVALID/);assert.throws(()=>old.smTransition(c,'player-a','ACTIVE'),/STATION_LIFETIME_INVALID/);
});
test('read before acceptance loses to LEFT, and no old request adopts the restored epoch',async()=>{
 const db=adopted(),c=db.tables.get('lk_communities')[0];await send(db,1);let raced=false;
 const result=await read(db,30,1,{before(op){if(op.ctx.step==='accept_write'&&!raced){raced=true;c.stationMembershipLifetime=smTransition(c,actor.id,'LEFT');c.members=[];}}});assert.equal(result.response.status,403);
 c.stationMembershipLifetime=smTransition(c,actor.id,'ACTIVE');c.members=[actor];assert.equal((await read(db,30,1)).response.status,403);assert.equal(c.communityMessageOutbox.intents.length,0);
});
test('out-of-order read commands preserve monotone effective cursor and original receipt',async()=>{
 const db=adopted();await send(db,1);await send(db,2);
 const [a,b]=await Promise.all([read(db,31,2),read(db,32,1)]);assert.equal(a.response.body.outcome,'CONFIRMED');assert.equal(b.response.body.outcome,'CONFIRMED');assert.equal(db.tables.get('lk_communities')[0].stationMembershipLifetime.players[0].readPosition.readThroughSequence,2);
 assert.deepEqual((await read(db,32,1)).response,b.response);
});

test('existing restore full-preimage custody rejects any adoption, baseline, publication or read change',async()=>{
 const {assertFullCommunityPreimage,hashFullCommunityPreimage}=await import('../apply_published_tournament_membership_plan.mjs');
 const c=adopted().tables.get('lk_communities')[0],hash=hashFullCommunityPreimage([c]);
 assert.doesNotThrow(()=>assertFullCommunityPreimage([structuredClone(c)],hash,'Synthetic restore'));
 for(const mutate of [x=>x.communityMessageOutbox.revision++,x=>x.communityMessageOutbox.streamId=uid(91),x=>x.stationMembershipLifetime.players[0].readPosition.readThroughSequence++,x=>x.stationMembershipLifetime.version=1]){const changed=structuredClone(c);mutate(changed);assert.throws(()=>assertFullCommunityPreimage([changed],hash,'Synthetic restore'),/drifted/);}
});
test('immutable wire fixture is emitted by actual owner/read/history helpers',async()=>{
 const {default:fs}=await import('node:fs');const fixture=JSON.parse(fs.readFileSync(new URL('./fixtures/station-stream/wire.json',import.meta.url),'utf8'));
 const db=adopted(),c=db.tables.get('lk_communities')[0];await runStationMessage(db,beginStationMessage({communityId,actor,requestId:uid(1),text:'Synthetic station message',requiredContract:true,nowIso:'2026-11-01T12:00:00.000Z'}));
 const snapshot=streamHistorySnapshot(c,actor),request=streamHistoryBind(streamHistoryRequest(communityId,{historyVersion:'3',limit:'50'}),snapshot);
 assert.deepEqual(streamHistoryPage(request,snapshot,db.tables.get('lk_community_chat_messages'),[],0),fixture.history);
 assert.deepEqual((await runStationRead(db,beginStationRead({communityId,actor,body:fixture.readRequest}))).response.body,fixture.receipt);
 assert.deepEqual({contractVersion:1,contract:'station-stream-summaries',items:[{...streamSummaryClassification(c,actor,true),unreadCount:0}]},fixture.summary);
});

test('shared pending capacity never skips a sequence and does not prevent membership removal',async()=>{
 const db=adopted(),c=db.tables.get('lk_communities')[0];
 for(let n=1;n<=32;n++)await send(db,n,{before(op){if(op.ctx.step==='message_write')return {skip:true,error:true};}});
 assert.equal(c.communityMessageOutbox.intents.length,32);assert.equal(c.communityMessageOutbox.publishedSequence,0);
 assert.equal((await send(db,33)).response.status,503);assert.equal((await read(db,40,0)).response.status,503);
 assert.equal(c.communityMessageOutbox.acceptedSequence,32);c.stationMembershipLifetime=smTransition(c,actor.id,'LEFT');c.members=[];assert.equal(c.stationMembershipLifetime.players[0].state,'LEFT');
 await recoverStationMessageOutbox(db,{dryRun:false,maxMessages:32});assert.equal(c.communityMessageOutbox.publishedSequence,32);assert.equal(c.communityMessageOutbox.intents.length,0);
});
test('legacy-shaped send on adopted stream waits for frontier and keeps its original success shape',async()=>{
 const db=adopted();await send(db,1,{before(op){if(op.ctx.step==='message_write')return {skip:true,error:true};}});
 const original={communityId,actor,requestId:uid(2),text:'Legacy shaped'};
 assert.equal((await runStationMessage(db,beginStationMessage(original))).response.status,503);
 await recoverStationMessageOutbox(db,{dryRun:false});const replay=await runStationMessage(db,beginStationMessage(original));assert.equal(replay.response.status,200);assert.equal(replay.response.body.ok,true);assert.equal(replay.response.body.contractVersion,undefined);
});
test('read malformed body/future range/corrupt accepted receipt never changes cursor or leaks chat',async()=>{
 const db=adopted();await send(db,1);const body={requestId:uid(50),streamId:uid(90),membershipEpoch:0,throughSequence:1};
 for(const bad of [{...body,extra:true},{...body,membershipEpoch:'0'},{...body,throughSequence:Number.MAX_SAFE_INTEGER},{...body,streamId:uid(90)+'\n'},null])assert.throws(()=>beginStationRead({communityId,actor,body:bad}),/INVALID/);
 assert.equal((await read(db,51,2)).response.status,400);
 await read(db,50,1);const row=db.tables.get('lk_community_chat_messages').find(r=>r.recordType==='READ_COMMAND');row.receipt.readThroughSequence=0;
 const status=await runStationRead(db,beginStationRead({communityId,actor,requestId:uid(50),statusOnly:true}));assert.equal(status.response.body.outcome,'UNKNOWN');assert.equal(status.response.body.receipt,undefined);
});

test('pre-adoption reserved candidate is never upgraded into the new stream',async()=>{
 const db=messageDb(),c=db.tables.get('lk_communities')[0];
 const pending=await send(db,1,{before(op){if(op.ctx.step==='accept_write')return {skip:true,error:true};}});assert.equal(pending.response.body.outcome,'UNKNOWN');assert.equal(c.communityMessageOutbox,undefined);
 Object.assign(c,stationStreamAdoptionPlan(c,uid(90)).update.$set);
 assert.equal((await send(db,1)).response.status,409);assert.equal(c.communityMessageOutbox.acceptedSequence,0);assert.equal(db.tables.get('lk_community_events')?.length||0,0);
});

test('pending READ audit intents share capacity without sequence/event allocation; missing original is not healed',async()=>{
 const db=adopted(),c=db.tables.get('lk_communities')[0];
 for(let n=1;n<=32;n++)await read(db,100+n,0,{before(op){if(op.ctx.step==='project_write')return {skip:true,error:true};}});
 assert.equal(c.communityMessageOutbox.intents.length,32);assert.equal(c.communityMessageOutbox.acceptedSequence,0);assert.equal((await send(db,1)).response.status,503);
 assert.equal(db.tables.get('lk_community_events')?.length||0,0);
 db.tables.get('lk_community_chat_messages').splice(0,1);const before=JSON.stringify([...db.tables]);await assert.rejects(()=>recoverStationMessageOutbox(db,{dryRun:false}),/READ_RECOVERY_UNPROVEN/);assert.equal(JSON.stringify([...db.tables]),before);
});

test('worker cleanup plus newer read cannot reaccept stale original after lost acceptance ACK',async()=>{
 const db=adopted(),c=db.tables.get('lk_communities')[0];await send(db,1);await send(db,2);let injected=false;
 const original=await read(db,60,1,{async before(op){if(op.ctx.step==='accept_readback'&&!injected){injected=true;await recoverStationMessageOutbox(db,{dryRun:false});assert.equal((await read(db,61,2)).response.body.readThroughSequence,2);}}});
 assert.equal(original.response.body.readThroughSequence,1);assert.equal(original.response.body.outcome,'CONFIRMED');assert.equal(c.stationMembershipLifetime.players[0].readPosition.readThroughSequence,2);assert.deepEqual(c.communityMessageOutbox.intents,[]);
 assert.equal((await read(db,60,1)).response.body.readThroughSequence,1);
});
test('RESERVED retry cannot reaccept after worker cleans between candidate and community reads',async()=>{
 const db=adopted(),c=db.tables.get('lk_communities')[0];await send(db,1);await send(db,2);
 await read(db,62,1,{before(op){if(op.ctx.step==='project_write')return {skip:true,error:true};}});let injected=false;
 const retry=await read(db,62,1,{async before(op){if(op.ctx.step==='community'&&!injected){injected=true;await recoverStationMessageOutbox(db,{dryRun:false});await read(db,63,2);}}});
 assert.equal(retry.response.body.readThroughSequence,1);assert.equal(retry.response.body.outcome,'CONFIRMED');assert.equal(c.stationMembershipLifetime.players[0].readPosition.readThroughSequence,2);assert.deepEqual(c.communityMessageOutbox.intents,[]);
});

test('fresh candidate proof followed by concurrent original commit invalidates pinned acceptance CAS',async()=>{
 const db=adopted(),c=db.tables.get('lk_communities')[0];await send(db,1);await send(db,2);let injected=false,losingCas=false;
 const original=await read(db,64,1,{async before(op){if(op.ctx.step==='accept_write'&&!injected){injected=true;assert.equal((await read(db,64,1)).response.body.readThroughSequence,1);await read(db,65,2);}},after(op,result){if(op.ctx.step==='accept_write'){assert.equal(result.matchedCount,0);losingCas=true;}}});
 assert.equal(losingCas,true);assert.equal(original.response.body.outcome,'CONFIRMED');assert.equal(original.response.body.readThroughSequence,1);assert.equal(c.stationMembershipLifetime.players[0].readPosition.readThroughSequence,2);assert.deepEqual(c.communityMessageOutbox.intents,[]);
});
