#!/usr/bin/env node
/* global __FPR_CORRECTION_RUNTIME_HASHES__ */
// Root-only, packet-bound, all-or-nothing correction. Never export private packet data.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { readFprCanonicalDryRun } from './lib/fprCanonicalDryRun.mjs';
import { loadFprHistoricalEvidence } from './lib/fprHistoricalEvidence.mjs';
import { loadFprLevelContext, buildFprPlayerPlan, applyFprPlayerPlan, assertFprPlanIdentityDisjoint,
  fprLevelHash, fprCorrectionSourceHash, readFprLevelActivation, projectFprLevelResults } from './lib/fprLevelLedger.mjs';
const values = {};
for (let i=2;i<process.argv.length;i+=2) {
  const key=process.argv[i];
  if (!['--mode','--runtime','--operation','--root','--backfill-operation','--backfill-runtime','--backfill-runner','--backfill-sha'].includes(key)
    || !process.argv[i+1] || values[key]) throw Error('FPR_CORRECTION_ARGUMENTS');
  values[key]=process.argv[i+1];
}
const mode=values['--mode'], operation=values['--operation'], runtime=values['--runtime'];
if (!['prepare','rehearse','apply','postcheck'].includes(mode) || !/^\/root\/\.padlhub-fpr-canonical-correction-[a-z0-9-]+$/.test(operation||'')
  || !runtime || !values['--root'] || process.getuid()!==0 || process.env.FPR_LEVEL_SHARED_LOCK_HELD!=='1') throw Error('FPR_CORRECTION_BOUNDARY');
const lockPath='/var/lock/padlhub-rating-worker.lock';
const fdStat=fs.fstatSync(9),lockStat=fs.statSync(lockPath);
if(fdStat.dev!==lockStat.dev||fdStat.ino!==lockStat.ino||!fdStat.isFile()
  ||spawnSync('flock',['-n','9'],{stdio:['ignore','ignore','ignore','ignore','ignore','ignore','ignore','ignore','ignore',9]}).status!==0
  ||spawnSync('flock',['-n',lockPath,'true'],{stdio:'ignore'}).status!==1)throw Error('FPR_CORRECTION_COMMON_LOCK_NOT_HELD');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const rt=fs.realpathSync(runtime), manifestBytes=fs.readFileSync(path.join(rt,'release-manifest.json')), manifest=JSON.parse(manifestBytes);
if (rt!==runtime || !rt.startsWith('/opt/padlhub-rating-worker/releases/') || manifest.dirtyWorktree!==false
  || manifest.recoveryPolicy!=='forward-compatible-only-after-fpr-ledger-activation') throw Error('FPR_CORRECTION_RUNTIME');
for (const f of manifest.files) {
  if (!f.path || path.isAbsolute(f.path) || f.path.split('/').includes('..')) throw Error('FPR_CORRECTION_RUNTIME');
  const file=path.join(rt,f.path);
  if (fs.realpathSync(file)!==file || !fs.lstatSync(file).isFile() || sha(fs.readFileSync(file))!==f.sha256) throw Error('FPR_CORRECTION_RUNTIME_DRIFT');
}
// The source builder embeds the complete owning formula/replay closure into this runner's hash.
const expectedRuntimeHashes=typeof __FPR_CORRECTION_RUNTIME_HASHES__==='undefined'?null:__FPR_CORRECTION_RUNTIME_HASHES__;
if(!expectedRuntimeHashes||Object.keys(expectedRuntimeHashes).length!==9)throw Error('FPR_CORRECTION_SOURCE_PIN_REQUIRED');
for(const [file,expected]of Object.entries(expectedRuntimeHashes)){
  if(manifest.files.find(f=>f.path===file)?.sha256!==expected||sha(fs.readFileSync(path.join(rt,file)))!==expected)
    throw Error('FPR_CORRECTION_INSTALLED_SOURCE_MISMATCH');
}
const runnerSha=sha(fs.readFileSync(process.argv[1]));
const {MongoClient,BSON}=createRequire(path.join(rt,'package.json'))('mongodb');
const EJSON=BSON.EJSON;
const flowBytes=fs.readFileSync('/root/.node-red/flows.json');
const cfg=JSON.parse(flowBytes).filter(n=>n.id==='4e820638cc39c730'&&n.type==='mongodb4-client'&&n.dbName==='games'&&typeof n.uri==='string');
if (cfg.length!==1) throw Error('FPR_CORRECTION_DB_CONFIG');
const client=new MongoClient(cfg[0].uri,{serverSelectionTimeoutMS:15000});
const now=new Date().toISOString();
const exact=d=>({...Object.fromEntries(Object.entries(d).map(([k,v])=>[k,{$eq:v,$exists:true}])),
  $expr:{$eq:[{$size:{$objectToArray:'$$ROOT'}},Object.keys(d).length]}});
