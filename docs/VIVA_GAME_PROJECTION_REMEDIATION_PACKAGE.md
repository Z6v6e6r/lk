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
