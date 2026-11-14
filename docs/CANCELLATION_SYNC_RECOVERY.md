# Cancellation and booking synchronization recovery

This candidate fixes cancelled daily-seat ownership, stale game projections,
organizer-transfer routing and cancellation verification. It does not apply a
production repair, issue a refund, migrate players or publish frontend bundles.

## Invariants

- A daily calendar seat and a returned subscription visit are separate facts.
  `SEAT_ONLY` jobs use the existing per-instance cancellation lock, GET-only
  provider effects, durable intent and a full-preimage operation CAS. They never
  invoke SERVICE, increment visitsLeft, or claim RETURN_VERIFIED.
- A bound seat requires an exact cancelled provider booking and a complete
  selected-instance snapshot with a real positive balance and no other same-day
  subscription use. A missing credit is retained as `creditRecoveryRequired`.
  Existing other-day bookings and payment/return receipts remain intact.
- A FAILED unbound refusal additionally requires a definite 4xx before accepted
  work, no provider/payment/managed markers, complete exercise absence evidence,
  and terminal fencing before guard takeover. Unknown writes remain held.
- Historical RELEASED monetary owners require exact transaction readback.
  Existing release reason, release date and recovery lineage are preserved.
  CONFIRMED money operations remain on the financial recovery path.
- Native SERVICE, repair and SEAT_ONLY jobs share the cancellation lock. Pending
  or unknown returns cannot be bypassed. DONE/DECLINED jobs never resurrect.
  The worker resumes `SEAT_INTENT` through the same state machine.

## Interfaces and source composition

`POST /lk/games/:gameId/cancellation/status` authenticates the current profile,
checks stored membership, reads the exact organizer booking plus every exercise
booking, and archives a stale local game only after all are cancelled. Local
membership mutation fences and snapshot CAS protect concurrent changes. Payment
history is retained; the endpoint never calls provider cancellation or refund.

The cabinet reconciles known-cancelled organizer games on refresh and on opening
cancellation without an active matching booking. Verification reads fresh complete
active/history pages; contradictory or incomplete evidence stays unverified. A
native return receipt remains bound to the exact booking and current session.
Unknown DELETE outcomes trigger readback, not automatic DELETE retries. An
original provider refusal is retained instead of replaced by a generic lag message.

Organizer transfer is installed by the existing source-driven handoff builder,
with majority+j authority writes and its concurrency fences. Replacement member
discovery trusts current stored membership and provider exercise identity, never
client-supplied booking IDs. Explicit provider consumption or exact LK operation
count replaces the former duration-based visit guess.

`scripts/prepare_cancellation_sync_recovery.mjs` composes only owned edits over
the pinned source snapshot. `cancellationSyncContractBudget.json` independently
limits changes to 20 existing nodes and 54 additions. `cancellationSyncSourceEdits.json`
preserves installed legacy lineage instead of importing unrelated maintained
managed/payment features. `cancellationSyncGatewayDeltas.json` permits exact
historical inversion without changing prior release hashes. Whole-source, anchor,
node-field or wire drift aborts composition.

## Deliberately held cases

- A manual replacement with no exact consumption count returns NEEDS_VISIT_COUNT.
- Newly discovered organizer-target SERVICE/CURRENCY/DEPOSIT returns require a
  versioned once-only refund capability; until that evidence exists they return
  NEEDS_PROVIDER_RETURN_PROOF before provider mutation. NONE is allowed only when
  the fresh provider options and selected action permit it; no refund fallback.
- Zero provider balance, other active same-day usage, managed ownership, partial
  lists, conflicting aliases and unknown financial/return dispatch stay held.
- Missing historical visits require separate exact reconciliation; freeing a
  calendar seat never mints credits. Customer reassignment is a separate operation.

## Validation and release prerequisites

The focused tests cover common-lock contention, immutable terminals, lost ACKs,
worker continuation, full-owner CAS, exact bindings, missing-credit preservation,
frontend pagination/conflicts and organizer authorization. The optional private
baseline tests compile the actual candidate router and exercise its guard recovery.
`cancellationSyncRuntime.test.mjs` additionally runs that single exact function in
an isolated Node-RED 4.0.9 with synthetic provider/database I/O, zero startup effects,
preserved unrelated node instance and inverse restoration. Production graphs,
credentials and customer records are not exported to Git or loaded into rehearsal.

Before a separately authorized release: obtain a fresh stable disk/active/editor
baseline, review any source drift rather than advancing pins blindly, rebuild the
exact graph contract and clean committed worker bundle, and validate compatible
backend/worker generation guards. Ship matching frontend/backend/worker versions
under the existing release runbook. Preserve backups and validate actual ACK,
runtime, worker, passive booking state and the required soak. No real booking,
cancellation, refund or data repair is part of these synthetic checks.
