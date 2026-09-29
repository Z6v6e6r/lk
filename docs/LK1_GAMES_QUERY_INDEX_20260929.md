# LK1 public games query: date/station index

## Evidence and scope

Read-only production check on `lk-primary-147`, 2026-09-29 16:26 MSK:

- Active `GET /lk/games` query function SHA-256: `2535de7d1219cc56fe4eb752c5b4df14f9f4dc1f8f2443a0b29422fb3af990ee`.
- Mongo binding: `games.lk_games`, `mongodb4` find/toArray node `77859abc9f190e6b`.
- Collection: 19,007 documents, 195,813,731 logical bytes.
- Representative future public date/station query: 6 returned, 19,007 documents examined, 0 keys examined, `COLLSCAN`, 1,128 ms in `executionStats`.
- Existing `schedule_station_date_time_v1` starts with `booking.studioName`; it does not serve the dominant `booking.date` + `booking.studioId` query. The payment/booking wildcard index covers different fields.

Isolated MongoDB 7.0 rehearsal on 19,007 synthetic games passed: the same
date/station query examined 19,007 documents before the index and 6 documents
plus 6 keys after it; `COLLSCAN` became `IXSCAN`. Server execution times in
that local fixture were 16 ms and 0 ms. These times are not a production
latency claim. The temporary database/container was removed after the test.

`scripts/manage_lk_games_public_index.mjs` manages only
`{ "booking.date": 1, "booking.studioId": 1 }` named
`lk_games_public_date_station_v1`. It does not change game documents, Node-RED,
subscriptions, payments, chat, or response shapes. The index is intended for
the repeated date/station public-list requests; date-less and actor/phone lookups
need separate evidence and changes.

## Ordered activation and stop conditions

1. Review the preserved result of
   `LK_GAMES_PUBLIC_INDEX_TEST_ISOLATED=YES LK_GAMES_PUBLIC_INDEX_TEST_MONGO_URI=mongodb://127.0.0.1:27018 node --test scripts/tests/lkGamesPublicIndex.mongo.test.mjs`.
   Repeat on a loopback isolated MongoDB if the index/query contract changes;
   the test refuses a non-loopback URI or absent isolation confirmation.
2. Run the index tool on `lk-primary-147` from the reviewed checkout with its
   locked Node.js dependencies, using the current mode-0600
   `/root/.node-red/flows.json` as `--flow-path`. Verify the source function
   SHA, Mongo node/config, target namespace, index catalog and production
   identity. Do not commit or print the flow or URI. Node-RED imports use a
   separate fresh external workspace; this index step does not import a flow.
3. Run the tool's `plan` against that live flow. Review `readyForApply`,
   `planDigest`, `targetFingerprint`, probe count and baseline `explain`. The
   private `--out` file is an append-only JSONL journal: the last complete
   line is the final report; an incomplete tail is ignored only when reading a
   rollback receipt. `MUTATION_PENDING` remains after an interrupted
   write; after exact catalog readback, a durable `CATALOG_VERIFIED` line
   contains the rollback receipt even if the query postcheck fails. Stop
   on a binding mismatch, missing future public probe, catalog conflict,
   Mongo unavailability or other source drift.
4. Obtain explicit authorization for the exact production schema action:
   create `lk_games_public_date_station_v1` on `games.lk_games` at
   `lk-primary-147`, with the reviewed digest and bounded observation.
   Only then set `LK_GAMES_PUBLIC_INDEX_APPLY=APPLY_LK_GAMES_PUBLIC_DATE_STATION_V1`
   and run `apply --flow-path ... --expected-plan-digest ... --out <new private receipt>`.
5. Require `outcome=SUCCEEDED`, an exact index catalog readback and an `IXSCAN`
   of the managed index for a returned future public date/station row. Compare
   `docsExamined`, Mongo execution time, `/lk/games` p95/5xx, Node-RED RSS,
   event-loop lag and restart rate over comparable traffic windows. An immediate
   drop in RSS after a restart would not prove a memory fix; this index requires
   no Node-RED restart.
6. Stop if the index is unused, errors increase, or unrelated production state
   drifts. Reconcile an `UNKNOWN_RECONCILIATION_REQUIRED` receipt before any
   retry. A verified catalog receipt (`SUCCEEDED`, `CATALOG_VERIFIED`, or
   `POSTCHECK_FAILED_INDEX_PRESENT`) can authorize an exact guarded rollback;
   a pending or unknown receipt cannot. A rollback requires separate exact
   authorization and the verified apply receipt:
   `LK_GAMES_PUBLIC_INDEX_ROLLBACK=ROLLBACK_LK_GAMES_PUBLIC_DATE_STATION_V1`
   with `rollback --flow-path ... --expected-plan-digest ... --apply-receipt ... --out ...`.
   Never drop a foreign or changed index.

No production index creation or rollback is part of this repository change.
After the index's measured effect, identify the four-minute public-list sweep
owner from source/config evidence and remove duplicate polling at its owner.
Then assess the game-list payload projection and actor/chat lookups with
contract and security tests. Re-measure live memory and latency before deciding
whether completed games need a hot/cold collection. Physical archival must
separately preserve results, payment/booking reconciliation, chat, and rating
lookups and requires a rehearsed migration and recovery plan.
