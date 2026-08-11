const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

export function isTournamentFinalized(tournament) {
  const params = isRecord(tournament?.params) ? tournament.params : {};
  const summary = isRecord(tournament?.summary) ? tournament.summary : {};
  const statuses = [
    tournament?.status,
    tournament?.state,
    tournament?.tournamentStatus,
    params.status,
    params.state,
    params.tournamentStatus,
    summary.status,
    summary.state,
    summary.tournamentStatus,
  ].map((value) => String(value || "").trim().toLowerCase());
  if (statuses.some((status) => ["completed", "finished", "closed", "done", "завершен", "завершён"].includes(status))) {
    return true;
  }
  const finishMarkers = [
    params.finishedAt,
    params.completedAt,
    params.manualFinishedAt,
    summary.finishedAt,
    summary.completedAt,
  ];
  if (finishMarkers.some((value) => String(value || "").trim())) return true;
  return [
    params.finished,
    params.isFinished,
    params.tournamentFinished,
    params.manualFinish,
    summary.finished,
    summary.isFinished,
    summary.tournamentFinished,
    summary.manualFinish,
  ].some((value) => value === true || value === 1 || value === "1" || String(value).toLowerCase() === "true");
}

export function resolveTournamentFinishedAtValue(tournament) {
  const params = isRecord(tournament?.params) ? tournament.params : {};
  const summary = isRecord(tournament?.summary) ? tournament.summary : {};
  return params.finishedAt
    || params.completedAt
    || summary.finishedAt
    || summary.completedAt
    || tournament?.updatedAt
    || null;
}
