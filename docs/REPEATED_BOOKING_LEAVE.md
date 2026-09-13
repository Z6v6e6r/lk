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
- Broader historical candidate tests remain pinned to old immutable releases:
  cupBookinglessStaffLeaveCandidate and splitLeaveProjectionPatch already disagree
  with base HEAD game-update source; splitLeaveActiveVivaDemotionCandidate rejects
  this successor router. Their release pins are deliberately not updated.
- No authenticated provider, live Mongo, browser or deployment proof is claimed.

## Release boundary

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
