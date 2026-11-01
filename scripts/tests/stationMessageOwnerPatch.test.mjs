import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {patchStationMessageOwner,messageOwnerIds} from '../lib/stationMessageOwnerSource.mjs';
import {addCommunityPolicyAuth} from '../lib/communityPolicyAuth.mjs';
import {protectStationCreate} from '../lib/stationMembershipCreateGuard.mjs';
import {sanitizeTypedCommunityPayload,addTypedCommunityResponseRedaction} from '../lib/communityResponseRedaction.mjs';
import {messageDb,uid} from './helpers/stationMessageHarness.mjs';
import {runStationMessage} from '../lib/stationMessageOwner.mjs';
const source=fs.readFileSync('scripts/patch_nodered_communities_flow.mjs','utf8');
const common=source.split('const commonHelpers = String.raw`')[1].split('\n`;')[0];
const fn=name=>common+source.split('const '+name+' = `${commonHelpers}')[1].split('\n`;')[0];
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
function base(){return protectStationCreate(addCommunityPolicyAuth([
 ...['Apply community join','Apply invite join','Apply member management'].map((name,i)=>({id:'roster'+i,type:'function',name,func:'// STATION_LIFETIME_ROSTER_V1 COMMUNITY_ROSTER_COMMIT_BARRIER\nreturn msg;',wires:[]})),
 {id:'tab',type:'tab'},{id:'mongo',type:'mongodb4-client'},{id:'response',type:'http response',wires:[]},
 {id:'entry',type:'http in',method:'post',url:'/lk/communities/:communityId/messages',wires:[['prepare']]},
 {id:'prepare',type:'function',name:'Prepare community chat',func:fn('fnChatPostPrepare'),wires:[['writer']]},
 {id:'writer',type:'function',z:'tab',name:'Build community chat docs',func:fn('fnChatPostApply'),outputs:4,wires:[['messages'],['events'],['response'],[]]},
 ...['messages','events'].map((id,i)=>({id,type:'mongodb4',clientNode:'mongo',collection:i?'lk_community_events':'lk_community_chat_messages',operation:'insertOne',wires:[]})),
 {id:'create',type:'function',z:'tab',name:'Build community create docs',func:fn('fnCreate'),outputs:6,wires:[['createStore'],[],[],[],['response'],[]]},
 {id:'createStore',type:'mongodb4',clientNode:'mongo',collection:'lk_communities',operation:'updateOne',wires:[]}
]),{createWrite:'createWrite',createAck:'createAck',createCatch:'createCatch'},'mongo');}
const patch=flow=>{const bytes=JSON.stringify(flow);return patchStationMessageOwner(bytes,{expectedFlowSha256:digest(bytes),mongoClientId:'mongo'});};
const evaluate=(flow,id,msg,flag='true')=>new Function('msg','env','nodeCrypto',flow.find(n=>n.id===id).func)(msg,{get:()=>flag},crypto);
test('actual old no-key and keyed send share owner; body cannot impersonate verified actor',async()=>{
 const graph=patch(addTypedCommunityResponseRedaction(base())),db=messageDb(),c=db.tables.get('lk_communities')[0];
 for(const requestId of [undefined,uid(40)]){
  const msg={payload:[c],_verifiedCommunityActor:{id:'player-a'},_communityChatPost:{communityId:c.id,member:{id:'intruder'},text:'synthetic',requestId},req:{headers:{}}};
  const output=evaluate(graph,'writer',msg);assert.ok(output[4]);assert.equal(output[0],null);assert.equal(output[2],null);
  const result=await runStationMessage(db,output[4]._stationMessageOperation);assert.equal(result.response.status,200);assert.equal(result.response.body.message.authorId,'player-a');
 }
 const bad=evaluate(graph,'writer',{payload:[c],_communityChatPost:{communityId:c.id,text:'x'},req:{headers:{}}});assert.equal(bad[2].statusCode,403);
 assert.equal(evaluate(graph,'writer',{payload:[c],_verifiedCommunityActor:{id:'player-a'},_communityChatPost:{communityId:c.id,text:'x'},req:{headers:{}}},'false')[0],null);
});
test('graph denies reserved references, other legacy ingress, wrong Mongo client and missing create protection',()=>{
 for(const mutate of [f=>f.push({id:'bad',type:'link out',links:[messageOwnerIds.communityWrite]}),f=>f.push({id:'bad',wires:[['messages']]}),f=>f.find(n=>n.id==='messages').clientNode='foreign',f=>f.find(n=>n.id==='create').func='return msg;',f=>f.push({id:'unowned',type:'mongodb4',collection:'lk_community_chat_messages',operation:'insertOne',wires:[]})])assert.throws(()=>patch(mutateGraph(mutate)));
 function mutateGraph(mutate){const f=base();mutate(f);return f;}
});
test('private outbox never enters public JSON; pending candidate rejected by actual legacy reader',()=>{
 const publicRow=sanitizeTypedCommunityPayload({communityType:'FRIENDS',communityMessageOutbox:[{message:{text:'private'}}],stationMessageEvent:{text:'private'}});assert.deepEqual(publicRow,{communityType:'FRIENDS'});
 const get=new Function('msg',fn('fnChatGetResponse'));
 const result=get({payload:[{stationMessageOwner:1,state:'RESERVED',id:uid(1),communityId:'station-community',text:'candidate',createdTs:1}],_communityChatGet:{communityId:'station-community'}});
 assert.equal(JSON.stringify(result).includes('candidate'),false);
});

