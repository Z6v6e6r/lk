import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { MongoClient } from "mongodb";

export const TRAINING_VISITS_COLLECTION = "lk_training_visits";
export const GROUP_TRAINING_TYPE_IDS = [605, 847, 963, 1208];
export const DEFAULT_GROUP_TRAINING_STUDIO_IDS = [
  "6b2d7e60-caff-4b22-89f6-6f19d7d311ab",
  "42c6d4df-833d-480a-bdc8-986716569884",
  "588b6151-f4f5-47d9-9449-80edf8cbc748",
  "0d5504f6-ea6f-44bb-a9e4-947faf0273ab",
  "6a7a9edc-6869-40ad-a5a1-8a1cdfb746a1",
  "3656cbaa-6426-490f-a44f-915404cbdd2b",
];

export const TRAINING_VISITS_INDEXES = [
  {
    key: { id: 1 },
    options: { name: "uniq_lk_training_visits_id", unique: true },
  },
  {
    key: { source: 1, sourceExerciseId: 1, bookingId: 1 },
    options: { name: "training_visits_by_source_exercise_booking" },
  },
  {
    key: { archived: 1, clientId: 1, phoneNorm: 1, timeToIso: -1 },
    options: { name: "training_visits_by_identity_time" },
  },
  {
    key: { source: 1, sourceExerciseId: 1, archived: 1 },
    options: { name: "training_visits_by_exercise" },
  },
  {
    key: { communityId: 1, relatedCommunityId: 1, archived: 1 },
    options: { name: "training_visits_by_community" },
  },
];

const DEFAULT_VIVA_TOKEN_URL = "https://kc.vivacrm.ru/realms/prod/protocol/openid-connect/token";
const DEFAULT_VIVA_API_BASE = "https://api.vivacrm.ru/api/v1";
const DEFAULT_VIVA_PUBLIC_BASE = "https://api.vivacrm.ru/end-user/api/v1/iSkq6G";
const ACTIVE_VISIT_SOURCE = "viva";
const ACTIVE_VISIT_SOURCE_KIND = "group_training_visit";

function getArg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  return process.argv[index + 1] || fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function splitCsv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toStr(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function toNum(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const raw = toStr(value);
  if (!raw) return null;
  const parsed = Number(raw.replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

function toInt(value) {
  const parsed = toNum(value);
  return parsed == null ? null : Math.trunc(parsed);
}

function pickString(source, keys) {
  if (!isRecord(source)) return "";
  for (const key of keys) {
    const value = toStr(source[key]);
    if (value) return value;
  }
  return "";
}

function pickNumber(source, keys) {
  if (!isRecord(source)) return null;
  for (const key of keys) {
    const value = toInt(source[key]);
    if (value !== null) return value;
  }
  return null;
}

function pickBoolean(source, keys) {
  if (!isRecord(source)) return null;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value !== 0;
    const normalized = toStr(value).toLowerCase();
    if (["true", "1", "yes", "y", "on", "да"].includes(normalized)) return true;
    if (["false", "0", "no", "n", "off", "нет"].includes(normalized)) return false;
  }
  return null;
}

function pickRecord(source, keys) {
  if (!isRecord(source)) return null;
  for (const key of keys) {
    if (isRecord(source[key])) return source[key];
  }
  return null;
}

function extractList(payload, keys = ["content", "items", "data", "exercises", "results", "bookings"]) {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload)) return [];
  for (const key of keys) {
    const value = payload[key];
    if (Array.isArray(value)) return value;
    if (isRecord(value)) {
      const nested = extractList(value, keys);
      if (nested.length > 0) return nested;
    }
  }
  return [];
}

export function normalizePhone(value) {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits;
}

function normalizeName(value) {
  return toStr(value).replace(/\s+/g, " ").trim();
}

function normalizeDate(value) {
  const raw = toStr(value);
  if (!raw) return "";
  const direct = raw.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  if (direct) return direct;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toISOString().slice(0, 10);
}

function parseIsoDate(value) {
  const normalized = normalizeDate(value);
  if (!normalized) return null;
  const [year, month, day] = normalized.split("-").map((item) => Number(item));
  if (!year || !month || !day) return null;
  return new Date(Date.UTC(year, month - 1, day));
}

function addUtcDays(date, days) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

