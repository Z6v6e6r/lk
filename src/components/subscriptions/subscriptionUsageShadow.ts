import type { ManagedSubscriptionPolicyDecision } from "../../types/managedSubscriptionRuntime.ts";
import {
  readSubscriptionUsageTestCredentials,
  subscriptionUsageTestApiPath,
  type SubscriptionUsageTestCredentials,
} from "./subscriptionUsageTestRoute.ts";
import type { SubscriptionUsageTestBookingOutcome } from "./subscriptionUsageTestBooking.ts";

export type SubscriptionUsageShadowAction = "CREATE_GAME" | "JOIN_GAME";

export interface SubscriptionUsageShadowTarget {
  targetId: string;
  title: string;
  action: SubscriptionUsageShadowAction;
  participantCount?: number;
  target: {
    category: string;
    durationMinutes: number;
    startsAt: string;
    basePriceMinor: number | null;
  };
}

export interface SubscriptionUsageShadowQuote {
  target: SubscriptionUsageShadowTarget;
  decision: ManagedSubscriptionPolicyDecision;
  bookingOutcome: SubscriptionUsageTestBookingOutcome;
}

export interface SubscriptionUsageShadowPresentation {
  tone: "subscription" | "full-price" | "blocked";
  title: string;
  summary: string;
  reasons: string[];
}

interface ApiErrorPayload {
  error?: { message?: string; details?: { issues?: string[] } };
}

interface ShadowFetchResponse {
  ok: boolean;
  json(): Promise<unknown>;
}

export type SubscriptionUsageShadowFetch = (
  input: string,
  init: RequestInit,
) => Promise<ShadowFetchResponse>;

export function isSubscriptionUsageShadowMode(
  pathname: string,
  search: string,
  isDevReleaseChannel: boolean,
): boolean {
  const normalizedPath = pathname.replace(/\/+$/, "") || "/";
  const allowedPaths = new Set(["/lk_dev", "/finde_game", "/find_game", "/game_create", "/game_join"]);
  if (!isDevReleaseChannel || !allowedPaths.has(normalizedPath)) return false;
  const params = new URLSearchParams(search);
  return params.get("subscriptionShadow") === "1" && params.get("subscriptionTest") !== "1";
}

