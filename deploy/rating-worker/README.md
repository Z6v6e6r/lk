# PadlHub rating worker deployment

Stable layout on `lk-primary-147`:

```text
/opt/padlhub-rating-worker/
  releases/<release-id>/
  current -> releases/<release-id>
/var/lib/padlhub-rating-worker/runs/<date>/
/var/log/padlhub-rating-worker/
```

Cron contract:

```cron
* * * * * /opt/padlhub-rating-worker/current/deploy/rating-worker/run-game-results.sh
*/15 * * * * /opt/padlhub-rating-worker/current/deploy/rating-worker/run-incremental.sh
17 3 * * * /opt/padlhub-rating-worker/current/deploy/rating-worker/run-full.sh
```

All entrypoints use the same `flock` lock. MongoDB URI is read at runtime from
the active Node-RED flow. Viva credentials, when enabled for attendance sync,
are read from root-only `/etc/padlhub-rating-worker.env`.

Game-result processing is disabled by default. Enable it only after the matching
Node-RED result flow and worker release have both passed postchecks:

```env
GAME_RESULT_RATING_WORKER_ENABLED=true
GAME_RESULT_RATING_WORKER_LIMIT=20
```

The result endpoint persists the score and a versioned `ratingWork` envelope in
one MongoDB write and returns immediately. The minute worker leases due work,
stores a deterministic prepared plan, appends immutable ledger events, replays
canonical player state, and only then marks the job `APPLIED`. A dispute queues
the same result for `REVERTED`; an author correction is a new score revision and
waits until the predecessor compensation has completed. Retries reuse event IDs,
so a crash after event insertion does not apply the rating twice.

Rollout order:

1. Build and install the worker release with the flag still `false`.
2. Import the result-flow patch built from a freshly pulled `lk-primary-147` flow.
3. Run the game-result worker without `--apply` and inspect the candidate report.
4. Set `GAME_RESULT_RATING_WORKER_ENABLED=true`, install the minute cron, and
   submit one controlled rating game.
5. Verify `lk_game_results.ratingWork`, immutable ledger events, canonical player
   state, the game roster projection, and the Viva projection outbox before broad use.

Rollback is two-part: disable the flag first so no new jobs are leased, then
restore the backed-up Node-RED flow. Already persisted jobs and ledger events must
be reconciled explicitly; do not delete them or edit player ratings in place.

Every run writes `rating_job_runs`, advances `rating_job_registry.watermark`
only after success, clears stale job errors, and includes `rating-worker-v1.0.12`
in the registry.

Detailed visit/worker reports are stored under `/var/lib` with mode `0600`;
the common cron logs contain aggregate summaries only. Historical backfill is
never part of cron: run `scripts/reconcile_player_rating.mjs` in dry-run mode,
review its report, and pass its exact confirmation token explicitly before
`--apply-backfill`.

Time for Friends runtime enrollment is also disabled by default. Enable it only
after approved communities carry exact `ratingProgram` metadata and a dry-run from
the intended cutover has no unresolved quarantine:

```env
TFF_AUTO_ENROLLMENT_ENABLED=true
TFF_AUTO_ENROLLMENT_CUTOVER_ISO=2026-08-12T00:00:00.000Z
```

Both incremental and full jobs respect the cutover; they never replace the guarded
historical membership backfill.

Viva attendance synchronization is best-effort for this wrapper: a provider
authentication or transport failure is reported in `visits`, but does not
prevent the canonical rating ledger/state/outbox job from running.

Build an immutable source-only release locally with:

```bash
node scripts/build_rating_worker_release.mjs --out /private/tmp/padlhub-rating-worker-<release-id>
```

The source-only package includes the shared Viva request helper used by attendance
sync. Run `npm run test:rating-worker-release` to verify the packaged manifest,
helper checksum, and clean module resolution before installing a release.

Copy the already verified `node_modules` from the active release on the server,
run `scripts/run_community_rating_recalc_147.mjs` first without `--apply`, and
switch `current` only after `scripts/postcheck_community_rating_147.mjs` succeeds.
The postcheck report now treats orphan community snapshots as non-blocking
aggregates (`orphanSnapshots` / `orphanSnapshotCommunities`) while keeping
strict checks for active community matrix, uniqueness, formula, and last-change.
