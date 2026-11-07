import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

export const evidenceHash = value => crypto.createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(stable(value))).digest('hex');
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'
  ? value instanceof Date?value.toISOString():Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])])):value;
const check=(condition,code)=>{if(!condition)throw Error('FPR_DRY_RUN_EVIDENCE_'+code);};
const at=value=>Date.parse(value);
const baselineTypes=new Set(['RATING_INITIAL_IMPORTED','RATING_BOOTSTRAPPED_FROM_VIVA','RATING_BOOTSTRAPPED_FROM_TOURNAMENT','RATING_BOOTSTRAPPED_FROM_GAME_RESULT','RATING_TOURNAMENT_CANONICAL_RECONCILED']);
const applies=e=>e.source?.applyToState!==false;

/** Validate the original durable apply chain; receipts bind their numbered plan via apply-intent's packet hash. */
export function verifyFprHistoricalEvidence({packet,prepared,intent,applied,receipts,packetSha,manifestSha,runnerSha,orderedWrites}) {
  check(/^[a-f0-9]{64}$/.test(packetSha)&&prepared.packetSha===packetSha&&intent.packetSha===packetSha,'PACKET_HASH');
  check(packet.runtimeManifestSha===manifestSha&&packet.runnerSha===runnerSha&&orderedWrites===true,'RUNTIME');
  check(Array.isArray(packet.plans)&&packet.plans.length>0&&packet.plans.length<=500&&receipts.length===packet.plans.length,'PLANS');
  check(applied.players===packet.plans.length&&applied.events===packet.plans.reduce((n,p)=>n+p.events.length,0),'APPLIED');
  check(Number.isFinite(at(packet.preparedAt))&&at(packet.preparedAt)<=at(intent.at)&&at(intent.at)<=at(applied.at),'TIME');
  const seen=new Set();
  packet.plans.forEach((p,i)=>{
    check(typeof p.clientId==='string'&&!seen.has(p.clientId)&&Array.isArray(p.events)&&p.events.length<=1000,'PLAN_IDENTITY');seen.add(p.clientId);
    const r=receipts[i];
    check(r.clientId===p.clientId&&r.events===p.events.length&&typeof r.changed==='boolean'&&typeof r.projection==='boolean'
      &&at(r.at)>=at(intent.at)&&at(r.at)<=at(applied.at),'RECEIPT');
  });
  return {packet,receipts,packetSha,manifestSha,runnerSha,
    fingerprint:evidenceHash({packetSha,manifestSha,runnerSha,prepared,intent,applied,receipts}),
    summary:{policy:'VERIFIED_BACKFILL_INITIAL_ANCHORS_AND_APPLIED_ORDER',packetSha256:packetSha,runtimeManifestSha256:manifestSha,runnerSha256:runnerSha,plans:packet.plans.length,receipts:receipts.length}};
}

