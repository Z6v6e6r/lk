# Cancellation consistency and security topology

This note describes the 2026-08-01 source candidate. It does not import,
publish, deploy, or mutate the live Node-RED flow or production data.

## Verified live preimage

- host: `lk-primary-147`;
- remote file: `/root/.node-red/flows.json`;
- SHA-256: `087cd7ca973681c5cf7585c97a0c8498b38d7eb214aede2f83b64ef49555946e`;
- nodes: `4628`;
- HTTP inputs: `203`;
- LK Games tab: `4b91e2a2413688db`.

The guarded patcher refuses another flow SHA, node count, route count, stale
origin metadata, source-function drift, graph drift, duplicate IDs, broken
wires, non-private output, or an existing/partial output target.

## Failure being corrected

The old browser flow could complete three separately acknowledged actions:

1. cancel the Viva booking;
2. patch the LK game roster in the browser;
3. refresh local UI state.

Those actions had no durable shared operation. A Viva success followed by a
failed, stale, or skipped LK patch returned the subscription visit but left the
person active in `lk_games`. Historical identity arrays and
`chat_messages.relatedPhones` could then keep the stale presence visible.

## Client contract

Every self-leave entry point now calls one authenticated endpoint:

```text
POST /lk/games/:gameId/split/leave
Authorization: Bearer <current-user-token>
body: { reason: "PLAYER_LEFT", refundMethod?: ... }
```

The client does not send an authoritative participant, phone, client ID,
booking ID, or operation ID. The server derives the actor from the verified
Viva profile and binds the target to the current game document.

Cabinet cancellation re-runs the exact booking-reference lookup at the mutation
boundary. Its result is one of `unique`, `none`, `ambiguous`, or `error`:

- `unique` game -> server self-leave;
- `ambiguous`, incomplete, or lookup error -> fail closed;
- game-like booking with `none` -> fail closed;
- ordinary non-game booking with complete `none` -> normal Viva cancellation.

Organizer game cancellation accepts only the exact requested game result from
the cleanup endpoint and never falls back to a direct Viva cancellation.

## Exact identity lookup

The exact `paymentRef` / `bookingIds` list mode keeps distinct game documents
distinct and deduplicates only by `doc.id`. It includes cancelled matching
records so the client can distinguish an already-linked hidden game from a true
non-game booking. If the server reports more rows than it returns, or pagination
completeness cannot be proven, the client treats the lookup as incomplete and
blocks the mutation.

## Durable leave saga

The server state machine is:

```text
Bearer/profile actor
  -> current game + immutable membership generation
  -> STARTED persisted and claimed
  -> exact Viva booking cancellation
  -> active + history read-back
  -> VIVA_CONFIRMED persisted
  -> game roster CAS
  -> Mongo acknowledgement
  -> fresh game read
  -> membership-generation fence
  -> DONE persisted
  -> durable DONE read-back / response
```

Important invariants:

- `STARTED` exists before a Viva mutation;
- the operation ID is deterministic for game, actor/target, and immutable
  membership generation;
- booking discovery finishes before `STARTED`; the durable record contains
  either exact booking IDs or explicit `vivaTargetMode: NONE`;
- Bearer headers and service tokens are never persisted;
- a retry claims an expired lease with token-and-lease CAS;
- BOOKINGS recovery checks for the service token before consuming the lease;
- NONE recovery needs no token but still persists `VIVA_CONFIRMED` before LK;
- a concurrent `DONE` is accepted only after durable DONE read-back;
- Mongo miss/error returns `RETRY_REQUIRED`, never false success.

## Concurrent rejoin

Membership generations use immutable active identifiers from payments,
participants, waitlist entries, and join responses. The canonical parts are
identical in authorize, retry hydrate, and the post-CAS fence.

If a newer generation appears while an old `STARTED` operation is recovering,
the old exact Viva booking is still reconciled. The new generation is not
removed. The operation finishes with `REJOIN_PRESERVED` only after the old Viva
target is confirmed cancelled and `VIVA_CONFIRMED` is durable.

The fresh read after game CAS closes the window in which a user rejoins between
the write acknowledgement and completion. A rejoin found there is preserved.

## Chat authority

The four existing chat HTTP routes keep their IDs and become:

