# Legacy game command production migration runner

Status: source-only R4 prerequisite. This document and its runner do not authorize a
production database connection, package installation, writer quiescence, migration,
Node-RED import/restart, mapping import, deploy, or provider call.

Production `apply` is additionally fail-closed in source because the source-controlled
trust-anchor manifest remains `UNBOUND`. The runner now implements domain-separated
detached Ed25519 verification, canonical JSON, exact evidence schemas, and public-key
fingerprint binding before Mongo, but no production public-key fingerprint has been
selected. The independent custody and exact binding procedure is documented in
`LEGACY_GAME_COMMAND_PRODUCTION_TRUST_ANCHOR.md`; generating or choosing that key is not
authorized by this source task.

## Purpose and boundaries

`scripts/run_legacy_game_command_production_migration.mjs` is the separately guarded
production wrapper around the local/test prerequisite migration core. It supports
`audit`, `dry-run`, `postcheck`, `apply`, and `rollback-plan`.

The runner may automate only:

- primary/majority audit of the prerequisite collections;
- a streaming SHA-256 digest of all migration-sensitive collections and exact index
  catalogs without printing document identities;
- backfill of only missing or invalid `lk_games.revision` values to `1`;
- creation of the exact prerequisite indexes;
- a majority-written one-time execution receipt and exact postcheck.

It deliberately cannot:

- trim or guess tenant/game/result identities;
- create or repair result idempotency keys or provider-outbox identities;
- infer or insert canonical/legacy mapping rows;
- create or weaken the three canonical `player_rating_state` indexes;
- stop writers, create a backup, install the custom node, import/restart Node-RED,
  expose a command endpoint, or call Viva/provider APIs.

Any blocking audit finding must be resolved by a separate reviewed evidence-backed
repair task. A fresh `dry-run` is required after that repair.

## Frozen source identity

The current runner accepts only:

- live full-flow SHA-256 `9e9698ea3e7cfa0bd2b42a95a7eed20a82436cb06f40ecd80c13896a1960b263`;
- reviewed unified source-only candidate SHA-256 `703c065429bcee016e86ac7559c3b834754bab61bcb5c70f4da55b1cc32064ca`;
- all seven writers in `scripts/legacy_game_revision_writers.json`;
- the exact custom-node package, runner, migration-core, writer-registry,
  approval-verifier, source trust-anchor manifest, root package, dependency lock,
  Node executable, and installed MongoDB driver package hashes calculated by the fresh
  audit process;
- a custodian-owned read-only release attestation that binds the deployed commit and
  every executable source hash from outside the migration executor identity.

The live flow was pulled read-only from
`root@lk-primary-147:/root/.node-red/flows.json`: `4762` source nodes, `4812`
candidate nodes, `215` HTTP inputs, `54` changed existing nodes, `50` added nodes,
and no added endpoint. The selected `LK Games` source contains `315` nodes and has
SHA-256 `5deb5beca55441bf29da036495304d7a707158c2af87fe88838f68befd6ff78e`.
Any changed live SHA requires a new source task, candidate, review, and execution
packet. The preceding `14b5aff6… -> d88ea0af…` pair and earlier prerequisite-only
or partial combined candidates are rejected.

The exact immutable release builder and guarded install contract are documented in
`LEGACY_GAME_COMMAND_PRODUCTION_RELEASE_INSTALL.md`. A release build or install does
not import the flow, bind the approval key, connect to MongoDB, or authorize migration.

## Read-only modes

Mongo credentials remain in protected process environment and are never printed:

```bash
export LK_LEGACY_COMMAND_MONGO_URI='<server-injected protected URI>'
export LK_LEGACY_COMMAND_MONGO_DB='<exact database name>'
export LK_LEGACY_COMMAND_RELEASE_SHA='<exact deployed repository commit>'

npm run mongo:legacy-game-command-prerequisites:production -- \
  --mode audit \
  --out /absolute/private/audit.json

npm run mongo:legacy-game-command-prerequisites:production -- \
  --mode dry-run \
  --release-attestation /absolute/custodian/release-attestation.json \
  --out /absolute/private/dry-run.json
```

