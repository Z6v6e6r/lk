#!/usr/bin/env node
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { createLk1VivaCancellationProvider, reconcileLk1UnpaidBooking,
  isValidLk1ZonedInstant, buildLk1UnpaidScanQuery } from './lib/lk1UnpaidBookingCancellation.mjs';

const args = process.argv.slice(2);
const value = name => { const index = args.indexOf(name); return index < 0 ? null : args[index + 1]; };
const mode = value('--mode') || process.env.LK1_UNPAID_CANCEL_MODE || 'OFF';
const cohortFrom = value('--cohort-from') || process.env.LK1_UNPAID_CANCEL_COHORT_FROM;
const tenantKey = value('--tenant') || process.env.LK1_UNPAID_CANCEL_TENANT;
const uri = process.env.LK1_UNPAID_CANCEL_MONGO_URI;
const database = process.env.LK1_UNPAID_CANCEL_DB || 'games';
const tokenFile = process.env.LK1_UNPAID_CANCEL_TOKEN_FILE;
const intervalMs = 120_000;
const label = key => crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 12);

if (args.includes('--help') || !args.includes('--run')) {
  process.stdout.write('Usage: node scripts/run_lk1_unpaid_booking_cancellation.mjs --run [--once] [--mode OFF|SHADOW|ENFORCE_NEW] --tenant TENANT --cohort-from RFC3339. Requires LK1_UNPAID_CANCEL_MONGO_URI, LK1_UNPAID_CANCEL_TOKEN_FILE, optional LK1_UNPAID_CANCEL_DB. Default OFF.\n');
  process.exit(0);
}
if (!['OFF', 'SHADOW', 'ENFORCE_NEW'].includes(mode)) throw new Error('MODE_INVALID');
if (mode === 'OFF') { process.stdout.write('{"mode":"OFF"}\n'); process.exit(0); }
if (!isValidLk1ZonedInstant(cohortFrom) || !/^[A-Za-z0-9_-]{1,64}$/.test(tenantKey || '')) throw new Error('COHORT_OR_TENANT_INVALID');
if (!uri || !tokenFile) throw new Error('WORKER_CONFIGURATION_REQUIRED');

const cutoffIso = new Date(cohortFrom).toISOString();
const { MongoClient } = await import('mongodb');
const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000, retryWrites: false });
let stopped = false;
let wake = () => {};
process.on('SIGINT', () => { stopped = true; wake(); });
process.on('SIGTERM', () => { stopped = true; wake(); });
try {
  await client.connect();
  const operations = client.db(database).collection('lk_subscription_daily_booking_ops');
  const provider = createLk1VivaCancellationProvider({ token: async () =>
    (await fs.readFile(tokenFile, 'utf8')).trim() });
  let afterId = null;
  do {
    const query = buildLk1UnpaidScanQuery({ tenantKey, cohortFrom: cutoffIso, afterId });
    const rows = await operations.find(query).sort({ _id: 1 }).limit(100).toArray();
    afterId = rows.length === 100 ? rows.at(-1)._id : null;
    for (const op of rows) {
      if (stopped) break;
      let result;
      try { result = await reconcileLk1UnpaidBooking({ op, operations, provider, cohortFrom: cutoffIso, mode }); }
      catch { result = { state: 'PRECHECK_REQUIRED' }; }
      if (result.state !== 'SKIPPED' || !['NOT_DUE', 'PAID'].includes(result.reason)) {
        process.stdout.write(JSON.stringify({ operation: label(op._id), state: result.state,
          ...(result.reason ? { reason: result.reason } : {}) }) + '\n');
      }
    }
    if (args.includes('--once') || stopped) break;
    // A large cohort is traversed one bounded page per interval. Never burst
    // through the full history with unbounded Viva GET traffic.
    await new Promise(resolve => { const timer = setTimeout(resolve, intervalMs);
      wake = () => { clearTimeout(timer); resolve(); }; });
  } while (!stopped);
} finally { await client.close(); }
