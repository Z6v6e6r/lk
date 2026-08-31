import type { ApiError, PadelSplitPaymentResult } from "./apiClient";
import {
  hasDeterministicSubscriptionDecision,
  readSubscriptionDecisionResultState,
} from "./subscriptionDecisionContract.ts";

export type SubscriptionDecisionAction = "CREATE_GAME" | "JOIN_GAME";

export type SubscriptionDecisionKind =
  | "SUBSCRIPTION_ALLOWED"
  | "LIMIT_USED"
  | "ADDITIONAL_PAYMENT_REQUIRED"
  | "SUBSCRIPTION_INVALID"
  | "ACTION_UNAVAILABLE"
  | "STALE_STATE"
  | "PENDING_CONFIRMATION"
  | "TECHNICAL_ERROR"
  | "ORDINARY_PAYMENT_ALLOWED";

export interface SubscriptionDecisionPresentation {
  kind: SubscriptionDecisionKind;
  title: string;
  message: string;
  reasonCode: string;
  retryable: boolean;
  subscriptionApplied: boolean;
  continueWithoutSubscription: boolean;
}

export function formatSubscriptionDecisionPresentation(
  presentation: SubscriptionDecisionPresentation,
): string {
  const title = presentation.title.replace(/[.!?]+$/, "");
  const message = presentation.message.trim();
  return message.toLocaleLowerCase("ru-RU").startsWith(title.toLocaleLowerCase("ru-RU"))
    ? message
    : `${title}. ${message}`;
}

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord => (
  Boolean(value) && typeof value === "object" && !Array.isArray(value)
);

const toText = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
};

const CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,120}$/;

export function collectSubscriptionDecisionCodes(
  value: unknown,
  seen = new Set<unknown>(),
): string[] {
  if (value === null || value === undefined || seen.has(value)) return [];
  const text = toText(value);
  if (!isRecord(value) && !Array.isArray(value)) {
    return text && CODE_PATTERN.test(text) ? [text] : [];
  }

  seen.add(value);
  if (Array.isArray(value)) {
    return Array.from(new Set(value.flatMap((item) => collectSubscriptionDecisionCodes(item, seen))));
  }

  const result: string[] = [];
  for (const key of ["code", "state", "reasonCode", "reasonCodes"]) {
    result.push(...collectSubscriptionDecisionCodes(value[key], seen));
  }
  for (const key of ["details", "raw", "error", "blockers", "decision", "bookingOutcome"]) {
    result.push(...collectSubscriptionDecisionCodes(value[key], seen));
  }
  return Array.from(new Set(result));
}

const includesCode = (codes: string[], candidates: ReadonlySet<string>) => (
  codes.some((code) => candidates.has(code))
);

const LIMIT_CODES = new Set([
  "ACTIVE_SERVICES_LIMIT_REACHED",
  "DAILY_USAGE_LIMIT_REACHED",
  "SUBSCRIPTION_DAILY_LIMIT_REACHED",
  "SUBSCRIPTION_CATEGORY_DAILY_LIMIT_REACHED",
  "SUBSCRIPTION_LIMIT_REACHED",
  "WEEKLY_USAGE_LIMIT_REACHED",
  "MONTHLY_USAGE_LIMIT_REACHED",
]);

const INVALID_SUBSCRIPTION_CODES = new Set([
  "SUBSCRIPTION_EXPIRED",
  "TARGET_AFTER_SUBSCRIPTION_EXPIRY",
  "SUBSCRIPTION_NOT_ACTIVE",
  "SUBSCRIPTION_INSTANCE_INVALID",
  "SUBSCRIPTION_VALIDITY_INVALID",
  "SUBSCRIPTION_TYPE_MISMATCH",
  "SUBSCRIPTION_FROZEN",
  "SUBSCRIPTION_CANCELLED",
  "SUBSCRIPTION_REFUNDED",
  "SUBSCRIPTION_REVOKED",
  "SUBSCRIPTION_SELECTION_REQUIRED",
  "SUBSCRIPTION_NOT_OWNED_OR_UNAVAILABLE",
  "MANAGED_SUBSCRIPTION_INSTANCE_NOT_FOUND",
  "MANAGED_SUBSCRIPTION_PRODUCT_MAPPING_REQUIRED",
  "MANAGED_SUBSCRIPTION_PLAN_NOT_ACTIVATED",
  "LEGACY_SUBSCRIPTION_BINDING_MISSING",
  "NO_SUBSCRIPTIONS_AVAILABLE",
]);

