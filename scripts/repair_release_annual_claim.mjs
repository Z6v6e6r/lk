#!/usr/bin/env node

// Guarded repair: release stale annual HUB reservations that hold a bounded
// daily seat while the provider still reports a non-terminal state.
//
// This is a deliberate, reviewed data repair. It never touches Viva, never
// changes a provider transaction and never widens a quota. It only moves the
// named reservation to the terminal FAILED state that the ledger schema already
// allows, then recomputes the derived counters with the same library the runtime
// uses, so the document stays valid.
//
// Dry-run by default. Writing requires --apply and a --backup-dir: a backup of
// the exact original document is written before the update, and the update
// itself is a compare-and-swap on the observed revision.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { listAnnualClaims, releaseAnnualClaim, RELEASE_REASON } from './lib/annualClaimRelease.mjs';

const require = createRequire(import.meta.url);

const args = process.argv.slice(2);
const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const has = (name) => args.includes(name);
const apply = has('--apply');
const fixturePath = value('--fixture');
const inventoryId = value('--inventory');
const paymentRef = value('--payment-ref');
const backupDir = value('--backup-dir');
const collectionName = value('--collection') || 'lk_tournament_subscription_sales';
const databaseName = value('--database') || process.env.SUBSCRIPTIONS_MONGODB_DATABASE || process.env.GAMES_MONGODB_DB || 'games';
const mongoUrl = value('--mongo-url') || process.env.SUBSCRIPTIONS_MONGODB_URI || process.env.GAMES_MONGODB_URI;
const nowIso = value('--now') || new Date().toISOString();

const fail = (message) => { throw new Error(message); };
if (!has('--help') && !fixturePath && !inventoryId) fail('Usage: --inventory <id> [--payment-ref <ref>] [--apply --backup-dir <dir>] | --fixture <ledger.json>');
if (apply && !backupDir) fail('--backup-dir is required with --apply');
if (apply && fixturePath) fail('--apply cannot be combined with --fixture');

const ledgerId = fixturePath ? null : `inventory:${inventoryId}`;

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

async function loadLedger() {
  if (fixturePath) {
    const ledger = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    return { ledger, collection: null, close: async () => {} };
  }
  const url = mongoUrl || (value('--mongo-url-file') ? fs.readFileSync(value('--mongo-url-file'), 'utf8').trim() : null)
    || (value('--flows') ? readMongoUrlFromFlows(value('--flows'), databaseName) : null);
  if (!url) fail('Mongo url is required: pass --mongo-url, --mongo-url-file, --flows, or set SUBSCRIPTIONS_MONGODB_URI');
  const mongodb = require(value('--mongodb-module') || 'mongodb');
  const client = new mongodb.MongoClient(attachMongoDatabase(url, databaseName), { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  const collection = client.db(databaseName).collection(collectionName);
  const ledger = await collection.findOne({ _id: ledgerId });
  if (!ledger) fail(`Ledger not found: ${ledgerId}`);
  return { ledger, collection, close: () => client.close() };
}

const { ledger, collection, close } = await loadLedger();
try {
  const decisions = listAnnualClaims(ledger, { now: nowIso });
  const releasable = decisions.filter((item) => item.releasable);

  if (!apply) {
    console.log(JSON.stringify({
      mode: 'dry-run', ledgerId: ledgerId || fixturePath, counterKey: ledger.counterKey,
      revision: ledger.revision, ready: ledger.ready, schemaVersion: ledger.schemaVersion,
      dailyDate: ledger.dailyDate, now: nowIso, reservedCount: ledger.reservedCount,
      claims: decisions,
      releasable: releasable.map((item) => item.paymentRef),
    }, null, 2));
    if (!releasable.length) console.log('nothing to release; no write performed');
    else console.log(`re-run with --apply --backup-dir <dir>${paymentRef ? '' : ' [--payment-ref <ref>]'} to release`);
    if (!paymentRef && releasable.length) console.log('note: without --payment-ref every releasable claim in this ledger is released');
  } else {
    const targets = paymentRef ? releasable.filter((item) => item.paymentRef === paymentRef) : releasable;
    if (!targets.length) {
      console.log(JSON.stringify({ mode: 'apply', applied: false, reason: paymentRef ? 'CLAIM_NOT_RELEASABLE' : 'NOTHING_TO_RELEASE' }));
    } else {
      let working = ledger;
      const released = [];
      for (const target of targets) {
        const outcome = releaseAnnualClaim(working, { paymentRef: target.paymentRef, now: nowIso });
        if (!outcome.ok) fail(`Release failed for ${target.paymentRef}: ${outcome.code} (${outcome.message})`);
        working = outcome.next;
        released.push({ paymentRef: target.paymentRef, deadline: outcome.deadline, before: outcome.before, after: outcome.after });
      }

      fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
      const stamp = nowIso.replace(/[:.]/g, '-');
      const backupPath = path.join(backupDir, `${String(ledgerId).replace(/[:/]/g, '_')}-${stamp}.json`);
      fs.writeFileSync(backupPath, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      fs.writeFileSync(path.join(backupDir, `backup-path-${stamp}.txt`), `${backupPath}\n`, { mode: 0o600, flag: 'wx' });

      const result = await collection.updateOne({ _id: ledgerId, revision: ledger.revision }, { $set: {
        reservations: working.reservations, revision: working.revision, updatedAt: working.updatedAt,
        paidCount: working.paidCount, reservedCount: working.reservedCount, takenCount: working.takenCount,
        dailyPaidCount: working.dailyPaidCount, dailyReservedCount: working.dailyReservedCount,
        dailyBaselinePaidCount: working.dailyBaselinePaidCount,
      } });
      const matched = result.matchedCount ?? result.result?.n ?? 0;
      const modified = result.modifiedCount ?? result.result?.nModified ?? 0;
      if (matched !== 1 || modified !== 1) fail('Compare-and-swap on revision failed; nothing written');
      console.log(JSON.stringify({
        mode: 'apply', applied: true, ledgerId, reason: RELEASE_REASON, backupPath,
        revisionBefore: ledger.revision, revisionAfter: working.revision, released,
      }, null, 2));
    }
  }
} finally {
  await close();
}
