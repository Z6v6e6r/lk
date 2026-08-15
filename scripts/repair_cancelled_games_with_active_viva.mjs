#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { MongoClient } from "mongodb";
import { createVivaFetch } from "./lib/vivaUserAgent.mjs";

const vivaFetch = createVivaFetch();

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

const pickId = (value) => {
  if (!value || typeof value !== "object") return toStr(value);
  return toStr(value.id || value.uuid || value.value || value.key);
};

const pickName = (value) => {
  if (!value || typeof value !== "object") return toStr(value);
  return toStr(value.name || value.title || value.label);
};

const addDays = (dateRaw, days) => {
  const date = new Date(`${dateRaw}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

const todayIsoDate = () => new Date().toISOString().slice(0, 10);

const asArray = (value) => (Array.isArray(value) ? value : []);

const readMongoUriFromFlow = () => {
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

const dateRange = (from, to) => {
  const result = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    result.push(date);
  }
  return result;
};

const normalizeTime = (value) => {
  const text = toStr(value);
  if (!text) return null;
  const match = text.match(/\d{1,2}:\d{2}/);
  return match ? match[0].padStart(5, "0") : null;
};

const normalizeStatus = (value) => String(value || "").trim().toUpperCase();

const isInactiveStatus = (statusRaw) => {
  const status = normalizeStatus(statusRaw);
  if (!status) return false;
  return (
    status.includes("CANCEL")
    || status.includes("DELETE")
    || status.includes("ARCHIVE")
    || status.includes("VOID")
  );
};

const isExerciseCancelled = (exercise) => {
  if (!exercise || typeof exercise !== "object") return false;
  if (exercise.isCancelled === true || exercise.cancelled === true || exercise.canceled === true) return true;
  if (isInactiveStatus(exercise.status || exercise.state || exercise.lifecycleStatus)) return true;
  if (isInactiveStatus(exercise?.booking?.status)) return true;
  return false;
};

const isExerciseActive = (exercise) => {
  if (!exercise || typeof exercise !== "object") return false;
  if (isExerciseCancelled(exercise)) return false;
  return Boolean(toStr(exercise.id || exercise.uuid || exercise.exerciseId));
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

const resolveGameDate = (game) => toStr(game?.booking?.date || game?.date);

const resolveGameTimeFrom = (game) => normalizeTime(game?.booking?.timeFrom || game?.timeFrom || game?.startTime);

const resolveGameRoomId = (game) => (
  pickId(game?.booking?.room)
  || toStr(game?.booking?.roomId)
  || toStr(game?.roomId)
  || null
);

const resolveGameStudioId = (game) => (
  pickId(game?.booking?.studio)
  || toStr(game?.booking?.studioId)
  || toStr(game?.stationId)
  || toStr(game?.studioId)
  || null
);

const resolveExerciseDate = (exercise) => (
  toStr(exercise?.date)
  || toStr(exercise?.booking?.date)
  || (toStr(exercise?.timeFrom)?.slice(0, 10) || null)
);

const resolveExerciseTimeFrom = (exercise) => normalizeTime(exercise?.timeFrom || exercise?.startTime || exercise?.booking?.timeFrom);

const resolveExerciseRoomId = (exercise) => pickId(exercise?.room) || toStr(exercise?.roomId) || null;

const resolveExerciseStudioId = (exercise) => (
  pickId(exercise?.studio)
  || pickId(exercise?.station)
  || toStr(exercise?.studioId)
  || toStr(exercise?.stationId)
  || null
);

const exerciseMatchesGameSlot = (game, exercise) => {
  const checks = [
    ["date", resolveGameDate(game), resolveExerciseDate(exercise)],
    ["timeFrom", resolveGameTimeFrom(game), resolveExerciseTimeFrom(exercise)],
    ["studioId", resolveGameStudioId(game), resolveExerciseStudioId(exercise)],
    ["roomId", resolveGameRoomId(game), resolveExerciseRoomId(exercise)],
  ];
  const mismatches = checks
    .filter(([, gameValue, exerciseValue]) => gameValue && exerciseValue && gameValue !== exerciseValue)
    .map(([field, gameValue, exerciseValue]) => ({ field, gameValue, exerciseValue }));
  return {
    ok: mismatches.length === 0,
    mismatches,
  };
};

const isOpenGameExercise = (exercise) => {
  const directionId = pickId(exercise?.direction);
  const typeId = pickId(exercise?.type);
  const directionName = String(pickName(exercise?.direction) || "").toLowerCase();
  const typeName = String(pickName(exercise?.type) || "").toLowerCase();
  if (directionId === "4588" && typeId === "1613") return true;
  return (
    directionName.includes("открыт")
    && (typeName.includes("игр") || typeName.includes("open"))
  );
};

const normalizeExerciseForReport = (exercise) => ({
  exerciseId: toStr(exercise?.id || exercise?.uuid || exercise?.exerciseId),
  date: resolveExerciseDate(exercise),
  timeFrom: resolveExerciseTimeFrom(exercise),
  timeTo: normalizeTime(exercise?.timeTo || exercise?.endTime || exercise?.booking?.timeTo),
  status: toStr(exercise?.status || exercise?.state || exercise?.lifecycleStatus),
  clientsCount: toNum(exercise?.clientsCount || exercise?.bookedCount || exercise?.booking?.clientsCount),
  maxClientsCount: toNum(exercise?.maxClientsCount || exercise?.capacity || exercise?.booking?.maxClientsCount),
  studioId: resolveExerciseStudioId(exercise),
  studioName: pickName(exercise?.studio || exercise?.station),
  roomId: resolveExerciseRoomId(exercise),
  roomName: pickName(exercise?.room),
  directionId: pickId(exercise?.direction),
  directionName: pickName(exercise?.direction),
  typeId: pickId(exercise?.type),
  typeName: pickName(exercise?.type),
});

const normalizeGameForReport = (game) => ({
  gameId: toStr(game?.id),
  status: toStr(game?.status),
  exerciseId: resolveExerciseId(game),
  date: resolveGameDate(game),
  timeFrom: resolveGameTimeFrom(game),
  studioId: resolveGameStudioId(game),
  roomId: resolveGameRoomId(game),
  title: toStr(game?.title || game?.booking?.title),
});

const buildSlotKey = ({ date, timeFrom, studioId, roomId }) => [
  date || "",
  timeFrom || "",
  studioId || "",
  roomId || "",
].join("|");

const isSplitPaymentStatusCancelled = (splitPayment) => isInactiveStatus(splitPayment?.status);

const chooseRestoredStatus = (game) => {
  const payment = game?.payment && typeof game.payment === "object" ? game.payment : null;
  if (payment && payment.paid === false) return "PAYMENT_PENDING";
  return "PAID";
};

const defaultDateFrom = toStr(getArg("--date-from")) || todayIsoDate();
const defaultDateTo = toStr(getArg("--date-to")) || addDays(defaultDateFrom, 14);
const now = new Date();
const nowIso = now.toISOString();
const nowSlug = nowIso.replace(/[:.]/g, "-");

const mongoUri = toStr(getArg("--mongo-uri", process.env.MONGO_URI || process.env.MONGODB_URI)) || readMongoUriFromFlow();
const dbName = getArg("--db", process.env.MONGO_DB || "games");
const collectionName = getArg("--collection", process.env.MONGO_COLLECTION || "lk_games");
const outFile = getArg("--out", `tmp/cancelled-games-active-viva-${nowSlug}.json`);
const apply = hasFlag("--apply");
const publicScan = hasFlag("--public-scan");
const adminScan = hasFlag("--admin-scan");
const lkScan = hasFlag("--lk-scan");
const adminDetail = hasFlag("--admin-detail");
const cancelAdminCanceled = hasFlag("--cancel-admin-canceled");
const dryRun = !apply;
const limit = Math.max(1, Math.min(5000, Math.floor(toNum(getArg("--limit", 500)) || 500)));
const dateFrom = defaultDateFrom;
const dateTo = defaultDateTo;
const verbose = hasFlag("--verbose");
const gameIds = unique([
  ...splitCsv(getArg("--game-id")),
  ...splitCsv(getArg("--game-ids")),
]);

const lkBase = toStr(getArg("--lk-base", process.env.LK_BASE_URL)) || "https://padlhub.su";
const vivaPublicBase = toStr(getArg("--viva-public-base", process.env.VIVA_PUBLIC_BASE_URL)) || "https://api.vivacrm.ru/end-user/api/v1/iSkq6G";
const vivaTokenUrl = toStr(getArg("--viva-token-url", process.env.VIVA_TOKEN_URL)) || "https://kc.vivacrm.ru/realms/prod/protocol/openid-connect/token";
const vivaApiBase = toStr(getArg("--viva-api-base", process.env.VIVA_API_BASE)) || "https://api.vivacrm.ru/api/v1";
const vivaClientId = toStr(getArg("--viva-client-id", process.env.VIVA_CLIENT_ID)) || "React-auth-dev";
const vivaUsername = toStr(getArg("--viva-username", process.env.VIVA_USERNAME));
const vivaPassword = toStr(getArg("--viva-password", process.env.VIVA_PASSWORD));

if (showHelp) {
  console.log(`
repair_cancelled_games_with_active_viva

Находит LK игры со статусом CANCELLED, у которых Viva exercise всё ещё активен.
По умолчанию работает в dry-run и пишет отчёт. С --apply восстанавливает статус LK записи.

Usage:
  node scripts/repair_cancelled_games_with_active_viva.mjs [options]

Mongo repair options:
  --admin-detail              Для Mongo repair брать Viva Admin detail вместо public detail
  --cancel-admin-canceled     Найти LK non-CANCELLED записи, у которых Viva Admin exercise canceled=true
  --mongo-uri <uri>           Mongo URI (или MONGO_URI / MONGODB_URI)
  --db <name>                 DB name (default: games)
  --collection <name>         Collection (default: lk_games)
  --game-id <id>              Один game id (можно CSV)
  --game-ids <id1,id2,...>    Несколько game id
  --date-from <YYYY-MM-DD>    Дата от (default: сегодня)
  --date-to <YYYY-MM-DD>      Дата до (default: date-from + 14 дней)
  --limit <n>                 Лимит Mongo документов (default: 500)
  --out <path>                Куда писать отчёт
  --apply                     Применить исправления (по умолчанию dry-run)

API scan options:
  --lk-scan                   Проверить LK API-visible игры через Viva detail
  --public-scan               Без Mongo: сравнить активные Viva open games с видимым LK списком
  --admin-scan                То же, но через Viva Admin /exercises?date
  --lk-base <url>             LK base URL (default: https://padlhub.su)
  --viva-public-base <url>    Viva public base URL
  --viva-token-url <url>      Viva OAuth token URL for --admin-scan
  --viva-api-base <url>       Viva Admin API base for --admin-scan
  --viva-client-id <id>       Viva OAuth client id for --admin-scan
  --viva-username <user>      Viva username for --admin-scan/--admin-detail
  --viva-password <pass>      Viva password for --admin-scan/--admin-detail
  --verbose                   Лог по датам/играм
`);
  process.exit(0);
}

const ensureOutDir = () => {
  const dir = path.dirname(path.resolve(outFile));
  fs.mkdirSync(dir, { recursive: true });
};

const writeReport = (report) => {
  ensureOutDir();
  fs.writeFileSync(path.resolve(outFile), `${JSON.stringify(report, null, 2)}\n`);
};

const fetchJson = async (url, options = {}) => {
  const response = await vivaFetch(url, options);
  const rawText = await response.text();
  let parsed = null;
  try {
    parsed = rawText ? JSON.parse(rawText) : null;
  } catch {
    parsed = rawText;
  }
  if (!response.ok) {
    const preview = typeof parsed === "string" ? parsed.slice(0, 300) : JSON.stringify(parsed).slice(0, 300);
    throw new Error(`HTTP ${response.status} for ${url}: ${preview}`);
  }
  return parsed;
};

const parseListPayload = (payload, listKeys = ["items", "games", "content", "data"]) => {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  for (const key of listKeys) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [];
};

const fetchVivaExercisesForDate = async (date) => {
  const url = `${vivaPublicBase}/exercises?date=${encodeURIComponent(date)}`;
  return parseListPayload(await fetchJson(url), ["content", "items", "data", "exercises"]);
};

const fetchVivaToken = async () => {
  if (!vivaUsername || !vivaPassword || !vivaClientId) {
    throw new Error("Missing Viva credentials for --admin-scan: pass --viva-username/--viva-password or set VIVA_USERNAME/VIVA_PASSWORD");
  }

  const params = new URLSearchParams();
  params.set("grant_type", "password");
  params.set("client_id", vivaClientId);
  params.set("username", vivaUsername);
  params.set("password", vivaPassword);

  const payload = await fetchJson(vivaTokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });
  const token = toStr(payload?.access_token);
  if (!token) throw new Error("Viva token response does not include access_token");
  return token;
};

const fetchVivaAdminExercisesForDate = async (date, token) => {
  const url = `${vivaApiBase}/exercises?date=${encodeURIComponent(date)}`;
  return parseListPayload(await fetchJson(url, {
    headers: { Authorization: `Bearer ${token}` },
  }), ["content", "items", "data", "exercises"]);
};

const fetchVivaExerciseDetail = async (exerciseId, token = null) => {
  if (token) {
    const url = `${vivaApiBase}/exercises/${encodeURIComponent(exerciseId)}`;
    return fetchJson(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
  }
  const url = `${vivaPublicBase}/exercises/${encodeURIComponent(exerciseId)}`;
  return fetchJson(url);
};

const fetchLkGamesForDate = async (date) => {
  const query = new URLSearchParams();
  query.set("public", "true");
  query.set("available", "true");
  query.set("limit", "1000");
  query.set("offset", "0");
  query.set("date", date);
  const url = `${lkBase}/lk/games?${query.toString()}`;
  return parseListPayload(await fetchJson(url), ["games", "items", "content", "data"]);
};

const getMongoCollection = async () => {
  if (!mongoUri) {
    throw new Error("Missing --mongo-uri (or MONGO_URI / MONGODB_URI env)");
  }
  const client = new MongoClient(mongoUri, {
    maxPoolSize: 8,
    minPoolSize: 0,
    serverSelectionTimeoutMS: 20000,
    connectTimeoutMS: 20000,
  });
  await client.connect();
  return {
    client,
    collection: client.db(dbName).collection(collectionName),
  };
};

const buildMongoQuery = () => {
  const query = {
    archived: { $ne: true },
    status: { $regex: "CANCEL", $options: "i" },
    $or: [
      { "metadata.splitPayment.vivaExerciseId": { $type: "string", $ne: "" } },
      { "metadata.splitPayment.exerciseId": { $type: "string", $ne: "" } },
      { "booking.vivaExerciseId": { $type: "string", $ne: "" } },
      { "booking.exerciseId": { $type: "string", $ne: "" } },
      { "metadata.vivaExerciseId": { $type: "string", $ne: "" } },
      { "metadata.exerciseId": { $type: "string", $ne: "" } },
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

  return query;
};

const buildExerciseIdExistsConditions = () => [
  { "metadata.splitPayment.vivaExerciseId": { $type: "string", $ne: "" } },
  { "metadata.splitPayment.exerciseId": { $type: "string", $ne: "" } },
  { "booking.vivaExerciseId": { $type: "string", $ne: "" } },
  { "booking.exerciseId": { $type: "string", $ne: "" } },
  { "metadata.vivaExerciseId": { $type: "string", $ne: "" } },
  { "metadata.exerciseId": { $type: "string", $ne: "" } },
];

const buildAdminCanceledSyncQuery = () => {
  const query = {
    archived: { $ne: true },
    status: { $not: /CANCEL/i },
    $or: buildExerciseIdExistsConditions(),
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

  return query;
};

const createRestorePatch = (game, exercise) => {
  const gameId = toStr(game?.id);
  const prevStatus = toStr(game?.status);
  const nextStatus = chooseRestoredStatus(game);
  const exerciseId = toStr(exercise?.id || exercise?.uuid || exercise?.exerciseId) || resolveExerciseId(game);
  const event = {
    id: `game_audit_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    at: nowIso,
    type: "GAME_STATUS_RESTORED",
    source: "repair_cancelled_games_with_active_viva",
    payload: {
      gameId,
      exerciseId,
      prevStatus,
      nextStatus,
      reason: "VIVA_EXERCISE_ACTIVE",
      vivaStatus: toStr(exercise?.status || exercise?.state || exercise?.lifecycleStatus),
    },
  };

  const setDoc = {
    status: nextStatus,
    updatedAt: nowIso,
    "metadata.lastStatusRestoreAt": nowIso,
    "metadata.lastStatusRestorePrevStatus": prevStatus,
    "metadata.lastStatusRestoreReason": "VIVA_EXERCISE_ACTIVE",
    "metadata.lastStatusRestoreSource": "repair_cancelled_games_with_active_viva",
    "metadata.cancelledInViva": false,
    "metadata.canceledInViva": false,
    "metadata.exerciseMissing": false,
    "audit.lastEvent": event,
    "audit.updatedAt": nowIso,
  };

  if (game?.audit && typeof game.audit === "object") {
    const version = Number.isFinite(Number(game.audit.version)) ? Number(game.audit.version) : 0;
    setDoc["audit.version"] = version + 1;
  } else {
    setDoc["audit.version"] = 1;
  }

  if (game?.metadata?.splitPayment && typeof game.metadata.splitPayment === "object") {
    setDoc["metadata.splitPayment.lastStatusRestoreAt"] = nowIso;
    setDoc["metadata.splitPayment.lastStatusRestoreReason"] = "VIVA_EXERCISE_ACTIVE";
    if (isSplitPaymentStatusCancelled(game.metadata.splitPayment)) {
      setDoc["metadata.splitPayment.status"] = "ACTIVE";
    }
  }

  return {
    filter: { id: gameId, archived: { $ne: true } },
    update: {
      $set: setDoc,
      $push: { "audit.events": event },
    },
    event,
    prevStatus,
    nextStatus,
  };
};

const createAdminCancelPatch = (game, exercise) => {
  const gameId = toStr(game?.id);
  const prevStatus = toStr(game?.status);
  const exerciseId = toStr(exercise?.id || exercise?.uuid || exercise?.exerciseId) || resolveExerciseId(game);
  const event = {
    id: `game_audit_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    at: nowIso,
    type: "GAME_STATUS_CANCELLED",
    source: "repair_cancelled_games_with_active_viva",
    payload: {
      gameId,
      exerciseId,
      prevStatus,
      nextStatus: "CANCELLED",
      reason: "VIVA_ADMIN_CANCELED",
      vivaCanceled: exercise?.canceled === true || exercise?.cancelled === true || exercise?.isCancelled === true,
      vivaStatus: toStr(exercise?.status || exercise?.state || exercise?.lifecycleStatus),
    },
  };

  const setDoc = {
    status: "CANCELLED",
    updatedAt: nowIso,
    "metadata.lastStatusAdminCancelSyncAt": nowIso,
    "metadata.lastStatusAdminCancelSyncPrevStatus": prevStatus,
    "metadata.lastStatusAdminCancelSyncReason": "VIVA_ADMIN_CANCELED",
    "metadata.lastStatusAdminCancelSyncSource": "repair_cancelled_games_with_active_viva",
    "metadata.cancelledInViva": true,
    "metadata.canceledInViva": true,
    "audit.lastEvent": event,
    "audit.updatedAt": nowIso,
  };

  if (game?.audit && typeof game.audit === "object") {
    const version = Number.isFinite(Number(game.audit.version)) ? Number(game.audit.version) : 0;
    setDoc["audit.version"] = version + 1;
  } else {
    setDoc["audit.version"] = 1;
  }

  if (game?.metadata?.splitPayment && typeof game.metadata.splitPayment === "object") {
    setDoc["metadata.splitPayment.lastStatusAdminCancelSyncAt"] = nowIso;
    setDoc["metadata.splitPayment.lastStatusAdminCancelSyncReason"] = "VIVA_ADMIN_CANCELED";
    setDoc["metadata.splitPayment.status"] = "CANCELLED";
  }

  return {
    filter: { id: gameId, archived: { $ne: true } },
    update: {
      $set: setDoc,
      $push: { "audit.events": event },
    },
    event,
    prevStatus,
    nextStatus: "CANCELLED",
  };
};

const runPublicScan = async () => {
  const report = {
    createdAt: nowIso,
    mode: "public-scan",
    dateFrom,
    dateTo,
    sources: {
      lkBase,
      vivaPublicBase,
    },
    summary: {
      dates: 0,
      vivaOpenGames: 0,
      lkVisibleGames: 0,
      vivaOpenGamesNotVisibleByExerciseId: 0,
      vivaOpenGamesNotVisibleByExerciseIdOrSlot: 0,
    },
    dates: [],
    candidates: [],
    failed: [],
  };

  for (const date of dateRange(dateFrom, dateTo)) {
    try {
      if (verbose) console.log(`scan ${date}`);
      const [vivaExercisesRaw, lkGamesRaw] = await Promise.all([
        fetchVivaExercisesForDate(date),
        fetchLkGamesForDate(date),
      ]);

      const vivaExercises = vivaExercisesRaw
        .filter((item) => item && typeof item === "object")
        .filter((item) => isOpenGameExercise(item))
        .filter((item) => isExerciseActive(item));

      const lkGames = lkGamesRaw
        .filter((item) => item && typeof item === "object")
        .map(normalizeGameForReport);

      const lkExerciseIds = new Set(lkGames.map((item) => item.exerciseId).filter(Boolean));
      const lkGamesBySlot = new Map();
      for (const game of lkGames) {
        const key = buildSlotKey(game);
        if (!lkGamesBySlot.has(key)) lkGamesBySlot.set(key, []);
        lkGamesBySlot.get(key).push(game);
      }

      const missingByExerciseId = [];
      const missingByExerciseIdOrSlot = [];

      for (const exercise of vivaExercises) {
        const normalized = normalizeExerciseForReport(exercise);
        if (!normalized.exerciseId || lkExerciseIds.has(normalized.exerciseId)) continue;
        const slotMatches = lkGamesBySlot.get(buildSlotKey(normalized)) || [];
        const item = {
          ...normalized,
          lkSlotMatches: slotMatches,
        };
        missingByExerciseId.push(item);
        if (slotMatches.length === 0) missingByExerciseIdOrSlot.push(item);
      }

      report.summary.dates += 1;
      report.summary.vivaOpenGames += vivaExercises.length;
      report.summary.lkVisibleGames += lkGames.length;
      report.summary.vivaOpenGamesNotVisibleByExerciseId += missingByExerciseId.length;
      report.summary.vivaOpenGamesNotVisibleByExerciseIdOrSlot += missingByExerciseIdOrSlot.length;
      report.dates.push({
        date,
        vivaOpenGames: vivaExercises.length,
        lkVisibleGames: lkGames.length,
        notVisibleByExerciseId: missingByExerciseId.length,
        notVisibleByExerciseIdOrSlot: missingByExerciseIdOrSlot.length,
      });
      report.candidates.push(...missingByExerciseId);
    } catch (error) {
      report.failed.push({
        date,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  writeReport(report);
  console.log(JSON.stringify(report.summary, null, 2));
  console.log(`Report: ${outFile}`);
};

const runAdminScan = async () => {
  const token = await fetchVivaToken();
  const report = {
    createdAt: nowIso,
    mode: "admin-scan",
    dateFrom,
    dateTo,
    sources: {
      lkBase,
      vivaApiBase,
    },
    summary: {
      dates: 0,
      vivaOpenGames: 0,
      lkVisibleGames: 0,
      vivaOpenGamesNotVisibleByExerciseId: 0,
      vivaOpenGamesNotVisibleByExerciseIdOrSlot: 0,
    },
    dates: [],
    candidates: [],
    failed: [],
  };

  for (const date of dateRange(dateFrom, dateTo)) {
    try {
      if (verbose) console.log(`admin scan ${date}`);
      const [vivaExercisesRaw, lkGamesRaw] = await Promise.all([
        fetchVivaAdminExercisesForDate(date, token),
        fetchLkGamesForDate(date),
      ]);

      const vivaExercises = vivaExercisesRaw
        .filter((item) => item && typeof item === "object")
        .filter((item) => isOpenGameExercise(item))
        .filter((item) => isExerciseActive(item));

      const lkGames = lkGamesRaw
        .filter((item) => item && typeof item === "object")
        .map(normalizeGameForReport);

      const lkExerciseIds = new Set(lkGames.map((item) => item.exerciseId).filter(Boolean));
      const lkGamesBySlot = new Map();
      for (const game of lkGames) {
        const key = buildSlotKey(game);
        if (!lkGamesBySlot.has(key)) lkGamesBySlot.set(key, []);
        lkGamesBySlot.get(key).push(game);
      }

      const missingByExerciseId = [];
      const missingByExerciseIdOrSlot = [];

      for (const exercise of vivaExercises) {
        const normalized = normalizeExerciseForReport(exercise);
        if (!normalized.exerciseId || lkExerciseIds.has(normalized.exerciseId)) continue;
        const slotMatches = lkGamesBySlot.get(buildSlotKey(normalized)) || [];
        const item = {
          ...normalized,
          lkSlotMatches: slotMatches,
        };
        missingByExerciseId.push(item);
        if (slotMatches.length === 0) missingByExerciseIdOrSlot.push(item);
      }

      report.summary.dates += 1;
      report.summary.vivaOpenGames += vivaExercises.length;
      report.summary.lkVisibleGames += lkGames.length;
      report.summary.vivaOpenGamesNotVisibleByExerciseId += missingByExerciseId.length;
      report.summary.vivaOpenGamesNotVisibleByExerciseIdOrSlot += missingByExerciseIdOrSlot.length;
      report.dates.push({
        date,
        vivaOpenGames: vivaExercises.length,
        lkVisibleGames: lkGames.length,
        notVisibleByExerciseId: missingByExerciseId.length,
        notVisibleByExerciseIdOrSlot: missingByExerciseIdOrSlot.length,
      });
      report.candidates.push(...missingByExerciseId);
    } catch (error) {
      report.failed.push({
        date,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  writeReport(report);
  console.log(JSON.stringify(report.summary, null, 2));
  console.log(`Report: ${outFile}`);
};

const runLkScan = async () => {
  const report = {
    createdAt: nowIso,
    mode: "lk-scan",
    dateFrom,
    dateTo,
    sources: {
      lkBase,
      vivaPublicBase,
    },
    summary: {
      dates: 0,
      lkVisibleGames: 0,
      withExerciseId: 0,
      vivaActive: 0,
      vivaCancelled: 0,
      noExerciseId: 0,
      fetchFailed: 0,
    },
    dates: [],
    games: [],
    failed: [],
  };

  const seenExerciseIds = new Map();

  for (const date of dateRange(dateFrom, dateTo)) {
    try {
      if (verbose) console.log(`lk scan ${date}`);
      const lkGamesRaw = await fetchLkGamesForDate(date);
      const lkGames = lkGamesRaw
        .filter((item) => item && typeof item === "object")
        .map(normalizeGameForReport);

      const dateSummary = {
        date,
        lkVisibleGames: lkGames.length,
        withExerciseId: 0,
        vivaActive: 0,
        vivaCancelled: 0,
        noExerciseId: 0,
        fetchFailed: 0,
      };

      for (const game of lkGames) {
        report.summary.lkVisibleGames += 1;
        const exerciseId = game.exerciseId;
        if (!exerciseId) {
          report.summary.noExerciseId += 1;
          dateSummary.noExerciseId += 1;
          report.games.push({ ...game, vivaState: "no_exercise_id" });
          continue;
        }

        report.summary.withExerciseId += 1;
        dateSummary.withExerciseId += 1;

        let exercise = seenExerciseIds.get(exerciseId);
        if (!exercise) {
          try {
            exercise = await fetchVivaExerciseDetail(exerciseId);
            seenExerciseIds.set(exerciseId, exercise);
          } catch (error) {
            report.summary.fetchFailed += 1;
            dateSummary.fetchFailed += 1;
            const failedItem = {
              ...game,
              vivaState: "fetch_failed",
              error: error instanceof Error ? error.message : String(error),
            };
            report.games.push(failedItem);
            report.failed.push(failedItem);
            continue;
          }
        }

        const active = isExerciseActive(exercise);
        const vivaState = active ? "active" : "cancelled_or_inactive";
        if (active) {
          report.summary.vivaActive += 1;
          dateSummary.vivaActive += 1;
        } else {
          report.summary.vivaCancelled += 1;
          dateSummary.vivaCancelled += 1;
        }

        report.games.push({
          ...game,
          vivaState,
          exercise: normalizeExerciseForReport(exercise),
        });
      }

      report.summary.dates += 1;
      report.dates.push(dateSummary);
    } catch (error) {
      report.failed.push({
        date,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  writeReport(report);
  console.log(JSON.stringify(report.summary, null, 2));
  console.log(`Report: ${outFile}`);
};

const runMongoRepair = async () => {
  if (!mongoUri) {
    throw new Error("Missing --mongo-uri (or MONGO_URI / MONGODB_URI env). Public LK API hides CANCELLED rows; persisted cancellations require Mongo.");
  }

  const token = adminDetail ? await fetchVivaToken() : null;
  const { client, collection } = await getMongoCollection();
  const report = {
    createdAt: nowIso,
    mode: "mongo-repair",
    dryRun,
    apply,
    options: {
      dbName,
      collectionName,
      dateFrom,
      dateTo,
      limit,
      gameIds,
      adminDetail,
    },
    summary: {
      scanned: 0,
      candidates: 0,
      restorable: 0,
      repaired: 0,
      skipped: 0,
      failed: 0,
    },
    candidates: [],
    repaired: [],
    skipped: [],
    failed: [],
  };

  try {
    const rows = await collection
      .find(buildMongoQuery())
      .sort({ "booking.date": 1, "booking.timeFrom": 1, updatedAt: -1 })
      .limit(limit)
      .toArray();

    report.summary.scanned = rows.length;

    for (const game of rows) {
      const gameId = toStr(game?.id);
      if (!gameId) continue;
      const exerciseId = resolveExerciseId(game);
      report.summary.candidates += 1;

      if (!exerciseId) {
        report.summary.skipped += 1;
        report.skipped.push({ gameId, reason: "no_exercise_id" });
        continue;
      }

      let exercise = null;
      try {
        exercise = await fetchVivaExerciseDetail(exerciseId, token);
      } catch (error) {
        report.summary.failed += 1;
        report.failed.push({
          gameId,
          exerciseId,
          reason: "viva_fetch_failed",
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      const exerciseReport = normalizeExerciseForReport(exercise);
      if (!isExerciseActive(exercise)) {
        report.summary.skipped += 1;
        report.skipped.push({
          gameId,
          exerciseId,
          reason: "viva_exercise_not_active",
          exercise: exerciseReport,
        });
        continue;
      }

      const slotCheck = exerciseMatchesGameSlot(game, exercise);
      if (!slotCheck.ok) {
        report.summary.skipped += 1;
        report.skipped.push({
          gameId,
          exerciseId,
          reason: "viva_slot_mismatch",
          mismatches: slotCheck.mismatches,
          game: normalizeGameForReport(game),
          exercise: exerciseReport,
        });
        continue;
      }

      const patch = createRestorePatch(game, exercise);
      report.summary.restorable += 1;
      report.candidates.push({
        gameId,
        exerciseId,
        prevStatus: patch.prevStatus,
        nextStatus: patch.nextStatus,
        game: normalizeGameForReport(game),
        exercise: exerciseReport,
      });

      if (dryRun) continue;

      try {
        const result = await collection.updateOne(patch.filter, patch.update);
        const persisted = {
          gameId,
          exerciseId,
          prevStatus: patch.prevStatus,
          nextStatus: patch.nextStatus,
          matchedCount: result.matchedCount || 0,
          modifiedCount: result.modifiedCount || 0,
        };
        report.repaired.push(persisted);
        if (persisted.matchedCount > 0) report.summary.repaired += 1;
      } catch (error) {
        report.summary.failed += 1;
        report.failed.push({
          gameId,
          exerciseId,
          reason: "mongo_update_failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    await client.close();
  }

  writeReport(report);
  console.log(JSON.stringify(report.summary, null, 2));
  console.log(`Report: ${outFile}`);
};

const runAdminCanceledSync = async () => {
  if (!mongoUri) {
    throw new Error("Missing --mongo-uri (or MONGO_URI / MONGODB_URI env). Admin-canceled sync requires Mongo.");
  }

  const token = await fetchVivaToken();
  const { client, collection } = await getMongoCollection();
  const report = {
    createdAt: nowIso,
    mode: "cancel-admin-canceled",
    dryRun,
    apply,
    options: {
      dbName,
      collectionName,
      dateFrom,
      dateTo,
      limit,
      gameIds,
    },
    summary: {
      scanned: 0,
      adminCanceled: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
    },
    candidates: [],
    updated: [],
    skipped: [],
    failed: [],
  };

  try {
    const rows = await collection
      .find(buildAdminCanceledSyncQuery())
      .sort({ "booking.date": 1, "booking.timeFrom": 1, updatedAt: -1 })
      .limit(limit)
      .toArray();

    report.summary.scanned = rows.length;

    for (const game of rows) {
      const gameId = toStr(game?.id);
      if (!gameId) continue;
      const exerciseId = resolveExerciseId(game);
      if (!exerciseId) {
        report.summary.skipped += 1;
        report.skipped.push({ gameId, reason: "no_exercise_id" });
        continue;
      }

      let exercise = null;
      try {
        exercise = await fetchVivaExerciseDetail(exerciseId, token);
      } catch (error) {
        report.summary.failed += 1;
        report.failed.push({
          gameId,
          exerciseId,
          reason: "viva_admin_fetch_failed",
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      if (!isExerciseCancelled(exercise)) {
        report.summary.skipped += 1;
        report.skipped.push({
          gameId,
          exerciseId,
          reason: "viva_admin_not_canceled",
          game: normalizeGameForReport(game),
          exercise: normalizeExerciseForReport(exercise),
        });
        continue;
      }

      const slotCheck = exerciseMatchesGameSlot(game, exercise);
      if (!slotCheck.ok) {
        report.summary.skipped += 1;
        report.skipped.push({
          gameId,
          exerciseId,
          reason: "viva_slot_mismatch",
          mismatches: slotCheck.mismatches,
          game: normalizeGameForReport(game),
          exercise: normalizeExerciseForReport(exercise),
        });
        continue;
      }

      const patch = createAdminCancelPatch(game, exercise);
      report.summary.adminCanceled += 1;
      report.candidates.push({
        gameId,
        exerciseId,
        prevStatus: patch.prevStatus,
        nextStatus: patch.nextStatus,
        game: normalizeGameForReport(game),
        exercise: normalizeExerciseForReport(exercise),
      });

      if (dryRun) continue;

      try {
        const result = await collection.updateOne(patch.filter, patch.update);
        const persisted = {
          gameId,
          exerciseId,
          prevStatus: patch.prevStatus,
          nextStatus: patch.nextStatus,
          matchedCount: result.matchedCount || 0,
          modifiedCount: result.modifiedCount || 0,
        };
        report.updated.push(persisted);
        if (persisted.matchedCount > 0) report.summary.updated += 1;
      } catch (error) {
        report.summary.failed += 1;
        report.failed.push({
          gameId,
          exerciseId,
          reason: "mongo_update_failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    await client.close();
  }

  writeReport(report);
  console.log(JSON.stringify(report.summary, null, 2));
  console.log(`Report: ${outFile}`);
};

const main = async () => {
  if (cancelAdminCanceled) {
    await runAdminCanceledSync();
    return;
  }
  if (lkScan) {
    await runLkScan();
    return;
  }
  if (adminScan) {
    await runAdminScan();
    return;
  }
  if (publicScan) {
    await runPublicScan();
    return;
  }
  await runMongoRepair();
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
