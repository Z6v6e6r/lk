# Managed subscription runtime policy contract v1

## Status

### Scoped live integration in progress — not installed or activated

The preserved task checkpoint is 948a10fb66c002c5d49698eb1f802fa3d49d1d86.
Its historical whole-function bodies must not replace production. The local
integration branch starts at 58f2c78e99599ab4d503b13a3c17e3d0f4590f24;
generic main modules remain unchanged.

The focused patcher scripts/patch_live_lk1_hub.mjs and source fragments under
scripts/nodered_lk1_hub_nodes/ compose only the direct product-bound HUB delta
over the four reviewed live function bodies and the gateway initializer. Whole target/dependency node hashes
and incoming edges are pinned; duplicate IDs, missing targets, changed preimages
or broken references fail closed. All other nodes and fields are preserved,
including unrelated Piter changes. Raw live flow stays private outside Git.
Artifact publication requires fresh live-pull custody.

### Reviewed source-bound enable and safe-OFF preparation

`scripts/lib/lk1HubPolicyTransition.mjs` prepares only the existing HUB product
global. Explicit `expectedPrior` and `desired` values are source-bound; null is
OFF. An initializer accepts the exact desired value idempotently, changes only
the exact expected prior, and reads back its result. This is not an atomic CAS:
one configuration writer is mandatory. A reader independently compares the
global with its embedded desired policy, so initializer failure or stale
file-backed ON cannot authorize a different source policy. New eligible HUB
requests hold on OFF/mismatch; known requests retain the pure replay check.

The focused builder now emits exact-graph contracts, not a function-only
contract. For an ON release the mandatory order is:

1. Install `safe-off.json` using `install-off-contract.json`, then verify flow
   and OFF context readback. This baseline contains the new replay guard.
   Respect the installer's ordinary fifteen-minute soak lease before the
   distinct enable deployment; do not manually clear or bypass that lease.
2. Enable `candidate.json` using `contract.json`, which is bound to that exact
   safe-OFF predecessor and permits only gateway func/initialize changes.
3. For recovery, use `safe-off-contract.json` or the existing installer's exact
   baseline backup. The safe-OFF initializer accepts the embedded ON policy and
   clears it with readback; unknown prior remains STOP. Verify OFF and retained
   request behavior before considering any further rollback.

HUB contracts have no `activationBoundary`; preserved future-game nodes do not
implicitly add one. Recovery of a failed enable must use the exact safe-OFF
backup and guarded rollback/resume. Do not substitute `reconcile-current` for
that recovery: its forward-recovery branch can republish the retained ON
candidate over already restored OFF bytes. Re-enabling through that command
requires renewed explicit ON authority and a reviewed current-state plan.

The enable contract mechanically rejects a direct old-source-to-ON install.
This requires two ordinary backend publication/restart steps and may require a
guarded recovery restart. Restoring dormant 8db7c36 after activation is not an
approved rollback: it lacks the replay protection. The old private artifacts
remain preserved, not relabelled. Synthetic memory/persisted-context lifecycle
tests do not prove real Node-RED disk persistence or restart behavior.

### Isolated DEV frontend publication preparation

The existing atomic static helper has a fixed `--dev-only` namespace with
eleven DEV bundles plus `release-dev.json`, separate release/current/lease
paths, and no fonts or opposite-channel pruning. The narrow owner-run adapter
`scripts/lk1-dev-frontend-release.mjs` validates the actual external artifacts
against the exact clean approved source, uploads only to the acquired reserve
release identity and checks public hashes plus a read-only DEV browser smoke.
The standard production release remains unchanged and independently gated.

The offline builder `scripts/nginx/prepare_lk1_dev_static_bootstrap.mjs` prepares
the two reserve server blocks in the existing vhost. It replaces only their
exact DEV manifest locations with twelve exact DEV aliases; all other bytes,
including legacy bundle/release routes, API and fonts, are preserved. It retains
the immutable installed baseline and exact nginx backup/rollback hashes.
Preparation performs no SSH, nginx installation or reload. Real nginx routing,
cache/CORS and switch/rollback rehearsal is separate from offline source tests.
Frontend pointer/nginx recovery does not disable the backend product policy;
backend safe-OFF does not roll back frontend files.

The existing split_create_readonly_preflight remains read-only. After successful
Viva profile authentication, fresh booking ingress performs at most one exact
Mongo FIND in the existing operation store, keyed by canonical tenant,
authenticated actor and validated operationId. This replaces the former
zero-DB-call invariant; DB/provider writes remain zero. A definitive empty result
resumes the existing preflight. Errors, ambiguous results and uncertain known
operations hold without effects; they must never be interpreted as empty.
This adds an operation-store read dependency even to legacy/no-rule booking
requests: a failed lookup blocks those requests as well. Release is unchanged.

Known HUB requests are checked independently of the enable flag. Confirmed
identity/payload/target and persisted checkout evidence can be returned without
checkout creation, allowance consumption or split CREATE continuation. All other
known outcomes require reconciliation. Only the two server-owned, freshly
authenticated internal CREATE continuations may bypass this ingress read;
they retain their existing durable-record and separate attempt CAS barriers.
An OFF rule cannot send those internal continuations into legacy booking.

Its bound HUB
success enters a separate call through the existing ordinary mutating gateway:
fresh actor/ownership reads, per-request lookup/insert and strict durable CAS.
Only that exact CAS continuation can hand back to
subscription_create_preflight_complete and permit one exercise POST. The
frozen CREATE payload, operation, actor, subscription and target must match.
After CREATE, a separate attempt CAS binds the actual exercise before booking.
Unknown outcomes never grant another CREATE, booking, transaction or DELETE.
The existing live no-delete guard and non-HUB rounding/daily rules are retained.

