import type { PadelGamePlayer } from "../../utils/apiClient";

export const RECENT_PAID_GAME_STABILITY_WINDOW_MS = 30_000;

type RecentGameRecordLike = {
  createdAt?: string | null;
  createdByFlow?: boolean | null;
  status?: string | null;
  payment?: {
    paid?: boolean | null;
    paymentUrl?: string | null;
  } | null;
  metadata?: {
    lastLeaveUpdateAt?: string | null;
  } | null;
};

function normalizePhone(value: string | null | undefined): string | null {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits;
}

function hasPaidState(record: RecentGameRecordLike | null | undefined): boolean {
  const status = String(record?.status || "").trim().toUpperCase();
  return record?.payment?.paid === true || status.includes("PAID") || status.includes("PAYED");
}

function hasPaymentRedirect(record: RecentGameRecordLike | null | undefined): boolean {
  return typeof record?.payment?.paymentUrl === "string" && record.payment.paymentUrl.trim().length > 0;
}

function isRecentFlowCreatedRecord(
  record: RecentGameRecordLike | null | undefined,
  nowTs: number,
  maxAgeMs: number,
): boolean {
  if (!record?.createdByFlow) return false;
  const createdAtTs = Date.parse(String(record.createdAt || ""));
  if (!Number.isFinite(createdAtTs)) return false;
  return nowTs - createdAtTs >= 0 && nowTs - createdAtTs <= maxAgeMs;
}

function hasRecentLeaveUpdate(
  record: RecentGameRecordLike | null | undefined,
  nowTs: number,
  maxAgeMs: number,
): boolean {
  const leaveUpdatedAt = Date.parse(String(record?.metadata?.lastLeaveUpdateAt || ""));
  if (!Number.isFinite(leaveUpdatedAt)) return false;
  return nowTs - leaveUpdatedAt >= 0 && nowTs - leaveUpdatedAt <= maxAgeMs;
}

export function shouldSkipRecentPaidGameBackgroundSync(
  record: RecentGameRecordLike | null | undefined,
  nowTs = Date.now(),
  maxAgeMs = RECENT_PAID_GAME_STABILITY_WINDOW_MS,
): boolean {
  if (!isRecentFlowCreatedRecord(record, nowTs, maxAgeMs)) return false;
  if (!hasPaidState(record)) return false;
  if (hasPaymentRedirect(record)) return false;
  return true;
}

export function shouldSkipRecentSplitGameRosterSync(params: {
  record: RecentGameRecordLike | null | undefined;
  isSplitPaymentGame: boolean;
  sourceParticipantsCount: number;
  leaveEventsCount: number;
  nowTs?: number;
  maxAgeMs?: number;
}): boolean {
  if (!params.isSplitPaymentGame) return false;
  if (params.sourceParticipantsCount <= 0) return false;
  if (hasRecentLeaveUpdate(params.record, params.nowTs ?? Date.now(), params.maxAgeMs ?? RECENT_PAID_GAME_STABILITY_WINDOW_MS)) {
    return true;
  }
  if (params.leaveEventsCount > 0) return false;
  return shouldSkipRecentPaidGameBackgroundSync(
    params.record,
    params.nowTs,
    params.maxAgeMs,
  );
}

export function buildGameAllRelatedPhones(params: {
  organizerPhone?: string | null;
  participants?: PadelGamePlayer[];
  waitlist?: PadelGamePlayer[];
  splitPaymentPhones?: Array<string | null | undefined>;
}): string[] {
  return Array.from(new Set([
    normalizePhone(params.organizerPhone),
    ...(params.participants ?? []).map((player) => normalizePhone(player.phone)),
    ...(params.waitlist ?? []).map((player) => normalizePhone(player.phone)),
    ...(params.splitPaymentPhones ?? []).map((value) => normalizePhone(value)),
  ].filter((value): value is string => Boolean(value))));
}
