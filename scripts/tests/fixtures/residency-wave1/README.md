# First residency quote stand

Use Node.js 22.13 or later, npm and a local Docker daemon. Clone the LK1 stand
branch into a new directory named `lk` under a dedicated workspace, then start:

```sh
bash lk/scripts/tests/fixtures/residency-wave1/run.sh
```

The script checks out CUP #134 at `614258018b54c854aedd3f9fcb749bdeb77bcd73` next
to LK1. It uses Node-RED 4.0.9 and MongoDB 8.0.5. LK1, CUP and Mongo listen on
`127.0.0.1` ports 24641, 24642 and 24643. Set
`RESIDENCY_STAND_LK_PORT`, `RESIDENCY_STAND_CUP_PORT` or
`RESIDENCY_STAND_MONGO_PORT` before starting when a port is occupied. Stop the
HTTP servers with Ctrl-C and the stand database with
`docker stop padlhub-residency-wave1-24643`.

The graph uses the LK1 #464 price-preview function bodies, a local fixture for Viva
and the original CUP HTTP controller, policy service and MongoDB repository with
synthetic authorization. The exercise ID, type and prices reproduce the control
example. Its start is moved to the next day. The CUP publication and player data
are fixtures.

```sh
curl -fsS http://127.0.0.1:24641/lk/subscriptions/game-price-preview \
  -H 'Authorization: Bearer fixture-first' -H 'Content-Type: application/json' \
  --data '{"target":{"targetKind":"GROUP_TRAINING_RESIDENCY_PURCHASE","exerciseId":"4c9f00aa-d286-4a48-ad29-98757bd0ca87"}}'
```

`fixture-first` returns a quote for 354000 kopecks, `fixture-active` returns
409 `RESIDENCY_PURCHASE_HISTORY_EXISTS` and `fixture-unavailable` returns
503 `PRICE_PREVIEW_SUBSCRIPTIONS_INCOMPLETE`. `GET /__stand/info` returns
the exercise dates and the fixture publication. Quote expiry is the earliest of
the time specified by CUP, 30 seconds from the start of the CUP call and 60 seconds
from the residency card read.

## Checkout and recovery

From the same workspace, with the stand running:

```sh
node lk/scripts/tests/fixtures/residency-wave1/verify.mjs
```

For each run the verifier chooses a new `operationId`. It checks the three
quote scenarios, then sends the full HTTP `residencyPurchaseQuote` as
`acceptedQuote`, with `exerciseId`, `operationId` and `consentAccepted: true`,
to the stand-only `POST /__stand/residency-checkout`. Use the same bearer for
the quote and checkout. The server re-prices the authenticated actor and
exercise through the LK1 HTTP preview before reserving an operation.

The adapter persists the two-line order in its own collection and deliberately
closes the HTTP socket without a response. The checkout returns 202
`PENDING_CONFIRMATION`. A repeated checkout with identical terms and
`operationId` looks up the original reference and returns 200 `CREATED` with
the original provider order ID. The verifier reads one journal row and one
provider order, with one create attempt, one lost response and one lookup.
A further replay returns the existing receipt. Altered terms and another actor
cannot change or read the original journal entry.

The adapter supports only synthetic orders. For a UI running on a different
origin, use a same-origin development proxy for the LK1 preview path. The
stand does not simulate the payment widget, activation or booking.
