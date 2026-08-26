# Legacy game command production immutable release

Status: source-only R4 installation prerequisite. Nothing in this document authorizes
package upload, production installation, Node-RED import/restart, key binding, MongoDB
access, migration, writer stop/resume, mapping import, or provider calls.

## Outcome

`scripts/build_legacy_game_command_production_release.mjs` creates a self-contained
release from a clean committed checkout. It packages the production runner, migration
core, writer registry, approval verifier, `UNBOUND` trust-anchor manifest, custom
Node-RED transaction module, root package/lock, and the complete installed MongoDB
runtime dependency closure. `release-manifest.json` is canonical JSON and binds every
regular file by relative path, size, and SHA-256 plus the exact repository/live/candidate
and runtime source identities.

`scripts/install_legacy_game_command_production_release.mjs` verifies that inventory
before doing anything. Its default-safe mode is `plan`, which performs no writes. A
future production install can create only:

```text
/opt/padlhub/legacy-game-command/releases/<exact-commit>/
```

It creates no `current` symlink, never overwrites an existing commit directory, and
does not touch `/root/.node-red`, `flows.json`, PM2/systemd, MongoDB, credentials, or
network/provider state. Installed files are custodian-owned `0444`; directories are
`0555`; enclosing release directories are custodian-owned and not group/other writable.
The unprivileged migration executor UID must be different from the custodian UID.

## Build and read-only plan

Run only after the approved source is committed in a clean worktree:

```bash
npm run release:legacy-game-command:build -- \
  --out /absolute/new/private/padlhub-legacy-command-<commit>

npm run release:legacy-game-command:install -- \
  --mode plan \
  --bundle /absolute/private/padlhub-legacy-command-<commit> \
  --install-root /opt/padlhub/legacy-game-command \
  --executor-uid '<dedicated-non-root-uid>' \
  --expected-commit '<independently-frozen-40-hex-commit>' \
  --expected-manifest-sha256 '<independently-frozen-release-manifest-sha256>'
```

The bundle directory must be new, must remain private before custody transfer, and must
not be built from a dirty checkout. Any missing/extra file, symlink, hardlink, digest
drift, non-canonical manifest, unsafe path, reused release directory, or equal
custodian/executor UID is a hard failure.

## Future production install gate

The exact install command is intentionally unusable without all of the following:

- process UID `0` acting as the independent custodian;
- exact install root `/opt/padlhub/legacy-game-command`;
- a dedicated positive non-root executor UID;
- an independently frozen exact commit matching the bundle manifest;
- an independently frozen SHA-256 of the canonical `release-manifest.json`;
- a new UUID deployment identity;
- a canonical non-future activation timestamp;
- the one-shot environment confirmation
  `LK_LEGACY_COMMAND_RELEASE_INSTALL=INSTALL_LEGACY_GAME_COMMAND_PRODUCTION_RELEASE_V1`;
- a separately approved live execution step with fresh remote/main and flow preimages.

At install time the attestation replaces only the build-host Node executable digest
with the actual target `process.execPath` digest. All portable source and MongoDB runtime
closure hashes remain fixed by the verified bundle. The installer writes canonical
`release-attestation.json` inside the sealed exact-commit directory only after the
bundle copy is complete, then atomically renames the private staging directory.

Even after installation, migration `apply` remains impossible while the checked-in
trust anchor is `UNBOUND`. Flow candidate deployment, trust-anchor binding, database
audit/backup/quiescence/apply, mapping import, and gateway activation remain separate
R4 transitions with their own approval and postchecks.

## Rehearsal and rollback

Focused tests install into a new disposable temporary root with `environment=rehearsal`,
verify exact runtime identities from the sealed copy, reject tampering and repeat
install, and remove only that disposable directory afterwards.

Production installation is additive and inert. Before any flow or database activation,
rollback is to stop referencing the exact release path; no active pointer is created by
this installer. Never delete the release directory while an audit, signed packet, or
execution receipt references it. Revocation and deletion require a later explicit
forensic/custody decision.
