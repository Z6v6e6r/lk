#!/usr/bin/env node

// One-off release of dead subscription holds (ADR 0004, stage 3). See
// scripts/lib/deadHoldRelease.mjs for the rule.
//
// Modes:
//   plan (default)  read Mongo and Viva (GET only), print counts and the plan digest.
//   --apply         recompute the plan, refuse unless it equals --approved-plan-digest,
//                   write a 0600 backup of every target document, then release each
//                   target in its own transaction (operation CAS + guard CAS delete).
//   --restore <backup.json>  put back operations still carrying exactly this release and
//                   recreate their guards when no guard exists for that day.
//
// Output carries counts and 12-character hash labels, never actor, subscription or
// booking identifiers. The backup holds the full documents and stays on the server.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  buildDeadHoldReleaseCommands, buildDeadHoldRestoreCommands, dailyVisitGuardKey,
  deadHoldPlanDigest, inFlightReason, IN_FLIGHT_JOB_KINDS, planDeadHoldRelease, TERMINAL_JOB_PHASES, WRITE_OPTIONS,
} from './lib/deadHoldRelease.mjs';
import { moscowDate } from './lib/subscriptionHoldAudit.mjs';

const require = createRequire(import.meta.url);
const VALUE_FLAGS = new Set(['--flows', '--mongo-url', '--database', '--collection', '--token-file', '--viva-base',
  '--days-ahead', '--request-gap-ms', '--backup-dir', '--approved-plan-digest', '--restore', '--now',
  '--mongodb-module', '--max-targets', '--quiet-minutes', '--report']);
const BOOLEAN_FLAGS = new Set(['--apply', '--scheduled']);

export function parseReleaseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (BOOLEAN_FLAGS.has(key)) { out[key] = true; continue; }
    if (!VALUE_FLAGS.has(key)) throw new Error(`UNKNOWN_ARGUMENT ${key}`);
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
  if (!out['--flows'] && !out['--mongo-url']) throw new Error('ARGUMENT_REQUIRED --flows | --mongo-url');
  const apply = Boolean(out['--apply']);
  const restore = out['--restore'] ?? null;
  const scheduled = Boolean(out['--scheduled']);
  if (apply && restore) throw new Error('ARGUMENT_INVALID --apply with --restore');
  if (scheduled && (apply || restore || out['--approved-plan-digest'])) throw new Error('ARGUMENT_INVALID --scheduled is its own mode');
  if (scheduled && (!out['--backup-dir'] || !out['--report'])) throw new Error('ARGUMENT_REQUIRED --scheduled needs --backup-dir and --report');
  if (apply && (!out['--backup-dir'] || !/^[a-f0-9]{64}$/.test(out['--approved-plan-digest'] ?? ''))) {
    throw new Error('ARGUMENT_REQUIRED --apply needs --backup-dir and --approved-plan-digest');
  }
  if (!restore && !out['--token-file']) throw new Error('ARGUMENT_REQUIRED --token-file');
  const now = out['--now'] ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(now))) throw new Error('ARGUMENT_INVALID --now');
  return {
    flows: out['--flows'] ?? null,
    mongoUrl: out['--mongo-url'] ?? null,
    database: out['--database'] ?? 'games',
    collection: out['--collection'] ?? 'lk_subscription_daily_booking_ops',
    tokenFile: out['--token-file'] ?? null,
    vivaBase: out['--viva-base'] ?? 'https://api.vivacrm.ru',
    daysAhead: integer('--days-ahead', 14, 0, 60),
    requestGapMs: integer('--request-gap-ms', 150, 0, 10000),
    maxTargets: integer('--max-targets', 150, 1, 1000),
    // The scheduled tick leaves operations written in the last minutes to the request path.
    quietMinutes: integer('--quiet-minutes', scheduled ? 5 : 0, 0, 120),
    report: out['--report'] ?? null,
    scheduled,
    backupDir: out['--backup-dir'] ?? null,
    approvedPlanDigest: out['--approved-plan-digest'] ?? null,
    restore,
    now,
    apply,
    mongodbModule: out['--mongodb-module'] ?? 'mongodb',
  };
}

