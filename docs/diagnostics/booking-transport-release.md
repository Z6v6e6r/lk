# Booking transport recovery: deployment preparation

Owner: LK operator. Audience: deployment reviewer/operator for lk-primary-147.
Scope: two new nodes restoring HTTP transport exceptions to the existing booking
owner, one compatible unpaid-worker generation, and the purchase diagnostics
allowlist already in PR342. Product rules, prices, deadlines and provider actions
are unchanged. Readiness covers this exact flow/worker pair.

## Refresh for the current runtime, 12 November 2026

The previous packet is superseded. PR344 (`4f0a48fc`, implementation `3c642922`)
added proof-based exclusion/release of cancelled unpaid reservations and explicit
successor selection. PR345 (`d554917e`, implementation `d95406db`, worker release
`d0e7f3d8`) added native free-visit cancellation and background recovery. Those are
business changes, not only pin updates. The task branch integrates current main
without rewriting its history or reverting either release.

The transport fix is still required: the installed HTTP consumer matches the
official4.0.9 fixture, senderr=true, and no Catch covers the booking HTTP node.
The two proposed nodes are still absent. The current private proof records
`SENDERR_TRUE_WITHOUT_HTTP_CATCH`; an implementation hash or custody change blocks
preparation rather than silently assuming the old behavior.

## Current live evidence

- Loaded Admin flow equals disk; Node-RED identity and on-disk bytes remained
  stable across the inspection. Only existing authenticated Admin GETs and inert
  owner capability GETs were used.
- Owner V1/ATOMIC_MANAGED_V1 and V2/MANAGED_JOIN_V2 return200. V3 and the training
  capability return their expected unsupported404. The candidate preserves this
  installed contract; it does not regenerate newer source wrappers.
- Five synthetic transport cases ran against the actual installed body in a VM:
  profile/http returns502; booking_create/http, booking_create/split,
  confirmation_bookings/http and lk1_transaction_create/http return202 pending.
  Coverage markers confirm the intended branches were reached. No HTTP, Mongo or
  asynchronous node.send dispatch occurred. The VM had no credentials, live
  context, transport, process, timers or database capability.
- Four additional cases cover the installed native cancellation adapter before
  acceptance and after dispatch uncertainty, cancelled-booking readback and visit
  return readback. They return503 before acceptance or202 pending after durable
  acceptance, with unchanged protocol state and no HTTP/Mongo/node.send dispatch,
  SERVICE retry, release or legacy fallback.
- Source flow120065b362f1b5dd4c9a69e9e50d4c3aacc2ce8939a27320a43de48c0ff3d399
  becomes candidate81026a59d077aa820687b61b0c5f4cb1d5a963ca466bfa4ac215f348a7a25947.
  All4985 existing nodes are preserved; the exact-graph contract allows only the
  two new Catch/recovery nodes. Booking gateway hash remains
  3dfbf374f318891e19bb1302482a8053fd6423eb0acf2a8d455601771529753a.
- Affected independent worker: active lk1-unpaid-cancel.service. Its MainPID,
  process start identity, executable/argv/CWD, loaded fragment, absence of
  drop-ins, effective configuration and current release were verified before and
  after inspection. A pending daemon reload is rejected. No separate subscription
  visit service/PM2 process was found in the inspected inventory.
- Installed base workerd0e7f3d8525a7821a8e10f17bccaa14ef333ce67 has manifest
  63c0f6ed1b0d10a5670fdea69cd91de2d63f35d38c16ae39d76ec2557590eb03.
  All13 files match the repository sources, including the two native cancellation
  libraries. The new generation changes only the
  copied guard's whole-flow pin. Runner, payment/cancellation logic, gateway pin,
  unit, auth module, package/lockfile, mode, cohort and cursors are preserved,
  including the FREE scan phase and freeCancelAfterId.
- Node-RED settings retain the auth module under release
  267a042d3f86d61602c6ba64528e972c9becb708. That immutable directory must remain.

No worker was launched, stopped or restarted; no configuration, source, data,
payment, booking, cancellation, confirmation or reconciliation was changed on
production. Full production function bodies/configs were not exported. The
previous export rejection was resolved using safe on-host verification.

## Prepare and verify

Use a clean, reviewed task commit. Keep every artifact in a new private external
directory. The inspector is streamed to Node on147; it writes nothing there and
prints only allowlisted proof/manifest metadata. Use the already verified SSH
proxy route; do not alter network settings.