const STALE_CODES = new Set([
  "STALE_STATE",
  "STALE_REVISION",
  "REVISION_CONFLICT",
  "SLOT_STALE",
  "SLOT_UNAVAILABLE",
  "GAME_STATE_CHANGED",
  "SUBSCRIPTION_CONTEXT_CHANGED",
  "MANAGED_SUBSCRIPTION_CONTEXT_CHANGED",
  "SUBSCRIPTION_ELIGIBILITY_CHANGED_BEFORE_WRITE",
  "SUBSCRIPTION_PRODUCT_IDENTITY_CHANGED_BEFORE_WRITE",
  "MANAGED_SUBSCRIPTION_ENFORCEMENT_CHANGED_BEFORE_WRITE",
  "MANAGED_SUBSCRIPTION_RUNTIME_CHANGED_BEFORE_WRITE",
]);

const ACTION_UNAVAILABLE_CODES = new Set([
  "ALREADY_JOINED",
  "GAME_ALREADY_JOINED",
  "GAME_FULL",
  "CAPACITY_FULL",
  "DURATION_NOT_ALLOWED",
  "SUBSCRIPTION_CREATE_DISABLED",
  "SUBSCRIPTION_JOIN_DISABLED",
  "BOOKING_WINDOW_EXCEEDED",
  "STATION_NOT_ALLOWED",
  "EVENT_NOT_INCLUDED",
  "SUBSCRIPTION_CATEGORY_NOT_ALLOWED",
  "MANAGED_SUBSCRIPTION_BENEFIT_NOT_APPLICABLE",
  "SUBSCRIPTION_BLACKOUT_DATE",
  "SUBSCRIPTION_NO_SHOW_BLOCKED",
]);

const PENDING_CODES = new Set([
  "PENDING_CONFIRMATION",
  "SUBSCRIPTION_ENTITLEMENT_CONFIRMATION_PENDING",
  "SPLIT_BOOKING_RECONCILIATION_REQUIRED",
  "SUBSCRIPTION_ENTITLEMENT_BIND_PENDING",
  "SUBSCRIPTION_ENTITLEMENT_CONFIRM_BIND_PENDING",
  "SUBSCRIPTION_ENTITLEMENT_CONFIRM_PENDING",
  "SUBSCRIPTION_BOOKING_CONFIRMED_RECONCILIATION_REQUIRED",
  "SUBSCRIPTION_ENTITLEMENT_CONFIRMED_RECONCILIATION_REQUIRED",
  "SUBSCRIPTION_FULL_PRICE_FALLBACK_PENDING",
]);

const TECHNICAL_CODES = new Set([
  "MANAGED_SUBSCRIPTION_RUNTIME_NOT_CONFIGURED",
  "MANAGED_SUBSCRIPTION_CONTEXT_INVALID",
  "MANAGED_SUBSCRIPTION_ENFORCEMENT_CONFIG_INVALID",
  "SUBSCRIPTION_ENTITLEMENT_NOT_CONFIGURED",
  "SUBSCRIPTION_ENTITLEMENT_ORIGIN_NOT_TRUSTED",
  "VIVA_SERVICE_TOKEN_UNAVAILABLE",
  "VIVA_SERVICE_AUTH_NOT_CONFIGURED",
  "VIVA_SERVICE_AUTH_UNAVAILABLE",
  "VIVA_SERVICE_TOKEN_REFRESH_IN_PROGRESS",
  "BACKEND_UNAVAILABLE",
  "REQUEST_TIMEOUT",
  "DECISION_UNKNOWN",
  "RESPONSE_CONTRACT_INVALID",
  "SUBSCRIPTION_ELIGIBILITY_RECHECK_UNAVAILABLE",
  "SUBSCRIPTION_PLAN_LOOKUP_FAILED",
  "SUBSCRIPTION_PLAN_UNRESOLVED",
  "SUBSCRIPTION_BOOKING_PERSISTENCE_UNAVAILABLE",
  "SUBSCRIPTION_BOOKINGS_ACTIVE_UNAVAILABLE",
  "SUBSCRIPTION_BOOKINGS_HISTORY_UNAVAILABLE",
  "SUBSCRIPTION_BOOKINGS_ACTIVE_SCHEMA_UNRECOGNIZED",
  "SUBSCRIPTION_BOOKINGS_HISTORY_SCHEMA_UNRECOGNIZED",
]);

