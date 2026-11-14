#!/usr/bin/env node

// Read-only audit: subscription holds that still consume an allowance while Viva no
// longer holds their booking ("dead holds"), and the daily-visit guards they block.
//
// This script has no write mode. It reads `lk_subscription_daily_booking_ops` through a
// collection proxy that only exposes find/count, reads Viva only with GET, and writes
// nothing except the optional 0600 report file. Reports carry counts and 12-character
// hash labels, never actor, phone, subscription or booking identifiers.
//
// Usage:
//   node scripts/audit_subscription_holds.mjs --fixture <snapshot.json> [--now <iso>]
//   node scripts/audit_subscription_holds.mjs --mongo-url-file <path> --token-file <path> \
//     [--days-back 7] [--days-ahead 60] [--max-exercises 300] [--report <path>]

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  DAILY_VISIT_GUARD_KIND,
  HOLDING_STATES,
  moscowDate,
  readOnlyCollection,
  summarizeSubscriptionHolds,
} from './lib/subscriptionHoldAudit.mjs';

const require = createRequire(import.meta.url);

const VALUE_FLAGS = new Set(['--fixture', '--now', '--mongo-url-file', '--flows', '--database', '--collection',
  '--tenant', '--token-file', '--viva-base', '--days-back', '--days-ahead', '--max-exercises',
  '--request-gap-ms', '--report', '--mongodb-module']);
const BOOLEAN_FLAGS = new Set(['--quiet', '--help']);

export function parseAuditArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (BOOLEAN_FLAGS.has(key)) { out[key] = true; continue; }
    if (!VALUE_FLAGS.has(key)) throw new Error(`UNKNOWN_ARGUMENT ${key} (this audit has no write mode)`);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--') || out[key] !== undefined) throw new Error(`ARGUMENT_INVALID ${key}`);
    out[key] = next;
    i += 1;
  }
  const integer = (key, fallback, min, max) => {
    const value = out[key] === undefined ? fallback : Number(out[key]);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`ARGUMENT_INVALID ${key}`);
    return value;
  };
  const now = out['--now'] ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(now))) throw new Error('ARGUMENT_INVALID --now');
  if (!out['--fixture'] && !out['--mongo-url-file'] && !out['--flows']) {
    throw new Error('ARGUMENT_REQUIRED --fixture | --mongo-url-file | --flows');
  }
  return {
    fixture: out['--fixture'] ?? null,
    now,
    mongoUrlFile: out['--mongo-url-file'] ?? null,
    flows: out['--flows'] ?? null,
    database: out['--database'] ?? 'games',
    collection: out['--collection'] ?? 'lk_subscription_daily_booking_ops',
    tenant: out['--tenant'] ?? null,
    tokenFile: out['--token-file'] ?? null,
    vivaBase: out['--viva-base'] ?? 'https://api.vivacrm.ru',
    daysBack: integer('--days-back', 7, 0, 120),
    daysAhead: integer('--days-ahead', 60, 0, 365),
    maxExercises: integer('--max-exercises', 300, 1, 5000),
    requestGapMs: integer('--request-gap-ms', 150, 0, 10000),
    report: out['--report'] ?? null,
    mongodbModule: out['--mongodb-module'] ?? 'mongodb',
    quiet: Boolean(out['--quiet']),
    help: Boolean(out['--help']),
  };
}

/** Stable, non-reversible label: the same operation gets the same label in every report. */
export const auditLabel = value => crypto.createHash('sha256').update(String(value ?? ''), 'utf8')
  .digest('hex').slice(0, 12);

const shiftDate = (date, days) => new Date(Date.parse(`${date}T00:00:00.000Z`) + days * 86400000)
  .toISOString().slice(0, 10);

export function auditWindow({ now, daysBack, daysAhead }) {
  const today = moscowDate(now);
  return { from: shiftDate(today, -daysBack), to: shiftDate(today, daysAhead), today };
}

