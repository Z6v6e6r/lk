# Residency LK1 personal pilot: compatibility, entry and acceptance

Status: implementation, LOCAL/CI and the isolated composition are complete. **No Node-RED
import, custom-node install, Mongo index apply, frontend publication, real Viva/CUP call or
real payment has been performed.** Deployment and the real purchase chain are separate
approved operations. Installation packet: `docs/residency-pilot-install.md`.

## Pinned current state (read-only, 2026-11-18)

| Object | Value | Evidence |
| --- | --- | --- |
| Published LK1 bundle | version `20261118T164240Z`, source `27ea6a8c1665789786b8a6c6fc9c657dc48483ed` (`codex/kids-training-release-147-20261118`) | `https://padlhub.su/lk/release.json` |
| Published bundle hash | sha256 `fce60c89044f95ef7ec9faf1d53267dfce87fcc996efa00dbacee87ab50485be`, 2 946 728 bytes | two cache-busted downloads; `docs/evidence/residency-pilot/published-bundle-20261118T164240Z.txt` |
| Previous pinned bundle | `20261118T144752Z` / `8ff3735e…` / `79789bf8…` | historical only; the live artifact moved after the earlier note |
| Old bundle routes | 62 `/lk/` paths, same as the previous publication; contains `/lk/residency/passes`, summer-subscription routes and the residency product; **no** `residency/orders` and no new refusal codes | `scripts/tests/fixtures/lk1-published-bundle-20261118T164240Z.json` |
| Node-RED on 147 | 4.0.9, Node 22.23.2, pm2 `node-red`, 5 678 nodes, 316 `http in`, no lifecycle route/id | last read-only snapshot `scripts/tests/fixtures/lk1-live-http-routes-20261118.json`; a fresh preimage is required at apply time |
| Installed residency flags | `SUBSCRIPTIONS_RESIDENCY_BOOKING_ENABLED=false`, `SUBSCRIPTIONS_RESIDENCY_PREVIEW_ENABLED=true`; no `LK_RESIDENCY_LIFECYCLE_*` | host snapshot |
| New owner source | PR #443 head `2f7c2d48251bc883cab9cf34a51492ba32be045e` + this branch | PR #452 |
| New pilot frontend | this branch, not published | `?buyResidency=lifecycle` |

The old client purchases residency directly from the browser:
`POST https://api.vivacrm.ru/end-user/api/v1/iSkq6G/transactions` with product
`4037a3a3-e551-4f9a-a9db-1410e46b8635`. It does not call the new lifecycle API. This was
verified by executing the downloaded published bundle in Chromium and recording the
network trace (`docs/evidence/residency-pilot/isolated-composition-20261118/README.md`).

## What changed for compatibility and pilot

1. `POST /lk/residency/orders` is gated by a server-side allowlist of verified
   `tenantId:userId` claims. Default: `CREATE_ENABLED=false` → 503
   `RESIDENCY_ORDERS_DISABLED`; `CREATE_AUDIENCE=pilot` with an empty list → 403
   `RESIDENCY_CREATE_NOT_ALLOWED`; a malformed list → 503
   `RESIDENCY_CREATE_POLICY_INVALID`. The `test` URL/localStorage switch is not read.
2. `LK_RESIDENCY_LIFECYCLE_ENABLED` is the service switch; `CREATE_ENABLED` is the
   new-order switch. With `CREATE_ENABLED=false` an existing order remains readable,
   reconcilable and cancellable, and activation of a paid order continues.
3. A separate pilot page `/lk_new?buyResidency=lifecycle` (return
   `?phResidencyLifecycleReturn=1`) reads catalog/status, shows the exact total, sends
   `expectedTotalMinor`, keeps one idempotency key per confirmed operation, recovers an
   unresolved order instead of creating a new one and never treats a bank return as
   payment proof. The old `?buyResidency=1` page, `zeroCheckoutPayment` and the pass
   gateway are untouched.
4. **Cross-path guard.** Before a new order and before any provider POST the gateway lists
   the actor's Viva transactions for the residency product (Admin API, 30-day window) and
   refuses with 409 `RESIDENCY_EXTERNAL_PURCHASE_PENDING` when an open/unknown operation,
   or a paid one without an active residency, exists. A failed, partial or unreadable list
   fails closed (503 `RESIDENCY_EXTERNAL_CHECK_UNAVAILABLE`). Transactions owned by this
   service's own orders are excluded. Two tabs/devices remain serialized by the Mongo
   active-slot partial unique index.
