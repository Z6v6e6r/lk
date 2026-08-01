#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { BSON, MongoClient } from "mongodb";

const asArray = (value) => (Array.isArray(value) ? value : []);
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
};
const normalizeId = (value) => toStr(value)?.toLowerCase() || null;
const normalizePhone = (value) => {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits;
};
const unique = (values) => Array.from(new Set(values.filter(Boolean)));
const isInactiveMembershipStatus = (value) => (
  /CANCEL|DECLIN|FAIL|ERROR|EXPIRE|REFUND|REJECT|VOID|CLOSE|ARCHIVE|LEFT|REMOV/i
    .test(String(value || ""))
);

function recordIdentity(record) {
  if (!isObject(record)) return { ids: [], phones: [], bookingIds: [] };
  return {
    ids: unique([
      record.id,
      record.clientId,
      record.playerId,
      record.userId,
    ].map(normalizeId)),
    phones: unique([
      record.phoneNorm,
      record.clientPhoneNorm,
      record.phone,
      record.clientPhone,
      record.mobile,
    ].map(normalizePhone)),
    bookingIds: unique([
      ...asArray(record.bookingIds),
      record.bookingId,
      ...asArray(record.booking_ids),
      record.booking_id,
    ].map(normalizeId)),
  };
}

function recordMatchesExactSelector(record, selector) {
  const identity = recordIdentity(record);
  if (selector.clientId && !identity.ids.includes(selector.clientId)) return false;
  if (selector.phone && !identity.phones.includes(selector.phone)) return false;
  if (selector.bookingId && !identity.bookingIds.includes(selector.bookingId)) return false;
  return true;
}

function recordMatchesResolvedIdentity(record, resolvedIds, resolvedPhones) {
  const identity = recordIdentity(record);
  return identity.ids.some((value) => resolvedIds.has(value))
    || identity.phones.some((value) => resolvedPhones.has(value));
}

function activePhonesFromPlayers(players) {
  return unique(asArray(players).flatMap((player) => recordIdentity(player).phones));
}

function membershipIdentitySignature(record) {
  const identity = recordIdentity(record);
  return JSON.stringify({
    ids: [...identity.ids].sort(),
    phones: [...identity.phones].sort(),
  });
}

function paymentMembershipSignature(record) {
  const identity = recordIdentity(record);
  return JSON.stringify({
    ids: [...identity.ids].sort(),
    phones: [...identity.phones].sort(),
    bookingIds: [...identity.bookingIds].sort(),
  });
}

function assertUnambiguousMembershipRows(records, label, signature = membershipIdentitySignature) {
  const signatures = new Set(
    records
      .filter(isObject)
      .map(signature),
  );
  if (signatures.size > 1) {
    throw new Error(`Exact participant selector is ambiguous across ${label}`);
  }
}

