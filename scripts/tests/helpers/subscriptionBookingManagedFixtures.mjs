const DAY_MS = 24 * 60 * 60 * 1000;
const PITER_STATION_ID = "1ea77cbf-bc36-49a1-96d6-f35c216a409b";
export function managedRuntimeResponse(overrides = {}) {
    const stationId = overrides.stationId || PITER_STATION_ID;
    const benefitStationIds = overrides.benefitStationIds || [stationId];
    const policy = {
        runtimeSchemaVersion: 1,
        subscriptionTypeId: overrides.subscriptionTypeId || "subscription-type:piter",
        policyVersion: 1,
        status: "PUBLISHED",
        effectiveAt: "2026-08-01T00:00:00.000Z",
        timeZone: "Europe/Moscow",
        createGame: { enabled: true, durationsMinutes: [60, 90, 120] },
        joinGame: { enabled: true, minDurationMinutes: 60, maxDurationMinutes: 120 },
        activeServicesLimit: { enabled: false, max: null, scope: "SUBSCRIPTION_BENEFIT_ONLY" },
        bookingWindow: { enabled: false, days: null },
        dailyUsageLimit: 1,
        usageUnitsByDuration: { "60": 1, "90": 1, "120": 1 },
        stationAccessRules: [{
                ruleId: "station-rule",
                enabled: true,
                priority: 1,
                selector: overrides.allStations
                    ? { kind: "ALL_STATIONS", stationIds: [] }
                    : {
                        kind: "STATION_LIST",
                        stationIds: overrides.stationIds || [stationId],
                    },
                surcharge: { kind: "NONE", amountMinor: 0 },
            }],
        benefitRules: [
            {
                ruleId: "create-free",
                enabled: true,
                category: "GAME",
                actions: ["CREATE_GAME"],
                externalEventTypeIds: ["viva:direction:4588:type:1613"],
                productTypeIds: [],
                durationMinutes: [60, 90, 120],
                stationIds: benefitStationIds,
                kind: "FREE_ENTITLEMENT",
                valueMinor: null,
                percentage: null,
                partialPrice: null,
                priority: 1,
            },
            {
                ruleId: "join-free",
                enabled: true,
                category: "GAME",
                actions: ["JOIN_GAME"],
                externalEventTypeIds: ["viva:direction:4588:type:1613"],
                productTypeIds: [],
                durationMinutes: [60, 90, 120],
                stationIds: benefitStationIds,
                kind: "FREE_ENTITLEMENT",
                valueMinor: null,
                percentage: null,
                partialPrice: null,
                priority: 2,
            },
        ],
        lifecycle: {
            activationMode: "FIRST_USE_OR_FIXED_DATE",
            activationWindowDays: 0,
            fixedActivationAt: "2026-09-30T21:00:00.000Z",
            fixedActivationTimeZone: "Europe/Moscow",
            validityDays: 365,
            allowBookingsAfterExpiry: false,
        },
        usage: {
            weeklyUsageLimit: null,
            monthlyUsageLimit: null,
            maxFutureBookings: null,
            minHoursBetweenUses: 0,
            blackoutDates: [],
        },
        ...overrides.policy,
    };
    return {
        schemaVersion: 1,
        subscriptionInstanceId: overrides.subscriptionInstanceId || "subscription-instance-1",
        clientSubscriptionId: overrides.clientSubscriptionId || "client-subscription-1",
        policyDigest: overrides.policyDigest || "a".repeat(64),
        policy,
        instance: {
            subscriptionInstanceId: "subscription-instance-1",
            subscriptionTypeId: policy.subscriptionTypeId,
            policyVersion: policy.policyVersion,
            state: "ACTIVE",
            activeFrom: new Date(Date.now() - DAY_MS).toISOString(),
            activeTo: new Date(Date.now() + 365 * DAY_MS).toISOString(),
            frozenUntil: null,
            noShowBlockedUntil: null,
            homeStationId: stationId,
            ...overrides.instance,
        },
        evidence: overrides.evidence || { mappingRevision: 1, instanceRevision: 1 },
    };
}
export function entitlementDecision({ action = "CREATE_GAME", finalPriceMinor = 0, durationMinutes = 60, } = {}) {
    return {
        decisionKind: "ENTITLEMENT",
        policyVersion: 1,
        policyDigest: "a".repeat(64),
        action,
        target: {
            targetId: "exercise-target",
            stationId: PITER_STATION_ID,
            eventTypeId: "viva:direction:4588:type:1613",
            productTypeId: null,
            durationMinutes,
            startsAt: "2026-08-21T15:00:00.000Z",
        },
        usageUnits: 1,
        money: {
            basePriceMinor: 150000,
            discountMinor: 150000 - finalPriceMinor,
            surchargeMinor: 0,
            finalPriceMinor,
            currency: "RUB",
        },
    };
}
