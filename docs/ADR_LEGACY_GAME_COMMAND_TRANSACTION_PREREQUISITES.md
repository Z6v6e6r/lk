# ADR: legacy game command transaction prerequisites

Status: source-only candidate. No endpoint, deploy, flow import, database mutation, index creation, secret change, identity mapping, or real game command is part of this change.

## Decision

The future LK2-to-LK1 game command gateway must use the source-controlled Node-RED config node `padlhub-legacy-game-command-store`. The config node has no input port. It owns one lazy `MongoClient` and exposes command-transaction, result-sink claim/ACK, and cleanup-recovery methods only to server-side custom nodes. Mongo URI and database name are read from the server-only environment variables named by `mongoUriEnv` and `databaseNameEnv`; neither value is stored in the flow or Git.

The service uses one Mongo session and one `withTransaction` boundary with:

- `readPreference=primary`;
- transaction `readConcern=snapshot`;
- transaction `writeConcern={w:"majority"}`;
- causal session semantics;
- one compare-and-set update of `lk_games.revision`;
- command ledger, game mutation, audit intents, outbox intents, and terminal result in the same transaction.

Independent `mongodb4` nodes, a process mutex, Redis lock, and public/cache read-back are not accepted as substitutes. The existing reverse bridge `/lk/games/:gameId/roster-command` is unchanged and is not the future LK2-to-LK1 route.

## Service API

```js
executeLegacyGameCommandTransaction({
  tenantKey,
  idempotencyKey,
  requestHash,
  correlationId,
  command,
  canonicalUserId,
  legacyGameId,
  expectedRevision,
  buildMutation,
})
```

`expectedRevision` is a mandatory positive integer. `buildMutation` is a deterministic, no-I/O domain callback supplied by the future command implementation. It must return a non-empty Mongo update and may return audit/outbox intents plus read-back verification. It cannot set/unset/increment `revision`, control `updatedAt`, or write the operation marker. There is intentionally no production NOOP command.

This prerequisite does not define JOIN/LEAVE eligibility or expose an HTTP route. That business slice remains separate.

## Transaction state machine

```text
new key
  -> CLAIMED
  -> mapping + game revision validation
     -> REJECTED (terminal business/precondition failure)
     -> APPLYING
        -> game CAS + audit/outbox intents + primary transactional read-back
        -> SUCCEEDED

same key + same hash + terminal -> stored result, replayed=true
same key + different hash       -> IDEMPOTENCY_KEY_REUSED
non-terminal duplicate          -> COMMAND_ALREADY_IN_PROGRESS
ambiguous commit                -> majority primary ledger reconciliation
no terminal evidence after the delayed majority-read barrier -> persisted UNKNOWN, never blind retry
```

An exception before commit aborts the claim, mutation, intents, and terminal result together. The driver may retry the transaction callback or commit according to Mongo transaction labels. Updates are idempotent within a retry because the transaction is not externally visible before commit and the final CAS/operation marker is atomic.

## Persistence contracts

### `lk_legacy_game_commands`

Required identity and trace fields are `tenantKey`, `idempotencyKey`, `requestHash`, `operationId`, `correlationId`, `command`, `canonicalUserId`, `legacyUserId`, and `legacyGameId`. State is `CLAIMED`, `APPLYING`, `SUCCEEDED`, `REJECTED`, or `UNKNOWN`. Terminal rows include result/error, source revisions, authoritative read-back, and timestamps.

Unique indexes:

- `(tenantKey, idempotencyKey)`;
- `(tenantKey, operationId)`.

`lk_games` has a mandatory unique `(tenantKey, id)` identity index. The service never selects the first of multiple legacy games. Migration audit rejects non-string, empty, untrimmed, or duplicate game identities before index creation, and every candidate read/CAS binds the exact configured tenant together with game id and revision.

### `lk_canonical_legacy_player_mappings`

The legacy identifier is the immutable Viva client UUID and is stored as `legacyUserId`. Required fields:

- `tenantKey`;
- canonical UUID `canonicalUserId`;
- immutable Viva UUID `legacyUserId`;
- `status=ACTIVE|REVOKED`;
- `source`, `version`, `evidenceRef`;
- creation and optional revocation timestamps.

Unique indexes protect both `(tenantKey, canonicalUserId)` and `(tenantKey, legacyUserId)`. Tenant keys must already be trimmed and both UUIDs must use canonical lowercase representation; normalized case/whitespace aliases are separately audited before index creation. A revoked row is retained. Automatic remap is prohibited. Display name, nickname, name/surname, fuzzy or unverified phone lookup, first-result selection, and client-supplied legacy IDs are prohibited.

### Intent collections

Audit and outbox intents use unique `(tenantKey, operationId, intentKey)` indexes. An external provider call must never execute inside `buildMutation`; the future JOIN/LEAVE slice must fail closed when a command requires Viva, payment/refund, rating, SMS, push, email, or another non-transactional write.

### Existing result side-effect outbox

New result submission requires a canonical client idempotency key. The durable identity is the reversible, injective length-prefixed `_id=id=res_v1_<tenantLength>_<tenantKey>_<idempotencyKey>` together with a unique `(tenantKey,idempotencyKey)` index; delimiter concatenation, truncation, and 32-bit hashes are not accepted as identity. A duplicate-key/upsert replay is acknowledged only after a primary/majority read returns the same tenant, result id, game id, idempotency key, result signature, and exact legacy-game projection. A mismatch is a terminal conflict, never a false success.

