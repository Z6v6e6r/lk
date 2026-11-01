import { smId, smUuid, smSequence, smPlayer, smReadPosition, smEqual, smLifetime, smStream, smHash, smKeys } from './stationMembershipLifetime.mjs';
import { stationStreamEnvelope } from './stationMessageStream.mjs';
import { historyActorAllowed, historyMongoIdentity, historyRequest, historyFindArguments, historyPage } from './stationMessageHistory.mjs';
const ssFail=code=>{throw Error(code);};
const ssInteger=value=>typeof value==='string'&&/^(0|[1-9][0-9]{0,15})$/.test(value)&&smSequence(Number(value))?Number(value):ssFail('HISTORY_CURSOR_INVALID');
export function streamHistoryRequest(communityId,query){
  if(!smId(communityId)||/[\r\n]/.test(communityId)||!query||typeof query!=='object'||Array.isArray(query)||query.historyVersion!=='3'||Object.keys(query).some(k=>!['historyVersion','mode','limit','streamId','membershipEpoch','afterSequence','throughSequence','beforeTs','beforeId'].includes(k)))ssFail('HISTORY_REQUEST_INVALID');
  const mode=query.mode??'STREAM';if(!['STREAM','ARCHIVE'].includes(mode))ssFail('HISTORY_REQUEST_INVALID');
  const limit=query.limit===undefined?50:ssInteger(query.limit);if(limit<1||limit>50)ssFail('HISTORY_REQUEST_INVALID');
  const bound=query.streamId!==undefined||query.membershipEpoch!==undefined;
  if(bound&&(!smUuid(query.streamId)||query.streamId.length!==36||query.membershipEpoch===undefined))ssFail('HISTORY_CURSOR_INVALID');
  const epoch=bound?ssInteger(query.membershipEpoch):undefined;
  if(mode==='ARCHIVE'){
    if(!bound||query.afterSequence!==undefined||query.throughSequence!==undefined)ssFail('HISTORY_CURSOR_INVALID');
    const legacy=historyRequest(communityId,{historyVersion:'2',limit:String(limit),...(query.beforeTs!==undefined?{beforeTs:query.beforeTs}:{}),...(query.beforeId!==undefined?{beforeId:query.beforeId}:{})});
    return {...legacy,historyVersion:3,mode,streamId:query.streamId,membershipEpoch:epoch};
  }
  if(query.beforeTs!==undefined||query.beforeId!==undefined||(query.afterSequence!==undefined&&!bound)||(query.throughSequence!==undefined&&query.afterSequence===undefined)||(bound&&query.afterSequence===undefined))ssFail('HISTORY_CURSOR_INVALID');
  return {communityId,historyVersion:3,mode,limit,...(bound?{streamId:query.streamId,membershipEpoch:epoch,afterSequence:ssInteger(query.afterSequence)}:{}),...(query.throughSequence!==undefined?{throughSequence:ssInteger(query.throughSequence)}:{})};
}
export function streamHistorySnapshot(community,actor){
  if(!historyActorAllowed(community,actor))ssFail('HISTORY_ACCESS_DENIED');
  const stream=stationStreamEnvelope(community),player=smPlayer(community,actor.id),position=smReadPosition(community,player);
  return {identity:historyMongoIdentity(community),communityId:community.id,streamId:stream.streamId,membershipEpoch:player.epoch,baselineSequence:position.baselineSequence,readThroughSequence:position.readThroughSequence,publishedThroughSequence:stream.publishedSequence};
}
export function streamHistoryBind(request,snapshot){
  if(request.streamId!==undefined&&(request.streamId!==snapshot.streamId||request.membershipEpoch!==snapshot.membershipEpoch))ssFail('HISTORY_ACCESS_DENIED');
  if(request.mode==='ARCHIVE')return request;
  const throughSequence=request.throughSequence??snapshot.publishedThroughSequence;
  const afterSequence=request.afterSequence??Math.max(0,throughSequence-request.limit);
  if(afterSequence>throughSequence||throughSequence>snapshot.publishedThroughSequence)ssFail('HISTORY_CURSOR_INVALID');
  return {...request,streamId:snapshot.streamId,membershipEpoch:snapshot.membershipEpoch,afterSequence,throughSequence};
}
export function streamHistoryFindArguments(request,legacy=false){
  if(request.mode==='ARCHIVE'){
    const args=historyFindArguments(request,legacy);args[0].streamId={$exists:false};args[0].recordType={$ne:'READ_COMMAND'};return args;
  }
  const args=historyFindArguments({...request,before:null});
  args[0]={communityId:request.communityId,stationMessageOwner:1,recordType:'MESSAGE',streamId:request.streamId,state:'COMMITTED',archived:false,sequence:{$gt:request.afterSequence,$lte:request.throughSequence}};
  args[1].sort={sequence:1};args[1].limit=request.limit;
  Object.assign(args[1].projection,{recordType:1,streamId:1,sequence:1});return args;
}
export function streamUnreadArguments(snapshots,actorId){
  if(!smId(actorId)||!Array.isArray(snapshots)||snapshots.length>50)ssFail('HISTORY_REQUEST_INVALID');
  const conditions=snapshots.map(s=>({communityId:s.communityId,streamId:s.streamId,sequence:{$gt:s.readThroughSequence,$lte:s.publishedThroughSequence}}));
  return [[{$match:{stationMessageOwner:1,recordType:'MESSAGE',state:'COMMITTED',archived:false,authorId:{$ne:actorId},$or:conditions.length?conditions:[{_id:{$exists:false}}]}},{$group:{_id:'$communityId',unreadCount:{$sum:1}}}],{maxTimeMS:3000,allowDiskUse:false}];
}
export function streamUnreadCounts(snapshots,rows){
  if(!Array.isArray(rows)||rows.length>snapshots.length)ssFail('HISTORY_STORE_INVALID');
  const counts=new Map(snapshots.map(s=>[s.communityId,0])),seen=new Set();
  for(const row of rows){if(!row||Object.keys(row).sort().join(',')!=='_id,unreadCount'||!counts.has(row._id)||seen.has(row._id)||!smSequence(row.unreadCount))ssFail('HISTORY_STORE_INVALID');seen.add(row._id);counts.set(row._id,row.unreadCount);}
  for(const s of snapshots)if(counts.get(s.communityId)>s.publishedThroughSequence-s.readThroughSequence)ssFail('HISTORY_STORE_INVALID');
  return counts;
}
export function streamHistoryPage(request,snapshot,canonical,legacy,unreadCount){
  const state={...snapshot};delete state.identity;delete state.communityId;
  if(!smSequence(unreadCount)||unreadCount>state.publishedThroughSequence-state.readThroughSequence)ssFail('HISTORY_STORE_INVALID');
  if(request.mode==='ARCHIVE'){
    if([...canonical,...legacy].some(r=>r.recordType==='READ_COMMAND'||r.streamId!==undefined))ssFail('HISTORY_ROW_INVALID');
    const page=historyPage(request,canonical,legacy);
    return {historyVersion:3,mode:'ARCHIVE',...state,unreadCount,messages:page.messages.map(r=>({...r,sequence:null})),hasMore:page.hasMore,nextBefore:page.nextBefore};
  }
  const expected=Math.min(request.limit,request.throughSequence-request.afterSequence);
  if(!Array.isArray(canonical)||canonical.length!==expected||canonical.some((r,i)=>r.recordType!=='MESSAGE'||r.streamId!==request.streamId||r.sequence!==request.afterSequence+i+1))ssFail('HISTORY_STREAM_GAP');
  // Reuse v2's bounded exact record normalizer independently of chronological ordering.
  const messages=canonical.map(r=>({...historyPage({...request,before:null,limit:1},[r],[]).messages[0],sequence:r.sequence}));
  const last=request.afterSequence+messages.length,hasMore=last<request.throughSequence;
  return {historyVersion:3,mode:'STREAM',...state,unreadCount,afterSequence:request.afterSequence,throughSequence:request.throughSequence,messages,nextAfterSequence:hasMore?last:null,hasMore};
}
export function streamSnapshotUnchanged(snapshot,community,actor){return smEqual(snapshot,streamHistorySnapshot(community,actor));}
export function streamSummaryClassification(community,actor,authorized){
  if(!authorized||!community||community.archived===true)ssFail('HISTORY_ACCESS_DENIED');
  if(community.communityType!=='STATION'){
    if(community.stationMembershipLifetime!==undefined||community.communityMessageOutbox!==undefined)ssFail('HISTORY_UNAVAILABLE');
    return {communityId:community.id,availability:'NOT_STATION'};
  }
  if(!smStream(community)){
    smLifetime(community);
    if(community.communityMessageOutbox!==undefined&&(!Array.isArray(community.communityMessageOutbox)||community.communityMessageOutbox.length>32))ssFail('HISTORY_UNAVAILABLE');
    for(const intent of community.communityMessageOutbox??[]){
      if(!smKeys(intent,['id','requestId','requestHash','actorId','communityId','communityIdentity','message','event'])||typeof intent.id!=='string'||!smUuid(intent.requestId)||!smId(intent.actorId)||intent.communityId!==community.id||!smEqual(intent.communityIdentity,historyMongoIdentity(community))||typeof intent.message?.text!=='string'||intent.message.authorId!==intent.actorId||intent.event?.type!=='CHAT_MESSAGE_CREATED'||intent.event.payload?.messageId!==intent.message.id||intent.requestHash!==smHash('station-message-request:v1',{communityId:community.id,actorId:intent.actorId,text:intent.message.text}))ssFail('HISTORY_UNAVAILABLE');
    }
    return {communityId:community.id,availability:'UNADOPTED'};
  }
  const state=streamHistorySnapshot(community,actor);delete state.identity;
  return {availability:'AVAILABLE',...state};
}
