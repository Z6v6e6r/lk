import { IS_DEV_RELEASE_CHANNEL, PUBLIC_INVITE_ORIGIN } from "../consts/api_config";
import type { Subscription } from "./apiClient";

export type ReferralSubscriptionPlanKey = "academy" | "friendship" | "ra" | "sport";
export type ReferralSubscriptionFlowType = "share" | "renewal";

export interface ReferralSubscriptionWindow {
  expirationDate: string;
  referralActiveEndsAt: string;
  renewalWindowStartsAt: string;
  renewalWindowEndsAt: string;
}

export interface ReferralOwnerCandidate extends ReferralSubscriptionWindow {
  subscriptionId: string;
  subscriptionName: string;
  planKey: ReferralSubscriptionPlanKey;
  ownerCycleKey: string;
  renewalWindowActive: boolean;
}

interface ReferralOwnerCandidateOptions {
  allowInactiveDuringRenewalWindow?: boolean;
}

const REFERRAL_PAGE_PATH = "/ab_leto_referral";
const REFERRAL_STORAGE_KEY_PREFIX = "padlhub.referral-window.v1";
const DAY_MS = 24 * 60 * 60 * 1000;
const MOSCOW_UTC_OFFSET = "+03:00";
const REFERRAL_DEV_PILOT_PHONES = new Set([
  "79104303190",
  "79266057141",
  "79603075826",
  "79998009669",
  "79261475290",
  "79035107512",
]);

function trimText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

export function normalizeReferralPhone(value: unknown): string | null {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits.length >= 11 ? digits : null;
}

function normalizeDateOnly(value: unknown): string | null {
  const text = trimText(value);
  if (!text) return null;
  const matched = text.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!matched) return null;
  return `${matched[1]}-${matched[2]}-${matched[3]}`;
}

function normalizePlanKeyFromName(value: unknown): ReferralSubscriptionPlanKey | null {
  const raw = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/ё/g, "е");
  if (!raw) return null;
  if (raw.includes("друж")) return "friendship";
  if (raw.includes("спорт")) return "sport";
  if (raw.includes("академ")) return "academy";
  if (raw.includes(" ра") || raw.endsWith("ра") || raw.includes("лето.падел.ра")) return "ra";
  return null;
}

function buildOwnerCycleKey(subscriptionId: string, expirationDate: string): string {
  return `${subscriptionId}:${expirationDate}`;
}

export function resolveReferralSubscriptionWindow(
  expirationDateValue: unknown,
): ReferralSubscriptionWindow | null {
  const expirationDate = normalizeDateOnly(expirationDateValue);
  if (!expirationDate) return null;

  const expirationDayStartsAt = `${expirationDate}T00:00:00${MOSCOW_UTC_OFFSET}`;
  const expirationDayStartTs = Date.parse(expirationDayStartsAt);
  if (!Number.isFinite(expirationDayStartTs)) return null;

  return {
    expirationDate,
    referralActiveEndsAt: new Date(expirationDayStartTs + DAY_MS).toISOString(),
    renewalWindowStartsAt: new Date(expirationDayStartTs - DAY_MS).toISOString(),
    renewalWindowEndsAt: new Date(expirationDayStartTs + 4 * DAY_MS).toISOString(),
  };
}

function isRangeActive(startIso: string | null | undefined, endIso: string | null | undefined, nowMs: number): boolean {
  const startTs = startIso ? Date.parse(startIso) : NaN;
  const endTs = endIso ? Date.parse(endIso) : NaN;
  if (!Number.isFinite(startTs) || !Number.isFinite(endTs)) return false;
  return nowMs >= startTs && nowMs < endTs;
}

function isReferralStillActive(window: ReferralSubscriptionWindow, nowMs: number): boolean {
  const endTs = Date.parse(window.renewalWindowEndsAt);
  if (!Number.isFinite(endTs)) return false;
  return nowMs < endTs;
}

function isSubscriptionStatusActive(value: unknown): boolean {
  return String(value || "").trim().toUpperCase() === "ACTIVE";
}

function buildOwnerCandidateFromSubscription(
  subscription: Pick<Subscription, "expirationDate" | "name" | "status" | "subscriptionId">,
  nowMs: number,
  options?: ReferralOwnerCandidateOptions,
): ReferralOwnerCandidate | null {
  const subscriptionId = trimText(subscription.subscriptionId);
  const subscriptionName = trimText(subscription.name);
  if (!subscriptionId || !subscriptionName) return null;

  const planKey = normalizePlanKeyFromName(subscriptionName);
  const window = resolveReferralSubscriptionWindow(subscription.expirationDate);
  if (!planKey || !window) return null;
  if (!isReferralStillActive(window, nowMs)) return null;

  const renewalWindowActive = isRangeActive(window.renewalWindowStartsAt, window.renewalWindowEndsAt, nowMs);
  if (!isSubscriptionStatusActive(subscription.status) && !(options?.allowInactiveDuringRenewalWindow && renewalWindowActive)) {
    return null;
  }

  return {
    subscriptionId,
    subscriptionName,
    planKey,
    ownerCycleKey: buildOwnerCycleKey(subscriptionId, window.expirationDate),
    renewalWindowActive,
    ...window,
  };
}

