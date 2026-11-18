import type { FprMatch, FprState } from "./fpr6x25";

export type FprScoreDraft = {
  score1: string;
  score2: string;
  sourceScore1: number | null;
  sourceScore2: number | null;
};

const text = (score: number | null) => score?.toString() ?? "";
const matches = (draft: FprScoreDraft, score1: number | null, score2: number | null) =>
  draft.score1 === text(score1) && draft.score2 === text(score2);

export function fprScoreDraftView(match: FprMatch, draft?: FprScoreDraft) {
  const dirty = Boolean(draft && !matches(draft, draft.sourceScore1, draft.sourceScore2)
    && !matches(draft, match.score1, match.score2));
  return {
    score1: dirty ? draft!.score1 : text(match.score1),
    score2: dirty ? draft!.score2 : text(match.score2),
    dirty,
    conflict: dirty && (draft!.sourceScore1 !== match.score1 || draft!.sourceScore2 !== match.score2),
  };
}

export function editFprScoreDraft(match: FprMatch, draft: FprScoreDraft | undefined, team: 1 | 2, value: string): FprScoreDraft {
  const previous = fprScoreDraftView(match, draft);
  const parsed = Math.max(0, Math.min(25, Number.parseInt(value, 10) || 0));
  return {
    score1: value.trim() ? String(team === 1 ? parsed : 25 - parsed) : "",
    score2: value.trim() ? String(team === 2 ? parsed : 25 - parsed) : "",
    sourceScore1: previous.dirty ? draft!.sourceScore1 : match.score1,
    sourceScore2: previous.dirty ? draft!.sourceScore2 : match.score2,
  };
}

export function reconcileFprScoreDrafts(drafts: Record<string, FprScoreDraft>, state: FprState) {
  const byId = new Map(state.attempts.flatMap(attempt => attempt.matches.map(match => [match.id, match] as const)));
  return Object.fromEntries(Object.entries(drafts).filter(([id, draft]) => {
    const match = byId.get(id);
    // Retain an orphaned draft for export if a remote command removed its match.
    return !match || fprScoreDraftView(match, draft).dirty;
  }));
}
