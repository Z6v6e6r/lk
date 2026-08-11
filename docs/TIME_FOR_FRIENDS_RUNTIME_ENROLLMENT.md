# Time for Friends runtime community enrollment

## Goal

New tournaments expose the exact communities where they are actively published,
and the rating worker automatically adds Time for Friends participants to the
resolved rating community before recalculating that community.

This is a runtime continuation of the one-time historical backfill. It does not
replace or rerun the historical repair script.

## Publication contract

`GET /lk/tournaments/americano/history?tournamentId=<id>` enriches each returned
tournament with:

```json
{
  "publishedCommunities": [
    {
      "communityId": "exact-community-id",
      "communityName": "Время на друзей — Станция",
      "publicationId": "exact-feed-post-id",
      "role": "RATING_PRIMARY",
      "stationId": "exact-viva-studio-id"
    }
  ],
  "ratingCommunityId": "exact-community-id",
  "ratingCommunityStatus": "RESOLVED"
}
```

`ratingCommunityStatus` is one of `RESOLVED`, `NOT_PUBLISHED`, or `AMBIGUOUS`.
A single active publication resolves implicitly. When a tournament has multiple
active publications, exactly one must have `publicationRole=RATING_PRIMARY`;
otherwise `ratingCommunityId` stays `null`.

On tournament broadcast start the server sends the Android integration:

```json
{
  "tournament_id": "exact-tournament-id",
  "community_id": "exact-community-id",
  "rating_community_id": "exact-community-id",
  "published_communities": [
    { "community_id": "exact-community-id", "role": "RATING_PRIMARY" }
  ]
}
```

The publication list is included when active publications exist. Singular
`community_id` keys are included only for a resolved rating community; ambiguous
relations never send scalar `null` values. The legacy no-publication request
remains unchanged.

New community tournament posts persist exact `directionId`, `studioId`, nested
direction, and nested studio snapshots. New tournament mechanics documents also
persist `params.directionId`, `params.directionName`, and `params.stationId`.
Names are display data only and never select an enrollment target.

## Automatic enrollment

`scripts/rating_worker.mjs` runs the enrollment step before community rating
recalculation. It is default-off and starts only when both values are configured:

```env
TFF_AUTO_ENROLLMENT_ENABLED=true
TFF_AUTO_ENROLLMENT_CUTOVER_ISO=2026-08-12T00:00:00.000Z
```

Incremental and full modes inspect only tournament documents/publication relations
changed at or after the cutover. Historical rows remain in the separately reviewed
backfill workflow.

An enrollment write is allowed only when all of the following are proven:

- the tournament has exactly one direction and it is Viva direction `5278`;
- tournament/publication station evidence resolves to exactly one station;
- the target community carries a server-owned `validatedPublications` row with
  exact publication, tournament, station, and `status=VALIDATED`; client-supplied
  feed author/member fields never grant mutation authority;
- there is one active publication, or one explicit `RATING_PRIMARY` publication;
- the target community exists, is active, and has server-maintained
  `ratingProgram={programKey:"TIME_FOR_FRIENDS",stationId,autoEnrollmentEnabled:true,validatedPublications:[...]}`;
- the publication, tournament, and approved community station IDs are identical;
- the player has an exact client ID;
- a roster player has explicit active state, a positive spot, and proven capacity;
  standings are accepted only after tournament finalization;
- the player is not already a member and not banned by exact ID/normalized phone;
- phone-only legacy membership does not leave identity ambiguous.

Multiple unmarked publications, untrusted publishers, unapproved community
metadata, direction/station conflicts, bans, unproven roster state, and unresolved
legacy identities are quarantined and produce no membership write. The worker does
not choose a level group from station name or community name.

Membership mutation is atomic and idempotent. It conditionally updates
`lk_communities.members`, removes the same identity from `pendingMembers`, updates
`memberCount`, and records an audit row in
`lk_tournament_community_enrollments`. Newly affected communities are recalculated
in the same worker run. Dry-run performs no writes.

The audit row is prepared before membership mutation. A failed conditional update
is read back and classified as an exact existing member, ban, inactive community,
or read-back failure. Unsafe outcomes fail the worker and do not advance its
watermark.

## Node-RED candidate

The source-first patcher consumes an exact live flow SHA and writes a new candidate
and audit report without changing the input or deploying:

```bash
npm run nodered:tournament-community-context:patch -- \
  --input /absolute/live/flows.json \
  --output /absolute/new/candidate.json \
  --report /absolute/new/report.json \
  --expected-flow-sha256 '<exact-live-sha256>'
```

The patch adds six nodes, rewires the existing history and broadcast tournament
lookups through the publication query, and updates only the reviewed broadcast
route function plus its catch scope.

## Remaining data boundary

Enrollment does not invent tournament standings. A participant can receive a
zero-activity snapshot immediately, but tournament points appear only when a
finalized local tournament document contains authoritative standings.