const formatMoney = (amountMinor: number | null | undefined): string | null => {
  if (!Number.isSafeInteger(amountMinor) || (amountMinor ?? -1) < 0) return null;
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    minimumFractionDigits: (amountMinor ?? 0) % 100 === 0 ? 0 : 2,
    maximumFractionDigits: (amountMinor ?? 0) % 100 === 0 ? 0 : 2,
  }).format((amountMinor ?? 0) / 100);
};

const actionNoun = (action: SubscriptionDecisionAction) => (
  action === "CREATE_GAME" ? "Создание игры" : "Присоединение к игре"
);

function errorMessage(error: ApiError | null | undefined): string | null {
  const normalized = toText(error?.message);
  if (!normalized || normalized === "Ошибка сети" || /^Ошибка запроса \(\d+\)$/.test(normalized)) {
    return null;
  }
  return normalized;
}

function isNoSubscriptionsAvailable(error: ApiError | null | undefined): boolean {
  if (!error) return false;
  const candidates: unknown[] = [error.message];
  if (isRecord(error.raw)) {
    candidates.push(error.raw.message, error.raw.error);
    if (isRecord(error.raw.details)) candidates.push(error.raw.details.message);
  }
  return candidates.some((value) => /no subscriptions available/i.test(toText(value) || ""));
}

