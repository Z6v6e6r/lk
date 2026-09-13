# Focused group-event payment runtime upgrade

`prepare_group_event_payment_upgrade.mjs` applies the already merged #64 group
payment change to the installed expanded gateway and price-preview functions.
It is an offline composer, not a deployment or an activation command.

The previous whole-fragment assembly could replace installed rejoin, gateway or
preview helpers. This upgrade embeds only the public canonical #64 deltas
(`af489711^1..af489711`) and applies each exact anchor once. The group-payment
helpers are inserted before `lk1Checkout`, preserving the installed rejoin helpers
between `lk1Finish` and checkout. No private live function body is checked in.

Only `func` changes on these existing nodes:

- `lk_subscription_booking_router_20260804`
- `lk_subscription_price_preview_20260908_router`

All other fields, initializers, wrappers, routes, connections, node order and
unrelated nodes are preserved. No nodes are added. The composer validates both
full preimage and postimage function SHA-256 values, current canonical fragment
hashes, enabled function/output shape, unique delta anchors and JavaScript syntax.
Any source drift, already upgraded body or missing/duplicate node fails closed.
The reviewed full pins are exported as `GROUP_UPGRADE_TARGETS`; the command line
has no override. Alternate pins on the exported composition function exist only
for synthetic tests and are not release authorization.

## Offline preparation

Use a fresh privately held source flow and a new private directory outside any
Git checkout. Do not commit raw source, candidate, contract or credentials.

```bash
node scripts/prepare_group_event_payment_upgrade.mjs \
  /absolute/private/source.flow.json \
  /absolute/new-private-directory \
  group-event-payment-upgrade-20260913
```

The output directory is mode `0700`; files are created no-clobber as `0600`:

- `candidate.flow.json`: full candidate; private operational artifact.
- `exact-graph-contract.json`: existing reviewed-deploy contract binding input
  bytes and candidate bytes, with only the two `func` fields allowed.
- `operator-summary.json`: input/candidate hashes, exact body pins, zero additions
  and `liveWrites: 0`. This describes the offline command, not production state.

The command performs no network request, provider call, database write, service
restart or deployment. For a combined leave/group candidate, compose the
independent leave changes separately and freeze a new combined exact-graph
contract from the fresh original flow; this two-node contract does not authorize
additional changes. Source commit/provenance, runtime prerequisites and the
existing reviewed operator install/rollback path remain release prerequisites.
A successful local composition is not evidence of deployment or provider payment.

## Verification

```bash
node --test scripts/tests/groupEventPaymentUpgrade.test.mjs scripts/tests/groupEventPayment.test.mjs
```

Tests prove that applying the deltas to the prior canonical fragments produces
exactly the merged fragments; synthetic installed wrappers and rejoin helpers
survive; unrelated fields and graph changes are rejected; and preimage, anchor,
postimage and output-location drift fail closed. The existing semantic suite
covers event tariff identity/type/price, variable discount rules, visit-free group
payment, incomplete/ambiguous products, actor/booking drift, CAS outcomes,
transaction readback, legacy replay and unchanged game-carrier behavior.