export function buildParticipantMembershipRepair(game, selectorRaw, nowIso) {
  if (!isObject(game)) throw new Error("Game record is required");
  const selector = {
    clientId: normalizeId(selectorRaw?.clientId),
    phone: normalizePhone(selectorRaw?.phone),
    bookingId: normalizeId(selectorRaw?.bookingId),
  };
  if (!selector.clientId && !selector.phone && !selector.bookingId) {
    throw new Error("At least one exact participant selector is required");
  }

  const metadata = isObject(game.metadata) ? game.metadata : {};
  const splitPayment = isObject(metadata.splitPayment) ? metadata.splitPayment : {};
  const participants = asArray(game.participants).filter(isObject);
  const waitlist = asArray(game.waitlist).filter(isObject);
  const payments = asArray(splitPayment.payments).filter(isObject);
  const possibleAnchors = selector.bookingId ? payments : [...participants, ...waitlist, ...payments];
  const anchors = possibleAnchors.filter((record) => recordMatchesExactSelector(record, selector));
  if (anchors.length === 0) throw new Error("Exact participant selector did not match this game");
  assertUnambiguousMembershipRows(anchors, "membership anchors");

  const resolvedIds = new Set(unique([
    selector.clientId,
    ...anchors.flatMap((record) => recordIdentity(record).ids),
  ]));
  const resolvedPhones = new Set(unique([
    selector.phone,
    ...anchors.flatMap((record) => recordIdentity(record).phones),
  ]));
  if (resolvedIds.size === 0 && resolvedPhones.size === 0) {
    throw new Error("Matched booking has no participant identity");
  }

  const matchedRosterRows = [...participants, ...waitlist].filter((record) => (
    recordMatchesResolvedIdentity(record, resolvedIds, resolvedPhones)
  ));
  assertUnambiguousMembershipRows(matchedRosterRows, "active roster rows");
  const matchedActivePaymentRows = payments
    .filter((record) => !isInactiveMembershipStatus(record.status))
    .filter((record) => recordMatchesResolvedIdentity(record, resolvedIds, resolvedPhones));
  if (
    selector.bookingId
    && matchedActivePaymentRows.some((record) => (
      !recordIdentity(record).bookingIds.includes(selector.bookingId)
    ))
  ) {
    throw new Error("Exact participant selector is ambiguous across active payment generations");
  }
  assertUnambiguousMembershipRows(
    matchedActivePaymentRows,
    "active payment generations",
    paymentMembershipSignature,
  );

  const organizerIdentity = recordIdentity({
    ...(isObject(game.organizer) ? game.organizer : {}),
    id: game.organizer?.id || metadata.organizerId,
    phoneNorm: game.organizer?.phoneNorm || game.organizer?.phone || metadata.organizerPhoneNorm,
  });
  if (
    organizerIdentity.ids.some((value) => resolvedIds.has(value))
    || organizerIdentity.phones.some((value) => resolvedPhones.has(value))
  ) {
    throw new Error("Participant repair must not remove the organizer");
  }

  const nextParticipants = participants.filter((record) => (
    !recordMatchesResolvedIdentity(record, resolvedIds, resolvedPhones)
  ));
  const nextWaitlist = waitlist.filter((record) => (
    !recordMatchesResolvedIdentity(record, resolvedIds, resolvedPhones)
  ));
  const nextInvitedPhones = unique(
    asArray(game.invitedPhones)
      .map(normalizePhone)
      .filter((phone) => !resolvedPhones.has(phone)),
  );
  let matchedPayments = 0;
  const nextPayments = payments.map((record) => {
    if (!recordMatchesResolvedIdentity(record, resolvedIds, resolvedPhones)) return record;
    if (isInactiveMembershipStatus(record.status)) return record;
    matchedPayments += 1;
    return {
      ...record,
      status: "LEFT",
      cancelReason: "EXACT_PARTICIPANT_REPAIR",
      cancelledAt: record.cancelledAt || nowIso,
      leftAt: record.leftAt || nowIso,
    };
  });

  const removedParticipants = participants.length - nextParticipants.length;
  const removedWaitlist = waitlist.length - nextWaitlist.length;
  const gameId = toStr(game.id);
  if (!gameId) throw new Error("Game id is required");
  const identityDigest = crypto.createHash("sha256")
    .update(JSON.stringify({
      ids: [...resolvedIds].sort(),
      phones: [...resolvedPhones].sort(),
    }))
    .digest("hex")
    .slice(0, 24);
  const operationId = `repair:${gameId}:${identityDigest}`;
  const currentLeaveEvents = asArray(metadata.leaveEvents).filter(isObject);
  const hasLeaveEvent = currentLeaveEvents.some((event) => (
    toStr(event.operationId) === operationId
    || recordMatchesResolvedIdentity({
      id: event.playerId,
      phoneNorm: event.playerPhone,
    }, resolvedIds, resolvedPhones)
  ));
  const leaveEvent = {
    operationId,
    playerId: [...resolvedIds][0] || null,
    playerPhone: [...resolvedPhones][0] || null,
    playerName: toStr(anchors.find((record) => toStr(record.name))?.name) || "Игрок",
    leftAt: nowIso,
    reason: "EXACT_PARTICIPANT_REPAIR",
    byId: null,
    byPhone: null,
    byName: "repair_game_participant_membership",
  };
  const nextLeaveEvents = hasLeaveEvent ? currentLeaveEvents : [...currentLeaveEvents, leaveEvent];
  const auditEvent = {
    id: crypto.createHash("sha256").update(operationId).digest("hex").slice(0, 24),
    at: nowIso,
    type: "GAME_PARTICIPANT_REPAIRED",
    source: "repair_game_participant_membership",
    payload: {
      operationId,
      removedParticipants,
      removedWaitlist,
      matchedPayments,
    },
  };
  const audit = isObject(game.audit) ? game.audit : {};
  const auditEvents = asArray(audit.events).filter(isObject);
  const hasAuditEvent = auditEvents.some((event) => toStr(event.id) === auditEvent.id);
  const nextAuditEvents = hasAuditEvent ? auditEvents : [...auditEvents, auditEvent].slice(-50);

  if (removedParticipants + removedWaitlist + matchedPayments === 0) {
    if (!hasLeaveEvent || !hasAuditEvent) {
      throw new Error("No active membership remains, but repair markers are missing");
    }
    return {
      operationId,
      resolvedIds: [...resolvedIds],
      resolvedPhones: [...resolvedPhones],
      removedParticipants: 0,
      removedWaitlist: 0,
      matchedPayments: 0,
      alreadyApplied: true,
      update: null,
    };
  }

  const nextMetadata = {
    ...metadata,
    splitPayment: {
      ...splitPayment,
      payments: nextPayments,
      lastLeaveUpdateAt: nowIso,
    },
    leaveEvents: nextLeaveEvents,
    lastLeaveUpdateAt: nowIso,
    lastParticipantRepairAt: nowIso,
    lastParticipantRepairOperationId: operationId,
  };
  const nextAudit = {
    ...audit,
    version: Number.isFinite(Number(audit.version)) ? Number(audit.version) + (hasAuditEvent ? 0 : 1) : 1,
    updatedAt: nowIso,
    lastEvent: auditEvent,
    events: nextAuditEvents,
  };
  const activePayments = nextPayments.filter((record) => !isInactiveMembershipStatus(record.status));
  const activeIdentityRecords = [
    game.organizer,
    ...nextParticipants,
    ...nextWaitlist,
    ...activePayments,
  ].filter(isObject);
  const activeRelatedPhones = unique([
    ...activeIdentityRecords.flatMap((record) => recordIdentity(record).phones),
    ...nextInvitedPhones,
  ]);
  const activeRelatedClientIds = unique(
    activeIdentityRecords.flatMap((record) => recordIdentity(record).ids),
  );
  nextMetadata.historicalRelatedPhones = unique([
    ...asArray(metadata.historicalRelatedPhones).map(normalizePhone),
    ...asArray(game.allRelatedPhones).map(normalizePhone),
    ...resolvedPhones,
  ]);
  nextMetadata.historicalRelatedClientIds = unique([
    ...asArray(metadata.historicalRelatedClientIds).map(normalizeId),
    ...asArray(game.allRelatedClientIds).map(normalizeId),
    ...resolvedIds,
  ]);

  return {
    operationId,
    resolvedIds: [...resolvedIds],
    resolvedPhones: [...resolvedPhones],
    removedParticipants,
    removedWaitlist,
    matchedPayments,
    alreadyApplied: false,
    update: {
      $set: {
        participants: nextParticipants,
        waitlist: nextWaitlist,
        participantPhones: activePhonesFromPlayers(nextParticipants),
        waitlistPhones: activePhonesFromPlayers(nextWaitlist),
        invitedPhones: nextInvitedPhones,
        allRelatedPhones: activeRelatedPhones,
        allRelatedClientIds: activeRelatedClientIds,
        metadata: nextMetadata,
        audit: nextAudit,
        updatedAt: nowIso,
      },
    },
  };
}

