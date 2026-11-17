const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

function isLevel(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value) && value >= 1 && value <= 7;
  if (typeof value !== "string") return false;
  const text = value.trim().toUpperCase();
  return /^(?:[ABCDАВСД]\+?(?:\s*[1-4])?|[1-7](?:[.,]\d+)?)(?:\s*[/–—-]\s*(?:[ABCDАВСД]\+?(?:\s*[1-4])?|[1-7](?:[.,]\d+)?))*$/.test(text);
}

function eventLevelStates(value: unknown): Record<string, unknown>[] {
  const root = record(value);
  if (!root) return [];
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
  return states;
}

/** Only explicit event admission metadata counts; rating calculation parameters do not. */
export function hasLevelRestriction(value: unknown): boolean {
  for (const state of eventLevelStates(value)) {
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

function displayLevel(value: unknown): string | null {
  if (!isLevel(value)) return null;
  const text = String(value).trim();
  const numeric = Number(text.replace(",", "."));
  if (Number.isFinite(numeric)) return numeric >= 1 && numeric <= 7 ? String(numeric).replace(".", ",") : null;
  return text.toUpperCase().replace(/[АВСД]/g, letter => ({ А: "A", В: "B", С: "C", Д: "D" })[letter]!)
    .replace(/\s*[–—-]\s*/g, "–").replace(/\s*\/\s*/g, " / ").replace(/([ABCD]\+?)\s+([1-4])/g, "$1$2");
}

/** Display event admission settings, never player levels or calculation bounds. */
export function getEventAllowedLevelLabel(value: unknown): string | null {
  const states = eventLevelStates(value);
  for (const state of states) {
    const precise = record(record(state.metadata)?.ratingRangePrecise);
    if (!precise) continue;
    const bound = (side: "min" | "max") => {
      const grade = displayLevel(precise[`${side}Grade`]);
      if (!grade || !/^[ABCD]\+?$/.test(grade)) return null;
      const division = precise[`${side}Level`];
      return grade + (Number.isInteger(division) && Number(division) >= 0 && Number(division) <= 4 ? division : "");
    };
    const min = bound("min"), max = bound("max");
    if (min || max) return min && max ? min === max ? min : `${min}–${max}` : min ? `от ${min}` : `до ${max}`;
  }
  for (const state of states) {
    for (const key of ["levelLabel", "ratingLabel", "ratingRange", "level"]) {
      const label = displayLevel(state[key]);
      if (label) return label;
    }
    const first = (keys: string[]) => keys.map(key => displayLevel(state[key])).find(Boolean);
    const min = first(["minRating", "ratingFrom", "ratingMin", "levelFrom"]);
    const max = first(["maxRating", "ratingTo", "ratingMax", "levelTo"]);
    if (min || max) return min && max ? min === max ? min : `${min}–${max}` : min ? `от ${min}` : `до ${max}`;
    if (Array.isArray(state.accessLevels)) {
      const levels = [...new Set(state.accessLevels.map(displayLevel).filter((label): label is string => label !== null))];
      if (levels.length) return levels.join(" / ");
    }
  }
  for (const state of states) for (const key of ["title", "name"]) {
    if (typeof state[key] !== "string") continue;
    const match = state[key].match(/уров(?:ень|ня)\s*[:：]?\s*((?:[ABCDАВСД]\+?(?:\s*[1-4])?(?![a-zа-я])|[1-7](?:[.,]\d+)?)(?:\s*[/–—-]\s*(?:[ABCDАВСД]\+?(?:\s*[1-4])?(?![a-zа-я])|[1-7](?:[.,]\d+)?))*)/i);
    const label = displayLevel(match?.[1]);
    if (label) return label;
  }
  return null;
}

export function parseDeclaredLevel(value: string): number | null {
  if (!/^\d(?:[.,]\d{1,5})?$/.test(value.trim())) return null;
  const numeric = Number(value.trim().replace(",", "."));
  return numeric >= 1 && numeric <= 7 ? numeric : null;
}