5. **Reverse detection.** A purchase started by the old client after a new order cannot be
   intercepted (it never reaches this server). The unresolved read exposes
   `externalCheck`; a paid external operation created after the order moves it to
   `PAID_REQUIRES_REVIEW` with `EXTERNAL_PAYMENT_DETECTED` instead of activating.
6. An opt-in `LK_RESIDENCY_LIFECYCLE_IDENTITY_LOG=true` writes the verified
   `tenantId`/`userId` to the Node-RED log for one-time enrollment; it is off by default.

## Guarantee and boundary

| Direction | Server guarantee | Evidence |
| --- | --- | --- |
| new → new (tabs, devices, retries) | one order and one provider POST (unique active slot + unresolved check) | composition C: 200+409, 1 order, 1 transaction |
| old → new | a pre-existing open/paid outside operation blocks the new order before its provider POST; unreadable list fails closed | composition A; backend transcript steps 2–3 |
| new → old | **not preventable**; detected and held for review, never auto-activated | composition B; step 7 |

This is not a claim of a shared transaction or of intercepting the old client. The old
client's financial POST is browser→Viva and has no server hop. Remaining gaps:

- The old→new check is a read before the POST, not an atomic provider constraint. A
  transaction created in that narrow window is not prevented, but the post-create re-read
  withholds the new payable link and keeps the order in `UNKNOWN_OUTCOME`; the old
  transaction still exists and must be reviewed, never paid twice.
- The reverse direction can still create and charge a second Viva transaction. For the
  pilot the owner must choose one of:
  a. one-account pilot with the operator present, the old page not linked and the
     detection/review path accepted;
  b. hide/disable the old Viva product for the pilot window and give the new flow a
     separate pilot product id (Viva + CUP configuration and a contract change);
  c. publish a reviewed old-client change that removes or disables the residency CTA.
  None of these is authorized or performed here.

## Test entry and flags

- Purchase: `https://padlhub.su/lk_new?buyResidency=lifecycle` (allowlisted account).
- Bank return: `https://padlhub.su/lk_new?phResidencyLifecycleReturn=1` via the
  server-configured target key `lk1pilot`.
- Old fallback: `https://padlhub.su/lk_new?buyResidency=1` (unchanged production page).
- No automatic switch: the new page is not linked from the cabinet. The URL selects the UI;
  the server allowlist grants the right.

Required environment (names only; full table in the install packet). The base
`SUCCESS_URL`/`FAIL_URL` must not contain a query string:

```text
LK_RESIDENCY_LIFECYCLE_ENABLED=true
LK_RESIDENCY_LIFECYCLE_CREATE_ENABLED=true
LK_RESIDENCY_LIFECYCLE_CREATE_AUDIENCE=pilot
LK_RESIDENCY_LIFECYCLE_PILOT_USERS=["iSkq6G:<verified-sub>"]
LK_RESIDENCY_LIFECYCLE_MONGO_URI / _MONGO_DB
LK_RESIDENCY_LIFECYCLE_CUP_API_URL / _CUP_INTEGRATION_TOKEN
LK_RESIDENCY_LIFECYCLE_RETURN_TARGETS={"lk1pilot":{"successUrl":"…phResidencyLifecycleReturn=1","failUrl":"…"}}
LK_RESIDENCY_LIFECYCLE_EXTERNAL_GUARD=true
LK_RESIDENCY_LIFECYCLE_EXTERNAL_LOOKBACK_MS=2592000000
LK_RESIDENCY_LIFECYCLE_IDENTITY_LOG=false
```

`<verified-sub>` is the Keycloak `sub` from an authenticated userinfo source. It is not
guessed and is not in this repository; the pilot stays closed until it is supplied. The
no-UUID enrollment procedure is section 10 of the install packet.

## Install order (summary)