export function enumerateDates({ dates, dateFrom, dateTo }) {
  const explicitDates = splitCsv(dates);
  if (explicitDates.length > 0) {
    return Array.from(new Set(explicitDates.map(normalizeDate).filter(Boolean))).sort();
  }

  const from = parseIsoDate(dateFrom || dateTo || new Date().toISOString());
  const to = parseIsoDate(dateTo || dateFrom || new Date().toISOString());
  if (!from || !to) return [];
  const start = from.getTime() <= to.getTime() ? from : to;
  const end = from.getTime() <= to.getTime() ? to : from;
  const result = [];
  for (let cursor = start; cursor.getTime() <= end.getTime(); cursor = addUtcDays(cursor, 1)) {
    result.push(cursor.toISOString().slice(0, 10));
  }
  return result;
}

function normalizedStatus(value) {
  return toStr(value).toLowerCase().replace(/ё/g, "е");
}

function hasInactiveMarker(value) {
  const status = normalizedStatus(value);
  if (!status) return false;
  return (
    status.includes("cancel")
    || status.includes("отмен")
    || status.includes("refund")
    || status.includes("declin")
    || status.includes("delete")
    || status.includes("archive")
    || status.includes("void")
    || status.includes("waitlist")
    || status.includes("waiting")
    || status.includes("pending")
    || status.includes("unpaid")
    || status.includes("failed")
    || status.includes("no_show")
    || status.includes("noshow")
    || status.includes("not_visit")
    || status.includes("notvisited")
    || status.includes("not visited")
    || status.includes("не приш")
  );
}

function hasConfirmedMarker(value) {
  const status = normalizedStatus(value);
  if (!status || hasInactiveMarker(status)) return false;
  return (
    status.includes("attend")
    || status.includes("visit")
    || status.includes("complete")
    || status.includes("checked")
    || status.includes("посещ")
    || status.includes("пришел")
  );
}

function isPositiveFlag(value) {
  return (
    value === true
    || value === 1
    || value === "1"
    || normalizedStatus(value) === "true"
    || normalizedStatus(value) === "yes"
    || normalizedStatus(value) === "да"
  );
}

function isFalseFlag(value) {
  return (
    value === false
    || value === 0
    || value === "0"
    || normalizedStatus(value) === "false"
    || normalizedStatus(value) === "no"
    || normalizedStatus(value) === "нет"
  );
}

function getExerciseTypeId(value) {
  const type = pickRecord(value, ["type", "exerciseType", "category"]);
  return pickNumber(type, ["id", "typeId", "exerciseTypeId"])
    ?? pickNumber(value, ["typeId", "exerciseTypeId", "vivaExerciseTypeId"]);
}

function getExerciseDirectionId(value) {
  const direction = pickRecord(value, ["direction"]);
  return pickNumber(direction, ["id", "directionId"])
    ?? pickNumber(value, ["directionId", "vivaDirectionId"]);
}

function getStudioId(value) {
  const studio = pickRecord(value, ["studio", "station", "club"]);
  return pickString(studio, ["id", "studioId", "stationId"])
    || pickString(value, ["studioId", "stationId", "clubId"]);
}

function isExerciseCancelled(value) {
  const status = pickString(value, ["status", "state", "sourceStatus"]);
  return (
    pickBoolean(value, ["isCancelled", "cancelled", "canceled", "archived"]) === true
    || hasInactiveMarker(status)
  );
}

