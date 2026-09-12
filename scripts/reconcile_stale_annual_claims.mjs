#!/usr/bin/env node

// Scheduled reconciler for stale annual HUB reservations.
//
// The annual HUB storefront keeps one bounded daily seat occupied while the
// provider transaction is non-terminal: the reservation carries the provider's
// checkout deadline, and the runtime releases it only when Viva returns an
// explicit terminal PAID/FAILED state. When the payment link simply dies
// without the provider ever reporting a terminal state, the seat stays occupied
// and the storefront keeps showing "0 из N" long after the checkout window has
// closed.
//
// This reconciler closes that window on a schedule. It reuses the reviewed,
// pure `releaseAllAnnualClaims` transformation (state FAILED, recomputed
// counters, revision bump) and only adds the scan + compare-and-swap write:
//
//   - a claim is released only after its own `expiresAt`/`paymentExpiresAt`
//     deadline has passed and only while it holds the *current* Moscow daily
//     seat, so a claim inside its checkout window is never touched;
//   - the write is a compare-and-swap on the observed `revision`, so a
//     concurrent runtime settlement wins and the reconciler reports it instead
//     of overwriting it;
//   - dry-run is the default; `--apply` requires `--backup-dir`, and the exact
//     preimage of every ledger that is actually changed is written there first
//     (mode 0600);
//   - a tick that finds nothing to release writes no backup, so a frequent
//     schedule does not leave an empty custody file per tick.
//
// Provider state is deliberately not re-read: for the HUB daily seat the local
// checkout deadline is authoritative (the payment link is dead once it passes),
// which is the exact rule that makes the stale seat releasable without a Viva
// round-trip.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { listAnnualClaims, releaseAllAnnualClaims, RELEASE_REASON } from './lib/annualClaimRelease.mjs';

const require = createRequire(import.meta.url);

const args = process.argv.slice(2);
const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const has = (name) => args.includes(name);
const apply = has('--apply');
const fixturePath = value('--fixture');
const backupDir = value('--backup-dir');
const reportPath = value('--report');
const quiet = has('--quiet');
const databaseName = value('--database') || process.env.SUBSCRIPTIONS_MONGODB_DATABASE || process.env.GAMES_MONGODB_DB || 'games';
const collectionName = value('--collection') || 'lk_tournament_subscription_sales';
const limit = Number(value('--limit') || 50);
const nowIso = value('--now') || new Date().toISOString();
const HUB_COUNTER_KEY = 'network_friendship';
const HUB_DOCUMENT_TYPE = 'HUB_ATOMIC_INVENTORY_LEDGER';

const fail = (message) => { throw new Error(message); };

if (has('--help')) {
  console.log(`Usage:
  node scripts/reconcile_stale_annual_claims.mjs [scan options] [--apply --backup-dir <dir>]

Scan options:
  --mongo-url <uri> | --mongo-url-file <path> | --flows <flows.json>
  --database <name>            default: ${databaseName}
  --collection <name>          default: ${collectionName}
  --limit <n>                  max ledgers per run (default: 50)
  --now <iso>                  evaluate at this instant (default: current time)
  --fixture <path>             offline rehearsal from a captured ledger document

Write options:
  --apply                      perform compare-and-swap releases (default: dry-run)
  --backup-dir <dir>           required with --apply; holds the preimage of every changed ledger

Report:
  --report <path>              write the JSON report to this file (0600)
  --quiet                      print only the summary line`);
  process.exit(0);
}

if (!Number.isSafeInteger(limit) || limit < 1) fail('--limit must be a positive integer');
if (!Number.isFinite(Date.parse(nowIso))) fail('--now must be an ISO timestamp');
if (apply && !backupDir) fail('--backup-dir is required with --apply');
if (apply && fixturePath) fail('--apply cannot be combined with --fixture');
if (!fixturePath && !(value('--mongo-url') || value('--mongo-url-file') || value('--flows')
  || process.env.SUBSCRIPTIONS_MONGODB_URI || process.env.GAMES_MONGODB_URI)) {
  fail('Mongo url is required: pass --mongo-url, --mongo-url-file, --flows, or set SUBSCRIPTIONS_MONGODB_URI');
}

/** Stable, non-reversible ledger label for reports: no inventory, refs or actors leak. */
const ledgerLabel = (value) => crypto.createHash('sha256')
  .update(String(value ?? ''), 'utf8').digest('hex').slice(0, 12);

const redactedClaim = (claim, ledger) => ({
  ledger,
  claim: ledgerLabel(claim.paymentRef),
  state: claim.state,
  deadline: claim.deadline,
  dailyDate: claim.dailyDate,
  releasable: claim.releasable,
  reason: claim.reason ?? 'RELEASABLE',
});

