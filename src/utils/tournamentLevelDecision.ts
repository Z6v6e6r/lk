/**
 * Presentation of the CUP tournament level decision (`GET /tournaments/:id/level-decision`).
 * This file only normalizes and renders the server decision. It deliberately contains no
 * admission formula: allowed/denied, ranges and tolerance all come from CUP.
 */

export type TournamentLevelReasonCode =
  | "LEVEL_NOT_RESTRICTED"
  | "LEVEL_ALLOWED"
  | "LEVEL_ALLOWED_WITH_TOLERANCE"
  | "LEVEL_NOT_ALLOWED"
  | "PLAYER_LEVEL_REQUIRED"
  | "PLAYER_LEVEL_UNKNOWN"
  | "LEVEL_CHECK_UNAVAILABLE"
  | "ACTIVITY_LEVEL_INVALID"
  | "LEVEL_GATE_DISABLED"
  | "LEVEL_GATE_LEGACY";

export interface TournamentLevelRange {
  min: number;
  max: number | null;
}

export interface TournamentLevelDecision {
  enforced: boolean;
  allowed: boolean;
  reasonCode: TournamentLevelReasonCode;
  message: string | null;
  ruleKind: "NONE" | "RANGE" | "CATEGORIES" | "INVALID";
  baseRange: TournamentLevelRange | null;
  allowedGrades: string[] | null;
  levelTolerance: number;
  effectiveRange: TournamentLevelRange | null;
  playerLevel: number | null;
  ruleVersion: string | null;
}

