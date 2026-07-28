import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';

const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
};

const toFiniteNumber = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const gradeToNumeric = (value) => {
  const grade = String(value || '').trim().toUpperCase();
  return ({ D: 2, 'D+': 2.5, C: 3, 'C+': 3.5, B: 4.2, 'B+': 5, A: 6 })[grade] ?? null;
};

const normalizeKeyPart = (value, fallback = 'unknown') => {
  const text = toStr(value);
  return encodeURIComponent(text || fallback).replace(/%/g, '~');
};

const resolveClientId = (row) => toStr(row?.clientId || row?.vivaClientId || row?.id);
const resolvePhone = (row) => {
  const digits = String(row?.phoneNorm || row?.phone || '').replace(/\D/g, '');
  return digits || null;
};

export const RATING_LEDGER_INDEXES = Object.freeze({
  ratingEvents: [
    { key: { idempotencyKey: 1 }, options: { name: 'rating_event_idempotency_uq', unique: true } },
    { key: { 'player.key': 1, occurredAt: -1 }, options: { name: 'rating_event_player_time' } },
    { key: { 'source.domain': 1, 'source.sourceId': 1, occurredAt: -1 }, options: { name: 'rating_event_source_time' } },
    { key: { eventType: 1, occurredAt: -1 }, options: { name: 'rating_event_type_time' } },
  ],
  playerRatings: [
    {
      key: { phoneNorm: 1 },
      options: {
        name: 'player_rating_phone_uq',
        unique: true,
        partialFilterExpression: { phoneNorm: { $type: 'string' } },
      },
    },
    {
      key: { clientId: 1 },
      options: {
        name: 'player_rating_client_uq',
        unique: true,
        partialFilterExpression: { clientId: { $type: 'string' } },
      },
    },
    {
      key: { playerKey: 1 },
      options: {
        name: 'player_rating_key_uq',
        unique: true,
        partialFilterExpression: { playerKey: { $type: 'string' } },
      },
    },
  ],
});

export function buildInitialImportMutation(row, nowIso = new Date().toISOString()) {
  const clientId = resolveClientId(row);
  const phoneNorm = resolvePhone(row);
  const legacyKey = toStr(row?._id);
  const playerKey = clientId
    ? `client:${clientId}`
    : phoneNorm
      ? `phone:${phoneNorm}`
      : legacyKey
        ? `legacy:${legacyKey}`
        : null;
  const ratingNumeric = toFiniteNumber(row?.ratingNumeric) ?? gradeToNumeric(row?.rating);
  if (!playerKey || !Number.isFinite(ratingNumeric)) {
    return {
      skipped: true,
      reason: !playerKey ? 'MISSING_PLAYER_IDENTITY' : 'MISSING_RATING',
      rowId: legacyKey,
    };
  }

  const eventId = `rating_evt:initial_import:${normalizeKeyPart(playerKey)}`;
  const name = toStr(row?.name) || 'Игрок';
  const event = {
    _id: eventId,
    id: eventId,
    idempotencyKey: eventId,
    schemaVersion: 1,
    eventType: 'RATING_INITIAL_IMPORTED',
    occurredAt: nowIso,
    createdAt: nowIso,
    player: {
      key: playerKey,
      clientId,
      memberKey: toStr(row?.memberKey),
      phoneNorm,
      name,
    },
    actor: {
      type: 'SYSTEM',
      id: 'system:rating-ledger-migration',
      memberKey: null,
      phoneNorm: null,
      name: 'Rating ledger migration',
    },
    source: {
      domain: 'INITIAL_IMPORT',
      sourceId: 'player_ratings',
      legacyRowId: legacyKey,
      legacyUpdatedAt: toStr(row?.updatedAt),
    },
    change: {
      before: null,
      delta: null,
      after: ratingNumeric,
      gradeBefore: null,
      gradeAfter: toStr(row?.rating),
      expected: null,
      actual: null,
    },
    formula: null,
    projectionIntent: { viva: 'NONE_INITIAL_IMPORT' },
  };
  const stateFilter = row?._id !== undefined && row?._id !== null
    ? { _id: row._id, lastEventId: { $exists: false } }
    : { phoneNorm, lastEventId: { $exists: false } };
  const stateSet = {
    schemaVersion: 1,
    ownership: 'CUP_CANONICAL',
    playerKey,
    lastEventId: eventId,
    lastEventType: event.eventType,
    lastEventAt: nowIso,
    lastSource: 'initial_import',
    lastChangedBy: event.actor,
    updatedAt: toStr(row?.updatedAt) || nowIso,
  };
  if (clientId) stateSet.clientId = clientId;
  if (phoneNorm) stateSet.phoneNorm = phoneNorm;

  return {
    skipped: false,
    playerKey,
    phoneNorm,
    clientId,
    eventOperation: {
      updateOne: {
        filter: { _id: eventId },
        update: { $setOnInsert: event },
        upsert: true,
      },
    },
    stateOperation: {
      updateOne: {
        filter: stateFilter,
        update: { $set: stateSet },
        upsert: false,
      },
    },
  };
}

export function findDuplicateIdentities(rows) {
  const duplicates = [];
  for (const [kind, resolver] of [['phoneNorm', resolvePhone], ['clientId', resolveClientId]]) {
    const seen = new Map();
    for (const row of rows) {
      const value = resolver(row);
      if (!value) continue;
      seen.set(value, (seen.get(value) || 0) + 1);
    }
    for (const [value, count] of seen.entries()) {
      if (count > 1) duplicates.push({ kind, value, count });
    }
  }
  return duplicates;
}

