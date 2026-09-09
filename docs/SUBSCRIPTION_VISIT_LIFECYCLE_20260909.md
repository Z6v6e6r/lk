# Subscription paid JOIN: visit lifecycle follow-up

Status: local implementation stage remains **BLOCKED** on the inverse operation and
ambiguous-outcome recovery. The new P2 HAR establishes a separate limit decrement;
it does not establish a complete visit debit/return contract.
Branch: `codex/subscription-join-payment-20260909`.
Base: `be2e395eebae6b6fee7e405fbfa87ef3e3e703bf`.
Previous local checkpoint: `3a9407077233e381d1a6d82da7241608d366c195`.

## Required behavior

A mixed JOIN creates one paid booking and checkout for the authoritative discounted
amount, and durably schedules one visit debit against the exact selected subscription.
Cancellation cancels that booking, removes the participant, starts the applicable money
refund and returns the same visit. The date's free 60 minutes become available again
only after the visit return is verified and allowance release is persisted. If debit
was never sent, a confirmed cancellation can release the allowance without a return.
An unresolved debit or return must not be repeated blindly or release the allowance.

## Local changes

- `scripts/lib/subscriptionVisitLifecycle.mjs`: server-only pure job/journal and Mongo
  CAS planners. A job is bound to one operation, client, subscription instance,
  exercise, booking and service date. Initial confirmation and job insertion share
  one proposed update. An acknowledged claim precedes each mutation intent;
  sent/unknown jobs produce verification tasks after restart. Cancellation during
  debit is preserved; a confirmed late debit schedules its inverse. Return evidence
  must identify the original debit. Persisted phases, receipts and identities are
  validated, including after restart. Release targets the old job/booking so a late
  worker cannot release a later JOIN.
- `scripts/nodered_games_nodes/fn_split_leave_daily_limit_route.js`: existing cancellation
  source keeps allowance reserved while subscription return is pending, while allowing
  roster cleanup to continue. Existing return-verification recovery re-enters this
  gate. Failed/malformed allowance reads retry instead of treating them as absent.
- `scripts/tests/subscriptionVisitLifecycle.test.mjs`: 16 fixture tests, including
  cancellation races, duplicate claims, ambiguous outcomes, corrupt restored jobs,
  exact identity, and actual quote usage before/after a persisted return release.
- `scripts/tests/subscriptionVisitLeaveGuard.test.mjs`: 5 source-function tests for
  pending/verified return, unchanged money-only path, failed reads and booking mismatch.
- `docs/SUBSCRIPTION_PAID_JOIN_FIX_20260909.md`, `docs/WORKLOG.md`: revised delivery status.

## Missing integration and release blocker

The new module performs no I/O. It is **not imported by a runtime flow**, does not
actually enqueue a job, and has no real dispatcher or Viva adapter. Its proposed
atomic confirmation update is not wired into the gateway. The leave guard addresses
the existing subscription-return state; the paid JOIN's future separate visit job
is not yet connected to that state. This patch therefore does not implement a working
end-to-end background debit/return service.

The original code/HAR inspection showed visit consumption through a SUBSCRIPTION
booking and return through that booking's cancellation. The new P2 HAR also establishes
a separate **limit decrement**, detailed below. It does not establish a corresponding
return, booking-linked consumption record, or operation-linked readback. A second
SUBSCRIPTION booking remains an invalid substitute because it creates another
participant/capacity claim.

Needed: a captured inverse adjustment on the same subscription instance and an actual
way to resolve a lost mutation response. The adapter must account for the observed
non-idempotent delta semantics. The current fixture-only requirements for provider
idempotency and operation-linked receipts are **not met** by this HAR; do not set those
capability flags to true or reuse the purchase transaction ID as a debit receipt.
Once these boundaries are resolved, wire the journal update, dispatcher, provider
adapter and cancellation recovery, then rehearse the full flow in approved isolation.

The earlier two-node paid-only candidate is insufficient for this expanded scope.
No new deploy artifact was generated from stale local flow snapshots. Source-function
checks here are not evidence that primary has this behavior. The original pending
HAR operation remains untouched, and its historical provider outcome is unconfirmed.

## P2 HAR evidence — 2026-09-09

