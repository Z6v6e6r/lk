import test from 'node:test';
import assert from 'node:assert/strict';
import { planFprBootstrapRecovery } from '../lib/fprBootstrapRecovery.mjs';
import { fprLevelHash } from '../lib/fprLevelLedger.mjs';
import { ratingFixture } from './helpers/fprRatingFixture.ts';
import { applyFprCommand, fprProjection, fprStandings, validateFprState } from '../../src/components/tournaments/fpr6x25.ts';
import { replayPlayerRatingEvents } from '../../src/services/player-rating/ledger.ts';
import { planFprRatingReconciliation } from '../../src/services/player-rating/fprRatingReplay.ts';
import { calculateFprTournamentRatings } from '../../src/services/player-rating/fprTournamentRating.ts';
import { ObjectId } from 'mongodb';

export function recoveryFixture() {
  const protocol = ratingFixture(8, 7, [1, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7]);
  protocol.audit.pop(); protocol.revision--; protocol.status = 'in_progress'; protocol.finishedAt = null;
  const bootstrap = { _id: 'bootstrap', id: 'bootstrap', idempotencyKey: 'bootstrap', schemaVersion: 1,
    eventType: 'RATING_BOOTSTRAPPED_FROM_TOURNAMENT', occurredAt: '2026-11-01T09:59:00.000Z', createdAt: '2026-11-01T09:59:00.000Z',
    player: { key: 'client:p0', clientId: 'p0', name: 'Synthetic' }, actor: {},
    source: { domain: 'FPR_ROSTER_BOOTSTRAP', initialSource: 'APPROVED_UNRATED_DEFAULT_1' },
    change: { before: null, delta: null, after: 1 }, formula: null, projectionIntent: { viva: 'NONE' } };
  const state = { _id: 'client:p0', ownership: 'CUP_CANONICAL', playerKey: 'client:p0', clientId: 'p0', ratingNumeric: 1,
    rating: 'D', lastEventId: bootstrap.id, lastEventAt: bootstrap.occurredAt };
  return { clientId: 'p0', operationId: 'synthetic-recovery', recordedAt: '2026-11-01T11:00:00.000Z', targetLevel: 3.65432,
    tournament: { _id: 'synthetic', tournamentType: 'fpr_6x25', tournamentId: protocol.tournamentId,
      participants: protocol.players.map(p => ({ id: p.id, name: p.name, rating: String(p.level) })),
      ...fprProjection(protocol, { fprCanonicalStart: { source: 'CUP_CANONICAL', rows: protocol.players.map(p => ({ clientId: p.id, ratingNumeric: p.level, version: 'old' })) } }) },
    state, compatibility: { ...state, _id: 'compatibility' }, events: [bootstrap], outboxes: [],
    community: { id: 'synthetic-community', updatedAt: '2026-11-01T09:00:00.000Z', members: [{ id: 'p0', levelScore: 3.65432 }] } };
}

test('restores ledger and open protocol without changing sports, survives commands and future finalization', () => {
  const input = recoveryFixture(), before = structuredClone(input), plan = planFprBootstrapRecovery(input);
  assert.deepEqual(input, before);
  assert.equal(plan.next.ratingNumeric, input.targetLevel);
  assert.equal(plan.nextCompatibility.ratingNumeric, input.targetLevel);
  assert.equal(plan.event.change.delta, 2.65432);
  assert.equal(plan.event.occurredAt, '2026-11-01T09:59:00.001Z');
  assert.equal(plan.event.createdAt, input.recordedAt);
  assert.equal(plan.outbox.status, 'PENDING');
  const old = input.tournament.params.fpr6x25, repaired = plan.tournament.params.fpr6x25;
  assert.deepEqual(repaired.attempts, old.attempts);
  assert.deepEqual(fprStandings(repaired), fprStandings(old));
  for (const player of repaired.players) assert.deepEqual({ ...player, level: old.players.find(p => p.id === player.id).level }, old.players.find(p => p.id === player.id));
  assert.equal(repaired.revision, old.revision + 1);
  assert.equal(repaired.audit.at(-1).action, 'admin_start_level_repair');
  validateFprState(repaired);
  const next = applyFprCommand(repaired, { id: 'synthetic-finish', action: 'finish', expectedRevision: repaired.revision }, '2026-11-01T11:01:00.000Z');
  assert.equal(next.players.find(p => p.id === 'p0').level, input.targetLevel);
  const rows = calculateFprTournamentRatings(next).standings;
  const player = rows.find(p => p.id === 'p0');
  assert.equal(player.ratingBefore, input.targetLevel);
  const award = { ...plan.event, _id: 'award', id: 'award', eventType: 'TOURNAMENT_RATING_APPLIED',
    occurredAt: next.finishedAt, source: { domain: 'TOURNAMENT', sourceId: next.tournamentId, fprProtocolId: next.tournamentId, fprFinishedAt: next.finishedAt },
    change: { before: player.ratingBefore, delta: player.ratingDelta, after: player.ratingAfter } };
  assert.equal(replayPlayerRatingEvents([...input.events, plan.event, award]).ratingNumeric, player.ratingAfter);
  assert.equal(planFprRatingReconciliation([...input.events, plan.event, award]), null);
  assert.throws(() => applyFprCommand(repaired, { id: 'stale', action: 'finish', expectedRevision: old.revision }, '2026-11-01T11:01:00.000Z'), /FPR_REVISION_CONFLICT/);
  assert.notEqual(plan.tournament.params.fprCanonicalStart.rows.find(p => p.clientId === 'p0').version, 'old');
  assert.equal(fprLevelHash(input.events), fprLevelHash(before.events));
});

test('blocks finalization, new events, stale or contradictory evidence, active outbox, and repeat repair', () => {
  for (const mutate of [
    x => { x.tournament.params.fpr6x25.status = 'completed'; x.tournament.params.fpr6x25.finishedAt = x.recordedAt; },
    x => { x.events.push({ ...x.events[0], id: 'other' }); },
    x => { x.community.members[0].levelScore = 3; },
    x => { x.community.updatedAt = x.recordedAt; },
    x => { x.outboxes.push({ status: 'SENDING' }); },
    x => { x.tournament.fprBootstrapRecovery = {}; },
    x => { x.tournament.params.fpr6x25.players.find(p => p.id === 'p0').level = 2; },
    x => { x.recordedAt = '2026-11-01T09:00:00.000Z'; },
  ]) {
    const input = recoveryFixture(); mutate(input);
    assert.throws(() => planFprBootstrapRecovery(input));
  }
});

test('preserves unknown BSON fields and document identity', () => {
  const input = recoveryFixture();
  input.tournament._id = new ObjectId();
  input.tournament.unrelated = { objectId: new ObjectId(), at: new Date() };
  const plan = planFprBootstrapRecovery(input);
  assert.equal(plan.tournament._id, input.tournament._id);
  assert.equal(plan.tournament.unrelated, input.tournament.unrelated);
  assert.equal(plan.tournament.unrelated.objectId._bsontype, 'ObjectId');
});
