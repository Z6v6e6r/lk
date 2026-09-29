# LK1 unpaid event booking cancellation

## Scope

The worker handles **new** LK1 group-training and tournament bookings with a durable
SMS checkout, positive amount, `subscriptionVisitCount=0`, and an `ON_PLACE` Viva
carrier. `ON_PLACE` alone is not an unpaid-payment signal. Open games already have
the split lifecycle. Events that consumed one subscription visit need a separate
return-of-visit design and are excluded.

The worker checks the exact operation, checkout, transaction intent, amount, owner,
exercise, and booking. Viva does not always echo the owner and booking in its
transaction GET; the stored intent and exact transaction ID bind those fields,
and any aliases Viva does return must match. Viva's fresh transaction must be exactly `UNPAID`, have a
valid zoned `paymentDueDate` at least 60 seconds in the past, and contain no paid
or refund evidence. Unknown, partial, `WAITING`, and `PAID` statuses never cancel.
The event must not have started when a new cancellation is claimed.

## Operation and recovery

`scripts/run_lk1_unpaid_booking_cancellation.mjs` is a long-running 120-second
scanner. It requires `--run`, a tenant, a fresh explicit RFC 3339 cohort cutoff,
`LK1_UNPAID_CANCEL_MONGO_URI`, and `LK1_UNPAID_CANCEL_TOKEN_FILE`. The token file
must contain the Viva admin bearer token and be readable by the worker process.
`LK1_UNPAID_CANCEL_DB` defaults to `games`. `--once` processes one bounded page
for inspection. The code never starts during a build or import.

Modes:

| Mode | Effect |
| --- | --- |
| `OFF` (default) | No Mongo or Viva connection. |
| `SHADOW` | Fresh provider readbacks and redacted candidate results; no writes. |
| `ENFORCE_NEW` | Cancel only operations created at or after the cutoff. |

Before a Viva write, a majority-journaled Mongo compare-and-swap stores
`lk1.unpaidCancellation.phase=INTENT`. The worker rechecks the transaction and
booking, probes `cancellationOnly.available`, and sends one client-scoped Viva
`PUT /bookings/{bookingId}/cancel` with `refundMethod=NONE` and
`cancelExercise=false`. It releases the LK1 claim only after exact canceled
booking readback and a final exact `UNPAID` transaction readback. A 2xx or 404
response to the cancel request is never cancellation proof.

If the process stops after Viva accepts cancellation, the next pass finds the
durable `INTENT`, confirms the canceled booking and unpaid transaction, then
releases the claim. If the booking remains active after an ambiguous attempt,
the intent moves to `REVIEW` and the worker does **not** send another cancel.
Provider/read failures leave `INTENT` for a later read-only reconciliation. The
LK1 ingress will not replay a stored payment link once an intent exists. A
cancelled operation cannot be retried with the same deterministic operation ID.
The current widget derives that ID from client, subscription and exercise, so it
cannot initiate a second booking for the same exercise after automatic cancellation.
That rebooking journey needs a separate safe successor-operation contract.

Logs contain a short SHA-256 operation label and state/reason only. Inspect
`REVIEW`, `PRECHECK_REQUIRED`, and `RETRY_STORE` before enabling or widening a
cohort. The Mongo operation is the durable audit record; do not log checkout
URLs, phone numbers, bearer tokens, or raw provider responses.

## Release and activation

This change ships code only. Deploying a runner or setting `ENFORCE_NEW` is a
separate live-state authorization. To prepare that transition, pin the deployed
LK1 gateway and Viva cancel API contracts, configure a fresh cohort cutoff,
observe a full payment-deadline window in `SHADOW`, and verify an exact natural
case in Viva and Mongo after activation. Keep the current live Node-RED flow as
the source for any later gateway release; do not rebuild it from a stale local
snapshot. Test graceful stop, token rotation, backup, and restart before enabling
the worker on production.

The remaining provider race is a payment arriving between the last transaction
GET and cancellation PUT. The final transaction GET prevents a local claim
release if payment appears, leaving the operation for manual reconciliation.
