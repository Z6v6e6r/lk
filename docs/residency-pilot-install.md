# Residency LK1 pilot: installation and recovery packet

Status: **prepared and exercised in the isolated composition; not installed on 147.**
Everything below is reversible and none of it changes the published old checkout until the
separate frontend publication. Live mutations require the owner's explicit approval naming
source, scope, target, order, verification, stop signal and recovery.

## 1. Frozen artifacts

All hashes below were produced from this task branch; the published bundle is a live
artifact and is not rebuilt.

| Artifact | Value |
| --- | --- |
| Custom node | `node-red/custom-nodes/residency-lifecycle-api` |
| Custom node tarball (without `node_modules`) | sha256 `00452423a223ab5b8e3a6c66fad7df2a3f5fdf38cc35962c8a9b6b646259d519`, 39 097 bytes |
| Custom node files | `lib/residency-lifecycle.mjs` `75d340a7…`, `lib/residency-lifecycle-provider.mjs` `c2bf6214…`, `lib/residency-lifecycle-http.mjs` `ffdffd0f…`, `lib/residency-lifecycle-store.mjs` `c16aba33…`, `residency-lifecycle-node.cjs` `09c35201…` (full list in `docs/evidence/residency-pilot/isolated-composition-20261118/hashes.txt`) |
| Import | `node-red/imports/lk_residency_lifecycle.import.json`, sha256 `22e524fb…`, 19 nodes (1 tab, 1 store, 15 http in including OPTIONS, 1 http, 1 response) |
| Dependency | `mongodb@7.2.0` (custom node `package-lock.json`), `nodered/node-red:4.0.9-22` (Node 22.14.0 in the isolated run; 147 runs Node 22.23.2) |
| New frontend | this branch, production build sha256 `0a83dbc72dc6c55549bab42ce597aa65089f9eca94f3577d803b04e018cbd59e`, 2 976 424 bytes (must be rebuilt and re-hashed by the release mechanism) |
| Published old frontend | `20261118T164240Z` / `27ea6a8c…` / `fce60c89…`; remains the production entry |

A new bundle hash must be produced by the existing release build, not copied from this
document. `dist/bundle.js` is not a published artifact.

## 2. Preconditions and preimage

1. Access to `lk-primary-147` (SSH currently times out from the working host; the operator
   must run this from a host with access). Do not use a VPN route for the browser smoke
   unless the confirmed tunnel is in place.
2. Fresh live preimage **at apply time**:
   `npm run nodered:modular:pull-147 -- /abs/path/flows.json` into a private workspace.
   Verify: 5 678 nodes, 316 `http in`, no `/lk/residency/{catalog,status,orders…}` route,
   no `lk_residency_lifecycle_*` id, and old `/lk/residency/passes` still present.
   The last read-only snapshot is `scripts/tests/fixtures/lk1-live-http-routes-20261118.json`;
   it is evidence, not a substitute for the fresh preimage.
3. Backups: `/root/.node-red/flows.json`, the two env files, `~/.node-red/package.json` and
   the installed custom-node directory. Record sha256 of each.
4. The Node-RED process must hold a non-expired Viva Admin token in global context
   (`vivacrm_access_token`, `vivacrm_token_expires_at`). The external guard reads the
   provider transaction list with it; without it, new orders fail closed with 503.

## 3. Preparation (no live change)

```bash
npm ci
npm run test:residency-lifecycle          # with LK_TEST_MONGO_URI for the 10 real-Mongo cases
npm run test:residency-pilot
npm run test:residency-lk1-compat
npx tsc -b
```

Prepare the additive candidate without touching the live file:

```bash
node scripts/prepare_lk_residency_lifecycle_install.mjs \
  --preimage /private/flows.json \
  --import node-red/imports/lk_residency_lifecycle.import.json \
  --candidate /private/candidate.json \
  --report /private/report.json
```

It refuses a route/node-id collision and never overwrites. Review `report.json`: only the
19 new nodes are added, no existing node is edited.

## 4. Indexes (one-off, before the first request)

`ENSURE_INDEXES=false` in normal runtime. Apply exactly these five specs on the pilot
database (`mongosh <private-uri>/<db> < scripts/pilot-composition/apply-indexes.js`):

