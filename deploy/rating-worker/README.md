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

All entrypoints use the same `flock` lock. Incremental and full runs wait up to
120 seconds (`RATING_WORKER_LOCK_WAIT_SECONDS`, positive integer) before failing
with exit 75 and `rating_worker_lock_timeout`. This wait precedes the execution
watchdog, so it does not consume the worker runtime budget. Minute game-result
runs keep their nonblocking busy-skip behavior. Never split these modes across
separate locks: they share the rating ledger and projections.

MongoDB URI is read at runtime from
the active Node-RED flow. Viva credentials, when enabled for attendance sync,
are read from root-only `/etc/padlhub-rating-worker.env`.

Every cron entrypoint delegates to `run-with-watchdog.sh`. For the minute
game-result job, a busy shared lock is an expected skip: it exits successfully and appends a structured
`rating_worker_lock_skipped` event to the run log. A started process is bounded
by GNU `timeout`; the defaults are 55 seconds for the minute game-result run and
780 seconds for incremental/full runs. Timeout exits are non-zero and append a
structured `rating_worker_watchdog_timeout` event. The 780-second ceiling is
below the worker's 14-minute Mongo lease, so the next 15-minute cron can recover.

The wrapper also limits each spawned Node child to 12 minutes and the canonical
worker limits Mongo socket inactivity to 2 minutes. Operators may lower these
limits for diagnosis with:

```env
RATING_WORKER_GAME_RESULTS_HARD_TIMEOUT_SECONDS=55
RATING_WORKER_INCREMENTAL_HARD_TIMEOUT_SECONDS=780
RATING_WORKER_FULL_HARD_TIMEOUT_SECONDS=780
RATING_WORKER_CHILD_TIMEOUT_MS=720000
RATING_WORKER_MONGO_SOCKET_TIMEOUT_MS=120000
```

