import crypto from 'node:crypto';
import { calculateFprTournamentRatings } from '../../src/services/player-rating/fprTournamentRating.ts';
import { replayPlayerRatingEvents } from '../../src/services/player-rating/ledger.ts';
import { replayFprRatingTargets } from '../../src/services/player-rating/fprRatingReplay.ts';
import { readFprLevelIdentityHistory } from './fprLevelIdentity.mjs';
import { getTournamentRatingExclusion } from '../../src/services/player-rating/tournamentExclusionGuard.ts';
import { reconstructedFprBaseline, evidencedFprTargetOrder } from './fprHistoricalEvidence.mjs';

const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const round = n => Number(n.toFixed(5));
const source = d => d.params?.fpr6x25?.communityRating?.sourceExerciseId || d.params?.sourceExerciseId || d.tournamentId;
const start = d => Date.parse(d.params?.fpr6x25?.leagueSnapshotAt);
const eventAt = e => Date.parse(e.occurredAt || e.createdAt);
const targetAt=e=>e.source?.fprProtocolId?Date.parse(e.source.fprFinishedAt):eventAt(e);
const isBaseline=e=>['RATING_INITIAL_IMPORTED','RATING_BOOTSTRAPPED_FROM_VIVA','RATING_BOOTSTRAPPED_FROM_TOURNAMENT','RATING_BOOTSTRAPPED_FROM_GAME_RESULT','RATING_TOURNAMENT_CANONICAL_RECONCILED'].includes(e.eventType);
export const dryRunError = e => /^FPR_(?:DRY_RUN|LEVEL)_[A-Z_]+$/.test(String(e?.message)) ? e.message : 'FPR_DRY_RUN_READ_FAILED';
const activeAwards = events => {
  const compensated = new Set(events.map(e => e.source?.compensatesEventId).filter(Boolean));
  return events.filter(e => e.source?.fprProtocolId && e.source.applyToState !== false
    && !e.source.compensatesEventId && !compensated.has(e.id)
    && ['TOURNAMENT_RATING_FINALIZED','TOURNAMENT_RATING_CORRECTION_APPLIED'].includes(e.eventType));
};

