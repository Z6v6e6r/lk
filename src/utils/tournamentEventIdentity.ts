// One visible event may have a legacy FPR storage ID. Keep that ID for writes,
// while cards, bookings and local history use the original event identity.
type TournamentIdentity = { tournamentId: string; tournamentType: string | null; params?: Record<string, unknown> | null };
export function tournamentEventId(record: TournamentIdentity): string {
  if (record.tournamentType === "fpr_6x25") {
    const source = record.params?.sourceExerciseId;
    const state = record.params?.fpr6x25 as { communityRating?: { sourceExerciseId?: string | null } } | undefined;
    const id = state?.communityRating?.sourceExerciseId || source;
    if (typeof id === "string" && id.trim()) return id.trim();
  }
  return record.tournamentId;
}

export function tournamentIdentityKeys(record: TournamentIdentity): string[] {
  return [...new Set([record.tournamentId, tournamentEventId(record)])];
}
