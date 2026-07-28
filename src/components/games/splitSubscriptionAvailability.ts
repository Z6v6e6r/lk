import type { ApiError, Subscription } from "../../utils/apiClient";

export type SplitSubscriptionCandidate = Pick<
  Subscription,
  "subscriptionId" | "name" | "status" | "expirationDate" | "visitsLeft" | "availableMinutes"
>;

export type SplitSubscriptionCategoryCandidate = Pick<
  Subscription,
  | "subscriptionId"
  | "hasStudioLimitation"
  | "availableStudios"
  | "hasTypeLimitation"
  | "availableTypes"
>;

function trimText(value: string | null | undefined): string | null {
  const text = String(value || "").trim();
  return text ? text : null;
}

function toDateKey(value: string | null | undefined): string | null {
  const text = trimText(value);
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) {
    return text.slice(0, 10);
  }

  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) return null;
  const date = new Date(parsed);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeComparableId(value: string | number | null | undefined): string | null {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized || null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  return null;
}

function normalizeComparableName(value: string | null | undefined): string | null {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized || null;
}

function hasIdIntersection(left: Set<string>, right: Set<string>): boolean {
  for (const value of left) {
    if (right.has(value)) return true;
  }
  return false;
}

function subscriptionMatchesSplitStudio(
  subscription: SplitSubscriptionCategoryCandidate,
  selectedStudioId: string | null | undefined,
): boolean {
  if (!subscription.hasStudioLimitation) return true;

  const allowedStudios = new Set(
    (subscription.availableStudios || [])
      .map((item) => normalizeComparableId(item?.id))
      .filter((value): value is string => Boolean(value)),
  );
  if (allowedStudios.size === 0) return false;

  const normalizedSelectedStudioId = normalizeComparableId(selectedStudioId);
  if (!normalizedSelectedStudioId) return true;

  return allowedStudios.has(normalizedSelectedStudioId);
}

function subscriptionMatchesSplitCategory(
  subscription: SplitSubscriptionCategoryCandidate,
  requiredExerciseTypeIds: Set<string>,
  requiredDirectionIds: Set<string>,
  selectedStudioId: string | null | undefined,
): boolean {
  if (!subscriptionMatchesSplitStudio(subscription, selectedStudioId)) {
    return false;
  }

  const allowedTypes = new Set(
    (subscription.availableTypes || [])
      .map((item) => normalizeComparableId(item?.id))
      .filter((value): value is string => Boolean(value)),
  );
  const hasOpenGameTypeByName = (subscription.availableTypes || []).some((item) => {
    const normalizedName = normalizeComparableName(item?.name);
    return Boolean(normalizedName && normalizedName.includes("открытая игра"));
  });

  if (!subscription.hasTypeLimitation) {
    return false;
  }
  if (!hasIdIntersection(allowedTypes, requiredExerciseTypeIds) && !hasOpenGameTypeByName) {
    return false;
  }

  void requiredDirectionIds;
  return true;
}

export function buildSplitComparableIdSet(values: Array<string | number | null | undefined>): Set<string> {
  return new Set(
    values
      .map((value) => normalizeComparableId(value))
      .filter((value): value is string => Boolean(value)),
  );
}

export function filterSplitCategoryCompatibleSubscriptions<T extends SplitSubscriptionCategoryCandidate>(
  subscriptions: T[],
  requiredExerciseTypeIds: Set<string>,
  requiredDirectionIds: Set<string>,
  selectedStudioId: string | null | undefined,
): T[] {
  return subscriptions.filter((subscription) => subscriptionMatchesSplitCategory(
    subscription,
    requiredExerciseTypeIds,
    requiredDirectionIds,
    selectedStudioId,
  ));
}

export function filterSplitEligibleSubscriptions<T extends SplitSubscriptionCandidate & SplitSubscriptionCategoryCandidate>(
  subscriptions: T[],
  requiredExerciseTypeIds: Set<string>,
  requiredDirectionIds: Set<string>,
  selectedStudioId: string | null | undefined,
  requiredVisits: number,
  requiredDurationMinutes: number | null | undefined,
  gameDate: string | null | undefined,
): T[] {
  return filterSplitCategoryCompatibleSubscriptions(
    subscriptions,
    requiredExerciseTypeIds,
    requiredDirectionIds,
    selectedStudioId,
  ).filter((subscription) => {
    if (!isSplitSubscriptionStatusActive(subscription.status)) return false;
    if (!hasSplitSubscriptionBalance(subscription, requiredVisits, requiredDurationMinutes)) return false;
    return isSplitSubscriptionValidForGameDate(subscription, gameDate);
  });
}

