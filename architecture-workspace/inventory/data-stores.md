# Data Store Inventory

## Current Mongo-Centric Areas

Known current Mongo-backed areas include:

- `lk_games` and game-related metadata.
- Game chats and read markers.
- Tournament state, rounds, results, standings, and sales.
- Support clients/dialogs/messages/outbox.
- Communities, feed, joins, rating sources.
- Community rating facts, aggregates, and snapshots.
- Analytics/events.
- Referral/subscription sales and counters.

Exact collection names should be verified from live/runtime exports before being
treated as complete.

## Proposed Target Split

| Data type | Target store | Reason |
|---|---|---|
| Users, identities, devices | PostgreSQL | Stable keys, constraints, audit. |
| Payments and callbacks | PostgreSQL | Idempotency, uniqueness, transactions. |
| Subscription usage | PostgreSQL | No double-spend, daily/product limits. |
| Booking mirror | PostgreSQL + JSONB | Transactional core plus flexible Viva payloads. |
| Game membership/core status | PostgreSQL + JSONB during transition | Strong state invariants; keep evolving metadata flexible. |
| Tournament canonical state | PostgreSQL + JSONB during transition | Players/rounds/results need referential integrity. |
| Support message payloads | MongoDB or PostgreSQL JSONB, separate domain | Channel payloads are flexible; access/audit must be strict. |
| Raw external payloads | MongoDB/Object storage | Debug/replay payloads change often. |
| Rating facts/snapshots | PostgreSQL or Mongo read model | Needs reproducible batch semantics and audit. |
| Recommendations/features | MongoDB/read model | Flexible features, low write criticality. |

## Migration Principle

PostgreSQL should become the transactional source of truth for money, identity,
usage, and command state. MongoDB can remain for flexible documents, legacy
compatibility, raw payloads, and read models.
