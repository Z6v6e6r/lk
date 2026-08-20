# Subscription visit return verification

## Problem

The split-leave flow previously treated a cancelled Viva booking as proof that a
subscription visit had been returned. The provider can acknowledge booking
cancellation while the concrete client subscription still keeps the debited
visit and the booking reference. In that case LK must not say that the visit was
returned.

## Identity contract

- `productId` is a catalog product and is never accepted as a client subscription instance.
- `clientSubscriptionId` is obtained from the exact active booking or from the
  previously verified payment projection.
- The Admin subscriptions read-back matches only `subscriptionId` or
  `clientSubscriptionId`; generic `id`/`uuid` fields are not used.
- The target booking ID, client ID, exercise ID, subscription instance ID and
  visit count must stay consistent across the leave operation.

## Fail-closed sequence

1. Read the active Viva booking and bind the exact booking to its client
   subscription instance and visit count.
2. Before any cancellation mutation, read
   `GET /api/v1/clients/{clientId}/subscriptions?size=200` with the existing
   server-side Viva credential.
3. Require exactly one matching subscription, a numeric `visitsLeft`, and the
   exact target booking in an active state. Missing or ambiguous evidence stops
   before `DELETE`/`PUT`.
4. Execute the existing cancellation request and verify that the booking is
   absent from active bookings and cancelled in history.
5. Read the exact subscription again. A return is `RETURN_VERIFIED` only when:
   - `visitsLeft >= visitsLeftBefore + expectedReturnCount`; and
   - the exact booking is absent from the subscription or explicitly cancelled.
6. Only `RETURN_VERIFIED` may produce `Вернули занятие на абонемент.` and finish
   as `DONE`.
7. If the post-cancellation read-back is unavailable or does not prove the
   return, remove the player from the LK roster but persist `RETURN_PENDING`,
   return HTTP `202`, and show `Вы вышли из игры. Возврат посещения проверяется`.

## Retry contract

- `RETURN_PENDING` is durable and is selected only when the server-side Viva
  credential is available.
- A retry performs only the subscriptions `GET`; it never repeats the booking
  cancellation.
- The retry uses an exact state transition `RETURN_PENDING -> VIVA_CONFIRMED -> DONE`.
- Concurrent retries may read in parallel, but only one state CAS can advance
  the operation.
- After 20 automatic verification attempts the operation remains pending for
  manual reconciliation; it must not be presented as a successful refund.

## Release gates

This checkpoint changes tracked Node-RED source functions, a focused patcher,
documentation and tests only. Before any deployment:

1. Pull and verify the current live `147` flow as the release preimage.
2. Rebuild the guarded candidate with the pinned source hashes:

   ```bash
   node scripts/patch_live_games_subscription_return_verification.mjs \
     --workspace /absolute/fresh-live-workspace \
     --output /absolute/fresh-live-workspace/candidate-return/full.flow.json \
     --import /absolute/fresh-live-workspace/candidate-return/import.nodes.json \
     --report /absolute/fresh-live-workspace/candidate-return/report.json
   ```

   The patcher replaces only 14 existing function bodies. It fails closed on
   any source-flow, node-preimage, route-count, topology or source-file drift.
3. Run the full split-leave, staff-leave, cancellation and Node-RED validation suites.
4. Review the exact Node-RED diff and rollback artifact.
5. Obtain separate approval for deployment.
6. Use a separately approved synthetic canary and capture sanitized Golden HAR
   evidence for the pre-snapshot, cancellation, booking read-backs and
   subscription post-snapshot.

No provider mutation, live flow import, push or deployment is part of this checkpoint.
