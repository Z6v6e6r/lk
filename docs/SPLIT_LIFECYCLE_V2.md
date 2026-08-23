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

The autonomous scheduler is restricted to an explicit creation cohort. `SPLIT_LIFECYCLE_V2_ENFORCE_FROM` must be a valid RFC 3339 timestamp with a timezone. Only games whose canonical top-level `createdAt` is equal to or later than that cutoff are eligible. The Mongo query applies the cutoff first, and the prepare function validates it again before creating any provider task. A historical game, a missing or invalid `createdAt`, or a missing or invalid cutoff is excluded fail closed.

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
- `SHADOW`: default; with a valid activation cutoff, selects due work only from the new cohort and returns dry-run summaries without Viva mutations.
- `ENFORCE_NEW`: with the same valid activation cutoff, enables the autonomous expire and cancel path only for that cohort.

`SPLIT_LIFECYCLE_V2_ENFORCE_FROM` is mandatory for both `SHADOW` and `ENFORCE_NEW`. If it is absent or invalid, the scheduler returns `activation_cutoff_missing` or `activation_cutoff_invalid` before acquiring its lease or issuing a Mongo query. `OFF` does not require the cutoff. The authenticated manual cleanup route is not cohort-limited and keeps its existing authorization, exact-target, and provider read-back guards.

Changing either runtime variable is a separate feature-activation gate. Deploying the candidate does not implicitly authorize a cutoff or `ENFORCE_NEW`.

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

1. Default mode is `SHADOW`, but it performs no query without a valid explicit cutoff.
2. `OFF` performs no query lease or mutation.
3. Missing, malformed, or impossible-date cutoffs stop before lease and Mongo.
4. Mongo receives `createdAt >= cutoff`, and prepare independently excludes historical, missing-date, and invalid-date rows.
5. The exact cutoff boundary is eligible; a row one millisecond earlier is not.
6. `ENFORCE_NEW` must be explicit and never expands the cohort.
7. Overlapping ticks are skipped while the five-minute lease is active.
8. Empty and completed passes release the lease and do not write to an HTTP response node.

## Release and observation gates

1. Build the cutoff hotfix from its pinned live `flows.json` preimage with `scripts/patch_live_split_lifecycle_v2_cutoff_hotfix.mjs`.
2. Validate that only `Build split cleanup query` and `Prepare split cleanup tasks` changed, with unchanged topology and HTTP routes.
3. Deploy the hotfix while runtime remains `SHADOW` and no cutoff is configured; the scheduler must report `activation_cutoff_missing` and perform no Mongo query.
4. Under a separate configuration gate, choose a fresh approved cohort timestamp and set `SPLIT_LIFECYCLE_V2_ENFORCE_FROM` while remaining in `SHADOW`.
5. Observe at least one full payment deadline window and verify only aggregate summaries for the new cohort. Historical eligible/task counts must remain zero.
6. Activate `ENFORCE_NEW` only after another separate approval, without changing the approved cutoff.
7. Post-check exact transaction, booking, exercise, and LK game state for a naturally occurring post-cutoff unpaid case. Do not create a payment or booking for the post-check without explicit authorization.

## Residual risk

A host or process loss after Viva accepts exercise creation but before Node-RED receives the exercise ID cannot be compensated by ID. The v2 flow never blindly retries that POST; such a case remains a manual reconciliation item. A durable provider-operation ledger with exact slot lookup is the next hardening layer for this narrower crash window.

The Mongo prefilter relies on the existing create flow writing canonical ISO strings to top-level `createdAt`. The independent prepare check is the destructive-action boundary: it rejects any unexpected representation instead of trusting the database filter alone.