```sh
node_modules/.bin/esbuild scripts/inspect_booking_transport_runtime.mjs \
  --bundle --platform=node --format=esm --target=node22 \
  --outfile=/private/tmp/PRIVATE_WORKSPACE/inspector.mjs
# Stream the owned inspector over the verified SSH route to:
# node --input-type=module -
# Save stdout privately as live-proof.json; never print private tokens/source.
node scripts/prepare_booking_transport_release.mjs \
  /private/tmp/PRIVATE_WORKSPACE/live-proof.json EXPECTED_PROOF_SHA256 \
  /private/tmp/PRIVATE_WORKSPACE/new-release
node scripts/prepare_booking_transport_release.mjs --verify \
  /private/tmp/PRIVATE_WORKSPACE/new-release EXPECTED_RELEASE_INDEX_SHA256
```

The builder requires fresh (<=30min), externally digest-pinned proof, exact
installed worker file hashes and a clean source tree. It emits the two-node
delta, exact-graph contract, new and original rollback worker bundles, derivation
receipt, proof and a release index. All files are0600 in0700 directories outside
Git. The index's SHA is returned separately and must be retained independently;
verification never trusts a self-supplied hash inside the packet.

Verification checks every indexed artifact, both bundle manifests/files, the
exact known delta code, and the deterministic guard-only derivation. Extra files,
links, identity/configuration drift, stale evidence and mismatched flow/worker
pairs fail closed. The original preparation-only CLI still returns not-ready;
only the complete verified pair has readyForDeployment=true. This flag grants no
production authority and expires with the preflight evidence.

## Future cutover, separate explicit approval required

Approval must name the exact reviewed PR commit, release-index SHA, host, ordered
steps, stop signals and rollback pair. None of these live steps ran during prep.

1. Re-run read-only preflight and packet verification immediately before apply.
   Compare all flow, worker, unit, environment and retained-auth-module bindings.
   If any differ, stop and prepare a newly reviewed packet; never relax pins.
2. Audit safe counts of unpaid INTENT/REVIEW and native QUEUED/CANCEL_INTENT/
   RETURN_PENDING immediately before cutover. A preparation snapshot is not a
   later drain receipt. Stop if unresolved provider work prevents a safe drain;
   do not clear jobs or trigger a provider operation to unblock the rollout.
   Acquire the existing reviewed-flow lease and stop the unpaid worker. Wait for
   confirmed exit/drain; preserve its exact current release, unit, environment,
   cursor and operation journal. Process exit alone does not make an ambiguous
   in-flight INTENT safe to repeat.
3. Preserve an exact private source-flow backup on147. Materialize the candidate
   on that trusted host from this backup and the verified packet; check both SHAs:

   ```sh
   node scripts/prepare_booking_transport_release.mjs --materialize \
     PRIVATE_PACKET EXPECTED_RELEASE_INDEX_SHA256 PRIVATE_SOURCE_BACKUP NEW_PRIVATE_OUTPUT
   ```

   This command only creates local preparation files. Use the existing guarded
   exact-graph deploy helper with `--failure-recovery retain-candidate` for the
   separately approved import/restart, lease,
   foreign-change checks and post-readback. Do not bypass it with a manual import.
4. Verify loaded candidate flow, unchanged gateway and the same inert capability
   contract. Install the new worker in a new immutable release; verify the
   externally recorded worker-manifest SHA before and after the standard locked
   dependency install. Preserve unit/environment bytes and every referenced old
   auth-module release. Switch current atomically only after verification.
5. Start the compatible worker in its existing mode/cohort. Its unchanged startup
   guard checks flows.read and the empty unauthenticated401 route before business
   access. Observe fixed state/error categories without replaying customer
   operations. Any flow/gateway/service-binding drift stops before business work;
   exit78 disables automatic restart, while PM2 restart exits75.

Rollback restores the exact CURRENT baseline flow120065b3… and13-file worker
d0e7f3d8…/unit/environment pair. Both sides retain the same native cancellation
protocol; the only transport difference is the two-node addition. The old
11-file1983e7e2… or c1ca5635… generation is not a rollback target for this packet.
The packet includes the current baseline worker manifest; use the guarded original
flow backup, never reverse-serialize JSON and assume the old hash. Retain durable
cursors, locks, INTENT/REVIEW, QUEUED/CANCEL_INTENT/RETURN_PENDING and SENT/UNKNOWN
states. Review ambiguous in-flight
operations before resuming; do not delete state or resend provider operations.

Stop on failed GET/VM/identity/manifest/graph checks, source drift, missing backup,
missing auth-module reference, worker drain uncertainty or mismatched rollback
pair. The stop method is to leave the worker stopped and keep the verified prior
flow/worker pair; further live recovery follows the approved guarded procedure.

The unrelated historical purchase502 financial outcome remains UNKNOWN. This
packet improves future correlation and booking transport handling; it makes no
claim that a payment was cancelled, refunded or completed.
