# Split booking lifecycle v2

## Goal

Prevent two failure modes in the split-payment game flow:

1. Viva exercise exists without a client booking after booking creation fails.
2. An expired unpaid booking remains active because the client never returns to the browser.

The browser return URL is a synchronization hint only. Payment and deletion decisions are made from exact Viva read-back on Node-RED.

## Creation compensation

For a newly created split exercise, Node-RED marks the exercise as owned by the current request. A conflicting or reused exercise is never owned by that request.

If the following booking request fails:

1. Read `GET /api/v1/exercises/{exerciseId}/bookings`.
2. If exactly one booking matches the expected client, resume from that booking without retrying the POST.
3. If the exercise has no bookings, delete only the owned exercise.
4. Read `GET /api/v1/exercises/{exerciseId}`.
5. Treat only `404` as verified compensation.
6. On an unavailable or ambiguous read-back, keep the exercise and return `RECONCILIATION_REQUIRED`; never perform a destructive guess.

This closes the observed `exercise created -> booking failed -> empty exercise remains` path and prevents deletion of a reused or non-empty exercise.

## Unpaid booking reconciliation

An internal Node-RED inject runs every 120 seconds with a five-minute overlap lease. It uses the existing split cleanup pipeline and never depends on an open browser tab.

Before cancelling a timed-out participant booking, the worker reads the exact Viva transaction and validates:

- exact transaction ID;
- exact booking ID association;
- client association when Viva returns it;
- amount equality when both sides contain an amount;
- canonical Viva status.

Status handling:

| Viva status | Action |
| --- | --- |
| `PAID` | Restore the participant/payment projection; do not cancel. |
| `UNPAID` | Continue to exact booking cancellation and cancellation read-back. |
| `WAITING` | `POST /transactions/{id}/expire`, then read the transaction again. Cancel only if the second read is exact `UNPAID`. |
| `REFUND`, `PARTIALLY_REFUNDED`, `PARTIALLY_PAID` | Manual review; no automatic deletion. |
| Unknown status, binding mismatch, missing transaction ID, or provider error | Fail closed; no automatic deletion. |

Local game state is changed only after Viva cancellation is verified by the existing client or exercise booking read-back.

## Feature modes

`SPLIT_LIFECYCLE_V2_MODE` controls only the autonomous scheduler:

- `OFF`: scheduler is skipped.
- `SHADOW`: default; selects due work and returns dry-run summaries without Viva mutations.
- `ENFORCE_NEW`: enables the autonomous expire and cancel path.

Changing this variable is a separate feature-activation gate. Deploying the candidate does not implicitly authorize `ENFORCE_NEW`.

## Regression test series

Creation:

1. Booking failure starts booking read-back, not exercise deletion.
2. Exact recovered booking resumes the flow without retrying the booking POST.
3. Verified empty owned exercise is deleted and read back as absent.
4. Reused or conflicting exercise is never compensated.
5. Ambiguous or non-empty read-back fails closed.

Payment cleanup:

1. Exact `UNPAID` proceeds to the scoped booking cancellation probe.
2. `WAITING` expires and is read back before cancellation.
3. `PAID` restores local paid state.
4. Provider error, partial state, unknown state, wrong transaction, wrong booking, and missing transaction ID all fail closed.
5. Successful cancellation still requires exact post-verification before the LK projection changes.

Scheduler:

1. Default mode is `SHADOW`.
2. `OFF` performs no query lease or mutation.
3. `ENFORCE_NEW` must be explicit.
4. Overlapping ticks are skipped while the five-minute lease is active.
5. Empty and completed passes release the lease and do not write to an HTTP response node.

## Release and observation gates

1. Build the candidate from the pinned live `flows.json` preimage with `scripts/patch_live_split_lifecycle_v2.mjs`.
2. Validate changed node IDs, unchanged HTTP routes, and the single added inject node.
3. Deploy with `SPLIT_LIFECYCLE_V2_MODE=SHADOW` only after the deploy gate is approved.
4. Observe at least one full payment deadline window and inspect only aggregate debug summaries.
5. Activate `ENFORCE_NEW` only after a separate approval.
6. Post-check exact transaction, booking, exercise, and LK game state for a naturally occurring unpaid case. Do not create a payment or booking for the post-check without explicit authorization.

## Residual risk

A host or process loss after Viva accepts exercise creation but before Node-RED receives the exercise ID cannot be compensated by ID. The v2 flow never blindly retries that POST; such a case remains a manual reconciliation item. A durable provider-operation ledger with exact slot lookup is the next hardening layer for this narrower crash window.
