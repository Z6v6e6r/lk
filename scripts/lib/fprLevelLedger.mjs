import { readFprLevelResults, fprLevelExcludedPlayerIds } from '../../src/services/player-rating/fprLevelResults.ts';
import { readFprLevelIdentityHistory } from './fprLevelIdentity.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { calculateFprTournamentRatings, FPR_LEVEL_FORMULA_VERSION } from '../../src/services/player-rating/fprTournamentRating.ts';
import { planFprRatingReconciliation, replayFprRatingTargets } from '../../src/services/player-rating/fprRatingReplay.ts';
import { validateFprState } from '../../src/components/tournaments/fpr6x25.ts';
import { getTournamentRatingExclusion } from '../../src/services/player-rating/tournamentExclusionGuard.ts';
import { buildTournamentRatingEvent, buildTournamentRatingRevision, buildTournamentCompensationEvent,
  replayPlayerRatingEvents, ratingGradeFromNumeric } from '../../src/services/player-rating/ledger.ts';
import { isTournamentFinalized } from './tournamentFinalization.mjs';

export const FPR_LEVEL_POLICY = 'fpr-ordinary-level-v1';
const activationPath = '/var/lib/padlhub-rating-worker/fpr-level-activation.json';
const stable = value => value instanceof Date ? { $date: value.toISOString() }
  : value?.toHexString ? { $oid: value.toHexString() }
    : Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])])) : value;
export const fprLevelHash = value => crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const list = value => Array.isArray(value) ? value : [];
const unique = values => [...new Set(values.filter(Boolean))];
const actor = { type: 'SYSTEM', id: 'system:fpr-level-worker', name: 'FPR rating worker' };
const eventId = event => String(event.id || event._id);
const active = (events, sourceId) => events.filter(e => e.source?.domain === 'TOURNAMENT'
  && e.source.sourceId === sourceId && !e.source.compensatesEventId
  && !events.some(other => other.source?.compensatesEventId === eventId(e)))
  .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || eventId(a).localeCompare(eventId(b))).at(-1);

export function readFprLevelActivation() {
  if (!fs.existsSync(activationPath)) return { enabled: false, dispatchEnabled: false };
  const stat = fs.lstatSync(activationPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o077)) throw new Error('FPR_LEVEL_ACTIVATION_CUSTODY');
  const config = JSON.parse(fs.readFileSync(activationPath, 'utf8'));
  if (config.policy !== FPR_LEVEL_POLICY || config.unratedStartLevel !== 1 || typeof config.enabled !== 'boolean'
    || typeof config.dispatchEnabled !== 'boolean') throw new Error('FPR_LEVEL_ACTIVATION_INVALID');
  return config;
}

/** One physical event owns one FPR protocol. Publication is not a personal-level prerequisite. */
export function selectFprLevelSources(protocols, legacy = []) {
  const groups = new Map(), protectedIds = new Set();
  for (const doc of protocols) {
    if (doc.tournamentType !== 'fpr_6x25') continue;
    const state = doc.params?.fpr6x25;
    if (!state || state.testMode !== false || state.communityRating?.policy !== 'community-tournament-v1') continue;
    const sourceId = state.communityRating.sourceExerciseId || doc.params.sourceExerciseId || doc.tournamentId;
    if (typeof sourceId !== 'string' || !sourceId) throw new Error('FPR_LEVEL_SOURCE_MISSING');
    if (doc.params.sourceExerciseId && doc.params.sourceExerciseId !== sourceId) throw new Error('FPR_LEVEL_SOURCE_CONFLICT');
    validateFprState(state);
    if (state.tournamentId !== doc.tournamentId) throw new Error('FPR_LEVEL_PROTOCOL_CONFLICT');
    const group = groups.get(sourceId) || [];
    group.push(doc); groups.set(sourceId, group);
  }
  const selected = new Map(), ambiguous = [];
  for (const [sourceId, group] of groups) {
    const complete = group.filter(d => d.archived !== true && d.params.fpr6x25.status === 'completed');
    const originals = legacy.filter(d => d.tournamentType !== 'fpr_6x25' && d.tournamentId === sourceId && d.archived !== true);
    if (!complete.length) continue;
    protectedIds.add(sourceId);
    const competingResult = originals.some(d => isTournamentFinalized(d) && list(d.standings).some(p =>
      Number(p.matchesPlayed || p.games || p.wins || p.pointsFor || p.totalPoints || p.ratingDelta) !== 0));
    if (complete.length > 1 || originals.length > 1 || competingResult) { ambiguous.push(sourceId); continue; }
    selected.set(sourceId, { document: complete[0], legacy: originals[0] || null });
  }
  return { protocols, legacy, selected, protectedIds, ambiguous };
}