function compareCandidates(left: ReferralOwnerCandidate, right: ReferralOwnerCandidate): number {
  const leftEndsAt = Date.parse(left.referralActiveEndsAt);
  const rightEndsAt = Date.parse(right.referralActiveEndsAt);
  if (Number.isFinite(leftEndsAt) && Number.isFinite(rightEndsAt) && leftEndsAt !== rightEndsAt) {
    return leftEndsAt - rightEndsAt;
  }
  return left.subscriptionId.localeCompare(right.subscriptionId);
}

function getStorageKey(phone: string): string {
  return `${REFERRAL_STORAGE_KEY_PREFIX}.${phone}`;
}

function isReferralDevPilotPhone(phone: string | null | undefined): boolean {
  const normalizedPhone = normalizeReferralPhone(phone);
  if (!normalizedPhone) return false;
  return REFERRAL_DEV_PILOT_PHONES.has(normalizedPhone);
}

function readStoredOwnerCandidate(phone: string, nowMs: number): ReferralOwnerCandidate | null {
  if (typeof window === "undefined") return null;

  try {
    const raw = window.localStorage.getItem(getStorageKey(phone));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ReferralOwnerCandidate> | null;
    if (!parsed || typeof parsed !== "object") return null;

    const candidate = {
      subscriptionId: trimText(parsed.subscriptionId),
      subscriptionName: trimText(parsed.subscriptionName),
      planKey: normalizePlanKeyFromName(parsed.planKey || parsed.subscriptionName),
      expirationDate: normalizeDateOnly(parsed.expirationDate),
      ownerCycleKey: trimText(parsed.ownerCycleKey),
      referralActiveEndsAt: trimText(parsed.referralActiveEndsAt),
      renewalWindowStartsAt: trimText(parsed.renewalWindowStartsAt),
      renewalWindowEndsAt: trimText(parsed.renewalWindowEndsAt),
    };

    if (!candidate.ownerCycleKey && candidate.subscriptionId && candidate.expirationDate) {
      candidate.ownerCycleKey = buildOwnerCycleKey(candidate.subscriptionId, candidate.expirationDate);
    }

    if (
      !candidate.subscriptionId
      || !candidate.subscriptionName
      || !candidate.planKey
      || !candidate.ownerCycleKey
      || !candidate.expirationDate
      || !candidate.referralActiveEndsAt
      || !candidate.renewalWindowStartsAt
      || !candidate.renewalWindowEndsAt
    ) {
      return null;
    }

    const normalized: ReferralOwnerCandidate = {
      subscriptionId: candidate.subscriptionId,
      subscriptionName: candidate.subscriptionName,
      planKey: candidate.planKey,
      ownerCycleKey: candidate.ownerCycleKey,
      expirationDate: candidate.expirationDate,
      referralActiveEndsAt: candidate.referralActiveEndsAt,
      renewalWindowStartsAt: candidate.renewalWindowStartsAt,
      renewalWindowEndsAt: candidate.renewalWindowEndsAt,
      renewalWindowActive: isRangeActive(candidate.renewalWindowStartsAt, candidate.renewalWindowEndsAt, nowMs),
    };

    return isReferralStillActive(normalized, nowMs) ? normalized : null;
  } catch {
    return null;
  }
}

function writeStoredOwnerCandidate(phone: string, candidate: ReferralOwnerCandidate | null) {
  if (typeof window === "undefined") return;

  try {
    if (!candidate) {
      window.localStorage.removeItem(getStorageKey(phone));
      return;
    }
    window.localStorage.setItem(getStorageKey(phone), JSON.stringify(candidate));
  } catch {
    // Ignore storage errors.
  }
}

export function resolveReferralOwnerCandidate(
  subscriptions: Subscription[] | null | undefined,
  ownerPhone: string | null | undefined,
  nowMs = Date.now(),
): ReferralOwnerCandidate | null {
  const normalizedPhone = normalizeReferralPhone(ownerPhone);
  if (IS_DEV_RELEASE_CHANNEL && normalizedPhone && !isReferralDevPilotPhone(normalizedPhone)) {
    writeStoredOwnerCandidate(normalizedPhone, null);
    return null;
  }

  const nextCandidates = (subscriptions || [])
    .map((subscription) => buildOwnerCandidateFromSubscription(subscription, nowMs))
    .filter((candidate): candidate is ReferralOwnerCandidate => Boolean(candidate))
    .sort(compareCandidates);

  const computedCandidate = nextCandidates[0] || null;
  if (!normalizedPhone) {
    return computedCandidate;
  }

  if (computedCandidate) {
    writeStoredOwnerCandidate(normalizedPhone, computedCandidate);
    return computedCandidate;
  }

  const storedCandidate = readStoredOwnerCandidate(normalizedPhone, nowMs);
  if (storedCandidate) {
    return storedCandidate;
  }

  writeStoredOwnerCandidate(normalizedPhone, null);
  return null;
}

