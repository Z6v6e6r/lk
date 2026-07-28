#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { MongoClient } from "mongodb";

const argv = process.argv.slice(2);

const getArg = (name, fallback = undefined) => {
  const index = argv.indexOf(name);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  return value === undefined || value.startsWith("--") ? true : value;
};

const hasFlag = (name) => argv.includes(name);
const splitCsv = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap((item) => splitCsv(item));
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
};
const unique = (values) => Array.from(new Set(values.filter(Boolean)));

const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
};

const asArray = (value) => (Array.isArray(value) ? value : []);

const apply = hasFlag("--apply");
const showHelp = hasFlag("--help") || hasFlag("-h");
const dbName = toStr(getArg("--db", process.env.MONGO_DB || "games")) || "games";
const collectionName = toStr(getArg("--collection", process.env.MONGO_GAMES_COLLECTION || "lk_games")) || "lk_games";
const reason = toStr(getArg("--reason", process.env.HIDE_GAME_REASON)) || "VIVA_CANCELLED_HIDE_FROM_LIST";
const outFile = toStr(getArg("--out")) || null;
const gameIds = unique([
  ...splitCsv(getArg("--game-id")),
  ...splitCsv(getArg("--game-ids")),
]);
const paymentRefs = unique([
  ...splitCsv(getArg("--payment-ref")),
  ...splitCsv(getArg("--payment-refs")),
].map((value) => toStr(value)).filter(Boolean));

const resolveMongoUriFromFlow = () => {
  const flowPath = path.resolve("node-red/modular/source.flow.json");
  if (!fs.existsSync(flowPath)) return null;
  const flow = JSON.parse(fs.readFileSync(flowPath, "utf8"));
  const node = asArray(flow).find((item) => (
    item?.type === "mongodb4-client"
    && typeof item.uri === "string"
    && item.uri.includes("/games")
  ));
  return toStr(node?.uri);
};

const mongoUri = toStr(getArg("--mongo-uri", process.env.MONGO_URI || process.env.MONGODB_URI || resolveMongoUriFromFlow()));

if (showHelp) {
  console.log(`
hide_cancelled_viva_games

Находит LK game records и переводит их в CANCELLED + archived=true,
чтобы скрыть отменённые в Viva игры из LK списков.
По умолчанию работает в dry-run и печатает JSON-отчёт.

Usage:
  node scripts/hide_cancelled_viva_games.mjs [options]

Options:
  --mongo-uri <uri>           Mongo URI (или MONGO_URI / MONGODB_URI)
  --db <name>                 DB name (default: games)
  --collection <name>         Collection (default: lk_games)
  --game-id <id>              Один game id (можно CSV)
  --game-ids <id1,id2,...>    Несколько game ids
  --payment-ref <ref>         Один paymentRef без/с pay_ (можно CSV)
  --payment-refs <r1,r2,...>  Несколько paymentRef
  --reason <code>             Audit reason (default: VIVA_CANCELLED_HIDE_FROM_LIST)
  --out <path>                Куда записать JSON-отчёт
  --apply                     Применить изменения (default: dry-run)
`);
  process.exit(0);
}

if (!mongoUri) {
  console.error("Missing --mongo-uri (or MONGO_URI / MONGODB_URI env, or source.flow.json mongo client)");
  process.exit(1);
}

if (gameIds.length === 0 && paymentRefs.length === 0) {
  console.error("Pass --game-id/--game-ids or --payment-ref/--payment-refs");
  process.exit(1);
}

const normalizePaymentRef = (value) => {
  const text = toStr(value);
  if (!text) return null;
  return text.startsWith("pay_") ? text.slice(4) : text;
};

const normalizedPaymentRefs = unique(paymentRefs.map(normalizePaymentRef).filter(Boolean));
const nowIso = new Date().toISOString();

