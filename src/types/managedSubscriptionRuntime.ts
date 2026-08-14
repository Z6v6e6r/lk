export type ManagedSubscriptionAction =
  | "CREATE_GAME"
  | "JOIN_GAME"
  | "BOOK_GROUP_TRAINING"
  | "BOOK_TOURNAMENT";

export type ManagedSubscriptionEventCategory =
  | "GAME"
  | "GROUP_TRAINING"
  | "TOURNAMENT";

export type ManagedSubscriptionBenefitKind =
  | "FREE_ENTITLEMENT"
  | "FIXED_PRICE"
  | "PERCENT_DISCOUNT"
  | "FIXED_DISCOUNT"
  | "DISABLED";

export interface ManagedSubscriptionBenefitRule {
  ruleId: string;
  enabled: boolean;
  category: ManagedSubscriptionEventCategory;
  externalEventTypeIds: string[];
  stationIds: string[];
  kind: ManagedSubscriptionBenefitKind;
  valueMinor: number | null;
  percentage: number | null;
  priority: number;
}

export interface ManagedSubscriptionRuntimePolicy {
  runtimeSchemaVersion: 1;
  subscriptionTypeId: string;
  policyVersion: number;
  status: "PUBLISHED";
  effectiveAt: string;
  timeZone: "Europe/Moscow";
  createGame: {
    enabled: boolean;
    durationsMinutes: Array<60 | 90 | 120>;
  };
  joinGame: {
    enabled: boolean;
    minDurationMinutes: number;
    maxDurationMinutes: number;
  };
  maxActiveServices: number;
  activeServiceScope: "SUBSCRIPTION_BENEFIT_ONLY" | "ALL_BOOKINGS";
  bookingWindowDays: number;
  dailyUsageLimit: number;
  usageUnitsByDuration: Record<"60" | "90" | "120", number>;
  benefitRules: ManagedSubscriptionBenefitRule[];
  lifecycle: {
    allowBookingsAfterExpiry: boolean;
  };
  usage: {
    weeklyUsageLimit: number | null;
    monthlyUsageLimit: number | null;
    maxFutureBookings: number | null;
    minHoursBetweenUses: number;
    crossStationMode: "HOME_ONLY" | "ALLOWED" | "ALLOWED_WITH_SURCHARGE";
    crossStationSurchargeMinor: number;
    blackoutDates: string[];
  };
}

export interface ManagedSubscriptionRuntimeInstance {
  subscriptionInstanceId: string;
  subscriptionTypeId: string;
  policyVersion: number;
  state:
    | "PENDING_ACTIVATION"
    | "ACTIVE"
    | "FROZEN"
    | "EXPIRED"
    | "CANCELLED"
    | "REFUNDED"
    | "REVOKED";
  activeFrom: string;
  activeTo: string;
  homeStationId: string;
  frozenUntil: string | null;
  noShowBlockedUntil: string | null;
}

export interface ManagedSubscriptionResolvedTarget {
  resolutionSource: "SERVER";
  stationId: string;
  category: ManagedSubscriptionEventCategory;
  externalEventTypeId: string | null;
  eventId: string | null;
  durationMinutes: number;
  startsAt: string;
  basePriceMinor: number | null;
  currency: "RUB";
}

export interface ManagedSubscriptionUsageSnapshot {
  activeServiceScope: "SUBSCRIPTION_BENEFIT_ONLY" | "ALL_BOOKINGS";
  dailyBucketLocalDate: string;
  activeServices: number;
  dailyUsed: number;
  weeklyUsed: number;
  monthlyUsed: number;
  futureBookings: number;
  activeServiceStartsAt: string[];
}

export interface ManagedSubscriptionPolicyEvaluationInput {
  evaluatedAt: string;
  action: ManagedSubscriptionAction;
  policy: ManagedSubscriptionRuntimePolicy;
  instance: ManagedSubscriptionRuntimeInstance;
  target: ManagedSubscriptionResolvedTarget;
  usage: ManagedSubscriptionUsageSnapshot;
}

export interface ManagedSubscriptionPolicyBlocker {
  code: string;
  message: string;
  details: Record<string, unknown> | null;
}

export interface ManagedSubscriptionAppliedBenefit {
  kind: Exclude<ManagedSubscriptionBenefitKind, "DISABLED"> | "NONE";
  ruleId: string | null;
  basePriceMinor: number | null;
  discountMinor: number;
  surchargeMinor: number;
  finalPriceMinor: number | null;
  currency: "RUB";
}

export interface ManagedSubscriptionPolicyDecision {
  eligible: boolean;
  policyVersion: number | null;
  blockers: ManagedSubscriptionPolicyBlocker[];
  usageUnits: number | null;
  activeServices: number | null;
  maxActiveServices: number | null;
  dailyUsed: number | null;
  dailyLimit: number | null;
  benefit: ManagedSubscriptionAppliedBenefit | null;
  evaluatedAt: string;
}
