# Game PATCH409 activation

PR369 runtime is activated by a separately pushed, clean release source. The
production rollout uses two existing custody boundaries in sequence; it does not
change auth, middleware, response/CORS headers, keys, nginx or business writes.

1. Fresh private `nodered:modular:pull-147` and `nodered:modular:verify`. Prepare
   `prepare_gamepatch409_hooks.mjs` from that exact source. Both enabled PATCH
   routes must reach the reviewed authorize/ACK source hashes. Apply only those
   two function bodies with the existing reviewed-flow installer, backups and
   shared flock/15-minute lease. With no observer these hooks are inert. Complete
   the guarded candidate reconciliation after its soak; never remove a lease.
2. Collect a fresh private settings/flow/machine/process snapshot after hook
   activation and soak. `prepare_gamepatch409_runtime.mjs` generates the immutable
   bundle and exact settings suffix without evaluating supplied settings. The
   game-specific installer binds whole flow, both routes and hook hashes,
   settings bytes/mode, machine, PID/restart count, source release, bundle and
   installer digest. It uses the same kernel flock and sticky shared lease.
3. Apply with `PADLHUB_GAMEPATCH409_INSTALL=CONFIRM_147`, exact packet contract
   digest and target147. One PM2 restart must register the matching generation,
   bundle, process, scope and startup self-test receipt before SOAKING. Startup
   synthetic fixtures never reach the production sink. Finish after15 minutes
   with unchanged sources/process and an attested receipt. Retain backups and
   receipts. Unknown restart/publication state retains custody for explicit
   settled-process recovery; no automatic retry or foreign-lease cleanup.

The settings installer state machine, lock/process adapters and packet builder
derive from the reviewed subscription409 installer source
`9cd9ccbadf4d9961b69be59a9bb46696420bc8dc`. Names/targets/hook roles are scoped to
gamePATCH409. The corrected bootstrap publication semantics come from merged
`subscription-booking-bootstrap.mjs`: a committed READY receipt cannot be paired
with a removed observer after a directory-fsync failure. Settings mode support is
local to this installer; the shared flow writer is unchanged.

The observer gates before inspection and again before its existing PM2 JSON sink:
only PATCH direct/records game routes, authorize binding/version409 or ACK
version409. It emits the merged strict sanitized schema, source release,
server-minted request ID, validated client build/operation claims and trusted
phase; no raw IDs, body, version values, credentials or entity references. Missing
metadata remains UNKNOWN. Detail budget and suppression remain bounded. Existing
instrumented unrelated nodes stay inert. No middleware is attached.

Rollback order: settings first through its owning installer and exact contract;
the harmless inactive hooks may remain. An optional subsequent hook rollback must
use its own reviewed backups and current-state guard. Never restore the flow
first: the settings installer attests that entire installed flow.

Frontend release sources project only reviewed diagnostic code/dependencies onto
the separately reproduced installed cabinet/games sources, preserving the actual
exhibition-widget pin and every unrelated installed artifact. Verify clean pushed
sources, compiled conflict/metadata fixtures, candidate/live desktop and mobile
smoke with all real writes blocked, all public file hashes, and natural409 logs.
Synthetic fixtures and natural production evidence must be reported separately.
