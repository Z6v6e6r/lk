#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import mongodb from "mongodb";
import mongodbPackage from "mongodb/package.json" with { type: "json" };

const { MongoClient } = mongodb;
const mongoDriverVersion = String(mongodbPackage.version || "");

export const LK_GAMES_LOOKUP_DB = "games";
export const LK_GAMES_LOOKUP_COLLECTION = "lk_games";
export const LK_GAMES_LOOKUP_MONGO_CONFIG_ID = "4e820638cc39c730";
export const LK_GAMES_LOOKUP_MONGO_NODE_ID = "77859abc9f190e6b";
export const LK_GAMES_LOOKUP_INDEX_NAME = "lk_games_payment_booking_lookup_wildcard_v1";
export const LK_GAMES_LOOKUP_QUERY_SHA256 = "2535de7d1219cc56fe4eb752c5b4df14f9f4dc1f8f2443a0b29422fb3af990ee";
export const LK_GAMES_LOOKUP_MONGODB_DRIVER_VERSION = "7.2.0";
export const LK_GAMES_LOOKUP_INDEX_CONFIRM = "APPLY_LK_GAMES_LOOKUP_WILDCARD_V1";
export const LK_GAMES_LOOKUP_ROLLBACK_CONFIRM = "ROLLBACK_LK_GAMES_LOOKUP_WILDCARD_V1";
export const LK_GAMES_LOOKUP_TEST_MODE_CONFIRM = "CONFIRM_ISOLATED_LK_GAMES_DB";
export const LK_GAMES_LOOKUP_APPLY_RECEIPT_KIND = "LK_GAMES_LOOKUP_INDEX_APPLY_RECEIPT_V1";

export const LK_GAMES_PAYMENT_LOOKUP_FIELDS = Object.freeze([
  "metadata.paymentRef",
  "metadata.splitPayment.paymentRef",
  "metadata.splitPayment.payments.paymentRef",
  "payment.paymentRef",
]);

export const LK_GAMES_BOOKING_LOOKUP_FIELDS = Object.freeze([
  "booking.bookingIds",
  "booking.bookingId",
  "metadata.bookingIds",
  "metadata.bookingId",
  "metadata.splitPayment.bookingIds",
  "metadata.splitPayment.bookingId",
  "metadata.splitPayment.organizerBookingId",
  "metadata.splitPayment.payments.bookingIds",
  "metadata.splitPayment.payments.bookingId",
  "payment.bookingIds",
  "payment.bookingId",
]);

const wildcardProjection = Object.freeze(Object.fromEntries(
  [...LK_GAMES_PAYMENT_LOOKUP_FIELDS, ...LK_GAMES_BOOKING_LOOKUP_FIELDS]
    .map((field) => [field, 1]),
));

export const LK_GAMES_LOOKUP_INDEX_SPEC = Object.freeze({
  key: Object.freeze({ "$**": 1 }),
  options: Object.freeze({
    name: LK_GAMES_LOOKUP_INDEX_NAME,
    wildcardProjection,
  }),
});

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
  wildcardProjection: index?.wildcardProjection
    ? stableValue(index.wildcardProjection)
    : null,
});

const normalizedSpec = () => normalizedIndex({
  name: LK_GAMES_LOOKUP_INDEX_SPEC.options.name,
  key: LK_GAMES_LOOKUP_INDEX_SPEC.key,
  wildcardProjection: LK_GAMES_LOOKUP_INDEX_SPEC.options.wildcardProjection,
});

export function classifyManagedIndex(existingIndexes) {
  const expected = normalizedSpec();
  const normalizedExisting = existingIndexes.map(normalizedIndex);
  const sameName = normalizedExisting.find((index) => index.name === expected.name);
  if (sameName) {
    return isDeepStrictEqual(sameName, expected)
      ? { matching: [expected.name], missing: [], conflicts: [] }
      : {
          matching: [],
          missing: [],
          conflicts: [{ code: "INDEX_NAME_CONFLICT", indexName: expected.name }],
        };
  }

  const equivalent = normalizedExisting.find((index) => (
    isDeepStrictEqual(index.key, expected.key)
    && isDeepStrictEqual(index.wildcardProjection, expected.wildcardProjection)
  ));
  if (equivalent) {
    return {
      matching: [],
      missing: [],
      conflicts: [{
        code: "EQUIVALENT_INDEX_DIFFERENT_NAME",
        indexName: expected.name,
        existingIndexName: equivalent.name,
      }],
    };
  }
  return { matching: [], missing: [expected.name], conflicts: [] };
}