const durable=(name,value)=>{
  const fd=fs.openSync(path.join(operation,name),'wx',0o600);
  try {fs.writeFileSync(fd,EJSON.stringify(value,{relaxed:false}));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  const dir=fs.openSync(operation,'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
};
const read=name=>{
  const file=path.join(operation,name),s=fs.lstatSync(file);
  if(!s.isFile()||s.isSymbolicLink()||s.uid!==0||(s.mode&0o077)||s.nlink!==1)throw Error('FPR_CORRECTION_CUSTODY');
  return EJSON.parse(fs.readFileSync(file,'utf8'),{relaxed:true});
};
const custody=()=>{const s=fs.lstatSync(operation);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==0||(s.mode&0o077))throw Error('FPR_CORRECTION_CUSTODY');};
const evidence=()=>loadFprHistoricalEvidence({operation:values['--backfill-operation'],runtime:values['--backfill-runtime'],
  runner:values['--backfill-runner'],expectedSha:values['--backfill-sha']});
const paused=()=>{const a=readFprLevelActivation();if(a.enabled||a.dispatchEnabled)throw Error('FPR_CORRECTION_AUTOMATION_NOT_PAUSED');};
const sourcePreimageHash=d=>{const copy={...d};delete copy.fprLevelResults;delete copy.fprLevelLedgerFence;return fprLevelHash(copy);};
const checkPlan=(plan,expected)=>{
  if (plan.fingerprint!==expected.fingerprint || fprLevelHash(plan.events)!==fprLevelHash(expected.events)
    || fprLevelHash(plan.next)!==fprLevelHash(expected.next)) throw Error('FPR_CORRECTION_PLAN_DRIFT');
};
try {
  await client.connect();const db=client.db('games');
  if(mode==='prepare') {
    let inputs;
    const report=await readFprCanonicalDryRun(db,values['--root'],now,{readHistoricalEvidence:evidence,captureInputs:v=>{inputs=v;}});
    if(report.blockers.length||report.temporalWarnings.length||report.summary.tournaments!==9||report.summary.players!==74
      || report.summary.calculatedTournaments!==9 || report.players.some(p=>p.status!=='calculated'))throw Error('FPR_CORRECTION_COHORT_BLOCKED');
    const context=await loadFprLevelContext(db,{enabled:true,unratedStartLevel:1});
    const backups=[], corrected=[], ids=new Map(), expectedValues=new Map();
    const previewSha256=fprLevelHash(report);
    for(const tournament of report.tournaments) {
      const source=context.selected.get(tournament.sourceEventId),document=source?.document;
      if(!document||document.tournamentId!==tournament.protocolId||document.fprCanonicalStartCorrection)throw Error('FPR_CORRECTION_SOURCE');
      const rows=document.params.fpr6x25.players.map(p=>{
        const r=tournament.rows.find(r=>r.seed===p.seed),h=inputs.histories.get(p.id);
        if(!r||!h?.current||r.player==null)throw Error('FPR_CORRECTION_IDENTITY');
        if(ids.has(h.current.playerKey)&&ids.get(h.current.playerKey)!==p.id)throw Error('FPR_CORRECTION_ALIAS_ROSTER');
        ids.set(h.current.playerKey,p.id);
        expectedValues.set(p.id,report.players.find(row=>row.player===r.player)?.candidate);
        const orderedAfterSourceIds=[];
        for(const tie of report.temporalResolutions.filter(t=>t.player===r.player)) {
          const at=tie.order.findIndex(t=>t.protocolId===document.tournamentId);
          if(at>=0)for(const prior of tie.order.slice(0,at)) {
            const d=inputs.documents.find(d=>d.tournamentId===prior.protocolId);
            if(!d)throw Error('FPR_CORRECTION_ORDER');
            orderedAfterSourceIds.push(d.params.fpr6x25.communityRating.sourceExerciseId||d.params.sourceExerciseId||d.tournamentId);
          }
        }
        return {id:p.id,start:r.cupStart,orderedAfterSourceIds};
      });
      backups.push(document);
      corrected.push({...document,fprCanonicalStartCorrection:{version:1,policy:'cup-canonical-start-correction-v1',operationId:path.basename(operation),
        sourceSha256:fprCorrectionSourceHash(document),legacySha256:source.legacy?fprCorrectionSourceHash(source.legacy):null,
        previewSha256,historicalEvidence:report.historicalEvidence,reconstructedBaselines:report.reconstructedBaselines,temporalResolutions:report.temporalResolutions,
        recordedAt:now,actor:'system:authorized-fpr-canonical-correction',rows}});
    }
    // Calculate with the same installed worker path, over metadata staged only in memory.
    const correctedById=new Map(corrected.map(d=>[String(d._id),d]));
    const memoryDb={collection:name=>name==='tournaments'?{find:(q,opts)=>{
      const cursor=db.collection(name).find(q,opts);return {limit:n=>({toArray:async()=>(await cursor.limit(n).toArray()).map(d=>correctedById.get(String(d._id))||d)})};
    }}:db.collection(name)};
    const correctedContext=await loadFprLevelContext(memoryDb,{enabled:true,unratedStartLevel:1});
    const plans=[];
    for(const id of [...ids.values()].sort()) {
      const plan=await buildFprPlayerPlan(db,id,correctedContext,now);
      if((plan.next||plan.current)?.ratingNumeric!==expectedValues.get(id))throw Error('FPR_CORRECTION_PREVIEW_MISMATCH');
      plans.push(plan);
    }
    assertFprPlanIdentityDisjoint(plans);
    // Every source-level start/target must equal the preview, including unchanged current players.
    for(const tournament of report.tournaments)for(const r of tournament.rows){
      const d=corrected.find(d=>d.tournamentId===tournament.protocolId),p=d.params.fpr6x25.players.find(p=>p.seed===r.seed);
      const row=correctedContext.ratings.get(tournament.sourceEventId).standings.find(row=>row.id===p.id);
      if(row.ratingBefore!==r.cupStart||row.ratingAfter!==r.candidateAfter||row.ratingDelta!==r.matchDelta)throw Error('FPR_CORRECTION_TARGET_MISMATCH');
    }
    const packet={version:1,preparedAt:now,runnerSha,runtimeManifestSha256:sha(manifestBytes),flowSha256:sha(flowBytes),root:values['--root'],
      report,backups,corrected,plans,sourceDocuments:[...context.protocols,...context.legacy],evidenceFingerprint:inputs.historicalEvidence.fingerprint};
    const bytes=EJSON.stringify(packet,{relaxed:false});
    if(Buffer.byteLength(bytes)>12*1024*1024)throw Error('FPR_CORRECTION_PACKET_BUDGET');
    fs.mkdirSync(operation,{mode:0o700});custody();
    const parent=fs.openSync(path.dirname(operation),'r');try{fs.fsyncSync(parent);}finally{fs.closeSync(parent);}
    durable('packet.ejson',packet);const packetSha256=sha(fs.readFileSync(path.join(operation,'packet.ejson')));
    durable('prepared.ejson',{packetSha256,runnerSha,at:now});
    console.log(JSON.stringify({ok:true,mode,operation,packetSha256,packetBytes:Buffer.byteLength(bytes),summary:report.summary,
      events:plans.reduce((n,p)=>n+p.events.length,0),changed:plans.filter(p=>p.next&&p.next.ratingNumeric!==p.current.ratingNumeric).length,privateDataExported:false}));
  } else {
    custody();const packet=read('packet.ejson'),prepared=read('prepared.ejson');
    if(sha(fs.readFileSync(path.join(operation,'packet.ejson')))!==prepared.packetSha256||packet.runnerSha!==runnerSha
      ||packet.runtimeManifestSha256!==sha(manifestBytes)||packet.flowSha256!==sha(flowBytes)||packet.root!==values['--root'])throw Error('FPR_CORRECTION_PACKET_DRIFT');
    if(mode==='apply'||mode==='rehearse') {
      paused();if(fs.realpathSync('/opt/padlhub-rating-worker/current')!==rt)throw Error('FPR_CORRECTION_RUNTIME_NOT_ACTIVE');
      if(Date.parse(now)-Date.parse(packet.preparedAt)>15*60000||evidence().fingerprint!==packet.evidenceFingerprint)throw Error('FPR_CORRECTION_PACKET_STALE');
      if(mode==='apply'){
        const rehearsal=read('rehearsed.ejson');
        if(!rehearsal.ok||rehearsal.mode!=='rehearse'||rehearsal.committed!==false||rehearsal.packetSha256!==prepared.packetSha256)
          throw Error('FPR_CORRECTION_REHEARSAL_REQUIRED');
      }
      const session=client.startSession();let results=[],rehearsalContext;
      durable(`${mode}-intent.ejson`,{packetSha256:prepared.packetSha256,at:now});
      try {
        session.startTransaction({readConcern:{level:'snapshot'},writeConcern:{w:'majority'},readPreference:'primary'});
        for(const before of packet.sourceDocuments){
          const current=await db.collection('tournaments').findOne({_id:before._id},{session});
          if(sourcePreimageHash(current)!==sourcePreimageHash(before))throw Error('FPR_CORRECTION_SOURCE_CHANGED');
        }
        for(let i=0;i<packet.backups.length;i++) {
          const before=packet.backups[i],current=await db.collection('tournaments').findOne({_id:before._id},{session});
          // Preserve a display/fence refresh while requiring every semantic field unchanged.
          const r=await db.collection('tournaments').updateOne(exact(current),{$set:{fprCanonicalStartCorrection:packet.corrected[i].fprCanonicalStartCorrection},$unset:{fprLevelResults:''}},{session});
          if(r.modifiedCount!==1)throw Error('FPR_CORRECTION_SOURCE_CAS');
        }
        const context=await loadFprLevelContext(db,{enabled:true,unratedStartLevel:1},session);rehearsalContext=context;
        for(const expected of packet.plans) {
          const fresh=await buildFprPlayerPlan(db,expected.clientId,context,packet.preparedAt,session);checkPlan(fresh,expected);
          results.push(await applyFprPlayerPlan(db,client,expected.clientId,context,packet.preparedAt,expected.fingerprint,session));
        }
        if(mode==='rehearse')await session.abortTransaction();else await session.commitTransaction();
      }catch(e){if(session.inTransaction())await session.abortTransaction();throw e;}finally{await session.endSession();}
      if(mode==='rehearse'){
        for(const before of packet.backups){const actual=await db.collection('tournaments').findOne({_id:before._id});
          if(sourcePreimageHash(actual)!==sourcePreimageHash(before))throw Error('FPR_CORRECTION_REHEARSAL_SOURCE_DRIFT');}
        for(const expected of packet.plans)checkPlan(await buildFprPlayerPlan(db,expected.clientId,rehearsalContext,packet.preparedAt),expected);
      }
      const result={ok:true,mode,packetSha256:prepared.packetSha256,players:results.length,events:results.reduce((n,r)=>n+r.events,0),
        changed:results.filter(r=>r.changed).length,committed:mode==='apply',at:new Date().toISOString(),privateDataExported:false};
      durable(mode==='rehearse'?'rehearsed.ejson':'applied.ejson',result);console.log(JSON.stringify(result));
    }else{
      let mismatches=0,retryEvents=0,verifiedEvents=0;
      const context=await loadFprLevelContext(db,{enabled:true,unratedStartLevel:1});
      for(const p of packet.plans){
        const wanted=p.next||p.current;
        for(const name of ['player_rating_state','player_ratings']){
          const rows=await db.collection(name).find({clientId:wanted.clientId}).limit(3).toArray();
          if(rows.length!==1||rows[0].ratingNumeric!==wanted.ratingNumeric||rows[0].lastEventId!==wanted.lastEventId)mismatches++;
        }
        for(const e of [...p.existingEvents,...p.events]){
          const actual=await db.collection('rating_events').findOne({_id:e._id});
          if(fprLevelHash(actual)!==fprLevelHash(e))mismatches++;else verifiedEvents++;
        }
        retryEvents+=(await buildFprPlayerPlan(db,p.clientId,context,now)).events.length;
      }
      for(const before of packet.backups){const current=await db.collection('tournaments').findOne({_id:before._id});
        if(sourcePreimageHash({...current,fprCanonicalStartCorrection:before.fprCanonicalStartCorrection})!==sourcePreimageHash(before)
          ||fprLevelHash(current?.fprCanonicalStartCorrection)!==fprLevelHash(packet.corrected.find(d=>String(d._id)===String(before._id)).fprCanonicalStartCorrection))mismatches++;
      }
      if(mismatches||retryEvents)throw Error('FPR_CORRECTION_POSTCHECK_MISMATCH');
      const results=await projectFprLevelResults(db,{...context,selected:new Map([...context.selected].filter(([,s])=>packet.backups.some(d=>String(d._id)===String(s.document._id))))},now,false);
      if(results.sourceChanged)throw Error('FPR_CORRECTION_DISPLAY_SOURCE_CHANGED');
      for(const tournament of packet.report.tournaments){
        const actual=await db.collection('tournaments').findOne({tournamentId:tournament.protocolId});
        for(const r of tournament.rows){const player=actual.params.fpr6x25.players.find(p=>p.seed===r.seed);
          const row=actual.fprLevelResults?.rows.find(row=>row.id===player.id);
          if(row?.status!=='applied'||row.before!==r.cupStart||row.after!==r.candidateAfter
            ||row.delta!==Number((r.candidateAfter-r.cupStart).toFixed(5)))throw Error('FPR_CORRECTION_DISPLAY_MISMATCH');}
      }
      const result={ok:true,mode,packetSha256:prepared.packetSha256,commitRecovered:!fs.existsSync(path.join(operation,'applied.ejson')),mismatches,retryEvents,verifiedEvents,results,players:packet.plans.length,at:now,privateDataExported:false};
      durable(`postcheck-${Date.now()}.ejson`,result);console.log(JSON.stringify(result));
    }
  }
}catch(e){console.log(JSON.stringify({ok:false,mode,error:/^FPR_[A-Z0-9_]+$/.test(e.message)?e.message:e.name,
  code:typeof e.code==='number'?e.code:null,privateDataExported:false}));process.exitCode=1;}finally{await client.close();}