This integration does not import the older CUP overlay, reserve protocol, or
type-binding prerequisite. The new private-fixture test is
scripts/tests/lk1HubLiveComposition.test.ts; it executes the final composed
functions. Without LK1_HUB_LIVE_FIXTURE it is explicitly skipped, not PASS.
Physical Mongo/provider behavior and actual Viva one-times tariff DTO acceptance
remain unverified. The earlier configured frontend build belongs to checkpoint
948a10fb, not to this integration source.

The optional product global has no actor-specific pilot switch. Enabling it on
shared backend 147 affects the entire eligible product/purchase cohort, including
production clients; using the DEV frontend does not isolate real booking writes.
No rule, subscription, booking or payment has been activated by this integration.

### 2026-09-06: direct Viva product rule, local implementation (not deployed)

The current user-approved pilot targets Viva product
`db7a5250-7369-4f43-8ac5-9111be24bc74` directly, not a CUP subscription type.
It supersedes the historical type-binding prerequisite in the section below.
The optional server global `subscriptions_lk1_product_policy` is one object with
exact fields `productId`, `maxActiveBookings`, `freeGameMinutesPerDay`,
`gameOverageDiscountPercent`, `groupTrainingDiscountPercent`,
`tournamentDiscountPercent`. It is absent by default and has **not been installed**.
Only authoritative owned Viva product/date/target evidence selects this branch.
Before `2026-09-01 Europe/Moscow`, the existing legacy path is retained.

For GAME, any positive free-minute portion consumes exactly one subscription
visit; the paid portion alone uses the existing partial-price percentage
calculator. Examples: used0+60 => one visit, no money; used0+90 => one visit and
paid30 at30% discount; used30+90 => one visit and paid60 at30%; used60+60 => no
free visit and paid60 at30%. The tariff comes from existing server price logic,
not the 10,000 RUB SERVICE carrier. Amounts above that carrier's capacity are
rejected before any operation insertion or provider write.

The existing `lk_subscription_daily_booking_ops` collection stores one immutable
request identity `(tenant, actor, operationId)`, frozen rule/target/minute decision,
and the per-leg attempted/result metadata. No new collection or booking state is
introduced. CREATE persists its attempt before the exercise POST, then binds the
actual server-read target and a separate booking attempt before the booking POST.
JOIN persists the booking attempt before its POST. Request replay cannot consume
allowance again or adopt a different request's booking; confirmation requires the
exact persisted/POST-returned booking ID. Unknown outcomes remain pending. Failed
or released requests are not reclaimed for a new booking.

Money uses the existing split SERVICE serializer, with count1, exact monetary
discount and the confirmed booking ID. A durable one-shot CAS must positively
modify the record before the transaction POST. Ambiguous outcomes without an exact
transaction ID do not trigger another POST. Exact transaction readback validates
all supplied amount/identity aliases; malformed or contradictory evidence stays
pending. A checkout URL means money is due, not paid. Carrier errors after a visit
do not authorize legacy compensation. The tournament subscription wrapper preserves
this additive due/checkout contract instead of always returning `paid: true`.

Evidence is **local synthetic function-chain testing**, including the actual
evaluator, split serializer, gateway and finalizer with an in-memory Mongo CAS
simulation. It is not physical DB, provider, deployed routing or browser proof.
Actor-wide/cross-request concurrency is explicitly deferred by the user while Viva
remains in use; same-request idempotency remains mandatory.

Subscription callers without a tariff now enter the existing authenticated
master-service/studio/sub-service/price GET pipeline after product/cohort selection.
The split completion includes the existing `PAYMENT_REQUIRED` settlement evidence;
the actual game-client decision predicate accepts the mixed result locally.

GT/T now uses the existing authenticated own-subscriptions GET independently of
visit availability, with exact product/instance/owner, ACTIVE status, purchase
cutoff and lifecycle covering the whole event. Zero remaining visits does not
exclude a monetary discount. It re-reads ownership, target and the existing
one-times tariff before an ON_PLACE booking, then uses the same SERVICE checkout
at the configured discount, with no subscription visit or GAME-minute debit.
The actual exercise's `availableClientSubscriptions` is never fabricated.
Malformed identity fields, timestamp expiry and price drift fail closed.

Still required before DEV activation: a real sanitized owned-instance response
proving the product link, a real event-bound one-times tariff response matching
the strict parser, final release checks, and fresh DEV backend
identity/isolation/preimage/rollback. `apiClient.Subscription` currently declares
the instance ID but no explicit product ID. The supplied catalog product UUID
and a matching product name do not prove owned-instance-to-product identity.
Accepted explicit server paths include `productId`, `subscriptionProductId`,
`templateId`, nested `product`/`template` IDs and their `subscription` equivalents;
all supplied aliases must agree. No existing sanitized real fixture proves one
of these paths. The browser collector is deliberately narrower (top-level IDs
or nested `product`), so other valid server paths may remain unavailable in UI.

