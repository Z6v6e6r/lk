#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { MongoClient } from "mongodb";
import {
  buildLegacyResultId,
  LEGACY_COMMAND_COLLECTIONS,
  LEGACY_COMMAND_INDEX_SPECS,
  validateLegacyIdentityMapping,
} from "../node-red/custom-nodes/legacy-game-command-transaction/legacy-game-command-core.mjs";

const MODES = new Set(["audit", "dry-run", "apply", "postcheck", "rollback-plan"]);
const LOCAL_DATABASE_PATTERN = /(?:^|[_-])(test|local|dev)(?:$|[_-])/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const LOCAL_MIGRATION_SENTINEL_COLLECTION = "lk_local_migration_sentinels";
export const LOCAL_MIGRATION_SENTINEL_ID = "legacy-game-command-prerequisites-local-v1";

export function parseLegacyPrerequisiteArgs(argv) {
  const result = { mode: "audit", environment: "local" };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--confirm-local-apply") {
      result.confirmLocalApply = true;
      continue;
    }
    if (!token.startsWith("--")) throw new Error(`Unexpected argument ${token}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${token}`);
    result[token.slice(2)] = value;
    index += 1;
  }
  if (!MODES.has(result.mode)) throw new Error(`Unsupported mode ${result.mode}`);
  return result;
}

function invalidRevisionFilter() {
  return {
    $or: [
      { revision: { $exists: false } },
      { revision: null },
      { revision: { $not: { $type: "number" } } },
      { revision: { $lt: 1 } },
      { revision: { $gt: Number.MAX_SAFE_INTEGER } },
      {
        $expr: {
          $cond: [
            { $in: [{ $type: "$revision" }, ["int", "long", "double", "decimal"]] },
            { $ne: [{ $mod: ["$revision", 1] }, 0] },
            false,
          ],
        },
      },
    ],
  };
}

