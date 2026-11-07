import test from 'node:test';
import assert from 'node:assert/strict';
import { ratingFixture } from './helpers/fprRatingFixture.ts';
import { fprProjection } from '../../src/components/tournaments/fpr6x25.ts';
import { replayPlayerRatingEvents } from '../../src/services/player-rating/ledger.ts';
import { calculateFprTournamentRatings } from '../../src/services/player-rating/fprTournamentRating.ts';
import { assertFprPlanIdentityDisjoint, selectFprLevelSources, buildFprPlayerEvents, buildFprProjectionOutbox, fprLevelHash } from '../lib/fprLevelLedger.mjs';

const now = '2026-11-05T10:00:00.000Z';
function context() {
  const state = ratingFixture(8, 7);
  const document = { _id: 'synthetic-document', tournamentId: state.tournamentId, tournamentType: 'fpr_6x25',
    participants: state.players, ...fprProjection(state, { sourceExerciseId: state.communityRating.sourceExerciseId }) };
  const context = selectFprLevelSources([document]);
  context.ratings = new Map([[state.communityRating.sourceExerciseId,
    calculateFprTournamentRatings(state, { participants: document.participants, unratedStartLevel: 1 })]]);
  return { context, document };
}
test('only one eligible physical-event owner; test and ambiguous protocols never become last-write-wins', () => {
  const { document } = context();
  const other = structuredClone(document);
  other.tournamentId = other.params.fpr6x25.tournamentId = 'fpr-other';
  assert.equal(selectFprLevelSources([document, other]).selected.size, 0);
  assert.deepEqual(selectFprLevelSources([document, other]).ambiguous, ['synthetic-source']);
  other.params.fpr6x25.testMode = true;
  assert.equal(selectFprLevelSources([other, document]).selected.size, 1);
  assert.equal(selectFprLevelSources([document, other]).protectedIds.size, 1);
});
test('exact event identity mismatch fails closed', () => {
  const { document } = context();
  document.params.sourceExerciseId = 'another';
  assert.throws(() => selectFprLevelSources([document]), /SOURCE_CONFLICT/);
});
test('archived and never-finished FPR drafts cannot suppress an ordinary completed source', () => {
  const { document } = context();
  const legacy = { tournamentId: 'synthetic-source', tournamentType: 'mexicano', params: { finished: true },
    standings: [{ id: 'p0', wins: 4, pointsFor: 100, ratingDelta: 0.1 }] };
  assert.equal(selectFprLevelSources([{ ...document, archived: true }], [legacy]).protectedIds.size, 0);
  const unfinished = structuredClone(document); unfinished.params.fpr6x25.status = 'in_progress'; unfinished.params.fpr6x25.finishedAt = null;
  assert.equal(selectFprLevelSources([unfinished], [legacy]).protectedIds.size, 0);
  const conflict = selectFprLevelSources([document], [legacy]);
  assert.equal(conflict.selected.size, 0);
  assert.deepEqual(conflict.ambiguous, ['synthetic-source']);
});
test('new FPR uses canonical event identity, bootstraps once, and a second plan adds nothing', () => {
  const { context: c } = context();
  const first = buildFprPlayerEvents({ clientId: 'p0', events: [], context: c, nowIso: now });
  assert.equal(first.events.filter(e => e.eventType === 'RATING_BOOTSTRAPPED_FROM_TOURNAMENT').length, 1);
  assert.equal(first.events.filter(e => e.eventType === 'TOURNAMENT_RATING_FINALIZED').length, 1);
  assert.equal(first.events.find(e => e.source.domain === 'TOURNAMENT').source.sourceId, 'synthetic-source');
  assert.equal(first.replay.ratingNumeric, c.ratings.get('synthetic-source').standings.find(p => p.id === 'p0').ratingAfter);
  const again = buildFprPlayerEvents({ clientId: 'p0', events: first.events, context: c, nowIso: '2026-11-05T11:00:00Z' });
  assert.equal(again.events.length, 0);
});
test('the same physical source cannot receive an ordinary and FPR award', () => {
  const { context: c } = context();
  const first = buildFprPlayerEvents({ clientId: 'p0', events: [], context: c, nowIso: now });
  const ordinary = structuredClone(first.events.find(e => e.source.domain === 'TOURNAMENT'));
  delete ordinary.source.fprProtocolId;
  assert.throws(() => buildFprPlayerEvents({ clientId: 'p0', events: [ordinary], context: c, nowIso: now }), /EXISTING_AWARD_COLLISION/);
});
test('an inherited level exclusion compensates only its own award and preserves source sports data', () => {
  const { context: c, document } = context();
  const first = buildFprPlayerEvents({ clientId: 'p0', events: [], context: c, nowIso: now });
  const before = structuredClone(document.params.fpr6x25);
  c.selected.get('synthetic-source').legacy = { tournamentId: 'synthetic-source', ratingExclusions: [{ playerId: 'p0', scopes: ['level'],
    auditId: 'synthetic-audit', reason: 'synthetic exclusion', recordedAt: now }] };
  const next = buildFprPlayerEvents({ clientId: 'p0', events: first.events, context: c, nowIso: now });
  assert.equal(next.events.filter(e => e.eventType === 'TOURNAMENT_RATING_ANNULLED').length, 1);
  assert.deepEqual(document.params.fpr6x25, before);
  assert.equal(replayPlayerRatingEvents([...first.events, ...next.events]).ratingNumeric, 2);
});
test('reopen, restore, repeated restore and correction append stable idempotent lineage', () => {
  const { context: c, document } = context();
  const first = buildFprPlayerEvents({ clientId: 'p0', events: [], context: c, nowIso: now });
  const reopened = { ...c, selected: new Map() };
  const undo = buildFprPlayerEvents({ clientId: 'p0', events: first.events, context: reopened, nowIso: '2026-11-05T11:00:00Z' });
  assert.equal(undo.events.filter(e => e.eventType === 'TOURNAMENT_RATING_REOPENED_REVERTED').length, 1);
  const restore = buildFprPlayerEvents({ clientId: 'p0', events: [...first.events, ...undo.events], context: c, nowIso: '2026-11-05T12:00:00Z' });
  const award = restore.events.find(e => e.source.domain === 'TOURNAMENT' && !e.source.compensatesEventId);
  assert.ok(award);
  assert.notEqual(award.id, first.events.find(e => e.source.domain === 'TOURNAMENT').id);
  const history = [...first.events, ...undo.events, ...restore.events];
  assert.equal(buildFprPlayerEvents({ clientId: 'p0', events: history, context: c, nowIso: '2026-11-05T13:00:00Z' }).events.length, 0);
  assert.equal(document.params.fpr6x25.status, 'completed');
});
test('outbox has a fresh frontier identity and canonical numeric payload, independent of old game outbox IDs', () => {
  const state = { playerKey: 'client:p0', clientId: 'p0', phoneNorm: null, name: 'Synthetic', ratingNumeric: 2.1, rating: 'D', lastEventId: 'old-game' };
  const first = buildFprProjectionOutbox(state, now);
  const next = buildFprProjectionOutbox({ ...state, ratingNumeric: 2.12 }, now);
  assert.notEqual(first.id, next.id);
  assert.equal(first.payload.eventId, first.id);
  assert.equal(first.payload.levelNumeric, '2.10000');
  assert.equal(first.fprProjection, true);
});
test('preimage hashes retain BSON date changes', () => {
  assert.notEqual(fprLevelHash({ date: new Date('2026-11-01') }), fprLevelHash({ date: new Date('2026-11-02') }));
});
test('a nonempty baseline-less history is never reset by an FPR bootstrap', () => {
  const { context: c } = context();
  const incomplete = { id: 'orphan', _id: 'orphan', eventType: 'GAME_RESULT_SUBMITTED_APPLIED', occurredAt: '2026-11-01T09:00:00Z',
    player: { clientId: 'p0', key: 'client:p0' }, source: { domain: 'GAME_RESULT' }, change: { delta: 0.1, after: 2.1 } };
  assert.throws(() => buildFprPlayerEvents({ clientId: 'p0', events: [incomplete], context: c, nowIso: now }), /EXISTING_HISTORY_NO_BASELINE/);
});

