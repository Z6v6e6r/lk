import { getTournamentRatingExclusion } from "./tournamentExclusionGuard.ts";
import { validateFprState } from "../../components/tournaments/fpr6x25.ts";

export type FprLevelResultRow = { id: string; status: "pending" | "not_awarded" }
  | { id: string; status: "applied"; before: number; after: number; delta: number };
export interface FprLevelResults {
  version: 1;
  protocolId: string;
  protocolRevision: number;
  sourceEventId: string;
  calculatedAt: string;
  rootExcludedPlayerIds: string[];
  rows: FprLevelResultRow[];
}
const record = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Expose only IDs, never admin audit reasons, and invalidate malformed exclusion metadata. */
export function fprLevelExcludedPlayerIds(state: unknown, exclusions: unknown): string[] | null {
  try {
    validateFprState(state);
    return state.players.filter(p => getTournamentRatingExclusion({ ratingExclusions: exclusions }, p.id, "level")).map(p => p.id).sort();
  } catch { return null; }
}

/** Read only a server projection of this exact completed protocol, never today's player level. */
export function readFprLevelResults(state: unknown, value: unknown, rootExcludedIds: string[] | null = [], rootSourceEventId?: unknown): FprLevelResults | null {
  try {
    validateFprState(state);
    const nestedSourceId = state.communityRating?.sourceExerciseId;
    if (rootSourceEventId && typeof rootSourceEventId !== "string"
      || nestedSourceId && rootSourceEventId && nestedSourceId !== rootSourceEventId) return null;
    const sourceEventId = nestedSourceId || (typeof rootSourceEventId === "string" ? rootSourceEventId : null) || state.tournamentId;
    if (state.status !== "completed" || state.testMode !== false || !record(value) || value.version !== 1
      || value.protocolId !== state.tournamentId || value.protocolRevision !== state.revision
      || value.sourceEventId !== sourceEventId
      || typeof value.calculatedAt !== "string" || !Number.isFinite(Date.parse(value.calculatedAt))
      || !Array.isArray(rootExcludedIds) || !Array.isArray(value.rootExcludedPlayerIds)
      || JSON.stringify([...rootExcludedIds].sort()) !== JSON.stringify([...value.rootExcludedPlayerIds].sort())
      || !Array.isArray(value.rows) || value.rows.length !== state.players.length) return null;
    const ids = new Set(state.players.map(p => p.id));
    if (new Set(rootExcludedIds).size !== rootExcludedIds.length || rootExcludedIds.some(id => !ids.has(id))) return null;
    const seen = new Set<string>();
    const rows: FprLevelResultRow[] = [];
    for (const row of value.rows) {
      if (!record(row) || typeof row.id !== "string" || !ids.has(row.id) || seen.has(row.id)) return null;
      seen.add(row.id);
      if (rootExcludedIds.includes(row.id) && row.status !== "not_awarded") return null;
      if (row.status === "pending" || row.status === "not_awarded") rows.push({ id: row.id, status: row.status });
      else if (row.status === "applied" && finite(row.before) && finite(row.after) && finite(row.delta)
        && row.before >= 1 && row.before <= 7 && row.after >= 1 && row.after <= 7
        && Math.abs(Number((row.after - row.before).toFixed(5)) - row.delta) < 0.000001) {
        rows.push({ id: row.id, status: row.status, before: row.before, after: row.after, delta: row.delta });
      } else return null;
    }
    return { version: 1, protocolId: state.tournamentId, protocolRevision: state.revision,
      sourceEventId: value.sourceEventId as string, calculatedAt: value.calculatedAt, rootExcludedPlayerIds: [...rootExcludedIds], rows };
  } catch { return null; }
}

export function formatFprLevel(value: number, signed = false): string {
  const text = (Object.is(value, -0) ? 0 : value).toLocaleString("ru-RU", { maximumFractionDigits: 5 });
  return signed && value > 0 ? `+${text}` : text;
}
