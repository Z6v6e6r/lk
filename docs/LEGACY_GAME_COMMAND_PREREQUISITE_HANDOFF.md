# Legacy game command prerequisite handoff

## Frozen source provenance

- Repository: `Z6v6e6r/lk`
- Base commit: `2c51123459ba12f137a15aea573fe224cfd54e95`
- Base tree: `743b68399d8de6474a6ebe35c3773ba300d38a90`
- Task branch: `codex/legacy-game-command-prerequisites-transactions-revision-mapping-20260825`
- Fresh active full-flow SHA-256: `0d25df4289a38978ac925f46689eaa30b6fc38efb5de00061ba86266f613a24e`
- Active full-flow nodes: `4762`
- Selected `LK Games` tab nodes: `315`
- Hardened full-flow candidate SHA-256: `035e9d93b70ee8d3b2817280f42539679e5a7ed270bf8f0c242b364ad57a0e02`
- Candidate full-flow nodes: `4798`
- Candidate selected `LK Games` tab nodes: `350`
- Selected HTTP inputs: `38`
- Broken wires/links: `0/0`
- Candidate budget: `47` existing function/wire changes, `36` added CAS, claim/lease, ACK, exact provider-identity read-back, recovery, and catch nodes, `0` added endpoints

The raw live flow and generated full-flow candidate remain outside Git in a private local workspace. Only source functions, a pinned patcher, fingerprints, tests, and documentation are committed.

## What this prerequisite delivers

- a Node-RED-compatible transaction service with a single client/session/transaction boundary;
- durable command ledger and intent collection contracts;
- explicit one-to-one canonical/Viva identity mapping schema;
- mandatory positive `lk_games.revision` semantics;
- a complete seven-writer inventory with no exemptions that fails closed on operation or source drift;
- tenant-bound result and provider identities, a mandatory collision-free result idempotency identity with primary/majority read-back, exact provider row/result/revision read-back before provider release, ACK/catch gates, a majority-read-back cleanup reconciliation intent, and an embedded result side-effect outbox with versioned aggregate CAS, durable source-game revision, per-sink CAS leases, terminal ACKs, same-transition crash replay, exact-source-revision fenced stored-game recovery, fenced Mongo replay, dependency-safe replay, and at-most-once provider delivery;
- an explicit asynchronous result-transition contract: the initial durable lifecycle CAS returns `202`, while replay returns the stored terminal response or an explicit recovery response without a second provider execution;
- audit/dry-run/local-apply/postcheck/rollback-plan migration tooling;
- a fresh-preimage source-only flow candidate builder;
- a disposable real replica-set test gate.

It deliberately delivers no endpoint, S2S authentication, JOIN/LEAVE mutation builder, feature flag, mapping row, index in production, deploy, or provider write.

## Next independent tasks

1. Guarded runtime prerequisite rollout: prove Node-RED Mongo driver/package compatibility, install the custom node package, deploy the revision-writer flow candidate, explicitly resolve missing tenant/duplicate game/result identities and missing result idempotency keys, verify the existing canonical rating-state unique indexes, and apply/postcheck revision plus exact index migrations. This is R4 and requires exact live preimage, backup, rollback, and active runtime proof.
2. Explicit identity mapping import: create only approved evidence-backed owner/beta mappings; no fuzzy lookup or automatic remap.
3. Game Command Gateway v1: add the versioned internal endpoint, S2S auth, normalized contract, and only business paths whose JOIN/LEAVE semantics have no unavoidable provider/payment/rating/notification side effects.
4. LK2 adapter: only after the gateway slice has its own source/CI/runtime proof.

The future gateway must not call Mongo directly from LK2 and must not reinterpret the existing legacy-to-canonical reverse bridge.