The affected bundle compiles with inert `ci.invalid` settings only; it is not a
DEV/release artifact. An initial synthetic CUA render exposed that the existing
owned-subscription button ignored the candidate's monetary `priceLabel`. With
coordinator-approved ownership of the existing component, the flagged candidate
shows «Потребуется оплата со скидкой.» before the action; ordinary variants and
business flow are unchanged. The candidate's closing note «Посещение не
списывается.» was removed on 2026-09-15 from both the tournament signup and the
group-training screens; the current copy is the shorter one and no pricing,
quote or booking behavior changed. Final desktop and
390px mobile CUA renders confirm the warning is visible and in the accessible
button text. Mobile validity text still wraps poorly (pre-existing cosmetic
limitation); no CSS was changed. No booking button was clicked. Playwright CLI
was unavailable (registry DNS); CUA is the fallback, not a Playwright CLI PASS.

GAME cached tariff evidence is target-bound and expires after30 seconds;
target/rule recheck is not a second tariff fetch. GT/T does fetch its tariff again.
No agent booking/debit/payment tests are authorized: the user plans
manual cases on `https://padlhub.ru/lk_dev`. That frontend URL alone does not prove
backend isolation. Production, shared routing, secrets and real data remain unchanged.

#### Safe checkpoint: local source, not release acceptance

```text
ROLE_AND_CURRENT_TASK=B / LK1 product-bound free-hour + money-overage implementation
REPOSITORY=Z6v6e6r/lk
WORKTREE_PATH=.worktrees/lk1-launcher-fix-main3bd-integration-20260905
BRANCH=codex/lk1-launcher-fix-main3bd-integration-20260905
HEAD_SHA=95ecbc40b54f94398f4d8222afca716464c04112 (changes uncommitted)
CHANGED_AND_UNTRACKED_FILES=11 modified scoped files listed below; no untracked files
DONE=GAME CREATE/JOIN allocation and one-shot checkout; GT/T independent money ownership, fresh event tariff, zero-visit discounted checkout; client due normalization
CURRENTLY_RUNNING=None; owned loopback fixture stopped after final render; no server/DB operation
TESTS_ACTUALLY_PASSED=Prior GAME gate: 224 PASS / 4 SKIP; GT/T increment: 2 gateway cases and 8 wrapper/daily-limit cases; after final lifecycle/identity fix: 3 focused GT/T cases; final UI tsc -b --noEmit and scoped ESLint --quiet; git diff --check; final inert affected-bundle compile; final local synthetic desktop/mobile warning render
BLOCKER=Real own-instance product link and event tariff DTO NOT_VERIFIED; DEV isolation/target NOT_PROVEN; release/runtime checks incomplete
SHARED_ENVIRONMENT_OR_RESOURCES=No host/provider/DB/config writes; coordinator owns read-only DEV target investigation; actor-wide concurrency deferred
NEXT_STEP_TO_CLOSE_A_B_C_D=Accept real sanitized product/tariff proof and fresh isolated DEV target/preimage/rollback before candidate installation. No claim that A/C/D are closed.
MODEL_ROUTE=parent
```

Changed files (existing worktree preserved):

- `scripts/nodered_subscription_booking_nodes/fn_subscription_booking_router.js`
- `scripts/nodered_subscription_booking_nodes/fn_subscription_booking_finalize.js`
- `scripts/nodered_subscription_booking_nodes/fn_managed_subscription_policy_evaluate.js`
- `scripts/nodered_games_nodes/fn_split_router.js`
- `scripts/tests/subscriptionBookingGateway.nodered.test.ts`
- `scripts/tests/managedSubscriptionPolicyEvaluator.nodered.test.ts`
- `scripts/tests/tournamentSignup.subscriptionConfirmation.test.ts`
- `src/types/managedSubscriptionRuntime.ts`
- `src/utils/tournamentSignupApi.ts`
- `src/components/tournament-signup/TournamentSignupPage.tsx` (coordinator-approved payment warning only)
- `docs/MANAGED_SUBSCRIPTION_RUNTIME_CONTRACT.md`

Four explicit skips from the prior 224-PASS gate (none counted as PASS):

- `native custody physical RESERVE READBACK with owned PostgreSQL and Mongo`:
  optional physical fixture absent; historical inactive CUP/LK2 path, not proof
  of the new direct-rule Mongo runtime either.
- `native custody in-process actual CUP resolver quote to native LK to canonical route`:
  old CUP resolver fixture/environment absent; inactive outside this direct rule.
- `LK1 overlay consumes actual CUP supplier responses across the final contract`:
  `LK1_CUP_SUPPLIER_RESPONSES` absent; historical mapping path, not this pilot.
- `HUB response and external command prefix match the exact fresh-live preimage`:
  `LK1_SUBSCRIPTION_LIVE_FLOW_FIXTURE` absent; fresh preimage remains a release gate.

Node-RED function files are ignored by ESLint, but their actual bodies execute in
the affected tests. The previous full ESLint passed; final changed TS/test scope
also passed. The final affected tournament bundle compiled 119 modules with all
required URLs set to inert `https://ci.invalid/…`; normal DEV environment validation
is blocked by 17 missing keys. No credentials were restored. Modular candidate
validation, physical Mongo and real provider/manual UI cases were not run.
No checkpoint commit, push, PR, merge, deploy or live mutation occurred. Triggered
read-only review closed the GAME 2P1/2P2/carrier-cap findings and the final GT/T
timestamp-lifecycle/malformed-identity findings; both are scoped source verdicts.
The separately reviewed final UI delta is `SCOPED_UI_PAYMENT_REVIEW=PASS`; the
reviewer did not repeat tests/render. Final inert compilation transformed 119
modules and emitted a 3,745.73 kB bundle (2,395.66 kB gzip) only under `/private/tmp`.

