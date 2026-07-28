const TOURNAMENT_NESTED_KEYS = [
  "skin",
  "tournamentSkin",
  "customTournament",
  "publicTournament",
  "sourceTournamentSnapshot",
  "sourceTournament",
  "tournament",
  "exercise",
  "baseTournament",
  "details",
  "statusAudit",
  "settings",
  "params",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function pickString(value: unknown, keys: string[]): string | null {
  if (!isRecord(value)) return null;
  for (const key of keys) {
    const raw = value[key];
    if (typeof raw === "string" && raw.trim()) return raw.trim();
    if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  }
  return null;
}

function pickNestedRecord(value: unknown, keys: string[]): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  for (const key of keys) {
    const raw = value[key];
    if (isRecord(raw)) return raw;
  }
  return null;
}

function collectTournamentStateRecords(
  value: unknown,
  seen = new Set<unknown>(),
): Record<string, unknown>[] {
  if (!isRecord(value) || seen.has(value)) return [];
  seen.add(value);

  const records: Record<string, unknown>[] = [value];
  TOURNAMENT_NESTED_KEYS.forEach((key) => {
    const nested = value[key];
    if (isRecord(nested)) {
      records.push(...collectTournamentStateRecords(nested, seen));
    }
  });
  return records;
}

function isUuidLike(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function isMongoObjectIdLike(value: string) {
  return /^[0-9a-f]{24}$/i.test(value);
}

export function resolveTournamentSignupExerciseId(value: unknown): string | null {
  if (!isRecord(value)) return null;

  const candidates: string[] = [];
  const records = collectTournamentStateRecords(value);
  for (const record of records) {
    const direct = pickString(record, [
      "sourceTournamentId",
      "vivaExerciseId",
      "exerciseId",
      "sourceExerciseId",
      "exerciseUuid",
    ]);
    if (direct) candidates.push(direct);

    const nestedSourceTournament = pickNestedRecord(record, ["sourceTournament", "sourceTournamentSnapshot"]);
    const sourceTournamentId = pickString(nestedSourceTournament, ["id", "uuid", "exerciseId"]);
    if (sourceTournamentId) candidates.push(sourceTournamentId);

    const nestedExercise = pickNestedRecord(record, ["exercise"]);
    const nestedExerciseId = pickString(nestedExercise, ["id", "uuid", "exerciseId", "vivaExerciseId"]);
    if (nestedExerciseId) candidates.push(nestedExerciseId);
  }

  const fallback = pickString(value, ["exerciseId", "id", "tournamentId", "uuid"]);
  if (fallback) candidates.push(fallback);

  const preferredUuid = candidates.find((candidate) => isUuidLike(candidate));
  if (preferredUuid) return preferredUuid;

  const preferredNonMongo = candidates.find((candidate) => !isMongoObjectIdLike(candidate));
  if (preferredNonMongo) return preferredNonMongo;

  return candidates[0] ?? null;
}
