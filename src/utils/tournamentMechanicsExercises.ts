import type { Exercise, Trainer } from "./apiClient";
import type { TournamentSignupSummary } from "./tournamentSignupApi";

const DEFAULT_TOURNAMENT_DIRECTION_ID = 2617;

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

function pickNestedFirstRecord(value: unknown, keys: string[]): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  for (const key of keys) {
    const raw = value[key];
    if (Array.isArray(raw)) {
      const record = raw.find(isRecord);
      if (record) return record;
    }
    if (isRecord(raw)) return raw;
  }
  return null;
}

function pickPersonName(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const direct = pickString(value, ["name", "displayName", "fullName", "title"]);
  if (direct) return direct;
  const name = [
    pickString(value, ["firstName", "firstname", "givenName"]),
    pickString(value, ["lastName", "lastname", "familyName"]),
  ].filter(Boolean).join(" ").trim();
  return name || null;
}

function splitTrainerName(name: string | null) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  return {
    firstName: parts[0] || "Турнир",
    lastName: parts.slice(1).join(" ") || "исполнитель",
  };
}

function buildSyntheticTrainer(summary: TournamentSignupSummary): Trainer[] {
  const person = pickNestedFirstRecord(summary.raw, [
    "trainer",
    "trainers",
    "coach",
    "coaches",
    "executor",
    "executors",
    "performer",
    "performers",
    "responsible",
    "organizer",
    "instructor",
  ]);
  const name = summary.trainerName || pickPersonName(person);
  if (!name) return [];

  const trainerId =
    pickString(person, ["id", "uuid", "trainerId", "executorId", "performerId", "responsibleId"])
    || "";
  const photo =
    summary.trainerAvatarUrl
    || pickString(person, ["avatarUrl", "avatar", "photo", "imageUrl", "picture"])
    || undefined;
  const { firstName, lastName } = splitTrainerName(name);

  return [{
    id: trainerId,
    firstName,
    lastName,
    photo,
  }];
}

function ensureIsoDateTime(value: string | null, dateKey: string | null, fallbackTime: string) {
  const normalized = String(value || "").trim();
  if (normalized) return normalized;
  if (!dateKey) return "";
  return `${dateKey}T${fallbackTime}:00+03:00`;
}

