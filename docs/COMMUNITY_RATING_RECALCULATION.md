# Community Rating Recalculation

## Purpose

The community rating read path first looks for prepared documents in `community_rating_snapshots`.
This worker fills the rating storage collections from authoritative community source data:

- `lk_communities`
- `lk_community_feed`
- `lk_games`
- `tournaments`
- `lk_training_visits`
- `rating_events`
- `player_rating_state`

The client must not calculate ratings. It should read the prepared snapshot through the community rating API.

## Overall Formula

The overall score uses normalized component values on the 0–100 scale:

```text
overall = games × 0.20 + tournaments × 0.60 + activity × 0.20
```

Formula changes require a new calculation version and a full recalculation before the API starts requesting that version.

## Storage

The recalculation worker writes in this order:

1. `community_rating_facts`
2. `community_rating_player_aggregates`
3. `community_rating_snapshots`

The worker creates rating indexes before writes unless `--skip-indexes` is passed.

## Game Fact Rules

- Game facts are built only for final `CONFIRMED` match results. `PENDING_REVIEW`, `DISPUTED`, `CORRECTION_PENDING`, and `NO_RESULT_EXPIRED` are excluded from final community rating snapshots.
- Pairings are resolved per set from `metadata.matchResult.setPairings[setIndex]`. If a set has no explicit pairing, the worker reuses the last known pairing; if none exists yet, it falls back to `metadata.teamSlots`.
- Player resolution includes `participants`, `playerPool`, and `waitlist` sources, so a player who appeared in a set can be rated even when they are not in the final four `teamSlots`.
- A game published in multiple communities contributes facts only for players who are members of the recalculated community.
- Each recalculation batch deletes stale facts for the community/calculation version before inserting current facts. This prevents old confirmed facts from surviving after a game becomes no-result/expired or otherwise non-final.

## Visit Fact Rules

- Training visits affect only `activityScore`, `totalEventsPlayed`, `lastActivityAt`, and `visitsAttended`; they do not affect game score, tournament score, or player level.
- Visit facts are built from materialized `lk_training_visits` rows matched to community members by `id` or normalized phone.
- A row is counted only when the visit is confirmed (`visitConfirmed`, `visited`, `attended`, `checkedIn`, or an attended/completed/visited status) and the visit time is not in the future relative to `collectedAt`.
- Cancelled, waitlist, pending, unpaid, failed, no-show, and explicitly `visitConfirmed=false` rows are excluded.
- The recommended materialized source is Viva exercise booking rows for group trainings with `visitConfirmed === true`.
- The materialized id must be deterministic per attendance, for example `viva:<exerciseId>:client:<clientId>` or `viva:<exerciseId>:phone:<phoneNorm>`. The sync must update the current state and archive stale rows for the scanned exercise when a booking is no longer confirmed.
- If Viva returns multiple confirmed booking rows for the same client/phone in one exercise, they are deduplicated to one attendance fact.
- Rows with explicit `communityId`/`relatedCommunityId` stay in that scope. Otherwise a visit is counted only for the mapped PadlHub station community and only when the attendee is its member. It is never broadcast to every community membership.

## Unified level ledger

- `currentLevel` is hydrated from `player_rating_state`, not from a stale member snapshot.
- game and tournament `ratingDelta` are summed from immutable `rating_events`.
- historical tournament events before the state cutover participate in dynamics but carry `applyToState=false`.
- snapshots expose `dataThrough`, `sourceVersion` and `calculationVersion`.
- when a versioned snapshot is missing, API returns degraded `503 RATING_SNAPSHOT_NOT_READY`; the old game/tournament-only fallback is not used because it omits visits and canonical level events.

## Training Visit Sync

`lk_training_visits` is filled by `scripts/sync_training_visits_from_viva.mjs`.
Default mode is dry-run. `--apply` writes only to `lk_training_visits`.

Dry-run a date range:

```bash
npm run visits:sync-viva -- --date-from 2026-06-01 --date-to 2026-07-07 --mongo-uri "$MONGODB_URI" --out tmp/training-visits-sync-dryrun.json
```

Apply after reviewing the report:

```bash
npm run visits:sync-viva -- --date-from 2026-06-01 --date-to 2026-07-07 --mongo-uri "$MONGODB_URI" --apply --out tmp/training-visits-sync-apply.json
```

Important sync behavior:

- group trainings are filtered by Viva type ids `605,847,963,1208` and the PadlHub group-schedule station whitelist;
- historical exercise ids are loaded from the Viva public end-user exercise list with `includePast=true&past=true`, while attendance confirmations are still loaded from Viva Admin bookings for each exercise id;
- confirmed rows are upserted with ids like `viva:<exerciseId>:client:<clientId>` or `viva:<exerciseId>:phone:<phoneNorm>`;
- by default, previously materialized active rows for scanned exercises are archived when the current Viva bookings no longer confirm attendance;
- use `--keep-missing` only for investigation, not for the normal rating pipeline;
- use `--all-studios` or `--studio-ids <csv>` only when the business scope changes.

## Commands

Dry-run one community:

```bash
npm run rating:recalculate -- --community-id <community-id> --mongo-uri "$MONGODB_URI" --dry-run
```

Recalculate one community:

```bash
npm run rating:recalculate -- --community-id <community-id> --mongo-uri "$MONGODB_URI"
```

Recalculate all active communities:

```bash
npm run rating:recalculate -- --all --mongo-uri "$MONGODB_URI"
```

Local wrapper for all communities:

```bash
npm run rating:recalculate:all -- --mongo-uri "$MONGODB_URI"
```

Dry-run for all communities:

```bash
npm run rating:recalculate:all -- --mongo-uri "$MONGODB_URI" --dry-run
```

Limit periods or tabs:

```bash
npm run rating:recalculate -- --community-id <community-id> --mongo-uri "$MONGODB_URI" --periods 30d,all --tabs overall,games
```

Product-visible periods are limited to:

- `all` — рейтинг за все время;
- `30d` — рейтинг за последний месяц.

Legacy request aliases such as `7d`, `week`, `90d`, and `quarter` are normalized to `30d` for compatibility.

## Scheduling

Recommended production schedule:

- run after confirmed game result publication;
- run after tournament standings finalization;
- run after training visit confirmation sync;
- run every 15 minutes as a safety net;
- run full `--all` recalculation after formula/version changes.

Versioned cron on `lk-primary-147` after a successful dry-run:

```cron
*/15 * * * * /opt/padlhub-rating-worker/current/deploy/rating-worker/run-incremental.sh
17 3 * * * /opt/padlhub-rating-worker/current/deploy/rating-worker/run-full.sh
```

After formula/version changes, run dry-run first and preserve the report:

```bash
npm run rating:recalculate:all -- --mongo-uri "$MONGODB_URI" --dry-run > tmp/community-rating-recalc-all-dryrun.json
```

When visit activity is involved, run the visit sync dry-run/apply before the rating recalculation dry-run/apply.

## Versioning

Every new fact, aggregate, and snapshot is tagged with `community-rating-v1.3.0`.
When the formula changes, increment the calculation version and run a full recalculation.
