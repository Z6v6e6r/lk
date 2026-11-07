import { replayPlayerRatingEvents, roundPlayerRating, type PlayerRatingEventDocument } from "./ledger.ts";

const BASELINES = new Set(["RATING_INITIAL_IMPORTED", "RATING_BOOTSTRAPPED_FROM_VIVA", "RATING_BOOTSTRAPPED_FROM_TOURNAMENT",
  "RATING_BOOTSTRAPPED_FROM_GAME_RESULT", "RATING_TOURNAMENT_CANONICAL_RECONCILED"]);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const generated = (event: PlayerRatingEventDocument) => event.source.fprReconciliation === true;
const fpr = (event: PlayerRatingEventDocument) => typeof event.source.fprProtocolId === "string";
const at = (event: PlayerRatingEventDocument) => {
  const time = Date.parse(String(fpr(event) ? event.source.fprFinishedAt : event.occurredAt || event.createdAt));
  if (!Number.isFinite(time)) throw new Error("FPR_REPLAY_INVALID_TIME");
  return time;
};

/** The ordinary ledger clamps only its final projection; retain its underlying balance. */
function rawLedgerRating(input: PlayerRatingEventDocument[]) {
  const ordered = input.filter(e => e.source.applyToState !== false).sort((a, b) => {
    const left = Date.parse(a.occurredAt || a.createdAt), right = Date.parse(b.occurredAt || b.createdAt);
    if (!Number.isFinite(left) || !Number.isFinite(right)) throw new Error("FPR_REPLAY_INVALID_TIME");
    return left - right || a.id.localeCompare(b.id);
  });
  const baseline = ordered.filter(e => BASELINES.has(e.eventType) && finite(e.change.after)).at(-1);
  if (!baseline) throw new Error("FPR_REPLAY_BASELINE_MISSING");
  let raw = baseline.change.after!;
  for (const event of ordered) {
    if (event.id === baseline.id || BASELINES.has(event.eventType) || Date.parse(event.occurredAt) < Date.parse(baseline.occurredAt)) continue;
    if (finite(event.change.delta)) raw += event.change.delta;
  }
  return raw;
}

/** Receipt-backed ordering applies only inside a pure equal-time FPR target group. */
function orderTargets(events: PlayerRatingEventDocument[]) {
  const ordered = events.sort((a, b) => at(a) - at(b) || a.id.localeCompare(b.id));
  const result: PlayerRatingEventDocument[] = [];
  for (let i = 0; i < ordered.length;) {
    let end = i + 1;
    while (end < ordered.length && at(ordered[end]) === at(ordered[i])) end++;
    const group = ordered.slice(i, end);
    const hasOrder = group.some(e => Array.isArray(e.source.fprOrderedAfterSourceIds) && e.source.fprOrderedAfterSourceIds.length);
    if (hasOrder) {
      if (group.some(e => !fpr(e)) || new Set(group.map(e => e.source.sourceId)).size !== group.length)
        throw new Error("FPR_REPLAY_ORDER_MIXED");
      const remaining = [...group];
      while (remaining.length) {
        const index = remaining.findIndex(e => {
          const after = e.source.fprOrderedAfterSourceIds;
          if (after != null && (!Array.isArray(after) || after.some(id => typeof id !== "string")))
            throw new Error("FPR_REPLAY_ORDER_INVALID");
          return !remaining.some(other => Array.isArray(after) && after.includes(other.source.sourceId));
        });
        if (index < 0) throw new Error("FPR_REPLAY_ORDER_CYCLE");
        result.push(remaining.splice(index, 1)[0]);
      }
    } else result.push(...group);
    i = end;
  }
  return result;
}

/** Scoped replay for identities receiving FPR awards; ordinary global replay stays unchanged. */
export function replayFprRatingTargets(input: PlayerRatingEventDocument[]) {
  const events = input.filter(e => !generated(e) && e.source.applyToState !== false);
  const fprEvents = events.filter(fpr);
  if (!fprEvents.length) return null;
  const firstAt = Math.min(...fprEvents.map(at));
  // Preserve the existing ledger's exact state before FPR begins; do not rewrite earlier history.
  const before = replayPlayerRatingEvents(events.filter(e => !fpr(e) && at(e) < firstAt));
  if (!before) throw new Error("FPR_REPLAY_BASELINE_MISSING");
  let rating = rawLedgerRating(events.filter(e => !fpr(e) && at(e) < firstAt));
  const compensated = new Set(fprEvents.map(e => e.source.compensatesEventId).filter(Boolean));
  const ordered = orderTargets(events.filter(e => at(e) >= firstAt && (!fpr(e) || (!e.source.compensatesEventId && !compensated.has(e.id)))));
  let lastAt = firstAt;
  for (const event of ordered) {
    if (!fpr(event) && event.source.compensatesEventId && finite(event.change.delta)) {
      rating += event.change.delta;
    } else if (BASELINES.has(event.eventType) || ["TOURNAMENT", "TOURNAMENT_START"].includes(String(event.source.domain))) {
      if (!finite(event.change.after)) throw new Error("FPR_REPLAY_TARGET_MISSING");
      rating = event.change.after;
    } else if (finite(event.change.delta)) {
      rating += event.change.delta;
    }
    lastAt = Math.max(lastAt, at(event));
  }
  // Even a fully reverted FPR must advance beyond its persisted event timestamp.
  lastAt = Math.max(lastAt, ...fprEvents.map(at));
  return { ratingNumeric: roundPlayerRating(rating), rawRatingNumeric: Number(rating.toFixed(5)), firstAt: new Date(firstAt).toISOString(),
    frontierAt: new Date(lastAt + 1).toISOString(), baselineEventId: before.baselineEventId };
}

/** Additive reconciliation does not hide an independently appended game behind a new baseline. */
export function planFprRatingReconciliation(input: PlayerRatingEventDocument[]) {
  const target = replayFprRatingTargets(input);
  if (!target) return null;
  const ordinary = replayPlayerRatingEvents(input);
  if (!ordinary) throw new Error("FPR_REPLAY_BASELINE_MISSING");
  const raw = rawLedgerRating(input);
  const delta = Number((target.rawRatingNumeric - raw).toFixed(5));
  if (delta === 0) return null;
  return { before: ordinary.ratingNumeric, after: target.ratingNumeric, rawBefore: Number(raw.toFixed(5)),
    rawAfter: target.rawRatingNumeric, delta, baselineEventId: target.baselineEventId };
}
