# Recovery for paid split joins

The ordinary participant join previously returned a Viva checkout and relied on the
browser to add it to the game with a subsequent PATCH. If this PATCH lost a race,
the active provider booking still occupied a slot and the user lost the link.
Repeating JOIN could then collide with the existing Viva booking.

The primary legacy public split join can now store one current attempt in
`lk_paid_split_join_checkouts`. The key binds the game's tenant, game, exercise and
the actor verified by Viva's user-token profile. An acknowledged majority-journaled
claim is required before creating the booking. State transitions bind the exact
attempt. The paid transaction request gets its own durable checkpoint before the
provider call. Existing provider price verification remains in the router.

When the invoice is available, the router records the exact checkout and projects
the pending participant into the latest game revision before returning 201 with
`checkoutStored: true`. The two legacy browser entry points use the returned attempt
and leave the existing payment/leave actions in the game card. Neither entry point
issues its own roster PATCH for that response. On a game CAS conflict, the server
rereads and reapplies only the actor's pending payment and waitlist row. Successful
replays reuse the original link, booking, transaction and payment reference.

After a lost transaction acknowledgement, a retry can read the authenticated
actor's complete Viva transaction page and recover a unique transaction bound to
the exact booking and charge. A lost booking acknowledgement or an incomplete,
ambiguous or contradictory provider read remains pending. It does not send another
booking or transaction request. Partial attempts of this kind require reconciliation.
The change has no backfill for existing untracked orphan bookings.

When recovery first finds an already expired checkout on an active booking, it
projects the exact attempt without a usable link so existing cleanup can process it.
A new generation requires the prior checkout to be terminal at Viva, the exact
booking to be cancelled without any settlement or visit credit, and the actor to
be absent from the live game booking list and active LK roster/payment state.
A client-side timer or an LK `EXPIRED` marker alone cannot open another attempt.
The payment deadline and existing cancellation worker are unchanged.

## Candidate preparation

On a private, freshly verified 147 disk-flow workspace outside Git, run:

```sh
node scripts/patch_live_paid_join_recovery.mjs /absolute/private/workspace /absolute/private/workspace/candidate.flow.json
```

The candidate changes the primary join prepare and split router function nodes and
adds a private Mongo dispatch, two Mongo nodes, and a scoped storage error handler.
The router reuses the active game's Mongo client configuration. Inputs must match
reviewed node hashes. A fresh review is required when those nodes drift. The candidate
does not alter public game reads, PAY confirmation, split leave or timeout cleanup.

This candidate stays inactive unless `LK_PAID_SPLIT_JOIN_RECOVERY_ENABLED=1`.
It targets the primary legacy public paid join. When enabled, the primary paid
route still checks the journal if the game becomes private. Private or unsupported
games fail closed during admission; the current candidate must not be activated
on a mixed public/private cohort without a compatible routing decision. A coordinated
release must verify the
legacy roster owner configuration, paired frontend, existing cleanup behavior,
Mongo replica-set write concern and provider response shapes with an isolated
rehearsal. Public and private games, subscription/create requests, and alternate
tenant flows must not share unreviewed authority. Do not turn the flag off on a
live cohort while attempts remain: older paths do not consult the journal. Establish a
drain/reconciliation plan before any rollback. Journal inspection is internal;
checkout URLs must not be included in diagnostics or release evidence.

Run the isolated function-path checks with
`node --test scripts/tests/paidSplitJoinRecovery.test.mjs`. The optional
`PAID_JOIN_FIXTURE_FLOW` points at a locally generated private candidate and runs
the same synthetic request/acknowledgement sequence against the composed live
function rather than the repository base. No provider, database or live write
is performed by this test.
