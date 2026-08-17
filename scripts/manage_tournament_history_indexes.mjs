#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { MongoClient } from "mongodb";

export const TOURNAMENT_HISTORY_DB = "games";
export const TOURNAMENT_HISTORY_COLLECTION = "lk_community_feed";
export const TOURNAMENT_HISTORY_MONGO_CONFIG_ID = "lk_tournament_history_mongo_20260719";
export const TOURNAMENT_HISTORY_INDEX_CONFIRM = "CONFIRM_LK_COMMUNITY_FEED";
export const TOURNAMENT_HISTORY_TEST_MODE_CONFIRM = "CONFIRM_ISOLATED_DB";

export const TOURNAMENT_HISTORY_LOOKUP_FIELDS = Object.freeze([
  Object.freeze({ field: "relatedTournamentId", indexName: "lk_feed_tournament_related_active" }),
  Object.freeze({ field: "tournamentId", indexName: "lk_feed_tournament_id_active" }),
  Object.freeze({ field: "details.relatedTournamentId", indexName: "lk_feed_tournament_details_related_active" }),
  Object.freeze({ field: "details.publicTournament.exerciseId", indexName: "lk_feed_tournament_public_exercise_active" }),
  Object.freeze({ field: "details.publicTournament.tournamentId", indexName: "lk_feed_tournament_public_tournament_active" }),
]);

export const TOURNAMENT_HISTORY_INDEX_SPECS = Object.freeze(
  TOURNAMENT_HISTORY_LOOKUP_FIELDS.map(({ field, indexName }) => Object.freeze({
    key: Object.freeze({ [field]: 1, archived: 1 }),
    options: Object.freeze({
      name: indexName,
      partialFilterExpression: Object.freeze({
        kind: "TOURNAMENT",
      }),
    }),
  })),
);

const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
  );
};

export const stableStringify = (value) => JSON.stringify(stableValue(value));
export const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

const normalizedIndex = (index) => ({
  name: String(index?.name || ""),
  key: stableValue(index?.key || {}),
  unique: index?.unique === true,
  sparse: index?.sparse === true,
  hidden: index?.hidden === true,
  expireAfterSeconds: Number.isFinite(index?.expireAfterSeconds)
    ? Number(index.expireAfterSeconds)
    : null,
  collation: index?.collation ? stableValue(index.collation) : null,
  partialFilterExpression: index?.partialFilterExpression
    ? stableValue(index.partialFilterExpression)
    : null,
});

const normalizedSpec = (spec) => ({
  name: spec.options.name,
  key: stableValue(spec.key),
  unique: spec.options.unique === true,
  sparse: spec.options.sparse === true,
  hidden: spec.options.hidden === true,
  expireAfterSeconds: Number.isFinite(spec.options.expireAfterSeconds)
    ? Number(spec.options.expireAfterSeconds)
    : null,
  collation: spec.options.collation ? stableValue(spec.options.collation) : null,
  partialFilterExpression: stableValue(spec.options.partialFilterExpression),
});

export function classifyManagedIndexes(existingIndexes) {
  const normalizedExisting = existingIndexes.map(normalizedIndex);
  const matching = [];
  const missing = [];
  const conflicts = [];

  for (const spec of TOURNAMENT_HISTORY_INDEX_SPECS) {
    const expected = normalizedSpec(spec);
    const sameName = normalizedExisting.find((index) => index.name === expected.name);
    if (sameName) {
      if (isDeepStrictEqual(sameName, expected)) matching.push(expected.name);
      else conflicts.push({ code: "INDEX_NAME_CONFLICT", indexName: expected.name });
      continue;
    }

    const equivalent = normalizedExisting.find((index) => (
      isDeepStrictEqual(index.key, expected.key)
      && index.unique === expected.unique
      && index.sparse === expected.sparse
      && isDeepStrictEqual(index.partialFilterExpression, expected.partialFilterExpression)
    ));
    if (equivalent) {
      conflicts.push({
        code: "EQUIVALENT_INDEX_DIFFERENT_NAME",
        indexName: expected.name,
        existingIndexName: equivalent.name,
      });
      continue;
    }
    missing.push(expected.name);
  }

  return { matching, missing, conflicts };
}

