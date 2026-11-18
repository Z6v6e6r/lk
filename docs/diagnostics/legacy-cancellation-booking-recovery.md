# Booking after legacy subscription cancellations

Owner: LK1 subscription gateway. Audience: maintainers and release reviewers.
The candidate removes an obsolete daily-visit reservation only after current
read-only evidence confirms that its cancelled booking no longer consumes the
subscription. It also preserves a durably saved pre-provider refusal as HTTP409.
Production activation is a separate authorized operation.

## Cause and scope

Legacy `action=release` wrote `RELEASED`, `releaseBookingId`,
`releasedBookingIds` and `releasedAt`. It did not write either a verified native
`SERVICE` return receipt or a `GAME_LEAVE` receipt. The newer daily guard requires
one of those origins before transferring ownership. Consequently usage/pricing
already ignored the released operation, but its daily guard still rejected a new
free event. Retry could not resolve this discrepancy.

The router durably recorded `FAILED / LK1_DAILY_VISIT_CHANGED` before creating a
new booking. The LK1 finalizer then converted that409 to202 and omitted the
message. The widget correctly used its pending fallback for that malformed
response. The correction belongs in the backend contract; no frontend text or
pricing rule changes are necessary.

The compatibility path applies to authenticated HTTP booking requests for native
zero-money subscription records. It covers a different event on the released
service day and HTTP replay/explicit successor for the same event. Existing
operation identity, fingerprint, rejoin generation limit and predecessor lineage
checks still run. Other money, managed-entitlement, LK2 and split command paths
retain their recovery rules.

## Readback and concurrency contract

1. Require a canonical native operation, `RELEASED`, exact released-booking IDs,
   valid timestamps, no modern release origin and no money/visit adjustment.
   Actor, tenant and subscription must match the authenticated request. At the
   daily guard, service date and server-owned product must match too.
2. GET the exact client's old booking. Require all booking/actor/exercise/
   subscription bindings, subscription payment and agreeing cancelled flags.
   Missing identity,404, timeout or redirected response cannot prove cancellation.
3. GET the owner's complete subscription list, bounded to fewer than200 rows.
   Require exactly one instance with the expected product, consistent integer
   visit counters, unique consumption IDs, no conflicting identity aliases,
   at least one remaining visit and absence of the old booking from consumptions.
4. Reread the old Mongo operation and require its entire snapshot unchanged.
   The request-local evidence expires after30seconds and never changes historical
   release records, return receipts or subscription counters.
5. Run the existing daily-guard compare-and-set against the old owner with
   majority+journal acknowledgement. A lost/conflicting ACK rereads the guard;
   it never grants ownership from an ambiguous update. Existing prewrite gates
   for pending free-cancellation jobs remain in place before new booking writes.

The evidence proves **current non-consumption**, not a historical `+1` refund.
No `PUT /cancel`, `SERVICE`, fake before/after receipt, backfill or guard deletion
is involved. A newly explicit booking still goes through fresh availability,
subscription validity, policy and atomic operation checks.

The409 exception is intentionally narrow: a server-owned operation/fingerprint
marker is minted only after the daily-conflict persistence ACK; the finalizer
also checks the HTTP action, exact stage/code/message and absence of create,
booking, transaction or entitlement effects. Unknown or paid outcomes remain202.
Stop signal: readback mismatch, changed owner, stale evidence, ambiguous ACK or
foreign guard owner. Stop method: existing reconciliation/refusal response before
any new provider write.

## Source-driven candidate

`prepare_legacy_cancellation_recovery.mjs` changes only `func` on:

- `lk_subscription_booking_router_20260804`;
- `lk_subscription_booking_finalize_20260804`.

There are no route, wire, config, dependency, startup, worker or schema changes.
Every edit has an exact inverse; the composer validates its two-function graph
contract and rejects disabled targets, unexpected preimages and repeated apply.
Raw source, candidate and contract stay in a private external workspace.

```sh
npm run nodered:modular:pull-147 -- /private/tmp/NEW-PRIVATE-WORKSPACE
node scripts/prepare_legacy_cancellation_recovery.mjs \
  /private/tmp/NEW-PRIVATE-WORKSPACE EXPECTED_WHOLE_FLOW_SHA256
```

The CLI accepts only the reviewed router/finalizer pins committed in the
patcher. Changed functions require source review and an updated patch, never
blind hash replacement. Candidate construction does not deploy or authorize
execution. Do not run the quarantined broad modular regeneration/export chain.

## Validation

```sh
node --test scripts/tests/legacyCancellationRecovery.test.mjs
LK1_LEGACY_CANCEL_LIVE_SOURCE=/private/path/input/source.flow.json \
  node --test scripts/tests/legacyCancellationRecovery.test.mjs
```

CI runs synthetic maintained guard/protocol/finalizer fixtures, including
mismatched identities, incomplete/duplicated consumption, changed owner,
concurrent ownership, lost ACK, replay lineage and money/unknown negative cases.
The optional private check composes and executes the exact installed full
router; production data is never used as a committed fixture.

For the incident, a private read-only acceptance check applied the exact new
predicate to both released operations and fresh Viva DTOs. Both passed current
cancellation and non-consumption checks. This is read-only eligibility evidence,
not an observed successful new booking or a deployment result.

## Activation and recovery limits

Before any separately approved activation, capture fresh disk/active/editor
state, review the exact graph and dependent-worker guards, rehearse and follow
the reviewed-flow release procedure. A backend flow-byte change can invalidate
worker binding even when its business code is untouched. Worker restoration or
re-pinning is not authorized by this PR.

Observe a natural affected booking after activation. Do not automatically replay
real booking/cancellation/payment operations as smoke tests. A code rollback must
use the exact guarded inverse and current runtime custody; reverting code does
not undo any completed booking or guard ownership transition.
