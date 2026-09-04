# Viva game court projection sync

## Problem

An LK game keeps a local projection of the linked VivaCRM exercise in
`lk_games.booking`. When VivaCRM moves the exercise to another court after the
game has been created, the current LK Games flow has no background process that
updates `booking.roomId` and `booking.roomName`. The cabinet therefore continues
to show the old court even though the provider exercise is already correct.

The reconciliation graph in
`scripts/prepare_viva_game_projection_sync_candidate.mjs` adds a bounded,
default-off worker to the existing `LK Games` tab. It does not add an HTTP route
and it reuses the tab's existing MongoDB client.

## Runtime behavior

Every five minutes the worker:

1. Acquires a six-minute, run-ID-owned process-local lease and reuses the shared
   VivaCRM service-token cache.
2. Selects up to 1,000 non-archived, non-cancelled, revisioned LK games for the
   configured tenant and the current Moscow date through the lookahead boundary.
3. Rejects malformed rows, cross-tenant rows, and rows whose Viva exercise IDs
   disagree across booking, metadata, and dedupe fields.
4. Reads the VivaCRM Admin exercises endpoint for each date, with page size 200,
   at most five pages per date, rate limiting of two requests per second, bounded HTTP
   timeouts, and redirects disabled. Unknown response containers, missing page
   metadata, and contradictory pagination fail the date closed.
5. Accepts only one exact provider exercise with the same exercise ID, studio,
   date, start time, and end time. Cancelled, missing, duplicate, truncated, or
   ambiguous provider data produces no write.
6. In `ENFORCE`, applies a MongoDB compare-and-swap update bound to the exact
   game ID, tenant, revision, Viva exercise, studio, and previous room values.

The update is restricted to:

- `booking.roomId`;
- `booking.roomName`;
- `updatedAt`;
- `revision`;
- the bounded audit trail with event `GAME_BOOKING_ROOM_RECONCILED`.

Roster, payment, result, status, booking IDs, and provider state are not changed.
The last sanitized diagnostic is stored in the Node-RED global context under
`lk_viva_game_projection_sync_last_report`; tokens and request headers are not
included. A run-level counter waits for every date and Mongo acknowledgement,
latches the first branch failures, and publishes one aggregate terminal report.
One date's success therefore cannot replace another date's provider or CAS
failure.

## Configuration

`VIVA_GAME_PROJECTION_SYNC_MODE` controls the worker:

- `OFF` is the default and performs no provider or MongoDB read.
- `SHADOW` reads both systems and reports drift without a MongoDB write.
- `ENFORCE` allows the room-only compare-and-swap update.

`VIVA_GAME_PROJECTION_SYNC_LOOKAHEAD_DAYS` defaults to `7` and is clamped to
`1..14`. The worker also requires the existing `PADLHUB_PLATFORM_TENANT_KEY`,
`VIVA_SERVICE_USERNAME`, `VIVA_SERVICE_PASSWORD`, and optional VivaCRM token
endpoint/client settings used by the other service-token consumers.

Changing the mode, importing the candidate, restarting Node-RED, or modifying
production environment variables is a separate live-operation stage.

## Candidate preparation

At release time, start from a fresh private workspace pulled from
`lk-primary-147`; the tracked flow snapshot is not an acceptable input:

```bash
bash scripts/pull_nodered_source_from_147.sh /absolute/external/workspace
npm run nodered:viva-game-projection-sync:candidate -- \
  --workspace /absolute/external/workspace \
  --output-directory /absolute/external/viva-game-projection-candidate
```

The builder requires a verified `live-147` source younger than 30 minutes,
checks the exact `LK Games` tab and MongoDB anchor, preserves every existing node
and HTTP route byte-for-byte at the JSON-object level, refuses node-ID
collisions, and writes private `0600` candidate/report files outside the repo.

Before any import, compare the report and full candidate with that same frozen
source, validate the target graph, and prepare a backup and rollback path. Begin
runtime acceptance in `SHADOW`; `ENFORCE` requires separate approval after the
shadow report is reviewed. Source tests and an offline candidate do not prove a
production import, provider read, MongoDB write, or cabinet rendering.