export function assertSafeBackupDirectory(backupDir) {
  const resolved = path.resolve(backupDir);
  const parsed = path.parse(resolved);
  const parts = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (const part of parts) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) continue;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error("Backup directory path must not contain symlinks");
    if (!stat.isDirectory()) throw new Error("Backup directory path must contain directories only");
  }

  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  const exactStat = fs.lstatSync(resolved);
  if (exactStat.isSymbolicLink() || !exactStat.isDirectory()) {
    throw new Error("Backup directory must be a real directory");
  }
  const canonical = fs.realpathSync(resolved);
  if (canonical !== resolved || (exactStat.mode & 0o077) !== 0) {
    throw new Error("Backup directory must be canonical and private (0700)");
  }
  return canonical;
}

function assertRepairGameReadback(gameReadback, repair, expectedUpdatedAt = null) {
  if (!gameReadback) throw new Error("Game repair read-back could not find the exact game");
  if (expectedUpdatedAt && gameReadback.updatedAt !== expectedUpdatedAt) {
    throw new Error("Game repair read-back did not confirm the exact write");
  }
  const repairIds = new Set(repair.resolvedIds);
  const repairPhones = new Set(repair.resolvedPhones);
  const remainingMembershipRows = [
    ...asArray(gameReadback.participants),
    ...asArray(gameReadback.waitlist),
  ].filter((record) => recordMatchesResolvedIdentity(record, repairIds, repairPhones));
  const readbackMetadata = isObject(gameReadback.metadata) ? gameReadback.metadata : {};
  const readbackSplitPayment = isObject(readbackMetadata.splitPayment)
    ? readbackMetadata.splitPayment
    : {};
  const activePaymentRows = asArray(readbackSplitPayment.payments)
    .filter((record) => recordMatchesResolvedIdentity(record, repairIds, repairPhones))
    .filter((record) => !isInactiveMembershipStatus(record?.status));
  const stillActivePhone = asArray(gameReadback.allRelatedPhones)
    .map(normalizePhone)
    .some((phone) => repairPhones.has(phone));
  const stillActiveClientId = asArray(gameReadback.allRelatedClientIds)
    .map(normalizeId)
    .some((clientId) => repairIds.has(clientId));
  if (
    remainingMembershipRows.length > 0
    || activePaymentRows.length > 0
    || stillActivePhone
    || stillActiveClientId
    || toStr(readbackMetadata.lastParticipantRepairOperationId) !== repair.operationId
  ) {
    throw new Error("Game repair read-back still contains active participant membership");
  }
}

