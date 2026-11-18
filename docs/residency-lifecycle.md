# Residency lifecycle (LK1 owner)

Status: source implementation, default off. No Node-RED import, index apply, provider
call, publication or deploy is performed by this change.

Contract version: `residency-lifecycle.v2` (additive over v1; `schemaVersion` stays 1).

## Ownership (verified 2026-11-18)

| Boundary | Owner | Evidence |
| --- | --- | --- |
| Residency product, transaction, payment status, subscription instance | **Viva** | Product 4037a3a3-e551-4f9a-a9db-1410e46b8635; existing LK1 checkout posts /end-user/api/v1/{tenant}/transactions and reads the Admin transaction. |
| Checkout, payment orchestration, renewal, order state | **LK1 subscription/payment owner** | docs/residency-purchase.md, docs/RESIDENCY_BOOKING.md, src/components/subscription-storefront/zeroCheckoutPayment.ts. |
| Residency policy, publication, provider evidence, activation window, discounts | **CUP (ЦУП)** | docs/subscriptions/residency-booking.md (ph-admin), POST /api/internal/subscriptions/residency-booking-refresh, residency-booking-context. |
| Read-only status for the new cabinet | **LK2** | LK2 PR #581 (GET /user/api/v1/{tenantKey}/residency) and #627 (verified-phone Viva mapping). |

Related merged work: CUP #101 (financial window starts from confirmed issuance), #102
(provider date shapes), #108 (authoritative tournament discount); LK1 #315 (residency
discounts), #321 (live refresh), #327 (direct checkout), #294/#306 (resident pass).

## Tariffs and rules (do not invent)

From the verified Viva product and the published CUP policy:

- price **79 000 minor units (790 ₽)**, term **30 days**, **30 visits**, activationDays=0,
  category 2572 (Резидентство), GROUP/BY_VISITS/BOOKING, all stations, no
  direction/type/day/time restrictions;
- benefits: **30% off games**, **50% off group training and tournaments**, all stations,
  for the paid 30-day window; no free visits or free game minutes;
- the CUP window starts at the confirmed financial issuance (paymentDate of the PAID
  transaction) and ends exactly 30 days later. CUP never reads a previous instance and
  never carries remaining days: `residency-provider-observation.ts` computes
  `activeFrom = paymentDate`, `activeTo = paymentDate + 30d`
  (`windowOrigin: PAYMENT_DATE`). This is the authoritative renewal rule for this
  contract, so an **early renewal is refused before the transaction** (see below);
- automatic renewal is not part of the product. A renewal is a new purchase. It becomes
  eligible only once the current `validUntil` has passed, i.e. when no paid days would be
  lost. A renewal that would return a window overlapping the old one, or a window whose
  length is not the product term, is an **anomaly after payment** and goes to club review
  (`RENEWAL_WINDOW_OVERLAP` / `ACTIVATION_WINDOW_TERM_MISMATCH`), not the normal path;
- no residency **price** discount is published. The lifecycle therefore returns an
  empty discountLines array and totalMinor = baseAmountMinor unless CUP publishes lines.
  The benefits above are consumed by the existing booking owner, not duplicated here.

Any future discount line must come from CUP. The domain engine accepts only
{ code, title, amountMinor, source } lines totalling at most the base amount and
fails closed on an invalid or unavailable quote.

## API contract for LK2 (and the LK1 client)

Base path: https://padlhub.su/lk/residency (SERV2 origin, same as the existing
/lk/residency/passes gateway). This is not a second pricing or payment engine: it
reuses the existing Viva transaction, the Admin transaction read and CUP's
residency-booking-refresh/context. LK2 must call this contract through PadlHub, never
Viva directly, and must not recompute the price.

Authentication: LK bearer (Authorization: Bearer <Viva Keycloak user token>), verified
through Keycloak userinfo; expected azp/client_id=widget and tenant iSkq6G. Mutating
routes require Idempotency-Key: 16..128 non-whitespace characters.
X-Correlation-ID is optional and echoed. All responses are Cache-Control: no-store,
Referrer-Policy: no-referrer, X-Robots-Tag: noindex, nofollow.

`X-Residency-Return-Target` (optional, default `widget`) selects a **configured** return
URL for the payment page. It is a configuration key, never a URL; an unknown key is 400
`RESIDENCY_RETURN_TARGET_INVALID` before any durable order or provider POST.

