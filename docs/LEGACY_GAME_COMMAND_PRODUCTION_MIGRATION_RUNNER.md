# Legacy game command production migration runner

Status: source-only R4 prerequisite. This document and its runner do not authorize a
production database connection, package installation, writer quiescence, migration,
Node-RED import/restart, mapping import, deploy, or provider call.

Production `apply` is additionally fail-closed in source because
`PRODUCTION_APPROVAL_TRUST_ANCHOR_SHA256` is intentionally unbound. The runner rejects
`apply` before opening a Mongo connection. Binding an independently controlled
Ed25519 approval public-key fingerprint, defining detached-signature verification,
and reviewing the strict evidence schemas is a separate R4 source task; generating or
choosing that key is not authorized here.

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

- live full-flow SHA-256 `0d25df4289a38978ac925f46689eaa30b6fc38efb5de00061ba86266f613a24e`;
- source-only candidate SHA-256 `035e9d93b70ee8d3b2817280f42539679e5a7ed270bf8f0c242b364ad57a0e02`;
- all seven writers in `scripts/legacy_game_revision_writers.json`;
- the exact custom-node package, runner, migration-core, and writer-registry hashes
  calculated by the fresh audit process.

The live flow was pulled read-only from
`root@lk-primary-147:/root/.node-red/flows.json`: `4762` source nodes, `4798`
candidate nodes, `215` HTTP inputs, `47` changed nodes, `36` added nodes, and no
added endpoint. Any changed live SHA requires a new source task, candidate, review,
and execution packet.

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
  --out /absolute/private/dry-run.json
```

The output is counts, target fingerprint, collection counts, source hashes, exact
index classification, and `planDigest`. It contains no URI, hostname, document,
user ID, phone, mapping identity, game ID, or result ID. The output path is created
once with mode `0600`; an existing file is never overwritten.

`readyForExecutionPacket=true` means only that the automated migration surface is
clean: identity/mapping/ledger/outbox duplicates and invalid rows are zero, index
definitions do not conflict, and all three existing rating indexes exactly match.
It is not migration or deploy approval.

## Mandatory execution evidence

An apply requires all five caller-owned private regular files, each with one hardlink
and no group/other access:

1. execution packet, at most 64 KiB;
2. backup manifest;
3. restore-verification report;
4. stopped-writer/quiescence attestation;
5. runtime package/driver compatibility report.

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
    "liveFlowSha256": "0d25df4289a38978ac925f46689eaa30b6fc38efb5de00061ba86266f613a24e",
    "candidateFlowSha256": "035e9d93b70ee8d3b2817280f42539679e5a7ed270bf8f0c242b364ad57a0e02",
    "packageSha256": "<fresh audit value>",
    "writerRegistrySha256": "<fresh audit value>",
    "runnerSha256": "<fresh audit value>",
    "migrationCoreSha256": "<fresh audit value>"
  },
  "plan": {
    "digest": "<fresh dry-run planDigest>",
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

## Apply gate (blocked pending trust-anchor task and future separate approval)

The command below is documentary and cannot execute in the current source state.
After a separate reviewed trust-anchor change and exact execution approval, repeat fresh fetch/source audit,
runtime proof, backup/restore proof, writer stop, quiescence observation, and
production dry-run. Recompute the packet file SHA-256 without rewriting the file.

```bash
export LK_LEGACY_COMMAND_PRODUCTION_APPLY='APPLY_LEGACY_GAME_COMMAND_PREREQUISITES_PRODUCTION_V1'

npm run mongo:legacy-game-command-prerequisites:production -- \
  --mode apply \
  --execution-packet /absolute/private/execution-packet.json \
  --expected-packet-sha256 '<exact packet file SHA-256>' \
  --backup-manifest /absolute/private/backup-manifest.json \
  --restore-verification /absolute/private/restore-verification.json \
  --quiescence-attestation /absolute/private/quiescence-attestation.json \
  --runtime-compatibility-report /absolute/private/runtime-compatibility.json \
  --out /absolute/private/apply-result.json
```

After signature binding, before the first backfill/index mutation, the runner inserts a majority-written
`APPLYING` receipt keyed by the one-time nonce. A reused nonce is rejected. A partial
failure records `FAILED` best-effort and requires read-only postcheck plus an explicit
recovery decision; blind retry is forbidden. A successful run requires an exact
postcheck and majority acknowledgement of the `SUCCEEDED` receipt.

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
but performs zero writes while its approval trust anchor is unbound. The test creates
a unique temporary database and removes it at the end.