Input: user-provided `viva-hub-p2-sanitized.har`, SHA256
`92c6fac34b48bfa462fd223e814ae3a7ae4d251f0cf6418303f1992a07b36410`.
Read offline as evidence only; no recorded request was replayed. Neither HAR contents,
customer IDs, tokens nor purchase transaction IDs were copied into the repository.
The file contains 10 entries: 2 list GETs, 3 limit PUTs and 5 OPTIONS requests.

Observed method (placeholders identify the exact client subscription instance):

```http
PUT /api/v1/clients/{clientId}/subscriptions/{clientSubscriptionId}/limit
Content-Type: application/json

{"type":"BY_VISITS","value":-1}
```

All three PUTs returned HTTP 200 and a subscription object whose `subscriptionId`
matched the request path. Entry indexes below are zero-based. Earlier list GETs
provided the initial counters; the first PUT response provides the second PUT's
baseline on the same instance.

| HAR entry | Instance alias | visitsTotal before → after | visitsLeft before → after |
| --- | --- | --- | --- |
| 4 | A | 365 → 364 | 365 → 364 |
| 6 | A, identical method/path/body | 364 → 363 | 364 → 363 |
| 8 | B, already has one booking | 365 → 364 | 364 → 363 |

A complete response-object comparison changes only `visitsTotal` and `visitsLeft`.
The `bookings` array, receipts, activation booking and existing `transactionId` are
unchanged. Therefore this observation proves a relative limit adjustment; it does
not prove that Viva registered a new visit or new transaction for the paid booking.
The used-count difference (`visitsTotal - visitsLeft`) remains unchanged.

An identical repeated PUT consumes another unit. The observed request must never be
blindly retried. The sanitized capture contains no idempotency key, conditional-write
header, request operation identifier, new response operation identifier or revision.
This does not prove that Viva has no such optional API feature; it leaves support
unverified. Its existing purchase `transactionId` cannot identify this adjustment.
There is no `value:1` request, inverse endpoint, or post-mutation GET in this capture.

Integration consequence: a local journal claim can prevent normal duplicate dispatch
but cannot establish exactly-once provider execution across a timeout/crash. A lost
response must remain unresolved and retain the free-minute allowance; a later balance
delta alone cannot attribute the change to this job under concurrent writers. An
explicit successful response can support a future request-bound adapter, but that is
a different evidence contract from the current operation-readback-only scaffold.
No adapter was connected or capability check weakened based on this incomplete trace.

Independent read-only payment/reliability inspection confirmed the delta semantics
and absence of inverse evidence. Next evidence needed from the user is a separate
one-visit return on the same instance, preferably followed by a fresh read of its
counters; no live adjustment was performed by this task.

## Checks and remaining evidence

P2 audit follow-up changed documentation only: parsed all 10 HAR entries, compared
all three mutation response objects with their preceding snapshots, inspected
header names and identity binding, ran `git diff --check` and a narrow added-text
credential/customer-ID scan. No runtime tests were rerun for documentation edits.
The test/build results below belong to the previous code checkpoints.

- New lifecycle and leave-guard suite: 21 PASS, 0 FAIL, 0 SKIP.
- Existing split-leave auth/router, subscription-instance and shared-daily-limit suite:
  117 PASS, 0 FAIL, 1 optional SKIP.
- Full repository lint: 0 errors, 387 pre-existing warnings. Scoped follow-up lint
  passed for the new module/tests after final cleanup.
- Independent payment/reliability review completed; corrected phase validation and
  ambiguous-read handling; no remaining blocking local findings at final review.
- Prior checkpoint typecheck and source modular validation passed. Full frontend build
  remains blocked by missing ignored VITE environment configuration, before compilation;
  it is not a successful build and was not rerun without changed inputs.
- No new flow composition/validation or physical provider/DB/worker/UI proof for this
  follow-up. In-memory fixtures verify local transitions, not concurrent Mongo or
  real provider effects. Retry scheduling, provider error observability and operational
  recovery still require the runtime integration.

No push, merge, deploy, provider debit, refund, booking cancellation, or shared data
mutation occurred. Existing primary checkout changes were preserved.
MODEL_ROUTE: parent
