# Private whole-court checkout for LK2

LK1 owns the initial Viva reservation and payment. LK2 owns the original draft and its
publication from the verified receipt. This source packet adds a disabled Node-RED tab
for a single explicitly scoped organizer, court window and RUB amount. It has no
browser entry point or callback that can declare a game paid.

## Private request and response

Both routes use POST and the same canonical JSON body in this key order:

- `/lk/integrations/v1/whole-court-checkout/reserve`
- `/lk/integrations/v1/whole-court-checkout/confirm`

```json
{
  "contractVersion": 1,
  "action": "CREATE_GAME",
  "operationId": "<canonical booked operation UUID>",
  "draftId": "<original LK2 draft UUID>",
  "stationId": "<verified Viva station ID>",
  "roomId": "<verified Viva room ID>",
  "startsAt": "<UTC millisecond ISO>",
  "endsAt": "<UTC millisecond ISO>",
  "amountMinor": 320000,
  "currency": "RUB"
}
```

The existing booked-operation RS256 configuration supplies issuer, audience and public
key. LK2 signs the exact tenant, actor, provider client, request hash, idempotency-key
hash, operation, method, path, correlation ID and short-lived actor token binding.
Scopes are `game-create.whole-court.reserve` and `game-create.whole-court.confirm`.
The SHA-256 input is the UTF-8 string `whole-court:<reserve|confirm>:v1` followed
by a NUL byte and the canonical request JSON. Header names are
`X-Subscription-Actor-Delegation`, `X-Subscription-Actor-Token`, and `X-Correlation-ID`.
Only LK2 passes the Viva station and room IDs from verified mappings. LK1 independently
checks the original actor from Viva and matches the pin before any state change.

Reserve can return `AWAITING_PAYMENT` with the original Viva URL and expiry;
confirmation always reads the same provider transaction and never hands out a new link.
`CONFIRMED` returns the original operation/draft plus a private receipt with the transaction,
exercise and booking IDs, exact amount, currency and confirmation time. `202 UNKNOWN`
means reconcile the original attempt. A missing, expired or conflicting receipt never
authorizes a fresh charge. Provider identifiers and checkout links are private
server-to-server data. The public LK2 response should expose only what the browser needs
to open the original checkout and recover its own game.

## Dispatch and recovery

The owner reserves the original key/body, reads the exact full-window price with the
existing court service selector, and claims the configured provider court window in
MongoDB with majority write concern. Two commands reaching the same window cannot both
receive an insert ACK. Only that ACK authorizes one master-service Viva POST. Transport
failure or a lost ACK retains the fence. A response containing only an opaque async
operation ID is recorded as unresolved for reconciliation. It is never treated as a
transaction ID or used to retry the POST.

The accepted direct response must identify one booking, one exercise, the original
transaction and a link on `https://pay.vivacrm.ru`. Before exposing the checkout, LK1
checks the exact transaction's amount, any echoed actor/booking/exercise IDs, and the
original end-user transaction status and deadline. A zero outstanding amount can be
accepted only with matching original amount evidence and explicit `PAID` on the exact
transaction. The signed browser return target on `https://lk2.padlhub.su/games/new`
contains the original operation ID and triggers LK2 readback only. The provider
transaction has its own durable confirmation claim. The immutable confirmed record
contains a redacted proof digest, drops the original checkout URL, and replays the same
receipt across requests. The access tokens are transport-only and absent from persisted
records or replies.

## Source composition and activation

`composeWholeCourtCheckout` creates a reviewed exact-graph candidate from a preimage
and the existing Mongo anchor. The additive tab owns the two private routes, a single
`lk_whole_court_checkout_ops` collection and independent catch/response wiring. Existing
routes and nodes are preserved. No collection/index migration or workflow dispatch is
included. The normal exact-graph review and rollback procedure applies to any future
installation. Runtime must use the standard Mongo URI logging guard and must preserve
the readback/transport credentials required by the existing Viva integration.

The new `LK1_WHOLE_COURT_CHECKOUT_ENABLED` flag controls this tab. Its disabled
default refuses both routes. The bounded first scope uses `LK1_WHOLE_COURT_CHECKOUT_TARGET`
with `actorId`, `providerClientId`, `tenantId`, `stationId`, `roomId`, `startsAt`,
`endsAt` and `amountMinor`. Existing booked-operation receiver/execution controls
also apply. The exact UTC window is 60, 90 or 120 minutes within one Moscow date.
Stop new work by turning off the scoped tab. Preserve the Mongo records while resolving
any in-flight booking or transaction. Review the flag after a controlled pilot and keep
the slot fixed throughout that pilot. This initial scope is not a general overlapping
availability lock across releases and independent legacy checkout paths.

The direct master-service provider response and the carrier's browser return must
still be established on the exact target. Tracked examples of an async operation belong
to a different Viva route and supply no mapping to this POST. An unsupported provider
response leaves the original reservation under reconciliation. This packet supplies
neither the LK2 signing/receipt consumer nor a production activation. Closure requires
matching installed revisions and one test payment performed by the authorized user.
After return, read the original booking, transaction, game and organizer placement.
The double-click run must count one of each and retain their original IDs on replay.
