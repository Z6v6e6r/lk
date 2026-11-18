#!/usr/bin/env node
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { MongoClient } from 'mongodb';
import { ratingGradeFromNumeric } from '../src/services/player-rating/ledger.ts';
export function compareVivaLevelInventory(states, inventory, tenantKey) {
  if (typeof tenantKey !== 'string' || !tenantKey || inventory?.tenantKey !== tenantKey
      || !Array.isArray(inventory.clients) || inventory.clients.length > 100000) {
    throw Error('VIVA_INVENTORY_SCOPE_INVALID');
  }
  const byId = new Map();
  for (const state of states) {
    for (const id of new Set([state.clientId, ...(state.identityAliases?.clientIds || [])].filter(Boolean))) {
      byId.set(id, [...(byId.get(id) || []), state]);
    }
  }
  const counts = { records: inventory.clients.length, unratedInViva: 0, matching: 0, different: 0,
    vivaOnly: 0, cupOnly: 0, conflictingIdentity: 0, invalidVivaLevel: 0, duplicateVivaIds: 0 };
  const visited = new Set();
  const mapped = new Set();
  for (const record of inventory.clients) {
    if (typeof record?.clientId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(record.clientId)
      || record.tenantKey !== tenantKey) throw Error('VIVA_INVENTORY_IDENTITY_INVALID');
    if (visited.has(record.clientId)) { counts.duplicateVivaIds++; continue; }
    visited.add(record.clientId);
    const candidates = byId.get(record.clientId) || [];
    if (candidates.length > 1) { counts.conflictingIdentity++; continue; }
    const canonical = candidates[0];
    if (canonical) mapped.add(canonical);
    if (record.ratingNumeric === null && record.rating === null) {
      counts.unratedInViva++;
      if (canonical) counts.cupOnly++;
    } else if (typeof record.ratingNumeric !== 'number' || !Number.isFinite(record.ratingNumeric)
      || record.ratingNumeric < 1 || record.ratingNumeric > 7 || typeof record.rating !== 'string') {
      counts.invalidVivaLevel++;
    } else if (!canonical) counts.vivaOnly++;
    else if (canonical.ratingNumeric !== record.ratingNumeric || canonical.rating !== record.rating) counts.different++;
    else counts.matching++;
  }
  counts.cupOnly += states.filter(state => !mapped.has(state) && ![state.clientId, ...(state.identityAliases?.clientIds || [])]
    .some(id => (byId.get(id) || []).length > 1)).length;
  return { comparison: 'DRY_RUN', completeInventoryAttested: inventory.complete === true, ...counts };
}

/** Read-only, aggregate-only audit. No provider calls, index creation or writes. */
export async function auditCupPlayerLevelCutover(db, options = {}) {
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
  const vivaDryRun = options.inventory
    ? compareVivaLevelInventory(states, options.inventory, options.tenantKey) : null;
  return { readOnly: true, canonicalStates: states.length, compatibilityStates: compatible.length, invalidCanonicalStates: invalid,
    gradeDrift, compatibilityWithoutCanonical, inFlightVivaTasks: inFlight, pendingVivaTasks, pendingLegacyTasks,
    identityConflicts, canonicalCoverageReady: identityConflicts === 0 && invalid === 0 && gradeDrift === 0 && compatibilityWithoutCanonical === 0 && inFlight === 0,
    ...(vivaDryRun ? { vivaDryRun } : {}),
    fullVivaClientInventoryVerified: false, note: 'Compare a protected Viva inventory before field deletion. Unrated clients need no canonical record.' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.MONGODB_URI) throw Error('Provide the intended read-only MONGODB_URI; credentials are never printed');
  const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--viva-inventory')) throw Error('VIVA_INVENTORY_USAGE');
    let options = {};
    if (args.length) {
      const stat = fs.lstatSync(args[1]);
      if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) || stat.size > 64 * 1024 * 1024) throw Error('VIVA_INVENTORY_FILE_INVALID');
      options = { inventory: JSON.parse(fs.readFileSync(args[1], 'utf8')), tenantKey: process.env.CUP_LEVEL_AUDIT_TENANT };
    }
    await client.connect();
    console.log(JSON.stringify(await auditCupPlayerLevelCutover(client.db(process.env.MONGODB_DB || 'games'), options), null, 2));
  }
  catch { process.stderr.write('CUP level audit unavailable; no mutations performed\n'); process.exitCode = 1; }
  finally { await client.close(); }
}
