import test from "node:test";
import assert from "node:assert/strict";
import { createFprState, applyFprCommand } from "../../src/components/tournaments/fpr6x25.ts";
import { editFprScoreDraft, fprScoreDraftView, reconcileFprScoreDrafts } from "../../src/components/tournaments/fprScoreDraft.ts";

function fixture() {
  const now = "2026-11-10T17:00:00Z";
  const state = createFprState({ tournamentId: "draft-test", players: Array.from({ length: 8 }, (_, i) => ({
    id: `player-${i}`, name: `Player ${i}`, level: 3, leaguePlace: i + 1, leaguePoints: 100 - i,
  })), courts: ["Court 1", "Court 2"], leagueSource: "Test league", endsAt: "2026-11-10T20:00:00Z", reserveAllowed: false, now });
  return { state, match: state.attempts[0].matches[0], other: state.attempts[0].matches[1], now };
}

test("typing during a read preserves the score when the same canonical snapshot returns", () => {
  const { state, match } = fixture();
  const draft = editFprScoreDraft(match, undefined, 1, "17");
  const drafts = reconcileFprScoreDrafts({ [match.id]: draft }, structuredClone(state));
  assert.deepEqual(fprScoreDraftView(match, drafts[match.id]), { score1: "17", score2: "8", dirty: true, conflict: false });
});

test("another court's successful save does not discard a local score", () => {
  const { state, match, other, now } = fixture();
  const draft = editFprScoreDraft(match, undefined, 2, "11");
  const next = applyFprCommand(state, { action: "score", id: "other-save", expectedRevision: state.revision,
    matchId: other.id, score1: 15, score2: 10, confirmed1: true, confirmed2: true, startIfScheduled: true }, now);
  const drafts = reconcileFprScoreDrafts({ [match.id]: draft }, next);
  assert.equal(fprScoreDraftView(next.attempts[0].matches[0], drafts[match.id]).score2, "11");
});

test("a concurrent update on the same court preserves the input and requires conflict review", () => {
  const { state, match } = fixture();
  const draft = editFprScoreDraft(match, undefined, 1, "16");
  const changed = { ...match, score1: 18, score2: 7 };
  const next = structuredClone(state); next.attempts[0].matches[0] = changed;
  const kept = reconcileFprScoreDrafts({ [match.id]: draft }, next)[match.id];
  assert.deepEqual(fprScoreDraftView(changed, kept), { score1: "16", score2: "9", dirty: true, conflict: true });
  const rebased = { ...kept, sourceScore1: changed.score1, sourceScore2: changed.score2 };
  assert.equal(fprScoreDraftView(changed, rebased).conflict, false);
});

test("acknowledgement clears the saved draft so later remote scores do not create a false conflict", () => {
  const { state, match } = fixture();
  const draft = editFprScoreDraft(match, undefined, 1, "20");
  state.attempts[0].matches[0] = { ...match, score1: 20, score2: 5 };
  const drafts = reconcileFprScoreDrafts({ [match.id]: draft }, state);
  assert.deepEqual(drafts, {});
  assert.equal(fprScoreDraftView({ ...match, score1: 19, score2: 6 }, drafts[match.id]).score1, "19");
});

test("clearing a saved score is a draft; remote round cancellation retains orphaned input for export", () => {
  const { state, match } = fixture();
  const draft = editFprScoreDraft({ ...match, score1: 12, score2: 13 }, undefined, 1, "");
  assert.equal(fprScoreDraftView({ ...match, score1: 12, score2: 13 }, draft).dirty, true);
  state.attempts[0].matches = [];
  assert.deepEqual(reconcileFprScoreDrafts({ [match.id]: draft }, state), { [match.id]: draft });
});
