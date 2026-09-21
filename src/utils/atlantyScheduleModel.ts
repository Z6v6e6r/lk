/**
 * Модель витрины корпоративного расписания «Время Атланты».
 *
 * Источник данных — публичный end-user API VivaCRM (тип занятия 2349
 * «Корпоративные клиенты», направление 6152 «Атланты»).
 */

export const ATLANTY_CORPORATE_TYPE_IDS = [2349] as const;
export const ATLANTY_CORPORATE_DIRECTION_IDS = [6152] as const;

export const ATLANTY_DEFAULT_TIME_ZONE = "Europe/Moscow";
export const ATLANTY_DEFAULT_PILL_LABEL = "Время Атланты";

const MONTHS_SHORT = [
  "янв",
  "фев",
  "мар",
  "апр",
  "мая",
  "июн",
  "июл",
  "авг",
  "сент",
  "окт",
  "ноя",
  "дек",
] as const;

const WEEKDAYS_SHORT = ["ВС", "ПН", "ВТ", "СР", "ЧТ", "ПТ", "СБ"] as const;

type UnknownRecord = Record<string, unknown>;

export type AtlantyScheduleEvent = {
  id: string;
  title: string;
  directionName: string | null;
  typeName: string | null;
  photoUrl: string | null;
  startAt: string;
  endAt: string;
  /** Локальная дата события (YYYY-MM-DD) в часовом поясе клуба. */
  date: string | null;
  dayLabel: string;
  monthLabel: string;
  weekdayLabel: string;
  /** «09:00–10:30» */
  timeRangeLabel: string;
  /** «22 сент, 09:00–10:30» */
  dateTimeLabel: string;
  locationLabel: string | null;
  levelLabel: string | null;
  slotsLabel: string | null;
  /** «+7 мест» / «Мест нет» / null, если вместимость неизвестна. */
  placesLabel: string | null;
  placesLeft: number | null;
  isFull: boolean;
  trainerName: string | null;
  trainerAvatarUrl: string | null;
};

export type AtlantyNormalizeOptions = {
  timeZone?: string;
  now?: number;
  typeIds?: readonly number[];
  directionIds?: readonly number[];
};

function isRecord(value: unknown): value is UnknownRecord {
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
    if (typeof raw === "number" && Number.isFinite(raw)) return Math.trunc(raw);
    if (typeof raw === "string" && raw.trim()) {
      const parsed = Number(raw.replace(",", "."));
      if (Number.isFinite(parsed)) return Math.trunc(parsed);
    }
  }
  return null;
}

function pickNestedRecord(value: unknown, keys: string[]): UnknownRecord | null {
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

export function getAtlantyTypeId(value: unknown): number | null {
  if (!isRecord(value)) return null;
  const type = pickNestedRecord(value, ["type", "exerciseType"]);
  return pickNumber(type, ["id", "typeId"]) ?? pickNumber(value, ["typeId", "exerciseTypeId"]);
}

export function getAtlantyDirectionId(value: unknown): number | null {
  if (!isRecord(value)) return null;
  const direction = pickNestedRecord(value, ["direction"]);
  return pickNumber(direction, ["id", "directionId"]) ?? pickNumber(value, ["directionId"]);
}

/** Относится ли упражнение к корпоративному расписанию клуба «Атланты». */
export function isAtlantyCorporateExercise(
  value: unknown,
  options: Pick<AtlantyNormalizeOptions, "typeIds" | "directionIds"> = {},
): boolean {
  if (!isRecord(value)) return false;
  const typeIds = options.typeIds ?? ATLANTY_CORPORATE_TYPE_IDS;
  const directionIds = options.directionIds ?? ATLANTY_CORPORATE_DIRECTION_IDS;
  const typeId = getAtlantyTypeId(value);
  const directionId = getAtlantyDirectionId(value);
  return (
    (typeId !== null && typeIds.includes(typeId))
    || (directionId !== null && directionIds.includes(directionId))
  );
}

export function extractAtlantyExerciseItems(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload)) return [];
  for (const key of ["content", "items", "data", "exercises", "results"]) {
    const raw = payload[key];
    if (Array.isArray(raw)) return raw;
  }
  return [];
}