export async function loadFprLevelContext(db, config = { enabled: false }, session) {
  const options = { session, maxTimeMS: 30000 };
  const awarded = await db.collection('rating_events').find({ 'source.fprProtocolId': { $exists: true } },
    { ...options, projection: { 'source.sourceId': 1 } }).limit(20001).toArray();
  if (awarded.length > 20000) throw new Error('FPR_LEVEL_EXISTING_EVENT_CAP');
  const awardedIds = new Set(awarded.map(e => e.source.sourceId));
  if (!config.enabled && !awarded.length) return { protocols: [], legacy: [], selected: new Map(), ratings: new Map(), protectedIds: new Set(), ambiguous: [] };
  const protocols = await db.collection('tournaments').find({ tournamentType: 'fpr_6x25' }, options).limit(1001).toArray();
  if (protocols.length > 1000) throw new Error('FPR_LEVEL_PROTOCOL_CAP');
  const ids = unique(protocols.map(d => d.params?.fpr6x25?.communityRating?.sourceExerciseId || d.params?.sourceExerciseId || d.tournamentId));
  const legacy = await db.collection('tournaments').find({ tournamentId: { $in: ids }, tournamentType: { $ne: 'fpr_6x25' } }, options).limit(2001).toArray();
  if (legacy.length > 2000) throw new Error('FPR_LEVEL_SOURCE_CAP');
  const context = selectFprLevelSources(protocols, legacy);
  if (!config.enabled) context.protectedIds = new Set();
  for (const id of awardedIds) context.protectedIds.add(id);
  context.ratings = new Map();
  if (config.enabled) for (const [id, source] of context.selected) {
    try {
      context.ratings.set(id, calculateFprTournamentRatings(source.document.params.fpr6x25,
        { params: source.document.params, participants: source.document.participants, unratedStartLevel: config.unratedStartLevel }));
    } catch {
      context.ambiguous.push(id); context.selected.delete(id);
    }
  }
  return context;
}