The exact order, readback and rollback are in `docs/residency-pilot-install.md`. In short:
fresh preimage → additive candidate → custom node + `mongodb@7.2.0` → five indexes
(`ENSURE_INDEXES=false`) → import 19 nodes → `ENABLED=true, CREATE_ENABLED=false` →
readback → identity enrollment → `CREATE_ENABLED=true` → separate frontend publication.
The isolated composition exercised steps 1–9 against a disposable Mongo and a fixture
provider; the live 147 was not touched.

## Stop and rollback

- Stop new purchases: `CREATE_ENABLED=false`. Existing orders keep reading, reconcile,
  cancel and activation.
- Stop the whole new API: `ENABLED=false`. Orders are not deleted; Viva transactions are
  not cancelled.
- Frontend rollback: publish the previous complete bundle / keep using
  `?buyResidency=1`. This does not roll back Node-RED, Mongo or Viva; keep servicing with
  `ENABLED=true` until started orders are terminal.
- Remove the import only with the reviewed Node-RED pack process; never delete the
  collection or indexes while orders are unresolved.

## Automated checks (LOCAL, this workspace)

| Check | Command | Result |
| --- | --- | --- |
| Lifecycle module suite (real Mongo) | `LK_TEST_MONGO_URI=… LK_TEST_MONGO_REQUIRED=1 npm run test:residency-lifecycle` | 126 pass, 0 fail, 0 skipped (disposable `mongo:8.0.5`) |
| Frontend client/route/attempt/decision | `npm run test:residency-pilot` | 11 pass |
| Route/id isolation + old bundle surface | `npm run test:residency-lk1-compat` | 7 pass (current published artifact and additive-install guards) |
| TypeScript | `npx tsc -b` | pass |
| Lint (changed files) | `npx eslint src/residency/*` | pass |
| Main bundle | `npx vite build` | pass (2.98 MB, 351 modules) |
| Isolated composition | `node scripts/pilot-composition/e2e.mjs` + `backend-transcript.sh` | 5/5 browser scenarios pass; deterministic old/new race withheld the second link; Node-RED 4.0.9-22 / Node 22.14.0 |
| Backend HTTP transcript | `scripts/pilot-composition/backend-transcript.sh` | all steps as expected |

## Manual acceptance scenario (for Alexey)

Each row: user action → expected screen → server-verifiable result. Do not repeat a real
charge; one agreed transaction is enough.

| # | Action | Expected screen | Server result to verify |
| --- | --- | --- | --- |
| 1 | Log in as the allowlisted account, open `?buyResidency=lifecycle` | 790 ₽, 30 days, 30%/50% benefits, "Стать резидентом" | `GET /catalog` 200 (exact current price), `GET /status` NONE/EXPIRED, `GET /orders?state=unresolved` 0, `externalCheck.requiresReview=false` |
| 2 | Press "Стать резидентом · <price>" | redirect to the bank/Viva payment page | exactly one `POST /orders` 200 PENDING_PAYMENT, one durable order, one Viva transaction, `expectedTotalMinor` equals the shown total |
| 3 | Pay the agreed amount once | bank result, then return to `?phResidencyLifecycleReturn=1` | `POST .../reconcile` → PAID_ACTIVATION_PENDING/ACTIVE; CUP window starts at paymentDate, +30 days |
| 4 | Refresh the return page and repeat reconcile | same order, no new payment link | same order id, `idempotentReplay`, activation calls ≤ 1 |
| 5 | Open the cabinet status / book a game and a group training | active residency, 30% game, 50% training/tournament where the contract says | `GET /status` ACTIVE with the same validUntil; discount lines from the booking owner |
| 6 | Before validUntil, try renewal | renewal refused with the eligible date | 409 `RESIDENCY_RENEWAL_TOO_EARLY`, zero Viva POSTs |
| 7 | Stop the pilot (`CREATE_ENABLED=false`), reopen the started order | order still visible, payment/reconcile available | create 503; unresolved/read/payment/reconcile 200 |
| 8 | Switch to `?buyResidency=1` (old page) before any new order | old page opens unchanged | old status/pass routes unchanged; no lifecycle POST from the old page |
| 9 | Ordinary account calls `POST /orders` directly | pilot unavailable | 403 `RESIDENCY_CREATE_NOT_ALLOWED`, zero orders |
| 10 | Double click / two tabs / two devices | one order | one `POST` 200, one 409, one durable order |
| 11 | (Negative, not a real payment) old checkout open, then new screen | server-detected external purchase, no CTA | 409 `RESIDENCY_EXTERNAL_PURCHASE_PENDING` on direct create, `externalCheck.openCount ≥ 1`, `requiresReview=true`, zero new transactions |
| 12 | (Negative) old checkout and new purchase launched simultaneously | the new screen never shows a second payable link | the new order stays `PENDING_PAYMENT` / payment `UNKNOWN` / `UNKNOWN_OUTCOME`; the old Viva transaction may exist and is reviewed; no activation |

