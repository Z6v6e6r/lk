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
*/15 * * * * /opt/padlhub-rating-worker/current/deploy/rating-worker/run-incremental.sh
17 3 * * * /opt/padlhub-rating-worker/current/deploy/rating-worker/run-full.sh
```

Both entrypoints use the same `flock` lock. MongoDB URI is read at runtime from
the active Node-RED flow. Viva credentials, when enabled for attendance sync,
are read from root-only `/etc/padlhub-rating-worker.env`.

Every run writes `rating_job_runs`, advances `rating_job_registry.watermark`
only after success, clears stale job errors, and includes `rating-worker-v1.0.11`
in the registry.

Detailed visit/worker reports are stored under `/var/lib` with mode `0600`;
the common cron logs contain aggregate summaries only. Historical backfill is
never part of cron: run `scripts/reconcile_player_rating.mjs` in dry-run mode,
review its report, and pass its exact confirmation token explicitly before
`--apply-backfill`.

Viva attendance synchronization is best-effort for this wrapper: a provider
authentication or transport failure is reported in `visits`, but does not
prevent the canonical rating ledger/state/outbox job from running.

Build an immutable source-only release locally with:

```bash
node scripts/build_rating_worker_release.mjs --out /private/tmp/padlhub-rating-worker-<release-id>
```

Copy the already verified `node_modules` from the active release on the server,
run `scripts/run_community_rating_recalc_147.mjs` first without `--apply`, and
switch `current` only after `scripts/postcheck_community_rating_147.mjs` succeeds.
