import { EXERCISE_CATEGORY_GROUP_TRAINING_TYPE_IDS } from "./exerciseCategory.ts";

export const GROUP_SCHEDULE_BOOKING_DAYS = 14;
export const GROUP_SCHEDULE_GAME_PLUS_TRAINER_TYPE_ID = 847;
export const GROUP_SCHEDULE_ALLOWED_TYPE_IDS = EXERCISE_CATEGORY_GROUP_TRAINING_TYPE_IDS;
export const GROUP_SCHEDULE_AVAILABLE_STUDIO_IDS = [
  "6b2d7e60-caff-4b22-89f6-6f19d7d311ab",
  "42c6d4df-833d-480a-bdc8-986716569884",
  "588b6151-f4f5-47d9-9449-80edf8cbc748",
  "0d5504f6-ea6f-44bb-a9e4-947faf0273ab",
  "6a7a9edc-6869-40ad-a5a1-8a1cdfb746a1",
  "3656cbaa-6426-490f-a44f-915404cbdd2b",
] as const;

export type GroupTrainingStatus = "AVAILABLE" | "FULL" | "CANCELLED";

export type GroupScheduleTrainer = {
  id: string;
  firstName: string;
  lastName: string;
  photo?: string;
};

export type GroupTrainingSummary = {
  id: string;
  title: string;
  typeId: number | null;
  typeName: string | null;
  typeColor: string | null;
  directionId: number | null;
  directionName: string | null;
  directionDescription: string | null;
  whatToTake: string | null;
  timeFrom: string;
  timeTo: string;
  date: string | null;
  timeLabel: string;
  clientsCount: number;
  maxClientsCount: number;
  spotsLeft: number | null;
  status: GroupTrainingStatus;
  girlsOnly: boolean;
  studioId: string | null;
  studioName: string | null;
  studioAddress: string | null;
  roomId: string | null;
  roomName: string | null;
  trainers: GroupScheduleTrainer[];
  trainerName: string | null;
  trainerAvatarUrl: string | null;
  levelLabel: string | null;
  inBooking: boolean;
  inWaitlist: boolean;
  inReserve: boolean;
  cancellationDeadline: string | null;
  raw: Record<string, unknown>;
};

type QueryValue = string | number | boolean | null | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function pickString(value: unknown, keys: string[]): string | null {
  if (!isRecord(value)) return null;
  for (const key of keys) {
    const raw = value[key];
    if (typeof raw === "string" && raw.trim()) return raw.trim();
    if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  }
  return null;
}

