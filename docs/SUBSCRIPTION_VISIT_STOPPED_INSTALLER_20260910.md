# Subscription visit: stopped DEV installer

Owner: LK subscription gateway. Audience: the operator of the dedicated synthetic
DEV host only. This is an installer implementation and local rehearsal. It does not
install anything on `lk-reserve-89`, enable or start a unit, open a port, or write a
payment, booking, provider or Mongo business record.

## Boundary

`scripts/lk1_subscription_visit_install/bundle.py` creates an immutable directory
with exactly `manifest.json`, `install.py` and `payload`. The payload contains the
approved DEV packet, an audited offline dependency closure, the extracted pinned
Node 22 executable, the private visit unit, its Mongo private-network drop-in and
the manifest environment file. The bundle records every payload hash, its own runner
hash, the runtime manifest hash, the Node archive hash and the dependency/audit
evidence hashes.

The pinned archive is Node `22.23.2` Linux x64 with SHA-256
`d60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307`.
No archive, closure or generated bundle is committed to Git.

`install.py` defaults to a check-only run. `--apply-stopped` additionally needs a
separate exact authorization JSON whose bundle-manifest hash and target host match.
The preparation stage does not create that authorization. It is an explicit later
control-plane artifact and has `startAuthorized: false`.

## Fail-closed checks

Before publishing any target, the installer verifies the exact host and service user,
the bootstrap Mongo unit hash, ownership and non-writable ancestry, absent start
markers, no service-user process, no listeners on 1882/3038/27030, and inactive plus
disabled dedicated legacy units. It rejects pre-existing visit targets rather than
replacing them.

Publication uses new staging paths and no-replace rename. A receipt records every
published target. If interrupted, the receipt remains `APPLYING`, the partial target
is preserved, and the next check holds with `INSTALL_TARGET_PREEXISTS`; it never
guesses a rollback, releases a subscription visit, deletes an unknown lock or starts
a service. A successful install only calls `systemctl daemon-reload`, then verifies
the new unit remains static, `RefuseManualStart=yes`, and both visit and dedicated
Mongo use `PrivateNetwork=yes`.

The server facts used to shape these checks were read-only observations on 2026-09-10:
the dedicated account is uid/gid 997, all five dedicated legacy units are
inactive/disabled, no dedicated listener is present, and both authorization markers
are absent. Those facts are stale by design and must be re-read immediately before an
authorized install.

## Local proof

`test_install.py` creates a synthetic private root and bundle. It proves:

- check-only validation changes no target;
- stopped publication succeeds once and is idempotent;
- apply without separate authorization is rejected;
- an interruption after the second publish retains the journal and blocks reuse.

The rehearsal replaces the Linux `renameat2` operation with a no-overwrite local
rename only inside a fresh synthetic root. It does not prove systemd parsing, the
real host preimage, Linux x64 dependency loading, or a live installation.

## Later, separately authorized work

Before an actual stopped install, rebuild the bundle from a clean checkpoint using a
fresh approved runtime packet, Node archive, Linux x64 closure inventory and zero-findings
audit. Re-read the host preimage; inspect the resulting manifest; then create the
separate exact installation authorization. Installing remains stopped. Starting the
Mongo and visit services, creating the start marker, real JOIN/payment/refund testing,
and any rollback action each require their own approval and verification.
