# Viva game court projection sync

## Problem

An LK game keeps a local projection of the linked VivaCRM exercise in
`lk_games.booking`. When VivaCRM moves the exercise to another court after the
game has been created, the current LK Games flow has no background process that
updates `booking.roomId` and `booking.roomName`. The cabinet therefore continues
to show the old court even though the provider exercise is already correct.

The release candidate built by
`scripts/prepare_viva_game_projection_sync_candidate.mjs` adds a bounded,
default-off worker to the existing `LK Games` tab and upgrades the exact
`Prepare game upsert` function. The create contract reads the tenant only from
`PADLHUB_PLATFORM_TENANT_KEY`, rejects a conflicting client tenant, binds the
upsert query to that tenant, and increments a numeric `revision` on every
successful write. It does not add an HTTP route and it reuses the tab's existing
MongoDB client.

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

The create contract is active as soon as the candidate is imported. If
`PADLHUB_PLATFORM_TENANT_KEY` is missing or invalid, create/draft/confirm fails
closed with `GAME_TENANT_CONFIG_INVALID`; a non-empty conflicting client value
fails with `GAME_TENANT_MISMATCH`. The environment must therefore be verified
before import even while the worker mode remains `OFF`.

Changing the mode, importing the candidate, restarting Node-RED, modifying
production environment variables, or applying a data migration is a separate
live-operation stage.

## Legacy tenant and revision migration

Production discovery on 2026-09-04 found legacy `lk_games` rows with
`tenantKey: null` and no numeric `revision`. The worker must not query or update
those rows as though they already belonged to the configured tenant.

`scripts/prepare_viva_game_projection_tenant_migration.mjs` creates a private,
offline, dry-run-only plan from three private projected inputs:

- Mongo game rows strictly limited to `_id`, status, tenant/revision state,
  provider identity, slot identity, and timestamps;
- Viva exercises fetched through the exact configured tenant and grouped by
  date;
- a reviewed read-only capture receipt for the tenant-bearing endpoint.

The planner rejects unrecognized top-level or nested fields, including
participant, phone, payment, roster, result, and room data, instead of accepting
a broad production export. It accepts at most 1,000 games across at most 14
days. A row is eligible only when it is active, both tenant and revision are
legacy-null/missing, every present Viva exercise identity agrees, and exactly
one active provider exercise matches exercise ID, studio, date, start time, and
end time. The planned Mongo filter repeats the legacy tenant/revision state and
the complete captured identity/concurrency state. The update is limited to the
configured tenant, `revision: 1`, timestamps, a bounded audit event, and an
operation marker; it carries literal `options: { upsert: false }`. Payment,
roster, booking, result, and provider state are excluded.

Example using already-created private projections:

```bash
npm run nodered:viva-game-projection-sync:migration-plan -- \
  --games-file /absolute/private/games.json \
  --provider-file /absolute/private/provider.json \
  --provider-capture-receipt-file /absolute/private/provider-receipt.json \
  --output-directory /absolute/private/migration-plan \
  --tenant-key iSkq6G \
  --expected-flow-sha256 <verified-live-flow-sha256> \
  --expected-provider-receipt-sha256 <reviewed-receipt-sha256> \
  --date-from 2026-09-04 \
  --date-to 2026-09-11 \
  --operation-id viva-projection-migration-20260904
```

`PADLHUB_PLATFORM_TENANT_KEY` must be set independently from the verified
runtime configuration and must equal `--tenant-key`. The expected flow hash
must come from the frozen live-flow readback and must equal the Mongo
projection's hash. All three inputs must be current-user-owned, single-link
regular `0600` files and are opened once; planning and hashes use the same
bytes. The output parent must be private and current-user-owned. The output
directory is created without replacement as `0700` and contains `0600`
`plan.json`, `summary.json`, and a final `READY` marker. Consumers must reject a
directory without `READY` or whose marker does not equal `summary.planSha256`.
The summary binds the plan, both projections, and the capture receipt by SHA-256
and always reports `writesPerformed: 0`. The planner has no apply mode. Mongo
`_id` values in the private plan use canonical Extended JSON
`{ "$oid": "..." }`; a future executor must parse them explicitly and must not
pass an unchecked JSON object to the driver.