function resolveReferralOwnerCandidates(
  subscriptions: Subscription[] | null | undefined,
  ownerPhone: string | null | undefined,
  nowMs: number,
  options?: ReferralOwnerCandidateOptions,
): ReferralOwnerCandidate[] {
  const normalizedPhone = normalizeReferralPhone(ownerPhone);
  if (IS_DEV_RELEASE_CHANNEL && normalizedPhone && !isReferralDevPilotPhone(normalizedPhone)) {
    writeStoredOwnerCandidate(normalizedPhone, null);
    return [];
  }

  const nextCandidates = (subscriptions || [])
    .map((subscription) => buildOwnerCandidateFromSubscription(subscription, nowMs, options))
    .filter((candidate): candidate is ReferralOwnerCandidate => Boolean(candidate))
    .sort(compareCandidates);

  if (!normalizedPhone) {
    return nextCandidates;
  }

  if (nextCandidates.length > 0) {
    writeStoredOwnerCandidate(normalizedPhone, nextCandidates[0]);
    return nextCandidates;
  }

  const storedCandidate = readStoredOwnerCandidate(normalizedPhone, nowMs);
  if (storedCandidate) {
    return [storedCandidate];
  }

  writeStoredOwnerCandidate(normalizedPhone, null);
  return [];
}

export function hydrateReferralSubscriptionsWithNames(
  subscriptions: Subscription[] | null | undefined,
  namesById: Record<string, string> | null | undefined,
): Subscription[] {
  if (!Array.isArray(subscriptions) || subscriptions.length === 0) return [];

  return subscriptions.map((subscription) => {
    if (trimText(subscription.name)) return subscription;

    const subscriptionId = trimText(subscription.subscriptionId);
    const resolvedName = subscriptionId ? trimText(namesById?.[subscriptionId]) : null;
    if (!resolvedName) return subscription;

    return {
      ...subscription,
      name: resolvedName,
    };
  });
}

export function resolveReferralShareOwnerCandidate(
  subscriptions: Subscription[] | null | undefined,
  ownerPhone: string | null | undefined,
  nowMs = Date.now(),
): ReferralOwnerCandidate | null {
  return resolveReferralOwnerCandidate(subscriptions, ownerPhone, nowMs);
}

export function resolveReferralRenewalOwnerCandidate(
  subscriptions: Subscription[] | null | undefined,
  ownerPhone: string | null | undefined,
  nowMs = Date.now(),
): ReferralOwnerCandidate | null {
  const candidates = resolveReferralOwnerCandidates(subscriptions, ownerPhone, nowMs, {
    allowInactiveDuringRenewalWindow: true,
  });
  return candidates.find((candidate) => candidate.renewalWindowActive) || null;
}

export function formatReferralCountdownLabel(targetIso: string | null | undefined, nowMs = Date.now()): string {
  const targetTs = trimText(targetIso) ? Date.parse(String(targetIso)) : NaN;
  if (!Number.isFinite(targetTs)) return "00:00:00";

  const diffMs = Math.max(targetTs - nowMs, 0);
  const totalSeconds = Math.floor(diffMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return [
    String(hours).padStart(2, "0"),
    String(minutes).padStart(2, "0"),
    String(seconds).padStart(2, "0"),
  ].join(":");
}

export function buildReferralSubscriptionUrl(
  inviteId: string | null | undefined,
  mode: ReferralSubscriptionFlowType = "share",
  fallbackOwner?: {
    ownerPhone?: string | null | undefined;
    ownerSubscriptionId?: string | null | undefined;
  } | null,
): string | null {
  const normalizedInviteId = trimText(inviteId);
  if (!normalizedInviteId) return null;
  const url = new URL(REFERRAL_PAGE_PATH, PUBLIC_INVITE_ORIGIN);
  url.searchParams.set("inviteId", normalizedInviteId);
  url.searchParams.set("mode", mode);
  if (IS_DEV_RELEASE_CHANNEL) {
    const normalizedOwnerPhone = normalizeReferralPhone(fallbackOwner?.ownerPhone);
    const normalizedOwnerSubscriptionId = trimText(fallbackOwner?.ownerSubscriptionId);
    if (normalizedOwnerPhone && normalizedOwnerSubscriptionId) {
      url.searchParams.set("ownerPhone", normalizedOwnerPhone);
      url.searchParams.set("ownerSubscriptionId", normalizedOwnerSubscriptionId);
    }
    url.searchParams.set("channel", "dev");
  }
  return url.toString();
}
