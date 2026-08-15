# Managed subscription runtime policy contract v1

## Status

This checkpoint defines and tests the first server-side policy evaluator for the
managed annual subscription model. It does not publish a CUP policy, activate a
Viva product, create a client subscription, change the live Node-RED flow or
perform a booking/payment mutation.

The evaluator source is:

`scripts/nodered_subscription_booking_nodes/fn_managed_subscription_policy_evaluate.js`.

The current `/lk/subscription-bookings` route remains unchanged until a later
flow-wiring checkpoint can resolve a published policy and an owned client
instance from authoritative server sources.

## Boundary

The browser is not allowed to calculate or assert entitlement, usage counters,
event classification, station identity, duration or price. Before calling the
evaluator, the server must resolve:

1. the authenticated actor from Viva Bearer profile;
2. the exact owned `clientSubscriptionId` and local subscription instance;
3. one immutable `PUBLISHED` runtime policy snapshot pinned by `policyVersion`;
4. the event/station/type/duration/base price from a trusted event/provider read;
5. active/history bookings and non-expired local reservations used by counters.

The target has `resolutionSource: SERVER`. A missing or client-supplied marker
is rejected with `TARGET_NOT_SERVER_RESOLVED`.

## Function-node input

The caller places the input in `msg._managedSubscriptionPolicyInput`:

```json
{
  "evaluatedAt": "2026-08-14T08:00:00.000Z",
  "action": "CREATE_GAME",
  "policy": {
    "runtimeSchemaVersion": 1,
    "subscriptionTypeId": "friendship-12m-yasenevo",
    "policyVersion": 3,
    "status": "PUBLISHED",
    "effectiveAt": "2026-08-01T00:00:00.000Z",
    "timeZone": "Europe/Moscow",
    "createGame": { "enabled": true, "durationsMinutes": [60, 90, 120] },
    "joinGame": { "enabled": true, "minDurationMinutes": 60, "maxDurationMinutes": 120 },
    "activeServicesLimit": {
      "enabled": true,
      "max": 3,
      "scope": "SUBSCRIPTION_BENEFIT_ONLY"
    },
    "bookingWindow": { "enabled": true, "days": 4 },
    "dailyUsageLimit": 1,
    "usageUnitsByDuration": { "60": 1, "90": 1, "120": 1 },
    "stationAccessRules": [
      {
        "ruleId": "home-free",
        "enabled": true,
        "priority": 300,
        "selector": { "kind": "HOME_STATION", "stationIds": [] },
        "surcharge": { "kind": "NONE", "amountMinor": 0 }
      },
      {
        "ruleId": "stations-a-b-150",
        "enabled": true,
        "priority": 200,
        "selector": { "kind": "STATION_LIST", "stationIds": ["station-a", "station-b"] },
        "surcharge": { "kind": "FIXED", "amountMinor": 15000 }
      }
    ],
    "benefitRules": [
      {
        "ruleId": "create-90-quarter-minus-20",
        "enabled": true,
        "priority": 100,
        "category": "GAME",
        "actions": ["CREATE_GAME"],
        "externalEventTypeIds": ["open-game"],
        "productTypeIds": [],
        "durationMinutes": [90],
        "stationIds": ["station-a"],
        "kind": "PARTIAL_PRICE_PERCENT_DISCOUNT",
        "valueMinor": null,
        "percentage": 20,
        "partialPrice": { "numerator": 1, "denominator": 4 }
      }
    ],
    "lifecycle": { "allowBookingsAfterExpiry": false },
    "usage": {
      "weeklyUsageLimit": null,
      "monthlyUsageLimit": null,
      "maxFutureBookings": null,
      "minHoursBetweenUses": 0,
      "blackoutDates": []
    }
  },
  "instance": {
    "subscriptionInstanceId": "opaque-local-id",
    "subscriptionTypeId": "friendship-12m-yasenevo",
    "policyVersion": 3,
    "state": "ACTIVE",
    "activeFrom": "2026-08-01T00:00:00.000Z",
    "activeTo": "2027-08-01T23:59:59.999Z",
    "homeStationId": "canonical-station-id",
    "frozenUntil": null,
    "noShowBlockedUntil": null
  },
  "target": {
    "resolutionSource": "SERVER",
    "stationId": "canonical-station-id",
    "category": "GAME",
    "externalEventTypeId": "canonical-event-type-id",
    "productTypeId": null,
    "eventId": null,
    "durationMinutes": 60,
    "startsAt": "2026-08-15T07:00:00.000Z",
    "basePriceMinor": null,
    "currency": "RUB"
  },
  "usage": {
    "activeServiceScope": "SUBSCRIPTION_BENEFIT_ONLY",
    "dailyBucketLocalDate": "2026-08-15",
    "activeServices": 0,
    "dailyUsed": 0,
    "weeklyUsed": 0,
    "monthlyUsed": 0,
    "futureBookings": 0,
    "activeServiceStartsAt": []
  }
}
```

