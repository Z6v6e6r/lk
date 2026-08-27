# Legacy game command prerequisite handoff

## Frozen source provenance

- Repository: `Z6v6e6r/lk`
- Base commit: `83a93ffb47b0ea87a9d1efde1174b1ba5383fada`
- Base tree: `7866655f4f198095961bf082421965f1500c5c3a`
- Task branch: `codex/legacy-command-live-rebase-host-plan-20260826`
- Fresh active full-flow SHA-256: `14b5aff65e0b49fd4f37d6d1d9465af8af3ccdf2e6cfa77bc76b4a9f2a831350`
- Active full-flow nodes: `4762`
- Selected `LK Games` tab nodes: `315`
- Selected `LK Games` source SHA-256: `33c676b3bc04125c22fd5c7772fe19a36e407820aa8119e7267daad2dc9f3221`
- Hardened full-flow candidate SHA-256: `6c8512eeffbf57edc720019487a60a2779b1ec180f1ae373a201519f96a6271e`
- Combined subscription-PATCH + prerequisite candidate SHA-256: `e730bf8c043e2f33f5a75c6825d56f39a580a10201f77c399d2323f70f9f7e4d`
- Candidate full-flow nodes: `4798`
- Candidate selected `LK Games` tab nodes: `350`
- Candidate selected `LK Games` SHA-256: `490a5311a6be9ab7078bf5c00db608c36af35546614824e289ae2f0ce806741d`
- Selected HTTP inputs: `38`
- Broken wires/links: `0/0`
- Candidate budget: `47` existing function/wire changes, `36` added CAS, claim/lease, ACK, exact provider-identity read-back, recovery, and catch nodes, `0` added endpoints

The raw live flow and generated full-flow candidate remain outside Git in a private local workspace. Only source functions, a pinned patcher, fingerprints, tests, and documentation are committed.

The combined candidate keeps the active live `fn_patch` preimage fingerprint
`4fb7d6ca9961e854cefb22f0752f9c1f921e1b6cbacfea3ce16e8b8681538931`
separate from the tracked subscription-enforcement candidate fingerprint
`9c6aaf4578c69fa30daa2326506900a5ee0a265f2299f1f0e3ab20b11e01a130`.
Relative to the hardened current-main candidate, it changes exactly the
`func` field of node `e0d7883bc1a9fa8c`; node counts, routes, the `47/36`
changed/added-node budget, and broken-reference counts remain unchanged.
The predecessor production migration runner was pinned to the historical
`6c8512eeffbf57edc720019487a60a2779b1ec180f1ae373a201519f96a6271e`
candidate and rejects the combined
`e730bf8c043e2f33f5a75c6825d56f39a580a10201f77c399d2323f70f9f7e4d`
source-only identity. This handoff does not authorize either candidate for
production.

The prerequisite-only and historical subscription-only candidates remain forbidden
for sequential application. The source-only unified builder now composes all five
subscription nodes, the legacy prerequisite graph, and the provider-authoritative
payment ACK/read-back graph from fresh full-flow SHA `14b5aff6…`. Its current
candidate identity is `d88ea0af…`, with `4762 -> 4812` nodes, `215` routes, and
broken wires/links `0/0`. The source-only production runner and immutable release
manifest now pin this exact unified identity and reject both historical identities.
Production custody remains `UNBOUND`; release installation, import, migration, and
deploy are still stopped.

The first predecessor transition changed exactly one existing function,
`Prepare split game payment` (`f3f9a60354d394da`). The later production pricing
recovery transition changed exactly two existing functions, `Prepare split join payment`
(`e92e68bf3f08a70c`) and `Route Viva split payment` (`8f7bd5b482fe9763`). Every change
was limited to the `func` field. The legacy-command builder owns none of these nodes and
preserves all three fresh function bodies byte-for-byte. Versioned redacted transition
evidence is committed in `scripts/legacy_game_command_live_reconciliation.json`.

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

1. Independently review and bind production custody for the unified source-only candidate in a separate R4 rollout. Neither the subscription-only nor prerequisite-only candidates may be imported, deployed, or applied sequentially. The later rollout must prove Node-RED Mongo driver/package compatibility, install the custom node package, explicitly resolve missing tenant/duplicate game/result identities and missing result idempotency keys, verify the existing canonical rating-state unique indexes, and apply/postcheck revision plus exact index migrations with exact live preimage, backup, rollback, and active runtime proof.
2. Explicit identity mapping import: create only approved evidence-backed owner/beta mappings; no fuzzy lookup or automatic remap.
3. Game Command Gateway v1: add the versioned internal endpoint, S2S auth, normalized contract, and only business paths whose JOIN/LEAVE semantics have no unavoidable provider/payment/rating/notification side effects.
4. LK2 adapter: only after the gateway slice has its own source/CI/runtime proof.

The future gateway must not call Mongo directly from LK2 and must not reinterpret the existing legacy-to-canonical reverse bridge.

Before any runtime prerequisite installation, complete the separately gated host
preconditions in `LEGACY_GAME_COMMAND_HOST_HARDENING_PLAN.md`. That document is a
source-only plan and does not authorize a host permission or identity mutation.