export function buildIndexPlanDigest({
  serverVersion,
  serverMajor,
  queryBinding,
  targetFingerprint,
  existingIndexes,
}) {
  return sha256(stableStringify({
    schemaVersion: 2,
    serverVersion: String(serverVersion || serverMajor),
    serverMajor: Number(serverMajor),
    namespace: `${LK_GAMES_LOOKUP_DB}.${LK_GAMES_LOOKUP_COLLECTION}`,
    queryBinding: stableValue(queryBinding || {}),
    targetFingerprint: String(targetFingerprint || ""),
    existingIndexes: existingIndexes
      .map(normalizedIndex)
      .sort((left, right) => left.name.localeCompare(right.name)),
    proposedIndex: normalizedSpec(),
  }));
}

export function buildPaymentLookupQuery(paymentRef) {
  const normalized = String(paymentRef || "").trim();
  if (!normalized) throw new Error("Payment lookup probe is absent");
  return {
    archived: { $ne: true },
    $or: LK_GAMES_PAYMENT_LOOKUP_FIELDS.map((field) => ({ [field]: normalized })),
  };
}

export function buildBookingLookupQuery(bookingId) {
  const normalized = (Array.isArray(bookingId) ? bookingId : [bookingId])
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  if (normalized.length === 0) throw new Error("Booking lookup probe is absent");
  return {
    archived: { $ne: true },
    $or: LK_GAMES_BOOKING_LOOKUP_FIELDS.map((field) => ({
      [field]: { $in: normalized },
    })),
  };
}