export function normalizeTrainingExercise(value, options = {}) {
  if (!isRecord(value)) return null;
  const allowedTypeIds = options.allowedTypeIds ?? GROUP_TRAINING_TYPE_IDS;
  const allowedStudioIds = options.allowedStudioIds ?? DEFAULT_GROUP_TRAINING_STUDIO_IDS;
  const typeId = getExerciseTypeId(value);
  const studioId = getStudioId(value);

  if (typeId == null || !allowedTypeIds.includes(typeId)) return null;
  if (allowedStudioIds.length > 0 && studioId && !allowedStudioIds.includes(studioId)) return null;
  if (isExerciseCancelled(value)) return null;

  const type = pickRecord(value, ["type", "exerciseType", "category"]);
  const direction = pickRecord(value, ["direction"]);
  const studio = pickRecord(value, ["studio", "station", "club"]);
  const room = pickRecord(value, ["room", "court"]);
  const id = pickString(value, ["id", "exerciseId", "uuid", "sourceExerciseId"]);
  const timeFromIso = pickString(value, ["timeFromIso", "timeFrom", "startsAt", "startAt", "startedAt", "beginAt"]);
  const timeToIso = pickString(value, ["timeToIso", "timeTo", "endsAt", "endAt", "finishedAt"]);
  if (!id || !timeFromIso) return null;

  return {
    id,
    sourceExerciseId: id,
    typeId,
    typeName: pickString(type, ["name", "title"]) || pickString(value, ["typeName", "exerciseTypeName"]),
    directionId: getExerciseDirectionId(value),
    directionName: pickString(direction, ["name", "title"]) || pickString(value, ["directionName"]),
    title: pickString(value, ["title", "name"]) || pickString(direction, ["name", "title"]) || "Group training",
    studioId: studioId || "",
    studioName: pickString(studio, ["name", "title"]) || pickString(value, ["studioName", "stationName"]),
    roomId: pickString(room, ["id", "roomId", "courtId"]) || pickString(value, ["roomId", "courtId"]),
    roomName: pickString(room, ["name", "title"]) || pickString(value, ["roomName", "courtName"]),
    timeFromIso,
    timeToIso: timeToIso || timeFromIso,
    date: normalizeDate(value.date || timeFromIso),
    status: pickString(value, ["status", "state", "sourceStatus"]) || null,
  };
}

function getBookingStatusValues(value) {
  if (!isRecord(value)) return [];
  return [
    value.status,
    value.state,
    value.registrationStatus,
    value.bookingStatus,
    value.paymentStatus,
    value.sourceStatus,
    value.rawStatus,
  ];
}

function isBookingExcluded(value) {
  if (!isRecord(value)) return true;
  if (pickBoolean(value, ["isCancelled", "cancelled", "canceled", "archived"]) === true) return true;
  return getBookingStatusValues(value).some((status) => hasInactiveMarker(status));
}

function isBookingConfirmed(value) {
  if (!isRecord(value) || isBookingExcluded(value)) return false;
  const flags = [
    value.visitConfirmed,
    value.visited,
    value.attended,
    value.checkedIn,
    value.checkIn,
    value.present,
    value.completed,
  ];
  if (flags.some((flag) => isPositiveFlag(flag))) return true;
  if (isFalseFlag(value.visitConfirmed)) return false;
  return getBookingStatusValues(value).some((status) => hasConfirmedMarker(status));
}

export function normalizeTrainingBooking(value, exercise, options = {}) {
  if (!isRecord(value)) return null;
  const client = pickRecord(value, ["client", "customer", "user", "member", "participant", "player"]) || {};
  const firstName = pickString(client, ["firstName", "firstname", "givenName", "name"]);
  const lastName = pickString(client, ["lastName", "lastname", "familyName", "surname"]);
  const fullName = normalizeName(
    [firstName, lastName].filter(Boolean).join(" ")
    || pickString(client, ["displayName", "fullName", "title"])
    || pickString(value, ["clientName", "playerName", "name", "displayName", "fullName"]),
  );
  const clientId = pickString(client, ["id", "clientId", "userId", "uuid", "playerId"])
    || pickString(value, ["clientId", "userId", "memberId", "playerId"]);
  const phoneNorm = normalizePhone(
    client.phone
    ?? client.phoneNorm
    ?? client.phoneNumber
    ?? client.mobile
    ?? value.phone
    ?? value.phoneNorm
    ?? value.phoneNumber
    ?? value.mobile
    ?? value.clientPhone,
  );
  const bookingId = pickString(value, ["id", "bookingId", "uuid", "recordId", "visitId"])
    || [clientId, phoneNorm].filter(Boolean).join(":");
  if (!bookingId || (!clientId && !phoneNorm)) return null;
  const attendanceIdentity = clientId ? `client:${clientId}` : `phone:${phoneNorm}`;

  const confirmed = isBookingConfirmed(value);
  const exerciseEndTs = Date.parse(exercise.timeToIso || exercise.timeFromIso || "");
  const collectedAtTs = Date.parse(options.collectedAt || new Date().toISOString());
  const isFuture = Number.isFinite(exerciseEndTs) && Number.isFinite(collectedAtTs) && exerciseEndTs > collectedAtTs;

  return {
    bookingId,
    visitId: `viva:${exercise.id}:${attendanceIdentity}`,
    attendanceIdentity,
    confirmed,
    excluded: isBookingExcluded(value),
    future: isFuture,
    status: pickString(value, ["status", "state", "sourceStatus"]) || null,
    registrationStatus: pickString(value, ["registrationStatus"]) || null,
    bookingStatus: pickString(value, ["bookingStatus"]) || null,
    paymentStatus: pickString(value, ["paymentStatus"]) || null,
    visitConfirmed: confirmed,
    spot: pickNumber(value, ["spot", "slot", "position"]),
    clientId,
    phoneNorm,
    phone: phoneNorm,
    name: fullName || phoneNorm || clientId,
    firstName,
    lastName,
  };
}

