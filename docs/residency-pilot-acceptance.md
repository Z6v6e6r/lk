# Residency LK1 personal pilot: compatibility, entry and acceptance

Status: source and local harness only. No Node-RED import, no custom-node install, no
Mongo index apply, no frontend publication, no real Viva/CUP call and no real payment were
performed by this change. Deployment and the real purchase chain are separate approved
operations.

## Pinned current state (read-only, 2026-11-18)

| Object | Value | Evidence |
| --- | --- | --- |
| Published LK1 bundle | version `20261118T144752Z`, source `8ff3735e7106815db702f47c2ec5faa0f91a88c4` (`codex/child-tournament-release-147-20261118`) | `https://padlhub.su/lk/release.json` and host `/var/www/html/lk-frontend-current/release.json` |
| Published bundle hash | `sha256 79789bf8a5d755ed7c6391208b76a058738f39b393f3cd85175b08bbfb097a7f`, 2 946 687 bytes | host readback + `scripts/tests/fixtures/lk1-published-bundle-20261118.json` |
| Old bundle routes | contains `/lk/residency/passes`, `/lk/tournaments/summer-subscription/{status,purchase,confirm}`, `buyResidency`, product `4037a3a3-e551-4f9a-a9db-1410e46b8635`; **no** `residency/orders` and no new refusal codes | same fixture |
| Node-RED | 4.0.9, Node 22.23.2, pm2 `node-red`, `/root/.node-red/flows.json` | read-only host inspection |
| Installed graph | 5 678 nodes, 316 `http in`; **no** `/lk/residency/*` route and no lifecycle node id | `scripts/tests/fixtures/lk1-live-http-routes-20261118.json` |
| Installed residency flags | `SUBSCRIPTIONS_RESIDENCY_BOOKING_ENABLED=false`, `SUBSCRIPTIONS_RESIDENCY_PREVIEW_ENABLED=true`; no `LK_RESIDENCY_LIFECYCLE_*` | host env-file names/flag values |
| New owner source | PR #443 head `2f7c2d48251bc883cab9cf34a51492ba32be045e` + this task branch | draft PR #443 |
| New pilot frontend | this task branch, not published | `?buyResidency=lifecycle` |

The old client purchases residency directly from the browser through
`/end-user/api/v1/{tenant}/transactions` and the Viva product id above. It does not call
the new lifecycle API. The new API is an additive flow plus a separate custom node; it
does not replace the old function nodes, so the old checkout keeps its route, payload and
Viva transaction owner.

## What changed for compatibility and pilot

1. `POST /lk/residency/orders` is gated by a server-side allowlist of verified
   `tenantId:userId` claims. Default: `CREATE_ENABLED=false` → 503
   `RESIDENCY_ORDERS_DISABLED`; `CREATE_AUDIENCE=pilot` with an empty list → 403
   `RESIDENCY_CREATE_NOT_ALLOWED`; a malformed list → 503
   `RESIDENCY_CREATE_POLICY_INVALID`. The `test` URL/localStorage switch is not read.
2. `LK_RESIDENCY_LIFECYCLE_ENABLED` is the service switch; `CREATE_ENABLED` is the
   new-order switch. With `CREATE_ENABLED=false` an existing order remains readable
   (`GET /orders?state=unresolved`, `GET /orders/{id}`, `GET .../payment`),
   reconcilable (`POST .../reconcile`) and cancellable.
3. A separate pilot page `/lk_new?buyResidency=lifecycle` (return
   `?phResidencyLifecycleReturn=1`) reads catalog/status, shows the exact total, sends
   `expectedTotalMinor`, keeps one idempotency key per confirmed operation, recovers an
   unresolved order instead of creating a new one and never treats a bank return as
   payment proof. The old `?buyResidency=1` page, `zeroCheckoutPayment` and the pass
   gateway are untouched.
4. The pilot page detects the old checkout marker and refuses to start a second order,
   linking to the old page instead. The reverse direction (old page started after a new
   order) is not interceptable without changing the published old client; this is an
   explicit residual risk, not a claim of a shared transaction.

## Test entry and flags

- Purchase: `https://padlhub.su/lk_new?buyResidency=lifecycle` (allowlisted account).
- Bank return: `https://padlhub.su/lk_new?phResidencyLifecycleReturn=1` via the
  server-configured return target key `lk1pilot`.
- Old fallback: `https://padlhub.su/lk_new?buyResidency=1` (unchanged production page).
- No automatic switch: the new page is not linked from the cabinet. The URL selects the
  UI; the server allowlist grants the right.

