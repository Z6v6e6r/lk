import {
  parseGroupScheduleDirectionIds,
  resolveGroupScheduleDirectionPreset,
  type GroupScheduleDirectionPreset,
} from "./groupScheduleModel.ts";

const DEFAULT_GROUP_SCHEDULE_ORIGIN = "https://padlhub.ru";

export const DEFAULT_GROUP_SCHEDULE_PATH = "/group";

const GROUP_SCHEDULE_DIRECTION_QUERY_PARAMS = [
  "direction",
  "directionId",
  "directionIds",
  "directions",
  "4lGIgL_direction",
] as const;

export type GroupScheduleEntryData = {
  exerciseId: string | null;
  date: string | null;
  studioId: string | null;
  returnToFindGame: boolean;
  directionIds: number[];
  directionLabel: string | null;
};

function firstNonEmpty(...values: Array<string | null | undefined>) {
  return values.map((value) => String(value || "").trim()).find(Boolean) ?? null;
}

function isFindGameReturnSource(value: string | null) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "finde_game" || normalized === "find_game";
}

function readGroupScheduleDirectionFilter(current: URL) {
  const tokens = GROUP_SCHEDULE_DIRECTION_QUERY_PARAMS
    .flatMap((param) => current.searchParams.getAll(param))
    .flatMap((value) => String(value || "").split(/[,;\s]+/))
    .map((token) => token.trim())
    .filter(Boolean);

  const preset = tokens
    .map((token) => resolveGroupScheduleDirectionPreset(token))
    .find((value): value is GroupScheduleDirectionPreset => value !== null) ?? null;
  const directionIds = parseGroupScheduleDirectionIds(tokens);
  const ids = preset
    ? Array.from(new Set([...preset.directionIds, ...directionIds]))
    : directionIds;

  return {
    directionIds: ids,
    directionLabel: ids.length > 0 ? preset?.label ?? null : null,
  };
}

export function normalizeGroupScheduleDate(value: unknown) {
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

export function readGroupScheduleEntryDataFromHref(href: string): GroupScheduleEntryData {
  const current = new URL(href, DEFAULT_GROUP_SCHEDULE_ORIGIN);
  const directionFilter = readGroupScheduleDirectionFilter(current);
  return {
    exerciseId: firstNonEmpty(
      current.searchParams.get("exerciseId"),
      current.searchParams.get("id"),
      current.searchParams.get("groupExerciseId"),
      current.searchParams.get("4lGIgL_exercise"),
    ),
    date: normalizeGroupScheduleDate(firstNonEmpty(
      current.searchParams.get("date"),
      current.searchParams.get("groupDate"),
      current.searchParams.get("4lGIgL_date"),
    )),
    studioId: firstNonEmpty(
      current.searchParams.get("studioId"),
      current.searchParams.get("stationId"),
      current.searchParams.get("4lGIgL_studio"),
    ),
    returnToFindGame: isFindGameReturnSource(firstNonEmpty(
      current.searchParams.get("returnTo"),
      current.searchParams.get("source"),
    )),
    directionIds: directionFilter.directionIds,
    directionLabel: directionFilter.directionLabel,
  };
}

export function buildGroupScheduleReturnUrl(
  input: string | URL,
  params: {
    exerciseId?: string | null;
    date?: string | null;
    paymentStatus?: "success" | "failed" | null;
  } = {},
) {
  const url = input instanceof URL
    ? new URL(input.toString())
    : new URL(String(input), DEFAULT_GROUP_SCHEDULE_ORIGIN);
  if (params.exerciseId) {
    url.searchParams.set("groupExerciseId", params.exerciseId);
  }
  if (params.date) {
    url.searchParams.set("date", params.date);
    url.searchParams.delete("4lGIgL_date");
  }
  url.searchParams.delete("groupPaymentSuccess");
  url.searchParams.delete("groupPaymentFailed");
  if (params.paymentStatus === "success") {
    url.searchParams.set("groupPaymentSuccess", "true");
  }
  if (params.paymentStatus === "failed") {
    url.searchParams.set("groupPaymentFailed", "true");
  }
  return url;
}