The Mongo projection metadata must declare format version 1, source kind
`live-147-mongo-projection`, host `lk-primary-147`, exact source-flow SHA-256,
database `games`, collection `lk_games`, and capture time. The Viva projection
must declare format version 1, source kind `viva-end-user-tenant-projection`,
exact tenant, and capture time. Its separate read-once receipt must cover every
requested date exactly once, bind each rows array by SHA-256, report a complete
HTTP 200 array response, and use the exact tenant-bearing path
`/end-user/api/v1/{tenant}/exercises?date={date}`. Projected provider rows must
carry the capture tool's reviewed normalized `active: true`; contradictory IDs,
studios, cancellation flags, and lifecycle states are rejected. The reviewed
receipt SHA is supplied independently. Both projections expire after 30 minutes
and may be at most five minutes ahead of the planner clock. These labels and
hashes are validation inputs rather than a remote signature; runtime-tenant,
reviewed receipt, and frozen flow-hash comparisons are all mandatory before the
dry-run plan is reviewable.

Before a later live migration, freeze the exact flow and database identities,
prove a current backup and restore path, create the private projections without
exporting credentials or PII, review every skip reason, and prepare a separate
CAS executor plus rollback rehearsal. Apply requires its own live-data approval.
The cutover must hold a hard maintenance/write fence across create, draft,
confirm, PATCH, cleanup, split, roster, result, and every other `lk_games`
writer from snapshot capture through apply, candidate import/restart, and final
postchecks. Repeat non-overlapping bounded plans and reviewed CAS batches until
the inventory reports zero active legacy rows across the complete identity/date
scope reachable by create, draft, and confirm; a single selected window is not
a sufficient release gate. Every row skipped by provider or identity validation
must remain fenced and be explicitly quarantined or resolved before ingress can
reopen. Postchecks must also prove zero duplicate game identities across legacy
and tenant-bound rows, zero remaining active reachable legacy rows, and non-zero
provider-confirmed tenant-bound rows. If complete reachability cannot be proved,
keep the writers fenced.

Recovery must keep that fence closed and either finish the new create contract
or restore the exact data backup before restoring the old `08c2...` flow.
Reopening ingress on the old flow with migrated rows is forbidden because it can
write a null tenant without resetting revision. Start the worker in `SHADOW`;
`ENFORCE` still requires separate approval.

### Cutover packet and migration executor

The cutover is represented by one private packet assembled only from a fresh
live workspace, its exact candidate, one or more non-overlapping migration
plans, and a private controls receipt:

```bash
npm run nodered:viva-game-projection-sync:cutover-packet -- \
  --workspace /absolute/private/fresh-live-workspace \
  --candidate-directory /absolute/private/viva-projection-candidate \
  --migration-index /absolute/private/migration-plan-index.json \
  --controls /absolute/private/cutover-controls.json \
  --output-directory /absolute/private/new-cutover-packet \
  --tenant-key iSkq6G
```

The migration index has format version 1, the exact tenant, and `plans` entries
containing absolute private paths for `plan.json`, the Mongo projection, the
Viva projection, and the provider-capture receipt, plus the plan SHA-256. The
builder validates every source digest and capture receipt, deterministically
rebuilds each plan from those exact bytes, and copies the source evidence into
the packet. The controls
receipt has format version 1 and the same tenant. It records exact-head CI;
durable PM2 tenant provisioning and post-restart readback; a held writer fence;
the current `games.lk_games` backup manifest; an isolated restore rehearsal;
the exact Mongo replica-set identity; disposition
of every skipped row; and the prepared postcheck contract. A claimed `PASS`
with a missing hash, mismatched count, incomplete writer inventory, overlapping
plan range, unresolved skip, or mismatched flow/tenant/commit is rejected.
The backup manifest and restore-rehearsal receipt are themselves private inputs;
the builder reads, hashes, validates, and copies them into the packet evidence
directory. The packet manifest binds the exact commit, source, deterministically
rebuilt candidate, controls, reviewed-flow contract, plans, source evidence,
and every runtime/preparer executor source file. Packet preparation rejects a
dirty or different checkout whose executor bytes do not match the exact commit.
The coordinator, migration executor, and postcheck independently hash the full
packet tree and replay source validation, capture-receipt validation, freshness,
and deterministic plan reconstruction before any live transition.

