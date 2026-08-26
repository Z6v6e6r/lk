# Legacy game command production immutable release

Status: source-only R4 installation prerequisite. Nothing in this document authorizes
package upload, production installation, Node-RED import/restart, key binding, MongoDB
access, migration, writer stop/resume, mapping import, or provider calls.

## Outcome

`scripts/build_legacy_game_command_production_release.mjs` creates a self-contained
release from a clean committed checkout. It packages the trusted bootstrap installer,
production runner, migration
core, writer registry, approval verifier, `UNBOUND` trust-anchor manifest, custom
Node-RED transaction module, root package/lock, and the complete installed MongoDB
runtime dependency closure. `release-manifest.json` is canonical JSON and binds every
regular file by relative path, size, and SHA-256 plus the exact repository/live/candidate
and runtime source identities. The MongoDB closure must additionally match the immutable
SHA-256 frozen from a separate clean `npm ci --ignore-scripts --omit=dev` install; a
same-version dependency tree with changed bytes is rejected before packaging.

The packaged `scripts/install_legacy_game_command_production_release.mjs` has only
Node built-in static imports. It must execute from inside that exact bundle and verifies
the canonical manifest and complete inventory before dynamically importing any bundled
code. Its own digest is bound both by `manifest.source.installerSha256` and by a separately
frozen operator value checked before Node starts. Its default-safe mode is `plan`, which
performs no writes. A
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

RELEASE_BUNDLE='/absolute/private/padlhub-legacy-command-<commit>'
EXPECTED_INSTALLER_SHA256='<independently-frozen-installer-sha256>'
ACTUAL_INSTALLER_SHA256="$(shasum -a 256 "$RELEASE_BUNDLE/scripts/install_legacy_game_command_production_release.mjs" | awk '{print $1}')"
if [ "$ACTUAL_INSTALLER_SHA256" != "$EXPECTED_INSTALLER_SHA256" ]; then
  echo 'installer SHA-256 mismatch; refusing to execute' >&2
  exit 1
fi

node "$RELEASE_BUNDLE/scripts/install_legacy_game_command_production_release.mjs" \
  --mode plan \
  --bundle "$RELEASE_BUNDLE" \
  --install-root /opt/padlhub/legacy-game-command \
  --executor-uid '<dedicated-non-root-uid>' \
  --expected-commit '<independently-frozen-40-hex-commit>' \
  --expected-manifest-sha256 '<independently-frozen-release-manifest-sha256>' \
  --expected-installer-sha256 "$EXPECTED_INSTALLER_SHA256"
```

The bundle directory must be new, must remain private before custody transfer, and must
not be built from a dirty checkout. Any missing/extra file, symlink, hardlink, digest
drift, non-canonical manifest, unsafe path, reused release directory, or equal
custodian/executor UID is a hard failure.

Do not invoke the installer through the repository `npm` script for custody transfer.
The commit, manifest digest, and installer digest must come from the independently
reviewed release record, not be discovered from the candidate bundle at install time.

## Future production install gate

The exact install command is intentionally unusable without all of the following:

- process UID `0` acting as the independent custodian;
- exact install root `/opt/padlhub/legacy-game-command`;
- a dedicated positive non-root executor UID;
- an independently frozen exact commit matching the bundle manifest;
- an independently frozen SHA-256 of the canonical `release-manifest.json`;
- an independently frozen SHA-256 of the installer, checked by the operator before
  executing that same file from inside the bundle;
- a new UUID deployment identity;
- a canonical non-future activation timestamp;
- the one-shot environment confirmation
  `LK_LEGACY_COMMAND_RELEASE_INSTALL=INSTALL_LEGACY_GAME_COMMAND_PRODUCTION_RELEASE_V1`;
- a separately approved live execution step with fresh remote/main and flow preimages.

After those values have been independently frozen and the read-only plan has passed,
the exact production installation invocation is:

```bash
RELEASE_BUNDLE='/absolute/private/padlhub-legacy-command-<commit>'
EXPECTED_INSTALLER_SHA256='<independently-frozen-installer-sha256>'
ACTUAL_INSTALLER_SHA256="$(shasum -a 256 "$RELEASE_BUNDLE/scripts/install_legacy_game_command_production_release.mjs" | awk '{print $1}')"
if [ "$ACTUAL_INSTALLER_SHA256" != "$EXPECTED_INSTALLER_SHA256" ]; then
  echo 'installer SHA-256 mismatch; refusing to execute' >&2
  exit 1
fi

env LK_LEGACY_COMMAND_RELEASE_INSTALL=INSTALL_LEGACY_GAME_COMMAND_PRODUCTION_RELEASE_V1 \
  node "$RELEASE_BUNDLE/scripts/install_legacy_game_command_production_release.mjs" \
  --mode install \
  --bundle "$RELEASE_BUNDLE" \
  --install-root /opt/padlhub/legacy-game-command \
  --executor-uid '<dedicated-non-root-uid>' \
  --expected-commit '<independently-frozen-40-hex-commit>' \
  --expected-manifest-sha256 '<independently-frozen-release-manifest-sha256>' \
  --expected-installer-sha256 "$EXPECTED_INSTALLER_SHA256" \
  --environment production \
  --deployment-id '<new-UUID>' \
  --activated-at '<canonical-non-future-RFC3339>'
```

Run it only as the approved root custodian. A failed external installer digest guard
must terminate the operator shell block before Node starts; do not continue manually.

The required `installerSha256` field intentionally makes pre-hotfix schema-v1 manifests,
attestations, compatibility reports, and execution packets fail closed. No legacy release
or signed packet is grandfathered: the trust anchor is still `UNBOUND`, so new evidence
must be generated from the new exact commit before any later binding or apply gate.

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
