import { readCupPlayerLevels } from './cupPlayerLevel.mjs';
const fail = (code, playerId) => { const error = new Error(code); error.playerId = playerId; throw error; };
/** Runtime starts only read existing CUP levels. Initial assignment belongs to onboarding/admin. */
export async function initializeFprStarts(db, client, ids, actorId) {
  if (!actorId || !Array.isArray(ids) || ids.length > 28) fail('FPR_START_ARGUMENTS');
  const session = client.startSession(); let result;
  try {
    await session.withTransaction(async () => {
      let levels;
      try { levels = await readCupPlayerLevels(db, ids, { session, maxTimeMS: 5000 }); }
      catch { fail('FPR_START_INVALID_CANONICAL'); }
      const unrated = levels.find(row => row.status !== 'RATED');
      if (unrated) fail('FPR_START_LEVEL_REQUIRED', unrated.clientId);
      const states = [], used = new Set();
      for (const row of levels) {
        const state = await db.collection('player_rating_state').findOne({ $or: [{ clientId: row.clientId }, { 'identityAliases.clientIds': row.clientId }] }, { session });
        if (!state) fail('FPR_START_INVALID_CANONICAL', row.clientId);
        if (used.has(state.playerKey)) fail('FPR_START_IDENTITY_CONFLICT', row.clientId); used.add(state.playerKey);
        states.push({ clientId: state.clientId, playerKey: state.playerKey, ownership: state.ownership, ratingNumeric: row.ratingNumeric,
          lastEventId: state.lastEventId, identityAliases: { clientIds: state.identityAliases?.clientIds || [row.clientId] } });
      }
      result = { states, initialized: [] };
    }, { readConcern: { level: 'snapshot' }, readPreference: 'primary', maxCommitTimeMS: 5000 });
    return result;
  } finally { await session.endSession(); }
}
// Compatibility exports never call the former provider reader or acquire a writer lock.
export const initializeFprStartsWithViva = initializeFprStarts;
export const prepareFprStarts = initializeFprStarts;