function pickNumber(value: unknown, keys: string[]): number | null {
  if (!isRecord(value)) return null;
  for (const key of keys) {
    const raw = value[key];
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
    if (typeof raw === "string" && raw.trim()) {
      const parsed = Number(raw.replace(",", "."));
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function pickBoolean(value: unknown, keys: string[]): boolean | null {
  if (!isRecord(value)) return null;
  for (const key of keys) {
    const raw = value[key];
    if (typeof raw === "boolean") return raw;
    if (typeof raw === "number" && Number.isFinite(raw)) return raw !== 0;
    if (typeof raw === "string") {
      const normalized = raw.trim().toLowerCase();
      if (["true", "1", "yes", "y", "on", "да"].includes(normalized)) return true;
      if (["false", "0", "no", "n", "off", "нет"].includes(normalized)) return false;
    }
  }
  return null;
}

function pickNestedRecord(value: unknown, keys: string[]): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  for (const key of keys) {
    const raw = value[key];
    if (isRecord(raw)) return raw;
  }
  return null;
}

function pickArray(value: unknown, keys: string[]): unknown[] {
  if (!isRecord(value)) return [];
  for (const key of keys) {
    const raw = value[key];
    if (Array.isArray(raw)) return raw;
  }
  return [];
}

function normalizeNumber(value: number | null, fallback = 0) {
  if (value == null || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function normalizeDate(value: unknown) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const isoDate = raw.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  if (isoDate) return isoDate;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, "0");
  const day = String(parsed.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatClock(value: string | null | undefined) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  }
  return raw.match(/\d{2}:\d{2}/)?.[0] || "";
}

function formatTimeLabel(timeFrom: string, timeTo: string) {
  const from = formatClock(timeFrom);
  const to = formatClock(timeTo);
  if (from && to) return `${from}-${to}`;
  return from || to || "Время уточняется";
}

function normalizeTrainer(value: unknown): GroupScheduleTrainer | null {
  if (!isRecord(value)) return null;
  const id = pickString(value, ["id", "uuid", "trainerId"]) || "";
  const firstName = pickString(value, ["firstName", "firstname", "givenName", "name"]) || "";
  const lastName = pickString(value, ["lastName", "lastname", "familyName", "surname"]) || "";
  const displayName = pickString(value, ["displayName", "fullName", "title"]);
  const parts = displayName && !firstName && !lastName
    ? displayName.split(/\s+/).filter(Boolean)
    : [];
  const normalizedFirstName = firstName || parts[0] || "Тренер";
  const normalizedLastName = lastName || parts.slice(1).join(" ");
  return {
    id,
    firstName: normalizedFirstName,
    lastName: normalizedLastName,
    photo: pickString(value, ["photo", "photoUrl", "avatar", "imageUrl"]) || undefined,
  };
}

function normalizeTrainers(value: unknown) {
  return pickArray(value, ["trainers", "executors", "coaches"])
    .map(normalizeTrainer)
    .filter((item): item is GroupScheduleTrainer => item !== null);
}

function normalizeTitleLevel(value: string | null) {
  const title = String(value || "").trim();
  if (!title) return null;
  const match = title.match(/уров(?:ень|ня)\s+([A-ZА-Я0-9+./\s-]+)/i);
  if (!match?.[1]) return null;
  return match[1]
    .replace(/\s+/g, " ")
    .replace(/\s*\/\s*/g, "/")
    .trim()
    .toUpperCase();
}

function normalizeTrainingSearchText(value: string | null | undefined) {
  return String(value || "")
    .trim()
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeRoomName(value: string | null) {
  const normalized = String(value || "").trim();
  if (!normalized) return null;
  return normalized
    .replace(/\s*\([^)]*\)\s*/g, " ")
    .replace(/\s*(?:ультра)?панорамик\s*/gi, " ")
    .replace(/\s+/g, " ")
    .trim() || normalized;
}

function getExerciseStatus(value: unknown, clientsCount: number, maxClientsCount: number): GroupTrainingStatus {
  if (!isRecord(value)) return "AVAILABLE";
  const status = String(pickString(value, ["status", "state"]) || "").trim().toUpperCase();
  if (
    value.isCancelled === true
    || value.cancelled === true
    || value.canceled === true
    || value.archived === true
    || status.includes("CANCEL")
    || status.includes("ARCHIVE")
  ) {
    return "CANCELLED";
  }
  if (maxClientsCount > 0 && clientsCount >= maxClientsCount) return "FULL";
  return "AVAILABLE";
}

function extractItems(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload)) return [];
  for (const key of ["content", "items", "data", "exercises", "results"]) {
    const raw = payload[key];
    if (Array.isArray(raw)) return raw;
  }
  return [];
}

export function buildGroupScheduleQuery(params: Record<string, QueryValue>) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value == null || value === "") return;
    query.set(key, String(value));
  });
  const value = query.toString();
  return value ? `?${value}` : "";
}

export function getGroupTrainingTypeId(value: unknown) {
  if (!isRecord(value)) return null;
  const type = pickNestedRecord(value, ["type", "exerciseType"]);
  return pickNumber(type, ["id", "typeId"]) ?? pickNumber(value, ["typeId", "exerciseTypeId"]);
}

export function isGamePlusTrainerTraining(value: unknown) {
  if (!isRecord(value)) return false;
  if (getGroupTrainingTypeId(value) === GROUP_SCHEDULE_GAME_PLUS_TRAINER_TYPE_ID) return true;

  const type = pickNestedRecord(value, ["type", "exerciseType"]);
  const direction = pickNestedRecord(value, ["direction"]);
  const haystack = normalizeTrainingSearchText([
    pickString(type, ["name", "title"]),
    pickString(direction, ["name", "title"]),
    pickString(value, ["typeName", "directionName", "title", "name"]),
  ].filter(Boolean).join(" "));
  return haystack.includes("игра тренер");
}

export function isGamePlusTrainerSummary(training: GroupTrainingSummary) {
  return isGamePlusTrainerTraining(training) || isGamePlusTrainerTraining(training.raw);
}

export function isGroupTrainingAllowed(
  value: unknown,
  options: {
    allowedTypeIds?: readonly number[];
    availableStudioIds?: readonly string[];
  } = {},
) {
  if (!isRecord(value)) return false;
  const allowedTypeIds = options.allowedTypeIds ?? GROUP_SCHEDULE_ALLOWED_TYPE_IDS;
  const availableStudioIds = options.availableStudioIds ?? GROUP_SCHEDULE_AVAILABLE_STUDIO_IDS;
  const typeId = getGroupTrainingTypeId(value);
  if (typeId == null || !allowedTypeIds.includes(typeId)) return false;

  const studio = pickNestedRecord(value, ["studio", "station", "club"]);
  const studioId = pickString(studio, ["id", "studioId"]) || pickString(value, ["studioId", "stationId"]);
  if (studioId && availableStudioIds.length > 0 && !availableStudioIds.includes(studioId)) return false;

  return true;
}