### Historical local projection/type-contract evidence (not an activation path)

The new release scope replaces the broad CUP/LK2 readiness criteria below.
The existing evaluator accepts a **server-built** `lk1Policy` containing only
`maxActiveBookings`, `freeGameMinutesPerDay`, `gameOverageDiscountPercent`,
`groupTrainingDiscountPercent`, and `tournamentDiscountPercent`.
This source-only entry is not called by the booking router yet and must not be
treated as production eligibility, publication, or provider authorization.

The corresponding LK1 consumer now accepts the agreed additive runtime-context
`policyResolution: { kind: ABSENT | LEGACY | MATCH, subscriptionTypeId }` contract.
The final CUP supplier source has been exercised against this consumer locally,
with synthetic actor/repository reads. This is not deployed-contract or current
mapping evidence. Enrollment requires both the existing
exact HUB product allowlist and the scalar Node-RED global
`subscriptions_lk1_overlay_subscription_type_id`. Its owner/purpose is the current
LK1 pilot; it has no default value, policy registry or browser input. Do not set it
until the existing read-only mapping bridge freshly verifies the actual HUB type
and the reviewed contract/release gates pass. Review or remove this pilot binding
when the pilot closes or an existing authoritative enrollment mechanism replaces
it; do not expand it into a registry. Old HUB allowlist membership alone does not
enable the new branch. Product ID as type ID and mismatched response types fail
closed for the explicitly enrolled pilot.

ABSENT continues the legacy flow without requiring a purchase date. LEGACY and
MATCH require valid unambiguous Viva date evidence; before the cutoff they retain
the legacy flow. A current MATCH deliberately stops with
`LK1_POLICY_OVERLAY_EXECUTION_UNBOUND`, without old CUP reserve or activation.
Before a legacy booking POST, the consumer repeats the same read and compares
type, instance, mapping revisions and rule identity. Non-2xx/malformed replies
cannot authorize fallback; recheck failures stay pending without a compensation
grant. These are synthetic function-path checks, not a live booking/payment test.

The final ABSENT/LEGACY response includes an exact safe `instance` subset:
`subscriptionInstanceId`, `subscriptionTypeId`, `state`, `activeFrom`, `activeTo`,
`frozenUntil`, `homeStationId`, `noShowBlockedUntil` (null). Both nested identities
must match the top-level result. Private fields, `purchasedAt`, `policyVersion`,
policy/publication payloads and extra keys are rejected in these two branches.
Instance metadata does not replace the original Viva eligibility guards.
The local cross-contract check executes the actual CUP source with synthetic
read-only dependencies, then feeds its ABSENT/LEGACY/MATCH and four actual error
responses to the actual LK1 function. It covers legacy continuation, safe MATCH
STOP, type/date/recheck drift and errors without any HTTP dispatch. The opt-in
gateway test uses `LK1_CUP_SUPPLIER_RESPONSES`; without supplied evidence it is
SKIPPED, never PASS. Supplier fixture generation pins its source/test hashes;
the JSON fixture alone is not proof of supplier provenance or live behavior.

The projection ignores the wider CUP booking window, units, weekly/monthly caps,
station surcharges, benefits, no-show extensions and activation capabilities.
It uses `SUBSCRIPTION_BENEFIT_ONLY` active count and
`usedOrReservedFreeMinutesToday` for the game's `Europe/Moscow` date. Both
counters are scoped to the selected `clientSubscriptionId` within the verified
tenant and actor; another instance of the same product never shares either
counter. They come from complete authoritative Viva reads plus instance-scoped
reserved operations, never browser input. Existing retries preserve same-operation
idempotency only. Distinct concurrent operations can still race between usage
read and reservation insertion; atomic per-instance quota reservation is a
pre-existing follow-up and is not established by this change. A pure repeatable
calculation is not proof of booking/payment idempotency.

The existing monetary calculation is reused: service 10,000 RUB is 1,000,000
minor units, and Viva transaction `discount` is a monetary amount, not a percent.
Mixed free/paid games compute minutes but remain blocked with
`LK1_GAME_OVERAGE_ALLOCATION_UNBOUND`; no proportional charge is invented.
The existing separate tournament Energy product has a 20,000 RUB base and is
not a substitute for this service.

Remaining wiring prerequisites: generic server-owned type lookup with no-rule
Viva fallback, existing authoritative purchase-date/sale-period selection,
unchanged underlying ownership/validity/past-event guards, and existing booking
plus discounted-payment dispatch/recovery. The real pilot type/version binding is
not server-verified. No legacy CUP/LK2 reserve/claim/worker/PG capability is required by the
new release, and no live candidate is prepared by this increment.

The user-selected pilot is `Падел.Дружба.ХАБ — годовая`, whose existing LK
catalogue provider product is `db7a5250-7369-4f43-8ac5-9111be24bc74`.
This product ID is not a subscription type ID. A fresh authoritative type/mapping
response is still required; fixture aliases and an unapplied historical activation
packet cannot establish the current binding. For the configured type, an
authoritative purchase before `2026-09-01` in `Europe/Moscow` keeps the existing
Viva/LK path without new calculations. The exact boundary belongs to the new
five-field rule. Missing or ambiguous purchase dates block only a configured rule;
confirmed absence of a policy must not require a purchase date.

### Earlier broad-runtime source contract (historical; not the new release DoD)

This checkpoint defines, wires and tests the first server-side policy evaluator
for the managed annual subscription model. It does not publish a CUP policy,
activate a Viva product, create a client subscription, change the live Node-RED
flow or perform a booking/payment mutation.

