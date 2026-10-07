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

Every current `lk_communities.members` entry is materialized in every requested snapshot period, including members with no game, tournament, or visit facts. Such a base row keeps the canonical `currentLevel` from `player_rating_state`, has zero scores/counters and the `no_activity` badge. It does not create a synthetic row in `community_rating_facts`.

## Player Rating API

`GET /lk/communities/:communityId/players/:playerId/rating` returns one minimal rating row for a station device or another ID-aware client. The public-path alias is `GET /communities/:communityId/players/:playerId/rating`.

- `playerId` must exactly match one of the member ID fields (`id`, `clientId`, `userId`, `uuid`, `playerId`); phone and name are never identity fallbacks for this endpoint.
- query parameters `tab=overall|dynamics|games|tournaments` and `period=all|30d` select the prepared snapshot;
- the response contains rating metrics and snapshot metadata only, without player name, phone or avatar;
- missing community/member returns `404`;
- missing snapshot returns `503 RATING_SNAPSHOT_NOT_READY`;
- an existing member missing from a stale snapshot returns `503 PLAYER_RATING_NOT_READY` until recalculation completes.

The Node-RED source functions live in `scripts/nodered_community_player_rating_nodes/`. The focused patcher `scripts/patch_nodered_community_player_rating_flow.mjs` accepts the default modular source only when its metadata proves a fresh exact live-147 pull; it produces a focused import and does not deploy it.

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

### Frozen tournament membership plan

For a reviewed historical tournament-membership plan, use the guarded executor.
The full plan must be a private (`0600`) absolute-path file, contain no quarantine
rows, match its canonical SHA-256, and be no older than 15 minutes. Dry-run is the
default and verifies the current community membership preimage without Mongo writes:

```bash
npm run community:memberships:apply-plan -- \
  --plan /absolute/private/plan-full.json \
  --flow-file /root/.node-red/flows.json
```

Apply requires a separately approved live-data gate, the exact fresh plan SHA, a
narrow backup directory, and a private report path. Backup v2 records both the
plan-bound membership fingerprint and the full BSON community preimage. Every Mongo
transaction attempt rechecks that full preimage before any membership or audit write,
and the committed full postimage is pinned in the execution ledger:

```bash
npm run community:memberships:apply-plan -- \
  --plan /absolute/private/plan-full.json \
  --flow-file /root/.node-red/flows.json \
  --apply \
  --confirm-plan-sha <fresh-plan-sha256> \
  --backup-dir /absolute/private/backups/<operation> \
  --report /absolute/private/reports/<operation>-apply.json
```

Recovery is a separate live-data operation. It requires both the plan SHA and the
backup file SHA. Restore replaces the exact target community preimages only while
the current full BSON documents still match the postimage pinned by apply; this is
checked before and inside the restore transaction. Any intervening community change
fails closed instead of being overwritten:

```bash
npm run community:memberships:apply-plan -- \
  --plan /absolute/private/plan-full.json \
  --flow-file /root/.node-red/flows.json \
  --restore \
  --confirm-plan-sha <plan-sha256> \
  --backup /absolute/private/backups/<operation>/membership-<sha>.ejson \
  --confirm-backup-sha <backup-sha256> \
  --report /absolute/private/reports/<operation>-restore.json
```

Membership apply and rating recalculation are separate gates. After a successful
membership postcheck, run a scoped rating dry-run for each affected community and
review it before authorizing rating writes.

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

- before each community recalculation, the worker plans exact Time for Friends
  participant enrollment from active tournament publications; ambiguous targets
  are quarantined and never selected by station/community name;

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

## Postcheck behavior for versioned snapshots

`scripts/postcheck_community_rating_147.mjs` now classifies versioned
`community_rating_snapshots` by active community list (`archived !== true`) and
uses active snapshots for matrix/unique/formula/`lastRatingChangedAt` checks.
Snapshots for unknown communities are tracked as `orphan` aggregates and are not
blocking; snapshots without a normalizable `communityId` remain fail-closed.

When visit activity is involved, run the visit sync dry-run/apply before the rating recalculation dry-run/apply.

## Versioning

Every new fact, aggregate, and snapshot is tagged with `community-rating-v1.3.0`.
When the formula changes, increment the calculation version and run a full recalculation.


## Calendar-month top 20 and published events

The additive routes below are generated by
`scripts/patch_nodered_community_monthly_flow.mjs`. They read only public (`OPEN`)
communities, recheck visibility on every request, and reject unknown/closed
communities and duplicate community IDs. Query-string identity is never an
access grant. The legacy `period=30d` route keeps its rolling-period contract.

### `GET /lk/communities/:communityId/rating/monthly`