function attachMongoDatabase(url, database) {
  if (!url) return url;
  if (/\/[A-Za-z0-9_-]+(\?|$)/.test(url.replace(/^mongodb(\+srv)?:\/\//, '').split('@').pop() || '')) return url;
  return url.endsWith('/') ? `${url}${database}` : `${url}/${database}`;
}

function readMongoUrlFromFlows(flowsPath, database) {
  const flows = JSON.parse(fs.readFileSync(flowsPath, 'utf8'));
  const node = (Array.isArray(flows) ? flows : []).find((item) => typeof item?.uri === 'string' && item.uri.startsWith('mongodb'));
  if (!node) fail(`No Mongo connection node found in ${flowsPath}`);
  return attachMongoDatabase(node.uri, database);
}

const maskUri = (url) => String(url || '').replace(/\/\/[^@/]*@/, '//***@');

async function loadScan() {
  if (fixturePath) {
    const parsed = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    return { ledgers: Array.isArray(parsed) ? parsed : [parsed], collection: null, close: async () => {}, source: fixturePath };
  }
  const url = value('--mongo-url') || process.env.SUBSCRIPTIONS_MONGODB_URI || process.env.GAMES_MONGODB_URI
    || (value('--mongo-url-file') ? fs.readFileSync(value('--mongo-url-file'), 'utf8').trim() : null)
    || (value('--flows') ? readMongoUrlFromFlows(value('--flows'), databaseName) : null);
  if (!url) fail('Mongo url is required: pass --mongo-url, --mongo-url-file, --flows, or set SUBSCRIPTIONS_MONGODB_URI');
  const mongodb = require(value('--mongodb-module') || 'mongodb');
  const client = new mongodb.MongoClient(attachMongoDatabase(url, databaseName), { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  const collection = client.db(databaseName).collection(collectionName);
  const ledgers = await collection.find({
    counterKey: HUB_COUNTER_KEY,
    documentType: HUB_DOCUMENT_TYPE,
    schemaVersion: 3,
    ready: true,
  }).limit(limit).toArray();
  return { ledgers, collection, close: () => client.close(), source: maskUri(url) };
}

const { ledgers, collection, close, source } = await loadScan();
const report = {
  mode: apply ? 'apply' : 'dry-run',
  source,
  database: databaseName,
  collection: collectionName,
  now: nowIso,
  releaseReason: RELEASE_REASON,
  ledgerCount: ledgers.length,
  scannedClaims: 0,
  releasableClaims: 0,
  plannedReleases: [],
  released: [],
  skipped: [],
  compareAndSwapFailures: [],
  backupPaths: [],
  applied: false,
  reason: null,
};

try {
  const candidates = [];
  const redactedByKey = new Map();
  for (const ledger of ledgers) {
    if (!ledger || typeof ledger !== 'object') continue;
    const label = ledgerLabel(ledger._id);
    const decisions = listAnnualClaims(ledger, { now: nowIso });
    report.scannedClaims += decisions.length;
    const releasable = decisions.filter((item) => item.releasable);
    report.releasableClaims += releasable.length;
    for (const decision of decisions) {
      const entry = redactedClaim(decision, label);
      redactedByKey.set(`${label}:${decision.paymentRef}`, entry);
      if (decision.releasable) report.plannedReleases.push(entry);
      else report.skipped.push(entry);
    }
    if (releasable.length) candidates.push(ledger);
  }

  if (!apply) {
    // Dry-run reports what a tick would release, without writing anything.
    report.released = report.plannedReleases;
    report.reason = candidates.length ? 'DRY_RUN_RELEASABLE' : 'NOTHING_TO_RELEASE';
  } else if (!candidates.length) {
    report.reason = 'NOTHING_TO_RELEASE';
  } else {
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    const appliedReleases = [];
    for (const ledger of candidates) {
      const label = ledgerLabel(ledger._id);
      const outcome = releaseAllAnnualClaims(ledger, { now: nowIso });
      if (!outcome.ok) fail(`Release failed for ledger ${label}: ${outcome.code} (${outcome.message})`);
      if (!outcome.released.length) continue;
      const stamp = nowIso.replace(/[:.]/g, '-');
      const backupPath = path.join(backupDir, `stale-annual-claims-${label}-${stamp}.json`);
      fs.writeFileSync(backupPath, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      report.backupPaths.push(backupPath);

      const next = outcome.next;
      const result = await collection.updateOne({ _id: ledger._id, revision: ledger.revision }, { $set: {
        reservations: next.reservations,
        revision: next.revision,
        updatedAt: next.updatedAt,
        paidCount: next.paidCount,
        reservedCount: next.reservedCount,
        takenCount: next.takenCount,
        dailyPaidCount: next.dailyPaidCount,
        dailyReservedCount: next.dailyReservedCount,
        dailyBaselinePaidCount: next.dailyBaselinePaidCount,
      } });
      const matched = result.matchedCount ?? result.result?.n ?? 0;
      const modified = result.modifiedCount ?? result.result?.nModified ?? 0;
      if (matched !== 1 || modified !== 1) {
        report.compareAndSwapFailures.push(label);
        continue;
      }
      report.applied = true;
      // `released` reflects what the compare-and-swap actually committed; a
      // failed swap is reported in compareAndSwapFailures and never here.
      for (const item of outcome.released) {
        appliedReleases.push({ ledger: label, claim: ledgerLabel(item.paymentRef), deadline: item.deadline,
          before: item.before, after: item.after });
        const entry = redactedByKey.get(`${label}:${item.paymentRef}`);
        if (entry) report.released.push(entry);
      }
    }
    report.reason = report.applied ? 'RELEASED' : 'NOTHING_TO_RELEASE';
    report.appliedReleases = appliedReleases;
  }

  if (reportPath) {
    fs.mkdirSync(path.dirname(path.resolve(reportPath)), { recursive: true });
    fs.writeFileSync(path.resolve(reportPath), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  }
  if (quiet) {
    console.log(JSON.stringify({ mode: report.mode, ledgers: report.ledgerCount,
      scannedClaims: report.scannedClaims, releasableClaims: report.releasableClaims,
      applied: report.applied, reason: report.reason,
      compareAndSwapFailures: report.compareAndSwapFailures.length }));
  } else {
    console.log(JSON.stringify(report, null, 2));
  }
  if (report.compareAndSwapFailures.length) {
    console.error(`compare-and-swap failed for ${report.compareAndSwapFailures.length} ledger(s); nothing was overwritten`);
    process.exitCode = 2;
  }
} finally {
  await close();
}
