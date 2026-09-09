import fs from 'node:fs/promises';
import { MongoClient } from 'mongodb';
import { createVivaVisitProvider, runSubscriptionVisitJob, cleanupConfirmedVisitLocks } from './lib/subscriptionVisitWorker.mjs';

// Invocation is an explicit runtime operation. No worker is started by builds/imports.
if (!process.argv.includes('--run')) {
  process.stdout.write('Disabled. Use --run with SUBSCRIPTION_VISIT_MONGO_URI, SUBSCRIPTION_VISIT_DB, SUBSCRIPTION_VISIT_TENANT and SUBSCRIPTION_VISIT_TOKEN_FILE. --once runs one batch.\n');
} else {
  const { SUBSCRIPTION_VISIT_MONGO_URI: uri, SUBSCRIPTION_VISIT_DB: database,
    SUBSCRIPTION_VISIT_TENANT: tenant, SUBSCRIPTION_VISIT_TOKEN_FILE: tokenFile,
    SUBSCRIPTION_VISIT_VIVA_ORIGIN: baseUrl } = process.env;
  if (!uri || !database || !tenant || !tokenFile) throw new Error('VISIT_WORKER_CONFIGURATION_REQUIRED');
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000, retryWrites: false });
  let stopped = false;
  let wake = () => {};
  process.on('SIGINT', () => { stopped = true; wake(); });
  process.on('SIGTERM', () => { stopped = true; wake(); });
  try {
    await client.connect();
    const operations = client.db(database).collection('lk_subscription_daily_booking_ops');
    const locks = client.db(database).collection('lk_subscription_visit_locks');
    const leaveOperations = client.db(database).collection('lk_game_leave_operations');
    const reported = new Map();
    let afterKey = null;
    const provider = createVivaVisitProvider({ baseUrl, token: async () => (await fs.readFile(tokenFile, 'utf8')).trim() });
    do {
      await cleanupConfirmedVisitLocks({ operations, locks, tenantKey: tenant });
      const rows = await operations.find({ tenantKey: tenant, state: 'CONFIRMED',
        ...(afterKey ? { _id: { $gt: afterKey } } : {}),
        $or: [{ 'lk1.visitNextCheckAt': { $exists: false } }, { 'lk1.visitNextCheckAt': { $lte: new Date().toISOString() } }],
        'lk1.visitJob.phase': { $in: ['DEBIT_PENDING', 'DEBIT_SENT', 'DEBIT_UNKNOWN', 'DEBIT_CONFIRMED', 'RETURN_PENDING', 'RETURN_SENT', 'RETURN_UNKNOWN', 'RETURN_CONFIRMED', 'CANCELLED_BEFORE_DEBIT'] } })
        .sort({ _id: 1 }).limit(50).toArray();
      afterKey = rows.length === 50 ? rows.at(-1)._id : null;
      for (const row of rows) {
        if (stopped) break;
        try {
          const result = await runSubscriptionVisitJob({ operationKey: row._id, operations, locks, provider, leaveOperations });
          // A concurrent cancellation increments revision; do not postpone it
          // using an older audit result. Its hook explicitly wakes the job.
          const current = await operations.findOne({ _id: row._id });
          if (current?.lk1?.visitJob?.revision === row.lk1.visitJob.revision) {
            await operations.updateOne({ _id: row._id, 'lk1.visitJob.revision': row.lk1.visitJob.revision },
              { $set: { 'lk1.visitNextCheckAt': new Date(Date.now()+120000).toISOString() } });
          }
          if (reported.get(row._id) !== result.state) {
            reported.set(row._id, result.state);
            process.stdout.write(JSON.stringify({ jobId: row.lk1.visitJob.id, ...result }) + '\n');
          }
        } catch { process.stderr.write(JSON.stringify({ jobId: row.lk1.visitJob.id, state: 'STORE_OR_RUNTIME_UNAVAILABLE' }) + '\n'); }
      }
      if (process.argv.includes('--once') || stopped) break;
      await new Promise(resolve => { const timer = setTimeout(resolve, 5000); wake = () => { clearTimeout(timer); resolve(); }; });
    } while (!stopped);
  } finally { await client.close(); }
}
