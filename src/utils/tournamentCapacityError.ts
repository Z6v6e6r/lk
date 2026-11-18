import type { ApiError } from "./apiClient";

/** A generic conflict or pending response does not prove that the tournament is full. */
export function isTournamentCapacityError(error: ApiError | null | undefined): boolean {
  if (error?.status !== 409) return false;
  const raw = error.raw && typeof error.raw === "object"
    ? error.raw as Record<string, unknown> : null;
  const details = raw?.details && typeof raw.details === "object"
    ? raw.details as Record<string, unknown> : null;
  const code = details?.code ?? raw?.code;
  return code === "CAPACITY_FULL" || code === "TOURNAMENT_FULL"
    || (code === "CONFLICT" && error.message.trim() === "Нет свободных мест");
}