test('all cohort targets are disjoint before the first transaction', () => {
  assert.throws(() => assertFprPlanIdentityDisjoint([
    { clientId: 'a', current: { _id: 'same', clientId: 'a' } },
    { clientId: 'b', current: { _id: 'same', clientId: 'a' } },
  ]), /COHORT_IDENTITY_OVERLAP/);
  assert.doesNotThrow(() => assertFprPlanIdentityDisjoint([{ clientId: 'a' }, { clientId: 'b' }]));
});

test('canonical correction preserves sports input, changes truthful before/after and is retry stable', async () => {
  const { effectiveFprLevelState, fprCorrectionSourceHash } = await import('../lib/fprLevelLedger.mjs');
  const { context: c, document } = context();
  const first = buildFprPlayerEvents({clientId:'p0',events:[],context:c,nowIso:now});
  const sports=structuredClone(document.params.fpr6x25);
  document.fprCanonicalStartCorrection={version:1,policy:'cup-canonical-start-correction-v1',operationId:'synthetic',
    previewSha256:'a'.repeat(64),sourceSha256:fprCorrectionSourceHash(document),legacySha256:null,
    rows:sports.players.map(p=>({id:p.id,start:p.level+0.5,orderedAfterSourceIds:[]}))};
  const effective=effectiveFprLevelState(document);
  c.ratings.set('synthetic-source',calculateFprTournamentRatings(effective,{participants:document.participants,unratedStartLevel:1}));
  const next=buildFprPlayerEvents({clientId:'p0',events:first.events,context:c,nowIso:'2026-11-06T10:00:00Z'});
  const correction=next.events.find(e=>e.eventType==='TOURNAMENT_RATING_CORRECTION_APPLIED');
  assert.equal(correction.change.before,sports.players[0].level+0.5);
  assert.equal(correction.change.delta,Number((correction.change.after-correction.change.before).toFixed(5)));
  assert.equal(correction.source.fprCanonicalCorrectionOperation,'synthetic');
  assert.deepEqual(document.params.fpr6x25,sports);
  assert.equal(buildFprPlayerEvents({clientId:'p0',events:[...first.events,...next.events],context:c,nowIso:'2026-11-06T11:00:00Z'}).events.length,0);
  document.participants=[...document.participants,{id:'unexpected'}];
  assert.throws(()=>effectiveFprLevelState(document),/SOURCE_DRIFT/);
});

test('correction rejects forged, duplicate, incomplete and invalid starts, including legacy drift', async () => {
  const { effectiveFprLevelState, fprCorrectionSourceHash }=await import('../lib/fprLevelLedger.mjs');
  for(const mutate of [m=>m.rows.pop(),m=>m.rows[0].start=0,m=>m.rows[0].start='2',m=>m.rows[0].id=m.rows[1].id,
    m=>m.sourceSha256='0'.repeat(64),m=>m.legacySha256='a'.repeat(64)]){
    const {document}=context();document.fprCanonicalStartCorrection={version:1,policy:'cup-canonical-start-correction-v1',operationId:'synthetic',
      previewSha256:'a'.repeat(64),sourceSha256:fprCorrectionSourceHash(document),legacySha256:null,
      rows:document.params.fpr6x25.players.map(p=>({id:p.id,start:2,orderedAfterSourceIds:[]}))};
    mutate(document.fprCanonicalStartCorrection);assert.throws(()=>effectiveFprLevelState(document),/CORRECTION/);
  }
});
