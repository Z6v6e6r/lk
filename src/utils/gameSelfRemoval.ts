export type GameSelfRemovalAuditStatus =
  | "cancelled_in_viva"
  | "already_absent_in_viva"
  | "no_viva_booking_target";

export type GameSelfRemovalAuditVerification =
  | "verified_absent"
  | "verified_booking_history"
  | "skipped_no_exercise_id"
  | "skipped_no_booking_target";

export interface GameSelfRemovalAuditEntry {
  id: string;
  at: string;
  gameId: string | null;
  source: "game_join" | "game_details";
  actor: "self";
  playerId: string | null;
  playerPhone: string | null;
  playerName: string | null;
  status: GameSelfRemovalAuditStatus;
  verification: GameSelfRemovalAuditVerification;
  bookingIds: string[];
  traceSteps: string[];
}

const DEFAULT_GAME_SELF_REMOVAL_AUDIT_LIMIT = 20;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function normalizeTraceSteps(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (isRecord(item) ? normalizeText(item.step) : null))
    .filter((item): item is string => Boolean(item));
}

export function buildGameSelfRemovalAuditEntry(
  params: Omit<GameSelfRemovalAuditEntry, "id" | "traceSteps"> & {
    trace?: unknown[];
  },
): GameSelfRemovalAuditEntry {
  const randomPart = Math.random().toString(36).slice(2, 10);
  return {
    id: `self_remove_${Date.now()}_${randomPart}`,
    at: params.at,
    gameId: params.gameId,
    source: params.source,
    actor: params.actor,
    playerId: params.playerId,
    playerPhone: params.playerPhone,
    playerName: params.playerName,
    status: params.status,
    verification: params.verification,
    bookingIds: Array.from(new Set(params.bookingIds.filter(Boolean))),
    traceSteps: normalizeTraceSteps(params.trace),
  };
}

export function appendGameSelfRemovalAuditLog(
  value: unknown,
  entry: GameSelfRemovalAuditEntry,
  limit = DEFAULT_GAME_SELF_REMOVAL_AUDIT_LIMIT,
): GameSelfRemovalAuditEntry[] {
  const current = Array.isArray(value)
    ? value.filter((item): item is GameSelfRemovalAuditEntry => isRecord(item) && normalizeText(item.id) !== null)
    : [];
  const cappedLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : DEFAULT_GAME_SELF_REMOVAL_AUDIT_LIMIT;
  return [...current, entry].slice(-cappedLimit);
}
