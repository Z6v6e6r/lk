#!/usr/bin/env node

// Reconciler for hung subscription booking claims.
//
// It releases claims in `lk_subscription_daily_booking_ops` that stayed
// non-terminal long after their own deadline (or after the configured TTL measured
// from their last write) while the provider reports no active booking for that
// actor and subscription instance. Releasing the claim returns the daily seat and
// the consumed free minutes that the claim was holding, so the player can use the
// subscription again.
//
// Dry-run by default. Writing requires --apply and a --backup-dir: the exact
// scanned documents are written to a 0600 backup before any update, and every
// update is a compare-and-swap on the observed state and write time.
//
// A claim is never released without a complete provider readback for its exercise.
// Missing, partial or failed provider evidence keeps the claim untouched.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import {
  DEFAULT_HUNG_CLAIM_TTL_MS,
  HUNG_CLAIM_STATES,
  AUDIT_ONLY_CLAIM_STATES,
  buildHungClaimReleaseCommand,
  hasCreateAttempt,
  planHungClaimRelease,
  summarizeHungClaims,
} from './lib/hungClaimRelease.mjs';

const require = createRequire(import.meta.url);

const args = process.argv.slice(2);
const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const has = (name) => args.includes(name);

if (has('--help')) {
  console.log(`Usage:
  node scripts/reconcile_hung_subscription_claims.mjs [scan options] [--apply --backup-dir <dir>]

Scan options:
  --mongo-url <uri> | --mongo-url-file <path> | --flows <flows.json>
  --database <name>            default: games
  --collection <name>          default: lk_subscription_daily_booking_ops
  --tenant <tenantKey>         restrict to one tenant (e.g. iSkq6G)
  --actor <padlhub uuid>       restrict to one actor
  --subscription <uuid>        restrict to one subscription instance
  --ttl-minutes <n>            hung-claim TTL when the claim declares no deadline (default: ${DEFAULT_HUNG_CLAIM_TTL_MS / 60000})
  --limit <n>                  max claims per run (default: 200)
  --sort <oldest|newest>       which claims a bounded run scans first (default: oldest)
  --now <iso>                  evaluate at this instant (default: current time)
  --fixture <path>             offline rehearsal from a captured { operations, bookingsByExercise } snapshot

Provider verification (required for any release):
  --viva-base <url>            default: https://api.vivacrm.ru
  --token-file <path> | --viva-token <token>

Report:
  --report <path>              write the JSON report to this file (0600)
  --quiet                      print only the summary line`);
  process.exit(0);
}

const apply = has('--apply');
const fixturePath = value('--fixture');
const backupDir = value('--backup-dir');
const reportPath = value('--report');
const quiet = has('--quiet');
const databaseName = value('--database') || process.env.GAMES_MONGODB_DB || 'games';
const collectionName = value('--collection') || 'lk_subscription_daily_booking_ops';
const tenantKey = value('--tenant');
const actorClientId = value('--actor');
const clientSubscriptionId = value('--subscription');
const limit = Number(value('--limit') || 200);
const sortOrder = value('--sort') || 'oldest';
const ttlMinutes = Number(value('--ttl-minutes') || DEFAULT_HUNG_CLAIM_TTL_MS / 60000);
const nowIso = value('--now') || new Date().toISOString();
const vivaBase = value('--viva-base') || process.env.VIVA_API_BASE || 'https://api.vivacrm.ru';
const tokenFile = value('--token-file') || process.env.VIVA_ADMIN_TOKEN_FILE;
const inlineToken = value('--viva-token') || process.env.VIVA_ADMIN_TOKEN;

const fail = (message) => { throw new Error(message); };
const ttlMs = Number.isFinite(ttlMinutes) && ttlMinutes > 0 ? ttlMinutes * 60000 : fail('--ttl-minutes must be a positive number');
if (!Number.isSafeInteger(limit) || limit < 1) fail('--limit must be a positive integer');
if (!['oldest', 'newest'].includes(sortOrder)) fail('--sort must be oldest or newest');
if (apply && !backupDir) fail('--backup-dir is required with --apply');
if (apply && fixturePath) fail('--apply cannot be combined with --fixture');
if (!Number.isFinite(Date.parse(nowIso))) fail('--now must be an ISO timestamp');

/** Stable, non-reversible claim label for reports: no actor, phone or subscription leaks. */
const claimLabel = (operation) => crypto.createHash('sha256')
  .update(String(operation?._id ?? ''), 'utf8').digest('hex').slice(0, 12);

