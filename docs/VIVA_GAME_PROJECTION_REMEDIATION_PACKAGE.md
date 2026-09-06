# Viva game projection remediation package

This package prepares the exact version-2 remediation inputs discovered during the
tenant-cutover preflight. Preparation is offline with respect to MongoDB and Viva: the
builder only reads already captured private artifacts and writes a new private package.

The builder requires one capture session collected under one writer fence. The full
backup and restore rehearsal may precede the Mongo write barrier because the barrier
is bound to the already built cutover plan. The provider and Mongo remediation captures
must follow barrier installation, and APPLY compares the complete live collection with
the frozen backup while that barrier is still held. Its inputs are the exact cutover
plan, the raw-byte bundle of every migration plan pinned by that cutover plan, remediation review
packet, manual review, identity audit, provider and Mongo captures, full backup and
restore rehearsal, fence and barrier receipts, migration connection file, and current
flow. Every input must be an owned `0600` regular file at a canonical absolute path.
The output directory must not exist, must be outside the repository, and must have an
owned `0700` parent.

## Production v2 evidence capture

The externally pinned `run_viva_game_projection_remediation_preflight.sh` launcher and
built-ins-only bootstrap form the production capture-only coordinator. They accept the
already prepared, digest-pinned cutover execution index
after Node-RED is stopped in `SHADOW` mode and the matching writer-fence receipt has
been issued. The wrapper acquires the canonical flock and starts the persistent fence
guardian. The coordinator validates the exact cutover packet, backup and isolated
restore receipt, installs the Mongo write barrier, compares the complete live
`games.lk_games` state with the full backup, and captures the skipped records from
MongoDB and Viva Admin under that same custody.

The provider bearer token and fence token are passed through owned `0400`, single-link
regular files on descriptors 10 and 7. The built-ins-only bootstrap validates and closes
both descriptors before starting the guardian or installing the Mongo barrier. It verifies
the JWT subject against the service-principal digest already pinned by every migration plan.
The token is not accepted as a command-line argument or environment value and is not
written to an artifact or standard output.

```bash
# Start this clean root shell first. EXACT_* digests come from the reviewed cutover plan.
/usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LANG=C LC_ALL=C \
  /bin/bash --noprofile --norc

repository_root=/absolute/root-owned/reviewed-repository
runtime_dir="$(/usr/bin/mktemp -d /run/padlhub-viva-remediation-preflight.XXXXXX)"
/bin/chmod 700 "$runtime_dir"
wrapper_sha256=EXACT_REVIEWED_PREFLIGHT_WRAPPER_SHA256
bootstrap_sha256=EXACT_REVIEWED_PREFLIGHT_BOOTSTRAP_SHA256

exec 7</private/fence-token-0400
exec 10</private/provider-token-0400
exec 8<"$repository_root/scripts/run_viva_game_projection_remediation_preflight.sh"
(set -o noclobber; /bin/cat <&8 >"$runtime_dir/launcher.sh")
/bin/chmod 500 "$runtime_dir/launcher.sh"
test "$(/usr/bin/stat -Lc '%u:%a:%h' -- "$runtime_dir/launcher.sh")" = "0:500:1"
test "$(/usr/bin/sha256sum --binary "$runtime_dir/launcher.sh" | /usr/bin/cut -d' ' -f1)" = "$wrapper_sha256"

exec /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LANG=C LC_ALL=C \
  PADLHUB_REMEDIATION_REPOSITORY_ROOT="$repository_root" \
  PADLHUB_REMEDIATION_RUNTIME_DIR="$runtime_dir" \
  PADLHUB_REMEDIATION_PREFLIGHT_WRAPPER_SHA256="$wrapper_sha256" \
  PADLHUB_REMEDIATION_PREFLIGHT_BOOTSTRAP_SHA256="$bootstrap_sha256" \
  PADLHUB_REMEDIATION_FENCE_TOKEN_FD=7 \
  PADLHUB_REMEDIATION_PROVIDER_TOKEN_FD=10 \
  PADLHUB_CUTOVER_GUARDIAN_RECEIPT="$runtime_dir/guardian.receipt.json" \
  PADLHUB_CUTOVER_GUARDIAN_RELEASE_REQUEST="$runtime_dir/guardian.release-request.json" \
  PADLHUB_CUTOVER_GUARDIAN_RECOVERY_REQUEST="$runtime_dir/guardian.recovery-request.json" \
  PADLHUB_CUTOVER_GUARDIAN_READY_REQUEST="$runtime_dir/guardian.ready-request.json" \
  PADLHUB_CUTOVER_GUARDIAN_HEARTBEAT="$runtime_dir/guardian.heartbeat.json" \
  /bin/bash --noprofile --norc "$runtime_dir/launcher.sh" \
  --execution-index /private/cutover-execution-index.json \
  --expected-execution-index-sha256 EXACT_SHA256 \
  --output-directory /private/new-remediation-v2-evidence \
  --report /private/new-remediation-preflight-report.json
```