export function buildFprPlayerEvents({ clientId, events, context, nowIso }) {
  const pending = [], sourceDocuments = [], excluded = [];
  const sources = [...context.selected].sort((a, b) => Date.parse(a[1].document.params.fpr6x25.finishedAt)
    - Date.parse(b[1].document.params.fpr6x25.finishedAt) || a[0].localeCompare(b[0]));
  for (const [sourceId, source] of sources) {
    const row = context.ratings.get(sourceId)?.standings.find(r => r.id === clientId);
    if (!row || row.ratedMatches === 0) continue;
    sourceDocuments.push(source.document, ...(source.legacy ? [source.legacy] : []));
    const history = [...events, ...pending];
    const previous = active(history, sourceId);
    if (previous && previous.source.fprProtocolId !== source.document.tournamentId) throw new Error('FPR_LEVEL_EXISTING_AWARD_COLLISION');
    const exclusion = getTournamentRatingExclusion(source.document, clientId, 'level')
      || source.legacy && getTournamentRatingExclusion(source.legacy, clientId, 'level');
    const finishedAt = source.document.params.fpr6x25.finishedAt;
    if (exclusion) {
      excluded.push(sourceId);
      if (previous) pending.push(buildTournamentCompensationEvent({ event: previous, occurredAt: finishedAt, createdAt: nowIso, reason: 'ANNULLED' }));
      continue;
    }
    const revision = buildTournamentRatingRevision({ tournamentId: sourceId, finishedAt, standing: row });
    if (previous?.source.sourceRevision === revision) continue;
    // The absolute ordinary target is based on the frozen tournament input, not today's level.
    const beforeEvents = history.filter(e => Date.parse(e.occurredAt || e.createdAt) < Date.parse(finishedAt));
    const before = previous?.change.before ?? replayFprRatingTargets(beforeEvents)?.ratingNumeric
      ?? replayPlayerRatingEvents(beforeEvents)?.ratingNumeric ?? row.ratingBefore;
    const predecessor = previous || history.filter(e => e.source?.sourceId === sourceId
      && e.source.fprProtocolId === source.document.tournamentId && !e.source.compensatesEventId)
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || eventId(a).localeCompare(eventId(b))).at(-1);
    const event = buildTournamentRatingEvent({ tournamentId: sourceId, finishedAt, standing: row, canonicalBefore: before,
      occurredAt: finishedAt, createdAt: nowIso, previousEventId: predecessor?.id });
    if (!event) throw new Error('FPR_LEVEL_EVENT_INVALID');
    Object.assign(event.source, { fprProtocolId: source.document.tournamentId, fprFinishedAt: finishedAt,
      fprLevelPolicy: FPR_LEVEL_POLICY, fprFormulaVersion: FPR_LEVEL_FORMULA_VERSION,
      fprUnratedStartApplied: row.unratedStartApplied });
    if (previous) pending.push(buildTournamentCompensationEvent({ event: previous, occurredAt: finishedAt, createdAt: nowIso, reason: 'CORRECTED' }));
    if (!replayPlayerRatingEvents(history)) {
      if (history.length) throw new Error('FPR_LEVEL_EXISTING_HISTORY_NO_BASELINE');
      const id = `rating_evt:fpr_bootstrap:${fprLevelHash(clientId)}`;
      pending.push({ _id: id, id, idempotencyKey: id, schemaVersion: 1, eventType: 'RATING_BOOTSTRAPPED_FROM_TOURNAMENT',
        occurredAt: new Date(Date.parse(finishedAt) - 1).toISOString(), createdAt: nowIso, player: event.player, actor,
        source: { domain: 'TOURNAMENT_BOOTSTRAP', sourceId, fprBootstrap: true },
        change: { before: null, delta: null, after: row.ratingBefore, gradeBefore: null, gradeAfter: ratingGradeFromNumeric(row.ratingBefore) },
        formula: null, projectionIntent: { viva: 'NONE_BOOTSTRAP' } });
    }
    pending.push(event);
  }
  // A previously awarded protocol can be reopened or removed without passing the completed selector.
  for (const old of events.filter(e => e.source?.fprProtocolId && !e.source.compensatesEventId)) {
    const sourceId = old.source.sourceId;
    if (context.ambiguous.includes(sourceId) || context.selected.has(sourceId)) continue;
    const previous = active([...events, ...pending], sourceId);
    if (!previous || previous.id !== old.id) continue;
    const document = context.protocols.find(d => d.tournamentId === old.source.fprProtocolId);
    if (!document) throw new Error('FPR_LEVEL_AWARDED_SOURCE_MISSING');
    sourceDocuments.push(document);
    pending.push(buildTournamentCompensationEvent({ event: old, occurredAt: old.source.fprFinishedAt,
      createdAt: nowIso, reason: 'REOPENED' }));
  }
  const history = [...events, ...pending];
  const correction = planFprRatingReconciliation(history);
  if (correction) {
    const id = `rating_evt:fpr_reconciliation:${fprLevelHash([clientId, history.map(e => [eventId(e), e.change, e.source]).sort(), correction])}`;
    const identity = history.find(e => e.player.clientId === clientId)?.player;
    if (!identity) throw new Error('FPR_LEVEL_IDENTITY_MISSING');
    pending.push({ _id: id, id, idempotencyKey: id, schemaVersion: 1, eventType: 'FPR_CANONICAL_RECONCILIATION_APPLIED',
      occurredAt: nowIso, createdAt: nowIso, player: identity, actor,
      source: { domain: 'FPR_RECONCILIATION', sourceId: id, fprReconciliation: true, fprLevelPolicy: FPR_LEVEL_POLICY,
        baselineEventId: correction.baselineEventId, rawLedgerBefore: correction.rawBefore, rawLedgerAfter: correction.rawAfter },
      change: { before: correction.before, after: correction.after, delta: correction.delta,
        gradeBefore: ratingGradeFromNumeric(correction.before), gradeAfter: ratingGradeFromNumeric(correction.after) },
      formula: { version: FPR_LEVEL_POLICY, applicationVersion: 'source-aware-additive-frontier-v1' }, projectionIntent: { viva: 'REQUIRED_DURING_MIGRATION' } });
  }
  const replay = replayPlayerRatingEvents([...events, ...pending]);
  if (planFprRatingReconciliation([...events, ...pending])) throw new Error('FPR_LEVEL_RECONCILIATION_NOT_STABLE');
  return { events: pending.filter(Boolean), replay, sourceDocuments, excluded };
}