The output is counts, target fingerprint, collection counts, source hashes, exact
index classification, and `planDigest`. It contains no URI, hostname, document,
user ID, phone, mapping identity, game ID, or result ID. The output path is created
once with mode `0600`; an existing file is never overwritten.

Without `--release-attestation`, read-only modes remain useful for an unbound audit but
always report `readyForExecutionPacket=false`. The attested dry-run must execute from a
custodian-owned read-only release under a separate unprivileged executor; the runner
rejects source or release-attestation paths writable by that executor.

`readyForExecutionPacket=true` means only that the automated migration surface is
clean: identity/mapping/ledger/outbox duplicates and invalid rows are zero, index
definitions do not conflict, and all three existing rating indexes exactly match.
It is not migration or deploy approval.

## Mandatory execution evidence

An apply requires a custodian-owned read-only release attestation, six caller-owned
private regular files with one hardlink and no group/other access, plus the
fingerprint-bound public key:

1. release attestation, at most 64 KiB and outside executor control;
2. execution packet, at most 64 KiB;
3. detached approval signature envelope;
4. backup manifest;
5. restore-verification report;
6. stopped-writer/quiescence attestation;
7. runtime package/driver compatibility report.

The last four files may be up to 16 MiB. Their exact byte hashes must equal the
hashes in the execution packet. A packet with invented hashes and no matching files
is rejected.

The reviewed packet has this shape (values are illustrative placeholders):

```json
{
  "schemaVersion": 1,
  "migrationId": "legacy-game-command-prerequisites-production-v1",
  "environment": "production",
  "target": {
    "databaseName": "<exact database>",
    "fingerprint": "<fresh target SHA-256>"
  },
  "source": {
    "repositoryCommit": "<exact 40-hex deployed commit>",
    "liveFlowSha256": "9e9698ea3e7cfa0bd2b42a95a7eed20a82436cb06f40ecd80c13896a1960b263",
    "candidateFlowSha256": "703c065429bcee016e86ac7559c3b834754bab61bcb5c70f4da55b1cc32064ca",
    "packageSha256": "<fresh audit value>",
    "writerRegistrySha256": "<fresh audit value>",
    "installerSha256": "<fresh audit value>",
    "runnerSha256": "<fresh audit value>",
    "migrationCoreSha256": "<fresh audit value>",
    "approvalVerifierSha256": "<fresh audit value>",
    "trustAnchorManifestSha256": "<fresh audit value>",
    "rootPackageSha256": "<fresh audit value>",
    "dependencyLockSha256": "<fresh audit value>",
    "nodeExecutableSha256": "<fresh audit value>",
    "mongodbRuntimeClosureSha256": "<fresh audit value>",
    "releaseAttestationSha256": "<custodian release-attestation file SHA-256>"
  },
  "plan": {
    "digest": "<fresh dry-run planDigest>",
    "stateDigest": "<fresh dry-run stateDigest>",
    "generatedAt": "<RFC3339 inside quiescence observation>"
  },
  "backup": {
    "manifestSha256": "<backup file SHA-256>",
    "snapshotIdentitySha256": "<opaque snapshot identity SHA-256>",
    "restoreVerificationSha256": "<restore report file SHA-256>",
    "completedAt": "<RFC3339 after writers stopped>",
    "restoreVerifiedAt": "<RFC3339>"
  },
  "quiescence": {
    "attestationSha256": "<quiescence file SHA-256>",
    "writerCount": 7,
    "writerRegistrySha256": "<fresh audit value>",
    "writersStoppedAt": "<RFC3339>",
    "observedFrom": "<RFC3339>",
    "observedTo": "<RFC3339 at least 120 seconds later>",
    "expiresAt": "<RFC3339 still in the future>"
  },
  "runtime": {
    "compatibilityReportSha256": "<runtime report file SHA-256>",
    "nodeVersion": "<verified exact version>",
    "mongodbDriverVersion": "<verified exact version>",
    "verifiedAt": "<RFC3339 inside stopped-writer window>"
  },
  "authorization": {
    "approvedAt": "<RFC3339>",
    "expiresAt": "<RFC3339 no more than 30 minutes later>"
  },
  "execution": {
    "nonce": "<new UUID never used before>"
  }
}
```