| Name | Keys | Options |
| --- | --- | --- |
| `residency_order_identity` | `{tenantId:1, orderId:1}` | unique |
| `residency_order_idempotency` | `{tenantId:1, idempotencyKeyHash:1}` | unique |
| `residency_order_active_slot` | `{tenantId:1, userId:1, activeSlot:1}` | unique, partial `{activeSlot:1}` |
| `residency_order_user_state` | `{tenantId:1, userId:1, state:1}` | — |
| `residency_order_expiry` | `{tenantId:1, state:1, "payment.expiresAt":1}` | — |

Read back with `db.lk_residency_lifecycle_orders.getIndexes()` and compare key/unique/partial,
not just the name; the node fails with `RESIDENCY_LIFECYCLE_INDEXES_MISSING`/
`…_MISMATCH` if the reviewed contract is absent.

## 5. Configuration (names only; values stay in the protected env files)

```text
LK_RESIDENCY_LIFECYCLE_ENABLED=true
LK_RESIDENCY_LIFECYCLE_MONGO_URI / _MONGO_DB
LK_RESIDENCY_LIFECYCLE_VIVA_API_URL
LK_RESIDENCY_LIFECYCLE_CUP_API_URL / _CUP_INTEGRATION_TOKEN
LK_RESIDENCY_LIFECYCLE_KEYCLOAK_USERINFO_URL
LK_RESIDENCY_LIFECYCLE_SUCCESS_URL / _FAIL_URL          # base URLs, no query string
LK_RESIDENCY_LIFECYCLE_RETURN_TARGETS={"lk1pilot":{"successUrl":"https://padlhub.su/lk_new?phResidencyLifecycleReturn=1","failUrl":"…"}}
LK_RESIDENCY_LIFECYCLE_DEFAULT_RETURN_TARGET=lk1pilot
LK_RESIDENCY_LIFECYCLE_CREATE_ENABLED=false             # step 1: servicing only
LK_RESIDENCY_LIFECYCLE_CREATE_AUDIENCE=pilot
LK_RESIDENCY_LIFECYCLE_PILOT_USERS=["iSkq6G:<verified-sub>"]
LK_RESIDENCY_LIFECYCLE_EXTERNAL_GUARD=true              # default true; do not disable
LK_RESIDENCY_LIFECYCLE_EXTERNAL_LOOKBACK_MS=2592000000
LK_RESIDENCY_LIFECYCLE_IDENTITY_LOG=false               # true only for enrollment
LK_RESIDENCY_LIFECYCLE_ENSURE_INDEXES=false
```

`SUCCESS_URL`/`FAIL_URL` are validated as bare HTTPS URLs; a query string in those two
variables makes the runtime fail with `RESIDENCY_CONFIG_INVALID:SUCCESS_URL`. The query
belongs only in `RETURN_TARGETS`.

## 6. Apply order

1. Copy the custom node to `/root/.node-red/node_modules/@padlhub/node-red-residency-lifecycle-api`
   and install its dependency in the Node-RED project (`npm install --omit=dev`).
2. Validate the custom node loads: restart in a maintenance window and read the log for
   `Loading palette nodes` without errors. Do not import the flow yet.
3. Apply the five indexes (section 4).
4. Import the reviewed candidate additively (new tab only; no existing node edited).
5. Set `ENABLED=true, CREATE_ENABLED=false` and restart Node-RED.
6. Read back:
   - `OPTIONS /lk/residency/catalog` → 204 with CORS headers;
   - authenticated `GET /lk/residency/catalog|status|orders?state=unresolved` → 200;
   - `POST /lk/residency/orders` → 503 `RESIDENCY_ORDERS_DISABLED` (no provider POST);
   - old `/lk/residency/passes`, summer-subscription and tournament routes → unchanged;
   - `getIndexes()` matches section 4; `ENSURE_INDEXES` remains false.
7. Enable the pilot: `CREATE_ENABLED=true`, verified `PILOT_USERS`, restart.
8. Verify: pilot create without `Idempotency-Key` → 400 `RESIDENCY_IDEMPOTENCY_KEY_REQUIRED`
   (no order, no provider POST); ordinary account create → 403; the old checkout still loads.
   This verification does not create a financial operation.