const buildQuery = () => {
  const orConditions = [];

  if (gameIds.length > 0) {
    orConditions.push({ id: { $in: gameIds } });
  }

  if (normalizedPaymentRefs.length > 0) {
    orConditions.push(
      { "metadata.paymentRef": { $in: normalizedPaymentRefs } },
      { "metadata.splitPayment.paymentRef": { $in: normalizedPaymentRefs } },
      { "metadata.splitPayment.payments.paymentRef": { $in: normalizedPaymentRefs } },
      { "payment.paymentRef": { $in: normalizedPaymentRefs } },
    );
  }

  return orConditions.length === 1 ? orConditions[0] : { $or: orConditions };
};

const buildAuditEvent = (game) => ({
  id: `game_audit_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
  at: nowIso,
  type: "GAME_STATUS_CANCELLED",
  source: "hide_cancelled_viva_games",
  payload: {
    gameId: toStr(game?.id),
    prevStatus: toStr(game?.status),
    nextStatus: "CANCELLED",
    prevArchived: game?.archived === true,
    nextArchived: true,
    reason,
  },
});

const buildUpdate = (game) => {
  const event = buildAuditEvent(game);
  const nextVersion = Number.isFinite(Number(game?.audit?.version))
    ? Number(game.audit.version) + 1
    : 1;

  return {
    filter: { id: game.id, archived: { $ne: true } },
    update: {
      $set: {
        status: "CANCELLED",
        archived: true,
        updatedAt: nowIso,
        "metadata.cancelledInViva": true,
        "metadata.canceledInViva": true,
        "metadata.vivaCancelledAt": nowIso,
        "metadata.lastManualHideReason": reason,
        "metadata.lastManualHideAt": nowIso,
        "metadata.lastManualHideSource": "hide_cancelled_viva_games",
        "metadata.splitPayment.status": "CANCELLED",
        "metadata.splitPayment.cancelReason": reason,
        "metadata.splitPayment.cancelledAt": nowIso,
        "audit.version": nextVersion,
        "audit.updatedAt": nowIso,
        "audit.lastEvent": event,
      },
      $push: {
        "audit.events": {
          $each: [event],
          $slice: -50,
        },
      },
    },
    event,
  };
};

const writeReport = (report) => {
  if (!outFile) return;
  const target = path.resolve(outFile);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`);
};

const client = new MongoClient(mongoUri, {
  maxPoolSize: 8,
  minPoolSize: 0,
  serverSelectionTimeoutMS: 20000,
  connectTimeoutMS: 20000,
});

const report = {
  createdAt: nowIso,
  mode: apply ? "apply" : "dry-run",
  reason,
  dbName,
  collectionName,
  filters: {
    gameIds,
    paymentRefs,
    normalizedPaymentRefs,
  },
  matched: [],
  updated: [],
};

try {
  await client.connect();
  const collection = client.db(dbName).collection(collectionName);
  const docs = await collection.find(buildQuery()).toArray();

  report.matched = docs.map((doc) => ({
    id: toStr(doc?.id),
    status: toStr(doc?.status),
    archived: doc?.archived === true,
    bookingDate: toStr(doc?.booking?.date),
    bookingTimeFrom: toStr(doc?.booking?.timeFrom),
    bookingTimeTo: toStr(doc?.booking?.timeTo),
    paymentRef: toStr(doc?.metadata?.paymentRef)
      || toStr(doc?.metadata?.splitPayment?.paymentRef)
      || toStr(doc?.payment?.paymentRef),
    splitPaymentStatus: toStr(doc?.metadata?.splitPayment?.status),
  }));

  if (apply) {
    for (const doc of docs) {
      const gameId = toStr(doc?.id);
      if (!gameId || doc?.archived === true) {
        report.updated.push({
          id: gameId,
          skipped: true,
          reason: doc?.archived === true ? "already_archived" : "missing_game_id",
        });
        continue;
      }

      const { filter, update } = buildUpdate(doc);
      const result = await collection.updateOne(filter, update);
      report.updated.push({
        id: gameId,
        matchedCount: result.matchedCount,
        modifiedCount: result.modifiedCount,
      });
    }
  }

  writeReport(report);
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  writeReport(report);
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
}