export function buildCombinedLookupQuery(paymentRef, bookingIds) {
  const paymentQuery = buildPaymentLookupQuery(paymentRef);
  const bookingQuery = buildBookingLookupQuery(bookingIds);
  return {
    archived: { $ne: true },
    $or: [...paymentQuery.$or, ...bookingQuery.$or],
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

const pathValues = (root, dottedPath) => {
  let values = [root];
  for (const key of dottedPath.split(".")) {
    values = values.flatMap((value) => {
      if (Array.isArray(value)) {
        return value.flatMap((item) => (
          item && typeof item === "object" ? [item[key]] : []
        ));
      }
      return value && typeof value === "object" ? [value[key]] : [];
    }).flat();
  }
  return values.flat(Infinity).filter((value) => (
    typeof value === "string" && value.trim()
  ));
};

export async function selectLookupProbe(collection, fields, label) {
  const projection = Object.fromEntries(fields.map((field) => [field, 1]));
  const row = await collection.findOne({
    archived: { $ne: true },
    $or: fields.map((field) => ({ [field]: { $type: "string" } })),
  }, { projection, maxTimeMS: 5_000 });

  for (const field of fields) {
    const value = pathValues(row, field)[0];
    if (value) {
      return { value, sourceField: field, hash: sha256(value).slice(0, 12) };
    }
  }
  const fallback = `lk-games-${label}-probe-not-found`;
  return { value: fallback, sourceField: null, hash: sha256(fallback).slice(0, 12) };
}

export async function explainLookupQuery(collection, query) {
  const explain = await collection
    .find(query)
    .limit(1000)
    .maxTimeMS(5_000)
    .explain("executionStats");
  return summarizeExplain(explain);
}

export async function applyLookupIndex(db) {
  const result = await db.command({
    createIndexes: LK_GAMES_LOOKUP_COLLECTION,
    indexes: [{
      key: LK_GAMES_LOOKUP_INDEX_SPEC.key,
      ...LK_GAMES_LOOKUP_INDEX_SPEC.options,
    }],
    maxTimeMS: 600_000,
  });
  const numIndexesBefore = Number(result?.numIndexesBefore);
  const numIndexesAfter = Number(result?.numIndexesAfter);
  if (!Number.isFinite(numIndexesBefore) || !Number.isFinite(numIndexesAfter)) {
    throw new Error("createIndexes did not return index-count provenance");
  }
  return {
    indexName: LK_GAMES_LOOKUP_INDEX_NAME,
    created: numIndexesAfter === numIndexesBefore + 1,
    numIndexesBefore,
    numIndexesAfter,
  };
}

export async function cleanupNewLookupIndex(collection, shouldCleanup) {
  if (!shouldCleanup) return { dropped: [], failures: [] };
  const indexes = await collection.listIndexes().toArray();
  const exact = indexes.find((index) => (
    index.name === LK_GAMES_LOOKUP_INDEX_NAME
    && isDeepStrictEqual(normalizedIndex(index), normalizedSpec())
  ));
  if (!exact) return { dropped: [], failures: [] };
  try {
    await collection.dropIndex(LK_GAMES_LOOKUP_INDEX_NAME);
    return { dropped: [LK_GAMES_LOOKUP_INDEX_NAME], failures: [] };
  } catch {
    return { dropped: [], failures: [LK_GAMES_LOOKUP_INDEX_NAME] };
  }
}

const opaqueValue = (value) => {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) return value.toString("base64");
  if (typeof value.toHexString === "function") return value.toHexString();
  if (value.buffer) {
    try { return Buffer.from(value.buffer).toString("base64"); } catch { /* continue */ }
  }
  const rendered = String(value);
  return rendered === "[object Object]" ? stableStringify(value) : rendered;
};

export async function readTargetIdentity(db, connectionFingerprint) {
  const [hello, collectionInfo] = await Promise.all([
    db.admin().command({ hello: 1 }),
    db.listCollections(
      { name: LK_GAMES_LOOKUP_COLLECTION },
      { nameOnly: false },
    ).next(),
  ]);
  const collectionUuid = collectionInfo?.info?.uuid;
  if (!collectionUuid) throw new Error("Collection UUID is unavailable");
  const collectionUuidFingerprint = sha256(opaqueValue(collectionUuid));
  const topologyFingerprint = sha256(stableStringify({
    setName: String(hello?.setName || ""),
    topologyProcessId: opaqueValue(hello?.topologyVersion?.processId),
    serviceId: opaqueValue(hello?.serviceId),
    msg: String(hello?.msg || ""),
  }));
  return {
    collectionUuidFingerprint,
    topologyFingerprint,
    targetFingerprint: sha256(stableStringify({
      connectionFingerprint: String(connectionFingerprint || ""),
      namespace: `${LK_GAMES_LOOKUP_DB}.${LK_GAMES_LOOKUP_COLLECTION}`,
      collectionUuidFingerprint,
      topologyFingerprint,
    })),
  };
}

const exactProtectedFile = (filePath) => {
  const absolutePath = path.resolve(String(filePath || ""));
  const stat = fs.lstatSync(absolutePath);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error("Protected flow path must be a private regular file");
  }
  return absolutePath;
};