/** Read-only counterfactual. Never mutate immutable events, scores, seeds, or a DB. */
export function planFprCanonicalDryRun({ documents, legacy = [], histories, rootId, capturedAt, historicalEvidence = null }) {
  const official = documents.filter(d => d.archived !== true && d.tournamentType === 'fpr_6x25'
    && d.params?.fpr6x25?.testMode === false && d.params.fpr6x25.status === 'completed');
  const root = official.find(d => d.tournamentId === rootId);
  if (!root || official.filter(d=>d.tournamentId===rootId).length !== 1) throw Error('FPR_DRY_RUN_ROOT_NOT_UNIQUE');
  if (official.some(d=>!Number.isFinite(start(d)))) throw Error('FPR_DRY_RUN_START_TIME_MISSING');
  const identity = id => histories.get(id)?.current?.playerKey || `raw:${id}`;
  const affected = new Set(root.params.fpr6x25.players.map(p=>identity(p.id)));
  const selected = new Set([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const d of official.filter(d=>start(d)>=start(root)).sort((a,b)=>start(a)-start(b))) {
      if (!selected.has(d.tournamentId) && d.params.fpr6x25.players.some(p=>affected.has(identity(p.id)))) {
        selected.add(d.tournamentId); d.params.fpr6x25.players.forEach(p=>affected.add(identity(p.id))); grew=true;
      }
    }
  }
  const cohort = official.filter(d=>selected.has(d.tournamentId)).sort((a,b)=>start(a)-start(b)||a.tournamentId.localeCompare(b.tournamentId));
  const aliases = new Map(root.params.fpr6x25.players.map(p=>[p.id,`root-${String(p.seed).padStart(2,'0')}`]));
  const identityAliases=new Map([...aliases].map(([id,alias])=>[identity(id),alias]));
  const playerIds=new Map(root.params.fpr6x25.players.map(p=>[identity(p.id),p.id]));
  for (const d of cohort) for (const p of d.params.fpr6x25.players) {
    if(!identityAliases.has(identity(p.id)))identityAliases.set(identity(p.id),`player-${String(identityAliases.size+1).padStart(3,'0')}`);
    aliases.set(p.id,identityAliases.get(identity(p.id)));if(!playerIds.has(identity(p.id)))playerIds.set(identity(p.id),p.id);
  }
  const replacements = new Map(), blockedSources = new Set(), tournamentReports = [], blockers = [];
  const anchors=new Map(),tieResolutions=new Map();
  const historiesFor = id => {
    const h = histories.get(id);
    if (!h || h.error) throw Error(h?.error || 'FPR_DRY_RUN_IDENTITY_MISSING');
    return h;
  };
  const replay = (id, cutoff, useReplacement) => {
    const h = historiesFor(id);
    if(historicalEvidence&&!h.events.some(e=>isBaseline(e)&&e.source?.applyToState!==false&&eventAt(e)<cutoff)&&!anchors.has(identity(id))){
      anchors.set(identity(id),reconstructedFprBaseline(h,documents,historicalEvidence));
    }
    const anchor=anchors.get(identity(id));
    const virtual=anchor?h.events.map(e=>e.id===anchor.eventId?{...e,occurredAt:anchor.virtualAt}:e):h.events;
    const input = virtual.filter(e=>eventAt(e)<cutoff && e.source?.applyToState !== false);
    if (input.some(e=>e.source?.fprProtocolId && blockedSources.has(e.source.sourceId))) throw Error('FPR_DRY_RUN_BLOCKED_PREDECESSOR');
    const active = activeAwards(input), times = new Map(),omit=new Set();
    for (const e of active) {
      const time=targetAt(e);if(!Number.isFinite(time)||time!==eventAt(e))throw Error('FPR_DRY_RUN_AWARD_TIME_MISMATCH');
      const group=times.get(time)||[];group.push(e);times.set(time,group);
    }
    for(const [time,group]of times)if(group.length>1){
      if(new Set(group.map(e=>e.source.sourceId)).size!==group.length)throw Error('FPR_DRY_RUN_ACTIVE_AWARD_NOT_UNIQUE');
      if(!historicalEvidence)throw Error('FPR_DRY_RUN_TIME_AMBIGUOUS');
      const ids=new Set(group.map(e=>e.id));
      if(input.some(e=>targetAt(e)===time&&!ids.has(e.id)))throw Error('FPR_DRY_RUN_TIME_MIXED_EVENTS');
      const resolution=evidencedFprTargetOrder(h,group,historicalEvidence);
      tieResolutions.set(identity(id)+':'+time,{player:aliases.get(id),...resolution.proof});
      // For a pure group of absolute targets, every earlier ACTIVE target is
      // overwritten by the last. Keep all compensated originals/compensations
      // elsewhere intact for the installed source-aware replay semantics.
      group.forEach(e=>{if(e.id!==resolution.lastEventId)omit.add(e.id);});
    }
    const events = input.filter(e=>!omit.has(e.id)).map(e=> useReplacement && replacements.has(e.id)
      ? { ...e, change: { ...e.change, after: replacements.get(e.id) } } : e);
    const state = replayFprRatingTargets(events) || replayPlayerRatingEvents(events);
    if (!state || !Number.isFinite(state.ratingNumeric)) throw Error('FPR_DRY_RUN_BASELINE_MISSING');
    return state.ratingNumeric;
  };
  for (const d of cohort) {
    const record = { protocolId:d.tournamentId, sourceEventId:source(d), date:d.params.localDateKey || null,
      frozenAt:d.params.fpr6x25.leagueSnapshotAt, recordedFinishedAt:d.params.fpr6x25.finishedAt,
      sourceSha256:hash(d.params.fpr6x25), status:'calculated', rows:[] };
    try {
      if (official.filter(other=>source(other)===source(d)).length !== 1) throw Error('FPR_DRY_RUN_SOURCE_AMBIGUOUS');
      if(new Set(d.params.fpr6x25.players.map(p=>identity(p.id))).size!==d.params.fpr6x25.players.length)throw Error('FPR_DRY_RUN_ROSTER_IDENTITY_CONFLICT');
      const originals=legacy.filter(other=>other.tournamentId===source(d));
      if(originals.length>1)throw Error('FPR_DRY_RUN_LEGACY_SOURCE_AMBIGUOUS');
      if(d.params.fpr6x25.players.some(p=>getTournamentRatingExclusion(d,p.id,'level')||originals.some(l=>getTournamentRatingExclusion(l,p.id,'level'))))throw Error('FPR_DRY_RUN_LEVEL_EXCLUDED');
      const copied = structuredClone(d.params.fpr6x25);
      const before = new Map();
      for (const p of copied.players) {
        let rating;
        try { rating = replay(p.id,start(d),true); }
        catch(e) { record.blockedPlayer=aliases.get(p.id);record.blockedFrozenStart=p.level;throw e; }
        if (rating<1 || rating>7) throw Error('FPR_DRY_RUN_START_OUT_OF_RANGE');
        before.set(p.id,rating); p.level=rating;
      }
      const calculated = calculateFprTournamentRatings(copied,{ params:d.params, participants:d.participants, unratedStartLevel:1 });
      const pending = [];
      for (const row of calculated.standings) {
        const h=historiesFor(row.id), awards=activeAwards(h.events).filter(e=>e.source.sourceId===source(d));
        if (awards.length!==1 || awards[0].source.fprProtocolId!==d.tournamentId) throw Error('FPR_DRY_RUN_ACTIVE_AWARD_NOT_UNIQUE');
        const old=awards[0];
        pending.push([old.id,row.ratingAfter]);
        record.rows.push({ player:aliases.get(row.id), seed:row.seed,
          frozenStart:d.params.fpr6x25.players.find(p=>p.id===row.id).level, cupStart:before.get(row.id),
          previousAfter:old.change.after, candidateAfter:row.ratingAfter, matchDelta:row.ratingDelta,
          difference:round(row.ratingAfter-old.change.after) });
      }
      pending.forEach(([id,value])=>replacements.set(id,value));
    } catch (e) {
      record.status='blocked'; record.error=dryRunError(e); record.rows=[];
      blockedSources.add(source(d)); blockers.push({ protocolId:d.tournamentId,code:record.error });
    }
    tournamentReports.push(record);
  }
  const players=[];
  for (const id of playerIds.values()) {
    const row={ player:aliases.get(id), status:'calculated' };
    try {
      const h=historiesFor(id), ordinary=replayPlayerRatingEvents(h.events);
      if (!h.current || ordinary?.ratingNumeric!==h.current.ratingNumeric || ordinary.lastEventId!==h.current.lastEventId) throw Error('FPR_DRY_RUN_CURRENT_PROJECTION_DRIFT');
      row.current=h.current.ratingNumeric;
      row.candidate=replay(id,Date.parse(capturedAt)+1,true);
      row.difference=round(row.candidate-row.current);
    } catch(e) { row.status='blocked';row.error=dryRunError(e);blockers.push({player:row.player,code:row.error}); }
    players.push(row);
  }
  const temporalWarnings=[];
  for(const id of playerIds.values()){
    const h=histories.get(id);if(!h?.events)continue;
    const byTime=new Map();
    for(const e of activeAwards(h.events)){
      const key=eventAt(e),group=byTime.get(key)||new Set();group.add(e.source.fprProtocolId);byTime.set(key,group);
    }
    for(const [time,protocols]of byTime)if(protocols.size>1&&!tieResolutions.has(identity(id)+':'+time))temporalWarnings.push({player:aliases.get(id),code:'FPR_DRY_RUN_TIME_AMBIGUOUS',recordedAt:new Date(time).toISOString(),protocols:[...protocols].sort()});
  }
  return { version:2, mode:'READ_ONLY_DRY_RUN', applyAvailable:false, applyReady:false, capturedAt, rootProtocolId:rootId,
    timePolicy:'CUP ledger before freeze; verified initial bootstrap anchors reconstructed in memory; original award timestamps retained; verified ordered-apply receipts resolve pure equal-time target groups',
    laterEventPolicy:'Recalculate affected FPR targets; preserve later ordinary/manual absolute targets and additive game deltas',
    summary:{tournaments:cohort.length,players:affected.size,calculatedTournaments:tournamentReports.filter(r=>r.status==='calculated').length,
      blockedTournaments:tournamentReports.filter(r=>r.status==='blocked').length,changedCurrentPlayers:players.filter(r=>r.status==='calculated'&&r.difference!==0).length,
      reconstructedInitialAnchors:anchors.size,resolvedTieGroups:tieResolutions.size},
    tournaments:tournamentReports,players,blockers,temporalWarnings,
    historicalEvidence:historicalEvidence?.summary||null,
    reconstructedBaselines:[...anchors].map(([key,a])=>({player:identityAliases.get(key),...a.proof})),
    temporalResolutions:[...tieResolutions.values()] };
}

