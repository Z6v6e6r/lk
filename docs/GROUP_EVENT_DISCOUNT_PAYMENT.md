# Group event payment using the configured subscription discount

Owner: PadlHub LK. Audience: holders of an eligible subscription registering for
`group_training`, including Viva type 847 (game + trainer) and 605/963/1208.

## Behavior

`/lk/subscriptions/game-price-preview` resolves the event's one-time tariff and
`groupTrainingDiscountPercent` from the existing subscription policy. The UI displays
that percentage and checks the same integer-kopeck calculation as the evaluator:
`baseMinor - floor(baseMinor * percent / 100)`. With the current 50% rule, 550000
kopecks becomes 275000. The policy itself and its eligibility/active-booking limits
are unchanged.

`/lk/subscription-bookings` preserves the existing zero-visit group decision and
ON_PLACE booking. At `lk1_payment_products`, it selects only the exact saved event
`priceProductId` from Viva's by-booking products. A single matching SERVICE with the
same base price is required; conflicting aliases, duplicates, absent products,
incomplete responses, or changed prices stop the operation. There is no fallback
to the generic 10000-ruble game service or to a subscription debit.

The gateway serializes one SERVICE with one confirmed booking and a discount of
`baseMinor - chargeMinor`, rechecks the authenticated profile and current rule, and
uses the existing durable compare-and-set before the transaction POST. The group
intent records product type/base price and transaction readback verifies identity,
booking, amount, discount, and HTTPS checkout URL. Only the verified URL returns to
the existing frontend redirect. Ordinary game and tournament checkout behavior is
unchanged. A 100% policy uses the existing zero-payment completion.

## Evidence and boundaries

Local tests execute the gateway and preview source with fixture-owned HTTP/Mongo
adapters, covering percentages, rounding, product/actor/booking tampering, CAS,
readback, replay, and no subscription debit. They are source-level evidence, not
live Viva or deployed-graph verification.

Touched function source: `scripts/nodered_lk1_hub_nodes/gateway.js` and
`scripts/nodered_subscription_price_preview_nodes/router.js`. No flow JSON, import,
export, server global policy, or live operation is changed by this source patch.

An authorized release must use a fresh private live preimage and a focused reviewed
candidate preserving the installed graph, including earlier group confirmation
fixes. The historical HUB installer is not an upgrade command for the current flow.
Verify the actual event product returned by Viva is SERVICE; other product types
remain unsupported by this payment path.

Stop signals: GROUP_PAYMENT binding/product errors, failed transaction CAS/readback,
or missing checkout URL. Stop method: leave the existing operation pending, with no
new booking or blind transaction retry. Repeated ingress remains read-only. Existing
pending operations from the old carrier failure are not repaired by deploying this
change; they require separately scoped reconciliation. Previously verified legacy group checkout links remain replayable through their
original identity/amount checks, without re-entering the write path.