const getArg = (name, fallback = null) => {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};

const hasArg = (name) => process.argv.includes(name);
const maskPhone = (phone) => phone ? `${phone.slice(0, 2)}*****${phone.slice(-2)}` : null;
const maskIdentifier = (value) => value ? `${String(value).slice(0, 4)}...${String(value).slice(-4)}` : null;
const writeReport = (outPath, report) => {
  if (!outPath) return;
  const absolutePath = path.resolve(outPath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
};

const printHelp = () => {
  console.log(`Usage:
  node scripts/migrate_player_rating_ledger.mjs --input-file ratings.json
  MONGO_URI=... node scripts/migrate_player_rating_ledger.mjs [--db name]
  MONGO_URI=... node scripts/migrate_player_rating_ledger.mjs --apply [--db name] [--out report.json]

Default mode is dry-run. --apply creates rating_events/indexes, appends deterministic
RATING_INITIAL_IMPORTED events, and marks untouched player_ratings rows as CUP_CANONICAL.
No rating value is overwritten by the migration.`);
};

async function ensureIndexes(db) {
  const existing = await db.listCollections({ name: 'rating_events' }).hasNext();
  if (!existing) await db.createCollection('rating_events');
  for (const item of RATING_LEDGER_INDEXES.ratingEvents) {
    await db.collection('rating_events').createIndex(item.key, item.options);
  }
  for (const item of RATING_LEDGER_INDEXES.playerRatings) {
    await db.collection('player_ratings').createIndex(item.key, item.options);
  }
}

async function runCli() {
  if (hasArg('--help') || (process.argv.length <= 2 && !process.env.MONGO_URI && !process.env.MONGODB_URI)) {
    printHelp();
    return;
  }

  const apply = hasArg('--apply');
  const inputFile = getArg('--input-file');
  const mongoUri = getArg('--mongo-uri', process.env.MONGO_URI || process.env.MONGODB_URI || null);
  const dbName = getArg('--db');
  const outPath = getArg('--out');
  let client = null;
  let db = null;
  let rows = [];
  try {
    if (inputFile) {
      const parsed = JSON.parse(fs.readFileSync(path.resolve(inputFile), 'utf8'));
      rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.ratings) ? parsed.ratings : [];
      if (apply && !mongoUri) throw new Error('--apply with --input-file also requires --mongo-uri');
    }
    if (mongoUri) {
      client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 10_000 });
      await client.connect();
      db = client.db(dbName || undefined);
      if (!inputFile) rows = await db.collection('player_ratings').find({}).toArray();
    }
    if (!inputFile && !mongoUri) throw new Error('Provide --input-file or MONGO_URI/MONGODB_URI');

    const nowIso = new Date().toISOString();
    const mutations = rows.map((row) => buildInitialImportMutation(row, nowIso));
    const applicable = mutations.filter((item) => !item.skipped);
    const skipped = mutations.filter((item) => item.skipped);
    const duplicates = findDuplicateIdentities(rows);
    const report = {
      mode: apply ? 'APPLY' : 'DRY_RUN',
      createdAt: nowIso,
      scanned: rows.length,
      applicable: applicable.length,
      skipped: skipped.length,
      duplicateIdentities: duplicates.length,
      sample: applicable.slice(0, 5).map((item) => ({
        playerKey: item.playerKey.startsWith('client:')
          ? 'client:masked'
          : item.playerKey.startsWith('phone:')
            ? 'phone:masked'
            : 'legacy:masked',
        phoneNorm: maskPhone(item.phoneNorm),
        clientId: maskIdentifier(item.clientId),
        eventId: 'rating_evt:initial_import:masked',
      })),
      skippedReasons: skipped.reduce((acc, item) => {
        acc[item.reason] = (acc[item.reason] || 0) + 1;
        return acc;
      }, {}),
    };
    console.log(JSON.stringify(report, null, 2));
    if (!apply) {
      writeReport(outPath, report);
      return;
    }
    if (!db) throw new Error('Mongo connection is required for --apply');
    if (duplicates.length > 0) {
      throw new Error(`Refusing --apply: ${duplicates.length} duplicate player identities must be reconciled first`);
    }

    await ensureIndexes(db);
    const eventOps = applicable.map((item) => item.eventOperation);
    const stateOps = applicable.map((item) => item.stateOperation);
    const eventResult = eventOps.length
      ? await db.collection('rating_events').bulkWrite(eventOps, { ordered: false })
      : null;
    const stateResult = stateOps.length
      ? await db.collection('player_ratings').bulkWrite(stateOps, { ordered: false })
      : null;
    report.applyResult = {
      applied: true,
      eventsUpserted: Number(eventResult?.upsertedCount || 0),
      eventsMatched: Number(eventResult?.matchedCount || 0),
      statesModified: Number(stateResult?.modifiedCount || 0),
      statesSkippedAsAlreadyCanonical: applicable.length - Number(stateResult?.matchedCount || 0),
    };
    console.log(JSON.stringify(report.applyResult, null, 2));
    writeReport(outPath, report);
  } finally {
    if (client) await client.close();
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runCli().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  });
}