function parseArgs(argv) {
  const values = new Map();
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) throw new Error(`Unknown argument: ${key}`);
    if (key === "--apply" || key === "--help") {
      flags.add(key);
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`);
    if (values.has(key)) throw new Error(`Duplicate argument: ${key}`);
    values.set(key, value);
    index += 1;
  }
  return { values, flags };
}

function usage() {
  console.log(`Usage:
  node scripts/repair_game_participant_membership.mjs \\
    --game-id <exact-id> [options]

Participant identity must be supplied through protected environment variables:
  REPAIR_BOOKING_ID, REPAIR_CLIENT_ID, REPAIR_PHONE

Default mode is dry-run. Apply additionally requires:
  --apply --confirm-game-id <same-exact-id> --confirm-viva-cancelled yes --backup-dir <absolute-dir>

Mongo connection must be supplied by MONGO_URI or MONGODB_URI (never as a CLI argument).
This repair never cancels or recreates a Viva booking and never archives the game.`);
}

function safeIdentitySummary(repair) {
  const maskedPhones = repair.resolvedPhones.map((phone) => (
    phone.length > 4 ? `${"*".repeat(phone.length - 4)}${phone.slice(-4)}` : "****"
  ));
  return {
    clientIdsCount: repair.resolvedIds.length,
    phones: maskedPhones,
  };
}

async function main() {
  const { values, flags } = parseArgs(process.argv.slice(2));
  if (flags.has("--help")) {
    usage();
    return;
  }

  const gameId = toStr(values.get("--game-id"));
  if (values.has("--phone") || values.has("--client-id") || values.has("--booking-id")) {
    throw new Error("Participant selectors are forbidden on the CLI; use protected REPAIR_* environment variables");
  }
  const selector = {
    clientId: process.env.REPAIR_CLIENT_ID,
    phone: process.env.REPAIR_PHONE,
    bookingId: process.env.REPAIR_BOOKING_ID,
  };
  if (values.has("--mongo-uri")) {
    throw new Error("--mongo-uri is forbidden; use MONGO_URI or MONGODB_URI");
  }
  const mongoUri = toStr(process.env.MONGO_URI || process.env.MONGODB_URI);
  if (!gameId) throw new Error("--game-id is required");
  if (!mongoUri) throw new Error("Mongo URI is required through MONGO_URI or MONGODB_URI");

  const apply = flags.has("--apply");
  const backupDir = toStr(values.get("--backup-dir"));
  if (apply) {
    if (toStr(values.get("--confirm-game-id")) !== gameId) throw new Error("--confirm-game-id must equal --game-id");
    if (toStr(values.get("--confirm-viva-cancelled"))?.toLowerCase() !== "yes") {
      throw new Error("--confirm-viva-cancelled yes is required for apply");
    }
    if (!backupDir || !path.isAbsolute(backupDir) || backupDir === "/") {
      throw new Error("--backup-dir must be a narrow absolute directory");
    }
  }

  const dbName = toStr(values.get("--db") || process.env.MONGO_DB) || "games";
  const collectionName = toStr(values.get("--collection") || process.env.MONGO_GAMES_COLLECTION) || "lk_games";
  const chatCollectionName = toStr(values.get("--chat-collection")) || "chat_messages";
  const nowIso = new Date().toISOString();
  const client = new MongoClient(mongoUri, {
    maxPoolSize: 2,
    serverSelectionTimeoutMS: 20_000,
    connectTimeoutMS: 20_000,
  });

  try {
    await client.connect();
    const database = client.db(dbName);
    const games = database.collection(collectionName);
    const matches = await games.find({ id: gameId }).limit(2).toArray();
    if (matches.length !== 1) throw new Error(`Expected exactly one game, found ${matches.length}`);
    const game = matches[0];
    const repair = buildParticipantMembershipRepair(game, selector, nowIso);
    const report = {
      mode: apply ? "apply" : "dry-run",
      gameId,
      operationId: repair.operationId,
      identity: safeIdentitySummary(repair),
      removedParticipants: repair.removedParticipants,
      removedWaitlist: repair.removedWaitlist,
      matchedPayments: repair.matchedPayments,
      alreadyApplied: repair.alreadyApplied,
      gameModifiedCount: 0,
      chatMatchedCount: 0,
      chatModifiedCount: 0,
      backupPath: null,
      gameReadbackVerified: false,
      chatReadbackVerified: false,
      postCommitReadbackVerified: false,
    };

    const chats = database.collection(chatCollectionName);
    const chatFilter = repair.resolvedPhones.length > 0
      ? { gameId, relatedPhones: { $in: repair.resolvedPhones } }
      : { _id: { $exists: false } };
    const chatMatches = repair.resolvedPhones.length > 0
      ? await chats.find(chatFilter).toArray()
      : [];
    report.chatMatchedCount = chatMatches.length;

    if (apply) {
      const canonicalBackupDir = assertSafeBackupDirectory(backupDir);
      const backupPath = path.join(
        canonicalBackupDir,
        `game-${gameId.replace(/[^A-Za-z0-9._-]/g, "_")}-participant-repair-${Date.now()}.ejson`,
      );
      fs.writeFileSync(backupPath, `${BSON.EJSON.stringify({
        generatedAt: nowIso,
        game,
        chatMessages: chatMatches,
      }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      report.backupPath = backupPath;

      try {
        const session = client.startSession();
        try {
          await session.withTransaction(async () => {
            if (repair.update) {
              const casFilter = Object.prototype.hasOwnProperty.call(game, "updatedAt")
                ? { _id: game._id, updatedAt: game.updatedAt }
                : { _id: game._id, updatedAt: { $exists: false } };
              const gameWrite = await games.updateOne(casFilter, repair.update, { session });
              if (gameWrite.matchedCount !== 1) throw new Error("Game changed after precheck; CAS rejected repair");
              report.gameModifiedCount = gameWrite.modifiedCount;
            }

            if (chatMatches.length > 0) {
              const backedUpChatIds = chatMatches.map((record) => record._id);
              const chatWrite = await chats.updateMany(
                {
                  _id: { $in: backedUpChatIds },
                  gameId,
                  relatedPhones: { $in: repair.resolvedPhones },
                },
                { $pull: { relatedPhones: { $in: repair.resolvedPhones } } },
                { session },
              );
              if (chatWrite.matchedCount !== chatMatches.length) {
                throw new Error("Chat changed after backup; repair stopped");
              }
              report.chatModifiedCount = chatWrite.modifiedCount;
            }

            const gameReadback = await games.findOne({ _id: game._id }, { session });
            assertRepairGameReadback(
              gameReadback,
              repair,
              repair.alreadyApplied ? null : nowIso,
            );
            report.gameReadbackVerified = true;

            const remainingChatLinks = repair.resolvedPhones.length > 0
              ? await chats.countDocuments(chatFilter, { limit: 1, session })
              : 0;
            if (remainingChatLinks !== 0) {
              throw new Error("Chat repair read-back still contains participant membership");
            }
            report.chatReadbackVerified = true;
          }, {
            readConcern: { level: "snapshot" },
            writeConcern: { w: "majority" },
          });
        } finally {
          await session.endSession();
        }

        const postCommitGameReadback = await games.findOne({ _id: game._id });
        assertRepairGameReadback(
          postCommitGameReadback,
          repair,
          repair.alreadyApplied ? null : nowIso,
        );
        const postCommitChatLinks = repair.resolvedPhones.length > 0
          ? await chats.countDocuments(chatFilter, { limit: 1 })
          : 0;
        if (postCommitChatLinks !== 0) {
          throw new Error("Post-commit chat read-back still contains participant membership");
        }
        report.postCommitReadbackVerified = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${message}; recovery backup: ${backupPath}`);
      }
    }

    console.log(JSON.stringify(report, null, 2));
  } finally {
    await client.close().catch(() => {});
  }
}

const invokedUrl = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedUrl === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