/** Only find/toArray reads, with a second exact-preimage pass. No service init/indexes. */
export async function readFprCanonicalDryRun(db, rootId, capturedAt=new Date().toISOString(),options={}) {
  const collect=async()=>{
    const documents=await db.collection('tournaments').find({tournamentType:'fpr_6x25'},{maxTimeMS:10000}).limit(1001).toArray();
    if(documents.length>1000) throw Error('FPR_DRY_RUN_PROTOCOL_CAP');
    const root=documents.find(d=>d.tournamentId===rootId);if(!root)throw Error('FPR_DRY_RUN_ROOT_MISSING');
    const ids=new Set(root.params.fpr6x25.players.map(p=>p.id)),histories=new Map();
    let changed=true;
    while(changed){
      changed=false;
      for(const id of [...ids].sort())if(!histories.has(id)){
        try{histories.set(id,await readFprLevelIdentityHistory(db,id));}catch(e){histories.set(id,{error:dryRunError(e)});}
      }
      const knownIds=new Set([...ids,...[...histories.values()].flatMap(h=>h.aliases||[])]);
      for(const d of documents){if(d.archived===true||d.params?.fpr6x25?.testMode!==false||d.params.fpr6x25.status!=='completed'||start(d)<start(root))continue;
        if(d.params.fpr6x25.players.some(p=>knownIds.has(p.id)))for(const p of d.params.fpr6x25.players)if(!ids.has(p.id)){ids.add(p.id);changed=true;}}
      if(ids.size>500)throw Error('FPR_DRY_RUN_COHORT_CAP');
    }
    const physicalIds=[...new Set(documents.map(source))];
    const legacy=await db.collection('tournaments').find({tournamentId:{$in:physicalIds},tournamentType:{$ne:'fpr_6x25'}},{maxTimeMS:10000}).limit(2001).toArray();
    if(legacy.length>2000)throw Error('FPR_DRY_RUN_LEGACY_CAP');
    const semanticDoc=d=>{const copy={...d};delete copy.fprLevelResults;delete copy.fprLevelLedgerFence;return copy;};
    const historicalEvidence=options.readHistoricalEvidence?options.readHistoricalEvidence():null;
    const fingerprint=hash([documents.map(semanticDoc),legacy.map(semanticDoc),
      [...histories].map(([id,h])=>[id,h.error,h.current,h.aliases,h.events]),historicalEvidence?.fingerprint]);
    return {documents,legacy,histories,historicalEvidence,fingerprint};
  };
  const before=await collect();const report=planFprCanonicalDryRun({...before,rootId,capturedAt});const after=await collect();
  if(before.fingerprint!==after.fingerprint)throw Error('FPR_DRY_RUN_PREIMAGE_CHANGED');
  return {...report,preimageSha256:before.fingerprint};
}
