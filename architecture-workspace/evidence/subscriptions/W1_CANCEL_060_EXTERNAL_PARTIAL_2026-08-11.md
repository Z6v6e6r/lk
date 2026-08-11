# Partial Cancellation Evidence — CREATE 60 Follow-up

Observed: 2026-08-11, `Europe/Moscow`.

Cases:

- `GHAR-BKG-CREATE-060`;
- `GHAR-CAN-SELF-SERVICE` candidate follow-up.

Evidence status: `PARTIAL_EXTERNAL_ACTION_NO_HAR_AMBIGUOUS_BALANCE`.

This report contains aliases and non-sensitive values only. Exact ids and the
source screenshots remain in the private evidence registry outside Git.

## New provider evidence

The second user-supplied Viva action-history screenshot confirms:

- the create debit at 10:40 local time: `15 -> 14`;
- a first later Client-labelled return at 10:56: `14 -> 15`;
- several additional Client and station-labelled balance mutations after that;
- the latest visible balance in the supplied screenshot is `17`.

Therefore the create delta is now confirmed, but cancellation attribution is
not isolated. The `14 -> 15` row is the expected return candidate, not Golden
proof that the exact test booking caused it.

## Fail-closed cancellation attempt

Before sending any cancellation command, the exact test target was checked
again.

Observed:

1. A hard refresh removed `game-create-060-a` from active cabinet bookings.
2. Exact direct game readback returned `Game not found`.
3. The LK cancelled-history surface contained the exact 22 August,
   07:00–08:00, Yasenevo 60-minute service with state `Отменено`.
4. The active subscription remained visible in the cabinet.

Decision: no cancellation request was sent. Retrying an already-cancelled game
could cause duplicate cleanup, a second return attempt or misleading evidence.

## What is proven

| Contract | Result |
|---|---|
| Synthetic subscription create consumed one visit | `CONFIRMED`, `15 -> 14` |
| Exact test game left active cabinet after cancellation | `CONFIRMED` |
| Exact test game direct lookup after cancellation | `Game not found` |
| Exact service visible in cancelled history | `CONFIRMED` |
| Publication residue after cancellation | None observed in the previously cleared detail surface |
| Codex sent a duplicate cancellation | `NO` |

## What is not proven

- who initiated cancellation;
- which provider cancellation option/refund method was selected;
- exact cancellation request and response;
- exclusive causal attribution of the `14 -> 15` row;
- idempotent retry behavior;
- raw HAR for create or cancellation.

The subscription was mutated by other actions during the evidence window. That
violates the single-writer requirement and prevents promotion to Golden HAR
evidence even though the final user-facing cleanup state is correct.

## Required clean rerun

1. Reserve an exclusive mutation window for one tester subscription.
2. Record balance immediately before create or join.
3. Perform one action and capture raw HAR.
4. Record balance and exact active/history readback immediately after.
5. Perform one cancellation with the selected provider option visible.
6. Capture raw HAR and immediate balance/readback before any other mutation.
7. Verify a second cancellation attempt is blocked by readback without sending
   another provider refund.
