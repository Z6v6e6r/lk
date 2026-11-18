import type { LifecycleCatalog, LifecycleOrder, LifecycleStatus } from "./residencyLifecycleClient.ts";

export type ResidencyLifecycleDecision =
  | { kind: "READY"; mode: "NEW" | "RENEWAL" }
  | { kind: "RECOVERY"; order: LifecycleOrder }
  | { kind: "BLOCKED"; code: string; message: string; eligibleAt: string | null };

/**
 * The screen never chooses a purchase mode by itself. It is derived from the authoritative
 * status/catalog and the server-side unresolved order; the server repeats every decision.
 */
export function resolveResidencyLifecycleDecision(input: {
  catalog: LifecycleCatalog | null;
  status: LifecycleStatus | null;
  unresolved: LifecycleOrder | null;
  oldCheckoutPending: boolean;
  /** Verified server-side: a purchase created outside the new checkout exists. */
  externalReview?: boolean;
}): ResidencyLifecycleDecision | null {
  const { catalog, status, unresolved, oldCheckoutPending, externalReview } = input;
  if (!catalog || !status) return null;
  if (unresolved) return { kind: "RECOVERY", order: unresolved };
  if (oldCheckoutPending) {
    return { kind: "BLOCKED", code: "LEGACY_CHECKOUT_PENDING", eligibleAt: null,
      message: "Есть незавершённая покупка в прежнем оформлении. Завершите или проверьте её перед новой оплатой." };
  }
  if (externalReview) {
    return { kind: "BLOCKED", code: "EXTERNAL_CHECKOUT_PENDING", eligibleAt: null,
      message: "Сервер обнаружил покупку резидентства в прежнем оформлении. Завершите или проверьте её перед новой оплатой — повторная оплата не создаётся." };
  }
  if (status.state === "UNAVAILABLE") {
    return { kind: "BLOCKED", code: "RESIDENCY_STATUS_UNAVAILABLE", eligibleAt: null,
      message: "Не удалось проверить действующее резидентство. Повторите позже." };
  }
  if (status.state === "ACTIVE") {
    if (!catalog.renewal.eligible) {
      const eligibleAt = catalog.renewal.eligibleAt || status.validUntil;
      return { kind: "BLOCKED", code: "RESIDENCY_RENEWAL_TOO_EARLY", eligibleAt,
        message: eligibleAt
          ? "Продление станет доступно после окончания текущего срока: " + formatResidencyDate(eligibleAt)
          : "Продление станет доступно после окончания текущего срока." };
    }
    return { kind: "READY", mode: "RENEWAL" };
  }
  if (status.state === "NONE" || status.state === "EXPIRED") return { kind: "READY", mode: "NEW" };
  return { kind: "BLOCKED", code: "RESIDENCY_STATUS_UNKNOWN", eligibleAt: null,
    message: "Состояние резидентства не подтверждено. Обновите страницу." };
}

export function formatResidencyDate(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return "—";
  return new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "long", year: "numeric" }).format(new Date(parsed));
}

export function formatResidencyMoney(minor: number): string {
  return new Intl.NumberFormat("ru-RU").format(Math.round(minor / 100)) + " ₽";
}

/** The bank return never proves payment; only the order/payment read does. */
export function isSettledOrder(order: LifecycleOrder): boolean {
  return order.state === "ACTIVE" || order.state === "PAID_REQUIRES_REVIEW" || order.state === "ACTIVATION_FAILED"
    || order.recovery.required === true;
}