### Catalog

GET /catalog

~~~
{
  "schemaVersion": 1,
  "product": {
    "productId": "4037a3a3-e551-4f9a-a9db-1410e46b8635",
    "title": "Резидентство ПадлхАБ",
    "termDays": 30,
    "priceMinor": 79000,
    "currency": "RUB",
    "benefits": []
  },
  "renewalEligible": false,
  "renewal": {
    "eligible": false,
    "reason": "REMAINING_DAYS_NOT_TRANSFERABLE",
    "eligibleAt": "2026-11-23T09:05:00.000Z",
    "currentValidUntil": "2026-11-23T09:05:00.000Z",
    "expected": {
      "termDays": 30,
      "startsAt": "PAYMENT_DATE",
      "earliestValidUntil": "2026-12-23T09:05:00.000Z"
    }
  },
  "checkedAt": "2026-11-18T09:00:00.000Z"
}
~~~

`renewal` is evaluated for the authenticated user before payment:
`eligible=false, reason=NOT_ACTIVE` when no residency is active (buy with mode NEW),
`eligible=false, reason=REMAINING_DAYS_NOT_TRANSFERABLE` while the current window still
has days, `eligible=false, reason=STATUS_UNAVAILABLE` when the source cannot be trusted,
and `eligible=true` at/after `validUntil`. `expected` describes the window the buyer
will get; the owner never promises remaining days on top of it.

The price is read from the exact public Viva product and validated against every term
above. A changed product, term, category, scope or activation mode returns 503
RESIDENCY_PRODUCT_TERMS_MISMATCH; the catalog is never cached into a local tariff.

### Current status

GET /status

~~~
{
  "schemaVersion": 1,
  "state": "ACTIVE | EXPIRED | NONE | UNAVAILABLE",
  "validFrom": "2026-11-18T09:05:00.000Z",
  "validUntil": "2026-12-18T09:05:00.000Z",
  "source": "CUP_RESIDENCY_POLICY",
  "observedAt": "2026-11-18T09:06:00.000Z",
  "reason": null
}
~~~

NONE is returned only after a complete owned Viva subscription read with no exact
product instance. A provider/CUP failure is UNAVAILABLE with a stable reason, never
NONE. Dates are copied from CUP evidence; the lifecycle never computes a window from
the local clock.

### Create or renew

POST /orders with Idempotency-Key and body
`{ "mode": "NEW" | "RENEWAL", "expectedTotalMinor": 79000, "expectedProductId": "<uuid>" }`.

- `expectedTotalMinor` is **required**: the client confirms the price it showed to the
  user. A missing value is 400 `RESIDENCY_PRICE_CONSENT_REQUIRED`; a confirmed amount
  below the server-computed total (or a different `expectedProductId`) is 409
  `RESIDENCY_PRICE_CHANGED` with `details`, before any durable order and before any
  provider POST. The consent is bound into the idempotency request hash, so the same key
  with a different confirmed price is 409 `RESIDENCY_IDEMPOTENCY_CONFLICT`.
- NEW is refused with 409 RESIDENCY_RENEWAL_REQUIRED while an active residency
  exists; use RENEWAL. RENEWAL requires an active residency
  (409 RESIDENCY_RENEWAL_NOT_ELIGIBLE).
- RENEWAL before the current `validUntil` is refused with 409
  `RESIDENCY_RENEWAL_TOO_EARLY` and `details: { reason, eligibleAt, currentValidUntil,
  expected }` **before** the durable order and the provider POST (zero provider calls).
- A second unresolved order for the same user is refused with
  409 RESIDENCY_ORDER_ALREADY_PENDING before any provider POST.
- The same key returns the same order (idempotentReplay: true); the same key with a
  different mode or confirmed price is 409 RESIDENCY_IDEMPOTENCY_CONFLICT.

Response: `{ "schemaVersion": 1, "order": { ... }, "idempotentReplay": false,
"recoveryRequired": false, "recovery": { ... } }`.

The order object:

