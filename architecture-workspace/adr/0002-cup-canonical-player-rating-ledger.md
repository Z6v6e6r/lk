# ADR 0002: Make CUP the Canonical Owner of Player Rating

Date: 2026-07-10

## Status

Accepted for incremental implementation.

Implementation update 2026-07-10: the first `player_ratings`/`rating_events` cutover and truthful Viva projection are live. A superseding physical-state decision is now accepted: `player_rating_state` is canonical, while `player_ratings` remains a compatibility projection until all legacy readers move.

## Context

Player rating is currently split across several stores and processes:

- Viva custom fields are used as an external player-level projection;
- game result confirmation updates Mongo `player_ratings` and then syncs Viva;
- tournament recalculation writes `standings.ratingAfter` but does not update the same player state;
- `lk_game_rating_events` describes a game-result lifecycle event, not a complete per-player rating history;
- manual changes cannot be audited through one event contract.

This makes it impossible to answer reliably which event or actor produced the current rating.

## Decision

CUP owns the canonical rating data in the existing Mongo database:

- `player_rating_state` is the current, versioned state of one player;
- `rating_events` is the immutable per-player history of every effective rating change.

Every change must have:

- a deterministic event and idempotency id;
- a stable player identity, with Viva `clientId` preferred and normalized phone retained only as a migration alias;
- event type and source domain/source id;
- actor type and identity;
- rating before, delta, after, and grade values;
- formula version and parameters when a formula was used;
- occurrence time.

The write order is event first, canonical state second, compatibility projections last. State stores `lastEventId`, baseline and identity aliases, so it can be rebuilt from the ledger even when a tournament event arrives after a newer game event. During migration, `player_ratings` and Viva are downstream projections and are not sources for new rating decisions.

For a player without canonical state, Viva may be used once as a bootstrap source. The Viva value must be persisted as `RATING_BOOTSTRAPPED_FROM_VIVA` plus `CUP_CANONICAL` state before it is returned. Existing CUP state is never refreshed or overwritten from Viva in the read path.

## Compatibility

- `lk_game_rating_events` remains temporarily as the result-lifecycle record.
- `lk_result_viva_sync_outbox` remains temporarily as the Viva projection outbox.
- game submit reads current rating from `player_rating_state`.
- game confirm/rollback appends `rating_events` before updating `player_rating_state`, then projects to `player_ratings`.
- tournament, admin/manual changes, onboarding and import flows must adopt the same event contract before Viva ownership can be removed.

## Consistency Model

Node-RED currently performs two Mongo writes without a cross-node transaction. The safe failure direction is therefore:

1. append an idempotent immutable event;
2. update `player_rating_state`;
3. update the `player_ratings` compatibility projection;
4. send external projection tasks.

If step 2 fails, the event remains available to rebuild state. The versioned projector replays initial baseline plus ordered deltas for affected identities. Updating canonical state without an event is prohibited for migrated writers.

## Consequences

Positive:

- CUP becomes the source of truth without a flag-day Viva shutdown;
- each rating can be explained by source and actor;
- retries are idempotent;
- current state can be rebuilt and audited from events;
- Viva outages no longer need to block the canonical rating decision after the projection contract is hardened.

Tradeoffs:

- transition code still maintains an additional Viva projection after CUP state is persisted;
- phone-based legacy identities must be reconciled to stable client ids;
- tournament and manual writers remain incomplete until they emit the same events;
- a reconciliation worker is required because the first implementation is event-first but not transactional.

## Rollout Gates

1. Backfill dry-run has no unresolved duplicate `phoneNorm` or `clientId` identities.
2. `rating_events` indexes and initial import are applied with a preserved report.
3. Game result flow is regenerated from the current live 147 source, imported and postchecked.
4. Tournament and manual/admin writers emit the same contract.
5. CUP/Viva comparison is clean for the agreed observation window.
6. Reads stop falling back to Viva.
7. Viva rating writes are disabled, then its rating fields are treated as legacy only.