export function buildIndexPlanDigest({ serverVersion, serverMajor, existingIndexes }) {
  const payload = {
    schemaVersion: 1,
    serverVersion: String(serverVersion || serverMajor),
    serverMajor: Number(serverMajor),
    namespace: `${TOURNAMENT_HISTORY_DB}.${TOURNAMENT_HISTORY_COLLECTION}`,
    existingIndexes: existingIndexes.map(normalizedIndex).sort((left, right) => left.name.localeCompare(right.name)),
    proposedIndexes: TOURNAMENT_HISTORY_INDEX_SPECS.map(normalizedSpec),
  };
  return sha256(stableStringify(payload));
}

export function buildTournamentHistoryPublicationQuery(tournamentId) {
  const normalizedId = String(tournamentId || "").trim();
  if (!normalizedId) throw new Error("Tournament history probe id is absent");
  return {
    archived: { $ne: true },
    kind: "TOURNAMENT",
    $or: TOURNAMENT_HISTORY_LOOKUP_FIELDS.map(({ field }) => ({ [field]: normalizedId })),
  };
}

const visitPlan = (value, stages, indexes) => {
  if (!value || typeof value !== "object") return;
  if (typeof value.stage === "string") stages.add(value.stage);
  if (typeof value.indexName === "string") indexes.add(value.indexName);
  Object.values(value).forEach((nested) => visitPlan(nested, stages, indexes));
};

export function summarizeExplain(explain) {
  const stages = new Set();
  const indexes = new Set();
  visitPlan(explain?.queryPlanner?.winningPlan, stages, indexes);
  const execution = explain?.executionStats || {};
  return {
    stages: [...stages].sort(),
    indexes: [...indexes].sort(),
    nReturned: Number(execution.nReturned || 0),
    totalKeysExamined: Number(execution.totalKeysExamined || 0),
    totalDocsExamined: Number(execution.totalDocsExamined || 0),
    executionTimeMillis: Number(execution.executionTimeMillis || 0),
    rejectedPlans: Array.isArray(explain?.queryPlanner?.rejectedPlans)
      ? explain.queryPlanner.rejectedPlans.length
      : 0,
  };
}

const getPath = (source, dottedPath) => dottedPath.split(".").reduce(
  (current, key) => (current && typeof current === "object" ? current[key] : undefined),
  source,
);

export async function selectTournamentHistoryProbe(collection) {
  const projection = Object.fromEntries(
    TOURNAMENT_HISTORY_LOOKUP_FIELDS.map(({ field }) => [field, 1]),
  );
  const row = await collection.findOne({
    kind: "TOURNAMENT",
    archived: { $ne: true },
    $or: TOURNAMENT_HISTORY_LOOKUP_FIELDS.map(({ field }) => ({ [field]: { $type: "string" } })),
  }, { projection, maxTimeMS: 5_000 });

  for (const { field } of TOURNAMENT_HISTORY_LOOKUP_FIELDS) {
    const value = getPath(row, field);
    if (typeof value === "string" && value.trim()) {
      return {
        value: value.trim(),
        sourceField: field,
        hash: sha256(value.trim()).slice(0, 12),
      };
    }
  }
  return {
    value: "00000000-0000-0000-0000-000000000000",
    sourceField: null,
    hash: sha256("00000000-0000-0000-0000-000000000000").slice(0, 12),
  };
}

export async function explainTournamentHistoryQuery(collection, probeId) {
  const explain = await collection
    .find(buildTournamentHistoryPublicationQuery(probeId), { limit: 50, maxTimeMS: 5_000 })
    .explain("executionStats");
  return summarizeExplain(explain);
}

export async function applyTournamentHistoryIndexes(collection, indexNames = null) {
  const requested = indexNames ? new Set(indexNames) : null;
  const specs = TOURNAMENT_HISTORY_INDEX_SPECS
    .filter((spec) => !requested || requested.has(spec.options.name))
    .map((spec) => ({ key: spec.key, ...spec.options }));
  if (specs.length === 0) return [];
  await collection.createIndexes(specs, { maxTimeMS: 120_000 });
  return specs.map((spec) => spec.name);
}