9. Publish the frontend only through the existing release mechanism and under a separate
   approval. The old `?buyResidency=1` page remains available as the rollback entry.

## 7. Readback and stop signals

| Check | Expected | Stop signal |
| --- | --- | --- |
| Routes | 8 lifecycle methods + OPTIONS; no collision | any changed old route/id |
| Indexes | exactly the five reviewed specs | missing/mismatched index (503) |
| Create gate | 503 with `CREATE_ENABLED=false`, 403 ordinary, 200 pilot | 200 for an ordinary account |
| External guard | 409 `RESIDENCY_EXTERNAL_PURCHASE_PENDING` when an old transaction is open; 503 when the provider list is unreadable | create 200 while the list is unavailable |
| Orders | unresolved read and reconcile still 200 after create is stopped | read/reconcile 5xx after stop |
| Provider | one `POST` per confirmed operation; no second transaction | two transactions for one order |

## 8. Recovery drill (already exercised in isolation)

The isolated composition ran exactly this order (scenario D in
`docs/evidence/residency-pilot/isolated-composition-20261118/e2e-scenarios.json`):

1. create an order and leave it unpaid;
2. set `CREATE_ENABLED=false` and restart: new create 503, the order is still readable;
3. open the old frontend: the old page loads; no new lifecycle order is created;
4. restart with the pilot config: the order is still there;
5. pay the original transaction and reconcile: the original order becomes ACTIVE;
6. total: one order, one Viva transaction, no new purchase.

Do **not** stop the whole service (`ENABLED=false`) as the routine stop while orders are
unresolved: reads, reconcile and activation must stay available. `ENABLED=false` is only
for an emergency; it does not cancel Viva transactions.

## 9. Rollback

| Situation | Action |
| --- | --- |
| Stop new purchases | `CREATE_ENABLED=false`; keep `ENABLED=true` until started orders are terminal |
| Frontend regression | republish the previous complete bundle or use `?buyResidency=1`; Node-RED/Mongo/Viva stay |
| Remove the flow | reviewed pack process only; never while orders are unresolved |
| Data | never drop the collection or indexes with unresolved orders; Viva transactions are not cancelled by any of these steps |
| Full emergency | `ENABLED=false` (service reads stop) + old frontend; restore the env and flows from the backups, then re-run section 7 |

## 10. Identity enrollment (no UUID relay from Alexey)

Exact claims the gateway needs from Keycloak userinfo:
`sub` (gateway `userId`), `azp|client_id|clientId = widget`, and
`tenantKey|tenant_key|tenant = iSkq6G`. The allowlist entry is `iSkq6G:<sub>`; nothing else
(phone, email, Keycloak admin id) is accepted.

No Keycloak admin credential, admin CLI, user token or 147 access exists in this workspace,
so the `sub` could not be read here. The concrete next action does not require Alexey to
find a UUID or send a token:

1. Operator: restart with `ENABLED=true`, `CREATE_ENABLED=false`, `IDENTITY_LOG=true`,
   and the storage/provider configuration. No allowlist entry is needed yet.
2. Alexey: logs in to LK1 normally and opens
   `https://padlhub.su/lk_new?buyResidency=lifecycle` once.
3. Operator: reads the Node-RED log line
   `{"event":"residency_lifecycle_identity","tenantId":"iSkq6G","userId":"…","identity":"iSkq6G:…"}`
   and copies the `identity` value.
4. Operator: sets `PILOT_USERS=["iSkq6G:<userId>"]`, `CREATE_ENABLED=true`,
   `IDENTITY_LOG=false`, restarts, and verifies section 7 (ordinary 403, pilot 400 without
   an idempotency key).
5. If log access is not available, add the operator-only identity probe as a separate
   reviewed change; do not widen the allowlist or guess the `sub`.

## 11. What is still missing before a real purchase

1. Verified `sub` of the pilot account (section 10).
2. Fresh live preimage and server access for the apply/readback (section 2).
3. A healthy Viva Admin token in the Node-RED global context.
4. Owner approval for the real test purchase (amount confirmed by `GET /catalog` at that
   moment) and the decision on the reverse-direction boundary (see acceptance).