export function inspectFlowBinding(flow) {
  if (!Array.isArray(flow)) throw new Error("Node-RED flow must be an array");
  const configs = flow.filter((node) => node?.id === LK_GAMES_LOOKUP_MONGO_CONFIG_ID);
  if (configs.length !== 1) throw new Error("Expected exactly one games Mongo config");
  const config = configs[0];
  const uri = typeof config.uri === "string" ? config.uri.trim() : "";
  const dbName = typeof config.dbName === "string" ? config.dbName.trim() : "";
  if (!uri || dbName !== LK_GAMES_LOOKUP_DB) throw new Error("Games Mongo config mismatch");

  const routes = flow.filter((node) => (
    node?.type === "http in"
    && node.method === "get"
    && node.url === "/lk/games"
  ));
  if (routes.length !== 1) throw new Error("Expected exactly one GET /lk/games route");
  const byId = new Map(flow.filter((node) => node?.id).map((node) => [node.id, node]));
  const queue = [routes[0].id];
  const visited = new Set();
  const functions = [];
  const mongoNodes = [];
  while (queue.length > 0) {
    const id = queue.shift();
    if (visited.has(id)) continue;
    visited.add(id);
    const node = byId.get(id);
    if (!node) continue;
    if (node.type === "function" && typeof node.func === "string") functions.push(node);
    if (node.type === "mongodb4") mongoNodes.push(node);
    for (const group of Array.isArray(node.wires) ? node.wires : []) {
      for (const target of Array.isArray(group) ? group : []) queue.push(target);
    }
  }
  const queryFunctions = functions.filter((node) => (
    node.func.includes("msg._lkPaymentRef")
    && node.func.includes("msg._lkBookingIds")
    && node.func.includes("metadata.splitPayment.payments.paymentRef")
  ));
  if (queryFunctions.length !== 1) throw new Error("Expected exactly one reachable games lookup query function");
  const queryFunction = queryFunctions[0];
  const querySha256 = sha256(queryFunction.func);
  if (querySha256 !== LK_GAMES_LOOKUP_QUERY_SHA256) {
    throw new Error("Games lookup query function SHA mismatch");
  }
  if (mongoNodes.length !== 1) throw new Error("Expected exactly one reachable games Mongo find node");
  const mongoNode = mongoNodes[0];
  if (mongoNode.id !== LK_GAMES_LOOKUP_MONGO_NODE_ID
    || mongoNode.collection !== LK_GAMES_LOOKUP_COLLECTION
    || mongoNode.operation !== "find"
    || mongoNode.output !== "toArray"
    || mongoNode.clientNode !== LK_GAMES_LOOKUP_MONGO_CONFIG_ID) {
    throw new Error("Reachable games Mongo find node binding mismatch");
  }
  return {
    uri,
    dbName,
    connectionFingerprint: sha256(uri),
    binding: {
      routeId: routes[0].id,
      queryFunctionId: queryFunction.id,
      queryFunctionSha256: querySha256,
      mongoConfigId: LK_GAMES_LOOKUP_MONGO_CONFIG_ID,
      mongoNodeId: mongoNode.id,
      mongoCollection: mongoNode.collection,
      mongoOperation: mongoNode.operation,
      mongoOutput: mongoNode.output,
    },
  };
}

const readConnectionFromFlow = (flowPath) => {
  const absolutePath = exactProtectedFile(flowPath);
  return inspectFlowBinding(JSON.parse(fs.readFileSync(absolutePath, "utf8")));
};

const runtimeVerified = (context) => (
  context.classification.missing.length === 0
  && context.classification.conflicts.length === 0
  && [context.paymentExplain, context.bookingExplain, context.combinedExplain].every((explain) => (
    !explain.stages.includes("COLLSCAN")
    && explain.stages.includes("IXSCAN")
    && explain.indexes.includes(LK_GAMES_LOOKUP_INDEX_NAME)
  ))
);

const readRuntimeContext = async (db, collection, connection) => {
  const [buildInfo, existingIndexes, stats, paymentProbe, bookingProbe, targetIdentity] = await Promise.all([
    db.command({ buildInfo: 1 }),
    collection.listIndexes().toArray(),
    db.command({ collStats: LK_GAMES_LOOKUP_COLLECTION, scale: 1, maxTimeMS: 10_000 }),
    selectLookupProbe(collection, LK_GAMES_PAYMENT_LOOKUP_FIELDS, "payment"),
    selectLookupProbe(collection, LK_GAMES_BOOKING_LOOKUP_FIELDS, "booking"),
    readTargetIdentity(db, connection.connectionFingerprint),
  ]);
  const serverMajor = Number.parseInt(String(buildInfo.version || "").split(".")[0], 10);
  if (!Number.isFinite(serverMajor) || serverMajor < 7) {
    throw new Error("MongoDB 7 or newer is required for the projected wildcard index");
  }
  const secondBookingProbe = `lk-games-booking-secondary-${bookingProbe.hash}`;
  const [paymentExplain, bookingExplain, combinedExplain] = await Promise.all([
    explainLookupQuery(collection, buildPaymentLookupQuery(paymentProbe.value)),
    explainLookupQuery(collection, buildBookingLookupQuery([bookingProbe.value, secondBookingProbe])),
    explainLookupQuery(
      collection,
      buildCombinedLookupQuery(paymentProbe.value, [bookingProbe.value, secondBookingProbe]),
    ),
  ]);
  const classification = classifyManagedIndex(existingIndexes);
  return {
    serverVersion: String(buildInfo.version || "unknown"),
    serverMajor,
    existingIndexes,
    classification,
    planDigest: buildIndexPlanDigest({
      serverVersion: String(buildInfo.version || "unknown"),
      serverMajor,
      queryBinding: connection.binding,
      targetFingerprint: targetIdentity.targetFingerprint,
      existingIndexes,
    }),
    binding: connection.binding,
    targetIdentity,
    stats: {
      count: Number(stats.count || 0),
      sizeBytes: Number(stats.size || 0),
      storageSizeBytes: Number(stats.storageSize || 0),
      totalIndexSizeBytes: Number(stats.totalIndexSize || 0),
      nindexes: Number(stats.nindexes || 0),
    },
    paymentProbe: { sourceField: paymentProbe.sourceField, hash: paymentProbe.hash },
    bookingProbe: { sourceField: bookingProbe.sourceField, hash: bookingProbe.hash },
    paymentExplain,
    bookingExplain,
    combinedExplain,
  };
};

