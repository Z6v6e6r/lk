export type ManagedSubscriptionAdminSection =
  | "SETTINGS"
  | "INSTANCES"
  | "ANALYTICS";

export interface ManagedSubscriptionAnalyticsFilter {
  dateFrom: string;
  dateTo: string;
  timeZone: "Europe/Moscow";
  subscriptionTypeIds: string[];
  stationIds: string[];
}

export interface ManagedSubscriptionComparableMetric {
  value: number | null;
  previousValue: number | null;
  absoluteChange: number | null;
  percentageChange: number | null;
  numerator: number | null;
  denominator: number | null;
  unavailableReason: string | null;
}

export type ManagedSubscriptionNonRenewalBucket =
  | "DAYS_1_6"
  | "DAYS_7_13"
  | "DAYS_14_20"
  | "DAYS_21_29"
  | "DAYS_30_PLUS";

export interface ManagedSubscriptionNonRenewalClient {
  clientRef: string;
  displayName: string;
  maskedPhone: string;
  subscriptionInstanceId: string;
  subscriptionTypeId: string;
  homeStationId: string;
  expiredAt: string;
  daysSinceExpiry: number;
  lastAttendedAt: string | null;
  bucket: ManagedSubscriptionNonRenewalBucket;
}

export interface ManagedSubscriptionCapacityRisk {
  eligibleSlotCapacity: number | null;
  subscriberOccupiedSlots: number | null;
  allConfirmedOccupiedSlots: number | null;
  subscriberSlotFillRate: number | null;
  unusedEligibleCapacity: number | null;
  entitlementDemand: number | null;
  capacityOverdraftUnits: number | null;
  unavailableReason: string | null;
}

export interface ManagedSubscriptionAnalyticsSummary {
  asOf: string;
  filter: ManagedSubscriptionAnalyticsFilter;
  comparison: { dateFrom: string; dateTo: string };
  freshness: {
    purchaseLedgerAt: string | null;
    bookingLedgerAt: string | null;
    attendanceLedgerAt: string | null;
    capacitySnapshotAt: string | null;
  };
  metrics: {
    activeSubscriptions: ManagedSubscriptionComparableMetric;
    subscriptionsPurchased: ManagedSubscriptionComparableMetric;
    newClientPurchases: ManagedSubscriptionComparableMetric;
    renewals: ManagedSubscriptionComparableMetric;
    renewalRate: ManagedSubscriptionComparableMetric;
    netRevenueMinor: ManagedSubscriptionComparableMetric;
    averageAttendedVisits: ManagedSubscriptionComparableMetric;
    medianAttendedVisits: ManagedSubscriptionComparableMetric;
    cancellationRate: ManagedSubscriptionComparableMetric;
    confirmedNoShowRate: ManagedSubscriptionComparableMetric;
    addOnRevenueMinor: ManagedSubscriptionComparableMetric;
    outstandingEntitlementUnits: ManagedSubscriptionComparableMetric;
  };
  nonRenewalCounts: Record<ManagedSubscriptionNonRenewalBucket, number>;
  capacity: ManagedSubscriptionCapacityRisk[];
}
