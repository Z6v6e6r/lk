# LK1 unpaid event booking cancellation

## Scope

The worker handles **new** LK1 group-training and tournament bookings with a durable
SMS checkout, positive amount, `subscriptionVisitCount=0`, and an `ON_PLACE` Viva
carrier. `ON_PLACE` alone is not an unpaid-payment signal. Open games already have
the split lifecycle. Events that consumed one subscription visit need a separate
return-of-visit design and are excluded.

The worker checks the exact operation, checkout, transaction intent, amount, owner,
exercise, and booking. Viva does not always echo the owner and booking in its
transaction GET; the stored intent and exact transaction ID bind those fields,
and any aliases Viva does return must match. Viva's fresh transaction must be exactly `UNPAID`, have a
valid zoned `paymentDueDate` at least 60 seconds in the past, plus a valid
`createDate` at least 26 minutes in the past, and contain no paid
or refund evidence. Unknown, partial, `WAITING`, and `PAID` statuses never cancel.
The event must not have started when a new cancellation is claimed.

Viva also represents a closed unpaid attempt as card `REJECTED` with the exact
`declineOutcome` `CANCELLED` or `EXPIRED` in that same card envelope. These terminal
shapes retain every transaction, amount, deadline and no-payment/no-refund check.
An unqualified rejection, unknown outcome or processing/paid alias still blocks
cancellation. The November 11 recovery rebinds the worker to the reviewed capacity
generation; it does not activate a historical backlog by moving the service cutoff.

Viva Admin can return a timezone-free `cancellationDate`. The booking classifier
accepts its strict calendar/time syntax only as corroboration of explicit
`isCancelled=true`; contradictory active aliases still block release. It does
not infer a timezone or relax transaction deadlines.

## Operation and recovery

`scripts/run_lk1_unpaid_booking_cancellation.mjs` is a long-running 120-second
scanner. It requires `--run`, a tenant, a fresh explicit RFC 3339 cohort cutoff,
`LK1_UNPAID_CANCEL_MONGO_URI`, and exactly one Viva credential source: a protected
bearer token file, a protected service-credential JSON file, or the existing
`VIVA_SERVICE_*` environment. The service-credential path obtains and refreshes
its bearer token; its local cache is capped at 15 minutes even when Viva reports
a longer token lifetime. `LK1_UNPAID_CANCEL_DB` defaults to `games`. `--once`
processes one bounded cycle of at most 100 rows. The code never starts during a build
or import.

The production launcher `scripts/launch_lk1_unpaid_booking_cancellation.mjs`
uses no additional file containing Viva credentials. At startup it reads the
existing Node-RED PM2 environment and the exact Mongo client config in the
live flow **in memory**, checks that Node-RED is online, and passes them to the
worker. In `ENFORCE_NEW` the worker pins the reviewed full-flow SHA, exact
gateway function, Node-RED PM2 process identity, and a protected SHA-256 of
the existing Viva service binding. At startup, authenticated read-only Admin
`GET /flows` responses must match the pinned disk flow and revision before and
after an empty request without Bearer to the direct Node-RED route. That route
must return `401 SUBSCRIPTION_BOOKING_AUTH_REQUIRED` before any Viva or Mongo
step. Stable PM2 snapshots bracket all three requests. The
worker rechecks its pins at every candidate, after provider awaits, and
immediately before each Viva cancellation request. Changed flow, binding, or
route stops with exit 78. A PM2 restart or temporary unavailability stops the
current attempt with exit 75; a fresh worker verifies the same pins before
processing. The systemd rate limit bounds rapid retries. Its
[systemd unit](../scripts/lk1_unpaid_cancel_service/lk1-unpaid-cancel.service)
defaults to `OFF`; `/etc/padlhub/lk1-unpaid-cancel.env` is for nonsecret mode,
tenant, cutoff, and binding digest only. A service-credential password rotation
requires a reviewed binding digest update and worker restart.

Each 120-second scan reserves at most 20 of its 100 rows for outstanding
`INTENT`, then scans unclaimed operations with the remaining capacity. Both
cursor positions are fsynced in the root-only systemd state directory. A worker
restart resumes those positions; a new tenant or cutoff stops until outstanding
`INTENT` is reconciled and the cursor state is deliberately replaced. An
interrupted page can be revisited because the durable operation state prevents
a second provider PUT.

Modes:

| Mode | Effect |
| --- | --- |
| `OFF` (default) | No Mongo or Viva connection. |
| `SHADOW` | Fresh provider readbacks and redacted candidate results; no writes. |
| `ENFORCE_NEW` | Cancel only operations created at or after the cutoff. |

