# Legacy game command prerequisite migrations

This runbook describes a future guarded production task. The current source-only change must not run any command in this document against shared or production state.

## Artifacts

- Transaction module: `node-red/custom-nodes/legacy-game-command-transaction/`
- Revision writer registry: `scripts/legacy_game_revision_writers.json`
- Fresh-flow candidate builder: `scripts/patch_live_games_command_prerequisites.mjs`
- Writer audit: `scripts/audit_legacy_game_revision_writers.mjs`
- Migration tool: `scripts/migrate_legacy_game_command_prerequisites.mjs`
- Production packet runner: `scripts/run_legacy_game_command_production_migration.mjs`
- Disposable replica gate: `scripts/run_legacy_game_command_replica_tests.sh`

The migration tool supports `audit`, `dry-run`, `apply`, `postcheck`, and `rollback-plan`. It defaults to `audit`. Its current `apply` guard accepts only an explicitly confirmed local/test database through a direct single-host loopback URI and requires a pre-existing destination sentinel bound to the exact database name and a UUID `localTargetId`. Production/shared apply is intentionally disabled until a separate R4 migration task has deployed and verified all mandatory revision writers.

Example local sequence (never reuse production credentials):

```bash
export LK_LEGACY_COMMAND_MONGO_URI='mongodb://127.0.0.1:27017/?directConnection=true'
export LK_LEGACY_COMMAND_MONGO_DB='lk_command_test'
npm run mongo:legacy-game-command-prerequisites -- --mode audit
npm run mongo:legacy-game-command-prerequisites -- --mode dry-run
npm run mongo:legacy-game-command-prerequisites -- --mode apply --environment test --confirm-local-apply --local-target-id '<UUID matching the pre-created disposable DB sentinel>'
npm run mongo:legacy-game-command-prerequisites -- --mode postcheck
npm run mongo:legacy-game-command-prerequisites -- --mode rollback-plan
```

The disposable replica test creates the sentinel itself. A manual local apply must create `lk_local_migration_sentinels/_id=legacy-game-command-prerequisites-local-v1` in advance with exact `databaseName`, `localTargetId`, and `purpose=DISPOSABLE_LEGACY_COMMAND_PREREQUISITE_TEST`. The sentinel is deliberately not auto-created by the migration tool. No command prints the Mongo URI. Audit output contains counts, not documents, user IDs, phones, or profile fields.

The separate production runner is documented in `LEGACY_GAME_COMMAND_PRODUCTION_MIGRATION_RUNNER.md`. It does not weaken the local/test guard. Production apply is currently impossible because its independently controlled approval trust-anchor fingerprint is intentionally unbound; the runner rejects before opening Mongo. A later source task must bind and review detached Ed25519 approval/evidence verification. Even after that, apply also requires a fresh state digest and target fingerprint, exact source/package/runner hashes, protected backup/restore/quiescence/runtime evidence files, a short-lived signed packet, an explicit apply phrase, and a one-time majority-written execution receipt. This source-only task did not connect it to production Mongo or execute any apply mode.

## Required production order