test('actual composed legacy authorization is bound to entire BSON preimage before any output',()=>{
 const graph=patch(base()),community={_id:'legacy-id',id:'legacy',communityType:'FRIENDS',members:[{id:'player-a'}],bannedMembers:[],typeSettingsRevision:1,ownerId:'owner',admins:['admin']};
 const prepare=()=>evaluate(graph,'writer',{payload:[structuredClone(community)],_communityChatPost:{communityId:community.id,member:{id:'player-a'},text:'private-original'},req:{method:'POST',headers:{}}});
 const transformed=graph.find(n=>n.id==='writer').func;assert.ok(transformed.includes('const policyAuthFailure = msg._communityPolicyAuthFailure;'));
 const corporate={...community,communityType:'CORPORATE'};
 const anonymous=evaluate(graph,'writer',{payload:[corporate],_communityChatPost:{communityId:community.id,member:{id:'player-a'},text:'private-original'},req:{method:'POST',headers:{}}});assert.equal(anonymous[2].statusCode,403);assert.equal(anonymous[0],null);
 const verified=evaluate(graph,'writer',{payload:[corporate],_verifiedCommunityActor:{id:'player-a'},_communityChatPost:{communityId:community.id,member:{id:'intruder'},text:'private-original'},req:{method:'POST',headers:{}}});assert.ok(verified[5]);assert.equal(verified[5]._legacyCommunityMessageDeferred[0].payload.authorId,'player-a');
 const held=prepare();assert.ok(held[5]);assert.ok(held.slice(0,5).every(v=>v===null));
 const [query,update,options]=held[5].payload;assert.deepEqual(query.$expr,{$eq:['$$ROOT',{$literal:community}]});assert.deepEqual(update,{$set:{id:community.id}});assert.equal(options.upsert,false);
 for(const change of [c=>{c.communityType='STATION';c.typeSettingsRevision++;},c=>{c.members=[];c.bannedMembers=[{id:'player-a'}];},c=>{c.ownerId='different';},c=>{c.admins=[];},c=>{c.visibility=null;}]){
  const current=structuredClone(community);change(current);assert.notDeepEqual(current,query.$expr.$eq[1].$literal);
  const blocked=evaluate(graph,messageOwnerIds.legacyAck,{...prepare()[5],payload:{acknowledged:true,matchedCount:0}});assert.equal(blocked[2].statusCode,409);assert.equal(blocked[0],null);assert.equal(blocked[1],null);assert.equal(blocked[3],null);assert.equal(JSON.stringify(blocked[2].payload).includes('private-original'),false);
 }
 // ACK proves acceptance before the subsequent type/ban transition; release the original docs.
 const accepted=prepare()[5];accepted.payload={acknowledged:true,matchedCount:1,modifiedCount:0};community.communityType='STATION';community.members=[];
 const released=evaluate(graph,messageOwnerIds.legacyAck,accepted);assert.equal(released[2].statusCode,200);assert.equal(released[0].payload.text,'private-original');
 for(const payload of [null,{acknowledged:false,matchedCount:1},{acknowledged:true,matchedCount:'1'},{acknowledged:true}]){
  const failed=evaluate(graph,messageOwnerIds.legacyAck,{...held[5],payload});assert.equal(failed[2].statusCode,503);assert.equal(failed[3],null);
 }
});
