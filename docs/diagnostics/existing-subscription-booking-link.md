# Existing subscription booking link preparation

The split JOIN provider booking and the browser's roster PATCH are separate steps.
An organizer-authority metadata mismatch can refuse the latter after the zero-cost
subscription booking has already been confirmed. Repeating JOIN is not a repair.

Ordinary roster metadata now preserves the presence and value of stored
`organizerId`, `organizerPhone`, and `organizerPhoneNorm`, including absent/null
values. Extra roster metadata cannot introduce or override them. The backend
authority guard and dedicated organizer-transfer command are unchanged.

## Offline preparation, without execution

`scripts/prepare_existing_booking_link.mjs` has no database/network dependencies
and no apply mode. It reads a private JSON evidence file and prepares a proposed
single-document CAS update and inverse. It cannot create a booking, payment,
subscription visit, or database write.

```sh
node scripts/prepare_existing_booking_link.mjs \
  --input /absolute/private/evidence.json \
  --output /absolute/private/proposal.json
```

Both paths must be outside Git checkouts; the output directory must be mode
0700. The output is created exclusively with mode 0600. Do not commit or attach
customer snapshots, identifiers, receipts, or proposals to a PR. CLI stdout only
reports the preparation status and zero write counts.

The caller collects these **read-only** receipts in a single short window:

- `observedAt` and `expected`: exact tenant/game/client/subscription/exercise/
  booking/operation IDs selected from verified incident evidence.
- `game`: the complete unique Mongo game document, including its root fields and
  `_id` key. `_id` is omitted from equality because its JSON representation loses
  the BSON type; every other root field and the complete root field count are
  bound in the proposed filter.
- `operation`: the unique CONFIRMED zero-cost operation and its original timestamps.
- `booking`: exact client-scoped Viva GET 200; active SUBSCRIPTION booking with
  matching client, exercise, subscription, room, studio and start/end instants.
- `subscription`: the exact ACTIVE instance from a complete GET 200 list,
  including the already-consumed booking and current visit balance.
- `guard`: the exact daily-visit guard, still owned by that confirmed operation.
- `reads`: completeness/status facts, including `linkedGames` (booking ID,
  completeness, and all game IDs referencing this booking). Search root organizer
  booking IDs, metadata booking arrays, split-payment booking IDs/arrays, and
  participant booking IDs/arrays. Refuse truncation, duplicates, or another game.

The synthetic fixture in `scripts/tests/existingBookingLinkRecovery.test.mjs`
documents the input shape. Evidence older than 60 seconds, incomplete reads,
provider identity/cancellation mismatches, a different guard owner, an active
membership mutation, missing/duplicate participant, and conflicting payment links
are refused. The participant must already be CONFIRMED; the planner never adds or
moves a player or converts a temporary PENDING entry.

The proposal only adds a zero-cost PAID participant payment link and the confirmed
booking ID to `metadata.bookingIds` and `metadata.splitPayment.bookingIds`, then
advances `updatedAt` and an existing revision. It preserves roster order/status,
organizer authority, audit history, all other payments and subscription state.
It does **not** add a participant booking to `game.booking.bookingIds`, which the
leave path uses for organizer bookings. No transaction, payment URL or paymentRef
is invented. An already-complete link yields `ALREADY_LINKED` and no command.

## Separate execution boundary

Preparation does not authorize execution. The packet expires after 60 seconds;
regenerate it from fresh complete reads immediately before any separately
authorized execution, using the same reviewed source. Validate BSON/JSON field
representation before execution: an exact query that does not match is a stop,
not permission to remove predicates or use replacement/upsert writes.

Before execution preserve the immutable private evidence, proposal, source hashes
and game preimage. An execution wrapper must pin those bytes, bind the exact fresh
BSON `_id`, revalidate the provider/operation/guard immediately before the write, require one matched
majority-acknowledged write with upsert disabled, and immediately read back the
exact postimage. Recheck the provider booking, subscription visit balance,
operation and guard: all must remain unchanged. There is no JOIN/retry/cancel/
refund/provider-write step in this recovery.

The proposed inverse is fenced by the exact recovery postimage. A zero-match
apply, unexpected postimage, or drift after execution requires investigation.
Never replay the forward write or weaken the inverse filter. Rollback is a
separately authorized Mongo-only transition and must not call Viva or alter visits.

Browser end-to-end acceptance and deployment are separate from these offline
tests. Preparation does not claim the production defect or customer record is fixed.
