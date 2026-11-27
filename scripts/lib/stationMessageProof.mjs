import crypto from 'node:crypto';
import { smHash, smEqual, smUuid, smSequence, smKeys } from './stationMembershipLifetime.mjs';

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

// Photo requests bind the normalized JPEG bytes and caption semantics. Existing text receipts keep v1.
export const STATION_PHOTO_MAX_BYTES = 512 * 1024;
export const stationPhotoValid = photo => smKeys(photo, ['sha256','size','hasCaption']) &&
  typeof photo.sha256 === 'string' && /^[a-f0-9]{64}$/.test(photo.sha256) &&
  Number.isInteger(photo.size) && photo.size > 0 && photo.size <= STATION_PHOTO_MAX_BYTES &&
  typeof photo.hasCaption === 'boolean';

export function stationMessageRequestHash({ communityId, actorId, text, photo }) {
  if (photo === undefined) return smHash('station-message-request:v1', { communityId, actorId, text });
  if (!stationPhotoValid(photo) || (!photo.hasCaption && text !== 'Фото')) throw Error('STATION_PHOTO_INVALID');
  return smHash('station-message-request:photo:v1', { communityId, actorId, text, photo });
}

export function stationMessageReceiptProof(ctx, row) {
  if (row?.photo === undefined) return committedProof(ctx, row);
  try {
    if (row.requestHash !== stationMessageRequestHash({ ...row, communityId: ctx.communityId, actorId: ctx.actorId }) ||
        (ctx.requestHash && ctx.requestHash !== row.requestHash)) return false;
    // v1 verifies the rest of the immutable row, including its exact event.
    const plainHash = stationMessageRequestHash({ communityId: ctx.communityId, actorId: ctx.actorId, text: row.text });
    return committedProof({ ...ctx, requestHash: plainHash }, { ...row, requestHash: plainHash });
  } catch { return false; }
}
