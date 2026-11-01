import fs from 'node:fs';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { addTypedCommunityResponseRedaction } from './communityResponseRedaction.mjs';
import { stationLifetimeRuntimeSource } from './stationMembershipReceiverSource.mjs';
export const messageOwnerIds=Object.fromEntries(['router','messageFind','messageWrite','communityFind','communityWrite','eventFind','eventWrite','response','catch','legacyWrite','legacyAck','legacyCatch'].map(k=>[k,'station_message_owner_'+k+'_v1']));
export const messageOwnerRuntimeSource=()=>stationLifetimeRuntimeSource()+'\n'+fs.readFileSync(new URL('./stationMessageOwner.mjs',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replace(/^export /gm,'');
export function patchStationMessageOwner(bytes,{expectedFlowSha256,mongoClientId}){
  if(crypto.createHash('sha256').update(bytes).digest('hex')!==expectedFlowSha256)throw Error('MESSAGE_GRAPH_PREIMAGE');
  const flow=addTypedCommunityResponseRedaction(JSON.parse(bytes)),ids=new Set(Object.values(messageOwnerIds)),byId=new Map(flow.map(n=>[n.id,n]));
  const reserved=v=>typeof v==='string'?ids.has(v):v&&typeof v==='object'?Object.values(v).some(reserved):false;
  if(flow.some(reserved))throw Error('MESSAGE_GRAPH_RESERVED_REFERENCE');
  if(!flow.some(n=>n.id===mongoClientId&&n.type==='mongodb4-client'))throw Error('MESSAGE_MONGO_CLIENT_REQUIRED');
  for(const name of ['Apply community join','Apply invite join','Apply member management']){
    const roster=flow.filter(n=>n.type==='function'&&n.name===name&&n.d!==true);
    if(roster.length!==1||!roster[0].func.includes('STATION_LIFETIME_ROSTER_V1')||!roster[0].func.includes('COMMUNITY_ROSTER_COMMIT_BARRIER'))throw Error('MESSAGE_LIFETIME_WRITERS_REQUIRED');
  }
  const matches=flow.filter(n=>n.type==='function'&&n.name==='Build community chat docs'&&n.d!==true);
  if(matches.length!==1)throw Error('MESSAGE_SEND_WRITER_AMBIGUOUS');
  const writer=matches[0],wires=writer.wires;
  if(writer.outputs!==4||wires?.length!==4||!writer.func.includes('COMMUNITY_TYPED_ACCESS_GUARD'))throw Error('MESSAGE_SEND_AUTH_REQUIRED');
  const ingress=flow.filter(n=>n.type==='http in'&&n.method==='post'&&n.url==='/lk/communities/:communityId/messages');
  if(ingress.length!==1||ingress[0].wires?.[0]?.length!==1||!String(ingress[0].wires[0][0]).startsWith('community-policy-verified-actor-v1-entry-'))throw Error('MESSAGE_AUTH_INGRESS_REQUIRED');
  for(const port of [0,1]){
    if(wires[port].length!==1)throw Error('MESSAGE_SEND_STORE_DRIFT');
    const store=byId.get(wires[port][0]);
    if(store?.type!=='mongodb4'||store.clientNode!==mongoClientId||store.operation!=='insertOne'||store.collection!==(port===0?'lk_community_chat_messages':'lk_community_events')||store.wires?.some(g=>g.length))throw Error('MESSAGE_SEND_STORE_DRIFT');
    if(flow.some(n=>n.id!==writer.id&&((n.wires||[]).flat().includes(store.id)||(n.links||[]).includes(store.id))))throw Error('MESSAGE_LEGACY_STORE_BYPASS');
  }
  const create=flow.filter(n=>n.type==='function'&&n.name==='Build community create docs');
  const oldGuard="const protectedRow={$or:[{$ne:[{$type:'$stationMembershipLifetime'},'missing']},env.get('LK_STATION_MEMBERSHIP_LIFETIME_ENABLED')==='true'?{$eq:['$communityType','STATION']}:false]};";
  const newGuard="const protectedRow={$or:[{$ne:[{$type:'$communityMessageOutbox'},'missing']},{$eq:['$communityType','STATION']},{$ne:[{$type:'$stationMembershipLifetime'},'missing']},env.get('LK_STATION_MEMBERSHIP_LIFETIME_ENABLED')==='true'?{$eq:['$communityType','STATION']}:false]};";
  const markedGuard=oldGuard.replace('{$or:[',"{$or:[{$ne:[{$type:'$communityMessageOutbox'},'missing']},");
  if(create.length!==1||!create[0].func.includes('STATION_CREATE_COLLISION_V1')||(!create[0].func.includes(oldGuard)&&!create[0].func.includes(markedGuard)&&!create[0].func.includes(newGuard)))throw Error('MESSAGE_CREATE_GUARD_REQUIRED');
  create[0].func=create[0].func.replace(oldGuard,newGuard).replace(markedGuard,newGuard);
  const prepare=flow.filter(n=>n.type==='function'&&n.func?.includes('msg._communityChatPost = {'));
  if(prepare.length!==1)throw Error('MESSAGE_PREPARE_REQUIRED');
  if(!prepare[0].func.includes('requestId: body.requestId'))prepare[0].func=prepare[0].func.replace('msg._communityChatPost = {','msg._communityChatPost = {\n  requestId: body.requestId,');
  // The existing authenticated route is the only STATION writer; no alternate raw path survives.
  if(flow.some(n=>n.collection==='lk_community_chat_messages'&&!['find','findOne','aggregate','countDocuments'].includes(n.operation)&&n.id!==wires[0][0]))throw Error('MESSAGE_UNOWNED_MESSAGE_WRITER');
  const original=writer.func;
  writer.func=messageOwnerRuntimeSource()+String.raw`
const loaded=Array.isArray(msg.payload)?msg.payload[0]:null;
const adopted=loaded&&Object.prototype.hasOwnProperty.call(loaded,'communityMessageOutbox');
if(loaded?.communityType==='STATION'||adopted){
  const actor=msg._verifiedCommunityActor,ctx=msg._communityChatPost;
  if(!actor?.id||msg._communityPolicyAuthFailure){msg.statusCode=403;msg.payload={error:'COMMUNITY_AUTH_REQUIRED'};return [null,null,msg,null,null];}
  try{
    const header=msg.req?.headers?.['idempotency-key'],bodyId=ctx?.requestId;
    if(header&&bodyId&&header!==bodyId)throw Error('MESSAGE_REQUEST_ID_INVALID');
    msg._stationMessageOperation=beginStationMessage({communityId:ctx?.communityId,actor,requestId:header??bodyId,text:ctx?.text});
    return [null,null,null,null,msg];
  }catch{msg.statusCode=400;msg.payload={error:'COMMUNITY_MESSAGE_REQUEST_INVALID'};return [null,null,msg,null,null];}
}
`+'const legacy=(function(){\n'+original+'\n}).call(this);\n'+String.raw`
// COMMUNITY_LEGACY_MESSAGE_ACCEPTANCE_V1: retain original authorization and hold every effect.
if(!Array.isArray(legacy)||!legacy[0])return legacy;
if(!loaded||loaded._id===undefined||typeof loaded.id!=='string'||loaded.communityType==='STATION'||Object.prototype.hasOwnProperty.call(loaded,'communityMessageOutbox')){
  msg.statusCode=409;msg.payload={error:'COMMUNITY_MESSAGE_PREIMAGE_INVALID'};return [null,null,msg,null,null,null];
}
// Full BSON preimage binds every composed authorization input, including absent/null,
// owner/admin fields, policy and roster. Mongo rechecks this predicate atomically.
msg._legacyCommunityMessageDeferred=legacy;
msg.payload=[{_id:loaded._id,$expr:{$eq:['$$ROOT',{$literal:loaded}]}},{$set:{id:loaded.id}},{upsert:false,maxTimeMS:3000}];
return [null,null,null,null,null,msg];
`;

  writer.outputs=6;writer.wires=[...wires,[messageOwnerIds.router],[messageOwnerIds.legacyWrite]];
  writer.libs=[...(writer.libs||[]).filter(x=>x.var!=='nodeCrypto'),{var:'nodeCrypto',module:'crypto'}];
  const z=writer.z;
  const router=messageOwnerRuntimeSource()+String.raw`
const next=msg._stationMessageOperation||advanceStationMessage(msg._stationMessage,msg.payload,Boolean(msg.error));
delete msg._stationMessageOperation;delete msg.error;
if(next.response){delete msg._stationMessage;msg.statusCode=next.response.status;msg.payload=next.response.body;msg.headers={'Content-Type':'application/json','Cache-Control':'no-store'};return [null,null,null,null,null,null,msg];}
msg._stationMessage=next.ctx;msg.payload=next.args;
const stores=['lk_community_chat_messages','lk_communities','lk_community_events'];
const port=stores.indexOf(next.store)*2+(next.method==='find'?0:1),outputs=Array(7).fill(null);
if(port<0||port>5)throw Error('MESSAGE_OWNER_ROUTE_INVALID');outputs[port]=msg;return outputs;
`;
  flow.push({id:messageOwnerIds.router,type:'function',z,name:'Advance station message custody',func:router,libs:[{var:'nodeCrypto',module:'crypto'}],outputs:7,wires:['messageFind','messageWrite','communityFind','communityWrite','eventFind','eventWrite','response'].map(k=>[messageOwnerIds[k]])});
  for(const [prefix,collection] of [['message','lk_community_chat_messages'],['community','lk_communities'],['event','lk_community_events']])for(const [suffix,operation]of[['Find','find'],['Write','updateOne']])flow.push({id:messageOwnerIds[prefix+suffix],type:'mongodb4',z,collection,operation,clientNode:mongoClientId,mode:'collection',output:'toArray',handleDocId:false,maxTimeMS:'3000',wires:[[messageOwnerIds.router]]});
  flow.push({id:messageOwnerIds.legacyWrite,type:'mongodb4',z,collection:'lk_communities',operation:'updateOne',clientNode:mongoClientId,mode:'collection',output:'toArray',handleDocId:false,maxTimeMS:'3000',wires:[[messageOwnerIds.legacyAck]]},
    {id:messageOwnerIds.legacyAck,type:'function',z,name:'Confirm legacy community message acceptance',outputs:4,wires,func:String.raw`
const deferred=msg._legacyCommunityMessageDeferred;
delete msg._legacyCommunityMessageDeferred;
const accepted=!msg.error&&msg.payload?.acknowledged===true&&msg.payload?.matchedCount===1;
if(!accepted||!Array.isArray(deferred)||deferred.length!==4){
  const status=!msg.error&&msg.payload?.acknowledged===true&&msg.payload?.matchedCount===0?409:503;
  delete msg.error;delete msg.query;delete msg._communityChatPost;
  msg.statusCode=status;msg.headers={'Content-Type':'application/json','Cache-Control':'no-store'};
  msg.payload={error:status===409?'COMMUNITY_MESSAGE_ACCESS_CHANGED':'COMMUNITY_MESSAGE_ACCEPTANCE_UNPROVEN'};
  return [null,null,msg,null];
}
for(const group of deferred)for(const item of Array.isArray(group)?group:[group])if(item)delete item._legacyCommunityMessageDeferred;
return deferred;
`},
    {id:messageOwnerIds.legacyCatch,type:'catch',z,scope:[messageOwnerIds.legacyWrite],uncaught:false,wires:[[messageOwnerIds.legacyAck]]});
  flow.push({id:messageOwnerIds.response,type:'http response',z,wires:[]},{id:messageOwnerIds.catch,type:'catch',z,scope:['messageFind','messageWrite','communityFind','communityWrite','eventFind','eventWrite'].map(k=>messageOwnerIds[k]),uncaught:false,wires:[[messageOwnerIds.router]]});
  if(new Set(flow.map(n=>n.id)).size!==flow.length)throw Error('MESSAGE_GRAPH_DUPLICATE_ID');
  const allIds=new Set(flow.map(n=>n.id));
  for(const n of flow)for(const target of [...(n.wires||[]).flat(),...(n.links||[]),...(Array.isArray(n.scope)?n.scope:[])])if(!allIds.has(target))throw Error('MESSAGE_GRAPH_DANGLING_REFERENCE');
  for(const n of flow)if(n.type==='function')new vm.Script('(function(msg,env,nodeCrypto){'+n.func+'\n})');
  return flow;
}