Direct Node or repository-wrapper invocation is rejected. Before the guardian starts,
the bootstrap verifies its external wrapper/bootstrap hashes against the plan, reads the
complete recursive source closure from the exact clean committed Git tree, performs a fresh
private `npm ci --ignore-scripts --omit=dev` from the committed SRI-bound lockfile, freezes
the resulting executor, validates all output/recovery paths, and validates both credential
descriptors. It then opens the canonical lock with `O_NOFOLLOW`, starts the guardian from
the frozen snapshot, and writes a durable bootstrap custody receipt beside the report.
That intermediate receipt records the Node-RED runtime as unverified; only the coordinator's
exact PM2 readback may later assert `RUNTIME_STOPPED`.

The successful terminal state is
`EVIDENCE_READY_BARRIERS_HELD_RUNTIME_STOPPED`. It publishes version-2 review,
enrichment and identity-audit artifacts, version-1 fence-bound provider and Mongo
captures, and the exact migration-plan bundle. Viva is captured in two complete passes;
each pass must cover the exact union of every remediation date plus or minus seven days.
Their canonical rows must match exactly, and raw plus canonical per-date digests, counts,
and tree hashes are retained. The package builder and executor enforce the same two-pass
scope contract. Before publication it revalidates the
fence, guardian, Mongo barrier, and complete collection hash after all provider
requests. It performs zero game-document writes and zero provider writes.

This coordinator has no tenant-migration APPLY, candidate publication, Node-RED start,
or automatic recovery capability. Success and failure reports bind the existing
`recover_viva_game_projection_mongo_write_barrier.mjs` executable, its digest, the
barrier preparation artifact, cutover plan, execution index, fence receipt, guardian
receipt, and migration connection. The barrier and guardian remain held until an
operator separately authorizes and runs either package verification/remediation or
the pinned recovery command. A failed capture must be treated as an outage with
explicit recovery required; do not release the flock or restart Node-RED first.

Use the published files as the five remediation inputs plus migration-plan bundle in
the package-builder command below. The full backup, manifest, restore receipt,
restored artifact, cutover plan and current flow remain in the exact cutover packet;
the fence receipt, barrier receipt and migration connection remain at the paths bound
by the cutover execution index and preflight report.

```bash
/usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin \
  /usr/bin/node scripts/prepare_viva_game_projection_remediation_package.mjs \
  --cutover-plan /private/cutover-plan.json \
  --migration-plan-bundle /private/migration-plan-bundle.json \
  --packet /private/remediation-review.packet.json \
  --enrichment /private/remediation-manual-review.json \
  --identity-audit /private/identity-reference-audit.json \
  --provider-capture /private/provider.capture.json \
  --mongo-capture /private/mongo.capture.json \
  --full-backup /private/full-backup.ejson \
  --full-backup-manifest /private/full-backup.manifest.json \
  --restore-rehearsal-receipt /private/restore-rehearsal.receipt.json \
  --restored-artifact /private/full-backup.restored.ejson \
  --fence-receipt /private/writer-fence.receipt.json \
  --mongo-write-barrier-receipt /private/mongo-write-barrier.receipt.json \
  --migration-connection-file /private/migration-mongo.connection.json \
  --flow-path /root/.node-red/flows.json \
  --generated-at 2026-09-06T10:03:00.000Z \
  --mutation-at 2026-09-06T10:04:00.000Z \
  --operation-id viva-remediation-EXACT-OPERATION-ID \
  --output-directory /private/new-remediation-package
```

The migration-plan bundle has this exact shape. Every `bytesBase64` value is the raw
byte stream of a migration-plan file and its digest must occur exactly once in
`cutoverPlan.migration.planSha256s`:

```json
{"formatVersion":1,"kind":"viva-game-projection-migration-plan-bundle","plans":[{"sha256":"...","bytesBase64":"..."}]}
```

The builder derives the active legacy count and Mongo operations from the bound full backup, packet,
review results, provider evidence, Mongo capture, and identity audit. The resulting
operation set must exactly equal the cutover plan's skipped identities. The IDs from
the pinned migration-plan bytes and the remediation IDs must be disjoint and their
union must equal every active legacy ID in the full-backup scope. It does not accept
an operation list or unknown CLI option.
Before publication it runs the same full executable-plan
validator used by the live remediation runner. It publishes `0600` inputs, a plan,
an execution index, a package manifest, and a `PREPARED_NOT_AUTHORIZED` marker in a
`0700` directory. Standard output contains only counts and hashes.

The builder creates a new private install root and runs `/usr/bin/npm ci
--ignore-scripts --omit=dev` from the exact committed `package.json` and
`package-lock.json`. npm verifies package tarballs against the lockfile SRI before the
builder captures the complete mandatory MongoDB runtime closure as exact file bytes.
Its public entrypoint imports only Node.js built-ins. The documented production command
clears the environment before starting the Node.js interpreter. It copies the exact committed
builder source into the private install root and imports MongoDB-dependent code only
after the fresh install is complete and the copied directory tree is read-only. The
package script applies the same child-process environment. `NODE_OPTIONS`, Git
configuration, and repository-local module lookup therefore cannot affect this trust step.
The install uses separate empty private user and global npm configuration files so npm
cannot inherit host registry hooks and npm 11 does not reject a duplicated config path.
The plan embeds those bytes, the committed manifests, package versions, and integrity
fields. Production does not read the repository's mutable or ignored `node_modules`
tree.