~~~
{
  "schemaVersion": 1,
  "orderId": "00000000-0000-4000-8000-000000000001",
  "mode": "NEW",
  "state": "PENDING_PAYMENT",
  "terminal": false,
  "terminalReason": null,
  "product": { "productId": "...", "title": "...", "termDays": 30, "currency": "RUB" },
  "pricing": { "baseAmountMinor": 79000, "discountLines": [], "totalMinor": 79000, "currency": "RUB" },
  "consent": { "expectedTotalMinor": 79000, "productId": "...", "acceptedAt": "..." },
  "renewal": null,
  "payment": {
    "status": "PENDING",
    "paymentUrl": "https://...",
    "expiresAt": "2026-11-18T09:20:00.000Z",
    "overdue": false,
    "instruction": "Оплатите по ссылке. Статус обновится после подтверждения банком."
  },
  "recovery": {
    "state": "AWAITING_PAYMENT",
    "required": false,
    "reason": null,
    "action": "PAY",
    "retryable": true,
    "since": "2026-11-18T09:00:00.000Z"
  },
  "activation": { "state": "NOT_STARTED", "attempts": 0, "lastErrorCode": null },
  "residency": null,
  "createdAt": "...",
  "updatedAt": "...",
  "revision": 1
}
~~~

States: PENDING_PAYMENT, PAYMENT_FAILED, EXPIRED, CANCELLED, PAID,
PAID_ACTIVATION_PENDING, ACTIVE, ACTIVATION_FAILED, PAID_REQUIRES_REVIEW.
PAID is a receipt, never current entitlement. Only ACTIVE carries a residency window.
The order is durable before the Viva POST.

`payment.status` is one of NONE, PENDING, PAID, FAILED, UNKNOWN. The internal
`DISPATCHING` value is never exposed (it is normalized to UNKNOWN in **both** the order
and the payment endpoint).

### Recovery states (public, persisted through reads)

`recovery` is a projection of durable order fields, so it survives a restart, a lost
mutation response and a different device:

| state | when | action | required |
| --- | --- | --- | --- |
| NONE | ACTIVE | NONE | false |
| TERMINAL | CANCELLED / PAYMENT_FAILED / EXPIRED | START_NEW_ORDER | false |
| REVIEW_REQUIRED | PAID_REQUIRES_REVIEW / ACTIVATION_FAILED | CONTACT_SUPPORT | true |
| ACTIVATION_PENDING | PAID / PAID_ACTIVATION_PENDING | RETRY_RECONCILE | true |
| UNKNOWN_OUTCOME | PENDING_PAYMENT with payment UNKNOWN/DISPATCHING | RETRY_RECONCILE | true |
| AWAITING_CONFIRMATION | PENDING_PAYMENT with payment PENDING past `expiresAt` | RETRY_RECONCILE | true |
| AWAITING_PAYMENT | PENDING_PAYMENT with payment PENDING within the window | PAY | false |

### Unknown outcome and double-charge guards

- The durable attempt exists before the Viva POST, so a crash or lost response leaves a
  DISPATCHING/UNKNOWN local attempt, never a second POST.
- An unknown create outcome (transport error, timeout, 5xx, unverifiable 2xx) **keeps
  the order unresolved and keeps the active slot**. No delivered link does not prove
  that no financial operation exists.
- When the provider accepted the request but the result could not be verified
  (`paid:true` followed by a failed Admin read, a contradictory amount, a missing link),
  the provider adapter returns `UNCONFIRMED` together with the transaction id it
  observed. The owner persists that id before any further check, so a later Admin read
  recovers the late result. The id is internal and never appears in a DTO.
- Only an explicit provider 4xx refusal of the request itself (400/401/403/404/405/415/
  422) is a confirmed basis for a terminal `PAYMENT_FAILED`. A 409/429/5xx never is.
- The dispatch lease (2 minutes) is an **operator/client hint**, not a permission to buy
  again. Its expiry changes nothing: the slot stays held, the order stays unresolved and
  recovery continues through reconcile/CUP evidence.
- The same key always returns the same order. A new key cannot bypass the guard: the
  unique partial active-slot index plus the pre-POST unresolved check refuse it.

### Expiry of the local payment window

The local pending window (`LK_RESIDENCY_LIFECYCLE_PAYMENT_TTL_MS`, default 20 minutes)
is **not** the provider's payment lifetime. When it elapses:

- a provider read that returns PAID recovers the order and activates it;
- a provider read that returns FAILED (a terminal provider status) is a confirmed basis
  for `PAYMENT_FAILED` and releases the slot;
