import { smId, smUuid, smHash, smEqual, smKeys, smMongoIdentity, smPlayer, smLifetime, smFence, smReadPosition, smSequence } from './stationMembershipLifetime.mjs';
import { stationReadBody, stationStreamEnvelope, stationStreamAppend, stationStreamReceiptDigest } from './stationMessageStream.mjs';
import { historyActorAllowed } from './stationMessageHistory.mjs';

const srMessages='lk_community_chat_messages',srCommunities='lk_communities';
const srKey=(actorId,requestId)=>'station-read:v1:'+smHash('station-read-key:v1',{tenant:'iSkq6G',actorId,requestId}).slice(7);
const srOp=(ctx,step,store,method,...args)=>{ctx.step=step;return {ctx,store,method,args};};
const srCandidate=(ctx,step='candidate')=>srOp(ctx,step,srMessages,'find',{_id:ctx.key},{limit:2,maxTimeMS:3000});
const srCommunity=(ctx,step='community')=>srOp(ctx,step,srCommunities,'find',{id:ctx.communityId},{limit:2,maxTimeMS:3000});
const srUnknown=(ctx,status,code)=>({ctx,response:{status,body:{contractVersion:1,contract:'station-read',requestId:smUuid(ctx.requestId)?ctx.requestId:null,outcome:'UNKNOWN',code}}});
const srBinding=(ctx,body)=>({communityId:ctx.communityId,actorId:ctx.actorId,...body});
const srSame=(ctx,row)=>row&&row._id===ctx.key&&row.stationMessageOwner===1&&row.recordType==='READ_COMMAND'&&row.archived===true&&row.actorId===ctx.actorId&&row.communityId===ctx.communityId&&row.requestId===ctx.requestId&&stationReadBody(row.body)&&row.body.requestId===ctx.requestId&&row.requestHash===smHash('station-read-request:v1',srBinding(ctx,row.body))&&(!ctx.requestHash||ctx.requestHash===row.requestHash);
function srProof(ctx,row){
  if(!srSame(ctx,row)||row.state!=='COMMITTED')return false;
  const r=row.receipt;
  return smKeys(r,['contractVersion','contract','requestId','outcome','streamId','membershipEpoch','throughSequence','readThroughSequence'])&&r.contractVersion===1&&r.contract==='station-read'&&r.outcome==='CONFIRMED'&&r.requestId===row.requestId&&r.streamId===row.body.streamId&&r.membershipEpoch===row.body.membershipEpoch&&r.throughSequence===row.body.throughSequence&&smSequence(r.readThroughSequence)&&r.readThroughSequence>=r.throughSequence&&row.receiptSha256===stationStreamReceiptDigest(r);
}
export function beginStationRead({communityId,actor,body,requestId,statusOnly=false}){
  if(!smId(communityId)||/[\r\n]/.test(communityId)||!smId(actor?.id)||/[\r\n]/.test(actor.id)||!(statusOnly?(smUuid(requestId)&&requestId.length===36):stationReadBody(body)))throw Error('READ_REQUEST_INVALID');
  const id=statusOnly?requestId:body.requestId;
  const ctx={readCommand:true,communityId,actorId:actor.id,requestId:id,key:srKey(actor.id,id),statusOnly,retries:0,...(!statusOnly?{body:structuredClone(body)}:{})};
  if(!statusOnly)ctx.requestHash=smHash('station-read-request:v1',srBinding(ctx,body));
  return srCandidate(ctx);
}
function srProject(ctx){
  const i=ctx.intent,d=ctx.candidate;
  if(!srSame(ctx,d)||i.kind!=='READ_COMMAND'||i.id!==ctx.key||i.actorId!==ctx.actorId||i.communityId!==ctx.communityId||i.requestId!==ctx.requestId||i.streamId!==d.body.streamId||i.epoch!==d.body.membershipEpoch||i.requestHash!==d.requestHash||!smEqual(i.communityIdentity,d.communityIdentity)||!smEqual(i.body,d.body)||!srProof(ctx,{...d,state:'COMMITTED',receipt:i.receipt,receiptSha256:i.receiptSha256}))throw Error('READ_RECEIPT_UNPROVEN');
  return srOp(ctx,'project_write',srMessages,'updateOne',{_id:d._id,state:'RESERVED',recordType:'READ_COMMAND',archived:true,requestHash:d.requestHash},{$set:{state:'COMMITTED',receipt:i.receipt,receiptSha256:i.receiptSha256}},{upsert:false,maxTimeMS:3000});
}
function srAccept(ctx,d){
  const stream=stationStreamEnvelope(d),player=smPlayer(d,ctx.actorId),position=smReadPosition(d,player);
  const effective=Math.max(position.readThroughSequence,ctx.body.throughSequence);
  const receipt={contractVersion:1,contract:'station-read',requestId:ctx.requestId,outcome:'CONFIRMED',streamId:ctx.body.streamId,membershipEpoch:ctx.body.membershipEpoch,throughSequence:ctx.body.throughSequence,readThroughSequence:effective};
  const accepted={kind:'READ_COMMAND',id:ctx.key,actorId:ctx.actorId,communityId:ctx.communityId,communityIdentity:smMongoIdentity(d),requestId:ctx.requestId,requestHash:ctx.requestHash,streamId:stream.streamId,epoch:player.epoch,body:ctx.body,receipt,receiptSha256:stationStreamReceiptDigest(receipt)};
  const lifetime=structuredClone(smLifetime(d));
  if(!smSequence(lifetime.revision+1))throw Error('READ_STREAM_UNAVAILABLE');
  lifetime.revision++;
  lifetime.players.find(p=>p.playerId===ctx.actorId).readPosition.readThroughSequence=effective;
  return srOp(ctx,'accept_write',srCommunities,'updateOne',{_id:d._id,id:ctx.communityId,communityType:'STATION',...smFence(d),members:d.members,bannedMembers:d.bannedMembers===undefined?{$exists:false}:d.bannedMembers,archived:d.archived===undefined?{$exists:false}:d.archived},{$set:{stationMembershipLifetime:lifetime,communityMessageOutbox:stationStreamAppend(d,accepted)}},{upsert:false,maxTimeMS:3000});
}
export function advanceStationRead(ctx,payload,error=false){
  try{
    if(ctx.step==='candidate_write')return srCandidate(ctx);
    if(ctx.step==='accept_write')return srCommunity(ctx,'accept_readback');
    if(ctx.step==='project_write')return srCandidate(ctx,'project_readback');
    if(ctx.step==='cleanup_write')return ctx.recovery?{ctx,complete:true}:srCommunity(ctx,'reply_acl');
    if(error||!Array.isArray(payload))return srUnknown(ctx,503,'READ_STREAM_UNAVAILABLE');
    const d=payload[0];
    if(ctx.step==='accept_candidate_check'){
      const community=ctx.acceptCommunity;delete ctx.acceptCommunity;
      if(payload.length!==1||!community||!srSame(ctx,d)||!smEqual(d.communityIdentity,ctx.candidate.communityIdentity))return srUnknown(ctx,503,'READ_RECEIPT_UNPROVEN');
      // A worker may have committed and removed the intent since the community read.
      // Return that original receipt; never calculate a second effective receipt.
      if(srProof(ctx,d)){ctx.candidate=d;ctx.receipt=d.receipt;return srCommunity(ctx,'cleanup_select');}
      if(d.state!=='RESERVED'||!smEqual(d,ctx.candidate))return srUnknown(ctx,503,'READ_RECEIPT_UNPROVEN');
      // Any acceptance/projection cleanup after this fresh candidate proof changes
      // the pinned outbox, so the following CAS cannot reaccept the original key.
      return srAccept(ctx,community);
    }
    if(ctx.step==='candidate'||ctx.step==='project_readback'){
      if(!d&&ctx.recovery)return srUnknown(ctx,503,'READ_RECEIPT_UNPROVEN');
      if(payload.length>1||(d&&!srSame(ctx,d)))return srUnknown(ctx,409,'READ_REQUEST_CONFLICT');
      if(d){ctx.candidate=d;ctx.body=d.body;ctx.requestHash=d.requestHash;}
      if(d&&srProof(ctx,d)){ctx.receipt=d.receipt;return srCommunity(ctx,ctx.statusOnly?'reply_acl':'cleanup_select');}
      if(ctx.step==='project_readback')return srUnknown(ctx,503,'READ_RECEIPT_UNPROVEN');
      return srCommunity(ctx);
    }
    if(ctx.step==='cleanup_select'){
      if(payload.length!==1||!smEqual(smMongoIdentity(d),ctx.candidate.communityIdentity))return srUnknown(ctx,503,'READ_STREAM_UNAVAILABLE');
      const stream=stationStreamEnvelope(d),intent=stream.intents.find(i=>i.id===ctx.key);
      if(stream.streamId!==ctx.body.streamId)return srUnknown(ctx,503,'READ_STREAM_UNAVAILABLE');
      if(!intent)return ctx.recovery?{ctx,complete:true}:srCommunity(ctx,'reply_acl');
      if(intent.kind!=='READ_COMMAND'||intent.requestHash!==ctx.requestHash||!smEqual(intent.receipt,ctx.receipt)||!smSequence(stream.revision+1))return srUnknown(ctx,503,'READ_RECEIPT_UNPROVEN');
      const next={...stream,revision:stream.revision+1,intents:stream.intents.filter(i=>i.id!==ctx.key)};
      return srOp(ctx,'cleanup_write',srCommunities,'updateOne',{_id:d._id,communityMessageOutbox:stream},{$set:{communityMessageOutbox:next}},{upsert:false,maxTimeMS:3000});
    }
    if(ctx.step==='reply_acl'){
      if(payload.length!==1||!historyActorAllowed(d,{id:ctx.actorId})||!smEqual(smMongoIdentity(d),ctx.candidate.communityIdentity))return srUnknown(ctx,403,'READ_ACCESS_DENIED');
      const stream=stationStreamEnvelope(d),player=smPlayer(d,ctx.actorId);
      if(stream.streamId!==ctx.body.streamId||player.epoch!==ctx.body.membershipEpoch)return srUnknown(ctx,403,'READ_ACCESS_DENIED');
      if(!ctx.receipt||!srProof(ctx,ctx.candidate))return srUnknown(ctx,200,'READ_RECEIPT_UNPROVEN');
      return {ctx,response:{status:200,body:ctx.receipt}};
    }
    if(!['community','accept_readback'].includes(ctx.step))return srUnknown(ctx,503,'READ_STREAM_UNAVAILABLE');
    if(payload.length!==1||d.communityType!=='STATION')return srUnknown(ctx,403,'READ_ACCESS_DENIED');
    const stream=stationStreamEnvelope(d),intent=stream.intents.find(i=>i.id===ctx.key);
    if(intent&&ctx.candidate&&!ctx.statusOnly){ctx.intent=intent;return srProject(ctx);}
    if(!historyActorAllowed(d,{id:ctx.actorId})||(ctx.candidate&&!smEqual(smMongoIdentity(d),ctx.candidate.communityIdentity)))return srUnknown(ctx,403,'READ_ACCESS_DENIED');
    if(ctx.statusOnly){if(ctx.body&&(stream.streamId!==ctx.body.streamId||smPlayer(d,ctx.actorId).epoch!==ctx.body.membershipEpoch))return srUnknown(ctx,403,'READ_ACCESS_DENIED');return srUnknown(ctx,200,'READ_RECEIPT_UNPROVEN');}
    const player=smPlayer(d,ctx.actorId);smReadPosition(d,player);
    if(stream.streamId!==ctx.body.streamId||player.epoch!==ctx.body.membershipEpoch)return srUnknown(ctx,403,'READ_ACCESS_DENIED');
    if(ctx.body.throughSequence>stream.publishedSequence)return srUnknown(ctx,400,'READ_REQUEST_INVALID');
    if(!ctx.candidate){
      const candidate={_id:ctx.key,stationMessageOwner:1,recordType:'READ_COMMAND',archived:true,state:'RESERVED',actorId:ctx.actorId,communityId:ctx.communityId,communityIdentity:smMongoIdentity(d),requestId:ctx.requestId,requestHash:ctx.requestHash,body:ctx.body};
      return srOp(ctx,'candidate_write',srMessages,'updateOne',{_id:ctx.key},{$setOnInsert:candidate},{upsert:true,maxTimeMS:3000});
    }
    if(ctx.step==='accept_readback'&&++ctx.retries>2)return srUnknown(ctx,503,'READ_RECEIPT_UNPROVEN');
    ctx.acceptCommunity=d;
    return srCandidate(ctx,'accept_candidate_check');
  }catch{return srUnknown(ctx,503,'READ_STREAM_UNAVAILABLE');}
}
export async function runStationRead(db,operation,{before,after}={}){
  let current=operation;
  for(let step=0;step<40;step++){
    if(current.response||current.complete)return current;
    if(current.ctx.statusOnly&&current.method!=='find')return srUnknown(current.ctx,503,'READ_STREAM_UNAVAILABLE');
    const fault=await before?.(current);let value,error=false;
    try{value=fault?.skip?fault.value:current.method==='find'?await db.collection(current.store).find(...current.args).toArray():await db.collection(current.store).updateOne(...current.args);error=Boolean(fault?.error);}catch{error=true;}
    const changed=await after?.(current,value);if(changed?.error)error=true;
    current=advanceStationRead(current.ctx,value,error);
  }
  return srUnknown(current.ctx,503,'READ_STREAM_UNAVAILABLE');
}
export function recoverStationReadIntent(community,intent){
  if(intent.kind!=='READ_COMMAND'||!smEqual(smMongoIdentity(community),intent.communityIdentity))throw Error('READ_RECEIPT_UNPROVEN');
  const ctx={readCommand:true,recovery:true,communityId:intent.communityId,actorId:intent.actorId,requestId:intent.requestId,key:intent.id,body:intent.body,requestHash:intent.requestHash,retries:0};
  return srCandidate(ctx);
}
