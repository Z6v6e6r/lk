export interface TournamentRatingExclusion {
  playerId: string;
  scopes: Array<"community" | "level">;
  auditId: string;
  reason: string;
  recordedAt: string;
}

// Admin-owned top-level metadata. Public tournament saves must never accept or
// replace it. Scores, rounds, standings and the original participant count stay intact.
export function getTournamentRatingExclusion(
  tournament: Record<string, unknown>,
  playerId: unknown,
  scope: "community" | "level",
): TournamentRatingExclusion | null {
  if (typeof playerId !== "string" || !playerId.trim()) return null;
  const exclusions = Array.isArray(tournament.ratingExclusions) ? tournament.ratingExclusions : [];
  for (const value of exclusions) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    if (row.playerId !== playerId || !Array.isArray(row.scopes) || !row.scopes.includes(scope)) continue;
    if (typeof row.auditId !== "string" || !row.auditId.trim()
      || typeof row.reason !== "string" || !row.reason.trim()
      || typeof row.recordedAt !== "string" || !Number.isFinite(Date.parse(row.recordedAt))) {
      throw new Error("INVALID_TOURNAMENT_RATING_EXCLUSION");
    }
    return row as unknown as TournamentRatingExclusion;
  }
  return null;
}