The evaluator source is:

`scripts/nodered_subscription_booking_nodes/fn_managed_subscription_policy_evaluate.js`.

The source-driven `/lk/subscription-bookings` candidate resolves a published
policy and actor-owned client instance through CUP runtime context before the
existing atomic claim and Viva read-back state machine. Production remains
unchanged until a separately approved fresh-flow build and deploy.

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
      "max": 4,
      "scope": "SUBSCRIPTION_BENEFIT_ONLY"
    },
    "bookingWindow": { "enabled": true, "days": 4 },
    "dailyUsageLimit": 1,
    "dailyUsagePolicy": {
      "actions": ["CREATE_GAME", "JOIN_GAME"],
      "limitExceeded": "PERCENT_DISCOUNT",
      "percentage": 30
    },
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
- duration-based units and daily/weekly/monthly usage limits; a missing
  `dailyUsagePolicy` keeps the historical all-actions `BLOCK` behavior;
- `dailyUsagePolicy.actions` can restrict the free daily quota to game create
  and join actions; `PERCENT_DISCOUNT` replaces the normal game benefit with a
  whole-price discount after the quota is exhausted;
- optional `dailyUsagePolicy.usageDurationsMinutes` restricts which durations
  consume that daily quota; absence preserves historical all-duration metering,
  while the PITER annual policy uses `[60]` so paid 90/120-minute discounts do
  not consume the separate free-hour allowance;
- maximum future bookings and minimum interval between services;
- ordered station rows: home station, selected station lists or all stations,
  each with its own fixed surcharge; equal-priority overlaps fail closed;
- exact action + category + event type + duration + product type + station
  benefit selection;
- `FREE_ENTITLEMENT`, fixed price, percent and fixed discount in RUB minor units;
- the evaluator still supports duration-specific partial-price benefits, but
  the PITER policy effective for sales from `2026-09-01` does not use them:
  60 minutes are free once per local day, while 90/120 minutes receive a 30%
  discount from the full server-resolved participant price;
- `dailyUsagePolicy.discountDurationsMinutes=[90,120]` narrows the post-limit
  30% override: a second 60-minute subscription action fails closed instead of
  inheriting that discount; the optional field preserves the behavior of older
  published policies that do not contain it;
- add-on products use the same appendable rule model with exact server-resolved
  product type, event type and stations;
- ambiguity and missing server base price fail closed;
- a matching `DISABLED` game benefit disables the discount only, while group or
  tournament use remains unavailable without an enabled matching benefit.

## Implemented source-driven flow wiring

The booking gateway candidate performs these source-driven steps:

1. send the authenticated LK Bearer and exact owned `clientSubscriptionId` to
   the internal CUP runtime-context adapter;
2. CUP resolves the actor-owned instance and verified provider mapping;
3. resolve event fields from Viva/read model, never from browser price/category;
4. merge complete active/history bookings and keep the atomic local day claim;
5. execute the policy evaluator;
6. on output 1, create one atomic day reservation and continue the
   existing Viva mutation/read-back state machine;
7. on output 2, return stable `409` blocker details without an upstream write;
8. release a reservation only after exact inactive booking/refund evidence.

The flow preserves legacy plan behavior when no managed mapping exists.
Once a product is explicitly mapped to managed runtime, missing/unpublished
policy evidence fails closed and does not fall back to hardcoded plan names.

## Reviewed production deployment

The managed-policy graph is deployed only from a clean, pushed `main` through:

```bash
NODE_RED_MANAGED_SUBSCRIPTION_RULES_DEPLOY=CONFIRM_147 \
  npm run nodered:managed-subscription-rules:deploy-147
```

The wrapper makes a new private live-147 pull, rebuilds the guarded candidate,
and creates an `exact-graph` contract. That contract permits changes only to
the exact fields of the split router, subscription HTTP request and atomic
booking router, plus the two named managed-policy nodes. It rejects removals,
any other existing-node change, any other added node and every HTTP-route
change. The remote installer verifies the same source, candidate and per-node
digests, writes private byte-identical backups, publishes atomically and
restarts only the existing `node-red` PM2 process. A restart, digest, public
games or subscription OPTIONS smoke failure requests the exact rollback.
The preflight accepts only a root-owned, single-link, non-symlink live flow
with mode `0600` or the historical Node-RED mode `0644`. Candidate, contract,
backup and every newly published or restored active flow are always `0600`.

The successful deploy prints a timestamped flow/contract backup pair. An
explicit rollback of that exact active candidate is:

```bash
NODE_RED_MANAGED_SUBSCRIPTION_RULES_ROLLBACK=CONFIRM_147 \
  npm run nodered:managed-subscription-rules:rollback-147 -- \
  YYYYMMDDTHHMMSS+ZZZZ
```

Neither command creates a booking, payment or Viva subscription. Authenticated
mutation canaries remain a separate approval after read-only postchecks.

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


## Game creation price preview

`POST /lk/subscriptions/game-price-preview` is an authenticated advisory read. It accepts
`target` (`NEW_GAME`, slot/station/room/master-service IDs, subServiceIds, startsAt,
durationMinutes 60/90/120, shareCount 2/4) and 1–20 unique `subscriptionIds`. The actor
comes from the bearer profile. Client-supplied actor, product, price and usage are rejected.

