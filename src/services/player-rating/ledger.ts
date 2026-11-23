export const PLAYER_RATING_COLLECTIONS = {
  events: "rating_events",
  state: "player_rating_state",
  compatibilityState: "player_ratings",
  projectionOutbox: "rating_projection_outbox",
  jobRegistry: "rating_job_registry",
  jobRuns: "rating_job_runs",
} as const;

export const PLAYER_RATING_LEDGER_SCHEMA_VERSION = 1;
export const PLAYER_RATING_WORKER_VERSION = "rating-worker-v1.0.15";

export interface PlayerRatingIdentity {
  playerKey: string;
  clientId: string | null;
  phoneNorm: string | null;
  name: string;
}

export interface PlayerRatingEventDocument {
  _id: string;
  id: string;
  idempotencyKey: string;
  schemaVersion: number;
  eventType: string;
  occurredAt: string;
  createdAt: string;
  player: {
    key: string;
    clientId: string | null;
    phoneNorm: string | null;
    name: string;
  };
  actor: Record<string, unknown>;
  source: Record<string, unknown>;
  change: {
    before: number | null;
    delta: number | null;
    after: number | null;
    gradeBefore: string | null;
    gradeAfter: string | null;
  };
  formula: Record<string, unknown> | null;
  projectionIntent: { viva: string };
}

export interface PlayerRatingReplayState {
  ratingNumeric: number;
  rating: string;
  baselineEventId: string;
  baselineAt: string;
  lastEventId: string;
  lastEventType: string;
  lastEventAt: string;
  appliedEvents: number;
}

function toStringOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

export function normalizeRatingPhone(value: unknown): string | null {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits;
}