Required environment (names only; values in the protected env files):

```text
LK_RESIDENCY_LIFECYCLE_ENABLED=true
LK_RESIDENCY_LIFECYCLE_CREATE_ENABLED=true
LK_RESIDENCY_LIFECYCLE_CREATE_AUDIENCE=pilot
LK_RESIDENCY_LIFECYCLE_PILOT_USERS=["iSkq6G:<verified-sub>"]
LK_RESIDENCY_LIFECYCLE_MONGO_URI / _MONGO_DB
LK_RESIDENCY_LIFECYCLE_CUP_API_URL / _CUP_INTEGRATION_TOKEN
LK_RESIDENCY_LIFECYCLE_RETURN_TARGETS={"lk1pilot":{"successUrl":"https://padlhub.su/lk_new?phResidencyLifecycleReturn=1","failUrl":"https://padlhub.su/lk_new?phResidencyLifecycleReturn=1"}}
```

`<verified-sub>` is the Keycloak `sub` of Alexey's account, read from an authenticated
admin/userinfo source. It is **not guessed** and is not in this repository; the pilot stays
closed until it is supplied.

## Exact install order (not performed)

1. Clean task branch, `npm ci`, `npm run test:residency-lifecycle`,
   `npm run test:residency-pilot`, `npm run test:residency-lk1-compat`, `npm run
   build:prod`.
2. Copy `node-red/custom-nodes/residency-lifecycle-api` to the 147 Node-RED custom-node
   directory and install its `mongodb` dependency in the Node-RED project. Do not replace
   the graph.
3. Back up `/root/.node-red/flows.json` and the two env files. Add the flags above to
   `subscriptions-residency-node-red-flags.env` and the secrets to the protected env file.
4. Apply the five indexes from `RESIDENCY_LIFECYCLE_INDEXES` as a one-off operator step;
   keep `ENSURE_INDEXES=false` in normal runtime.
5. Prepare the additive candidate without touching the live file:
   `node scripts/prepare_lk_residency_lifecycle_install.mjs --preimage <live flows.json>
   --import node-red/imports/lk_residency_lifecycle.import.json --candidate <private
   candidate.json> --report <private report.json>`. It refuses an existing id/route and
   never overwrites. Import the reviewed 19 nodes additively (new tab, no existing node
   edited). Verify the 8 routes, OPTIONS, the store binding and that the old
   summer-subscription and pass routes are unchanged. Restart Node-RED under the existing
   change process, then read back the routes, flags and indexes.
6. Smoke with flags: `ENABLED=true, CREATE_ENABLED=false` (catalog/status read, create 503,
   old checkout unchanged); then `CREATE_ENABLED=true, AUDIENCE=pilot` with the verified
   sub (allowlisted create 200, ordinary account 403, old checkout unchanged).
7. Publish the frontend through the existing release mechanism only after local checks,
   then open the pilot URL on the published bundle. The old bundle remains the production
   entry.

## Stop and rollback

- Stop new purchases: `CREATE_ENABLED=false`. Existing orders keep reading, reconcile,
  cancel and activation.
- Stop the whole new API: `ENABLED=false`. Orders are not deleted; Viva transactions are
  not cancelled.
- Frontend rollback: publish the previous complete bundle / keep using
  `?buyResidency=1`. The old page does not depend on the new flow. This does **not**
  roll back Node-RED, Mongo or Viva; keep servicing with `ENABLED=true` until started
  orders are terminal.
- Remove the import only with the reviewed Node-RED pack process; never delete the
  collection or indexes while orders are unresolved.

Evidence: [local checks](evidence/residency-pilot/local-checks.txt),
[browser states](evidence/residency-pilot/browser-states.txt),
[host and published bundle](evidence/residency-pilot/host-readonly.txt).

## Automated checks (LOCAL, this workspace)

| Check | Command | Result |
| --- | --- | --- |
| Lifecycle module suite | `LK_TEST_MONGO_URI=... mongo:8.0.5 npm run test:residency-lifecycle` | 105 pass, 0 skipped (disposable Mongo 8.0.5; 9 real-store cases included) |
| Pilot HTTP gate | included above | new cases: default deny, 403 ordinary, allowed pilot, 503 stopped create, reads/reconcile/activation after stop, missing policy closed |
| Config allowlist | `node --test scripts/tests/residencyLifecycleGateway.test.mjs` | valid list, wrong tenant, malformed/empty/duplicate, invalid audience; runtime storage check unaffected |
| Frontend route/attempt/decision/client | `npm run test:residency-pilot` | 8 pass |
| Route/id isolation + old bundle surface | `npm run test:residency-lk1-compat` | 7 pass: 4 against the live 316-route fixture/published bundle, 3 additive-install guards |
| TypeScript | `tsc -b` | pass |
| Lint (changed files) | `eslint ...` | pass |
| Main bundle | `vite build` | pass (2.97 MB, 351 modules) |
| Browser harness | synthetic JWT + fixture API, Chrome headless/CDP | pilot, active, unavailable, legacy marker, return pending/unknown/review/paid, denied, disabled, unknown create, double click (1 POST) |

