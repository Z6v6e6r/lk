# Recovery of cancelled subscription games

Owner: LK1 subscription booking gateway. Audience: players joining games with a
subscription, and operators reconciling a specific historical cancelled booking.

A historical confirmed-claim reconciler could mark an operation `RELEASED`
after seeing its cancelled booking without checking the payment leg or return
of the subscription visit. The daily guard correctly refused that incomplete
release, while the split finalizer converted its durable pre-write refusal into
`202/PENDING_CONFIRMATION`. Repeated checks could not resolve that state.

## Runtime change

`prepare_reconciled_cancellation_recovery.mjs` consumes a verified private live
workspace and composes only the `func` fields of:

- `lk_subscription_booking_router_20260804`;
- `lk_subscription_booking_finalize_20260804`;
- `bcc3dccf8d64f9bb` (legacy split cleanup).

It preserves the complete graph, native order, existing legacy/native cancellation
protocols, HTTP/Mongo wiring and unrelated node fields. The local six-output cleanup implementation is never
substituted for the installed four-output function; four exact deltas preserve
its existing architecture. Exact function preimages,
whole-source SHA, syntax and inverse reconstruction are required. Reapplication
or source drift fails closed. Raw flows/candidates stay outside Git.

For a historical reconciler-released paid `open_game`, a new split JOIN may read
the exact old booking, transaction and complete subscription list. The request
must prove explicit cancellation, a closed expired unpaid online attempt, no
booking-level separate settlement, exact money/binding, and a balanced unique
consumption list with no remaining booking on that Moscow service day. It then
rereads the unchanged old operation and uses the existing majority+j owner CAS.
All reads belong to the same request and a 30-second window. The proof is not
persisted as a native refund and never authorizes a provider write or replay of
the old operation. An inconsistent visit balance remains blocked for repair.

A durable refusal of a bound split JOIN before any booking/create/money/visit
effect now remains `409` with its original message. The actual split ingress
does not supply `action=book`; its caller, managed action and split context bind
this exception. Split CREATE and uncertain outcomes retain `202`.

The out-of-band confirmed-claim reconciler now holds money/create/visit cases
for their dedicated recovery rather than declaring them released from booking
evidence alone. Its runtime installation is a separate release target from the
two Node-RED functions; this change does not install or restart a service.

## Preventing the original loss

The timeout cleanup previously treated a verified unpaid **surcharge** as proof
that the whole booking should be cancelled with `NONE`, even when the booking
also consumed a subscription visit. The provider audit and cleanup trace can
therefore show a visit debit followed by a no-return cancellation.

The bounded prevention patch adds a fresh exact booking read for non-actor admin
cleanup too. Only an explicitly ordinary ON_PLACE booking, consistent identity,
state and absence of other payment/prepaid evidence may continue with NONE.
Subscription, prepaid, foreign, unknown or conflicting financial evidence holds
the cleanup before cancellation and before any whole-exercise fallback. It does
not introduce SERVICE without a durable cancellation owner. The retained booking
requires reconciliation; this patch prevents another lost visit and does not
claim to implement automatic refund of paid subscription game visits.

## Explicit single-booking visit repair

`repair_cancelled_subscription_visit.mjs` defaults to dry-run and requires a
private exact target file, a new private output directory, and an expected flow
SHA. The target file contains only `actorClientId` and `operationKey`. It never
scans or repairs other clients. The SERVICE mode never changes the daily guard.

An optional separate `--handoff-target-key-file` mode performs no SERVICE or
other provider write. Its private file names the exact already-refused target
operation. After a completed repair, it requires another fresh provider readback,
the unchanged terminal owner, the untouched FAILED409 target and the exact old
guard. Dry-run produces a separate digest. Apply uses one replica-set transaction
to fence both operations, transfer the guard and attach the repair audit. Exact
whole-document CAS and snapshot isolation protect concurrent target retries;
partial writes abort together. The target remains FAILED with no booking/payment,
so the next explicit user retry performs normal fresh usage and price checks.
It does not book a game. Before backend activation this handoff serves only the
named target; moving to another game may require fresh reconciliation.

The supported case is one missing visit after an already cancelled subscription
booking with an expired unpaid surcharge. Before SERVICE it requires the same
binding/payment/consumption checks as runtime, an exact one-visit counter gap,
and the current provider cancellation option for that exact booking. Group,
exercise cancellation, executor and addon/package effects are rejected. Unknown
option shapes also hold the repair.

The current official CRM client selects `SERVICE` from the exact subscription
option and sends `{refundMethod:"SERVICE", cancelExercise:false}` to the booking
cancellation endpoint. This is distinct from the native zero-money cancellation
protocol, which deliberately requires an active booking. Reverify this provider
contract before using the recovery tool against a changed API.

After a positive dry-run, apply requires its unchanged plan digest. The repair
uses the native subscription return lock and a stable per-booking repair job.
It repeats provider and ledger checks under that lock. Only the direct majority
ACK of `QUEUED -> SERVICE_INTENT` permits one SERVICE request. No external write
is retried. Lost intent ACK, network failure, non-200, failed proof persistence
or inconsistent postcheck preserves the intent and lock for read-only recovery.
Known pre-intent failures CAS only the exact QUEUED job to DECLINED, allowing
normal native lock takeover; no foreign lock is deleted.

Accept success only after direct HTTP200 and an exact readback: total visits
unchanged, visits left increased by exactly one, the same other consumption
bookings, the old booking still cancelled and the surcharge still closed/unpaid.
A separate repair proof honestly records target absence before and after the
repair. Do not manufacture a native before/after refund receipt, reset money
fields, increase subscription limits, delete guards or replay a booking.

## Provider refusal observed during the incident

A positive exact cancellation option is not a guarantee that an already-cancelled
booking can be returned again. The provider rejected the incident's single
SERVICE request with HTTP400/BAD_REQUEST, “Запись уже отменена”, despite offering
the subscription option. Subsequent full readback and subscription audit showed
no visit return. Do not retry that request or transfer the daily guard while
consumption remains inconsistent. A provider-side correction is required.

The incident's own repair intent was separately classified DECLINED only after
that direct refusal, unchanged fresh readback and full-document majority CAS.
Its intent/baseline and receipt digests were preserved; the common lock was not
deleted, and the original business guard was unchanged. This is an addressed
operator resolution of a proven rejection, not a blanket “400 means no effect”
rule and not a successful visit-return proof.

## Verification and activation

Regression tests cover malformed/foreign provider evidence, separate booking
payment, root effects, duplicate consumption, same-day use, stale reads, owner
drift, lost/contended guard ACK, finalizer uncertainty, two concurrent repairs,
lost lock/intent ACK, pre-dispatch cleanup and unknown SERVICE outcomes. The
critical subscription CI matrix includes both new suites and the reconciler
suite. Local full builds may use the existing CI inert compile-time configuration;
they are compilation evidence, not a production artifact.

Before activation, use a fresh authenticated active-flow readback, clean editor,
reviewed exact candidate and current worker binding/recovery procedure. A changed
flow can stop workers pinned to the previous generation; preserve and validate
their current generation rather than relaxing a guard. Merge, Node-RED activation
and worker installation require the current session's applicable release authority.

Stop signals: changed source/runtime, conflicting editor/lease, changed target,
provider identity/payment/count drift, another return in flight, unknown ACK or
unexpected provider effect. Stop before the next write and retain private receipts.
Do not repeat SERVICE or apply a destructive rollback to make a check pass.
Withholding the candidate prevents new runtime behavior; restoring reviewed source
does not undo a completed visit return or any other external operation.