One batch reads current owned subscriptions, product mappings/catalog names, active and
historical bookings, durable HAB usage and the existing Viva court tariff. Cache misses
never start admin subscription lookups or projection writes. The isolated graph contains
only GET transport and Mongo find operations. It reuses source-bound booking helpers,
the unchanged HAB usage block, and the exact installed policy evaluator. The HAB purchase
cohort and legacy daily rules remain unchanged. Unsupported/uncertain policy, identity or
partial provider data fails the whole batch; a partial minimum is never advertised.

Each quote binds `selectionKey` to slot/station/room/master-service/sorted subservices/
start/duration/share count, returns AVAILABLE/LIMIT_USED/UNAVAILABLE, basePriceMinor,
amountMinor, freeMinutes/paidMinutes and a 30-second expiry. The date/time card displays
the lowest confirmed amount across the complete batch as “По подписке от … ₽”. Selection
of the concrete subscription remains on the next screen. Changing slot/account/IDs
invalidates the old result immediately. Freshness is validated at response receipt: an
already-expired or malformed response never becomes a displayed price. A valid display
snapshot is retained for the unchanged selection, without an expiry timer or automatic
refresh. Its age alone does not replace the displayed price with an error.

On the public CREATE payment-method screen each subscription row displays its own confirmed
participation price and paid-minute detail from that same complete batch. The overall minimum
is never assigned to another subscription. Failed initial reads or uncertainty hide row
prices; the user can explicitly retry the batched preview. Selecting a subscription does
not trigger another preview read. CREATE submits only the selected clientSubscriptionId,
not the display snapshot or its quoted amount; the existing server checks the chosen
subscription against current authoritative state before booking/write-off. Its rejection
is presented as the creation error, without silently choosing a different subscription.

Preview makes no reservation, booking, debit or payment; CREATE always rechecks current
authoritative state. Cross-midnight tariffs and unsupported regional policy reads remain
unconfirmed rather than guessed. The API requires an existing valid service token for
the room/station read; preview never refreshes that token.

Deployment is separate: apply the additions-only graph contract from
`scripts/patch_nodered_subscription_price_preview.mjs`, prepare the exact primary/reserve ingress candidates with
`scripts/nginx/prepare_subscription_price_preview.mjs` (dedicated `lk_subscription_price_preview_by_ip` zone at 60r/m,
burst 2, body cap 16 KiB, 30-second proxy timeouts, verified reserve TLS), then publish
frontend. Applying those artifacts requires separate owner approval. No existing
booking graph is replaced. Missing backend routing yields unconfirmed UI conditions.
The local graph harness uses `LK_PRICE_PREVIEW_FLOW_FIXTURE` pointing to an exact private
flow; raw provider flows must never enter Git. CI without that private fixture reports
those runtime cases as skipped, not provider proof.

Public CREATE keeps category/lifecycle-compatible candidates with at least one visit for preview and later selection: HAB can cover its free hour on 90/120-minute games with one visit. This is not a local entitlement decision. A legacy one-visit subscription can remain visible as a candidate, but the authoritative preview does not quote it as available and CREATE still rejects insufficient balance. Filtering that later candidate list by fresh server quotes is a follow-up UX improvement.

Install the matching `previewGuard('primary' | 'reserve')` in nginx's HTTP context before enabling this location. The primary guard reuses the existing `lk_subscription_product_limit_key` map, preserving the trusted reserve proxy exemption; reserve uses `$binary_remote_addr`. Catalog lookups retain their original limiter and cannot consume the preview quota. Guard and location must be installed together with exact preimages, backup, `nginx -t` and reload.


## R1 owner evidence producer (source-only opt-in)

Owner: LK subscription booking gateway; audience: internal CUP entitlement confirm/release.
The source adds optional proofs compatible with ph-admin #57 (`d5000a4d`): confirmation
uses existing `v1` bytes; release uses `release-v1`, the separate HMAC domain
`owner-evidence:release:v1` + one NUL byte and compact fields in this exact order:
`operationId`, `reason`, `providerBookingId`, `issuedAt`. The proof travels only in
`X-Subscription-Owner-Evidence`, never in the operation document or response payload.

Backend prerequisites (not installed or enabled by this change):

- `subscriptions_owner_evidence_enabled`: absent/false preserves unsigned legacy behavior;
  true enables the producer. Unknown values fail closed. This rollout option belongs to the
  subscription owner; activate only after receiver integration and provider sandbox acceptance.
  Review/remove the legacy option once all affected consumers accept owner evidence.
- `subscriptions_owner_evidence_secret`: backend-only string matching the receiver's existing
  `SUBSCRIPTIONS_OWNER_EVIDENCE_SECRET`, at least 32 UTF-8 bytes after trimming. Keep environments
  isolated; never obtain it from an HTTP request, flow export, browser, or committed settings.
- Trusted Node-RED `global.crypto` supplies the built-in Node `crypto` API. Its runtime availability
  has not been verified. Missing key/crypto or invalid configuration gives 202 reconciliation,
  never an unsigned fallback in enabled mode.

Confirmation requires an observed active booking with its own ID, matching actor, subscription
and exercise, and the persisted entitlement operation. A POST-only booking-ID fallback cannot
produce a proof. The normal readback and activation-recovery paths both support confirmation.

Cancellation requires complete authenticated active/history lists, the exact requested booking,
explicit booking cancellation (boolean cancellation flag or exact CANCELLED/CANCELED status),
consistent actor/target/subscription/date across matching rows and the canonical local operation.
Payment errors, refunds, archives and a cancelled exercise alone are insufficient. Only then can
CUP release its ledger; local release follows the exact CUP acknowledgement. Lost response leaves
local state pending; retry reads Viva again and uses the same entitlement operation. The proof
uses the observation timestamp, expires after at most 60 seconds locally, and never refreshes old
readback merely by resigning it. Receiver configuration may enforce a shorter age.

