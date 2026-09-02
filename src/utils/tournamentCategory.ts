export type TournamentExerciseLike = {
  direction?: {
    id?: number | string | null;
    name?: string | null;
  } | null;
  type?: {
    id?: number | string | null;
    name?: string | null;
  } | null;
};

const TOURNAMENT_DIRECTION_IDS = new Set([2617, 4769, 5278]);
// 1013 is Viva's dedicated special-tournament type. The broader 839 type is
// intentionally excluded because it is also used by non-mechanics exercises.
const TOURNAMENT_TYPE_IDS = new Set([1013]);
const SPECIAL_TOURNAMENT_CATEGORY_NAMES = new Set([
  "падел турнир (особый)",
  "падел турнир особый",
  "padel tournament (special)",
  "padel tournament special",
]);

function normalizeTournamentCategoryName(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/\s+/g, " ");
}

function isSpecialTournamentCategoryName(value: unknown): boolean {
  const normalized = normalizeTournamentCategoryName(value);
  return Boolean(normalized) && SPECIAL_TOURNAMENT_CATEGORY_NAMES.has(normalized);
}

export function isTournamentDirectionId(value: unknown): boolean {
  const normalized = typeof value === "number" ? value : Number(value);
  return Number.isFinite(normalized) && TOURNAMENT_DIRECTION_IDS.has(normalized);
}

export function isTournamentExerciseCategory(
  exercise: TournamentExerciseLike | null | undefined,
): boolean {
  if (!exercise) return false;

  if (
    isTournamentDirectionId(exercise.direction?.id)
    || isTournamentDirectionId(exercise.type?.id)
    || TOURNAMENT_TYPE_IDS.has(Number(exercise.type?.id))
  ) {
    return true;
  }

  return (
    isSpecialTournamentCategoryName(exercise.direction?.name)
    || isSpecialTournamentCategoryName(exercise.type?.name)
  );
}