export function buildTrainingVisitRecord({ exercise, booking, syncedAt }) {
  const id = booking.visitId;
  return {
    id,
    visitId: id,
    trainingVisitId: id,
    attendanceId: id,
    bookingId: booking.bookingId,
    exerciseId: exercise.id,
    groupExerciseId: exercise.id,
    trainingId: exercise.id,
    sourceExerciseId: exercise.sourceExerciseId,
    source: ACTIVE_VISIT_SOURCE,
    sourceKind: ACTIVE_VISIT_SOURCE_KIND,
    archived: false,
    visitConfirmed: true,
    visited: true,
    attended: true,
    status: booking.status || "VISIT_CONFIRMED",
    registrationStatus: booking.registrationStatus,
    bookingStatus: booking.bookingStatus,
    paymentStatus: booking.paymentStatus,
    date: exercise.date,
    timeFromIso: exercise.timeFromIso,
    timeToIso: exercise.timeToIso,
    scheduledAt: exercise.timeFromIso,
    clientId: booking.clientId || null,
    userId: booking.clientId || null,
    playerId: booking.clientId || null,
    phone: booking.phone || null,
    phoneNorm: booking.phoneNorm || null,
    name: booking.name,
    client: {
      id: booking.clientId || null,
      clientId: booking.clientId || null,
      phone: booking.phone || null,
      phoneNorm: booking.phoneNorm || null,
      name: booking.name,
      firstName: booking.firstName || null,
      lastName: booking.lastName || null,
    },
    exercise: {
      id: exercise.id,
      exerciseId: exercise.id,
      sourceExerciseId: exercise.sourceExerciseId,
      typeId: exercise.typeId,
      typeName: exercise.typeName || null,
      directionId: exercise.directionId,
      directionName: exercise.directionName || null,
      title: exercise.title,
      studioId: exercise.studioId || null,
      studioName: exercise.studioName || null,
      roomId: exercise.roomId || null,
      roomName: exercise.roomName || null,
      date: exercise.date,
      timeFromIso: exercise.timeFromIso,
      timeToIso: exercise.timeToIso,
    },
    typeId: exercise.typeId,
    typeName: exercise.typeName || null,
    directionId: exercise.directionId,
    directionName: exercise.directionName || null,
    studioId: exercise.studioId || null,
    studioName: exercise.studioName || null,
    roomId: exercise.roomId || null,
    roomName: exercise.roomName || null,
    syncedAt,
    updatedAt: syncedAt,
  };
}

function extractBookingsFromExercisePayload(value) {
  if (!isRecord(value)) return [];
  const direct = extractList(value, ["bookings", "visits", "attendees", "clients", "participants"]);
  return direct.filter(isRecord);
}