export async function cleanupNewTournamentHistoryIndexes(collection, indexNames) {
  const currentIndexes = await collection.listIndexes().toArray();
  const currentByName = new Map(currentIndexes.map((index) => [index.name, normalizedIndex(index)]));
  const dropped = [];
  const failures = [];

  for (const indexName of [...indexNames].reverse()) {
    const spec = TOURNAMENT_HISTORY_INDEX_SPECS.find((item) => item.options.name === indexName);
    const current = currentByName.get(indexName);
    if (!spec || !current || !isDeepStrictEqual(current, normalizedSpec(spec))) continue;
    try {
      await collection.dropIndex(indexName);
      dropped.push(indexName);
    } catch {
      failures.push(indexName);
    }
  }
  return { dropped, failures };
}

const exactProtectedFile = (filePath) => {
  const absolutePath = path.resolve(String(filePath || ""));
  const stat = fs.lstatSync(absolutePath);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error("Protected flow path must be a private regular file");
  }
  return absolutePath;
};

const readConnectionFromFlow = (flowPath) => {
  const absolutePath = exactProtectedFile(flowPath);
  const flow = JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  if (!Array.isArray(flow)) throw new Error("Node-RED flow must be an array");
  const matches = flow.filter((node) => node?.id === TOURNAMENT_HISTORY_MONGO_CONFIG_ID);
  if (matches.length !== 1) throw new Error("Expected exactly one tournament history Mongo config");
  const config = matches[0];
  const uri = typeof config.uri === "string" ? config.uri.trim() : "";
  const dbName = typeof config.dbName === "string" ? config.dbName.trim() : "";
  if (!uri || dbName !== TOURNAMENT_HISTORY_DB) throw new Error("Tournament history Mongo config mismatch");
  return { uri, dbName };
};

const getArg = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : null;
};

