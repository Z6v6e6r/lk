#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { MongoClient } from 'mongodb';
import { ratingGradeFromNumeric } from '../src/services/player-rating/ledger.ts';
/** Read-only, aggregate-only audit. No provider calls, index creation or writes. */
export async function auditCupPlayerLevelCutover(db) {
  const [states, compatible] = await Promise.all([
    db.collection('player_rating_state').find({}, { projection: { clientId: 1, playerKey: 1, identityAliases: 1, ownership: 1, ratingNumeric: 1, rating: 1, lastEventId: 1 } }).limit(50001).toArray(),
    db.collection('player_ratings').find({}, { projection: { clientId: 1, playerKey: 1, ratingNumeric: 1 } }).limit(50001).toArray(),
  ]);
  if (states.length > 50000 || compatible.length > 50000) throw Error('AUDIT_CAP_EXCEEDED');
  const ids = new Set(states.flatMap(row => [row.clientId, ...(row.identityAliases?.clientIds || [])]).filter(Boolean));
  const keys = new Set(states.map(row => row.playerKey));
  const owners = new Map();
  states.forEach((row, index) => { for (const id of new Set([row.clientId, ...(row.identityAliases?.clientIds || [])].filter(Boolean))) { const set = owners.get(id) || new Set(); set.add(index); owners.set(id, set); } });
  const identityConflicts = [...owners.values()].filter(set => set.size > 1).length;
  const invalid = states.filter(row => row.ownership !== 'CUP_CANONICAL' || typeof row.ratingNumeric !== 'number' || !Number.isFinite(row.ratingNumeric) || row.ratingNumeric < 1 || row.ratingNumeric > 7 || !row.lastEventId).length;
  const gradeDrift = states.filter(row => Number.isFinite(row.ratingNumeric) && row.rating !== ratingGradeFromNumeric(row.ratingNumeric)).length;
  const compatibilityWithoutCanonical = compatible.filter(row => !ids.has(row.clientId) && !keys.has(row.playerKey)).length;
  const inFlight = await db.collection('rating_projection_outbox').countDocuments({ status: 'SENDING' });
  const pendingVivaTasks = await db.collection('rating_projection_outbox').countDocuments({ status: { $in: ['PENDING', 'FAILED_RETRYABLE'] } });
  const pendingLegacyTasks = await db.collection('lk_result_viva_sync_outbox').countDocuments({ status: { $in: ['PENDING', 'FAILED'] } });
  return { readOnly: true, canonicalStates: states.length, compatibilityStates: compatible.length, invalidCanonicalStates: invalid,
    gradeDrift, compatibilityWithoutCanonical, inFlightVivaTasks: inFlight, pendingVivaTasks, pendingLegacyTasks,
    identityConflicts, canonicalCoverageReady: identityConflicts === 0 && invalid === 0 && gradeDrift === 0 && compatibilityWithoutCanonical === 0 && inFlight === 0,
    fullVivaClientInventoryVerified: false, note: 'Compare a protected Viva inventory before field deletion. Unrated clients need no canonical record.' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.MONGODB_URI) throw Error('Provide the intended read-only MONGODB_URI; credentials are never printed');
  const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
  try { await client.connect(); console.log(JSON.stringify(await auditCupPlayerLevelCutover(client.db(process.env.MONGODB_DB || 'games')), null, 2)); }
  catch { process.stderr.write('CUP level audit unavailable; no mutations performed\n'); process.exitCode = 1; }
  finally { await client.close(); }
}