For booking POST rejection, only a response without a transport error and status
400/401/403/404/405/410/415/422 produces PROVIDER_REJECTED with explicit null booking ID.
This is the conservative definitive-rejection status set already used by the split CREATE flow;
provider sandbox acceptance of this endpoint remains required. Split CREATE now carries the
actual exercise-rejection receipt only after the PRECREATE_ATTEMPTING acknowledgement and finalize
handoff. It requires the original request operation, placeholder, actor, subscription/instance,
policy, station, room, date, start, duration and exercise type to match the stored recovery target.
A created, owned, adopted or recovered exercise cannot use this abort proof. Inherited receipts
are discarded. In signed mode, the exact rejection facts and original observation time are first
CAS-persisted on the existing booking operation, from `PRECREATE_ATTEMPTING` to
`PRECREATE_RECONCILIATION_REQUIRED`. The CAS binds the tenant, actor, LK/CUP operations,
subscription instance, original placeholder and full recovery target, with no created/recovered
booking binding. It never stores a token, signature, secret or raw provider response.

Only an exact readback of that immutable marker permits CUP release. A duplicate or lost Mongo
acknowledgement reads the first marker without overwriting its observation time. A fresh request
after context loss can resume release only within the original 60-second producer evidence window
(the receiver may require a shorter window), without a new CREATE POST. After CUP acknowledgement,
an exact marker CAS changes the existing operation to `RELEASED`; a lost local acknowledgement
reads back that result. A concurrent created/recovered binding or a mismatched marker stays pending.
Older source versions see reconciliation state and cannot resume CREATE from it.

An exact canonical `RELEASED` marker and matching release reason can replay the stored failure
after that window, without signing a new proof or calling CUP. Malformed, future-dated or mismatched
terminal markers stay pending. Evidence is never re-dated. Unfinished release with expired evidence
stays pending unless a read of the canonical CUP operation proves release already completed. After the
original 60-second window, a validated unfinished durable rejection uses only
`POST /api/internal/subscriptions/entitlements/readback` with
`{ operationId, subscriptionInstanceId }`, the existing actor Bearer and entitlement integration
token. This is a read-only request: no owner proof is generated, no release is dispatched and no
provider booking/payment write is attempted. Its response must have exactly `schemaVersion: 1`,
`operationId`, `subscriptionInstanceId`, `operationState`, `compensationState`, `releaseReason`,
and `providerBookingId`. Only the exact pinned operation/instance and
`FAILED / APPLIED / PROVIDER_REJECTED / null` permit the existing full-marker local CAS to
`RELEASED`. The original `observedAt` is unchanged. An already committed local result is replayed
without another CUP request; an ambiguous local acknowledgement reads the local marker again.

