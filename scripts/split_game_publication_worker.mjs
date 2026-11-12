import { pathToFileURL } from 'node:url';
import { publishConfirmedOperation } from './lib/splitGamePublication.mjs';

export async function runPublicationBatch(db, { apply = false, limit = 20, withTransaction, tenantKey } = {}) {
  if (apply && typeof withTransaction !== 'function') throw new Error('TRANSACTION_REQUIRED');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(tenantKey || '')) throw new Error('TENANT_REQUIRED');
  const operations = db.collection('lk_subscription_daily_booking_ops'), games = db.collection('lk_games');
  // No old/no-intent operations. Money and provider reconciliation are never this worker's job.
  const rows = await operations.find({ tenantKey, state: 'CONFIRMED', 'lk1.publication.version': 1,
    'lk1.publication.state': 'PENDING', 'lk1.decision.benefit.finalPriceMinor': 0,
    $or: [{ 'lk1.publication.retryAt': { $exists: false } }, { 'lk1.publication.retryAt': { $lte: new Date().toISOString() } }],
  }).limit(Math.min(50, Math.max(1, limit))).toArray();
  const counts = { published: 0, dryRun: 0, ignored: 0, pending: 0 };
  for (const operation of rows) {
    try {
      const execute = session => publishConfirmedOperation({ operations, games, operation, apply, session });
      const result = apply ? await withTransaction(execute) : await execute();
      counts[result.state === 'PUBLISHED' ? 'published' : result.state === 'DRY_RUN' ? 'dryRun' : 'ignored']++;
    } catch (error) {
      counts.pending++;
      if (apply) {
        const permanent = typeof error?.code === 'string' && /^PUBLICATION_(?:BINDING|BOOKING|INTENT|TARGET|EXISTING_GAME|RENDER)/.test(error.code);
        const attempts = Number(operation.lk1?.publication?.attempts || 0) + 1;
        // Park poison/conflicting intents and back off transient storage failures, so
        // they cannot monopolize the bounded queue. Never downgrade a successful CAS.
        await operations.updateOne({ _id: operation._id, operationId: operation.operationId,
          tenantKey, state: 'CONFIRMED', 'lk1.publication.state': 'PENDING',
          'lk1.publication.intentJson': operation.lk1.publication.intentJson },
        { $set: { 'lk1.publication.state': permanent || attempts >= 8 ? 'BLOCKED' : 'PENDING',
          'lk1.publication.retryAt': new Date(Date.now() + 30000).toISOString(),
          'lk1.publication.lastError': permanent ? error.code : 'PUBLICATION_STORAGE_RETRY' },
        $inc: { 'lk1.publication.attempts': 1 } }, { writeConcern: { w: 'majority', j: true } });
      }
    } // Only counts leave the worker; no IDs, bodies or credentials.
  }
  return counts;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const tenantKey = process.env.PADLHUB_PLATFORM_TENANT_KEY;
  if (!process.env.MONGO_URI || !process.env.MONGO_DB || !tenantKey) throw new Error('CONFIG_REQUIRED');
  const { MongoClient } = await import('mongodb');
  const client = new MongoClient(process.env.MONGO_URI, { maxPoolSize: 2, serverSelectionTimeoutMS: 5000 });
  try {
    await client.connect(); const db = client.db(process.env.MONGO_DB);
    if (apply) {
      const hello = await db.admin().command({ hello: 1 });
      if (!hello.setName) throw new Error('REPLICA_SET_REQUIRED');
      const indexes = await db.collection('lk_games').listIndexes().toArray();
      if (!indexes.some(i => i.unique === true && JSON.stringify(i.key) === JSON.stringify({ tenantKey: 1, id: 1 }) && !i.partialFilterExpression && !i.sparse)) throw new Error('UNIQUE_INDEX_REQUIRED');
    }
    for (;;) {
      console.log(JSON.stringify(await runPublicationBatch(db, { apply, tenantKey, withTransaction: async execute => {
        const session = client.startSession();
        try { return await session.withTransaction(() => execute(session),
          { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority', j: true } }); }
        finally { await session.endSession(); }
      } })));
      if (process.argv.includes('--once')) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  } finally { await client.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('SPLIT_PUBLICATION_WORKER_STOPPED'); process.exitCode = 1; });
}