1. Fresh-pull `/root/.node-red/flows.json` from `lk-primary-147` into a private workspace and freeze its SHA.
2. Re-run the writer inventory. Drift or an unregistered `lk_games` writer is STOP.
3. Build the source-only flow candidate from the exact preimage and independently inspect the allowed change budget.
4. Install the custom node package and its existing MongoDB peer dependency in a separate runtime task. Do not configure an endpoint.
5. Enter a maintenance quiescence that stops every `lk_games` writer and verify the write counter remains unchanged. Do not deploy the candidate before quiescence.
6. Run production audit/dry-run from a separately reviewed migration runner using primary/majority reads. Record invalid game/result identities and revisions, missing/invalid result idempotency keys, duplicate game/result identities, duplicate `(tenantKey,idempotencyKey)` result identities, invalid or duplicate tenant-qualified provider-outbox identities, mapping validation/raw duplicates/normalized aliases, ledger duplicates, command-intent duplicates, and cleanup-reconciliation duplicates.
7. Resolve every invalid tenant/game id and duplicate `(tenantKey,id)` identity explicitly. The source-only tool will not trim, guess ownership, or select a duplicate.
8. While writers remain quiesced, backfill only missing/invalid `lk_games.revision` values to `1`; explicitly repair tenant/id/revision/idempotency identity of historical `lk_game_results` and tenant-qualified identity of historical provider-outbox rows; create the exact game/result/outbox/cleanup plus other prerequisite indexes; and run exact postcheck. Historical result idempotency keys must come from reviewed request/ledger evidence: the tool never hashes a result into a guessed key, guesses a tenant, or accepts a collision.
9. Still under quiescence, deploy the mandatory revision writer candidate under the normal Node-RED guarded import/restart stage.
10. Prove active-flow SHA, node graph, Mongo ACK shape, runtime package resolution, and that create/PATCH/result/split/projection writers create or increment a positive revision exactly once. Before enabling result side-effect replay, independently postcheck the existing canonical rating migration indexes `player_rating_state_key_uq`, `player_rating_state_client_uq`, and `player_rating_state_phone_uq` with their exact key/unique/partial-filter contracts. Exercise existing draft/payment-confirm compatibility with explicit revision for every update-existing path.
11. Resume writers only after a second primary/majority postcheck proves zero drift and exact index name/key/order/unique properties. Any write during steps 6-10 is STOP and restarts the audit.
12. Only then may an approved mapping process add explicit mappings with trimmed tenant keys and canonical lowercase UUIDs. Keep the future gateway disabled until S2S secret injection, endpoint contract, supported JOIN/LEAVE business rules, and side-effect exclusions pass their own R4 gate.

The runner automates only the safe subset of step 8: revision backfill and exact prerequisite indexes after all other blockers are zero. Historical result/provider identity repairs and mapping rows remain separate evidence-backed migrations.

## Mapping migration policy

This prerequisite creates schema/index capability only. It does not infer or insert a production identity mapping. A future mapping import must be an explicit, reviewed list with evidence per row. It must audit both sides before every insert, reject conflicts, never reuse a revoked side, and produce a postcheck count/hash without exposing identifiers in logs.

## Postcheck invariants

- every `lk_games` document has trimmed, non-empty string `tenantKey` and `id`, plus a positive integer `revision`;
- `(tenantKey,id)` game identity is duplicate-free and protected by the exact unique index;
- all seven registered writers are active and use exact revision CAS/increment semantics;
- both mapping unique indexes exist;
- both command-ledger unique indexes exist;
- both intent unique indexes exist;
- every existing `lk_game_results` row has `_id=id=buildLegacyResultId(tenantKey,idempotencyKey)`, a canonical tenant/game/result identity, a positive revision, and an approved canonical idempotency key;
- result `(tenantKey,id)` and `(tenantKey,idempotencyKey)` identities are duplicate-free and protected by exact unique indexes;
- tenant/result/revision and embedded result-outbox lookup indexes exist;
- tenant-qualified provider-outbox identity and result/revision lookup indexes exist;
- cleanup reconciliation identity/status indexes exist;
- every existing provider-outbox row has canonical tenant, id, result id, and positive result revision, and resolves to exactly that tenant-qualified result row at that revision before writer activation;
- the canonical `player_rating_state` identity indexes have their exact existing key, unique, and partial-filter contracts before result side-effect replay is enabled;
- mapping runtime-validation and duplicate counts are zero;
- command ledger and intent duplicate counts are zero;
- no command endpoint is active yet;
- no secret value exists in Git or exported flow artifacts.

## Rollback

Rollback is operational, not a blind down migration:

- disable future gateway callers first;
- keep `lk_games.revision` values because deployed writers may already depend on them;
- revoke an incorrect mapping instead of deleting/remapping it;
- preserve command ledgers, result outboxes, command intents, and cleanup reconciliation intents as forensic evidence;
- remove indexes only after proving no active code uses them;
- restore the previous guarded flow only if its preimage and compatibility with retained revisions are verified.

The tool emits the same rollback plan in `rollback-plan` mode and performs no mutation.
