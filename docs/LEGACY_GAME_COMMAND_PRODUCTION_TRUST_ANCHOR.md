# Legacy game command production approval trust anchor

Status: source-only R4 verification contract. The Ed25519 verifier and strict evidence
schemas are implemented, but the source-controlled manifest remains `UNBOUND`. This
document does not authorize key generation, key custody changes, production database
access, migration apply, deploy, writer quiescence, or any live mutation.

## Separation of authority

The migration executor must not be able to choose its own approval key. Production
authority is therefore fixed only by
`scripts/legacy_game_command_production_trust_anchor.json`. Runtime environment
variables and CLI arguments cannot replace its fingerprint.

The private Ed25519 key must remain under an independently controlled approval role.
It must never be copied into Git, Node-RED, the migration host, an execution packet, an
evidence artifact, a CI log, or a Codex workspace. The executor receives only the
canonical SPKI PEM public key and one detached signature envelope.

The runner itself, migration core, writer registry, custom-node package, verifier, and
manifest must be installed as one custodian-owned read-only release. Every parent
directory and file is rejected if it is writable by, or owned by, the unprivileged
migration executor. Do not run a future `BOUND` apply as `root`, from a developer
worktree, or from a checkout writable by the invoking account.

An independent custodian must also create canonical
`release-attestation.json` with an `ACTIVE` deployment UUID, exact repository commit,
activation timestamp, and the live/candidate/package/writer/runner/core/verifier/
manifest/root-package/dependency-lock/Node-executable/MongoDB-runtime-closure hashes. Its exact
SHA-256 is bound into the dry-run context, runtime evidence,
and signed execution packet. The executor may read this file but must not own or modify
it. A caller-supplied release environment value cannot override the attestation.

The current manifest is intentionally:

```json
{"algorithm":"Ed25519","keyId":"UNBOUND","publicKeySpkiSha256":"UNBOUND","schemaVersion":1,"status":"UNBOUND"}
```

While it is unbound, `apply` fails before reading Mongo configuration or opening a
Mongo connection. Unit tests generate temporary Ed25519 key pairs only in process
memory; they are not production authority and are never written to disk.

## Approved source binding

Binding requires a separate exact source review with all of the following inputs:

1. an approved lowercase `keyId` identifying the independent custody generation;
2. the canonical Ed25519 SPKI PEM public key supplied through the approved custody
   channel;
3. the SHA-256 of the DER SPKI export, independently recomputed by two reviewers;
4. evidence that the private key is non-exportable or otherwise held outside the
   executor/runtime boundary;
5. an expiry/rotation/revocation owner and an emergency stop procedure.

Only the public-key fingerprint and `keyId` are committed by changing the manifest to
`status=BOUND`. No private key or signature is committed. A manifest change requires
fresh source hashes, tests, security and reliability review, checkpoint commit, user
verification, integration approval, push approval, and a later exact execution gate.

## Canonical signed material

Every protected JSON input must be UTF-8 canonical JSON: recursively sorted object
keys, no insignificant whitespace, and exactly one trailing newline. Non-canonical
JSON, duplicate-key representations, unknown fields, symlinks, extra hardlinks, and
group/other-readable protected files are rejected.

The detached Ed25519 signature covers this exact message:

```text
UTF8("PadlHub legacy game command production migration approval v1")
+ 0x00
+ RAW_32_BYTES(SHA256(exact canonical execution-packet bytes))
```

The signature envelope is itself canonical protected JSON:

```json
{
  "algorithm": "Ed25519",
  "keyFingerprintSha256": "<DER SPKI SHA-256>",
  "keyId": "<approved custody key id>",
  "migrationId": "legacy-game-command-prerequisites-production-v1",
  "packetSha256": "<exact canonical packet SHA-256>",
  "schemaVersion": 1,
  "signatureBase64": "<canonical base64 64-byte signature>"
}
```

The checked-in manifest identity, supplied public key, envelope fingerprint, signature,
and packet digest must all agree. Any mismatch is STOP before Mongo.

## Strict evidence schemas

The signed execution packet contains the exact SHA-256 of four canonical protected
evidence files. The runner parses them before Mongo and rejects unknown or missing
fields.

- Backup manifest: target/repository/snapshot identity, artifact-set digest, tool name
  and version, the exact pre-migration state digest, start/completion timestamps, and
  `status=COMPLETED`.
- Restore verification: exact backup/snapshot binding, restored-state digest,
  verification timestamp, and `status=VERIFIED`; the restored-state digest must equal
  the signed plan state digest.
- Quiescence attestation: exact target/repository/writer registry, all seven writers,
  stopped/observation/expiry timestamps, equal decimal before/after write counters,
  and `status=QUIESCENT`.
- Runtime compatibility: exact repository/live/candidate/package/writer/runner/core/
  approval-verifier/trust-manifest/root-package/dependency-lock/Node-executable/
  MongoDB-runtime-closure/release-attestation hashes, Node and MongoDB driver versions equal to
  the actually running process and installed package,
  verification timestamp, and `status=COMPATIBLE`.

All timestamps are canonical UTC RFC3339 with milliseconds. Hash and schema validation
does not prove the statements true by itself; the independent approver must review the
underlying backup, restore, quiescence, and runtime evidence before signing.

## Runtime inputs after a future binding

An apply additionally requires:

```text
--release-attestation /absolute/custodian/release-attestation.json
--approval-public-key /absolute/private/approval-public-key.pem
--approval-signature /absolute/private/approval-signature.json
```

The public key must be a canonical Ed25519 SPKI PEM owned by the executor and not
group/other-writable. The signature, packet, and four evidence JSON files must be owned
private regular files with one hardlink. The output path must differ from every input.

Even a valid signature does not authorize execution by itself. Exact release/source/
target/plan hashes, a fresh authorization window, writer quiescence, backup/restore,
runtime compatibility, explicit apply phrase, one-time receipt, and postcheck all remain
mandatory. Deploy, writer stop/resume, mapping import, and migration execution are
separate R4 transitions.

## Rotation and revocation

Revocation is source-first and fail-closed: set the manifest back to `UNBOUND`, pass the
full source/security gates, and publish that source before accepting another approval.
Never reuse an approval signature or execution nonce across a manifest change. Rotation
binds a new `keyId` and fingerprint through the same reviewed source workflow; there is
no multi-key overlap or runtime fallback.
