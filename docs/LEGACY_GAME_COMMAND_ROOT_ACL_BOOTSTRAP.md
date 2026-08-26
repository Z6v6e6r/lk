# Legacy game command root ACL bootstrap

Status: source-only R4 prerequisite. This document and its artifact do not authorize
upload, execution on `lk-primary-147`, mode or ACL mutation, package installation,
identity creation, release installation, Node-RED import/restart, database access, or
provider calls.

## Purpose and rejected package path

The live read-only preflight found `/` at `0:0:0707`, while `getfacl`, `getfattr`, and
`attr` are absent. Installing the `acl` package cannot safely bootstrap this condition:
`apt`/`dpkg` executes a broad mutable package workflow while every local identity can
write directly under `/`, and the exact package origin, bytes, hooks, concurrency, and
recovery state have not been frozen. Neither `ls` nor mode bits prove that a POSIX ACL
or another extended attribute is absent.

The prerequisite therefore uses a reviewed static Linux amd64 helper. It has no target
package or interpreter dependency. It opens the target exactly once with
`O_DIRECTORY|O_NOFOLLOW`, verifies the same file descriptor before mutation, uses
`flistxattr` twice and rejects every non-empty or drifting xattr set, calls `fchmod` on
that descriptor, `fsync`s it, and checks the same device/inode afterwards. Production
accepts only exact target `/` on ext4 and exact transitions `0707 -> 0755` or
`0755 -> 0707`.

The helper also requires root real/effective UID and GID, a root-owned mode `0500`
single-link executable with the independently frozen SHA-256, and a root-owned mode
`0700` xattr-free working directory. Apply, rollback, and rehearsal have distinct
one-shot environment sentinels. Output is deterministic fixed-shape JSON. Exit `69`
explicitly means a mutation may already have occurred and postcheck evidence is
required before any next action.

## Reproducible source build

From a clean committed checkout, with the already reviewed Docker image available:

```bash
node scripts/build_legacy_game_command_root_acl_bootstrap.mjs \
  --out /absolute/new/private/root-acl-bootstrap-<commit> \
  --environment production
```

The builder uses the digest-pinned image
`node@sha256:0557ac14e0d45d02ed563067b82856ca5e7aa3437fa28d98d4350ea9c3d9494a`,
`--network none`, and `--platform linux/amd64`. It compiles twice, requires identical
bytes, rejects ELF interpreter/dynamic segments, and emits only a `0500` binary plus a
canonical `0600` manifest. Production input is materialized from the exact Git blob,
not read from the mutable worktree; HEAD and clean status are checked again after both
compiles. A private sibling staging directory is removed on failure and atomically
renamed to the requested new output only after verification. The manifest always records
`liveMutationAuthorized:false`; its source, binary, image, commit, compiler, flags, and
environment fields are evidence, not authority.

## Future H0 delivery and read-only audit gate

H0 requires a new explicit live approval naming the host, exact source commit, manifest
SHA-256, binary SHA-256, delivery and custody paths, and audit-only mode. Transfer the
two reviewed files to a new delivery path, then as root copy the binary into a new
root-owned `0700` directory and make it `0500`, with no symlink, hardlink, or xattr.
Freeze the custody directory and `/` device/inode, `mountId`, and `mountFlags` values
and binary digest independently.

Execute from the private custody directory through a descriptor opened by Bash builtins;
do not execute the delivery copy or trust an in-process self-hash as the initial anchor.
Keep this exact interactive root shell and descriptor open:

```bash
cd '<new-root-owned-mode-0700-custody-directory>'
EXPECTED_SELF_SHA256='<independently-frozen-binary-sha256>'
exec {BOOTSTRAP_FD}<legacy-game-command-root-acl-bootstrap
if [ ! -f "/proc/self/fd/$BOOTSTRAP_FD" ] \
  || [ ! -O "/proc/self/fd/$BOOTSTRAP_FD" ] \
  || [ ! -x "/proc/self/fd/$BOOTSTRAP_FD" ]; then
  echo 'bootstrap descriptor custody failed' >&2
  exit 1
fi
printf 'bootstrap_pid=%s bootstrap_fd=%s\n' "$BASHPID" "$BOOTSTRAP_FD"
IFS= read -r FD_VERIFICATION
if [ "$FD_VERIFICATION" != "VERIFIED_FD_SHA256_$EXPECTED_SELF_SHA256" ]; then
  echo 'independent descriptor digest was not confirmed; refusing exec' >&2
  exit 1
fi
/proc/self/fd/$BOOTSTRAP_FD \
  --mode audit --environment production --target / \
  --expected-self-sha256 "$EXPECTED_SELF_SHA256"
```

Before entering `FD_VERIFICATION`, a separate trusted local session must download exact
`/proc/<printed-bootstrap_pid>/fd/<printed-bootstrap_fd>` from `lk-primary-147`, hash the
download locally, and compare it with the independently approved artifact SHA-256. Only
an exact match permits entering `VERIFIED_FD_SHA256_<approved-digest>` in the original
waiting shell. A mismatch, unavailable `/proc` read-back, closed/reopened shell or FD,
or path-based hash blocks execution. The helper's self-hash is a second check of that
same opened inode, not the trust anchor.