export function normalizeGroupTraining(value: unknown): GroupTrainingSummary | null {
  if (!isRecord(value) || !isGroupTrainingAllowed(value)) return null;
  const id = pickString(value, ["id", "exerciseId", "uuid"]);
  const direction = pickNestedRecord(value, ["direction"]);
  const type = pickNestedRecord(value, ["type", "exerciseType"]);
  const studio = pickNestedRecord(value, ["studio", "station", "club"]);
  const room = pickNestedRecord(value, ["room", "court"]);
  const timeFrom = pickString(value, ["timeFrom", "startsAt", "startAt"]);
  const timeTo = pickString(value, ["timeTo", "endsAt", "endAt"]);
  if (!id || !timeFrom || !timeTo) return null;

  const clientsCount = normalizeNumber(pickNumber(value, ["clientsCount", "participantsCount", "bookedCount"]));
  const maxClientsCount = normalizeNumber(pickNumber(value, ["maxClientsCount", "maxParticipants", "capacity"]));
  const directionName = pickString(direction, ["name", "title"]) || pickString(value, ["directionName"]);
  const typeName = pickString(type, ["name", "title"]) || pickString(value, ["typeName"]);
  const title = directionName || typeName || "Групповая тренировка";
  const trainers = normalizeTrainers(value);
  const trainerName = trainers
    .map((trainer) => [trainer.firstName, trainer.lastName].filter(Boolean).join(" ").trim())
    .filter(Boolean)
    .join(", ") || null;
  const status = getExerciseStatus(value, clientsCount, maxClientsCount);

  return {
    id,
    title,
    typeId: getGroupTrainingTypeId(value),
    typeName,
    typeColor: pickString(type, ["color"]),
    directionId: pickNumber(direction, ["id", "directionId"]) ?? pickNumber(value, ["directionId"]),
    directionName,
    directionDescription: pickString(direction, ["description", "body", "text"]),
    whatToTake: pickString(direction, ["whatToTake"]),
    timeFrom,
    timeTo,
    date: normalizeDate(timeFrom),
    timeLabel: formatTimeLabel(timeFrom, timeTo),
    clientsCount,
    maxClientsCount,
    spotsLeft: maxClientsCount > 0 ? Math.max(0, maxClientsCount - clientsCount) : null,
    status,
    girlsOnly: pickBoolean(value, ["girlsOnly", "femaleOnly", "womenOnly"]) === true,
    studioId: pickString(studio, ["id", "studioId"]) || pickString(value, ["studioId", "stationId"]),
    studioName: pickString(studio, ["name", "title"]) || pickString(value, ["studioName", "stationName"]),
    studioAddress: pickString(studio, ["address", "fullAddress"]) || pickString(value, ["address", "studioAddress"]),
    roomId: pickString(room, ["id", "roomId"]) || pickString(value, ["roomId", "courtId"]),
    roomName: normalizeRoomName(pickString(room, ["name", "title"]) || pickString(value, ["roomName", "courtName"])),
    trainers,
    trainerName,
    trainerAvatarUrl: trainers.find((trainer) => trainer.photo)?.photo ?? null,
    levelLabel: normalizeTitleLevel(title),
    inBooking: pickBoolean(value, ["inBooking"]) === true,
    inWaitlist: pickBoolean(value, ["inWaitlist"]) === true,
    inReserve: pickBoolean(value, ["inReserve"]) === true,
    cancellationDeadline: pickString(value, ["cancellationDeadline"]),
    raw: value,
  };
}

export function normalizeGroupTrainingList(payload: unknown) {
  return extractItems(payload)
    .map((item) => normalizeGroupTraining(item))
    .filter((item): item is GroupTrainingSummary => item !== null)
    .sort((left, right) => {
      const leftTs = Date.parse(left.timeFrom || "");
      const rightTs = Date.parse(right.timeFrom || "");
      const safeLeft = Number.isFinite(leftTs) ? leftTs : Number.MAX_SAFE_INTEGER;
      const safeRight = Number.isFinite(rightTs) ? rightTs : Number.MAX_SAFE_INTEGER;
      return safeLeft - safeRight;
    });
}
