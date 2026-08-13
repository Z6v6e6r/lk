export interface TournamentSignupListSnapshotState {
  snapshotAgeMs: number | null;
  lastSuccessfulAt: string | null;
  stale: boolean;
  refreshInProgress: boolean;
  snapshotAvailable: boolean;
  snapshotRefreshEnabled: boolean;
  snapshotReadModelEnabled: boolean;
  refreshScheduled: boolean;
  refreshCompleted: boolean;
  refreshReason:
    | "disabled"
    | "fresh"
    | "refreshed"
    | "refresh_failed"
    | "cooldown"
    | "out_of_range";
  retryAfterMs: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function pickString(value: Record<string, unknown>, key: string): string | null {
  const raw = value[key];
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

function pickNumber(value: Record<string, unknown>, key: string): number | null {
  const raw = value[key];
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim()) {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function normalizeTournamentSignupListSnapshotState(
  payload: unknown,
): TournamentSignupListSnapshotState | null {
  if (!isRecord(payload) || !Array.isArray(payload.items)) return null;
  const reason = pickString(payload, "refreshReason");
  const refreshReason: TournamentSignupListSnapshotState["refreshReason"] = (
    reason === "fresh"
    || reason === "refreshed"
    || reason === "refresh_failed"
    || reason === "cooldown"
    || reason === "out_of_range"
  ) ? reason : "disabled";

  return {
    snapshotAgeMs: pickNumber(payload, "snapshotAgeMs"),
    lastSuccessfulAt: pickString(payload, "lastSuccessfulAt"),
    stale: payload.stale === true,
    refreshInProgress: payload.refreshInProgress === true,
    snapshotAvailable: payload.snapshotAvailable === true,
    snapshotRefreshEnabled: payload.snapshotRefreshEnabled === true,
    snapshotReadModelEnabled: payload.snapshotReadModelEnabled === true,
    refreshScheduled: payload.refreshScheduled === true,
    refreshCompleted: payload.refreshCompleted === true,
    refreshReason,
    retryAfterMs: pickNumber(payload, "retryAfterMs"),
  };
}
