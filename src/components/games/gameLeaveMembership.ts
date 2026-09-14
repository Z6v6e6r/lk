import { isInactiveSplitPaymentReservationStatus } from "./splitPaymentOccupancy.ts";

type Row = Record<string, unknown>;
export type GameLeaveIdentity = { id?: string | null; phone?: string | null };

function rows(value: unknown): Row[] {
  return Array.isArray(value)
    ? value.filter((item): item is Row => Boolean(item) && typeof item === "object")
    : [];
}

function id(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" ? value.trim().toLowerCase() || null : null;
}

function phone(value: unknown): string | null {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits || null;
}

function matches(row: Row, identity: GameLeaveIdentity): boolean {
  const actorId = id(identity.id);
  const rowId = id(row.clientId || row.playerId || row.userId || row.id);
  // Match the authenticated server leave rule: a conflicting ID cannot match by phone.
  if (actorId && rowId) return actorId === rowId;
  const actorPhone = phone(identity.phone);
  return Boolean(actorPhone && [row.phoneNorm, row.phone, row.mobile, row.clientPhoneNorm, row.clientPhone]
    .some((value) => phone(value) === actorPhone));
}

function active(row: Row): boolean {
  return !isInactiveSplitPaymentReservationStatus(row.status);
}

export function findActiveSplitPaymentForLeave(
  payments: unknown,
  identity: GameLeaveIdentity,
): Row | null {
  // A passed payment deadline is not confirmation that server membership was removed.
  return rows(payments).find((row) => active(row) && matches(row, identity)) ?? null;
}

export function hasActiveGameLeaveMembership(
  game: { participants?: unknown; waitlist?: unknown; metadata?: Row | null },
  identity: GameLeaveIdentity,
): boolean {
  const split = game.metadata?.splitPayment as Row | undefined;
  return [...rows(game.participants), ...rows(game.waitlist)]
    .some((row) => active(row) && matches(row, identity))
    || Boolean(findActiveSplitPaymentForLeave(split?.payments, identity));
}