```text
chat HTTP input
  -> Bearer syntax gate
  -> Viva profile read
  -> verified actor dispatch
  -> current lk_games membership read
  -> message read/write/read-marker or active-game chat list
```

There is no path from any chat HTTP input to game/message Mongo before profile
resolution. Caller-supplied phone/client identity is rejected when it conflicts
with the verified profile.

`chat_messages.relatedPhones`, `allRelatedPhones`, and similar historical
projections are not authorization sources. The leave saga deliberately does
not `$pull` historical chat phones: that destructive projection update cannot
be generation-safe across a concurrent rejoin without a shared transaction or
immutable chat membership generation. Chat visibility and access come only
from current active `lk_games` organizer/participant/waitlist/payment rows.

## Generic PATCH CAS

Roster, invite, organizer, and metadata patches require `expectedUpdatedAt` or
`expectedRevision`. The precondition is attached to the Mongo query. Legacy
success/autojoin outputs are suppressed for CAS requests; one post-write gate
returns success only after a valid Mongo acknowledgement.

- missing precondition -> `428` before Mongo;
- invalid revision -> `400` before Mongo;
- `matchedCount=0` -> `409`, no autojoin;
- malformed acknowledgement or Mongo error -> `5xx`;
- matched write -> one success response, then autojoin;
- non-protected patches preserve the legacy route.

Clients re-read the authoritative record on `409`/`428` instead of applying an
optimistic roster fallback.

## Historical repair tool

`scripts/repair_game_participant_membership.mjs` is for an already inconsistent
record, not for the normal leave path. It is dry-run by default and requires an
exact game plus immutable Viva/participant identity, private backup directory,
confirmed cancelled Viva state, and explicit apply confirmation. Ambiguous
booking generations, shared-phone collisions, organizer removal, newer rejoin,
symlinks, hardlinks, or unsafe permissions fail closed. Game and exact backed-up
chat rows are updated in one Mongo transaction with in-transaction and
post-commit read-back.

## Reproducible candidates

Phase one keeps the five existing generic PATCH nodes byte-identical to the
live preimage so old cached clients remain compatible:

- candidate: `/private/tmp/padlhub-cancellation-phase1-compat-20260801-v2.json`;
- report: `/private/tmp/padlhub-cancellation-phase1-compat-20260801-v2.report.json`;
- SHA-256: `ffe6020341a50755f8f83c35e3099cac87d3b9a6a3aaea6c8c8e9cc26a195ec4`;
- nodes: `4628 -> 4667`;
- `rolloutPhase: phase1-compat`;
- `patchCasAcknowledgementGate: false`.

Phase two is the full candidate after old-client drain:

- candidate: `/private/tmp/padlhub-cancellation-candidate-20260801-v9.json`;
- report: `/private/tmp/padlhub-cancellation-candidate-20260801-v9.report.json`;
- SHA-256: `28611b28d137a8492533301543fef0902d8676cbd1b10e23127bc257b29857db`;
- nodes: `4628 -> 4673`;
- `rolloutPhase: phase2-cas`;
- `patchCasAcknowledgementGate: true`.

For both candidates:

- HTTP inputs: `203 -> 203`;
- duplicate IDs: `0`;
- broken wires/links: `0`;
- `deploymentPerformed: false`.

Both candidates were built from a fresh verified pull after the final
strong-identity review. Older intermediate candidates must not be used.

## Production rollout boundary

Do not deploy an isolated function body or manually merge this graph. The
backend saga, exact lookup, chat gate, and their pinned topology form one
server candidate.

The prepared rollout is explicitly two-phase because old cached clients can
still perform the legacy Viva-then-PATCH flow. Phase one ships the saga, strong
identity checks, chat gate, exact lookup, and cache invalidation while retaining
legacy generic PATCH compatibility. Then publish/cache-bust the frontend and
drain old clients. Only after a new fresh live pull and postchecks may phase two
enable PATCH CAS. The current phase-two artifact is a reviewed reference from
the original preimage; after phase one it must be regenerated against the new
exact live SHA rather than imported unchanged.

Required post-deploy proof is browser -> API -> operation document -> Viva
active/history -> direct `/lk/games/:id` and lists/by-phone -> chat list/access
after a full reload. Health, manifest, HTTP 2xx, or a returned subscription
visit alone are not sufficient.
