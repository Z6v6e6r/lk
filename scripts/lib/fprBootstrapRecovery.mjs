import { replayPlayerRatingEvents, ratingGradeFromNumeric } from '../../src/services/player-rating/ledger.ts';
import { validateFprState, fprStandings } from '../../src/components/tournaments/fpr6x25.ts';
import { buildFprProjectionOutbox, fprLevelHash } from './fprLevelLedger.mjs';

const fail = () => { throw Error('FPR_BOOTSTRAP_RECOVERY_PRECONDITION'); };
const version = value => {
  let h = 0xcbf29ce484222325n;
  for (const c of value) h = BigInt.asUintN(64, (h ^ BigInt(c.charCodeAt(0))) * 0x100000001b3n);
  return 'v1-' + h.toString(16).padStart(16, '0');
};

/** Only an open, unawarded incident with one erroneous bootstrap is repairable here. */
export function planFprBootstrapRecovery({ clientId, operationId, recordedAt, tournament,
  state, compatibility, events, outboxes, community, targetLevel }) {
  if (!/^[a-zA-Z0-9-]{8,100}$/.test(operationId || '') || !Number.isFinite(Date.parse(recordedAt))
    || !Number.isFinite(targetLevel) || targetLevel <= 1 || targetLevel > 7) fail();
  const protocol = tournament?.params?.fpr6x25;
  validateFprState(protocol);
  if (tournament.tournamentType !== 'fpr_6x25' || protocol.testMode !== false
    || !['ready', 'in_progress'].includes(protocol.status) || protocol.finishedAt !== null
    || tournament.archived === true || tournament.fprCanonicalStartCorrection || tournament.fprBootstrapRecovery
    || tournament.fprLevelResults || events?.length !== 1 || !state || !compatibility
    || state.clientId !== clientId || state.playerKey !== 'client:' + clientId || state.ownership !== 'CUP_CANONICAL'
    || compatibility.clientId !== clientId || compatibility.playerKey !== state.playerKey
    || state.ratingNumeric !== 1 || compatibility.ratingNumeric !== 1) fail();
  const bootstrap = events[0], effectiveAt = new Date(Date.parse(bootstrap.occurredAt) + 1).toISOString();
  if (bootstrap.eventType !== 'RATING_BOOTSTRAPPED_FROM_TOURNAMENT'
    || bootstrap.source?.domain !== 'FPR_ROSTER_BOOTSTRAP'
    || bootstrap.source.initialSource !== 'APPROVED_UNRATED_DEFAULT_1'
    || bootstrap.player?.clientId !== clientId || bootstrap.player.key !== state.playerKey
    || bootstrap.change?.after !== 1 || bootstrap.change.delta !== null || bootstrap.change.before !== null
    || state.lastEventId !== bootstrap.id || compatibility.lastEventId !== bootstrap.id
    || Date.parse(effectiveAt) >= Date.parse(protocol.leagueSnapshotAt)
    || Date.parse(recordedAt) < Date.parse(protocol.audit.at(-1)?.at || protocol.leagueSnapshotAt)
    || Date.parse(community?.updatedAt) >= Date.parse(bootstrap.occurredAt)
    || !Number.isFinite(Date.parse(community?.updatedAt))
    || outboxes.some(row => ['PENDING', 'FAILED_RETRYABLE', 'SENDING'].includes(row.status))) fail();
  const members = community.members?.filter(p => p.id === clientId);
  if (members?.length !== 1 || members[0].levelScore !== targetLevel) fail();
  const player = protocol.players.filter(p => p.id === clientId);
  const participants = tournament.participants?.filter(p => p.id === clientId);
  const snapshot = tournament.params.fprCanonicalStart;
  const rows = snapshot?.rows?.filter(p => p.clientId === clientId);
  if (player.length !== 1 || player[0].level !== 1 || participants?.length !== 1 || Number(participants[0].rating) !== 1
    || snapshot.source !== 'CUP_CANONICAL' || rows?.length !== 1 || rows[0].ratingNumeric !== 1) fail();
  const evidence = { communityId: community.id, updatedAt: community.updatedAt,
    clientId, field: 'levelScore', value: targetLevel, memberSha256: fprLevelHash(members[0]) };
  const id = 'rating_evt:fpr_bootstrap_recovery:' + operationId;
  const event = { _id: id, id, idempotencyKey: id, schemaVersion: 1,
    eventType: 'RATING_LEVEL_CORRECTION_APPLIED', occurredAt: effectiveAt, createdAt: recordedAt,
    player: { ...bootstrap.player }, actor: { type: 'SYSTEM', id: 'system:authorized-fpr-bootstrap-recovery' },
    source: { domain: 'LEVEL_RECOVERY', sourceId: operationId, policy: 'fpr-bootstrap-recovery-v1',
      repairsEventId: bootstrap.id, protocolId: tournament.tournamentId, evidence,
      effectiveTimeReason: 'Restore the evidenced level already valid before the frozen tournament snapshot; creation time records the actual repair.' },
    change: { before: 1, delta: Number((targetLevel - 1).toFixed(5)), after: targetLevel,
      gradeBefore: ratingGradeFromNumeric(1), gradeAfter: ratingGradeFromNumeric(targetLevel) },
    formula: null, projectionIntent: { viva: 'REQUIRED_DURING_MIGRATION' } };
  const replay = replayPlayerRatingEvents([...events, event]);
  if (replay.ratingNumeric !== targetLevel) fail();
  const next = { ...state, ratingNumeric: replay.ratingNumeric, rating: replay.rating,
    lastEventId: replay.lastEventId, lastEventType: replay.lastEventType, lastEventAt: replay.lastEventAt,
    updatedAt: recordedAt, projectedAt: recordedAt, projectedBy: 'fpr-bootstrap-recovery-v1' };
  const nextCompatibility = { ...compatibility, ...next, _id: compatibility._id,
    compatibilityProjection: true, canonicalCollection: 'player_rating_state', compatibilityUpdatedAt: recordedAt };
  // Clone only owned plain branches; structuredClone would erase unknown BSON types.
  const repaired = { ...tournament, params: { ...tournament.params,
    fpr6x25: { ...protocol, players: protocol.players.map(p => p.id === clientId ? { ...p, level: targetLevel } : p), audit: [...protocol.audit] },
    fprCanonicalStart: { ...snapshot, rows: snapshot.rows.map(row => row.clientId === clientId ? { ...row } : row) } },
    participants: tournament.participants.map(p => p.id === clientId ? { ...p, rating: String(targetLevel) } : p) };
  const canonicalRow = repaired.params.fprCanonicalStart.rows.find(p => p.clientId === clientId);
  canonicalRow.ratingNumeric = targetLevel;
  canonicalRow.version = version(JSON.stringify([next.playerKey, next.lastEventId, next.ratingNumeric]));
  repaired.params.fpr6x25.audit.push({ id: operationId, at: recordedAt, action: 'admin_start_level_repair',
    detail: 'Recovered existing level after erroneous unrated bootstrap; sports results preserved.',
    fingerprint: fprLevelHash({ clientId, before: 1, after: targetLevel, evidence, eventId: event.id }) });
  repaired.params.fpr6x25.revision += 1;
  repaired.updatedAt = recordedAt;
  repaired.fprBootstrapRecovery = { policy: 'fpr-bootstrap-recovery-v1', operationId, clientId,
    before: 1, after: targetLevel, effectiveAt, recordedAt, eventId: event.id, evidence };
  validateFprState(repaired.params.fpr6x25);
  if (fprLevelHash(fprStandings(protocol)) !== fprLevelHash(fprStandings(repaired.params.fpr6x25))) fail();
  return { event, next, nextCompatibility, tournament: repaired,
    outbox: buildFprProjectionOutbox(next, recordedAt) };
}