- PENDING, UNKNOWN, a missing read or an unavailable read never expiring the order,
  never releasing the slot and never hiding a still-payable link; the order stays
  PENDING_PAYMENT with `payment.overdue=true` and recovery
  `AWAITING_CONFIRMATION`.
- A late PAID is accepted from every non-terminal state; a legacy EXPIRED row is still
  recovered. A CANCELLED order is never revived.

### Payment link or instruction

GET /orders/{orderId}/payment

~~~
{
  "schemaVersion": 1,
  "orderId": "...",
  "state": "PENDING_PAYMENT",
  "paymentStatus": "PENDING",
  "paymentUrl": "https://...",
  "expiresAt": "2026-11-18T09:20:00.000Z",
  "overdue": false,
  "instruction": "Оплатите по ссылке. Статус обновится после подтверждения банком.",
  "recovery": { ... },
  "terminal": false,
  "terminalReason": null
}
~~~

The endpoint reads the provider back before answering when the link is missing or the
local window passed; it never POSTs. `paymentStatus` uses the same normalized
vocabulary as the order DTO. A cancelled, paid or failed order never returns a stale
payment link. `state` is the order state.

### Reconcile / payment callback

POST /orders/{orderId}/reconcile with Idempotency-Key and optional
`{ "eventId": "<stable provider event id>" }`; response envelope:
`{ schemaVersion, order, idempotentReplay, reviewRequired, retryable, recovery }`.

The owner reads the original Viva transaction (Admin, service credential) and accepts
PAID only when all of the following hold: exact transaction id, same client, exactly
one exact-product SUBSCRIPTION line with count=1, toPay equals the confirmed
order total, paymentDate present, no refund. It then asks CUP to verify the owned
subscription instance (residency-booking-refresh). Activation is written only from
CUP's context.instance.activeFrom/activeTo.

- Duplicate callback with the same eventId returns the stored order with
  idempotentReplay: true; activation is called at most once.
- A PENDING/UNKNOWN read keeps the order pending and returns retryable: true.
- FAILED/CANCELLED/REFUND is terminal PAYMENT_FAILED.
- Amount/transaction mismatch is PAID_REQUIRES_REVIEW (no activation).
- A late PAID read can recover a locally EXPIRED or PAID_ACTIVATION_PENDING
  order. A CANCELLED order is never revived; a paid read sets
  reviewRequired: true for refund/support.
- Without a provider transaction id, the owner may recover through CUP's verified
  owned instance only when the instance was purchased after the order was created.

### My unresolved order (another device)

GET /orders?state=unresolved returns the authenticated user's unresolved orders:

~~~
{ "schemaVersion": 1, "orders": [ { ...order... } ], "count": 1 }
~~~

Only `state=unresolved` (and an optional `limit=20`) is accepted; anything else is 400.
This is the server-authorized way to find an own unfinished order after losing local
storage or changing device. It is tenant- and user-scoped and never lists another
user's order.

### Cancel

POST /orders/{orderId}/cancel with Idempotency-Key. Cancellable only while not paid and
not active. A safe cancellation requires a confirmed basis: the owner reads the original
transaction first. PAID refuses the cancel (`RESIDENCY_ORDER_PAID`); an unreadable or
still-PENDING/UNKNOWN status fails closed (503 `RESIDENCY_PAYMENT_STATUS_UNAVAILABLE` or
409 `RESIDENCY_PAYMENT_STATUS_UNKNOWN`). A provider read that proves FAILED is a
confirmed basis for cancelling. A DISPATCHING/UNKNOWN attempt without a provider id is
not cancellable by this command (support path). A paid order waiting for activation must
not be cancelled into an automatic refund (409 `RESIDENCY_ORDER_PAID`).

### Error envelope

~~~
{ "code": "RESIDENCY_ORDER_NOT_FOUND", "message": "Order not found", "details": { ... } }
~~~