export function getTournamentMechanicsExerciseDateKey(exercise?: Pick<Exercise, "timeFrom"> | null) {
  const normalized = String(exercise?.timeFrom || "").trim();
  if (!normalized) return null;
  const isoDate = normalized.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  if (isoDate) return isoDate;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function buildSyntheticTournamentExercise(summary: TournamentSignupSummary): Exercise {
  const studio = pickNestedRecord(summary.raw, ["studio", "station", "club", "location"]);
  const room = pickNestedRecord(summary.raw, ["room", "court"]);
  const direction = pickNestedRecord(summary.raw, ["direction"]);
  const type = pickNestedRecord(summary.raw, ["type", "exerciseType", "category"]);
  const dateKey = summary.date || getTournamentMechanicsExerciseDateKey(
    summary.startsAt ? { timeFrom: summary.startsAt } : null,
  );
  const directionId =
    pickNumber(summary.raw, ["directionId", "vivaDirectionId"])
    ?? pickNumber(direction, ["id", "directionId"])
    ?? DEFAULT_TOURNAMENT_DIRECTION_ID;
  const typeId =
    pickNumber(summary.raw, ["typeId", "exerciseTypeId", "vivaExerciseTypeId"])
    ?? pickNumber(type, ["id", "typeId", "exerciseTypeId"])
    ?? directionId;
  const studioId =
    pickString(summary.raw, ["studioId", "stationId", "clubId"])
    || pickString(studio, ["id"])
    || `synthetic-studio:${summary.exerciseId}`;
  const roomId =
    pickString(summary.raw, ["roomId", "courtId"])
    || pickString(room, ["id"])
    || `synthetic-room:${summary.exerciseId}`;
  const timeFrom = ensureIsoDateTime(summary.startsAt, dateKey, "00:00");
  const timeTo = ensureIsoDateTime(summary.endsAt, dateKey, "23:59");

  return {
    id: summary.exerciseId,
    direction: {
      id: directionId,
      name:
        pickString(direction, ["name", "title"])
        || pickString(summary.raw, ["directionName"])
        || "Турнир",
    },
    type: {
      id: typeId,
      name:
        pickString(type, ["name", "title"])
        || pickString(summary.raw, ["typeName", "exerciseTypeName", "category"])
        || summary.format
        || "Турнир",
      color: "#1F1F1F",
      format: "TOURNAMENT",
    },
    timeFrom,
    timeTo,
    clientsCount: summary.participantsCount ?? 0,
    maxClientsCount: summary.maxParticipants ?? 0,
    girlsOnly: pickBoolean(summary.raw, ["girlsOnly", "femaleOnly", "womenOnly"]) === true,
    studio: {
      id: studioId,
      name: summary.studioName || pickString(studio, ["name", "title"]) || "Турнирная площадка",
      country: pickString(studio, ["country", "countryName"]) || "Россия",
      city:
        pickString(summary.raw, ["city", "cityName"])
        || pickString(studio, ["city", "cityName", "town", "locality"])
        || "",
      address:
        summary.address
        || pickString(studio, ["address", "fullAddress", "location", "street"])
        || "",
      panoramicCourtsCount: pickNumber(studio, ["panoramicCourtsCount", "panoramicCourts"]),
      masterServiceId: pickString(studio, ["masterServiceId", "master_service_id"]),
      preferredSubServiceId: pickString(studio, ["preferredSubServiceId", "preferred_sub_service_id"]),
      subServiceIds: [],
      lat: pickNumber(studio, ["lat", "latitude"]),
      lng: pickNumber(studio, ["lng", "longitude", "lon"]),
    },
    room: {
      id: roomId,
      name:
        pickString(summary.raw, ["roomName", "courtName", "courtTitle"])
        || pickString(room, ["name", "title"])
        || "Корт",
    },
    trainers: buildSyntheticTrainer(summary),
    status: summary.status,
    state: summary.status,
    cancelled: summary.status === "CANCELLED",
    archived: false,
    // Extra ids help deep-link lookup by local tournamentId from public URLs.
    ...({
      tournamentId: summary.id,
      exerciseId: summary.exerciseId,
      sourceTournamentId: summary.exerciseId,
      publicUrl: summary.publicUrl,
      raw: summary.raw,
    } as Record<string, unknown>),
  } as Exercise;
}

export function buildTournamentMechanicsFallbackExercises(items: TournamentSignupSummary[]) {
  const byId = new Map<string, Exercise>();
  items.forEach((summary) => {
    if (!summary?.exerciseId || summary.status === "CANCELLED") return;
    byId.set(summary.exerciseId, buildSyntheticTournamentExercise(summary));
  });
  return Array.from(byId.values());
}

function mergePrimaryTournamentExercise(primary: Exercise, fallback: Exercise): Exercise {
  const primaryTrainers = Array.isArray(primary.trainers)
    ? primary.trainers.filter(Boolean)
    : [];
  const fallbackTrainers = Array.isArray(fallback.trainers)
    ? fallback.trainers.filter(Boolean)
    : [];

  return {
    ...fallback,
    ...primary,
    direction: {
      ...(fallback.direction ?? {}),
      ...(primary.direction ?? {}),
    },
    type: {
      ...(fallback.type ?? {}),
      ...(primary.type ?? {}),
    },
    studio: {
      ...(fallback.studio ?? {}),
      ...(primary.studio ?? {}),
    },
    room: {
      ...(fallback.room ?? {}),
      ...(primary.room ?? {}),
    },
    trainers: primaryTrainers.length > 0 ? primaryTrainers : fallbackTrainers,
    timeFrom: primary.timeFrom || fallback.timeFrom,
    timeTo: primary.timeTo || fallback.timeTo,
    clientsCount: primary.clientsCount ?? fallback.clientsCount,
    maxClientsCount: primary.maxClientsCount ?? fallback.maxClientsCount,
    girlsOnly: primary.girlsOnly ?? fallback.girlsOnly,
    status: primary.status ?? fallback.status,
    state: primary.state ?? fallback.state,
    cancelled: primary.cancelled ?? fallback.cancelled,
    archived: primary.archived ?? fallback.archived,
  };
}

export function mergeTournamentMechanicsExercises(
  primary: Exercise[],
  fallback: Exercise[],
  dateKey: string,
) {
  const merged = new Map<string, Exercise>();

  fallback.forEach((exercise) => {
    const id = String(exercise?.id || "").trim();
    if (!id || getTournamentMechanicsExerciseDateKey(exercise) !== dateKey) return;
    merged.set(id, exercise);
  });

  primary.forEach((exercise) => {
    const id = String(exercise?.id || "").trim();
    if (!id || getTournamentMechanicsExerciseDateKey(exercise) !== dateKey) return;
    const existing = merged.get(id);
    merged.set(id, existing ? mergePrimaryTournamentExercise(exercise, existing) : exercise);
  });

  return Array.from(merged.values()).sort((left, right) => {
    const leftTs = Date.parse(left.timeFrom || "");
    const rightTs = Date.parse(right.timeFrom || "");
    const safeLeftTs = Number.isFinite(leftTs) ? leftTs : 0;
    const safeRightTs = Number.isFinite(rightTs) ? rightTs : 0;
    return safeLeftTs - safeRightTs;
  });
}