Additional time rules are fail-closed: the backup must be no older than 24 hours,
must complete after writers stopped and before the observed window closes, restore
verification must follow backup completion, and the fresh plan must be generated
inside the attested quiescence window.

## Apply gate (blocked pending exact public-key binding and future separate approval)

The command below is documentary and cannot execute in the current source state.
After a separate reviewed manifest binding and exact execution approval, repeat fresh fetch/source audit,
runtime proof, backup/restore proof, writer stop, quiescence observation, and
production dry-run. Recompute the packet file SHA-256 without rewriting the file.

```bash
export LK_LEGACY_COMMAND_PRODUCTION_APPLY='APPLY_LEGACY_GAME_COMMAND_PREREQUISITES_PRODUCTION_V1'

npm run mongo:legacy-game-command-prerequisites:production -- \
  --mode apply \
  --execution-packet /absolute/private/execution-packet.json \
  --expected-packet-sha256 '<exact packet file SHA-256>' \
  --release-attestation /absolute/custodian/release-attestation.json \
  --approval-public-key /absolute/private/approval-public-key.pem \
  --approval-signature /absolute/private/approval-signature.json \
  --backup-manifest /absolute/private/backup-manifest.json \
  --restore-verification /absolute/private/restore-verification.json \
  --quiescence-attestation /absolute/private/quiescence-attestation.json \
  --runtime-compatibility-report /absolute/private/runtime-compatibility.json \
  --out /absolute/private/apply-result.json
```

After trust-anchor binding and signature verification, before the first backfill/index
mutation, the runner inserts a majority-written `APPLYING` receipt keyed by the one-time
nonce. Any insert error or unacknowledged result triggers a primary/majority read-back;
an exact receipt becomes `RECOVERY_REQUIRED`, a conflicting nonce is rejected, and an
absent or unreadable result remains `UNKNOWN`. None of those branches may start the
migration. This bounded receipt read-back remains allowed after the short-lived mutation
authority expires. The CLI emits a distinct safe code and, when `--out` was reserved,
writes a private `STOPPED` failure report so the required recovery branch is not lost.
A partial failure after an acknowledged receipt records `FAILED` best-effort
and requires read-only postcheck plus an explicit recovery decision; blind retry is
forbidden. A successful run requires an exact postcheck and majority acknowledgement
of the `SUCCEEDED` receipt.

## Postcheck and recovery

```bash
npm run mongo:legacy-game-command-prerequisites:production -- \
  --mode postcheck \
  --out /absolute/private/postcheck.json

npm run mongo:legacy-game-command-prerequisites:production -- \
  --mode rollback-plan \
  --out /absolute/private/rollback-plan.json
```

`postcheck` is read-only and fails on any invalid revision/identity, duplicate,
missing/conflicting prerequisite index, or missing/weakened canonical rating index.
`rollback-plan` is offline and never connects to Mongo. Revision tokens, execution
receipts, command ledgers, outboxes, intents, and mappings are forensic state and are
not blindly deleted. Writer resume, flow deploy, and mapping import remain separate
explicit R4 transitions.

## Source-only rehearsal

The disposable replica-set gate exercises the real write path without shared state:

```bash
npm run test:legacy-game-command-prerequisites:mongo
```

It proves the existing sentinel-bound local revision backfill and exact index
postcheck, then proves the production runner can generate a fresh target/state audit
but performs zero writes while its source manifest is unbound. Unit tests separately
prove valid and invalid detached Ed25519 signatures plus strict evidence schemas using
in-memory temporary keys. They also bind the packet to the actual `process.version`,
installed MongoDB driver version, dependency lock, and immutable runtime artifact
digests. The replica test creates a unique temporary database and removes it at the end.