### One test purchase request (needs owner approval)

- **Account:** the allowlisted pilot account (Alexey) after enrollment.
- **Product:** `4037a3a3-e551-4f9a-a9db-1410e46b8635`, 30 days, 30% games / 50% group
  training and tournaments.
- **Amount:** the exact total read by `GET /lk/residency/catalog` immediately before the
  purchase (currently documented as 790 ₽ / 79 000 minor). If the catalog differs from the
  amount the operator approved, the purchase is not started; `expectedTotalMinor` is an
  exact consent, not a ceiling.
- **Expected result:** one `POST /orders` 200, one Viva transaction, payment once,
  reconcile → ACTIVE, one 30-day CUP window from the payment date.
- **Unknown outcome (timeout, bank page closed, lost response):** do not pay again and do
  not create a new order; reopen the return page / the order, use reconcile, and if still
  unknown treat it as `UNKNOWN_OUTCOME` and contact support. The order keeps its slot.
- **Not authorized by this packet:** additional purchases, debits, cancellations or refunds.

### Discount verification without a charge

The residency discount is checked through the existing advisory price preview, not by
booking or paying:

1. Authenticate as the same pilot account.
2. Call `POST /lk/subscriptions/game-price-preview` with the existing `{target,
   subscriptionIds}` payload (the game card uses the same call; it never creates or
   reserves a game and never charges).
3. Record `quotes[]`: the discount lines and amounts for one game and for one group
   training/tournament target.
4. Expected contract: 30% for game creation/participation and 50% for game+coach, group
   trainings, the friendship league and PadlHub tournaments. If the owner returns a
   different line or amount, stop and do not book.
5. Do not confirm a booking or a payment in this step. The discount on an actually
   confirmed booking remains a separate approved action after the first purchase.

## Mechanics in the new screen and their status

| Mechanic | Status |
| --- | --- |
| Catalog, exact price, 30-day term | LOCAL + isolated pass |
| Price consent with `expectedTotalMinor` | LOCAL + isolated pass; real Viva not called |
| Create + bank redirect | LOCAL + isolated pass (fixture); real bank not called |
| Return/reload/recovery, unknown outcome | LOCAL + isolated pass |
| Activation, status, active window | LOCAL + isolated pass (fixture); real CUP not called |
| Early-renewal refusal | LOCAL pass |
| Personal allowlist and ordinary-account refusal | LOCAL + isolated pass |
| Create stopped while servicing continues | LOCAL + isolated pass, including restart |
| Old checkout first → new create refused | LOCAL + isolated pass |
| New order first → old checkout paid → review | LOCAL + isolated pass (detection only) |
| Old and new launched simultaneously | LOCAL + isolated pass: the post-create re-read withholds the second payment link and keeps the original order; no auto-activation |
| 30% games / 50% group training and tournaments | contract copy only; not verified end-to-end on a real active residency |
| Resident pass QR | existing separate gateway; not exercised in this pilot |

## Not done / blockers

1. No import, custom-node install, index apply, env change or frontend publication on 147.
2. Alexey's verified Keycloak `sub` is not present; the allowlist is empty and the server
   is closed by default. Enrollment procedure: install packet section 10.
3. No real Viva transaction/payment/refund; no real CUP activation; no real discount
   booking. These need the agreed action and amount above.
4. A fresh live preimage and server access are required at apply time; SSH to 147 times out
   from this workspace.
5. The reverse direction (old page after a new order) is detected, not prevented; the owner
   must choose the pilot variant (Guarantee and boundary).
6. Real-Mongo tests ran on a disposable `mongo:8.0.5`; the 147 Mongo was not touched.
