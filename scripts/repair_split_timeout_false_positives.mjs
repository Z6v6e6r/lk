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
const showHelp = hasFlag("--help") || hasFlag("-h");

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
  const normalized = String(value).trim();
  return normalized || null;
};

const toNum = (value) => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.trim().replace(",", "."));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const normalizeId = (value) => {
  const text = toStr(value);
  return text ? text.toLowerCase() : null;
};

const normalizePhone = (value) => {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits;
};

const normalizeName = (value) => {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  return text || "Игрок";
};

const inferMaxPlayers = (game) => {
  const fromInvite = Math.floor(toNum(game?.invite?.maxPlayers) || 0);
  if (fromInvite === 2 || fromInvite === 4) return fromInvite;
  const fromShare = Math.floor(toNum(game?.metadata?.splitPayment?.shareCount) || 0);
  if (fromShare === 2 || fromShare === 4) return fromShare;
  return 4;
};

const resolveExerciseId = (game) => {
  const splitPayment = game?.metadata?.splitPayment || null;
  const booking = game?.booking || null;
  return (
    toStr(splitPayment?.vivaExerciseId)
    || toStr(splitPayment?.exerciseId)
    || toStr(booking?.vivaExerciseId)
    || toStr(booking?.exerciseId)
    || toStr(game?.metadata?.vivaExerciseId)
    || toStr(game?.metadata?.exerciseId)
    || null
  );
};

const paymentItemIdentity = (item) => ({
  clientId: normalizeId(item?.clientId || item?.playerId || item?.userId),
  phone: normalizePhone(item?.phoneNorm || item?.clientPhoneNorm || item?.phone || item?.clientPhone),
  name: normalizeName(item?.playerName || item?.clientName || item?.name || "Игрок"),
  bookingId: toStr(item?.bookingId),
});

const playerIdentity = (player) => ({
  id: normalizeId(player?.id),
  phone: normalizePhone(player?.phone || player?.phoneNorm || player?.clientPhone),
});

const sameIdentity = (left, right) => {
  if (!left || !right) return false;
  if (left.id && right.id && left.id === right.id) return true;
  if (left.phone && right.phone && left.phone === right.phone) return true;
  return false;
};

const isSplitPaymentInactiveStatus = (statusRaw) => {
  const status = String(statusRaw || "").trim().toUpperCase();
  if (!status) return false;
  const inactiveMarkers = [
    "CANCEL",
    "DECLIN",
    "FAIL",
    "ERROR",
    "EXPIRE",
    "REFUND",
    "REJECT",
    "VOID",
    "CLOSE",
    "ARCHIVE",
  ];
  return inactiveMarkers.some((marker) => status.includes(marker));
};

const isVivaBookingActive = (booking) => {
  const status = String(booking?.status || "").trim().toUpperCase();
  if (booking?.isCancelled === true) return false;
  if (!status) return true;
  return !(
    status.includes("CANCEL")
    || status.includes("DELETE")
    || status.includes("ARCHIVE")
    || status.includes("VOID")
  );
};

const parseVivaBookings = (payload) => {
  const list = Array.isArray(payload)
    ? payload
    : (Array.isArray(payload?.content)
      ? payload.content
      : (Array.isArray(payload?.data) ? payload.data : []));

  return list
    .filter((item) => item && typeof item === "object")
    .map((item) => {
      const client = item.client && typeof item.client === "object" ? item.client : {};
      const firstName = toStr(client.firstName);
      const lastName = toStr(client.lastName);
      const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();
      return {
        id: toStr(item.id || item.bookingId || item.uuid || item.recordId),
        status: toStr(item.status) || null,
        isCancelled: item.isCancelled === true,
        visitConfirmed: item.visitConfirmed === true,
        spot: toNum(item.spot),
        clientId: normalizeId(client.id || item.clientId || item.playerId || item.userId),
        phone: normalizePhone(client.phone || item.phone || item.phoneNorm || item.clientPhone),
        name: fullName || normalizeName(item.clientName || item.playerName || item.name),
      };
    })
    .filter((item) => Boolean(item.id));
};

