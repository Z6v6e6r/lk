type TournamentResultErrorLike = {
  status: number | null;
  message: string;
  raw?: unknown;
};

export type TournamentOfflineResultItemLike = {
  roundId?: string | null;
  matchId?: string | null;
  score1?: number | null;
  score2?: number | null;
  court?: string | null;
  courtIndex?: number | null;
  pair1?: string[] | null;
  pair2?: string[] | null;
};

export type TournamentOfflineResultsPayloadLike = {
  tournamentId: string;
  results: TournamentOfflineResultItemLike[];
  params?: Record<string, unknown> | null;
};

const RETRY_BASE_MS = 10_000;
const RETRY_MAX_MS = 10 * 60_000;

function normalizeString(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeScopeRoundIds(payload: TournamentOfflineResultsPayloadLike): string[] {
  const scoredResults = payload.results.filter((item) => (
    item?.score1 != null || item?.score2 != null
  ));
  const scopedResults = scoredResults.length > 0 ? scoredResults : payload.results;
  const roundIds = new Set<string>();
  scopedResults.forEach((item) => {
    const roundId = normalizeString(item?.roundId);
    if (roundId) roundIds.add(roundId);
  });
  return Array.from(roundIds).sort((left, right) => left.localeCompare(right, "ru"));
}

export function getTournamentOfflineResultMatchKey(roundId: string, matchId: string): string {
  return `${normalizeString(roundId)}::${normalizeString(matchId)}`;
}

export function computeTournamentOfflineRetryDelayMs(attempts: number): number {
  const power = Math.max(0, attempts - 1);
  const delay = RETRY_BASE_MS * (2 ** Math.min(power, 6));
  return Math.min(delay, RETRY_MAX_MS);
}

export function shouldQueueTournamentResultError(
  error: TournamentResultErrorLike | null | undefined,
): boolean {
  if (!error) return false;
  if (error.status == null) return true;
  if (error.status === 408 || error.status === 425 || error.status === 429) return true;
  return typeof error.status === "number" && error.status >= 500;
}

export function getTournamentOfflineResultQueueScope(
  payload: TournamentOfflineResultsPayloadLike,
): string {
  const roundIds = normalizeScopeRoundIds(payload);
  if (roundIds.length === 0) return "finish";
  return `round:${roundIds.join("+")}`;
}

function mergeTournamentOfflineResultItems(
  base: TournamentOfflineResultItemLike[] | null | undefined,
  incoming: TournamentOfflineResultItemLike[] | null | undefined,
): TournamentOfflineResultItemLike[] {
  const merged = new Map<string, TournamentOfflineResultItemLike>();

  (Array.isArray(base) ? base : []).forEach((item) => {
    const roundId = normalizeString(item?.roundId);
    const matchId = normalizeString(item?.matchId);
    if (!roundId || !matchId) return;
    merged.set(getTournamentOfflineResultMatchKey(roundId, matchId), {
      roundId,
      matchId,
      score1: item.score1 ?? null,
      score2: item.score2 ?? null,
      court: normalizeString(item.court) || null,
      courtIndex: typeof item.courtIndex === "number" && Number.isFinite(item.courtIndex)
        ? item.courtIndex
        : null,
      pair1: Array.isArray(item.pair1) ? item.pair1.map((value) => normalizeString(value)).filter(Boolean) : null,
      pair2: Array.isArray(item.pair2) ? item.pair2.map((value) => normalizeString(value)).filter(Boolean) : null,
    });
  });

  (Array.isArray(incoming) ? incoming : []).forEach((item) => {
    const roundId = normalizeString(item?.roundId);
    const matchId = normalizeString(item?.matchId);
    if (!roundId || !matchId) return;
    const key = getTournamentOfflineResultMatchKey(roundId, matchId);
    const previous = merged.get(key) ?? null;
    merged.set(key, {
      roundId,
      matchId,
      score1: item.score1 != null
        ? item.score1
        : previous?.score1 ?? null,
      score2: item.score2 != null
        ? item.score2
        : previous?.score2 ?? null,
      court: normalizeString(item.court) || previous?.court || null,
      courtIndex: typeof item.courtIndex === "number" && Number.isFinite(item.courtIndex)
        ? item.courtIndex
        : previous?.courtIndex ?? null,
      pair1: Array.isArray(item.pair1) && item.pair1.length > 0
        ? item.pair1.map((value) => normalizeString(value)).filter(Boolean)
        : previous?.pair1 ?? null,
      pair2: Array.isArray(item.pair2) && item.pair2.length > 0
        ? item.pair2.map((value) => normalizeString(value)).filter(Boolean)
        : previous?.pair2 ?? null,
    });
  });

  return Array.from(merged.values());
}

export function mergeTournamentOfflineResultPayloads(
  base: TournamentOfflineResultsPayloadLike | null | undefined,
  incoming: TournamentOfflineResultsPayloadLike,
): TournamentOfflineResultsPayloadLike {
  return {
    tournamentId: normalizeString(incoming.tournamentId) || normalizeString(base?.tournamentId),
    results: mergeTournamentOfflineResultItems(base?.results, incoming.results),
    params: {
      ...(base?.params ?? {}),
      ...(incoming.params ?? {}),
    },
  };
}
