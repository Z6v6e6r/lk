# Time for Friends community membership backfill

## Scope

`scripts/backfill_time_for_friends_community_memberships.mjs` prepares and,
only after a separately reviewed dry-run, applies historical membership changes
for tournaments with Viva direction `5278` ("Время на друзей").

The tool does not choose a community by its name and does not use a station-only
fallback. The authoritative target relation is a historical `lk_community_feed`
post (active or archived) with:

- `kind=TOURNAMENT`;
- an exact stable `relatedTournamentId`/Viva exercise id;
- an exact community id included in the reviewed scope manifest.

Local tournaments with explicit direction `5278` are inventoried even when no
publication exists. If an exercise has zero or more than one eligible published
community, it is quarantined. This is important because one station can have
several level groups.

## Sources and rating boundary

There are two participant sources:

1. A finalized local `tournaments` document with standings. These players are
   both membership candidates and immediately eligible for tournament facts in
   the existing community-rating recalculation.
2. A past Viva exercise with a provider-confirmed direction, station and active
   roster. These players are membership candidates only. They become rating
   eligible after a finalized local tournament document with standings exists.

A finalized local tournament linked only by an archived publication is also
membership-only: production community rating intentionally reads active posts.

The report separates `ratingEligibleOperations` and
`membershipOnlyOperations`. Recalculating a community cannot invent tournament
facts for the second group.

Only exact Viva/CUP client ids are accepted. Existing membership and ban
identities are compared by exact id and, when available, normalized phone using
the live community semantics. Phone-only legacy rows are fail-closed when the
candidate phone is unavailable. Cancelled rows, unresolved ids, rows without a
positive active `spot`, banned members, station conflicts and ambiguous
publications are quarantined. Name matching is never used.

## Reviewed scope manifest

The manifest is an operator-reviewed authorization boundary. Do not build it by
fuzzy matching community names.

```json
{
  "version": "time-for-friends-scope-YYYY-MM-DD",
  "directionId": 5278,
  "communities": [
    {
      "communityId": "exact-community-id",
      "stationId": "exact-viva-studio-id"
    }
  ],
  "tournamentMappings": [
    {
      "tournamentId": "exact-unpublished-viva-exercise-id",
      "communityId": "exact-reviewed-community-id",
      "stationId": "exact-viva-studio-id"
    }
  ]
}
```

`tournamentMappings` is optional and exists only for manual resolution of an
unpublished/ambiguous historical exercise. Its exact community/station pair must
already be approved above; conflicts with source station or publications remain
quarantine. A mapping without an active publication is membership-only because
the production rating collector cannot create a tournament fact from it.

Missing direction metadata in an existing local tournament is quarantined;
membership in the scope never proves tournament type. Publication-only Viva
exercises must provide direction `5278` and an exact station from the provider.

## Dry-run

The default mode performs no database writes. For full historical coverage the
script can read exact public exercise metadata from Viva and active participants
from the bounded LK participants endpoint. If an optional Viva Bearer is present
in `VIVA_TOKEN` (or compatibility `VIVA_AUTH_TOKEN`), it is never written to the
report.

```bash
npm run tff:memberships:backfill -- \
  --mongo-uri "$MONGODB_URI" \
  --scope tmp/time-for-friends-community-scope.json \
  --fetch-participants \
  --inventory-from 2025-08-11 \
  --inventory-to 2026-08-11 \
  --out tmp/time-for-friends-memberships-dryrun.json
```

The inclusive inventory range is capped at 366 days and is part of the reviewed
plan SHA. Every Viva exercise with direction `5278` in that range is added to the
coverage denominator. Exercises without a historical publication/local mapping
remain `ELIGIBLE_PUBLICATION_NOT_FOUND`; station alone never selects a level group.

The participant reader is sequential, waits `1100ms` between exercises and has
a default hard cap of 200 exercise ids. A previously reviewed provider export
can be supplied with `--participants-file` instead.

Exercise direction, station and capacity are read from the Viva end-user
`GET /end-user/api/v1/{tenant}/exercises/{id}` contract. Active roster rows come
from the bounded LK participants endpoint. A row is accepted only when its
positive `spot` does not exceed the exact exercise capacity; proven waitlist rows
are reported and skipped.

Reports are written with mode `0600`; player ids are represented by stable
one-way references. Preserve the reported `planSha256`. It covers the full
normalized scope, source fingerprint, decision fingerprint and write operations.

The summary separates expected skips from unsafe quarantine:

- `NOT_TIME_FOR_FRIENDS` — local/provider metadata contains exactly one explicit
  direction other than `5278`; two distinct directions remain quarantine;
- `EXERCISE_NOT_ENDED` — the exercise is still current or future;
- `NO_ACTIVE_PARTICIPANTS` — the provider source and capacity are proven but
  there are no active in-capacity rows;
- `WAITLIST_OUTSIDE_CAPACITY` / `CANCELLED_ROSTER_ROW` — proven non-participants.

`skippedByReason`, `quarantinedByReason` and `providerStatusCounts` make these
classes auditable without treating expected out-of-scope rows as data errors.
HTTP/transport failures and missing required provider metadata remain quarantine
and include redacted `providerStatus`, `metadataStatus` and error category.

## Guarded apply

Apply is a separate, explicitly approved data-mutation stage. It requires the
SHA of a fresh reviewed plan and blocks when quarantine is non-empty unless the
operator separately passes `--allow-quarantine`.

```bash
npm run tff:memberships:backfill -- \
  --mongo-uri "$MONGODB_URI" \
  --scope tmp/time-for-friends-community-scope.json \
  --fetch-participants \
  --inventory-from 2025-08-11 \
  --inventory-to 2026-08-11 \
  --out tmp/time-for-friends-memberships-apply.json \
  --apply \
  --confirm-report-sha '<reviewed-plan-sha256>'
```

Each membership mutation is a single conditional Mongo update. It adds an exact
client id only when the same id/confirmed normalized phone is absent from
`members` and `bannedMembers`, removes the same identity from `pendingMembers`,
and recalculates `memberCount` from the array length. The deterministic audit
ledger is `lk_tournament_community_enrollments`; execution state is stored in
`lk_tournament_community_backfill_executions`. Per-operation failures are
recorded as `FAILED_RETRYABLE`, the script still writes a partial report and
exits non-zero. Retries are idempotent.

The script does not create feed posts and does not remove members after a
tournament.

## Rating recalculation

After membership apply and readback, first dry-run only the affected communities
printed by the backfill report:

```bash
npm run rating:recalculate -- \
  --community-id <affected-community-id> \
  --mongo-uri "$MONGODB_URI" \
  --dry-run
```

Rating apply is another separately approved stage. Verify facts, aggregates,
snapshots, `calculationVersion`, row counts and `dataThrough` before and after it.

## Fail-closed quarantine reasons

- `DIRECTION_ID_NOT_PROVEN` / `PROVIDER_DIRECTION_ID_NOT_PROVEN` / `DIRECTION_ID_CONFLICT`
- `PARTICIPATION_SOURCE_NOT_PROVEN`
- `CAPACITY_NOT_PROVEN` / `ACTIVE_SPOT_NOT_PROVEN`
- `ROSTER_ACTIVE_STATUS_NOT_PROVEN`
- `STATION_ID_MISSING` / `STATION_ID_CONFLICT`
- `ELIGIBLE_PUBLICATION_NOT_FOUND`
- `ELIGIBLE_PUBLICATION_AMBIGUOUS`
- `PLAYER_CLIENT_ID_MISSING`
- `PLAYER_BANNED`
- `COMMUNITY_LEGACY_IDENTITY_UNRESOLVED`
