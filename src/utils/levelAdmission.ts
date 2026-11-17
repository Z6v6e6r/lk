const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

function isLevel(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value) && value >= 1 && value <= 7;
  if (typeof value !== "string") return false;
  const text = value.trim().toUpperCase();
  return /^(?:[ABCDАВСД]\+?(?:\s*[1-4])?|[1-7](?:[.,]\d+)?)(?:\s*[/–—-]\s*(?:[ABCDАВСД]\+?(?:\s*[1-4])?|[1-7](?:[.,]\d+)?))*$/.test(text);
}

/** Only explicit event admission metadata counts; rating calculation parameters do not. */
export function hasLevelRestriction(value: unknown): boolean {
  const root = record(value);
  if (!root) return false;
  const states: Record<string, unknown>[] = [];
  const pending = [root], seen = new Set<object>();
  while (pending.length && states.length < 100) {
    const state = pending.pop()!;
    if (seen.has(state)) continue;
    seen.add(state); states.push(state);
    for (const key of ["raw", "settings", "skin", "tournamentSkin", "customTournament", "publicTournament", "sourceTournamentSnapshot", "sourceTournament", "tournament", "exercise", "details", "direction", "type"]) {
      const nested = record(state[key]);
      if (nested) pending.push(nested);
    }
  }
  for (const state of states) {
    if (["minRating", "maxRating", "ratingFrom", "ratingTo", "ratingMin", "ratingMax", "levelFrom", "levelTo", "levelLabel", "ratingLabel", "ratingRange", "level"].some(key => isLevel(state[key]))) return true;
    const precise = record(record(state.metadata)?.ratingRangePrecise);
    if (precise && (isLevel(precise.minGrade) || isLevel(precise.maxGrade))) return true;
    if (Array.isArray(state.accessLevels) && state.accessLevels.some(isLevel)) return true;
    for (const key of ["title", "name"]) {
      const title = state[key];
      if (typeof title === "string" && /уров(?:ень|ня)\s*[:：]?\s*(?:[ABCDАВСД]\+?(?![a-zа-я])|[1-7](?:[.,]\d+)?)/i.test(title)) return true;
    }
  }
  return false;
}

export function parseDeclaredLevel(value: string): number | null {
  if (!/^\d(?:[.,]\d{1,5})?$/.test(value.trim())) return null;
  const numeric = Number(value.trim().replace(",", "."));
  return numeric >= 1 && numeric <= 7 ? numeric : null;
}
