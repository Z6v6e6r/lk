import test from 'node:test';
import assert from 'node:assert/strict';
import { ratingFixture } from './helpers/fprRatingFixture.ts';
import { calculateFprTournamentRatings } from '../../src/services/player-rating/fprTournamentRating.ts';
import { buildTournamentRatingEvent, replayPlayerRatingEvents } from '../../src/services/player-rating/ledger.ts';
import { planFprCanonicalDryRun, readFprCanonicalDryRun, dryRunError } from '../lib/fprCanonicalDryRun.mjs';
import { main } from '../dry_run_fpr_canonical_starts.mjs';
import { verifyFprHistoricalEvidence, reconstructedFprBaseline, evidencedFprTargetOrder } from '../lib/fprHistoricalEvidence.mjs';
const capturedAt='2026-11-06T10:00:00Z';
function fixture(){
  const s=ratingFixture(4,6,[3.037,3,2.5,2.8]);
  const document={tournamentId:s.tournamentId,tournamentType:'fpr_6x25',params:{fpr6x25:s,sourceExerciseId:s.communityRating.sourceExerciseId},participants:s.players.map(p=>({id:p.id,rating:p.level}))};
  const old=calculateFprTournamentRatings(s),histories=new Map();
  for(const p of s.players){
    const before=p.id==='p0'?4.03664:p.level;
    const baseline={id:`baseline:${p.id}`,_id:`baseline:${p.id}`,eventType:'RATING_INITIAL_IMPORTED',occurredAt:'2026-10-01T00:00:00Z',createdAt:'2026-10-01T00:00:00Z',
      player:{clientId:p.id,key:`client:${p.id}`},source:{domain:'INITIAL_IMPORT'},change:{before:null,delta:null,after:before}};
    const row=old.standings.find(r=>r.id===p.id);
    const award=buildTournamentRatingEvent({tournamentId:old.tournamentId,finishedAt:s.finishedAt,standing:row,canonicalBefore:before,createdAt:'2026-11-05T10:00:00Z'});
    Object.assign(award.source,{fprProtocolId:s.tournamentId,fprFinishedAt:s.finishedAt});
    const events=[baseline,award],projection=replayPlayerRatingEvents(events);
    histories.set(p.id,{events,current:{_id:`client:${p.id}`,clientId:p.id,playerKey:`client:${p.id}`,ratingNumeric:projection.ratingNumeric,lastEventId:projection.lastEventId},aliases:[p.id],phones:[],keys:[`client:${p.id}`]});
  }
  return {documents:[document],histories,rootId:s.tournamentId,capturedAt};
}
test('read-only plan uses historical CUP baseline, preserves sport data and deterministically recalculates every player',()=>{
  const data=fixture(),before=structuredClone(data),result=planFprCanonicalDryRun(data);
  assert.equal(result.mode,'READ_ONLY_DRY_RUN');assert.equal(result.applyAvailable,false);assert.equal(result.applyReady,false);
  assert.equal(result.summary.calculatedTournaments,1);assert.equal(result.tournaments[0].rows.length,4);
  const winner=result.tournaments[0].rows.find(r=>r.player==='root-01');
  assert.equal(winner.frozenStart,3.037);assert.equal(winner.cupStart,4.03664);
  assert.deepEqual(data,before);assert.deepEqual(planFprCanonicalDryRun(data),result);
});
test('later game deltas remain additive and later ordinary absolute targets remain boundaries',()=>{
  for(const absolute of [false,true]){
    const data=fixture(),h=data.histories.get('p0'),current=h.current.ratingNumeric;
    const e={id:'later-event',eventType:absolute?'TOURNAMENT_RATING_FINALIZED':'GAME_RESULT_CONFIRMED',occurredAt:'2026-11-04T10:00:00Z',createdAt:'2026-11-04T10:00:00Z',player:{clientId:'p0',key:'client:p0'},
      source:{domain:absolute?'TOURNAMENT':'GAME_RESULT',sourceId:'later'},change:{before:current,after:absolute?4.5:current+.1,delta:absolute?4.5-current:.1}};
    h.events.push(e);Object.assign(h.current,{ratingNumeric:replayPlayerRatingEvents(h.events).ratingNumeric,lastEventId:'later-event'});
    const report=planFprCanonicalDryRun(data),row=report.players.find(r=>r.player==='root-01');
    assert.equal(row.status,'calculated');
    if(absolute){assert.equal(row.candidate,4.5);assert.equal(row.difference,0);}
    else assert.equal(row.candidate,Number((report.tournaments[0].rows.find(r=>r.player==='root-01').candidateAfter+.1).toFixed(5)));
  }
});
test('same-time restored targets, missing baseline, compensated awards and identity conflicts fail closed',()=>{
  for(const kind of ['time','baseline','compensated','identity']){
    const data=fixture(),h=data.histories.get('p0');
    if(kind==='time'){const e=structuredClone(h.events[1]);e.id='other-restored';e.source.sourceId='other-source';e.source.fprProtocolId='other-protocol';e.change.delta=0;h.events.push(e);h.current.lastEventId=replayPlayerRatingEvents(h.events).lastEventId;}
    if(kind==='baseline')h.events.shift();
    if(kind==='compensated'){h.events.push({...structuredClone(h.events[1]),id:'compensation',source:{...h.events[1].source,compensatesEventId:h.events[1].id}});}
    if(kind==='identity'){h.error='FPR_LEVEL_CLIENT_ALIAS_CONFLICT';}
    const report=planFprCanonicalDryRun(data);assert.ok(report.blockers.length);assert.equal(report.applyReady,false);
    if(kind==='time'){
      assert.ok(report.blockers.some(b=>b.code==='FPR_DRY_RUN_TIME_AMBIGUOUS'));
      assert.ok(report.temporalWarnings.some(b=>b.code==='FPR_DRY_RUN_TIME_AMBIGUOUS'));
    }
    else assert.equal(report.tournaments[0].status,'blocked');
  }
});
test('historical non-applying events cannot contaminate the start',()=>{
  const data=fixture(),h=data.histories.get('p0');
  h.events.push({id:'historical',occurredAt:'2026-10-20T10:00:00Z',source:{applyToState:false},change:{delta:100,after:7},eventType:'TOURNAMENT_RATING_FINALIZED'});
  assert.equal(planFprCanonicalDryRun(data).tournaments[0].rows.find(r=>r.player==='root-01').cupStart,4.03664);
});
function matches(doc,query){
  return Object.entries(query).every(([key,value])=>{
    if(key==='$or')return value.some(q=>matches(doc,q));
    const found=key.split('.').reduce((v,k)=>v?.[k],doc);
    if(value&&typeof value==='object'&&'$in'in value)return value.$in.some(v=>Array.isArray(found)?found.includes(v):found===v);
    if(value&&typeof value==='object'&&'$ne'in value)return found!==value.$ne;
    return Array.isArray(found)?found.includes(value):found===value;
  });
}
test('DB read path supports only find/limit/toArray and never invokes writes or indexes',async()=>{
  const data=fixture(),collections={tournaments:data.documents,player_rating_state:[...data.histories.values()].map(h=>h.current),rating_events:[...data.histories.values()].flatMap(h=>h.events)};
  const db={collection(name){return new Proxy({find(query){let found=collections[name].filter(d=>matches(d,query));return {limit(n){found=found.slice(0,n);return this;},async toArray(){return structuredClone(found);}};}},{get(target,key){if(key!=='find')throw Error('WRITE_OR_UNEXPECTED_METHOD:'+String(key));return target[key];}});}};
  const report=await readFprCanonicalDryRun(db,data.rootId,capturedAt);
  assert.equal(report.summary.calculatedTournaments,1);assert.match(report.preimageSha256,/^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(report).includes('client:p0'),false);
});
test('runner rejects apply and all unknown flags before opening any connection',async()=>{
  await assert.rejects(()=>main(['--apply','true']),/ARGUMENTS/);
  await assert.rejects(()=>main(['--root','x','--apply','true']),/ARGUMENTS/);
});
test('level exclusions on either protocol or legacy source block the preview without exporting admin reasons',()=>{
  for(const legacy of [false,true]){
    const data=fixture(),exclusion={playerId:'p0',scopes:['level'],auditId:'admin',reason:'PRIVATE ADMIN REASON',recordedAt:'2026-11-05T00:00:00Z'};
    if(legacy)data.legacy=[{tournamentId:data.documents[0].params.sourceExerciseId,ratingExclusions:[exclusion]}];
    else data.documents[0].ratingExclusions=[exclusion];
    const report=planFprCanonicalDryRun(data);assert.equal(report.tournaments[0].error,'FPR_DRY_RUN_LEVEL_EXCLUDED');
    assert.equal(JSON.stringify(report).includes('PRIVATE ADMIN REASON'),false);
  }
});
test('unknown driver errors are reduced to an allowlisted code',()=>{
  assert.equal(dryRunError(Error('query phone: PRIVATE_CONTACT')),'FPR_DRY_RUN_READ_FAILED');
});
test('transitive closure includes a later FPR under a validated client alias and three new opponents',()=>{
  const data=fixture(),first=data.documents[0],rootHistory=data.histories.get('p0');
  rootHistory.current.identityAliases={clientIds:['p0','p0-alias']};rootHistory.aliases=['p0','p0-alias'];
  data.histories.set('p0-alias',rootHistory);
  const substitutions={p0:'p0-alias',p1:'p4',p2:'p5',p3:'p6'};
  const shifted=JSON.parse(JSON.stringify(first.params.fpr6x25),(key,value)=>{
    if(typeof value!=='string')return value;
    if(substitutions[value])return substitutions[value];
    if(/^2026-11-01T/.test(value))return new Date(Date.parse(value)+86400000).toISOString();
    return value;
  });
  shifted.tournamentId='fpr-followup';shifted.communityRating.sourceExerciseId='followup-source';
  const next={...structuredClone(first),tournamentId:shifted.tournamentId,params:{fpr6x25:shifted,sourceExerciseId:'followup-source'},participants:shifted.players.map(p=>({id:p.id,rating:p.level}))};
  const old=calculateFprTournamentRatings(shifted);
  for(const p of shifted.players){
    let h=data.histories.get(p.id);
    if(!h){const base=structuredClone(rootHistory.events[0]);base.id='base:'+p.id;base.player={clientId:p.id,key:'client:'+p.id};base.change.after=p.level;
      h={events:[base],current:{playerKey:'client:'+p.id,clientId:p.id},aliases:[p.id]};data.histories.set(p.id,h);}
    const prior=replayPlayerRatingEvents(h.events).ratingNumeric;
    const e=buildTournamentRatingEvent({tournamentId:'followup-source',finishedAt:shifted.finishedAt,standing:old.standings.find(r=>r.id===p.id),canonicalBefore:prior});
    Object.assign(e.source,{fprProtocolId:shifted.tournamentId,fprFinishedAt:shifted.finishedAt});h.events.push(e);
    const projection=replayPlayerRatingEvents(h.events);Object.assign(h.current,{ratingNumeric:projection.ratingNumeric,lastEventId:projection.lastEventId});
  }
  data.documents.push(next);
  const report=planFprCanonicalDryRun(data);assert.equal(report.summary.tournaments,2);assert.equal(report.summary.players,7);
  const root=report.tournaments[0].rows.find(r=>r.player==='root-01');
  assert.equal(report.tournaments[1].rows.find(r=>r.player==='root-01').cupStart,root.candidateAfter);
});
test('source formula or archive changes between the two read passes invalidate the report',async()=>{
  for(const field of ['formula','archived']){
    const data=fixture(),collections={tournaments:data.documents,player_rating_state:[...data.histories.values()].map(h=>h.current),rating_events:[...data.histories.values()].flatMap(h=>h.events)};
    let protocolReads=0;
    const db={collection(name){return{find(query){
      if(name==='tournaments'&&query.tournamentType==='fpr_6x25'&&++protocolReads===2){if(field==='formula')collections.tournaments[0].params.K=.8;else collections.tournaments[0].archived=true;}
      let found=collections[name].filter(d=>matches(d,query));return{limit(n){found=found.slice(0,n);return this;},async toArray(){return structuredClone(found);}};
    }};}};
    await assert.rejects(()=>readFprCanonicalDryRun(db,data.rootId,capturedAt),/PREIMAGE_CHANGED/);
  }
});

