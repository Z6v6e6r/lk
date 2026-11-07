import { fprStandings, validateFprState, type FprState } from "../../components/tournaments/fpr6x25.ts";

export const FPR_LEVEL_FORMULA_VERSION = "fpr-ordinary-tournament-v1";
type RecordValue = Record<string, unknown>;
export interface FprLevelOptions {
  params?: RecordValue;
  participants?: RecordValue[];
  /** Explicit policy for an unrated frozen snapshot; never silently turn zero into a bonus. */
  unratedStartLevel?: number;
}
interface LevelPlayer {
  id: string; before: number; rating: number; delta: number; matches: number; unrated: boolean;
  verif: number; regularity: number; engagement: number; pressure: number; multiplier: number;
}
const number = (value: unknown, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const round = (value: number, digits: number) => Number(value.toFixed(digits));
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** Ordinary tournament maths over the real closed FPR matches, without legacy-round writes. */
export function calculateFprTournamentRatings(state: FprState, options: FprLevelOptions = {}) {
  validateFprState(state);
  if (state.testMode !== false || state.status !== "completed") throw new Error("FPR_LEVEL_NOT_FINAL");
  const params = options.params ?? {};
  const weights = params.weights && typeof params.weights === "object" ? params.weights as RecordValue : {};
  const K = number(params.K, 0.3), D = number(params.D, 3), B = number(params.B, 0.3);
  const influence = number(params.Influence, 0.5);
  const wv = number(weights.verif, 0.5), wr = number(weights.regularity, 0.3), we = number(weights.engagement, 0.2);
  const min = number(params.minRating, 1), max = number(params.maxRating, 7), digits = number(params.round, 5);
  if (K < 0 || D <= 0 || B < 0 || min !== 1 || max !== 7 || !Number.isInteger(digits) || digits < 0 || digits > 10) {
    throw new Error("FPR_LEVEL_INVALID_FORMULA");
  }
  const players = new Map<string, LevelPlayer>(state.players.map(p => {
    const participant = options.participants?.find(row => String(row.id) === p.id) ?? {};
    if (p.level !== 0 && (p.level < min || p.level > max)) throw new Error("FPR_LEVEL_INVALID_START");
    const unrated = p.level === 0;
    const before = unrated ? options.unratedStartLevel : p.level;
    if (before == null || !Number.isFinite(before) || before < min || before > max) throw new Error("FPR_LEVEL_UNRATED_START");
    return [p.id, { id: p.id, before, rating: before, delta: 0, matches: 0, unrated,
      verif: number(participant.verif, 0.1), regularity: number(participant.regularity, 1),
      engagement: number(participant.engagement, 1), pressure: number(participant.pressure, 1),
      multiplier: number(participant.tournamentMultiplier, 1) }] as [string, LevelPlayer];
  }));
  const pairRating = (a: LevelPlayer, b: LevelPlayer) => (a.rating * a.rating + b.rating * b.rating) / (a.rating + b.rating);
  const delta = (p: LevelPlayer, opponentRating: number, actual: number, opponentVerif: number) => {
    const expected = 1 / (1 + Math.pow(10, (opponentRating - p.rating) / D));
    const confidence = wv * p.verif + wr * p.regularity + we * p.engagement;
    const result = round(K * (actual - expected) * ((1 - influence) + influence * confidence)
      * ((1 - influence) + influence * opponentVerif) * p.pressure * p.multiplier, digits);
    if (!Number.isFinite(result)) throw new Error("FPR_LEVEL_INVALID_FORMULA");
    return result;
  };
  let matches = 0;
  for (const attempt of state.attempts) {
    if (attempt.status !== "closed") continue;
    for (const match of attempt.matches) {
      const a = players.get(match.pair1[0])!, b = players.get(match.pair1[1])!;
      const c = players.get(match.pair2[0])!, d = players.get(match.pair2[1])!;
      const actual1 = 1 / (1 + Math.exp(-B * (match.score1! - match.score2!)));
      const actual2 = 1 / (1 + Math.exp(-B * (match.score2! - match.score1!)));
      const pair1 = pairRating(a, b), pair2 = pairRating(c, d);
      // All four deltas use the same pre-match state, exactly as the ordinary handler.
      const changes = [delta(a, pair2, actual1, (c.verif + d.verif) / 2), delta(b, pair2, actual1, (c.verif + d.verif) / 2),
        delta(c, pair1, actual2, (a.verif + b.verif) / 2), delta(d, pair1, actual2, (a.verif + b.verif) / 2)];
      [a, b, c, d].forEach((p, index) => {
        p.delta += changes[index];
        if (!Number.isFinite(p.delta)) throw new Error("FPR_LEVEL_INVALID_FORMULA");
        p.rating = round(clamp(p.rating + changes[index], min, max), digits);
        p.matches += 1;
      });
      matches += 1;
    }
  }
  return {
    formulaVersion: FPR_LEVEL_FORMULA_VERSION,
    tournamentId: state.communityRating?.sourceExerciseId || state.tournamentId,
    sourceProtocolId: state.tournamentId,
    finishedAt: state.finishedAt!, matches,
    standings: fprStandings(state).map(row => {
      const p = players.get(row.id)!;
      return { ...row, ratingBefore: p.before, ratingAfter: p.rating, ratingDelta: round(p.delta, digits),
        deltaTotal: round(p.delta, digits), unratedStartApplied: p.unrated, ratedMatches: p.matches };
    }),
  };
}