The packet enumerates every `mongodb4` writer to `lk_games` in both the source
and candidate graphs. `aggregate` is conservatively classified as a writer,
and any dynamic Mongo collection anywhere in the flow or blank `lk_games`
operation is rejected as unclassifiable. A valid fence receipt must bind the exact writer union and the
complete set of migration operation IDs, show
write ingress blocked, internal schedulers stopped, Node-RED stopped, and all
writers quiescent. Production execution must use
`scripts/run_viva_game_projection_cutover.sh`. It starts a detached fence
guardian that inherits the canonical host `flock` descriptor and retains it
after coordinator success, failure, or interruption. The guardian releases the
descriptor only after a separate root-owned, token-bound release request with
confirmation `RELEASE_VIVA_GAME_PROJECTION_CUTOVER_FENCE_V1`. The descriptor is
identified by its process start identity, descriptor, device, and inode. A
fresh fsynced heartbeat proves that the detached process still owns that exact
descriptor; malformed or stale release requests are quarantined without
releasing the lock. The descriptor is held continuously across every migration plan,
candidate publication, `pm2 restart --update-env`, live read-only postchecks,
and READY-marker publication. A crash therefore leaves ingress fenced for
explicit reconciliation. The lower-level
`scripts/run_viva_game_projection_fenced_migration.sh` is retained for one
verify, reconciliation, apply, or restore action only. The executor performs a
full live PM2/tenant/flock/current-op check before and after each transaction,
uses a one-second watchdog during the transaction, and performs a cheap
descriptor/token/inode lease check around each CAS and readback. Mongo clients
use bounded connection, socket, operation, and commit timeouts. Each plan is
limited to 100 operations so those checks and the 15-second commit deadline fit
inside a bounded transaction. The receipt expires and must leave at least two
minutes on its lease. A generated packet always has
`liveMutationAuthorized: false`; `READY_FOR_SEPARATE_LIVE_APPROVAL` means the
evidence is internally complete for review, not that apply, import, restart, or
activation is authorized.

Before the first plan, the coordinator writes a durable `.prepared` recovery
artifact containing the exact preimage, revokes every role from the separately
identified application principal, and installs a strict impossible collection
validator on `games.lk_games` as a second layer. It proves that the application
principal receives authorization error 13 for transactionally aborted insert,
update, and delete probes and for drop, rename, and `collMod` probes. The pinned
migration principal must remain distinct and must prove a transactionally
aborted validator bypass. The previous roles and validator/options are stored
in the preparation and final private barrier receipts. A failed installation is
recovered only with the exact artifact and explicit
`npm run mongo:viva-game-projection-sync:barrier-recover` confirmation. Recovery
also requires the exact execution index, fresh writer-fence and guardian receipts, a live
guardian heartbeat holding the canonical lock inode, the frozen runtime in
`stopped`/`SHADOW`, and the exact clean executor commit. The operator command
writes a private, fresh recovery request; the guardian alone accepts it and
spawns the frozen recovery executor with its inherited canonical flock FD.
Release requests are quarantined while recovery runs. The executor repeats the
live flock, heartbeat, PM2, and receipt gates before and after every Mongo
recovery side effect. It durably records an outcome-unknown entry before
restoring Mongo state; retrying the same report path reconciles that journal and
completes the exact preimage. Its terminal journal entry contains the complete
report and hash before report publication, so a crash in finalization recreates
the report without repeating Mongo mutations. The validator is restored before
application roles are returned. This
Mongo barrier survives coordinator and guardian-process failure. The coordinator then rereads
the packet's complete EJSON backup and requires its document count and canonical
full-collection state hash to equal a fresh live scan under the barrier before
any tenant migration. It also requires the frozen plan ObjectIds to equal every
active legacy row from the packet generation date in UTC, without an upper date
bound. The boundary is generated independently of migration-plan ranges and is
revalidated against the fresh packet clock at every live entrypoint.

The executor accepts canonical EJSON ObjectIds and verifies the separately
pinned packet-manifest, cutover-plan, migration-plan, flow, tenant, host, and
fence hashes. It also rereads the Mongo-barrier receipt for every expensive
fence check. `verify` and `reconcile` are read-only. `apply` creates a private
full-BSON backup outside every Git worktree, fsyncs its file and directory,
reads it back and validates it before the first mutation, then repeats
the preimage check inside a majority transaction, uses only exact CAS
`updateOne(..., { upsert: false })`, requires one matched and modified row per
operation, and records postimage hashes. Each attempt uses an append-only,
fsynced state journal and writes `TRANSACTION_OUTCOME_UNKNOWN` before the
transaction begins. If the client loses the commit result, `reconcile` compares
every current document to the exact preimage and deterministic postimage; it
returns only `ABORTED_NO_MUTATION`, `APPLIED_RECOVERED`, or
`BLOCKED_MIXED_OR_DRIFT`. `reconcile-restore` separately distinguishes an
uncommitted restore, a fully recovered restore, and mixed/drifted state. `restore`
requires the exact apply receipt and backup, rejects any post-apply drift, and
restores every full preimage with CAS in a separate transaction. Apply and
restore each need a separately approved live-data transition and their exact
environment confirmation phrase; preparing or verifying the packet does not
set either phrase.

