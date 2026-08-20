# Exact subscription return binding

## Why this checkpoint exists

A split-game participant can have several active Viva subscriptions at the same
time. A catalog `productId` does not identify the concrete client subscription
that paid for a booking. The leave flow must therefore use the exact
`clientSubscriptionId` and the exact number of debited visits, or stop before a
provider mutation.

The production canary that exposed this gap was a 60-minute split game with
three eligible active subscriptions. The join succeeded and one visit was
debited, but the legacy payment projection did not persist the exact client
subscription instance in the player's payment row. Leave then correctly failed
closed instead of guessing which subscription to return.

## Contract for new joins

1. The browser may select a `clientSubscriptionId`, but it cannot confirm that
   the booking used that instance.
2. After booking, the server reads the exact Viva booking and requires an
   explicit client subscription instance field. A generic top-level
   `subscriptionId` is treated as a catalog identifier and is never accepted as
   instance evidence.
3. The expected visit count comes from the game duration stored on the server:
   one visit below 90 minutes and two visits from 90 minutes.
4. Provider evidence may return its own visit count. If present, it is used; if
   absent, the server-owned duration count is used.
5. Canonical confirmation rejects subscription evidence without both the exact
   instance and a positive integer visit count.
6. The roster projection writes these values only into the payment row matched
   to the confirmed reservation/player. It never updates sibling players.

## Safe recovery for an existing game

An existing payment row can predate exact binding persistence. Recovery is
allowed only after the leave flow has authenticated the actor and resolved the
exact active Viva booking.

1. Derive the expected return count from the stored game duration if the legacy
   row has no count.
2. Read the client's Viva subscriptions with the existing server credential.
3. Match subscriptions only by an exact nested active booking ID.
4. Continue only when exactly one subscription contains that booking.
5. Capture that instance, its pre-return balance, the matching booking and the
   visit count before executing the existing cancellation request.
6. If no subscription or more than one subscription matches, return HTTP 409
   and perform no provider mutation.
7. The existing post-cancellation subscription read-back remains mandatory;
   local success is not proof that the visit was returned.

This compatibility path does not use `subscriptionProductId`, catalog
`subscriptionId`, subscription name, nearest expiry or highest balance as a
fallback.

## Tests and canary acceptance

- A new 60/90/120-minute join persists the exact confirmed instance and visit
  count on only the joining player's payment row.
- A provider payload that exposes only a catalog subscription ID is rejected.
- An existing 60-minute game with three active subscriptions resolves the one
  instance containing the exact booking and prepares a one-visit return.
- Two instances containing the same booking fail closed before `DELETE`/`PUT`.
- A successful canary must prove: player removed, booking cancelled in Viva,
  exact subscription balance incremented by the expected count, and no changes
  to the other subscriptions.
- If the result is `RETURN_PENDING`, do not retry cancellation manually. Use
  the existing read-only reconciliation path.

## Guarded Node-RED candidate

Before deployment, pull a fresh live `147` flow and build the candidate only
from that verified workspace:

```bash
node scripts/patch_live_games_subscription_binding.mjs \
  --workspace /absolute/fresh-live-workspace \
  --output /absolute/fresh-live-workspace/candidate-subscription-binding/full.flow.json \
  --import /absolute/fresh-live-workspace/candidate-subscription-binding/import.nodes.json \
  --report /absolute/fresh-live-workspace/candidate-subscription-binding/report.json
```

The patcher replaces only six existing function bodies. It pins the reviewed
whole-flow and function preimages, preserves routes and topology, and refuses
source drift. The snapshot used during isolated verification is evidence only;
its freshness must not be assumed at deployment time.

## Rollback

Before import, preserve the byte-identical fresh live flow and the six original
nodes. If authenticated smoke fails, restore that exact flow, restart the same
Node-RED unit, and prove the prior flow digest plus health/read-only game smoke.
Rollback of code does not undo a Viva cancellation, so the first mutation
canary must be a separately approved synthetic participant with recorded
pre-state and a manual Viva reconciliation plan.

No provider request, booking change, flow import, restart, merge, push or deploy
is part of this checkpoint.