const REASONS: readonly TournamentLevelReasonCode[] = [
  "LEVEL_NOT_RESTRICTED", "LEVEL_ALLOWED", "LEVEL_ALLOWED_WITH_TOLERANCE", "LEVEL_NOT_ALLOWED",
  "PLAYER_LEVEL_REQUIRED", "PLAYER_LEVEL_UNKNOWN", "LEVEL_CHECK_UNAVAILABLE", "ACTIVITY_LEVEL_INVALID",
  "LEVEL_GATE_DISABLED", "LEVEL_GATE_LEGACY",
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

function range(value: unknown): TournamentLevelRange | null {
  if (!isRecord(value)) return null;
  const min = finite(value.min);
  if (min === null) return null;
  const max = value.max === null ? null : finite(value.max);
  if (value.max !== null && max === null) return null;
  return { min, max };
}

/** Unknown or malformed server payloads normalize to null, never to "allowed". */
export function normalizeTournamentLevelDecision(value: unknown): TournamentLevelDecision | null {
  if (!isRecord(value) || typeof value.allowed !== "boolean") return null;
  const reasonCode = REASONS.find((reason) => reason === value.reasonCode);
  if (!reasonCode) return null;
  const ruleKind = (["NONE", "RANGE", "CATEGORIES", "INVALID"] as const).find((kind) => kind === value.ruleKind) ?? "INVALID";
  return {
    enforced: value.enforced === true,
    allowed: value.allowed,
    reasonCode,
    message: typeof value.message === "string" && value.message.trim() ? value.message.trim() : null,
    ruleKind,
    baseRange: range(value.baseRange),
    allowedGrades: Array.isArray(value.allowedGrades)
      ? value.allowedGrades.filter((grade): grade is string => typeof grade === "string")
      : null,
    levelTolerance: finite(value.levelTolerance) ?? 0,
    effectiveRange: range(value.effectiveRange),
    playerLevel: finite(value.playerLevel),
    ruleVersion: typeof value.ruleVersion === "string" ? value.ruleVersion : null,
  };
}

const level = (value: number) => value.toFixed(2).replace(".", ",");
export const formatTournamentLevelRange = (value: TournamentLevelRange) =>
  value.max === null ? `от ${level(value.min)}` : `${level(value.min)}–${level(value.max)}`;

export type TournamentLevelGateState =
  /** Nothing to show or enforce (unrestricted, legacy CUP, not signed in). */
  | { kind: "OPEN"; decision: TournamentLevelDecision | null }
  | { kind: "ALLOWED"; decision: TournamentLevelDecision }
  | { kind: "BLOCKED"; decision: TournamentLevelDecision | null; reason: TournamentLevelReasonCode };

/**
 * Maps the server decision (or its failure) to the signup state. `levelRestrictedHint` is the
 * tournament's own displayed level restriction; when CUP cannot be asked for a restricted
 * tournament, signup stays closed instead of defaulting to allowed.
 */
export function resolveTournamentLevelGate(input: {
  decision: TournamentLevelDecision | null;
  requestFailed: boolean;
  notFound: boolean;
  levelRestrictedHint: boolean;
}): TournamentLevelGateState {
  const { decision } = input;
  if (decision) {
    if (!decision.enforced) return { kind: "OPEN", decision };
    return decision.allowed
      ? { kind: decision.reasonCode === "LEVEL_NOT_RESTRICTED" || decision.reasonCode === "LEVEL_GATE_DISABLED" ? "OPEN" : "ALLOWED", decision } as TournamentLevelGateState
      : { kind: "BLOCKED", decision, reason: decision.reasonCode };
  }
  // 404: the tournament has no CUP rule (or CUP predates the decision route).
  if (input.notFound || !input.requestFailed) return { kind: "OPEN", decision: null };
  return input.levelRestrictedHint
    ? { kind: "BLOCKED", decision: null, reason: "LEVEL_CHECK_UNAVAILABLE" }
    : { kind: "OPEN", decision: null };
}

export interface TournamentLevelNotice {
  rangeLine: string | null;
  toleranceLine: string | null;
  statusLine: string | null;
  tone: "neutral" | "ok" | "warning" | "error";
}

const STATUS_TEXT: Partial<Record<TournamentLevelReasonCode, string>> = {
  LEVEL_ALLOWED_WITH_TOLERANCE: "Ваш уровень подходит с учётом допуска турнира.",
  PLAYER_LEVEL_REQUIRED: "Уровень не определён. Определите уровень, чтобы записаться на турнир.",
  PLAYER_LEVEL_UNKNOWN: "Не удалось подтвердить ваш уровень. Обратитесь к организатору турнира.",
  LEVEL_CHECK_UNAVAILABLE: "Проверка уровня временно недоступна. Попробуйте позже — запись откроется после проверки.",
  ACTIVITY_LEVEL_INVALID: "Ограничение уровня турнира настроено некорректно. Запись временно недоступна.",
};

/** Text for the signup screen, derived only from server fields. */
export function describeTournamentLevelGate(state: TournamentLevelGateState): TournamentLevelNotice | null {
  const decision = state.decision;
  if (state.kind === "OPEN" && (!decision || !decision.enforced)) return null;
  const rangeLine = decision?.ruleKind === "RANGE" && decision.baseRange
    ? `Уровень турнира: ${formatTournamentLevelRange(decision.baseRange)}.`
    : decision?.ruleKind === "CATEGORIES" && decision.allowedGrades?.length
      ? `Уровень турнира: ${decision.allowedGrades.join(", ")}.`
      : null;
  const toleranceLine = decision?.ruleKind === "RANGE" && decision.levelTolerance > 0 && decision.effectiveRange
    ? `Допуск ±${level(decision.levelTolerance)}: можно записаться с рейтингом ${formatTournamentLevelRange(decision.effectiveRange)}.`
    : null;
  if (state.kind === "OPEN") return rangeLine || toleranceLine ? { rangeLine, toleranceLine, statusLine: null, tone: "neutral" } : null;
  if (state.kind === "ALLOWED") {
    return {
      rangeLine,
      toleranceLine,
      statusLine: STATUS_TEXT[state.decision.reasonCode] ?? null,
      tone: "ok",
    };
  }
  const bounds = decision?.effectiveRange ?? decision?.baseRange ?? null;
  const statusLine = state.reason === "LEVEL_NOT_ALLOWED"
    ? decision?.playerLevel !== null && decision?.playerLevel !== undefined && bounds
      ? `Ваш уровень ${level(decision.playerLevel)} вне допустимых границ ${formatTournamentLevelRange(bounds)}. Запись на этот турнир недоступна.`
      : decision?.message ?? "Ваш уровень не подходит для этого турнира."
    : STATUS_TEXT[state.reason] ?? decision?.message ?? "Запись на этот турнир сейчас недоступна.";
  return {
    rangeLine,
    toleranceLine,
    statusLine,
    tone: state.reason === "LEVEL_CHECK_UNAVAILABLE" ? "warning" : "error",
  };
}

/** Server label for the "Уровень" row, so the card never promises a wider range than CUP allows. */
export function tournamentLevelLabelFromDecision(decision: TournamentLevelDecision | null): string | null {
  if (!decision?.enforced) return null;
  if (decision.ruleKind === "RANGE" && decision.baseRange) {
    const base = formatTournamentLevelRange(decision.baseRange);
    return decision.levelTolerance > 0 && decision.effectiveRange
      ? `${base} (с допуском ${formatTournamentLevelRange(decision.effectiveRange)})`
      : base;
  }
  if (decision.ruleKind === "CATEGORIES" && decision.allowedGrades?.length) return decision.allowedGrades.join(", ");
  return null;
}
