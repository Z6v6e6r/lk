# Worker generation for PR403 activation

The installed cancellation worker is built from source74f59966 and remains
bound to the pre-403 whole-flow and gateway hashes. Its existing guard correctly
refuses a new backend generation. A restart of that old bundle cannot rebind it.

This source carries the same already-installed generation-attestation guard and
changes only its two expected generation hashes relative to the installed code.
All13worker bundle payloads must compare equal to the installed bundle except
`lib/lk1LiveGatewayGuard.mjs`; stripping its two pins must recover the exact old
guard. Existing unit, dependencies, mode, tenant/cohort, auth and cursor remain
unchanged. Native-deployment guard regressions are included in CI so the source
also retains the already-installed no-restart generation behavior.

The pins refer specifically to the PR403 two-function candidate produced from
the reviewed preimage by `prepare_legacy_cancellation_recovery.mjs` and persisted
as its exact candidate bytes by the existing guarded full-runtime installer.
They do not authorize deployment or startup effects. Native editor storage has
a different byte encoder and requires its own exact packet; do not reuse these
pins against a differently serialized flow or replace them on the server.

Activation sequence after explicit approval of the actual backend operation:

1. Preserve fresh source/active/editor/runtime state and immutable worker bundle,
   current pointer, unit/env/cursor and pending-job inventory under the shared
   release lock. Refuse foreign state or an incompatible active lease.
2. Stop only the cancellation worker and wait for PID0, preserving processing state.
3. Apply exactly PR403 through the existing reviewed exact-graph installer, using
   retain-candidate on a lost/failed ACK. Do not replay an uncertain apply, delete
   a lease or automatically restart/rollback repeatedly.
4. Verify active/disk/source equality, new expected hashes and runtime health;
   finish the full backend15-minute observation before worker transition.
5. Stage a new immutable worker bundle built from clean pushed matching-CI source.
   Verify manifest, dependencies and installed unit. While stopped, switch current
   atomically with expected-pointer checks and keep the prior auth release.
6. Require the normal exact read-only guard attestation, then start the unchanged
   service once. Observe a complete scan cycle and15minutes with stable status,
   valid cursor progress, no guard/auth/runtime failures and preserved job scope.
7. Verify client eligibility using current reads and the exact loaded function
   in a VM that refuses real provider/DB mutations. Do not create a test booking.

Source/code rollback cannot undo a completed cancellation or other startup write.
If new readiness fails, keep the worker stopped; restore its previous pointer
only while stopped and do not start old pins against a new backend. The backend
inverse remains a separate guarded transition preserving intervening changes.