const publicContext = (context) => ({
  serverVersion: context.serverVersion,
  namespace: `${LK_GAMES_LOOKUP_DB}.${LK_GAMES_LOOKUP_COLLECTION}`,
  planDigest: context.planDigest,
  targetFingerprint: context.targetIdentity.targetFingerprint,
  queryBinding: context.binding,
  collectionStats: context.stats,
  managedIndex: context.classification,
  probes: {
    payment: context.paymentProbe,
    booking: context.bookingProbe,
  },
  explains: {
    payment: context.paymentExplain,
    booking: context.bookingExplain,
    combined: context.combinedExplain,
  },
});

const getArg = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : null;
};

const safeErrorMessage = (error) => String(error?.message || "Unknown error")
  .replace(/mongodb(?:\+srv)?:\/\/[^\s]+/gi, "[REDACTED_MONGO_URI]")
  .slice(0, 500);

const openReportSink = (reportPath, required = false) => {
  if (!reportPath) {
    if (required) throw new Error("Mutation commands require --out for durable reconciliation evidence");
    return null;
  }
  const absolutePath = path.resolve(reportPath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  const descriptor = fs.openSync(absolutePath, "wx", 0o600);
  return {
    path: absolutePath,
    write(report) {
      const payload = `${JSON.stringify(report, null, 2)}\n`;
      fs.ftruncateSync(descriptor, 0);
      fs.writeSync(descriptor, payload, 0, "utf8");
      fs.fsyncSync(descriptor);
    },
    close() { fs.closeSync(descriptor); },
  };
};

export function buildApplyReceipt({ operationId, before, after, createdIndexes }) {
  const body = {
    kind: LK_GAMES_LOOKUP_APPLY_RECEIPT_KIND,
    schemaVersion: 1,
    operationId: String(operationId),
    indexName: LK_GAMES_LOOKUP_INDEX_NAME,
    createdIndexes: [...createdIndexes],
    beforePlanDigest: before.planDigest,
    afterPlanDigest: after.planDigest,
    targetFingerprint: after.targetIdentity.targetFingerprint,
  };
  return { ...body, receiptDigest: sha256(stableStringify(body)) };
}

export function validateApplyReceipt(report, currentContext) {
  const receipt = report?.applyReceipt;
  if (report?.mode !== "APPLY" || report?.outcome !== "SUCCEEDED" || !receipt) {
    throw new Error("Apply receipt is not a successful apply report");
  }
  const { receiptDigest, ...body } = receipt;
  if (receiptDigest !== sha256(stableStringify(body))) {
    throw new Error("Apply receipt digest mismatch");
  }
  if (body.kind !== LK_GAMES_LOOKUP_APPLY_RECEIPT_KIND
    || body.indexName !== LK_GAMES_LOOKUP_INDEX_NAME
    || !isDeepStrictEqual(body.createdIndexes, [LK_GAMES_LOOKUP_INDEX_NAME])) {
    throw new Error("Apply receipt does not prove ownership of the managed index");
  }
  if (body.afterPlanDigest !== currentContext.planDigest
    || body.targetFingerprint !== currentContext.targetIdentity.targetFingerprint) {
    throw new Error("Apply receipt target/catalog no longer matches current state");
  }
  return receipt;
}

const readApplyReceipt = (receiptPath) => {
  const absolutePath = exactProtectedFile(receiptPath);
  return JSON.parse(fs.readFileSync(absolutePath, "utf8"));
};

const assertMutationBindingUnchanged = async ({ flowPath, connection, before, db }) => {
  const freshConnection = readConnectionFromFlow(flowPath);
  if (freshConnection.dbName !== connection.dbName
    || freshConnection.connectionFingerprint !== connection.connectionFingerprint
    || !isDeepStrictEqual(freshConnection.binding, connection.binding)) {
    throw new Error("Flow or Mongo connection binding drifted before mutation");
  }
  const targetIdentity = await readTargetIdentity(db, connection.connectionFingerprint);
  if (targetIdentity.targetFingerprint !== before.targetIdentity.targetFingerprint) {
    throw new Error("Mongo target identity drifted before mutation");
  }
};

const bestEffortReconciliation = async (db, collection, connection) => {
  try {
    const [existingIndexes, targetIdentity] = await Promise.all([
      collection.listIndexes().toArray(),
      readTargetIdentity(db, connection.connectionFingerprint),
    ]);
    return {
      targetFingerprint: targetIdentity.targetFingerprint,
      managedIndex: classifyManagedIndex(existingIndexes),
      indexNames: existingIndexes.map((index) => String(index?.name || "")).sort(),
    };
  } catch (error) {
    return { unavailable: true, error: safeErrorMessage(error) };
  }
};

const printHelp = () => {
  console.log(`Usage:
  node scripts/manage_lk_games_lookup_index.mjs plan --flow-path /root/.node-red/flows.json [--out report.json]
  node scripts/manage_lk_games_lookup_index.mjs verify --flow-path /root/.node-red/flows.json [--out report.json]
  LK_GAMES_LOOKUP_INDEX_APPLY=${LK_GAMES_LOOKUP_INDEX_CONFIRM} \\
    node scripts/manage_lk_games_lookup_index.mjs apply \\
      --flow-path /root/.node-red/flows.json \\
      --expected-plan-digest <sha256> --out <new-private-report.json>
  LK_GAMES_LOOKUP_INDEX_ROLLBACK=${LK_GAMES_LOOKUP_ROLLBACK_CONFIRM} \\
    node scripts/manage_lk_games_lookup_index.mjs rollback \\
      --flow-path /root/.node-red/flows.json \\
      --expected-plan-digest <sha256> --apply-receipt <successful-apply-report.json> \\
      --out <new-private-report.json>

For isolated tests only, LK_GAMES_LOOKUP_INDEX_TEST_MODE=${LK_GAMES_LOOKUP_TEST_MODE_CONFIRM}
and MONGO_URI may replace --flow-path for plan or verify. apply always requires
the protected production flow path. The URI and raw probe values are never included
in reports. All modes require the exact bundled MongoDB driver ${LK_GAMES_LOOKUP_MONGODB_DRIVER_VERSION}.
plan and verify are read-only. apply and rollback are live schema mutations; each requires
separate operator authorization, its explicit confirmation phrase, durable report path,
and the exact current catalog digest. rollback additionally requires the successful apply
receipt proving that the same operation created the managed index.`);
};

export async function runCli() {
  const command = process.argv[2];
  if (!command || command === "--help" || command === "help") {
    printHelp();
    return;
  }
  if (!["plan", "verify", "apply", "rollback"].includes(command)) throw new Error("Unknown command");
  if (mongoDriverVersion !== LK_GAMES_LOOKUP_MONGODB_DRIVER_VERSION) {
    throw new Error(
      `MongoDB driver ${LK_GAMES_LOOKUP_MONGODB_DRIVER_VERSION} is required; found ${mongoDriverVersion || "unknown"}`,
    );
  }

  const expectedPlanDigest = String(getArg("--expected-plan-digest") || "").trim().toLowerCase();
  if (command === "apply") {
    if (process.env.LK_GAMES_LOOKUP_INDEX_APPLY !== LK_GAMES_LOOKUP_INDEX_CONFIRM) {
      throw new Error("Apply confirmation is absent");
    }
    if (!/^[a-f0-9]{64}$/.test(expectedPlanDigest)) {
      throw new Error("Expected plan digest is absent or invalid");
    }
  }
  if (command === "rollback") {
    if (process.env.LK_GAMES_LOOKUP_INDEX_ROLLBACK !== LK_GAMES_LOOKUP_ROLLBACK_CONFIRM) {
      throw new Error("Rollback confirmation is absent");
    }
    if (!/^[a-f0-9]{64}$/.test(expectedPlanDigest)) {
      throw new Error("Expected plan digest is absent or invalid");
    }
  }

  const flowPath = getArg("--flow-path");
  if (command === "apply" && !flowPath) throw new Error("Apply requires a protected --flow-path");
  if (command === "rollback" && !flowPath) throw new Error("Rollback requires a protected --flow-path");
  const applyReceiptPath = getArg("--apply-receipt");
  if (command === "rollback" && !applyReceiptPath) {
    throw new Error("Rollback requires --apply-receipt");
  }
  if (!flowPath && process.env.LK_GAMES_LOOKUP_INDEX_TEST_MODE !== LK_GAMES_LOOKUP_TEST_MODE_CONFIRM) {
    throw new Error("MONGO_URI requires explicit isolated test mode");
  }
  const connection = flowPath
    ? readConnectionFromFlow(flowPath)
    : {
        uri: String(process.env.MONGO_URI || "").trim(),
        dbName: LK_GAMES_LOOKUP_DB,
        connectionFingerprint: sha256(String(process.env.MONGO_URI || "").trim()),
        binding: {
          routeId: "isolated-test-route",
          queryFunctionId: "isolated-test-query",
          queryFunctionSha256: LK_GAMES_LOOKUP_QUERY_SHA256,
          mongoConfigId: "isolated-test-config",
          mongoNodeId: "isolated-test-mongo",
          mongoCollection: LK_GAMES_LOOKUP_COLLECTION,
          mongoOperation: "find",
          mongoOutput: "toArray",
        },
      };
  if (!connection.uri) throw new Error("Provide a protected --flow-path or MONGO_URI");

  const clientOptions = {
    appName: `PadlHubLkGamesLookupIndex:${command}`,
    maxPoolSize: 1,
    serverSelectionTimeoutMS: 10_000,
  };
  const client = new MongoClient(connection.uri, clientOptions);
  const mutationCommand = command === "apply" || command === "rollback";
  const reportSink = openReportSink(getArg("--out"), mutationCommand);
  let report = null;
  let db = null;
  let collection = null;
  let before = null;
  let mutationAttempted = false;
  let closeError = null;
  try {
    await client.connect();
    db = client.db(connection.dbName);
    collection = db.collection(LK_GAMES_LOOKUP_COLLECTION);
    before = await readRuntimeContext(db, collection, connection);

    if (command === "plan") {
      report = {
        schemaVersion: 2,
        mode: "PLAN",
        outcome: "SUCCEEDED",
        readyForApply: before.classification.conflicts.length === 0,
        ...publicContext(before),
      };
    } else if (command === "verify") {
      const verified = runtimeVerified(before);
      report = {
        schemaVersion: 2,
        mode: "VERIFY",
        outcome: verified ? "SUCCEEDED" : "FAILED_NO_MUTATION",
        verified,
        ...publicContext(before),
      };
      if (!verified) process.exitCode = 3;
    } else if (command === "apply") {
      if (expectedPlanDigest !== before.planDigest) throw new Error("Index catalog plan digest mismatch");
      if (before.classification.conflicts.length > 0) throw new Error("Managed index conflict must be reviewed");
      const shouldCreate = before.classification.missing.includes(LK_GAMES_LOOKUP_INDEX_NAME);
      const operationId = crypto.randomUUID();
      let mutationResult = null;
      if (shouldCreate) {
        await assertMutationBindingUnchanged({ flowPath, connection, before, db });
        reportSink.write({
          schemaVersion: 2,
          mode: "APPLY",
          outcome: "UNKNOWN_RECONCILIATION_REQUIRED",
          operationId,
          mutationAttempted: true,
          phase: "CREATE_INDEX_COMMAND_PENDING",
          before: publicContext(before),
        });
        mutationAttempted = true;
        mutationResult = await applyLookupIndex(db);
        if (!mutationResult.created) {
          throw new Error("createIndexes did not prove that this operation created the managed index");
        }
      }
      const after = await readRuntimeContext(db, collection, connection);
      await assertMutationBindingUnchanged({ flowPath, connection, before: after, db });
      if (!runtimeVerified(after)) throw new Error("Post-apply query plan verification failed");
      const createdIndexes = mutationResult?.created ? [LK_GAMES_LOOKUP_INDEX_NAME] : [];
      report = {
        schemaVersion: 2,
        mode: "APPLY",
        outcome: "SUCCEEDED",
        operationId,
        mutationAttempted,
        applied: true,
        idempotent: !shouldCreate,
        createdIndexes,
        mutationResult,
        applyReceipt: createdIndexes.length === 1
          ? buildApplyReceipt({ operationId, before, after, createdIndexes })
          : null,
        before: publicContext(before),
        after: publicContext(after),
      };
    } else {
      if (expectedPlanDigest !== before.planDigest) throw new Error("Index catalog plan digest mismatch");
      if (before.classification.conflicts.length > 0) throw new Error("Managed index conflict must be reviewed");
      if (!before.classification.matching.includes(LK_GAMES_LOOKUP_INDEX_NAME)) {
        throw new Error("Exact managed index is absent");
      }
      const applyReceiptReport = readApplyReceipt(applyReceiptPath);
      const applyReceipt = validateApplyReceipt(applyReceiptReport, before);
      await assertMutationBindingUnchanged({ flowPath, connection, before, db });
      reportSink.write({
        schemaVersion: 2,
        mode: "ROLLBACK",
        outcome: "UNKNOWN_RECONCILIATION_REQUIRED",
        operationId: applyReceipt.operationId,
        mutationAttempted: true,
        phase: "DROP_INDEX_COMMAND_PENDING",
        before: publicContext(before),
      });
      mutationAttempted = true;
      const cleanup = await cleanupNewLookupIndex(collection, true);
      if (cleanup.failures.length > 0 || cleanup.dropped.length !== 1) {
        throw new Error("Exact managed index rollback failed");
      }
      const after = await readRuntimeContext(db, collection, connection);
      await assertMutationBindingUnchanged({ flowPath, connection, before: after, db });
      if (!after.classification.missing.includes(LK_GAMES_LOOKUP_INDEX_NAME)
        || after.classification.conflicts.length > 0) {
        throw new Error("Post-rollback index catalog verification failed");
      }
      report = {
        schemaVersion: 2,
        mode: "ROLLBACK",
        outcome: "SUCCEEDED",
        operationId: applyReceipt.operationId,
        mutationAttempted: true,
        rolledBack: true,
        droppedIndexes: cleanup.dropped,
        before: publicContext(before),
        after: publicContext(after),
      };
    }
  } catch (error) {
    report = {
      schemaVersion: 2,
      mode: String(command || "UNKNOWN").toUpperCase(),
      outcome: mutationAttempted
        ? "UNKNOWN_RECONCILIATION_REQUIRED"
        : "FAILED_NO_MUTATION",
      mutationAttempted,
      error: safeErrorMessage(error),
      ...(before ? { before: publicContext(before) } : {}),
      ...(mutationAttempted && db && collection
        ? { reconciliation: await bestEffortReconciliation(db, collection, connection) }
        : {}),
    };
    process.exitCode = 1;
  } finally {
    try { await client.close(); } catch (error) { closeError = safeErrorMessage(error); }
  }

  if (closeError) report.operationalWarnings = [`MongoClient close failed: ${closeError}`];
  try { reportSink?.write(report); } finally { reportSink?.close(); }
  const rendered = JSON.stringify(report, null, 2);
  if (report.outcome === "SUCCEEDED") console.log(rendered);
  else console.error(rendered);
}

const isMain = process.argv[1] === "-"
  || (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (isMain) runCli().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error?.message || "Unknown error" }));
  process.exit(1);
});