Before a Viva write, a majority-journaled Mongo compare-and-swap stores
`lk1.unpaidCancellation.phase=INTENT`. The worker rechecks the transaction and
booking, probes `cancellationOnly.available`, and sends one client-scoped Viva
`PUT /bookings/{bookingId}/cancel` with `refundMethod=NONE` and
`cancelExercise=false`. It releases the LK1 claim only after exact canceled
booking readback and a final exact `UNPAID` transaction readback. A 2xx or 404
response to the cancel request is never cancellation proof.

If the process stops after Viva accepts cancellation, the next pass finds the
durable `INTENT`, confirms the canceled booking and unpaid transaction, then
releases the claim. If the booking remains active after an ambiguous attempt,
the intent moves to `REVIEW` and the worker does **not** send another cancel.
SIGTERM prevents a new cancellation request before the provider PUT starts;
an already in-flight request may still complete. Declare the worker stopped
only after process exit, then reconcile any `INTENT` against Viva and Mongo.
Provider/read failures leave `INTENT` for a later read-only reconciliation. The
LK1 ingress will not replay a stored payment link once an intent exists. A
cancelled operation cannot be retried with the same deterministic operation ID.
The current widget derives that ID from client, subscription and exercise, so it
cannot initiate a second booking for the same exercise after automatic cancellation.
That rebooking journey needs a separate safe successor-operation contract.

Logs contain a short SHA-256 operation label and state/reason only. Inspect
`REVIEW`, `PRECHECK_REQUIRED`, and `RETRY_STORE` before enabling or widening a
cohort. The Mongo operation is the durable audit record; do not log checkout
URLs, phone numbers, bearer tokens, or raw provider responses.

## Release and activation

The repository source alone is not a deployed service. The gateway guard also
requires a separate reviewed-flow release: pull a fresh private 147 workspace,
run `scripts/patch_live_lk1_unpaid_cancel_guard.mjs`, prepare a function-only
reviewed-flow contract, and use the guarded 147 deploy helper with backup,
lease, PM2 restart and exact live readback. The patcher pins the live full-flow
and gateway preimages; any drift requires a new review. Do not use quarantined
wide modular regeneration or an older LK1 hotfix wrapper.

Build the worker only from a clean, pushed commit with
`node scripts/lk1_unpaid_cancel_service/build_bundle.mjs ABSOLUTE_NEW_PRIVATE_DIR`.
The bundle contains the launcher, runner, four libraries, pinned MongoDB 7.2.0
package and lockfile, systemd unit, and an exact SHA-256 manifest. Run
`node verify_bundle.mjs ABSOLUTE_BUNDLE_DIR` before transfer and again on 147,
passing the locally recorded manifest digest as `--expect-manifest-sha256 SHA`
on 147.
Install it into a new root-owned mode-0700
`/opt/padlhub-lk1-unpaid-cancel/releases/<sourceCommit>` directory, run
`npm ci --omit=dev --ignore-scripts` there, and run
`node verify_bundle.mjs --installed ABSOLUTE_RELEASE_DIR` afterward. The
preinstall verifier rejects extra files, including `.npmrc` and `node_modules`.
`npm ls --omit=dev`, `node --check` on both entrypoints, and
`systemd-analyze verify` on the unit must pass before an atomic `current`
symlink switch. Copy that verified unit into
`/etc/systemd/system/lk1-unpaid-cancel.service`, preserving any old unit for
rollback; then `systemctl daemon-reload` and verify `systemctl cat` and the
unit fragment path and SHA-256 against the bundle before starting. Preserve
the previous release and symlink target for rollback. The source commit, manifest digest, lockfile hash,
installed dependency version, `current` target, service status, and sanitized
SHADOW log are the deployment readback. No source file or credential is edited
on the host. A failed service start restores the prior symlink and unit, reloads
systemd, and restarts the prior release; any ambiguous `INTENT` is reconciled
before restart. A detected runtime drift exits with code 78 and a fixed reason;
the unit explicitly prevents automatic restart for that code. An operator must
review the changed flow and restart the service deliberately.

