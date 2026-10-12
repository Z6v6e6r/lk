# Partner bookings in the LK roster

A Partner API join stores a named `PARTNER_API` participant and an external
payment linked to a Viva booking. Viva stores that booking under the integration's
technical client. Importing the technical client as another `ADMIN` participant
incorrectly consumes a second seat.

The LK projection now restores a missing participant booking ID only from one
consistent server payment binding, and maps an exact Viva booking to its named
Partner owner. Different bookings sharing one technical client remain distinct.
Missing, conflicting or repeated booking identities stop automatic roster PATCH.
Cached provider projections cannot delete legacy rows without booking identity.
Neither payment details nor technical client contact details are added to the
named participant by this projection.

## Server protection

`scripts/patch_partner_roster_guard.mjs` prepares a candidate from a fresh private
live flow. It accepts the exact existing `Prepare game patch` function and Mongo
node hashes; it never regenerates the old tracked Games flow. The candidate
changes both `PATCH /lk/games/:gameId` and `/lk/games/records/:gameId`, wraps only
the existing prepare function, and adds six nodes using the existing Mongo
configuration. All other nodes and configuration references are preserved.

Roster PATCH first reads the current game. A stored Partner participant or paid
external Partner membership rejects that legacy write with
`GAME_PARTNER_ROSTER_COMMAND_REQUIRED`. This also rejects an old browser body
that omits the Partner participant. Non-roster requests retain their existing
path. Ordinary roster writes require the caller's current version and compare
the exact document, tenant, participants, waitlist, payments, timestamp and
revision before writing. Revision increments establish a fence even for writes
within one millisecond. HTTP success and autojoin occur only after Mongo ACK;
conflicts, read/write failures and unacknowledged writes do not fan out.

Owner: the LK Games team. Audience: club-game participants and staff. Observable
result: one named LK participant for one Partner membership; Viva retains the
technical booking. Stop signal: source/config drift, incomplete provider proof,
CAS conflict, failed ACK or changed membership. Stop method: reject the write,
retain its preimage and reconcile by reads without an automatic retry.

## One-game correction

`scripts/repair_partner_roster_duplicate.mjs` provides a dry-run and guarded
repair. The caller supplies an exact game/member/operation/booking/client scope
and a fresh complete Viva GET scoped to the membership's exercise. It verifies
one active membership, one completed join, one paid external payment, one named
participant and one technical duplicate. Multiple bookings for the same
technical client, result-bearing games or any conflicting identity stop repair.

Apply requires the exact dry-run hash and a stopped/drained Partner mutation
boundary verified before and after the correction. This is necessary because
removal can change membership before touching the game. Save and fsync a private
BSON backup, then use sequential reads in a snapshot transaction and one exact
CAS write. Remove only the technical roster row, restore the retained named
participant's booking/generation fields, and advance timestamp/revision.
Payments, member, operation, result snapshots and other game fields are unchanged.
Postcheck repeats the scoped Viva read and preserves a private receipt.
Commit uncertainty or postcheck failure requires reconciliation, not a repeat.

Activation order for an explicitly authorized production repair:

1. Publish the reviewed source and verify CI for its exact head.
2. Pull a fresh private live preimage; build and review the candidate against its
   current hashes. Use the project's guarded Node-RED apply mechanism and retain
   a preimage/revision for recovery. Do not overwrite foreign flow changes.
3. Verify both PATCH aliases reject Partner roster writes and ordinary writes
   receive a confirmed ACK, using isolated fixtures for actual write checks.
4. Publish the complete clean frontend artifact to the existing prod topology,
   verify source manifests and hashes, and reload the affected cabinet.
5. Drain/stop the Partner sidecar, reread the case and run a fresh dry-run. Apply
   the exact one-game correction, verify roster/payments/provider/member state,
   then restart the unchanged approved sidecar and verify readiness.

The source-driven candidate and repair preparation grant no merge, import,
publication, restart or real data-write authority. Preparation leaves those
steps pending until the named production sequence is approved.