function appliedEvidence(data,bootstrapIds=[]){
  const histories=[...new Set(data.histories.values())],packet={preparedAt:'2026-11-05T10:00:00Z',runtimeManifestSha:'b'.repeat(64),runnerSha:'a'.repeat(64),protocolBackup:structuredClone(data.documents),
    plans:histories.map(h=>({clientId:h.current.clientId,current:bootstrapIds.includes(h.current.clientId)?null:{...h.current},
      existingEvents:bootstrapIds.includes(h.current.clientId)?[]:h.events.filter(e=>!e.source?.fprProtocolId),
      events:structuredClone(h.events.filter(e=>e.source?.fprProtocolId||e.source?.fprBootstrap))}))};
  const receipts=packet.plans.map(p=>({clientId:p.clientId,events:p.events.length,changed:true,projection:true,at:'2026-11-05T11:01:00Z'}));
  const input={packet,prepared:{packetSha:'c'.repeat(64)},intent:{packetSha:'c'.repeat(64),at:'2026-11-05T11:00:00Z'},
    applied:{players:packet.plans.length,events:packet.plans.reduce((n,p)=>n+p.events.length,0),at:'2026-11-05T11:02:00Z'},receipts,
    packetSha:'c'.repeat(64),manifestSha:'b'.repeat(64),runnerSha:'a'.repeat(64),orderedWrites:true};
  return {input,evidence:verifyFprHistoricalEvidence(input)};
}
function updateProjection(h){const state=replayPlayerRatingEvents(h.events);Object.assign(h.current,{ratingNumeric:state.ratingNumeric,lastEventId:state.lastEventId});}
function bootstrapFixture(zero=false){
  const data=fixture(),h=data.histories.get('p0'),award=h.events[1],level=zero?1:3.037;
  if(zero){data.documents[0].params.fpr6x25.players.find(p=>p.id==='p0').level=0;data.documents[0].participants[0].rating=0;}
  award.change.before=level;award.change.delta=Number((award.change.after-level).toFixed(5));
  award.source.fprUnratedStartApplied=zero;award.source.tournamentRatingSnapshot.before=level;
  const bootstrap={...structuredClone(h.events[0]),eventType:'RATING_BOOTSTRAPPED_FROM_TOURNAMENT',id:'bootstrap-p0',_id:'bootstrap-p0',
    occurredAt:new Date(Date.parse(award.occurredAt)-1).toISOString(),createdAt:'2026-11-05T10:00:00Z',source:{domain:'TOURNAMENT_BOOTSTRAP',sourceId:award.source.sourceId,fprBootstrap:true},change:{before:null,delta:null,after:level}};
  h.events=[bootstrap,award];updateProjection(h);
  data.historicalEvidence=appliedEvidence(data,['p0']).evidence;
  return data;
}
test('verified original CUP bootstrap/receipt reconstructs a first-participation anchor, never observed-at-start',()=>{
  for(const zero of [false,true]){
    const data=bootstrapFixture(zero),before=structuredClone(data.histories),report=planFprCanonicalDryRun(data);
    assert.equal(report.summary.blockedTournaments,0);assert.equal(report.summary.reconstructedInitialAnchors,1);
    assert.equal(report.reconstructedBaselines[0].value,zero?1:3.037);assert.equal(report.reconstructedBaselines[0].observedAtStart,false);
    assert.deepEqual(data.histories,before);
  }
});
test('bootstrap proof rejects nonempty prior history, wrong source, changed immutable event, zero-policy mismatch and duplicate baseline',()=>{
  for(const kind of ['prior','source','immutable','zero','duplicate']){
    const data=bootstrapFixture(kind==='zero'),h=data.histories.get('p0');
    if(kind==='prior')data.historicalEvidence.packet.plans[0].existingEvents=[{id:'old'}];
    if(kind==='source')data.historicalEvidence.packet.plans[0].events[0].source.sourceId='foreign';
    if(kind==='immutable')h.events[0].change.after=6;
    if(kind==='zero')data.historicalEvidence.packet.plans[0].events[1].source.fprUnratedStartApplied=false;
    if(kind==='duplicate')h.events.unshift({...structuredClone(h.events[0]),id:'other-bootstrap'});
    assert.throws(()=>reconstructedFprBaseline(h,data.documents,data.historicalEvidence),/FPR_DRY_RUN_EVIDENCE_/);
  }
});
test('packet chain rejects hash, runtime, receipt identity/count/time and applied-count mismatch',()=>{
  for(const kind of ['hash','runtime','identity','count','time','applied','ordered']){
    const {input}=appliedEvidence(fixture());
    if(kind==='hash')input.prepared.packetSha='d'.repeat(64);
    if(kind==='runtime')input.manifestSha='d'.repeat(64);
    if(kind==='identity')input.receipts[0].clientId='foreign';
    if(kind==='count')input.receipts[0].events++;
    if(kind==='time')input.receipts[0].at='2026-11-06T00:00:00Z';
    if(kind==='applied')input.applied.events++;
    if(kind==='ordered')input.orderedWrites=false;
    assert.throws(()=>verifyFprHistoricalEvidence(input),/FPR_DRY_RUN_EVIDENCE_/);
  }
});
function tiedFixture(count=2,later='none'){
  const data=fixture(),h=data.histories.get('p0');
  for(let i=1;i<count;i++){
    const e=structuredClone(h.events[1]);e.id='tie-'+i;e._id=e.id;e.source.sourceId='tie-source-'+i;e.source.fprProtocolId='tie-protocol-'+i;e.change.after=4+i/10;e.change.delta=0;h.events.push(e);
  }
  data.historicalEvidence=appliedEvidence(data).evidence;
  if(later!=='none')h.events.push({id:'later',eventType:later==='game'?'GAME_RESULT_CONFIRMED':'TOURNAMENT_RATING_FINALIZED',occurredAt:'2026-11-04T10:00:00Z',
    source:{domain:later==='game'?'GAME_RESULT':'TOURNAMENT',sourceId:'late'},change:{delta:later==='game'?.1:0,after:5.2}});
  updateProjection(h);return data;
}
test('two/three equal-time absolute targets preserve verified apply order, later game and ordinary target semantics',()=>{
  for(const count of [2,3])for(const later of ['none','game','ordinary']){
    const data=tiedFixture(count,later),before=structuredClone(data.histories),report=planFprCanonicalDryRun(data);
    const row=report.players.find(p=>p.player==='root-01');
    const expected=later==='ordinary'?5.2:Number((4+(count-1)/10+(later==='game'?.1:0)).toFixed(5));
    assert.equal(row.candidate,expected);assert.equal(report.temporalWarnings.length,0);assert.equal(report.temporalResolutions.length,1);
    assert.equal(report.temporalResolutions[0].actualPlayedAtKnown,false);assert.deepEqual(data.histories,before);
  }
});
test('equal-time evidence does not absorb an unrecorded correction or mixed non-FPR event',()=>{
  const data=tiedFixture(),h=data.histories.get('p0'),group=h.events.filter(e=>e.source?.fprProtocolId);
  assert.throws(()=>evidencedFprTargetOrder(h,[...group,{...group[0],id:'uncovered-correction'}],data.historicalEvidence),/IMMUTABLE_EVENT/);
  h.events.push({id:'mixed',eventType:'GAME_RESULT_CONFIRMED',occurredAt:group[0].occurredAt,source:{domain:'GAME_RESULT'},change:{delta:0}});updateProjection(h);
  const report=planFprCanonicalDryRun(data);assert.equal(report.players.find(p=>p.player==='root-01').error,'FPR_DRY_RUN_TIME_MIXED_EVENTS');
});
test('compensated earlier FPR retains firstAt semantics before the verified tie group',()=>{
  const data=tiedFixture(),h=data.histories.get('p0'),original=structuredClone(h.events[1]);
  original.id='prior-fpr';original._id=original.id;original.occurredAt='2026-10-20T00:00:00Z';original.source.fprFinishedAt=original.occurredAt;original.source.sourceId='prior';original.change.delta=0;
  const compensation={...structuredClone(original),id:'prior-compensation',occurredAt:'2026-10-21T00:00:00Z',source:{...original.source,compensatesEventId:original.id}};
  const target={id:'prior-ordinary',eventType:'TOURNAMENT_RATING_FINALIZED',occurredAt:'2026-10-22T00:00:00Z',source:{domain:'TOURNAMENT'},change:{delta:0,after:3.8}};
  h.events.push(original,compensation,target);updateProjection(h);
  const report=planFprCanonicalDryRun(data);
  assert.equal(report.tournaments[0].rows.find(p=>p.player==='root-01').cupStart,3.8);
});
test('partial evidence CLI arguments fail before opening Mongo',async()=>{
  await assert.rejects(()=>main(['--root','x','--backfill-operation','/root/private']),/EVIDENCE_ARGUMENTS/);
});
test('duplicate active revisions for a predecessor source do not silently use event-ID order',()=>{
  const data=fixture(),h=data.histories.get('p0'),prior=structuredClone(h.events[1]);
  prior.id='prior-1';prior._id=prior.id;prior.occurredAt='2026-10-20T00:00:00Z';prior.source.fprFinishedAt=prior.occurredAt;prior.source.sourceId='prior-source';prior.source.fprProtocolId='prior-protocol';prior.change.delta=0;
  h.events.push(prior,{...structuredClone(prior),id:'prior-2',_id:'prior-2'});updateProjection(h);
  assert.equal(planFprCanonicalDryRun(data).tournaments[0].error,'FPR_DRY_RUN_ACTIVE_AWARD_NOT_UNIQUE');
});
test('historical evidence changing between read passes rejects the complete report',async()=>{
  const data=fixture(),collections={tournaments:data.documents,player_rating_state:[...data.histories.values()].map(h=>h.current),rating_events:[...data.histories.values()].flatMap(h=>h.events)};
  const db={collection(name){return{find(query){let found=collections[name].filter(d=>matches(d,query));return{limit(n){found=found.slice(0,n);return this;},async toArray(){return structuredClone(found);}};}};}};
  let reads=0;
  await assert.rejects(()=>readFprCanonicalDryRun(db,data.rootId,capturedAt,{readHistoricalEvidence:()=>({fingerprint:'evidence-'+ ++reads})}),/PREIMAGE_CHANGED/);
});
