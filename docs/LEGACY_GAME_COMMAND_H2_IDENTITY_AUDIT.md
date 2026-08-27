# Legacy game command H2 identity collision audit

Status: source-only R4 prerequisite. This helper cannot create, modify, lock, or delete
an account or group. It does not authorize upload, execution on lk-primary-147,
groupadd, useradd, release installation, migration, Node-RED changes, or cleanup.

## Outcome

The C source builds as a static Linux amd64 ELF. The helper runs as root from a
root-owned 0700 custody directory, verifies its opened 0500 single-link executable and
SHA-256, clears the environment, enables no_new_privs, and has no identity-mutation
implementation.

The operator supplies the exact candidate UID/GID, mountinfo SHA-256, custody pins and
every reviewed local object-bearing mount with its device, inode, mount ID, statfs flags,
filesystem magic, owner and mode. Production accepts system IDs only and requires `/`
coverage. The helper parses mountinfo itself and requires a one-to-one mapping for every
source-approved local filesystem mount. Duplicate, omitted, remote, idmapped, unknown,
or unclassified mounts fail closed. Exclusions are limited to the source-controlled
kernel-pseudo list and the exact systemd `autofs` placeholder at
`/proc/sys/fs/binfmt_misc`. That placeholder is accepted only with mount root `/`, source
`systemd-1`, and exactly one same-path `binfmt_misc` child whose parent mount ID is the
placeholder mount ID. Every other `autofs` shape remains unknown and fails closed. The
mount ID, parent ID, mount root, path, filesystem, source and disposition are digest-bound.

## Scan and evidence contract

Each pinned mount is traversed twice by sorted descriptor-relative `openat` operations,
without following symlinks or crossing mount IDs. Directory ctime is verified around
the complete child walk; object identity, ctime and ACL bytes are read and rechecked
through the held descriptor. The helper checks numeric owner/group and parses
system.posix_acl_access plus system.posix_acl_default directly from Linux xattrs. It
separately checks all four UID/GID fields plus supplementary groups in proc status and
numeric keys/IDs/owner/creator fields in SysV IPC tables.

Per-mount object, collision and exact inventory digests must converge. Exact process
PID/starttime/credential and SysV IPC inventories must also converge. Mountinfo must
match the approved digest before the coverage classification and remain unchanged
afterwards. File paths below the approved mount roots and raw ACL output are never
emitted.

The helper reserves a root-owned 0600 single-link evidence file with O_EXCL. A complete
scan writes and fsyncs canonical JSON, then creates and fsyncs an evidence.complete
marker containing its SHA-256 and status. Attempt UUID, lease digest, hostname, boot ID,
issued/expiry window, start/completion times and both-pass inventory digests are bound
into the receipt; the evidence filename must equal the attempt UUID plus `.json`.
Freshness is checked again immediately before the marker. GO requires all match counts
to be zero and always records `creationAuthorized:false`.
BLOCKED is a complete collision result; a signal, deadline, race, parser/read error,
mount drift, write failure, or missing marker is incomplete and cannot authorize H2.

## Reproducible build

From a clean committed checkout:

    node scripts/build_legacy_game_command_h2_identity_audit.mjs \
      --out /absolute/new/private/h2-identity-audit-commit \
      --environment production

The builder uses a digest-pinned, network-disabled amd64 image, a separate read-only
exact-source mount and writable output mount, then byte-compares the source again. It
compiles twice with static flags, rejects dynamic/interpreter ELF segments, and emits
only a 0500 binary plus canonical 0600 manifest. The manifest records
identityMutationImplemented:false and liveMutationAuthorized:false.

## H2 execution boundary

An audit receipt is short-lived evidence, not creation authority. A later exact H2
approval must freeze the host, IDs, names, reviewed mount set, helper/manifest/evidence
digests and an exclusive host-operation lease. Within that same lease, rerun NSS checks
and this scan immediately before the reviewed groupadd/useradd/usermod sequence, then
repeat scan and process checks. Any drift or match is STOP. Upload, execution, identity
creation, recovery and cleanup remain separate live gates.