async function duplicateGroups(collection, fields, session, maxTimeMS) {
  const id = Object.fromEntries(fields.map((field) => [field, `$${field}`]));
  return collection.aggregate([
    { $group: { _id: id, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
    { $limit: 20 },
  ], { ...primaryMajority, session, maxTimeMS }).toArray();
}

const primaryMajority = { readPreference: "primary", readConcern: { level: "majority" } };

async function countInvalidGameIdentities(games, session, maxTimeMS) {
  let count = 0;
  for await (const game of games.find({}, {
    ...primaryMajority,
    session,
    projection: { tenantKey: 1, id: 1 }, maxTimeMS,
  })) {
    const tenantKey = typeof game.tenantKey === "string" ? game.tenantKey.trim() : "";
    const id = typeof game.id === "string" ? game.id.trim() : "";
    if (!tenantKey || !id || tenantKey !== game.tenantKey || id !== game.id) count += 1;
  }
  return count;
}

async function countInvalidResultIdentities(results, session, maxTimeMS) {
  let count = 0;
  for await (const result of results.find({}, {
    ...primaryMajority,
    session,
    projection: { _id: 1, tenantKey: 1, id: 1, gameId: 1, idempotencyKey: 1, revision: 1 }, maxTimeMS,
  })) {
    const tenantKey = typeof result.tenantKey === "string" ? result.tenantKey.trim() : "";
    const id = typeof result.id === "string" ? result.id.trim() : "";
    const gameId = typeof result.gameId === "string" ? result.gameId.trim() : "";
    const idempotencyKey = typeof result.idempotencyKey === "string" ? result.idempotencyKey.trim() : "";
    let expectedId = null;
    try { expectedId = buildLegacyResultId(tenantKey, idempotencyKey); } catch { expectedId = null; }
    if (!tenantKey || !id || !gameId || !idempotencyKey
      || tenantKey !== result.tenantKey || id !== result.id || gameId !== result.gameId
      || idempotencyKey !== result.idempotencyKey || result._id !== id
      || id !== expectedId
      || !Number.isSafeInteger(result.revision) || result.revision < 1) count += 1;
  }
  return count;
}

async function countInvalidProviderOutboxIdentities(outbox, results, session, maxTimeMS) {
  let count = 0;
  for await (const row of outbox.find({}, {
    ...primaryMajority,
    session,
    projection: { _id: 1, tenantKey: 1, id: 1, resultId: 1, resultRevision: 1 }, maxTimeMS,
  })) {
    const tenantKey = typeof row.tenantKey === "string" ? row.tenantKey.trim() : "";
    const id = typeof row.id === "string" ? row.id.trim() : "";
    const resultId = typeof row.resultId === "string" ? row.resultId.trim() : "";
    const resultIdentity = tenantKey && resultId && Number.isSafeInteger(row.resultRevision) && row.resultRevision > 0
      ? await results.findOne(
        { tenantKey, id: resultId, revision: row.resultRevision },
        { ...primaryMajority, session, projection: { _id: 1 }, maxTimeMS },
      )
      : null;
    if (!tenantKey || !id || !resultId || tenantKey !== row.tenantKey || id !== row.id
      || row._id !== id || !id.includes(`:${tenantKey}:`)
      || !Number.isSafeInteger(row.resultRevision) || row.resultRevision < 1
      || !resultIdentity) count += 1;
  }
  return count;
}

async function countInvalidMappings(mappings, session, maxTimeMS) {
  let count = 0;
  for await (const mapping of mappings.find({}, { ...primaryMajority, session, maxTimeMS })) {
    if (validateLegacyIdentityMapping(mapping).length) count += 1;
  }
  return count;
}

async function countNormalizedMappingAliases(mappings, field, session, maxTimeMS) {
  const seen = new Set();
  const duplicates = new Set();
  for await (const mapping of mappings.find({}, {
    ...primaryMajority,
    session,
    projection: { tenantKey: 1, [field]: 1 }, maxTimeMS,
  })) {
    const tenantKey = typeof mapping.tenantKey === "string" ? mapping.tenantKey.trim() : "";
    const identity = typeof mapping[field] === "string" ? mapping[field].trim().toLowerCase() : "";
    if (!tenantKey || !identity) continue;
    const key = `${tenantKey}\u0000${identity}`;
    if (seen.has(key)) duplicates.add(key);
    seen.add(key);
  }
  return duplicates.size;
}

export async function auditLegacyCommandPrerequisites(db, { session, maxTimeMS = 120_000 } = {}) {
  const games = db.collection(LEGACY_COMMAND_COLLECTIONS.games);
  const mappings = db.collection(LEGACY_COMMAND_COLLECTIONS.mappings);
  const commands = db.collection(LEGACY_COMMAND_COLLECTIONS.commands);
  const auditIntents = db.collection(LEGACY_COMMAND_COLLECTIONS.auditIntents);
  const outboxIntents = db.collection(LEGACY_COMMAND_COLLECTIONS.outboxIntents);
  const results = db.collection(LEGACY_COMMAND_COLLECTIONS.results);
  const resultVivaSyncOutbox = db.collection(LEGACY_COMMAND_COLLECTIONS.resultVivaSyncOutbox);
  const cleanupReconciliationIntents = db.collection(LEGACY_COMMAND_COLLECTIONS.cleanupReconciliationIntents);
  const [
    gameCount,
    invalidRevisionCount,
    invalidGameIdentityCount,
    mappingCount,
    invalidMappingCount,
    duplicateGames,
    duplicateCanonical,
    duplicateLegacy,
    normalizedCanonicalAliasCount,
    normalizedLegacyAliasCount,
    duplicateCommandKeys,
    duplicateOperationIds,
    duplicateAuditIntents,
    duplicateOutboxIntents,
    resultCount,
    invalidResultIdentityCount,
    duplicateResults,
    duplicateResultIdempotencyKeys,
    providerOutboxCount,
    invalidProviderOutboxIdentityCount,
    duplicateProviderOutboxIdentities,
    duplicateCleanupReconciliationIntents,
  ] = await Promise.all([
    games.countDocuments({}, { ...primaryMajority, session, maxTimeMS }),
    games.countDocuments(invalidRevisionFilter(), { ...primaryMajority, session, maxTimeMS }),
    countInvalidGameIdentities(games, session, maxTimeMS),
    mappings.countDocuments({}, { ...primaryMajority, session, maxTimeMS }),
    countInvalidMappings(mappings, session, maxTimeMS),
    duplicateGroups(games, ["tenantKey", "id"], session, maxTimeMS),
    duplicateGroups(mappings, ["tenantKey", "canonicalUserId"], session, maxTimeMS),
    duplicateGroups(mappings, ["tenantKey", "legacyUserId"], session, maxTimeMS),
    countNormalizedMappingAliases(mappings, "canonicalUserId", session, maxTimeMS),
    countNormalizedMappingAliases(mappings, "legacyUserId", session, maxTimeMS),
    duplicateGroups(commands, ["tenantKey", "idempotencyKey"], session, maxTimeMS),
    duplicateGroups(commands, ["tenantKey", "operationId"], session, maxTimeMS),
    duplicateGroups(auditIntents, ["tenantKey", "operationId", "intentKey"], session, maxTimeMS),
    duplicateGroups(outboxIntents, ["tenantKey", "operationId", "intentKey"], session, maxTimeMS),
    results.countDocuments({}, { ...primaryMajority, session, maxTimeMS }),
    countInvalidResultIdentities(results, session, maxTimeMS),
    duplicateGroups(results, ["tenantKey", "id"], session, maxTimeMS),
    duplicateGroups(results, ["tenantKey", "idempotencyKey"], session, maxTimeMS),
    resultVivaSyncOutbox.countDocuments({}, { ...primaryMajority, session, maxTimeMS }),
    countInvalidProviderOutboxIdentities(resultVivaSyncOutbox, results, session, maxTimeMS),
    duplicateGroups(resultVivaSyncOutbox, ["tenantKey", "id"], session, maxTimeMS),
    duplicateGroups(cleanupReconciliationIntents, ["tenantKey", "intentId"], session, maxTimeMS),
  ]);

  return {
    gameCount,
    invalidRevisionCount,
    invalidGameIdentityCount,
    mappingCount,
    invalidMappingCount,
    duplicateCanonicalCount: duplicateCanonical.length,
    duplicateLegacyCount: duplicateLegacy.length,
    normalizedCanonicalAliasCount,
    normalizedLegacyAliasCount,
    duplicateGameIdentityCount: duplicateGames.length,
    duplicateCommandKeyCount: duplicateCommandKeys.length,
    duplicateOperationIdCount: duplicateOperationIds.length,
    duplicateAuditIntentCount: duplicateAuditIntents.length,
    duplicateOutboxIntentCount: duplicateOutboxIntents.length,
    resultCount,
    invalidResultIdentityCount,
    duplicateResultIdentityCount: duplicateResults.length,
    duplicateResultIdempotencyKeyCount: duplicateResultIdempotencyKeys.length,
    providerOutboxCount,
    invalidProviderOutboxIdentityCount,
    duplicateProviderOutboxIdentityCount: duplicateProviderOutboxIdentities.length,
    duplicateCleanupReconciliationIntentCount: duplicateCleanupReconciliationIntents.length,
    duplicateSamplesTruncated: [
      duplicateGames,
      duplicateCanonical,
      duplicateLegacy,
      duplicateCommandKeys,
      duplicateOperationIds,
      duplicateAuditIntents,
      duplicateOutboxIntents,
      duplicateResults,
      duplicateResultIdempotencyKeys,
      duplicateProviderOutboxIdentities,
      duplicateCleanupReconciliationIntents,
    ].some((items) => items.length === 20),
  };
}

export function buildLegacyPrerequisiteRollbackPlan() {
  return {
    automaticRollback: false,
    reason: "Revision may be incremented after cutover and identity mappings are append-only evidence; blind rollback is unsafe.",
    steps: [
      "Disable every future command-gateway caller before changing persistence.",
      "Keep revision values in lk_games; do not unset a concurrency token used by writers.",
      "Revoke incorrect mappings instead of deleting or remapping them.",
      "Drop only prerequisite indexes after confirming no deployed code depends on them.",
      "Preserve command ledger, audit intents, and outbox intents as forensic records.",
      "Preserve result side-effect outbox and cleanup reconciliation intents until every sink is terminal.",
      "Preserve production migration execution receipts and investigate any APPLYING or FAILED receipt before retry.",
    ],
  };
}

export function assertLocalApplyAllowed(options) {
  if (options.mode !== "apply") return;
  if (options.environment !== "local" && options.environment !== "test") {
    throw new Error("Production and shared-environment apply are forbidden by this source-only task");
  }
  if (!options.confirmLocalApply) throw new Error("Local apply requires --confirm-local-apply");
  if (!LOCAL_DATABASE_PATTERN.test(options.databaseName || "")) {
    throw new Error("Local apply requires a database name containing local, test, or dev");
  }
  if (!UUID_PATTERN.test(String(options.localTargetId || ""))) {
    throw new Error("Local apply requires a UUID --local-target-id bound to a pre-existing database sentinel");
  }
  const mongoUri = String(options.mongoUri || "");
  if (!mongoUri.startsWith("mongodb://") || mongoUri.startsWith("mongodb+srv://")) {
    throw new Error("Local apply requires a direct mongodb:// loopback URI");
  }
  const authority = mongoUri.slice("mongodb://".length).split("/")[0].split("@").at(-1);
  if (!authority || authority.includes(",")) throw new Error("Local apply requires exactly one loopback Mongo host");
  const parsed = new URL(`http://${authority}`);
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!(hostname === "localhost" || hostname === "::1" || /^127(?:\.\d{1,3}){3}$/.test(hostname))) {
    throw new Error("Local apply requires a loopback Mongo destination");
  }
}

export async function assertLocalDestination(db, options) {
  assertLocalApplyAllowed(options);
  if (db.databaseName !== options.databaseName) throw new Error("Connected database name does not match the approved local target");
  const sentinel = await db.collection(LOCAL_MIGRATION_SENTINEL_COLLECTION).findOne({
    _id: LOCAL_MIGRATION_SENTINEL_ID,
    databaseName: options.databaseName,
    localTargetId: options.localTargetId,
    purpose: "DISPOSABLE_LEGACY_COMMAND_PREREQUISITE_TEST",
  });
  if (!sentinel) throw new Error("Local apply destination sentinel is missing or does not match");
}

export const auditHasBlockingFindings = (audit) => [
  "invalidGameIdentityCount",
  "invalidMappingCount",
  "duplicateGameIdentityCount",
  "duplicateCanonicalCount",
  "duplicateLegacyCount",
  "normalizedCanonicalAliasCount",
  "normalizedLegacyAliasCount",
  "duplicateCommandKeyCount",
  "duplicateOperationIdCount",
  "duplicateAuditIntentCount",
  "duplicateOutboxIntentCount",
  "invalidResultIdentityCount",
  "duplicateResultIdentityCount",
  "duplicateResultIdempotencyKeyCount",
  "invalidProviderOutboxIdentityCount",
  "duplicateProviderOutboxIdentityCount",
  "duplicateCleanupReconciliationIntentCount",
].some((field) => audit[field] > 0);

export async function applyLegacyCommandPrerequisites(db, options) {
  await assertLocalDestination(db, options);
  const before = await auditLegacyCommandPrerequisites(db);
  if (auditHasBlockingFindings(before)) {
    throw new Error("Legacy game identity, mapping, ledger, or intent collections are not safe for unique index creation");
  }

  const revisionResult = await db.collection(LEGACY_COMMAND_COLLECTIONS.games).updateMany(
    invalidRevisionFilter(),
    { $set: { revision: 1 } },
    { writeConcern: { w: "majority" }, maxTimeMS: 120_000 },
  );
  if (!revisionResult.acknowledged) throw new Error("Revision backfill was not majority acknowledged");
  for (const [logicalName, specs] of Object.entries(LEGACY_COMMAND_INDEX_SPECS)) {
    const collectionName = LEGACY_COMMAND_COLLECTIONS[logicalName];
    const collection = db.collection(collectionName);
    for (const spec of specs) {
      const { key, ...indexOptions } = spec;
      await collection.createIndex(key, {
        ...indexOptions,
        writeConcern: { w: "majority" },
        maxTimeMS: 120_000,
      });
    }
  }
  const after = await auditLegacyCommandPrerequisites(db);
  if (after.invalidRevisionCount || auditHasBlockingFindings(after)) {
    throw new Error("Postcheck failed after local prerequisite migration");
  }
  return {
    before,
    revisionMatchedCount: revisionResult.matchedCount,
    revisionModifiedCount: revisionResult.modifiedCount,
    after,
  };
}

export async function verifyIndexes(db) {
  const mismatches = [];
  for (const [logicalName, specs] of Object.entries(LEGACY_COMMAND_INDEX_SPECS)) {
    const collectionName = LEGACY_COMMAND_COLLECTIONS[logicalName];
    const existing = await db.collection(collectionName).indexes().catch((error) => {
      if (error?.codeName === "NamespaceNotFound") return [];
      throw error;
    });
    const byName = new Map(existing.map((item) => [item.name, item]));
    for (const spec of specs) {
      const actual = byName.get(spec.name);
      if (!actual) {
        mismatches.push(`${collectionName}.${spec.name}:missing`);
        continue;
      }
      const expectedKeys = Object.entries(spec.key);
      const actualKeys = Object.entries(actual.key || {});
      if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
        mismatches.push(`${collectionName}.${spec.name}:keys`);
      }
      if (Boolean(actual.unique) !== Boolean(spec.unique)) {
        mismatches.push(`${collectionName}.${spec.name}:unique`);
      }
      for (const option of ["sparse", "partialFilterExpression", "collation", "expireAfterSeconds", "hidden"]) {
        if (Object.prototype.hasOwnProperty.call(actual, option)) {
          mismatches.push(`${collectionName}.${spec.name}:${option}`);
        }
      }
    }
  }
  return mismatches;
}