const resolveBookingForPaymentItem = (paymentItem, vivaBookings) => {
  const identity = paymentItemIdentity(paymentItem);
  const bookingId = toStr(paymentItem?.bookingId);

  const byId = bookingId
    ? vivaBookings.find((row) => row.id === bookingId)
    : null;
  if (byId) return byId;

  return vivaBookings.find((row) => {
    if (identity.clientId && row.clientId && identity.clientId === row.clientId) return true;
    if (identity.phone && row.phone && identity.phone === row.phone) return true;
    return false;
  }) || null;
};

const shouldTreatAsRecoveryCandidate = (paymentItem, options = {}) => {
  const includePlayerLeft = options.includePlayerLeft === true;
  const status = String(paymentItem?.status || "").trim().toUpperCase();
  const cancelReason = String(paymentItem?.cancelReason || "").trim().toUpperCase();
  if (status === "EXPIRED" && cancelReason.includes("PAYMENT_TIMEOUT")) return true;
  if (status === "PAYMENT_PENDING") {
    const amount = toNum(paymentItem?.amount);
    const amountMinor = toNum(paymentItem?.amountMinor);
    if ((amount !== null && amount <= 0) || (amountMinor !== null && amountMinor <= 0)) {
      return true;
    }
  }
  if (includePlayerLeft && status === "CANCELLED") {
    if (!cancelReason) return true;
    if (
      cancelReason.includes("PLAYER_LEFT")
      || cancelReason.includes("SELF")
      || cancelReason.includes("LEFT")
      || cancelReason.includes("TIMEOUT")
    ) {
      return true;
    }
  }
  return false;
};

const upsertPlayerByIdentity = (list, player) => {
  const candidate = playerIdentity(player);
  const idx = list.findIndex((item) => sameIdentity(playerIdentity(item), candidate));
  if (idx === -1) {
    list.push(player);
    return;
  }
  const prev = list[idx];
  list[idx] = {
    ...prev,
    ...player,
    id: prev.id ?? player.id ?? null,
    phone: prev.phone ?? player.phone ?? null,
    photo: prev.photo ?? player.photo ?? null,
    rating: prev.rating ?? player.rating ?? null,
    ratingNumeric: prev.ratingNumeric ?? player.ratingNumeric ?? null,
  };
};

const removePlayerFromListByIdentity = (list, identity) => (
  list.filter((item) => !sameIdentity(playerIdentity(item), identity))
);

const computeRelatedPhones = (organizerPhone, splitPayments, participants, waitlist) => {
  const phones = [
    normalizePhone(organizerPhone),
    ...splitPayments
      .filter((item) => !isSplitPaymentInactiveStatus(item?.status))
      .map((item) => normalizePhone(item?.phoneNorm || item?.clientPhoneNorm || item?.phone || item?.clientPhone)),
    ...participants.map((item) => normalizePhone(item?.phone)),
    ...waitlist.map((item) => normalizePhone(item?.phone)),
  ];
  return unique(phones.filter(Boolean));
};

const parseGameDate = (game) => toStr(game?.booking?.date);

const gameStatusIsCancelled = (game) => String(game?.status || "").trim().toUpperCase().includes("CANCEL");

const now = new Date();
const nowIso = now.toISOString();
const nowSlug = nowIso.replace(/[:.]/g, "-");

const mongoUri = getArg("--mongo-uri", process.env.MONGO_URI || process.env.MONGODB_URI);
const dbName = getArg("--db", process.env.MONGO_DB || "games");
const collectionName = getArg("--collection", process.env.MONGO_COLLECTION || "lk_games");
const inputFile = getArg("--input-file");
const outFile = getArg("--out", `tmp/split-timeout-repair-${nowSlug}.json`);
const apply = hasFlag("--apply");
const dryRun = !apply;
const limit = Math.max(1, Math.min(1000, Math.floor(toNum(getArg("--limit", 200)) || 200)));
const dateFrom = toStr(getArg("--date-from"));
const dateTo = toStr(getArg("--date-to"));
const includePendingOnly = hasFlag("--include-pending-only");
const includePlayerLeft = !hasFlag("--no-player-left");
const verbose = hasFlag("--verbose");
const gameIds = unique([
  ...splitCsv(getArg("--game-id")),
  ...splitCsv(getArg("--game-ids")),
]);