This path depends on ph-admin #59 (`70d3820`), the companion CUP actor/tenant/instance-scoped,
primary-majority readback implementation (itself dependent on #57/#58). Missing endpoint, disabled receiver, timeout, transport error, wrong response
origin, extra/missing fields, another operation/instance or any incomplete/different release remains
pending. In particular, it cannot release a reservation that CUP still holds. ph-admin continues
to require fresh owner evidence for release commands, including command replays; this read does
not extend that TTL or mint a new attestation. No new LK public endpoint, usage ledger, state enum,
secret, configuration flag or provider write is introduced here.
408/409/429/5xx, transport failures, empty history after an expired attempt, local pre-write
failures and generic operation failure are not signed. They remain pending in enabled mode. Existing
precreated-exercise reconciliation protection is unchanged, even after a definite booking refusal.

Stop signal: `SUBSCRIPTION_OWNER_EVIDENCE_NOT_CONFIGURED` or
`SUBSCRIPTION_OWNER_EVIDENCE_READBACK_REQUIRED`, or unexpected CUP refusal. Preserve reservations
and reconcile; do not disable evidence validation to force a release. Rollback is a reviewed
source rollback with compatible receiver mode, never automatic compensation. No deployment,
secret creation, provider write or flag activation is part of this source change. Full strict-mode
rollout still requires local-abort recovery, physical Mongo verification, the companion CUP
readback deployment and provider acceptance. Unit fixtures and green CI do not establish those outcomes.

## Managed JOIN owner v2 (source only)

The v1 external routes, JWT claims, request hashes and operation-ID derivation are
unchanged. v2 uses the same operation ID for a tenant/user/idempotency key: changing
version or an admitted binding conflicts instead of opening another operation.
There is no new activation flag. Existing receiver/execution gates, the canonical
managed product/purchase-date selector and the existing owner-evidence signer remain
mandatory. These sources do not install a flow, change configuration or activate a provider.

The separate internal routes are POST `/lk/integrations/v2/booked-operation-preflights`,
POST `/lk/integrations/v2/booked-operation-admissions`, and GET
`/lk/integrations/v2/booked-operations/:operationId`. v2 delegation requires
`contract_version:2`; preflight scope is `subscription-runtime.booked-operation.preflight`,
admission/read retain their respective existing scopes. Signed method, actual route,
actor token digest/expiry, tenant, actor/provider mapping, target mapping/version and
request hash must agree. Preflight forbids reservation_id; admission requires it;
read requires receipt_version 2. The operation ID still uses the v1 derivation domain.

The synthetic managed wire fixture is `scripts/tests/fixtures/managed-join-v2-contract.json`.
Preflight hashes ordered compact JSON under `booked-operation-preflight:v2` plus NUL;
admission uses `booked-operation-admission:v2` plus NUL. Preflight is nonbinding and
accepts only JOIN_GAME/USE_SUBSCRIPTION with the public target/revision. It verifies the
user-scoped provider profile, exact exercise and uniquely owned subscription by GET,
then evaluates the canonical gateway's exact selector closure extracted by the existing
source helper. It never creates a booking, reservation, usage ledger or Mongo row.
A positive unmanaged selection returns the same base fields with `management:"LEGACY"`
and no entitlement. Missing product/configuration, ambiguity, failed reads or missing CUP
mapping never imply legacy. A valid explicitly empty product allowlist may return legacy.
The managed branch reads CUP runtime-context and JOIN-only entitlement preflight with
existing credentials and exact trusted origins, and returns the canonical instance plus
policy version/digest and target snapshot ID/revision/evidence reference. Private provider
identifiers remain backend-only. The preflight decision does not authorize a paid fallback.

Admission stores the complete immutable v2 request before any CUP reserve. The canonical
booking prepare node accepts the tuple only as a restrictive precondition; it supplies no
authority to a direct caller. The gateway rechecks its managed selector, runtime instance
and effective policy and sends the original expectations to CUP. Before a new reserve the existing policy evaluator must select FREE_ENTITLEMENT from
the pinned effective policy; a zero-priced discount is insufficient. The CUP reserve
must also prove an ENTITLEMENT decision with zero final RUB price and positive integer units. Ambiguous,
malformed, mismatched or paid responses hold pending without booking or rewriting the
original expectations. No retry refreshes a possible-write binding. A cancelled or released
same operation cannot be reclaimed as a new v2 booking.

The verified v1 executor supplies a restrictive internal `lk2LegacyJoin:true` marker. It
is validated at canonical ingress and persisted on first operation creation. If selection
changes to managed, a new reserve/provider dispatch holds pending; canonical attempted
operations still use existing read/reconciliation paths. Direct LK1 callers without this
marker preserve their existing behavior. The marker cannot grant authority or bypass
actor ownership, and a malformed marker is rejected.

Only a read of the exact persisted admission and canonical owned booking may emit receipt
v2. The canonical row must be CONFIRMED, activation complete/not required, and the CUP
entitlement CONFIRMED. Policy and instance match the original admission; usageRef and
reservationUnits come from the persisted entitlement operation/decision. An outer receiver
CONFIRMED state alone is UNKNOWN. Pending confirmation, cancellation, missing/corrupt
bindings and ambiguous local acknowledgement never synthesize success. The API returns
no-store/no-referrer responses and never exposes integration tokens or owner proofs.

Current observer hashes describe changed source only. Historical PATRIOTS, deployment
allowlists and activation preimages remain frozen. Local tests and CI do not establish
provider/runtime acceptance; installing/activating these sources requires a separately
approved release with fresh custody and recovery evidence.

For new v2 operations, the entitlement-bind CAS also stores an explicit recovery context
before the provider POST: original runtime policy/instance/evidence, target, enforcement
identity, activation requirement/revision and verified FREE policy digest. It contains no
actor token, integration token or proof. A fresh authenticated actor profile precedes an
exact original-operation lookup before current selector/policy gates. The recovery lane
validates the immutable tuple and stored decision, then uses only a complete, exact-origin
provider GET with unique actor/exercise/subscription/date/booking matching. It confirms the
same CUP operation and applies conditional local confirmation/activation updates bound to
the original state, tuple and recovery context. Cancellation/reclaim races cannot resurrect
a row. This lane never calls reserve, repeats provider POST or reads a replacement policy.
Old or corrupt rows lacking recovery context stay UNKNOWN. Explicit valid selector
configuration and existing signing/CUP credentials are activation prerequisites, not locally
verified runtime facts; direct LK1 behavior with an absent selector configuration is unchanged.

A same-key v2 admission retry may carry the optional signed `recovery_only:true` claim.
Only true is accepted, only on v2 admission; it changes neither the original admission
body/hash nor its immutable delegation binding. The outer receiver requires the original
ATTEMPTING/UNKNOWN admission and fresh actor delegation, then claims a two-minute recovery
lease with a unique attempt ID. Competing/lost claim acknowledgements only read existing
state. The loopback owner request adds restrictive `managedJoinV2RecoveryOnly:true`; missing
canonical state cannot become a new admission, reserve or booking. Recovery finalization
CAS-matches its unique attempt so a stale response cannot overwrite a later recovery.
The ordinary v1 execution path and initial v2 admission semantics are unchanged. A refreshed
preflight, new seat or new usage reservation is never part of this retry.

Before either initial v2 execution or recovery, the receiver requires the inert local
owner GET probe with exact header value `2` and response
`{contractVersion:2,owner:"LK1_SUBSCRIPTION_BOOKING_OWNER",policy:"MANAGED_JOIN_V2"}`
from the exact loopback URL. Old ATOMIC_MANAGED_V1, missing capability, redirect or
unavailable owner stops before profile/claim/loopback mutation. Header `1` and its v1
response bytes remain unchanged. The existing canonical flow patcher prepends the probe
and canonical router into the same function body; its prepare/router/evaluator graph must
be deployed as one reviewed compatible packet. A probe fragment alone is not an install.