Result lifecycle writers persist `legacyGameProjectionOutbox.version=2` inside the same `lk_game_results` update as the lifecycle transition. Its sinks are explicit `RATING`, `EVENT`, and `PROVIDER` records with deterministic keys, attempt counters, lease metadata, and stored response. Mongo sinks use `FENCED` retry: rating projection queries accept only the same event or the captured predecessor state and refuse to overwrite a later event. Provider sinks use `AT_MOST_ONCE`: after claim, any lost or expired ACK becomes `UNKNOWN`/`RECOVERY_REQUIRED`; automatic provider replay is forbidden.

```text
PENDING/RETRYABLE --majority claim--> PROCESSING
PROCESSING --majority ACK-----------> DELIVERED | SKIPPED | SUPERSEDED
PROCESSING provider lease expiry ---> UNKNOWN -> RECOVERY_REQUIRED
all sinks terminal and no UNKNOWN --> outbox DELIVERED
terminal request replay ------------> stored response, zero sink/provider writes
```

Claims and completions are compare-and-set updates of the result document and use majority writes plus primary/majority reads. The existing Viva row is insert-only for this path: a terminal row is never reset to `PENDING`, its attempt counter is never cleared, and provider execution is released only after its durable row ACK followed by an exact primary/majority read of row id, tenant, result id, and result revision. Cleanup CAS failure uses the same custom service to majority-upsert `lk_legacy_game_revision_reconciliation_intents` and requires primary/majority read-back before returning its intent id.

The first successful result lifecycle transition returns an authoritative `202 RESULT_SIDE_EFFECTS_ACCEPTED` immediately after the durable result/game CAS and outbox persistence. Rating/event/Viva execution is asynchronous. A same-transition replay validates the exact durable outbox transition identity and then returns its stored terminal response. If the durable result transition exists but its saved game projection is missing, the outbox's durable `sourceGameRevision` must equal the current game revision before replay performs the stored `gamePayload` CAS; any intervening game write is `RECOVERY_REQUIRED`, with no game write or side-effect release. It never emits a second initial HTTP response or repeats an at-most-once provider call. Viva summary reads, writes, rebuilds, retry tasks, and provider release are all bound to exact tenant, result id, and result revision.

## Mandatory game revision

`lk_games.revision` is the only approved concurrency token for future legacy commands. It is a positive integer:

- new records match only a missing revision and atomically `$inc` it to `1`;
- create/upsert of an existing identity requires a positive `expectedRevision`;
- roster/lifecycle mutations match the exact current revision;
- every successful roster/lifecycle mutation increments it exactly once;
- missing, null, string, zero, or negative values fail closed after migration cutover;
- `updatedAt` remains an audit timestamp and is not concurrency authority.

The frozen live `LK Games` flow contains seven direct `lk_games` update writers. All seven are tenant-and-revision protected; there are no result-writer exemptions because confirm/dispute/expire may also project rating fields into roster entries. `scripts/legacy_game_revision_writers.json` records every writer and exact active/candidate source fingerprints plus its expected source relation. `scripts/audit_legacy_game_revision_writers.mjs` treats every non-read `mongodb4` operation aimed at `lk_games`, every dynamic mutation, and every aggregation (because `$merge`/`$out` may target games from another collection) as a potential writer and fails on an unregistered writer or on a registered source outside that writer's actual ancestor/descendant graph. Result submit/confirm/expire and cleanup reads bind the configured or persisted tenant before building a mutation plan. The source-only candidate adds ACK/catch gates for create, PATCH, cleanup, provisional-result, result-lifecycle, rating/event sinks, and provider outbox/status writes. Dependent success remains held until the relevant game CAS acknowledgement. Runtime activation of result-side-effect replay also requires an independent exact postcheck of the existing canonical `player_rating_state` unique identity indexes; this prerequisite does not silently recreate or weaken that separate migration.

## Connection and failure lifecycle

The config node creates the client lazily on first server-side use, reuses its pool, resets a failed initialization promise, and closes the owned client on Node-RED close/redeploy. Missing URI or database environment configuration fails closed. Command results and errors expose only an allowlist of stable codes and generic safe messages; raw Mongo/custom-node errors, credentials, profile data, and phone numbers must not be logged or returned. Serialized result bundles are operational PII and require a separately approved retention/access policy before runtime rollout.

The custom package pins its own MongoDB driver dependency (`^7.2.0`) instead of inheriting the Node-RED root driver. The guarded runtime task must install the package in isolation and prove module resolution and replica-set connectivity before enabling any caller; the older root driver is not accepted as transaction evidence.

Ambiguous commit recovery performs a bounded delayed barrier of primary/majority ledger and marker reads. A terminal row is authoritative. If neither terminal ledger nor marker becomes visible, or if only the marker is visible, the service persists a majority-written `UNKNOWN` ledger with reconciliation evidence and returns `COMMAND_STATE_UNKNOWN`; it is not permission to retry the mutation. A new service instance replays that terminal `UNKNOWN` rather than executing the mutation.

## Replica-set assumption

Transactions require a writable Mongo replica-set primary. The integration gate uses a disposable real single-node replica set, not repository mocks. It verifies `hello.setName` and `isWritablePrimary`, transaction commit/abort, unique indexes, concurrent duplicates, crash points, ambiguous commit retry/reconciliation, exact revision increments, read-back, and absence of partial intents.

## Consequences

This change makes the persistence boundary and migrations implementable without creating the gateway itself. A future gateway slice is still NO-GO until the custom node is installed, the revised writer candidate is deployed and independently audited, revision/index migrations are applied and postchecked, explicit mappings are created through an approved process, S2S authentication is configured, and JOIN/LEAVE business logic proves that supported paths have no excluded side effects.