export function appendSubscriptionUsageShadowToSameOriginUrl(target: URL, source: URL): URL {
  const sourceParams = source.searchParams;
  if (sourceParams.get("subscriptionShadow") !== "1"
    || sourceParams.get("subscriptionTest") === "1") return target;

  target.searchParams.set("subscriptionShadow", "1");
  if (target.origin !== source.origin) return target;

  const credentials = readSubscriptionUsageTestCredentials(source.hash);
  if (!credentials) return target;
  const fragment = new URLSearchParams(target.hash.replace(/^#/, ""));
  fragment.set("offerId", credentials.offerId);
  fragment.set("token", credentials.token);
  target.hash = fragment.toString();
  return target;
}

export function subscriptionUsageShadowTargetId(
  action: SubscriptionUsageShadowAction,
  durationMinutes: number | null | undefined,
): string | null {
  const duration = Number(durationMinutes);
  if (![60, 90, 120].includes(duration)) return null;
  return `annual-${action === "CREATE_GAME" ? "create" : "join"}-${duration}`;
}

export function normalizeSubscriptionUsageShadowCounter(
  value: unknown,
  max: number,
): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(max, Math.max(0, Math.floor(parsed)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isShadowQuote(value: unknown): value is SubscriptionUsageShadowQuote {
  if (!isRecord(value) || !isRecord(value.target) || !isRecord(value.decision)
    || !isRecord(value.bookingOutcome)) return false;
  const target = value.target;
  const resolvedTarget = target.target;
  const outcome = value.bookingOutcome;
  const decision = value.decision;
  return typeof target.targetId === "string"
    && (target.action === "CREATE_GAME" || target.action === "JOIN_GAME")
    && isRecord(resolvedTarget)
    && typeof resolvedTarget.durationMinutes === "number"
    && typeof decision.eligible === "boolean"
    && Array.isArray(decision.blockers)
    && typeof outcome.allowed === "boolean"
    && typeof outcome.subscriptionApplied === "boolean"
    && ["SUBSCRIPTION", "FULL_PRICE_WITHOUT_SUBSCRIPTION", "BLOCKED"].includes(
      String(outcome.pricingMode),
    )
    && Array.isArray(outcome.reasonCodes);
}

export async function fetchSubscriptionUsageShadowQuote({
  apiBase,
  credentials,
  action,
  durationMinutes,
  activeServices,
  dailyGameUsage,
  request = fetch as SubscriptionUsageShadowFetch,
}: {
  apiBase: string;
  credentials: SubscriptionUsageTestCredentials | null;
  action: SubscriptionUsageShadowAction;
  durationMinutes: number | null | undefined;
  activeServices: number;
  dailyGameUsage: number;
  request?: SubscriptionUsageShadowFetch;
}): Promise<SubscriptionUsageShadowQuote> {
  if (!credentials) {
    throw new Error("В ссылке отсутствуют offerId или секретный DEV-токен");
  }
  const targetId = subscriptionUsageShadowTargetId(action, durationMinutes);
  if (!targetId) {
    throw new Error("DEV-shadow поддерживает только игры на 60, 90 или 120 минут");
  }
  const response = await request(
    `${apiBase}${subscriptionUsageTestApiPath(credentials.offerId, "quote")}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Subscription-Test-Token": credentials.token,
      },
      body: JSON.stringify({
        targetId,
        activeServices: normalizeSubscriptionUsageShadowCounter(activeServices, 4),
        dailyGameUsage: normalizeSubscriptionUsageShadowCounter(dailyGameUsage, 4),
      }),
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    },
  );
  const payload = await response.json();
  if (!response.ok) {
    const apiError = isRecord(payload) ? payload as ApiErrorPayload : null;
    const details = apiError?.error?.details?.issues?.join("; ");
    throw new Error(details || apiError?.error?.message || "DEV-shadow расчёт недоступен");
  }
  if (!isShadowQuote(payload) || payload.target.targetId !== targetId) {
    throw new Error("DEV-shadow вернул ответ неизвестного формата");
  }
  return payload;
}

const formatMoney = (amountMinor: number | null | undefined) => {
  if (amountMinor === null || amountMinor === undefined) return "цена не определена";
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: 0,
  }).format(amountMinor / 100);
};

const percentageOf = (discountMinor: number, amountMinor: number | null | undefined) => (
  amountMinor && amountMinor > 0 ? Math.round((discountMinor / amountMinor) * 100) : null
);

const participantShareLabel = (target: SubscriptionUsageShadowTarget) => (
  (target.participantCount ?? 1) > 1 ? `доля игрока 1/${target.participantCount}` : null
);

export function presentSubscriptionUsageShadowQuote(
  quote: SubscriptionUsageShadowQuote,
): SubscriptionUsageShadowPresentation {
  const { bookingOutcome: outcome, decision, target } = quote;
  const participantShare = participantShareLabel(target);
  if (outcome.pricingMode === "FULL_PRICE_WITHOUT_SUBSCRIPTION") {
    return {
      tone: "full-price",
      title: "Без подписки — полная стоимость",
      summary: [
        "лимит льгот подписки исчерпан",
        participantShare,
        "без скидки",
        `итого ${formatMoney(outcome.finalPriceMinor)}`,
      ].filter(Boolean).join(" · "),
      reasons: outcome.reasonCodes,
    };
  }
  if (!outcome.allowed || outcome.pricingMode === "BLOCKED" || !decision.eligible) {
    return {
      tone: "blocked",
      title: "Действие недоступно",
      summary: "Ограничение не позволяет применить подписку к этому действию.",
      reasons: decision.blockers.map((blocker) => blocker.message || blocker.code),
    };
  }

  const benefit = decision.benefit;
  const parts: Array<string | null> = [];
  if (!benefit) {
    parts.push("льгота не рассчитана");
  } else if (benefit.kind === "FREE_ENTITLEMENT") {
    parts.push("первые 60 минут бесплатно");
  } else if (benefit.kind === "PARTIAL_PRICE_PERCENT_DISCOUNT") {
    const calculation = benefit.partialPriceCalculation;
    parts.push("первые 60 минут бесплатно");
    parts.push(`доплата за ${Math.max(0, target.target.durationMinutes - 60)} минут`);
    parts.push(participantShare);
    if (calculation) {
      const percentage = percentageOf(
        calculation.percentageDiscountMinor,
        calculation.chargeBeforeDiscountMinor,
      );
      parts.push(
        `скидка ${percentage ?? 0}% на доплату ${formatMoney(calculation.percentageDiscountMinor)}`,
      );
    }
  } else if (benefit.kind === "PERCENT_DISCOUNT" || benefit.kind === "FIXED_DISCOUNT") {
    if (benefit.ruleId === "daily-usage-limit-exceeded") {
      parts.push("бесплатный час использован");
      parts.push(participantShare);
    }
    const percentage = percentageOf(benefit.discountMinor, benefit.basePriceMinor);
    parts.push(
      `${percentage === null ? "скидка" : `скидка ${percentage}%`} ${formatMoney(benefit.discountMinor)}`,
    );
  } else {
    parts.push("без льготы");
  }
  parts.push(`итого ${formatMoney(outcome.finalPriceMinor)}`);
  return {
    tone: "subscription",
    title: "По годовой подписке",
    summary: parts.filter(Boolean).join(" · "),
    reasons: outcome.reasonCodes,
  };
}
