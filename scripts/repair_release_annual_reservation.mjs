#!/usr/bin/env node

// Guarded repair: release one stale annual reservation that holds a bounded
// daily seat while the provider still reports a non-terminal state.
//
// This is a deliberate, reviewed data repair. It never touches Viva, never
// changes the provider transaction and never widens a quota. It only moves the
// named reservation to the terminal FAILED state that the ledger schema already
// allows, then recomputes the derived counters with the same library the runtime
// uses, so the document stays valid.
//
// Dry-run by default; writing requires --apply. A backup of the exact original
// document is written before the update, and the update itself is a compare-and-
// swap on the observed revision.

import fs from 'node:fs';
import path from 'node:path';
// The production host still ships the CommonJS mongodb v3 package, so the
// named ESM import is not available there.
import mongodbDriver from 'mongodb';
const { MongoClient } = mongodbDriver;
import { annualHistory } from './lib/annualSubscriptionHistory.mjs';

const args = process.argv.slice(2);
const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const apply = args.includes('--apply');
const inventoryId = value('--inventory');
const paymentRef = value('--payment-ref');
const backupDir = value('--backup-dir');
const collectionName = value('--collection') || 'lk_tournament_subscription_sales';
const mongoUrl = value('--mongo-url') || process.env.SUBSCRIPTIONS_MONGODB_URI || process.env.GAMES_MONGODB_URI;
const databaseName = value('--database') || process.env.SUBSCRIPTIONS_MONGODB_DATABASE || process.env.GAMES_MONGODB_DB || 'games';
const nowIso = value('--now') || new Date().toISOString();

const fail = (message) => { throw new Error(message); };
if (!inventoryId || !paymentRef) fail('Usage: --inventory <id> --payment-ref <ref> [--backup-dir <dir>] [--apply]');
if (!mongoUrl) fail('Mongo url is required');
if (apply && !backupDir) fail('--backup-dir is required with --apply');

const ledgerId = `inventory:${inventoryId}`;
const moscowDate = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date(iso));
const client = new MongoClient(mongoUrl, { serverSelectionTimeoutMS: 10000 });

try {
  await client.connect();
  const collection = client.db(databaseName).collection(collectionName);
  const ledger = await collection.findOne({ _id: ledgerId });
  if (!ledger) fail(`Ledger not found: ${ledgerId}`);
  if (ledger.counterKey !== 'network_friendship') fail(`Unexpected counterKey: ${ledger.counterKey}`);
  if (ledger.schemaVersion !== 3 || ledger.ready !== true) fail('Ledger is not a ready schemaVersion 3 document');
  if (!annualHistory.validate(ledger)) fail('Ledger fails its own validation before the repair');

  const matches = ledger.reservations.filter((item) => item.paymentRef === paymentRef);
  if (matches.length !== 1) fail(`Expected exactly one reservation for ${paymentRef}, found ${matches.length}`);
  const reservation = matches[0];
  const activeStates = ['CLAIMED', 'DISPATCHING', 'PAYMENT_PENDING', 'PROVIDER_UNKNOWN'];
  if (!activeStates.includes(reservation.state)) fail(`Reservation is not active: ${reservation.state}`);
  const deadline = [reservation.expiresAt, reservation.paymentExpiresAt]
    .map((item) => (item ? Date.parse(item) : null)).filter((item) => item !== null);
  if (!deadline.length || Math.max(...deadline) > Date.parse(nowIso)) fail('Reservation deadline has not passed');
  if (reservation.dailyDate !== moscowDate(nowIso) || ledger.dailyDate !== moscowDate(nowIso)) {
    fail('Reservation is not for the current Moscow daily seat');
  }

  const next = JSON.parse(JSON.stringify(ledger));
  const target = next.reservations.find((item) => item.paymentRef === paymentRef);
  target.state = 'FAILED';
  target.releasedAt = nowIso;
  target.releaseReason = 'REPAIR_STALE_LOCAL_RESERVATION_PROVIDER_NON_TERMINAL';
  next.revision = ledger.revision + 1;
  next.updatedAt = nowIso;
  Object.assign(next, annualHistory.counts(next, next.dailyDate));
  if (!annualHistory.validate(next)) fail('Repaired ledger fails validation');

  const before = { paidCount: ledger.paidCount, reservedCount: ledger.reservedCount,
    dailyPaidCount: ledger.dailyPaidCount, dailyReservedCount: ledger.dailyReservedCount, revision: ledger.revision };
  const after = { paidCount: next.paidCount, reservedCount: next.reservedCount,
    dailyPaidCount: next.dailyPaidCount, dailyReservedCount: next.dailyReservedCount, revision: next.revision };
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', ledgerId, paymentRef,
    reservationStateBefore: reservation.state, reservationStateAfter: target.state,
    deadline: new Date(Math.max(...deadline)).toISOString(), now: nowIso, before, after, productionTouched: apply }, null, 2));

  if (!apply) {
    console.log('dry-run only; re-run with --apply --backup-dir <dir> to write');
  } else {
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    const stamp = nowIso.replace(/[:.]/g, '-');
    const backupPath = path.join(backupDir, `${ledgerId.replace(/[:/]/g, '_')}-${stamp}.json`);
    fs.writeFileSync(backupPath, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    fs.writeFileSync(path.join(backupDir, `backup-path-${stamp}.txt`), `${backupPath}\n`, { mode: 0o600, flag: 'wx' });
    const result = await collection.updateOne({ _id: ledgerId, revision: ledger.revision }, { $set: {
      reservations: next.reservations, revision: next.revision, updatedAt: next.updatedAt,
      paidCount: next.paidCount, reservedCount: next.reservedCount, takenCount: next.takenCount,
      dailyPaidCount: next.dailyPaidCount, dailyReservedCount: next.dailyReservedCount,
      dailyBaselinePaidCount: next.dailyBaselinePaidCount,
    } });
    const matched = result.matchedCount ?? result.result?.n ?? 0;
    const modified = result.modifiedCount ?? result.result?.nModified ?? 0;
    if (matched !== 1 || modified !== 1) fail('Compare-and-swap on revision failed; nothing written');
    console.log(JSON.stringify({ applied: true, backupPath, revision: next.revision }));
  }
} finally {
  await client.close();
}