`details` is present only for structured refusals (`RESIDENCY_PRICE_CHANGED`,
`RESIDENCY_RENEWAL_TOO_EARLY`). Stable codes include RESIDENCY_AUTH_REQUIRED,
RESIDENCY_REQUEST_INVALID, RESIDENCY_REQUEST_TOO_LARGE, RESIDENCY_CONTENT_TYPE_INVALID,
RESIDENCY_IDEMPOTENCY_KEY_REQUIRED, RESIDENCY_IDEMPOTENCY_CONFLICT,
RESIDENCY_PRICE_CONSENT_REQUIRED, RESIDENCY_PRICE_CHANGED,
RESIDENCY_RENEWAL_TOO_EARLY, RESIDENCY_RETURN_TARGET_INVALID,
RESIDENCY_ORDER_ALREADY_PENDING, RESIDENCY_RENEWAL_NOT_ELIGIBLE,
RESIDENCY_RENEWAL_REQUIRED, RESIDENCY_STATUS_UNAVAILABLE,
RESIDENCY_CATALOG_UNAVAILABLE, RESIDENCY_PRICING_UNAVAILABLE,
RESIDENCY_PRICING_INVALID, RESIDENCY_ORDER_NOT_FOUND, RESIDENCY_ORDER_CONFLICT,
RESIDENCY_ORDER_ACTIVE, RESIDENCY_ORDER_PAID, RESIDENCY_ORDER_NOT_CANCELLABLE,
RESIDENCY_UPSTREAM_TIMEOUT, RESIDENCY_UPSTREAM_UNAVAILABLE,
RESIDENCY_UPSTREAM_INVALID, RESIDENCY_PAYMENT_INVALID,
RESIDENCY_PAYMENT_AMOUNT_MISMATCH, RESIDENCY_PAYMENT_OWNERSHIP_MISMATCH,
RESIDENCY_PRODUCT_TERMS_MISMATCH, RESIDENCY_SUBSCRIPTION_OWNERSHIP_CONFLICT,
RESIDENCY_EVIDENCE_INVALID, RESIDENCY_PAYMENT_STATUS_UNAVAILABLE,
RESIDENCY_PAYMENT_STATUS_UNKNOWN, RESIDENCY_SUBSCRIPTIONS_PARTIAL,
RESIDENCY_RATE_LIMITED, RESIDENCY_INTERNAL. Activation error codes include
INSTANCE_NOT_FOUND, INSTANCE_BEFORE_ORDER, INSTANCE_LOOKUP_UNAVAILABLE,
ACTIVATION_UNAVAILABLE, RENEWAL_WINDOW_OVERLAP, ACTIVATION_WINDOW_TERM_MISMATCH,
DISPATCH_LEASE_EXPIRED, DISPATCH_OUTCOME_UNKNOWN and TRANSACTION_ID_MISSING.
No code, message or log carries a token, phone, provider id, PII or raw provider body.

## Idempotency and double-charge guards

1. A deterministic order UUID is derived from (tenant, user, Idempotency-Key); the
   request hash binds the mode, the product and the confirmed price. The unique index
   residency_order_idempotency makes the insertion one-winner.
2. A second unresolved order for the user is refused **before** the Viva POST.
3. Viva is called exactly once for a create. A transport/lost response leaves the order
   UNKNOWN and keeps the slot.
4. Every state change is a Mongo revision CAS. A losing callback re-reads the durable
   row and returns it.
5. Activation is a single-flight claim after PAID; only the CAS winner calls CUP, and
   the claim is reclaimable only after two minutes. A repeated or concurrent callback
   cannot activate twice.
6. Cancellation is terminal for that order and needs a confirmed basis; a replacement
   order is a new key, not a re-dispatch of the old one.

## LK2 server consumer boundary

The LK2 API is the only caller of this contract for the new cabinet. It must not create
a second payment owner or a local entitlement model.

- Identity: tenant from the verified route, user and session from the PadlHub JWT; the
  request body never selects a user, tenant, provider id or product.
- Credential: LK2 obtains a **server-held, session-bound Viva Keycloak access token**
  through the existing `authService.issueVivaAccessToken(actor)` path (the same
  mechanism as the monthly-purchase owner call) and sends it as
  `Authorization: Bearer <token>`. The PadlHub JWT is never forwarded to LK1. A missing
  or expired Viva delegation is a stable `RESIDENCY_REAUTH_REQUIRED`, never a silent
  fallback.
- Operation scope: the LK2 route exposes only the six residency operations below; the
  token is never returned in a DTO or a log.
