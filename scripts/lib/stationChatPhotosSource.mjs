import fs from 'node:fs';
import { COMMUNITY_AUTH_SUBFLOW } from './communityPolicyAuth.mjs';
import { STATION_PHOTO_ROUTE } from './stationChatPhotos.mjs';

const names = ['post', 'get', 'prepare', 'put', 'read', 'message', 'community', 'event', 'catch'];
export const stationPhotoNodes = Object.fromEntries(names.map(name => [name, 'station-chat-photo-v1-' + name]));
const photoAuthId = name => COMMUNITY_AUTH_SUBFLOW + '-entry-' + stationPhotoNodes[name];
export const stationPhotoReservedIds = [...Object.values(stationPhotoNodes), photoAuthId('post'), photoAuthId('get')];

const photoRuntime = () => fs.readFileSync(new URL('./stationChatPhotos.mjs', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '').replace(/^export /gm, '');

const responseSource = String.raw`
function photoResponse(statusCode, payload) {
  return { req: msg.req, res: msg.res, _msgid: msg._msgid, statusCode, payload, headers: {
    'Content-Type': statusCode === 200 ? 'image/jpeg' : 'application/json',
    'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
  }};
}
const photoError = (status, error) => photoResponse(status, {error});
`;

const runtimeStorage = String.raw`
function photoStorage() {
  const bucket = env.get('LK_STATION_CHAT_PHOTO_BUCKET'), region = env.get('LK_STATION_CHAT_PHOTO_REGION');
  const accessKeyId = env.get('LK_STATION_CHAT_PHOTO_ACCESS_KEY'), secretAccessKey = env.get('LK_STATION_CHAT_PHOTO_SECRET_KEY');
  const endpoint = env.get('LK_STATION_CHAT_PHOTO_ENDPOINT');
  if (!bucket || !region || !accessKeyId || !secretAccessKey ||
      (endpoint && !/^https:\/\/[a-z0-9.-]+(?::[0-9]{1,5})?\/?$/i.test(endpoint))) throw Error('STATION_PHOTO_STORAGE_UNAVAILABLE');
  const client = new s3.S3Client({
    region, credentials: {accessKeyId, secretAccessKey},
    ...(endpoint ? {endpoint, forcePathStyle: true} : {}), maxAttempts: 1,
    requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
  });
  return { sdk: s3, client, bucket };
}
async function withPhotoStorage(work) {
  const inFlight = context.get('photoIO') || 0;
  if (inFlight >= 4) throw Error('STATION_PHOTO_STORAGE_BUSY');
  context.set('photoIO', inFlight + 1);
  let storage;
  try { storage = photoStorage(); return await work(storage); }
  finally { storage?.client.destroy(); context.set('photoIO', context.get('photoIO') - 1); }
}
`;

const prepareSource = String.raw`
const deny = (status, error) => [null, photoError(status, error)];
if (env.get('LK_STATION_CHAT_PHOTO_SEND_ENABLED') !== 'true') return deny(503, 'STATION_PHOTO_SEND_DISABLED');
if (!msg._verifiedCommunityActor?.id || msg._communityPolicyAuthFailure) {
  return deny(msg._communityPolicyAuthFailure === 'UNAVAILABLE' ? 503 : 403, 'COMMUNITY_AUTH_REQUIRED');
}
const communityId = msg.req?.params?.communityId;
if (!smId(communityId) || Object.keys(msg.req.query || {}).length) return deny(400, 'STATION_PHOTO_REQUEST_INVALID');
const inFlight = context.get('photoPrepare') || 0;
if (inFlight >= 4) return deny(429, 'STATION_PHOTO_BUSY');
context.set('photoPrepare', inFlight + 1);
return (async () => {
  try {
    const {bytes, ...input} = await prepareStationPhoto(msg.payload, sharp);
    const operation = beginStationMessage({...input, communityId, actor: msg._verifiedCommunityActor});
    return [{req:msg.req,res:msg.res,_msgid:msg._msgid,_stationMessageOperation:operation,_stationPhotoBytes:bytes}, null];
  } catch { return deny(400, 'STATION_PHOTO_REQUEST_INVALID'); }
  finally { context.set('photoPrepare', context.get('photoPrepare') - 1); }
})();
`;

const putSource = String.raw`
return (async () => {
  const {id, photo} = msg.payload[0];
  try { msg.payload = await withPhotoStorage(storage => putStationPhotoObject(storage, id, photo, msg._stationPhotoBytes)); }
  catch { msg.payload = false; }
  delete msg._stationPhotoBytes;
  return msg;
})();
`;

const readSource = String.raw`
const deny = (status, error) => [null, null, null, photoError(status, error)];
const hidden = () => deny(404, 'STATION_PHOTO_NOT_FOUND');
const unavailable = () => deny(503, 'STATION_PHOTO_UNAVAILABLE');
const find = (port, step, filter) => {
  msg._stationPhotoRead.step = step;
  msg.payload = [filter, {limit:2,maxTimeMS:3000}];
  const outputs = [null, null, null, null]; outputs[port] = msg; return outputs;
};
if (msg.error) return unavailable();
try {
  const ctx = msg._stationPhotoRead;
  if (!ctx) {
    if (!msg._verifiedCommunityActor?.id || msg._communityPolicyAuthFailure) {
      return deny(msg._communityPolicyAuthFailure === 'UNAVAILABLE' ? 503 : 403, 'COMMUNITY_AUTH_REQUIRED');
    }
    const request = stationPhotoReadRequest(msg.req?.params, msg.req?.query, msg._verifiedCommunityActor);
    msg._stationPhotoRead = {request};
    return find(0, 'message', {communityId:request.communityId,id:request.messageId,stationMessageOwner:1,state:'COMMITTED',archived:false,photo:{$exists:true}});
  }
  if (!Array.isArray(msg.payload) || msg.payload.length > 1) return unavailable();
  const row = msg.payload[0], {request,message} = ctx;
  if (ctx.step === 'message') {
    if (!stationPhotoMessageAllowed(request, row)) return hidden();
    ctx.message = row;
    return find(1, 'access', {id:request.communityId});
  }
  if (ctx.step === 'access') {
    if (!stationPhotoAccess(request, row, message)) return hidden();
    ctx.epoch = smPlayer(row, request.actor.id).epoch;
    return find(2, 'event', {_id:message.stationMessageEvent._id});
  }
  if (ctx.step === 'event') {
    if (!row || !smEqual(row, message.stationMessageEvent)) return hidden();
    return (async () => {
      try {
        ctx.bytes = await withPhotoStorage(storage => readStationPhotoObject(storage, message.id, message.photo));
        return find(1, 'finalAccess', {id:request.communityId});
      } catch { return unavailable(); }
    })();
  }
  if (ctx.step === 'finalAccess') {
    if (!stationPhotoAccess(request, row, message) || smPlayer(row, request.actor.id).epoch !== ctx.epoch) return hidden();
    return [null, null, null, photoResponse(200, ctx.bytes)];
  }
  return unavailable();
} catch { return unavailable(); }
`;

export function addStationPhotoNodes(flow, { z, mongoClientId, ownerIds, ownerRuntime }) {
  const ids = stationPhotoNodes;
  const response = [ownerIds.response], read = [ids.read];
  const crypto = { var: 'nodeCrypto', module: 'crypto' };
  const storage = { var: 's3', module: '@aws-sdk/client-s3' };
  const runtime = ownerRuntime + '\n' + photoRuntime();
  const routes = [
    ['post', STATION_PHOTO_ROUTE, ids.prepare],
    ['get', STATION_PHOTO_ROUTE + '/:messageId', ids.read],
  ];
  for (const [method, url, target] of routes) {
    flow.push({id:ids[method],type:'http in',z,method,url,upload:false,wires:[[photoAuthId(method)]]},
      {id:photoAuthId(method),type:'subflow:' + COMMUNITY_AUTH_SUBFLOW,z,wires:[[target]]});
  }
  flow.push(
    {id:ids.prepare,type:'function',z,name:'Prepare station chat photo',outputs:2,wires:[[ownerIds.router],response],
      libs:[crypto,{var:'sharp',module:'sharp'}],func:runtime + responseSource + prepareSource},
    {id:ids.put,type:'function',z,name:'Store immutable station chat photo',outputs:1,wires:[[ownerIds.router]],
      libs:[crypto,storage],func:runtime + runtimeStorage + putSource},
    {id:ids.read,type:'function',z,name:'Open authorized station chat photo',outputs:4,wires:[[ids.message],[ids.community],[ids.event],response],
      libs:[crypto,storage],func:runtime + responseSource + runtimeStorage + readSource},
  );
  for (const [name, collection] of [['message','lk_community_chat_messages'],['community','lk_communities'],['event','lk_community_events']]) {
    flow.push({id:ids[name],type:'mongodb4',z,clientNode:mongoClientId,collection,operation:'find',mode:'collection',output:'toArray',
      handleDocId:false,maxTimeMS:'3000',wires:[read]});
  }
  flow.push({id:ids.catch,type:'catch',z,scope:[ids.message,ids.community,ids.event],uncaught:false,wires:[read]});
}