The production entrypoint accepts only the exact digest-pinned execution index. Take
the wrapper and bootstrap digests from the reviewed plan's `executorSources`. The
controlling root shell opens the wrapper once, copies those same opened bytes into a
new private runtime directory, verifies the copy, and invokes it with absolute system
binaries. The wrapper opens the bootstrap once and likewise executes only its verified
private copy. The bootstrap verifies the clean pinned commit, reads every local source
from its committed Git blob, validates the embedded dependency bytes against the
committed lockfile, and materializes one read-only executor with its own `node_modules`.
Individual pinned inputs cannot be overridden:

```bash
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
unset BASH_ENV ENV CDPATH NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH
unset GIT_DIR GIT_WORK_TREE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES
umask 077
repository_root=/absolute/root-owned/reviewed-repository
runtime_dir="$(/usr/bin/mktemp -d /run/padlhub-viva-remediation.XXXXXX)"
/bin/chmod 700 "$runtime_dir"
token_file="$runtime_dir/fence.token"
(set -o noclobber; printf '%s' "$PADLHUB_CUTOVER_FENCE_TOKEN" >"$token_file")
/bin/chmod 400 "$token_file"
exec 7<"$token_file"
unset PADLHUB_CUTOVER_FENCE_TOKEN
export PADLHUB_REMEDIATION_WRAPPER_SHA256=EXACT_REVIEWED_WRAPPER_SHA256
export PADLHUB_REMEDIATION_BOOTSTRAP_SHA256=EXACT_REVIEWED_BOOTSTRAP_SHA256
export PADLHUB_REMEDIATION_REPOSITORY_ROOT="$repository_root"
export PADLHUB_REMEDIATION_RUNTIME_DIR="$runtime_dir"
exec 8<"$repository_root/scripts/run_viva_game_projection_fenced_remediation.sh"
(set -o noclobber; /bin/cat <&8 >"$runtime_dir/wrapper.sh")
/bin/chmod 500 "$runtime_dir/wrapper.sh"
test "$(/usr/bin/stat -Lc '%u:%a:%h' -- "$runtime_dir/wrapper.sh")" = "0:500:1"
test "$(/usr/bin/sha256sum --binary "$runtime_dir/wrapper.sh" | /usr/bin/cut -d' ' -f1)" = "$PADLHUB_REMEDIATION_WRAPPER_SHA256"
exec /usr/bin/env -i \
  PATH=/usr/sbin:/usr/bin:/sbin:/bin \
  PADLHUB_REMEDIATION_WRAPPER_SHA256="$PADLHUB_REMEDIATION_WRAPPER_SHA256" \
  PADLHUB_REMEDIATION_BOOTSTRAP_SHA256="$PADLHUB_REMEDIATION_BOOTSTRAP_SHA256" \
  PADLHUB_REMEDIATION_REPOSITORY_ROOT="$repository_root" \
  PADLHUB_REMEDIATION_RUNTIME_DIR="$runtime_dir" \
  PADLHUB_REMEDIATION_FENCE_TOKEN_FD=7 \
  /bin/bash --noprofile --norc "$runtime_dir/wrapper.sh" \
  --execution-index /private/new-remediation-package/remediation-execution-index.json \
  --expected-execution-index-sha256 EXACT_SHA256 \
  --mode verify \
  --report /private/new-reports/remediation-verify.json
```

Direct production invocation of the remediation runner is rejected. `verify`,
`reconcile`, and `reconcile-restore` remain read-only. Recovery modes first journal
intent, then may
operate after the original evidence TTL only while the exact inherited flock, stopped
Node-RED runtime, Mongo barrier, immutable plan, backup, and apply receipt are verified
again. Only after backup and, where required, apply receipt validation do they journal
the recovery controls as verified. `apply` and
`restore` retain their separate environment confirmation phrases and live-operation
approval gates. The package marker and execution index always state
`executionAuthorized=false`, `liveMutationAuthorized=false`, and
`productionWritesPerformed=0`.

The cutover plan embedded in this remediation package is a safety binding for the
held fence, candidate, backup, and Mongo target. It is not the final tenant-cutover
execution index. After a successful remediation, rebuild the Mongo/provider
projections, tenant-migration plans, cutover packet, fence receipt, and cutover
execution index from the post-remediation state before any tenant migration. The
remediation manifest records `finalCutoverPlanReusable=false` to make this boundary
explicit. Tenant migration APPLY is accepted only from the in-process cutover
coordinator after it has compared the live full collection with the backup and proved
that all pinned migration plans exactly cover the global active legacy set. Direct
standalone tenant-migration APPLY is rejected.