export function toFiniteRating(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(String(value).replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

export function roundPlayerRating(value: number): number {
  return Math.round(Math.min(7, Math.max(1, value)) * 100000) / 100000;
}

function roundRatingDelta(value: number): number {
  return Math.round(value * 100000) / 100000;
}

export const PLAYER_RATING_BANDS = [
  { grade: "A", min: 5.5, max: 7 },
  { grade: "B+", min: 4.7, max: 5.5 },
  { grade: "B", min: 4, max: 4.7 },
  { grade: "C+", min: 3.5, max: 4 },
  { grade: "C", min: 3, max: 3.5 },
  { grade: "D+", min: 2, max: 3 },
  { grade: "D", min: 1, max: 2 },
] as const;

export type PlayerRatingBand = typeof PLAYER_RATING_BANDS[number];

function ratingBandForNumber(rating: number): PlayerRatingBand {
  return PLAYER_RATING_BANDS.find((band) => rating >= band.min) ?? PLAYER_RATING_BANDS[6];
}

export function ratingGradeFromNumeric(value: unknown): PlayerRatingBand["grade"] {
  return ratingBandForNumber(roundPlayerRating(toFiniteRating(value) ?? 1)).grade;
}

export function ratingSublevelsForBand({ grade, min, max }: PlayerRatingBand) {
  const width = (max - min) / 4;
  const boundaries = [min, ...[1, 2, 3].map((step) => roundPlayerRating(min + step * width)), max];
  const [letter, plus = ""] = grade;
  return ([1, 2, 3, 4] as const).map((index) => ({
    index,
    label: letter + (index === 1 ? "" : String(index - 1)) + plus,
    min: boundaries[index - 1],
    max: boundaries[index],
  }));
}

export function ratingSublevelFromNumeric(value: number) {
  const rating = roundPlayerRating(toFiniteRating(value) ?? 1);
  const band = ratingBandForNumber(rating);
  const steps = ratingSublevelsForBand(band);
  return steps.find((step) => rating < step.max) ?? steps[3];
}

export function ratingGradesForChange(before: unknown, after: unknown) {
  const beforeNumeric = toFiniteRating(before);
  const afterNumeric = toFiniteRating(after);
  return {
    gradeBefore: beforeNumeric == null ? null : ratingGradeFromNumeric(beforeNumeric),
    gradeAfter: afterNumeric == null ? null : ratingGradeFromNumeric(afterNumeric),
  };
}

export function buildPlayerRatingKey(input: {
  clientId?: unknown;
  phoneNorm?: unknown;
  fallback?: unknown;
}): string | null {
  const clientId = toStringOrNull(input.clientId);
  const phoneNorm = normalizeRatingPhone(input.phoneNorm);
  const fallback = toStringOrNull(input.fallback);
  if (clientId) return `client:${clientId}`;
  if (phoneNorm) return `phone:${phoneNorm}`;
  return fallback ? `legacy:${fallback}` : null;
}

function hashParts(parts: unknown[]): string {
  const input = parts.map((part) => String(part ?? "")).join("\u001f");
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= BigInt(input.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

function parseOccurredAt(event: PlayerRatingEventDocument): number {
  const parsed = Date.parse(event.occurredAt || event.createdAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isBaselineEvent(event: PlayerRatingEventDocument): boolean {
  return event.eventType === "RATING_INITIAL_IMPORTED"
    || event.eventType === "RATING_BOOTSTRAPPED_FROM_VIVA"
    || event.eventType === "RATING_BOOTSTRAPPED_FROM_TOURNAMENT"
    || event.eventType === "RATING_BOOTSTRAPPED_FROM_GAME_RESULT"
    || event.eventType === "RATING_TOURNAMENT_CANONICAL_RECONCILED";
}

export function eventAppliesToCanonicalState(event: PlayerRatingEventDocument): boolean {
  return event?.source?.applyToState !== false;
}

export function replayPlayerRatingEvents(
  events: PlayerRatingEventDocument[],
): PlayerRatingReplayState | null {
  const ordered = events.filter(eventAppliesToCanonicalState).sort((left, right) => {
    const timeDiff = parseOccurredAt(left) - parseOccurredAt(right);
    if (timeDiff !== 0) return timeDiff;
    return left.id.localeCompare(right.id);
  });
  const baselines = ordered.filter((event) => isBaselineEvent(event) && toFiniteRating(event.change.after) != null);
  const baseline = baselines.at(-1);
  if (!baseline) return null;

  const baselineAtTs = parseOccurredAt(baseline);
  let ratingNumeric = toFiniteRating(baseline.change.after) as number;
  let lastEvent = baseline;
  let appliedEvents = 0;
  for (const event of ordered) {
    if (event.id === baseline.id || isBaselineEvent(event)) continue;
    if (parseOccurredAt(event) < baselineAtTs) continue;
    const delta = toFiniteRating(event.change.delta);
    if (delta == null) continue;
    ratingNumeric += delta;
    appliedEvents += 1;
    lastEvent = event;
  }
  ratingNumeric = roundPlayerRating(ratingNumeric);
  return {
    ratingNumeric,
    rating: ratingGradeFromNumeric(ratingNumeric),
    baselineEventId: baseline.id,
    baselineAt: baseline.occurredAt,
    lastEventId: lastEvent.id,
    lastEventType: lastEvent.eventType,
    lastEventAt: lastEvent.occurredAt,
    appliedEvents,
  };
}

export function buildGameResultBaselineEvent(input: {
  resultId: string;
  occurredAt: string;
  player: Record<string, unknown>;
  ratingNumeric: unknown;
  createdAt?: string;
}): PlayerRatingEventDocument | null {
  const clientId = toStringOrNull(input.player.id ?? input.player.clientId);
  const phoneNorm = normalizeRatingPhone(input.player.phoneNorm ?? input.player.phone);
  const playerKey = buildPlayerRatingKey({
    clientId,
    phoneNorm,
    fallback: input.player.memberKey,
  });
  const ratingNumeric = toFiniteRating(input.ratingNumeric);
  if (!playerKey || ratingNumeric == null) return null;
  const eventId = `rating_evt:game_result_bootstrap:${hashParts([playerKey])}`;
  return {
    _id: eventId,
    id: eventId,
    idempotencyKey: eventId,
    schemaVersion: PLAYER_RATING_LEDGER_SCHEMA_VERSION,
    eventType: "RATING_BOOTSTRAPPED_FROM_GAME_RESULT",
    occurredAt: input.occurredAt,
    createdAt: input.createdAt || new Date().toISOString(),
    player: {
      key: playerKey,
      clientId,
      phoneNorm,
      name: toStringOrNull(input.player.name) || "Игрок",
    },
    actor: {
      type: "SYSTEM",
      id: "system:game-result-rating-worker",
      name: "Game result rating worker",
    },
    source: {
      domain: "GAME_RESULT_BOOTSTRAP",
      sourceId: input.resultId,
      resultId: input.resultId,
    },
    change: {
      before: null,
      delta: null,
      after: roundPlayerRating(ratingNumeric),
      gradeBefore: null,
      gradeAfter: ratingGradeFromNumeric(ratingNumeric),
    },
    formula: null,
    projectionIntent: { viva: "NONE_BOOTSTRAP" },
  };
}

export function buildGameResultRatingEvent(input: {
  gameId: string;
  resultId: string;
  scoreRevision: number;
  occurredAt: string;
  impact: Record<string, unknown>;
  formula?: Record<string, unknown> | null;
  actor?: Record<string, unknown> | null;
  supersedesResultId?: string | null;
  supersedesEventId?: string | null;
  applySemantics?: string | null;
  createdAt?: string;
}): PlayerRatingEventDocument | null {
  const clientId = toStringOrNull(input.impact.id ?? input.impact.clientId);
  const phoneNorm = normalizeRatingPhone(input.impact.phoneNorm ?? input.impact.phone);
  const memberKey = toStringOrNull(input.impact.memberKey);
  const playerKey = buildPlayerRatingKey({ clientId, phoneNorm, fallback: memberKey });
  const before = toFiniteRating(input.impact.before);
  const after = toFiniteRating(input.impact.after);
  const delta = toFiniteRating(input.impact.delta);
  if (!playerKey || before == null || after == null || delta == null) return null;
  const eventId = `rating_evt:game_result:${hashParts([
    input.resultId,
    input.scoreRevision,
    "apply",
    playerKey,
  ])}`;
  const actor = input.actor && typeof input.actor === "object" ? input.actor : {};
  const actorId = toStringOrNull(actor.id);
  return {
    _id: eventId,
    id: eventId,
    idempotencyKey: eventId,
    schemaVersion: PLAYER_RATING_LEDGER_SCHEMA_VERSION,
    eventType: input.supersedesResultId
      ? "GAME_RESULT_CORRECTION_APPLIED"
      : "GAME_RESULT_SUBMITTED_APPLIED",
    occurredAt: input.occurredAt,
    createdAt: input.createdAt || new Date().toISOString(),
    player: {
      key: playerKey,
      clientId,
      phoneNorm,
      name: toStringOrNull(input.impact.name) || "Игрок",
    },
    actor: {
      type: actorId ? "PLAYER" : "SYSTEM",
      id: actorId || "system:game-result-rating-worker",
      name: toStringOrNull(actor.name) || (actorId ? "Игрок" : "Game result rating worker"),
      phoneNorm: normalizeRatingPhone(actor.phoneNorm ?? actor.phone),
    },
    source: {
      domain: "GAME_RESULT",
      sourceId: input.gameId,
      gameId: input.gameId,
      resultId: input.resultId,
      scoreRevision: input.scoreRevision,
      supersedesResultId: input.supersedesResultId || null,
      supersedesEventId: input.supersedesEventId || null,
      applySemantics: input.applySemantics || "INITIAL_APPLY",
    },
    change: {
      before: roundPlayerRating(before),
      delta: roundRatingDelta(delta),
      after: roundPlayerRating(after),
      gradeBefore: ratingGradeFromNumeric(before),
      gradeAfter: ratingGradeFromNumeric(after),
    },
    formula: input.formula || { version: "game-rating-v1" },
    projectionIntent: { viva: "REQUIRED_DURING_MIGRATION" },
  };
}

export function buildGameResultCompensationEvent(input: {
  event: PlayerRatingEventDocument;
  correctionResultId: string;
  scoreRevision: number;
  occurredAt: string;
  canonicalBefore?: unknown;
  createdAt?: string;
}): PlayerRatingEventDocument | null {
  const delta = toFiniteRating(input.event.change.delta);
  const canonicalBefore = toFiniteRating(input.canonicalBefore) ?? toFiniteRating(input.event.change.after);
  if (delta == null || canonicalBefore == null) return null;
  const compensationDelta = roundRatingDelta(-delta);
  const canonicalAfter = roundPlayerRating(canonicalBefore + compensationDelta);
  const eventId = `rating_evt:game_result_compensation:${hashParts([
    input.event.id,
    input.correctionResultId,
    input.scoreRevision,
  ])}`;
  return {
    ...input.event,
    _id: eventId,
    id: eventId,
    idempotencyKey: eventId,
    eventType: "GAME_RESULT_CORRECTION_REVERTED",
    occurredAt: input.occurredAt,
    createdAt: input.createdAt || new Date().toISOString(),
    actor: {
      type: "SYSTEM",
      id: "system:game-result-rating-worker",
      name: "Game result rating worker",
    },
    source: {
      ...input.event.source,
      correctionResultId: input.correctionResultId,
      correctionScoreRevision: input.scoreRevision,
      compensatesEventId: input.event.id,
      applySemantics: "CORRECTION_TIME",
    },
    change: {
      before: roundPlayerRating(canonicalBefore),
      delta: compensationDelta,
      after: canonicalAfter,
      gradeBefore: ratingGradeFromNumeric(canonicalBefore),
      gradeAfter: ratingGradeFromNumeric(canonicalAfter),
    },
    projectionIntent: { viva: "REQUIRED_DURING_MIGRATION" },
  };
}

export function buildTournamentRatingRevision(input: {
  tournamentId: unknown;
  finishedAt: unknown;
  standing: Record<string, unknown>;
}): string {
  return hashParts([
    input.tournamentId,
    input.finishedAt,
    input.standing.id,
    input.standing.ratingBefore,
    input.standing.ratingDelta ?? input.standing.deltaTotal,
    input.standing.ratingAfter,
  ]);
}

export function buildTournamentRatingEvent(input: {
  tournamentId: string;
  finishedAt: string;
  standing: Record<string, unknown>;
  phoneNorm?: string | null;
  canonicalBefore?: number | null;
  occurredAt?: string;
  createdAt?: string;
  previousEventId?: string | null;
}): PlayerRatingEventDocument | null {
  const clientId = toStringOrNull(input.standing.id ?? input.standing.clientId);
  const phoneNorm = normalizeRatingPhone(input.phoneNorm ?? input.standing.phoneNorm ?? input.standing.phone);
  const playerKey = buildPlayerRatingKey({ clientId, phoneNorm });
  const tournamentBefore = toFiniteRating(input.standing.ratingBefore);
  const tournamentDelta = toFiniteRating(input.standing.ratingDelta ?? input.standing.deltaTotal);
  const tournamentAfter = toFiniteRating(input.standing.ratingAfter);
  if (!playerKey || tournamentBefore == null || tournamentDelta == null || tournamentAfter == null) return null;
  const canonicalBefore = toFiniteRating(input.canonicalBefore) ?? tournamentBefore;
  const canonicalAfter = roundPlayerRating(tournamentAfter);
  const canonicalDelta = roundRatingDelta(canonicalAfter - canonicalBefore);
  const revision = buildTournamentRatingRevision({
    tournamentId: input.tournamentId,
    finishedAt: input.finishedAt,
    standing: input.standing,
  });
  const correctionSuffix = input.previousEventId
    ? `:${hashParts([input.previousEventId])}`
    : "";
  const eventId = `rating_evt:tournament:${input.tournamentId}:${revision}${correctionSuffix}:${playerKey}`;
  return {
    _id: eventId,
    id: eventId,
    idempotencyKey: eventId,
    schemaVersion: PLAYER_RATING_LEDGER_SCHEMA_VERSION,
    eventType: input.previousEventId
      ? "TOURNAMENT_RATING_CORRECTION_APPLIED"
      : "TOURNAMENT_RATING_FINALIZED",
    occurredAt: input.occurredAt || input.finishedAt,
    createdAt: input.createdAt || new Date().toISOString(),
    player: {
      key: playerKey,
      clientId,
      phoneNorm,
      name: toStringOrNull(input.standing.name) || "Игрок",
    },
    actor: {
      type: "SYSTEM",
      id: "system:rating-worker",
      name: "Rating worker",
    },
    source: {
      domain: "TOURNAMENT",
      sourceId: input.tournamentId,
      tournamentId: input.tournamentId,
      sourceRevision: revision,
      supersedesEventId: input.previousEventId || null,
      ratingApplication: "CANONICAL_TARGET_AFTER",
      tournamentRatingSnapshot: {
        before: tournamentBefore,
        delta: tournamentDelta,
        after: tournamentAfter,
      },
    },
    change: {
      before: canonicalBefore,
      delta: canonicalDelta,
      after: canonicalAfter,
      gradeBefore: ratingGradeFromNumeric(canonicalBefore),
      gradeAfter: ratingGradeFromNumeric(canonicalAfter),
    },
    formula: { version: "tournament-rating-v1", applicationVersion: "canonical-target-after-v1" },
    projectionIntent: { viva: "REQUIRED_DURING_MIGRATION" },
  };
}

export function buildTournamentStartOverrideEvent(input: {
  tournamentId: string;
  startChange: Record<string, unknown>;
  phoneNorm?: string | null;
  canonicalBefore?: number | null;
  createdAt?: string;
}): PlayerRatingEventDocument | null {
  const player = input.startChange.player && typeof input.startChange.player === "object"
    ? input.startChange.player as Record<string, unknown>
    : {};
  const change = input.startChange.change && typeof input.startChange.change === "object"
    ? input.startChange.change as Record<string, unknown>
    : {};
  const changedBy = input.startChange.changedBy && typeof input.startChange.changedBy === "object"
    ? input.startChange.changedBy as Record<string, unknown>
    : {};
  const source = input.startChange.source && typeof input.startChange.source === "object"
    ? input.startChange.source as Record<string, unknown>
    : {};
  const clientId = toStringOrNull(player.clientId);
  const phoneNorm = normalizeRatingPhone(input.phoneNorm ?? player.phone);
  const playerKey = buildPlayerRatingKey({ clientId, phoneNorm, fallback: player.participantId });
  const targetAfter = toFiniteRating(change.after);
  const canonicalBefore = toFiniteRating(input.canonicalBefore) ?? toFiniteRating(change.before);
  const occurredAt = toStringOrNull(input.startChange.occurredAt);
  const sourceEventId = toStringOrNull(input.startChange.eventId);
  if (!playerKey || targetAfter == null || canonicalBefore == null || !occurredAt || !sourceEventId) return null;
  const after = roundPlayerRating(targetAfter);
  const before = roundPlayerRating(canonicalBefore);
  const delta = roundRatingDelta(after - before);
  const eventId = `rating_evt:tournament_start:${hashParts([
    input.tournamentId,
    sourceEventId,
    playerKey,
  ])}`;
  const actorId = toStringOrNull(changedBy.id);

  return {
    _id: eventId,
    id: eventId,
    idempotencyKey: eventId,
    schemaVersion: PLAYER_RATING_LEDGER_SCHEMA_VERSION,
    eventType: "TOURNAMENT_START_RATING_CHANGED",
    occurredAt,
    createdAt: input.createdAt || new Date().toISOString(),
    player: {
      key: playerKey,
      clientId,
      phoneNorm,
      name: toStringOrNull(player.name) || "Игрок",
    },
    actor: {
      type: actorId ? "ADMIN" : "SYSTEM",
      id: actorId || "system:tournament-start",
      name: toStringOrNull(changedBy.name) || (actorId ? "Организатор" : "Tournament start"),
      phoneNorm: normalizeRatingPhone(changedBy.phone),
    },
    source: {
      domain: "TOURNAMENT_START",
      sourceId: input.tournamentId,
      tournamentId: input.tournamentId,
      startEventId: sourceEventId,
      reason: toStringOrNull(source.reason) || "MANUAL_OVERRIDE",
      ratingApplication: "CANONICAL_TARGET_AFTER",
    },
    change: {
      before,
      delta,
      after,
      gradeBefore: ratingGradeFromNumeric(before),
      gradeAfter: ratingGradeFromNumeric(after),
    },
    formula: {
      version: "tournament-start-override-v1",
      applicationVersion: "canonical-target-after-v1",
    },
    projectionIntent: { viva: "REQUIRED_DURING_MIGRATION" },
  };
}

export function buildTournamentCompensationEvent(input: {
  event: PlayerRatingEventDocument;
  occurredAt: string;
  createdAt?: string;
  reason: "REOPENED" | "CORRECTED" | "ANNULLED";
}): PlayerRatingEventDocument | null {
  const delta = toFiniteRating(input.event.change.delta);
  if (delta == null) return null;
  const eventId = `rating_evt:tournament_compensation:${hashParts([
    input.event.id,
    input.reason,
    input.occurredAt,
  ])}`;
  return {
    ...input.event,
    _id: eventId,
    id: eventId,
    idempotencyKey: eventId,
    eventType: input.reason === "REOPENED"
      ? "TOURNAMENT_RATING_REOPENED_REVERTED"
      : input.reason === "ANNULLED"
        ? "TOURNAMENT_RATING_ANNULLED"
        : "TOURNAMENT_RATING_CORRECTION_REVERTED",
    occurredAt: input.occurredAt,
    createdAt: input.createdAt || new Date().toISOString(),
    actor: {
      type: "SYSTEM",
      id: "system:rating-worker",
      name: "Rating worker",
    },
    source: {
      ...input.event.source,
      compensationReason: input.reason,
      compensatesEventId: input.event.id,
      sourceRevision: hashParts([input.event.id, input.reason, input.occurredAt]),
    },
    change: {
      before: input.event.change.after,
      delta: roundRatingDelta(-delta),
      after: input.event.change.before,
      ...ratingGradesForChange(input.event.change.after, input.event.change.before),
    },
    projectionIntent: { viva: "REQUIRED_DURING_MIGRATION" },
  };
}