The H0 audit is GO only when JSON proves root identity, self/cwd custody, target
`0:0:0707`, ext4, `xattrBytes:0`, `mutationPerformed:false`, and
`postcheckComplete:true`. Freeze the reported cwd and target device/inode, mount ID, and
mount flags values for a separate H1 approval. Any other result blocks H1. Do not fall back to `chmod`, `ls`,
Python, Perl, package installation, or path-based mutation.

## Future H1 apply gate

H1 is a separate live approval naming exact H0 evidence, target preimage and identity,
binary digest, custody directory identity, expected transition, public read-only smoke,
and rollback boundary. With the same reviewed descriptor-custody block and frozen
values, its only permitted mutation invocation is:

```bash
LK_ROOT_ACL_BOOTSTRAP_APPLY=APPLY_ROOT_MODE_0755_V1 \
  /proc/self/fd/$BOOTSTRAP_FD \
  --mode apply --environment production --target / \
  --expected-self-sha256 "$EXPECTED_SELF_SHA256" \
  --expected-cwd-device '<frozen-custody-device>' \
  --expected-cwd-inode '<frozen-custody-inode>' \
  --expected-cwd-mount-id '<frozen-custody-mount-id>' \
  --expected-cwd-mount-flags '<frozen-custody-mount-flags>' \
  --expected-target-device '<frozen-root-device>' \
  --expected-target-inode '<frozen-root-inode>' \
  --expected-target-mount-id '<frozen-root-mount-id>' \
  --expected-target-mount-flags '<frozen-root-mount-flags>' \
  --expected-mode 0707 --target-mode 0755 \
  --evidence-name 'root-acl-apply-<approved-UUID>.json'
```

The helper reserves the named root-owned, regular, single-link, xattr-free `0600`
evidence file with `O_EXCL` before `fchmod`. Success requires identical complete JSON in
that file and stdout, the same device/inode/mount ID/mount flags and filesystem, before
mode `0707`, after mode `0755`, empty xattrs, `mutationPerformed:true`, and
`postcheckComplete:true`. The helper flushes and `fsync`s the evidence file and custody
directory before stdout success. Then open a new SSH session, verify Node/PM2/Node-RED
read-only health, and run the approved public LK Games read-only smoke. H1 must not
include H2, release install, restart, flow import, or database/provider work.

## Failure and separately approved rollback

Before `fchmod`, any nonzero exit is fail-closed and no manual continuation is allowed.
Exit `68` reports that `fchmod` failed. After a mutating invocation starts, any signal,
disconnect, timeout, abnormal/nonzero exit other than the explicit pre-mutation failure,
missing/truncated/non-exact success JSON, empty/incomplete durable evidence, or
stdout/evidence mismatch is `UNKNOWN_AFTER_POSSIBLE_MUTATION`. Exit `69` explicitly
contains `AFTER_MUTATION`. In every UNKNOWN case, preserve the evidence file and obtain
an independently verified descriptor audit plus direct mode/mount read-back before any
retry, rollback, H2, install, or other action.

Rollback to the insecure preimage is break-glass and needs its own approval. It uses the
same exact custody and target identity pins but a different transition and sentinel:

```bash
LK_ROOT_ACL_BOOTSTRAP_ROLLBACK=ROLLBACK_ROOT_MODE_0707_V1 \
  /proc/self/fd/$BOOTSTRAP_FD \
  --mode rollback --environment production --target / \
  --expected-self-sha256 "$EXPECTED_SELF_SHA256" \
  --expected-cwd-device '<frozen-custody-device>' \
  --expected-cwd-inode '<frozen-custody-inode>' \
  --expected-cwd-mount-id '<frozen-custody-mount-id>' \
  --expected-cwd-mount-flags '<frozen-custody-mount-flags>' \
  --expected-target-device '<frozen-root-device>' \
  --expected-target-inode '<frozen-root-inode>' \
  --expected-target-mount-id '<frozen-root-mount-id>' \
  --expected-target-mount-flags '<frozen-root-mount-flags>' \
  --expected-mode 0755 --target-mode 0707 \
  --evidence-name 'root-acl-rollback-<approved-UUID>.json'
```

Repeat helper read-back, new SSH, supervisor, and public API checks after rollback.
Unknown/non-empty xattrs, identity drift, or an unverified post-mutation state requires a
new ACL-aware recovery plan; it must never be bypassed with raw `chmod`.

## Disposable rehearsal coverage

The focused test builds the static helper without network and verifies audit,
`0707 -> 0755 -> 0707`, unchanged opened inode, missing-sentinel rejection, identity
drift, duplicate options, xattrs, symlinks, production aliases, mount-pin mismatch,
executable path substitution, broken stdout, kill-after-mutation, and a path-replacement
race. Rehearsal mutation is restricted to `/rehearsal/` and requires
`LK_ROOT_ACL_BOOTSTRAP_REHEARSAL=MUTATE_REHEARSAL_TARGET_V1`.
