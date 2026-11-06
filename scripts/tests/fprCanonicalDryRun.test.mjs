import test from 'node:test';
import assert from 'node:assert/strict';
import { ratingFixture } from './helpers/fprRatingFixture.ts';
import { calculateFprTournamentRatings } from '../../src/services/player-rating/fprTournamentRating.ts';
import { buildTournamentRatingEvent, replayPlayerRatingEvents } from '../../src/services/player-rating/ledger.ts';
import { planFprCanonicalDryRun, readFprCanonicalDryRun, dryRunError } from '../lib/fprCanonicalDryRun.mjs';
import { main } from '../dry_run_fpr_canonical_starts.mjs';
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