MongoDB credentials are inherited through the child environment and are never
placed in worker command-line arguments.

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
only after success, clears stale job errors, and includes `rating-worker-v1.0.13`
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
TFF_AUTO_ENROLLMENT_PROVIDER_ROSTER_ENABLED=true
TFF_AUTO_ENROLLMENT_PROVIDER_ROSTER_MAX_FETCHES=20
```

Both incremental and full jobs respect the cutover; they never replace the guarded
historical membership backfill. Provider roster reads are a separate default-off
gate. They use exact Viva exercise UUIDs, are capped per run, never persist the
fetched roster, and cannot replace the server-owned publication validation row.

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


## Calendar-month reports at 05:00 and 14:00 Moscow

### API reports without tournament closure

For an API-only release use `scripts/community_monthly_reports.mjs`. It reads the
actual persisted sources and writes **only** `community_monthly_reports`. It never
projects unfinished tournaments as finished, invokes finalization, enrolls players,
calls Viva, or writes canonical ratings. Dry-run is the default. Its `--apply`
requires the shared lock environment and matching inherited FD9; always invoke
`deploy/rating-worker/run-monthly-reports.sh`, which acquires the real existing
`/var/lock/padlhub-rating-worker.lock` and keeps the child inside a 780s watchdog.

Install a clean source-only release separately under
`/opt/padlhub-community-monthly/releases/<release-id>` and point its `current` at
that release. Do not replace `/opt/padlhub-rating-worker/current`: deployed
compatibility releases can contain published-tournament enrollment fixes absent
from the main package. Preserve canonical worker files, environment and cron.
Reuse verified production Mongo dependencies without running package installation
or `configure-runtime-env.mjs`. Check manifest hashes and actual Node22 imports.

Rehearse the report-only CLI without `--apply`, then deploy the reviewed API flow,
run the reports wrapper once, and read back both public APIs. Every write retains
a protected fsynced EJSON preimage under `/var/lib/padlhub-community-monthly/`.
Existing reports use full-document BSON-preserving CAS; absent reports use one
insert attempt. Conflicts and failed whole-document readback fail the run without
retry. Private per-run receipts distinguish verified publications, acknowledged
writes and failures, including partial multi-community runs.

Only after the initial run/API checks install and enable
`community-monthly-reports.service` / `.timer` (05:00 and 14:00 Europe/Moscow).
This separate timer publishes reports only. The existing `community-monthly`
auto-close timer/flag remain unchanged. Failed runs restart after 60s, bounded by
three starts per 30min; each new run reads fresh sources/preimages, while an
individual CAS/insert is never retried. Before updating or rolling back, stop both
the reports timer **and service**, cancelling any queued/active invocation; then
restore its previous package pointer under the same lock. Stopping the timer alone
does not cancel a service already waiting for the lock.
The durable EJSON envelope contains both the previous and intended new document;
successful receipts also retain the postimage hash. Derived reports are retained
on source rollback. Any necessary report restore
must compare the exact current document with the reviewed postimage, and must
not restore tournaments, participant lists or rating ledgers.

### Optional tournament finalization worker

The source-only release includes `run-monthly.sh` (executable),
`community-monthly.service`, `community-monthly.timer` and the monthly worker.
The timer uses explicit `Europe/Moscow` calendar times and `Persistent=true`.
It shares the existing worker lock. A monthly run waits up to 840 seconds for
that lock; lock timeout exits 75 and systemd retries. Once started, its watchdog
is 780 seconds. The monthly path does not run Viva attendance/provider sync or
the game-result job. Monthly reports and tournament preimages are stored under
`/var/lib/padlhub-rating-worker/monthly/<run>/` with directories 0700/files 0600.
The schedule does not become active merely by building or committing this code.

Flag (default-off):

```env
COMMUNITY_MONTHLY_WORKER_ENABLED=false
RATING_WORKER_MONTHLY_HARD_TIMEOUT_SECONDS=780
```

Before authorized activation:

1. Pass the rating/release tests and the isolated real-Mongo conflict CI job.
2. Pull a fresh active flow from `lk-primary-147` into a private external
   workspace; preserve its exact SHA256. Generate the additive candidate with
   `node --experimental-strip-types scripts/patch_nodered_community_monthly_flow.mjs
   --source <private-fresh-flow> --source-sha256 <sha256> --output <private-candidate>`.
   It adds the two GET routes and guards the existing result/create writers;
   it must not replace unrelated live functions from a stale repository export.
3. Install the immutable worker release with the flag off and deploy the reviewed
   flow candidate with the normal flow backup/lease and API postchecks. Apply
   refuses an active flow without the writer guards.
4. Run `node --experimental-strip-types scripts/community_monthly_worker.mjs`
   without `--apply` on the intended host. Inspect per-community totals, due
   tournament candidates and every skip reason. No closure/report writes happen
   in dry-run. Quarantined historical/reopened/incomplete tournaments require
   separate reconciliation; do not loosen this guard for broad activation.
5. After approval, enable the flag in the existing protected runtime environment,
   install/enable the supplied timer units and run through `run-monthly.sh`
   (including any approved initial run). Never bypass the shared lock by passing
   `--apply` directly. Preserve preimages and report receipts.
6. Read back `community_monthly_reports`, both public APIs, closed tournament
   scores/standings and conditional-write conflicts. Verify the next timer times
   and monitor the first 05:00/14:00 runs. The existing canonical rating worker
   processes newly completed tournaments on its own schedule; this job does not
   replay or overwrite player levels.

Rollback: disable the flag and timer first, retain the guarded flow until all
in-flight writes have stopped, then restore the reviewed worker/flow preimage if
needed. Already closed tournaments, reports and ledger events remain data to
reconcile explicitly; never blindly restore an old tournament over newer results.
The HTTP routes deny closed communities and do not accept caller-supplied member
identity as permission. Missing current-month data returns 503, rather than the
previous month's ranking.
