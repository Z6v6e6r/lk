import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import util from 'node:util';
import vm from 'node:vm';
import { stationStreamAdoptionPlan } from '../lib/stationMessageStream.mjs';
import { historyRuntimeSource } from '../lib/stationMessageHistorySource.mjs';
import { stationPhotoNodes } from '../lib/stationChatPhotosSource.mjs';
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
test('new versioned routes are absent from old graph and reuse exact verified auth without legacy ingress',async()=>{
 const old=base();assert.equal(old.some(n=>n.type==='http in'&&n.url.includes('message-requests')),false);
 const graph=patch(old),db=messageDb(),headers={'x-padlhub-community-message-contract':'station-message.v1'};
 for(const mode of ['canonical','status']){
  const route=graph.find(n=>n.id===messageOwnerIds[mode+'In']);assert.equal(route.method,mode==='status'?'get':'post');assert.deepEqual(route.wires,[[messageOwnerIds[mode+'Auth']]]);
  assert.equal(graph.find(n=>n.id===messageOwnerIds[mode+'Auth']).type,'subflow:community-policy-verified-actor-v1');
 }
 const sendMessage={req:{headers,params:{communityId:'station-community'},query:{}},payload:{requestId:uid(66),text:'Canonical'},_verifiedCommunityActor:{id:'player-a'}};
 const send=evaluate(graph,messageOwnerIds.canonicalBegin,structuredClone(sendMessage));assert.ok(send[0]);assert.equal(send[0]._stationMessageOperation.ctx.requiredContract,true);const receipt=await runStationMessage(db,send[0]._stationMessageOperation);assert.equal(receipt.response.body.outcome,'CONFIRMED');
 const read=evaluate(graph,messageOwnerIds.statusBegin,{req:{headers,params:{communityId:'station-community',requestId:uid(66)},query:{}},_verifiedCommunityActor:{id:'player-a'}});assert.equal(read[0]._stationMessageOperation.ctx.statusOnly,true);
 const status=await runStationMessage(db,read[0]._stationMessageOperation,{before(op){assert.equal(op.method,'find');}});assert.deepEqual(status.response.body,receipt.response.body);
 const changed=structuredClone(sendMessage);changed.payload.requestId=uid(67);db.tables.get('lk_communities')[0].communityType='FRIENDS';const forced=evaluate(graph,messageOwnerIds.canonicalBegin,changed);assert.ok(forced[0]);assert.equal((await runStationMessage(db,forced[0]._stationMessageOperation)).response.status,403);
});
test('new route protocol rejects missing/wrong version, actor spoofing, malformed body/key and route shadows',()=>{
 const graph=patch(base());
 const message=()=>({req:{headers:{'x-padlhub-community-message-contract':'station-message.v1'},params:{communityId:'station-community'},query:{}},payload:{requestId:uid(70),text:'Canonical'},_verifiedCommunityActor:{id:'player-a'}});
 for(const change of [m=>{delete m.req.headers['x-padlhub-community-message-contract'];},m=>{m.req.headers['x-padlhub-community-message-contract']='station-message.v2';},m=>{m.payload.member={id:'other'};},m=>{delete m.payload.requestId;},m=>{m.payload.requestId='bad';},m=>{m.payload.text=' '.repeat(8000)+'x';},m=>{m.req.query.actor='other';}]){
  const msg=message();change(msg);const result=evaluate(graph,messageOwnerIds.canonicalBegin,msg);assert.equal(result[0],null);assert.equal(result[1].statusCode,400);assert.equal(result[1].payload.outcome,'UNKNOWN');assert.equal(result[1]._stationMessageOperation,undefined);
 }
 const spoof=message();delete spoof.req.headers.authorization;const auth=evaluate(graph,'community-policy-verified-actor-v1-prepare',spoof);assert.equal(auth[1]._verifiedCommunityActor,undefined);assert.equal(evaluate(graph,messageOwnerIds.canonicalBegin,auth[1])[1].statusCode,403);
 const denied=message();delete denied._verifiedCommunityActor;const result=evaluate(graph,messageOwnerIds.canonicalBegin,denied);assert.equal(result[1].statusCode,403);assert.equal(result[1].payload.message,undefined);
 for(const url of ['/lk/communities/:communityId/message-requests','/lk/communities/:communityId/:resource','/lk/*','/*']){const flow=base();flow.push({id:'shadow',type:'http in',method:'post',url,wires:[['prepare']]});assert.throws(()=>patch(flow),/ROUTE_(COLLISION|SHADOWED)/);}
 const bypass=base();bypass.push({id:'old-link',type:'link out',links:[messageOwnerIds.statusBegin]});assert.throws(()=>patch(bypass),/RESERVED_REFERENCE/);
 const authDrift=base();authDrift.find(n=>n.id==='community-policy-verified-actor-v1-response').func='msg._verifiedCommunityActor=msg.payload;return msg;';assert.throws(()=>patch(authDrift),/AUTH_SUBFLOW_DRIFT/);
 const get={req:{headers:{'x-padlhub-community-message-contract':'station-message.v1'},params:{communityId:'station-community',requestId:uid(70)},query:{}},payload:{text:'no body'},_verifiedCommunityActor:{id:'player-a'}};assert.equal(evaluate(graph,messageOwnerIds.statusBegin,get)[1].statusCode,400);
});