export function resolveSubscriptionDecisionPresentation({
  action,
  requestedPaymentMode,
  durationMinutes,
  result = null,
  error = null,
}: {
  action: SubscriptionDecisionAction;
  requestedPaymentMode: "subscription" | "one_time";
  durationMinutes?: number | null;
  result?: PadelSplitPaymentResult | null;
  error?: ApiError | null;
}): SubscriptionDecisionPresentation {
  const codes = collectSubscriptionDecisionCodes(error?.raw ?? result?.raw);
  const noSubscriptionsAvailable = isNoSubscriptionsAvailable(error);
  const primaryCode = codes[0]
    || (noSubscriptionsAvailable
      ? "NO_SUBSCRIPTIONS_AVAILABLE"
      : error?.status === null ? "NETWORK_UNAVAILABLE" : "DECISION_UNKNOWN");

  if (error) {
    if (includesCode(codes, LIMIT_CODES)) {
      return {
        kind: "LIMIT_USED",
        title: "Лимит подписки использован",
        message: errorMessage(error)
          || "Льгота подписки уже использована. Выберите обычную оплату или другую дату.",
        reasonCode: primaryCode,
        retryable: false,
        subscriptionApplied: false,
        continueWithoutSubscription: true,
      };
    }
    if (includesCode(codes, INVALID_SUBSCRIPTION_CODES) || noSubscriptionsAvailable) {
      return {
        kind: "SUBSCRIPTION_INVALID",
        title: "Подписка недействительна",
        message: errorMessage(error)
          || "Активная подписка для этого действия не найдена. Выберите обычную оплату.",
        reasonCode: primaryCode,
        retryable: false,
        subscriptionApplied: false,
        continueWithoutSubscription: true,
      };
    }
    if (includesCode(codes, STALE_CODES)) {
      return {
        kind: "STALE_STATE",
        title: "Данные изменились",
        message: "Обновите игру или выбранное время и повторите действие.",
        reasonCode: primaryCode,
        retryable: true,
        subscriptionApplied: false,
        continueWithoutSubscription: false,
      };
    }
    if (includesCode(codes, ACTION_UNAVAILABLE_CODES)) {
      const alreadyJoined = codes.some((code) => code.includes("ALREADY_JOINED"));
      const full = codes.some((code) => code === "GAME_FULL" || code === "CAPACITY_FULL");
      return {
        kind: "ACTION_UNAVAILABLE",
        title: "Действие недоступно",
        message: alreadyJoined
          ? "Вы уже участвуете в этой игре."
          : full
            ? "В игре нет свободных мест."
            : errorMessage(error) || "Подписка не может быть применена к выбранному действию.",
        reasonCode: primaryCode,
        retryable: false,
        subscriptionApplied: false,
        continueWithoutSubscription: false,
      };
    }
    if (includesCode(codes, PENDING_CODES)) {
      return {
        kind: "PENDING_CONFIRMATION",
        title: "Проверяем результат",
        message: "Запрос принят, но итог ещё не подтверждён. Повторите проверку — новая льгота не спишется.",
        reasonCode: primaryCode,
        retryable: true,
        subscriptionApplied: false,
        continueWithoutSubscription: false,
      };
    }

    const technical = includesCode(codes, TECHNICAL_CODES)
      || error.status === null
      || (error.status ?? 0) >= 500;
    return {
      kind: "TECHNICAL_ERROR",
      title: "Временная техническая ошибка",
      message: technical
        ? "Не удалось подтвердить условия подписки. Повторите попытку; неизвестное состояние не даёт скидку."
        : "Сервер не подтвердил условия подписки. Обновите данные и повторите попытку.",
      reasonCode: primaryCode,
      retryable: true,
      subscriptionApplied: false,
      continueWithoutSubscription: false,
    };
  }

  if (!result) {
    return {
      kind: "TECHNICAL_ERROR",
      title: "Временная техническая ошибка",
      message: "Сервер не вернул решение по подписке. Повторите попытку.",
      reasonCode: "RESPONSE_CONTRACT_INVALID",
      retryable: true,
      subscriptionApplied: false,
      continueWithoutSubscription: false,
    };
  }

  if (!hasDeterministicSubscriptionDecision(result, requestedPaymentMode)) {
    return {
      kind: "TECHNICAL_ERROR",
      title: "Временная техническая ошибка",
      message: "Сервер вернул неподтверждённое состояние подписки. Обновите данные и повторите попытку.",
      reasonCode: readSubscriptionDecisionResultState(result.raw) || "RESPONSE_CONTRACT_INVALID",
      retryable: true,
      subscriptionApplied: false,
      continueWithoutSubscription: false,
    };
  }

  if (requestedPaymentMode === "one_time") {
    const amount = formatMoney(result.toPayMinor);
    return {
      kind: "ORDINARY_PAYMENT_ALLOWED",
      title: "Оплата без подписки",
      message: `${actionNoun(action)} доступно по обычной оплате${amount ? `: ${amount}` : ""}.`,
      reasonCode: "ONE_TIME_PAYMENT",
      retryable: false,
      subscriptionApplied: false,
      continueWithoutSubscription: false,
    };
  }

  const selectedMode = String(result.selectedPaymentMode || "").trim().toLowerCase();
  const fullPriceFallback = selectedMode === "one_time"
    || codes.includes("FULL_PRICE_WITHOUT_SUBSCRIPTION");
  if (fullPriceFallback) {
    const amount = formatMoney(result.toPayMinor);
    return {
      kind: "LIMIT_USED",
      title: "Лимит подписки использован",
      message: `Можно продолжить без подписки по полной стоимости${amount ? `: ${amount}` : ""}.`,
      reasonCode: codes.find((code) => LIMIT_CODES.has(code)) || "FULL_PRICE_WITHOUT_SUBSCRIPTION",
      retryable: false,
      subscriptionApplied: false,
      continueWithoutSubscription: true,
    };
  }

  if (selectedMode !== "subscription") {
    return {
      kind: "TECHNICAL_ERROR",
      title: "Временная техническая ошибка",
      message: "Сервер не подтвердил способ применения подписки. Повторите попытку.",
      reasonCode: "RESPONSE_CONTRACT_INVALID",
      retryable: true,
      subscriptionApplied: false,
      continueWithoutSubscription: false,
    };
  }

  if (!toText(result.bookingId) && !toText(result.paymentUrl)) {
    return {
      kind: "TECHNICAL_ERROR",
      title: "Временная техническая ошибка",
      message: "Сервер не вернул подтверждение записи по подписке. Повторите проверку.",
      reasonCode: "RESPONSE_CONTRACT_INVALID",
      retryable: true,
      subscriptionApplied: false,
      continueWithoutSubscription: false,
    };
  }

  const amount = formatMoney(result.toPayMinor);
  if ((result.toPayMinor ?? Math.round(result.toPay * 100)) > 0) {
    const extraMinutes = Number.isFinite(durationMinutes)
      ? Math.max(0, Math.round(Number(durationMinutes)) - 60)
      : 0;
    return {
      kind: "ADDITIONAL_PAYMENT_REQUIRED",
      title: "Подписка применена, нужна доплата",
      message: extraMinutes > 0
        ? `60 минут по подписке, доплата за ${extraMinutes} минут${amount ? ` — ${amount}` : ""}.`
        : `Подписка применена${amount ? `, доплата — ${amount}` : ", требуется доплата"}.`,
      reasonCode: "SUBSCRIPTION_ADDITIONAL_PAYMENT",
      retryable: false,
      subscriptionApplied: true,
      continueWithoutSubscription: false,
    };
  }

  return {
    kind: "SUBSCRIPTION_ALLOWED",
    title: "Можно по подписке",
    message: `${actionNoun(action)} подтверждено сервером без доплаты.`,
    reasonCode: "SUBSCRIPTION_CONFIRMED",
    retryable: false,
    subscriptionApplied: true,
    continueWithoutSubscription: false,
  };
}