const redactedDecision = (operation, decision) => ({
  claim: claimLabel(operation),
  state: decision.state,
  serviceDate: decision.serviceDate,
  deadline: decision.deadline,
  releasable: decision.releasable,
  reason: decision.reason ?? 'RELEASABLE',
  // Reported regardless of the deciding reason: a create attempt is the operator's
  // manual-reconciliation signal even when a booking id already binds the claim.
  createAttempt: hasCreateAttempt(operation),
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

async function providerToken() {
  if (inlineToken) return inlineToken;
  if (tokenFile) return fs.readFileSync(tokenFile, 'utf8').trim();
  return null;
}

const bookingCache = new Map();
async function readExerciseBookings(exerciseId, token) {
  const key = String(exerciseId || '').toLowerCase();
  if (bookingCache.has(key)) return bookingCache.get(key);
  // The raw payload is cached, not just its rows: the release decision needs the
  // page envelope to prove the list is complete.
  let payload = null;
  try {
    const response = await fetch(`${vivaBase}/api/v1/exercises/${encodeURIComponent(exerciseId)}/bookings?showCancelled=true&size=200`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
      redirect: 'error',
    });
    if (response.ok) payload = await response.json();
  } catch {
    payload = null;
  }
  bookingCache.set(key, payload);
  return payload;
}

async function loadScan() {
  if (fixturePath) {
    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    const map = new Map(Object.entries(fixture.bookingsByExercise || {})
      .map(([key, value]) => [String(key).toLowerCase(), value]));
    return {
      operations: Array.isArray(fixture.operations) ? fixture.operations : [],
      bookingsByExercise: map,
      collection: null,
      close: async () => {},
      source: fixturePath,
    };
  }
  const url = value('--mongo-url') || process.env.SUBSCRIPTIONS_MONGODB_URI || process.env.GAMES_MONGODB_URI
    || (value('--mongo-url-file') ? fs.readFileSync(value('--mongo-url-file'), 'utf8').trim() : null)
    || (value('--flows') ? readMongoUrlFromFlows(value('--flows'), databaseName) : null);
  if (!url) fail('Mongo url is required: pass --mongo-url, --mongo-url-file, --flows, or set GAMES_MONGODB_URI');
  const mongodb = require(value('--mongodb-module') || 'mongodb');
  const client = new mongodb.MongoClient(attachMongoDatabase(url, databaseName), { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  const collection = client.db(databaseName).collection(collectionName);
  const nowTs = Date.parse(nowIso);
  const query = { state: { $in: [...HUNG_CLAIM_STATES, ...AUDIT_ONLY_CLAIM_STATES] }, updatedAt: { $lte: new Date(nowTs - ttlMs).toISOString() } };
  if (tenantKey) query.tenantKey = tenantKey;
  if (actorClientId) query.actorClientId = actorClientId;
  if (clientSubscriptionId) query.clientSubscriptionId = clientSubscriptionId;
  const operations = await collection.find(query)
    .sort({ updatedAt: sortOrder === 'newest' ? -1 : 1 })
    .limit(limit)
    .toArray();
  const token = await providerToken();
  if (token) {
    for (const exerciseId of new Set(operations.map((operation) => String(operation?.exerciseId || '')).filter(Boolean))) {
      await readExerciseBookings(exerciseId, token);
    }
  }
  return { operations, bookingsByExercise: bookingCache, collection, close: () => client.close(), source: maskUri(url) };
}

const { operations, bookingsByExercise, collection, close, source } = await loadScan();
const providerReady = Boolean(fixturePath) || Boolean(await providerToken());
if (apply && !fixturePath && !providerReady) {
  fail('--apply requires a provider token: pass --token-file or --viva-token');
}
const report = {
  mode: apply ? 'apply' : 'dry-run',
  source,
  database: databaseName,
  collection: collectionName,
  now: nowIso,
  ttlMinutes,
  providerVerification: providerReady ? 'PERFORMED' : 'TOKEN_MISSING',
  applied: null,
  reason: null,
  scanned: 0,
  released: [],
  skipped: [],
  compareAndSwapFailures: [],
  backupPath: null,
};
try {
  const summary = summarizeHungClaims({
    operations,
    bookingsByExercise: bookingsByExercise,
    now: nowIso,
    ttlMs,
  });
  report.scanned = summary.total;
  report.byReason = summary.byReason;

  if (!apply) {
    report.decisions = operations.map((operation, index) => redactedDecision(operation, summary.decisions[index]));
    report.releasable = report.decisions.filter((item) => item.releasable).map((item) => item.claim);
  } else {
    const releasable = summary.releasable;
    const releasableLabels = new Set(releasable.map((decision) => claimLabel({ _id: decision.operationKey })));
    const toWrite = operations.filter((operation) => releasableLabels.has(claimLabel(operation)));
    // A scheduled run usually finds nothing to release; it must not leave an empty
    // backup behind on every tick.
    if (!toWrite.length) {
      report.applied = false;
      report.reason = 'NOTHING_TO_RELEASE';
    } else {
      fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
      const stamp = nowIso.replace(/[:.]/g, '-');
      const backupPath = path.join(backupDir, `hung-claims-${stamp}.json`);
      fs.writeFileSync(backupPath, `${JSON.stringify(toWrite, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      report.backupPath = backupPath;
      report.applied = true;

      for (const operation of toWrite) {
        const decision = planHungClaimRelease({
          operation,
          bookings: bookingsByExercise.get(String(operation?.exerciseId || '').toLowerCase()),
          now: nowIso,
          ttlMs,
        });
        if (!decision.releasable) {
          report.skipped.push(redactedDecision(operation, decision));
          continue;
        }
        const command = buildHungClaimReleaseCommand({ operation, now: nowIso });
        const result = await collection.updateOne(command.query, command.update, command.options);
        const matched = result.matchedCount ?? result.result?.n ?? 0;
        const modified = result.modifiedCount ?? result.result?.nModified ?? 0;
        if (matched !== 1 || modified !== 1) {
          report.compareAndSwapFailures.push(claimLabel(operation));
          continue;
        }
        report.released.push(redactedDecision(operation, decision));
      }
    }
  }

  if (reportPath) {
    fs.mkdirSync(path.dirname(path.resolve(reportPath)), { recursive: true });
    fs.writeFileSync(path.resolve(reportPath), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  }
  if (quiet) {
    console.log(JSON.stringify({ mode: report.mode, scanned: report.scanned, byReason: report.byReason,
      released: report.released.length, compareAndSwapFailures: report.compareAndSwapFailures.length }));
  } else {
    console.log(JSON.stringify(report, null, 2));
  }
  if (report.compareAndSwapFailures.length) {
    console.error(`compare-and-swap failed for ${report.compareAndSwapFailures.length} claim(s); nothing was overwritten`);
    process.exitCode = 2;
  }
} finally {
  await close();
}