const exact = document => document ? { ...Object.fromEntries(Object.entries(document).map(([k, v]) => [k, { $eq: v, $exists: true }])),
  $expr: { $eq: [{ $size: { $objectToArray: '$$ROOT' } }, Object.keys(document).length] } } : null;
const canonicalFingerprint = state => fprLevelHash([state.playerKey, state.clientId, state.ratingNumeric, state.lastEventId, state.fprLevelFrontier || null]);
export function buildFprProjectionOutbox(state, nowIso) {
  const fingerprint = canonicalFingerprint(state);
  const id = `rating_projection:fpr:${fprLevelHash([state.clientId, fingerprint])}`;
  return { _id: id, id, fprProjection: true, canonicalFingerprint: fingerprint, ratingEventId: state.lastEventId,
    clientId: state.clientId, playerKey: state.playerKey, payload: { clientId: state.clientId, phone: state.phoneNorm,
      playerName: state.name, levelLetter: state.rating, levelNumeric: state.ratingNumeric.toFixed(5), nextRating: state.ratingNumeric,
      source: 'tournament_rating_worker', changedById: actor.id, changedByName: actor.name,
      eventId: id, confirmedAt: nowIso }, status: 'PENDING', attempts: 0, createdAt: nowIso, updatedAt: nowIso, nextAttemptAt: nowIso };
}

