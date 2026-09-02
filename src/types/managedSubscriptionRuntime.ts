export type ManagedSubscriptionAction =
  | "CREATE_GAME"
  | "JOIN_GAME"
  | "BOOK_GROUP_TRAINING"
  | "BOOK_TOURNAMENT"
  | "PURCHASE_ADD_ON_PRODUCT";

export type ManagedSubscriptionEventCategory =
  | "GAME"
  | "GROUP_TRAINING"
  | "TOURNAMENT"
  | "ADD_ON_PRODUCT";

export type ManagedSubscriptionBenefitKind =
  | "FREE_ENTITLEMENT"
  | "FIXED_PRICE"
  | "PERCENT_DISCOUNT"
  | "FIXED_DISCOUNT"
  | "PARTIAL_PRICE_PERCENT_DISCOUNT"
  | "DISABLED";

export interface ManagedSubscriptionBenefitRule {
  ruleId: string;
  enabled: boolean;
  category: ManagedSubscriptionEventCategory;
  actions: ManagedSubscriptionAction[];
  externalEventTypeIds: string[];
  productTypeIds: string[];
  durationMinutes: number[];
  stationIds: string[];
  kind: ManagedSubscriptionBenefitKind;
  valueMinor: number | null;
  percentage: number | null;
  partialPrice: {
    numerator: number;
    denominator: number;
  } | null;
  priority: number;
}

export interface ManagedSubscriptionStationAccessRule {
  ruleId: string;
  enabled: boolean;
  priority: number;
  selector:
    | { kind: "HOME_STATION"; stationIds: [] }
    | { kind: "STATION_LIST"; stationIds: string[] }
    | { kind: "ALL_STATIONS"; stationIds: [] };
  surcharge: {
    kind: "NONE" | "FIXED";
    amountMinor: number;
  };
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
  activeServicesLimit: {
    enabled: boolean;
    max: number | null;
    scope: "SUBSCRIPTION_BENEFIT_ONLY" | "ALL_BOOKINGS";
  };
  bookingWindow: {
    enabled: boolean;
    days: number | null;
  };
  dailyUsageLimit: number;
  dailyUsagePolicy?: {
    actions: ManagedSubscriptionAction[];
    limitExceeded: "BLOCK" | "PERCENT_DISCOUNT";
    percentage: number | null;
    discountDurationsMinutes?: Array<60 | 90 | 120>;
  };
  usageUnitsByDuration: Record<"60" | "90" | "120", number>;
  stationAccessRules: ManagedSubscriptionStationAccessRule[];
  benefitRules: ManagedSubscriptionBenefitRule[];
  lifecycle: {
    activationMode?:
      | "PURCHASE"
      | "FIRST_USE"
      | "FIXED_DATE"
      | "FIRST_USE_OR_FIXED_DATE";
    activationWindowDays?: number;
    fixedActivationAt?: string | null;
    fixedActivationTimeZone?: "Europe/Moscow";
    validityDays?: number;
    allowBookingsAfterExpiry: boolean;
  };
  usage: {
    weeklyUsageLimit: number | null;
    monthlyUsageLimit: number | null;
    maxFutureBookings: number | null;
    minHoursBetweenUses: number;
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
  activeFrom: string | null;
  activeTo: string | null;
  homeStationId: string;
  frozenUntil: string | null;
  noShowBlockedUntil: string | null;
}

export interface ManagedSubscriptionResolvedTarget {
  resolutionSource: "SERVER";
  stationId: string;
  category: ManagedSubscriptionEventCategory;
  externalEventTypeId: string | null;
  productTypeId: string | null;
  eventId: string | null;
  durationMinutes: number;
  startsAt: string;
  basePriceMinor: number | null;
  currency: "RUB";
}

export interface ManagedSubscriptionUsageSnapshot {
  activeServiceScope: "SUBSCRIPTION_BENEFIT_ONLY" | "ALL_BOOKINGS";
  dailyBucketLocalDate: string;
  activeServices: number | null;
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
  partialPriceCalculation: {
    numerator: number;
    denominator: number;
    chargeBeforeDiscountMinor: number;
    percentageDiscountMinor: number;
  } | null;
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
