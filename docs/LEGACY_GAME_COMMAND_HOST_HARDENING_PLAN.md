# Legacy game command host-hardening plan

Status: source-only R4 plan. This document does not authorize `chmod`, `groupadd`,
`useradd`, `usermod`, `userdel`, `groupdel`, package upload, release installation,
Node-RED import/restart, MongoDB access, migration, mapping import, gateway activation,
or provider calls.

## Observed production preimage

The read-only preflight on `lk-primary-147` observed:

- filesystem root `/`: owner `0:0`, mode `0707`;
- `/root`: owner `0:0`, mode `0700`;
- `/opt/padlhub/legacy-game-command`: absent;
- dedicated account `padlhub-legacy-command`: absent;
- live `/root/.node-red/flows.json` SHA-256
  `14b5aff65e0b49fd4f37d6d1d9465af8af3ccdf2e6cfa77bc76b4a9f2a831350`.

Mode `0707` lets every local identity write to `/` and therefore violates the immutable
release ancestor-custody check. The release installer also requires a positive non-root
executor UID different from the root custodian, but no dedicated executor exists.

These observations are not an execution preimage. Immediately before either future
mutation, repeat the read-only freeze below and stop on any drift.

## Gate H1: protect the filesystem root

This is a standalone live permission mutation and requires explicit approval naming
`lk-primary-147`, `/`, preimage `0:0:0707`, and target `0:0:0755`.

Before the approval is consumed, require a working ACL-capable readback tool. On this
host the reviewed command is `getfacl -cp /`; if `getfacl` is absent, errors, truncates
its result, or cannot represent the mounted filesystem ACL, H1 is blocked. Capture a
private root-owned evidence file with `stat -Lc '%u:%g:%a:%F' /`, mount
identity/options, and the complete `getfacl -cp /` result. Stop if `/` is not a real
directory owned by `0:0`, its mode is not exactly `0707`, it is unexpectedly remounted,
or the non-comment, non-blank ACL output is not exactly one access entry each for
`user::`, `group::`, and `other::`. Any `default:`, named user/group, `mask::`, duplicate,
or unknown ACL entry blocks H1. Also prove that no process, service, or deployment
contract intentionally writes entries directly under `/`; normal writes below
established top-level directories are unaffected.

Only after that exact gate, the proposed mutation is:

```bash
chmod 0755 -- /
```

Immediate read-back must prove owner `0:0`, mode `0755`, the same mount identity, and
exactly the same three-entry access ACL schema with no `default:` or other entry through
the same mandatory ACL-capable tool.
Open a new SSH session, prove Node and the Node-RED supervisor can still read their
existing paths, and run the already reviewed public LK Games read-only smoke. Do not
combine this permission change with release upload, install, restart, or flow import.

If an immediate postcheck fails and the failure is causally attributable to this single
mode change, stop. Restoring the insecure preimage is a separate break-glass live gate;
before any later host or release mutation, its exact recovery command is:

```bash
chmod 0707 -- /
```

After recovery, repeat owner/mode, mount, mandatory ACL, new-SSH, supervisor, and public
API read-back. If an extended ACL was present or ACL read-back was unavailable, H1 is
blocked and this simple recovery is insufficient; prepare a separately reviewed
ACL-aware plan instead.

## Gate H2: create the dedicated executor identity

H2 starts only after H1 and its postchecks are recorded. It is a separate live identity
mutation and requires explicit approval naming the exact account
`padlhub-legacy-command`.

Fresh preflight must prove both passwd and group names are absent, `/usr/sbin/nologin`
exists, and the host uses the expected local account database. Select one unused system
UID and one unused system GID from the host's effective system ranges, record the exact
numbers, and include them in the H2 approval. They are runtime evidence, not guessed or
pinned in source. Immediately before creation, prove through NSS that both numbers and
both names remain unused.

Enumerate every persistent local filesystem mounted on the host. As root, scan each
mount without crossing filesystem boundaries for any object owned by the frozen numeric
UID or GID, and scan its ACLs for either numeric identity. The evidence must name the
complete mount set and report zero ownership and ACL matches. An unavailable/incomplete
scan, a remote or ambiguous persistent mount, any match, or any identity/name drift
blocks H2 and requires a newly frozen identity and approval. Do not adopt, rename, or
modify an existing or orphaned identity.

Only after that exact scan, the proposed creation sequence is:

```bash
groupadd --system --gid <frozen-unused-gid> padlhub-legacy-command
useradd --system --uid <frozen-unused-uid> \
  --gid <frozen-unused-gid> --no-user-group --no-create-home \
  --home-dir /nonexistent --shell /usr/sbin/nologin \
  padlhub-legacy-command
usermod --lock padlhub-legacy-command
```

Read back passwd, shadow status, group, and process state without printing a password
hash. Repeat the ownership and ACL scan before the UID is passed to any other command.
The account must have:

- the exact approved positive non-root UID and GID, different from the root custodian;
- an explicitly locked password/account state;
- exactly its named private primary group and no supplementary groups or group members;
- shell `/usr/sbin/nologin`;
- home field `/nonexistent`, with no directory created;
- no sudoers entry, password, SSH key, token, credential, or running process.

The exact UID becomes a frozen input to the separately reviewed release install command.
Creating and locking the account does not authorize using it, installing the release,
exposing credentials, or connecting to MongoDB.

The H2 approval, precheck, postcheck, failure, and rollback evidence may and must refer
to the exact UID/GID; those records are retained after rollback. Until any downstream
operational binding has occurred, an H2-only failure may be recovered under a separate
destructive approval with:

```bash
userdel padlhub-legacy-command
groupdel padlhub-legacy-command
```

If `groupadd` succeeded but `useradd` did not, recovery applies only the separately
approved `groupdel`. After recovery, passwd and group names plus both frozen numeric IDs
must all be absent through NSS; the ownership/ACL scan must still return zero matches.
Any remaining process, object, ACL, passwd entry, or group entry is an incomplete
rollback and blocks retry. Removal is forbidden after any downstream install or
attestation, file/ACL ownership, process execution, credential or service binding,
migration execution packet, or other use outside H2-local evidence. At that point
recovery requires a new identity/custody plan that preserves numeric ownership and
forensic references.

## Release handoff after H1 and H2

Only when both gates have independent preimage and postcheck records may a later deploy
stage substitute the frozen numeric UID for `<dedicated-non-root-uid>` in
`LEGACY_GAME_COMMAND_PRODUCTION_RELEASE_INSTALL.md`. That later stage must still refresh
the live flow SHA, repository/main identity, release manifest and installer digests,
custody paths, free space, and the global reviewed-flow lease before any upload or write.

H1 and H2 do not authorize one another and do not authorize the release install. A
failed or drifted gate stops at that boundary; it is never bypassed manually.
