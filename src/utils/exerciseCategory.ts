export const EXERCISE_CATEGORY_OPEN_GAME = "open_game" as const;
export const EXERCISE_CATEGORY_COURT_RENTAL = "court_rental" as const;
export const EXERCISE_CATEGORY_GROUP_TRAINING = "group_training" as const;
export const EXERCISE_CATEGORY_TOURNAMENT = "tournament" as const;

export type ExerciseCategory =
  | typeof EXERCISE_CATEGORY_OPEN_GAME
  | typeof EXERCISE_CATEGORY_COURT_RENTAL
  | typeof EXERCISE_CATEGORY_GROUP_TRAINING
  | typeof EXERCISE_CATEGORY_TOURNAMENT;

export type CabinetBookingCategory = "games" | "trainings" | "tournaments" | "other";

export const EXERCISE_CATEGORY_OPEN_GAME_DIRECTION_IDS = [4588] as const;
export const EXERCISE_CATEGORY_OPEN_GAME_TYPE_IDS = [1613] as const;
export const EXERCISE_CATEGORY_GROUP_TRAINING_TYPE_IDS = [605, 847, 963, 1208] as const;
export const EXERCISE_CATEGORY_TOURNAMENT_DIRECTION_IDS = [2617, 3284, 4769] as const;
export const EXERCISE_CATEGORY_TOURNAMENT_TYPE_IDS = [839, 1013] as const;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toStr(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  const text = toStr(value);
  if (!text) return null;
  const parsed = Number(text.replace(",", "."));
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function pickRecord(source: UnknownRecord | null | undefined, keys: string[]): UnknownRecord | null {
  if (!source) return null;
  for (const key of keys) {
    const candidate = source[key];
    if (isRecord(candidate)) return candidate;
  }
  return null;
}

function pickString(source: UnknownRecord | null | undefined, keys: string[]): string | null {
  if (!source) return null;
  for (const key of keys) {
    const candidate = toStr(source[key]);
    if (candidate) return candidate;
  }
  return null;
}

function pickNumber(source: UnknownRecord | null | undefined, keys: string[]): number | null {
  if (!source) return null;
  for (const key of keys) {
    const candidate = toNumber(source[key]);
    if (candidate !== null) return candidate;
  }
  return null;
}

function includesNumber(values: readonly number[], value: number | null): boolean {
  return value !== null && values.includes(value);
}

function normalizeMarker(value: unknown): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^a-z0-9а-я]+/g, "");
}

function collectNameMarkers(source: UnknownRecord | null | undefined): string[] {
  if (!source) return [];
  return [
    pickString(source, ["name", "title", "label"]),
    pickString(source, ["directionName", "directionTitle"]),
    pickString(source, ["typeName", "typeTitle", "exerciseTypeName", "categoryName"]),
    pickString(pickRecord(source, ["direction"]), ["name", "title"]),
    pickString(pickRecord(source, ["type", "exerciseType", "category"]), ["name", "title"]),
  ]
    .map((value) => normalizeMarker(value))
    .filter(Boolean);
}

function hasTournamentMarker(markers: string[]): boolean {
  return markers.some((marker) => (
    marker.includes("турнир")
    || marker.includes("tournament")
    || marker.includes("американо")
    || marker.includes("americano")
    || marker.includes("мексикано")
    || marker.includes("mexicano")
    || marker.includes("roundrobin")
    || marker.includes("олимп")
    || marker.includes("паделтурнир")
    || marker.includes("padeltournament")
    || marker.includes("турнирособый")
    || marker.includes("tournamentspecial")
  ));
}

function hasGroupTrainingMarker(markers: string[]): boolean {
  return markers.some((marker) => (
    marker.includes("трен")
    || marker.includes("training")
    || marker.includes("coach")
    || marker.includes("групп")
    || marker.includes("group")
    || marker.includes("игратренер")
    || marker.includes("gameplustrainer")
  ));
}

function hasOpenGameMarker(markers: string[]): boolean {
  return markers.some((marker) => (
    marker.includes("свояигра")
    || marker.includes("своюигру")
    || marker.includes("открытаяигра")
    || marker.includes("opengame")
    || marker.includes("сплит")
    || marker.includes("split")
    || marker.includes("игра")
    || marker.includes("game")
  ));
}

function hasCourtRentalMarker(markers: string[]): boolean {
  return markers.some((marker) => (
    marker.includes("аренда")
    || marker.includes("арендовать")
    || marker.includes("courtrental")
    || marker.includes("rentalcourt")
  ));
}

export function resolveExerciseCategoryFromValue(value: unknown): ExerciseCategory | null {
  if (!isRecord(value)) return null;

  const exercise = pickRecord(value, ["exercise", "event", "tournament"]) ?? value;
  const type = pickRecord(exercise, ["type", "exerciseType", "category"]);
  const direction = pickRecord(exercise, ["direction"]);
  const typeId =
    pickNumber(type, ["id", "typeId", "exerciseTypeId"])
    ?? pickNumber(exercise, ["typeId", "exerciseTypeId", "vivaExerciseTypeId"]);
  const directionId =
    pickNumber(direction, ["id", "directionId"])
    ?? pickNumber(exercise, ["directionId", "vivaDirectionId"]);

  if (
    includesNumber(EXERCISE_CATEGORY_OPEN_GAME_TYPE_IDS, typeId)
    || includesNumber(EXERCISE_CATEGORY_OPEN_GAME_DIRECTION_IDS, directionId)
  ) {
    return EXERCISE_CATEGORY_OPEN_GAME;
  }

  if (
    includesNumber(EXERCISE_CATEGORY_TOURNAMENT_TYPE_IDS, typeId)
    || includesNumber(EXERCISE_CATEGORY_TOURNAMENT_DIRECTION_IDS, directionId)
  ) {
    return EXERCISE_CATEGORY_TOURNAMENT;
  }

  if (includesNumber(EXERCISE_CATEGORY_GROUP_TRAINING_TYPE_IDS, typeId)) {
    return EXERCISE_CATEGORY_GROUP_TRAINING;
  }

  const markers = collectNameMarkers(exercise);
  if (hasTournamentMarker(markers)) return EXERCISE_CATEGORY_TOURNAMENT;
  if (hasGroupTrainingMarker(markers)) return EXERCISE_CATEGORY_GROUP_TRAINING;
  if (hasOpenGameMarker(markers)) return EXERCISE_CATEGORY_OPEN_GAME;
  if (hasCourtRentalMarker(markers)) return EXERCISE_CATEGORY_COURT_RENTAL;

  return null;
}

export function isExerciseConvertibleToGameFromBooking(value: unknown): boolean {
  const category = resolveExerciseCategoryFromValue(value);
  return category === EXERCISE_CATEGORY_OPEN_GAME || category === EXERCISE_CATEGORY_COURT_RENTAL;
}

export function resolveCabinetBookingCategory(value: unknown): CabinetBookingCategory {
  const category = resolveExerciseCategoryFromValue(value);
  if (category === EXERCISE_CATEGORY_OPEN_GAME) return "games";
  if (category === EXERCISE_CATEGORY_GROUP_TRAINING) return "trainings";
  if (category === EXERCISE_CATEGORY_TOURNAMENT) return "tournaments";
  return "other";
}