// Same URL handling as reconcile_hung_subscription_claims.mjs, so the audit
// authenticates against exactly the database the scheduled reconciler uses.
function attachMongoDatabase(url, database) {
  if (!url) return url;
  if (/\/[A-Za-z0-9_-]+(\?|$)/.test(url.replace(/^mongodb(\+srv)?:\/\//, '').split('@').pop() || '')) return url;
  return url.endsWith('/') ? `${url}${database}` : `${url}/${database}`;
}

function readMongoUrl(options) {
  if (options.mongoUrlFile) return attachMongoDatabase(fs.readFileSync(options.mongoUrlFile, 'utf8').trim(), options.database);
  const flows = JSON.parse(fs.readFileSync(options.flows, 'utf8'));
  const node = (Array.isArray(flows) ? flows : []).find(item => typeof item?.uri === 'string' && item.uri.startsWith('mongodb'));
  if (!node) throw new Error('MONGO_NODE_NOT_FOUND');
  return attachMongoDatabase(node.uri, options.database);
}

const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms); });

async function readExerciseBookings({ vivaBase, token, exerciseId }) {
  try {
    const response = await fetch(`${vivaBase}/api/v1/exercises/${encodeURIComponent(exerciseId)}/bookings?showCancelled=true&size=200`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
      redirect: 'error',
    });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

async function loadLive(options, window) {
  const mongodb = require(options.mongodbModule);
  // Options limited to those the installed driver (3.x on the server) and 4.x share.
  const client = new mongodb.MongoClient(readMongoUrl(options), {
    serverSelectionTimeoutMS: 10000, readPreference: 'secondaryPreferred',
  });
  await client.connect();
  try {
    const collection = readOnlyCollection(client.db(options.database).collection(options.collection));
    const dateRange = { $gte: window.from, $lte: window.to };
    const scope = options.tenant ? { tenantKey: options.tenant } : {};
    const operations = await collection.find({ ...scope, state: { $in: [...HOLDING_STATES] }, serviceDate: dateRange },
      { maxTimeMS: 30000 }).toArray();
    const guards = await collection.find({ ...scope, kind: DAILY_VISIT_GUARD_KIND, serviceDate: dateRange },
      { maxTimeMS: 30000 }).toArray();
    const token = options.tokenFile ? fs.readFileSync(options.tokenFile, 'utf8').trim() : null;
    const bookingsByExercise = new Map();
    // Bound exercises only: an unbound claim needs no provider read for this verdict.
    const exerciseIds = [...new Set(operations
      .filter(operation => operation?.bookingId || operation?.upstreamBookingId)
      .map(operation => String(operation?.exerciseId ?? '').trim().toLowerCase()).filter(Boolean))];
    const selected = exerciseIds.slice(0, options.maxExercises);
    if (token) {
      for (const exerciseId of selected) {
        bookingsByExercise.set(exerciseId, await readExerciseBookings({ vivaBase: options.vivaBase, token, exerciseId }));
        if (options.requestGapMs) await sleep(options.requestGapMs);
      }
    }
    return {
      operations, guards, bookingsByExercise,
      provider: { token: Boolean(token), exercises: exerciseIds.length, read: token ? selected.length : 0,
        truncated: exerciseIds.length > selected.length },
    };
  } finally {
    await client.close();
  }
}

function loadFixture(options) {
  const fixture = JSON.parse(fs.readFileSync(options.fixture, 'utf8'));
  const bookingsByExercise = new Map(Object.entries(fixture.bookingsByExercise ?? {})
    .map(([key, value]) => [String(key).toLowerCase(), value]));
  return { operations: fixture.operations ?? [], guards: fixture.guards ?? [], bookingsByExercise,
    provider: { token: true, exercises: bookingsByExercise.size, read: bookingsByExercise.size, truncated: false } };
}

export async function runSubscriptionHoldAudit(options) {
  const window = auditWindow(options);
  const loaded = options.fixture ? loadFixture(options) : await loadLive(options, window);
  const { summary, deadHolds } = summarizeSubscriptionHolds({ ...loaded, now: options.now, labelOf: auditLabel });
  return {
    mode: 'read-only-audit',
    source: options.fixture ? 'fixture' : 'live',
    now: options.now,
    window,
    provider: loaded.provider,
    summary,
    deadHolds,
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const options = parseAuditArgs(process.argv.slice(2));
  if (options.help) {
    console.log('See the header of scripts/audit_subscription_holds.mjs. This audit never writes.');
    process.exit(0);
  }
  const report = await runSubscriptionHoldAudit(options);
  if (options.report) {
    fs.writeFileSync(path.resolve(options.report), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  }
  console.log(JSON.stringify(options.quiet ? { window: report.window, provider: report.provider, summary: report.summary } : report, null, 2));
}