const vivaTokenUrl = getArg("--viva-token-url", process.env.VIVA_TOKEN_URL || "https://kc.vivacrm.ru/realms/prod/protocol/openid-connect/token");
const vivaApiBase = getArg("--viva-api-base", process.env.VIVA_API_BASE || "https://api.vivacrm.ru/api/v1");
const vivaClientId = getArg("--viva-client-id", process.env.VIVA_CLIENT_ID || "React-auth-dev");
const vivaUsername = getArg("--viva-username", process.env.VIVA_USERNAME || "it@citysport.pro");
const vivaPassword = getArg("--viva-password", process.env.VIVA_PASSWORD || "mhF-ma6-4Ju-QsJ");

if (showHelp) {
  console.log(`
repair_split_timeout_false_positives

Проверяет split-игры и находит ложные удаления:
- сверяет split-payment записи с Viva bookings;
- в dry-run формирует отчет;
- с --apply восстанавливает игроков и статусы.

Usage:
  node scripts/repair_split_timeout_false_positives.mjs [options]
  npm run repair:split-timeout -- [options]

Main options:
  --mongo-uri <uri>           Mongo URI (или MONGO_URI / MONGODB_URI)
  --db <name>                 DB name (default: games)
  --collection <name>         Collection (default: lk_games)
  --game-id <id>              Один game id (можно CSV)
  --game-ids <id1,id2,...>    Несколько game id
  --date-from <YYYY-MM-DD>    Фильтр даты от
  --date-to <YYYY-MM-DD>      Фильтр даты до
  --limit <n>                 Лимит документов (default: 200)
  --no-player-left            Не восстанавливать случаи PLAYER_LEFT/CANCELLED
  --input-file <path>         Альтернатива Mongo: JSON с играми
  --out <path>                Куда писать отчет
  --apply                     Применить исправления (по умолчанию dry-run)
  --verbose                   Лог по играм

Viva options:
  --viva-token-url <url>
  --viva-api-base <url>
  --viva-client-id <id>
  --viva-username <user>
  --viva-password <pass>
`);
  process.exit(0);
}

if (!inputFile && !mongoUri) {
  console.error("Missing --mongo-uri (or MONGO_URI / MONGODB_URI env), or provide --input-file");
  process.exit(1);
}

if (!vivaUsername || !vivaPassword || !vivaClientId) {
  console.error("Missing Viva credentials: --viva-client-id, --viva-username, --viva-password");
  process.exit(1);
}

let mongoClient = null;
let mongoCollection = null;

const getMongoCollection = async () => {
  if (inputFile) {
    throw new Error("Mongo collection is not available when --input-file is used");
  }
  if (!mongoUri) {
    throw new Error("Missing --mongo-uri (or MONGO_URI / MONGODB_URI env)");
  }
  if (mongoCollection) return mongoCollection;

  mongoClient = new MongoClient(mongoUri, {
    maxPoolSize: 8,
    minPoolSize: 0,
    serverSelectionTimeoutMS: 20000,
    connectTimeoutMS: 20000,
  });
  await mongoClient.connect();
  mongoCollection = mongoClient.db(dbName).collection(collectionName);
  return mongoCollection;
};

const closeMongo = async () => {
  if (!mongoClient) return;
  await mongoClient.close();
  mongoClient = null;
  mongoCollection = null;
};