test('actual READ route uses verified actor and exact body; GET is find-only with immutable original receipt',async()=>{
 const {stationStreamAdoptionPlan}=await import('../lib/stationMessageStream.mjs');const {runStationRead}=await import('../lib/stationMessageRead.mjs');
 const graph=patch(base()),db=messageDb(),c=db.tables.get('lk_communities')[0];Object.assign(c,stationStreamAdoptionPlan(c,uid(90)).update.$set);
 const body={requestId:uid(80),streamId:uid(90),membershipEpoch:0,throughSequence:0};
 const make=()=>({req:{params:{communityId:c.id},query:{},headers:{'x-padlhub-community-read-contract':'station-read.v1'}},payload:body,_verifiedCommunityActor:{id:'player-a'}});
 const started=evaluate(graph,messageOwnerIds.readBegin,make());assert.ok(started[0]);const result=await runStationRead(db,started[0]._stationMessageOperation);assert.equal(result.response.body.outcome,'CONFIRMED');
 const msg=make();msg.payload=undefined;msg.req.params.requestId=body.requestId;const status=evaluate(graph,messageOwnerIds.readStatusBegin,msg);assert.ok(status[0]);assert.deepEqual((await runStationRead(db,status[0]._stationMessageOperation,{before(op){assert.equal(op.method,'find');}})).response.body,result.response.body);
 for(const mutate of [m=>delete m._verifiedCommunityActor,m=>m.payload={...body,actorId:'player-a'},m=>m.payload={...body,membershipEpoch:'0'},m=>m.payload={...body,requestId:body.requestId+'\n'},m=>m.req.query={phone:'forged'},m=>m.req.headers={}]){const bad=make();mutate(bad);const denied=evaluate(graph,messageOwnerIds.readBegin,bad);assert.equal(denied[0],null);assert.equal(denied[1].payload.outcome,'UNKNOWN');}
 assert.equal(db.tables.get('lk_community_events')?.length||0,0);
});