export async function buildFprPlayerPlan(db, clientId, context, nowIso, session) {
  const options = { session, maxTimeMS: 30000 };
  const { current, aliases, phones, events: existingEvents } = await readFprLevelIdentityHistory(db, clientId, session);
  const priorReplay = replayPlayerRatingEvents(existingEvents);
  if (current && (!priorReplay || priorReplay.ratingNumeric !== current.ratingNumeric || priorReplay.lastEventId !== current.lastEventId)) {
    throw new Error('FPR_LEVEL_PRIOR_PROJECTION_DRIFT');
  }
  const compatible = await db.collection('player_ratings').find({ $or: [{ clientId: { $in: aliases } }, { playerKey: current?.playerKey || `client:${clientId}` }] }, options).limit(3).toArray();
  if (compatible.length > 1) throw new Error('FPR_LEVEL_COMPATIBILITY_CONFLICT');
  const outboxes = await db.collection('rating_projection_outbox').find({ $or: [{ clientId: { $in: aliases } }, { 'payload.clientId': { $in: aliases } }],
    status: { $in: ['PENDING', 'FAILED_RETRYABLE', 'SENDING'] } }, options).limit(1001).toArray();
  if (outboxes.length > 1000 || outboxes.some(r => r.status === 'SENDING')) throw new Error('FPR_LEVEL_PROJECTION_IN_FLIGHT');
  const calculated = buildFprPlayerEvents({ clientId, events: existingEvents, context, nowIso });
  if (!calculated.events.length) return { clientId, events: [], current, existingEvents, compatibility: compatible[0] || null, outboxes,
    sourceDocuments: calculated.sourceDocuments, fingerprint: fprLevelHash([current, [...existingEvents].sort((a, b) => eventId(a).localeCompare(eventId(b))), compatible,
      [...outboxes].sort((a, b) => String(a._id).localeCompare(String(b._id)))]) };
  const replay = calculated.replay;
  if (!replay) throw new Error('FPR_LEVEL_REPLAY_MISSING');
  const name = current?.name || [...context.ratings.values()].flatMap(x => x.standings).find(p => p.id === clientId)?.name || 'Игрок';
  const next = { ...current, schemaVersion: 1, ownership: 'CUP_CANONICAL', playerKey: current?.playerKey || `client:${clientId}`,
    clientId: current?.clientId || clientId, phoneNorm: current?.phoneNorm || null, name,
    ratingNumeric: replay.ratingNumeric, rating: replay.rating,
    baseline: { eventId: replay.baselineEventId, at: replay.baselineAt,
      ratingNumeric: [...existingEvents, ...calculated.events].find(e => e.id === replay.baselineEventId)?.change.after ?? null },
    identityAliases: { ...current?.identityAliases, clientIds: aliases, phoneNorms: phones },
    lastEventId: replay.lastEventId, lastEventType: replay.lastEventType, lastEventAt: replay.lastEventAt,
    fprLevelFrontier: fprLevelHash([...existingEvents, ...calculated.events].map(e => eventId(e)).sort()),
    projectedBy: FPR_LEVEL_POLICY, projectedAt: nowIso, updatedAt: nowIso, createdAt: current?.createdAt || nowIso };
  const projectionRequired = !current || canonicalFingerprint(current) !== canonicalFingerprint(next);
  return { clientId, ...calculated, current, existingEvents, compatibility: compatible[0] || null, outboxes, next,
    outbox: projectionRequired ? buildFprProjectionOutbox(next, nowIso) : null,
    fingerprint: fprLevelHash([current, [...existingEvents].sort((a, b) => eventId(a).localeCompare(eventId(b))), compatible,
      [...outboxes].sort((a, b) => String(a._id).localeCompare(String(b._id)))]) };
}

/** Caller holds the common worker flock; transactions also protect concurrent canonical writers. */
export async function applyFprPlayerPlan(db, client, clientId, context, nowIso, expectedFingerprint) {
  const session = client.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      const plan = await buildFprPlayerPlan(db, clientId, context, nowIso, session);
      if (expectedFingerprint && plan.fingerprint !== expectedFingerprint) throw new Error('FPR_LEVEL_PREIMAGE_CHANGED');
      if (!plan.events.length) { result = { events: 0, changed: false }; return; }
      for (const source of plan.sourceDocuments) {
        const latest = await db.collection('tournaments').findOne({ _id: source._id }, { session, maxTimeMS: 15000 });
        const version = row => { if (!row) return null; const copy = { ...row }; delete copy.fprLevelLedgerFence; delete copy.fprLevelResults; return fprLevelHash(copy); };
        if (version(latest) !== version(source)) throw new Error('FPR_LEVEL_SOURCE_CHANGED');
        // A real transactional write acquires a source-document fence. Snapshot reads alone do not.
        const fenced = await db.collection('tournaments').updateOne(exact(latest), { $set: { fprLevelLedgerFence: {
          policy: FPR_LEVEL_POLICY, owner: crypto.randomUUID(), sourceVersion: version(source), recordedAt: nowIso } } }, { session });
        if (fenced.matchedCount !== 1 || fenced.modifiedCount !== 1) throw new Error('FPR_LEVEL_SOURCE_CAS');
      }
      await db.collection('rating_events').bulkWrite(plan.events.map(e => ({ updateOne: { filter: { _id: e.id }, update: { $setOnInsert: e }, upsert: true } })), { session, ordered: true });
      if (plan.current) {
        const set = { ...plan.next }; delete set._id;
        const r = await db.collection('player_rating_state').updateOne(exact(plan.current), { $set: set }, { session });
        if (r.matchedCount !== 1) throw new Error('FPR_LEVEL_STATE_CAS');
      } else await db.collection('player_rating_state').insertOne({ ...plan.next, _id: plan.next.playerKey }, { session });
      const compatibility = { ...plan.next, compatibilityProjection: true, canonicalCollection: 'player_rating_state', compatibilityUpdatedAt: nowIso };
      delete compatibility._id;
      if (plan.compatibility) {
        const r = await db.collection('player_ratings').updateOne(exact(plan.compatibility), { $set: compatibility }, { session });
        if (r.matchedCount !== 1) throw new Error('FPR_LEVEL_COMPATIBILITY_CAS');
      } else await db.collection('player_ratings').insertOne({ ...compatibility, _id: `fpr:${plan.next.playerKey}` }, { session });
      if (plan.outbox) {
        if (plan.outboxes.length) await db.collection('rating_projection_outbox').updateMany({ _id: { $in: plan.outboxes.map(r => r._id) }, status: { $in: ['PENDING', 'FAILED_RETRYABLE'] } },
          { $set: { status: 'SUPERSEDED', supersededBy: plan.outbox.id, updatedAt: nowIso } }, { session });
        await db.collection('rating_projection_outbox').updateOne({ _id: plan.outbox.id }, { $setOnInsert: plan.outbox }, { session, upsert: true });
      }
      result = { events: plan.events.length, changed: !plan.current || plan.current.ratingNumeric !== plan.next.ratingNumeric, projection: !!plan.outbox };
    }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary' });
    return result;
  } finally { await session.endSession(); }
}