export function buildTrainingVisitRecordsFromExercises(exercisePayloads, options = {}) {
  const syncedAt = options.syncedAt || new Date().toISOString();
  const allowedTypeIds = options.allowedTypeIds ?? GROUP_TRAINING_TYPE_IDS;
  const allowedStudioIds = options.allowedStudioIds ?? DEFAULT_GROUP_TRAINING_STUDIO_IDS;
  const stats = {
    sourceExercises: Array.isArray(exercisePayloads) ? exercisePayloads.length : 0,
    eligibleExercises: 0,
    skippedExercises: 0,
    sourceBookings: 0,
    confirmedBookings: 0,
    skippedBookings: 0,
    futureBookings: 0,
    missingIdentityBookings: 0,
    deduplicatedBookings: 0,
  };
  const records = [];
  const scannedExerciseIds = [];

  for (const rawExercise of Array.isArray(exercisePayloads) ? exercisePayloads : []) {
    const exercise = normalizeTrainingExercise(rawExercise, { allowedTypeIds, allowedStudioIds });
    if (!exercise) {
      stats.skippedExercises += 1;
      continue;
    }
    stats.eligibleExercises += 1;
    scannedExerciseIds.push(exercise.id);

    const rawBookings = extractBookingsFromExercisePayload(rawExercise);
    stats.sourceBookings += rawBookings.length;

    for (const rawBooking of rawBookings) {
      const booking = normalizeTrainingBooking(rawBooking, exercise, { collectedAt: syncedAt });
      if (!booking) {
        stats.missingIdentityBookings += 1;
        stats.skippedBookings += 1;
        continue;
      }
      if (booking.future) {
        stats.futureBookings += 1;
        stats.skippedBookings += 1;
        continue;
      }
      if (!booking.confirmed) {
        stats.skippedBookings += 1;
        continue;
      }
      stats.confirmedBookings += 1;
      records.push(buildTrainingVisitRecord({ exercise, booking, syncedAt }));
    }
  }

  const dedupedRecords = [];
  const seen = new Set();
  for (const record of records) {
    if (seen.has(record.id)) {
      stats.deduplicatedBookings += 1;
      continue;
    }
    seen.add(record.id);
    dedupedRecords.push(record);
  }

  return {
    records: dedupedRecords,
    scannedExerciseIds: Array.from(new Set(scannedExerciseIds)),
    stats,
  };
}

export function buildTrainingVisitBulkPlan({ records, scannedExerciseIds, archiveMissing = true, syncedAt }) {
  const activeIds = records.map((record) => record.id);
  const operations = records.map((record) => ({
    updateOne: {
      filter: { id: record.id },
      update: {
        $set: record,
        $setOnInsert: {
          createdAt: syncedAt,
        },
      },
      upsert: true,
    },
  }));

  if (archiveMissing && scannedExerciseIds.length > 0) {
    operations.push({
      updateMany: {
        filter: {
          source: ACTIVE_VISIT_SOURCE,
          sourceExerciseId: { $in: scannedExerciseIds },
          archived: { $ne: true },
          ...(activeIds.length > 0 ? { id: { $nin: activeIds } } : {}),
        },
        update: {
          $set: {
            archived: true,
            visitConfirmed: false,
            archivedAt: syncedAt,
            archivedReason: "VIVA_SYNC_MISSING_OR_NOT_CONFIRMED",
            syncedAt,
            updatedAt: syncedAt,
          },
        },
      },
    });
  }

  return {
    operations,
    activeIds,
    scannedExerciseIds,
    archiveMissing,
    summary: {
      upserts: records.length,
      archiveMissingOperations: archiveMissing && scannedExerciseIds.length > 0 ? 1 : 0,
    },
  };
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const rawText = await response.text();
  let parsed = null;
  try {
    parsed = rawText ? JSON.parse(rawText) : null;
  } catch {
    parsed = rawText;
  }
  if (!response.ok) {
    const body = typeof parsed === "string" ? parsed : JSON.stringify(parsed);
    throw new Error(`HTTP ${response.status} for ${url}: ${String(body || "").slice(0, 400)}`);
  }
  return parsed;
}

async function fetchVivaToken({ vivaTokenUrl, vivaClientId, vivaUsername, vivaPassword }) {
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
  if (!token) throw new Error("Viva token response has no access_token");
  return token;
}

export function buildVivaAdminExercisesUrl({ vivaApiBase, date }) {
  const query = new URLSearchParams({ date });
  return `${vivaApiBase}/exercises?${query.toString()}`;
}

export function buildVivaPublicExercisesUrl({ vivaPublicBase, date }) {
  const query = new URLSearchParams({
    date,
    includePast: "true",
    past: "true",
  });
  return `${vivaPublicBase}/exercises?${query.toString()}`;
}