export const label = value => crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex').slice(0, 12);
const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms); });
const shiftDate = (date, days) => new Date(Date.parse(`${date}T00:00:00.000Z`) + days * 86400000).toISOString().slice(0, 10);

function attachMongoDatabase(url, database) {
  if (/\/[A-Za-z0-9_-]+(\?|$)/.test(url.replace(/^mongodb(\+srv)?:\/\//, '').split('@').pop() || '')) return url;
  return url.endsWith('/') ? `${url}${database}` : `${url}/${database}`;
}
function readMongoUrl(options) {
  if (options.mongoUrl) return options.mongoUrl;
  const flows = JSON.parse(fs.readFileSync(options.flows, 'utf8'));
  const node = (Array.isArray(flows) ? flows : []).find(item => typeof item?.uri === 'string' && item.uri.startsWith('mongodb'));
  if (!node) throw new Error('MONGO_NODE_NOT_FOUND');
  return attachMongoDatabase(node.uri, options.database);
}

async function readExerciseBookings({ vivaBase, token, exerciseId, fetchImpl = fetch }) {
  try {
    const response = await fetchImpl(`${vivaBase}/api/v1/exercises/${encodeURIComponent(exerciseId)}/bookings?showCancelled=true&size=200`, {
      method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(10000), redirect: 'error',
    });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

/** Fresh plan from primary reads. Exported for tests with an injected collection and fetch. */
export async function buildPlan({ collection, options, token, fetchImpl }) {
  const today = moscowDate(options.now);
  const to = shiftDate(today, options.daysAhead);
  const operations = await collection.find({ state: 'CONFIRMED', serviceDate: { $gte: today, $lte: to } },
    { maxTimeMS: 30000 }).toArray();
  const bound = operations.filter(op => op?.bookingId || op?.upstreamBookingId);
  const exerciseIds = [...new Set(bound.map(op => String(op?.exerciseId ?? '').trim().toLowerCase()).filter(Boolean))];
  const bookingsByExercise = new Map();
  for (const exerciseId of exerciseIds) {
    bookingsByExercise.set(exerciseId, await readExerciseBookings({ vivaBase: options.vivaBase, token, exerciseId, fetchImpl }));
    if (options.requestGapMs) await sleep(options.requestGapMs);
  }
  const guardKeys = [...new Set(bound.map(dailyVisitGuardKey))];
  const jobs = await collection.find({ kind: { $in: [...IN_FLIGHT_JOB_KINDS] }, phase: { $nin: [...TERMINAL_JOB_PHASES] } },
    { maxTimeMS: 30000 }).toArray();
  const guards = new Map((guardKeys.length ? await collection.find({ _id: { $in: guardKeys } }).toArray() : [])
    .map(guard => [guard._id, guard]));
  const targets = [];
  const byReason = {};
  for (const operation of bound) {
    const bookings = bookingsByExercise.get(String(operation.exerciseId ?? '').trim().toLowerCase()) ?? null;
    const guard = guards.get(dailyVisitGuardKey(operation)) ?? null;
    const blocked = inFlightReason({ operation, jobs, now: options.now, quietMs: (options.quietMinutes ?? 0) * 60000 });
    const decision = !isPlainJson(operation) || (guard && !isPlainJson(guard))
      ? { eligible: false, reason: 'NON_JSON_DOCUMENT' }
      : planDeadHoldRelease({ operation, bookings, guard, today });
    // Only an otherwise eligible target is held back, so the counts keep their meaning.
    if (decision.eligible && blocked) { decision.eligible = false; decision.reason = blocked; }
    byReason[decision.reason ?? 'ELIGIBLE'] = (byReason[decision.reason ?? 'ELIGIBLE'] ?? 0) + 1;
    if (decision.eligible) targets.push({ operation, guard: decision.releaseGuard ? guard : null });
  }
  targets.sort((a, b) => String(a.operation._id).localeCompare(String(b.operation._id)));
  return {
    window: { from: today, to },
    scanned: operations.length,
    exercisesRead: exerciseIds.length,
    providerUnreadable: [...bookingsByExercise.values()].filter(value => value === null).length,
    byReason,
    targets,
    digest: deadHoldPlanDigest(targets),
  };
}

// The backup is JSON. A document with Dates, ObjectIds or other BSON values would not
// restore byte-for-byte, so such a target is left alone.
export const isPlainJson = (value) => {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isPlainJson);
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.values(value).every(isPlainJson);
  }
  return false;
};

const planReport = plan => ({
  window: plan.window, scanned: plan.scanned, exercisesRead: plan.exercisesRead,
  providerUnreadable: plan.providerUnreadable, byReason: plan.byReason,
  targets: plan.targets.length, guardsToRelease: plan.targets.filter(target => target.guard).length,
  byDate: plan.targets.reduce((acc, target) => {
    acc[target.operation.serviceDate] = (acc[target.operation.serviceDate] ?? 0) + 1; return acc;
  }, {}),
  byCategory: plan.targets.reduce((acc, target) => {
    const key = target.operation.category ?? 'unknown'; acc[key] = (acc[key] ?? 0) + 1; return acc;
  }, {}),
  planDigest: plan.digest,
});

function writePrivateFile(file, value) {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const dir = fs.openSync(path.dirname(file), fs.constants.O_RDONLY);
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}

const TRANSACTION_OPTIONS = Object.freeze({
  readConcern: { level: 'snapshot' }, writeConcern: WRITE_OPTIONS.writeConcern, readPreference: 'primary',
});

/**
 * One explicit transaction without driver retries. The 3.x driver on the server
 * mishandles `withTransaction` retries after an abort, so a failed attempt is aborted
 * once and reported; the next tick re-plans from fresh reads instead of retrying.
 * `body` returns an outcome; throwing `Abort(outcome)` rolls back with that outcome.
 */
class Abort extends Error {
  constructor(outcome) { super('ABORT'); this.outcome = outcome; }
}
async function inTransaction(client, body) {
  const session = client.startSession();
  try {
    session.startTransaction(TRANSACTION_OPTIONS);
    let outcome;
    try {
      outcome = await body(session);
    } catch (error) {
      try { await session.abortTransaction(); } catch { /* already aborted by the server */ }
      if (error instanceof Abort) return { outcome: error.outcome };
      return { outcome: 'TRANSACTION_ERROR', error: errorCode(error) };
    }
    try {
      await session.commitTransaction();
    } catch (error) {
      // Commit outcome unknown: the postcheck reads the real state.
      return { outcome: 'COMMIT_UNKNOWN', error: errorCode(error) };
    }
    return { outcome };
  } finally {
    session.endSession();
  }
}
// Driver text with quoted values and long hex/uuid runs removed, so no identifier leaks.
const errorText = error => String(error?.message ?? '').replace(/"[^"]*"|'[^']*'/g, '<v>')
  .replace(/[0-9a-f-]{8,}/gi, '<id>').replace(/lk1[^\s,]*/g, '<id>').slice(0, 160);
const errorCode = error => [error?.codeName ?? error?.name ?? 'Error', error?.code ?? '',
  ...(Array.isArray(error?.errorLabels) ? error.errorLabels : []), errorText(error)].filter(Boolean).join(':');

/** Release every target, each in its own transaction. Never retries a failed target. */
export async function applyPlan({ client, collection, plan, now, recheck = null }) {
  const results = [];
  for (const target of plan.targets) {
    // The Mongo CAS cannot see Viva: re-read the booking right before this write, so a
    // restored or rebooked seat after the plan's read keeps its hold.
    if (recheck) {
      const reason = await recheck(target);
      if (reason) { results.push({ operation: label(target.operation._id), outcome: `SKIPPED_RECHECK_${reason}` }); continue; }
    }
    const { operationCommand, guardCommand } = buildDeadHoldReleaseCommands({ ...target, now });
    const result = await inTransaction(client, async (session) => {
      const updated = await collection.updateOne(operationCommand.query, operationCommand.update, { session });
      if (updated.matchedCount !== 1 || updated.modifiedCount !== 1) throw new Abort('OPERATION_CHANGED');
      if (guardCommand) {
        const deleted = await collection.deleteOne(guardCommand.query, { session });
        if (deleted.deletedCount !== 1) throw new Abort('GUARD_CHANGED');
      }
      return guardCommand ? 'RELEASED_WITH_GUARD' : 'RELEASED';
    });
    results.push({ operation: label(target.operation._id), ...result });
    if (['TRANSACTION_ERROR', 'COMMIT_UNKNOWN'].includes(result.outcome)) break;
  }
  return results;
}

/** Fresh Viva readback for one target; returns a reason to skip, or null. */
export function makeRecheck({ options, token, fetchImpl }) {
  const today = moscowDate(options.now);
  return async ({ operation, guard }) => {
    const bookings = await readExerciseBookings({ vivaBase: options.vivaBase, token,
      exerciseId: String(operation.exerciseId ?? '').trim().toLowerCase(), fetchImpl });
    if (bookings === null) return 'PROVIDER_UNREADABLE';
    const decision = planDeadHoldRelease({ operation, bookings, guard, today });
    if (!decision.eligible) return decision.reason ?? 'NOT_ELIGIBLE';
    return decision.releaseGuard === Boolean(guard) ? null : 'GUARD_PLAN_CHANGED';
  };
}

/** Postcheck from primary: released operations and absent guards. */
export async function verifyApplied({ collection, plan, results }) {
  const released = new Set(results.filter(item => item.outcome.startsWith('RELEASED')).map(item => item.operation));
  const unknown = new Set(results.filter(item => item.outcome === 'COMMIT_UNKNOWN').map(item => item.operation));
  for (const target of plan.targets) {
    if (!unknown.has(label(target.operation._id))) continue;
    const [operation] = await collection.find({ _id: target.operation._id }).toArray();
    // Resolve the unknown commit to what actually happened.
    const item = results.find(entry => entry.operation === label(target.operation._id));
    item.outcome = operation?.state === 'RELEASED' && operation.releaseReason === 'DEAD_HOLD_PROVIDER_CANCELLED'
      ? (target.guard ? 'RELEASED_WITH_GUARD' : 'RELEASED') : 'COMMIT_NOT_APPLIED';
    if (item.outcome.startsWith('RELEASED')) released.add(item.operation);
  }
  let mismatches = 0;
  for (const target of plan.targets) {
    if (!released.has(label(target.operation._id))) continue;
    const [operation] = await collection.find({ _id: target.operation._id }).toArray();
    if (operation?.state !== 'RELEASED' || operation.visitReturn !== 'UNVERIFIED') mismatches += 1;
    if (target.guard) {
      const [guard] = await collection.find({ _id: target.guard._id }).toArray();
      // A new guard owned by another operation is legitimate after the release.
      if (guard && guard.ownerOperationKey === target.operation._id) mismatches += 1;
    }
  }
  return mismatches;
}

export async function restoreBackup({ client, collection, backup }) {
  const results = [];
  for (const entry of backup.targets) {
    const { operationCommand, guardDocument } = buildDeadHoldRestoreCommands(entry);
    const result = await inTransaction(client, async (session) => {
      const replaced = await collection.replaceOne(operationCommand.query, operationCommand.replacement, { session });
      if (replaced.matchedCount !== 1) throw new Abort('OPERATION_NOT_IN_RELEASED_STATE');
      if (guardDocument) {
        const [current] = await collection.find({ _id: guardDocument._id }, { session }).toArray();
        if (current) throw new Abort('GUARD_REOWNED');
        await collection.insertOne(guardDocument, { session });
      }
      return 'RESTORED';
    });
    results.push({ operation: label(entry.operation._id), ...result });
  }
  return results;
}

function writeReport(file, value) {
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

/** One scheduled tick: no approval digest, bounded, backup only when something is released. */
export async function runScheduledTick({ client, collection, plan, options }) {
  const base = { mode: 'scheduled', at: options.now, ...planReport(plan) };
  let report;
  if (plan.providerUnreadable > 0 && plan.providerUnreadable === plan.exercisesRead) {
    report = { ...base, result: 'PROVIDER_UNREADABLE' };
  } else if (plan.targets.length > options.maxTargets) {
    report = { ...base, result: 'TOO_MANY_TARGETS' };
  } else if (!plan.targets.length) {
    report = { ...base, result: 'NOTHING_TO_RELEASE' };
  } else {
    fs.mkdirSync(options.backupDir, { recursive: true, mode: 0o700 });
    const backupPath = path.join(options.backupDir, `dead-holds-${options.now.replace(/[:.]/g, '-')}.json`);
    writePrivateFile(backupPath, { createdAt: options.now, planDigest: plan.digest, targets: plan.targets });
    const results = await applyPlan({ client, collection, plan, now: options.now, recheck: options.recheck ?? null });
    const postcheckMismatches = await verifyApplied({ collection, plan, results });
    const failed = results.some(item => ['TRANSACTION_ERROR', 'COMMIT_NOT_APPLIED'].includes(item.outcome));
    report = { ...base, result: failed ? 'FAILED_TARGETS' : 'DONE', backupPath, outcomes: tally(results), postcheckMismatches };
  }
  writeReport(options.report, report);
  return report;
}

const tally = results => results.reduce((acc, item) => {
  const key = item.error ? `${item.outcome}:${item.error}` : item.outcome;
  acc[key] = (acc[key] ?? 0) + 1; return acc;
}, {});

export async function runDeadHoldRelease(options) {
  const mongodb = require(options.mongodbModule);
  const client = new mongodb.MongoClient(readMongoUrl(options), { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  try {
    const db = client.db(options.database);
    const hello = await db.admin().command({ isMaster: 1 });
    if (!hello.setName) throw new Error('REPLICA_SET_REQUIRED');
    const collection = db.collection(options.collection, { readPreference: 'primary' });
    if (options.restore) {
      const backup = JSON.parse(fs.readFileSync(options.restore, 'utf8'));
      const results = await restoreBackup({ client, collection, backup });
      const restored = results.filter(item => item.outcome === 'RESTORED').length;
      return { mode: 'restore', result: restored === results.length ? 'DONE' : 'PARTIAL_RESTORE', restored, results: tally(results) };
    }
    const token = fs.readFileSync(options.tokenFile, 'utf8').trim();
    const plan = await buildPlan({ collection, options, token, fetchImpl: options.fetchImpl });
    const recheck = makeRecheck({ options, token, fetchImpl: options.fetchImpl });
    // `return await`: a bare returned promise would let `finally` close the pool mid-tick.
    if (options.scheduled) return await runScheduledTick({ client, collection, plan, options: { ...options, recheck } });
    if (!options.apply) return { mode: 'plan', ...planReport(plan) };
    if (plan.digest !== options.approvedPlanDigest) return { mode: 'apply', result: 'PLAN_DRIFT', ...planReport(plan) };
    if (plan.targets.length > options.maxTargets) return { mode: 'apply', result: 'TOO_MANY_TARGETS', ...planReport(plan) };
    fs.mkdirSync(options.backupDir, { recursive: true, mode: 0o700 });
    const backupPath = path.join(options.backupDir, `dead-holds-${options.now.replace(/[:.]/g, '-')}.json`);
    writePrivateFile(backupPath, { createdAt: options.now, planDigest: plan.digest, targets: plan.targets });
    const results = await applyPlan({ client, collection, plan, now: options.now, recheck });
    const postcheckMismatches = await verifyApplied({ collection, plan, results });
    const failed = results.some(item => ['TRANSACTION_ERROR', 'COMMIT_NOT_APPLIED'].includes(item.outcome));
    return { mode: 'apply', result: failed ? 'FAILED_TARGETS' : 'DONE', backupPath, outcomes: tally(results), postcheckMismatches, ...planReport(plan) };
  } finally {
    await client.close();
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const report = await runDeadHoldRelease(parseReleaseArgs(process.argv.slice(2)));
    console.log(JSON.stringify(report, null, 2));
    if (report.result && !['DONE', 'NOTHING_TO_RELEASE'].includes(report.result)) process.exitCode = 2;
    if (report.postcheckMismatches) process.exitCode = 3;
  } catch (error) {
    console.error(JSON.stringify({ error: /^[A-Z_]+/.test(error?.message ?? '') ? error.message : 'RELEASE_FAILED' }));
    process.exitCode = 1;
  }
}