/** Fail before any write if two frozen participant IDs resolve to the same canonical identity. */
export function assertFprPlanIdentityDisjoint(plans) {
  const owners = new Map();
  for (const plan of plans) {
    const state = plan.next || plan.current;
    const keys = [
      ...unique([plan.clientId, state?.clientId, ...list(state?.identityAliases?.clientIds)]).map(x => `client:${x}`),
      ...unique([state?.phoneNorm, ...list(state?.identityAliases?.phoneNorms)]).map(x => `phone:${x}`),
      ...unique([state?.playerKey, ...list(state?.identityAliases?.playerKeys)]).map(x => `key:${x}`),
      ...(plan.current?._id ? [`state:${plan.current._id}`] : []),
    ];
    for (const key of keys) {
      if (owners.has(key) && owners.get(key) !== plan.clientId) throw new Error('FPR_LEVEL_COHORT_IDENTITY_OVERLAP');
      owners.set(key, plan.clientId);
    }
  }
}

/** Publish display-only tournament levels from settled ledger events. Sports fields are never written. */
export async function projectFprLevelResults(db, context, nowIso, dryRun) {
  const result = { scanned: context.selected.size, updated: 0, sourceChanged: 0 };
  for (const [sourceId, source] of context.selected) {
    const document = source.document, state = document.params.fpr6x25;
    const events = await db.collection('rating_events').find({ 'source.domain': 'TOURNAMENT',
      'source.sourceId': sourceId, 'source.fprProtocolId': document.tournamentId, 'source.applyToState': { $ne: false } }, { maxTimeMS: 30000 }).limit(20001).toArray();
    if (events.length > 20000) throw new Error('FPR_LEVEL_RESULTS_EVENT_CAP');
    const rows = state.players.map(player => {
      const calculated = context.ratings.get(sourceId)?.standings.find(row => row.id === player.id);
      const excluded = getTournamentRatingExclusion(document, player.id, 'level')
        || source.legacy && getTournamentRatingExclusion(source.legacy, player.id, 'level');
      const row = { id: player.id, status: excluded || calculated?.ratedMatches === 0 ? 'not_awarded' : 'pending' };
      if (row.status === 'not_awarded' || !calculated) return row;
      const own = events.filter(e => e.player?.clientId === player.id);
      const uncompensated = own.filter(e => !e.source.compensatesEventId && !own.some(c => c.source.compensatesEventId === eventId(e)));
      if (uncompensated.length !== 1) return row;
      const award = uncompensated[0];
      const revision = buildTournamentRatingRevision({ tournamentId: sourceId, finishedAt: state.finishedAt, standing: calculated });
      if (award.source.sourceRevision !== revision || award.change.after !== calculated.ratingAfter) return row;
      return { id: player.id, status: 'applied', before: award.change.before, after: award.change.after, delta: award.change.delta };
    });
    const rootExcludedIds = fprLevelExcludedPlayerIds(state, document.ratingExclusions);
    const projection = readFprLevelResults(state, { version: 1, protocolId: state.tournamentId,
      protocolRevision: state.revision, sourceEventId: sourceId, calculatedAt: nowIso, rootExcludedPlayerIds: rootExcludedIds, rows }, rootExcludedIds, document.params?.sourceExerciseId);
    if (!projection) throw new Error('FPR_LEVEL_RESULTS_INVALID');
    // The timestamp must not make an unchanged snapshot a write on every worker run.
    const comparable = value => value && typeof value === "object" && !Array.isArray(value) ? { ...value, calculatedAt: null } : null;
    const latest = await db.collection('tournaments').findOne({ _id: document._id });
    const semantic = value => { const copy = { ...value }; delete copy.fprLevelLedgerFence; delete copy.fprLevelResults; return fprLevelHash(copy); };
    if (!latest || semantic(latest) !== semantic(document)) { result.sourceChanged++; continue; }
    if (source.legacy) {
      const legacy = source.legacy._id && await db.collection('tournaments').findOne({ _id: source.legacy._id });
      if (!legacy || semantic(legacy) !== semantic(source.legacy)) { result.sourceChanged++; continue; }
    }
    if (fprLevelHash(comparable(latest.fprLevelResults)) === fprLevelHash(comparable(projection))) continue;
    if (dryRun) { result.updated++; continue; }
    const write = await db.collection('tournaments').updateOne(exact(latest), { $set: { fprLevelResults: projection } });
    if (write.matchedCount === 1) result.updated++; else result.sourceChanged++;
  }
  return result;
}