async function fetchVivaExercisesForDate({ token, vivaApiBase, date }) {
  const payload = await fetchJson(buildVivaAdminExercisesUrl({ vivaApiBase, date }), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
  return extractList(payload, ["content", "items", "data", "exercises", "results"]).filter(isRecord);
}

async function fetchVivaPublicExercisesForDate({ vivaPublicBase, date }) {
  const payload = await fetchJson(buildVivaPublicExercisesUrl({ vivaPublicBase, date }), {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
    },
  });
  return extractList(payload, ["content", "items", "data", "exercises", "results"]).filter(isRecord);
}

async function fetchVivaBookingsForExercise({ token, vivaApiBase, exerciseId, showCancelled }) {
  const query = new URLSearchParams({
    showCancelled: showCancelled ? "true" : "false",
    size: "500",
    sort: "visitConfirmed,asc",
  });
  query.append("sort", "client.lastName,asc");
  const payload = await fetchJson(`${vivaApiBase}/exercises/${encodeURIComponent(exerciseId)}/bookings?${query.toString()}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
  return extractList(payload, ["content", "items", "data", "bookings", "results"]).filter(isRecord);
}

function getExerciseSourceId(value) {
  if (!isRecord(value)) return "";
  return pickString(value, ["id", "exerciseId", "uuid", "sourceExerciseId"]);
}

function mergeExerciseSources(adminExercises, publicExercises) {
  const byId = new Map();
  for (const exercise of adminExercises) {
    const id = getExerciseSourceId(exercise);
    if (!id) continue;
    byId.set(id, exercise);
  }
  for (const exercise of publicExercises) {
    const id = getExerciseSourceId(exercise);
    if (!id || byId.has(id)) continue;
    byId.set(id, exercise);
  }
  return Array.from(byId.values());
}

async function loadExercisesFromViva(options) {
  const token = options.vivaToken || await fetchVivaToken(options);
  const exercisesWithBookings = [];
  const datesReport = [];

  for (const date of options.dates) {
    const adminExercises = await fetchVivaExercisesForDate({
      token,
      vivaApiBase: options.vivaApiBase,
      date,
    });
    const publicExercises = await fetchVivaPublicExercisesForDate({
      vivaPublicBase: options.vivaPublicBase,
      date,
    });
    const rawExercises = mergeExerciseSources(adminExercises, publicExercises);
    let eligible = 0;
    let bookingRequests = 0;

    for (const rawExercise of rawExercises) {
      const normalized = normalizeTrainingExercise(rawExercise, {
        allowedTypeIds: options.allowedTypeIds,
        allowedStudioIds: options.allowedStudioIds,
      });
      if (!normalized) continue;
      eligible += 1;
      bookingRequests += 1;
      const bookings = await fetchVivaBookingsForExercise({
        token,
        vivaApiBase: options.vivaApiBase,
        exerciseId: normalized.id,
        showCancelled: options.showCancelled,
      });
      exercisesWithBookings.push({
        ...rawExercise,
        bookings,
      });
    }

    datesReport.push({
      date,
      sourceExercises: rawExercises.length,
      adminSourceExercises: adminExercises.length,
      publicSourceExercises: publicExercises.length,
      eligibleExercises: eligible,
      bookingRequests,
    });
  }

  return {
    exercises: exercisesWithBookings,
    datesReport,
  };
}

function loadExercisesFromInputFile(inputFile) {
  const parsed = JSON.parse(fs.readFileSync(path.resolve(inputFile), "utf8"));
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.exercises)) return parsed.exercises;
  if (Array.isArray(parsed?.items)) return parsed.items;
  if (Array.isArray(parsed?.data)) return parsed.data;
  return [parsed];
}

async function ensureTrainingVisitIndexes(collection) {
  for (const index of TRAINING_VISITS_INDEXES) {
    await collection.createIndex(index.key, index.options);
  }
}

async function countArchiveCandidates(collection, plan) {
  if (!plan.archiveMissing || plan.scannedExerciseIds.length === 0) return 0;
  return collection.countDocuments({
    source: ACTIVE_VISIT_SOURCE,
    sourceExerciseId: { $in: plan.scannedExerciseIds },
    archived: { $ne: true },
    ...(plan.activeIds.length > 0 ? { id: { $nin: plan.activeIds } } : {}),
  });
}

function compactRecord(record) {
  return {
    id: record.id,
    bookingId: record.bookingId,
    exerciseId: record.exerciseId,
    date: record.date,
    timeToIso: record.timeToIso,
    clientId: record.clientId,
    phoneNorm: record.phoneNorm,
    name: record.name,
    studioId: record.studioId,
    typeId: record.typeId,
  };
}

function printUsage() {
  console.error(`
sync_training_visits_from_viva

Builds the lk_training_visits read model from Viva group training bookings.
Default mode is dry-run. Apply writes only to lk_training_visits.

Usage:
  node scripts/sync_training_visits_from_viva.mjs --date-from 2026-06-01 --date-to 2026-07-07 --mongo-uri "$MONGODB_URI"
  node scripts/sync_training_visits_from_viva.mjs --dates 2026-07-07 --apply --mongo-uri "$MONGODB_URI"
  node scripts/sync_training_visits_from_viva.mjs --input-file tmp/viva-training-fixture.json

Options:
  --dates <csv>              Exact dates, YYYY-MM-DD
  --date-from <YYYY-MM-DD>   Inclusive start date; default today
  --date-to <YYYY-MM-DD>     Inclusive end date; default date-from/today
  --input-file <path>        JSON exercise payloads with nested bookings
  --mongo-uri <uri>          Mongo URI; or MONGO_URI/MONGODB_URI
  --db <name>                Mongo database, default games
  --collection <name>        Target collection, default lk_training_visits
  --apply                    Apply upserts/archive to Mongo (default dry-run)
  --keep-missing             Do not archive previously materialized rows missing from the current scan
  --skip-indexes             Do not create indexes before apply
  --studio-ids <csv>         Restrict to studio ids; default PadlHub group schedule studios
  --all-studios              Do not filter by studio id
  --type-ids <csv>           Restrict Viva exercise type ids; default 605,847,963,1208
  --out <path>               Write JSON report to file too

Viva options:
  --viva-token <token>       Use an existing bearer token
  --viva-token-url <url>     Default ${DEFAULT_VIVA_TOKEN_URL}
  --viva-api-base <url>      Default ${DEFAULT_VIVA_API_BASE}
  --viva-public-base <url>   Default ${DEFAULT_VIVA_PUBLIC_BASE}
  --viva-client-id <id>      Or VIVA_CLIENT_ID
  --viva-username <user>     Or VIVA_USERNAME
  --viva-password <pass>     Or VIVA_PASSWORD
`);
}

function buildCliOptions() {
  const typeIds = splitCsv(getArg("--type-ids"))
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item));
  const allowedTypeIds = typeIds.length > 0 ? typeIds : GROUP_TRAINING_TYPE_IDS;
  const studioIds = splitCsv(getArg("--studio-ids"));
  const allowedStudioIds = hasFlag("--all-studios")
    ? []
    : (studioIds.length > 0 ? studioIds : DEFAULT_GROUP_TRAINING_STUDIO_IDS);
  const dates = enumerateDates({
    dates: getArg("--dates"),
    dateFrom: getArg("--date-from"),
    dateTo: getArg("--date-to"),
  });

  return {
    showHelp: hasFlag("--help") || hasFlag("-h"),
    apply: hasFlag("--apply"),
    dryRun: !hasFlag("--apply"),
    archiveMissing: !hasFlag("--keep-missing"),
    skipIndexes: hasFlag("--skip-indexes"),
    showCancelled: !hasFlag("--hide-cancelled"),
    dates,
    inputFile: getArg("--input-file"),
    outFile: getArg("--out"),
    mongoUri: getArg("--mongo-uri", process.env.MONGO_URI || process.env.MONGODB_URI),
    dbName: getArg("--db", process.env.MONGO_DB || "games"),
    collectionName: getArg("--collection", TRAINING_VISITS_COLLECTION),
    allowedTypeIds,
    allowedStudioIds,
    syncedAt: new Date().toISOString(),
    vivaToken: getArg("--viva-token", process.env.VIVA_TOKEN || ""),
    vivaTokenUrl: getArg("--viva-token-url", process.env.VIVA_TOKEN_URL || DEFAULT_VIVA_TOKEN_URL),
    vivaApiBase: getArg("--viva-api-base", process.env.VIVA_API_BASE || DEFAULT_VIVA_API_BASE).replace(/\/+$/, ""),
    vivaPublicBase: getArg("--viva-public-base", process.env.VIVA_PUBLIC_BASE || DEFAULT_VIVA_PUBLIC_BASE).replace(/\/+$/, ""),
    vivaClientId: getArg("--viva-client-id", process.env.VIVA_CLIENT_ID || ""),
    vivaUsername: getArg("--viva-username", process.env.VIVA_USERNAME || ""),
    vivaPassword: getArg("--viva-password", process.env.VIVA_PASSWORD || ""),
  };
}

function validateCliOptions(options) {
  if (options.showHelp) return;
  if (!options.inputFile && options.dates.length === 0) {
    throw new Error("Missing dates. Pass --dates or --date-from/--date-to.");
  }
  if (!options.inputFile && !options.vivaToken && (!options.vivaClientId || !options.vivaUsername || !options.vivaPassword)) {
    throw new Error("Missing Viva credentials. Pass --viva-token or VIVA_CLIENT_ID/VIVA_USERNAME/VIVA_PASSWORD.");
  }
  if (options.apply && !options.mongoUri) {
    throw new Error("Missing Mongo URI for --apply. Pass --mongo-uri or MONGO_URI/MONGODB_URI.");
  }
}

async function run(options) {
  validateCliOptions(options);
  if (options.showHelp) {
    printUsage();
    return null;
  }

  const source = options.inputFile
    ? {
      exercises: loadExercisesFromInputFile(options.inputFile),
      datesReport: [],
    }
    : await loadExercisesFromViva(options);

  const normalized = buildTrainingVisitRecordsFromExercises(source.exercises, {
    syncedAt: options.syncedAt,
    allowedTypeIds: options.allowedTypeIds,
    allowedStudioIds: options.allowedStudioIds,
  });
  const plan = buildTrainingVisitBulkPlan({
    records: normalized.records,
    scannedExerciseIds: normalized.scannedExerciseIds,
    archiveMissing: options.archiveMissing,
    syncedAt: options.syncedAt,
  });

  let applyResult = null;
  let archiveCandidates = null;

  if (options.mongoUri) {
    const client = new MongoClient(options.mongoUri, {
      maxPoolSize: 8,
      minPoolSize: 0,
      serverSelectionTimeoutMS: 20000,
      connectTimeoutMS: 20000,
    });
    try {
      await client.connect();
      const collection = client.db(options.dbName).collection(options.collectionName);
      archiveCandidates = await countArchiveCandidates(collection, plan);
      if (options.apply) {
        if (!options.skipIndexes) {
          await ensureTrainingVisitIndexes(collection);
        }
        applyResult = plan.operations.length > 0
          ? await collection.bulkWrite(plan.operations, { ordered: false })
          : null;
      }
    } finally {
      await client.close();
    }
  }

  const report = {
    ok: true,
    mode: options.apply ? "apply" : "dry-run",
    dryRun: options.dryRun,
    db: options.dbName,
    collection: options.collectionName,
    source: options.inputFile ? "input-file" : "viva",
    dates: options.dates,
    syncedAt: options.syncedAt,
    filters: {
      typeIds: options.allowedTypeIds,
      studioIds: options.allowedStudioIds,
      archiveMissing: options.archiveMissing,
    },
    datesReport: source.datesReport,
    stats: normalized.stats,
    scannedExerciseIds: normalized.scannedExerciseIds.length,
    records: normalized.records.length,
    archiveCandidates,
    writes: {
      plannedOperations: plan.operations.length,
      upserts: plan.summary.upserts,
      archiveMissingOperations: plan.summary.archiveMissingOperations,
      applied: Boolean(applyResult),
      result: applyResult ? {
        acknowledged: applyResult.acknowledged === true,
        insertedCount: applyResult.insertedCount || 0,
        matchedCount: applyResult.matchedCount || 0,
        modifiedCount: applyResult.modifiedCount || 0,
        upsertedCount: applyResult.upsertedCount || 0,
        deletedCount: applyResult.deletedCount || 0,
      } : null,
    },
    preview: normalized.records.slice(0, 20).map(compactRecord),
  };

  if (options.outFile) {
    fs.mkdirSync(path.dirname(path.resolve(options.outFile)), { recursive: true });
    fs.writeFileSync(path.resolve(options.outFile), `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(JSON.stringify(report, null, 2));
  return report;
}

const isCliEntrypoint = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isCliEntrypoint) {
  run(buildCliOptions()).catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
  });
}

export {
  buildCliOptions,
  run,
};