function addDays(date: string, days: number) {
  const parsed = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return date;
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

/** Сегодняшняя дата в часовом поясе клуба (YYYY-MM-DD). */
export function resolveAtlantyDateFrom(now: number, timeZone?: string) {
  return getAtlantyDateParts(new Date(now).toISOString(), timeZone)?.date
    || new Date(now).toISOString().slice(0, 10);
}

/**
 * URL публичного расписания VivaCRM с серверным фильтром по направлениям.
 * `directions` — единственный фильтр, который реально применяет API.
 */
export function buildAtlantyPeriodUrl(params: {
  apiBase: string;
  tenantKey: string;
  dateFrom: string;
  dateTo: string;
  page?: number;
  size?: number;
  directionIds?: readonly number[];
}) {
  const query = new URLSearchParams({
    dateFrom: params.dateFrom,
    dateTo: params.dateTo,
    page: String(params.page ?? 0),
    size: String(params.size ?? 500),
    directions: (params.directionIds ?? ATLANTY_CORPORATE_DIRECTION_IDS).join(","),
  });
  const base = params.apiBase.replace(/\/+$/, "");
  return `${base}/end-user/api/v1/${encodeURIComponent(params.tenantKey)}/exercises/period?${query.toString()}`;
}

export function resolveAtlantyDateTo(dateFrom: string, daysAhead: number) {
  return addDays(dateFrom, daysAhead);
}

/** «уровень D–D+» / «уровень C/C+» → «D–D+» / «C/C+». */
export function normalizeAtlantyLevelLabel(
  ...sources: Array<string | null | undefined>
): string | null {
  const haystack = sources
    .map((source) => String(source || "").trim())
    .filter(Boolean)
    .join(" ");
  if (!haystack) return null;

  const match = haystack.match(
    /уров(?:ень|ня)\s*([A-ZА-Я0-9][A-ZА-Я0-9+./\s–—-]*)/i,
  );
  if (!match?.[1]) return null;

  const normalized = match[1]
    .replace(/\s+/g, " ")
    .replace(/\s*\/\s*/g, "/")
    .replace(/\s*[–—-]\s*/g, "–")
    .trim();
  if (!normalized) return null;
  return normalized.toUpperCase();
}

export type AtlantyDateParts = {
  date: string;
  dayLabel: string;
  monthLabel: string;
  weekdayLabel: string;
  clock: string;
};

function resolveTimeZone(timeZone?: string) {
  return timeZone?.trim() || ATLANTY_DEFAULT_TIME_ZONE;
}

/** Разбирает ISO-дату события в календарные части по часовому поясу клуба. */
export function getAtlantyDateParts(
  value: string | null | undefined,
  timeZone?: string,
): AtlantyDateParts | null {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;

  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: resolveTimeZone(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const parts: Partial<Record<string, string>> = {};
  for (const part of formatter.formatToParts(parsed)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }

  const year = parts.year;
  const month = parts.month;
  const day = parts.day;
  const hour = parts.hour === "24" ? "00" : parts.hour;
  if (!year || !month || !day) return null;

  const isoDate = `${year}-${month}-${day}`;
  const monthIndex = Number(month) - 1;
  const weekdayIndex = new Date(`${isoDate}T12:00:00Z`).getUTCDay();

  return {
    date: isoDate,
    dayLabel: String(Number(day)),
    monthLabel: MONTHS_SHORT[monthIndex] || "",
    weekdayLabel: WEEKDAYS_SHORT[weekdayIndex] || "",
    clock: `${hour || "00"}:${parts.minute || "00"}`,
  };
}

/** «+7 мест» / «Мест нет» / null. */
export function formatAtlantyPlacesLabel(placesLeft: number | null): string | null {
  if (placesLeft === null || !Number.isFinite(placesLeft)) return null;
  if (placesLeft > 0) return `+${placesLeft} ${pluralizePlaces(placesLeft)}`;
  return "Мест нет";
}

function pluralizePlaces(value: number) {
  const mod10 = value % 10;
  const mod100 = value % 100;
  if (mod10 === 1 && mod100 !== 11) return "место";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "места";
  return "мест";
}

function normalizeText(value: string | null | undefined) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function normalizeAtlantyEvent(
  value: unknown,
  options: AtlantyNormalizeOptions = {},
): AtlantyScheduleEvent | null {
  if (!isAtlantyCorporateExercise(value, options)) return null;
  if (!isRecord(value)) return null;

  const id = pickString(value, ["id", "exerciseId", "uuid"]);
  const startAt = pickString(value, ["timeFrom", "startsAt", "startAt"]);
  if (!id || !startAt) return null;
  const endAt = pickString(value, ["timeTo", "endsAt", "endAt"]) || startAt;

  const timeZone = options.timeZone;
  const startParts = getAtlantyDateParts(startAt, timeZone);
  if (!startParts) return null;

  const endParts = getAtlantyDateParts(endAt, timeZone);
  const timeRangeLabel = endParts && endParts.clock !== startParts.clock
    ? `${startParts.clock}–${endParts.clock}`
    : startParts.clock;

  const direction = pickNestedRecord(value, ["direction"]);
  const type = pickNestedRecord(value, ["type", "exerciseType"]);
  const studio = pickNestedRecord(value, ["studio", "station", "club"]);
  const room = pickNestedRecord(value, ["room", "court"]);

  const directionName = normalizeText(
    pickString(direction, ["name", "title"]) || pickString(value, ["directionName"]),
  );
  const typeName = normalizeText(
    pickString(type, ["name", "title"]) || pickString(value, ["typeName"]),
  );
  const roomName = normalizeText(
    pickString(room, ["name", "title"]) || pickString(value, ["roomName", "courtName"]),
  );
  const studioName = normalizeText(
    pickString(studio, ["name", "title"]) || pickString(value, ["studioName", "stationName"]),
  );

  const clientsCount = Math.max(
    0,
    pickNumber(value, ["clientsCount", "participantsCount", "bookedCount"]) ?? 0,
  );
  const maxClientsCount = Math.max(
    0,
    pickNumber(value, ["maxClientsCount", "maxParticipants", "capacity"]) ?? 0,
  );
  const placesLeft = maxClientsCount > 0
    ? Math.max(0, maxClientsCount - clientsCount)
    : null;
  const includeRoom = roomName.length > 0
    && !/панорамик|panoramic/i.test(roomName)
    && !studioName.toLowerCase().includes(roomName.toLowerCase());

  const trainers = pickArray(value, ["trainers", "executors", "coaches"]);
  const firstTrainer = isRecord(trainers[0]) ? trainers[0] : null;
  const trainerName = firstTrainer
    ? normalizeText(
      pickString(firstTrainer, ["displayName", "fullName", "name"])
      || [
        pickString(firstTrainer, ["firstName", "firstname", "givenName"]),
        pickString(firstTrainer, ["lastName", "lastname", "familyName", "surname"]),
      ].filter(Boolean).join(" "),
    ) || null
    : null;

  return {
    id,
    title: directionName || typeName || "Время Атланты",
    directionName: directionName || null,
    typeName: typeName || null,
    photoUrl:
      pickString(direction, ["photoWeb", "photo"])
      || pickString(value, ["photoWeb", "photo", "photoUrl", "imageUrl"]),
    startAt,
    endAt,
    date: startParts.date,
    dayLabel: startParts.dayLabel,
    monthLabel: startParts.monthLabel,
    weekdayLabel: startParts.weekdayLabel,
    timeRangeLabel,
    dateTimeLabel: `${startParts.dayLabel} ${startParts.monthLabel}, ${timeRangeLabel}`,
    locationLabel: studioName && includeRoom
      ? `${studioName} · ${roomName}`
      : studioName || roomName || null,
    levelLabel: normalizeAtlantyLevelLabel(directionName, typeName, pickString(direction, ["description"])),
    slotsLabel: maxClientsCount > 0 ? `${clientsCount}/${maxClientsCount}` : null,
    placesLabel: formatAtlantyPlacesLabel(placesLeft),
    placesLeft,
    isFull: placesLeft === 0,
    trainerName,
    trainerAvatarUrl: firstTrainer
      ? pickString(firstTrainer, ["photo", "photoUrl", "avatar", "imageUrl"])
      : null,
  };
}

export function normalizeAtlantyEventList(
  payload: unknown,
  options: AtlantyNormalizeOptions = {},
) {
  const now = options.now ?? Date.now();
  const seen = new Set<string>();

  return extractAtlantyExerciseItems(payload)
    .map((item) => normalizeAtlantyEvent(item, options))
    .filter((item): item is AtlantyScheduleEvent => item !== null)
    .filter((item) => {
      const endTs = Date.parse(item.endAt || item.startAt);
      return !Number.isFinite(endTs) || endTs >= now;
    })
    .filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    })
    .sort((left, right) => {
      const leftTs = Date.parse(left.startAt);
      const rightTs = Date.parse(right.startAt);
      const safeLeft = Number.isFinite(leftTs) ? leftTs : Number.MAX_SAFE_INTEGER;
      const safeRight = Number.isFinite(rightTs) ? rightTs : Number.MAX_SAFE_INTEGER;
      return safeLeft - safeRight;
    });
}