export async function processFprLevelLedger(db, client, { context, config, nowIso, dryRun }) {
  if (!config.enabled) return { enabled: false, events: 0, players: 0, ambiguous: context.ambiguous.length };
  const existing = await db.collection('rating_events').find({ 'source.fprProtocolId': { $exists: true } }, { projection: { 'player.clientId': 1 } }).limit(20001).toArray();
  if (existing.length > 20000) throw new Error('FPR_LEVEL_EXISTING_EVENT_CAP');
  const playerIds = unique([...context.ratings.values()].flatMap(r => r.standings.filter(p => p.ratedMatches > 0).map(p => p.id))
    .concat(existing.map(e => e.player?.clientId))).sort();
  const totals = { enabled: true, players: playerIds.length, events: 0, changed: 0, projections: 0, ambiguous: context.ambiguous.length };
  const plans = [];
  for (const id of playerIds) plans.push(await buildFprPlayerPlan(db, id, context, nowIso));
  assertFprPlanIdentityDisjoint(plans);
  for (const plan of plans) {
    if (dryRun) { totals.events += plan.events.length; totals.changed += Number(!!plan.next && (!plan.current || plan.next.ratingNumeric !== plan.current.ratingNumeric)); totals.projections += Number(!!plan.outbox); }
    else { const result = await applyFprPlayerPlan(db, client, plan.clientId, context, nowIso, plan.fingerprint); totals.events += result.events; totals.changed += Number(result.changed); totals.projections += Number(!!result.projection); }
  }
  totals.resultsProjection = await projectFprLevelResults(db, context, nowIso, dryRun);
  return totals;
}

