export type GameAtlasCategory = "all" | "open" | "mine" | "upcoming";
export type GameAtlasRequestMode = "replace" | "append";

export interface GameAtlasRequestToken {
  generation: number;
  mode: GameAtlasRequestMode;
}

export interface GameAtlasRequestCoordinator {
  start: (mode: GameAtlasRequestMode) => GameAtlasRequestToken | null;
  isCurrent: (token: GameAtlasRequestToken) => boolean;
  finish: (token: GameAtlasRequestToken) => void;
}

export interface AtlasGameRecordLike {
  id?: unknown;
  booking?: {
    date?: unknown;
    timeFrom?: unknown;
    timeTo?: unknown;
    studioId?: unknown;
    studioName?: unknown;
  } | null;
}

export interface GameAtlasPaginationInput {
  requestedOffset: number;
  consumedCount: number;
  serverHasMore: boolean;
}

const normalizeText = (value: unknown): string => String(value ?? "").trim();

export function createGameAtlasRequestCoordinator(): GameAtlasRequestCoordinator {
  let generation = 0;
  let replaceInFlight = false;
  let appendInFlight = false;

  return {
    start(mode) {
      if (mode === "append") {
        if (replaceInFlight || appendInFlight) return null;
        appendInFlight = true;
        return { generation, mode };
      }

      generation += 1;
      replaceInFlight = true;
      return { generation, mode };
    },
    isCurrent(token) {
      return token.generation === generation;
    },
    finish(token) {
      if (token.mode === "append") {
        appendInFlight = false;
        return;
      }
      if (token.generation === generation) {
        replaceInFlight = false;
      }
    },
  };
}

export function isDisplayableGameAtlasRecord(record: AtlasGameRecordLike | null | undefined): boolean {
  if (!record || typeof record !== "object") return false;
  if (!normalizeText(record.id)) return false;
  const booking = record.booking;
  if (!booking || typeof booking !== "object") return false;

  const date = normalizeText(booking.date);
  const time = normalizeText(booking.timeFrom) || normalizeText(booking.timeTo);
  const station = normalizeText(booking.studioId) || normalizeText(booking.studioName);
  const dateMatch = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const timeMatch = time.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!dateMatch || !timeMatch || !station) return false;

  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const hours = Number(timeMatch[1]);
  const minutes = Number(timeMatch[2]);
  const seconds = Number(timeMatch[3] ?? 0);
  if (hours > 23 || minutes > 59 || seconds > 59) return false;
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  return calendarDate.getUTCFullYear() === year
    && calendarDate.getUTCMonth() === month - 1
    && calendarDate.getUTCDate() === day;
}

export function parseAtlasMultiValues<T extends string>(rawValue: string | null, allowed?: readonly T[]): T[] {
  if (!rawValue) return [];
  return Array.from(new Set(
    rawValue
      .split(",")
      .map((value) => value.trim())
      .filter((value): value is T => Boolean(
        value
        && value !== "all"
        && value !== "__all__"
        && (!allowed || allowed.includes(value as T)),
      )),
  ));
}

export function serializeAtlasMultiValues(values: readonly string[]): string {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).join(",");
}

export function toggleAtlasMultiValue<T extends string>(
  selectedValues: readonly T[],
  value: T,
  allValue: string,
): T[] {
  if (value === allValue) return [];
  return selectedValues.includes(value)
    ? selectedValues.filter((selectedValue) => selectedValue !== value)
    : [...selectedValues, value];
}

export function matchesAtlasMultiValue(selectedValues: readonly string[], value: string): boolean {
  return selectedValues.length === 0 || selectedValues.includes(value);
}

export function matchesAtlasSearchText(values: readonly unknown[], query: string): boolean {
  const normalizeComparable = (value: unknown) => normalizeText(value)
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const normalizedQuery = normalizeComparable(query);
  if (!normalizedQuery) return true;
  const haystack = normalizeComparable(values.filter(Boolean).join(" "));
  return normalizedQuery.split(" ").every((token) => haystack.includes(token));
}

export function matchesAtlasCategory(
  category: GameAtlasCategory,
  hasPlaces: boolean,
  mine: boolean,
  startTs: number | null,
  nowTs = Date.now(),
): boolean {
  if (category === "open") return hasPlaces;
  if (category === "mine") return mine;
  if (category === "upcoming") return startTs !== null && startTs >= nowTs;
  return true;
}

export function matchesAtlasAvailability(hasPlaces: boolean, filters: readonly string[]): boolean {
  if (filters.length === 0) return true;
  return filters.some((filter) => (
    filter === "available" ? hasPlaces : filter === "full" ? !hasPlaces : false
  ));
}

export function matchesAtlasTimeOfDay(startMinutes: number | null, filters: readonly string[]): boolean {
  if (filters.length === 0) return true;
  if (startMinutes === null) return false;
  return filters.some((filter) => {
    if (filter === "morning") return startMinutes >= 7 * 60 && startMinutes < 11 * 60;
    if (filter === "day") return startMinutes >= 11 * 60 && startMinutes < 18 * 60;
    return filter === "evening" && startMinutes >= 18 * 60 && startMinutes < 24 * 60;
  });
}

export function resolveGameAtlasPagination({
  requestedOffset,
  consumedCount,
  serverHasMore,
}: GameAtlasPaginationInput): { nextOffset: number; hasMore: boolean } {
  const safeOffset = Number.isSafeInteger(requestedOffset) && requestedOffset >= 0 ? requestedOffset : 0;
  const safeConsumedCount = Number.isSafeInteger(consumedCount) && consumedCount > 0 ? consumedCount : 0;
  return {
    nextOffset: safeOffset + safeConsumedCount,
    hasMore: serverHasMore && safeConsumedCount > 0,
  };
}
