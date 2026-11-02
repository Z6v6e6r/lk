# Monthly Friendship purchase custody

R1 source implementation over LK owner integration `046f29b6`. This document describes
source behavior, not installed flows, provider acceptance or production readiness.
The canonical LK2 API and native consumer are a separate unfinished part of the same
purchase outcome. No deployment, provider call or live configuration change is included.

## Owner and compatibility

`compose_monthly_friendship_custody.mjs` checks five immutable function preimages,
Mongo collection/client identity and existing provider/confirmation graph edges. It
replaces only five function bodies; tracked flows and release configuration are not
regenerated. The confirmation polling fifth port remains required.

Monthly Friendship uses its existing product lookup, ordinary price or verified promo
quote, launch/daily quotas and 10:00 Europe/Moscow calendar. It does not use annual
Piter/HAB tier or lifecycle rules. Existing payments without `monthlyCustody` retain
their original confirmation route. The public LK1 response retains bank URL and amount
fields; an unknown response without an attributable operation returns non-success HTTP
so the legacy storefront cannot interpret an absent amount as a free purchase.

The existing storefront can omit `clientId`. Before reserving, the owner performs the
existing Viva client-by-phone GET and requires one exact matching client in a complete
page. A supplied client ID must agree. This is legacy compatibility, not a new public
authorization contract. The forthcoming LK2 private ingress must independently verify
its actor delegation and supply server-resolved identity; public callers must never
choose tenant, provider identifiers, payment URL or return URL in that contract.

## Durable purchase and recovery

One `MONTHLY_FRIENDSHIP_CUSTODY_V1` aggregate per tenant/inventory in
`lk_tournament_subscription_sales` owns all new monthly reservations. Original request,
price/promo, frozen epoch, client, product and provider payload are immutable. Both web
and future native creation must enter this same owner. The old monthly quota algorithm
runs against legacy rows plus aggregate operations, excluding verified compatibility
projections. A full-preimage CAS serializes last-slot claims. New pending/unknown holds
never expire merely because a payment-link TTL elapsed. This can conservatively close
availability while reconciliation is unresolved; it cannot authorize an extra sale.

Only an acknowledged exact CLAIMED/generation0 → DISPATCHING/generation1 CAS authorizes
one transaction POST. A lost dispatch ACK, timeout, new key or changed quote does not
permit another POST. The old payment-method fallback is not used for custody purchases.

The attributable create response is first persisted in an immutable
`MONTHLY_FRIENDSHIP_PROVIDER_OBSERVATION_V1` document. It contains only parsed bounded
fields, original request and dispatch identity, never bearer tokens/raw provider bodies.
Another buyer advancing the aggregate cannot discard this evidence: bounded CAS retries
apply it to the current aggregate, and a restarted reader can recover it without POST.
A crash after provider dispatch but before any durable attributable response remains
UNKNOWN; no speculative transaction-list match or blind replay is introduced.

Per-tenant transaction and issued-instance ownership use immutable
`MONTHLY_FRIENDSHIP_IDENTITY_V1` documents with deterministic `_id` keys. Existing legacy
sale rows are checked for conflicting ownership. The aggregate remains the business
source of truth; observation/identity records are evidence and exclusivity, and ordinary
sale rows are compatibility projections. Projection revision guards prevent an older
pending response overwriting a newer paid projection. The existing Mongo `_id` uniqueness
is used; no live index or migration is performed by this source task.

PAID requires exact transaction/client/product/financial facts and one transaction-linked
issued instance. Pages must have consistent totals, number, element count, final flag,
full non-final pages and unique identities; at most 50 pages of 200 entries. Missing or
contradictory data stays unknown. Provider payment time predating original dispatch is
rejected conservatively, without invented clock tolerance. Provider `paidAt` is retained
separately from local `confirmedAt`, preserving the quota calendar. Success proves an
original issued purchase, not current entitlement after later expiry/refund.

Initial creation parsing accepts only the reviewed `id/toPay/paymentUrl/paymentDueDate`
shape. Alternate provider shapes, missing URL/deadline or malformed values fail closed;
a retained transaction ID can still settle by strict issuance readback without a bank
URL. Actual provider field shape, timestamp precision and client/instance pagination
must be accepted before activation. Refund/terminal hold release is not inferred from
local expiry or cancellation. Aggregates are bounded to 2,000 operations and 4 million
serialized characters; reaching the bound closes admission and requires an owned
retention/inventory transition, never silent deletion.

## Binding, activation and rollback

Source recognizes `monthly_friendship_custody_binding`:
`{version:1, enabled:false, tenantId:<server-owned>, inventoryId:<exact monthly inventory>}`.
No binding is created by this change. Owner: LK monthly subscription release owner.
Purpose: coordinate one owner for web/native monthly writes while preserving old payments.
Activation requires exact composed graph review, complete legacy-writer inventory,
existing payment/identity adoption review, backup/recovery rehearsal, real provider
acceptance and separate exact-target authority. Check tenant/provider binding and current
epoch; do not copy a fixture or enable an annual tariff. Review/remove the flag only after
all monthly consumers use the verified owner and no old in-flight writers remain.

When a binding exists, `enabled:false` closes new monthly admission but keeps original
readback/recovery. Presence of a custody ledger also fences an accidental legacy fallback.
Do not delete the binding, ledger, observations or identity claims to reopen sales.
After the first accepted operation, rollback must preserve this owner/recovery code and
close admission; restoring the old POST-before-record writer is not a safe rollback.
Physical apply, index changes, restore and provider/refund operations remain separate
approved transitions.

## Evidence scope

Local kernel/composed-runtime tests cover last-slot interleaving, original-key conflicts,
lost ACK, restart, immutable response recovery, legacy confirmation, calendar boundaries,
client lookup, strict issuance and contradictory pagination. Required CI tests use the
existing isolated loopback Mongo service with unique disposable database names; they
refuse local/shared URIs and fail if the CI fixture is absent. No local database is
provisioned. Green CI does not prove installed topology, provider contracts, devices or
production acceptance.