The restore rehearsal is produced by
`npm run nodered:viva-game-projection-sync:restore-rehearsal`. It restores the
exact complete backup into a newly named disposable replica-set database,
compares the live canonical state, writes the actual restored EJSON bytes and a
receipt, and marks the database with an exclusive random ownership record.
Cleanup verifies that marker and drops only the owned `lk_games` and marker
collections; it never drops the database, so a colliding unrelated collection
survives. The packet builder hashes and
revalidates those restored bytes; boolean-only restore claims are rejected.

After migration and candidate installation, the coordinator calls
`prepare_viva_game_projection_cutover_postcheck.mjs` while it still owns the
same lock. The postcheck requires the exact sequential coordinator journal,
including each in-flight entry before its matching applied receipt and all
applies before candidate publication and runtime restart. It rereads every
actual apply report and migration plan,
validates every apply receipt, compares every migrated row with its exact
postimage, requires the apply identities to equal the global unbounded legacy
coverage set, queries Mongo for remaining active legacy rows and duplicate provider
identities, checks for projection-worker audit writes since PM2 restart, and
reads back the exact candidate, runtime tenant, replica-set identity, Mongo
write barrier, live guardian heartbeat, executor-source hashes, exclusive host
lock, and `SHADOW` mode. `SHADOW` and the exact
tenant must already be present in stopped PM2 state, and the coordinator also
passes only the required runtime values into `pm2 restart --update-env`, while
clearing all cutover tokens, paths, descriptors, PIDs, and confirmation phrases.
The frozen PM2 ID, executable, cwd, arguments, Node arguments, and restart count
must remain exact through a ten-second stability dwell and a bounded local
`GET /flows` probe. The probe requires status 200 and the exact canonical hash
of the reviewed candidate flow. It hashes the actual evidence bytes and
atomically writes only the postcheck receipt and manifest. The standalone
postcheck never writes `READY_TO_REOPEN_INGRESS.json` and refuses synthetic hash
strings without the exact bytes.
Immediately before READY publication it repeats the current-time lease check,
exclusive-flock probe, Mongo barrier check, PM2 environment/status readback, and
candidate-flow hash. The coordinator first fsyncs its terminal success report
and terminal journal entry, then repeats the packet, writer fence, guardian,
Mongo barrier, PM2, and exact `/flows` gates. READY is written last and binds the
terminal report/journal hashes, exact execution-index SHA, coordinator attempt
UUID, barrier receipt, guardian receipt, and final guardian heartbeat.
If READY publication cannot be reconciled or durably removed, the publication
helper returns an explicit outcome-unknown path. The coordinator then keeps the
already validated SHADOW runtime online while ingress and both barriers remain
closed, avoiding a valid-looking READY marker that points to a stopped runtime.
The coordinator reports `POSTCHECK_PASS_INGRESS_STILL_BLOCKED`; it never opens
ingress. A failed postcheck emits no READY marker. If the candidate was already
published, the coordinator must prove PM2 `stopped`; a stop failure is reported
explicitly while the persistent host and Mongo barriers remain. Restoring the old flow is allowed only after
the exact data backup has been restored.

The coordinator consumes one private `viva-game-projection-cutover-execution-index`
whose SHA-256 is separately pinned. The index binds the packet, fence receipt,
tenant, exact plan/report/backup paths, a root-private migration-principal
connection file and its SHA-256, a new Mongo-barrier receipt path, flow-backup
directory, apply-index output, postcheck output, and canonical live flow path.
`PADLHUB_CUTOVER_GUARDIAN_RECEIPT`,
`PADLHUB_CUTOVER_GUARDIAN_HEARTBEAT`, and
`PADLHUB_CUTOVER_GUARDIAN_RELEASE_REQUEST` and
`PADLHUB_CUTOVER_GUARDIAN_RECOVERY_REQUEST` must point to new private paths
outside the repository. Live execution requires both
the migration confirmation and `VIVA_GAME_PROJECTION_CUTOVER_EXECUTE=`
`EXECUTE_VIVA_GAME_PROJECTION_CUTOVER_V1`; neither is present in a prepared
packet. Run `npm run nodered:viva-game-projection-sync:cutover-run -- --help`
for the bounded CLI. Producing a READY marker still does not authorize the
separate ingress-opening transition.

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
checks the exact `LK Games` tab, MongoDB anchor, and live create-function
preimage, changes only the create node's `func` field, preserves every other
existing node and every HTTP route at the JSON-object level, refuses node-ID
collisions, and writes private `0600` candidate/report files outside the repo.

Before any import, compare the report and full candidate with that same frozen
source, validate the target graph, verify the server tenant, complete the legacy
cutover gate above, and prepare a backup and rollback path. Begin runtime
acceptance in `SHADOW`; `ENFORCE` requires separate approval after the shadow
report is reviewed. Source tests and an offline candidate do not prove a
production import, provider read, MongoDB write, or cabinet rendering.
