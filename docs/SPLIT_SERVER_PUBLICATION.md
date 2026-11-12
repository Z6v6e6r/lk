# Durable split game publication

Owner: LK1 booking/publication backend. Audience: organizers creating a new split game
with an LK1 subscription that covers the complete organizer share. The observed outcome
is one game in `games.lk_games`, linked to the already CONFIRMED booking/exercise, even
when the browser disconnects before receiving the split response.

This change is development-only until a separately approved Node-RED/worker/frontend
release. It does not repair, backfill, replay or modify any existing booking. In
particular, an old operation without the new immutable snapshot is ignored.

## Initial compatibility contour

The browser opts in for one organizer, empty waitlist, no selected community fan-out,
and no custom precise-rating override. Privacy, coarse rating bounds, title, comment,
join-price label, format and display location labels are preserved. Other creates use
the existing path. The backend additionally requires legacy LK1 CREATE (not JOIN,
training, advisory preflight or the private quarter-create owner), a verified actor,
zero final charge and one subscription visit. A paid fallback does not opt in.
The persisted organizer identity is server-derived; this initial worker uses the
neutral display name `Организатор` and does not copy browser-supplied photo/rating.

Community membership/publication and additional players are deliberately not granted
by the worker. They require their existing owner/permission paths. The first cohort
cannot silently drop those author choices: the frontend declines opt-in when present.

## Protocol and persistence

`publicationIntent` is an optional versioned whitelist on the existing split/create
request. It contains author settings only, never client identity, roster authority,
booking/exercise IDs, payment evidence, game IDs, seed snapshots or community rights.
The server derives tenant/actor/phone and booking target from the verified canonical
context. The normalized intent and binding are saved in `operation.lk1.publication`
before the existing operation insert and before provider create. Replays compare that
same normalized intent and identity; they cannot retrofit an old operation or replace
its author settings. The pre-provider CAS also fences on the saved intent.
The server also freezes the existing master-service/subservice lookup selectors,
nominal share/total/promo snapshot and deadlines. They are preserved in the game for
future JOINs, including an ordinary-price JOIN after a promotion ends. These locators
are not price/ownership proof: the existing JOIN pipeline revalidates them with Viva.

The existing booking state machine still owns all provider writes, compensation,
discounts, subscription usage and confirmation. The new worker has **no HTTP/provider
adapter or service credentials**. It processes only CONFIRMED operations with a new
version-1 PENDING snapshot and checks exact actor/tenant/booking/exercise/slot binding.

Publication uses a deterministic game ID for `(tenantKey, exerciseId)`, the existing
unique `(tenantKey,id)` index, `$setOnInsert`, exact readback and an operation CAS.
The standard game builder generates the record and canonical result roster; its
parallel HTTP/autojoin outputs are never executed. Paid authority is synthesized only
from the already verified zero-charge subscription operation, never from the intent.
The persisted game marker contains a binding digest, not a second copy of private
actor/operation/booking identifiers.
Its digest uses a lossless alphabetic a–p nibble encoding so the existing generic
phone-shaped string redactor cannot corrupt a valid digest; no PII filter is weakened.

Production writes require a replica set and a transaction spanning game insert and
publication receipt. A concurrent release/changed operation conflicts with that
transaction and cannot leave a committed game from the stale worker attempt. A lost
acknowledgement/restart reads the same deterministic record and retries publication
only. Conflicting existing games are not overwritten. Permanent conflicts are parked
BLOCKED; transient storage failures back off for 30 seconds and are parked after eight
attempts. Logs contain aggregate counts only.

A successful booking response can contain `serverPublication`:

```json
{"version":1,"state":"PENDING","operationId":"fixture-operation","candidateGameId":"gsp_fixture","gameId":null}
```

`candidateGameId` is a locator, **not proof of publication**. `gameId` is populated only
for a durable PUBLISHED receipt. The browser observes the candidate with bounded GET
polling and checks the owner, exact booking/exercise, paid state and publication marker;
it never falls back to another game POST or
booking/payment confirmation. A pending read moves to details with a pending message,
not another create action. Old servers without the descriptor retain compatibility.

