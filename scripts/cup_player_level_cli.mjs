import { authorizeCupLevelInput } from './lib/cupLevelAuth.mjs';
// Private root-owned Node-RED child. Authentication is completed before spawning.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { readCupPlayerLevels, initializeCupPlayerLevel } from './lib/cupPlayerLevel.mjs';
import { withRatingDataLock } from './lib/ratingDataLock.mjs';
let client;
try {
  const script = fs.realpathSync(process.argv[1]);
  if (process.getuid() !== 0 || !/^\/opt\/padlhub-player-level\/releases\/[a-zA-Z0-9-]+\/level\.mjs$/.test(script)) throw Error('LEVEL_RUNTIME_UNAVAILABLE');
  const manifest = JSON.parse(fs.readFileSync(script.replace(/level\.mjs$/, 'release-manifest.json')));
  if (manifest.sourceDirty !== false || manifest.sha256 !== crypto.createHash('sha256').update(fs.readFileSync(script)).digest('hex')) throw Error('LEVEL_RUNTIME_UNAVAILABLE');
  const bytes = fs.readFileSync(0); if (bytes.length > 32768) throw Error('LEVEL_ARGUMENTS');
  const input = await authorizeCupLevelInput(JSON.parse(bytes), async authorization => {
    const response = await fetch('https://api.vivacrm.ru/end-user/api/v1/iSkq6G/profile', {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10000), headers: { Authorization: authorization, Accept: 'application/json' },
    });
    if ([401, 403].includes(response.status)) throw Error('LEVEL_AUTH_REQUIRED');
    if (response.status !== 200) throw Error('LEVEL_UNAVAILABLE');
    return (await response.json())?.id;
  });
  if (input.operation === 'verify') {
    console.log(JSON.stringify({ ok: true, source: 'CUP_CANONICAL', items: [] })); process.exit(0);
  }
  const { MongoClient } = createRequire('/opt/padlhub-rating-worker/current/package.json')('mongodb');
  const config = JSON.parse(fs.readFileSync('/root/.node-red/flows.json')).find(n => n.id === '4e820638cc39c730' && n.type === 'mongodb4-client' && n.dbName === 'games');
  if (!config?.uri) throw Error('LEVEL_RUNTIME_UNAVAILABLE');
  client = new MongoClient(config.uri, { serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000, socketTimeoutMS: 10000 });
  await client.connect(); const db = client.db('games');
  // Existing unique indexes are prerequisites; this process never creates them.
  for (const name of ['player_rating_state', 'player_ratings']) {
    const indexes = await db.collection(name).indexes();
    if (!['clientId', 'playerKey'].every(k => indexes.some(i => i.unique && Object.keys(i.key).length === 1 && i.key[k] === 1 && (!i.partialFilterExpression || JSON.stringify(i.partialFilterExpression) === JSON.stringify({ [k]: { $type: 'string' } }))))) throw Error('LEVEL_INDEXES_REQUIRED');
  }
  const eventIndexes = await db.collection('rating_events').indexes();
  if (!eventIndexes.some(i => i.unique && Object.keys(i.key).length === 1 && i.key.idempotencyKey === 1 && !i.partialFilterExpression)) throw Error('LEVEL_INDEXES_REQUIRED');
  let items;
  if (input.operation === 'initialize') items = [await withRatingDataLock(() => initializeCupPlayerLevel(db, client, input), { waitSeconds: 10 })];
  else {
    const session = client.startSession();
    try { await session.withTransaction(async () => { items = await readCupPlayerLevels(db, input.clientIds, { session, maxTimeMS: 5000 }); },
      { readConcern: { level: 'snapshot' }, readPreference: 'primary', maxCommitTimeMS: 5000 }); }
    finally { await session.endSession(); }
  }
  console.log(JSON.stringify({ ok: true, source: 'CUP_CANONICAL', items }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: /^LEVEL_[A-Z_]+$/.test(error.message) ? error.message : 'LEVEL_UNAVAILABLE' }));
  process.exitCode = 1;
} finally { if (client) await client.close(); }
