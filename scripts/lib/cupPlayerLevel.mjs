import { createHash } from 'node:crypto';
import { ratingGradeFromNumeric, normalizeRatingPhone } from '../../src/services/player-rating/ledger.ts';

const fail = code => { throw new Error(code); };
export const validLevel = n => typeof n === 'number' && Number.isFinite(n) && n >= 1 && n <= 7;
export const validClientId = id => typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(id);
export const levelIdentityQuery = id => ({ $or: [{ clientId: id }, { playerKey: 'client:' + id },
  { 'identityAliases.clientIds': id }, { 'identityAliases.playerKeys': 'client:' + id }] });
const version = state => 'v1-' + createHash('sha256').update(JSON.stringify([state.playerKey, state.lastEventId, state.ratingNumeric])).digest('hex').slice(0, 24);

/** Exact verified client identities only. No provider fields or caller rating fallback. */
export async function readCupPlayerLevels(db, ids, options = {}) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some(id => !validClientId(id)) || new Set(ids).size !== ids.length) fail('LEVEL_ARGUMENTS');
  const rows = [];
  for (const id of ids) {
    const states = await db.collection('player_rating_state').find(levelIdentityQuery(id), options).limit(3).toArray();
    if (states.length > 1) fail('LEVEL_IDENTITY_CONFLICT');
    const state = states[0];
    if (!state) {
      // History without a projection is a repair condition, not a new player.
      const history = await db.collection('rating_events').findOne({ $or: [{ 'player.clientId': id }, { 'player.key': 'client:' + id }] }, options);
      if (history || await db.collection('player_ratings').findOne(levelIdentityQuery(id), options)) fail('LEVEL_REBUILD_REQUIRED');
      rows.push({ clientId: id, rating: null, ratingNumeric: null, source: 'CUP_CANONICAL', status: 'UNRATED', version: null });
      continue;
    }
    if (state.ownership !== 'CUP_CANONICAL' || !validLevel(state.ratingNumeric) || !state.lastEventId || !state.playerKey) fail('LEVEL_INVALID_CANONICAL');
    rows.push({ clientId: id, rating: ratingGradeFromNumeric(state.ratingNumeric), ratingNumeric: state.ratingNumeric,
      source: 'CUP_CANONICAL', status: 'RATED', version: version(state) });
  }
  return rows;
}

/** First assignment is atomic, initial-only and serialized with the rating workers. */
export async function initializeCupPlayerLevel(db, client, { clientId, name, phone, ratingNumeric }, now = new Date().toISOString()) {
  if (!validClientId(clientId) || !validLevel(ratingNumeric) || Math.abs(ratingNumeric * 1e5 - Math.round(ratingNumeric * 1e5)) > 1e-7) fail('LEVEL_ARGUMENTS');
  const session = client.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      const options = { session, maxTimeMS: 5000 };
      const phoneNorm = normalizeRatingPhone(phone);
      if (phoneNorm) {
        const owners = await db.collection('player_rating_state').find({ $or: [{ phoneNorm }, { 'identityAliases.phoneNorms': phoneNorm }, { playerKey: 'phone:' + phoneNorm }, { 'identityAliases.playerKeys': 'phone:' + phoneNorm }] }, options).limit(3).toArray();
        if (owners.some(state => state.clientId !== clientId && !state.identityAliases?.clientIds?.includes(clientId))) fail('LEVEL_IDENTITY_CONFLICT');
        const history = await db.collection('rating_events').findOne({ $or: [{ 'player.phoneNorm': phoneNorm, 'player.clientId': { $ne: clientId } }, { 'player.key': 'phone:' + phoneNorm }] }, options);
        if (history) fail('LEVEL_IDENTITY_CONFLICT');
      }
      const [row] = await readCupPlayerLevels(db, [clientId], options);
      const eventId = 'rating_evt:onboarding:' + createHash('sha256').update(clientId).digest('hex');
      if (row.status === 'RATED') {
        const previous = await db.collection('rating_events').findOne({ id: eventId }, options);
        if (previous?.eventType === 'RATING_INITIAL_ASSIGNED' && previous.source?.domain === 'ONBOARDING' && previous.actor?.id === clientId && previous.change?.after === ratingNumeric) { result = row; return; }
        fail('LEVEL_ALREADY_ASSIGNED');
      }
      // An unprojected compatibility identity must be reconciled before onboarding.
      if (await db.collection('player_ratings').findOne(levelIdentityQuery(clientId), options)) fail('LEVEL_REBUILD_REQUIRED');
      const key = 'client:' + clientId, grade = ratingGradeFromNumeric(ratingNumeric);
      const event = { _id: eventId, id: eventId, idempotencyKey: eventId, schemaVersion: 1,
        eventType: 'RATING_INITIAL_ASSIGNED', occurredAt: now, createdAt: now,
        player: { key, clientId, phoneNorm, name: String(name || 'Игрок').slice(0, 200) },
        actor: { type: 'PLAYER', id: clientId }, source: { domain: 'ONBOARDING', sourceId: eventId },
        change: { before: null, delta: null, after: ratingNumeric, gradeBefore: null, gradeAfter: grade },
        formula: { version: 'onboarding-v1' }, projectionIntent: { viva: 'NONE_CUP_ONLY' } };
      const state = { _id: key, playerKey: key, clientId, phoneNorm, name: event.player.name, nameSearch: event.player.name.toLocaleLowerCase('ru-RU'),
        schemaVersion: 1, ownership: 'CUP_CANONICAL', ratingNumeric, rating: grade,
        identityAliases: { clientIds: [clientId], phoneNorms: phoneNorm ? [phoneNorm] : [], playerKeys: [key] },
        baseline: { eventId, at: now, ratingNumeric }, lastEventId: eventId,
        lastEventType: event.eventType, lastEventAt: now, lastSource: 'ONBOARDING', lastChangedBy: event.actor, lastDelta: null, source: 'CUP', createdAt: now, updatedAt: now };
      await db.collection('rating_events').insertOne(event, options);
      await db.collection('player_rating_state').insertOne(state, options);
      await db.collection('player_ratings').insertOne({ ...state, compatibilityProjection: true, canonicalCollection: 'player_rating_state' }, options);
      result = (await readCupPlayerLevels(db, [clientId], options))[0];
    }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary', maxCommitTimeMS: 5000 });
    return result;
  } finally { await session.endSession(); }
}
