// Closes the checkout-polling loop of the stale seasonal subscription sales backlog.
//
// 2026-09-17: `lk_tournament_subscription_sales` held 2 495 PAYMENT_PENDING sale records,
// 2 304 of them past their payment deadline, and 1 640 of them were re-read from the
// provider every hour (one row had 60 recovery checks). The checkout poller schedules
// `paymentPolling.nextCheckAt` an hour ahead for every locally archived sale, and the
// reconcile dispatcher selects exactly the rows whose `nextCheckAt` is due, so the
// backlog kept re-reading provider transactions forever without ever turning one paid.
//
// This script writes the terminal polling marker for rows that already exhausted the
// reviewed recovery bound (`maxRecoveryChecks` in scripts/lib/subscriptionPaymentPolling.mjs):
//
//   paymentPolling.recoveryClosedAt        = now
//   paymentPolling.recoveryClosedReason    = "RECOVERY_CHECK_LIMIT"
//   paymentPolling.nextCheckAt             = null
//
// `nextCheckAt: null` matches neither `{ $exists: false }` nor `{ $lte: <iso> }` in the
// installed dispatcher query, so the row leaves the hourly loop immediately; the deployed
// poller additionally recognises `recoveryClosedAt` and never rewrites the schedule.
//
// Only checkout-polling metadata is touched. The sale keeps its own status
// (PAYMENT_PENDING), its transaction id, its amounts and its provider deadline, exactly as
// the poller's own archive write does; a late payment is still settled by
// `npm run subscriptions:reconcile-viva`, and a late provider confirmation still wins over
// the local closure inside the poller.
//
// Usage:
//   node scripts/close_subscription_payment_polling_backlog.mjs --flows <flows.json> --report <report.json> [--dry-run]
//   node scripts/close_subscription_payment_polling_backlog.mjs --flows <flows.json> --report <report.json> --apply [--limit 5000]
//
// Dry run is the default. Only `--apply` writes, and it never upserts and never retries a
// concurrent modification (compare-and-swap on the exact preimage it read).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createSubscriptionPaymentPolling } from './lib/subscriptionPaymentPolling.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback = null) => {
  const at = args.indexOf(name);
  return at === -1 ? fallback : args[at + 1];
};
const APPLY = flag('--apply');
const flowsPath = value('--flows', '/root/.node-red/flows.json');
const reportPath = value('--report', null);
const databaseName = value('--database', null);
const modulePath = value('--mongodb-module', 'mongodb');
const limit = Number(value('--limit', '5000'));
const { maxRecoveryChecks } = createSubscriptionPaymentPolling();

if (!flowsPath || !reportPath) {
  console.error('Usage: --flows <flows.json> --report <report.json> [--apply] [--limit N]');
  process.exit(2);
}
if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20000) {
  console.error('--limit must be a safe integer between 1 and 20000');
  process.exit(2);
}

const raw = fs.readFileSync(flowsPath, 'utf8');
const uri = (raw.match(/mongodb\+srv:\/\/[^"\\]+/) || raw.match(/mongodb:\/\/[^"\\]+/) || [])[0];
if (!uri) {
  console.error('No MongoDB URI found in the flows file');
  process.exit(2);
}
const dbName = databaseName || (uri.split('?')[0].split('/').pop()) || 'test';
const require = createRequire(path.join(path.dirname(flowsPath), '/'));
const { MongoClient } = require(modulePath);
const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
await client.connect();
const col = client.db(dbName).collection('lk_tournament_subscription_sales');

const now = new Date().toISOString();
// Only rows that are locally archived, already past the reviewed recovery bound and not
// yet closed for polling. A row inside its recovery window keeps its hourly read.
const filter = {
  status: 'PAYMENT_PENDING',
  'paymentPolling.status': 'FAILED',
  'paymentPolling.recoveryChecks': { $gte: maxRecoveryChecks },
  'paymentPolling.recoveryClosedAt': { $exists: false },
};

