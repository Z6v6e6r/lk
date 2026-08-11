#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const asArray = (value) => Array.isArray(value) ? value : [];
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const text = (value) => value == null ? null : String(value).trim() || null;
const normalizeId = (value) => text(value)?.toLowerCase() || null;
const normalizePhone = (value) => {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  return digits.length === 11 && digits.startsWith("8") ? `7${digits.slice(1)}` : digits;
};
const unique = (values) => Array.from(new Set(values.filter(Boolean)));

function identity(value) {
  return {
    ids: unique([value?.id, value?.clientId, value?.playerId, value?.userId].map(normalizeId)),
    phones: unique([value?.phoneNorm, value?.clientPhoneNorm, value?.phone, value?.clientPhone].map(normalizePhone)),
  };
}

function samePlayer(left, right) {
  const a = identity(left);
  const b = identity(right);
  if (a.ids.some((value) => b.ids.includes(value))) return true;
  if (a.phones.some((value) => b.phones.includes(value))) return true;
  return false;
}

function splitGame(game) {
  const split = isObject(game?.metadata?.splitPayment) ? game.metadata.splitPayment : null;
  return game?.settings?.payMode === "split" || split?.enabled === true;
}

function activeGame(game) {
  return game?.archived !== true && !/CANCEL|ARCHIVE/i.test(String(game?.status || ""));
}

export function buildSplitWaitlistDuplicateRepair(game, nowIso) {
  if (!isObject(game) || !text(game.id) || !activeGame(game) || !splitGame(game)) return null;
  const participants = asArray(game.participants).filter(isObject);
  const waitlist = asArray(game.waitlist).filter(isObject);
  const removed = waitlist.filter((player) => participants.some((member) => samePlayer(member, player)));
  if (removed.length === 0) return null;

  const nextWaitlist = waitlist.filter((player) => !removed.includes(player));
  const waitlistPhones = unique(nextWaitlist.flatMap((player) => identity(player).phones));
  const operationId = `waitlist-dedup:${game.id}:${crypto.createHash("sha256")
    .update(JSON.stringify(removed.map(identity))).digest("hex").slice(0, 16)}`;
  const metadata = isObject(game.metadata) ? game.metadata : {};
  const audit = isObject(game.audit) ? game.audit : {};
  const event = {
    id: crypto.createHash("sha256").update(operationId).digest("hex").slice(0, 24),
    at: nowIso,
    type: "GAME_WAITLIST_DEDUPED",
    source: "repair_split_waitlist_duplicates",
    payload: { operationId, removedWaitlistRows: removed.length },
  };
  const events = asArray(audit.events).filter(isObject);
  const nextEvents = events.some((item) => text(item.id) === event.id) ? events : [...events, event].slice(-50);
  return {
    gameId: game.id,
    operationId,
    removedWaitlistRows: removed.length,
    update: {
      $set: {
        waitlist: nextWaitlist,
        waitlistPhones,
        metadata: {
          ...metadata,
          waitlistPhones,
          lastWaitlistDedupAt: nowIso,
          lastWaitlistDedupOperationId: operationId,
        },
        audit: {
          ...audit,
          version: Number.isFinite(Number(audit.version)) ? Number(audit.version) + 1 : 1,
          updatedAt: nowIso,
          lastEvent: event,
          events: nextEvents,
        },
        updatedAt: nowIso,
      },
    },
  };
}

function parseArgs(argv) {
  const values = new Map();
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--apply" || key === "--help") { flags.add(key); continue; }
    if (!key.startsWith("--")) throw new Error(`Unknown argument: ${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--") || values.has(key)) throw new Error(`Invalid ${key}`);
    values.set(key, value); index += 1;
  }
  return { values, flags };
}

function safeBackupDirectory(value) {
  const resolved = path.resolve(value || "");
  if (!path.isAbsolute(value || "") || resolved === path.parse(resolved).root) throw new Error("--backup-dir must be a narrow absolute directory");
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Backup directory must be a real directory");
  return resolved;
}

async function main() {
  const { values, flags } = parseArgs(process.argv.slice(2));
  if (flags.has("--help")) {
    console.log("Usage: npm run repair:split-waitlist-duplicates -- [--from-date YYYY-MM-DD] [--limit N] [--apply --confirm-count N --backup-dir /absolute/path]");
    return;
  }
  const apply = flags.has("--apply");
  const fromDate = text(values.get("--from-date")) || new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow" }).format(new Date());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) throw new Error("--from-date must be YYYY-MM-DD");
  const limit = Math.max(1, Math.min(1000, Number(values.get("--limit")) || 500));
  const mongoUri = text(process.env.MONGO_URI || process.env.MONGODB_URI);
  if (!mongoUri) throw new Error("MONGO_URI or MONGODB_URI is required");
  if (apply && (!text(values.get("--confirm-count")) || !text(values.get("--backup-dir")))) {
    throw new Error("Apply requires --confirm-count and --backup-dir");
  }
  const { BSON, MongoClient } = await import("mongodb");
  const client = new MongoClient(mongoUri, { maxPoolSize: 2, serverSelectionTimeoutMS: 20_000 });
  try {
    await client.connect();
    const games = client.db(text(process.env.MONGO_DB) || "games").collection(text(process.env.MONGO_GAMES_COLLECTION) || "lk_games");
    const query = { archived: { $ne: true }, status: { $nin: ["CANCELLED", "CANCELED"] }, "booking.date": { $gte: fromDate }, $or: [{ "settings.payMode": "split" }, { "metadata.splitPayment.enabled": true }] };
    const records = await games.find(query).sort({ "booking.date": 1, id: 1 }).limit(limit + 1).toArray();
    if (records.length > limit) throw new Error(`Candidate scan exceeded --limit=${limit}`);
    const nowIso = new Date().toISOString();
    const repairs = records.map((game) => ({ game, repair: buildSplitWaitlistDuplicateRepair(game, nowIso) })).filter((item) => item.repair);
    const report = { mode: apply ? "apply" : "dry-run", fromDate, scannedGames: records.length, candidates: repairs.map(({ repair }) => ({ gameId: repair.gameId, removedWaitlistRows: repair.removedWaitlistRows })) };
    if (!apply) { console.log(JSON.stringify(report, null, 2)); return; }
    if (Number(values.get("--confirm-count")) !== repairs.length) throw new Error("--confirm-count must equal dry-run candidate count");
    const backupDir = safeBackupDirectory(values.get("--backup-dir"));
    const backupPath = path.join(backupDir, `split-waitlist-duplicates-${Date.now()}.ejson`);
    fs.writeFileSync(backupPath, `${BSON.EJSON.stringify({ generatedAt: nowIso, query, games: repairs.map(({ game }) => game) }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    for (const { game, repair } of repairs) {
      const result = await games.updateOne({ _id: game._id, updatedAt: game.updatedAt }, repair.update);
      if (result.modifiedCount !== 1) throw new Error(`CAS update failed for ${repair.gameId}`);
      const readback = await games.findOne({ _id: game._id, "metadata.lastWaitlistDedupOperationId": repair.operationId });
      if (!readback || asArray(readback.waitlist).some((player) => asArray(readback.participants).some((member) => samePlayer(member, player)))) throw new Error(`Read-back failed for ${repair.gameId}`);
    }
    console.log(JSON.stringify({ ...report, backupPath, applied: repairs.length }, null, 2));
  } finally { await client.close(); }
}

if (import.meta.url === new URL(process.argv[1], "file:").href) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
