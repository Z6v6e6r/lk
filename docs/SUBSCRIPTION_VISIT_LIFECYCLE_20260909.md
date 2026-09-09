# Subscription paid JOIN: visit lifecycle follow-up

Status: local implementation stage remains **BLOCKED** on the provider contract.
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

Inspected project code and available HAR samples show visit consumption through a
SUBSCRIPTION booking and return through that booking's cancellation. They do not
establish an independent debit/return method for an ON_PLACE booking. A second
SUBSCRIPTION booking would create another participant/capacity claim and is not a
valid substitute. No undocumented provider method or balance mutation was invented.

Needed: the actual backend/provider method, request and response for separate debit
and return, operation-linked readback, and retry/idempotency semantics. Once supplied,
wire the journal update, dispatcher, provider adapter and cancellation recovery; then
rehearse the complete flow against fixture-owned services and the approved DEV target.
A fixture's adapter capability flags are not evidence of provider capabilities.

The earlier two-node paid-only candidate is insufficient for this expanded scope.
No new deploy artifact was generated from stale local flow snapshots. Source-function
checks here are not evidence that primary has this behavior. The original pending
HAR operation remains untouched, and its historical provider outcome is unconfirmed.

## Checks and remaining evidence

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