- Idempotency-Key is forwarded unchanged; the owner derives the same order identity.
- Return URL: the consumer sends `X-Residency-Return-Target: lk2`; LK1 maps that key to
  its configured LK2 URL. LK2 never accepts a redirect target from the browser.
- Product identity: the consumer compares `product.productId` in every owner DTO with
  LK2's configured `VIVA_RESIDENCY_PRODUCT_ID` and fails closed on a mismatch, so the
  independent LK2 status read and the owner cannot describe different products.
- Errors: the owner's stable `RESIDENCY_*` code and HTTP status are passed through
  together with `correlationId`; timeouts/unavailability become retryable
  `RESIDENCY_OWNER_UNAVAILABLE` with the same Idempotency-Key preserved.

| LK2 path (`/user/api/v1/{tenantKey}`) | Owner path | Idempotency-Key |
| --- | --- | --- |
| GET /residency/catalog | GET /lk/residency/catalog | — |
| POST /residency/orders | POST /lk/residency/orders | required |
| GET /residency/orders/{orderId} | GET /lk/residency/orders/{orderId} | — |
| GET /residency/orders/{orderId}/payment | GET /lk/residency/orders/{orderId}/payment | — |
| POST /residency/orders/{orderId}/reconcile | POST /lk/residency/orders/{orderId}/reconcile | required |
| POST /residency/orders/{orderId}/cancel | POST /lk/residency/orders/{orderId}/cancel | required |
| GET /residency/orders?state=unresolved | GET /lk/residency/orders?state=unresolved | — |

## Configuration

| Variable | Meaning |
| --- | --- |
| LK_RESIDENCY_LIFECYCLE_ENABLED | Must be exactly true; default off. |
| LK_RESIDENCY_LIFECYCLE_MONGO_URI, ..._MONGO_DB | Order storage. |
| LK_RESIDENCY_LIFECYCLE_VIVA_API_URL | Default https://api.vivacrm.ru. |
| LK_RESIDENCY_LIFECYCLE_CUP_API_URL, ..._CUP_INTEGRATION_TOKEN | CUP residency evidence. |
| LK_RESIDENCY_LIFECYCLE_KEYCLOAK_USERINFO_URL | Default clients realm userinfo. |
| LK_RESIDENCY_LIFECYCLE_EXPECTED_CLIENT_ID, ..._TENANT_KEY | widget, iSkq6G. |
| LK_RESIDENCY_LIFECYCLE_PRODUCT_ID | Default canonical product; a different id must be reviewed. |
| LK_RESIDENCY_LIFECYCLE_RETURN_TARGETS | JSON map of return-target key to {successUrl,failUrl}; https only. Absent means only `widget` from SUCCESS_URL/FAIL_URL. |
| LK_RESIDENCY_LIFECYCLE_DEFAULT_RETURN_TARGET | Default `widget`. |
| LK_RESIDENCY_LIFECYCLE_SUCCESS_URL, ..._FAIL_URL | Fixed return URLs for the default target. |
| LK_RESIDENCY_LIFECYCLE_ALLOW_ORIGIN | CORS origin; default * for the Tilda widget. |
| LK_RESIDENCY_LIFECYCLE_PAYMENT_TTL_MS | Local pending-payment window (default 20 min, the existing checkout window). Not a provider expiry. |
| LK_RESIDENCY_LIFECYCLE_DISPATCH_LEASE_MS | Dispatch lease hint, default 120000. Never releases the slot. |
| LK_RESIDENCY_LIFECYCLE_TIMEOUT_MS | Upstream timeout, 500..15000 ms. |
| LK_RESIDENCY_LIFECYCLE_RATE_LIMIT_PER_MINUTE | Per-user mutation/read limit, 1..120. |
| LK_RESIDENCY_LIFECYCLE_ENSURE_INDEXES | true only for a reviewed first install; default false verifies the indexes and fails closed. |

The Viva Admin token is read from the existing Node-RED global
vivacrm_access_token; the actor's Viva token is the request Bearer. Neither is
stored in the order, flow or logs.

## Storage

Collection lk_residency_lifecycle_orders:

- unique residency_order_identity on (tenantId, orderId);
- unique residency_order_idempotency on (tenantId, idempotencyKeyHash);
- unique partial residency_order_active_slot on (tenantId, userId, activeSlot)
  where activeSlot=1 — the atomic one-unresolved-order-per-user guard;
