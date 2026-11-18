# Residency lifecycle (LK1 owner)

Status: source implementation, default off. No Node-RED import, index apply, provider
call, publication or deploy is performed by this change.

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
  transaction), not at Viva visit-counter activation;
- automatic renewal is **not** part of the product. A renewal is a new purchase; the
  existing active instance remains valid until its own activeTo;
- no residency **price** discount is published. The lifecycle therefore returns an
  empty discountLines array and totalMinor = baseAmountMinor. The benefits above
  are consumed by the existing booking owner, not duplicated here.

Any future discount line must come from CUP. The domain engine accepts only
{ code, title, amountMinor, source } lines totalling at most the base amount and
fails closed on an invalid or unavailable quote.

## API contract for LK2 (and the LK1 client)

Base path: https://padlhub.su/lk/residency (SERV2 origin, same as the existing
/lk/residency/passes gateway). This is not a second pricing or payment engine: it
reuses the existing Viva transaction, the Admin transaction read and CUP's
residency-booking-refresh/context. LK2 must call this contract through PadlHub, never
Viva directly, and must not recompute the price. Authentication: LK bearer
(Authorization: Bearer <LK user token>), verified through Keycloak userinfo; expected
azp/client_id=widget and tenant iSkq6G.
Mutating routes require Idempotency-Key: 16..128 non-whitespace characters.
X-Correlation-ID is optional and echoed. All responses are Cache-Control: no-store,
Referrer-Policy: no-referrer, X-Robots-Tag: noindex, nofollow.

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
  "checkedAt": "2026-11-18T09:00:00.000Z"
}
~~~

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

POST /orders with Idempotency-Key and body { "mode": "NEW" | "RENEWAL" }
(mode defaults to NEW).

- NEW is refused with 409 RESIDENCY_RENEWAL_REQUIRED while an active residency
  exists; use RENEWAL.
- RENEWAL requires an active residency (409 RESIDENCY_RENEWAL_NOT_ELIGIBLE).
- A second unresolved order for the same user is refused with
  409 RESIDENCY_ORDER_ALREADY_PENDING before any provider POST.
- The same key returns the same order (idempotentReplay: true); the same key with a
  different mode is 409 RESIDENCY_IDEMPOTENCY_CONFLICT.

Response: { "schemaVersion": 1, "order": { ... }, "idempotentReplay": false, "recoveryRequired": false }.

The order object:

