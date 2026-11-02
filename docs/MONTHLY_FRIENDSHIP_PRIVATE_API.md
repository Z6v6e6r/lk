# Monthly Friendship private owner contract

Source implementation; no runtime installation or activation is implied. This is the
ordinary monthly Friendship counter, not the annual/HAB sale contract. The canonical
LK2 API/native consumer is a separate, still required integration.

The pure `compose_monthly_friendship_api.mjs` composer adds four private POST ingress
routes under `/lk/integrations/v1/monthly-friendship/`: `quote`, `purchase`, `read`,
`reconcile`. It requires the exact reviewed monthly custody source and its existing
Mongo owner binding. It changes no legacy node and creates no second provider writer:
the embedded source uses the same monthly reservation, dispatch, observation and
identity kernel over `lk_tournament_subscription_sales`.

## Authority and wire

Every request requires a dedicated `phub-monthly-friendship-actor+jwt` RS256 delegation,
closed `subscription-runtime.monthly-friendship.<mode>` scope, exact method/path/body
hash, tenant/user/current session, synced provider client/mapping, original key-derived
operation UUID, correlation ID and hashed short-lived actor token. Tokens are ephemeral;
no token, provider authorization header or raw provider body enters stored records or
responses. The issuer canonicalizes JSON keys before signing. Max delegation lifetime
is 60 seconds, with no future-issued/expired-token grace period.

The dedicated configuration prefix is `LK_MONTHLY_FRIENDSHIP_API_`, with `ENABLED`,
`ISSUER`, `AUDIENCE`, `KEY_ID`, `PUBLIC_KEY_PEM`, `TENANT_ID`. The switch is off unless
`ENABLED` is exactly `true`. Owner: release owner for R1 commerce. Activation requires
reviewed canonical actor mapping/session enforcement, exact matching signing authority,
provider acceptance, fenced legacy writers and live-target approval. Review the switch
after R1 acceptance; retain independent shutdown/recovery capability. This source change
neither creates keys nor changes configuration.

The only offer UUID is `862670f6-a476-4a18-aecb-9e27661fbad3`. It is a PadlHub catalogue
identity, not a Viva ID. Base body is `{contract: "monthly-friendship.v1", offerId}`.
Purchase additionally requires `{expectedRevision, amountMinor, currency: "RUB"}`.
No client phone/product/price selection, promo, arbitrary redirect or alternate offer
is accepted. Quote and purchase use the same original operation key; the caller must
retain that key before quoting. Provider identifiers in private receipts stay server-side.

## Quote, payment and recovery

The owner first reads the actor's Viva end-user profile with the delegated actor token.
Client aliases and phone aliases must agree. A quote then executes the existing monthly
prepare/capacity logic and a complete authoritative product read using the existing
cached service token. It stops before entering atomic custody: no reservation, binding,
promo preview or transaction POST occurs. The revision binds product facts/lifecycle,
price, inventory/epoch/day and the fixed original transaction payload. A fresh quote is
recomputed before purchase, with exact consent matching; no new tariff is invented.

Purchase first reads its immutable `MONTHLY_FRIENDSHIP_ACTOR_BINDING_V1`. If present,
it uses only the original operation; catalogue drift, disabled admissions and new epochs
do not route recovery into another purchase. A new binding uses deterministic `_id`
uniqueness and setOnInsert. Only an exact acknowledged insertion enters existing monthly
custody. A lost ACK permits readback/recovery only. Binding rows deliberately omit legacy
top-level paymentRef/counterKey/inventoryId, so they cannot become legacy reservations.

`read` reads the original ledger without storage writes or transaction GET. `reconcile`
uses known original-transaction/issued-instance GETs through the same owner. Neither can
POST a new payment. A receipt received after delegation expiry is durably retained before
withholding its response; a fresh authenticated read recovers it. Expiry blocks any next
provider call. Unknown outcomes remain held and never release automatically by time.

Success/failure URLs are fixed to `https://padlhub.su/lk2/subscription-payment-return` with
the original reference appended by existing preparation. A return is never payment proof.
The return landing/native handoff must be implemented and accepted before activation.
PAID is the historical purchase receipt; it never grants current entitlement after refund,
expiry or revocation without the separate current-subscription read.

## Evidence and rollback

Focused tests exercise the actual composed function bodies, quote zero writes, closed
authority, price/lifecycle drift, original-only recovery, same-key races, lost insert ACK,
expired response authority and sanitized replies. The existing CI-only loopback Mongo
fixture runs independent-client binding and durable-observation tests. No local/shared
Mongo provisioning or provider operation is part of these tests. Strict product page and
actor-profile field shapes still require PROVIDER evidence; mocks are not that evidence.

Disable new admission before rollback. Keep original ledger/binding/observation records
and compatible recovery code. Do not restore the old unjournaled monthly POST path or
remove the custody binding while accepted/ambiguous operations remain. A disabled API
switch intentionally denies all private access; owner admission closure instead permits
original read/reconcile. No live rollback is executed by this source composer.
