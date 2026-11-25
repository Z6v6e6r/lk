# Repeat booking removal

Owner: LK Games / CUP maintainers. Audience: reviewers and release operator.

An expired payment generation can coexist with a new ADMIN participant that has no
booking ID. CUP previously rejected removal before LK could inspect Viva. The new
CUP request uses the active roster binding, or a membership version derived from
an ADMIN roster snapshot when no binding exists. Expired payment rows are excluded.

LK independently validates the snapshot and stores a STARTED DISCOVERY operation.
It reads the complete exercise roster and requires exactly one active booking for
the target client. The booking ID and subscription evidence are persisted with a
claim-token compare-and-set and independently read back before cancellation.
Retries use that saved booking ID. Background discovery is prohibited. A changed
roster snapshot prevents local deletion; conflicting or incomplete Viva evidence
fails closed. No participant PATCH bypass is introduced.

Subscription cancellation without a recoverable pre-cancel baseline becomes
RETURN_PENDING, never verified return. Recovery does not replay a refund. Old
inactive payment history is preserved. Idempotency remains scoped to the membership
snapshot: there is no cross-operation idempotency-key registry. Duplicate roster
identities can still require manual diagnosis rather than automatic removal.

## Local acceptance

- 155 focused LK leave, membership, subscription-return and graph tests pass.
- CUP removal tests and build pass (separate ph-admin change).
- LK lint: zero errors, existing warnings. Full build uses inert CI configuration.
- Historical candidate tests validate their immutable source commits separately
  from the reviewed repeated-booking successor. Their production release pins remain
  unchanged; old CUP/projection builders reject successor source even when their
  historical function preimages match. Tests require full Git history and run in the
  `test:leave-generation-regressions` CI gate; no historical live-flow regeneration
  or candidate reauthorization is implied.
- No authenticated provider, live Mongo, browser or deployment proof is claimed.

## Release boundary

For the production graph without organizer-handoff, use the explicit profile and
combined upgrade in [LK_SEPTEMBER_RELEASE_COMPATIBILITY.md](LK_SEPTEMBER_RELEASE_COMPATIBILITY.md).
The following describes the original source candidate, not a direct live upgrade.

The source-only builder is `scripts/prepare_repeated_booking_leave_candidate.mjs`.
It requires an external fresh source flow whose touched functions match reviewed
base preimages, validates existing operation-store configuration and routing, adds
four discovery persistence nodes, and writes a new private candidate file only.
It is not an installer. Existing function-only deployment operators cannot apply
this topology change. A separately reviewed topology-aware release contract,
backup/reverse candidate, and fresh source verification are required before install.
Do not force through drift or run a broad legacy flow generator.

Deploy the compatible LK graph before the CUP service. The CUP-only update cannot
repair this incident against the old authorizer. Keep persistent DISCOVERY operations
for forward recovery; do not roll back code blindly while such operations exist.
Release postchecks must verify exact client/exercise binding, provider absence,
subscription-return evidence, local roster and unchanged historical payments.
No merge, deployment or live data action is part of the source change.

## Primary LK1 recovery profile, November 2026

The November primary graph uses the organizer-handoff membership lock and newer
leave gates. Its CUP facade already sends a snapshot version when an imported
Viva participant has no linked booking ID in LK. The installed Node-RED staff
authorizer predates that contract. `ADMIN` is also a projection value assigned
when LK reads the Viva roster. It does not identify who initiated the booking.

Use `scripts/prepare_cup_staff_leave_live_candidate.mjs` for this pinned primary
graph. It makes an exact-graph candidate and contract outside Git from a fresh
private snapshot. It does not update the Pade Prime route or use the September
optimistic-CAS profile.

```sh
node scripts/prepare_cup_staff_leave_live_candidate.mjs \
  /absolute/private/source.flow.json /absolute/new-private-output deployment-id
CUP_STAFF_LEAVE_SOURCE_FIXTURE=/absolute/private/source.flow.json \
  node --test scripts/tests/staffPlayerLeave.nodered.test.mjs
```

For the unbound staff path, read the complete exercise roster and the exact
booking's cancellation options first. Only an explicit no-return request,
supported by Viva, can create a durable operation. A rejected option leaves the
same snapshot available for a corrected request. The operation stores the exact
booking and snapshot before entering the normal membership lock. A second roster
check and the exact cancellation-options response guard the request to Viva.
Active absence and explicit matching cancellation history guard local removal.
The existing linked-booking return path retains its original behavior. An unbound
booking for which a return is requested requires separate verification.

Recovery retains the original booking and snapshot. A provider failure releases
only the lock stamped with the failed claim, keeping a newer retry's lock and
the original response. If the outcome of a provider write is uncertain, recovery
rechecks the exact booking and leaves the local roster alone until confirmation.
Refreshing the live graph invalidates earlier candidate and reversal evidence.
Recheck the unpaid cancellation worker's full-graph pin and editor state during
release admission. This source-only profile does not execute an install, restart,
Viva cancellation, or data repair.