The browser harness is a local fixture, not the real LK1 session, Viva or CUP. It proves
the screen states and the request/response wiring, not the real payment chain.

## Manual acceptance scenario (for Alexey)

Each row: user action → expected screen → server-verifiable result. Do not repeat a real
charge; one agreed transaction is enough.

| # | Action | Expected screen | Server result to verify |
| --- | --- | --- | --- |
| 1 | Log in to LK1 as the allowlisted account, open `?buyResidency=lifecycle` | 790 ₽, 30 days, 30%/50% benefits, "Стать резидентом" | `GET /catalog` 200, `GET /status` NONE/EXPIRED, `GET /orders?state=unresolved` 0 |
| 2 | Press "Стать резидентом · 790 ₽" | redirect to the bank/ Viva payment page | exactly one `POST /orders` 200 PENDING_PAYMENT, one durable order, one Viva transaction, `expectedTotalMinor=79000` |
| 3 | Pay the agreed amount once | bank result, then return to `?phResidencyLifecycleReturn=1` | `POST .../reconcile` → PAID_ACTIVATION_PENDING/ACTIVE; CUP window starts at paymentDate, +30 days |
| 4 | Refresh the return page and repeat reconcile | same order, no new payment link | same order id, `idempotentReplay`, activation calls ≤ 1 |
| 5 | Open the cabinet status / booking a game and a group training | active residency, 30% game, 50% training/tournament where the contract says | `GET /status` ACTIVE with the same validUntil; discount lines from the booking owner |
| 6 | Before validUntil, try renewal | renewal refused with the eligible date | 409 `RESIDENCY_RENEWAL_TOO_EARLY`, zero Viva POSTs |
| 7 | Stop the pilot (`CREATE_ENABLED=false`), reopen the started order | order still visible, payment/reconcile available | create 503; unresolved/read/payment/reconcile 200 |
| 8 | Switch to `?buyResidency=1` (old page) | old page opens unchanged | old `/lk/tournaments/summer-subscription/status` and Viva browser checkout unchanged |
| 9 | Ordinary account calls `POST /orders` directly | pilot unavailable | 403 `RESIDENCY_CREATE_NOT_ALLOWED` |
| 10 | Double click / two tabs | one order | one `POST` (browser), one order (server active-slot) |

## Mechanics in the new screen and their status

| Mechanic | Status |
| --- | --- |
| Catalog, exact price, 30-day term | LOCAL pass (fixtures) |
| Price consent with `expectedTotalMinor` | LOCAL pass; real Viva not called |
| Create + bank redirect | LOCAL pass (fixture); real bank not called |
| Return/reload/recovery, unknown outcome | LOCAL pass |
| Activation, status, active window | LOCAL pass (fixture); real CUP not called |
| Early-renewal refusal | LOCAL pass |
| Personal allowlist and ordinary-account refusal | LOCAL pass (HTTP + browser fixture) |
| Create stopped while servicing continues | LOCAL pass |
| Old checkout marker guard (new→old direction) | LOCAL pass |
| Old page after a new order (old→new direction) | **not implemented**; next step is a shared provider idempotency decision or a reviewed old-client change |
| 30% games / 50% group training and tournaments | contract copy only; **not verified end-to-end** on a real active residency |
| Resident pass QR | existing separate gateway; not exercised in this pilot |

## Not done / blockers

1. No import, custom-node install, index apply, env change or frontend publication on 147.
2. Alexey's verified Keycloak `sub` is not present; the allowlist is empty and the
   server is closed by default.
3. No real Viva transaction/payment/refund; no real CUP activation; no real discount
   booking. These need the agreed action and amount.
4. The Mongo-backed nine tests passed against a disposable local `mongo:8.0.5`
   (`LK_TEST_MONGO_REQUIRED=1`, 105/105). The real 147 Mongo is not touched.
5. The old published client has no shared attempt registry with the new owner. Do not
   expose both purchase buttons at once until that is decided.
