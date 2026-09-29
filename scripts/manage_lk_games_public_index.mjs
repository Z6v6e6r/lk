#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { MongoClient } from "mongodb";
import {
  inspectFlowBinding,
  readTargetIdentity,
  sha256,
  stableStringify,
  summarizeExplain,
} from "./manage_lk_games_lookup_index.mjs";

export const INDEX_NAME = "lk_games_public_date_station_v1";
export const INDEX_KEY = Object.freeze({ "booking.date": 1, "booking.studioId": 1 });
const keyEntries = (key) => Object.entries(key || {});
const COLLECTION = "lk_games";
const NAMESPACE = "games.lk_games";
const APPLY_CONFIRM = "APPLY_LK_GAMES_PUBLIC_DATE_STATION_V1";
const ROLLBACK_CONFIRM = "ROLLBACK_LK_GAMES_PUBLIC_DATE_STATION_V1";

const getArg = (name) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : process.argv[index + 1] || null;
};

const protectedJson = (filePath) => {
  const absolute = path.resolve(String(filePath || ""));
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)) {
    throw new Error("Input must be a private regular file (mode 0600)");
  }
  return JSON.parse(fs.readFileSync(absolute, "utf8"));
};

export const protectedReceipt = (filePath) => {
  const absolute = path.resolve(String(filePath || ""));
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)) {
    throw new Error("Receipt must be a private regular file (mode 0600)");
  }
  const journal = fs.readFileSync(absolute, "utf8");
  const lastCompleteLineEnd = journal.lastIndexOf("\n");
  if (lastCompleteLineEnd < 0) throw new Error("Receipt journal has no complete record");
  const previousLineEnd = journal.lastIndexOf("\n", lastCompleteLineEnd - 1);
  return JSON.parse(journal.slice(previousLineEnd + 1, lastCompleteLineEnd));
};

export const appendReport = (descriptor, report) => {
  const payload = Buffer.from(`${JSON.stringify(report)}\n`, "utf8");
  let offset = 0;
  while (offset < payload.length) {
    const written = fs.writeSync(descriptor, payload, offset, payload.length - offset);
    if (written <= 0) throw new Error("Report journal write made no progress");
    offset += written;
  }
  fs.fsyncSync(descriptor);
};

