import type { ManagedSubscriptionAction } from "../../types/managedSubscriptionRuntime";

export interface SubscriptionUsageTestBookingOutcome {
  allowed: boolean;
  subscriptionApplied: boolean;
  pricingMode: "SUBSCRIPTION" | "FULL_PRICE_WITHOUT_SUBSCRIPTION" | "BLOCKED";
  finalPriceMinor: number | null;
  reasonCodes: string[];
}

export function subscriptionUsageTestCounterDelta(
  outcome: SubscriptionUsageTestBookingOutcome,
  action: ManagedSubscriptionAction,
  usageUnits: number | null,
): { activeServices: number; dailyGameUsage: number } {
  if (!outcome.allowed || !outcome.subscriptionApplied) {
    return { activeServices: 0, dailyGameUsage: 0 };
  }
  const normalizedUsageUnits = Number.isInteger(usageUnits) && (usageUnits ?? 0) > 0
    ? usageUnits ?? 0
    : 1;
  return {
    activeServices: 1,
    dailyGameUsage: action === "CREATE_GAME" || action === "JOIN_GAME"
      ? normalizedUsageUnits
      : 0,
  };
}
