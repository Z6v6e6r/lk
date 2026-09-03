export interface PadelAvailableGamesQueryOptions {
  limit?: number;
  offset?: number;
  date?: string | null;
  stationId?: string | null;
  stationName?: string | null;
}

export function buildPadelAvailableGamesQuery(
  options: PadelAvailableGamesQueryOptions = {},
  runtime: { isDevReleaseChannel: boolean; now?: () => number },
): { query: URLSearchParams; limit: number; offset: number } {
  const limit = Number.isFinite(options.limit)
    ? Math.max(1, Math.min(500, Math.floor(options.limit as number)))
    : 12;
  const offset = Number.isFinite(options.offset)
    ? Math.max(0, Math.floor(options.offset as number))
    : 0;
  const query = new URLSearchParams({
    public: "true",
    available: "true",
    limit: String(limit),
    offset: String(offset),
  });
  const stationId = options.stationId?.trim() || "";
  const stationName = options.stationName?.trim() || "";
  const date = options.date?.trim() || "";

  if (date) query.set("date", date);
  if (stationId) {
    query.set("stationId", stationId);
    query.set("studioId", stationId);
  }
  if (stationName) {
    query.set("stationName", stationName);
    query.set("studioName", stationName);
  }
  if (!runtime.isDevReleaseChannel) {
    query.set("_ts", String((runtime.now ?? Date.now)()));
  }

  return { query, limit, offset };
}