export const syncJournalDirectory = (filePath) => {
  const descriptor = fs.openSync(path.dirname(path.resolve(filePath)), "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
};

export function classifyIndex(indexes) {
  const sameName = indexes.find((index) => index.name === INDEX_NAME);
  if (sameName) {
    const safeOptions = !sameName.unique && !sameName.sparse && !sameName.hidden
      && !sameName.partialFilterExpression && !sameName.expireAfterSeconds
      && !sameName.collation;
    return safeOptions && isDeepStrictEqual(keyEntries(sameName.key), keyEntries(INDEX_KEY))
      ? "matching" : "name-conflict";
  }
  if (indexes.some((index) => isDeepStrictEqual(keyEntries(index.key), keyEntries(INDEX_KEY)))) {
    return "equivalent-other-name";
  }
  return "missing";
}

export function publicDateStationQuery(date, stationId, nowTs) {
  return {
    archived: { $ne: true },
    $and: [
      { $or: [
        { "booking.endTs": { $gte: nowTs } },
        { $and: [
          { "booking.endTs": { $exists: false } },
          { "booking.startTs": { $gte: nowTs } },
        ] },
        { $and: [
          { "booking.endTs": { $exists: false } },
          { "booking.startTs": { $exists: false } },
        ] },
      ] },
      { $or: [
        { "settings.isPrivate": { $exists: false } },
        { "settings.isPrivate": { $ne: true } },
      ] },
      { "booking.date": date },
      { "booking.studioId": stationId },
    ],
  };
}

export function planDigest({ binding, targetFingerprint, indexes }) {
  return sha256(stableStringify({
    schemaVersion: 1,
    namespace: NAMESPACE,
    binding,
    targetFingerprint,
    indexes: indexes.map((index) => ({
      name: index.name,
      keyEntries: keyEntries(index.key),
      unique: Boolean(index.unique),
      sparse: Boolean(index.sparse),
      hidden: Boolean(index.hidden),
      expireAfterSeconds: index.expireAfterSeconds ?? null,
      partialFilterExpression: index.partialFilterExpression || null,
      wildcardProjection: index.wildcardProjection || null,
      collation: index.collation || null,
    })).sort((a, b) => a.name.localeCompare(b.name)),
    proposed: { name: INDEX_NAME, keyEntries: keyEntries(INDEX_KEY) },
  }));
}

export function buildApplyReceipt(operationId, after) {
  const body = {
    kind: "LK_GAMES_PUBLIC_INDEX_APPLY_RECEIPT_V1",
    operationId,
    indexName: INDEX_NAME,
    afterPlanDigest: after.planDigest,
    targetFingerprint: after.targetFingerprint,
  };
  return { ...body, digest: sha256(stableStringify(body)) };
}

export function validateApplyReceipt(report, current) {
  const receipt = report?.applyReceipt;
  if (report?.mode !== "APPLY"
    || !["SUCCEEDED", "CATALOG_VERIFIED", "POSTCHECK_FAILED_INDEX_PRESENT"].includes(report?.outcome)
    || !receipt) {
    throw new Error("Verified apply catalog receipt is required");
  }
  const { digest, ...body } = receipt;
  if (digest !== sha256(stableStringify(body))
    || body.kind !== "LK_GAMES_PUBLIC_INDEX_APPLY_RECEIPT_V1"
    || body.indexName !== INDEX_NAME
    || body.afterPlanDigest !== current.planDigest
    || body.targetFingerprint !== current.targetFingerprint) {
    throw new Error("Apply receipt does not bind this exact index and target");
  }
  return receipt;
}

const sampleQuery = async (collection) => {
  const nowTs = Date.now();
  const row = await collection.findOne({
    archived: { $ne: true },
    "booking.date": { $gte: new Date(nowTs).toISOString().slice(0, 10) },
    "booking.studioId": { $type: "string" },
    "settings.isPrivate": { $ne: true },
    $or: [
      { "booking.endTs": { $gte: nowTs } },
      { "booking.endTs": { $exists: false }, "booking.startTs": { $gte: nowTs } },
      { "booking.endTs": { $exists: false }, "booking.startTs": { $exists: false } },
    ],
  }, { projection: { "booking.date": 1, "booking.studioId": 1 }, maxTimeMS: 5_000 });
  if (!row?.booking?.date || !row?.booking?.studioId) {
    throw new Error("No future public date/station probe; index effect cannot be verified");
  }
  return {
    query: publicDateStationQuery(row.booking.date, row.booking.studioId, nowTs),
    probe: { date: row.booking.date, stationIdHash: sha256(row.booking.studioId).slice(0, 12) },
  };
};

const readCatalog = async (db, collection, connection) => {
  const [indexes, identity] = await Promise.all([
    collection.listIndexes().toArray(),
    readTargetIdentity(db, connection.connectionFingerprint),
  ]);
  return {
    indexes,
    context: {
      indexState: classifyIndex(indexes),
      planDigest: planDigest({
        binding: connection.binding,
        targetFingerprint: identity.targetFingerprint,
        indexes,
      }),
      targetFingerprint: identity.targetFingerprint,
      binding: connection.binding,
    },
  };
};

const readContext = async (db, collection, connection) => {
  const catalog = await readCatalog(db, collection, connection);
  const { query, probe } = await sampleQuery(collection);
  const explain = summarizeExplain(await collection.find(query)
    .maxTimeMS(5_000).explain("executionStats"));
  return {
    indexes: catalog.indexes,
    context: { ...catalog.context, probe, explain },
  };
};

const assertIndexUsed = (context) => {
  if (context.indexState !== "matching"
    || context.explain.nReturned < 1
    || !context.explain.stages.includes("IXSCAN")
    || context.explain.stages.includes("COLLSCAN")
    || !context.explain.indexes.includes(INDEX_NAME)) {
    throw new Error("Representative live query did not use the managed index");
  }
};

export async function runCli() {
  const mode = process.argv[2];
  if (!["plan", "verify", "apply", "rollback"].includes(mode)) {
    throw new Error("Usage: manage_lk_games_public_index.mjs plan|verify|apply|rollback --flow-path <private live flow> --out <new private report> [--expected-plan-digest <sha256>] [--apply-receipt <private apply report>]");
  }
  const flowPath = getArg("--flow-path");
  const out = getArg("--out");
  if (!flowPath || !out) throw new Error("--flow-path and --out are required");
  const connection = inspectFlowBinding(protectedJson(flowPath));
  const reportDescriptor = fs.openSync(path.resolve(out), "wx", 0o600);
  const client = new MongoClient(connection.uri, {
    appName: `PadlHubLkGamesPublicIndex:${mode}`,
    maxPoolSize: 1,
    serverSelectionTimeoutMS: 10_000,
  });
  let report;
  let mutationAttempted = false;
  try {
    await client.connect();
    const db = client.db(connection.dbName);
    const collection = db.collection(COLLECTION);
    const beforeRead = mode === "rollback"
      ? await readCatalog(db, collection, connection)
      : await readContext(db, collection, connection);
    const before = beforeRead.context;
    report = { schemaVersion: 1, mode: mode.toUpperCase(), outcome: "SUCCEEDED", before };
    if (mode === "plan") {
      report.readyForApply = before.indexState === "missing";
    } else if (mode === "verify") {
      assertIndexUsed(before);
    } else {
      const confirmation = mode === "apply" ? APPLY_CONFIRM : ROLLBACK_CONFIRM;
      const envName = mode === "apply" ? "LK_GAMES_PUBLIC_INDEX_APPLY" : "LK_GAMES_PUBLIC_INDEX_ROLLBACK";
      if (process.env[envName] !== confirmation) throw new Error("Mutation confirmation is absent");
      if (getArg("--expected-plan-digest") !== before.planDigest) {
        throw new Error("Exact index catalog digest mismatch");
      }
      if (mode === "apply") {
        if (before.indexState !== "missing") throw new Error("Index is present or conflicting");
      } else {
        if (before.indexState !== "matching") throw new Error("Exact managed index is absent");
        validateApplyReceipt(protectedReceipt(getArg("--apply-receipt")), before);
      }
      const fresh = inspectFlowBinding(protectedJson(flowPath));
      if (!isDeepStrictEqual(fresh.binding, connection.binding)
        || fresh.connectionFingerprint !== connection.connectionFingerprint) {
        throw new Error("Live flow binding drifted before mutation");
      }
      const catalog = await collection.listIndexes().toArray();
      const freshIdentity = await readTargetIdentity(db, connection.connectionFingerprint);
      if (classifyIndex(catalog) !== before.indexState
        || freshIdentity.targetFingerprint !== before.targetFingerprint
        || planDigest({ binding: connection.binding, targetFingerprint: before.targetFingerprint, indexes: catalog }) !== before.planDigest) {
        throw new Error("Index catalog drifted before mutation");
      }
      const expectedIndexes = mode === "apply"
        ? [...beforeRead.indexes, { name: INDEX_NAME, key: INDEX_KEY }]
        : beforeRead.indexes.filter((index) => index.name !== INDEX_NAME);
      const expectedAfterDigest = planDigest({
        binding: connection.binding,
        targetFingerprint: before.targetFingerprint,
        indexes: expectedIndexes,
      });
      report.outcome = "UNKNOWN_RECONCILIATION_REQUIRED";
      report.operationId = crypto.randomUUID();
      report.phase = "MUTATION_PENDING";
      appendReport(reportDescriptor, report);
      syncJournalDirectory(out);
      mutationAttempted = true;
      if (mode === "apply") {
        const result = await db.command({ createIndexes: COLLECTION, indexes: [
          { name: INDEX_NAME, key: INDEX_KEY },
        ], maxTimeMS: 600_000 });
        if (Number(result.numIndexesAfter) !== Number(result.numIndexesBefore) + 1) {
          throw new Error("createIndexes did not prove one new index");
        }
      } else {
        await collection.dropIndex(INDEX_NAME);
      }
      const catalogRead = await readCatalog(db, collection, connection);
      const catalogAfter = catalogRead.context;
      if (catalogAfter.targetFingerprint !== before.targetFingerprint
        || catalogAfter.planDigest !== expectedAfterDigest
        || catalogAfter.indexState !== (mode === "apply" ? "matching" : "missing")) {
        throw new Error("Post-mutation target or catalog changed unexpectedly");
      }
      if (mode === "apply") {
        report = {
          schemaVersion: 1, mode: "APPLY", outcome: "CATALOG_VERIFIED",
          operationId: report.operationId, createdIndex: INDEX_NAME,
          applyReceipt: buildApplyReceipt(report.operationId, catalogAfter),
          before, after: catalogAfter,
        };
        appendReport(reportDescriptor, report);
      }
      const after = mode === "rollback"
        ? catalogAfter
        : (await readContext(db, collection, connection)).context;
      if (after.targetFingerprint !== before.targetFingerprint
        || after.planDigest !== expectedAfterDigest) {
        throw new Error("Postcheck target or catalog changed unexpectedly");
      }
      if (mode === "apply") assertIndexUsed(after);
      else if (after.indexState !== "missing") throw new Error("Post-rollback catalog mismatch");
      report = {
        schemaVersion: 1, mode: mode.toUpperCase(), outcome: "SUCCEEDED",
        operationId: report.operationId,
        createdIndex: mode === "apply" ? INDEX_NAME : null,
        droppedIndex: mode === "rollback" ? INDEX_NAME : null,
        applyReceipt: mode === "apply" ? report.applyReceipt : null,
        before, after,
      };
    }
  } catch (error) {
    report = {
      ...(report || { schemaVersion: 1, mode: mode.toUpperCase() }),
      outcome: report?.outcome === "CATALOG_VERIFIED"
        ? "POSTCHECK_FAILED_INDEX_PRESENT"
        : mutationAttempted ? "UNKNOWN_RECONCILIATION_REQUIRED" : "FAILED_NO_MUTATION",
      error: String(error?.message || error).replace(/mongodb(?:\+srv)?:\/\/\S+/gi, "[REDACTED_MONGO_URI]").slice(0, 500),
    };
    process.exitCode = 1;
  } finally {
    await client.close();
    appendReport(reportDescriptor, report);
    fs.closeSync(reportDescriptor);
    console.log(JSON.stringify(report));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().catch((error) => {
    console.error(String(error?.message || error).replace(/mongodb(?:\+srv)?:\/\/\S+/gi, "[REDACTED_MONGO_URI]"));
    process.exitCode = 1;
  });
}