Returns a prepared JSON report for the current calendar month in
`Europe/Moscow`: inclusive Moscow midnight on day 1 to exclusive midnight on
day 1 of the next month. An event belongs to its published scheduled month,
including a tournament administratively completed later. Game dates come from the
linked game booking (date/time or explicit ISO fields), rather than the publication
creation time; future events are
excluded. Confirmed training visits must also fall in this calendar window.

The existing `community-rating-v1.3.0` formula and ranking are reused:
`games × 0.20 + tournaments × 0.60 + activity × 0.20`. Normalization covers the
entire community before the first 20 rows are selected. Members with no points
remain eligible for rows. `totalMembers`, `activeMembers` and `tournamentsCount`
refer to the complete monthly population.

Response fields: `communityId`, `communityName`, `month` (`YYYY-MM`),
`period=calendar_month`, `timeZone`, `from`, `until`, `updatedAt`, `dataThrough`,
`stale`, `calculationVersion`, `columns`, `totalMembers`, `activeMembers`,
`tournamentsCount`, `limit=20`, `items`.

Each item matches the report columns: `rank`, `initials`, `playerName`,
`overallScore`, `scoreDisplay` (decimal comma), `currentLevel`, `levelDirection`
(`up|down|flat`), `lastRatingDelta`, `tournamentsPlayed`,
`tournamentMatchesWon`, `tournamentPointsScored`, `tournamentPointsDiff`.
The arrow uses the existing last personal rating delta, rather than position
movement. Phone numbers and internal player identities are excluded, including
phone-only name fallbacks. Numeric scores are rounded to at most two decimals.

Reports are atomically replaced in `community_monthly_reports` using the
unique `_id` derived from community ID and month. They do not enter the legacy
snapshot matrix or alter its health checks. A missing/incompatible current-month
report returns `503 MONTHLY_RATING_NOT_READY`; a report older than 16 hours
returns `stale=true`. Month rollover requires the first scheduled run or an
approved initial run before the new report is available.

### `GET /lk/communities/:communityId/events`

Lists published tournaments, games and training/events. Default `scope=upcoming`
includes future and currently running events; `scope=all` also includes history.
Archived, cancelled, draft, hidden and private publications/sources are excluded.
The endpoint reads stored publication/source availability; it does not fetch live
Viva capacity or reserve a place. Each item includes `postId`, `eventId`, `kind`,
`title`, `startsAt`, `endsAt`, `timeZone`, `status`, `signupUrl`, `canRegister`,
`availabilitySource=published_community_data`.

Registration links use the published stable event ID and the existing routes:
`https://padlhub.ru/tournaments?tournamentId=...`,
`https://padlhub.ru/game_join?gameId=...`,
`https://padlhub.ru/group_schedule?exerciseId=...`. Generic events may use only
these known public routes with one allowed ID parameter. Raw credentials and
arbitrary registration URL parameters are never forwarded. Completed/past events
have `signupUrl=null`; current events may have a link but `canRegister=false`.

Pages scan up to 200 publications sorted by publication `id`. Follow
`nextCursor` while `hasMore=true`, even when a page has no available items.
Items are sorted by start time within each page and deduplicated by kind/event ID
within that page; consumers merging pages should use the same key. Conflicting
source aliases are excluded rather than guessing a registration target.

### Recalculation and completion

`scripts/community_monthly_worker.mjs` prepares all active communities twice a
day, at **05:00 and 14:00 Europe/Moscow**. The runtime flag is default-off;
activation and flow/worker deployment are separate approved operations. See
`deploy/rating-worker/README.md` for the timer, shared lock and rollout order.

Before each report, the worker considers unfinished published tournaments. It
waits until `max(actualStartedAt/createdAt, publishedStart) + 3 hours`, requires
all scheduled rounds and valid entered integer scores, and preserves the stored
rounds/results. Missing or conflicting start times/IDs, incomplete scores,
existing tournament ledger events, start-rating overrides and newer canonical
player levels are reported for review. Partial results are not invented or
silently converted to losses.

Unattended apply requires guarded live result/create writers. Closure takes an
EJSON preimage, fsyncs it and its directory, then uses a conditional write over
the read lifecycle/results. A concurrent change skips that source; readback must
confirm completion, standings and unchanged rounds. Closed initial-create retries
are atomic no-ops with HTTP 409, and stale result saves also fail with HTTP 409.
The worker uses the existing recalculation function, has no TV-stop commands,
and does not directly modify canonical player ledger/state or provider data.

Checks: `npm run test:community-rating`, `npm run test:rating-worker-release`.
The `Community monthly MongoDB integration` CI job runs closure/create conflicts
against an isolated MongoDB 8 service matching the production major; without
`COMMUNITY_MONTHLY_TEST_MONGO_URI`, that integration test is explicitly skipped.
