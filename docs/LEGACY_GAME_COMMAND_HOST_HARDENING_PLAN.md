# Legacy game command host-hardening plan

Status: source-only R4 plan. This document does not authorize `chmod`, `useradd`,
`userdel`, package upload, release installation, Node-RED import/restart, MongoDB access,
migration, mapping import, gateway activation, or provider calls.

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

Before the approval is consumed, capture a private root-owned evidence file with at
least `stat -Lc '%u:%g:%a:%F' /`, mount identity/options, and `getfacl -cp /` when
`getfacl` is installed. Stop if `/` is not a real directory owned by `0:0`, its mode is
not exactly `0707`, it is unexpectedly remounted, or it has an extended ACL. Also prove
that no process, service, or deployment contract intentionally writes entries directly
under `/`; normal writes below established top-level directories are unaffected.

Only after that exact gate, the proposed mutation is:

```bash
chmod 0755 -- /
```

Immediate read-back must prove owner `0:0`, mode `0755`, the same mount identity, and no
new ACL. Open a new SSH session, prove Node and the Node-RED supervisor can still read
their existing paths, and run the already reviewed public LK Games read-only smoke. Do
not combine this permission change with release upload, install, restart, or flow import.

If an immediate postcheck fails and the failure is causally attributable to this single
mode change, stop. Restoring the insecure preimage is a separate break-glass live gate;
before any later host or release mutation, its exact recovery command is:

```bash
chmod 0707 -- /
```

After recovery, repeat owner/mode, mount, new-SSH, supervisor, and public API read-back.
If an extended ACL was present, H1 is blocked and this simple recovery is insufficient;
prepare a separately reviewed ACL-aware plan instead.

## Gate H2: create the dedicated executor identity

H2 starts only after H1 and its postchecks are recorded. It is a separate live identity
mutation and requires explicit approval naming the exact account
`padlhub-legacy-command`.

Fresh preflight must prove both passwd and group names are absent, `/usr/sbin/nologin`
exists, and the host uses the expected local account database. Stop if the name or group
already exists; do not adopt, rename, or modify an existing identity.

The proposed creation command is:

```bash
useradd --system --user-group --no-create-home \
  --home-dir /nonexistent --shell /usr/sbin/nologin \
  padlhub-legacy-command
```

Read back and record the allocated numeric UID/GID. The account must have:

- a positive non-root UID different from the root custodian;
- only its private primary group and no supplementary groups;
- shell `/usr/sbin/nologin`;
- home field `/nonexistent`, with no directory created;
- no sudoers entry, password, SSH key, token, credential, or running process.

The numeric UID is not guessed or pinned in source. After creation it becomes a frozen
input to the separately reviewed release install command. Creating the account does not
authorize using it, installing the release, exposing credentials, or connecting to
MongoDB.

Before any artifact, process, execution packet, or forensic record refers to the UID,
an H2-only failure may be recovered under a separate destructive approval with:

```bash
userdel padlhub-legacy-command
```

Removal is forbidden once the UID is referenced by installed files, attestations,
processes, or evidence. At that point recovery requires a new identity/custody plan that
preserves UID ownership and forensic references.

## Release handoff after H1 and H2

Only when both gates have independent preimage and postcheck records may a later deploy
stage substitute the frozen numeric UID for `<dedicated-non-root-uid>` in
`LEGACY_GAME_COMMAND_PRODUCTION_RELEASE_INSTALL.md`. That later stage must still refresh
the live flow SHA, repository/main identity, release manifest and installer digests,
custody paths, free space, and the global reviewed-flow lease before any upload or write.

H1 and H2 do not authorize one another and do not authorize the release install. A
failed or drifted gate stops at that boundary; it is never bypassed manually.
