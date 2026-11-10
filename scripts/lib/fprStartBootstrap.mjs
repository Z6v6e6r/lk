import { replayPlayerRatingEvents, ratingGradeFromNumeric } from '../../src/services/player-rating/ledger.ts';
import { planFprRatingReconciliation } from '../../src/services/player-rating/fprRatingReplay.ts';
import { buildFprProjectionOutbox, fprLevelHash } from './fprLevelLedger.mjs';
const arr=v=>Array.isArray(v)?v:[];
const uniq=v=>[...new Set(v.filter(x=>typeof x==='string'&&x))];
const fail=(code,playerId)=>{const e=new Error(code);e.playerId=playerId;throw e;};
const exact=d=>({...Object.fromEntries(Object.entries(d).map(([k,v])=>[k,{$eq:v,$exists:true}])),
  $expr:{$eq:[{$size:{$objectToArray:'$$ROOT'}},Object.keys(d).length]}});
const valid=n=>typeof n==='number'&&Number.isFinite(n)&&n>=1&&n<=7;
const query=id=>({$or:[{clientId:id},{'identityAliases.clientIds':id},{playerKey:'client:'+id},{'identityAliases.playerKeys':'client:'+id}]});

/** Staff-only caller holds the real worker flock. One transaction covers the complete roster. */
export async function initializeFprStarts(db,client,ids,actorId,now=new Date().toISOString(),
  {dryRun=false,discoverMissing=false,verifiedVivaLevels=new Map(),evidenceClock=()=>new Date().toISOString()}={}){
  if(!Array.isArray(ids)||ids.length<1||ids.length>28||new Set(ids).size!==ids.length
    ||ids.some(id=>typeof id!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(id))
    ||typeof actorId!=='string'||!actorId||actorId.length>128||discoverMissing&&!dryRun)fail('FPR_START_ARGUMENTS');
  const freshEvidence=fetchedAt=>{
    const checkedAt=Date.parse(evidenceClock()),fetched=Date.parse(fetchedAt);
    return Number.isFinite(checkedAt)&&Number.isFinite(fetched)&&Math.abs(checkedAt-fetched)<=15000;
  };
  const session=client.startSession();let result;
  try{
    await session.withTransaction(async()=>{
      const options={session,maxTimeMS:5000},plans=[],used=new Set(),missingClientIds=[];
      for(const id of ids){
        const states=await db.collection('player_rating_state').find(query(id),options).limit(3).toArray();
        const compatible=await db.collection('player_ratings').find(query(id),options).limit(3).toArray();
        if(states.length>1||compatible.length>1)fail('FPR_START_IDENTITY_CONFLICT',id);
        const current=states[0],compat=compatible[0];
        const aliases=uniq([id,current?.clientId,compat?.clientId,...arr(current?.identityAliases?.clientIds),...arr(compat?.identityAliases?.clientIds)]);
        const phones=uniq([current?.phoneNorm,compat?.phoneNorm,...arr(current?.identityAliases?.phoneNorms),...arr(compat?.identityAliases?.phoneNorms)]);
        const keys=uniq([current?.playerKey,compat?.playerKey,...arr(current?.identityAliases?.playerKeys),...arr(compat?.identityAliases?.playerKeys),...aliases.map(x=>'client:'+x),...phones.map(x=>'phone:'+x)]);
        const ownerQuery={$or:[{clientId:{$in:aliases}},{'identityAliases.clientIds':{$in:aliases}},
          {playerKey:{$in:keys}},{'identityAliases.playerKeys':{$in:keys}},
          ...(phones.length?[{phoneNorm:{$in:phones}},{'identityAliases.phoneNorms':{$in:phones}}]:[])]};
        for(const [name,selected]of [['player_rating_state',current],['player_ratings',compat]]){
          const owners=await db.collection(name).find(ownerQuery,options).limit(3).toArray();
          if(owners.some(s=>!selected||String(s._id)!==String(selected._id)))fail('FPR_START_IDENTITY_CONFLICT',id);
        }
        const canonicalId=current?.clientId||compat?.clientId||id,key=current?.playerKey||'client:'+canonicalId;
        if(typeof canonicalId!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(canonicalId))fail('FPR_START_IDENTITY_CONFLICT',id);
        if(used.has(key))fail('FPR_START_IDENTITY_CONFLICT',id);used.add(key);
        if(current){
          if(current.ownership!=='CUP_CANONICAL'||!valid(current.ratingNumeric)||typeof current.lastEventId!=='string'||!current.lastEventId
            ||typeof current.clientId!=='string'||!current.clientId||typeof current.playerKey!=='string'||!current.playerKey)
            fail('FPR_START_INVALID_CANONICAL',id);
          plans.push({id,state:current,unchanged:true});continue;
        }
        const events=await db.collection('rating_events').find({$or:[{'player.clientId':{$in:aliases}},{'player.key':{$in:keys}},
          ...(phones.length?[{'player.phoneNorm':{$in:phones}}]:[])]},options).limit(20001).toArray();
        if(events.length>20000)fail('FPR_START_HISTORY_INVALID',id);
        if(events.some(e=>e.player?.clientId&&!aliases.includes(e.player.clientId)))fail('FPR_START_IDENTITY_CONFLICT',id);
        if(events.some(e=>(e.player?.phoneNorm&&!phones.includes(e.player.phoneNorm))||(e.player?.key&&!keys.includes(e.player.key))))fail('FPR_START_HISTORY_INVALID',id);
        let replay,event=null,initialSource='CUP_LEDGER',providerEvidence=null;
        if(events.length){
          try{replay=replayPlayerRatingEvents(events);if(!replay||planFprRatingReconciliation(events))fail('FPR_START_HISTORY_INVALID',id);}
          catch{fail('FPR_START_HISTORY_INVALID',id);}
        }else{
          if(compat?.lastEventId)fail('FPR_START_HISTORY_INVALID',id);
          const empty=v=>v==null||String(v).trim()===''||Number(String(v).replace(',','.'))===0;
          const raw=empty(compat?.ratingNumeric)?compat?.rating:compat.ratingNumeric;
          const absent=empty(raw);
          let numeric;
          if(absent){
            if(discoverMissing){missingClientIds.push(canonicalId);continue;}
            const verified=verifiedVivaLevels.get(canonicalId);
            if(!verified||verified.clientId!==canonicalId||!valid(verified.ratingNumeric)
              ||!['VIVA_NUMERIC','VERIFIED_VIVA_UNRATED_DEFAULT_1'].includes(verified.source)
              ||!freshEvidence(verified.fetchedAt)
              ||!/^[a-f0-9]{64}$/.test(verified.evidenceSha256||''))fail('FPR_START_VIVA_REQUIRED',id);
            numeric=verified.ratingNumeric;initialSource=verified.source;
            providerEvidence={fetchedAt:verified.fetchedAt,sha256:verified.evidenceSha256};
            if(initialSource==='VERIFIED_VIVA_UNRATED_DEFAULT_1'){
              if(numeric!==1)fail('FPR_START_INVALID_LEVEL',id);
              // An existing local numeric is a contradiction, never authority to invent a new default.
              const communities=await db.collection('lk_communities').find({$or:[{'members.id':{$in:aliases}},
                {'members.clientId':{$in:aliases}}]},options).limit(101).toArray();
              if(communities.length>100)fail('FPR_START_HISTORY_INVALID',id);
              if(communities.some(c=>arr(c.members).some(m=>[m.id,m.clientId].some(value=>aliases.includes(value))
                &&[m.levelScore,m.currentLevel,m.ratingNumeric,m.levelNumeric].some(n=>n!=null&&String(n).trim()!==''&&valid(Number(String(n).replace(',','.')))))))
                fail('FPR_START_EXISTING_LEVEL_CONFLICT',id);
            }
          }else{
            numeric=typeof raw==='number'||typeof raw==='string'?Number(String(raw).replace(',','.')):NaN;
            initialSource='CUP_COMPATIBILITY_NUMERIC';
          }
          if(!valid(numeric))fail('FPR_START_INVALID_LEVEL',id);
          const eventId='rating_evt:fpr_roster_bootstrap:'+fprLevelHash(key);
          event={_id:eventId,id:eventId,idempotencyKey:eventId,schemaVersion:1,eventType:'RATING_BOOTSTRAPPED_FROM_TOURNAMENT',
            occurredAt:now,createdAt:now,player:{key,clientId:canonicalId,phoneNorm:compat?.phoneNorm||null,name:compat?.name||'Игрок'},
            actor:{type:'STAFF',id:actorId,name:'FPR organizer'},
            source:{domain:'FPR_ROSTER_BOOTSTRAP',sourceId:eventId,policy:'fpr-canonical-start-bootstrap-v1',initialSource,
              ...(providerEvidence?{providerEvidence}:{}),...(compat?{compatibilityPreimageSha256:fprLevelHash(compat)}:{})},
            change:{before:null,delta:null,after:numeric,gradeBefore:null,gradeAfter:ratingGradeFromNumeric(numeric)},
            formula:null,projectionIntent:{viva:'REQUIRED_DURING_MIGRATION'}};
          replay=replayPlayerRatingEvents([event]);
        }
        if(!replay||!valid(replay.ratingNumeric))fail('FPR_START_HISTORY_INVALID',id);
        const history=event?[event]:events,baseline=history.find(e=>e.id===replay.baselineEventId);
        const state={schemaVersion:1,ownership:'CUP_CANONICAL',playerKey:key,clientId:canonicalId,phoneNorm:compat?.phoneNorm||null,name:compat?.name||baseline?.player?.name||'Игрок',
          ratingNumeric:replay.ratingNumeric,rating:replay.rating,identityAliases:{clientIds:aliases,phoneNorms:phones,playerKeys:keys},
          baseline:{eventId:replay.baselineEventId,at:replay.baselineAt,ratingNumeric:baseline?.change.after},
          lastEventId:replay.lastEventId,lastEventType:replay.lastEventType,lastEventAt:replay.lastEventAt,
          ...(events.some(e=>e.source?.fprProtocolId)?{fprLevelFrontier:fprLevelHash(events.map(e=>e.id).sort())}:{}),
          projectedBy:'fpr-canonical-start-bootstrap-v1',createdAt:compat?.createdAt||now,updatedAt:now,projectedAt:now};
        const pending=await db.collection('rating_projection_outbox').find({$or:[{clientId:{$in:aliases}},{'payload.clientId':{$in:aliases}}],
          status:{$in:['PENDING','FAILED_RETRYABLE','SENDING']}},options).limit(1001).toArray();
        if(pending.length>1000||pending.some(r=>r.status==='SENDING'))fail('FPR_START_PROJECTION_BUSY',id);
        plans.push({id,state,compat,event,pending,initialSource,outbox:buildFprProjectionOutbox(state,now)});
      }
      for(const plan of plans)if(plan.event?.source.providerEvidence&&!freshEvidence(plan.event.source.providerEvidence.fetchedAt))
        fail('FPR_START_VIVA_REQUIRED',plan.id);
      if(!dryRun)for(const plan of plans.filter(p=>!p.unchanged)){
        try{
        if(plan.event)await db.collection('rating_events').insertOne(plan.event,{session});
        await db.collection('player_rating_state').insertOne({...plan.state,_id:plan.state.playerKey},{session});
        const projection={...plan.state,compatibilityProjection:true,canonicalCollection:'player_rating_state',compatibilityUpdatedAt:now};
        if(plan.compat){const r=await db.collection('player_ratings').updateOne(exact(plan.compat),{$set:projection},{session});
          if(r.matchedCount!==1)fail('FPR_START_PREIMAGE_CHANGED',plan.id);
        }else await db.collection('player_ratings').insertOne({...projection,_id:'fpr-start:'+fprLevelHash(plan.state.playerKey)},{session});
        if(plan.pending.length)await db.collection('rating_projection_outbox').updateMany({_id:{$in:plan.pending.map(r=>r._id)},status:{$in:['PENDING','FAILED_RETRYABLE']}},
          {$set:{status:'SUPERSEDED',supersededBy:plan.outbox.id,updatedAt:now}},{session});
        await db.collection('rating_projection_outbox').insertOne(plan.outbox,{session});
        }catch(e){if(e.hasErrorLabel?.('TransientTransactionError')||/^FPR_START_/.test(e.message))throw e;fail('FPR_START_PREIMAGE_CHANGED',plan.id);}
      }
      result={...(discoverMissing?{missingClientIds}:{}),states:plans.map(p=>({clientId:p.state.clientId,playerKey:p.state.playerKey,ownership:p.state.ownership,ratingNumeric:p.state.ratingNumeric,
        lastEventId:p.state.lastEventId,identityAliases:{clientIds:p.state.identityAliases?.clientIds||[p.id]}})),
        initialized:plans.filter(p=>!p.unchanged).map(p=>({clientId:p.id,source:p.initialSource,ratingNumeric:p.state.ratingNumeric}))};
    },{readConcern:{level:'snapshot'},writeConcern:{w:'majority'},readPreference:'primary',maxCommitTimeMS:5000});
    return result;
  }finally{await session.endSession();}
}

/** Provider I/O happens once before the retriable all-roster write transaction. */
export async function initializeFprStartsWithViva(db,client,ids,actorId,readVivaLevels,{dryRun=false,clock=()=>new Date().toISOString()}={}){
  const discovery=await initializeFprStarts(db,client,ids,actorId,clock(),{dryRun:true,discoverMissing:true});
  const verifiedVivaLevels=discovery.missingClientIds.length?await readVivaLevels(discovery.missingClientIds):new Map();
  return initializeFprStarts(db,client,ids,actorId,clock(),{dryRun,verifiedVivaLevels,evidenceClock:clock});
}
