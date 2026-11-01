import crypto from 'node:crypto';
import { smHash, smEqual, smId, smUuid, smMongoIdentity, smLifetime, smPlayer, smFence, smIdentity } from './stationMembershipLifetime.mjs';

export const MESSAGE_OUTBOX_LIMIT = 32;
const messages = 'lk_community_chat_messages', communities = 'lk_communities', events = 'lk_community_events';
const uuid = value => { const h=crypto.createHash('sha256').update(value).digest('hex').slice(0,32).split(''); h[12]='8';h[16]=((parseInt(h[16],16)&3)|8).toString(16);const s=h.join('');return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`; };
const op = (ctx, step, store, method, ...args) => {ctx.step=step;return {ctx,store,method,args};};
const readCandidate = (ctx,step='candidate') => op(ctx,step,messages,'find',{_id:ctx.key},{limit:2,maxTimeMS:3000});
const readCommunity = (ctx,step='community') => op(ctx,step,communities,'find',{id:ctx.communityId},{limit:2,maxTimeMS:3000});
const errorResult = (ctx,status,code) => ({ctx,response:{status,body:{error:code,requestId:ctx.requestId,messageId:ctx.candidate?.publicId || null}}});
const sameCandidate = (ctx,d) => d && d.stationMessageOwner===1 && d._id===ctx.key && d.actorId===ctx.actorId && d.communityId===ctx.communityId && d.requestHash===ctx.requestHash;
const outbox = c => {if(c.communityMessageOutbox===undefined)return [];if(!Array.isArray(c.communityMessageOutbox)||c.communityMessageOutbox.length>MESSAGE_OUTBOX_LIMIT)throw Error('MESSAGE_OUTBOX_INVALID');return c.communityMessageOutbox;};
const active = (c,actor) => {
  const p=smPlayer(c,actor);
  return c.archived!==true && c.communityType==='STATION' && p.state==='ACTIVE' && Array.isArray(c.members) && c.members.some(m=>smIdentity(m)===actor && (!m.status||m.status==='ACTIVE')) &&
    !(Array.isArray(c.bannedMembers)&&c.bannedMembers.some(m=>!smIdentity(m)||smIdentity(m)===actor));
};
const identityMatches = (c,d) => c && c.id===d.communityId && smEqual(smMongoIdentity(c),d.communityIdentity);
const result = ctx => {
  if(ctx.recovery)return {ctx,complete:true};
  if(!ctx.canReply)return errorResult(ctx,409,'MESSAGE_ACCEPTED_ACCESS_CHANGED');
  const d=ctx.committed;
  if(d.archived===true)return errorResult(ctx,409,'MESSAGE_ACCEPTED_UNAVAILABLE');
  return {ctx,response:{status:200,body:{ok:true,requestId:ctx.requestId,message:{id:d.id,communityId:d.communityId,text:d.text,createdAt:d.createdAt,createdTs:d.createdTs,authorId:d.authorId,authorName:d.authorName,authorAvatar:d.authorAvatar}}}};
};
export function beginStationMessage({communityId,actor,requestId,text,nowIso=new Date().toISOString()}) {
  if(!smId(communityId)||!smId(actor?.id))throw Error('MESSAGE_ACTOR_REQUIRED');
  if(typeof text!=='string'||!text.trim()||text.trim().length>8000)throw Error('MESSAGE_TEXT_INVALID');
  if(requestId!==undefined && requestId!==null && !smUuid(requestId))throw Error('MESSAGE_REQUEST_ID_INVALID');
  const id=requestId??crypto.randomUUID(),actorId=actor.id,body=text.trim();
  const key='station-message:v1:'+smHash('station-message-key:v1',{tenant:'iSkq6G',actorId,requestId:id}).slice(7);
  const ctx={key,requestId:id,communityId,actorId,text:body,nowIso,retries:0,requestHash:smHash('station-message-request:v1',{communityId,actorId,text:body})};
  return readCandidate(ctx);
}
function project(ctx) {
  const d=ctx.candidate,i=ctx.intent;
  if(!i || i.id!==ctx.key || i.requestHash!==ctx.requestHash || !smEqual(i.communityIdentity,d.communityIdentity) || i.message?.id!==d.publicId ||
    smHash('station-message-request:v1',{communityId:d.communityId,actorId:d.actorId,text:i.message?.text})!==d.requestHash || i.message.authorId!==d.actorId || i.event?.payload?.messageId!==d.publicId)throw Error('MESSAGE_INTENT_INVALID');
  return op(ctx,'message_write',messages,'updateOne',{_id:d._id,state:'RESERVED',requestHash:d.requestHash},{$set:{...i.message,state:'COMMITTED',stationMessageEvent:i.event}},{upsert:false,maxTimeMS:3000});
}
export function advanceStationMessage(ctx,payload,error=false) {
  try {
    if(ctx.step==='candidate_write')return readCandidate(ctx,'candidate_readback');
    if(ctx.step==='accept_write'){ctx.acceptAmbiguous=Boolean(error)||payload?.acknowledged!==true;return readCommunity(ctx,'accept_readback');}
    if(ctx.step==='message_write')return readCandidate(ctx,'message_readback');
    if(ctx.step==='event_write')return op(ctx,'event_readback',events,'find',{_id:ctx.committed.stationMessageEvent._id},{limit:2,maxTimeMS:3000});
    if(ctx.step==='cleanup')return result(ctx); // cleanup may be retried; canonical message+event already proven
    if(error||!Array.isArray(payload))return errorResult(ctx,503,'MESSAGE_STORE_UNAVAILABLE');
    const rows=payload,d=rows[0];
    if(['candidate','candidate_readback','message_readback','accept_candidate_readback','recovery_candidate'].includes(ctx.step)) {
      if(!rows.length){
        if(ctx.step==='candidate')return readCommunity(ctx,'reserve_select');
        return errorResult(ctx,503,'MESSAGE_CUSTODY_UNPROVEN');
      }
      if(rows.length!==1||!sameCandidate(ctx,d))return errorResult(ctx,409,'MESSAGE_REQUEST_CONFLICT');
      ctx.candidate=d;
      if(d.state==='COMMITTED'){
        if(d.id!==d.publicId||typeof d.text!=='string'||!d.stationMessageEvent)return errorResult(ctx,503,'MESSAGE_COMMIT_INVALID');
        ctx.committed=d;
        if(ctx.step==='candidate'||ctx.step==='candidate_readback')return readCommunity(ctx,'reply_access');
        return op(ctx,'event_write',events,'updateOne',{_id:d.stationMessageEvent._id},{$setOnInsert:d.stationMessageEvent},{upsert:true,maxTimeMS:3000});
      }
      if(d.state!=='RESERVED')return errorResult(ctx,409,'MESSAGE_REQUEST_TERMINAL');
      if(ctx.step==='message_readback')return errorResult(ctx,503,'MESSAGE_COMMIT_UNPROVEN');
      if(ctx.step==='accept_candidate_readback')return errorResult(ctx,503,'MESSAGE_ACCEPTANCE_UNPROVEN');
      if(ctx.recovery)return project(ctx);
      return readCommunity(ctx);
    }
    if(['reserve_select','community','accept_readback','reply_access'].includes(ctx.step)) {
      const c=d;
      if(rows.length!==1 || !smMongoIdentity(c))return errorResult(ctx,409,'MESSAGE_COMMUNITY_CHANGED');
      ctx.canReply=active(c,ctx.actorId);
      if(ctx.step==='reply_access'){
        ctx.canReply=ctx.canReply&&identityMatches(c,ctx.candidate);
        return op(ctx,'event_write',events,'updateOne',{_id:ctx.committed.stationMessageEvent._id},{$setOnInsert:ctx.committed.stationMessageEvent},{upsert:true,maxTimeMS:3000});
      }
      if(ctx.step==='reserve_select'){
        if(!ctx.canReply)return errorResult(ctx,403,'COMMUNITY_MESSAGE_ACCESS_DENIED');
        const p=smPlayer(c,ctx.actorId);
        const candidate={_id:ctx.key,stationMessageOwner:1,state:'RESERVED',archived:true,requestId:ctx.requestId,requestHash:ctx.requestHash,communityId:ctx.communityId,communityIdentity:smMongoIdentity(c),actorId:ctx.actorId,epoch:p.epoch,policyRevision:c.typeSettingsRevision,publicId:uuid(ctx.key),reservedAt:ctx.nowIso};
        return op(ctx,'candidate_write',messages,'updateOne',{_id:ctx.key},{$setOnInsert:candidate},{upsert:true,maxTimeMS:3000});
      }
      if(!identityMatches(c,ctx.candidate))return errorResult(ctx,409,'MESSAGE_COMMUNITY_CHANGED');
      ctx.communityIdentity=smMongoIdentity(c);ctx.communityMongoId=c._id;
      const intents=outbox(c),intent=intents.find(i=>i.id===ctx.key);
      if(intent){ctx.intent=intent;return project(ctx);}
      if(ctx.step==='accept_readback')return readCandidate(ctx,'accept_candidate_readback');
      if(!ctx.canReply || smPlayer(c,ctx.actorId).epoch!==ctx.candidate.epoch || c.typeSettingsRevision!==ctx.candidate.policyRevision)return errorResult(ctx,403,'COMMUNITY_MESSAGE_ACCESS_CHANGED');
      if(intents.length>=MESSAGE_OUTBOX_LIMIT)return errorResult(ctx,503,'MESSAGE_OUTBOX_FULL');
      if(++ctx.retries>3)return errorResult(ctx,409,'MESSAGE_ACCEPTANCE_CONFLICT');
      const member=c.members.find(m=>smIdentity(m)===ctx.actorId),createdAt=ctx.candidate.reservedAt;
      const message={id:ctx.candidate.publicId,communityId:ctx.communityId,text:ctx.text,createdAt,createdTs:Date.parse(createdAt),authorId:ctx.actorId,authorName:String(member.name||'Игрок').slice(0,120),authorAvatar:typeof member.avatar==='string'&&member.avatar.length<=2048?member.avatar:null,archived:false};
      const event={_id:'station-message-event:'+message.id,id:uuid('event:'+message.id),communityId:ctx.communityId,type:'CHAT_MESSAGE_CREATED',createdAt,createdTs:message.createdTs,actor:{id:ctx.actorId,name:message.authorName},payload:{messageId:message.id,textPreview:ctx.text.slice(0,120)}};
      ctx.intent={id:ctx.key,requestId:ctx.requestId,requestHash:ctx.requestHash,actorId:ctx.actorId,communityId:ctx.communityId,communityIdentity:ctx.communityIdentity,message,event};
      const filter={_id:c._id,id:c.id,communityType:'STATION',archived:{$ne:true},typeSettingsRevision:ctx.candidate.policyRevision,...smFence(c)};
      for(const field of ['members','bannedMembers','communityMessageOutbox'])filter[field]=Object.hasOwn(c,field)?c[field]:{$exists:false};
      const set={communityMessageOutbox:[...intents,ctx.intent]};
      if(c.stationMembershipLifetime===undefined)set.stationMembershipLifetime=smLifetime(c);
      return op(ctx,'accept_write',communities,'updateOne',filter,{$set:set},{upsert:false,maxTimeMS:3000});
    }
    if(ctx.step==='event_readback'){
      if(rows.length!==1||!smEqual(d,ctx.committed.stationMessageEvent))return errorResult(ctx,503,'MESSAGE_EVENT_UNPROVEN');
      if(!ctx.communityMongoId)return result(ctx);
      return op(ctx,'cleanup',communities,'updateOne',{_id:ctx.communityMongoId},{$pull:{communityMessageOutbox:{id:ctx.key,requestHash:ctx.requestHash}}},{upsert:false,maxTimeMS:3000});
    }
    return errorResult(ctx,503,'MESSAGE_STATE_INVALID');
  }catch{return errorResult(ctx,503,'MESSAGE_STATE_INVALID');}
}
export async function runStationMessage(db,operation,{before,after}={}) {
  let next=operation;
  for(let step=0;step<40;step++){
    if(next.response||next.complete)return next;
    const fault=await before?.(next);let value,error=false;
    try{value=fault?.skip?fault.value:next.method==='find'?await db.collection(next.store).find(...next.args).toArray():await db.collection(next.store).updateOne(...next.args);error=Boolean(fault?.error);}catch{error=true;}
    const changed=await after?.(next,value);if(changed?.error)error=true;
    next=advanceStationMessage(next.ctx,value,error);
  }
  return errorResult(next.ctx,503,'MESSAGE_STEP_LIMIT');
}
export async function recoverStationMessageOutbox(db,{dryRun=true,maxCommunities=50,maxMessages=100,deadlineMs=10000}={}) {
  let rows;
  const deadline=Date.now()+deadlineMs;
  try { rows=await db.collection(communities).find({'communityMessageOutbox.0':{$exists:true}},{limit:maxCommunities,maxTimeMS:3000}).toArray(); } catch { throw Error('STATION_MESSAGE_RECOVERY_STORE_UNAVAILABLE'); }
  let pending=0,recovered=0;
  for(const c of rows)for(const intent of outbox(c)){
    if(pending>=maxMessages||Date.now()>deadline)return {pending,recovered,bounded:true};
    pending++;
    if(dryRun)continue;
    if(!smEqual(smMongoIdentity(c),intent.communityIdentity))throw Error('STATION_MESSAGE_RECOVERY_IDENTITY');
    const ctx={...intent,key:intent.id,recovery:true,communityMongoId:c._id,intent};
    const result=await runStationMessage(db,readCandidate(ctx,'recovery_candidate'));
    if(!result.complete)throw Error('STATION_MESSAGE_RECOVERY_UNPROVEN');
    recovered++;
  }
  return {pending,recovered};
}
