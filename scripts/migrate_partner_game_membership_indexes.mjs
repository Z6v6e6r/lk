#!/usr/bin/env node
// Scoped partner migration: creates the indexes the Partner Game Membership API requires
// (one on lk_games, the rest on the five lk_partner_* collections owned by this API).
//
// This is deliberately NOT the legacy-game-command production migration. That governed
// migration also owns uniq_tenant_game_id but its trust anchor is still UNBOUND, so it
// cannot run; this script exists as a bounded, reversible pilot exception and must be
// retired or replaced by the governed path before the partner API is promoted.
//
// It never drops anything on its own, never touches documents, and refuses to run when a
// duplicate {tenantKey,id} group or an index conflict is present.
//
// Modes:
//   audit           read-only inventory and classification  (default)
//   dry-run         audit plus the exact createIndex plan
//   apply           create only the missing indexes (requires --confirm-apply)
//   postcheck       verify every spec matches the live database
//   rollback-plan   print the dropIndex calls that would undo this migration
//
// Connection: LK_PARTNER_GAME_MEMBERSHIP_MONGO_URI (preferred) or
// LK_PARTNER_GAME_API_MONGO_URI, plus --database or LK_PARTNER_GAME_MEMBERSHIP_MONGO_DB.
import { fileURLToPath } from "node:url";
import { MongoClient } from "mongodb";
import {
  PARTNER_MEMBERSHIP_COLLECTIONS,
  PARTNER_MEMBERSHIP_INDEX_SPECS,
} from "../node-red/custom-nodes/partner-game-membership-api/partner-game-membership-mongo.mjs";

const MODES = new Set(["audit", "dry-run", "apply", "postcheck", "rollback-plan"]);
const UNIQUE_GAME_IDENTITY = "uniq_tenant_game_id";

export function parseArgs(argv) {
  const options = { mode: "audit", confirmApply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--confirm-apply") { options.confirmApply = true; continue; }
    if (!token.startsWith("--")) throw new Error(`Unexpected argument ${token}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${token}`);
    options[token === "--mode" ? "mode" : token.slice(2)] = value;
    index += 1;
  }
  if (!MODES.has(options.mode)) throw new Error(`Unknown mode ${options.mode}`);
  return options;
}

export function classifyIndexSpecs(actual, specs) {
  const matching = []; const missing = []; const conflicts = [];
  for (const spec of specs) {
    const sameName = actual.find((item) => item.name === spec.name);
    if (sameName) {
      const equal = JSON.stringify(sameName.key) === JSON.stringify(spec.key)
        && (sameName.unique ?? false) === (spec.unique ?? false)
        && (sameName.sparse ?? false) === (spec.sparse ?? false)
        && (sameName.expireAfterSeconds ?? null) === (spec.expireAfterSeconds ?? null);
      if (equal) matching.push(spec.name); else conflicts.push(`${spec.name}:definition`);
      continue;
    }
    const equivalent = actual.find((item) => JSON.stringify(item.key) === JSON.stringify(spec.key)
      && (item.unique ?? false) === (spec.unique ?? false)
      && (item.sparse ?? false) === (spec.sparse ?? false));
    if (equivalent) conflicts.push(`${spec.name}:equivalent-as-${equivalent.name}`);
    else missing.push(spec.name);
  }
  return { matching, missing, conflicts };
}