Before `ENFORCE_NEW`, compute `LK1_UNPAID_CANCEL_BINDING_SHA256` from the four
existing Node-RED PM2 `VIVA_SERVICE_*` values with the worker's
`lk1VivaBinding()` helper and put only the digest in the root-owned mode-0600
activation environment file. Set `LK1_UNPAID_CANCEL_NODE_RED_ADMIN_TOKEN_FILE`
to the root-owned mode-0600 `/etc/padlhub/lk1-unpaid-cancel-guard/service.token`
in a root-owned mode-0700 directory. This dedicated 256-bit opaque service token
uses Node-RED 4.0.9's supported `adminAuth.tokens` hook and exact `flows.read`
permission. It cannot deploy flows or read unrelated Admin settings/context.
It is independent of `.sessions.json`, editor login/logout and session expiry.
Never write/log credential values in source or release artifacts. Without the
protected file, `ENFORCE_NEW` stops before Mongo or Viva access.

`lib/lk1FlowReadTokenAuth.cjs` is part of the verified immutable worker bundle.
The source-driven `patch_lk1_flow_read_auth_settings.mjs` appends a guarded
settings adapter pinned to that immutable module path; it preserves existing
users/passwords/authenticate/default/session expiry and rejects preexisting token
hooks/modules/custom headers. Retain the immutable release referenced by settings
until a reviewed auth rollout removes that reference; worker release cleanup must
not delete the active auth module. Generate the token only on the server. The hook
reads its protected file on every request, uses full constant-time digest
comparison and fails closed on unsafe/missing files. Atomic file rotation revokes
the previous token on the next authentication request, without editing sessions.

Settings rollout requires exact live settings/flow/PM2 preimages, backup and one
reviewed Node-RED restart with worker stopped and no outstanding INTENT/REVIEW.
Verify actual installed auth middleware in an isolated fixture: service flows
read succeeds, writes and unrelated reads fail, expired editor session does not
affect service access, existing editor access remains valid. Never probe Admin
writes on production. Then verify live active-flow/revision equality, unauth401,
protected file custody and the unchanged cohort/cursor on worker restart. A new
payment observation window is unnecessary when only this authentication adapter
changes; payment classifier/worker logic and its prior acceptance stay unchanged.
Rollback restores exact settings/env/current and rebinds the guard; after the old
session expires it cannot promise ENFORCE and must leave the worker stopped if
service authentication is unavailable.
The worker for the coordinated Friendship-special/residency release pins full-flow
`9260954f988dd396c0b22f3dbe792a2b45e5244c2e07c9485cca76b555a80fc6` and gateway
`bca5774dc55b6a0d4eb271496a0c14b8b5aea2c80d7c1f94a67eb3771f3bbd89`.
Build/install this clean pushed bundle together with that reviewed flow; the old
bundle remains paired with source flow `3d454ddace61985d4a1d6d92790fcfd25aa7ac8f26911c145c50bd83394e8383` for rollback.
Stop the existing worker and wait for exit before switching either side. Preserve
its prior mode, cohort, cursor, binding and protected token. This coordinated
source-only pin refresh does not authorize a new cohort or mode activation.

The unit defaults to `OFF`. Activate `SHADOW` with a root-owned mode-0600
`/etc/padlhub/lk1-unpaid-cancel.env` containing only mode, tenant, and a fresh
new-cohort cutoff. Keep the service stopped while applying or rolling back any
Node-RED flow, even though its runtime pin also stops writes on detected drift.
Wait for process exit before changing the flow; then restart in `SHADOW` and
check the new runtime pin. Never switch to `ENFORCE_NEW` as part of installation.

For activation, pin the deployed gateway and Viva cancel API contracts, set a
fresh cohort cutoff, observe a full payment-deadline window in `SHADOW`, and
verify an exact natural case in Viva and Mongo after activation. Test graceful
stop, token refresh/rotation, backup, and restart first. A read-only 147 probe
on 2026-09-29 showed one `ELIGIBLE` in an eight-hour diagnostic cohort; two
transactions were not `UNPAID` and three other operations failed closed on
binding/state checks. That probe did not authorize writes or satisfy the full
new-cohort observation window.

The operator confirmed on 2026-09-29 that a Viva payment link lives 25 minutes,
an expired transaction cannot be paid, and a payment begun before expiry cannot
settle as `PAID` afterward. The classifier therefore waits
until both `paymentDueDate + 60 seconds` and `createDate + 26 minutes` and
requires a fresh exact `UNPAID` immediately before cancel. If provider behavior
changes, stop the worker.
An aggregate read-only 147 probe found `createDate` and `paymentDueDate` in all
nine sampled LK1 event transactions; their provider due time was 20 minutes
after creation. The 26-minute bound protects the extra five minutes of link
life even when the earlier provider due time has passed.
The final transaction GET prevents local claim release if an unexpected payment
appears and leaves that operation for manual reconciliation.