## Source-driven Node-RED integration

`composeSplitPublicationSources` composes four existing function bodies:

- Prepare split game payment: validate/copy intent only while
  `LK_SPLIT_GAME_PUBLICATION_ENABLED=1` and outside the private canonical owner;
- Route atomic subscription booking: persist/bind the snapshot and return the explicit
  publication descriptor with confirmed checkout;
- Finalize subscription booking response: retain that descriptor on normal/replay paths;
- Route Viva split payment: retain the descriptor in serialized responses.

`buildSplitPublicationCandidate(flow, reviewedFunctionHashes)` requires exact target
IDs/types/names and separately reviewed SHA256 preimages, modifies only these `func`
fields, rejects ambiguous/missing anchors and refuses repeat composition. It does not
pull, write, import, restart or deploy anything. Before an eventual apply, use a fresh
private external verified live workspace and the existing exact graph contract/release
gates; do not run the broad quarantined rebuild or overwrite live bodies from stale
generic sources. Current live and main generations differ.
Disabling new opt-ins keeps the normalized incoming intent available for read-only
resume of an already stored publication; it does not retrofit an old no-intent row.

## Worker and activation prerequisites

No flag is enabled and no service is started by this PR. Future activation requires:

1. Fresh reviewed live function/graph preimages and the complete candidate/rollback.
2. Confirmed replica-set transactions and the existing non-partial, non-sparse unique
   `{tenantKey:1,id:1}` index. The worker refuses write mode without them; no migration
   is bundled or executed.
3. A least-privilege Mongo account for the configured `MONGO_DB` with read/write only
   to the operation publication metadata and games as required by the transaction;
   `MONGO_URI` and `PADLHUB_PLATFORM_TENANT_KEY` must name the intended tenant/database.
4. Install the worker closure (worker, lib, contract, canonical `fn_create.js`) from the
   reviewed commit. Start and inspect dry-run before enabling writes and the Node-RED
   opt-in flag. Frontend and server must ship from the reviewed compatible closure.

The CLI defaults to dry-run. `--once` performs one batch; `--apply` is required for any
write. The loop is bounded to 20 operations per batch, one second between batches and
two Mongo connections. For example, only after separate authorization:

```text
node scripts/split_game_publication_worker.mjs --once
node scripts/split_game_publication_worker.mjs --apply
```

Stop signal: publication conflicts, growing pending counts, wrong tenant/source or
missing transaction/index prerequisites. Stop method: disable new opt-ins, stop the
worker and retain pending intents/receipts for read-only reconciliation. Stopping does
not undo existing bookings, games, subscription usage or other past external effects.

## Validation and limitations

Run the unit/Node-RED contract tests and the existing API regressions:

```text
node --experimental-strip-types --test scripts/tests/splitGamePublication.test.mjs scripts/tests/splitPayment.apiClient.test.ts
bash scripts/run_split_publication_replica_tests.sh
```

The latter creates a new disposable localhost-only Mongo 7 replica set and deletes it
on exit. It never accepts a shared database or changes the real booking. It covers
concurrent workers, transaction rollback before commit, restart and stale released
operation observations. Failure/negative tests cover identity/intent changes, false
roster/payment/community authority, conflicting existing games, missing intent,
lost acknowledgements and failed readback. The existing mandatory CI includes the
new non-network unit suite.
The transport regression uses the real worker record, existing GET privacy sanitizer,
actual client normalizer and GET-only polling; the ordinary JOIN regression executes
the real JOIN prepare/router until its authenticated price lookup, without network.

No live Node-RED candidate was applied, no worker/flag was activated, no real booking
or payment was created or changed, and no historical split/create was repeated.
Production topology, future candidate preimages and authenticated mobile/desktop UI
remain release acceptance work. Generated build bundles and diagnostic source/data
exports do not belong in the PR.
