import test from 'node:test';
import assert from 'node:assert/strict';
import {historyGraph,historyEvaluate,historyCommunity,historyMessage} from './helpers/stationHistoryHarness.mjs';
import {historyNodeIds} from '../lib/stationMessageHistorySource.mjs';
import {stationStreamAdoptionPlan} from '../lib/stationMessageStream.mjs';
import {smTransition} from '../lib/stationMembershipLifetime.mjs';
const streamId='00000000-0000-4000-8000-000000000090';
function fixture(){const c=historyCommunity();Object.assign(c,stationStreamAdoptionPlan(c,streamId).update.$set);c.communityMessageOutbox.acceptedSequence=4;c.communityMessageOutbox.publishedSequence=4;const rows=[1,2,3,4].map(i=>({...historyMessage(i,5000-i),recordType:'MESSAGE',streamId,sequence:i,authorId:i===3?'actor':'other'}));return {c,rows};}
function history({query={historyVersion:'3',limit:'2'},mutate,counts=[{_id:'community',unreadCount:3}],changeRows}={}){
 const flow=historyGraph(),{c,rows}=fixture(),msg={req:{method:'GET',params:{communityId:'community'},query,headers:{}},_verifiedCommunityActor:{id:'actor'}};
 let out=historyEvaluate(flow,'prepare',msg);if(!out[0])return out[1];msg.payload=[c];out=historyEvaluate(flow,'query',msg);if(!out[3])return out[1];
 const bound=msg._stationHistory.request;
 assert.deepEqual(msg.payload[1].sort,{sequence:1});assert.equal(msg.payload[1].limit,Number(query.limit||50));
 msg.payload=changeRows?changeRows(rows):rows.filter(r=>r.sequence>bound.afterSequence&&r.sequence<=bound.throughSequence).slice(0,bound.limit);
 out=historyEvaluate(flow,historyNodeIds.router,msg);if(out[2])return out[2];assert.ok(out[3]);assert.equal(msg.payload[0][0].$match.authorId.$ne,'actor');
 msg.payload=counts;out=historyEvaluate(flow,historyNodeIds.router,msg);if(out[2])return out[2];assert.ok(out[1]);if(mutate)mutate(c);msg.payload=[c];out=historyEvaluate(flow,historyNodeIds.router,msg);return out[2];
}
test('actual v3 graph latest ascending sequence is independent of reserved timestamp and counts exclude own',()=>{
 const result=history();assert.equal(result.statusCode,200);assert.deepEqual(result.payload.messages.map(m=>m.sequence),[3,4]);assert.equal(result.payload.unreadCount,3);assert.equal(result.payload.afterSequence,2);assert.equal(result.payload.throughSequence,4);assert.equal(result.payload.publishedThroughSequence,4);
 const older=history({query:{historyVersion:'3',limit:'2',streamId,membershipEpoch:'0',afterSequence:'0',throughSequence:'2'}});assert.deepEqual(older.payload.messages.map(m=>m.sequence),[1,2]);assert.equal(older.payload.publishedThroughSequence,4);assert.equal(older.payload.throughSequence,2);
});
test('graph fails closed on epoch/read/frontier/identity drift, holes and forged cursors',()=>{
 for(const mutate of [c=>c._id='replacement',c=>c.stationMembershipLifetime.players[0].readPosition.readThroughSequence=1,c=>{c.communityMessageOutbox.publishedSequence=5;c.communityMessageOutbox.acceptedSequence=5;},c=>{c.stationMembershipLifetime=smTransition(c,'actor','LEFT');c.members=[];}])assert.notEqual(history({mutate}).statusCode,200);
 assert.equal(history({changeRows:rows=>[rows[3]]}).statusCode,503);
 assert.equal(history({query:{historyVersion:'3',afterSequence:'0'}}).statusCode,400);
 assert.equal(history({query:{historyVersion:'3',streamId,membershipEpoch:'1',afterSequence:'0'}}).statusCode,503);
 assert.equal(history({counts:[{_id:'foreign',unreadCount:0}]}).statusCode,503);
});
function summaries({rows,body={communityIds:['community']},actor={id:'actor'},counts=[],mutate}={}){
 const flow=historyGraph(),msg={req:{method:'POST',query:{},headers:{'x-padlhub-community-stream-contract':'station-stream.v1'}},payload:body,_verifiedCommunityActor:actor};
 let out=historyEvaluate(flow,historyNodeIds.summariesBegin,msg);if(out[1])return out[1];
 const c=rows??[fixture().c];msg.payload=c;out=historyEvaluate(flow,historyNodeIds.summariesRouter,msg);if(out[2])return out[2];assert.ok(out[1]);assert.equal(msg.payload[1].maxTimeMS,3000);
 msg.payload=counts;out=historyEvaluate(flow,historyNodeIds.summariesRouter,msg);if(out[2])return out[2];assert.ok(out[0]);if(mutate)mutate(c);msg.payload=c;out=historyEvaluate(flow,historyNodeIds.summariesRouter,msg);return out[2];
}
test('readonly batch distinguishes authorized unadopted/nonstation, never conflates missing or malformed with zero',()=>{
 assert.equal(summaries({counts:[{_id:'community',unreadCount:3}]}).payload.items[0].unreadCount,3);
 assert.deepEqual(summaries({rows:[historyCommunity()]}).payload.items,[{communityId:'community',availability:'UNADOPTED'}]);
 assert.deepEqual(summaries({rows:[{...historyCommunity(),communityType:'FRIENDS'}]}).payload.items,[{communityId:'community',availability:'NOT_STATION'}]);
 assert.equal(summaries({rows:[]}).statusCode,403);assert.equal(summaries({actor:{id:'foreign'}}).statusCode,403);
 assert.equal(summaries({body:{communityIds:['community','community']}}).statusCode,400);assert.equal(summaries({body:{communityIds:['community'],actorId:'actor'}}).statusCode,400);
 assert.equal(summaries({rows:[{...historyCommunity(),communityMessageOutbox:null}]}).statusCode,503);
 assert.equal(summaries({mutate:rows=>rows[0].stationMembershipLifetime.players[0].readPosition.readThroughSequence=1}).statusCode,503);
});
test('legacy query and renderer exclude READ_COMMAND even with forged visible flags',()=>{
 const flow=historyGraph(),msg={req:{method:'GET',params:{communityId:'community'},query:{},headers:{}},_verifiedCommunityActor:{id:'actor'}};
 historyEvaluate(flow,'prepare',msg);msg.payload=[historyCommunity()];const out=historyEvaluate(flow,'query',msg);assert.ok(out[0]);assert.deepEqual(msg.payload.recordType,{$ne:'READ_COMMAND'});
 msg.payload=[{...historyMessage(1),recordType:'READ_COMMAND',text:'must not leak'}];const rendered=historyEvaluate(flow,'render',msg);assert.equal(JSON.stringify(rendered).includes('must not leak'),false);
 for(const node of flow.filter(n=>n.id.startsWith('station_history_v2_')&&n.type==='mongodb4'))assert.ok(['find','aggregate'].includes(node.operation));
});