~~~
{
  "schemaVersion": 1,
  "orderId": "00000000-0000-4000-8000-000000000001",
  "mode": "NEW",
  "state": "PENDING_PAYMENT",
  "product": { "productId": "...", "title": "...", "termDays": 30, "currency": "RUB" },
  "pricing": { "baseAmountMinor": 79000, "discountLines": [], "totalMinor": 79000, "currency": "RUB" },
  "payment": {
    "status": "PENDING",
    "providerTransactionId": "00000000-0000-4000-8000-000000000003",
    "paymentUrl": "https://...",
    "expiresAt": "2026-11-18T09:20:00.000Z",
    "instruction": "Оплатите по ссылке. Статус обновится после подтверждения банком."
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

### Order state

GET /orders/{orderId} returns the order object. It is scoped to the authenticated
tenant and user; another user's id is 404 RESIDENCY_ORDER_NOT_FOUND.

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
  "instruction": "Оплатите по ссылке. Статус обновится после подтверждения банком."
}
~~~

A lost create response is recovered by reading the original transaction/order, never
by POSTing a second transaction. A cancelled or paid order never returns a stale
payment link.

### Reconcile / payment callback

POST /orders/{orderId}/reconcile with Idempotency-Key and optional
{ "eventId": "<stable provider event id>" }.

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

### Cancel

POST /orders/{orderId}/cancel with Idempotency-Key. Cancellable only while not
paid and not active. The owner reads the original transaction first: PAID refuses the
cancel, and an unreadable status fails closed instead of cancelling an in-flight payment.
A paid order waiting for activation must not be cancelled into an automatic refund
(409 RESIDENCY_ORDER_PAID).

### Error envelope

~~~
{ "code": "RESIDENCY_ORDER_NOT_FOUND", "message": "Order not found" }
~~~

Stable codes include RESIDENCY_AUTH_REQUIRED, RESIDENCY_REQUEST_INVALID,
RESIDENCY_REQUEST_TOO_LARGE, RESIDENCY_CONTENT_TYPE_INVALID,
RESIDENCY_IDEMPOTENCY_KEY_REQUIRED, RESIDENCY_IDEMPOTENCY_CONFLICT,
RESIDENCY_ORDER_ALREADY_PENDING, RESIDENCY_RENEWAL_NOT_ELIGIBLE,
RESIDENCY_RENEWAL_REQUIRED, RESIDENCY_STATUS_UNAVAILABLE,
RESIDENCY_CATALOG_UNAVAILABLE, RESIDENCY_PRICING_UNAVAILABLE,
RESIDENCY_PRICING_INVALID, RESIDENCY_ORDER_NOT_FOUND, RESIDENCY_ORDER_CONFLICT,
RESIDENCY_ORDER_ACTIVE, RESIDENCY_ORDER_PAID, RESIDENCY_ORDER_NOT_CANCELLABLE,
RESIDENCY_UPSTREAM_TIMEOUT, RESIDENCY_UPSTREAM_UNAVAILABLE,
RESIDENCY_UPSTREAM_INVALID, RESIDENCY_PAYMENT_INVALID,
RESIDENCY_PAYMENT_AMOUNT_MISMATCH, RESIDENCY_PAYMENT_OWNERSHIP_MISMATCH,
RESIDENCY_PRODUCT_TERMS_MISMATCH, RESIDENCY_SUBSCRIPTION_OWNERSHIP_CONFLICT,
RESIDENCY_EVIDENCE_INVALID, RESIDENCY_RATE_LIMITED, RESIDENCY_INTERNAL.
No code, message or log carries a token, phone, provider id, PII or raw provider body.

## Idempotency and double-charge guards

1. A deterministic order UUID is derived from (tenant, user, Idempotency-Key); the
   request hash binds the mode and product. The unique index
   residency_order_idempotency makes the insertion one-winner.
2. A second unresolved order for the user is refused **before** the Viva POST.
3. Viva is called exactly once for a create. A transport/lost response leaves the order
   UNKNOWN; the next read recovers the original order, it never re-POSTs.
4. Every state change is a Mongo revision CAS. A losing callback re-reads the durable
   row and returns it.
5. Activation is a separate transition after PAID; it is called only once per order
   and only from CUP evidence. A repeated callback cannot activate twice.
6. Cancellation and expiry are terminal for that order; a replacement order is a new
   key, not a re-dispatch of the old one.

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
| LK_RESIDENCY_LIFECYCLE_SUCCESS_URL, ..._FAIL_URL | Fixed return URLs. |
| LK_RESIDENCY_LIFECYCLE_ALLOW_ORIGIN | CORS origin; default * for the Tilda widget. |
| LK_RESIDENCY_LIFECYCLE_PAYMENT_TTL_MS | Local pending-payment window (default 20 min, the existing checkout window). Not a provider expiry. |
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
- residency_order_user_state on (tenantId, userId, state);
- residency_order_expiry on (tenantId, state, payment.expiresAt).

The adapter also exposes RESIDENCY_LIFECYCLE_INDEXES; applying them is an operational
step, not a startup migration.

## Rollout and E2E

1. Review and install node-red/custom-nodes/residency-lifecycle-api on the LK1
   Node-RED host. It is a separate package; installing it is an approved live action.
2. Create the four indexes with the reviewed Mongo operator path; do not enable
   ENSURE_INDEXES in normal runtime.
3. Set the env values (CUP token protected; Viva Admin token already present). Keep
   LK_RESIDENCY_LIFECYCLE_ENABLED=false until the contract check passes.
4. Import node-red/imports/lk_residency_lifecycle.import.json; verify the 7 routes,
   CORS and the store binding.
5. Contract check with a synthetic client on the test stand:
   - GET /catalog returns 79 000 and the exact terms;
   - POST /orders twice with one key returns one order and one Viva transaction;
   - an unpaid order returns PENDING_PAYMENT and no residency row;
   - after a sandbox card payment, reconcile returns ACTIVE with CUP dates;
   - a repeated callback returns the same order and does not create a second
     transaction/instance;
   - a second POST /orders for the same user returns
     RESIDENCY_ORDER_ALREADY_PENDING;
   - after activation, POST /orders {mode:"RENEWAL"} creates a new order and the old
     window remains visible until its activeTo;
   - an unpaid order past its local TTL is EXPIRED; a later sandbox PAID read
     recovers it;
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
- LK2 adapter: a server-side client for this contract (delegation or authenticated
  owner call) is not part of this PR; the contract above is the stable surface.
- PROVIDER evidence: the exact Admin transaction/status fields and CUP refresh response
  are pinned from existing source and tests, not from a fresh sandbox read in this
  session. Run the contract check before activation.
- Index apply, custom-node install, flow import, flags and deployment are separate
  operational steps.