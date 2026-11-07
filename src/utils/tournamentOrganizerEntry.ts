const DEFAULT_TOURNAMENT_ORGANIZER_ORIGIN = "https://padlhub.ru";

/**
 * Deep link флаг для открытия organizer-модуля турниров (`LKWidgetTournaments`) прямо в ЛК.
 * Пример: https://padlhub.ru/lk_new?openTournaments=1
 */
export const TOURNAMENT_ORGANIZER_QUERY_KEY = "openTournaments";

const TOURNAMENT_ORGANIZER_PARAM_KEYS = [
  TOURNAMENT_ORGANIZER_QUERY_KEY,
  "tournamentId",
  "exerciseId",
  "slug",
  "tournamentSlug",
  "date",
] as const;

const DISABLED_FLAG_VALUES = new Set(["0", "false", "no", "off"]);

export type TournamentOrganizerEntryData = {
  enabled: boolean;
  tournamentId: string | null;
  tournamentSlug: string | null;
  date: string | null;
};

function firstNonEmpty(...values: Array<string | null | undefined>) {
  return values.map((value) => String(value || "").trim()).find(Boolean) ?? null;
}

function normalizeSlug(value: unknown) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  try {
    return decodeURIComponent(raw).trim().toLowerCase() || null;
  } catch {
    return raw.toLowerCase();
  }
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

function disabledEntry(): TournamentOrganizerEntryData {
  return {
    enabled: false,
    tournamentId: null,
    tournamentSlug: null,
    date: null,
  };
}

/**
 * Читает deep link проведения турниров из href ЛК.
 * Ссылка без флага `openTournaments` (или с `openTournaments=0/false/no/off`) ничего не открывает.
 */
export function readTournamentOrganizerEntryFromHref(href: string): TournamentOrganizerEntryData {
  let current: URL;
  try {
    current = new URL(href, DEFAULT_TOURNAMENT_ORGANIZER_ORIGIN);
  } catch {
    return disabledEntry();
  }

  if (!current.searchParams.has(TOURNAMENT_ORGANIZER_QUERY_KEY)) return disabledEntry();
  const flagValue = String(current.searchParams.get(TOURNAMENT_ORGANIZER_QUERY_KEY) ?? "").trim().toLowerCase();
  if (DISABLED_FLAG_VALUES.has(flagValue)) return disabledEntry();

  return {
    enabled: true,
    tournamentId: firstNonEmpty(
      current.searchParams.get("tournamentId"),
      current.searchParams.get("exerciseId"),
    ),
    tournamentSlug: normalizeSlug(
      current.searchParams.get("slug") || current.searchParams.get("tournamentSlug"),
    ),
    date: normalizeDate(current.searchParams.get("date")),
  };
}

/**
 * Убирает из URL ЛК все параметры deep link, чтобы повторный рендер/refresh не открывал модуль снова.
 * Возвращает новый `URL`, исходный объект не мутируется.
 */
export function clearTournamentOrganizerEntryFromUrl(url: URL): URL {
  const next = new URL(url.toString());
  TOURNAMENT_ORGANIZER_PARAM_KEYS.forEach((key) => next.searchParams.delete(key));
  return next;
}
