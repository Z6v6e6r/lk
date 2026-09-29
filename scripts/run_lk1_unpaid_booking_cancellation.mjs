#!/usr/bin/env node
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { createLk1VivaCancellationProvider, reconcileLk1UnpaidBooking,
  isValidLk1ZonedInstant, buildLk1UnpaidScanQuery } from './lib/lk1UnpaidBookingCancellation.mjs';
import { createLk1VivaServiceToken } from './lib/lk1VivaServiceToken.mjs';
import { createLk1LiveGatewayGuard } from './lib/lk1LiveGatewayGuard.mjs';

const args = process.argv.slice(2);
const value = name => { const index = args.indexOf(name); return index < 0 ? null : args[index + 1]; };
const mode = value('--mode') || process.env.LK1_UNPAID_CANCEL_MODE || 'OFF';
const cohortFrom = value('--cohort-from') || process.env.LK1_UNPAID_CANCEL_COHORT_FROM;
const tenantKey = value('--tenant') || process.env.LK1_UNPAID_CANCEL_TENANT;
const uri = process.env.LK1_UNPAID_CANCEL_MONGO_URI;
const database = process.env.LK1_UNPAID_CANCEL_DB || 'games';
const tokenFile = process.env.LK1_UNPAID_CANCEL_TOKEN_FILE;
const serviceConfigFile = process.env.LK1_UNPAID_CANCEL_VIVA_SERVICE_CONFIG_FILE;
const serviceEnvironment = {
  tokenUrl: process.env.VIVA_SERVICE_TOKEN_URL,
  clientId: process.env.VIVA_SERVICE_CLIENT_ID,
  username: process.env.VIVA_SERVICE_USERNAME,
  password: process.env.VIVA_SERVICE_PASSWORD,
};
const hasServiceEnvironment = Object.values(serviceEnvironment).some(Boolean);
const intervalMs = 120_000;
const label = key => crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 12);

if (args.includes('--help') || !args.includes('--run')) {
  process.stdout.write('Usage: node scripts/run_lk1_unpaid_booking_cancellation.mjs --run [--once] [--mode OFF|SHADOW|ENFORCE_NEW] --tenant TENANT --cohort-from RFC3339. Requires LK1_UNPAID_CANCEL_MONGO_URI and exactly one of LK1_UNPAID_CANCEL_TOKEN_FILE, LK1_UNPAID_CANCEL_VIVA_SERVICE_CONFIG_FILE, or VIVA_SERVICE_* environment; optional LK1_UNPAID_CANCEL_DB. Default OFF.\n');
  process.exit(0);
}
if (!['OFF', 'SHADOW', 'ENFORCE_NEW'].includes(mode)) throw new Error('MODE_INVALID');
if (mode === 'OFF') { process.stdout.write('{"mode":"OFF"}\n'); process.exit(0); }
if (!isValidLk1ZonedInstant(cohortFrom) || !/^[A-Za-z0-9_-]{1,64}$/.test(tenantKey || '')) throw new Error('COHORT_OR_TENANT_INVALID');
if (!uri || [Boolean(tokenFile), Boolean(serviceConfigFile), hasServiceEnvironment]
  .filter(Boolean).length !== 1) throw new Error('WORKER_CONFIGURATION_REQUIRED');
const liveGuard = mode === 'ENFORCE_NEW' ? createLk1LiveGatewayGuard() : null;

async function readPrivateFile(file) {
  if (!file?.startsWith('/')) throw new Error('CREDENTIAL_FILE_INVALID');
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) throw new Error('CREDENTIAL_FILE_INVALID');
  return fs.readFile(file, 'utf8');
}

const cutoffIso = new Date(cohortFrom).toISOString();
const { MongoClient } = await import('mongodb');
const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000, retryWrites: false });
let stopped = false;
let guardDrift = false;
let wake = () => {};
process.on('SIGINT', () => { stopped = true; wake(); });
process.on('SIGTERM', () => { stopped = true; wake(); });
const shouldStop = () => {
  if (stopped) return true;
  if (liveGuard && !liveGuard.check()) { guardDrift = true; stopped = true; wake(); return true; }
  return false;
};
try {
  await client.connect();
  const operations = client.db(database).collection('lk_subscription_daily_booking_ops');
  const token = serviceConfigFile
    ? createLk1VivaServiceToken({ readConfig: async () => JSON.parse(await readPrivateFile(serviceConfigFile)) })
    : hasServiceEnvironment
      ? createLk1VivaServiceToken({ readConfig: async () => serviceEnvironment })
      : async () => (await readPrivateFile(tokenFile)).trim();
  const provider = createLk1VivaCancellationProvider({ token });
  let afterId = null;
  do {
    const query = buildLk1UnpaidScanQuery({ tenantKey, cohortFrom: cutoffIso, afterId });
    const rows = await operations.find(query).sort({ _id: 1 }).limit(100).toArray();
    afterId = rows.length === 100 ? rows.at(-1)._id : null;
    for (const op of rows) {
      if (shouldStop()) break;
      let result;
      try { result = await reconcileLk1UnpaidBooking({ op, operations, provider, cohortFrom: cutoffIso,
        mode, shouldStop }); }
      catch (error) { result = { state: 'PRECHECK_REQUIRED',
        reason: /^[A-Z_]+$/.test(error?.message || '') ? error.message : 'READ_UNAVAILABLE' }; }
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
} finally {
  await client.close();
  if (guardDrift) {
    process.stdout.write('{"state":"STOPPED","reason":"LIVE_RUNTIME_CHANGED"}\n');
    // systemd must not re-baseline a changed live flow after this stop.
    process.exitCode = 78;
  }
}