- residency_order_user_state on (tenantId, userId, state);
- residency_order_expiry on (tenantId, state, payment.expiresAt).

The runtime verifies the **keys, uniqueness and partial predicate** of each installed
index and fails closed on a missing or mismatched index (an index name alone proves
nothing). Writes use an acknowledged, journaled `majority` write concern, and the order
insert is only successful when the server acknowledged it. The adapter also exposes
RESIDENCY_LIFECYCLE_INDEXES; applying them is an operational step, not a startup
migration.

A disposable real-Mongo test (`scripts/tests/residencyLifecycleMongo.test.mjs`, run with
`LK_TEST_MONGO_URI`) verifies the partial index, the one-winner concurrency, the
acknowledged insert, the revision CAS and the restart recovery. The in-memory suite
cannot.

## Rollout and E2E

1. Review and install node-red/custom-nodes/residency-lifecycle-api on the LK1
   Node-RED host. It is a separate package; installing it is an approved live action.
2. Create the five indexes with the reviewed Mongo operator path; do not enable
   ENSURE_INDEXES in normal runtime.
3. Set the env values (CUP token protected; Viva Admin token already present; return
   targets for `widget` and `lk2`). Keep LK_RESIDENCY_LIFECYCLE_ENABLED=false until the
   contract check passes.
4. Import node-red/imports/lk_residency_lifecycle.import.json; verify the 8 routes,
   CORS and the store binding.
5. Contract check with a synthetic client on the test stand:
   - GET /catalog returns 79 000, the exact terms and a per-user renewal block;
   - POST /orders without `expectedTotalMinor` is 400 and creates nothing;
   - POST /orders twice with one key returns one order and one Viva transaction;
   - an unpaid order returns PENDING_PAYMENT and no residency row;
   - after a sandbox card payment, reconcile returns ACTIVE with CUP dates;
   - a repeated callback returns the same order and does not create a second
     transaction/instance;
   - a second POST /orders for the same user returns
     RESIDENCY_ORDER_ALREADY_PENDING, also after a lost/unknown create response;
   - after activation, POST /orders {mode:"RENEWAL"} is 409
     RESIDENCY_RENEWAL_TOO_EARLY with zero Viva POSTs, and becomes eligible at
     `eligibleAt`;
   - an unpaid order past its local TTL still returns the pending order and the link; a
     later sandbox PAID read recovers it;
   - stop CUP or Viva and confirm UNAVAILABLE/retryable, never NONE or a second
     charge; restore and confirm recovery.
6. Enable LK_RESIDENCY_LIFECYCLE_ENABLED=true only after the check; keep the flag as
   the stop method. Disabling blocks new operations but does not delete orders.

Real money, publication, provider writes outside the sandbox, import and deploy are
separate approvals. This source change performs none of them.

## Remaining dependencies (not claimed complete)

- LK1 client wiring: ResidencyPurchasePage/zeroCheckoutPayment still use the
  existing browser checkout. A follow-up must switch the UI to this API behind
  VITE_RESIDENCY_LIFECYCLE_ENABLED and keep the current page as the fallback.
- LK2 adapter: implemented in the separate LK2 consumer PR; the contract above is the
  stable surface. The LK2 consumer needs its own Viva actor token (session-bound) and
  the `lk2` return target configured here.
- PROVIDER evidence: the exact Admin transaction/status fields and CUP refresh response
  are pinned from existing source and tests, not from a fresh sandbox read in this
  session. Two provider questions remain open and are not guessed here: (a) whether a
  second ACTIVE instance purchased while the first is active stacks or restarts at
  Viva (CUP already restarts, so early renewal is refused either way), and (b) whether
  the Viva Keycloak userinfo for the LK2-issued token carries `azp=widget` and the
  tenant claim (needed by this owner's auth). Run the contract check before activation.
- Provider-side idempotency: the current Viva end-user transaction contract has no
  reviewed idempotency key. The owner mitigates with a durable pre-POST attempt, a
  unique active-slot index, no automatic retry, a persisted transaction id and
  read-back. Reconciling a fully lost response through CUP evidence is supported; a
  provider-side dedup key remains a separate PROVIDER contract decision.
- Index apply, custom-node install, flow import, flags and deployment are separate
  operational steps.