const writeReport = (reportPath, report) => {
  if (!reportPath) return;
  const absolutePath = path.resolve(reportPath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, `${JSON.stringify(report, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
};

const printHelp = () => {
  console.log(`Usage:
  node scripts/manage_tournament_history_indexes.mjs plan --flow-path /root/.node-red/flows.json [--out report.json]
  node scripts/manage_tournament_history_indexes.mjs verify --flow-path /root/.node-red/flows.json [--out report.json]
  TOURNAMENT_HISTORY_INDEX_APPLY=${TOURNAMENT_HISTORY_INDEX_CONFIRM} \\
    node scripts/manage_tournament_history_indexes.mjs apply \\
      --flow-path /root/.node-red/flows.json \\
      --expected-plan-digest <sha256> [--out report.json]

For isolated tests only, TOURNAMENT_HISTORY_INDEX_TEST_MODE=${TOURNAMENT_HISTORY_TEST_MODE_CONFIRM}
and MONGO_URI may replace --flow-path for plan or verify. apply always requires
the protected flow path. The URI is never included in reports. plan and verify
are read-only. apply requires the exact current catalog digest and creates only
missing managed indexes.`);
};

const readRuntimeContext = async (db, collection) => {
  const buildInfo = await db.command({ buildInfo: 1 });
  const serverMajor = Number.parseInt(String(buildInfo.version || "").split(".")[0], 10);
  if (!Number.isFinite(serverMajor) || serverMajor < 7) {
    throw new Error("MongoDB 7 or newer is required for this reviewed migration");
  }
  const existingIndexes = await collection.listIndexes().toArray();
  const classification = classifyManagedIndexes(existingIndexes);
  const probe = await selectTournamentHistoryProbe(collection);
  const explain = await explainTournamentHistoryQuery(collection, probe.value);
  return {
    serverVersion: String(buildInfo.version || "unknown"),
    serverMajor,
    existingIndexes,
    classification,
    planDigest: buildIndexPlanDigest({
      serverVersion: String(buildInfo.version || "unknown"),
      serverMajor,
      existingIndexes,
    }),
    probe: { sourceField: probe.sourceField, hash: probe.hash },
    probeValue: probe.value,
    explain,
  };
};

const publicContext = (context) => ({
  serverVersion: context.serverVersion,
  namespace: `${TOURNAMENT_HISTORY_DB}.${TOURNAMENT_HISTORY_COLLECTION}`,
  planDigest: context.planDigest,
  managedIndexes: context.classification,
  probe: context.probe,
  explain: context.explain,
});

export async function runCli() {
  const command = process.argv[2];
  if (!command || command === "--help" || command === "help") {
    printHelp();
    return;
  }
  if (!["plan", "verify", "apply"].includes(command)) throw new Error("Unknown command");

  const expectedPlanDigest = String(getArg("--expected-plan-digest") || "").trim().toLowerCase();
  if (command === "apply") {
    if (process.env.TOURNAMENT_HISTORY_INDEX_APPLY !== TOURNAMENT_HISTORY_INDEX_CONFIRM) {
      throw new Error("Apply confirmation is absent");
    }
    if (!/^[a-f0-9]{64}$/.test(expectedPlanDigest)) {
      throw new Error("Expected plan digest is absent or invalid");
    }
  }

  const flowPath = getArg("--flow-path");
  if (command === "apply" && !flowPath) {
    throw new Error("Apply requires a protected --flow-path");
  }
  if (!flowPath && process.env.TOURNAMENT_HISTORY_INDEX_TEST_MODE !== TOURNAMENT_HISTORY_TEST_MODE_CONFIRM) {
    throw new Error("MONGO_URI requires explicit isolated test mode");
  }
  const connection = flowPath
    ? readConnectionFromFlow(flowPath)
    : { uri: String(process.env.MONGO_URI || "").trim(), dbName: TOURNAMENT_HISTORY_DB };
  if (!connection.uri) throw new Error("Provide a protected --flow-path or MONGO_URI");

  const client = new MongoClient(connection.uri, {
    appName: `PadlHubTournamentHistoryIndexes:${command}`,
    maxPoolSize: 1,
    serverSelectionTimeoutMS: 10_000,
  });
  let report;
  try {
    await client.connect();
    const db = client.db(connection.dbName);
    const collection = db.collection(TOURNAMENT_HISTORY_COLLECTION);
    const before = await readRuntimeContext(db, collection);

    if (command === "plan") {
      report = { schemaVersion: 1, mode: "PLAN", readyForApply: before.classification.conflicts.length === 0, ...publicContext(before) };
    } else if (command === "verify") {
      const verified = before.classification.missing.length === 0
        && before.classification.conflicts.length === 0
        && !before.explain.stages.includes("COLLSCAN")
        && TOURNAMENT_HISTORY_INDEX_SPECS.every((spec) => before.explain.indexes.includes(spec.options.name));
      report = { schemaVersion: 1, mode: "VERIFY", verified, ...publicContext(before) };
      if (!verified) process.exitCode = 3;
    } else {
      if (expectedPlanDigest !== before.planDigest) {
        throw new Error("Index catalog plan digest mismatch");
      }
      if (before.classification.conflicts.length > 0) throw new Error("Managed index conflicts must be reviewed");

      const createdNames = [];
      try {
        createdNames.push(...await applyTournamentHistoryIndexes(collection, before.classification.missing));
        const after = await readRuntimeContext(db, collection);
        const verified = after.classification.missing.length === 0
          && after.classification.conflicts.length === 0
          && !after.explain.stages.includes("COLLSCAN")
          && TOURNAMENT_HISTORY_INDEX_SPECS.every((spec) => after.explain.indexes.includes(spec.options.name));
        if (!verified) throw new Error("Post-apply query plan verification failed");
        report = {
          schemaVersion: 1,
          mode: "APPLY",
          applied: true,
          createdIndexes: createdNames,
          before: publicContext(before),
          after: publicContext(after),
        };
      } catch (error) {
        const cleanup = await cleanupNewTournamentHistoryIndexes(
          collection,
          before.classification.missing,
        );
        if (cleanup.failures.length > 0) throw new Error("Index apply failed and automatic cleanup was incomplete");
        const cleanupResult = cleanup.dropped.length > 0
          ? "newly created indexes were removed"
          : "no pre-existing indexes were changed";
        throw new Error(`Index apply failed; ${cleanupResult}: ${error.message}`);
      }
    }
  } finally {
    await client.close();
  }

  writeReport(getArg("--out"), report);
  console.log(JSON.stringify(report, null, 2));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) runCli().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error?.message || "Unknown error" }));
  process.exit(1);
});