function formatDateLabel(value: string | null | undefined): string | null {
  const dateKey = toDateKey(value);
  if (!dateKey) return null;
  const parsed = new Date(`${dateKey}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleDateString("ru-RU");
}

function isSplitSubscriptionStatusActive(statusRaw: unknown): boolean {
  const status = String(statusRaw || "").trim().toUpperCase();
  if (!status) return true;
  const blockedMarkers = [
    "EXPIRED",
    "CANCEL",
    "BLOCK",
    "ARCHIVE",
    "INACTIVE",
    "SUSPEND",
    "FINISH",
    "TERMINAT",
    "ENDED",
    "ЗАВЕРШ",
    "ОТМЕН",
    "ПРОСРОЧ",
  ];
  return !blockedMarkers.some((marker) => status.includes(marker));
}

function hasSplitSubscriptionBalance(
  subscription: Pick<Subscription, "visitsLeft" | "availableMinutes">,
  requiredVisits: number,
  requiredDurationMinutes: number | null | undefined,
): boolean {
  const normalizedRequiredVisits = Math.max(1, Math.floor(requiredVisits || 1));
  const normalizedRequiredMinutes = Number.isFinite(requiredDurationMinutes)
    ? Math.max(1, Math.floor(Number(requiredDurationMinutes)))
    : null;
  const hasVisitsValue = Number.isFinite(subscription.visitsLeft);
  const hasMinutesValue = Number.isFinite(subscription.availableMinutes);
  const visitsLeft = hasVisitsValue ? subscription.visitsLeft : null;
  const minutesLeft = hasMinutesValue ? subscription.availableMinutes : null;

  if (visitsLeft != null) return visitsLeft >= normalizedRequiredVisits;
  if (minutesLeft != null) {
    if (normalizedRequiredMinutes != null) return minutesLeft >= normalizedRequiredMinutes;
    return minutesLeft > 0;
  }

  return true;
}

export function isSplitSubscriptionValidForGameDate(
  subscription: Pick<Subscription, "expirationDate">,
  gameDate: string | null | undefined,
): boolean {
  const gameDateKey = toDateKey(gameDate);
  if (!gameDateKey) return true;
  const expirationKey = toDateKey(subscription.expirationDate);
  if (!expirationKey) return false;
  return expirationKey >= gameDateKey;
}

function findLatestEligibleSplitSubscription(
  subscriptions: SplitSubscriptionCandidate[],
  gameDate: string | null | undefined,
  requiredVisits: number,
  requiredDurationMinutes: number | null | undefined,
): SplitSubscriptionCandidate | null {
  const eligible = subscriptions
    .filter((subscription) => isSplitSubscriptionStatusActive(subscription.status))
    .filter((subscription) => hasSplitSubscriptionBalance(subscription, requiredVisits, requiredDurationMinutes));

  if (eligible.length === 0) return null;

  const gameDateKey = toDateKey(gameDate);
  const coveredByDate = gameDateKey
    ? eligible.filter((subscription) => isSplitSubscriptionValidForGameDate(subscription, gameDate))
    : eligible;
  const pool = coveredByDate.length > 0 ? coveredByDate : eligible;

  return [...pool].sort((left, right) => {
    const leftKey = toDateKey(left.expirationDate) || "";
    const rightKey = toDateKey(right.expirationDate) || "";
    return rightKey.localeCompare(leftKey);
  })[0] ?? null;
}

export function resolveSplitSubscriptionUnavailableMessage(params: {
  subscriptions: SplitSubscriptionCandidate[];
  gameDate: string | null | undefined;
  requiredVisits: number;
  requiredDurationMinutes: number | null | undefined;
}): string | null {
  const fallback = findLatestEligibleSplitSubscription(
    params.subscriptions,
    params.gameDate,
    params.requiredVisits,
    params.requiredDurationMinutes,
  );

  if (!fallback) {
    return "Вы не можете вступить в данную игру: для этой даты нет подходящего абонемента.";
  }

  if (isSplitSubscriptionValidForGameDate(fallback, params.gameDate)) {
    return null;
  }

  const subscriptionUntil = formatDateLabel(fallback.expirationDate);
  const gameDateLabel = formatDateLabel(params.gameDate);
  if (subscriptionUntil && gameDateLabel) {
    return `Вы не можете вступить в данную игру: ваша подписка действует до ${subscriptionUntil}, а игра запланирована на ${gameDateLabel}.`;
  }
  if (subscriptionUntil) {
    return `Вы не можете вступить в данную игру: ваша подписка действует до ${subscriptionUntil}.`;
  }
  return "Вы не можете вступить в данную игру: для этой даты нет подходящего абонемента.";
}

export function isNoSubscriptionsAvailableError(error: ApiError | null | undefined): boolean {
  if (!error) return false;

  const raw = error.raw;
  if (raw && typeof raw === "object") {
    const anyRaw = raw as Record<string, unknown>;
    const rawMessage = trimText(anyRaw.message as string | null | undefined);
    if (rawMessage && /No subscriptions available/i.test(rawMessage)) {
      return true;
    }
    const rawError = trimText(anyRaw.error as string | null | undefined);
    if (rawError && /No subscriptions available/i.test(rawError)) {
      return true;
    }
    const details = anyRaw.details;
    if (details && typeof details === "object") {
      const detailsMessage = trimText((details as Record<string, unknown>).message as string | null | undefined);
      if (detailsMessage && /No subscriptions available/i.test(detailsMessage)) {
        return true;
      }
    }
  }

  return error.status === 400 && /subscription/i.test(error.message);
}