const before = {
  total: await col.countDocuments({}),
  paymentPending: await col.countDocuments({ status: 'PAYMENT_PENDING' }),
  pollFailed: await col.countDocuments({ 'paymentPolling.status': 'FAILED' }),
  pastDeadline: await col.countDocuments({ status: 'PAYMENT_PENDING',
    'paymentPolling.deadlineAt': { $lt: now } }),
  dueForRead: await col.countDocuments({ status: 'PAYMENT_PENDING',
    'paymentPolling.nextCheckAt': { $lte: now } }),
  schedulableInFuture: await col.countDocuments({ status: 'PAYMENT_PENDING',
    'paymentPolling.nextCheckAt': { $gt: now } }),
  selected: await col.countDocuments(filter),
};

const selected = await col.find(filter)
  .project({ _id: 1, clientId: 1, paymentRef: 1, status: 1, paymentPolling: 1 }).limit(limit).toArray();
const clients = new Set(selected.map((row) => String(row.clientId || '')).filter(Boolean));
const nowIso = new Date().toISOString();
const report = {
  kind: 'SUBSCRIPTION_PAYMENT_POLLING_BACKLOG_CLOSURE_V1',
  at: nowIso, database: dbName, apply: APPLY, dryRun: !APPLY,
  recoveryBound: maxRecoveryChecks, limit,
  before,
  selection: { filter, selected: selected.length, distinctClients: clients.size,
    minRecoveryChecks: selected.length ? Math.min(...selected.map((row) => row.paymentPolling?.recoveryChecks ?? 0)) : null,
    maxRecoveryChecks: selected.length ? Math.max(...selected.map((row) => row.paymentPolling?.recoveryChecks ?? 0)) : null,
    reasons: [...new Set(selected.map((row) => row.paymentPolling?.reason || null))] },
  // Exact preimages of what will be closed, bounded for the receipt.
  preimages: selected.slice(0, 200).map((row) => ({ _id: String(row._id), paymentRef: row.paymentRef,
    status: row.status, paymentPolling: row.paymentPolling })),
  applied: 0, conflicts: 0, missedByLimit: 0,
};

if (APPLY) {
  for (const row of selected) {
    const result = await col.updateOne({
      _id: row._id,
      status: 'PAYMENT_PENDING',
      'paymentPolling.recoveryChecks': row.paymentPolling?.recoveryChecks,
      'paymentPolling.nextCheckAt': row.paymentPolling?.nextCheckAt === undefined
        ? { $exists: false } : row.paymentPolling.nextCheckAt,
      'paymentPolling.recoveryClosedAt': { $exists: false },
    }, {
      $set: {
        'paymentPolling.recoveryClosedAt': nowIso,
        'paymentPolling.recoveryClosedReason': 'RECOVERY_CHECK_LIMIT',
        'paymentPolling.nextCheckAt': null,
      },
    });
    if (result.modifiedCount === 1) report.applied += 1;
    else report.conflicts += 1;
  }
  report.missedByLimit = Math.max(0, before.selected - selected.length);
  report.after = {
    selected: await col.countDocuments(filter),
    paymentPending: await col.countDocuments({ status: 'PAYMENT_PENDING' }),
    schedulableInFuture: await col.countDocuments({ status: 'PAYMENT_PENDING',
      'paymentPolling.nextCheckAt': { $gt: nowIso } }),
    closedForPolling: await col.countDocuments({ 'paymentPolling.recoveryClosedAt': { $exists: true } }),
    // The financial state must be untouched by this closure.
    paidWithClosedPolling: await col.countDocuments({ status: 'PAID',
      'paymentPolling.recoveryClosedAt': { $exists: true } }),
  };
}

await client.close();
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
console.log(JSON.stringify({ apply: report.apply, selected: report.selection.selected,
  distinctClients: report.selection.distinctClients, applied: report.applied,
  conflicts: report.conflicts, after: report.after ?? null, report: reportPath }, null, 1));