export async function runLegacyPrerequisiteMode(db, options) {
  if (options.mode === "rollback-plan") return { mode: options.mode, rollback: buildLegacyPrerequisiteRollbackPlan() };
  const audit = await auditLegacyCommandPrerequisites(db);
  if (options.mode === "audit" || options.mode === "dry-run") {
    return {
      mode: options.mode,
      audit,
      plannedRevisionBackfillCount: audit.invalidRevisionCount,
      plannedIndexes: Object.values(LEGACY_COMMAND_INDEX_SPECS).flat().map((spec) => spec.name),
      mutationsPerformed: false,
    };
  }
  if (options.mode === "apply") {
    return { mode: options.mode, ...(await applyLegacyCommandPrerequisites(db, options)), mutationsPerformed: true };
  }
  const indexMismatches = await verifyIndexes(db);
  if (audit.invalidRevisionCount || auditHasBlockingFindings(audit) || indexMismatches.length) {
    throw new Error(`Postcheck failed: invalid revisions=${audit.invalidRevisionCount}, index mismatches=${indexMismatches.join(",") || "none"}`);
  }
  return { mode: options.mode, audit, indexMismatches, mutationsPerformed: false };
}

async function main(argv) {
  const options = parseLegacyPrerequisiteArgs(argv);
  if (options.mode === "rollback-plan") {
    console.log(JSON.stringify(await runLegacyPrerequisiteMode(null, options), null, 2));
    return;
  }
  const mongoUri = process.env.LK_LEGACY_COMMAND_MONGO_URI;
  const databaseName = options.database || process.env.LK_LEGACY_COMMAND_MONGO_DB;
  if (!mongoUri || !databaseName) throw new Error("LK_LEGACY_COMMAND_MONGO_URI and database are required");
  options.databaseName = databaseName;
  options.mongoUri = mongoUri;
  assertLocalApplyAllowed(options);
  const client = new MongoClient(mongoUri, {
    readPreference: "primary",
    serverSelectionTimeoutMS: 10_000,
  });
  try {
    await client.connect();
    const result = await runLegacyPrerequisiteMode(client.db(databaseName), options);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await client.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