/** Server-only file reads. Full packets, aliases and receipt contents never enter the public report. */
export function loadFprHistoricalEvidence({operation,runtime,runner,expectedSha}) {
  const op=fs.realpathSync(operation),rt=fs.realpathSync(runtime),run=fs.realpathSync(runner);
  check(op===operation&&/^\/root\/\.padlhub-fpr-level-backfill-[a-z0-9-]+$/.test(op),'OPERATION_PATH');
  check(rt===runtime&&rt.startsWith('/opt/padlhub-rating-worker/releases/')&&run===runner&&run.startsWith('/root/.padlhub-fpr-level-source-'),'SOURCE_PATH');
  const stat=fs.lstatSync(op);check(stat.isDirectory()&&stat.uid===0&&!(stat.mode&0o077),'CUSTODY');
  const privateBytes=name=>{const file=path.join(op,name),s=fs.lstatSync(file);check(s.isFile()&&!s.isSymbolicLink()&&s.uid===0&&!(s.mode&0o077)&&s.nlink===1,'CUSTODY');return fs.readFileSync(file);};
  const manifestBytes=fs.readFileSync(path.join(rt,'release-manifest.json')),manifest=JSON.parse(manifestBytes);
  check(Array.isArray(manifest.files)&&manifest.files.length<1000,'MANIFEST');
  for(const f of manifest.files){
    check(typeof f.path==='string'&&!path.isAbsolute(f.path)&&!f.path.split('/').includes('..'),'MANIFEST_PATH');
    const file=path.join(rt,f.path);check(fs.realpathSync(file)===file&&fs.lstatSync(file).isFile()&&evidenceHash(fs.readFileSync(file))===f.sha256,'MODULE_HASH');
  }
  const {BSON}=createRequire(path.join(rt,'package.json'))('mongodb');
  const read=name=>BSON.EJSON.parse(privateBytes(name).toString('utf8'),{relaxed:true});
  const bytes=privateBytes('packet.ejson'),packetSha=evidenceHash(bytes);check(packetSha===expectedSha,'PIN');
  const packet=BSON.EJSON.parse(bytes.toString('utf8'),{relaxed:true});
  const writer=fs.readFileSync(path.join(rt,'scripts/lib/fprLevelLedger.mjs'),'utf8');
  const receipts=packet.plans.map((_,i)=>read(`player-${String(i).padStart(3,'0')}.ejson`));
  return verifyFprHistoricalEvidence({packet,prepared:read('prepared.ejson'),intent:read('apply-intent.ejson'),applied:read('applied.ejson'),receipts,
    packetSha,manifestSha:evidenceHash(manifestBytes),runnerSha:evidenceHash(fs.readFileSync(run)),orderedWrites:/bulkWrite\([\s\S]*?ordered:\s*true/.test(writer)});
}

function matchedPlan(history,evidence) {
  check(evidence?.packet&&evidence?.fingerprint,'MISSING');
  const matches=evidence.packet.plans.map((plan,index)=>({plan,index})).filter(({plan})=>history.aliases.includes(plan.clientId));
  check(matches.length===1,'PLAN_IDENTITY');return matches[0];
}
function verifyEvent(history,plan,event) {
  const original=plan.events.filter(e=>e.id===event.id),actual=history.events.filter(e=>e.id===event.id);
  check(original.length===1&&actual.length===1&&evidenceHash(original[0])===evidenceHash(event)&&evidenceHash(actual[0])===evidenceHash(event),'IMMUTABLE_EVENT');
}

/** A CUP bootstrap recorded at first-result time becomes an explicitly reconstructed initial anchor, only in memory. */
export function reconstructedFprBaseline(history,documents,evidence) {
  const {plan,index}=matchedPlan(history,evidence);
  check(plan.current===null&&Array.isArray(plan.existingEvents)&&plan.existingEvents.length===0,'INITIAL_PREIMAGE');
  const bases=history.events.filter(e=>applies(e)&&baselineTypes.has(e.eventType));
  check(bases.length===1,'BASELINE_UNIQUE');const event=bases[0];verifyEvent(history,plan,event);
  check(event.eventType==='RATING_BOOTSTRAPPED_FROM_TOURNAMENT'&&event.source.domain==='TOURNAMENT_BOOTSTRAP'&&event.source.fprBootstrap===true
    &&event.change.before===null&&event.change.delta===null&&Number.isFinite(event.change.after)&&event.change.after>=1&&event.change.after<=7,'BOOTSTRAP');
  const first=plan.events.find(e=>e.source?.fprProtocolId&&!e.source.compensatesEventId);
  check(first&&first.source.sourceId===event.source.sourceId&&at(event.occurredAt)===at(first.occurredAt)-1&&event.createdAt===evidence.packet.preparedAt,'FIRST_SOURCE');
  verifyEvent(history,plan,first);
  check(!history.events.some(e=>applies(e)&&e.id!==event.id&&at(e.occurredAt||e.createdAt)<at(first.occurredAt)),'EARLIER_HISTORY');
  const originals=evidence.packet.protocolBackup.filter(d=>d.tournamentId===first.source.fprProtocolId);
  const current=documents.filter(d=>d.tournamentId===first.source.fprProtocolId);
  check(originals.length===1&&current.length===1,'SOURCE_DOCUMENT');
  const state=originals[0].params?.fpr6x25,live=current[0].params?.fpr6x25;
  check(state?.status==='completed'&&state.testMode===false&&state.communityRating?.sourceExerciseId===event.source.sourceId,'SOURCE_DOCUMENT');
  const p=state.players.filter(p=>history.aliases.includes(p.id)),lp=live.players.filter(p=>history.aliases.includes(p.id));
  check(p.length===1&&lp.length===1&&p[0].level===lp[0].level&&state.leagueSnapshotAt===live.leagueSnapshotAt,'FROZEN_INPUT');
  const value=p[0].level===0?1:p[0].level;
  check(value===event.change.after&&first.source.tournamentRatingSnapshot?.before===value
    &&first.source.fprUnratedStartApplied===(p[0].level===0),'BOOTSTRAP_VALUE');
  const freeze=at(state.leagueSnapshotAt);check(Number.isFinite(freeze)&&freeze<at(event.occurredAt),'FREEZE_TIME');
  check(!documents.some(d=>d.tournamentType==='fpr_6x25'&&d.archived!==true&&d.params?.fpr6x25?.testMode===false&&d.params.fpr6x25.status==='completed'
    &&at(d.params.fpr6x25.leagueSnapshotAt)<freeze&&d.params.fpr6x25.players.some(p=>history.aliases.includes(p.id))),'EARLIER_SOURCE');
  return {eventId:event.id,virtualAt:new Date(freeze-1).toISOString(),proof:{kind:'RECONSTRUCTED_CANONICAL_INITIAL_ANCHOR',value,
    observedAtStart:false,sourceProtocolId:first.source.fprProtocolId,recordedAt:event.occurredAt,createdAt:event.createdAt,
    virtualAnchorAt:new Date(freeze-1).toISOString(),eventSha256:evidenceHash(event),packetSha256:evidence.packetSha,
    receiptSha256:evidenceHash(evidence.receipts[index]),unratedStartApplied:p[0].level===0}};
}

/** Recover accepted application sequence, never pretend to recover actual play times. */
export function evidencedFprTargetOrder(history,group,evidence) {
  const {plan,index}=matchedPlan(history,evidence);
  const ordered=group.map(e=>{verifyEvent(history,plan,e);check(e.occurredAt===e.source.fprFinishedAt,'AWARD_TIME');return{event:e,ordinal:plan.events.findIndex(p=>p.id===e.id)};}).sort((a,b)=>a.ordinal-b.ordinal);
  check(new Set(ordered.map(r=>r.ordinal)).size===group.length,'ORDINAL');
  return {lastEventId:ordered.at(-1).event.id,proof:{kind:'RECORDED_ORDERED_BACKFILL_APPLICATION',recordedAt:ordered[0].event.occurredAt,
    actualPlayedAtKnown:false,packetSha256:evidence.packetSha,receiptSha256:evidenceHash(evidence.receipts[index]),
    order:ordered.map(({event,ordinal})=>({protocolId:event.source.fprProtocolId,ordinal,eventSha256:evidenceHash(event)}))}};
}