/** FPR projections are isolated from the legacy blind dispatcher and always use current canonical values. */
export async function processFprProjectionOutbox(db, projectionUrl, nowIso, dryRun) {
  const rows = await db.collection('rating_projection_outbox').find({ fprProjection: true, attempts: { $lt: 30 }, $or: [
    { status: { $in: ['PENDING', 'FAILED_RETRYABLE'] }, nextAttemptAt: { $lte: nowIso } },
    { status: 'SENDING', projectionLeaseUntil: { $lte: nowIso } },
  ] })
    .sort({ createdAt: 1 }).limit(200).toArray();
  const result = { scanned: rows.length, synced: 0, superseded: 0, failed: 0 };
  if (dryRun) return result;
  for (const row of rows) {
    const states = await db.collection('player_rating_state').find({ clientId: row.clientId }).limit(3).toArray();
    if (states.length !== 1) throw new Error('FPR_LEVEL_PROJECTION_IDENTITY_CONFLICT');
    const state = states[0];
    if (canonicalFingerprint(state) !== row.canonicalFingerprint) {
      const next = buildFprProjectionOutbox(state, nowIso);
      await db.collection('rating_projection_outbox').updateOne({ _id: row._id, status: row.status }, { $set: { status: 'SUPERSEDED', supersededBy: next.id, updatedAt: nowIso } });
      await db.collection('rating_projection_outbox').updateOne({ _id: next.id }, { $setOnInsert: next }, { upsert: true });
      result.superseded++; continue;
    }
    const leaseOwner = crypto.randomUUID();
    const claim = await db.collection('rating_projection_outbox').updateOne({ _id: row._id, status: row.status,
      ...(row.status === 'SENDING' ? { projectionLeaseOwner: row.projectionLeaseOwner, projectionLeaseUntil: row.projectionLeaseUntil } : {}) },
    { $set: { status: 'SENDING', projectionLeaseOwner: leaseOwner, projectionLeaseUntil: new Date(Date.now() + 60000).toISOString() }, $inc: { attempts: 1 } });
    if (claim.modifiedCount !== 1) continue;
    const owned = { _id: row._id, status: 'SENDING', projectionLeaseOwner: leaseOwner };
    try {
      const beforeSend = await db.collection('player_rating_state').findOne({ _id: state._id });
      if (!beforeSend || canonicalFingerprint(beforeSend) !== row.canonicalFingerprint) {
        const next = buildFprProjectionOutbox(beforeSend, nowIso);
        await db.collection('rating_projection_outbox').updateOne({ _id: next.id }, { $setOnInsert: next }, { upsert: true });
        await db.collection('rating_projection_outbox').updateOne(owned, { $set: { status: 'SUPERSEDED', supersededBy: next.id, updatedAt: nowIso },
          $unset: { projectionLeaseOwner: '', projectionLeaseUntil: '' } });
        result.superseded++; continue;
      }
      const response = await fetch(projectionUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(row.payload), signal: AbortSignal.timeout(20000) });
      const body = await response.json();
      if (!response.ok || body?.ok !== true || body?.projectionStatus !== 'SYNCED' || body?.clientId !== state.clientId
        || !Number.isFinite(Number(body.levelNumeric)) || Math.abs(Number(body.levelNumeric) - state.ratingNumeric) > 0.000001) {
        throw new Error(`FPR_LEVEL_PROJECTION_UNCONFIRMED_${response.status}`);
      }
      const latest = await db.collection('player_rating_state').findOne({ _id: state._id });
      if (!latest || canonicalFingerprint(latest) !== row.canonicalFingerprint) {
        const next = buildFprProjectionOutbox(latest, nowIso);
        await db.collection('rating_projection_outbox').updateOne({ _id: next.id }, { $setOnInsert: next }, { upsert: true });
        await db.collection('rating_projection_outbox').updateOne(owned, { $set: { status: 'SUPERSEDED', supersededBy: next.id, updatedAt: nowIso },
          $unset: { projectionLeaseOwner: '', projectionLeaseUntil: '' } });
        result.superseded++; continue;
      }
      await db.collection('rating_projection_outbox').updateOne(owned, { $set: { status: 'SYNCED', syncedAt: nowIso, updatedAt: nowIso },
        $unset: { projectionLeaseOwner: '', projectionLeaseUntil: '' } });
      result.synced++;
    } catch (error) {
      await db.collection('rating_projection_outbox').updateOne(owned, { $set: { status: 'FAILED_RETRYABLE', lastError: String(error.message).slice(0, 100),
        nextAttemptAt: new Date(Date.parse(nowIso) + 600000).toISOString(), updatedAt: nowIso }, $unset: { projectionLeaseOwner: '', projectionLeaseUntil: '' } });
      result.failed++;
    }
  }
  return result;
}
