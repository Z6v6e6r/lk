# LK Games payment and booking lookup index

## Scope

`GET /lk/games` resolves payment and booking identities through a MongoDB `$or`
across four `paymentRef` paths and eleven `bookingIds` paths. Without an index
for every `$or` branch, MongoDB selects `COLLSCAN` even if only the most common
fields have ordinary indexes.

The proposed additive index is:

```javascript
{
  key: { "$**": 1 },
  name: "lk_games_payment_booking_lookup_wildcard_v1",
  wildcardProjection: {
    // Exactly the 15 lookup fields used by the active query.
  },
}
```

The full projection is defined and tested in
`scripts/manage_lk_games_lookup_index.mjs`. The index does not change documents,
Node-RED flows, API responses, or payment state.

## Production evidence from 2026-09-04

- Namespace: `games.lk_games`, MongoDB `8.0.17-6`.
- Documents: `17,382`; logical size: `155,993,459` bytes; storage size:
  `47,747,072` bytes.
- Existing indexes: `_id_` and `schedule_station_date_time_v1`.
- Active `GET /lk/games` query function SHA-256:
  `2535de7d1219cc56fe4eb752c5b4df14f9f4dc1f8f2443a0b29422fb3af990ee`.
- Payment lookup: `COLLSCAN`, `17,382` documents examined, `0` keys examined,
  `41 ms` in the sampled execution.
- Booking lookup: `COLLSCAN`, `17,382` documents examined, `0` keys examined,
  `73 ms` in the sampled execution.
- Combined payment plus booking lookup: `COLLSCAN`, `17,382` documents examined,
  `0` keys examined, `118 ms` in the sampled execution.
- Read-only plan digest snapshot: `6565639adbffbd2f7d23bacc68fa7aa17735ed889c4fb512bec70bd120a34963`.
  It is evidence only and is not authorization for apply. Any target, flow,
  server, or catalog drift invalidates it.

A synthetic MongoDB 7.0 rehearsal used 17,379 documents and all 15 lookup
branches. The projected wildcard index preserved the original queries
and produced `OR + IXSCAN`: payment examined one document/key; booking examined
one document and four keys. A combined 15-branch lookup also used `OR + IXSCAN`.
The fixture index occupied about 1.46 MB. The live
index size and build duration are intentionally not inferred from synthetic
data.

## Tool modes

`plan` and `verify` are read-only. Reports contain collection counts, index
metadata, query stages, and hashes of probe values. MongoDB URI and raw payment
or booking identifiers are not included.

The Node-RED runtime has `mongodb@3.7.4`; it is not used for this operation.
Build a single stdin runner with the repository-pinned `mongodb@7.2.0`, then
freeze its SHA-256 before every production session:

```bash
node_modules/.bin/esbuild scripts/manage_lk_games_lookup_index.mjs \
  --bundle --platform=node --format=cjs --target=node22 --log-level=error \
  --outfile=/private/tmp/lk-games-index-runner.cjs
shasum -a 256 /private/tmp/lk-games-index-runner.cjs
```

The 2026-09-04 read-only production plan completed on MongoDB `8.0.17-6` using
this bundled driver. The runner is streamed through SSH and is not installed on
the server:

```bash
ssh lk-primary-147 \
  'cd /root/.node-red && node - plan --flow-path /root/.node-red/flows.json' \
  < /private/tmp/lk-games-index-runner.cjs
```

The tool refuses to proceed if the protected flow is not a private regular
file, the MongoDB namespace differs, the active route/query topology drifts,
the reachable `mongodb4 find` node differs, the query function SHA changes,
the URI fingerprint, collection UUID, or topology identity changes, MongoDB is
older than 7, the driver is not exactly `7.2.0`, or an index with the managed
name/specification conflicts.

## Apply gate

Creating the index is a live schema mutation and requires separate approval.
Immediately before apply:

1. Rebuild the runner from the approved commit, retain its SHA-256, run `plan`
   again, and retain its exact output as the catalog and target preimage.
2. Confirm the active query SHA, current index catalog, document count, Node-RED
   PID/restart count, server load, available memory, and MongoDB connection
   count.
3. Start only during a low-traffic window. Do not deploy Node-RED or frontend
   artifacts in the same window.
4. Use the fresh digest once. Any catalog, server-version, target, route, Mongo
   node, or query-source drift invalidates it.

After explicit approval, the reviewed command is:

```bash
ssh lk-primary-147 \
  'cd /root/.node-red && LK_GAMES_LOOKUP_INDEX_APPLY=APPLY_LK_GAMES_LOOKUP_WILDCARD_V1 node - apply --flow-path /root/.node-red/flows.json --expected-plan-digest <fresh-plan-digest> --out /root/lk-games-index-apply-<operation-id>.json' \
  < /private/tmp/lk-games-index-runner.cjs
```

The apply re-reads the protected flow and target identity immediately before
the command. It accepts ownership only when the atomic `createIndexes` response
shows the index count increased by one. It then repeats payment-only,
booking-only, and combined `executionStats` checks and requires the managed
index, `IXSCAN`, and absence of `COLLSCAN`.

The durable apply report is reserved before connection. Immediately before the
DDL command it is fsynced as `UNKNOWN_RECONCILIATION_REQUIRED`; only a complete
postcheck changes it to `SUCCEEDED` and issues an apply receipt. There is no
automatic drop after an ambiguous create. On `UNKNOWN_RECONCILIATION_REQUIRED`,
do not retry apply or start rollback: run a fresh read-only `plan`, reconcile the
catalog and target, and request separate authority for the resulting action.

## Postcheck

Run `verify` from the same reviewed script and flow:

```bash
ssh lk-primary-147 \
  'cd /root/.node-red && node - verify --flow-path /root/.node-red/flows.json' \
  < /private/tmp/lk-games-index-runner.cjs
```

Then observe for at least 10 minutes:

- Node-RED PID, PM2 restart count, RSS, and CPU;
- server load, available memory, and MongoDB connections;
- `/lk/games` status/latency and nginx `499`/`5xx` counts;
- payment-only, booking-only, and combined lookup request counts;
- one fresh `explain("executionStats")` for each of those three shapes.

Do not execute real payment, booking, or cancellation mutations as a lookup
index check.

## Rollback gate

The index is additive; rollback does not alter game documents. A manual rollback
is still a live schema mutation and requires separate approval. It is permitted
only with the durable `SUCCEEDED` apply report whose receipt says that exact
operation created the index. An idempotent apply with `createdIndexes: []` never
authorizes rollback. Run a fresh `plan` and use the post-apply digest that still
matches the receipt:

```bash
ssh lk-primary-147 \
  'cd /root/.node-red && LK_GAMES_LOOKUP_INDEX_ROLLBACK=ROLLBACK_LK_GAMES_LOOKUP_WILDCARD_V1 node - rollback --flow-path /root/.node-red/flows.json --expected-plan-digest <fresh-post-apply-plan-digest> --apply-receipt /root/lk-games-index-apply-<operation-id>.json --out /root/lk-games-index-rollback-<operation-id>.json' \
  < /private/tmp/lk-games-index-runner.cjs
```

Rollback removes only an exact match for
`lk_games_payment_booking_lookup_wildcard_v1` and verifies the resulting catalog.
The rollback report uses the same pre-command durable unknown state and requires
fresh reconciliation after any ambiguous outcome. After a successful rollback,
the original API behavior remains available but the lookup
queries are expected to return to `COLLSCAN` until another approved index is
installed.
