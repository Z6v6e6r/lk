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
valid zoned `paymentDueDate` at least 60 seconds in the past, and contain no paid
or refund evidence. Unknown, partial, `WAITING`, and `PAID` statuses never cancel.
The event must not have started when a new cancellation is claimed.

## Operation and recovery

`scripts/run_lk1_unpaid_booking_cancellation.mjs` is a long-running 120-second
scanner. It requires `--run`, a tenant, a fresh explicit RFC 3339 cohort cutoff,
`LK1_UNPAID_CANCEL_MONGO_URI`, and exactly one Viva credential source: a protected
bearer token file, a protected service-credential JSON file, or the existing
`VIVA_SERVICE_*` environment. The service-credential path obtains and refreshes
its bearer token; its local cache is capped at 15 minutes even when Viva reports
a longer token lifetime. `LK1_UNPAID_CANCEL_DB` defaults to `games`. `--once`
processes one bounded page for inspection. The code never starts during a build
or import.

The production launcher `scripts/launch_lk1_unpaid_booking_cancellation.mjs`
uses no additional file containing Viva credentials. At startup it reads the
existing Node-RED PM2 environment and the exact Mongo client config in the
live flow **in memory**, checks that Node-RED is online, and passes them to the
worker. In `ENFORCE_NEW` the worker pins the exact deployed gateway function,
complete live flow bytes, and Node-RED PM2 process identity. It rechecks these
at every candidate and immediately before each Viva cancellation request; a
flow change, process restart, or outage stops further work. Its
[systemd unit](../scripts/lk1_unpaid_cancel_service/lk1-unpaid-cancel.service)
defaults to `OFF`; `/etc/padlhub/lk1-unpaid-cancel.env` is for nonsecret mode,
tenant, and cutoff values only. A service-credential password rotation requires
a worker restart to pick up the refreshed Node-RED PM2 environment.

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
The bundle contains the launcher, runner, three libraries, pinned MongoDB 7.2.0
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

The remaining provider race is a payment arriving between the last transaction
GET and cancellation PUT. The final transaction GET prevents a local claim
release if payment appears, leaving the operation for manual reconciliation.
Do not enable `ENFORCE_NEW` until Viva confirms that an expired `UNPAID`
transaction cannot capture a late payment, or a proven provider operation
closes that window before booking cancellation. One sampled absence of late
payments is not that guarantee.