test('ARCHIVE is separate unsequenced history with current epoch state and no STREAM range fields',()=>{
 const flow=historyGraph(),{c}=fixture(),msg={req:{method:'GET',params:{communityId:'community'},query:{historyVersion:'3',mode:'ARCHIVE',limit:'2',streamId,membershipEpoch:'0'},headers:{}},_verifiedCommunityActor:{id:'actor'}};
 historyEvaluate(flow,'prepare',msg);msg.payload=[c];let out=historyEvaluate(flow,'query',msg);assert.ok(out[3]);assert.deepEqual(msg.payload[0].streamId,{$exists:false});assert.deepEqual(msg.payload[0].recordType,{$ne:'READ_COMMAND'});
 msg.payload=[historyMessage(2)];out=historyEvaluate(flow,historyNodeIds.router,msg);assert.ok(out[0]);assert.deepEqual(msg.payload[0].streamId,{$exists:false});
 msg.payload=[];out=historyEvaluate(flow,historyNodeIds.router,msg);assert.ok(out[3]);msg.payload=[{_id:'community',unreadCount:3}];out=historyEvaluate(flow,historyNodeIds.router,msg);assert.ok(out[1]);msg.payload=[c];out=historyEvaluate(flow,historyNodeIds.router,msg);
 assert.equal(out[2].statusCode,200);const body=out[2].payload;assert.equal(body.mode,'ARCHIVE');assert.equal(body.messages[0].sequence,null);assert.equal(body.publishedThroughSequence,4);for(const key of ['afterSequence','throughSequence','nextAfterSequence'])assert.equal(key in body,false);
});