test('opt-in graph protects the photo routes and returns only an attachment marker in history', async () => {
 const fixture = base();
 const photos = stationPhotoNodes;
 fixture.push(
   {id:'historyRead',type:'mongodb4',clientNode:'mongo',collection:'lk_community_chat_messages',operation:'find',wires:[['render']]},
   {id:'query',type:'function',z:'tab',name:'Build community chat query',func:historyRuntimeSource()+'\nreturn (function(){'+fn('fnChatGetQuery')+'\n})();',outputs:3,wires:[['historyRead'],['response'],[]]},
   {id:'render',type:'function',z:'tab',name:'Build community chat response',func:fn('fnChatGetResponse'),outputs:2,wires:[['response'],[]]},
 );
 const compose = flow => {
   const bytes=JSON.stringify(flow);
   return patchStationMessageOwner(bytes,{expectedFlowSha256:digest(bytes),mongoClientId:'mongo',stationPhotos:true});
 };
 const graph = compose(fixture);
 const db = messageDb(), community = db.tables.get('lk_communities')[0];
 Object.assign(community, stationStreamAdoptionPlan(community, uid(82)).update.$set);
 const jpeg = Buffer.from([255,216,255,217]);
 const raw = {req:{params:{communityId:community.id},query:{}},payload:{requestId:uid(80),caption:'',jpeg:jpeg.toString('base64')}};
 const actor = {id:'player-a'};
 const config = {LK_STATION_CHAT_PHOTO_BUCKET:'fixture',LK_STATION_CHAT_PHOTO_REGION:'fixture',LK_STATION_CHAT_PHOTO_ACCESS_KEY:'fixture',LK_STATION_CHAT_PHOTO_SECRET_KEY:'fixture',LK_STATION_CHAT_PHOTO_SEND_ENABLED:'true'};
 const contexts = new Map();
 const image = {metadata:async()=>({format:'jpeg',width:1,height:1}),rotate:()=>image,jpeg:()=>image,toBuffer:async()=>jpeg};
 const objects = new Map();
 let reads=0;
 class S3Client {
   async send(command) {
     if (command instanceof sdk.PutObjectCommand) { objects.set(command.input.Key, command.input.Body); return {}; }
     reads++;
     const bytes=objects.get(command.input.Key);
     return {ContentType:'image/jpeg',ContentLength:bytes.length,Body:Readable.from([bytes])};
   }
   destroy() {}
 }
 const sdk={S3Client,PutObjectCommand:class {constructor(input){this.input=input;}},GetObjectCommand:class {constructor(input){this.input=input;}}};
 const exec = (id,msg) => {
   const node = graph.find(node=>node.id===id);
   if(!contexts.has(id))contexts.set(id,new Map());
   const sandbox={msg,env:{get:k=>config[k]},nodeCrypto:crypto,sharp:()=>image,s3:sdk,context:contexts.get(id),Buffer,util};
   return vm.runInNewContext('(function(){\n'+node.func+'\n})()',sandbox);
 };
 assert.equal(exec(photos.prepare,structuredClone(raw))[1].statusCode,403);
 assert.deepEqual(graph.find(n=>n.id===photos.post).wires,[['community-policy-verified-actor-v1-entry-'+photos.post]]);
 assert.throws(()=>compose([...fixture,{id:'shadow',type:'http in',method:'get',url:'/lk/communities/:x/message-photos/:id',wires:[['query']]}]),/ROUTE_COLLISION/);
 const prepared = (await exec(photos.prepare,{...raw,_verifiedCommunityActor:actor}))[0];
 const stores = ['lk_community_chat_messages','lk_communities','lk_community_events'];
 let owner = exec(messageOwnerIds.router,prepared);
 for(let n=0; !owner[6] && n<40; n++){
   const port=owner.findIndex(Boolean), msg=owner[port];
   if(port===7)owner=exec(messageOwnerIds.router,await exec(photos.put,msg));
   else {
     const store=db.collection(stores[Math.floor(port/2)]);
     msg.payload=port%2 ? await store.updateOne(...msg.payload) : await store.find(...msg.payload).toArray();
     owner=exec(messageOwnerIds.router,msg);
   }
 }
 assert.equal(owner[6].statusCode,200);
 const { message } = owner[6].payload;
 const saved=db.tables.get(stores[0])[0];
 const query=exec('query',{req:{method:'GET'},payload:[community],_communityChat:{communityId:community.id},_verifiedCommunityActor:actor})[0];
 query.payload=[saved];
 const history=exec('render',query)[0].payload;
 assert.equal(history.stationPhotoSendEnabled,true);
 assert.equal(history.messages[0].photo.hasCaption,false);
 assert.equal(JSON.stringify(history).includes(saved.photo.sha256),false);
 config.LK_STATION_CHAT_PHOTO_SEND_ENABLED='false';
 assert.equal(exec(photos.prepare,{...raw,_verifiedCommunityActor:actor})[1].statusCode,503);
 const queryOff=exec('query',{req:{method:'GET'},payload:[community],_communityChat:{communityId:community.id},_verifiedCommunityActor:actor})[0];
 queryOff.payload=[saved];
 assert.equal(exec('render',queryOff)[0].payload.stationPhotoSendEnabled,undefined);
 async function open(viewer, {skipEvent=false,revokeBeforeReply=false} = {}){
   let out=exec(photos.read,{req:{params:{communityId:community.id,messageId:message.id}},_verifiedCommunityActor:viewer});
   for(let n=0;!out[3]&&n<8;n++){
     const port=out.findIndex(Boolean),msg=out[port];
     if(revokeBeforeReply&&msg._stationPhotoRead.step==='finalAccess')db.tables.get(stores[1])[0].members=[];
     msg.payload=skipEvent&&port===2?[]:await db.collection(stores[port]).find(...msg.payload).toArray();
     out=await exec(photos.read,msg);
   }
   return out[3];
 }
 assert.equal((await open({id:'outsider'})).statusCode,404);
 assert.equal((await open(actor,{skipEvent:true})).statusCode,404);
 assert.equal(reads,0);
 const opened=await open(actor);
 assert.equal(opened.statusCode,200);
 assert.equal(opened.headers['Cache-Control'],'private, no-store');
 assert.deepEqual(opened.payload,jpeg);
 assert.equal((await open(actor,{revokeBeforeReply:true})).statusCode,404);
 assert.equal(reads,2);
});
