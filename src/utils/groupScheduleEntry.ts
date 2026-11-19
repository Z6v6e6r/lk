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
    // `groupExerciseId` is written only by this widget (selection and payment return), so it
    // is the latest player intent and wins over an entry link that opened another training.
    exerciseId: firstNonEmpty(
      current.searchParams.get("groupExerciseId"),
      current.searchParams.get("exerciseId"),
      current.searchParams.get("id"),
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

/**
 * The training and date to open on mount (#459, A → B).
 *
 * The host page may keep passing the entry link's `data.exerciseId` (A) on every mount.
 * `groupExerciseId` is written only by this widget, on an explicit selection and in payment
 * return URLs, so once present it is the player's latest choice (B) and wins over the host
 * entry; the date then follows the same URL. Without it the host entry wins, then the URL
 * entry params, so the first visit by a link to A still opens A.
 */
export function resolveGroupScheduleInitialSelection(
  href: string,
  host: { exerciseId?: string | null; date?: string | null } = {},
): { exerciseId: string | null; date: string | null } {
  let url: URL | null = null;
  try {
    url = new URL(href, DEFAULT_GROUP_SCHEDULE_ORIGIN);
  } catch {
    url = null;
  }
  const entry = url ? readGroupScheduleEntryDataFromHref(url.toString()) : null;
  const chosen = firstNonEmpty(url?.searchParams.get("groupExerciseId"));
  if (chosen) {
    return { exerciseId: chosen, date: entry?.date ?? normalizeGroupScheduleDate(host.date) };
  }
  return {
    exerciseId: firstNonEmpty(host.exerciseId, entry?.exerciseId),
    date: normalizeGroupScheduleDate(host.date) ?? entry?.date ?? null,
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

const GROUP_SCHEDULE_EXERCISE_QUERY_PARAMS = ["groupExerciseId", "exerciseId", "id", "4lGIgL_exercise"] as const;

/**
 * Keeps the opened training in the page URL so a refresh reopens it.
 * Returns the next href, or null when the URL already points to this selection; in that case
 * payment return flags of the same training are left untouched.
 */
export function syncGroupScheduleSelectionHref(
  href: string,
  selection: { exerciseId: string | null; date?: string | null },
): string | null {
  const current = readGroupScheduleEntryDataFromHref(href);
  const exerciseId = String(selection.exerciseId || "").trim() || null;
  const date = normalizeGroupScheduleDate(selection.date);
  if (exerciseId) {
    if (current.exerciseId === exerciseId && (!date || current.date === date)) return null;
    const keepsTraining = current.exerciseId === exerciseId;
    const url = buildGroupScheduleReturnUrl(href, { exerciseId, date });
    if (keepsTraining) {
      const previous = new URL(href, DEFAULT_GROUP_SCHEDULE_ORIGIN);
      for (const flag of ["groupPaymentSuccess", "groupPaymentFailed"]) {
        const value = previous.searchParams.get(flag);
        if (value !== null) url.searchParams.set(flag, value);
      }
    }
    return url.toString();
  }
  if (!current.exerciseId) return null;
  const url = new URL(href, DEFAULT_GROUP_SCHEDULE_ORIGIN);
  for (const param of GROUP_SCHEDULE_EXERCISE_QUERY_PARAMS) url.searchParams.delete(param);
  url.searchParams.delete("groupPaymentSuccess");
  url.searchParams.delete("groupPaymentFailed");
  return url.toString();
}

/**
 * The payment page's return flag for this training, if any. A hint only: the order status
 * itself always comes from the server read (`resolveGroupScheduleOrderStatus`).
 */
export function readGroupSchedulePaymentReturnHint(href: string, exerciseId: string | null): "success" | "failed" | null {
  if (!exerciseId) return null;
  let url: URL;
  try {
    url = new URL(href, DEFAULT_GROUP_SCHEDULE_ORIGIN);
  } catch {
    return null;
  }
  if (readGroupScheduleEntryDataFromHref(url.toString()).exerciseId !== exerciseId) return null;
  const success = url.searchParams.get("groupPaymentSuccess") === "true";
  const failed = url.searchParams.get("groupPaymentFailed") === "true";
  if (success === failed) return null;
  return success ? "success" : "failed";
}