export async function auditPartnerIndexes(db) {
  const collections = {};
  const missing = []; const conflicts = []; const matching = [];
  for (const [logicalName, specs] of Object.entries(PARTNER_MEMBERSHIP_INDEX_SPECS)) {
    const name = PARTNER_MEMBERSHIP_COLLECTIONS[logicalName];
    let actual = [];
    try { actual = await db.collection(name).indexes(); } catch { actual = []; }
    const verdict = classifyIndexSpecs(actual, specs);
    collections[logicalName] = { name, present: actual.map((item) => item.name), ...verdict };
    missing.push(...verdict.missing.map((item) => `${name}:${item}`));
    conflicts.push(...verdict.conflicts.map((item) => `${name}:${item}`));
    matching.push(...verdict.matching.map((item) => `${name}:${item}`));
  }
  const duplicateGames = await db.collection(PARTNER_MEMBERSHIP_COLLECTIONS.games)
    .aggregate([
      { $group: { _id: { tenantKey: "$tenantKey", id: "$id" }, count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
      { $limit: 10 },
    ]).toArray();
  return { collections, matching, missing, conflicts, duplicateGames };
}

export function buildCreateIndexPlan(audit) {
  const operations = [];
  for (const [logicalName, specs] of Object.entries(PARTNER_MEMBERSHIP_INDEX_SPECS)) {
    const name = PARTNER_MEMBERSHIP_COLLECTIONS[logicalName];
    for (const spec of specs) {
      if (audit.collections[logicalName].missing.includes(spec.name)) {
        const { key, ...indexOptions } = spec;
        operations.push({ collection: name, createIndex: key, options: indexOptions });
      }
    }
  }
  return operations;
}

export function buildRollbackPlan() {
  const operations = [];
  for (const [logicalName, specs] of Object.entries(PARTNER_MEMBERSHIP_INDEX_SPECS)) {
    const name = PARTNER_MEMBERSHIP_COLLECTIONS[logicalName];
    for (const spec of specs) operations.push({ collection: name, dropIndex: spec.name });
  }
  return operations;
}

function assertApplyAllowed(db, audit) {
  if (audit.conflicts.length) throw new Error(`Index conflicts must be resolved manually: ${audit.conflicts.join(", ")}`);
  if (audit.duplicateGames.length) {
    throw new Error(`Duplicate {tenantKey,id} groups block ${UNIQUE_GAME_IDENTITY}: ${audit.duplicateGames.length}`);
  }
  if (!db.databaseName) throw new Error("A database name is required");
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.mode === "rollback-plan") {
    process.stdout.write(`${JSON.stringify({ mode: options.mode, operations: buildRollbackPlan() }, null, 2)}\n`);
    return;
  }
  const mongoUri = process.env.LK_PARTNER_GAME_MEMBERSHIP_MONGO_URI || process.env.LK_PARTNER_GAME_API_MONGO_URI;
  const databaseName = options.database || process.env.LK_PARTNER_GAME_MEMBERSHIP_MONGO_DB || process.env.LK_PARTNER_GAME_API_MONGO_DB;
  if (!mongoUri || !databaseName) throw new Error("A Mongo URI and database name are required");
  const client = new MongoClient(mongoUri, { readPreference: "primary", serverSelectionTimeoutMS: 12000 });
  try {
    await client.connect();
    const db = client.db(databaseName);
    const audit = await auditPartnerIndexes(db);
    const base = {
      mode: options.mode, database: databaseName, matching: audit.matching,
      missing: audit.missing, conflicts: audit.conflicts,
      duplicateGames: audit.duplicateGames.map((item) => `${item._id.tenantKey}:${item._id.id}`),
    };
    if (options.mode === "audit") {
      process.stdout.write(`${JSON.stringify({ ...base, collections: audit.collections }, null, 2)}\n`);
      return;
    }
    if (options.mode === "dry-run") {
      process.stdout.write(`${JSON.stringify({ ...base, operations: buildCreateIndexPlan(audit) }, null, 2)}\n`);
      return;
    }
    if (options.mode === "postcheck") {
      process.stdout.write(`${JSON.stringify({ ...base, ok: audit.missing.length === 0 && audit.conflicts.length === 0 }, null, 2)}\n`);
      if (audit.missing.length || audit.conflicts.length) process.exitCode = 1;
      return;
    }
    if (!options.confirmApply) throw new Error("apply requires --confirm-apply");
    assertApplyAllowed(db, audit);
    const applied = [];
    for (const operation of buildCreateIndexPlan(audit)) {
      const { collection, createIndex, options: indexOptions } = operation;
      const name = await db.collection(collection).createIndex(createIndex, indexOptions);
      applied.push(`${collection}:${name}`);
    }
    const after = await auditPartnerIndexes(db);
    process.stdout.write(`${JSON.stringify({
      mode: options.mode, database: databaseName, applied,
      remainingMissing: after.missing, remainingConflicts: after.conflicts,
      duplicateGames: after.duplicateGames.map((item) => `${item._id.tenantKey}:${item._id.id}`),
      ok: after.missing.length === 0 && after.conflicts.length === 0,
    }, null, 2)}\n`);
    if (after.missing.length || after.conflicts.length) process.exitCode = 1;
  } finally {
    await client.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
