import type { PadelGameRecord } from "../../utils/apiClient";

export interface SplitOrdinaryPrice {
  totalAmount: number;
  shareAmount: number;
}

/**
 * `pending` — the lookup is in flight; `resolved` — an exact court price was
 * proven; `failed` — the lookup ran and returned no usable price (the legacy
 * stored share may be shown as a fallback); `unavailable` — the lookup could
 * not run at all (no session, incomplete contract), so no fallback is allowed.
 */
export type SplitOrdinaryPriceStatus = "pending" | "resolved" | "failed" | "unavailable";

export interface SplitOrdinaryPriceState {
  price: SplitOrdinaryPrice | null;
  status: SplitOrdinaryPriceStatus;
}

export interface SplitOrdinaryPriceParams {
  booking: PadelGameRecord["booking"] | null | undefined;
  metadata?: Record<string, unknown> | null;
  shareCount: number;
}

export const DEFAULT_SPLIT_SHARE_COUNT = 4;

function toPositiveNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string") {
    const parsed = Number(value.trim().replace(",", "."));
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

export function toSplitPositiveNumber(value: unknown): number | null {
  return toPositiveNumber(value);
}

function toNonNegativeNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === "string") {
    const parsed = Number(value.trim().replace(",", "."));
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return null;
}

function toTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeSplitIdList(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : (typeof value === "string" ? value.split(",") : []);
  return Array.from(new Set(
    raw
      .map((item) => toTrimmedString(item))
      .filter(Boolean),
  ));
}

export function normalizeSplitShareCount(value: unknown): number {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SPLIT_SHARE_COUNT;
}

export interface SplitOrdinaryPriceContract {
  date: string;
  fromTime: string;
  toTime: string;
  studioId: string;
  roomId: string;
  masterServiceId: string;
  subServiceIds: string[];
  shareCount: number;
}

/**
 * Resolves the exact Viva pricing contract for a stored game. Mirrors the server
 * guard in `Route Viva split payment`: without the stored station, room, slot
 * window, master service and sub-services the exact price cannot be proven, so
 * the contract resolves to `null` instead of falling back to a nominal amount.
 */
export function resolveSplitOrdinaryPriceContract(
  params: SplitOrdinaryPriceParams,
): SplitOrdinaryPriceContract | null {
  const booking = params.booking ?? null;
  const metadata = params.metadata ?? null;

  const date = toTrimmedString(booking?.date);
  const fromTime = toTrimmedString(booking?.timeFrom);
  const toTime = toTrimmedString(booking?.timeTo);
  const studioId = toTrimmedString(booking?.studioId);
  const roomId = toTrimmedString(booking?.roomId);
  const masterServiceId = toTrimmedString(booking?.masterServiceId)
    || toTrimmedString(metadata?.masterServiceId);
  const subServiceIds = normalizeSplitIdList(
    (booking?.subServiceIds && booking.subServiceIds.length > 0)
      ? booking.subServiceIds
      : metadata?.subServiceIds,
  );

  if (!date || !fromTime || !toTime || !studioId || !roomId) return null;
  if (!masterServiceId || subServiceIds.length === 0) return null;

  return {
    date,
    fromTime,
    toTime,
    studioId,
    roomId,
    masterServiceId,
    subServiceIds,
    shareCount: normalizeSplitShareCount(params.shareCount),
  };
}

/**
 * The stored split share is canonical only when the game carries the data the
 * server derived it from: the exact court total or a valid immutable
 * pricing-policy snapshot. Records without either may hold the legacy nominal
 * fallback (10 000 / share count) and must be re-priced against the exact Viva
 * court price.
 */
export function hasCanonicalSplitSharePrice(
  splitPayment: Record<string, unknown> | null | undefined,
): boolean {
  if (!splitPayment) return false;
  if (toPositiveNumber(splitPayment.totalAmount) !== null) return true;
  return isPricingPolicySnapshot(splitPayment.pricingPolicy);
}

function isPricingPolicySnapshot(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const policy = value as Record<string, unknown>;
  const id = toTrimmedString(policy.id) || toTrimmedString(policy.pricingPolicyId);
  const mode = toTrimmedString(policy.pricingMode) || toTrimmedString(policy.model);
  const currency = toTrimmedString(policy.currency).toUpperCase();
  const twoTeams = toNonNegativeNumber(policy.twoTeamsHourlyAmount);
  const fourPlayers = toNonNegativeNumber(policy.fourPlayersHourlyAmount);
  return Boolean(id)
    && mode === "PER_PARTICIPANT_HOUR"
    && currency === "RUB"
    && twoTeams !== null
    && fourPlayers !== null;
}

/**
 * Participant share count exactly as the join payload and the server coerce it:
 * an explicit two-player game stays doubles, everything else is a four-player
 * game, regardless of arbitrary stored values such as 3.
 */
export function resolveSplitJoinShareCount(shareCount: unknown, maxPlayers: number): 2 | 4 {
  const parsed = Math.floor(Number(shareCount));
  if (parsed === 2) return 2;
  const safeMaxPlayers = Math.floor(Number(maxPlayers));
  // An unknown capacity is not a singles game: the server defaults to four.
  return Number.isFinite(safeMaxPlayers) && safeMaxPlayers > 0 && safeMaxPlayers <= 2 ? 2 : 4;
}

export function buildSplitOrdinaryPrice(
  exactCourtPrice: unknown,
  shareCount: unknown,
): SplitOrdinaryPrice | null {
  const totalAmount = toPositiveNumber(exactCourtPrice);
  if (totalAmount === null) return null;
  const roundedTotal = Math.round(totalAmount * 100) / 100;
  return {
    totalAmount: roundedTotal,
    shareAmount: Math.round(roundedTotal / normalizeSplitShareCount(shareCount) * 100) / 100,
  };
}

/**
 * Shared precedence for every split join surface:
 * campaign price -> exact ordinary court share -> canonical stored share ->
 * stored share only when the exact-price lookup actually ran and returned no
 * price. A pending, impossible or unauthorized lookup never re-quotes the
 * nominal fallback.
 */
export function resolveSplitDisplayShareAmount(params: {
  promoShareAmount: number | null;
  ordinaryShareAmount: number | null;
  ordinaryStatus: SplitOrdinaryPriceStatus;
  storedShareAmount: number | null;
  storedIsCanonical: boolean;
}): number | null {
  const promo = toPositiveNumber(params.promoShareAmount);
  if (promo !== null) return promo;
  const ordinary = toPositiveNumber(params.ordinaryShareAmount);
  if (ordinary !== null) return ordinary;
  const stored = toPositiveNumber(params.storedShareAmount);
  if (params.storedIsCanonical) return stored;
  return params.ordinaryStatus === "failed" ? stored : null;
}
