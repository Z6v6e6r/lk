import crypto from 'node:crypto';
import { smHash, smEqual, smUuid, smSequence } from './stationMembershipLifetime.mjs';

export const uuid = value => { const h=crypto.createHash('sha256').update(value).digest('hex').slice(0,32).split(''); h[12]='8';h[16]=((parseInt(h[16],16)&3)|8).toString(16);const s=h.join('');return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`; };
export const requestKey = (actorId,requestId) => 'station-message:v1:'+smHash('station-message-key:v1',{tenant:'iSkq6G',actorId,requestId}).slice(7);
// Validate the existing immutable receipt, never repair it or infer it from a candidate/outbox.
export const committedProof = (ctx,d) => {
  if(!d||(d.recordType!==undefined&&d.recordType!=='MESSAGE')||d._id!==ctx.key||d.stationMessageOwner!==1||d.state!=='COMMITTED'||d.archived!==false||d.requestId!==ctx.requestId||d.actorId!==ctx.actorId||d.authorId!==ctx.actorId||d.communityId!==ctx.communityId||d.publicId!==uuid(ctx.key)||d.id!==d.publicId)return false;
  if(typeof d.text!=='string'||!d.text||d.text!==d.text.trim()||d.text.length>8000||typeof d.authorName!=='string'||!d.authorName||d.authorName.length>120||typeof d.createdAt!=='string'||!Number.isFinite(Date.parse(d.createdAt))||d.createdTs!==Date.parse(d.createdAt))return false;
  if(d.requestHash!==smHash('station-message-request:v1',{communityId:ctx.communityId,actorId:ctx.actorId,text:d.text})||(ctx.requestHash&&ctx.requestHash!==d.requestHash))return false;
  if(d.streamId!==undefined && (!smUuid(d.streamId)||!smSequence(d.sequence)||d.sequence<1||d.recordType!=='MESSAGE'))return false;
  const event={...(d.streamId?{streamId:d.streamId,sequence:d.sequence}:{}),_id:'station-message-event:'+d.id,id:uuid('event:'+d.id),communityId:d.communityId,type:'CHAT_MESSAGE_CREATED',createdAt:d.createdAt,createdTs:d.createdTs,actor:{id:d.actorId,name:d.authorName},payload:{messageId:d.id,textPreview:d.text.slice(0,120)}};
  return smEqual(d.stationMessageEvent,event);
};