The TypeScript DTO mirror for current and future LK adapters is
`src/types/managedSubscriptionRuntime.ts`.

## Output

The function stores a sanitized decision in
`msg._managedSubscriptionPolicyDecision` and has two outputs:

- output 1: eligible;
- output 2: blocked or invalid context.

It does not write Viva, Mongo, roster, payments or publication projections.
An eligible decision is not a reservation. The next flow step must atomically
reserve the relevant counters before any upstream mutation and must revalidate
the same policy version.

## Implemented rules

- only `runtimeSchemaVersion=1`, `PUBLISHED`, effective policy;
- exact subscription type and instance/policy version match;
- active/frozen/expired/no-show-blocked instance state;
- server-resolved target and action/category match;
- create toggle and exact 60/90/120 allow-list;
- join toggle and configured duration range;
- independently enabled/disabled active-services maximum and station-local
  booking window (`4` means today plus three days);
- blackout local dates;
- active-service maximum, including current reservations in the supplied count;
- exact active-service scope and target-local daily bucket match;
- duration-based units and daily/weekly/monthly usage limits;
- maximum future bookings and minimum interval between services;
- ordered station rows: home station, selected station lists or all stations,
  each with its own fixed surcharge; equal-priority overlaps fail closed;
- exact action + category + event type + duration + product type + station
  benefit selection;
- `FREE_ENTITLEMENT`, fixed price, percent and fixed discount in RUB minor units;
- duration-specific benefits can make a 60-minute create action free while a
  confirmed 4,000 RUB 90-minute service uses a `1/4` share and 20% discount,
  charging 800 RUB;
- add-on products use the same appendable rule model with exact server-resolved
  product type, event type and stations;
- ambiguity and missing server base price fail closed;
- a matching `DISABLED` game benefit disables the discount only, while group or
  tournament use remains unavailable without an enabled matching benefit.

## Required flow wiring (next checkpoint)

The current booking gateway can use the evaluator only after these source-driven
Node-RED steps exist:

1. read a reviewed CUP runtime projection by exact Viva product mapping;
2. resolve the actor-owned local instance by exact `clientSubscriptionId`;
3. resolve event fields from Viva/read model, never from browser price/category;
4. merge complete active/history bookings with non-expired local reservations;
5. execute the policy evaluator;
6. on output 1, create one atomic entitlement reservation and continue the
   existing Viva mutation/read-back state machine;
7. on output 2, return stable `409` blocker details without an upstream write;
8. release a reservation only after exact inactive booking/refund evidence.

The flow must preserve legacy plan behavior when no managed mapping exists.
Once a product is explicitly mapped to managed runtime, missing/unpublished
policy evidence must fail closed and must not fall back to hardcoded plan names.

## Evidence gates

These semantics are intentionally not implemented by this evaluator until a
sanitized Golden HAR confirms the provider contract:

- Viva visit debit/return counts for 60/90/120 minutes;
- real discount/fixed-price transaction request and payment confirmation;
- activation on first use, freeze and unfreeze mutations;
- late cancellation/no-show provider writes;
- refund, unpaid expiration and delayed payment behavior.

HTTP success without exact read-back remains insufficient evidence.

## No-show

`No-show` means that a client had a confirmed booking, did not attend it and did
not cancel within the allowed cancellation window. It is not the same as an
ordinary cancellation. A no-show policy may independently consume an
entitlement, charge a fee, add a strike or temporarily block new bookings.

The LK must never infer a no-show merely because time passed or a client is not
visible in one response. `noShowBlockedUntil` can be set only from authoritative
Viva attendance/status evidence (or an explicit reviewed administrator action)
with exact read-back and audit history.

The three-section CUP module and analytics definitions are specified in
`docs/MANAGED_SUBSCRIPTION_ADMIN_MODULE.md`.