const fetchJson = async (url, options = {}) => {
  const response = await fetch(url, options);
  const rawText = await response.text();
  let parsed = null;
  try {
    parsed = rawText ? JSON.parse(rawText) : null;
  } catch {
    parsed = rawText;
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}: ${typeof parsed === "string" ? parsed.slice(0, 300) : JSON.stringify(parsed).slice(0, 300)}`);
  }
  return parsed;
};

const fetchVivaToken = async () => {
  const params = new URLSearchParams();
  params.set("grant_type", "password");
  params.set("client_id", vivaClientId);
  params.set("username", vivaUsername);
  params.set("password", vivaPassword);

  const payload = await fetchJson(vivaTokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const token = toStr(payload?.access_token);
  if (!token) {
    throw new Error("Viva token response has no access_token");
  }
  return token;
};

const fetchVivaBookingsForExercise = async (token, exerciseId) => {
  const query = new URLSearchParams({
    showCancelled: "false",
    size: "200",
    sort: "visitConfirmed,asc",
  });
  query.append("sort", "client.lastName,asc");
  const url = `${vivaApiBase}/exercises/${encodeURIComponent(exerciseId)}/bookings?${query.toString()}`;
  const payload = await fetchJson(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
  return parseVivaBookings(payload);
};

const fetchCandidatesFromMongo = async () => {
  if (inputFile) {
    const parsed = JSON.parse(fs.readFileSync(path.resolve(inputFile), "utf8"));
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.items)) return parsed.items;
    if (Array.isArray(parsed?.games)) return parsed.games;
    return [parsed];
  }

  const query = {
    archived: { $ne: true },
    $or: [
      { "metadata.leaveEvents.reason": "AUTO_PAYMENT_TIMEOUT" },
      { "metadata.playerLeaveEvents.reason": "AUTO_PAYMENT_TIMEOUT" },
      { "metadata.leftPlayers.reason": "AUTO_PAYMENT_TIMEOUT" },
      { "metadata.splitPayment.payments": { $elemMatch: { status: "EXPIRED", cancelReason: "PAYMENT_TIMEOUT" } } },
      ...(includePlayerLeft ? [{ "metadata.splitPayment.payments": { $elemMatch: { status: "CANCELLED" } } }] : []),
      ...(includePendingOnly ? [{ "metadata.splitPayment.payments": { $elemMatch: { status: "PAYMENT_PENDING" } } }] : []),
    ],
  };

  if (gameIds.length > 0) {
    query.id = { $in: gameIds };
  }

  if (dateFrom || dateTo) {
    query["booking.date"] = {
      ...(dateFrom ? { $gte: dateFrom } : {}),
      ...(dateTo ? { $lte: dateTo } : {}),
    };
  }

  const collection = await getMongoCollection();
  const rows = await collection
    .find(query)
    .sort({ "booking.date": -1, updatedAt: -1 })
    .limit(limit)
    .toArray();
  return Array.isArray(rows) ? rows : [];
};

const persistGameUpdate = async (gameId, setDoc) => {
  const collection = await getMongoCollection();
  const result = await collection.updateOne(
    { id: gameId, archived: { $ne: true } },
    { $set: setDoc },
  );
  return {
    acknowledged: result.acknowledged === true,
    matchedCount: result.matchedCount || 0,
    modifiedCount: result.modifiedCount || 0,
    upsertedCount: result.upsertedCount || 0,
    upsertedId: result.upsertedId || null,
  };
};

const main = async () => {
  const allCandidatesRaw = await fetchCandidatesFromMongo();
  const games = allCandidatesRaw.filter((item) => item && typeof item === "object");
  const filteredGames = games.filter((game) => {
    if (gameStatusIsCancelled(game)) return false;
    const bookingDate = parseGameDate(game);
    if (dateFrom && bookingDate && bookingDate < dateFrom) return false;
    if (dateTo && bookingDate && bookingDate > dateTo) return false;
    return true;
  });

  const token = await fetchVivaToken();

  const report = {
    createdAt: nowIso,
    dryRun,
    apply,
    options: {
      gameIds,
      dateFrom,
      dateTo,
      limit,
      includePlayerLeft,
      dbName,
      collectionName,
    },
    scanned: filteredGames.length,
    candidates: [],
    repaired: [],
    skipped: [],
    failed: [],
  };

  for (const game of filteredGames) {
    const gameId = toStr(game.id);
    if (!gameId) continue;
    const splitPayment = game?.metadata?.splitPayment;
    const payments = Array.isArray(splitPayment?.payments)
      ? splitPayment.payments.filter((item) => item && typeof item === "object")
      : [];
    if (payments.length === 0) {
      report.skipped.push({ gameId, reason: "no_split_payments" });
      continue;
    }

    const candidatePayments = payments
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => shouldTreatAsRecoveryCandidate(item, { includePlayerLeft }));

    if (candidatePayments.length === 0) {
      report.skipped.push({ gameId, reason: "no_recovery_candidates" });
      continue;
    }

    const exerciseId = resolveExerciseId(game);
    if (!exerciseId) {
      report.failed.push({ gameId, reason: "no_exercise_id" });
      continue;
    }

    let vivaBookings = [];
    try {
      vivaBookings = await fetchVivaBookingsForExercise(token, exerciseId);
    } catch (error) {
      report.failed.push({
        gameId,
        reason: "viva_fetch_failed",
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    const restorable = [];
    for (const { item, index } of candidatePayments) {
      const booking = resolveBookingForPaymentItem(item, vivaBookings);
      if (!booking || !isVivaBookingActive(booking)) continue;
      restorable.push({ index, item, booking });
    }

    report.candidates.push({
      gameId,
      exerciseId,
      timeoutLikePayments: candidatePayments.length,
      restorablePayments: restorable.length,
    });

    if (restorable.length === 0) {
      report.skipped.push({ gameId, reason: "no_restorable_viva_bookings", exerciseId });
      continue;
    }

    const participants = Array.isArray(game.participants) ? [...game.participants] : [];
    const waitlist = Array.isArray(game.waitlist) ? [...game.waitlist] : [];
    const leaveEvents = Array.isArray(game?.metadata?.leaveEvents) ? [...game.metadata.leaveEvents] : [];
    const maxPlayers = inferMaxPlayers(game);
    const repairedAt = new Date().toISOString();

    const nextPayments = [...payments];
    const restoredIdentities = [];
    for (const entry of restorable) {
      const { item, booking, index } = entry;
      const bookingSpot = toNum(booking.spot);
      const targetStatus = bookingSpot != null && bookingSpot > maxPlayers ? "WAITLIST" : "PAID";
      const paidAt = toStr(item.paidAt) || repairedAt;

      nextPayments[index] = {
        ...item,
        status: targetStatus,
        cancelReason: null,
        cancelledAt: null,
        leftAt: null,
        deadlineAt: toStr(item.deadlineAt) || null,
        expiresAt: toStr(item.expiresAt) || null,
        paidAt: targetStatus === "PAID" ? paidAt : null,
        bookingId: booking.id || toStr(item.bookingId) || null,
        bookingIds: unique([
          ...splitCsv(item.bookingIds),
          booking.id,
        ]),
        clientId: booking.clientId || toStr(item.clientId) || null,
        phoneNorm: booking.phone || normalizePhone(item.phoneNorm || item.phone || item.clientPhone) || null,
        phone: toStr(item.phone) || booking.phone || null,
        playerName: booking.name || toStr(item.playerName) || toStr(item.clientName) || "Игрок",
        clientName: booking.name || toStr(item.clientName) || toStr(item.playerName) || "Игрок",
        spot: bookingSpot ?? toNum(item.spot) ?? null,
        repairMeta: {
          restoredByScript: "repair_split_timeout_false_positives",
          restoredAt: repairedAt,
          restoreReason: "VIVA_ACTIVE_BOOKING",
          vivaVisitConfirmed: booking.visitConfirmed === true,
          vivaStatus: booking.status || null,
        },
      };

      const player = {
        id: booking.clientId || toStr(item.clientId) || null,
        name: booking.name || toStr(item.playerName) || "Игрок",
        phone: booking.phone || normalizePhone(item.phoneNorm || item.phone) || null,
        photo: null,
        rating: null,
        ratingNumeric: null,
        source: "INVITE_LINK",
        status: targetStatus === "PAID" ? "CONFIRMED" : "WAITLIST",
      };
      const identityKey = playerIdentity(player);
      restoredIdentities.push(identityKey);

      if (targetStatus === "PAID") {
        const withoutInWaitlist = removePlayerFromListByIdentity(waitlist, identityKey);
        waitlist.length = 0;
        waitlist.push(...withoutInWaitlist);
        upsertPlayerByIdentity(participants, { ...player, status: "CONFIRMED" });
      } else {
        const withoutInParticipants = removePlayerFromListByIdentity(participants, identityKey);
        participants.length = 0;
        participants.push(...withoutInParticipants);
        upsertPlayerByIdentity(waitlist, { ...player, status: "WAITLIST" });
      }
    }

    const trimmedParticipants = participants.slice(0, maxPlayers);
    const participantIdentities = trimmedParticipants.map((item) => playerIdentity(item));
    const dedupedWaitlist = waitlist.filter((item) => {
      const identity = playerIdentity(item);
      return !participantIdentities.some((participantIdentity) => sameIdentity(identity, participantIdentity));
    });

    const nextLeaveEvents = leaveEvents.filter((eventItem) => {
      const reason = String(eventItem?.reason || "").trim().toUpperCase();
      if (reason !== "AUTO_PAYMENT_TIMEOUT") return true;
      const eventIdentity = {
        id: normalizeId(eventItem?.playerId),
        phone: normalizePhone(eventItem?.playerPhone),
      };
      return !restoredIdentities.some((restoredIdentity) => sameIdentity(eventIdentity, restoredIdentity));
    });

    const nextMetadata = {
      ...(game.metadata && typeof game.metadata === "object" ? game.metadata : {}),
      splitPayment: {
        ...(splitPayment && typeof splitPayment === "object" ? splitPayment : {}),
        status: "ACTIVE",
        payments: nextPayments,
        lastLeaveUpdateAt: repairedAt,
        repairLastRunAt: repairedAt,
        repairLastRunBy: "repair_split_timeout_false_positives",
      },
      leaveEvents: nextLeaveEvents,
      lastLeaveUpdateAt: repairedAt,
      participantPhones: unique(trimmedParticipants.map((item) => normalizePhone(item?.phone))),
      waitlistPhones: unique(dedupedWaitlist.map((item) => normalizePhone(item?.phone))),
      allRelatedPhones: computeRelatedPhones(
        game?.organizer?.phone || game?.metadata?.organizerPhone || null,
        nextPayments,
        trimmedParticipants,
        dedupedWaitlist,
      ),
    };

    const setDoc = {
      participants: trimmedParticipants,
      waitlist: dedupedWaitlist,
      metadata: nextMetadata,
      updatedAt: repairedAt,
    };

    const resultEntry = {
      gameId,
      exerciseId,
      restoredPlayers: restorable.map((entry) => ({
        bookingId: entry.booking.id,
        clientId: entry.booking.clientId,
        phone: entry.booking.phone,
        name: entry.booking.name,
        visitConfirmed: entry.booking.visitConfirmed === true,
        vivaStatus: entry.booking.status,
      })),
      participantsBefore: Array.isArray(game.participants) ? game.participants.length : 0,
      waitlistBefore: Array.isArray(game.waitlist) ? game.waitlist.length : 0,
      participantsAfter: trimmedParticipants.length,
      waitlistAfter: dedupedWaitlist.length,
      leaveEventsBefore: leaveEvents.length,
      leaveEventsAfter: nextLeaveEvents.length,
      applied: false,
      updateResult: null,
    };

    if (apply) {
      try {
        const updateResult = await persistGameUpdate(gameId, setDoc);
        resultEntry.applied = true;
        resultEntry.updateResult = updateResult;
      } catch (error) {
        report.failed.push({
          gameId,
          reason: "mongo_update_failed",
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
    }

    report.repaired.push(resultEntry);
    if (verbose) {
      console.log(`[repair] game=${gameId} restored=${resultEntry.restoredPlayers.length} apply=${apply ? "yes" : "no"}`);
    }
  }

  report.summary = {
    scanned: report.scanned,
    candidates: report.candidates.length,
    repaired: report.repaired.length,
    skipped: report.skipped.length,
    failed: report.failed.length,
    dryRun,
  };

  const outPath = path.resolve(outFile);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");

  console.log(JSON.stringify({
    ok: true,
    dryRun,
    scanned: report.summary.scanned,
    repaired: report.summary.repaired,
    failed: report.summary.failed,
    report: outPath,
  }, null, 2));
};

const run = async () => {
  try {
    await main();
  } finally {
    await closeMongo();
  }
};

run().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
